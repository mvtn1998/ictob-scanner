"""Shared scanner logic for the OB Sentinel web terminal.

Ported from the desktop scanner (ict_ob_scanner_indices.py):
  * SM-Rally pattern score          (rally_score)
  * SM-Rally option-detail grades   (oi_strip_grade, build_option_detail)
  * NSE index catalog + membership  (INDEX_CATALOG, fetch_index_list, sectors)
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

IST = timezone(timedelta(hours=5, minutes=30))
UA = {"User-Agent": "ob-sentinel/1.0", "Accept": "*/*"}

# ---------------------------------------------------------------------------
# INDICES — catalog + membership
# ---------------------------------------------------------------------------
IND_LIST_URL = "https://archives.nseindia.com/content/indices/ind_{slug}list.csv"
IND_LIST_URL_B = "https://nsearchives.nseindia.com/content/indices/ind_{slug}list.csv"

# (display name, NSE archive slug, Upstox NSE_INDEX name or "")
INDEX_CATALOG: tuple[tuple[str, str, str], ...] = (
    ("NIFTY 50", "nifty50", "Nifty 50"),
    ("NIFTY BANK", "niftybank", "Nifty Bank"),
    ("NIFTY IT", "niftyit", "Nifty IT"),
    ("NIFTY AUTO", "niftyauto", "Nifty Auto"),
    ("NIFTY FMCG", "niftyfmcg", "Nifty FMCG"),
    ("NIFTY PHARMA", "niftypharma", "Nifty Pharma"),
    ("NIFTY METAL", "niftymetal", "Nifty Metal"),
    ("NIFTY ENERGY", "niftyenergy", "Nifty Energy"),
    ("NIFTY REALTY", "niftyrealty", "Nifty Realty"),
    ("NIFTY PSU BANK", "niftypsubank", "Nifty PSU Bank"),
    ("NIFTY FIN SERVICE", "niftyfinance", "Nifty Fin Service"),
    ("NIFTY MEDIA", "niftymedia", "Nifty Media"),
    ("NIFTY INFRA", "niftyinfra", "Nifty Infra"),
    ("NIFTY HEALTHCARE", "niftyhealthcare", "NIFTY HEALTHCARE"),
    ("NIFTY MNC", "niftymnc", "Nifty MNC"),
    ("NIFTY CONSUMPTION", "niftyconsumption", "Nifty Consumption"),
    ("NIFTY COMMODITIES", "niftycommodities", "Nifty Commodities"),
    ("NIFTY OIL & GAS", "niftyoilgas", "NIFTY OIL AND GAS"),
    ("NIFTY MIDCAP 100", "niftymidcap100", "NIFTY MIDCAP 100"),
    ("NIFTY MIDCAP 150", "niftymidcap150", "NIFTY MIDCAP 150"),
    ("NIFTY NEXT 50", "niftynext50", "Nifty Next 50"),
    ("NIFTY 100", "nifty100", "Nifty 100"),
    ("NIFTY 200", "nifty200", "Nifty 200"),
    ("NIFTY 500", "nifty500", "Nifty 500"),
)

SECTOR_PRIORITY: tuple[str, ...] = (
    "NIFTY PSU BANK", "NIFTY BANK", "NIFTY PHARMA", "NIFTY HEALTHCARE",
    "NIFTY IT", "NIFTY AUTO", "NIFTY FMCG", "NIFTY REALTY", "NIFTY METAL",
    "NIFTY OIL & GAS", "NIFTY ENERGY", "NIFTY MEDIA", "NIFTY FIN SERVICE",
    "NIFTY INFRA", "NIFTY MNC", "NIFTY CONSUMPTION", "NIFTY COMMODITIES",
)

SECTOR_REQUIRES = {
    "NIFTY BANK": ("NIFTY PSU BANK",),
    "NIFTY FIN SERVICE": ("NIFTY PSU BANK", "NIFTY BANK"),
    "NIFTY HEALTHCARE": ("NIFTY PHARMA",),
    "NIFTY ENERGY": ("NIFTY OIL & GAS",),
    "NIFTY INFRA": ("NIFTY REALTY",),
    "NIFTY MNC": ("NIFTY IT", "NIFTY FMCG", "NIFTY PHARMA", "NIFTY AUTO"),
    "NIFTY CONSUMPTION": ("NIFTY AUTO", "NIFTY FMCG", "NIFTY PHARMA",
                          "NIFTY METAL"),
    "NIFTY COMMODITIES": ("NIFTY METAL", "NIFTY OIL & GAS", "NIFTY ENERGY"),
}

SEC_META = {name: slug for name, slug, _ in INDEX_CATALOG}


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, payload) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, separators=(",", ":")),
                        encoding="utf-8")
    except OSError:
        pass


def fetch_index_list(slug: str, cache_dir: Path, max_age_days: int = 30
                     ) -> list[str]:
    """Constituent symbols of one NSE index, cached on disk.

    The broker has no membership endpoint; NSE Indices publishes the CSVs.
    A cache fresher than `max_age_days` is used without a download, and it
    is also the fallback whenever the archive is unreachable.
    """
    cache_dir = Path(cache_dir)
    cf = cache_dir / f"index_{slug}.json"
    hit = _read_json(cf)
    if isinstance(hit, dict) and hit.get("symbols"):
        age = (time.time() - float(hit.get("ts") or 0)) / 86400.0
        if 0 <= age < max_age_days:
            return list(hit["symbols"])

    out: list[str] = []
    for url in (IND_LIST_URL, IND_LIST_URL_B):
        try:
            r = requests.get(url.format(slug=slug), headers=UA, timeout=20)
            if r.status_code != 200 or "Symbol" not in r.text:
                continue
            for line in r.text.splitlines()[1:]:
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 5 and parts[3] == "EQ" and parts[2]:
                    sym = parts[2].upper()
                    if sym not in out:
                        out.append(sym)
            if out:
                _write_json(cf, {"ts": time.time(), "symbols": out})
                return out
        except requests.RequestException:
            continue
    if isinstance(hit, dict) and hit.get("symbols"):
        return list(hit["symbols"])
    return []


def build_sector_map(index_lists: dict[str, list[str]]) -> dict[str, str]:
    """One relevant sector index per stock, never a broad-market index."""
    missing = {name for name in SECTOR_PRIORITY if name not in index_lists}
    out: dict[str, str] = {}
    for name in SECTOR_PRIORITY:
        if name in missing:
            continue
        if any(dep in missing for dep in SECTOR_REQUIRES.get(name, ())):
            continue
        for sym in index_lists.get(name) or ():
            s = str(sym).strip().upper()
            if s and s not in out:
                out[s] = name
    return out


def load_sectors(cache_dir: Path) -> dict[str, str]:
    """Sector map from the on-disk cache (fast path), else {}."""
    cf = Path(cache_dir) / "sectors.json"
    hit = _read_json(cf)
    if isinstance(hit, dict) and hit.get("map"):
        return dict(hit["map"])
    return {}


def refresh_sectors(cache_dir: Path, max_age_days: int = 7) -> dict[str, str]:
    """Download the sector lists and rebuild the map (slow, background)."""
    cache_dir = Path(cache_dir)
    cf = cache_dir / "sectors.json"
    hit = _read_json(cf)
    if isinstance(hit, dict) and (time.time() - float(hit.get("ts") or 0)
                                  ) / 86400.0 < max_age_days:
        return dict(hit.get("map") or {})
    lists: dict[str, list[str]] = {}
    for name in SECTOR_PRIORITY:
        slug = SEC_META.get(name)
        if not slug:
            continue
        syms = fetch_index_list(slug, cache_dir, max_age_days=max_age_days)
        if syms:
            lists[name] = syms
    if not lists:
        return load_sectors(cache_dir)
    smap = build_sector_map(lists)
    _write_json(cf, {"ts": time.time(), "map": smap})
    return smap


# ---------------------------------------------------------------------------
# RALLY PATTERN (SM-Rally port)
# ---------------------------------------------------------------------------
def rally_score(day_high: float, day_low: float, ltp: float,
                prev_close: float, vrank: float = 0.5):
    """BULL/BEAR rally-pattern score for one symbol.

    BULL RALLY = price in the upper half of its day range, moved >= 0.8%
                 up from the day low; BEAR RALLY mirrors it at the high.
    Score = move x position quality x day-confirm bonus x range factor,
            then scaled 0.85..1.15x by the stock's volume percentile.
    Returns ("BULL"|"BEAR"|None, score).
    """
    try:
        dh = max(float(day_high or 0), float(ltp or 0))
        dl = min(float(day_low or 0) or float(ltp or 0), float(ltp or 0))
        ltp = float(ltp or 0)
        pc = float(prev_close or 0)
    except (TypeError, ValueError):
        return None, 0.0
    if ltp <= 0 or dh <= 0 or dl <= 0:
        return None, 0.0
    day_range = dh - dl
    if day_range < 0.01:
        return None, 0.0
    if pc <= 0:
        pc = ltp
    pct = (ltp - pc) / pc * 100.0

    range_pos = max(0.0, min(1.0, (ltp - dl) / day_range))
    is_bull = range_pos >= 0.50
    if is_bull:
        move_pct = (ltp - dl) / dl * 100.0
        pos_quality = range_pos
    else:
        move_pct = (dh - ltp) / dh * 100.0
        pos_quality = 1.0 - range_pos
    if move_pct < 0.8:
        return None, 0.0

    price_score = min(100.0, move_pct * 10.0)
    quality = (pos_quality - 0.5) * 2.0
    if (is_bull and pct > 0) or (not is_bull and pct < 0):
        pct_bonus = min(1.3, 1.0 + abs(pct) * 0.06)
    else:
        pct_bonus = 0.80
    range_pct = day_range / pc * 100.0
    range_factor = min(1.5, max(0.5, range_pct * 0.4))

    raw = price_score * (0.5 + 0.5 * quality) * pct_bonus * range_factor
    final = round(min(100.0, min(100.0, raw) * (0.85 + 0.30 * vrank)), 1)
    return ("BULL" if is_bull else "BEAR"), final


def volume_rank(volumes: list[float]) -> list[float]:
    """Cross-sectional volume percentile (0..1) per symbol, source-style."""
    n = max(1, len(volumes))
    ordered = sorted(volumes)
    out = []
    for v in volumes:
        if v <= 0:
            out.append(0.5)
            continue
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if ordered[mid] < v:
                lo = mid + 1
            else:
                hi = mid
        out.append(lo / n)
    return out


# ---------------------------------------------------------------------------
# OPTION DETAIL (SM-Rally OptiFlow port)
# ---------------------------------------------------------------------------
OPT_GRADES = ("ELITE", "STRONG", "OK", "THIN", "AVOID")
GRADE_COLOR = {
    "ELITE": "#3dffb0", "STRONG": "#22e6ff", "OK": "#b9c6dd",
    "THIN": "#ffb020", "AVOID": "#6b7280",
}


def oi_strip_grade(vol: float, spr: float, turnover: float):
    """Strike liquidity grade — same weights as SM Rally's option flow."""
    if vol <= 0 or turnover <= 0:
        return "AVOID", 0.0
    score = 100.0 * (
        0.55 * min(1.0, turnover / 2_500_000.0)     # traded value vs 25L
        + 0.25 * max(0.0, 1.0 - spr / 4.0)          # spread tightness
        + 0.20 * min(1.0, vol / 4000.0))            # contracts traded
    grade = ("ELITE" if score >= 75 else "STRONG" if score >= 55
             else "OK" if score >= 40 else "THIN" if score >= 25
             else "AVOID")
    return grade, round(score, 1)


