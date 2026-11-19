"""ICT / SMC order-block engine — ported 1:1 from ict_ob_scanner_indices.py.

Every function in this module is the desktop scanner's own code (same
constants, same thresholds, same order of operations), so a scan run here
returns exactly the numbers the Tk app shows.
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


# ==========================================================================
# SM RALLY OPTION-DETAIL ENGINE (OI strip + liquidity grades)
# ==========================================================================

OPT_GRADES = ("ELITE", "STRONG", "OK", "THIN", "AVOID")


def oi_strip_grade(vol: float, spr: float, turnover: float) -> tuple[str, float]:
    """SM-Rally (OptiFlow) strike liquidity grade.

    Three factors weighted exactly as SM Rally does:
      0.55 — session traded turnover vs ₹25 L  (turnover = vol × ltp)
      0.25 — spread tightness (1 − spr/4, clamped ≥ 0)
      0.20 — contracts traded vs 4000
    Grades from the score: ELITE ≥ 75, STRONG ≥ 55, OK ≥ 40, THIN ≥ 25.
    """
    if vol <= 0 or turnover <= 0:                 # no trades -> junk
        return "AVOID", 0.0
    score = 100.0 * (
        0.55 * min(1.0, turnover / 2_500_000.0)   # ₹25L/day → full
        + 0.25 * max(0.0, 1.0 - spr / 4.0)        # spread tightness
        + 0.20 * min(1.0, vol / 4000.0))          # contracts traded
    grade = ("ELITE" if score >= 75 else "STRONG" if score >= 55
             else "OK" if score >= 40 else "THIN" if score >= 25
             else "AVOID")
    return grade, round(score, 1)


def oi_track_verdict(continuity_pct: float) -> tuple[str, str]:
    """SM-Rally continuity verdict for the last-90-minute window.
    Returns (verdict, color): STRONG > 50 %, OK > 25 %, else THIN."""
    if continuity_pct > 50:
        return "STRONG", "#00e676"
    if continuity_pct > 25:
        return "OK", "#ffaa00"
    return "THIN", "#f03030"


def build_oi_strip(
        symbol: str,
        sect_key: str,
        chain_raw: list[dict],
        expiry: str,
        tpm: list[dict],
        pct: float | None = None,
        status: str = "") -> dict:
    """Build the app-ready OI strip payload from option-chain rows —
    ported 1:1 from SM Rally's OptiFlow panel (sm_rally_edit)."""
    rows = [r for r in chain_raw if isinstance(r, dict)]

    def safefloat(x):
        try:
            if x is None:
                return None
            return float(x)
        except Exception:
            return None

    def _oich(md):
        """OI change: oi_net_change when present, else oi - prev_oi
        (the v2 /option/chain endpoint does not always send oi_net_change)."""
        ch = md.get("oi_net_change")
        if ch is None:
            ch = (md.get("oi") or 0) - (md.get("prev_oi") or 0)
        return safefloat(ch) or 0.0

    sides = []
    spot = pcr = ce_vol = pe_vol = 0.0
    for r in rows:
        if spot <= 0:
            spot = safefloat(r.get("underlying_spot_price")) or 0.0
        if pcr <= 0:
            pcr = safefloat(r.get("pcr")) or 0.0
        sides.append(r)
        IDE = "call_options"
        SIDE = "put_options"
        md_ce = r.get(IDE) or {}
        md_pe = r.get(SIDE) or {}
        _ce = md_ce.get("market_data") or {}
        _pe = md_pe.get("market_data") or {}
        ce_vol += safefloat(_ce.get("volume")) or 0
        pe_vol += safefloat(_pe.get("volume")) or 0

    if not sides:
        return {"symbol": symbol, "expiry": expiry or "", "spot": spot,
                "pct": pct or 0.0, "pcr": pcr, "ce_vol": 0, "pe_vol": 0,
                "flow": "NEUTRAL", "flow_dir": "NEUTRAL",
                "day_favor": "NEUTRAL", "rows": [], "tpm": [], "cont": 0.0,
                "cont_verdict": "—", "cont_color": "#6b7280",
                "cont_note": "no 1-min data", "track": None,
                "status": status}

    flow_ce = sum(_oich((r.get("call_options") or {}).get("market_data", {}))
                  for r in sides)
    flow_pe = sum(_oich((r.get("put_options") or {}).get("market_data", {}))
                  for r in sides)

    # ---- flow + day favor, exactly like SM Rally ------------------
    # SM-Rally side choice: bullish stock (pct >= 0) -> CE side; bearish
    # -> PE side. Only without a change% yet it falls back to the
    # volume-heavy side. dom = volume share of the dominant side.
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
    if pct is None:
        side, basis = flow_side, "flow"
    else:
        side, basis = ("CE" if pct >= 0 else "PE"), "day"

    # option-semantics day favour from the OI flow direction
    if abs(flow_pe) >= abs(flow_ce) and flow_pe > 0:
        day_favor = "LONG BUILDUP"
    elif abs(flow_pe) >= abs(flow_ce):
        day_favor = "SHORT COVERING"
    elif flow_ce > 0:
        day_favor = "SHORT BUILDUP"
    else:
        day_favor = "LONG UNWINDING"

    atm_strike = None
    if spot:
        atm_strike = min(
            (safefloat(r.get("strike_price")) or 0 for r in sides),
            key=lambda k: abs(k - spot))

    # ---- grade EVERY traded option, then rank by score (SM Rally) ----
    cands: list[dict] = []
    for r in sides:
        st = safefloat(r.get("strike_price")) or 0
        if not st:
            continue
        for side_name, blk in (("CE", r.get("call_options")),
                               ("PE", r.get("put_options"))):
            blk = blk or {}
            md = blk.get("market_data") or {}
            gr = blk.get("option_greeks") or {}
            ltp = safefloat(md.get("ltp")) or 0
            bid = safefloat(md.get("bid_price")) or 0
            ask = safefloat(md.get("ask_price")) or 0
            vol = safefloat(md.get("volume")) or 0
            iv = safefloat(gr.get("iv")) or 0
            if ltp > 0 and vol > 0:
                spr = ((ask - bid) / ltp * 100.0) \
                    if (ask > 0 and bid > 0) else 25.0
            else:
                spr, vol_used = 99.0, 0.0
            grade, score = oi_strip_grade(vol, spr, vol * ltp)
            cands.append({
                "strike": st, "side": side_name, "ltp": ltp, "spr": spr,
                "vol": int(vol), "iv": iv, "grade": grade, "score": score,
                "bid": bid, "ask": ask, "atm": (st == atm_strike),
                "key": blk.get("instrument_key") or "",
            })

    # ---- tracked option: day-favor side, ATM strike (SM Rally) --------
    spot0 = spot or (atm_strike or 0)
    pref = [c for c in cands if c["side"] == side and c["score"] > 0]
    if pref:
        best = min(pref, key=lambda c: (abs(c["strike"] - spot0),
                                        -c["score"]))
    else:
        best = (max(cands, key=lambda c: c["score"]) if cands else None)
    track = None
    if best:
        track = {"side": best["side"], "strike": best["strike"],
                 "ltp": best["ltp"], "grade": best["grade"],
                 "score": best["score"], "key": best["key"]}

    # ---- strike card: SM Rally takes the TOP 11 BY SCORE, shown
    #      side-grouped (CE rows first, then PE), like its text card ----
    top = [c for c in cands if c["score"] > 0]
    top.sort(key=lambda c: -c["score"])
    top = top[:11]
    top.sort(key=lambda c: (c["side"], c["strike"]))

    # ---- trades-per-minute continuity: LAST 90 MINUTES ONLY ---
    tail = tpm[-90:] if tpm else []
    cont_n = len(tail)
    cont_done = sum(1 for b in tail if (safefloat(b.get("v")) or 0) > 0)
    cont = (cont_done / cont_n * 100.0) if cont_n else 0.0
    verdict, vcolor = oi_track_verdict(cont)
    note = f"{cont_done}/{cont_n} mins traded" if cont_n \
        else "no 1-min data yet"

    return {
        "symbol": symbol, "expiry": expiry or "",
        "spot": spot, "pct": pct, "pcr": pcr,
        "ce_vol": int(ce_vol), "pe_vol": int(pe_vol),
        "flow": flow, "flow_side": flow_side, "dom": round(dom, 0),
        "day_favor": day_favor, "track_side": side, "track_basis": basis,
        "track": track,
        "rows": top, "tpm": tail,
        "cont": cont, "cont_verdict": verdict,
        "cont_color": vcolor, "cont_note": note,
        "status": status,
    }


