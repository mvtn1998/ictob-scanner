"""Background scanner for the ICT OB Scanner web terminal.

The desktop app's Scanner thread, SymbolState cache and ranking rules are
reproduced here. One difference is deliberate: the browser cannot hold a
tick websocket open on the user's behalf, so the REST intraday refresh the
desktop already runs every cycle is the live path (it includes the forming
5-minute bar, exactly the series the engine is given there).
"""
from __future__ import annotations

import bisect
import bisect as _bisect_ts
import json
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from . import sample
from .client import Upstox, UpstoxAuthError
from .config import (CACHE, IND, INDEX_CATALOG, IST, OPT_ENTRY_TTL,
                     OI_REFRESH_SEC, SAMPLE_SYMBOLS)
from .engine import (build_oi_strip, latest_day_candles, max_ob_volx,
                     rally_score_symbol, run_engine)

REQUEST_PAUSE = 0.13
CYCLE_SLEEP = 5.0
RALLY_COLOR_MIN = 30.0

SECTOR_PRIORITY = (
    "NIFTY PSU BANK", "NIFTY BANK", "NIFTY PHARMA", "NIFTY HEALTHCARE",
    "NIFTY IT", "NIFTY AUTO", "NIFTY FMCG", "NIFTY REALTY", "NIFTY METAL",
    "NIFTY OIL & GAS", "NIFTY ENERGY", "NIFTY MEDIA", "NIFTY FIN SERVICE",
    "NIFTY INFRA", "NIFTY MNC", "NIFTY CONSUMPTION", "NIFTY COMMODITIES",
)

INDEX_LEVEL = {
    "NIFTY 50": 25860, "NIFTY BANK": 57420, "NIFTY IT": 39120,
    "NIFTY AUTO": 24810, "NIFTY FMCG": 58940, "NIFTY PHARMA": 22470,
    "NIFTY METAL": 9870, "NIFTY ENERGY": 38640, "NIFTY REALTY": 1085,
    "NIFTY PSU BANK": 7420, "NIFTY FIN SERVICE": 27940, "NIFTY MEDIA": 1790,
    "NIFTY INFRA": 9180, "NIFTY HEALTHCARE": 14320, "NIFTY MNC": 31260,
    "NIFTY CONSUMPTION": 12440, "NIFTY COMMODITIES": 9420,
    "NIFTY OIL & GAS": 11890, "NIFTY MIDCAP 50": 12810,
    "NIFTY MIDCAP 100": 61240, "NIFTY MIDCAP 150": 21740,
    "NIFTY NEXT 50": 74120, "NIFTY 100": 27240, "NIFTY 200": 15180,
    "NIFTY 500": 24160, "NIFTY SMALLCAP 50": 18420,
    "NIFTY SMALLCAP 100": 19210, "NIFTY SMALLCAP 250": 21470,
}


class SymbolState:
    def __init__(self, symbol: str, key: str, name: str):
        self.symbol = symbol
        self.key = key
        self.name = name
        self.candles: dict[str, list[dict]] = {}
        self.daily_prev: list[dict] = []
        self.result: dict | None = None
        self.view5: list[dict] | None = None
        self.max_x = 0.0
        self.n_obs = 0
        self.n_active = 0
        self.n_bull = 0
        self.n_bear = 0
        self.ltp = 0.0
        self.prev_close = 0.0
        self.rally_dir: str | None = None
        self.rally_score = 0.0
        self.error: str | None = None
        self.last_utc = 0.0
        self.warmed = False
        self.fut: str | None = None
        self.fut_us: str | None = None
        self.oi_tag: str | None = None