def oi_track_verdict(continuity_pct: float):
    if continuity_pct > 50:
        return "STRONG", "#3dffb0"
    if continuity_pct > 25:
        return "OK", "#ffb020"
    return "THIN", "#ff5b7a"


def _f(x, default=None):
    try:
        if x is None:
            return default
        return float(x)
    except (TypeError, ValueError):
        return default


def build_option_detail(symbol: str, chain: list[dict], expiry: str,
                        pct: float | None, tpm: list[dict],
                        stale: str = "") -> dict:
    """Option-detail payload: flow header, graded strike card, continuity."""
    rows = [r for r in chain if isinstance(r, dict)]
    base = {"symbol": symbol, "expiry": expiry or "", "spot": 0.0,
            "pct": pct if pct is not None else 0.0, "pcr": 0.0,
            "ce_vol": 0, "pe_vol": 0, "flow": "—", "flow_side": "CE",
            "dom": 50, "day_favor": "—", "track": None, "rows": [],
            "cont": 0.0, "cont_verdict": "—", "cont_color": "#6b7280",
            "cont_note": "no 1-min data", "bars": [], "stale": stale}
    if not rows:
        return base

    spot = 0.0
    pcr = 0.0
    ce_vol = pe_vol = 0.0
    flow_ce = flow_pe = 0.0
    for r in rows:
        spot = spot or (_f(r.get("underlying_spot_price")) or 0.0)
        pcr = pcr or (_f(r.get("pcr")) or 0.0)
        ce = r.get("call_options") or {}
        pe = r.get("put_options") or {}
        c_md = ce.get("market_data") or {}
        p_md = pe.get("market_data") or {}
        ce_vol += _f(c_md.get("volume")) or 0.0
        pe_vol += _f(p_md.get("volume")) or 0.0

        def _oich(md):
            ch = md.get("oi_net_change")
            if ch is None:
                ch = (md.get("oi") or 0) - (md.get("prev_oi") or 0)
            return _f(ch) or 0.0

        flow_ce += _oich(c_md)
        flow_pe += _oich(p_md)

    tot = abs(flow_ce) + abs(flow_pe)
    if tot == 0:
        flow = "FLAT"
    elif flow_pe > flow_ce:
        flow = f"PE-heavy {abs(flow_pe) / tot * 100:.0f}%"
    else:
        flow = f"CE-heavy {abs(flow_ce) / tot * 100:.0f}%"
    vtot = ce_vol + pe_vol
    dom = (max(ce_vol, pe_vol) / vtot * 100.0) if vtot else 50.0
    flow_side = "CE" if flow_ce >= flow_pe else "PE"
    side = flow_side if pct is None else ("CE" if pct >= 0 else "PE")

    if abs(flow_pe) >= abs(flow_ce) and flow_pe > 0:
        day_favor = "LONG BUILDUP"
    elif abs(flow_pe) >= abs(flow_ce):
        day_favor = "SHORT COVERING"
    elif flow_ce > 0:
        day_favor = "SHORT BUILDUP"
    else:
        day_favor = "LONG UNWINDING"

    atm = None
    if spot:
        strikes = [(_f(r.get("strike_price")) or 0) for r in rows]
        strikes = [s for s in strikes if s]
        if strikes:
            atm = min(strikes, key=lambda k: abs(k - spot))

    cands: list[dict] = []
    for r in rows:
        strike = _f(r.get("strike_price")) or 0
        if not strike:
            continue
        for side_name, blk in (("CE", r.get("call_options")),
                               ("PE", r.get("put_options"))):
            blk = blk or {}
            md = blk.get("market_data") or {}
            gr = blk.get("option_greeks") or {}
            ltp = _f(md.get("ltp")) or 0.0
            bid = _f(md.get("bid_price")) or 0.0
            ask = _f(md.get("ask_price")) or 0.0
            vol = _f(md.get("volume")) or 0.0
            iv = _f(gr.get("iv")) or 0.0
            if ltp > 0 and vol > 0:
                spr = ((ask - bid) / ltp * 100.0
                       if (ask > 0 and bid > 0) else 25.0)
            else:
                spr, vol = 99.0, 0.0
            grade, score = oi_strip_grade(vol, spr, vol * ltp)
            chg = _f(md.get("net_change")) or 0.0
            prev = ltp - chg if ltp and chg else ltp
            cands.append({
                "strike": strike, "side": side_name, "ltp": round(ltp, 2),
                "spr": round(spr, 1), "vol": int(vol), "iv": round(iv, 1),
                "grade": grade, "score": score, "atm": strike == atm,
                "pct": round((chg / prev * 100.0) if prev else 0.0, 1),
            })

    spot0 = spot or (atm or 0)
    pref = [c for c in cands if c["side"] == side and c["score"] > 0]
    if pref:
        best = min(pref, key=lambda c: (abs(c["strike"] - spot0), -c["score"]))
    else:
        best = max(cands, key=lambda c: c["score"]) if cands else None

    top = [c for c in cands if c["score"] > 0]
    top.sort(key=lambda c: -c["score"])
    top = top[:11]
    top.sort(key=lambda c: (c["side"], c["strike"]))

    tail = tpm[-90:] if tpm else []
    bars = [round(_f(b.get("v"), 0.0) or 0.0, 0) for b in tail]
    n_cont = len(tail)
    done = sum(1 for b in tail if (_f(b.get("v")) or 0) > 0)
    cont = (done / n_cont * 100.0) if n_cont else 0.0
    verdict, color = oi_track_verdict(cont)

    base.update({
        "spot": round(spot, 2), "pcr": round(pcr, 2),
        "ce_vol": int(ce_vol), "pe_vol": int(pe_vol),
        "flow": flow, "flow_side": flow_side, "dom": round(dom),
        "day_favor": day_favor, "side": side, "atm": atm,
        "track": ({"side": best["side"], "strike": best["strike"],
                   "ltp": best["ltp"], "grade": best["grade"],
                   "score": best["score"], "pct": best["pct"]}
                  if best else None),
        "rows": top, "bars": bars,
        "cont": round(cont, 1), "cont_verdict": verdict,
        "cont_color": color,
        "cont_note": f"{done}/{n_cont} mins traded" if n_cont
        else "no 1-min data yet",
    })
    return base