def _fmt_big(v: float | int) -> str:
    """5,690,000 -> '56.9L';  4,400 -> '4.4K'  (SM-Rally number style)."""
    v = float(v or 0)
    for div, suf in ((10_000_000, "Cr"), (100_000, "L"), (1_000, "K")):
        if abs(v) >= div:
            return f"{v / div:.1f}{suf}"
    return f"{v:.0f}"


def summarize_oi_strip(strip: dict) -> str:
    """One-line summary for the OI strip header."""
    if not strip:
        return ""
    return (f"OPTION DETAIL — {strip['symbol']} "
            f"spot {strip['spot']:.2f} {strip['pct']:+.2f}% "
            f"expiry {strip['expiry']} {strip['flow']} "
            f"PCR {strip['pcr']:.2f} "
            f"CE {_fmt_big(strip['ce_vol'])} "
            f"PE {_fmt_big(strip['pe_vol'])} "
            f"day favor {strip['day_favor']}")


OI_COLORS = {
    "ELITE":  "#00e676",
    "STRONG": "#7fdbca",
    "OK":     "#d1d4dc",
    "THIN":   "#ffaa00",
    "AVOID":  "#6b7280",
}
OI_REFRESH_SEC = 15.0     # option-chain refresh cadence for the OI strip

# ---- second scan mode: rank by option-detail + trade-per-minute score ----
SCAN_MODES = ("OB VOL (x)", "OPTION + TPM", "RALLY + OPT",
              "INDICES")
