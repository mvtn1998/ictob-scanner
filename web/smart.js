/* OB SENTINEL — Smart Money stage
   Design ported from the market-lab dashboard, fed by this app's own tape:
   /api/tape (every stock's move through the session + ranks), /api/chart
   (5-minute candles, order blocks, VWAP) for the big tiles and the pop-up. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pc = (x, d = 2) => x == null ? "–" : (x > 0 ? "+" : "") + Number(x).toFixed(d) + "%";
  const money = (v) => Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const C = { up: "#2f9e5f", down: "#d6455d", upL: "#9fd8b5", downL: "#f0a9b5", ink: "#141a26", blue: "#3b5bdb", grid: "#dfe3ea" };

  let D = null, BY = {}, LAST_FULL = 0, H = null, G = null;
  const nowMin = () => Math.max(1, Math.min(375, Math.floor((Date.now() / 1000 + 19800) % 86400 / 60) - 555));

  /* ============================================================ sparklines */
  function spark(cv, path, up) {
    const dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, Hh = cv.clientHeight;
    if (!W || !Hh) return;
    cv.width = W * dpr; cv.height = Hh * dpr;
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, Hh);
    if (!path || path.length < 2) return;
    const vs = path.map((p) => p[1]);
    const lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * .15 || .05;
    const X = (i) => i / (path.length - 1) * (W - 4) + 2;
    const Y = (v) => Hh - 4 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)) * (Hh - 8);
    const col = up ? C.up : C.down;
    x.beginPath();
    path.forEach((p, i) => i ? x.lineTo(X(i), Y(p[1])) : x.moveTo(X(i), Y(p[1])));
    x.strokeStyle = col; x.lineWidth = 1.6; x.stroke();
    x.lineTo(X(path.length - 1), Hh); x.lineTo(X(0), Hh); x.closePath();
    x.fillStyle = up ? "rgba(47,158,95,.10)" : "rgba(214,69,93,.10)"; x.fill();
  }

  /* ============================================================ index cards */
  let CARD_KEYS = [];
  function cards() {
    const idx = D.indices || {};
    if (!CARD_KEYS.length) CARD_KEYS = Object.keys(idx).slice(0, 4);
    $("cards").innerHTML = CARD_KEYS.map((k) => {
      const i = idx[k];
      if (!i) return `<div class="icard"></div>`;
      return `<div class="icard ${i.pct < 0 ? "neg" : ""}" data-k="i:${esc(k)}" data-v="${i.ltp}" onclick="void 0">
        <canvas id="ic_${esc(k).replace(/\W/g, "_")}"></canvas>
        <div class="lab"><b>${esc(k.replace(/^NIFTY ?/, "")) || esc(k)}</b>
          <span class="${i.pct >= 0 ? "up" : "down"}">${pc(i.pct)}</span>
          <br><span class="tag ${i.pct >= 0 ? "bull" : "bear"}">${i.pct >= 0 ? "ABOVE" : "BELOW"} ZERO</span></div>
        <div class="px">${money(i.ltp)} ◂</div>
        <div class="foot"><span><span class="muted">scan</span> <b>${esc(D.market || "—")}</b></span>
          <span class="exp">${esc((D.time || "").slice(11, 16))} IST</span></div>
      </div>`;
    }).join("");
    CARD_KEYS.forEach((k) => {
      const i = D.indices[k]; if (!i) return;
      spark($("ic_" + k.replace(/\W/g, "_")), i.path, i.pct >= 0);
    });
  }

  /* ============================================================ geometry */
  const yScale = (v) => Math.sign(v) * Math.log1p(Math.abs(v) / .12);
  function geometry() {
    const st = $("stage"), W = st.clientWidth, Hs = st.clientHeight;
    const tilesW = Math.round(W * .38), wfW = Math.round(W * .055), gap = Math.round(W * .075);
    const chartR = W - tilesW - gap - wfW, beadsH = 84;
    const CH = 118, L = CH + 34, T = beadsH + 18, B = Hs - 20;
    const vals = D.stocks.map((s) => Number(s.pct) || 0).sort((a, b) => a - b);
    const q = (f) => vals[Math.floor(f * (vals.length - 1))];
    const hiV = Math.max(.3, Math.min(8, q(.985))), loV = Math.min(-.3, Math.max(-8, q(.015)));
    const tTop = yScale(hiV), tBot = yScale(loV);
    const Y = (v) => T + (tTop - yScale(Math.max(loV, Math.min(hiV, v)))) / (tTop - tBot) * (B - T);
    const nm = nowMin(), X = (m) => L + m / nm * (chartR - L);
    return { W, Hs, L, CH, T, B, chartR, wfL: chartR, wfR: chartR + wfW, tilesL: W - tilesW, tilesW, beadsH, Y, X, hiV, loV, nm };
  }

  /* ============================================================ tiles */
  const COLS = [[13, 20], [8, 12], [4, 7], [1, 3]];
  function tileHTML(s, big) {
    if (!s) return `<div class="tile" style="visibility:hidden"></div>`;
    const side = s.side, opt = s.opt, st = Math.round(s.comb || 0);
    const tag = opt && opt.grade
      ? `<span class="tag ${side}">${esc(opt.grade)}</span>`
      : `<span class="tag ${side}">${esc(s.oi || s.dir || "—")}</span>`;
    const det = big ? `<div class="det">
        ST <b class="${side === "bull" ? "up" : "down"}">${esc(s.dir)} ${side === "bull" ? "↑" : "↓"}</b> ${st}<br>
        <span class="obline" data-sym="${esc(s.sym)}">OB —</span><br>
        LIQ <span class="${s.oi === "LONG BUILD" ? "up" : s.oi ? "down" : "muted"}">${esc(s.oi || "not read")}</span></div>` : "";
    return `<div class="tile ${side} ${big ? "big" : ""}" data-s="${esc(s.sym)}" data-k="t:${esc(s.sym)}" data-v="${s.ltp}">
      <canvas></canvas>
      <div class="lab">${big ? `<span class="logo" style="color:${side === "bull" ? "var(--up)" : "var(--down)"}">${esc(String(s.sym)[0])}</span>` : ""}<b style="display:inline">${esc(s.sym)}</b>
        <br><span class="${s.pct >= 0 ? "up" : "down"}">${pc(s.pct)}</span>${big ? "" : `<br>${tag}`}</div>
      <span class="rk ${side === "bull" ? "up" : "down"}">${String(s.rank).padStart(2, "0")}</span>
      ${big || s.rank <= 7 ? `<span class="px" ${big ? 'style="bottom:52%"' : ""}>${money(s.ltp)}</span>` : ""}${det}
    </div>`;
  }

  function tiles() {
    const g = G, half = (g.Hs - 6) / 2;
    $("tiles").style.width = g.tilesW + "px";
    const widths = [1, 1.05, 1.25, 1.7], tot = widths.reduce((a, b) => a + b, 0);
    for (const [side, el, list] of [["bull", $("hbull"), D.bull], ["bear", $("hbear"), D.bear]]) {
      el.style.top = (side === "bull" ? 0 : half + 6) + "px";
      el.style.height = half + "px";
      el.innerHTML = COLS.map(([a, b], i) => {
        const ranks = [];
        for (let r = a; r <= b; r++) ranks.push(r);
        if (side === "bear") ranks.reverse();
        return `<div class="col" style="width:${widths[i] / tot * 100}%">${ranks.map((r) => tileHTML(BY[list[r - 1]], i === 3)).join("")}</div>`;
      }).join("");
    }
    document.querySelectorAll(".tile[data-s]").forEach((t) => {
      const s = BY[t.dataset.s];
      spark(t.querySelector("canvas"), s && s.path, s && s.pct >= 0);
      t.onmouseenter = (e) => setH({ type: "stock", key: t.dataset.s }, e);
      t.onmousemove = (e) => tip(BY[t.dataset.s], e);
      t.onmouseleave = () => setH(null);
      t.onclick = () => openChart(t.dataset.s);
    });
    bigDetails();
  }

  /* OB distance for the six detail tiles, from the app's own chart endpoint */
  const OB_CACHE = {};
  let OB_Q = Promise.resolve();
  function bigDetails() {
    document.querySelectorAll(".tile.big[data-s]").forEach((t) => {
      const sym = t.dataset.s;
      const el = t.querySelector(".obline");
      const row = BY[sym];
      if (!el || !row) return;
      const cached = OB_CACHE[sym];
      if (cached && Date.now() - cached.t < 90000) { paintOb(el, cached.v); return; }
      el.textContent = "OB …";
      OB_Q = OB_Q.then(async () => {
        try {
          const d = await (await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}`)).json();
          const zones = d.zones || [];
          const act = zones.filter((z) => z.active);
          const z = (act.length ? act : zones).slice(-1)[0] || null;
          // distances are measured inside the chart's own session, so a sample
          // session (whose price base differs from the scanned quote) still
          // reports honest zone distances instead of nonsense percentages
          const last = d.last || row.ltp;
          const vwap = (d.vwap || []).filter((x) => x != null).slice(-1)[0];
          const v = z ? {
            gap: ((last - (z.top + z.bottom) / 2) / last) * 100,
            grade: z.grade, dir: z.dir,
            vwapGap: vwap ? (last / vwap - 1) * 100 : null,
            vol: z.vol || 0,
          } : null;
          OB_CACHE[sym] = { t: Date.now(), v };
          const tile = document.querySelector(`.tile.big[data-s="${CSS.escape(sym)}"] .obline`);
          if (tile) paintOb(tile, v);
        } catch (_) { el.textContent = "OB —"; }
      });
    });
  }
  function paintOb(el, v) {
    if (!v) { el.textContent = "OB none active"; return; }
    const side = v.gap < 0 ? "below" : "above";
    el.innerHTML = `OB <b>${Math.abs(v.gap).toFixed(2)}% ${side}</b> <span class="muted">· ${esc(v.grade)}${v.vol ? ` · ${v.vol.toFixed(1)}x Vol` : ""}</span>` +
      (v.vwapGap != null ? `<br>VWAP ${pc(v.vwapGap)}` : "");
  }

  /* ============================================================ sector chips */
  function chips() {
    const g = G;
    const box = $("chips");
    box.style.left = "0px"; box.style.top = g.T + "px";
    box.style.height = (g.B - g.T) + "px"; box.style.width = g.CH + "px";
    const secs = D.sectors || [], room = Math.max(4, Math.floor((g.B - g.T + 2) / 21));
    box.innerHTML = secs.slice(0, room).map((s) => `<div class="chip" data-sec="${esc(s.name)}">
      <div class="h"><span title="${esc(s.name)}">${esc(s.name.replace(/^NIFTY ?/i, ""))}</span><span class="${s.pct >= 0 ? "up" : "down"}">${pc(s.pct)}</span></div>
      <div class="seg">${"<i></i>".repeat(Math.min(s.up, 24))}${'<i class="d"></i>'.repeat(Math.min(s.down, 24))}</div>
    </div>`).join("");
    box.querySelectorAll(".chip").forEach((c) => {
      c.onmouseenter = () => setH({ type: "sector", key: c.dataset.sec });
      c.onmouseleave = () => setH(null);
    });
  }

  /* ============================================================ tween */
  let PREV = {}, ANIM = { t0: 0, from: {} };
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const animK = () => Math.min(1, (performance.now() - ANIM.t0) / 650);
  function FO(s) { const f = ANIM.from[s.sym]; if (!f) return Number(s.pct) || 0; return f[0] + ((Number(s.pct) || 0) - f[0]) * ease(animK()); }
  function CB(s) { const f = ANIM.from[s.sym]; if (!f) return Number(s.comb) || 0; return f[1] + ((Number(s.comb) || 0) - f[1]) * ease(animK()); }
  function animate() {
    ANIM.t0 = performance.now(); ANIM.from = PREV;
    const step = () => { draw(); beads(); if (animK() < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    PREV = Object.fromEntries(D.stocks.map((x) => [x.sym, [Number(x.pct) || 0, Number(x.comb) || 0]]));
  }

  /* ============================================================ big canvas */
  const matches = (s) => !H || (H.type === "stock" ? s.sym === H.key : s.sector === H.key);
  let PTS = {}, ROWS = [], CONN = [];
  function smoothPath(x, pts) {
    if (pts.length < 2) return;
    x.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      x.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    x.lineTo(pts.at(-1)[0], pts.at(-1)[1]);
  }

  function draw() {
    if (!D || !G) return;
    const g = G, cv = $("bg"), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.Hs * dpr);
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, g.W, g.Hs);
    const y0 = g.Y(0);

    x.font = '10px "JetBrains Mono", monospace';
    x.fillStyle = "#6b7385"; x.strokeStyle = C.grid; x.lineWidth = 1;
    [5, 3, 2, 1, .5, .2, 0, -.2, -.5, -.75, -1, -1.5, -2, -3, -5]
      .filter((v) => v <= g.hiV + 1e-9 && v >= g.loV - 1e-9).forEach((v) => {
        const y = g.Y(v);
        x.beginPath(); x.moveTo(g.L, y); x.lineTo(g.chartR, y); x.stroke();
        x.fillText((v > 0 ? "+" : "") + v, g.CH + 6, y + 3);
      });
    for (let m = 45; m < g.nm; m += 60) {
      const xx = g.X(m);
      x.beginPath(); x.moveTo(xx, g.T); x.lineTo(xx, g.B); x.stroke();
    }
    [["09:15", 0], ["10:00", 45], ["11:00", 105], ["12:00", 165], ["13:00", 225], ["14:00", 285], ["15:00", 345]]
      .forEach(([t, m]) => { if (m < g.nm - 20) x.fillText(t, g.X(m) - 14, g.Hs - 4); });
    const tnow = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    x.fillStyle = C.ink; x.fillText(tnow, g.chartR - 18, g.Hs - 4);

    x.fillStyle = C.up; x.fillRect(g.L - 6, g.T, 2, y0 - g.T);
    x.fillStyle = C.down; x.fillRect(g.L - 6, y0, 2, g.B - y0);

    /* stock lines */
    PTS = {};
    const ordered = D.stocks.slice().sort((a, b) => (matches(a) ? 1 : 0) - (matches(b) ? 1 : 0));
    for (const s of ordered) {
      const p = s.path || [];
      if (!p.length) continue;
      const pts = p.map((q) => [g.X(q[0]), g.Y(q[1])]);
      if (pts.length) pts.push([g.X(g.nm), g.Y(FO(s))]);
      PTS[s.sym] = pts;
      const strong = s.rank && s.rank <= 20, up = FO(s) >= 0, m = matches(s);
      if (H && !m) x.strokeStyle = up ? "rgba(47,158,95,.07)" : "rgba(214,69,93,.07)";
      else if (H && H.type === "stock") x.strokeStyle = C.ink;
      else if (H) x.strokeStyle = up ? C.up : C.down;
      else x.strokeStyle = up ? (strong ? "rgba(47,158,95,.95)" : "rgba(47,158,95,.34)")
        : (strong ? "rgba(214,69,93,.95)" : "rgba(214,69,93,.34)");
      x.lineWidth = H && H.type === "stock" ? 2.4 : (H ? 1.6 : strong ? 1.5 : 1);
      if (pts.length >= 2) { x.beginPath(); smoothPath(x, pts); x.stroke(); }
      // a dot at the current minute: the field always shows where every stock is,
      // even before the tape has collected enough samples to draw a line
      const tipPt = pts.at(-1);
      x.fillStyle = x.strokeStyle;
      x.beginPath(); x.arc(tipPt[0], tipPt[1], strong ? 2.4 : 1.5, 0, 7); x.fill();
    }

    /* indices dashed */
    x.setLineDash([5, 4]); x.lineWidth = 1.5;
    Object.entries(D.indices || {}).slice(0, 4).forEach(([k, i]) => {
      if (!i.path || i.path.length < 2) return;
      const pts = i.path.map((q) => [g.X(q[0]), g.Y(q[1])]);
      x.strokeStyle = H ? "rgba(59,91,219,.25)" : C.blue;
      x.beginPath(); smoothPath(x, pts); x.stroke();
      const lp = pts.at(-1);
      x.setLineDash([]); x.font = '700 9.5px "JetBrains Mono", monospace';
      const label = k.replace(/^NIFTY ?/, "") || k;
      const tw = x.measureText(label).width;
      x.fillStyle = "#fff"; x.fillRect(lp[0] - tw - 10, lp[1] - 7, tw + 6, 13);
      x.fillStyle = C.blue; x.fillText(label, lp[0] - tw - 7, lp[1] + 3);
      x.setLineDash([5, 4]); x.font = '10px "JetBrains Mono", monospace';
    });
    x.setLineDash([]);

    /* waterfall: every stock, strongest at the top */
    const bull = D.bull.map((s) => BY[s]).filter(Boolean);
    const bear = D.bear.map((s) => BY[s]).filter(Boolean).reverse();
    const rows = [], wfW = g.wfR - g.wfL - 4;
    const mxd = Math.max(1, ...D.stocks.map((s) => Math.abs(CB(s))));
    bull.forEach((s, i) => rows.push({ s, y: g.T + (i + .5) * (y0 - g.T) / bull.length, h: (y0 - g.T) / bull.length }));
    bear.forEach((s, i) => rows.push({ s, y: y0 + (i + .5) * (g.B - y0) / bear.length, h: (g.B - y0) / bear.length }));
    ROWS = rows;
    for (const r of rows) {
      const s = r.s, up = s.side === "bull", strong = s.rank <= 20, m = matches(s);
      const len = Math.max(3, Math.abs(CB(s)) / mxd * wfW);
      x.fillStyle = H && H.type === "stock" && m ? C.ink
        : H && !m ? (up ? "rgba(47,158,95,.12)" : "rgba(214,69,93,.12)")
          : up ? (strong ? C.up : C.upL) : (strong ? C.down : C.downL);
      x.fillRect(g.wfL + 2, r.y - Math.max(.6, r.h * .35), len, Math.max(1.2, r.h * .7));
    }

    const brk = (a, b) => {
      const yA = a.y - a.h / 2 - 2, yB = b.y + b.h / 2 + 2;
      x.strokeStyle = C.ink; x.lineWidth = 1.5;
      [[g.wfL, 1], [g.wfR, -1]].forEach(([xx, d]) => {
        x.beginPath(); x.moveTo(xx + d * 6, yA); x.lineTo(xx, yA); x.lineTo(xx, yB); x.lineTo(xx + d * 6, yB); x.stroke();
      });
    };
    if (bull.length) brk(rows[0], rows[Math.min(19, bull.length - 1)]);
    if (bear.length) brk(rows[rows.length - Math.min(20, bear.length)], rows[rows.length - 1]);
    x.font = '9.5px "JetBrains Mono", monospace'; x.fillStyle = "#6b7385";
    x.fillText(String(bull.length), g.wfL - 24, y0 - 3);
    x.fillText(String(bear.length), g.wfR + 3, y0 - 3);

    /* connectors: the 20 strongest and 20 weakest to their tiles */
    CONN = [];
    const st = $("stage").getBoundingClientRect();
    for (const r of rows) {
      if (r.s.rank > 20) continue;
      const t = document.querySelector(`.tile[data-s="${CSS.escape(r.s.sym)}"]`);
      if (!t) continue;
      const b = t.getBoundingClientRect();
      const tx = g.tilesL - 2, ty = b.top - st.top + b.height / 2;
      const m = matches(r.s), sel = H && H.type === "stock" && m;
      if (H && !m) continue;
      x.strokeStyle = sel ? C.ink : r.s.side === "bull" ? C.up : C.down;
      x.lineWidth = sel ? 2 : 1;
      x.setLineDash(sel ? [] : [4, 3]);
      const sx = g.wfR, cx = (sx + tx) / 2;
      x.beginPath(); x.moveTo(sx, r.y); x.bezierCurveTo(cx, r.y, cx, ty, tx, ty); x.stroke();
      CONN.push({ sym: r.s.sym, side: r.s.side, rank: r.s.rank, sx, sy: r.y, cx, tx, ty });
    }
    x.setLineDash([]);

    /* zero line across, then an S-curve into the gap between the two tile halves */
    const divY = g.Hs / 2;
    x.strokeStyle = "#2c3e8f"; x.lineWidth = 1.6;
    x.beginPath(); x.moveTo(g.L, y0); x.lineTo(g.wfR, y0);
    const cx = (g.wfR + g.tilesL) / 2;
    x.bezierCurveTo(cx, y0, cx, divY, g.tilesL, divY); x.lineTo(g.W, divY); x.stroke();
    [[g.X(Math.min(g.nm * .55, 200)), y0], [g.wfL, y0], [g.wfR, y0], [g.tilesL, divY]].forEach(([a, b]) => {
      x.fillStyle = "#2c3e8f"; x.beginPath(); x.arc(a, b, 3, 0, 7); x.fill();
    });

    if (H && H.type === "stock") {
      const r = rows.find((q) => q.s.sym === H.key);
      if (r) { x.fillStyle = C.ink; x.fillRect(g.wfL + 2, r.y - 1.5, Math.max(4, Math.abs(CB(r.s)) / mxd * wfW), 3); }
    }
  }

  /* ============================================================ beads */
  let BEADS = [];
  function beads() {
    const g = G, cv = $("beads"), W = g.wfR, Hb = g.beadsH, dpr = Math.min(2, devicePixelRatio || 1);
    cv.style.width = W + "px";
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hb * dpr);
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, Hb);
    const L = 20, R = W - 24, ax = Hb - 26, lim = 4;
    const X = (v) => { const c = Math.max(-lim, Math.min(lim, v)); return L + (c + lim) / (2 * lim) * (R - L); };
    x.strokeStyle = "#c5ccd6"; x.lineWidth = 1;
    x.beginPath(); x.moveTo(L, ax); x.lineTo(R, ax); x.stroke();
    x.beginPath(); x.moveTo(X(0), 4); x.lineTo(X(0), Hb); x.stroke();
    x.fillStyle = "#6b7385"; x.font = '9px "JetBrains Mono", monospace';
    x.fillText("-4%", 0, ax + 3); x.fillText("+4%", R + 3, ax + 3);
    for (let v = -3; v <= 3; v++) if (v) {
      x.beginPath(); x.moveTo(X(v), ax - 3); x.lineTo(X(v), ax + 3); x.stroke();
    }

    BEADS = [];
    const stack = {};
    const list = D.stocks.slice().sort((a, b) => Math.abs(FO(a)) - Math.abs(FO(b)));
    for (const s of list) {
      const bx = Math.round(X(FO(s)) / 6) * 6;
      const k = stack[bx] = (stack[bx] || 0) + 1, up = FO(s) >= 0;
      const by = up ? ax - 6 - (k - 1) * 6 : ax + 6 + (k - 1) * 6;
      if (by < 2 || by > Hb - 2) continue;
      const m = matches(s);
      x.fillStyle = H && !m ? (up ? "rgba(47,158,95,.15)" : "rgba(214,69,93,.15)")
        : H && H.type === "stock" ? C.ink : up ? C.up : C.down;
      x.beginPath(); x.arc(bx, by, H && H.type === "stock" && m ? 4.5 : 2.6, 0, 7); x.fill();
      BEADS.push({ s, x: bx, y: by });
      if (H && H.type === "stock" && m) {
        x.font = '700 10px "JetBrains Mono", monospace'; x.fillStyle = C.ink;
        x.fillText(`${s.sym} ${pc(FO(s))}`, Math.min(R - 90, bx - 30), up ? by - 8 : by + 16);
      }
    }

    const ext = [BY[D.bull[0]], BY[D.bear[0]]].filter(Boolean);
    ext.forEach((s) => {
      const b = BEADS.find((q) => q.s === s);
      if (!b) return;
      x.strokeStyle = s.side === "bull" ? C.up : C.down; x.lineWidth = 2;
      x.beginPath(); x.arc(b.x, b.y, 6, 0, 7); x.stroke();
    });
    Object.entries(D.indices || {}).slice(0, 4).forEach(([, i]) => {
      x.fillStyle = C.ink; x.beginPath(); x.arc(X(i.pct), ax, 3, 0, 7); x.fill();
    });

    const real = (D.sectors || []).filter((s) => s.n >= 3);
    const lead = real[0], lag = real.at(-1);
    const dia = (s, el, txt, arrow) => {
      if (!s) return;
      const xx = X(s.pct);
      x.fillStyle = C.ink;
      x.beginPath(); x.moveTo(xx, ax - 5); x.lineTo(xx + 5, ax); x.lineTo(xx, ax + 5); x.lineTo(xx - 5, ax); x.fill();
      x.setLineDash([2, 2]); x.strokeStyle = "#9aa2b1";
      x.beginPath(); x.moveTo(xx, ax - 6); x.lineTo(xx, 14); x.stroke(); x.setLineDash([]);
      el.style.left = Math.max(0, Math.min(W - 250, xx - 120)) + "px"; el.style.top = "0px";
      el.innerHTML = `${txt} <b>${esc(s.name)}</b> <span class="${s.pct >= 0 ? "up" : "down"}">${pc(s.pct)}</span> ${arrow}`;
    };
    dia(lag, $("lagl"), "LAGGING SECTOR", '<span class="down">↘</span>');
    dia(lead, $("leadl"), '<span class="up">↗</span> LEADING SECTOR', "");
    $("counts").style.left = (W + 6) + "px";
  }

  /* ============================================================ hover */
  function setH(h, e) {
    const same = JSON.stringify(h) === JSON.stringify(H);
    H = h;
    if (!h) $("tip").style.display = "none";
    if (same) return;
    document.querySelectorAll(".tile[data-s]").forEach((t) => {
      const s = BY[t.dataset.s];
      t.classList.toggle("dim", !!h && !(s && matches(s)));
      t.classList.toggle("hl", !!h && h.type === "stock" && s && s.sym === h.key);
    });
    document.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("on", !!h && h.type === "sector" && c.dataset.sec === h.key);
      c.classList.toggle("dim", !!h && h.type === "sector" && c.dataset.sec !== h.key);
    });
    draw(); beads();
  }

  function tip(s, e) {
    if (!s) return;
    const t = $("tip");
    t.style.display = "block";
    t.style.left = Math.min(innerWidth - 260, e.clientX + 14) + "px";
    t.style.top = Math.min(innerHeight - 130, e.clientY + 14) + "px";
    const opt = s.opt;
    t.innerHTML = `<b>${esc(s.sym)}</b> <span class="muted">· ${esc(s.sector || "F&O")}</span><br>
      ₹${money(s.ltp)} · <span class="${s.pct >= 0 ? "up" : "down"}">${pc(s.pct)}</span><br>
      STRENGTH ${Number(s.comb || 0).toFixed(1)} · ${esc(s.dir || "–")}${s.rank ? " #" + s.rank : ""}<br>
      OI ${esc(s.oi || "–")} · range ${Math.round((s.pos || 0) * 100)}%<br>
      ${opt ? `OPTION <b>${esc(opt.grade || "–")}</b> ${esc(opt.side || "")} ${opt.strike ?? ""}` : "no chain yet"}`;
  }

  function nearestLine(mx, my) {
    let best = null, bd = 9;
    for (const [sym, pts] of Object.entries(PTS)) {
      for (const p of pts) {
        if (Math.abs(p[0] - mx) > 7) continue;
        const d = Math.abs(p[1] - my);
        if (d < bd) { bd = d; best = sym; }
      }
    }
    return best;
  }

  $("stage").addEventListener("mousemove", (e) => {
    if (e.target.closest(".tile") || e.target.closest(".chip")) return;
    const st = $("stage").getBoundingClientRect();
    const mx = e.clientX - st.left, my = e.clientY - st.top, g = G;
    if (!g) return;
    let sym = null;
    if (my < g.beadsH && mx < g.wfR) {
      let bd = 8;
      BEADS.forEach((b) => { const d = Math.hypot(b.x - mx, b.y - my); if (d < bd) { bd = d; sym = b.s.sym; } });
    } else if (mx >= g.wfL && mx <= g.wfR) {
      const r = ROWS.find((r) => Math.abs(r.y - my) <= Math.max(2, r.h / 2));
      sym = r && r.s.sym;
    } else if (mx < g.chartR && mx > g.L) sym = nearestLine(mx, my);
    if (sym) { setH({ type: "stock", key: sym }); tip(BY[sym], e); }
    else if (H && H.type === "stock") setH(null);
  });
  $("stage").addEventListener("mouseleave", () => setH(null));
  $("stage").addEventListener("click", (e) => {
    if (e.target.closest(".tile") || e.target.closest(".chip")) return;
    if (H && H.type === "stock") openChart(H.key);
  });

  /* ============================================================ travel lights */
  const FX = { t0: performance.now(), last: 0 };
  function fxPoint(pts, f) {
    const i = Math.min(pts.length - 2, Math.max(0, Math.floor(f))), t = Math.min(1, Math.max(0, f - i));
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
  }
  function bez(c, t) {
    const u = 1 - t;
    return [u * u * u * c.sx + 3 * u * u * t * c.cx + 3 * u * t * t * c.cx + t * t * t * c.tx,
      u * u * u * c.sy + 3 * u * u * t * c.sy + 3 * u * t * t * c.ty + t * t * t * c.ty];
  }
  function fxLoop(now) {
    requestAnimationFrame(fxLoop);
    if (document.hidden || !D || !G || now - FX.last < 66) return;
    FX.last = now;
    const g = G, cv = $("fx"), dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(g.W * dpr) || cv.height !== Math.round(g.Hs * dpr)) {
      cv.width = Math.round(g.W * dpr); cv.height = Math.round(g.Hs * dpr);
      cv.style.width = g.W + "px"; cv.style.height = g.Hs + "px";
    }
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, g.W, g.Hs);
    if ($("modal").style.display === "flex") return;
    const T = (now - FX.t0) / 1000 * .18;
    const dot = (p, rgb) => {
      x.fillStyle = `rgba(${rgb},.18)`; x.beginPath(); x.arc(p[0], p[1], 5, 0, 7); x.fill();
      x.fillStyle = `rgb(${rgb})`; x.beginPath(); x.arc(p[0], p[1], 2.1, 0, 7); x.fill();
    };
    const phase = (rank) => (T / 4 + rank * .05) % 1.25;
    for (const c of CONN) {
      const s = BY[c.sym], pts = PTS[c.sym];
      if (!s || !pts || pts.length < 2 || (H && !matches(s))) continue;
      const rgb = c.side === "bull" ? "22,163,74" : "220,38,38", f = phase(c.rank);
      dot(f < 1 ? fxPoint(pts, f * (pts.length - 1)) : bez(c, (f - 1) / .25), rgb);
    }
  }
  requestAnimationFrame(fxLoop);

  /* ============================================================ data */
  const SEEN = {};
  function flash() {
    document.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.dataset.k, v = +el.dataset.v;
      if (k in SEEN && SEEN[k] !== v) {
        el.classList.remove("flash-up", "flash-down");
        void el.offsetWidth;
        el.classList.add(v > SEEN[k] ? "flash-up" : "flash-down");
      }
      SEEN[k] = v;
    });
  }

  function render() {
    if (!D || !D.stocks || !D.stocks.length) return;
    G = geometry();
    BY = Object.fromEntries(D.stocks.map((s) => [s.sym, s]));
    $("nb").textContent = D.bull.length;
    $("nr").textContent = D.bear.length;
    cards(); tiles(); chips(); flash();
    animate();
    if (H && H.type === "stock") setH({ ...H });
  }

  async function load() {
    try {
      const nd = await (await fetch("/api/tape")).json();
      if (!nd.stocks || !nd.stocks.length) {
        $("live").textContent = "waiting for the first scan…";
        return;
      }
      D = nd;
      $("live").innerHTML = (nd.demo ? `<span class="dot warn"></span>SAMPLE · `
        : `<span class="dot"></span>LIVE · `) + `${esc(nd.market || "scan")} · ` +
        new Date(nd.time).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
      $("live").className = "live" + (nd.demo ? " sample" : "");
      $("live").title = nd.demo
        ? "Simulated feed: connect Upstox to switch every panel to live market data"
        : "Live quote feed from your Upstox account";
      if (!document.querySelector("#modal[style*=flex]")) render();
    } catch (e) {
      $("live").textContent = "server not reachable";
    }
  }

  /* ============================================================ pop-up zone */
  let MC = {}, MSYM = null;
  function openChart(sym) {
    MSYM = sym;
    $("modal").style.display = "flex";
    $("tip").style.display = "none";
    loadChart();
  }
  function closeChart() { $("modal").style.display = "none"; render(); }
  $("mx").onclick = closeChart;
  $("modal").onclick = (e) => { if (e.target.id === "modal") closeChart(); };
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeChart(); });

  async function loadChart() {
    const row = BY[MSYM];
    $("mname").textContent = MSYM;
    $("msub").textContent = row
      ? `${row.sector || "F&O"} · ${row.dir || "–"}${row.rank ? ` #${row.rank}` : ""} · strength ${Number(row.comb || 0).toFixed(1)}`
      : "INDEX";
    $("mprice").innerHTML = row ? `₹${money(row.ltp)} · <span class="${row.pct >= 0 ? "up" : "down"}">${pc(row.pct)}</span>` : "";
    $("mbox").style.borderLeftColor = row && row.pct < 0 ? "var(--down)" : "var(--up)";
    $("mlv").innerHTML = '<div class="muted">Loading…</div>';
    try {
      const d = await (await fetch(`/api/chart?symbol=${encodeURIComponent(MSYM)}`)).json();
      if (d.error) { $("mlv").innerHTML = `<div class="down">${esc(d.error)}</div>`; return; }
      MC.data = d;
      chartDraw();
      const zones = d.zones || [];
      const act = zones.filter((z) => z.active);
      const z = (act.length ? act : zones).slice(-1)[0] || null;
      const vwap = (d.vwap || []).filter((v) => v != null).slice(-1)[0];
      const ltp = d.last || (row && row.ltp) || 0;
      $("mev").innerHTML = zones.slice(-6).map((q) =>
        `<span style="border-left-color:${q.dir > 0 ? "var(--up)" : "var(--down)"}">${q.dir > 0 ? "BULL OB" : "BEAR OB"} ${q.grade} · ${money(q.bottom)}–${money(q.top)}${q.vol ? ` · ${q.vol.toFixed(1)}x Vol` : ""}${q.active ? " · live" : ""}</span>`).join("");
      const lvls = d.levels || [];
      $("mlv").innerHTML = `
        <h4>ACTIVE ZONE</h4>
        <div class="kv"><span>order block</span><b>${z ? `${money(z.bottom)} – ${money(z.top)}` : "none"}</b></div>
        <div class="kv"><span>bias</span><b class="${z && z.dir > 0 ? "up" : "down"}">${z ? (z.dir > 0 ? "bullish" : "bearish") : "–"}</b></div>
        <div class="kv"><span>invalidation</span><b>${z ? money(z.dir > 0 ? z.bottom : z.top) : "–"}</b></div>
        <div class="kv"><span>distance</span><b>${z ? pc((ltp / ((z.top + z.bottom) / 2) - 1) * 100) : "–"}</b></div>
        <div class="kv"><span>vwap</span><b>${vwap ? money(vwap) : "–"}</b></div>
        <h4>SCANNER</h4>
        <div class="kv"><span>strength</span><b>${row ? Number(row.comb || 0).toFixed(1) : "–"}</b></div>
        <div class="kv"><span>day move</span><b class="${row && row.pct >= 0 ? "up" : "down"}">${row ? pc(row.pct) : "–"}</b></div>
        <div class="kv"><span>range position</span><b>${row ? Math.round((row.pos || 0) * 100) + "%" : "–"}</b></div>
        <div class="kv"><span>oi flow</span><b>${row ? esc(row.oi || "–") : "–"}</b></div>
        <div class="kv"><span>contract</span><b>${row && row.opt ? `${esc(row.opt.side)} ${row.opt.strike} · ${esc(row.opt.grade)}` : "–"}</b></div>
        <div class="kv"><span>source</span><b>${esc(d.label || "")} · 5m</b></div>
        <h4>HTF LEVELS</h4>
        ${lvls.length ? lvls.map((l) => `<div class="kv"><span>${esc(l.label)}</span><b>${money(l.price)} <span class="${l.price >= ltp ? "down" : "up"}">${pc((l.price / (ltp || 1) - 1) * 100)}</span></b></div>`).join("") : '<div class="kv"><span>levels</span><b>unavailable</b></div>'}`;
    } catch (_) { $("mlv").innerHTML = '<div class="down">chart endpoint not answering</div>'; }
  }

  function chartDraw() {
    const cv = $("mc"), d = MC.data;
    if (!d || !d.candles || !d.candles.length) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.clientWidth, Hh = cv.clientHeight;
    if (!W || !Hh) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    const x = cv.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, Hh);
    const padL = 6, padR = 56, padT = 10, padB = 18;
    const w = W - padL - padR, h = Hh - padT - padB;
    const cs = d.candles, n = cs.length, step = w / Math.max(1, n);
    let lo = Math.min(...cs.map((k) => k[3])), hi = Math.max(...cs.map((k) => k[2]));
    (d.zones || []).forEach((z) => { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); });
    const last0 = cs[cs.length - 1][4];
    const lvls = (d.levels || []).filter((l) => last0 && Math.abs(l.price / last0 - 1) <= .12);
    lvls.forEach((l) => { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); });
    const span = (hi - lo) || 1;
    lo -= span * .06; hi += span * .06;
    const X = (i) => padL + (i + .5) * step, Y = (v) => padT + (hi - v) / (hi - lo) * h;
    x.font = '9px "JetBrains Mono", monospace'; x.textAlign = "left";
    for (let i = 0; i <= 3; i++) {
      const v = lo + (hi - lo) * i / 3, yy = Math.round(Y(v)) + .5;
      x.strokeStyle = "#eef1f5"; x.beginPath(); x.moveTo(padL, yy); x.lineTo(padL + w, yy); x.stroke();
      x.fillStyle = "#98a2b3"; x.fillText(money(v), padL + w + 6, yy + 3);
    }
    (d.zones || []).forEach((z) => {
      const x0 = X(z.i0), x1 = X(Math.min(n - 1, z.i1 ?? n - 1)) + step / 2;
      const y0 = Y(z.top), y1 = Y(z.bottom);
      const rgb = z.dir > 0 ? "34,160,90" : "220,63,84";
      x.fillStyle = `rgba(${rgb},${z.active ? ".13" : ".05"})`;
      x.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(1, y1 - y0));
      x.strokeStyle = `rgba(${rgb},${z.active ? ".5" : ".2"})`;
      x.beginPath(); x.moveTo(x0, y0 + .5); x.lineTo(x1, y0 + .5);
      x.moveTo(x0, y1 + .5); x.lineTo(x1, y1 + .5); x.stroke();
      if (z.active) { x.fillStyle = `rgba(${rgb},.95)`; x.fillText(z.grade, Math.min(x0 + 3, padL + w - 34), y0 - 3); }
    });
    lvls.forEach((l) => {
      const y = Math.round(Y(l.price)) + .5;
      if (y < padT - 1 || y > padT + h + 1) return;
      x.strokeStyle = "rgba(0,102,255,.5)"; x.setLineDash([6, 4]); x.lineWidth = 1.3;
      x.beginPath(); x.moveTo(padL, y); x.lineTo(padL + w, y); x.stroke(); x.setLineDash([]);
      x.font = '700 9px "JetBrains Mono", monospace'; x.fillStyle = "#0066ff";
      x.fillText(`${l.label} ${money(l.price)}`, padL + 3, y - 3);
    });
    x.strokeStyle = "rgba(37,99,235,.65)"; x.setLineDash([3, 3]);
    x.beginPath(); let started = false;
    (d.vwap || []).forEach((v, i) => {
      if (v == null) return;
      started ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v));
      started = true;
    });
    x.stroke(); x.setLineDash([]);
    const bw = Math.max(1.5, Math.min(7, step * .6));
    cs.forEach((k, i) => {
      const up = k[4] >= k[1], cx = X(i);
      x.strokeStyle = up ? "rgba(47,158,95,.8)" : "rgba(214,69,93,.8)"; x.lineWidth = 1;
      x.beginPath(); x.moveTo(cx + .5, Y(k[2])); x.lineTo(cx + .5, Y(k[3])); x.stroke();
      x.fillStyle = up ? "rgba(47,158,95,.9)" : "rgba(214,69,93,.9)";
      const yo = Y(k[1]), yc = Y(k[4]);
      x.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });
    const last = cs[cs.length - 1][4], ly = Math.round(Y(last)) + .5;
    x.fillStyle = "#141a26"; x.fillRect(padL + w + 2, ly - 7, 50, 14);
    x.fillStyle = "#fff"; x.fillText(money(last), padL + w + 6, ly + 3.5);
    x.fillStyle = "#98a2b3"; x.textAlign = "center";
    [0, Math.floor(n / 2), n - 1].forEach((i) => {
      if (!cs[i]) return;
      const t = new Date(cs[i][0]).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      x.fillText(t, Math.min(padL + w - 12, Math.max(padL + 12, X(i))), padT + h + 12);
    });
    x.textAlign = "left";
  }

  /* ============================================================ upstox link */
  async function auth() {
    try {
      const s = await (await fetch("/api/auth/state")).json();
      const b = $("upstoxBtn");
      if (!b) return;
      if (s.authorized) {
        b.textContent = s.cloud ? "Live feed from your PC" : "Upstox connected";
        b.className = "upstox on";
        b.href = "#";
        b.title = "Live feed from your Upstox account";
      } else if (s.login === false) {
        b.textContent = /expired/i.test(s.message || "") ? "Reconnect on your PC" : "Waiting for your PC";
        b.className = "upstox warn";
        b.href = "#";
        b.title = "This copy takes the live feed from the scanner running on your computer; open it there and reconnect Upstox";
      } else {
        const expired = /expired/i.test(s.message || "");
        b.textContent = expired ? "Reconnect Upstox" : "Connect Upstox";
        b.className = "upstox" + (expired ? " warn" : "");
        b.href = "/api/auth/login?next=smart";
        b.title = s.message ? `Upstox: ${s.message}` : "Link your Upstox account";
      }
    } catch (_) { /* the button keeps its default link */ }
  }
  const linked = new URLSearchParams(location.search).get("linked");
  if (linked) {
    const n = $("linkNote");
    if (n) { n.hidden = false; n.textContent = "· Upstox linked, switching to the live feed…"; }
    setTimeout(() => { if (n) n.hidden = true; }, 9000);
    history.replaceState(null, "", location.pathname);
  }
  auth();
  setInterval(auth, 60000);

  new ResizeObserver(() => { if (G) { render(); if (MC.data) chartDraw(); } }).observe($("stage"));
  load();
  setInterval(load, 4000);
})();
