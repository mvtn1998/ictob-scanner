"""Website feed: candle series, order-block zones and market pulse.

The landing page never renders a table. It gets two small payloads:

  * chart  — one 5-minute session with order-block zones and VWAP
  * pulse  — index tape, market-picture dots and the latest detections

Live candles come from the broker when a session exists; otherwise the
same geometry is generated locally and the page labels it as sample data.
"""
from __future__ import annotations

import hashlib
import math
import random
import time
from datetime import date, datetime, timedelta

from scanner_core import (INDEX_CATALOG, IST, detect_order_blocks, htf_levels,
                          market_session, session_vwap)
from scanner_engine import DEMO_INDEX_LEVEL

SESSION_BARS = 75          # 09:15 -> 15:20 in 5-minute bars

_DAILY: dict[str, tuple[float, list[dict]]] = {}
_DAILY_TTL = 900.0


def _daily(engine, key: str) -> list[dict]:
    """Daily history for the HTF levels, cached (six tiles share the call)."""
    hit = _DAILY.get(key)
    if hit and time.time() - hit[0] < _DAILY_TTL:
        return hit[1]
    try:
        rows = engine.client.candles_daily(key)
    except Exception:                                  # noqa: BLE001
        rows = []
    if rows:
        _DAILY[key] = (time.time(), rows)
    return rows


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:12], 16)


def demo_candles(symbol: str, bars: int = SESSION_BARS) -> list[dict]:
    """A believable 5-minute session with real displacement swings."""
    seed = _seed(symbol, date.today().isoformat(), "chart")
    r = random.Random(seed)
    base = DEMO_INDEX_LEVEL.get(symbol) or (90 + (seed % 420000) / 100.0)
    start = datetime.now(IST).replace(hour=9, minute=15, second=0,
                                      microsecond=0)
    price = base * (1 + r.uniform(-0.008, 0.008))
    trend = r.uniform(-0.00055, 0.00075)
    vol = base * 0.0011
    out: list[dict] = []
    for i in range(bars):
        phase = math.sin(i / 7.5 + (seed % 100) / 40.0) * 0.00040
        drift = trend + phase
        if r.random() < 0.07:                       # displacement impulse
            drift += r.choice((1, -1)) * r.uniform(0.0035, 0.0065)
        o = price
        c = o * (1 + drift + r.gauss(0, vol / base * 0.55))
        wick = abs(r.gauss(0, 0.00042))
        h = max(o, c) * (1 + wick)
        l = min(o, c) * (1 - wick)
        v = r.uniform(0.35, 2.4) * 120000 * (1 + abs(drift) * 90)
        out.append({"ts": start + timedelta(minutes=5 * i),
                    "o": round(o, 2), "h": round(h, 2), "l": round(l, 2),
                    "c": round(c, 2), "v": round(v)})
        price = c
    return out


def _hist_candles(engine, key: str, days: int = 8) -> list[dict]:
    """Most recent traded session's 5-minute candles (broker history)."""
    from urllib.parse import quote

    today = datetime.now(IST).date()
    start = today - timedelta(days=days)
    try:
        d = engine.client._get(
            f"/v3/historical-candle/{quote(key)}/minutes/5/"
            f"{today.isoformat()}/{start.isoformat()}")
    except Exception:                              # noqa: BLE001
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
    if out:
        last_day = out[-1]["ts"].date()
        out = [c for c in out if c["ts"].date() == last_day]
    return out


def _chart_key(engine, symbol: str) -> str:
    for name, _slug, up in INDEX_CATALOG:
        if name == symbol and up:
            return engine.index_keys.get(up, "")
    for s in engine.stocks:
        if s["symbol"] == symbol:
            return s.get("key", "")
    return ""


