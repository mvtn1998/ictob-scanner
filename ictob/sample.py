"""Simulated NSE feed used whenever the broker token is missing/expired.

The website never invents scan results: it only manufactures candles and
option-chain rows. Every order block, grade, VWAP and rank on screen is
computed by the same engine that runs on live Upstox data, just like the
desktop app's numbers after a session closes.
"""
from __future__ import annotations

import hashlib
import math
import random
from datetime import date, datetime, time, timedelta

from .config import IST

SESSION_BARS = 75          # 09:15 -> 15:20 in 5-minute bars


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:12], 16)


PRICE_HINT = {
    "RELIANCE": 1465, "HDFCBANK": 1712, "ICICIBANK": 1288, "INFY": 1580,
    "TCS": 3420, "SBIN": 842, "AXISBANK": 1180, "BHARTIARTL": 1640,
    "ITC": 468, "LT": 3620, "KOTAKBANK": 1925, "HINDUNILVR": 2520,
    "BAJFINANCE": 9450, "MARUTI": 12480, "M&M": 3160, "TATAMOTORS": 780,
    "SUNPHARMA": 1725, "TITAN": 3680, "ASIANPAINT": 2450,
    "ADANIENT": 2980, "ADANIPORTS": 1420, "POWERGRID": 322, "NTPC": 368,
    "ONGC": 242, "COALINDIA": 412, "TATASTEEL": 168, "JSWSTEEL": 1055,
    "HINDALCO": 712, "VEDL": 512, "BPCL": 328, "IOC": 152, "DLF": 812,
    "GODREJPROP": 2860, "INDUSINDBK": 745, "PNB": 108, "BANKBARODA": 268,
    "CANBK": 118, "WIPRO": 268, "HCLTECH": 1725, "TECHM": 1680,
    "DRREDDY": 1325, "CIPLA": 1580, "DIVISLAB": 6120,
    "APOLLOHOSP": 7420, "EICHERMOT": 5280, "HEROMOTOCO": 4850,
    "BAJAJ-AUTO": 9420, "NESTLEIND": 2320, "BRITANNIA": 5280,
    "TATACONSUM": 1085, "GRASIM": 2680, "ULTRACEMCO": 11850,
    "SHREECEM": 28600, "AMBUJACEM": 612, "ACC": 2180, "IDEA": 8.6,
    "PIDILITIND": 3120, "DABUR": 528, "HAVELLS": 1685,
    "SIEMENS": 3280, "ABB": 5840,
}


def base_price(symbol: str) -> float:
    hint = PRICE_HINT.get(symbol)
    if hint:
        return float(hint)
    h = _seed(symbol, "base")
    return round(75.0 * (1.0345 ** (h % 96)), 2)


def daily_candles(symbol: str, days: int = 120) -> list[dict]:
    """Daily history ending yesterday (for PDH/PDL, PWH/PWL, PMH/PML)."""
    r = random.Random(_seed(symbol, "daily"))
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=days + 40)
    price = base_price(symbol) * (1 + r.uniform(-0.12, 0.08))
    out: list[dict] = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            drift = r.gauss(0.0006, 0.011)
            o = price
            c = max(1.0, o * (1 + drift))
            w = abs(r.gauss(0, 0.006))
            h = max(o, c) * (1 + w)
            l = min(o, c) * (1 - w)
            out.append({"ts": datetime.combine(d, time(15, 30), IST),
                        "o": round(o, 2), "h": round(h, 2),
                        "l": round(l, 2), "c": round(c, 2),
                        "v": round(r.uniform(0.4, 1.8) * 2_500_000)})
            price = c
        d += timedelta(days=1)
    return out


