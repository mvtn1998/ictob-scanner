"""OB Sentinel — website + live scanner feed.

    python server.py            -> http://127.0.0.1:8765

The landing page (`/`) is the product experience; the numbers-only board
lives at `/board` for personal use. Both read the same background engine.
"""
from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

import terminal_feed
from scanner_engine import Engine
from site_feed import chart_payload, pulse_payload
from tape import Tape

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
HOST = os.environ.get("OB_HOST", "127.0.0.1")
PORT = int(os.environ.get("OB_PORT") or os.environ.get("PORT") or "8765")
# A deployed copy cannot finish an Upstox login (the app has one registered
# redirect URI, pointing at this computer), so the local instance hands it the
# day's token instead. Set OB_CLOUD=1 on the host.
CLOUD = os.environ.get("OB_CLOUD", "") == "1"


def _sync_conf() -> tuple[str, str]:
    url = os.environ.get("OB_SYNC_URL", "").strip()
    key = os.environ.get("OB_SYNC_KEY", "").strip()
    if not (url and key):
        try:
            d = json.loads((ROOT / "config" / "sync.json").read_text(
                encoding="utf-8"))
            url = url or str(d.get("url") or "")
            key = key or str(d.get("key") or "")
        except (OSError, ValueError):
            pass
    return url.rstrip("/"), key


SYNC_URL, SYNC_KEY = _sync_conf()

ENGINE: Engine | None = None
TAPE: Tape | None = None
# pages that may be the landing page after a successful Upstox login
PAGE_AFTER_LOGIN = {"terminal": "/terminal", "board": "/board",
                    "smart": "/smart", "dash": "/dash"}


def push_token(token: str) -> bool:
    """Hand the day's token to the deployed copy (no-op when unset)."""
    if not (token and SYNC_URL and SYNC_KEY):
        return False
    try:
        r = requests.post(f"{SYNC_URL}/api/auth/token",
                          json={"access_token": token},
                          headers={"X-OB-Key": SYNC_KEY}, timeout=20)
        return r.status_code == 200
    except requests.RequestException:
        return False


class TokenSync(threading.Thread):
    """Keep the deployed copy logged in after the daily re-login here."""

    def __init__(self) -> None:
        super().__init__(daemon=True, name="token-sync")
        self.last = ""

    def run(self) -> None:
        while ENGINE is not None:
            try:
                tok = ENGINE.client.token()
                if tok and tok != self.last and ENGINE.client.valid()[0]:
                    if push_token(tok):
                        self.last = tok
                        print("token synced to the deployed site")
            except Exception:                       # noqa: BLE001
                pass
            time.sleep(300)