class Scanner(threading.Thread):
    def __init__(self, root: Path):
        super().__init__(daemon=True, name="ictob-scanner")
        self.root = Path(root)
        self.client = Upstox(self.root)
        self.lock = threading.RLock()
        self.stop_evt = threading.Event()

        self.states: dict[str, SymbolState] = {}
        self.universe_meta: dict = {}
        self.idx_master: dict = {}
        self.demo = True
        self.auth_msg = "not linked"
        self.user = "-"
        self.master_msg = "loading F&O master…"
        self.phase = {"phase": "warmup", "done": 0, "total": 0,
                      "msg": "Warming up (F&O master loaded)...",
                      "cycle": 0, "errors": 0}
        self.selected: str | None = None
        self.mode = "RALLY + OPT"
        self.tf = 5
        self.vol_candles = False
        self.filter = ""

        self.opt_rank: dict[str, tuple[float, float, float, float | None]] = {}
        self.rally_opt: dict[str, float] = {}
        self.opt_favor: dict[str, str] = {}
        self.opt_error: dict[str, str] = {}
        self.oi_cache: dict[str, tuple[float, dict | None, str]] = {}

        self.index_mode: str | None = None
        self.target_syms: set[str] = set()
        self.idx_quotes: dict[str, dict] = {}
        self.idx_chg_min: float | None = None
        self.index_lists: dict[str, list[str]] = {}

        self._auth_check_at = 0.0
        self.started = time.time()
        self.last_tick = 0.0
        self.sector_map: dict[str, str] = {}
        self.tf_cache: dict[tuple[str, int], tuple[float, list[dict]]] = {}

    def _fetch_user(self) -> None:
        try:
            prof = self.client.profile()
            d = (prof.get("data") or {})
            self.user = (d.get("user_name") or d.get("user_id")
                         or d.get("email") or "-")
        except Exception:                           # noqa: BLE001
            pass

    def sector(self, sym: str) -> str:
        if not self.sector_map:
            for name in reversed(SECTOR_PRIORITY):
                slug = next((sl for nm, sl, _k in INDEX_CATALOG
                             if nm == name), "")
                if not slug:
                    continue
                for s in self.index_members(name):
                    self.sector_map[s] = name
        return self.sector_map.get(sym, "")

    # --------------------------------------------------------------- run ---
    def run(self) -> None:
        rows = self.client.load_master()
        stocks: dict[str, dict] = {}
        if rows:
            try:
                stocks, idx = self.client.build_universe(rows)
                self.idx_master = idx
            except Exception as e:                  # noqa: BLE001
                self.master_msg = f"master parse failed: {str(e)[:60]}"
        if not stocks:
            stocks = {s: {"symbol": s, "name": s, "key": f"NSE_EQ|{s}",
                          "fut": "", "fut_us": ""} for s in SAMPLE_SYMBOLS}
        self.universe_meta = stocks
        with self.lock:
            self.states = {sym: SymbolState(sym, info.get("key", ""),
                                            info.get("name") or sym)
                           for sym, info in stocks.items()}
            for sym, st in self.states.items():
                info = stocks[sym]
                st.fut = info.get("fut")
                st.fut_us = info.get("fut_us")
            self.master_msg = f"F&O master loaded: {len(stocks)} stocks"
            self.phase.update({"total": len(stocks)})

        threading.Thread(target=self._opt_worker, daemon=True,
                         name="ictob-opt").start()
        threading.Thread(target=self._oi_worker, daemon=True,
                         name="ictob-oi").start()

        ok, msg = self.client.valid()
        self.demo = not ok
        self.auth_msg = msg
        if not self.demo:
            self._fetch_user()
        if self.demo:
            self._run_demo()
        else:
            self._run_live()

    # ---------------------------------------------------------- simulated ---
    def _run_demo(self) -> None:
        today = date.today()
        days = [today - timedelta(days=1), today]
        with self.lock:
            for i, (sym, st) in enumerate(self.states.items()):
                daily = sample.daily_candles(sym)
                st.daily_prev = daily
                st.prev_close = float(daily[-1]["c"]) if daily else 0.0
                for d in days:
                    st.candles[d.isoformat()] = sample.session_candles(
                        sym, d, st.prev_close, tag="session")
                st.ltp = float(st.candles[today.isoformat()][-1]["c"])
                st.warmed = True
                self._compute(st)
                self.phase.update({"done": i + 1, "total": len(self.states)})
        self._rank_rallies()
        self._demo_indices()
        cycle = 0
        while not self.stop_evt.is_set():
            cycle += 1
            items = list(self.states.items())
            for k in range(0, len(items), 50):          # keep the API responsive
                with self.lock:
                    for sym, st in items[k:k + 50]:
                        rows = st.candles.get(today.isoformat()) or []
                        if rows:
                            sample.tick_last(rows, sym, time.time())
                            st.ltp = float(rows[-1]["c"])
                        self._compute(st)
            # A fresh login (web callback or pasted token) must lift the
            # scanner out of sample mode on its own - no process restart.
            if time.time() - self._auth_check_at > 20.0:
                self._auth_check_at = time.time()
                ok, msg = self.client.valid(ttl=15)
                if ok:
                    self.demo = False
                    self.auth_msg = msg
                    self._fetch_user()
                    self.phase.update({"phase": "warmup",
                                       "msg": "Token accepted - switching to LIVE"})
                    return self._run_live()

            with self.lock:
                self._rank_rallies()
                self._demo_indices()
                self.phase.update({
                    "phase": "scan", "done": len(self.states),
                    "total": len(self.states), "cycle": cycle,
                    "errors": 0,
                    "msg": f"Sample sweep {cycle} · {len(self.states)} F&O stocks",
                })
                self.last_tick = time.time()
            self.stop_evt.wait(3.0)

    def _demo_indices(self) -> None:
        for name, _slug, _up in INDEX_CATALOG:
            chg = sample.index_change(name)
            base = INDEX_LEVEL.get(name, 10000)
            ltp = round(base * (1 + chg / 100.0), 2)
            self.idx_quotes[name] = {
                "ltp": ltp, "prev": float(base), "chg": chg}

    # --------------------------------------------------------------- live ---
    def _run_live(self) -> None:
        st_list = list(self.states.values())
        self.phase.update({"phase": "warmup", "msg": "Warming up (F&O master loaded)..."})
        for i, st in enumerate(st_list):
            if self.stop_evt.is_set():
                return
            try:
                self._fetch_day_hist(st)
                self._compute(st)
            except UpstoxAuthError:
                self.auth_msg = "token expired — login again"
                self.demo = True
                return self._run_demo()
            except Exception as e:                  # noqa: BLE001
                st.error = str(e)[:120]
            self.phase.update({"phase": "warmup", "done": i + 1,
                               "total": len(st_list),
                               "msg": f"Warming up {st.symbol} ({i + 1}/{len(st_list)})"})
            time.sleep(REQUEST_PAUSE)
        self._fetch_ltp()
        cycle = 0
        while not self.stop_evt.is_set():
            cycle += 1
            errs = 0
            order = list(self.states.values())
            if self.selected and self.selected in self.states:
                fs = self.states[self.selected]
                order.remove(fs)
                order.insert(0, fs)
            for i, st in enumerate(order):
                if self.stop_evt.is_set():
                    return
                try:
                    self._refresh_intraday(st)
                    self._compute(st)
                except UpstoxAuthError:
                    self.auth_msg = "token expired — login again"
                    self.demo = True
                    return self._run_demo()
                except Exception as e:              # noqa: BLE001
                    st.error = str(e)[:120]
                    errs += 1
                if i % 10 == 0:
                    self.phase.update({"phase": "scan", "done": i + 1,
                                       "total": len(order),
                                       "msg": f"Scanning {st.symbol} ({i + 1}/{len(order)})",
                                       "cycle": cycle, "errors": errs})
                    self._rank_rallies()
                time.sleep(REQUEST_PAUSE)
            self._fetch_ltp()
            self._fetch_indices()
            self._rank_rallies()
            self.phase.update({"phase": "idle", "done": len(order),
                               "total": len(order), "cycle": cycle,
                               "errors": errs,
                               "msg": f"Cycle {cycle} complete - errors: {errs}"})
            self.stop_evt.wait(CYCLE_SLEEP)

    def _fetch_day_hist(self, st: SymbolState) -> None:
        today = date.today()
        rows = self.client.candles_hist(st.key, 5, today,
                                        today - timedelta(days=12))
        for c in rows:
            st.candles.setdefault(c["ts"].strftime("%Y-%m-%d"), []).append(c)
        try:
            st.daily_prev = self.client.candles_day(
                st.key, today, today - timedelta(days=120))
        except Exception:                           # noqa: BLE001
            st.daily_prev = []
        if st.daily_prev:
            try:
                st.prev_close = float(st.daily_prev[-1]["c"] or 0.0)
            except Exception:                       # noqa: BLE001
                st.prev_close = 0.0
        st.warmed = True

    def _refresh_intraday(self, st: SymbolState) -> None:
        rows = self.client.candles_intraday(st.key, 5)
        if not rows:
            return
        di = rows[0]["ts"].strftime("%Y-%m-%d")
        merged = {c["ts"]: c for c in st.candles.get(di, [])}
        for c in rows:
            merged[c["ts"]] = c
        st.candles[di] = [merged[k] for k in sorted(merged)]

    def _fetch_ltp(self) -> None:
        try:
            keys = [s.key for s in self.states.values() if s.key]
            d = self.client.ltp(keys)
        except UpstoxAuthError:
            raise
        except Exception as e:                      # noqa: BLE001
            self.phase["msg"] = f"Quote fetch failed: {str(e)[:80]}"
            return
        by_sym = {}
        for k, v in (d or {}).items():
            tok = str(k).split(":")[-1].split("|")[-1]
            by_sym[tok] = v
        with self.lock:
            for st in self.states.values():
                q = (d.get(f"NSE_EQ:{st.symbol}") or by_sym.get(st.symbol)
                     or d.get(st.key))
                if not q:
                    continue
                lp = q.get("last_price") or q.get("ltp")
                try:
                    if lp:
                        st.ltp = float(lp)
                except (TypeError, ValueError):
                    pass

    def _fetch_indices(self) -> None:
        if self.index_mode is None and not self.target_syms:
            return
        want: dict[str, tuple] = {}
        for disp, _slug, up_name in INDEX_CATALOG:
            if not up_name:
                continue
            key = (self.idx_master.get(up_name)
                   or f"NSE_INDEX|{up_name}")
            want[key] = ("index", disp)
        for st in self.states.values():
            if st.symbol in self.target_syms:
                want[st.key] = ("state", st)
        try:
            d = self.client.quotes_v2(list(want))
        except UpstoxAuthError:
            raise
        except Exception:                           # noqa: BLE001
            return
        by_tok = {}
        for k, v in want.items():
            by_tok[k] = v
            by_tok[str(k).split("|")[-1]] = v
        for rk, q in (d or {}).items():
            hit = (by_tok.get(rk)
                   or by_tok.get(str(rk).split("|")[-1])
                   or by_tok.get(str(rk).split(":")[-1]))
            if not hit or not isinstance(q, dict):
                continue
            lp = _num(q.get("last_price") or q.get("ltp"))
            pc = _num(q.get("prev_close_price")
                      or (q.get("prev_ohlc") or {}).get("close"))
            if pc <= 0:
                nc = _num(q.get("net_change"))
                pc = (lp - nc) if nc and lp else 0.0
            what, obj = hit
            if what == "index":
                rec = self.idx_quotes.setdefault(
                    obj, {"ltp": 0.0, "prev": 0.0, "chg": None})
                if lp > 0:
                    rec["ltp"] = lp
                if pc > 0:
                    rec["prev"] = pc
                if rec["ltp"] > 0 and rec["prev"] > 0:
                    rec["chg"] = (rec["ltp"] - rec["prev"]) / rec["prev"] * 100
            else:
                obj.prev_close = pc or obj.prev_close
                if lp > 0:
                    obj.ltp = lp

    # ------------------------------------------------------------ compute ---
    def _compute(self, st: SymbolState) -> None:
        merged: list[dict] = []
        for di in sorted(st.candles):
            merged.extend(st.candles[di])
        if not merged:
            return
        st.view5 = merged
        st.result = run_engine(merged, st.daily_prev, IND)
        obs = st.result["obs"]
        st.max_x = max_ob_volx(st.result)
        st.n_obs = st.n_active = sum(1 for ob in obs if ob["active"])
        st.n_bull = st.result["n_bull_active"]
        st.n_bear = st.result["n_bear_active"]
        st.error = None
        st.last_utc = time.time()

    def _rank_rallies(self) -> None:
        with self.lock:
            syms = list(self.states.values())
            today_di = date.today().isoformat()
            vols = []
            for s in syms:
                day = latest_day_candles(s, today_di)
                vols.append(sum(float(c.get("v") or 0.0) for c in (day or [])))
            ordered = sorted(vols)
            n = max(1, len(syms))
            for s, v in zip(syms, vols):
                vrank = (bisect.bisect_left(ordered, v) / n) if v > 0 else 0.5
                try:
                    s.rally_dir, s.rally_score = rally_score_symbol(s, vrank)
                except Exception:                   # noqa: BLE001
                    s.rally_dir, s.rally_score = None, 0.0

    # ------------------------------------------------------- option strip ---
    def strip_fetch_exp_and_chain(self, spot_key: str) -> tuple[str, list]:
        today = datetime.now(IST).strftime("%Y-%m-%d")
        contracts = self.client.option_contracts(spot_key)
        exps = set()
        for c in contracts:
            if not isinstance(c, dict):
                continue
            e = c.get("expiry") or c.get("expiry_date")
            if e and str(e) >= today:
                exps.add(str(e))
        if not exps:
            return "", []
        expiry = sorted(exps)[0]
        return expiry, [r for r in self.client.option_chain(spot_key, expiry)
                        if isinstance(r, dict)]

    def build_strip(self, st: SymbolState) -> tuple[dict | None, str]:
        """The SM-Rally OI strip for one symbol, exactly as the app builds it."""
        if self.demo:
            day = latest_day_candles(st, date.today().isoformat())
            spot = st.ltp or (float(day[-1]["c"]) if day else 0.0)
            if spot <= 0:
                return None, "no price yet"
            pct = ((st.ltp / float(day[0]["o"]) - 1.0) * 100.0
                   if day and float(day[0]["o"]) else 0.0)
            expiry, chain = sample.option_chain(st.symbol, spot, st.ltp, pct)
        else:
            try:
                expiry, chain = self.strip_fetch_exp_and_chain(st.key)
            except UpstoxAuthError:
                raise
            except Exception as e:                  # noqa: BLE001
                return None, str(e)[:140]
            if not chain:
                return None, ("no option chain for " + st.symbol
                              + (f" (expiry {expiry})" if expiry
                                 else " — no listed option expiry"))
            day = latest_day_candles(st, date.today().isoformat())
            pct = None
            if day and st.ltp:
                o = float(day[0].get("o") or 0)
                pct = (st.ltp / o - 1.0) * 100.0 if o else None

        strip = build_oi_strip(symbol=st.symbol, sect_key=st.key,
                               chain_raw=chain, expiry=expiry, tpm=[], pct=pct)
        track = strip.get("track") or {}
        tpm: list[dict] = []
        if track.get("key"):
            if self.demo:
                tpm = sample.tpm_bars(st.symbol)
            else:
                for c in self.client.option_intraday_1m(track["key"]):
                    tpm.append({"t": c["ts"].strftime("%H:%M"),
                                "v": c.get("v") or 0})
        if tpm:
            strip = build_oi_strip(symbol=st.symbol, sect_key=st.key,
                                   chain_raw=chain, expiry=expiry, tpm=tpm,
                                   pct=pct)
        return strip, ""

    def _opt_worker(self) -> None:
        """Always-on option + TPM lane (drives OPTION + TPM and RALLY + OPT)."""
        while not self.stop_evt.is_set():
            if not self.states:
                time.sleep(2.0)
                continue
            done = n = 0
            for s in sorted(self.states.values(), key=lambda x: x.symbol):
                if self.stop_evt.is_set():
                    return
                n += 1
                now = time.time()
                rec = self.opt_rank.get(s.symbol)
                if rec and now - rec[0] < OPT_ENTRY_TTL:
                    continue
                if s.ltp <= 0:
                    continue
                try:
                    strip, reason = self.build_strip(s)
                except UpstoxAuthError:
                    self.demo = True
                    self.auth_msg = "token expired — login again"
                    time.sleep(2.0)
                    continue
                except Exception as e:              # noqa: BLE001
                    strip, reason = None, str(e)[:140]
                if strip:
                    self.opt_favor[s.symbol] = strip.get("day_favor") or ""
                    track = strip.get("track") or {}
                    opt = float(track.get("score") or 0.0)
                    cont = float(strip.get("cont") or 0.0)
                    tpm_known = len(strip.get("tpm") or []) >= 30
                    comb = ((opt + cont) / 2.0) if tpm_known else opt
                    self.opt_rank[s.symbol] = (now, round(opt, 1),
                                               round(cont, 0), round(comb, 1))
                    self.opt_error.pop(s.symbol, None)
                    rally = float(getattr(s, "rally_score", 0.0) or 0.0)
                    if rally >= RALLY_COLOR_MIN:
                        popt = ((rally + comb) / 2.0
                                if tpm_known else rally * 0.85)
                        self.rally_opt[s.symbol] = round(popt, 1)
                    else:
                        self.rally_opt.pop(s.symbol, None)
                else:
                    self.opt_rank[s.symbol] = (now + OPT_ENTRY_TTL / 2,
                                               0.0, 0.0, None)
                    if reason:
                        self.opt_error[s.symbol] = reason
                done += 1
                time.sleep(0.02 if self.demo else 0.6)
            time.sleep(2.0 if self.demo else 5.0)

    def _oi_worker(self) -> None:
        """Refresh the OI strip for the selected stock every 15 seconds."""
        while not self.stop_evt.is_set():
            sym = self.selected
            if sym and sym in self.states:
                last = self.oi_cache.get(sym)
                if not last or time.time() - last[0] >= OI_REFRESH_SEC:
                    st = self.states[sym]
                    try:
                        strip, reason = self.build_strip(st)
                    except Exception as e:          # noqa: BLE001
                        strip, reason = None, str(e)[:140]
                    self.oi_cache[sym] = (time.time(), strip, reason)
            time.sleep(0.5)

    def oi_strip(self, symbol: str) -> dict:
        sym = (symbol or self.selected or "").upper()
        rec = self.oi_cache.get(sym)
        if rec:
            ts, strip, reason = rec
            if strip:
                return {"strip": strip, "age": int(time.time() - ts),
                        "error": ""}
            return {"strip": None, "age": int(time.time() - ts),
                    "error": reason}
        return {"strip": None, "age": 0, "error": ""}

    # ------------------------------------------------------------- indices ---
    def _index_slug(self, disp: str) -> str | None:
        return next((sl for nm, sl, _k in INDEX_CATALOG if nm == disp), None)

    def index_members(self, disp: str) -> list[str]:
        slug = self._index_slug(disp)
        if not slug:
            return []
        if slug in self.index_lists:
            return self.index_lists[slug]
        path = self.root / "data" / "sentinel_cache" / f"index_{slug}.json"
        syms: list[str] = []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                syms = [str(s).upper() for s in raw.get("symbols") or []]
            elif isinstance(raw, list):
                syms = [str(s).upper() for s in raw]
        except (OSError, ValueError):
            syms = []
        if syms:
            self.index_lists[slug] = syms
        return syms

    def set_index(self, disp: str | None) -> dict:
        with self.lock:
            self.index_mode = disp
            self.target_syms = set()
            if disp:
                members = self.index_members(disp)
                if members:
                    self.target_syms = {s for s in members if s in self.states}
                else:
                    # no published list on disk: show the F&O universe
                    self.target_syms = set(self.states)
            if self.selected and self.target_syms \
                    and self.selected not in self.target_syms:
                self.selected = None
        if disp:                        # paint LTP / chg % right away
            try:
                self._fetch_indices()
            except Exception:           # noqa: BLE001
                pass
        return {"index": disp, "members": len(self.target_syms)}

    def focus_refresh(self, sym: str) -> None:
        """Pull today's intraday bars for the just-clicked stock so its
        chart is on the live session at once (the cycle would otherwise
        reach it only at the next pass)."""
        st = self.states.get(sym)
        if st is None:
            return
        try:
            self._refresh_intraday(st)
            with self.lock:
                self._compute(st)
                self._rank_rallies()
        except Exception:                   # noqa: BLE001
            pass

    def chg_of(self, sym: str) -> float | None:
        q = self.idx_quotes.get(sym)
        if q is not None:
            return q.get("chg")
        st = self.states.get(sym)
        if st is not None and st.prev_close > 0 and st.ltp > 0:
            return (st.ltp - st.prev_close) / st.prev_close * 100.0
        return None

    # ------------------------------------------------------------- ranking ---
    def _strip_tag(self, sym: str, st: SymbolState | None) -> str:
        if st is None:
            return ""
        if st.rally_dir and st.rally_score >= RALLY_COLOR_MIN:
            bull = st.rally_dir == "BULL"
            strong = st.rally_score >= 75.0
            base = "bull" if bull else "bear"
            fav = self.opt_favor.get(sym)
            oi_ok = (fav in ("LONG BUILDUP", "SHORT COVERING") if bull
                     else fav in ("SHORT BUILDUP", "LONG UNWINDING"))
            if oi_ok:
                return f"rally_oi_{base}_{'strong' if strong else 'mid'}"
            return f"{base}_{'strong' if strong else 'mid'}"
        return ""

    def _rally_cell(self, s: SymbolState) -> str:
        popt = self.rally_opt.get(s.symbol)
        arrow = ("▲" if s.rally_dir == "BULL"
                 else "▼" if s.rally_dir == "BEAR" else "")
        if popt is not None:
            return f"{arrow}{popt:.0f}"
        rs = float(s.rally_score or 0.0)
        if s.rally_dir and rs >= RALLY_COLOR_MIN:
            return f"{arrow}{rs:.0f}"
        return "—"

    def _rally_rank(self, sym: str, st: SymbolState) -> float:
        popt = self.rally_opt.get(sym)
        rs = float(st.rally_score or 0.0)
        if popt is not None:
            score = float(popt)
            dirn = st.rally_dir
        elif st.rally_dir and rs >= RALLY_COLOR_MIN:
            score, dirn = rs, st.rally_dir
        else:
            return 100.0
        if dirn not in ("BULL", "BEAR"):
            return 100.0
        return 200.0 + score if dirn == "BULL" else -100.0 + score

    def rows(self) -> list[dict]:
        with self.lock:
            filt = (self.filter or "").upper()
            if self.mode == "INDICES":
                return self._index_rows()
            out = []
            for sym, s in self.states.items():
                if filt and filt not in sym:
                    continue
                if self.mode == "RALLY + OPT":
                    if not (s.rally_dir and s.rally_score >= RALLY_COLOR_MIN):
                        continue
                    popt = self.rally_opt.get(sym)
                    cell = (f"{popt:.0f}" if popt is not None
                            else f"{s.rally_score:.0f}")
                    out.append((1e9 if popt is None else -popt, sym,
                                cell))
                elif self.mode == "OPTION + TPM":
                    rec = self.opt_rank.get(sym)
                    comb = rec[3] if rec and len(rec) == 4 else None
                    cell = ("…" if comb is None else f"{comb:.0f}") if rec \
                        else "…"
                    out.append((1e9 if comb is None else -comb, sym, cell))
                else:
                    top_dir = ""
                    if s.result and s.result["obs"]:
                        best = max((ob for ob in s.result["obs"]
                                    if ob["active"]),
                                   key=lambda ob: ob["vol_ratio"], default=None)
                        if best:
                            top_dir = "▲" if best["dir"] == 1 else "▼"
                    out.append((-s.max_x, -s.n_obs, sym, s, top_dir))
            if self.mode in ("RALLY + OPT", "OPTION + TPM"):
                out.sort(key=lambda r: (r[0], r[1]))
                rows = []
                for _k, sym, cell in out:
                    s = self.states[sym]
                    tag = self._strip_tag(sym, s)
                    if not tag and s.rally_dir and s.rally_score >= RALLY_COLOR_MIN:
                        tag = ("bull" if s.rally_dir == "BULL" else "bear")
                    rows.append({
                        "s": sym, "x": (f"{s.max_x:.1f}x" if s.max_x else "—"),
                        "obs": s.n_obs, "cell": cell,
                        "ltp": (f"{s.ltp:.2f}" if s.ltp else "—"),
                        "tag": tag, "chg": self.chg_of(sym),
                    })
                return rows
            out.sort(key=lambda r: (r[0], r[1], r[2]))
            rows = []
            for _nx, _n, sym, s, top_dir in out:
                tag = self._strip_tag(sym, s)
                rows.append({
                    "s": sym, "x": (f"{s.max_x:.1f}x" if s.max_x else "—"),
                    "obs": s.n_obs, "cell": top_dir,
                    "ltp": (f"{s.ltp:.2f}" if s.ltp else "—"),
                    "tag": tag, "chg": self.chg_of(sym),
                })
            return rows

    def _index_rows(self) -> list[dict]:
        out = []
        for disp, _slug, _k in INDEX_CATALOG:
            q = self.idx_quotes.get(disp) or {}
            chg, ltp = q.get("chg"), float(q.get("ltp") or 0.0)
            xf = "…" if chg is None else f"{chg:+.2f}%"
            tag = ""
            if chg is not None:
                tag = ("bull_strong" if chg >= 2.0
                       else "bull" if chg > 0
                       else "bear_strong" if chg <= -2.0 else "bear")
            out.append({"s": disp, "x": xf, "obs": "", "cell": "",
                        "ltp": f"{ltp:,.2f}" if ltp else "—",
                        "tag": tag, "chg": chg, "index": True})
        out.sort(key=lambda r: -(r["chg"] if r["chg"] is not None else -1e9))
        return out

    def constituent_rows(self) -> list[dict]:
        with self.lock:
            if not self.index_mode:
                return []
            filt = (self.filter or "").upper()
            out = []
            for sym in sorted(self.target_syms):
                if filt and filt not in sym:
                    continue
                st = self.states.get(sym)
                if st is None:
                    continue
                chg = self.chg_of(sym)
                if self.idx_chg_min is not None and (
                        chg is None or chg < self.idx_chg_min):
                    continue
                out.append((-self._rally_rank(sym, st),
                            -(chg if chg is not None else -1e9),
                            sym, st, chg))
            out.sort(key=lambda r: (r[0], r[1], r[2]))
            rows = []
            for _rk, _ck, sym, st, chg in out:
                tag = self._strip_tag(sym, st)
                if not tag and chg is not None:
                    tag = ("bull_strong" if chg >= 2.0
                           else "bull" if chg > 0
                           else "bear_strong" if chg <= -2.0 else "bear")
                rows.append({
                    "s": sym,
                    "x": "…" if chg is None else f"{chg:+.2f}%",
                    "obs": st.n_obs, "cell": self._rally_cell(st),
                    "ltp": f"{st.ltp:,.2f}" if st.ltp else "—",
                    "tag": tag, "chg": chg,
                })
            return rows

    def meter(self) -> dict:
        with self.lock:
            bulls, bears, flat = [], [], 0
            for s in self.states.values():
                rs = float(s.rally_score or 0.0)
                if s.rally_dir not in ("BULL", "BEAR") or rs < RALLY_COLOR_MIN:
                    flat += 1
                    continue
                popt = self.rally_opt.get(s.symbol)
                score = rs if popt is None else float(popt)
                (bulls if s.rally_dir == "BULL" else bears).append(
                    (score, s.symbol))
            bulls.sort(key=lambda r: (-r[0], r[1]))
            bears.sort(key=lambda r: (-r[0], r[1]))

            def cells(items):
                out = []
                for _score, sym in items[:3]:
                    chg = self.chg_of(sym)
                    out.append({"s": sym,
                                "chg": ("…" if chg is None
                                        else f"{chg:+.2f}%")})
                return out
            return {"up": len(bulls), "down": len(bears), "flat": flat,
                    "top": cells(bulls), "worst": cells(bears)}

    # --------------------------------------------------------------- chart ---
    def chart(self, symbol: str | None, tf: int = 5,
              cut: int | None = None) -> dict:
        sym = (symbol or self.selected or "").upper()
        st = self.states.get(sym)
        if st is None:
            return {"error": "unknown symbol"}
        merged = st.view5 or []
        if not merged:
            return {"error": "no candle data yet", "symbol": sym}

        if tf == 5:
            series = merged
        else:
            day_rows = []
            for di in sorted(st.candles):
                day_rows.extend(st.candles[di])
            series = sample.aggregate(day_rows, tf) if self.demo else \
                self._tf_candles(st, tf) or sample.aggregate(day_rows, tf)

        last_di = series[-1]["ts"].date() if series else None
        view = [c for c in series if c["ts"].date() == last_di]
        if not view:
            return {"error": "no candle data yet", "symbol": sym}
        if cut is not None:
            view = view[:max(2, min(int(cut) + 1, len(view)))]

        # engine result for exactly the visible history
        if cut is None:
            result = st.result or {}
            used = merged
        else:
            cutoff = view[-1]["ts"]
            used = [c for c in merged if c["ts"] <= cutoff]
            result = run_engine(used, st.daily_prev, IND)
        vis_ts = {c["ts"]: i for i, c in enumerate(view)}
        vis_list = [c["ts"] for c in view]

        def bar_of(ts):
            """Bar index containing ts (exact for 5m, else the enclosing
            higher-timeframe bar — the desktop chart bisects the same way)."""
            hit = vis_ts.get(ts)
            if hit is not None:
                return hit
            pos = _bisect_ts.bisect_right(vis_list, ts) - 1
            return pos if pos >= 0 else None

        obs = []
        for ob in result.get("obs") or []:
            if not ob.get("active"):
                continue
            x0 = bar_of(ob["origin_ts"])
            if x0 is None:
                continue
            obs.append({
                "dir": ob["dir"], "top": round(ob["top"], 2),
                "bottom": round(ob["bottom"], 2),
                "mid": round(ob["mid"], 2),
                "x0": x0, "grade": ob["grade"],
                "tag": ob.get("sweep_tag") or "",
                "fvg": bool(ob.get("fvg")),
                "vol_ratio": round(float(ob.get("vol_ratio") or 0), 2),
                "bos": bool(ob.get("bos")),
            })
        vwap = []
        for d, seg in result.get("vwap_day_parts") or []:
            if d != last_di:
                continue
            for c_ts, val in seg:
                i = vis_ts.get(c_ts)
                if i is not None and val is not None:
                    vwap.append([i, round(val, 2)])
        last = float(view[-1]["c"])
        first = float(view[0]["o"])
        oi = self.oi_cache.get(sym)
        return {
            "symbol": sym,
            "name": st.name,
            "tf": tf,
            "demo": self.demo,
            "candles": [[int(c["ts"].timestamp() * 1000), c["o"], c["h"],
                         c["l"], c["c"], int(c.get("v") or 0)] for c in view],
            "obs": obs,
            "vwap": vwap,
            "htf": result.get("htf") or {},
            "sector": self.sector(sym),
            "badge": "SAMPLE" if self.demo else "LIVE",
            "rel_vol": round(float(result.get("rel_vol") or 0), 2),
            "max_x": round(st.max_x, 2),
            "last": round(last, 2),
            "pct": round((last - first) / first * 100.0, 2) if first else 0.0,
            "prev_close": round(st.prev_close, 2),
            "ltp": round(st.ltp, 2),
            "countdown": _countdown(tf),
            "oi_ready": bool(oi and oi[1]),
            "cut": cut,
        }

    def _tf_candles(self, st: SymbolState, tf: int) -> list[dict]:
        """Non-5m chart series, cached for 60s like the Tk app's chart cache."""
        key = (st.key, tf)
        hit = self.tf_cache.get(key)
        now = time.time()
        if hit and now - hit[0] < 60.0:
            return hit[1]
        try:
            rows = self.client.candles_intraday(st.key, tf)
        except Exception:                           # noqa: BLE001
            return hit[1] if hit else []
        if rows:
            self.tf_cache[key] = (now, rows)
            return rows
        return hit[1] if hit else []

    # --------------------------------------------------------------- state ---
    def snapshot(self) -> dict:
        with self.lock:
            errs = sum(1 for s in self.states.values() if s.error)
            return {
                "demo": self.demo,
                "auth": {"message": self.auth_msg, "user": self.user},
                "master": self.master_msg,
                "tracking": len(self.states),
                "phase": dict(self.phase),
                "errors": errs,
                "selected": self.selected,
                "mode": self.mode,
                "tv": self.tf,
                "vol": self.vol_candles,
                "filter": self.filter,
                "index": self.index_mode,
                "idx_chg_min": self.idx_chg_min,
                "indices": self._index_rows() if self.mode == "INDICES" else [],
                "constituents": (self.constituent_rows()
                                 if self.mode == "INDICES" and self.index_mode
                                 else []),
                "rows": self.rows(),
                "meter": self.meter(),
                "utc": datetime.utcnow().strftime("%H:%M:%S"),
                "session": _session_label(),
            }


def _num(x, default: float = 0.0) -> float:
    try:
        return float(x) if x is not None else default
    except (TypeError, ValueError):
        return default


def _countdown(tf: int) -> str:
    now = datetime.now(IST)
    step = max(1, int(tf)) * 60
    rem = step - (now.hour * 3600 + now.minute * 60 + now.second) % step
    return f"{rem // 60}:{rem % 60:02d}"


def _session_label() -> str:
    now = datetime.now(IST)
    if now.weekday() >= 5:
        return "CLOSED"
    t = now.hour * 60 + now.minute
    if t < 9 * 60 + 15:
        return "PRE"
    if t <= 15 * 60 + 30:
        return "LIVE"
    return "CLOSED"