def session_candles(symbol: str, sess: date, prev_close: float,
                    tag: str = "s") -> list[dict]:
    """One 5-minute session with real displacement swings (FVG/BOS ready)."""
    r = random.Random(_seed(symbol, sess.isoformat(), tag))
    start = datetime.combine(sess, time(9, 15), IST)
    price = prev_close * (1 + r.uniform(-0.0045, 0.0045))
    vol_base = 45_000 + (_seed(symbol, "vol") % 1_400_000)
    phase = r.uniform(0, 6.28)
    trend = r.uniform(-0.00028, 0.00032)
    out: list[dict] = []
    i = 0
    while i < SESSION_BARS:
        impulse = r.random() < 0.16 and i > 4 and i < SESSION_BARS - 3
        sign = 1 if r.random() < 0.5 else -1
        n_bars = 2 if impulse else 0
        if impulse:
            gap = sign * r.uniform(0.0012, 0.0022)
            body = sign * r.uniform(0.0042, 0.0075)
            o0 = price * (1 + gap)
            c0 = o0 * (1 + body * 0.55)
            h0 = max(o0, c0) * (1 + 0.0003)
            l0 = min(o0, c0) * (1 - 0.0003)
            out.append({"ts": start + timedelta(minutes=5 * i),
                        "o": round(o0, 2), "h": round(h0, 2),
                        "l": round(l0, 2), "c": round(c0, 2),
                        "v": round(vol_base * r.uniform(2.2, 3.6))})
            price = c0
            i += 1
            o1 = price * (1 + sign * r.uniform(0.0004, 0.0012))
            c1 = o1 * (1 + body * 0.65)
            h1 = max(o1, c1) * (1 + 0.00035)
            l1 = min(o1, c1) * (1 - 0.00035)
            out.append({"ts": start + timedelta(minutes=5 * i),
                        "o": round(o1, 2), "h": round(h1, 2),
                        "l": round(l1, 2), "c": round(c1, 2),
                        "v": round(vol_base * r.uniform(2.0, 3.2))})
            price = c1
            i += 1
            continue
        drift = trend + math.sin(i / 7.5 + phase) * 0.00040
        o = price
        ret = drift + r.gauss(0, 0.0009)
        c = max(1.0, o * (1 + ret))
        w = abs(r.gauss(0, 0.00055))
        h = max(o, c) * (1 + w)
        l = min(o, c) * (1 - w)
        v = vol_base * r.uniform(0.35, 1.55)
        if abs(ret) > 0.0022:
            v *= r.uniform(1.4, 2.4)
        out.append({"ts": start + timedelta(minutes=5 * i),
                    "o": round(o, 2), "h": round(h, 2),
                    "l": round(l, 2), "c": round(c, 2),
                    "v": round(v)})
        price = c
        i += 1
    return out


def aggregate(candles: list[dict], minutes: int) -> list[dict]:
    """Aggregate 5m candles into a higher timeframe (1m -> composed too)."""
    if minutes <= 5:
        return list(candles)
    out: list[dict] = []
    bucket: list[dict] = []
    for c in candles:
        key = int(c["ts"].timestamp()) // (minutes * 60)
        if bucket and bucket[0]["key"] != key:
            out.append(_merge(bucket, minutes))
            bucket = []
        bucket.append({**c, "key": key})
    if bucket:
        out.append(_merge(bucket, minutes))
    return out


def _merge(rows: list[dict], minutes: int) -> dict:
    ts = datetime.fromtimestamp(rows[0]["key"] * minutes * 60, IST)
    return {"ts": ts, "o": rows[0]["o"],
            "h": max(r["h"] for r in rows), "l": min(r["l"] for r in rows),
            "c": rows[-1]["c"], "v": sum(r["v"] for r in rows)}