def _atr(candles: list[dict], n: int = 14) -> list:
    trs = []
    prev = None
    for c in candles:
        tr = c["h"] - c["l"] if prev is None else max(
            c["h"] - c["l"], abs(c["h"] - prev), abs(c["l"] - prev))
        trs.append(tr)
        prev = c["c"]
    out = [None] * len(trs)
    if len(trs) < n:
        return out
    s = sum(trs[:n]) / n
    out[n - 1] = s
    for i in range(n, len(trs)):
        out[i] = (out[i - 1] * (n - 1) + trs[i]) / n
    return out


def detect_order_blocks(candles: list[dict], atr_mult: float = 0.9,
                        max_zones: int = 6) -> list[dict]:
    """ICT order blocks for the chart: displacement candle + origin zone.

    A block is created when a candle's body clears 1.15 ATR (displacement).
    The zone is the body-to-extremity range of the last opposite candle
    before it — the same anatomy the desktop scanner uses. A block dies
    when price closes beyond its distal edge.
    """
    n = len(candles)
    if n < 25:
        return []
    atr = _atr(candles)
    vol_sma = [None] * n
    run = 0.0
    for i, c in enumerate(candles):
        run += float(c.get("v") or 0.0)
        if i >= 20:
            run -= float(candles[i - 20].get("v") or 0.0)
        if i >= 19:
            vol_sma[i] = run / 20.0

    zones: list[dict] = []
    for i in range(3, n):
        a = atr[i]
        if not a:
            continue
        body = abs(candles[i]["c"] - candles[i]["o"])
        if body < atr_mult * a:
            continue
        bull = candles[i]["c"] > candles[i]["o"]
        origin = None
        for j in range(i - 1, max(-1, i - 6), -1):
            down = candles[j]["c"] < candles[j]["o"]
            if (bull and down) or (not bull and not down):
                origin = j
                break
        if origin is None:
            continue
        o = candles[origin]
        if bull:
            top, bottom = float(o["o"]), float(o["l"])
        else:
            top, bottom = float(o["h"]), float(o["o"])
        if top - bottom <= 0:
            continue

        end = n - 1
        mitigated = None
        for k in range(i + 1, n):
            close = float(candles[k]["c"])
            if (bull and close < bottom) or (not bull and close > top):
                mitigated = k
                end = k
                break

        strength = body / a
        vs = vol_sma[i]
        vol_ratio = (float(candles[i].get("v") or 0.0) / vs) if vs else 0.0
        grade = ("ELITE" if strength >= 2.0 or vol_ratio >= 2.2
                 else "STRONG" if strength >= 1.55 or vol_ratio >= 1.6
                 else "OK")
        zones.append({"dir": 1 if bull else -1, "top": round(top, 2),
                      "bottom": round(bottom, 2), "i0": origin,
                      "i1": end, "bar": i, "active": mitigated is None,
                      "grade": grade, "strength": round(strength, 2),
                      "vol": round(vol_ratio, 2)})

    zones.sort(key=lambda z: z["i0"])
    if len(zones) > max_zones:
        active = [z for z in zones if z["active"]][-max_zones:]
        rest = [z for z in zones if not z["active"]][-2:]
        zones = sorted(active + rest, key=lambda z: z["i0"])
    return zones


