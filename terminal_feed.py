"""Terminal feed: multi-timeframe OHLCV for the chart terminal.

The terminal needs long, consistent history for every interval (1m … 1M).
A broker session gives us five-minute bars for one session only, so this
module generates a deterministic market per symbol instead: the same seed
always produces the same candles, every interval derives from the same
daily series, and the last bar is nudged with a time bucket so quotes move
while the page is open.  Payloads are labelled ``sample`` so the UI can say
so plainly, exactly like the landing-page chart does.
"""
from __future__ import annotations

import hashlib
import math
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote as _q

from scanner_core import INDEX_CATALOG

IST = timezone(timedelta(hours=5, minutes=30))
SESSION_MINUTES = 375          # 09:15 -> 15:30
DAY_START = (9, 15)
MAX_DAYS = 1600                # fixed history width per symbol (~6.4 years)

# symbol, name, exchange, kind, base price, decimals
SYMBOLS: tuple[tuple[str, str, str, str, float, int], ...] = (
    ("NIFTY 50", "Nifty 50 Index", "NSE", "index", 25800.0, 2),
    ("NIFTY BANK", "Nifty Bank", "NSE", "index", 64635.0, 2),
    ("NIFTY IT", "Nifty IT", "NSE", "index", 31322.0, 2),
    ("NIFTY AUTO", "Nifty Auto", "NSE", "index", 24180.0, 2),
    ("NIFTY FMCG", "Nifty FMCG", "NSE", "index", 58940.0, 2),
    ("NIFTY METAL", "Nifty Metal", "NSE", "index", 9840.0, 2),
    ("SENSEX", "BSE Sensex", "BSE", "index", 83919.0, 2),
    ("BANKNIFTY1!", "Nifty Bank Futures", "NSE", "futures", 64556.0, 2),
    ("NIFTY1!", "Nifty 50 Futures", "NSE", "futures", 25775.0, 2),
    ("RELIANCE", "Reliance Industries", "NSE", "stock", 1377.5, 2),
    ("HDFCBANK", "HDFC Bank", "NSE", "stock", 846.0, 2),
    ("ICICIBANK", "ICICI Bank", "NSE", "stock", 1640.0, 2),
    ("AXISBANK", "Axis Bank", "NSE", "stock", 1446.0, 2),
    ("BAJFINANCE", "Bajaj Finance", "NSE", "stock", 1122.0, 2),
    ("TCS", "Tata Consultancy Services", "NSE", "stock", 3120.0, 2),
    ("INFY", "Infosys", "NSE", "stock", 1094.3, 2),
    ("SBIN", "State Bank of India", "NSE", "stock", 812.4, 2),
    ("BHARTIARTL", "Bharti Airtel", "NSE", "stock", 1892.0, 2),
    ("ITC", "ITC Ltd", "NSE", "stock", 438.6, 2),
    ("LT", "Larsen & Toubro", "NSE", "stock", 3648.0, 2),
    ("MARUTI", "Maruti Suzuki", "NSE", "stock", 12840.0, 2),
    ("TATAMOTORS", "Tata Motors", "NSE", "stock", 704.2, 2),
    ("HINDUNILVR", "Hindustan Unilever", "NSE", "stock", 2384.0, 2),
    ("KOTAKBANK", "Kotak Mahindra Bank", "NSE", "stock", 1742.0, 2),
    ("SUNPHARMA", "Sun Pharmaceutical", "NSE", "stock", 1682.0, 2),
    ("ADANIENT", "Adani Enterprises", "NSE", "stock", 2416.0, 2),
    ("ASIANPAINT", "Asian Paints", "NSE", "stock", 2214.0, 2),
    ("ONGC", "Oil & Natural Gas Corp", "NSE", "stock", 246.8, 2),
    ("WIPRO", "Wipro Ltd", "NSE", "stock", 248.4, 2),
    ("BTCUSD", "Bitcoin / US Dollar", "CRYPTO", "crypto", 55960.0, 1),
    ("ETHUSD", "Ethereum / US Dollar", "CRYPTO", "crypto", 1568.5, 2),
    ("SOLUSD", "Solana / US Dollar", "CRYPTO", "crypto", 132.4, 2),
    ("XRPUSD", "XRP / US Dollar", "CRYPTO", "crypto", 0.8716, 4),
    ("USDINR", "US Dollar / Indian Rupee", "FX", "forex", 92.66, 4),
    ("EURUSD", "Euro / US Dollar", "FX", "forex", 1.0965, 5),
    ("GBPUSD", "British Pound / US Dollar", "FX", "forex", 1.3081, 5),
    ("USDJPY", "US Dollar / Japanese Yen", "FX", "forex", 158.56, 3),
)