def tick_last(candles: list[dict], symbol: str, now: float) -> None:
    """Nudge the forming 5m candle so the terminal moves every refresh."""
    if not candles:
        return
    c = candles[-1]
    h = _seed(symbol, int(now) // 3, "tick")
    step = (h % 2000) / 100000.0 - 0.01
    new = max(0.01, c["c"] * (1 + step * 0.0018))
    c["c"] = round(new, 2)
    c["h"] = round(max(c["h"], new), 2)
    c["l"] = round(min(c["l"], new), 2)
    c["v"] = round(c["v"] + (h % 9000), 0)


# ---------------------------------------------------------------------------
# option chain (rows feed the real build_oi_strip grading logic)
# ---------------------------------------------------------------------------
def _strike_step(spot: float) -> float:
    for step in (2.5, 5, 10, 25, 50, 100):
        if spot / step <= 45:
            return float(step)
    return 100.0


def option_chain(symbol: str, spot: float, ltp: float,
                 pct: float) -> tuple[str, list[dict]]:
    r = random.Random(_seed(symbol, "chain", date.today().isoformat()))
    step = _strike_step(spot)
    atm = round(spot / step) * step
    today = date.today()
    expiry = today + timedelta(days=(3 - today.weekday()) % 7 + 3)
    expiry_s = expiry.isoformat()
    rows: list[dict] = []
    ce_tot = pe_tot = 0.0
    chain = []
    for k in range(-5, 6):
        strike = atm + k * step
        if strike <= 0:
            continue
        dist = abs(strike - spot) / max(spot, 1.0)
        base_vol = r.uniform(2000, 90000) * math.exp(-dist * 36)
        for side in ("CE", "PE"):
            money = max(2.0, spot * 0.012 * math.exp(-dist * 22) + step * 0.05)
            ltp_o = round(money * r.uniform(0.85, 1.25), 2)
            spread = max(0.05, ltp_o * r.uniform(0.0015, 0.008))
            vol = int(max(0, base_vol * r.uniform(0.55, 1.5)))
            oi = int(max(0, base_vol * r.uniform(2.0, 9.0)))
            rows.append({
                "strike": strike, "side": side, "ltp": ltp_o,
                "bid": round(max(0.05, ltp_o - spread / 2), 2),
                "ask": round(ltp_o + spread / 2, 2), "vol": vol,
                "oi": oi, "prev_oi": int(oi * r.uniform(0.9, 1.05)),
                "iv": round(r.uniform(11, 32), 1),
                "key": f"SAMPLE|{symbol}|{strike:.0f}{side}",
            })
    for k in range(-5, 6):
        strike = atm + k * step
        if strike <= 0:
            continue
        ce = next((x for x in rows if x["strike"] == strike and x["side"] == "CE"), None)
        pe = next((x for x in rows if x["strike"] == strike and x["side"] == "PE"), None)
        if not ce or not pe:
            continue
        ce_tot += ce["vol"]
        pe_tot += pe["vol"]
        chain.append({
            "strike_price": strike,
            "underlying_spot_price": round(spot, 2),
            "pcr": round(pe_tot / ce_tot, 2) if ce_tot else 0.0,
            "call_options": {
                "instrument_key": ce["key"],
                "market_data": {
                    "ltp": ce["ltp"], "bid_price": ce["bid"],
                    "ask_price": ce["ask"], "volume": ce["vol"],
                    "oi": ce["oi"], "prev_oi": ce["prev_oi"],
                    "oi_net_change": ce["oi"] - ce["prev_oi"],
                    "net_change": 0.0,
                },
                "option_greeks": {"iv": ce["iv"]},
            },
            "put_options": {
                "instrument_key": pe["key"],
                "market_data": {
                    "ltp": pe["ltp"], "bid_price": pe["bid"],
                    "ask_price": pe["ask"], "volume": pe["vol"],
                    "oi": pe["oi"], "prev_oi": pe["prev_oi"],
                    "oi_net_change": pe["oi"] - pe["prev_oi"],
                    "net_change": 0.0,
                },
                "option_greeks": {"iv": pe["iv"]},
            },
        })
    return expiry_s, chain


def tpm_bars(symbol: str) -> list[dict]:
    """90 one-minute traded-volume bars for the continuity gauge."""
    r = random.Random(_seed(symbol, "tpm", date.today().isoformat()))
    out: list[dict] = []
    start = datetime.combine(date.today(), time(9, 15), IST)
    for i in range(90):
        traded = r.random() < 0.72
        out.append({"t": (start + timedelta(minutes=i)).strftime("%H:%M"),
                    "v": int(r.uniform(250, 9000)) if traded else 0})
    return out


def index_change(name: str) -> float:
    h = _seed(name, "idx", date.today().isoformat())
    r = random.Random(h)
    return round(r.uniform(-1.9, 2.1), 2)
