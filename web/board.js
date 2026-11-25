/* OB SENTINEL — live board client
   Market picture · ranked bullish/bearish boards · setup panel */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MINT = "#6cf5c2";
  const ROSE = "#ff7a98";
  const CYAN = "#67d8ff";
  const DIM = "#4c5663";
  const GRADE = { ELITE: MINT, STRONG: CYAN, OK: "#b9c6dd", THIN: "#ffbe55", AVOID: "#6b7280" };
  const MONO = '500 8.5px "JetBrains Mono", ui-monospace, monospace';

  const num = (v, d = 2) => {
    const n = Number(v);
    return isFinite(n) ? n.toLocaleString("en-IN",
      { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
  };
  const int = (v) => {
    const n = Number(v);
    return isFinite(n) ? Math.round(n).toLocaleString("en-IN") : "—";
  };
  const pctTxt = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  };
  const shortIdx = (name) => String(name || "").replace(/^NIFTY ?/, "") || name;

  const state = {
    snap: null,
    pulse: null,
    selected: null,
    scope: "",
    seen: { BULL: new Set(), BEAR: new Set() },
    chart: null,
    seq: 0,
    booted: false,
  };

  /* ============================================================
     clock · tape
     ============================================================ */
  function tickClock() {
    const now = new Date();
    const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
    $("clock").textContent = ist.toTimeString().slice(0, 8);
    const s = state.snap;
    $("sessionLbl").textContent = s ? `${s.session} · ${s.date}` : "—";
  }

  let tapeBuilt = false;
  function renderTape(indices) {
    const box = $("tape");
    if (!box || !indices || !indices.length) return;
    if (!tapeBuilt) {
      const items = indices.concat(indices).map((ix) =>
        `<span class="tk" data-name="${esc(ix.name)}"><b>${esc(shortIdx(ix.name))}</b>` +
        `<i class="v">—</i><i class="p">—</i></span>`).join("");
      box.innerHTML = items;
      tapeBuilt = true;
    }
    const byName = new Map(indices.map((i) => [i.name, i]));
    box.querySelectorAll(".tk").forEach((el) => {
      const ix = byName.get(el.dataset.name);
      if (!ix) return;
      el.classList.toggle("up", Number(ix.pct) >= 0);
      el.classList.toggle("down", Number(ix.pct) < 0);
      el.querySelector(".v").textContent = ix.ltp ? num(ix.ltp, 1) : "—";
      el.querySelector(".p").textContent = pctTxt(ix.pct);
    });
  }

  /* ============================================================
     market picture — one dot per stock
     ============================================================ */
  const dots = { cv: null, ctx: null, data: [], w: 0, h: 0, geom: null };

  function dotsResize() {
    const cv = $("dotfield");
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    dots.w = Math.max(1, r.width);
    dots.h = Math.max(1, r.height);
    cv.width = Math.round(dots.w * dpr);
    cv.height = Math.round(dots.h * dpr);
    dots.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dotsDraw();
  }

  function dotsDraw() {
    const c = dots.ctx;
    if (!c || !dots.data.length) return;
    const { w, h } = dots;
    c.clearRect(0, 0, w, h);
    const midY = h / 2;
    const maxPct = Math.max(1, ...dots.data.map((d) => Math.abs(d[1])));
    const padX = 12;
    /* compressed scale: the dense middle of the market still spreads out */
    const x = (p) => w / 2 + (Math.sign(p) || 0) *
      Math.sqrt(Math.abs(p) / maxPct) * (w / 2 - padX);
    dots.geom = { x, maxPct, midY };

    /* axis */
    c.strokeStyle = "rgba(255,255,255,.12)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(padX, midY + .5);
    c.lineTo(w - padX, midY + .5);
    c.stroke();
    c.setLineDash([2, 4]);
    c.strokeStyle = "rgba(255,255,255,.06)";
    c.beginPath();
    c.moveTo(w / 2, 4); c.lineTo(w / 2, h - 4);
    c.stroke();
    c.setLineDash([]);

    /* leader labels */
    c.font = MONO;
    c.fillStyle = DIM;
    c.textAlign = "left";
    c.fillText(`-${maxPct.toFixed(1)}%`, padX, h - 2);
    c.textAlign = "center";
    c.fillText("0", w / 2, h - 2);
    c.textAlign = "right";
    c.fillText(`+${maxPct.toFixed(1)}%`, w - padX, h - 2);

    const bulls = dots.data.filter((d) => d[2] === "BULL")
      .sort((a, b) => b[3] - a[3]).slice(0, 6);
    const bears = dots.data.filter((d) => d[2] === "BEAR")
      .sort((a, b) => b[3] - a[3]).slice(0, 6);
    const ringed = new Set([...bulls, ...bears].map((d) => d[0]));

    dots.pos = [];
    dots.data.forEach(([sym, pct, dir, score], i) => {
      const px = x(Number(pct) || 0);
      const s = Math.max(0, Math.min(100, Number(score) || 0));
      const jitter = ((i * 37) % 13) / 13 - 0.5;      // stable, spread the dots
      const reach = (midY - 7);
      const depth = 0.24 + (s / 100) * 0.76;
      let py;
      if (dir === "BEAR") py = midY + 3 + Math.abs(depth) * reach * 0.92 +
        jitter * 8;
      else if (dir === "BULL") py = midY - 3 - Math.abs(depth) * reach * 0.92 +
        jitter * 8;
      else py = midY + jitter * 5;
      py = Math.max(4, Math.min(h - 10, py));
      dots.pos.push({ sym, pct, px, py });
      const color = dir === "BEAR" ? ROSE : dir === "BULL" ? MINT : "#5d6675";
      c.globalAlpha = ringed.has(sym) ? 1 : 0.62;
      c.fillStyle = color;
      c.beginPath();
      c.arc(px, py, ringed.has(sym) ? 2.5 : 1.7, 0, Math.PI * 2);
      c.fill();
      if (ringed.has(sym)) {
        c.globalAlpha = .5;
        c.strokeStyle = color;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(px, py, 5.5, 0, Math.PI * 2);
        c.stroke();
      }
    });
    c.globalAlpha = 1;
  }

  function bindDotHover() {
    const cv = $("dotfield");
    const tip = $("dotTip");
    if (!cv || !tip) return;
    cv.addEventListener("mousemove", (e) => {
      if (!dots.geom || !dots.data.length) return;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = null, bestD = 12;
      (dots.pos || []).forEach((p) => {
        const dist = Math.hypot(p.px - mx, p.py - my);
        if (dist < bestD) { bestD = dist; best = p; }
      });
      if (!best) { tip.hidden = true; return; }
      const { sym, pct } = best;
      tip.hidden = false;
      tip.style.left = `${best.px}px`;
      tip.style.top = `${best.py}px`;
      tip.innerHTML = `<b>${esc(sym)}</b> ` +
        `<span class="${Number(pct) >= 0 ? "up" : "down"}">${pctTxt(pct)}</span>`;
    });
    cv.addEventListener("mouseleave", () => { tip.hidden = true; });
  }

  /* ============================================================
     boards
     ============================================================ */
  function sideRows(side) {
    const rows = (state.snap?.rows || []).filter((r) => r.dir === side);
    return rows.sort((a, b) => b.comb - a.comb).slice(0, 14);
  }

  function rowHtml(r, i, total) {
    const bull = r.dir === "BULL";
    const p = Math.min(99.9, 100 - (i / Math.max(1, total)) * 100);
    const rule = i < 3 ? `<span class="pick p">pick</span>`
      : i < 8 ? `<span class="pick w">watch</span>` : "";
    const opt = r.opt || null;
    const gColor = opt ? (GRADE[opt.grade] || "#b9c6dd") : "";
    const optCell = opt
      ? `<b style="color:${gColor}">${esc(opt.grade)}</b>` +
        `<em>${esc(opt.side)} ${num(opt.strike, 0)}</em>`
      : `<b style="color:#3f4753">—</b><em class="dim">no chain</em>`;
    return `<li class="row" data-sym="${esc(r.symbol)}">
      <span class="rk">p${p.toFixed(1)}<em>#${i + 1}/${total}</em></span>
      <span class="stock"><b>${esc(r.symbol)}</b>` +
        (r.sector ? `<em>${esc(r.sector.replace(/^NIFTY /, ""))}</em>` : "") + `</span>
      <span class="rule">${rule}</span>
      <span class="str"><span class="meter${bull ? "" : " bear"}"><i style="width:${Math.min(100, r.comb)}%"></i></span><b>${(r.comb || 0).toFixed(0)}</b></span>
      <span class="mv ${Number(r.pct) >= 0 ? "up" : "down"}">${pctTxt(r.pct)}</span>
      <span class="opt">${optCell}</span>
    </li>`;
  }

  function renderBoard(side, listEl, total) {
    const rows = sideRows(side);
    if (!rows.length) {
      listEl.innerHTML = `<li class="empty-row">no ${side.toLowerCase()} structure right now</li>`;
      state.seen[side] = new Set();
      return;
    }
    const seen = state.seen[side];
    listEl.innerHTML = rows.map((r, i) => rowHtml(r, i, total)).join("");
    [...listEl.children].forEach((li) => {
      const sym = li.dataset.sym;
      if (sym && !seen.has(sym)) li.classList.add("enter");
      if (li.dataset.sym === state.selected) li.classList.add("sel");
    });
    state.seen[side] = new Set(rows.map((r) => r.symbol));
  }

  function renderBoards() {
    const s = state.snap;
    if (!s) return;
    const bull = s.stats.bull || 0;
    const bear = s.stats.bear || 0;
    $("bullCount").textContent = `${int(bull)} bullish`;
    $("bearCount").textContent = `${int(bear)} bearish`;
    renderBoard("BULL", $("bullList"), bull);
    renderBoard("BEAR", $("bearList"), bear);
  }

  function bindBoards() {
    ["bullList", "bearList"].forEach((id) => {
      $(id).addEventListener("click", (e) => {
        const li = e.target.closest("li[data-sym]");
        if (li) selectSymbol(li.dataset.sym);
      });
    });
  }

  /* ============================================================
     setup — chart, levels, contract
     ============================================================ */
  class Chart {
    constructor(cv, tip) {
      this.cv = cv;
      this.ctx = cv.getContext("2d");
      this.tip = tip;
      this.data = null;
      this.w = 1; this.h = 1;
      this.hover = -1;
      new ResizeObserver(() => { this.resize(); this.draw(); })
        .observe(cv.parentElement || cv);
      cv.addEventListener("mousemove", (e) => this.move(e));
      cv.addEventListener("mouseleave", () => {
        this.hover = -1;
        if (this.tip) this.tip.hidden = true;
        this.draw();
      });
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = this.cv.getBoundingClientRect();
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.cv.width = Math.round(this.w * dpr);
      this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setData(d) {
      this.data = d;
      this.resize();
      this.draw();
    }

    geom() {
      const padL = 6, padR = 48, padT = 8, padB = 16;
      const w = this.w - padL - padR;
      const h = this.h - padT - padB;
      const n = this.data.candles.length;
      return { padL, padR, padT, padB, w, h, n, step: w / Math.max(1, n) };
    }

    draw() {
      const c = this.ctx;
      if (!c || !this.data || !this.data.candles.length) return;
      const { candles, zones = [], vwap = [] } = this.data;
      const g = this.geom();
      c.clearRect(0, 0, this.w, this.h);

      let lo = Math.min(...candles.map((k) => k[3]));
      let hi = Math.max(...candles.map((k) => k[2]));
      zones.forEach((z) => { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); });
      const span = (hi - lo) || 1;
      lo -= span * .07; hi += span * .07;
      const x = (i) => g.padL + (i + .5) * g.step;
      const y = (v) => g.padT + (hi - v) / (hi - lo) * g.h;
      this.xy = { x, y, lo, hi, g };

      /* horizontal grid + price labels */
      c.font = MONO;
      c.textAlign = "left";
      for (let i = 0; i <= 3; i++) {
        const v = lo + (hi - lo) * (i / 3);
        const yy = Math.round(y(v)) + .5;
        c.strokeStyle = "rgba(255,255,255,.045)";
        c.beginPath(); c.moveTo(g.padL, yy); c.lineTo(g.padL + g.w, yy); c.stroke();
        c.fillStyle = "#4c5663";
        c.fillText(num(v, 1), g.padL + g.w + 6, yy + 3);
      }

      /* order-block zones */
      zones.forEach((z) => {
        const x0 = x(z.i0);
        const x1 = x(Math.min(g.n - 1, z.i1 ?? g.n - 1)) + g.step / 2;
        const y0 = y(z.top), y1 = y(z.bottom);
        const bull = z.dir > 0;
        const col = bull ? "108,245,194" : "255,122,152";
        c.fillStyle = `rgba(${col},${z.active ? .13 : .05})`;
        c.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(1, y1 - y0));
        c.strokeStyle = `rgba(${col},${z.active ? .5 : .2})`;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x0, y0 + .5); c.lineTo(x1, y0 + .5);
        c.moveTo(x0, y1 + .5); c.lineTo(x1, y1 + .5);
        c.stroke();
        if (z.active) {
          c.fillStyle = `rgba(${col},.9)`;
          c.font = MONO;
          c.fillText(z.grade, Math.min(x0 + 3, g.padL + g.w - 40), y0 - 3);
        }
      });

      /* vwap */
      c.strokeStyle = "rgba(103,216,255,.6)";
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath();
      let started = false;
      vwap.forEach((v, i) => {
        if (v == null) return;
        const px = x(i), py = y(v);
        started ? c.lineTo(px, py) : c.moveTo(px, py);
        started = true;
      });
      c.stroke();
      c.setLineDash([]);

      /* candles */
      const bw = Math.max(1.6, Math.min(7, g.step * .62));
      candles.forEach((k, i) => {
        const up = k[4] >= k[1];
        const col = up ? MINT : ROSE;
        const cx = x(i);
        c.strokeStyle = up ? "rgba(108,245,194,.75)" : "rgba(255,122,152,.75)";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(cx + .5, y(k[2]));
        c.lineTo(cx + .5, y(k[3]));
        c.stroke();
        c.fillStyle = up ? "rgba(108,245,194,.85)" : "rgba(255,122,152,.85)";
        const yo = y(k[1]), yc = y(k[4]);
        c.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      });

      /* last price marker */
      const last = candles[candles.length - 1][4];
      const ly = Math.round(y(last)) + .5;
      c.strokeStyle = "rgba(255,255,255,.22)";
      c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(g.padL, ly); c.lineTo(g.padL + g.w, ly); c.stroke();
      c.setLineDash([]);
      c.fillStyle = "#0b1017";
      c.fillRect(g.padL + g.w + 2, ly - 7, 44, 13);
      c.strokeStyle = "rgba(255,255,255,.3)";
      c.strokeRect(g.padL + g.w + 2.5, ly - 6.5, 43, 12);
      c.fillStyle = "#e9f2fb";
      c.font = MONO;
      c.fillText(num(last, 1), g.padL + g.w + 6, ly + 3.5);

      /* time labels */
      c.fillStyle = "#4c5663";
      c.textAlign = "center";
      [0, Math.floor(g.n / 2), g.n - 1].forEach((i) => {
        if (!candles[i]) return;
        const d = new Date(candles[i][0]);
        const t = d.toLocaleTimeString("en-GB",
          { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
        c.fillText(t, Math.min(g.padL + g.w - 12, Math.max(g.padL + 12, x(i))),
          g.padT + g.h + 12);
      });
      c.textAlign = "left";

      /* crosshair */
      if (this.hover >= 0 && candles[this.hover]) {
        const k = candles[this.hover];
        const cx = Math.round(x(this.hover)) + .5;
        c.strokeStyle = "rgba(255,255,255,.2)";
        c.setLineDash([2, 2]);
        c.beginPath(); c.moveTo(cx, g.padT); c.lineTo(cx, g.padT + g.h); c.stroke();
        c.setLineDash([]);
        c.fillStyle = MINT;
        c.beginPath(); c.arc(cx, y(k[4]), 2.5, 0, Math.PI * 2); c.fill();
      }
    }

    move(e) {
      if (!this.data || !this.xy) return;
      const r = this.cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const { g } = this.xy;
      const i = Math.round((mx - g.padL) / g.step - .5);
      if (i < 0 || i >= this.data.candles.length) {
        this.hover = -1;
        if (this.tip) this.tip.hidden = true;
        this.draw();
        return;
      }
      this.hover = i;
      this.draw();
      const k = this.data.candles[i];
      const d = new Date(k[0]);
      const t = d.toLocaleTimeString("en-GB",
        { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      if (this.tip) {
        this.tip.hidden = false;
        this.tip.style.left = `${Math.min(this.w - 60, Math.max(60, this.xy.x(i)))}px`;
        this.tip.style.top = `${this.xy.y(k[2])}px`;
        this.tip.innerHTML =
          `<em>${t}</em>O ${num(k[1], 1)} H ${num(k[2], 1)} ` +
          `L ${num(k[3], 1)} C ${num(k[4], 1)}`;
      }
    }
  }

  function renderStats(row) {
    const box = $("sStats");
    if (!box) return;
    const tiles = [
      ["strength", `${(row?.comb || 0).toFixed(1)} / 100`],
      ["day move", pctTxt(row?.pct)],
      ["range pos", `${Math.round((row?.pos || 0) * 100)}%`],
      ["oi flow", row?.oi || "—"],
    ];
    box.innerHTML = tiles.map(([k, v]) =>
      `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  }

  function renderLevels(payload, row) {
    const box = $("sLevels");
    if (!box) return;
    const zones = payload?.zones || [];
    const active = zones.filter((z) => z.active);
    const zone = (active.length ? active : zones).slice(-1)[0] || null;
    const vwap = (payload?.vwap || []).filter((v) => v != null).slice(-1)[0];
    const ltp = payload?.last ?? row?.ltp ?? 0;
    const dirTxt = zone ? (zone.dir > 0 ? "bullish" : "bearish") : "—";

    const rows = [
      ["order block", zone
        ? `${num(zone.bottom)} – ${num(zone.top)}<em>${dirTxt} · ${zone.grade}</em>`
        : `none active<em>waiting for displacement</em>`, "zone"],
      ["invalidation", zone ? num(zone.dir > 0 ? zone.bottom : zone.top) : "—", "inv"],
      ["vwap", vwap ? num(vwap) : "—", ""],
      ["distance to zone", zone
        ? `${pctTxt(((ltp - (zone.top + zone.bottom) / 2) / ltp) * 100)}`
        : "—", ""],
    ];
    box.innerHTML = rows.map(([k, v, cls]) =>
      `<div class="lv ${cls}"><span>${k}</span><b>${v}</b></div>`).join("");
  }

  function renderContract(opt) {
    const box = $("sContract");
    if (!box) return;
    const trk = opt?.track;
    if (!trk) {
      box.innerHTML = `<div class="c-l"><span>tracked contract</span>` +
        `<b>no listed option</b></div>` +
        `<div class="c-r"><b style="color:#5c6674">—</b><em>chain</em></div>`;
      return;
    }
    const color = GRADE[trk.grade] || "#b9c6dd";
    box.innerHTML =
      `<div class="c-l"><span>tracked contract · ${esc(opt.expiry || "exp")}</span>` +
      `<b>${num(trk.strike, 0)} ${esc(trk.side)} · ${esc(trk.grade)}</b></div>` +
      `<div class="c-r"><b style="color:${color}">₹${num(trk.ltp)}</b>` +
      `<em>${esc(opt.flow || "—")}</em></div>`;
  }

  async function selectSymbol(symbol) {
    if (!symbol) return;
    state.selected = symbol;
    const row = (state.snap?.rows || []).find((r) => r.symbol === symbol);
    [...document.querySelectorAll(".row")].forEach((li) =>
      li.classList.toggle("sel", li.dataset.sym === symbol));

    $("setupEmpty").hidden = true;
    $("setupBody").hidden = false;
    $("setupClose").hidden = false;
    $("sSym").textContent = symbol;
    $("sMeta").textContent = [row?.sector || "F&O", row?.dir || ""].filter(Boolean).join(" · ");
    $("sSym").title = symbol;
    $("sLtp").textContent = num(row?.ltp);
    const pc = $("sPct");
    pc.textContent = pctTxt(row?.pct);
    pc.className = Number(row?.pct) >= 0 ? "up" : "down";
    renderStats(row);

    const seq = ++state.seq;
    try {
      const r = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}`);
      const data = await r.json();
      if (seq !== state.seq) return;
      state.chart = data;
      chart?.setData(data);
      renderLevels(data, row);
      $("sMeta").textContent = [row?.sector || "F&O", row?.dir || "",
        `${data.label} · 5m`].filter(Boolean).join(" · ");
    } catch (_) { /* keep previous chart */ }

    try {
      const r = await fetch(`/api/option?symbol=${encodeURIComponent(symbol)}`);
      const opt = await r.json();
      if (seq !== state.seq) return;
      renderContract(opt);
    } catch (_) { /* no chain */ }
  }

  let chart = null;

  /* ============================================================
     status · scope · picture meta
     ============================================================ */
  function renderStatus(s) {
    const ph = s.phase || {};
    $("phaseLbl").textContent = (ph.label || "scanning").toUpperCase();
    $("progFill").style.width = ph.total
      ? `${Math.min(100, (ph.done / ph.total) * 100)}%` : "0%";
    $("cycleLbl").textContent = ph.total
      ? `SCAN ${int(ph.done)}/${int(ph.total)}` : "SCAN —";
    $("feedLbl").textContent = s.demo ? "FEED · SAMPLE" : "FEED · LIVE";
    const age = s.last_tick ? Math.max(0, Math.round(Date.now() / 1000 - s.last_tick)) : null;
    $("tickLbl").textContent = age == null ? "TICK · —" : `TICK · ${age}s AGO`;
    $("errLbl").textContent = s.error ? `! ${s.error}` : "";
    $("statusDot").style.background = s.demo ? "#ffbe55" : MINT;
    $("statusDot").style.boxShadow = `0 0 8px ${s.demo ? "#ffbe55" : MINT}`;

    const chip = $("feedState");
    chip.classList.toggle("live", !s.demo);
    chip.querySelector("span").textContent = s.demo ? "SAMPLE" : "LIVE";

    const btn = $("brokerBtn");
    if (!s.demo) {
      btn.classList.add("linked");
      btn.textContent = "Broker linked";
      btn.setAttribute("href", "#");
    } else {
      btn.classList.remove("linked");
      btn.textContent = "Link broker";
      btn.setAttribute("href", "/api/auth/login");
    }
  }

  function renderScope(indices) {
    const bar = $("scopeBar");
    if (!bar || !indices || !indices.length) return;
    const active = state.snap?.scope || "";
    if (bar.children.length !== indices.length + 1) {
      bar.innerHTML = `<button class="chip" data-name="">Universe</button>` +
        indices.map((ix) =>
          `<button class="chip" data-name="${esc(ix.name)}">` +
          `<span class="nm">${esc(shortIdx(ix.name))}</span> <i>—</i></button>`).join("");
    }
    [...bar.children].forEach((chip, i) => {
      if (i === 0) {
        chip.classList.toggle("on", !active);
        return;
      }
      const ix = indices[i - 1];
      if (!ix) return;
      chip.classList.toggle("on", active === ix.name);
      const p = chip.querySelector("i");
      p.textContent = pctTxt(ix.pct);
      p.className = Number(ix.pct) >= 0 ? "up" : "down";
    });
  }

  function bindScope() {
    $("scopeBar").addEventListener("click", async (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const name = chip.dataset.name || "";
      try {
        await fetch(`/api/scope?name=${encodeURIComponent(name)}`);
      } catch (_) { /* snapshot still carries scope */ }
      poll();
    });
  }

  function renderPicture(p) {
    if (!p) return;
    $("cntBull").textContent = int(p.stats.bull);
    $("cntBear").textContent = int(p.stats.bear);
    const total = (p.stats.bull || 0) + (p.stats.bear || 0);
    const share = total ? ((p.stats.bull || 0) / total) * 100 : 50;
    $("breadthFill").style.width = `${share}%`;
    $("breadthTxt").textContent = `${Math.round(share)}% of the board leans bullish`;
    const secs = p.sectors || [];
    const lead = secs.slice().sort((a, b) => b.avg - a.avg)[0];
    const lag = secs.slice().sort((a, b) => a.avg - b.avg)[0];
    $("leadSec").textContent = lead ? `${shortIdx(lead.name)} ${pctTxt(lead.avg)}` : "—";
    $("lagSec").textContent = lag ? `${shortIdx(lag.name)} ${pctTxt(lag.avg)}` : "—";
    $("picMeta").textContent =
      `${int(p.stats.universe)} F&O · ${int(p.stats.scored)} scored · ${p.ts || ""}`;
    $("picTime").textContent = p.ts || "—";
    dots.data = p.dots || [];
    dotsResize();
    dotsDraw();
  }

  /* ============================================================
     polling
     ============================================================ */
  async function poll() {
    try {
      const r = await fetch("/api/snapshot?mode=rally");
      if (!r.ok) throw new Error(`snapshot ${r.status}`);
      const s = await r.json();
      state.snap = s;
      state.scope = s.scope || "";
      renderStatus(s);
      renderTape(s.indices);
      renderScope(s.indices);
      renderBoards();
      if (!state.booted && s.rows.length) {
        state.booted = true;
        selectSymbol(state.selected || s.rows[0].symbol);
      } else if (!state.selected) {
        $("setupEmpty").hidden = false;
        $("setupBody").hidden = true;
      }
    } catch (e) {
      $("errLbl").textContent = `! ${e.message}`;
    }
  }

  async function pollPulse() {
    try {
      const r = await fetch("/api/pulse");
      const p = await r.json();
      state.pulse = p;
      renderPicture(p);
    } catch (_) { /* keep last picture */ }
  }

  /* ============================================================
     boot
     ============================================================ */
  function init() {
    dots.ctx = $("dotfield").getContext("2d");
    dotsResize();
    window.addEventListener("resize", dotsResize);
    bindDotHover();
    bindBoards();
    bindScope();
    chart = new Chart($("sChart"), $("sTip"));
    $("setupClose").addEventListener("click", () => {
      state.selected = null;
      [...document.querySelectorAll(".row.sel")].forEach((li) => li.classList.remove("sel"));
      $("setupBody").hidden = true;
      $("setupEmpty").hidden = false;
      $("setupClose").hidden = true;
    });

    tickClock();
    setInterval(tickClock, 1000);
    poll();
    pollPulse();
    setInterval(poll, 4000);
    setInterval(pollPulse, 15000);
    setInterval(() => { if (state.selected) selectSymbol(state.selected); }, 25000);
  }

  init();
})();
