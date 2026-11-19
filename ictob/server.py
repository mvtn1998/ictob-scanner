"""ICT OB Scanner — web terminal server.

    python run_scanner.py        ->  http://127.0.0.1:8770

The page is the desktop app's layout: ranking list on the left, the
TradingView-style OB chart on the right with the SM-Rally option-detail
strip beneath it. Every number comes from the scanner thread (the ported
ICT/SMC engine), never from the browser.
"""
from __future__ import annotations

import base64
import hmac
import json
import mimetypes
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import BASE_URL, HOST, PASSWORD, PORT, WEB
from .scanner import Scanner

ENGINE: Scanner | None = None
START_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "ICTOBScanner/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ helpers ---
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

    # ------------------------------------------------------------- access ---
    def _authorized(self) -> bool:
        """HTTP Basic gate, active only when ICTOB_PASSWORD is set."""
        if not PASSWORD:
            return True
        head = self.headers.get("Authorization") or ""
        if not head.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(head[6:]).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return False
        _user, _sep, given = raw.partition(":")
        return hmac.compare_digest(given, PASSWORD)

    def _challenge(self) -> None:
        self._send(401, b"password required", "text/plain; charset=utf-8",
                   {"WWW-Authenticate": 'Basic realm="ICT OB Scanner"'})

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # --------------------------------------------------------------- GET ---
    def do_GET(self) -> None:                       # noqa: N802
        try:
            self._route(urlparse(self.path))
        except Exception:                           # noqa: BLE001
            traceback.print_exc()
            self.json({"error": "internal error"}, 500)

    def do_POST(self) -> None:                      # noqa: N802
        if not self._authorized():
            self._challenge()
            return
        try:
            u = urlparse(self.path)
            if u.path == "/api/auth/token":
                self._post_token()
                return
            self.json({"error": "not found"}, 404)
        except Exception:                           # noqa: BLE001
            traceback.print_exc()
            self.json({"error": "internal error"}, 500)

    def _post_token(self) -> None:
        eng = ENGINE
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(min(length, 20000)) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            self.json({"error": "bad json"}, 400)
            return
        if not isinstance(payload, dict):
            self.json({"error": "bad payload"}, 400)
            return
        if payload.get("token"):
            eng.client.save_token(str(payload["token"]).strip(),
                                  str(payload.get("api_key") or ""))
            self.json({"ok": True, "message": "token saved"})
            return
        key = str(payload.get("api_key") or "").strip()
        if payload.get("save_only"):
            if not (key and payload.get("api_secret")
                    and payload.get("redirect_uri")):
                self.json({"error": "api key, secret and redirect URI are "
                                    "required"}, 400)
                return
            eng.client.save_credentials(
                key, str(payload["api_secret"]).strip(),
                str(payload["redirect_uri"]).strip())
            self.json({"ok": True, "message": "credentials saved"})
            return
        secret = str(payload.get("api_secret") or "").strip()
        redirect = str(payload.get("redirect_uri") or "").strip()
        code = str(payload.get("code") or "").strip().strip("'\"")
        if code.lower().startswith("http"):
            q = parse_qs(urlparse(code).query)
            code = (q.get("code") or [""])[0]
        if not (key and secret and redirect and code):
            self.json({"error": "api key, secret, redirect URI and code "
                                "are all required"}, 400)
            return
        eng.client.save_credentials(key, secret, redirect)
        try:
            eng.client.exchange_code(code)
        except Exception as e:                      # noqa: BLE001
            self.json({"error": str(e)[:300]}, 400)
            return
        self.json({"ok": True, "message": "broker linked"})

    def _route(self, u) -> None:
        path = u.path
        q = parse_qs(u.query)
        eng = ENGINE

        if path == "/healthz":
            self.json({"ok": True,
                       "mode": "live" if eng and not eng.demo else "sample",
                       "phase": (eng.phase if eng else {})})
            return
        if not self._authorized():
            self._challenge()
            return

        if path == "/api/state":
            self.json(eng.snapshot())
            return
        if path == "/api/chart":
            sym = (q.get("symbol") or [eng.selected or ""])[0]
            try:
                tf = int((q.get("tf") or [eng.tf])[0])
            except ValueError:
                tf = eng.tf
            cut = q.get("cut")
            try:
                cut_i = int(cut[0]) if cut and cut[0] != "" else None
            except ValueError:
                cut_i = None
            self.json(eng.chart(sym, tf, cut_i))
            return
        if path == "/api/oi":
            sym = (q.get("symbol") or [eng.selected or ""])[0]
            self.json(eng.oi_strip(sym))
            return
        if path == "/api/select":
            sym = (q.get("symbol") or [""])[0].upper()
            if sym in eng.states:
                eng.selected = sym
                threading.Thread(target=eng.focus_refresh, args=(sym,),
                                 daemon=True).start()
            self.json({"selected": eng.selected})
            return
        if path == "/api/set":
            self._set(q)
            return
        if path == "/api/refresh":
            self.json({"ok": True,
                       "message": "scan cycle is always running"})
            return
        if path == "/api/auth/login":
            if not eng.client.credentials().get("api_key"):
                self.json({"error": "save API credentials first"}, 400)
                return
            self.redirect(eng.client.login_url())
            return
        if path == "/api/auth/state":
            ok, msg = eng.client.valid()
            self.json({"authorized": ok, "message": msg})
            return
        if path == "/callback":
            code = (q.get("code") or [""])[0]
            if not code:
                self._send(400, b"missing code", "text/plain")
                return
            try:
                eng.client.exchange_code(code)
            except Exception as e:                  # noqa: BLE001
                self._send(500, f"login failed: {e}".encode(), "text/plain")
                return
            self.redirect("/?linked=1")
            return

        if path in ("/", ""):
            return self._file("index.html")
        self._file(path.lstrip("/"))

    def _set(self, q) -> None:
        eng = ENGINE
        if "mode" in q:
            mode = q["mode"][0]
            if mode in ("OB VOL (x)", "OPTION + TPM", "RALLY + OPT",
                        "INDICES"):
                eng.mode = mode
                if mode != "INDICES":
                    eng.set_index(None)
        if "tv" in q:
            try:
                eng.tf = int(q["tv"][0])
            except ValueError:
                pass
        if "vol" in q:
            eng.vol_candles = q["vol"][0] in ("1", "true", "on")
        if "filter" in q:
            eng.filter = (q["filter"][0] or "").strip()
        if "index" in q:
            eng.set_index((q["index"][0] or "").strip() or None)
        if "chgmin" in q:
            try:
                eng.idx_chg_min = float(q["chgmin"][0])
            except (ValueError, TypeError):
                eng.idx_chg_min = None
        self.json({"ok": True})

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
    global ENGINE
    with START_LOCK:
        if ENGINE is None:
            ENGINE = Scanner(WEB.parent.parent)
            ENGINE.start()
    ThreadingHTTPServer.allow_reuse_address = True
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"ICT OB SCANNER  ->  http://{HOST}:{PORT}")
    if BASE_URL:
        print(f"public origin   ->  {BASE_URL}")
    print(f"password gate   ->  {'on' if PASSWORD else 'off'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        if ENGINE:
            ENGINE.stop_evt.set()
        srv.shutdown()


if __name__ == "__main__":
    main()