def session_vwap(candles: list[dict]) -> list[float | None]:
    out: list[float | None] = []
    pv = vol = 0.0
    for c in candles:
        tp = (float(c["h"]) + float(c["l"]) + float(c["c"])) / 3.0
        v = float(c.get("v") or 0.0)
        pv += tp * v
        vol += v
        out.append(pv / vol if vol else None)
    return out


def htf_levels(daily: list[dict], now: datetime | None = None) -> list[dict]:
    """Previous-session/week/month highs and lows, as in the desktop app.

    Bars dated today are dropped, so a live daily candle can never become
    its own reference level. The latest complete week and month in the
    history are the previous ones.
    """
    now = now or datetime.now(IST)
    bars = sorted([b for b in (daily or [])
                   if b.get("ts") and b["ts"].date() < now.date()],
                  key=lambda b: b["ts"])
    if not bars:
        return []

    out: list[dict] = []
    day = bars[-1]
    out.append({"label": "PDH", "price": round(float(day["h"]), 2),
                "group": "PD"})
    out.append({"label": "PDL", "price": round(float(day["l"]), 2),
                "group": "PD"})

    weeks: dict[tuple, list[dict]] = {}
    months: dict[tuple, list[dict]] = {}
    for b in bars:
        iso = b["ts"].date().isocalendar()
        weeks.setdefault((iso[0], iso[1]), []).append(b)
        months.setdefault((b["ts"].year, b["ts"].month), []).append(b)


    week = weeks[sorted(weeks)[-1]]
    out.append({"label": "PWH", "price": round(max(float(x["h"]) for x in week), 2),
                "group": "PW"})
    out.append({"label": "PWL", "price": round(min(float(x["l"]) for x in week), 2),
                "group": "PW"})

    month = months[sorted(months)[-1]]
    out.append({"label": "PMH", "price": round(max(float(x["h"]) for x in month), 2),
                "group": "PM"})
    out.append({"label": "PML", "price": round(min(float(x["l"]) for x in month), 2),
                "group": "PM"})
    return out


def fmt_big(v: float | int) -> str:
    v = float(v or 0)
    for div, suf in ((10_000_000, "Cr"), (100_000, "L"), (1_000, "K")):
        if abs(v) >= div:
            return f"{v / div:.1f}{suf}"
    return f"{v:.0f}"


def market_session(now: datetime | None = None) -> str:
    """PRE / LIVE / CLOSED for the NSE cash session (IST)."""
    now = now or datetime.now(IST)
    if now.weekday() >= 5:
        return "CLOSED"
    t = now.hour * 60 + now.minute
    if 9 * 60 <= t < 9 * 60 + 15:
        return "PRE"
    if 9 * 60 + 15 <= t <= 15 * 60 + 30:
        return "LIVE"
    return "CLOSED"
