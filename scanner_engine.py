"""Market engine for the OB Sentinel web terminal.

One engine object serves the website. It keeps a live view of the NSE F&O
universe, scores every symbol with the SM-Rally pattern engine, enriches the
leaders with option-detail grades, and tracks the NSE index board.

When the stored Upstox token is missing/expired the engine runs a clearly
flagged simulated feed, so the terminal is always operable.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
from collections import deque
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

import requests

from scanner_core import (
    INDEX_CATALOG, IST, build_option_detail, fetch_index_list, load_sectors,
    market_session, oi_strip_grade, rally_score, refresh_sectors,
    volume_rank,
)

API_BASE = "https://api.upstox.com"
UA = {"User-Agent": "ob-sentinel/1.0", "Accept": "application/json"}
OPT_TTL = 300.0          # option-detail freshness per symbol
QUOTE_EVERY = 6.0        # universe quote refresh
INDEX_EVERY = 12.0       # index board refresh
SPARK_EVERY = 90.0       # index sparkline refresh
OI_EVERY = 25.0          # futures OI refresh


def _f(x, default=0.0) -> float:
    try:
        if x is None:
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


class Upstox:
    """Minimal Upstox REST client (login, quotes, candles, option chain)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.token_file = self.root / "upstox_token.json"
        self.cred_file = self.root / "config" / "credentials.json"
        self.session = requests.Session()
        self._tok = ""
        self._valid: tuple[float, bool, str] | None = None

    # ------------------------------------------------------------- auth ---
    def credentials(self) -> dict:
        try:
            c = json.loads(self.cred_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            c = {}
        # a deployed copy has no config/ directory; the env supplies the app
        for key, env in (("api_key", "UPSTOX_API_KEY"),
                         ("api_secret", "UPSTOX_API_SECRET"),
                         ("redirect_uri", "UPSTOX_REDIRECT_URI")):
            if os.environ.get(env):
                c[key] = os.environ[env]
        return c

    def token(self) -> str:
        if self._tok:
            return self._tok
        try:
            tok = str(json.loads(self.token_file.read_text(
                encoding="utf-8")).get("access_token") or "")
        except (OSError, ValueError):
            tok = ""
        # a restarted instance starts with no file; the env keeps it live
        return tok or os.environ.get("UPSTOX_ACCESS_TOKEN", "").strip()

    def save_token(self, token: str, api_key: str = "") -> None:
        # keep it in memory first: a host with an ephemeral or read-only disk
        # still serves the live feed until it restarts
        self._tok = token.strip()
        self._valid = None
        try:
            self.token_file.write_text(json.dumps({
                "access_token": self._tok,
                "obtained_at": time.time(),
                "api_key": api_key,
            }, indent=2), encoding="utf-8")
        except OSError:
            pass

    def check_token(self, tok: str) -> bool:
        """True when Upstox accepts this token (no state touched)."""
        try:
            r = requests.get(f"{API_BASE}/v2/user/profile",
                             headers={**UA,
                                      "Authorization": f"Bearer {tok}"},
                             timeout=12)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def login_url(self, state: str = "ob-sentinel") -> str:
        c = self.credentials()
        q = urlencode({
            "response_type": "code",
            "client_id": c.get("api_key", ""),
            "redirect_uri": c.get("redirect_uri", ""),
            "state": state,
        }, quote_via=quote)
        return f"{API_BASE}/v2/login/authorization/dialog?{q}"

    def exchange_code(self, code: str) -> dict:
        c = self.credentials()
        r = requests.post(
            f"{API_BASE}/v2/login/authorization/token",
            headers={"Accept": "application/json",
                     "Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "ob-sentinel/1.0"},
            data={"code": code,
                  "client_id": c.get("api_key", ""),
                  "client_secret": c.get("api_secret", ""),
                  "redirect_uri": c.get("redirect_uri", ""),
                  "grant_type": "authorization_code"},
            timeout=25)
        d = r.json()
        tok = d.get("access_token")
        if not tok:
            raise RuntimeError(f"token exchange failed: {str(d)[:200]}")
        self.save_token(tok, c.get("api_key", ""))
        return d

    def valid(self, ttl: float = 45.0) -> tuple[bool, str]:
        """(authorized, message) — cached so the UI can poll cheaply."""
        tok = self.token()
        if not tok:
            return False, "no token"
        if self._valid and time.time() - self._valid[0] < ttl:
            return self._valid[1], self._valid[2]
        try:
            r = requests.get(f"{API_BASE}/v2/user/profile",
                             headers={**UA,
                                      "Authorization": f"Bearer {tok}"},
                             timeout=15)
            if r.status_code == 200:
                self._valid = (time.time(), True, "authorized")
                return True, "authorized"
            msg = ("token expired — Upstox tokens die at 3:30 AM"
                   if r.status_code == 401 else f"HTTP {r.status_code}")
            self._valid = (time.time(), False, msg)
            return False, msg
        except requests.RequestException as e:
            return False, f"network: {str(e)[:80]}"

    # ---------------------------------------------------------- requests ---
    def _get(self, path: str, params: dict | None = None) -> dict:
        token = self.token()
        if not token:
            raise RuntimeError("not authorized")
        r = self.session.get(API_BASE + path, params=params,
                             headers={**UA,
                                      "Authorization": f"Bearer {token}"},
                             timeout=25)
        if r.status_code in (401, 403):
            self._valid = (time.time(), False, f"HTTP {r.status_code}")
            raise PermissionError(r.text[:200])
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
        return r.json()

    def quotes(self, keys: list[str]) -> dict:
        """v2 full quotes (accepts NSE_EQ / NSE_FO / NSE_INDEX keys)."""
        out: dict = {}
        for i in range(0, len(keys), 100):
            chunk = keys[i:i + 100]
            try:
                d = self._get("/v2/market-quote/quotes",
                              {"instrument_key": ",".join(chunk)})
            except (RuntimeError, PermissionError):
                continue
            for k, v in (d.get("data") or {}).items():
                nk = str(k).replace(":", "|")
                out[nk] = v
                # v2 keys the response by trading symbol (NSE_EQ|RELIANCE)
                # while the master stores NSE_EQ|<isin> — index both.
                out["TOK|" + nk.split("|", 1)[-1]] = v
        return out

    def quotes_v3(self, keys: list[str]) -> dict:
        out: dict = {}
        for i in range(0, len(keys), 120):
            chunk = keys[i:i + 120]
            try:
                d = self._get("/v3/market-quote/quotes",
                              {"instrument_key": ",".join(chunk)})
            except (RuntimeError, PermissionError):
                continue
            out.update(d.get("data") or {})
        return out

    def candles_intraday(self, key: str, minutes: int = 5) -> list[dict]:
        try:
            d = self._get(f"/v3/historical-candle/intraday/{quote(key)}"
                          f"/minutes/{minutes}")
        except (RuntimeError, PermissionError):
            return []
        rows = (d.get("data") or {}).get("candles") or []
        out = []
        for row in rows:
            try:
                out.append({"ts": datetime.fromisoformat(row[0]),
                            "o": float(row[1]), "h": float(row[2]),
                            "l": float(row[3]), "c": float(row[4]),
                            "v": float(row[5] or 0)})
            except (ValueError, TypeError, IndexError):
                continue
        out.sort(key=lambda c: c["ts"])
        return out

    def candles_daily(self, key: str, days: int = 45) -> list[dict]:
        """Daily candles for the last `days` calendar days (ascending).

        Used for the desktop indicator's HTF levels: PDH/PDL, PWH/PWL and
        PMH/PML. v3 is tried first, v2 is the fallback.
        """
        end = datetime.now(IST).date()
        start = end - timedelta(days=days)
        paths = (f"/v3/historical-candle/{quote(key)}/days/1/"
                 f"{end.isoformat()}/{start.isoformat()}",
                 f"/v2/historical-candle/{quote(key)}/day/"
                 f"{end.isoformat()}/{start.isoformat()}")
        rows: list = []
        for path in paths:
            try:
                d = self._get(path)
            except (RuntimeError, PermissionError):
                continue
            rows = (d.get("data") or {}).get("candles") or []
            if rows:
                break
        out = []
        for row in rows:
            try:
                out.append({"ts": datetime.fromisoformat(row[0]),
                            "o": float(row[1]), "h": float(row[2]),
                            "l": float(row[3]), "c": float(row[4]),
                            "v": float(row[5] or 0)})
            except (ValueError, TypeError, IndexError):
                continue
        out.sort(key=lambda c: c["ts"])
        return out

    def option_contracts(self, spot_key: str) -> list[dict]:
        try:
            d = self._get("/v2/option/contract",
                          {"instrument_key": spot_key})
        except (RuntimeError, PermissionError):
            return []
        data = d.get("data")
        if isinstance(data, dict):
            data = list(data.values())
        return [c for c in (data or []) if isinstance(c, dict)]

    def option_chain(self, spot_key: str, expiry: str) -> list[dict]:
        try:
            d = self._get("/v2/option/chain",
                          {"instrument_key": spot_key,
                           "expiry_date": expiry})
        except (RuntimeError, PermissionError):
            return []
        data = d.get("data")
        if isinstance(data, dict):
            data = list(data.values())
        return [r for r in (data or []) if isinstance(r, dict)]


# ---------------------------------------------------------------------------
# universe
# ---------------------------------------------------------------------------
def build_universe(root: Path, data_dir: Path) -> tuple[list[dict], dict,
                                                        dict]:
    """(stocks, index_name->instrument_key, f&o futures by symbol)."""
    master = Path(data_dir) / "instruments_cache.json"
    cache = Path(data_dir) / "sentinel_universe.json"
    stamp = master.stat().st_mtime if master.exists() else 0
    hit = None
    try:
        hit = json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        hit = None
    if hit and not master.exists():
        # a fresh container ships only the small universe seed
        return hit["stocks"], hit["indices"], hit["futures"]
    if hit and abs(float(hit.get("stamp") or 0) - stamp) < 1:
        return hit["stocks"], hit["indices"], hit["futures"]

    try:
        rows = json.loads(master.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], {}, {}

    eq: dict[str, dict] = {}
    idx: dict[str, str] = {}
    futs: dict[str, list[dict]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        seg = r.get("segment")
        if seg == "NSE_EQ" and r.get("instrument_type") == "EQ":
            sym = str(r.get("trading_symbol") or r.get("symbol")
                      or "").upper()
            if sym and r.get("instrument_key"):
                eq[sym] = {"key": r["instrument_key"],
                           "name": r.get("name") or sym}
        elif seg == "NSE_INDEX" and r.get("name") and r.get("instrument_key"):
            idx[r["name"]] = r["instrument_key"]
        elif seg == "NSE_FO" and r.get("instrument_type") == "FUT":
            u = str(r.get("underlying_symbol") or "").upper()
            if u and r.get("instrument_key"):
                futs.setdefault(u, []).append({
                    "key": r["instrument_key"],
                    "expiry": int(r.get("expiry") or 0),
                    "symbol": r.get("trading_symbol") or "",
                })

    today = int(datetime.now(IST).timestamp() * 1000)
    stocks = []
    near: dict[str, dict] = {}
    for sym in sorted(futs):
        if sym not in eq:
            continue
        live = [f for f in futs[sym] if f["expiry"] >= today] or futs[sym]
        live.sort(key=lambda f: f["expiry"])
        fut = live[0] if live else None
        stocks.append({"symbol": sym, "key": eq[sym]["key"],
                       "name": eq[sym]["name"],
                       "fut": fut["key"] if fut else "",
                       "fut_symbol": fut["symbol"] if fut else ""})
        if fut:
            near[sym] = fut
    payload = {"stamp": stamp, "stocks": stocks, "indices": idx,
               "futures": near}
    try:
        cache.write_text(json.dumps(payload, separators=(",", ":")),
                         encoding="utf-8")
    except OSError:
        pass
    return stocks, idx, near


# ---------------------------------------------------------------------------
# simulated feed (used until the broker is linked)
# ---------------------------------------------------------------------------
DEMO_INDEX_LEVEL = {
    "NIFTY 50": 25860, "NIFTY BANK": 57420, "NIFTY IT": 39120,
    "NIFTY AUTO": 24810, "NIFTY FMCG": 58940, "NIFTY PHARMA": 22470,
    "NIFTY METAL": 9870, "NIFTY ENERGY": 38640, "NIFTY REALTY": 1085,
    "NIFTY PSU BANK": 7420, "NIFTY FIN SERVICE": 27940, "NIFTY MEDIA": 1790,
    "NIFTY INFRA": 9180, "NIFTY HEALTHCARE": 14320, "NIFTY MNC": 31260,
    "NIFTY CONSUMPTION": 12440, "NIFTY COMMODITIES": 9420,
    "NIFTY OIL & GAS": 11890, "NIFTY MIDCAP 100": 61240,
    "NIFTY MIDCAP 150": 21740, "NIFTY NEXT 50": 74120, "NIFTY 100": 27240,
    "NIFTY 200": 15180, "NIFTY 500": 24160,
}

DEMO_FALLBACK_SYMBOLS = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "AXISBANK",
    "BHARTIARTL", "ITC", "LT", "KOTAKBANK", "HINDUNILVR", "BAJFINANCE",
    "MARUTI", "M&M", "TATAMOTORS", "SUNPHARMA", "TITAN", "ASIANPAINT",
    "ADANIENT", "ADANIPORTS", "POWERGRID", "NTPC", "ONGC", "COALINDIA",
    "TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL", "BPCL", "IOC", "DLF",
    "GODREJPROP", "INDUSINDBK", "PNB", "BANKBARODA", "CANBK", "WIPRO",
    "HCLTECH", "TECHM", "DRREDDY", "CIPLA", "DIVISLAB", "APOLLOHOSP",
    "EICHERMOT", "HEROMOTOCO", "BAJAJ-AUTO", "NESTLEIND", "BRITANNIA",
    "TATACONSUM", "GRASIM", "ULTRACEMCO", "SHREECEM", "AMBUJACEM",
    "ACC", "IDEA", "PIDILITIND", "DABUR", "HAVELLS", "SIEMENS", "ABB",
]


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:12], 16)