BY_SYMBOL = {s[0]: s for s in SYMBOLS}
ALIASES = {
    "NIFTY": "NIFTY 50",
    "NIFTY50": "NIFTY 50",
    "BANKNIFTY": "NIFTY BANK",
    "NIFTYBANK": "NIFTY BANK",
    "BTC": "BTCUSD",
    "ETH": "ETHUSD",
    "BTCUSDT": "BTCUSD",
}

# interval -> minutes of one bar (aggregated from the 1-minute session)
INTRADAY = {"1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60}
DAILY = {"1d": 1, "1w": 5, "1M": 21}
INTERVALS = tuple(INTRADAY) + tuple(DAILY)


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:15], 16)


def _digits(sym: dict) -> int:
    return int(sym["digits"])


def _round(v: float, d: int) -> float:
    return round(v, d)


def _r(v: float, d: int) -> float:
    return float(f"{v:.{d}f}")


def catalog() -> list[dict]:
    out = []
    for symbol, name, exch, kind, _base, digits in SYMBOLS:
        out.append({"symbol": symbol, "name": name, "exchange": exch,
                    "type": kind, "digits": digits})
    return out


def resolve(symbol: str) -> dict:
    s = (symbol or "").strip()
    key = s.upper()
    key = ALIASES.get(key, key)
    for row in SYMBOLS:
        if row[0].upper() == key:
            return {"symbol": row[0], "name": row[1], "exchange": row[2],
                    "type": row[3], "base": row[4], "digits": row[5]}
    return {"symbol": SYMBOLS[0][0], "name": SYMBOLS[0][1],
            "exchange": SYMBOLS[0][2], "type": SYMBOLS[0][3],
            "base": SYMBOLS[0][4], "digits": SYMBOLS[0][5]}