def chart_payload(engine, symbol: str = "NIFTY 50") -> dict:
    symbol = (symbol or "NIFTY 50").strip().upper()
    if symbol not in {n for n, _s, _u in INDEX_CATALOG}:
        known = {s["symbol"] for s in engine.stocks}
        if symbol not in known:
            symbol = "NIFTY 50"

    candles: list[dict] = []
    levels: list[dict] = []
    label = "sample"
    if not engine.demo:
        key = _chart_key(engine, symbol)
        if key:
            try:
                candles = engine.client.candles_intraday(key, 5)
            except Exception:                      # noqa: BLE001
                candles = []
            label = "live"
            if not candles:
                candles = _hist_candles(engine, key)
                label = "last session"
            levels = htf_levels(_daily(engine, key))
    demo = not candles
    if not candles:
        candles = demo_candles(symbol)
        label = "sample session"

    recent = candles[-SESSION_BARS:]
    zones = detect_order_blocks(recent)
    vwap = session_vwap(recent)

    first = float(recent[0]["o"])
    last = float(recent[-1]["c"])
    pct = ((last - first) / first * 100.0) if first else 0.0
    return {
        "symbol": symbol,
        "demo": demo,
        "label": label,
        "session": market_session(),
        "last": round(last, 2),
        "pct": round(pct, 2),
        "candles": [[int(c["ts"].timestamp() * 1000), c["o"], c["h"],
                     c["l"], c["c"], int(c.get("v") or 0)] for c in recent],
        "vwap": [round(v, 2) if v else None for v in vwap],
        "zones": zones,
        "levels": levels,
    }


def _pack(r: dict) -> dict:
    opt = r.get("opt") or {}
    return {"symbol": r["symbol"], "pct": round(r["pct"], 2),
            "score": round(r["comb"], 1),
            "grade": opt.get("grade", ""), "side": opt.get("side", ""),
            "strike": opt.get("strike"), "sector": r["sector"]}


def pulse_payload(engine, limit: int = 150) -> dict:
    with engine.lock:
        indices = [{"name": c["name"], "pct": c["pct"]}
                   for c in engine.indices if c["ltp"] > 0]
        rows = [r for r in engine.rows.values() if r["ltp"] > 0]
        scored = sorted([r for r in rows if r["score"] > 0],
                        key=lambda r: -r["comb"])
        dots = [[r["symbol"], round(r["pct"], 2), r["dir"] or "",
                 round(r["comb"], 1), r["sector"]] for r in
                (scored[:limit] if scored else rows[:limit])]
        bulls = sorted([r for r in scored if r["dir"] == "BULL"],
                       key=lambda r: -r["comb"])[:6]
        bears = sorted([r for r in scored if r["dir"] == "BEAR"],
                       key=lambda r: -r["comb"])[:6]
        now = time.time()
        feed = [{"symbol": s, "dir": d, "age": int(max(0, now - t)),
                 "score": round(c, 1), "grade": g}
                for (t, s, d, c, g) in list(engine.detections)[-9:]][::-1]

        agg: dict[str, list[float]] = {}
        for r in rows:
            if r["sector"]:
                agg.setdefault(r["sector"], []).append(r["pct"])
        sectors = [{"name": k, "avg": round(sum(v) / len(v), 2),
                    "n": len(v)} for k, v in agg.items() if len(v) >= 3]
        sectors.sort(key=lambda s: -abs(s["avg"]))

        bull = sum(1 for r in rows if r["dir"] == "BULL")
        bear = sum(1 for r in rows if r["dir"] == "BEAR")
        stats = {"universe": len(engine.stocks), "bull": bull, "bear": bear,
                 "scored": len(scored)}
        demo = engine.demo
    return {"demo": demo, "session": market_session(), "indices": indices,
            "dots": dots, "stats": stats,
            "bulls": [_pack(r) for r in bulls],
            "bears": [_pack(r) for r in bears],
            "feed": feed, "sectors": sectors[:8],
            "ts": datetime.now(IST).strftime("%H:%M:%S")}
