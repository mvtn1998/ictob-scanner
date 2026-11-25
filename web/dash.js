/* OB SENTINEL — dashboard client, Market Lab design
   Data: /api/snapshot (tape + indices + phase), /api/pulse (picture, sectors,
   detections), /api/chart (5-min candles + order-block zones + VWAP),
   /api/option (tracked contract), /api/scope (index filter). */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
    if (!isFinite(n) || v === null) return "—";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  };
  const shortIdx = (n) => String(n || "").replace(/^NIFTY ?/, "") || n;
  const GREEN = "#22a05a", RED = "#dc3f54", BLUE = "#2563eb";
  const GRADE = { ELITE: "g-ELITE", STRONG: "g-STRONG", OK: "g-OK", THIN: "g-THIN", AVOID: "g-AVOID" };

  // tape = the scanner's RALLY + OPT ranking, shared with the Smart Money stage
  const state = { snap: null, tape: null, bySym: {}, pulse: null, selected: null, seq: 0, booted: false };

  /* ============================================================ header */
  function renderBadges(s) {
    const ph = s.phase || {};
    const items = [
      ["Ranking", "RALLY + OPT"],
      ["Universe", `${int(s.stats.universe)} F&O`],
      ["Scored", int(s.stats.scored)],
      ["Bull / bear", `${int(s.stats.bull)} / ${int(s.stats.bear)}`],
      ["Advancing", int(s.stats.adv)],
      ["Declining", int(s.stats.dec)],
      ["Avg move", pctTxt(s.stats.avg)],
    ];
    const feed = s.demo
      ? `<span class="badge warn">Feed <b>SAMPLE</b></span>`
      : `<span class="badge live">Feed <b>LIVE</b></span>`;
    $("badges").innerHTML = feed +
      items.map(([k, v]) => `<span class="badge">${k} <b>${esc(v)}</b></span>`).join("") +
      `<span class="badge">${esc(s.session || "")} <b>${esc(s.ist || "")}</b></span>`;
    $("phaseLbl").textContent = (ph.label || "scanning").toUpperCase();
    $("progFill").style.width = ph.total
      ? `${Math.min(100, (ph.done / ph.total) * 100)}%` : "0%";
    $("cycleLbl").textContent = ph.total ? `SCAN ${int(ph.done)}/${int(ph.total)}` : "SCAN —";
    $("sessionLbl").textContent = `${s.session || "—"} · ${s.date || ""} ${s.ist || ""}`;
    $("feedLbl").textContent = s.demo ? "FEED · SAMPLE" : "FEED · LIVE";
    const age = s.last_tick ? Math.max(0, Math.round(Date.now() / 1000 - s.last_tick)) : null;
    $("tickLbl").textContent = age == null ? "TICK · —" : `TICK · ${age}s AGO`;
    $("errLbl").textContent = s.error ? `! ${s.error}` : "";
    $("statusDot").style.background = s.demo ? "#ffbe55" : GREEN;
  }

  /* ============================================================ index cards */
  let tapeBuilt = false;
  function renderTape(indices) {
    if (!indices || !indices.length) return;
    const box = $("tape");
    if (!tapeBuilt || box.children.length !== indices.length) {
      box.innerHTML = indices.map((ix) =>
        `<div class="icard" data-name="${esc(ix.name)}">
           <div class="n">${esc(shortIdx(ix.name))}</div>
           <div class="v">—</div><div class="p">—</div>
         </div>`).join("");
      tapeBuilt = true;
    }
    indices.forEach((ix, i) => {
      const el = box.children[i];
      if (!el) return;
      const v = el.querySelector(".v"), p = el.querySelector(".p");
      v.textContent = ix.ltp ? num(ix.ltp, 1) : "—";
      p.textContent = pctTxt(ix.pct);
      p.className = "p " + (Number(ix.pct) >= 0 ? "up" : "down");
    });
  }

  /* ============================================================ scope */
  function renderScope(indices) {
    const bar = $("scopeBar");
    if (!bar || !indices) return;
    const active = state.snap?.scope || "";
    if (bar.children.length !== indices.length + 1) {
      bar.innerHTML = `<button class="chip" data-name="">Universe</button>` +
        indices.map((ix) => `<button class="chip" data-name="${esc(ix.name)}">` +
          `<span>${esc(shortIdx(ix.name))}</span> <i>—</i></button>`).join("");
    }
    [...bar.children].forEach((chip, i) => {
      if (i === 0) { chip.classList.toggle("on", !active); return; }
      const ix = indices[i - 1];
      if (!ix) return;
      chip.classList.toggle("on", active === ix.name);
      const p = chip.querySelector("i");
      p.textContent = pctTxt(ix.pct);
      p.className = Number(ix.pct) >= 0 ? "up" : "down";
    });
  }
  $("scopeBar").addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    try { await fetch(`/api/scope?name=${encodeURIComponent(chip.dataset.name || "")}`); } catch (_) {}
    poll();
  });

  /* ============================================================ picture */
  const dots = { cv: $("dotfield"), ctx: null, data: [], w: 1, h: 1, pos: [], geom: null };

  function dotsResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = dots.cv.getBoundingClientRect();
    dots.w = Math.max(1, r.width); dots.h = Math.max(1, r.height);
    dots.cv.width = Math.round(dots.w * dpr);
    dots.cv.height = Math.round(dots.h * dpr);
    dots.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dotsDraw();
  }

  function dotsDraw() {
    const c = dots.ctx;
    if (!c) return;
    const { w, h } = dots;
    c.clearRect(0, 0, w, h);
    if (!dots.data.length) return;
    const midY = h / 2, padX = 14;
    const maxPct = Math.max(1, ...dots.data.map((d) => Math.abs(Number(d[1]) || 0)));
    const x = (p) => w / 2 + (Math.sign(p) || 0) *
      Math.sqrt(Math.abs(p) / maxPct) * (w / 2 - padX);
    dots.geom = { x, maxPct, midY };

    c.strokeStyle = "#e4e8ef"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padX, midY + .5); c.lineTo(w - padX, midY + .5); c.stroke();
    c.setLineDash([2, 4]); c.strokeStyle = "#eceff4";
    c.beginPath(); c.moveTo(w / 2, 6); c.lineTo(w / 2, h - 18); c.stroke();
    c.setLineDash([]);

    c.font = '500 9px "JetBrains Mono", monospace';
    c.fillStyle = "#98a2b3";
    c.textAlign = "left"; c.fillText(`−${maxPct.toFixed(1)}%`, padX, h - 4);
    c.textAlign = "center"; c.fillText("0", w / 2, h - 4);
    c.textAlign = "right"; c.fillText(`+${maxPct.toFixed(1)}%`, w - padX, h - 4);

    const bulls = dots.data.filter((d) => d[2] === "BULL")
      .sort((a, b) => b[3] - a[3]).slice(0, 6);
    const bears = dots.data.filter((d) => d[2] === "BEAR")
      .sort((a, b) => b[3] - a[3]).slice(0, 6);
    const ringed = new Set([...bulls, ...bears].map((d) => d[0]));

    dots.pos = [];
    dots.data.forEach(([sym, pct, dir, score], i) => {
      const px = x(Number(pct) || 0);
      const s = Math.max(0, Math.min(100, Number(score) || 0));
      const jitter = ((i * 37) % 13) / 13 - 0.5;
      const reach = midY - 10;
      const depth = 0.22 + (s / 100) * 0.78;
      let py;
      if (dir === "BEAR") py = midY + 3 + depth * reach * 0.9 + jitter * 9;
      else if (dir === "BULL") py = midY - 3 - depth * reach * 0.9 + jitter * 9;
      else py = midY + jitter * 5;
      py = Math.max(6, Math.min(h - 22, py));
      dots.pos.push({ sym, pct, px, py });
      const color = dir === "BEAR" ? RED : dir === "BULL" ? GREEN : "#9aa3b2";
      c.globalAlpha = ringed.has(sym) ? 1 : .6;
      c.fillStyle = color;
      c.beginPath(); c.arc(px, py, ringed.has(sym) ? 2.6 : 1.8, 0, Math.PI * 2); c.fill();
      if (ringed.has(sym)) {
        c.globalAlpha = .45; c.strokeStyle = color; c.lineWidth = 1;
        c.beginPath(); c.arc(px, py, 5.8, 0, Math.PI * 2); c.stroke();
      }
    });
    c.globalAlpha = 1;
  }

  dots.cv.addEventListener("mousemove", (e) => {
    const tip = $("dotTip");
    if (!dots.geom || !dots.pos.length) return;
    const r = dots.cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 14;
    dots.pos.forEach((p) => {
      const dist = Math.hypot(p.px - mx, p.py - my);
      if (dist < bd) { bd = dist; best = p; }
    });
    if (!best) { tip.style.display = "none"; return; }
    tip.style.display = "block";
    tip.style.left = `${best.px}px`;
    tip.style.top = `${best.py}px`;
    tip.innerHTML = `<b>${esc(best.sym)}</b> <span style="color:${Number(best.pct) >= 0 ? "#7ee2a8" : "#ff9fb1"}">${pctTxt(best.pct)}</span>`;
  });
  dots.cv.addEventListener("mouseleave", () => { $("dotTip").style.display = "none"; });

  function renderPicture(p) {
    if (!p) return;
    $("cntBull").textContent = `▲ ${int(p.stats.bull)}`;
    $("cntBear").textContent = `▼ ${int(p.stats.bear)}`;
    const total = (p.stats.bull || 0) + (p.stats.bear || 0);
    const share = total ? (p.stats.bull || 0) / total * 100 : 50;
    $("breadthFill").style.width = `${share}%`;
    const secs = (p.sectors || []).slice();
    const lead = secs.slice().sort((a, b) => b.avg - a.avg)[0];
    const lag = secs.slice().sort((a, b) => a.avg - b.avg)[0];
    $("leadSec").textContent = lead ? `${shortIdx(lead.name)} ${pctTxt(lead.avg)}` : "—";
    $("lagSec").textContent = lag ? `${shortIdx(lag.name)} ${pctTxt(lag.avg)}` : "—";
    $("picMeta").textContent = `${int(p.stats.universe)} F&O · ${int(p.stats.scored)} scored · ${p.ts || ""}`;
    dots.data = p.dots || [];
    dotsResize();
    renderFeed(p);
    renderSectors(p);
    renderLeaders(p);
  }

  function renderFeed(p) {
    const f = p.feed || [];
    $("feedN").textContent = f.length;
    $("feed").innerHTML = f.map((x) => {
      const bull = x.dir === "BULL";
      return `<div class="drow">
        <span class="s">${esc(x.symbol)} <span class="pill ${bull ? "g" : "r"}">${esc(x.dir || "—")}</span></span>
        <span class="r ${bull ? "up" : "down"}">${num(x.score, 1)}</span>
        <span class="m">${x.age}s ago${x.grade ? ` · ${esc(x.grade)}` : ""}</span>
      </div>`;
    }).join("") || `<div class="empty">No structure detected yet this session.</div>`;
  }

  function renderSectors(p) {
    const secs = (p.sectors || []).slice(0, 8);
    const mx = Math.max(.2, ...secs.map((s) => Math.abs(s.avg)));
    $("sectors").innerHTML = secs.map((s) =>
      `<div class="drow">
         <span class="s">${esc(shortIdx(s.name))}</span>
         <span class="r ${s.avg >= 0 ? "up" : "down"}">${pctTxt(s.avg)}</span>
         <span class="m">${s.n} stocks</span>
         <div class="bar"><i style="width:${Math.abs(s.avg) / mx * 100}%;background:${s.avg >= 0 ? "var(--up)" : "var(--down)"}"></i></div>
       </div>`).join("") || `<div class="empty">Sector map still building.</div>`;
  }

  function renderLeaders(p) {
    const rows = [...(p.bulls || []), ...(p.bears || [])];
    $("leaders").innerHTML = rows.map((r) =>
      `<div class="drow" data-sym="${esc(r.symbol)}">
         <span class="s">${esc(r.symbol)} <span class="pill ${r.side === "PE" ? "r" : "b"}">${esc((r.grade || "—"))}</span></span>
         <span class="r ${r.pct >= 0 ? "up" : "down"}">${pctTxt(r.pct)}</span>
         <span class="m">${esc(r.sector ? shortIdx(r.sector) : "F&O")} · strength ${num(r.score, 0)}</span>
       </div>`).join("") || `<div class="empty">Waiting for the first scored names.</div>`;
    $("leaders").querySelectorAll("[data-sym]").forEach((el) =>
      el.onclick = () => selectSymbol(el.dataset.sym));
  }

  /* ============================================================ boards */
  function boardHtml(side) {
    // base ranking = RALLY + OPT, taken straight from /api/tape: only names in
    // a rally, sorted by rally strength blended with option quality, chains
    // already read first (the server applies the same order)
    const keys = state.tape ? (side === "BULL" ? state.tape.bull : state.tape.bear) : [];
    const all = keys.length
      ? keys.map((k) => state.bySym[k]).filter(Boolean)
      : (state.snap?.rows || []).filter((r) => r.dir === side && Number(r.score) > 0)
        .sort((a, b) => (a.opt ? 0 : 1) - (b.opt ? 0 : 1) || b.comb - a.comb);
    const rows = all.slice(0, 13);
    const meta = side === "BULL" ? $("bullMeta") : $("bearMeta");
    if (meta) meta.textContent = `${all.length} in a rally · RALLY + OPT`;
    if (!rows.length) {
      return `<tbody><tr><td colspan="6" class="empty">No ${side.toLowerCase()} structure right now.</td></tr></tbody>`;
    }
    const body = rows.map((r, i) => {
      const opt = r.opt;
      const optCell = opt
        ? `<span class="grade ${GRADE[opt.grade] || ""}">${esc(opt.grade || "—")}</span>
           <span class="muted" style="font-size:10px"> ${esc(opt.side || "")} ${num(opt.strike, 0)}</span>`
        : `<span class="muted" style="font-size:10px">no chain</span>`;
      return `<tr data-sym="${esc(r.symbol)}" class="${i < 3 ? "pick" : ""}${state.selected === r.symbol ? " sel" : ""}">
        <td>${i + 1}${i < 3 ? `<span class="pill b">PICK</span>` : i < 8 ? `<span class="pill n">WATCH</span>` : ""}</td>
        <td>${esc(r.symbol)}</td>
        <td>${esc(r.sector ? shortIdx(r.sector) : "F&O")}</td>
        <td><span class="meter${side === "BEAR" ? " bear" : ""}"><i style="width:${Math.min(100, r.comb)}%"></i></span><b>${num(r.comb, 0)}</b></td>
        <td class="${Number(r.pct) >= 0 ? "up" : "down"}">${pctTxt(r.pct)}</td>
        <td>${optCell}</td>
      </tr>`;
    }).join("");
    return `<thead><tr><th>#</th><th>Stock</th><th>Sector</th><th>Strength</th><th>Move</th><th>Option</th></tr></thead><tbody>${body}</tbody>`;
  }

  function renderBoards() {
    const s = state.snap;
    if (!s) return;
    $("bullTable").innerHTML = boardHtml("BULL");
    $("bearTable").innerHTML = boardHtml("BEAR");
    ["bullTable", "bearTable"].forEach((id) => {
      $(id).querySelectorAll("tbody tr[data-sym]").forEach((tr) =>
        tr.onclick = () => selectSymbol(tr.dataset.sym));
    });
    const nb = state.tape ? state.tape.bull.length : s.stats.bull;
    const nn = state.tape ? state.tape.bear.length : s.stats.bear;
    const total = nb + nn;
    const share = total ? Math.round(nb / total * 100) : 50;
    $("bullNote").innerHTML = `<b>PICK</b> = the three strongest bullish structures; <b>WATCH</b> = next five. Ranking is <b>RALLY + OPT</b>: only names in a rally are listed, then they sort by 62% rally strength + 38% option quality, chains already read first. ${share}% of the board leans bullish.`;
    $("bearNote").innerHTML = `<b>PICK</b> = the three strongest bearish structures. A bearish name with a CE grade in the option column is a chain-wide read, not a trade signal — check the contract before acting.`;
  }

  /* ============================================================ chart */
  const chart = { cv: $("sChart"), ctx: null, data: null, w: 1, h: 1, hover: -1, xy: null };

  function chartResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = chart.cv.getBoundingClientRect();
    chart.w = Math.max(1, r.width); chart.h = Math.max(1, r.height);
    chart.cv.width = Math.round(chart.w * dpr);
    chart.cv.height = Math.round(chart.h * dpr);
    chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartDraw();
  }

  function chartDraw() {
    const c = chart.ctx;
    if (!c || !chart.data || !chart.data.candles.length) return;
    const { candles, zones = [], vwap = [] } = chart.data;
    const padL = 6, padR = 54, padT = 10, padB = 18;
    const w = chart.w - padL - padR, h = chart.h - padT - padB;
    const n = candles.length, step = w / Math.max(1, n);
    c.clearRect(0, 0, chart.w, chart.h);

    let lo = Math.min(...candles.map((k) => k[3]));
    let hi = Math.max(...candles.map((k) => k[2]));
    zones.forEach((z) => { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); });
    const span = (hi - lo) || 1;
    lo -= span * .07; hi += span * .07;
    const x = (i) => padL + (i + .5) * step;
    const y = (v) => padT + (hi - v) / (hi - lo) * h;
    chart.xy = { x, y, lo, hi, padL, padR, step, w, h, n, padT, padB };

    c.font = '500 9px "JetBrains Mono", monospace';
    c.textAlign = "left";
    for (let i = 0; i <= 3; i++) {
      const v = lo + (hi - lo) * (i / 3), yy = Math.round(y(v)) + .5;
      c.strokeStyle = "#eef1f5";
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(padL + w, yy); c.stroke();
      c.fillStyle = "#98a2b3";
      c.fillText(num(v, 1), padL + w + 6, yy + 3);
    }

    zones.forEach((z) => {
      const x0 = x(z.i0);
      const x1 = x(Math.min(n - 1, z.i1 ?? n - 1)) + step / 2;
      const y0 = y(z.top), y1 = y(z.bottom);
      const rgb = z.dir > 0 ? "34,160,90" : "220,63,84";
      c.fillStyle = `rgba(${rgb},${z.active ? ".14" : ".06"})`;
      c.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(1, y1 - y0));
      c.strokeStyle = `rgba(${rgb},${z.active ? ".55" : ".22"})`;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x0, y0 + .5); c.lineTo(x1, y0 + .5);
      c.moveTo(x0, y1 + .5); c.lineTo(x1, y1 + .5);
      c.stroke();
      if (z.active) {
        c.fillStyle = `rgba(${rgb},.95)`;
        c.fillText(z.grade, Math.min(x0 + 3, padL + w - 34), y0 - 3);
      }
    });

    c.strokeStyle = "rgba(37,99,235,.65)";
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

    const bw = Math.max(1.6, Math.min(7, step * .62));
    candles.forEach((k, i) => {
      const up = k[4] >= k[1];
      const cx = x(i);
      c.strokeStyle = up ? "rgba(34,160,90,.8)" : "rgba(220,63,84,.8)";
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(cx + .5, y(k[2])); c.lineTo(cx + .5, y(k[3])); c.stroke();
      c.fillStyle = up ? "rgba(34,160,90,.9)" : "rgba(220,63,84,.9)";
      const yo = y(k[1]), yc = y(k[4]);
      c.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    });

    const last = candles[candles.length - 1][4];
    const ly = Math.round(y(last)) + .5;
    c.strokeStyle = "#c9d0dc";
    c.setLineDash([2, 3]);
    c.beginPath(); c.moveTo(padL, ly); c.lineTo(padL + w, ly); c.stroke();
    c.setLineDash([]);
    c.fillStyle = "#141a26";
    c.fillRect(padL + w + 2, ly - 7, 50, 14);
    c.fillStyle = "#fff";
    c.fillText(num(last, 1), padL + w + 6, ly + 3.5);

    c.fillStyle = "#98a2b3";
    c.textAlign = "center";
    [0, Math.floor(n / 2), n - 1].forEach((i) => {
      if (!candles[i]) return;
      const t = new Date(candles[i][0]).toLocaleTimeString("en-GB",
        { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      c.fillText(t, Math.min(padL + w - 12, Math.max(padL + 12, x(i))), padT + h + 12);
    });
    c.textAlign = "left";

    if (chart.hover >= 0 && candles[chart.hover]) {
      const cx = Math.round(x(chart.hover)) + .5;
      c.strokeStyle = "#bcc4d1";
      c.setLineDash([2, 2]);
      c.beginPath(); c.moveTo(cx, padT); c.lineTo(cx, padT + h); c.stroke();
      c.setLineDash([]);
      c.fillStyle = BLUE;
      c.beginPath(); c.arc(cx, y(candles[chart.hover][4]), 2.5, 0, Math.PI * 2); c.fill();
    }
  }

  chart.cv.addEventListener("mousemove", (e) => {
    if (!chart.data || !chart.xy) return;
    const r = chart.cv.getBoundingClientRect();
    const g = chart.xy;
    const i = Math.round((e.clientX - r.left - g.padL) / g.step - .5);
    const tip = $("sTip");
    if (i < 0 || i >= chart.data.candles.length) {
      chart.hover = -1; tip.style.display = "none"; chartDraw(); return;
    }
    chart.hover = i; chartDraw();
    const k = chart.data.candles[i];
    const t = new Date(k[0]).toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
    tip.style.display = "block";
    tip.style.left = `${Math.min(chart.w - 80, Math.max(80, g.x(i)))}px`;
    tip.style.top = `${g.y(k[2])}px`;
    tip.innerHTML = `${t} · O ${num(k[1], 1)} H ${num(k[2], 1)} L ${num(k[3], 1)} C ${num(k[4], 1)}`;
  });
  chart.cv.addEventListener("mouseleave", () => {
    chart.hover = -1; $("sTip").style.display = "none"; chartDraw();
  });

  /* ============================================================ setup */
  function renderStats(row) {
    const tiles = [
      ["strength", `${num(row?.comb || 0, 1)} / 100`],
      ["day move", pctTxt(row?.pct)],
      ["range pos", `${Math.round((row?.pos || 0) * 100)}%`],
      ["oi flow", row?.oi || "—"],
    ];
    $("sStats").innerHTML = tiles.map(([k, v]) =>
      `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  }

  function renderLevels(payload, row) {
    const zones = payload?.zones || [];
    const active = zones.filter((z) => z.active);
    const zone = (active.length ? active : zones).slice(-1)[0] || null;
    const vwap = (payload?.vwap || []).filter((v) => v != null).slice(-1)[0];
    const ltp = payload?.last ?? row?.ltp ?? 0;
    const rows = [
      ["order block", zone
        ? `${num(zone.bottom)} – ${num(zone.top)}<em>${zone.dir > 0 ? "bullish" : "bearish"} · ${esc(zone.grade)}</em>`
        : `none active<em>waiting for displacement</em>`],
      ["invalidation", zone ? num(zone.dir > 0 ? zone.bottom : zone.top) : "—"],
      ["vwap", vwap ? num(vwap) : "—"],
      ["distance to zone", zone
        ? pctTxt(((ltp - (zone.top + zone.bottom) / 2) / ltp) * 100) : "—"],
    ];
    $("sLevels").innerHTML = rows.map(([k, v]) =>
      `<div class="lv"><span>${k}</span><b>${v}</b></div>`).join("");
  }

  function renderContract(opt) {
    const trk = opt?.track;
    if (!trk) {
      $("sContract").innerHTML = `<div class="cl"><span>tracked contract</span><b>no listed option</b></div>
        <div class="cr"><b class="muted">—</b><em>chain</em></div>`;
      return;
    }
    $("sContract").innerHTML =
      `<div class="cl"><span>tracked contract · ${esc(opt.expiry || "exp")}</span>
         <b>${num(trk.strike, 0)} ${esc(trk.side)} · ${esc(trk.grade)}</b></div>
       <div class="cr"><b class="${GRADE[trk.grade] || ""}">₹${num(trk.ltp)}</b><em>${esc(opt.flow || "—")}</em></div>`;
  }

  async function selectSymbol(sym) {
    if (!sym) return;
    state.selected = sym;
    const row = state.bySym[sym] || (state.snap?.rows || []).find((r) => r.symbol === sym);
    document.querySelectorAll("tbody tr[data-sym]").forEach((tr) =>
      tr.classList.toggle("sel", tr.dataset.sym === sym));
    $("setupEmpty").hidden = true;
    $("setupBody").hidden = false;
    $("sSym").textContent = sym;
    $("sMeta").textContent = [row?.sector || "F&O", row?.dir || ""].filter(Boolean).join(" · ");
    $("sLtp").textContent = num(row?.ltp);
    const pc = $("sPct");
    pc.textContent = pctTxt(row?.pct);
    pc.className = Number(row?.pct) >= 0 ? "up" : "down";
    renderStats(row);

    const seq = ++state.seq;
    try {
      const data = await (await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}`)).json();
      if (seq !== state.seq) return;
      chart.data = data;
      chartResize();
      renderLevels(data, row);
      $("sMeta").textContent = [row?.sector || "F&O", row?.dir || "",
        `${data.label} · 5m`].filter(Boolean).join(" · ");
    } catch (_) { /* keep the previous chart */ }

    try {
      const opt = await (await fetch(`/api/option?symbol=${encodeURIComponent(sym)}`)).json();
      if (seq !== state.seq) return;
      renderContract(opt);
    } catch (_) { /* no chain */ }
  }

  /* ============================================================ polling */
  async function poll() {
    try {
      const [r, tr] = await Promise.all([
        fetch("/api/snapshot?mode=rally"),
        fetch("/api/tape").catch(() => null),
      ]);
      if (!r.ok) throw new Error(`snapshot ${r.status}`);
      const s = await r.json();
      state.snap = s;
      if (tr && tr.ok) {
        const t = await tr.json();
        if (t && t.stocks && t.stocks.length) {
          state.tape = t;
          state.bySym = Object.fromEntries(t.stocks.map((x) => [x.sym, { ...x, symbol: x.sym }]));
        }
      }
      renderBadges(s);
      renderTape(s.indices);
      renderScope(s.indices);
      renderBoards();
      if (!state.booted && s.rows.length) {
        state.booted = true;
        selectSymbol(s.rows[0].symbol);
      }
    } catch (e) {
      $("errLbl").textContent = `! ${e.message}`;
    }
  }

  async function pollPulse() {
    try { renderPicture(await (await fetch("/api/pulse")).json()); } catch (_) {}
  }

  /* ============================================================ upstox link */
  async function auth() {
    try {
      const s = await (await fetch("/api/auth/state")).json();
      const b = $("upstoxBtn");
      if (!b) return;
      if (s.authorized) {
        b.textContent = "Upstox connected";
        b.className = "upstox on";
        b.href = "#";
        b.title = "Live feed from your Upstox account";
      } else {
        const expired = /expired/i.test(s.message || "");
        b.textContent = expired ? "Reconnect Upstox" : "Connect Upstox";
        b.className = "upstox" + (expired ? " warn" : "");
        b.href = "/api/auth/login?next=dash";
        b.title = s.message ? `Upstox: ${s.message}` : "Link your Upstox account";
      }
    } catch (_) { /* keep the default link */ }
  }

  function init() {
    dots.ctx = dots.cv.getContext("2d");
    chart.ctx = chart.cv.getContext("2d");
    new ResizeObserver(dotsResize).observe(dots.cv.parentElement);
    new ResizeObserver(chartResize).observe(chart.cv.parentElement);
    auth();
    if (new URLSearchParams(location.search).get("linked")) {
      history.replaceState(null, "", location.pathname);
      setTimeout(auth, 4000);
    }
    poll();
    pollPulse();
    setInterval(poll, 4000);
    setInterval(pollPulse, 15000);
    setInterval(auth, 30000);
    setInterval(() => { if (state.selected) selectSymbol(state.selected); }, 30000);
  }

  init();
})();