SCAN_MODE_TITLE = {
    "OB VOL (x)": "STOCKS — BY OB VOLUME (x)",
    "OPTION + TPM": "STOCKS — OPTION DETAIL + TPM",
    "RALLY + OPT": "STOCKS — RALLY + OPTION/TPM",
    "INDICES": "INDICES — CLICK TO OPEN ITS F&O STOCKS",
}
OPT_RANK_TTL_SEC = 240.0   # per-symbol option+tpm score freshness
OPT_RANK_STEP_SEC = 0.60   # pause between option-chain fetches (rate-limit safe)



# ==========================================================================
# ICT / SMC ORDER-BLOCK ENGINE (Pine Script port)
# ==========================================================================

def swing_gate(st: dict | None) -> int:
    st = st or {}
    return int(st.get("swingLen", 10)) + int(st.get("obLookback", 5)) + 5


def _rma(src: list[float], n: int):
    """Wilder's RMA (same as Pine ta.rma): seeded with SMA of first n."""
    out = [None] * len(src)
    if len(src) < n:
        return out
    s = sum(src[:n]) / n
    out[n - 1] = s
    for i in range(n, len(src)):
        out[i] = (out[i - 1] * (n - 1) + src[i]) / n
    return out


def _win_max(vals: list[float], idx: int, n: int, off: int) -> float | None:
    """max over vals[idx-off-n+1 .. idx-off]  == ta.highest(...)[off]."""
    lo = idx - off - n + 1
    hi = idx - off
    if lo < 0:
        return None
    return max(vals[lo:hi + 1])


def _win_min(vals: list[float], idx: int, n: int, off: int) -> float | None:
    lo = idx - off - n + 1
    hi = idx - off
    if lo < 0:
        return None
    return min(vals[lo:hi + 1])