class Engine(threading.Thread):
    def __init__(self, root: Path, data_dir: Path):
        super().__init__(daemon=True, name="ob-engine")
        self.root = Path(root)
        self.data_dir = Path(data_dir)
        self.cache_dir = self.data_dir / "sentinel_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.client = Upstox(self.root)
        self.lock = threading.RLock()
        self.stop_evt = threading.Event()

        self.stocks, self.index_keys, self.futures = build_universe(
            self.root, self.data_dir)
        if not self.stocks:
            self.stocks = [{"symbol": s, "key": "", "name": s, "fut": "",
                            "fut_symbol": ""} for s in
                           DEMO_FALLBACK_SYMBOLS]
            self.futures = {}
        self.sector_map: dict[str, str] = load_sectors(self.cache_dir)

        self.rows: dict[str, dict] = {
            s["symbol"]: {"symbol": s["symbol"], "sector": "",
                          "ltp": 0.0, "prev": 0.0, "pct": 0.0, "vol": 0.0,
                          "dh": 0.0, "dl": 0.0, "dir": None, "score": 0.0,
                          "comb": 0.0, "oi": "", "opt": None,
                          "key": s["key"], "fut": s["fut"]}
            for s in self.stocks}
        for sym, row in self.rows.items():
            row["sector"] = self.sector_map.get(sym, "")
        self.indices: list[dict] = [
            {"name": name, "ltp": 0.0, "pct": 0.0, "chg": 0.0,
             "spark": [], "members": None}
            for name, _slug, _up in INDEX_CATALOG]
        self.sparks: dict[str, list[float]] = {}
        self.opt_cache: dict[str, tuple[float, dict]] = {}

        self.scope_name: str | None = None
        self.scope_syms: set[str] = set()
        self.scope_loading = False
        self.index_lists: dict[str, list[str]] = {}

        self.demo = True
        self.auth_msg = "not linked"
        self.phase = {"label": "boosting engine", "done": 0,
                      "total": len(self.stocks), "cycle": 0}
        self.last_tick = 0.0
        self.last_error = ""
        self.started = time.time()
        self.detections: deque = deque(maxlen=80)
        self._scored_once = False

    # --------------------------------------------------------------- run ---
    def run(self) -> None:
        threading.Thread(target=self._universe_worker, daemon=True).start()
        threading.Thread(target=self._sector_worker, daemon=True).start()
        threading.Thread(target=self._opt_worker, daemon=True).start()
        threading.Thread(target=self._spark_worker, daemon=True).start()
        last_q = last_i = last_s = last_oi = 0.0
        while not self.stop_evt.is_set():
            try:
                ok, msg = self.client.valid()
                with self.lock:
                    was_demo = self.demo
                    self.demo = not ok
                    self.auth_msg = msg
                    if was_demo and not self.demo:
                        self._clear_simulated()
                if self.demo:
                    self._demo_cycle()
                else:
                    now = time.time()
                    if now - last_q > QUOTE_EVERY:
                        last_q = now
                        self._live_quotes()
                    if now - last_oi > OI_EVERY:
                        last_oi = now
                        self._live_oi()
                    if now - last_i > INDEX_EVERY:
                        last_i = now
                        self._live_indices()
                    last_s = now
            except Exception as e:                       # noqa: BLE001
                self.last_error = f"{type(e).__name__}: {str(e)[:120]}"
                time.sleep(2.0)
            self.stop_evt.wait(3.0)

    # ------------------------------------------------------- live pieces ---
    def _live_quotes(self) -> None:
        keys = [s["key"] for s in self.stocks if s["key"]]
        data = self.client.quotes(keys)
        if not data:
            return
        got = 0
        with self.lock:
            for s in self.stocks:
                q = data.get(s["key"]) or data.get("TOK|" + s["symbol"])
                if not q:
                    continue
                row = self.rows.get(s["symbol"])
                if row is None:
                    continue
                ltp = _f(q.get("last_price")) or _f(q.get("ltp"))
                ohlc = q.get("ohlc") or {}
                pc = _f(q.get("prev_close_price")) or _f(
                    (q.get("prev_ohlc") or {}).get("close"))
                if not pc:
                    nc = _f(q.get("net_change"))
                    pc = (ltp - nc) if (nc and ltp) else 0.0
                if not pc:
                    pc = _f(ohlc.get("close"))
                dh = max(_f(ohlc.get("high")), _f(ohlc.get("open")), ltp)
                dl = min(x for x in (_f(ohlc.get("low")),
                                     _f(ohlc.get("open")), ltp) if x > 0)
                if ltp <= 0 or dh <= 0 or dl <= 0:
                    continue
                row.update({"ltp": ltp, "prev": pc or ltp,
                            "dh": dh, "dl": dl,
                            "vol": _f(q.get("volume")),
                            "pct": round((ltp - pc) / pc * 100.0, 2)
                            if pc else 0.0})
                got += 1
            self._score_locked()
            self.phase.update({"label": "scanning universe",
                               "done": got, "total": len(self.stocks)})
            self.last_tick = time.time()

    def _live_indices(self) -> None:
        keys = []
        name_by_key = {}
        for name, _slug, up in INDEX_CATALOG:
            key = self.index_keys.get(up) if up else None
            if key:
                keys.append(key)
                name_by_key[key] = name
        data = self.client.quotes(keys)
        if not data:
            return
        with self.lock:
            for card in self.indices:
                up = next((u for n, _s, u in INDEX_CATALOG
                           if n == card["name"]), "")
                key = self.index_keys.get(up) if up else None
                q = data.get(key or "")
                if not q:
                    continue
                ltp = _f(q.get("last_price")) or _f(q.get("ltp"))
                pc = _f(q.get("prev_close_price")) or _f(
                    (q.get("prev_ohlc") or {}).get("close"))
                if not pc:
                    nc = _f(q.get("net_change"))
                    pc = (ltp - nc) if (nc and ltp) else 0.0
                if ltp <= 0:
                    continue
                card.update({
                    "ltp": round(ltp, 2), "prev": round(pc, 2),
                    "chg": round(ltp - pc, 2) if pc else 0.0,
                    "pct": round((ltp - pc) / pc * 100.0, 2) if pc else 0.0,
                })
        self.last_tick = time.time()

    def _clear_simulated(self) -> None:
        """Drop every generated value so the board never mixes sim + live."""
        self.opt_cache.clear()
        self.sparks.clear()
        for card in self.indices:
            card["spark"] = []
        for row in self.rows.values():
            row["oi"] = ""
            row["opt"] = None
            row["comb"] = 0.0

    def _spark_worker(self) -> None:
        while not self.stop_evt.is_set():
            self.stop_evt.wait(SPARK_EVERY if not self.demo else 8.0)
            if self.demo:
                continue
            try:
                self._live_sparks()
            except Exception as e:                   # noqa: BLE001
                self.last_error = f"sparks: {str(e)[:90]}"

    def _live_sparks(self) -> None:
        primary = [c["name"] for c in self.indices]
        for name in primary:
            up = next((u for n, _s, u in INDEX_CATALOG if n == name), "")
            key = self.index_keys.get(up) if up else None
            if not key:
                continue
            rows = self.client.candles_intraday(key, 5)
            if not rows:
                continue
            pts = [c["c"] for c in rows][-72:]
            with self.lock:
                self.sparks[name] = pts
                for card in self.indices:
                    if card["name"] == name:
                        card["spark"] = pts
            time.sleep(0.08)

    def _live_oi(self) -> None:
        fmap = {s["symbol"]: s["fut"] for s in self.stocks if s["fut"]}
        keys = list(fmap.values())
        if not keys:
            return
        data = self.client.quotes_v3(keys)
        if not data:
            return
        norm = {str(k).replace(":", "|"): v for k, v in data.items()}
        pat = re.compile(r"^(.+?)\d{2}[A-Z]{3}FUT$")
        for k, v in data.items():
            m = pat.match(str(k).split(":")[-1].split("|")[-1])
            if m:
                norm["SYM|" + m.group(1)] = v
        with self.lock:
            for sym, fk in fmap.items():
                q = norm.get(fk) or norm.get("SYM|" + sym)
                if not q:
                    continue
                ltp = _f(q.get("last_price"))
                pc = _f(q.get("prev_close_price"))
                oi = _f(q.get("oi"))
                poi = _f(q.get("prev_oi"))
                if oi <= 0 or poi <= 0 or ltp <= 0:
                    continue
                d_price = ltp - pc if pc else _f(q.get("net_change"))
                d_oi = oi - poi
                tag = ""
                if d_price > 0 and d_oi > 0:
                    tag = "LONG BUILD"
                elif d_price < 0 and d_oi > 0:
                    tag = "SHORT BUILD"
                elif d_price > 0 and d_oi < 0:
                    tag = "SHORT COVER"
                elif d_price < 0 and d_oi < 0:
                    tag = "LONG UNWIND"
                if tag and sym in self.rows:
                    self.rows[sym]["oi"] = tag

    # --------------------------------------------------------- simulated ---
    def _demo_cycle(self) -> None:
        now = time.time()
        with self.lock:
            for i, s in enumerate(self.stocks):
                sym = s["symbol"]
                h = _seed(sym, date.today().isoformat())
                prev = 45 + (h % 420000) / 100.0
                base = ((h >> 12) % 760) / 100.0 - 3.2
                phase = ((h >> 20) % 628) / 100.0
                drift = math.sin(now / 55.0 + phase) * 0.45
                trend = math.sin(now / 700.0 + phase * 0.7) * 0.85
                pct = base + drift + trend
                ltp = round(prev * (1 + pct / 100.0), 2)
                openp = round(prev * (1 + (((h >> 26) % 120) - 60) / 10000.0), 2)
                span = prev * (0.004 + ((h >> 4) % 150) / 12000.0)
                dh = round(max(openp, ltp) + span * 0.55, 2)
                dl = round(min(openp, ltp) - span * 0.55, 2)
                vol = float((h % 90000) * 40 + 50000)
                row = self.rows[sym]
                row.update({"ltp": ltp, "prev": round(prev, 2),
                            "pct": round((ltp - prev) / prev * 100.0, 2),
                            "dh": dh, "dl": dl, "vol": vol})
                if not row["oi"]:
                    r = random.Random(h % 9999)
                    row["oi"] = r.choice(["LONG BUILD", "SHORT BUILD",
                                          "SHORT COVER", "LONG UNWIND", ""])
            self._demo_opt_all(now)
            self._score_locked()
            self.phase.update({"label": "simulated sweep",
                               "done": len(self.stocks),
                               "total": len(self.stocks),
                               "cycle": int((now - self.started) // 6) + 1})
            self.last_tick = now

        # index board
        with self.lock:
            for card in self.indices:
                name = card["name"]
                base = DEMO_INDEX_LEVEL.get(name, 10000)
                h = _seed(name, date.today().isoformat())
                phase = ((h >> 8) % 628) / 100.0
                pct = (((h >> 16) % 420) / 100.0 - 1.9
                       + math.sin(now / 85.0 + phase) * 0.28)
                ltp = round(base * (1 + pct / 100.0), 2)
                prev = float(base)
                card.update({"ltp": ltp, "prev": prev,
                             "chg": round(ltp - prev, 2),
                             "pct": round((ltp - prev) / prev * 100.0, 2)})
                if not card.get("spark"):
                    r = random.Random(h)
                    pts, val = [], ltp * (1 - pct / 100.0)
                    for _ in range(64):
                        val *= 1 + r.uniform(-0.0016, 0.0017)
                        pts.append(round(val, 2))
                    pts[-1] = ltp
                    card["spark"] = pts
                else:
                    pts = card["spark"][1:] + [ltp]
                    card["spark"] = pts
        self.last_tick = now

    def _demo_opt_all(self, now: float) -> None:
        """Simulated option-detail summary for every symbol (cheap)."""
        for sym, row in self.rows.items():
            spot = row["ltp"]
            if spot <= 0:
                continue
            h = _seed(sym, "optq", date.today().isoformat())
            r = random.Random(h)
            step = _demo_step(spot)
            strike = round(spot / step) * step
            side = "CE" if row["pct"] >= 0 else "PE"
            premium = max(0.5, spot * 0.011 * r.uniform(0.6, 1.5))
            vol = r.uniform(250, 62000) * (1 + abs(row["pct"]) / 9.0)
            spr = r.uniform(0.2, 3.4)
            grade, score = oi_strip_grade(vol, spr, vol * premium)
            self.opt_cache[sym] = (now, {
                "side": side, "strike": strike,
                "ltp": round(premium, 2), "grade": grade,
                "score": score, "cont": round(r.uniform(12, 94), 1),
                "verdict": "",
            })

    # ----------------------------------------------------------- scoring ---
    def _score_locked(self) -> None:
        """Recompute rally scores cross-sectionally (call with lock held)."""
        syms = []
        vols = []
        for sym, row in self.rows.items():
            syms.append(sym)
            vols.append(row["vol"])
        ranks = volume_rank(vols)
        for sym, vrank in zip(syms, ranks):
            row = self.rows[sym]
            prev_dir = row["dir"]
            d, score = rally_score(row["dh"], row["dl"], row["ltp"],
                                   row["prev"], vrank)
            if (self._scored_once and d and d != prev_dir
                    and score >= 25):
                self.detections.append((
                    time.time(), sym, d, score,
                    (row["opt"] or {}).get("grade", "")))
            row["dir"] = d
            row["score"] = score
            opt = self.opt_cache.get(sym)
            if opt and time.time() - opt[0] < OPT_TTL:
                quality = 0.7 * opt[1]["score"] + 0.3 * opt[1]["cont"]
                row["opt"] = opt[1]
                row["comb"] = round(0.62 * score + 0.38 * quality, 1)
            else:
                row["opt"] = None
                row["comb"] = round(score * 0.88, 1)

        if not self._scored_once:
            # first pass: seed the stream with the session's leading setups
            self._scored_once = True
            top = sorted([r for r in self.rows.values() if r["score"] >= 25],
                         key=lambda r: -r["comb"])[:9]
            now = time.time()
            for i, r in enumerate(top):
                self.detections.append((
                    now - (i + 1) * 41, r["symbol"], r["dir"],
                    r["comb"], (r["opt"] or {}).get("grade", "")))

    # ----------------------------------------------------------- workers ---
    def _universe_worker(self) -> None:
        """Fetch today's F&O master once, then swap the universe in place.

        A deployed instance has no persistent disk, so it starts from the
        committed seed and refreshes itself: current stock/index keys and
        this month's futures, without dropping the quotes already shown.
        """
        try:
            from universe_fetch import refresh_master
            if not refresh_master(self.data_dir):
                return
        except Exception as e:                       # noqa: BLE001
            self.last_error = f"master: {str(e)[:100]}"
            return
        try:
            stocks, idx, futs = build_universe(self.root, self.data_dir)
        except Exception as e:                       # noqa: BLE001
            self.last_error = f"universe: {str(e)[:100]}"
            return
        if not stocks:
            return
        with self.lock:
            old = self.rows
            rows = {}
            for s in stocks:
                row = {"symbol": s["symbol"], "sector": "", "ltp": 0.0,
                       "prev": 0.0, "pct": 0.0, "vol": 0.0, "dh": 0.0,
                       "dl": 0.0, "dir": None, "score": 0.0, "comb": 0.0,
                       "oi": "", "opt": None, "key": s["key"],
                       "fut": s["fut"]}
                prev = old.get(s["symbol"])
                if prev:
                    for k in ("ltp", "prev", "pct", "vol", "dh", "dl",
                              "dir", "score", "comb", "oi", "opt"):
                        row[k] = prev[k]
                row["sector"] = self.sector_map.get(s["symbol"], "")
                rows[s["symbol"]] = row
            self.stocks, self.index_keys, self.futures = stocks, idx, futs
            self.rows = rows
            self._score_locked()

    def _sector_worker(self) -> None:
        try:
            smap = refresh_sectors(self.cache_dir)
        except Exception:                                # noqa: BLE001
            return
        if not smap:
            return
        with self.lock:
            self.sector_map = smap
            for sym, row in self.rows.items():
                row["sector"] = smap.get(sym, "")

    def _opt_worker(self) -> None:
        while not self.stop_evt.is_set():
            if self.demo:
                self.stop_evt.wait(2.0)
                continue
            with self.lock:
                order = sorted(self.rows.values(),
                               key=lambda r: (-(r["comb"]), -r["score"]))
                todo = next((r["symbol"] for r in order
                             if r["score"] > 0 and (
                                 r["symbol"] not in self.opt_cache or
                                 time.time() - self.opt_cache[
                                     r["symbol"]][0] > OPT_TTL)), None)
            if not todo:
                self.stop_evt.wait(2.0)
                continue
            try:
                detail = self._fetch_detail(todo)
                if detail and detail.get("track"):
                    with self.lock:
                        self.opt_cache[todo] = (time.time(), {
                            "side": detail["track"]["side"],
                            "strike": detail["track"]["strike"],
                            "ltp": detail["track"]["ltp"],
                            "grade": detail["track"]["grade"],
                            "score": detail["track"]["score"],
                            "cont": detail["cont"],
                            "verdict": detail["cont_verdict"],
                        })
                        self._score_locked()
            except Exception as e:                       # noqa: BLE001
                self.last_error = f"option: {str(e)[:100]}"
            self.stop_evt.wait(1.0)

    # ------------------------------------------------------------ option ---
    def _spot_key(self, sym: str) -> str:
        for s in self.stocks:
            if s["symbol"] == sym:
                return s["key"]
        return ""

    def _fetch_detail(self, sym: str) -> dict | None:
        key = self._spot_key(sym)
        if not key:
            return None
        today = datetime.now(IST).strftime("%Y-%m-%d")
        contracts = self.client.option_contracts(key)
        exps = {str(c.get("expiry") or c.get("expiry_date") or "")
                for c in contracts}
        exps = sorted(e for e in exps if e and e >= today)
        if not exps:
            return None
        expiry = exps[0]
        chain = self.client.option_chain(key, expiry)
        row = self.rows.get(sym) or {}
        tpm: list[dict] = []
        detail = build_option_detail(sym, chain, expiry, row.get("pct"), tpm)
        trk_key = ""
        for c in contracts:
            if (str(c.get("expiry") or "") == expiry
                    and detail.get("track")
                    and abs(_f(c.get("strike_price")) -
                            detail["track"]["strike"]) < 1e-6
                    and str(c.get("instrument_type") or "") ==
                    detail["track"]["side"]):
                trk_key = str(c.get("instrument_key") or "")
                break
        if trk_key:
            tpm = [{"v": c["v"]} for c in self.client.candles_intraday(trk_key, 1)]
            detail = build_option_detail(sym, chain, expiry, row.get("pct"),
                                         tpm)
        return detail

    def option_detail(self, sym: str) -> dict:
        if self.demo:
            return _demo_detail(sym, self.rows.get(sym) or {})
        try:
            detail = self._fetch_detail(sym)
        except Exception as e:                           # noqa: BLE001
            detail = None
            self.last_error = f"option: {str(e)[:100]}"
        if detail and detail.get("rows"):
            if detail.get("track"):
                with self.lock:
                    self.opt_cache[sym] = (time.time(), {
                        "side": detail["track"]["side"],
                        "strike": detail["track"]["strike"],
                        "ltp": detail["track"]["ltp"],
                        "grade": detail["track"]["grade"],
                        "score": detail["track"]["score"],
                        "cont": detail["cont"],
                        "verdict": detail["cont_verdict"],
                    })
                    self._score_locked()
            return detail
        return build_option_detail(sym, [], "", 0.0, [],
                                   stale="option chain unavailable")

    # -------------------------------------------------------------- scope ---
    def set_scope(self, name: str | None) -> dict:
        if not name:
            with self.lock:
                self.scope_name = None
                self.scope_syms = set()
            return {"scope": None, "members": 0}
        slug = next((s for n, s, _u in INDEX_CATALOG if n == name), None)
        if not slug:
            return {"scope": name, "members": 0}
        syms = fetch_index_list(slug, self.cache_dir)
        members = set(syms) & set(self.rows)
        with self.lock:
            self.scope_name = name
            self.scope_syms = members
            self.index_lists[name] = sorted(members)
            for card in self.indices:
                if card["name"] == name:
                    card["members"] = len(members)
        return {"scope": name, "members": len(members)}

    # ----------------------------------------------------------- snapshot ---
    def snapshot(self, mode: str = "rally", scope: str | None = None) -> dict:
        now = datetime.now(IST)
        with self.lock:
            if scope and scope != self.scope_name:
                pass
            rows = list(self.rows.values())
            if self.scope_name:
                rows = [r for r in rows if r["symbol"] in self.scope_syms]
            live = [r for r in rows if r["ltp"] > 0 and r["score"] > 0]
            if mode == "opt":
                live.sort(key=lambda r: (-(r["opt"]["score"] if r["opt"]
                                           else -1), -r["comb"]))
            else:
                live.sort(key=lambda r: (-r["comb"], -r["score"]))
            if mode == "opt":
                chosen = live[:80]
            else:
                # both boards need a full top list, not a shared slice
                chosen = sorted(
                    [r for r in live if r["dir"] == "BULL"][:30]
                    + [r for r in live if r["dir"] == "BEAR"][:30]
                    + [r for r in live if r["dir"] not in ("BULL", "BEAR")][:12],
                    key=lambda r: -r["comb"])
            payload_rows = [{
                "symbol": r["symbol"], "sector": r["sector"],
                "ltp": r["ltp"], "pct": r["pct"], "dir": r["dir"],
                "score": r["score"], "comb": r["comb"], "oi": r["oi"],
                "pos": round(max(0.0, min(1.0, (r["ltp"] - r["dl"]) /
                                          ((r["dh"] - r["dl"]) or 1))), 3),
                "opt": r["opt"],
            } for r in chosen]
            bull = sum(1 for r in live if r["dir"] == "BULL")
            bear = sum(1 for r in live if r["dir"] == "BEAR")
            adv = sum(1 for r in rows if r["pct"] > 0)
            dec = sum(1 for r in rows if r["pct"] < 0)
            avg = (sum(r["pct"] for r in rows) / len(rows)) if rows else 0.0
            indices = [dict(c) for c in self.indices]
            demo = self.demo
            auth = self.auth_msg
            phase = dict(self.phase)
            last_tick = self.last_tick
            scope_name = self.scope_name
            members = len(self.scope_syms)
            err = self.last_error
            univ = len(self.stocks)
        return {
            "ts": time.time(),
            "ist": now.strftime("%H:%M:%S"),
            "date": now.strftime("%d %b %Y"),
            "session": market_session(now),
            "demo": demo,
            "auth": auth,
            "mode": mode,
            "scope": scope_name,
            "scope_members": members,
            "phase": phase,
            "error": err,
            "last_tick": last_tick,
            "stats": {"universe": univ, "scored": len(live),
                      "bull": bull, "bear": bear, "adv": adv, "dec": dec,
                      "avg": round(avg, 2)},
            "indices": indices,
            "rows": payload_rows,
        }


# ---------------------------------------------------------------------------
# simulated option detail
# ---------------------------------------------------------------------------
def _demo_step(spot: float) -> float:
    for cap, step in ((100, 2.5), (250, 5), (500, 10), (1000, 20),
                      (2000, 50), (5000, 100)):
        if spot <= cap:
            return step
    return 250.0


def _demo_detail(sym: str, row: dict) -> dict:
    spot = _f(row.get("ltp")) or 500.0
    pct = _f(row.get("pct"))
    step = _demo_step(spot)
    atm = round(spot / step) * step
    r = random.Random(_seed(sym, "opt", date.today().isoformat()))
    expiry = (datetime.now(IST) + timedelta(days=3)).strftime("%Y-%m-%d")
    tv_base = spot * 0.011
    chain = []
    for i in range(-6, 7):
        strike = atm + i * step
        for side in ("call_options", "put_options"):
            intrinsic = max(spot - strike, 0) if side == "call_options" \
                else max(strike - spot, 0)
            tv = tv_base * math.exp(-abs(strike - spot) / (step * 3.2))
            ltp = max(0.5, intrinsic + tv + r.uniform(-0.4, 0.4))
            spread = r.uniform(0.12, 1.4)
            vol = max(0, int(r.uniform(150, 90000) *
                             math.exp(-abs(strike - spot) / (step * 2.2))))
            oi = int(r.uniform(2000, 90000))
            doi = int(r.uniform(-9000, 9000))
            md = {"ltp": round(ltp, 2), "volume": vol,
                  "bid_price": round(ltp * (1 - spread / 200), 2),
                  "ask_price": round(ltp * (1 + spread / 200), 2),
                  "oi": oi, "prev_oi": oi - doi, "oi_net_change": doi,
                  "net_change": round(r.uniform(-3, 3), 2)}
            if side == "call_options":
                chain.append({"strike_price": strike,
                              "underlying_spot_price": spot,
                              "pcr": round(r.uniform(0.6, 1.6), 2),
                              "call_options": {"market_data": md,
                                               "option_greeks":
                                               {"iv": r.uniform(12, 32)}},
                              "put_options": {}})
            else:
                chain[-1]["put_options"] = {
                    "market_data": md,
                    "option_greeks": {"iv": r.uniform(12, 32)}}
    bars = []
    traded = 0
    for _ in range(90):
        v = r.uniform(0, 9000) if r.random() > 0.22 else 0.0
        traded += 1 if v else 0
        bars.append(round(v))
    detail = build_option_detail(sym, chain, expiry, pct,
                                [{"v": v} for v in bars])
    detail["demo"] = True
    detail["spot"] = round(spot, 2)
    return detail
