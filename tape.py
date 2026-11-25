"""Session tape for the Smart Money stage.

The stage draws every stock's move through the day — a field of lines, a bead
row, a waterfall and the ranked tiles. The scanner itself only knows "now", so
this thread keeps one point a minute per stock (and per index) from the
engine's own rows: no second data source, no extra broker calls.

The page falls back to the current minute when a stock has no history yet, so
the waterfall, beads and tiles always render; the lines fill in as the session
runs.
"""
from __future__ import annotations

import threading
from datetime import datetime

from scanner_core import IST, market_session

STEP = 15.0        # seconds between looks; one point a minute is kept
MAXPTS = 420       # a full session of minutes
RALLY_MIN = 30.0   # the desktop scanner's RALLY + OPT colour threshold


class Tape(threading.Thread):
    def __init__(self, engine):
        super().__init__(daemon=True)
        self.engine = engine
        self.lock = threading.Lock()
        self.paths: dict[str, list[list[float]]] = {}
        self.ipaths: dict[str, list[list[float]]] = {}
        self._last_min = -1
        self.stop_evt = threading.Event()

    # ------------------------------------------------------------------ clock
    @staticmethod
    def _minute(now: datetime) -> int:
        """Minutes since 09:15, clamped to a session (1..375)."""
        m = (now.hour - 9) * 60 + now.minute - 15 + 1
        return max(1, min(375, m))

    # ----------------------------------------------------------------- sampler
    def run(self) -> None:
        while not self.stop_evt.is_set():
            try:
                self.sample()
            except Exception:                              # noqa: BLE001
                pass
            self.stop_evt.wait(STEP)

    def sample(self) -> None:
        eng = self.engine
        try:
            with eng.lock:
                rows = [(r.get("symbol"), r.get("pct")) for r in eng.rows.values()]
                idx = [(c.get("name"), c.get("pct")) for c in eng.indices]
        except Exception:                                   # noqa: BLE001
            return
        m = self._minute(datetime.now(IST))
        if m == self._last_min:
            return
        self._last_min = m
        with self.lock:
            for sym, pct in rows:
                if not sym or pct is None:
                    continue
                p = self.paths.setdefault(sym, [])
                if not p or p[-1][0] < m:
                    p.append([m, round(float(pct), 2)])
                    if len(p) > MAXPTS:
                        del p[: len(p) - MAXPTS]
            for name, pct in idx:
                if not name or pct is None:
                    continue
                p = self.ipaths.setdefault(name, [])
                if not p or p[-1][0] < m:
                    p.append([m, round(float(pct), 2)])
                    if len(p) > MAXPTS:
                        del p[: len(p) - MAXPTS]

    # ----------------------------------------------------------------- payload
    def payload(self) -> dict:
        eng = self.engine
        with eng.lock:
            rows = [{
                "sym": r.get("symbol"), "sector": r.get("sector") or "",
                "ltp": r.get("ltp"), "pct": r.get("pct"),
                "dir": r.get("dir") or "", "score": r.get("score") or 0,
                "comb": r.get("comb") or 0, "oi": r.get("oi") or "",
                "pos": r.get("pos") or 0, "opt": r.get("opt"),
            } for r in eng.rows.values() if r.get("ltp")]
            if getattr(eng, "scope_syms", None):
                rows = [r for r in rows if r["sym"] in eng.scope_syms]
            idx = [{"name": c.get("name"), "ltp": c.get("ltp"),
                    "pct": c.get("pct")} for c in eng.indices if c.get("ltp")]
        with self.lock:
            paths = {k: list(v) for k, v in self.paths.items()}
            ipaths = {k: list(v) for k, v in self.ipaths.items()}

        for r in rows:
            r["path"] = paths.get(r["sym"], [])

        # RALLY + OPT is the base ranking: only stocks in a rally (direction set,
        # rally score above zero) are listed, and they sort by the composite of
        # rally strength and option quality — chains already read first, so a
        # scored option outranks a name nobody has looked at yet.
        def ro(rows, side):
            return sorted([r for r in rows if r["dir"] == side and r["score"] > 0],
                          key=lambda r: (0 if r["opt"] else 1, -r["comb"], -r["score"]))
        bull = ro(rows, "BULL")
        bear = ro(rows, "BEAR")
        for i, r in enumerate(bull):
            r["side"], r["rank"] = "bull", i + 1
        for i, r in enumerate(bear):
            r["side"], r["rank"] = "bear", i + 1

        secs: dict[str, list[dict]] = {}
        for r in rows:
            if r["sector"]:
                secs.setdefault(r["sector"], []).append(r)
        sectors = sorted([{
            "name": k, "n": len(v),
            "pct": round(sum(s["pct"] for s in v) / len(v), 2),
            "up": sum(1 for s in v if s["pct"] > 0),
            "down": sum(1 for s in v if s["pct"] < 0),
        } for k, v in secs.items() if len(v) >= 3], key=lambda s: -s["pct"])

        indices = {c["name"]: {**c, "path": ipaths.get(c["name"], [])}
                   for c in idx}
        return {
            "time": datetime.now(IST).isoformat(timespec="seconds"),
            "market": market_session(),
            "demo": bool(getattr(eng, "demo", True)),
            "auth": getattr(eng, "auth_msg", ""),
            "mode": "RALLY + OPT",
            "weights": "0.62 rally + 0.38 option quality",
            "rally_min": RALLY_MIN,
            "stocks": rows,
            "indices": indices,
            "sectors": sectors,
            "bull": [r["sym"] for r in bull],
            "bear": [r["sym"] for r in bear],
        }