class Handler(BaseHTTPRequestHandler):
    server_version = "OBSentinel/1.1"
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: bytes, ctype: str,
              extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, payload, code: int = 200) -> None:
        body = json.dumps(payload, default=str,
                          allow_nan=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def redirect(self, to: str) -> None:
        self._send(302, b"", "text/plain", {"Location": to})

    def log_message(self, fmt, *args):          # keep the console readable
        if "/api/" in (str(args[0]) if args else ""):
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:                   # noqa: N802
        try:
            self._route(urlparse(self.path))
        except Exception:                       # noqa: BLE001
            traceback.print_exc()
            self.json({"error": "internal error"}, 500)

    def do_POST(self) -> None:                  # noqa: N802
        try:
            self._post(urlparse(self.path))
        except Exception:                       # noqa: BLE001
            traceback.print_exc()
            self.json({"error": "internal error"}, 500)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 4096:
            return {}
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}
        return d if isinstance(d, dict) else {}

    def _post(self, u) -> None:
        if u.path != "/api/auth/token":
            self.json({"error": "not found"}, 404)
            return
        if not SYNC_KEY or self.headers.get("X-OB-Key", "") != SYNC_KEY:
            self.json({"error": "forbidden"}, 403)
            return
        tok = str(self._body().get("access_token") or "").strip()
        if len(tok) < 20:
            self.json({"error": "access_token required"}, 400)
            return
        ENGINE.client.save_token(tok)
        print("token received from the local scanner")
        self.json({"ok": True})

    def _route(self, u) -> None:
        path = u.path
        q = parse_qs(u.query)
        eng = ENGINE

        if path == "/healthz":
            self.json({"ok": True, "stocks": len(eng.stocks),
                       "indices": len(eng.indices), "demo": eng.demo,
                       "auth": eng.auth_msg,
                       "tick": round(time.time() - eng.last_tick, 1)
                       if eng.last_tick else None})
            return
        if path == "/api/chart":
            sym = (q.get("symbol") or ["NIFTY 50"])[0]
            self.json(chart_payload(eng, sym))
            return
        if path == "/api/pulse":
            self.json(pulse_payload(eng))
            return
        if path == "/api/terminal/symbols":
            self.json({"symbols": terminal_feed.catalog()})
            return
        if path == "/api/terminal/candles":
            sym = (q.get("symbol") or ["NIFTY 50"])[0]
            iv = (q.get("interval") or ["1d"])[0]
            try:
                bars = int((q.get("bars") or ["600"])[0])
            except ValueError:
                bars = 600
            self.json(terminal_feed.FEED.series(sym, iv, bars))
            return
        if path == "/api/terminal/quotes":
            raw = (q.get("symbols") or [""])[0]
            self.json({"quotes": terminal_feed.FEED.quotes(
                [s for s in raw.split(",") if s.strip()])})
            return
        if path == "/api/terminal/status":
            self.json(terminal_feed.FEED.status())
            return
        if path == "/api/tape":
            self.json(TAPE.payload() if TAPE else {"stocks": []})
            return
        if path == "/api/snapshot":
            mode = (q.get("mode") or ["rally"])[0]
            self.json(eng.snapshot(mode="opt" if mode == "opt" else "rally"))
            return
        if path == "/api/option":
            sym = (q.get("symbol") or [""])[0].upper()
            if not sym:
                self.json({"error": "symbol required"}, 400)
                return
            self.json(eng.option_detail(sym))
            return
        if path == "/api/scope":
            name = (q.get("name") or [""])[0]
            self.json(eng.set_scope(name or None))
            return
        if path == "/api/auth/login":
            nxt = (q.get("next") or [""])[0]
            state = "ob-sentinel" + (f"|{nxt}" if nxt in PAGE_AFTER_LOGIN else "")
            self.redirect(eng.client.login_url(state=state))
            return
        if path == "/api/auth/state":
            ok, msg = eng.client.valid()
            self.json({"authorized": ok, "message": msg,
                       "demo": eng.demo, "login": not CLOUD,
                       "cloud": CLOUD, "sync": bool(SYNC_URL)})
            return
        if path == "/callback":
            code = (q.get("code") or [""])[0]
            if not code:
                self._send(400, b"missing code", "text/plain")
                return
            try:
                eng.client.exchange_code(code)
            except Exception as e:              # noqa: BLE001
                self._send(500, f"login failed: {e}".encode(), "text/plain")
                return
            threading.Thread(target=push_token,
                             args=(eng.client.token(),), daemon=True).start()
            dest = "/?linked=1"
            state = (q.get("state") or [""])[0]
            if "|" in state:
                nxt = state.split("|", 1)[1]
                if nxt in PAGE_AFTER_LOGIN:
                    dest = PAGE_AFTER_LOGIN[nxt] + "?linked=1"
            self.redirect(dest)
            return

        # ---- pages ----
        if path in ("/", ""):
            return self._file("index.html")
        if path == "/board":
            return self._file("board.html")
        if path == "/dash":
            return self._file("dash.html")
        if path == "/smart":
            return self._file("smart.html")
        if path in ("/terminal", "/terminal/"):
            return self._file("terminal.html")

        rel = path.lstrip("/")
        self._file(rel)

    def _file(self, rel: str) -> None:
        target = (WEB / rel).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            self._send(403, b"forbidden", "text/plain")
            return
        if not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype = (mimetypes.guess_type(str(target))[0]
                 or "application/octet-stream")
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)


def main() -> None:
    global ENGINE, TAPE
    ENGINE = Engine(ROOT, DATA)
    ENGINE.start()
    terminal_feed.FEED.bind(ENGINE)
    TAPE = Tape(ENGINE)
    TAPE.start()
    if SYNC_URL and SYNC_KEY:
        TokenSync().start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"OB SENTINEL  ->  http://{HOST}:{PORT}")
    if CLOUD:
        print("cloud mode: the Upstox token is received from the local scanner")
    print(f"universe: {len(ENGINE.stocks)} F&O stocks · "
          f"indices: {len(ENGINE.indices)} · auto live/sample")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        ENGINE.stop_evt.set()
        srv.shutdown()


if __name__ == "__main__":
    main()