def _htf_levels(sess_date, daily: list[dict]) -> dict:
    """Previous Day / Week / Month high / low from daily candles.

    Same values the indicator gets from request.security(..., high[1],
    lookahead_on): the LAST COMPLETED day / week / month before the
    session date.
    """
    htf = {"PDH": None, "PDL": None, "PWH": None, "PWL": None,
           "PMH": None, "PML": None}
    if not daily:
        return htf

    prev_day = None
    weeks: "OrderedDict[tuple, list[dict]]" = OrderedDict()
    months: "OrderedDict[tuple, list[dict]]" = OrderedDict()
    for c in daily:
        d = c["ts"].date()
        if d < sess_date:
            prev_day = c
        weeks.setdefault(d.isocalendar()[:2], []).append(c)
        months.setdefault((d.year, d.month), []).append(c)

    if prev_day is not None:
        htf["PDH"], htf["PDL"] = prev_day["h"], prev_day["l"]

    sess_wk = sess_date.isocalendar()[:2]
    for wk in sorted(weeks):
        if wk >= sess_wk:
            break
        vals = weeks[wk]
        htf["PWH"] = max(c["h"] for c in vals)
        htf["PWL"] = min(c["l"] for c in vals)

    sess_mo = (sess_date.year, sess_date.month)
    for mk in sorted(months):
        if mk >= sess_mo:
            break
        vals = months[mk]
        htf["PMH"] = max(c["h"] for c in vals)
        htf["PML"] = min(c["l"] for c in vals)
    return htf