class Feed:
    """Deterministic daily market per symbol, with intraday derived from it."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self._daily: dict[str, list[dict]] = {}
        self._series: dict[tuple[str, str, int], list[dict]] = {}
        self.engine = None
        self._live: dict[tuple[str, str, int], tuple[float, dict]] = {}
        self.live_error = ""

    # ---------------------------------------------------------- broker ---
    def bind(self, engine) -> None:
        """Attach the live Upstox engine (None keeps the sample feed)."""
        self.engine = engine

    def status(self) -> dict:
        eng = self.engine
        if eng is None:
            return {"authorized": False, "message": "broker not attached",
                    "live": False}
        try:
            ok, msg = eng.client.valid()
        except Exception:                              # noqa: BLE001
            ok, msg = False, "auth check failed"
        return {"authorized": bool(ok), "message": msg, "live": bool(ok),
                "error": self.live_error}

    def key_for(self, symbol: str) -> str:
        """Upstox instrument key for a terminal symbol, or ""."""
        eng = self.engine
        if eng is None:
            return ""
        for disp, _slug, up in INDEX_CATALOG:
            if disp == symbol:
                return eng.index_keys.get(up, "")
        for row in eng.stocks:
            if row.get("symbol") == symbol:
                return row.get("key", "")
        return ""

    @staticmethod
    def _rows(payload: dict) -> list[dict]:
        rows = (payload.get("data") or {}).get("candles") or []
        out = []
        for row in rows:
            try:
                ts = datetime.fromisoformat(str(row[0]))
                out.append({"t": int(ts.timestamp() * 1000),
                            "o": float(row[1]), "h": float(row[2]),
                            "l": float(row[3]), "c": float(row[4]),
                            "v": float(row[5] or 0)})
            except (ValueError, TypeError, IndexError):
                continue
        return out

    @staticmethod
    def _merge_rows(rows: list[dict]) -> list[dict]:
        seen: dict[int, dict] = {}
        for r in rows:
            seen[r["t"]] = r
        return [seen[t] for t in sorted(seen)]

    @staticmethod
    def _bucket(bars: list[dict], kind: str) -> list[dict]:
        out: list[dict] = []
        chunk: list[dict] = []
        last = None
        for b in bars:
            dt = datetime.fromtimestamp(b["t"] / 1000, IST)
            key = ((dt.isocalendar()[0], dt.isocalendar()[1]) if kind == "week"
                   else (dt.year, dt.month))
            if last is not None and key != last and chunk:
                out.append(Feed._merge(chunk))
                chunk = []
            chunk.append(b)
            last = key
        if chunk:
            out.append(Feed._merge(chunk))
        return out

    @staticmethod
    def _merge(chunk: list[dict]) -> dict:
        return {"t": chunk[0]["t"], "o": chunk[0]["o"],
                "h": max(b["h"] for b in chunk),
                "l": min(b["l"] for b in chunk),
                "c": chunk[-1]["c"],
                "v": float(sum(b["v"] for b in chunk))}

    def _live_daily(self, key: str, bars: int, interval: str) -> list[dict]:
        client = self.engine.client
        today = datetime.now(IST).date()
        span = {"1d": max(90, bars * 2), "1w": max(240, bars * 9),
                "1M": max(500, bars * 40)}[interval]
        start = today - timedelta(days=min(span, 3650))
        rows: list[dict] = []
        cur = today
        while cur > start:
            frm = max(start, cur - timedelta(days=730))
            try:
                d = client._get(
                    f"/v2/historical-candle/{_q(key)}/day/"
                    f"{cur.isoformat()}/{frm.isoformat()}")
            except (RuntimeError, PermissionError):
                break
            rows.extend(self._rows(d))
            cur = frm - timedelta(days=1)
        rows = self._merge_rows(rows)
        if interval == "1w":
            rows = self._bucket(rows, "week")
        elif interval == "1M":
            rows = self._bucket(rows, "month")
        return rows[-bars:]

    def _live_intraday(self, key: str, interval: str, bars: int) -> list[dict]:
        client = self.engine.client
        m = INTRADAY[interval]
        today = datetime.now(IST).date()
        days = min(60, max(3, math.ceil(bars * m / SESSION_MINUTES) + 2))
        start = today - timedelta(days=days)
        rows: list[dict] = []
        cur = today
        while cur > start:
            frm = max(start, cur - timedelta(days=25))
            try:
                d = client._get(
                    f"/v3/historical-candle/{_q(key)}/minutes/{m}/"
                    f"{cur.isoformat()}/{frm.isoformat()}")
            except (RuntimeError, PermissionError):
                break
            rows.extend(self._rows(d))
            cur = frm - timedelta(days=1)
        try:
            d = client._get(f"/v3/historical-candle/intraday/{_q(key)}"
                            f"/minutes/{m}")
            rows.extend(self._rows(d))
        except (RuntimeError, PermissionError):
            pass
        return self._merge_rows(rows)[-bars:]

    def _live_payload(self, sym: dict, interval: str, bars: int) -> dict | None:
        """Live candles with a short cache, or None to fall back to sample."""
        if self.engine is None or not self.status()["authorized"]:
            return None
        cache_key = (sym["symbol"], interval, bars)
        ttl = 8.0 if interval in INTRADAY else 180.0
        now = time.time()
        with self.lock:
            hit = self._live.get(cache_key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        key = self.key_for(sym["symbol"])
        if not key:
            return None
        try:
            if interval in DAILY:
                candles = self._live_daily(key, bars, interval)
            else:
                candles = self._live_intraday(key, interval, bars)
        except Exception as e:                         # noqa: BLE001
            self.live_error = str(e)[:160]
            return None
        if len(candles) < 20:
            return None
        payload = self._payload(sym, interval, candles, "live")
        with self.lock:
            self._live[cache_key] = (now, payload)
        return payload

    @staticmethod
    def _payload(sym: dict, interval: str, candles: list[dict],
                 source: str) -> dict:
        return {"symbol": sym["symbol"], "name": sym["name"],
                "exchange": sym["exchange"], "type": sym["type"],
                "digits": _digits(sym), "interval": interval,
                "source": source, "candles": candles}

    # ----------------------------------------------------------- daily ---
    def daily(self, symbol: str, bars: int = 900) -> list[dict]:
        key = symbol
        with self.lock:
            cached = self._daily.get(key)
        if cached:
            return cached[-bars:]

        # One fixed-width history per symbol: every interval, quote and
        # watchlist row then agrees on the same candles.
        sym = resolve(key)
        rnd = random.Random(_seed(key, "daily-v1"))
        digits = _digits(sym)
        dates: list = []
        day = datetime.now(IST).date() - timedelta(days=int(MAX_DAYS * 1.45) + 10)
        while len(dates) < MAX_DAYS:
            if day.weekday() < 5:
                dates.append(day)
            day += timedelta(days=1)
        dates = dates[-MAX_DAYS:]

        price = sym["base"] * rnd.uniform(0.62, 0.86)
        vol_regime = rnd.uniform(0.007, 0.014)
        trend = rnd.uniform(0.00035, 0.00110)
        out: list[dict] = []
        for i, d in enumerate(dates):
            phase = math.sin(i / 41.0 + rnd.random()) * 0.0009
            ret = trend + phase + rnd.gauss(0, vol_regime)
            if rnd.random() < 0.022:
                ret += rnd.choice((-1, 1)) * rnd.uniform(0.018, 0.042)
            o = price * (1 + rnd.gauss(0, vol_regime * 0.35))
            c = o * (1 + ret)
            span = abs(rnd.gauss(0, vol_regime)) + abs(ret) * 0.55
            h = max(o, c) * (1 + span * 0.8)
            l = min(o, c) * (1 - span * 0.8)
            v = rnd.uniform(0.55, 1.9) * (900_000 if sym["type"] != "index"
                                          else 260_000_000)
            v *= 1 + abs(ret) * 22
            out.append({"t": int(datetime(d.year, d.month, d.day, 15, 30,
                                          tzinfo=IST).timestamp() * 1000),
                        "o": _round(o, digits), "h": _round(h, digits),
                        "l": _round(l, digits), "c": _round(c, digits),
                        "v": float(round(v))})
            price = c

        # anchor the latest close to the symbol's reference price
        factor = sym["base"] / out[-1]["c"]
        for bar in out:
            for k in ("o", "h", "l", "c"):
                bar[k] = _round(bar[k] * factor, digits)

        with self.lock:
            self._daily[key] = out
        return out[-bars:]

    # ------------------------------------------------------- intraday ---
    def _session(self, sym: dict, day: dict) -> list[dict]:
        """One 1-minute session that opens/closes on the daily bar."""
        rnd = random.Random(_seed(sym["symbol"], day["t"], "min-v1"))
        digits = _digits(sym)
        o, h, l, c, v = day["o"], day["h"], day["l"], day["c"], day["v"]
        n = SESSION_MINUTES
        start = datetime.fromtimestamp(day["t"] / 1000, IST).replace(
            hour=DAY_START[0], minute=DAY_START[1], second=0, microsecond=0)

        lin = [o + (c - o) * i / n for i in range(1, n + 1)]
        span = max(h - l, sym["base"] * 0.0004)
        ramp = span * 0.32 / math.sqrt(n)
        devs: list[float] = []
        acc = 0.0
        for i in range(1, n + 1):
            acc = acc * 0.90 + rnd.gauss(0, ramp)
            devs.append(acc)
        # keep the path inside the day's range, then touch both extremes
        path = [min(max(li + di, l), h) for li, di in zip(lin, devs)]
        path[0] = o
        path[-1] = c
        hi_at = min(range(n), key=lambda i: -path[i])
        lo_at = min(range(n), key=lambda i: path[i])
        path[hi_at] = h
        path[lo_at] = l

        weights = [rnd.uniform(0.3, 1.9) for _ in range(n)]
        wsum = sum(weights) or 1.0
        out: list[dict] = []
        prev = o
        for i in range(n):
            clo = path[i]
            wick = span * rnd.uniform(0.01, 0.12)
            hi = min(max(prev, clo) + wick, h)
            lo = max(min(prev, clo) - wick, l)
            ts = start + timedelta(minutes=i)
            out.append({"t": int(ts.timestamp() * 1000),
                        "o": _round(prev, digits), "h": _round(hi, digits),
                        "l": _round(lo, digits), "c": _round(clo, digits),
                        "v": float(round(v * weights[i] / wsum))})
            prev = clo
        if hi_at < n:
            out[hi_at]["h"] = h
        if lo_at < n:
            out[lo_at]["l"] = l
        return out

    @staticmethod
    def _aggregate(bars: list[dict], k: int) -> list[dict]:
        if k <= 1:
            return bars
        out: list[dict] = []
        for i in range(0, len(bars), k):
            chunk = bars[i:i + k]
            if not chunk:
                continue
            out.append({"t": chunk[0]["t"],
                        "o": chunk[0]["o"],
                        "h": max(b["h"] for b in chunk),
                        "l": min(b["l"] for b in chunk),
                        "c": chunk[-1]["c"],
                        "v": float(sum(b["v"] for b in chunk))})
        return out

    def _daily_to_weekly(self, bars: list[dict], step: int) -> list[dict]:
        out: list[dict] = []
        bucket: list[dict] = []
        last_key = None
        for bar in bars:
            dt = datetime.fromtimestamp(bar["t"] / 1000, IST)
            key = (dt.isocalendar()[0], dt.isocalendar()[1]) if step == 5 \
                else (dt.year, dt.month)
            if last_key is not None and key != last_key and bucket:
                out.append({"t": bucket[0]["t"], "o": bucket[0]["o"],
                            "h": max(b["h"] for b in bucket),
                            "l": min(b["l"] for b in bucket),
                            "c": bucket[-1]["c"],
                            "v": float(sum(b["v"] for b in bucket))})
                bucket = []
            bucket.append(bar)
            last_key = key
        if bucket:
            out.append({"t": bucket[0]["t"], "o": bucket[0]["o"],
                        "h": max(b["h"] for b in bucket),
                        "l": min(b["l"] for b in bucket),
                        "c": bucket[-1]["c"],
                        "v": float(sum(b["v"] for b in bucket))})
        return out

    # --------------------------------------------------------- series ---
    def series(self, symbol: str, interval: str = "1d",
               bars: int = 600) -> dict:
        sym = resolve(symbol)
        interval = interval if interval in INTERVALS else "1d"
        bars = max(60, min(int(bars or 600), 3000))
        cache_key = (sym["symbol"], interval, bars)
        live = self._live_payload(sym, interval, bars)
        if live:
            return live
        with self.lock:
            hit = self._series.get(cache_key)
        if hit:
            return self._payload(sym, interval, hit, "sample")

        if interval in DAILY:
            need = bars if DAILY[interval] == 1 else bars * DAILY[interval]
            daily = self.daily(sym["symbol"], min(1200, max(300, need + 40)))
            if DAILY[interval] == 1:
                out = daily[-bars:]
            else:
                out = self._daily_to_weekly(daily, DAILY[interval])[-bars:]
        else:
            k = INTRADAY[interval]
            per_day = max(1, SESSION_MINUTES // k)
            days = min(10, max(1, math.ceil(bars / per_day)))
            daily = self.daily(sym["symbol"], 240)
            minutes: list[dict] = []
            for day in daily[-days:]:
                minutes.extend(self._session(sym, day))
            out = self._aggregate(minutes, k)[-bars:]

        with self.lock:
            self._series[cache_key] = out
        return self._payload(sym, interval, out, "sample")

    # --------------------------------------------------------- quotes ---
    def _live_quotes(self, syms: list[dict]) -> dict[str, dict]:
        eng = self.engine
        if eng is None or not self.status()["authorized"]:
            return {}
        keymap: dict[str, dict] = {}
        for s in syms:
            k = self.key_for(s["symbol"])
            if k:
                keymap[k] = s
        if not keymap:
            return {}
        try:
            data = eng.client.quotes_v3(list(keymap))
        except Exception as e:                         # noqa: BLE001
            self.live_error = str(e)[:160]
            return {}
        out: dict[str, dict] = {}
        for raw_key, q in (data or {}).items():
            nk = str(raw_key).replace(":", "|")
            sym = keymap.get(nk)
            if sym is None:
                tail = nk.split("|")[-1]
                sym = next((v for k, v in keymap.items()
                            if k.split("|")[-1] == tail), None)
            if sym is None:
                # quotes are keyed by trading symbol (NSE_EQ|RELIANCE) while the
                # master stores the ISIN, so match on the displayed ticker too
                tail = nk.split("|")[-1].upper()
                sym = next((v for v in keymap.values()
                            if v["symbol"].upper() == tail), None)
            if sym is None:
                continue
            ohlc = q.get("ohlc") or {}
            try:
                ltp = float(q.get("last_price") or 0)
            except (TypeError, ValueError):
                ltp = 0.0
            try:
                prev = float(ohlc.get("close") or 0)
            except (TypeError, ValueError):
                prev = 0.0
            if ltp <= 0:
                continue
            digits = _digits(sym)
            chg = _r(ltp - prev, digits) if prev else 0.0
            pct = (chg / prev * 100) if prev else 0.0
            out[sym["symbol"]] = {
                "symbol": sym["symbol"], "name": sym["name"],
                "exchange": sym["exchange"], "type": sym["type"],
                "digits": digits, "ltp": _r(ltp, digits),
                "prev": _r(prev, digits) if prev else None,
                "chg": chg, "pct": round(pct, 2),
                "open": ohlc.get("open"), "high": ohlc.get("high"),
                "low": ohlc.get("low"), "close": prev or None,
                "volume": q.get("volume"), "live": True,
            }
        return out

    def quotes(self, symbols: list[str]) -> list[dict]:
        bucket = int(time.time() // 30)
        syms = [resolve(raw) for raw in symbols[:80]]
        live = self._live_quotes(syms)
        out = []
        for sym in syms:
            hit = live.get(sym["symbol"])
            if hit:
                out.append(hit)
                continue
            daily = self.daily(sym["symbol"], 320)
            if len(daily) < 2:
                continue
            last, prev = daily[-1], daily[-2]
            rnd = random.Random(_seed(sym["symbol"], bucket, "tick"))
            drift = rnd.gauss(0, 0.00055) * (2.2 if sym["type"] == "crypto"
                                            else 1.0)
            digits = _digits(sym)
            ltp = _r(last["c"] * (1 + drift), digits)
            chg = _r(ltp - prev["c"], digits)
            pct = (chg / prev["c"] * 100) if prev["c"] else 0.0
            out.append({"symbol": sym["symbol"], "name": sym["name"],
                        "exchange": sym["exchange"], "type": sym["type"],
                        "digits": digits, "ltp": ltp,
                        "prev": prev["c"], "chg": chg,
                        "pct": round(pct, 2),
                        "open": last["o"], "high": last["h"],
                        "low": last["l"], "close": last["c"],
                        "volume": last["v"], "live": False})
        return out


FEED = Feed()
