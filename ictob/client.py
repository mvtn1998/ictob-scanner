"""Upstox REST client (login, master, candles, quotes, option chain).

The request shapes are the desktop scanner's own: v3 intraday candles, the
v2 daily range endpoint, v2/v3 quotes (v2 is the one that also accepts
NSE_INDEX), and the v2 option contract/chain endpoints that need the raw
instrument key (never a URL-encoded pipe).
"""
from __future__ import annotations

import gzip
import json
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, urlencode

import requests

from .config import BASE_URL, CRED_FILE, IST, STATE_DIR, TOKEN_FILE

API_BASE = "https://api.upstox.com"
MASTER_URL = ("https://assets.upstox.com/market-quote/instruments/"
              "exchange/complete.json.gz")
UA = {"User-Agent": "ictob-scanner/1.0", "Accept": "application/json"}


class UpstoxError(Exception):
    pass


class UpstoxAuthError(UpstoxError):
    """401 / invalid token -> re-login needed."""


class Upstox:
    def __init__(self, root: Path | None = None, timeout: float = 25.0):
        self.root = Path(root or CRED_FILE.parent.parent)
        state = Path(STATE_DIR)
        self.token_file = (state / "upstox_token.json" if state != self.root
                           else TOKEN_FILE)
        self.cred_file = (state / "config" / "credentials.json"
                          if state != self.root else CRED_FILE)
        self._mem_token = ""
        self._mem_cred: dict = {}
        self.session = requests.Session()
        self.session.headers.update(UA)
        self.timeout = timeout
        self.eq_master: dict = {}     # symbol -> NSE_EQ row (all equities)
        self.idx_master: dict = {}    # "Nifty 50" -> NSE_INDEX|Nifty 50
        self._valid: tuple[float, bool, str] | None = None

    # ------------------------------------------------------------- auth ----
    def credentials(self) -> dict:
        """file < environment < values saved from the UI at runtime."""
        try:
            c = json.loads(self.cred_file.read_text(encoding="utf-8"))
            c = c if isinstance(c, dict) else {}
        except (OSError, ValueError):
            c = {}
        for env, key in (("UPSTOX_API_KEY", "api_key"),
                         ("UPSTOX_API_SECRET", "api_secret"),
                         ("UPSTOX_REDIRECT_URI", "redirect_uri")):
            val = os.environ.get(env, "").strip()
            if val:
                c[key] = val
        if not c.get("redirect_uri") and BASE_URL:
            c["redirect_uri"] = BASE_URL + "/callback"
        if self._mem_cred:
            c = {**c, **{k: v for k, v in self._mem_cred.items() if v}}
        return c

    def save_credentials(self, key: str, secret: str, redirect: str) -> None:
        self._mem_cred = {"api_key": key, "api_secret": secret,
                          "redirect_uri": redirect}
        try:
            self.cred_file.parent.mkdir(parents=True, exist_ok=True)
            self.cred_file.write_text(json.dumps({
                "api_key": key, "api_secret": secret,
                "redirect_uri": redirect,
            }, indent=2), encoding="utf-8")
        except OSError:
            pass

    def token(self) -> str:
        if self._mem_token:
            return self._mem_token
        try:
            tok = str(json.loads(self.token_file.read_text(
                encoding="utf-8")).get("access_token") or "")
            if tok:
                return tok
        except (OSError, ValueError):
            pass
        return os.environ.get("UPSTOX_ACCESS_TOKEN", "").strip()

    def save_token(self, token: str, api_key: str = "") -> None:
        self._mem_token = token
        self._valid = None
        try:
            self.token_file.parent.mkdir(parents=True, exist_ok=True)
            self.token_file.write_text(json.dumps({
                "access_token": token, "obtained_at": time.time(),
                "api_key": api_key,
            }, indent=2), encoding="utf-8")
        except OSError:
            pass

    def login_url(self, state: str = "ictob") -> str:
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
                     "User-Agent": "ictob-scanner/1.0"},
            data={"code": code,
                  "client_id": c.get("api_key", ""),
                  "client_secret": c.get("api_secret", ""),
                  "redirect_uri": c.get("redirect_uri", ""),
                  "grant_type": "authorization_code"},
            timeout=self.timeout)
        try:
            d = r.json()
        except ValueError as e:
            raise UpstoxError(f"Bad JSON ({r.status_code})") from e
        tok = d.get("access_token")
        if not tok:
            raise UpstoxAuthError(
                f"Token exchange failed: {str(d)[:280]}")
        self.save_token(tok, c.get("api_key", ""))
        return d

    def profile(self) -> dict:
        return self._get_json("/v2/user/profile")

    def valid(self, ttl: float = 45.0) -> tuple[bool, str]:
        tok = self.token()
        if not tok:
            return False, "not linked"
        if self._valid and time.time() - self._valid[0] < ttl:
            return self._valid[1], self._valid[2]
        try:
            r = requests.get(f"{API_BASE}/v2/user/profile",
                             headers={**UA,
                                      "Authorization": f"Bearer {tok}"},
                             timeout=12)
            if r.status_code == 200:
                self._valid = (time.time(), True, "authorized")
                return True, "authorized"
            msg = ("token expired — Upstox tokens die at 3:30 AM"
                   if r.status_code in (401, 403) else f"HTTP {r.status_code}")
            self._valid = (time.time(), False, msg)
            return False, msg
        except requests.RequestException as e:
            return False, f"network: {str(e)[:80]}"

    # ---------------------------------------------------------- helpers ----
    @staticmethod
    def _decode(r: requests.Response) -> dict:
        if r.status_code == 401:
            raise UpstoxAuthError(
                "401 Unauthorized - access token expired (Upstox tokens "
                "expire 3:30 AM). Please login again.")
        if r.status_code == 403:
            raise UpstoxAuthError(
                "403 Forbidden - token lacks permission for this API "
                "(check ApiPermissions on the Upstox app).")
        if r.status_code >= 400:
            raise UpstoxError(f"HTTP {r.status_code}: {r.text[:300]}")
        try:
            return r.json()
        except ValueError as e:
            raise UpstoxError(
                f"Bad JSON ({r.status_code}): {r.text[:200]}") from e

    def _get_json(self, path: str, params: dict | None = None) -> dict:
        tok = self.token()
        if not tok:
            raise UpstoxAuthError("not authorized")
        r = self.session.get(API_BASE + path, params=params,
                             headers={"Authorization": f"Bearer {tok}"},
                             timeout=self.timeout)
        return self._decode(r)

    # ---------------------------------------------------------- candles ----
    @staticmethod
    def _parse_candles(d: dict) -> list[dict]:
        rows = (d.get("data") or {}).get("candles") or []
        out = []
        for row in rows:
            try:
                out.append({
                    "ts": datetime.fromisoformat(row[0]),
                    "o": float(row[1]), "h": float(row[2]),
                    "l": float(row[3]), "c": float(row[4]),
                    "v": float(row[5] or 0),
                })
            except (ValueError, TypeError, IndexError):
                continue
        out.sort(key=lambda c: c["ts"])
        return out

    def candles_day(self, key: str, to_date: date,
                    from_date: date) -> list[dict]:
        path = (f"/v2/historical-candle/{quote(key)}/day/"
                f"{to_date.isoformat()}/{from_date.isoformat()}")
        return self._parse_candles(self._get_json(path))

    def candles_hist(self, key: str, minutes: int, to_date: date,
                     from_date: date) -> list[dict]:
        path = (f"/v3/historical-candle/{quote(key)}/minutes/{minutes}/"
                f"{to_date.isoformat()}/{from_date.isoformat()}")
        return self._parse_candles(self._get_json(path))

    def candles_intraday(self, key: str, minutes: int) -> list[dict]:
        path = (f"/v3/historical-candle/intraday/{quote(key)}"
                f"/minutes/{minutes}")
        return self._parse_candles(self._get_json(path))

    # ----------------------------------------------------------- quotes ----
    def ltp(self, keys: list[str]) -> dict:
        if not keys:
            return {}
        out = {}
        for i in range(0, len(keys), 400):
            part = keys[i:i + 400]
            d = self._get_json("/v2/market-quote/ltp",
                               params={"instrument_key": ",".join(part)})
            out.update(d.get("data") or {})
        return out

    def quotes_v3(self, keys: list[str]) -> dict:
        if not keys:
            return {}
        out = {}
        for i in range(0, len(keys), 150):
            part = keys[i:i + 150]
            d = self._get_json("/v3/market-quote/quotes",
                               params={"instrument_key": ",".join(part)})
            out.update(d.get("data") or {})
        return out

    def quotes_v2(self, keys: list[str]) -> dict:
        if not keys:
            return {}
        out = {}
        for i in range(0, len(keys), 100):
            part = keys[i:i + 100]
            try:
                d = self._get_json("/v2/market-quote/quotes",
                                   params={"instrument_key": ",".join(part)})
            except UpstoxAuthError:
                raise
            except (UpstoxError, requests.RequestException):
                continue
            out.update(d.get("data") or {})
        return out

    # ---------------------------------------------------- option chain -----
    def option_contracts(self, spot_key: str) -> list[dict]:
        d = self._get_json("/v2/option/contract",
                           params={"instrument_key": spot_key})
        out = d.get("data") or []
        if isinstance(out, dict):
            out = out.get("items") or out.get("data") or list(out.values())
        return out if isinstance(out, list) else []

    def option_chain(self, spot_key: str, expiry: str) -> list[dict]:
        d = self._get_json("/v2/option/chain",
                           params={"instrument_key": spot_key,
                                   "expiry_date": expiry})
        data = d.get("data")
        if isinstance(data, dict):
            data = data.get("data") or data.get("rows") or list(data.values())
        if not isinstance(data, list):
            data = [data] if data else []
        return data

    def option_intraday_1m(self, opt_key: str) -> list[dict]:
        try:
            raw = self.candles_intraday(opt_key, 1)
        except Exception:                       # noqa: BLE001
            return []
        today = datetime.now(IST).strftime("%Y-%m-%d")
        out = [c for c in raw
               if getattr(c.get("ts"), "strftime", lambda f: "")(\
                   "%Y-%m-%d") == today]
        return out or raw

    # ----------------------------------------------------------- master ----
    def load_master(self, timeout: float = 90.0) -> list[dict] | None:
        """Instrument master rows.

        The desktop app streams the exchange file fresh on every start; the
        website prefers the copy already on disk (data/instruments_cache.json)
        and only downloads when it is missing or stale.
        """
        cache = self.root / "data" / "instruments_cache.json"
        try:
            stamp = cache.stat().st_mtime
        except OSError:
            stamp = 0
        if cache.exists() and (time.time() - stamp) < 86400:
            try:
                rows = json.loads(cache.read_text(encoding="utf-8"))
                if isinstance(rows, list) and rows:
                    return rows
            except (OSError, ValueError):
                pass
        try:
            r = requests.get(MASTER_URL, headers={"User-Agent": "ictob-scanner/1.0"},
                             timeout=timeout)
            r.raise_for_status()
            raw = gzip.decompress(r.content)
            rows = json.loads(raw)
            if isinstance(rows, list) and rows:
                try:
                    cache.write_text(json.dumps(rows), encoding="utf-8")
                except OSError:
                    pass
                return rows
        except Exception:                       # noqa: BLE001
            pass
        try:
            rows = json.loads(cache.read_text(encoding="utf-8"))
            return rows if isinstance(rows, list) else None
        except (OSError, ValueError):
            return None

    def build_universe(self, rows: list[dict]) -> tuple[dict, dict]:
        """({symbol: {key,name,fut,fut_us}}, {index name: key}).

        NSE stock futures are joined to their NSE_EQ equity row via the
        underlying key, and the nearest live monthly future is kept — the
        same universe the desktop scanner builds from the master.
        """
        eq_by_key: dict = {}
        eq_by_symbol: dict = {}
        futs: dict[str, list[dict]] = {}
        futs_by_sym: dict[str, list[dict]] = {}
        idx: dict[str, str] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            seg = row.get("segment") or row.get("exc")
            it = row.get("instrument_type")
            if seg == "NSE_INDEX" and row.get("name"):
                idx[row["name"]] = row["instrument_key"]
            elif seg == "NSE_EQ" and it == "EQ":
                sym = (row.get("trading_symbol") or row.get("symbol") or "").upper()
                if not sym:
                    continue
                rec = {"symbol": sym, "name": row.get("name") or sym,
                       "isin": row.get("isin"), "key": row["instrument_key"]}
                eq_by_key[row["instrument_key"]] = rec
                eq_by_symbol[sym] = rec
            elif seg == "NSE_FO" and it == "FUT":
                ut = row.get("underlying_type")
                if ut not in ("EQUITY", None):
                    continue
                uk = row.get("underlying_key")
                if uk and "|" in uk:
                    futs.setdefault(uk, []).append(row)
                us = str(row.get("underlying_symbol") or "").upper()
                if us:
                    futs_by_sym.setdefault(us, []).append(row)

        def nearest(rows_: list[dict]) -> tuple:
            if not rows_:
                return None, None
            try:
                rows_ = sorted(rows_, key=lambda r: str(
                    r.get("expiry") or r.get("expiry_date") or ""))
            except Exception:                   # noqa: BLE001
                pass
            r0 = rows_[0]
            return r0.get("instrument_key"), r0.get("underlying_symbol")

        stocks: dict[str, dict] = {}
        for k, e in eq_by_key.items():
            fs = futs.get(k)
            if not fs:
                continue
            e = dict(e)
            e["fut"], e["fut_us"] = nearest(fs)
            stocks[e["symbol"]] = e
        for sym, fs in futs_by_sym.items():
            if sym in stocks or sym not in eq_by_symbol:
                continue
            e = dict(eq_by_symbol[sym])
            e["fut"], e["fut_us"] = nearest(fs)
            stocks[sym] = e
        self.eq_master = {e["symbol"]: dict(e) for e in eq_by_key.values()}
        self.idx_master = idx
        return dict(sorted(stocks.items())), idx