def run_engine(candles: list[dict], daily: list[dict],
               st: dict | None = None) -> dict:
    """Run the port. Returns a result dict:

    {
      "session_date": date,
      "obs": [ {dir, top, bottom, mid, origin_idx, origin_ts, right_idx,
                grade, sweep_tag, fvg, bos, swept, raided_htf, vol_ratio,
                active, retested, mitigated_idx} ],
      "vwap": [ (ts, vwap) ... ] for today's session,
      "vwap_day_parts": [ (date, [(ts, vwap) ...]) ... ],
      "htf": {"PDH":.., "PDL":.., "PWH":.., "PWL":.., "PMH":.., "PML":..},
      "pd_status": str, "vwap_bias": bool, "rel_vol": float,
      "n_bull_active": int, "n_bear_active": int,
    }
    Only order blocks ORIGINATING in the current intraday session are
    reported (pre-made OBs from earlier days are never included).
    """
    st = st or {}
    n = len(candles)
    res = {
        "session_date": candles[-1]["ts"].date() if n else None,
        "obs": [],
        "vwap": [],
        "vwap_day_parts": [],
        "htf": {"PDH": None, "PDL": None, "PWH": None, "PWL": None,
                "PMH": None, "PML": None},
        "pd_status": "",
        "vwap_bias": False,
        "rel_vol": 0.0,
        "n_bull_active": 0,
        "n_bear_active": 0,
    }
    gate = swing_gate(st)
    if n < gate + 8:
        return res

    ob_lookback = int(st.get("obLookback", 5))
    swing_len = int(st.get("swingLen", 10))
    atr_mult = float(st.get("atrMult", 1.1))
    req_fvg = bool(st.get("reqFVG", True))
    req_bos = bool(st.get("reqBOS", True))
    req_sweep = bool(st.get("reqSweep", False))
    use_vol = bool(st.get("useVolFilter", True))
    vol_mult = float(st.get("volMult", 1.2))
    use_vwap_f = bool(st.get("useVwapFilter", False))
    ict_refined = st.get("zoneMode",
                         "ICT Refined (Body to Extremity)") == \
        "ICT Refined (Body to Extremity)"
    mitigation = st.get("mitigationMode",
                        "Close Beyond Distal (Full Invalidation)")
    max_active = int(st.get("maxActiveOBs", 6))

    ts = [c["ts"] for c in candles]
    o = [c["o"] for c in candles]
    h = [c["h"] for c in candles]
    l = [c["l"] for c in candles]
    cl = [c["c"] for c in candles]
    v = [float(c["v"]) for c in candles]

    # ---- ATR(14) (Wilder) ---------------------------------------------------
    tr = []
    prev_c = None
    for i in range(n):
        if prev_c is None:
            tr.append(h[i] - l[i])
        else:
            tr.append(max(h[i] - l[i], abs(h[i] - prev_c),
                          abs(l[i] - prev_c)))
        prev_c = cl[i]
    atr = _rma(tr, 14)

    # ---- Volume SMA(20) -----------------------------------------------------
    volsma: list = []
    for i in range(n):
        volsma.append(sum(v[i - 19:i + 1]) / 20.0 if i >= 19 else None)

    # ---- Session VWAP (resets each day, like Pine ta.vwap) ------------------
    vw: list = []
    cum_pv = 0.0
    cum_v = 0.0
    cur_day = None
    day_parts: list[tuple] = []
    day_seg: list[tuple] = []
    for i in range(n):
        d = ts[i].date()
        if d != cur_day:
            cur_day = d
            cum_pv = 0.0
            cum_v = 0.0
            day_seg = []
            day_parts.append((d, day_seg))
        hlcv3 = (h[i] + l[i] + cl[i]) / 3.0 * v[i]
        cum_pv += hlcv3
        cum_v += v[i]
        val = (cum_pv / cum_v) if cum_v > 0 else None
        vw.append(val)
        day_seg.append((ts[i], val))

    # ---- HTF levels ----------------------------------------------------------
    # SESSION = TODAY (IST) ONLY. Never treat a stale/partial candle day as
    # "the session": if today's candles are missing or a stock's data is
    # behind, order blocks from previous days must NOT be counted.
    sess_date = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    htf = _htf_levels(sess_date, daily)
    res["htf"] = htf
    res["session_date"] = sess_date

    # ---- engine state ----------------------------------------------------------
    bull_active: list[dict] = []
    bear_active: list[dict] = []
    generated: list[dict] = []     # EVERY OB created (incl. capped/mitigated)
    last_bull_origin = -1
    last_bear_origin = -1
    session_high = None
    session_low = None

    def _new_ob(direction, top, bot, origin_idx, b, grade, tag, fv, bb,
                swl, raid, vr) -> dict:
        return {
            "dir": direction,
            "top": top,
            "bottom": bot,
            "mid": (top + bot) / 2.0,
            "origin_idx": origin_idx,
            "origin_ts": ts[origin_idx],
            "right_idx": b,
            "grade": grade,
            "sweep_tag": tag,
            "fvg": fv,
            "bos": bb,
            "swept": swl,
            "raided_htf": raid,
            "vol_ratio": vr,
            "active": True,
            "retested": False,
            "mitigated_idx": None,
            "dropped_for_cap": False,
        }

    for b in range(n):
        # ==================================================================
        # 6. MITIGATION, EXTENSION & RETEST ENGINE (runs on every bar)
        # ==================================================================
        for arr in (bull_active, bear_active):
            for i in range(len(arr) - 1, -1, -1):
                ob = arr[i]
                if b > ob["origin_idx"] + 2:
                    if mitigation == "Close Beyond Distal (Full Invalidation)":
                        invalid = cl[b] < ob["bottom"] if ob["dir"] == 1 \
                            else cl[b] > ob["top"]
                    elif mitigation == "Close Beyond 50% Mean Threshold":
                        invalid = cl[b] < ob["mid"] if ob["dir"] == 1 \
                            else cl[b] > ob["mid"]
                    else:  # First Touch (Wick)
                        invalid = l[b] <= ob["top"] if ob["dir"] == 1 \
                            else h[b] >= ob["bottom"]
                    if invalid:
                        ob["active"] = False
                        ob["mitigated_idx"] = b - 1
                        arr.pop(i)
                    else:
                        ob["right_idx"] = b
                        if not ob["retested"]:
                            if ob["dir"] == 1 and l[b] <= ob["top"] and \
                                    cl[b] >= ob["mid"]:
                                ob["retested"] = True
                            elif ob["dir"] == -1 and h[b] >= ob["bottom"] and \
                                    cl[b] <= ob["mid"]:
                                ob["retested"] = True

        # ==================================================================
        # 5. ORDER BLOCK ORIGIN SCANNER (Pine condition: bar_index > N)
        # ==================================================================
        if b <= gate or b - ob_lookback - 2 < 0:
            continue
        a = atr[b]
        if a is None:
            continue

        prev_sh = _win_max(h, b, swing_len, 2)
        prev_sl = _win_min(l, b, swing_len, 2)

        # ------------------------------------------------ A. bullish ---
        bull_fvg = l[b] > h[b - 2] and cl[b - 1] > o[b - 1]
        bull_disp = (cl[b - 1] - o[b - 1]) >= a * atr_mult or \
            (cl[b] - o[b - 2]) >= a * atr_mult * 1.4
        bull_bos = cl[b] > prev_sh or cl[b - 1] > prev_sh

        vwap_ok = (not use_vwap_f) or (vw[b] is not None and cl[b] > vw[b])
        trig = bull_disp and (not req_fvg or bull_fvg) and \
            (not req_bos or bull_bos)

        if trig and vwap_ok:
            anchor = -1
            base = 1e10
            for i in range(2, ob_lookback + 1):
                if cl[b - i] < o[b - i] and l[b - i] < base:
                    base = l[b - i]
                    anchor = i
            if anchor == -1:
                for i in range(2, ob_lookback + 1):
                    if l[b - i] < base:
                        base = l[b - i]
                        anchor = i
            exact = b - anchor
            if anchor != -1 and exact != last_bull_origin:
                prior_low = _win_min(l, b, swing_len, anchor + 1)
                base_low = min(l[b - anchor], l[b - anchor - 1])
                swept_local = prior_low is not None and base_low < prior_low
                raided = False
                for lvl in (htf["PDL"], htf["PWL"], htf["PML"]):
                    if lvl is not None and base_low <= lvl and cl[b] > lvl:
                        raided = True
                        break
                swept_liq = swept_local or raided
                s1 = volsma[b - anchor]
                s2 = volsma[b - 1]
                vs1 = s1 is not None and v[b - anchor] > s1 * vol_mult
                vs2 = s2 is not None and v[b - 1] > s2 * vol_mult
                vol_surge = vs1 or vs2
                if (not req_sweep or swept_liq) and (not use_vol or vol_surge):
                    top_ = max(o[b - anchor], cl[b - anchor]) if ict_refined \
                        else h[b - anchor]
                    bot_ = l[b - anchor]
                    if (top_ - bot_) < a * 0.15:
                        top_ = h[b - anchor]
                    vr = max(
                        v[b - anchor] / (s1 if s1 else 1.0),
                        v[b - 1] / (s2 if s2 else 1.0),
                    )
                    score = int(bull_fvg) + int(bull_bos) + int(swept_liq) + \
                        int(vol_surge) + int(raided)
                    grade = "S-TIER" if score >= 4 else \
                        ("A+" if score == 3 else "OB")
                    tag = ("[HTF-RAID]" if raided else
                           "[SWEEP]" if swept_local else "")
                    ob = _new_ob(1, top_, bot_, exact, b, grade, tag,
                                 bull_fvg, bull_bos, swept_liq, raided, vr)
                    generated.append(ob)
                    bull_active.append(ob)
                    last_bull_origin = exact
                    if len(bull_active) > max_active:
                        old = bull_active.pop(0)
                        old["active"] = False
                        old["dropped_for_cap"] = True

        # ------------------------------------------------ B. bearish ---
        bear_fvg = h[b] < l[b - 2] and cl[b - 1] < o[b - 1]
        bear_disp = (o[b - 1] - cl[b - 1]) >= a * atr_mult or \
            (o[b - 2] - cl[b]) >= a * atr_mult * 1.4
        bear_bos = cl[b] < prev_sl or cl[b - 1] < prev_sl

        vwap_ok = (not use_vwap_f) or (vw[b] is not None and cl[b] < vw[b])
        trig = bear_disp and (not req_fvg or bear_fvg) and \
            (not req_bos or bear_bos)

        if trig and vwap_ok:
            anchor = -1
            base = -1e10
            for i in range(2, ob_lookback + 1):
                if cl[b - i] > o[b - i] and h[b - i] > base:
                    base = h[b - i]
                    anchor = i
            if anchor == -1:
                for i in range(2, ob_lookback + 1):
                    if h[b - i] > base:
                        base = h[b - i]
                        anchor = i
            exact = b - anchor
            if anchor != -1 and exact != last_bear_origin:
                prior_high = _win_max(h, b, swing_len, anchor + 1)
                base_high = max(h[b - anchor], h[b - anchor - 1])
                swept_local = prior_high is not None and \
                    base_high > prior_high
                raided = False
                for lvl in (htf["PDH"], htf["PWH"], htf["PMH"]):
                    if lvl is not None and base_high >= lvl and cl[b] < lvl:
                        raided = True
                        break
                swept_liq = swept_local or raided
                s1 = volsma[b - anchor]
                s2 = volsma[b - 1]
                vs1 = s1 is not None and v[b - anchor] > s1 * vol_mult
                vs2 = s2 is not None and v[b - 1] > s2 * vol_mult
                vol_surge = vs1 or vs2
                if (not req_sweep or swept_liq) and (not use_vol or vol_surge):
                    top_ = h[b - anchor]
                    bot_ = min(o[b - anchor], cl[b - anchor]) if ict_refined \
                        else l[b - anchor]
                    if (top_ - bot_) < a * 0.15:
                        bot_ = l[b - anchor]
                    vr = max(
                        v[b - anchor] / (s1 if s1 else 1.0),
                        v[b - 1] / (s2 if s2 else 1.0),
                    )
                    score = int(bear_fvg) + int(bear_bos) + int(swept_liq) + \
                        int(vol_surge) + int(raided)
                    grade = "S-TIER" if score >= 4 else \
                        ("A+" if score == 3 else "OB")
                    tag = ("[HTF-RAID]" if raided else
                           "[SWEEP]" if swept_local else "")
                    ob = _new_ob(-1, top_, bot_, exact, b, grade, tag,
                                 bear_fvg, bear_bos, swept_liq, raided, vr)
                    generated.append(ob)
                    bear_active.append(ob)
                    last_bear_origin = exact
                    if len(bear_active) > max_active:
                        old = bear_active.pop(0)
                        old["active"] = False
                        old["dropped_for_cap"] = True

        if ts[b].date() == sess_date:
            session_high = h[b] if session_high is None else \
                max(session_high, h[b])
            session_low = l[b] if session_low is None else \
                min(session_low, l[b])

    # ---- report only OBs originating in the current intraday session -------
    session_obs = [ob for ob in generated
                   if ob["origin_ts"].date() == sess_date]
    res["obs"] = session_obs
    res["vwap_day_parts"] = day_parts
    res["vwap"] = day_seg  # segment for the session date (last day)

    # dashboard values
    last_v = v[-1]
    last_s = volsma[-1]
    res["rel_vol"] = (last_v / last_s) if last_s else 0.0
    last_vw = vw[-1]
    last_c = cl[-1]
    res["vwap_bias"] = bool(last_vw is not None and last_c > last_vw)

    pdh, pdl = htf["PDH"], htf["PDL"]
    if pdh is not None and pdl is not None and session_high is not None:
        both = session_high >= pdh and session_low <= pdl
        res["pd_status"] = ("BOTH SWEPT" if both
                            else "PDH SWEPT" if session_high >= pdh
                            else "PDL SWEPT" if session_low <= pdl
                            else "INSIDE PD RANGE")

    res["n_bull_active"] = sum(1 for ob in session_obs
                               if ob["dir"] == 1 and ob["active"])
    res["n_bear_active"] = sum(1 for ob in session_obs
                               if ob["dir"] == -1 and ob["active"])
    return res


