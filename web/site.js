/* OB SENTINEL — site */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
              '"': "&quot;", "'": "&#39;" }[c]));
  const MINT = "#6cf5c2";
  const CYAN = "#67d8ff";
  const ROSE = "#ff7a98";
  const GRID = "rgba(255,255,255,.045)";
  const MONO = '500 9px "JetBrains Mono", ui-monospace, monospace';

  const fmt = (v, d = 2) => Number(v).toLocaleString("en-IN", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
  const pctTxt = (v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`;
  const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  });

  /* ============================================================
     price chart
     ============================================================ */
  class PriceChart {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.opts = { mini: false, hover: true, ...opts };
      this.data = null;
      this.hoverIdx = -1;
      this.progress = 0;
      this.raf = null;
      this.tip = opts.tip || null;
      this._bind();
    }

    _bind() {
      const ro = new ResizeObserver(() => { this.resize(); this.draw(this.progress); });
      ro.observe(this.cv.parentElement || this.cv);
      if (this.opts.hover) {
        this.cv.addEventListener("mousemove", (e) => this._move(e));
        this.cv.addEventListener("mouseleave", () => {
          this.hoverIdx = -1;
          if (this.tip) this.tip.hidden = true;
          this.draw(this.progress);
        });
      }
    }

    _geom() {
      const mini = this.opts.mini;
      const padL = mini ? 6 : 8;
      const padR = mini ? 8 : 64;
      const padT = mini ? 8 : 16;
      const padB = mini ? 8 : 22;
      const w = this.w - padL - padR;
      const h = this.h - padT - padB;
      const n = this.data.candles.length;
      return { padL, padR, padT, padB, w, h, n, step: w / n };
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.cv.getBoundingClientRect();
      this.w = Math.max(1, rect.width);
      this.h = Math.max(1, rect.height);
      this.cv.width = Math.round(this.w * dpr);
      this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setData(data) {
      this.data = data;
      this.resize();
      this.progress = 0;
      this.animate();
    }

    animate() {
      cancelAnimationFrame(this.raf);
      const t0 = performance.now();
      const dur = 1050;
      const loop = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        this.progress = 1 - Math.pow(1 - p, 3);
        this.draw(this.progress);
        if (p < 1) this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    draw(p = 1) {
      if (!this.data) return;
      const c = this.ctx;
      const g = this._geom();
      const { candles, zones, vwap } = this.data;
      const mini = this.opts.mini;

      c.clearRect(0, 0, this.w, this.h);
      if (!candles.length) return;

      let lo = Math.min(...candles.map((k) => k[3]));
      let hi = Math.max(...candles.map((k) => k[2]));
      zones.forEach((z) => { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); });
      const span = (hi - lo) || 1;
      lo -= span * 0.09;
      hi += span * 0.09;

      const x = (i) => g.padL + (i + 0.5) * g.step;
      const y = (v) => g.padT + (hi - v) / (hi - lo) * g.h;
      this._xy = { x, y, g, lo, hi };

      /* grid + price axis */
      if (!mini) {
        c.strokeStyle = GRID;
        c.lineWidth = 1;
        c.font = MONO;
        c.fillStyle = "rgba(152,162,179,.55)";
        c.textAlign = "left";
        c.textBaseline = "middle";
        for (let i = 0; i <= 4; i++) {
          const yy = g.padT + (g.h / 4) * i;
          c.beginPath(); c.moveTo(g.padL, yy); c.lineTo(g.padL + g.w, yy); c.stroke();
          const val = hi - ((hi - lo) / 4) * i;
          c.fillText(val.toFixed(val > 1000 ? 0 : 1), g.padL + g.w + 10, yy);
        }
        c.fillStyle = "rgba(152,162,179,.45)";
        c.textAlign = "center";
        c.textBaseline = "top";
        for (let i = 0; i < candles.length; i += 12) {
          c.fillText(clock(candles[i][0]), x(i), g.padT + g.h + 7);
        }
      }

      /* order-block zones */
      const zoneAlpha = Math.max(0, Math.min(1, (p - 0.35) / 0.5));
      zones.forEach((z) => {
        const bull = z.dir === 1;
        const x0 = x(z.i0) - g.step * 0.5;
        const x1 = Math.min(x(z.i1) + g.step * 0.5,
                           x0 + g.step * (mini ? 14 : 26));
        const yt = y(z.top);
        const yb = y(z.bottom);
        const grad = c.createLinearGradient(x0, 0, x1, 0);
        const tint = bull ? "108,245,194" : "255,122,152";
        grad.addColorStop(0, `rgba(${tint},.13)`);
        grad.addColorStop(1, `rgba(${tint},.015)`);
        c.globalAlpha = zoneAlpha * (z.active ? 1 : 0.5);
        c.fillStyle = grad;
        c.fillRect(x0, yt, Math.max(2, x1 - x0), Math.max(1, yb - yt));
        c.strokeStyle = bull ? "rgba(108,245,194,.42)" : "rgba(255,122,152,.38)";
        c.lineWidth = 1;
        c.setLineDash([3, 3]);
        c.beginPath();
        c.moveTo(x0, yt); c.lineTo(x1, yt);
        c.moveTo(x0, yb); c.lineTo(x1, yb);
        c.stroke();
        c.setLineDash([]);
        if (!mini) {
          c.font = MONO;
          c.fillStyle = bull ? "rgba(108,245,194,.8)" : "rgba(255,122,152,.75)";
          c.textAlign = "left";
          c.textBaseline = "bottom";
          c.fillText(z.grade === "ELITE" ? "OB · ELITE" : "OB",
                     x0 + 4, yt - 3);
        }
        c.globalAlpha = 1;
      });

      /* vwap */
      if (!mini && vwap && vwap.length) {
        c.beginPath();
        let started = false;
        vwap.forEach((v, i) => {
          if (v == null) return;
          if (!started) { c.moveTo(x(i), y(v)); started = true; }
          else c.lineTo(x(i), y(v));
        });
        c.strokeStyle = "rgba(103,216,255,.55)";
        c.lineWidth = 1.1;
        c.setLineDash([5, 4]);
        c.stroke();
        c.setLineDash([]);
      }

      /* candles */
      const shown = Math.max(1, Math.floor(candles.length * p));
      const bodyW = Math.max(1.6, g.step * 0.62);
      for (let i = 0; i < shown; i++) {
        const [, o, h, l, cl] = candles[i];
        const up = cl >= o;
        const cx = x(i);
        const col = up ? MINT : ROSE;
        c.strokeStyle = up ? "rgba(108,245,194,.55)" : "rgba(255,122,152,.55)";
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(cx, y(h)); c.lineTo(cx, y(l)); c.stroke();
        const yo = y(o), yc = y(cl);
        const top = Math.min(yo, yc);
        const bh = Math.max(1.2, Math.abs(yc - yo));
        c.fillStyle = up ? "rgba(108,245,194,.85)" : "rgba(255,122,152,.85)";
        c.fillRect(cx - bodyW / 2, top, bodyW, bh);
      }

      /* pulsing live marker on the last candle */
      if (!mini) {
        const lastX = x(candles.length - 1);
        const lastY = y(candles[candles.length - 1][4]);
        const ph = (Math.sin(performance.now() / 620) + 1) / 2;
        c.beginPath();
        c.arc(lastX, lastY, 2.6 + ph * 3.4, 0, Math.PI * 2);
        c.fillStyle = `rgba(108,245,194,${0.26 - ph * 0.2})`;
        c.fill();
        c.beginPath();
        c.arc(lastX, lastY, 1.9, 0, Math.PI * 2);
        c.fillStyle = "#6cf5c2";
        c.fill();
      }

      /* live price */
      if (!mini && p > 0.6) {
        const last = candles[candles.length - 1][4];
        const ly = y(last);
        c.strokeStyle = "rgba(255,255,255,.18)";
        c.setLineDash([4, 5]);
        c.beginPath(); c.moveTo(g.padL, ly); c.lineTo(g.padL + g.w, ly); c.stroke();
        c.setLineDash([]);
        const label = last.toFixed(2);
        c.font = MONO;
        const tw = c.measureText(label).width + 14;
        c.fillStyle = "#6cf5c2";
        const ry = Math.max(g.padT - 2, Math.min(ly - 8, g.padT + g.h - 14));
        c.beginPath();
        c.roundRect(g.padL + g.w + 4, ry, tw, 15, 3);
        c.fill();
        c.fillStyle = "#06070a";
        c.textAlign = "left";
        c.textBaseline = "middle";
        c.fillText(label, g.padL + g.w + 11, ry + 8);
      }

      /* hover crosshair */
      if (this.hoverIdx >= 0 && this.hoverIdx < candles.length) {
        const cx = x(this.hoverIdx);
        c.strokeStyle = "rgba(255,255,255,.16)";
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(cx, g.padT); c.lineTo(cx, g.padT + g.h); c.stroke();
      }
    }

    _move(e) {
      if (!this.data || !this._xy) return;
      const rect = this.cv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { g } = this._xy;
      const idx = Math.round((mx - g.padL) / g.step - 0.5);
      const i = Math.max(0, Math.min(this.data.candles.length - 1, idx));
      this.hoverIdx = i;
      const k = this.data.candles[i];
      if (this.tip) {
        const up = k[4] >= k[1];
        this.tip.hidden = false;
        this.tip.style.left = `${Math.min(Math.max(mx, 60), this.w - 70)}px`;
        this.tip.style.top = `${e.clientY - rect.top - 6}px`;
        this.tip.innerHTML =
          `<em>${clock(k[0])}</em>` +
          `<span class="${up ? "up" : "down"}">${fmt(k[4])}</span> ` +
          `<span style="color:#98a2b3">H ${fmt(k[2])} · L ${fmt(k[3])}</span>`;
      }
      this.draw(this.progress);
    }
  }

  /* ============================================================
     market-picture scatter
     ============================================================ */
  class Scatter {
    constructor(canvas, tip) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.tip = tip;
      this.dots = [];
      this.points = [];
      this.hot = -1;
      new ResizeObserver(() => { this.resize(); this.draw(); })
        .observe(canvas.parentElement || canvas);
      canvas.addEventListener("mousemove", (e) => this._move(e));
      canvas.addEventListener("mouseleave", () => {
        this.hot = -1; this.tip.hidden = true; this.draw();
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

    setData(dots) {
      this.dots = dots || [];
      this.resize();
      this.draw();
    }

    draw() {
      const c = this.ctx;
      c.clearRect(0, 0, this.w, this.h);
      if (!this.dots.length) return;
      const pad = 16;
      const w = this.w - pad * 2;
      const h = this.h - pad * 2;

      c.strokeStyle = "rgba(255,255,255,.05)";
      c.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const yy = pad + (h / 4) * i;
        c.beginPath(); c.moveTo(pad, yy); c.lineTo(pad + w, yy); c.stroke();
      }
      c.strokeStyle = "rgba(255,255,255,.16)";
      c.beginPath(); c.moveTo(pad + w / 2, pad); c.lineTo(pad + w / 2, pad + h); c.stroke();

      const clamp = (v) => Math.max(-5, Math.min(5, v));
      this.points = this.dots.map((d, i) => {
        const [sym, pct, dir, score] = d;
        const nx = clamp(Number(pct)) / 5;
        const px = pad + w / 2 + nx * (w / 2) * 0.94;
        const seed = [...sym].reduce((a, ch) => a + ch.charCodeAt(0), 0);
        const py = pad + ((seed * 37 + i * 53) % 1000) / 1000 * h;
        return { sym, pct, dir, score, px, py };
      });

      const order = [...this.points].sort((a, b) => a.score - b.score);
      order.forEach((pt) => {
        const bull = pt.dir === "BULL";
        const bear = pt.dir === "BEAR";
        const col = bull ? MINT : bear ? ROSE : "#4a5364";
        const r = 1.9 + Math.min(3.4, Number(pt.score) / 26);
        const isHot = this.hot >= 0 && this.points[this.hot] === pt;
        c.beginPath();
        c.arc(pt.px, pt.py, isHot ? r + 2 : r, 0, Math.PI * 2);
        c.fillStyle = col;
        c.globalAlpha = bull || bear ? 0.9 : 0.5;
        c.shadowColor = col;
        c.shadowBlur = bull || bear ? (isHot ? 18 : 8) : 0;
        c.fill();
        c.shadowBlur = 0;
        c.globalAlpha = 1;
      });
    }

    _move(e) {
      if (!this.points.length) return;
      const r = this.cv.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      let best = -1;
      let dist = 18 * 18;
      this.points.forEach((pt, i) => {
        const d = (pt.px - mx) ** 2 + (pt.py - my) ** 2;
        if (d < dist) { dist = d; best = i; }
      });
      if (best === this.hot) return;
      this.hot = best;
      if (best >= 0) {
        const pt = this.points[best];
        this.tip.hidden = false;
        this.tip.style.left = `${pt.px}px`;
        this.tip.style.top = `${pt.py}px`;
        this.tip.innerHTML = `<b>${pt.sym}</b> &nbsp;${pctTxt(pt.pct)}`;
      } else {
        this.tip.hidden = true;
      }
      this.draw();
    }
  }

  /* ============================================================
     state + feed
     ============================================================ */
  const state = {
    symbol: "NIFTY 50",
    topSymbol: "",
    pulse: null,
    lastPulse: 0,
    heroReady: false,
    charts: {},
  };

  const hero = new PriceChart($("#heroChart"), { tip: $("#chartTip") });
  const mini = new PriceChart($("#miniOb"), { mini: true, hover: false });
  const scatter = new Scatter($("#scatter"), $("#scatterTip"));

  async function loadChart(symbol) {
    const sym = symbol || state.symbol;
    try {
      const r = await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}`);
      const data = await r.json();
      state.symbol = data.symbol;
      state.heroReady = true;
      hero.setData(data);
      $("#chartSym").textContent = data.symbol;
      $("#chartSub").textContent =
        `${data.label || (data.demo ? "sample" : "live")} · 5m · ${pctTxt(data.pct)}`;
      $$("#chartTabs .tab").forEach((b) =>
        b.classList.toggle("active", b.dataset.sym === data.symbol));
      if (!state.charts.mini) {
        mini.setData(data);
        state.charts.mini = true;
      }
    } catch (_) { /* keep the last frame */ }
  }

  function renderTape(indices) {
    if (!indices.length) return;
    const build = () => indices.map((ix) => {
      const up = Number(ix.pct) >= 0;
      return `<span class="tape-item ${up ? "up" : "down"}">
        <b>${ix.name.replace("NIFTY ", "NIFTY · ")}</b>
        <span class="pct">${pctTxt(ix.pct)}</span></span>`;
    }).join("");
    $("#tape").innerHTML = build() + build();
  }

  function applyFeedState(demo) {
    const chip = $("#feedChip");
    chip.classList.toggle("live", !demo);
    chip.querySelector("span").textContent = demo ? "Sample" : "Live";
    $("#footState").textContent = demo ? "Sample feed" : "Live · Upstox";
    if (!demo) {
      const btn = $("#navCta");
      btn.classList.add("connected");
      btn.textContent = "Broker connected";
      const heroBtn = $("#heroConnect");
      heroBtn.classList.add("connected");
      heroBtn.textContent = "Broker connected";
      const cta = $("#ctaConnect");
      const board = document.querySelector('.cta-band a[href="/board"]');
      if (board) {
        cta.hidden = true;
        board.classList.remove("btn-quiet");
        board.classList.add("btn");
      }
    }
  }

  /* ---------- live board ---------- */
  const GRADE_COLOR = {
    ELITE: "#6cf5c2", STRONG: "#67d8ff", OK: "#b9c6dd",
    THIN: "#ffb020", AVOID: "#5d6675",
  };

  function tween(el, to, suffix = "") {
    if (!el) return;
    const from = Number(el.dataset.v ?? el.textContent.replace(/[^\d.-]/g, "")) || 0;
    el.dataset.v = String(to);
    if (from === to) { el.textContent = to + suffix; return; }
    const t0 = performance.now();
    const dur = 620;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function railRow(item, dir) {
    const g = item.grade || "";
    const color = GRADE_COLOR[g] || "transparent";
    return `<div class="r-main"><b>${item.symbol}</b>` +
      `<em>${item.sector || "f&amp;o"}</em></div>` +
      `<span class="r-bar"><i style="width:0%"></i></span>` +
      `<span class="grade" style="color:${color};${g ? "" : "display:none"}">${g}</span>` +
      `<span class="r-pct ${item.pct >= 0 ? "up" : "down"}">` +
      `${pctTxt(item.pct)}</span>`;
  }

  function renderRail(listEl, items, dir) {
    if (!listEl) return;
    const prev = new Map();
    [...listEl.children].forEach((el) =>
      prev.set(el.dataset.sym, el.getBoundingClientRect().top));

    const keep = new Set(items.map((i) => i.symbol));
    [...listEl.children].forEach((el) => {
      if (!keep.has(el.dataset.sym)) el.remove();
    });

    items.forEach((item, idx) => {
      let el = listEl.querySelector(`[data-sym="${item.symbol}"]`);
      const fresh = !el;
      if (!el) {
        el = document.createElement("li");
        el.className = "rail-row enter";
        el.dataset.sym = item.symbol;
        el.innerHTML = railRow(item, dir);
      }
      el.querySelector(".r-bar i").style.width = `${Math.min(100, item.score)}%`;
      el.querySelector(".r-main em").textContent = item.sector || "f&o";
      el.querySelector(".r-pct").textContent = pctTxt(item.pct);
      el.querySelector(".r-pct").className =
        `r-pct ${item.pct >= 0 ? "up" : "down"}`;
      const gradeEl = el.querySelector(".grade");
      if (item.grade) {
        gradeEl.style.display = "";
        gradeEl.textContent = item.grade;
        gradeEl.style.color = GRADE_COLOR[item.grade] || "#b9c6dd";
      }
      listEl.appendChild(el);
      if (fresh) setTimeout(() => el.classList.remove("enter"), 600);
    });

    [...listEl.children].forEach((el) => {
      const was = prev.get(el.dataset.sym);
      if (was == null) return;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1.5) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform .55s cubic-bezier(.2,.7,.2,1)";
        el.style.transform = "";
      });
    });
  }

  function renderFeed(items) {
    const box = $("#feed");
    if (!box || !items) return;
    const key = (i) => `${i.symbol}:${i.dir}`;
    const existing = new Map([...box.children].map((el) => [el.dataset.k, el]));
    const keep = new Set(items.map(key));
    [...box.children].forEach((el) => {
      if (!keep.has(el.dataset.k)) el.remove();
    });
    items.forEach((it, idx) => {
      let el = existing.get(key(it));
      if (!el) {
        el = document.createElement("article");
        el.className = "feed-card";
        el.dataset.k = key(it);
        el.dataset.dir = it.dir;
        el.innerHTML =
          `<div class="fc-top"><b>${esc(it.symbol)}</b>` +
          `<span class="fc-age"></span></div>` +
          `<div class="fc-mid"><span class="badge ${it.dir === "BULL" ? "bull" : "bear"}">` +
          `${it.dir === "BULL" ? "\u25b2 BULL" : "\u25bc BEAR"}</span>` +
          (it.grade ? `<span class="grade" style="color:${GRADE_COLOR[it.grade] || "#b9c6dd"}">${it.grade}</span>` : "") +
          `</div>`;
      }
      const age = it.age < 5 ? "now" : it.age < 60 ? `${it.age}s` : `${Math.round(it.age / 60)}m`;
      el.querySelector(".fc-age").textContent = age;
      box.appendChild(el);
    });
  }

  function renderSectors(items) {
    const box = $("#sectors");
    if (!box || !items) return;
    const existing = new Map([...box.children].map((el) => [el.dataset.k, el]));
    const keep = new Set(items.map((s) => s.name));
    [...box.children].forEach((el) => {
      if (!keep.has(el.dataset.k)) el.remove();
    });
    const max = Math.max(1, ...items.map((s) => Math.abs(s.avg)));
    items.forEach((s) => {
      let el = existing.get(s.name);
      if (!el) {
        el = document.createElement("div");
        el.className = "sector-chip";
        el.dataset.k = s.name;
        el.innerHTML = `<div class="sc-top"><span></span><em></em></div>` +
          `<div class="sc-bar"><i style="width:0%"></i></div>`;
      }
      el.classList.toggle("neg", s.avg < 0);
      el.querySelector("span").textContent = s.name.replace("NIFTY ", "");
      const pctEl = el.querySelector("em");
      pctEl.textContent = pctTxt(s.avg);
      pctEl.className = s.avg >= 0 ? "up" : "down";
      el.querySelector("i").style.width =
        `${Math.round(Math.abs(s.avg) / max * 100)}%`;
      box.appendChild(el);
    });
  }

  async function loadPulse() {
    try {
      const r = await fetch("/api/pulse");
      const p = await r.json();
      state.pulse = p;
      state.lastPulse = Date.now();
      renderTape(p.indices);
      scatter.setData(p.dots);
      applyFeedState(p.demo);
      tween($("#statScored"), p.stats.scored || 0);
      tween($("#statBull"), p.stats.bull || 0);
      tween($("#statBear"), p.stats.bear || 0);
      tween($("#liveCount"), p.stats.universe || 0);
      tween($("#bullCount"), p.stats.bull || 0);
      tween($("#bearCount"), p.stats.bear || 0);
      $("#statSession").textContent = p.session || "—";
      renderRail($("#bullList"), p.bulls || [], "BULL");
      renderRail($("#bearList"), p.bears || [], "BEAR");
      renderFeed((p.feed || []).slice(0, 8));
      renderSectors(p.sectors || []);
      const top = (p.bulls && p.bulls[0]) || null;
      if (top) {
        state.topSymbol = top.symbol;
        const tab = $("#topTab");
        tab.hidden = false;
        tab.dataset.sym = top.symbol;
        tab.textContent = `TOP \u00b7 ${top.symbol}`;
      }
    } catch (e) { console.warn("pulse", e); }
  }

  /* ============================================================
     page wiring
     ============================================================ */
  $$("#chartTabs .tab").forEach((b) => {
    b.addEventListener("click", () => {
      if (!b.dataset.sym) return;
      loadChart(b.dataset.sym);
    });
  });

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.16 });
  $$(".reveal").forEach((el) => io.observe(el));

  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("stuck", window.scrollY > 12);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  $("#year").textContent = String(new Date().getFullYear());

  // smooth anchors
  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // live sync label + chart heartbeat
  setInterval(() => {
    const el = $("#liveSync");
    if (!el || !state.lastPulse) return;
    const s = Math.round((Date.now() - state.lastPulse) / 1000);
    el.textContent = s < 2 ? "synced" : `synced ${s}s ago`;
  }, 1000);
  setInterval(() => { if (state.heroReady) hero.draw(1); }, 900);

  // boot
  loadChart("NIFTY 50");
  loadPulse();
  setInterval(loadPulse, 8000);
  setInterval(() => loadChart(state.symbol), 30000);
})();