def max_ob_volx(result: dict) -> float:
    """Stock headline number: highest vol ratio (x Vol) of any still-active
    (TV-visible) order block generated during the intraday session, no
    matter which block. Mitigated/capped OBs are removed in TV, so they do
    not count."""
    obs = result.get("obs") or []
    return max((ob["vol_ratio"] for ob in obs if ob["active"]),
               default=0.0)


# ==========================================================================
# SCANNER CONSTANTS + OI BIAS + RALLY PATTERN
# ==========================================================================

REQUEST_PAUSE = 0.13   # seconds between API calls (~7 req/s, well under limits)
CYCLE_SLEEP = 5.0
RALLY_COLOR_MIN = 30.0   # SM-Rally default min-score filter for the strip


def _oi_tag(q: dict) -> str | None:
    """Classify OI bias from a futures quote:
    LB = Long Build-up    (price up   + OI up)   -> bullish, GREEN strip
    SB = Short Build-up   (price down + OI up)   -> bearish, RED strip
    Anything else (covering / unwinding / flat) gets NO strip.
    """
    md = q.get("market_data") or {}
    src = md if (md.get("oi") is not None
                 or md.get("previous_oi") is not None) else q
    lp = src.get("last_price")
    pc = (src.get("prev_close_price")
          or (src.get("ohlc") or {}).get("close")
          or (md.get("ohlc") or {}).get("close"))
    oi = src.get("oi")
    poi = src.get("previous_oi") or md.get("previous_oi")
    if not (lp and pc and oi and poi):
        return None
    try:
        chg = (lp - pc) / pc
        dup = (oi - poi) / poi
    except ZeroDivisionError:
        return None
    if abs(chg) < 0.0008 and abs(dup) < 0.005:
        return None                       # flat day: no meaningful bias
    if dup <= 0:
        return None                      # OI falling: covering/unwinding — no strip
    return "LB" if chg >= 0 else "SB"


def latest_day_candles(st, today_di: str | None = None) -> list[dict]:
    """The candles of the stock's most recent TRADED session (today when we
    have them, else the last session in cache). Lets the rally strip stay
    populated while the market is closed / over a weekend, instead of
    blanking out just because no candle exists under today's date key."""
    td = today_di or (date.today().isoformat())
    day = st.candles.get(td) or []
    if day:
        return day
    for di in sorted(st.candles, reverse=True):
        if st.candles[di]:
            return st.candles[di]
    return []


def rally_score_symbol(st, vrank: float) -> tuple[str | None, float]:
    """SM-Rally 'Rally Pattern' symbol strip logic, 1:1 with the source app:

    BULL RALLY = price in the upper half of its day range, moved >= 0.8% up
                 from the day low;  BEAR RALLY = mirror at the day high.
    Score      = price_move_score x position_quality x day-confirm bonus x
                 range factor, then boosted 0.85..1.15x by the stock's volume
                 percentile across the whole F&O list.
    Returns ("BULL"|"BEAR"|None, score-number)."""
    # last traded session: today when live, else the last cached session so
    # the results survive after market close / over a weekend
    day = latest_day_candles(st)
    day_di = day[-1]["ts"].strftime("%Y-%m-%d") if day else \
        date.today().isoformat()
    ltp = float(st.ltp or 0.0) or (float(day[-1]["c"]) if day else 0.0)
    if not day or ltp <= 0:
        return (None, 0.0)

    # outside market hours there is no live LTP: use the session close so
    # the pattern list stays the same the whole time in between sessions
    if not st.ltp and day:
        ltp = float(day[-1]["c"])

    dh = max([float(c["h"]) for c in day] + [ltp])
    dl = min([float(c["l"]) for c in day] + [ltp])
    day_range = dh - dl
    if day_range < 0.01:
        return (None, 0.0)

    # previous close for the pct-confirm bonus: last daily candle BEFORE
    # the session being scored, else that session's open
    pc = 0.0
    for c in reversed(st.daily_prev or []):
        ts = c.get("ts")
        d = ts.date() if isinstance(ts, datetime) else None
        if d is not None and d.isoformat() < day_di:
            pc = float(c["c"])
            break
    if pc <= 0:
        pc = float(day[0]["o"])
    pct = (ltp - pc) / pc * 100.0 if pc > 0 else 0.0

    range_pos = max(0.0, min(1.0, (ltp - dl) / day_range))
    is_bull = range_pos >= 0.50
    if is_bull:
        move_pct = (ltp - dl) / dl * 100.0
        pos_quality = range_pos
    else:
        move_pct = (dh - ltp) / dh * 100.0
        pos_quality = 1.0 - range_pos
    if move_pct < 0.8:
        return (None, 0.0)

    price_score = min(100.0, move_pct * 10.0)
    quality = (pos_quality - 0.5) * 2.0
    if (is_bull and pct > 0) or (not is_bull and pct < 0):
        pct_bonus = min(1.3, 1.0 + abs(pct) * 0.06)
    else:
        pct_bonus = 0.80
    cl = pc if pc > 0 else ltp
    range_pct = day_range / cl * 100.0
    range_factor = min(1.5, max(0.5, range_pct * 0.4))

    raw = price_score * (0.5 + 0.5 * quality) * pct_bonus * range_factor
    final = round(min(100.0, min(100.0, raw)
                      * (0.85 + 0.30 * vrank)), 1)  # re-capped like SM Rally
    return ("BULL" if is_bull else "BEAR", final)

