/* ==========================================================================
   Terminal — chart workspace app.
   Vanilla JS, canvas renderer, no dependencies.
   ========================================================================== */
'use strict';

/* ------------------------------- helpers -------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TZONES = [
  ['Asia/Kolkata', 'UTC+5:30', 'India'], ['UTC', 'UTC', 'UTC'],
  ['Asia/Dubai', 'UTC+4', 'Dubai'], ['Asia/Singapore', 'UTC+8', 'Singapore'],
  ['Asia/Hong_Kong', 'UTC+8', 'Hong Kong'], ['Asia/Tokyo', 'UTC+9', 'Tokyo'],
  ['Australia/Sydney', 'UTC+11', 'Sydney'], ['Europe/London', 'UTC', 'London'],
  ['Europe/Frankfurt', 'UTC+1', 'Frankfurt'],
  ['America/New_York', 'UTC−5', 'New York'],
  ['America/Chicago', 'UTC−6', 'Chicago'],
  ['America/Los_Angeles', 'UTC−8', 'Los Angeles'],
];
let TZ = 'Asia/Kolkata';

function buildDTF(tz) {
  const o = { timeZone: tz };
  return {
    hm: new Intl.DateTimeFormat('en-GB', {
      ...o, hour: '2-digit', minute: '2-digit', hour12: false,
    }),
    clock: new Intl.DateTimeFormat('en-GB', {
      ...o, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }),
    dmy: new Intl.DateTimeFormat('en-GB', { ...o, day: '2-digit', month: 'short' }),
    dmyy: new Intl.DateTimeFormat('en-GB', {
      ...o, day: '2-digit', month: 'short', year: '2-digit',
    }),
    full: new Intl.DateTimeFormat('en-GB', {
      ...o, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      hour12: false,
    }),
    month: new Intl.DateTimeFormat('en-GB', { ...o, month: 'short', year: '2-digit' }),
    monthOnly: new Intl.DateTimeFormat('en-GB', { ...o, month: 'short' }),
    year: new Intl.DateTimeFormat('en-GB', { ...o, year: 'numeric' }),
  };
}
let DTF = buildDTF(TZ);

function applyTimezone(tz) {
  TZ = tz;
  DTF = buildDTF(tz);
  state.settings.tz = tz;
  const zone = TZONES.find((z) => z[0] === tz) || TZONES[0];
  const btn = $('#tzBtn');
  if (btn) { btn.textContent = zone[1]; btn.title = tz; }
  schedule();
  saveSoon();
}

function fmtPrice(v, digits) {
  const d = digits ?? state.digits ?? 2;
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtCompact(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
function fmtPct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

async function api(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(path + qs, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(path + ' → ' + res.status);
  return res.json();
}

/* ------------------------------- palettes ------------------------------- */
const PAL = {
  dark: {
    bg: '#131722', panel: '#1a1e2a', line: '#2a2e39', line2: '#363a45',
    text: '#d1d4dc', text2: '#8b90a0', text3: '#5c6170', grid: '#1c202b',
    accent: '#2962ff', up: '#26a69a', down: '#ef5350', draw: '#e8b34a',
  },
  light: {
    bg: '#ffffff', panel: '#f7f8fa', line: '#e0e3eb', line2: '#d1d4dc',
    text: '#131722', text2: '#606273', text3: '#9598a1', grid: '#eef1f6',
    accent: '#2962ff', up: '#089981', down: '#f23645', draw: '#b57b00',
  },
};

const INTERVALS = [
  ['1m', '1 minute'], ['3m', '3 minutes'], ['5m', '5 minutes'],
  ['15m', '15 minutes'], ['30m', '30 minutes'], ['1h', '1 hour'],
  ['1d', '1 day'], ['1w', '1 week'], ['1M', '1 month'],
];
const IV_LABEL = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '1d': '1D', '1w': '1W', '1M': '1M' };

const CHART_TYPES = [
  ['candles', 'Candles'], ['hollow', 'Hollow candles'], ['bars', 'Bars'],
  ['highlow', 'High-low'], ['columns', 'Columns'], ['line', 'Line'],
  ['area', 'Area'], ['baseline', 'Baseline'], ['heikin', 'Heikin Ashi'],
];

/* -------------------------------- state --------------------------------- */
const state = {
  symbol: 'NIFTY 50',
  name: 'Nifty 50 Index',
  meta: null,
  interval: '1d',
  chartType: 'candles',
  bars: [],
  digits: 2,
  source: 'sample',
  indicators: [],
  drawings: [],
  tool: 'cursor',
  magnet: false,
  keepDrawing: false,
  lockAll: false,
  hideAll: false,
  selection: null,
  view: { offset: 0, spacing: 8 },
  crosshair: null,
  drag: null,
  temp: null,
  compare: null,
  auth: { authorized: false, message: '', live: false },
  dataVersion: 0,
  panel: 'watchlist',
  watchlist: [],
  quotes: {},
  alerts: [],
  replay: { on: false, index: 0, playing: false, timer: null, speed: 420, picking: false },
  wlSort: 'manual', wlCollapsed: {},
  settings: {
    theme: 'dark', grid: true, crosshair: true, volume: true,
    scale: 'linear', up: '#26a69a', down: '#ef5350',
    lastPriceLine: true, watermark: true, rightPad: 6,
    priceStretch: 1, priceShift: 0, tz: 'Asia/Kolkata', wlPct: true,
  },
};

const DEFAULTS_WATCHLIST = ['NIFTY 50', 'NIFTY BANK', 'SENSEX', 'NIFTY IT',
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BTCUSD', 'ETHUSD', 'USDINR'];

/* ------------------------------- storage -------------------------------- */
const LS_KEY = 'ob.terminal.v1';

function drawingsKey() { return state.symbol + '|' + state.interval; }

function saveState() {
  try {
    const payload = {
      symbol: state.symbol,
      interval: state.interval,
      chartType: state.chartType,
      settings: state.settings,
      indicators: state.indicators,
      watchlist: state.watchlist,
      alerts: state.alerts,
      panel: state.panel,
      drawingsByKey: readAllDrawings(),
    };
    payload.drawingsByKey[drawingsKey()] = state.drawings;
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch (e) { /* quota — ignore */ }
}

function readAllDrawings() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return raw.drawingsByKey || {};
  } catch (e) { return {}; }
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (raw.settings) Object.assign(state.settings, raw.settings);
    if (raw.chartType) state.chartType = raw.chartType;
    if (raw.interval) state.interval = raw.interval;
    if (raw.symbol) state.symbol = raw.symbol;
    if (Array.isArray(raw.indicators)) state.indicators = raw.indicators;
    if (Array.isArray(raw.alerts)) state.alerts = raw.alerts;
    if (Array.isArray(raw.watchlist) && raw.watchlist.length) {
      state.watchlist = raw.watchlist;
    }
    if (raw.panel) state.panel = raw.panel;
    const all = raw.drawingsByKey || {};
    state.drawings = all[state.symbol + '|' + state.interval] || [];
  } catch (e) { /* fresh start */ }
  if (!state.watchlist.length) {
    state.watchlist = DEFAULTS_WATCHLIST.map((s) => ({ symbol: s }));
  }
}

const saveSoon = (() => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(saveState, 350); };
})();

/* -------------------------------- chart --------------------------------- */
const canvas = $('#chartCanvas');
const ctx = canvas.getContext('2d');
const AXIS_W = 68;
const AXIS_H = 22;

const chart = {
  W: 0, H: 0, panes: [], theme: PAL.dark, hover: null, raf: 0,
};

function C() { return PAL[state.settings.theme] || PAL.dark; }
function plotW() { return Math.max(10, chart.W - AXIS_W); }
function plotH() { return Math.max(10, chart.H - AXIS_H); }
function pricePane() {
  return chart.panes[0] || { id: 'price', top: 0, height: plotH(), scale: { min: 0, max: 1, type: 'linear' } };
}

const _barsCache = { key: '', val: [] };
function activeBars() {
  const key = state.dataVersion + '|' +
    (state.replay.on ? 'r' + state.replay.index : 'all');
  if (_barsCache.key !== key) {
    _barsCache.key = key;
    _barsCache.val = state.replay.on
      ? state.bars.slice(0, Math.max(1, state.replay.index))
      : state.bars;
  }
  return _barsCache.val;
}

function visibleCount() { return Math.max(1, Math.floor(plotW() / state.view.spacing)); }

function xOf(i) { return (i - state.view.offset + 0.5) * state.view.spacing; }
function iOf(x) { return x / state.view.spacing + state.view.offset - 0.5; }

function pToY(p, pane) {
  const s = pane.scale, h = pane.height;
  if (s.type === 'log') {
    const lo = Math.log(Math.max(s.min, 1e-9)), hi = Math.log(Math.max(s.max, 1e-9));
    const t = (Math.log(Math.max(p, 1e-9)) - lo) / ((hi - lo) || 1);
    return pane.top + (1 - t) * h;
  }
  return pane.top + (1 - (p - s.min) / ((s.max - s.min) || 1)) * h;
}
function yToP(y, pane) {
  const s = pane.scale, h = pane.height;
  const t = 1 - (y - pane.top) / (h || 1);
  if (s.type === 'log') {
    const lo = Math.log(Math.max(s.min, 1e-9)), hi = Math.log(Math.max(s.max, 1e-9));
    return Math.exp(lo + t * (hi - lo));
  }
  return s.min + t * (s.max - s.min);
}

function resize() {
  const wrap = $('#chartWrap');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, wrap.clientWidth), h = Math.max(160, wrap.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chart.W = w; chart.H = h;
  if (!state.view.spacing || state.view.spacing < 1) fitView();
  clampView();
  schedule();
}

function schedule() {
  if (chart.raf) return;
  chart.raf = requestAnimationFrame(() => { chart.raf = 0; render(); });
}

function fitView(showBars) {
  const bars = activeBars();
  const n = bars.length;
  if (!n) return;
  const want = Math.min(n, showBars || (state.interval === '1d' || state.interval === '1w' || state.interval === '1M' ? 160 : 220));
  state.view.spacing = clamp(plotW() / Math.max(20, want), 1.8, 42);
  state.view.offset = Math.max(0, n - plotW() / state.view.spacing)
    + (state.settings.rightPad ?? 6);
  clampView();
}

function maxOffset() {
  const n = activeBars().length;
  const pad = state.settings.rightPad ?? 6;
  return Math.max(0, n - visibleCount() + pad);
}

function atRightEdge(slack = 1.2) {
  return maxOffset() - state.view.offset <= slack;
}

function clampView() {
  state.view.offset = clamp(state.view.offset, 0, maxOffset());
  state.view.spacing = clamp(state.view.spacing, 1.6, 60);
}

/* --------------------------- indicator pipeline ------------------------- */
function subIndicators() {
  return state.indicators.filter((i) => {
    const def = window.Indicators.DEFS[i.type];
    return def && def.pane === 'sub' && i.visible !== false;
  });
}

function mainIndicators() {
  return state.indicators.filter((i) => {
    const def = window.Indicators.DEFS[i.type];
    return def && def.pane === 'main' && i.visible !== false;
  });
}

function recomputeIndicators() {
  const bars = state.bars;
  state.indicators.forEach((ind) => {
    ind._calc = bars.length ? window.Indicators.compute(ind, bars) : { lines: [] };
  });
}

function computePanes() {
  const subs = subIndicators();
  const ph = plotH();
  const per = subs.length ? clamp(ph * 0.17, 52, 132) : 0;
  let subTotal = per * subs.length;
  if (subTotal > ph * 0.56) subTotal = ph * 0.56;
  const priceH = Math.max(60, ph - subTotal);
  const panes = [{ id: 'price', kind: 'price', top: 0, height: priceH }];
  const each = subs.length ? (ph - priceH) / subs.length : 0;
  subs.forEach((ind, i) => {
    panes.push({
      id: 'sub' + i, kind: 'sub', ind,
      top: priceH + i * each, height: each,
      calc: ind._calc || { lines: [] },
    });
  });
  panes.forEach((p) => { p.scale = computeScale(p); });
  chart.panes = panes;
}

function computeScale(pane) {
  const bars = activeBars();
  const start = Math.max(0, Math.floor(state.view.offset));
  const end = Math.min(bars.length - 1, Math.ceil(state.view.offset + visibleCount() + 1));
  let min = Infinity, max = -Infinity;

  if (pane.kind === 'price') {
    for (let i = start; i <= end; i++) {
      if (!bars[i]) continue;
      min = Math.min(min, bars[i].l);
      max = Math.max(max, bars[i].h);
    }
    mainIndicators().forEach((ind) => {
      const calc = ind._calc;
      if (!calc) return;
      calc.lines.forEach((ln) => {
        for (let i = start; i <= end; i++) {
          const v = ln.vals[i];
          if (v !== null && v !== undefined && isFinite(v)) {
            min = Math.min(min, v); max = Math.max(max, v);
          }
        }
      });
    });
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    min -= pad; max += pad;
    const stretch = state.settings.priceStretch || 1;
    const mid = (min + max) / 2;
    const shift = (state.settings.priceShift || 0) * (max - min);
    min = mid - (mid - min) * stretch - shift;
    max = mid + (max - mid) * stretch - shift;
  } else {
    const calc = pane.calc || { lines: [] };
    calc.lines.forEach((ln) => {
      for (let i = start; i <= end; i++) {
        const v = ln.vals[i];
        if (v !== null && v !== undefined && isFinite(v)) {
          min = Math.min(min, v); max = Math.max(max, v);
        }
      }
    });
    const def = window.Indicators.DEFS[pane.ind.type] || {};
    if (def.fixed) { min = def.fixed[0]; max = def.fixed[1]; }
    else if (pane.ind.type === 'volume') { min = 0; max = max * 1.1 || 1; }
    else if (!isFinite(min)) { min = 0; max = 1; }
    else {
      if (min > 0) min = 0;
      const pad = (max - min) * 0.12 || 1;
      max += pad;
      if (min < 0) min -= pad;
    }
  }
  const type = pane.kind === 'price' ? state.settings.scale : 'linear';
  if (type === 'log') { min = Math.max(min, 1e-6); }
  return { min, max, type };
}

/* -------------------------------- render -------------------------------- */
function niceTicks(min, max, want) {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 2 ? 2.5 : norm >= 1 ? 2 : 1) * mag;
  const first = Math.ceil(min / step) * step;
  const out = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

function priceAxisText(v) {
  if (state.settings.scale === 'percent') {
    const base = chart._basePrice;
    return base ? ((v / base - 1) * 100).toFixed(2) + '%' : fmtPrice(v);
  }
  return fmtPrice(v);
}

function render() {
  if (!chart.W || !chart.H) return;
  const bars = activeBars();
  const c = C();
  chart.theme = c;
  const W = chart.W, H = chart.H, pw = plotW(), ph = plotH();

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  if (!bars.length) { drawEmpty(); return; }

  computePanes();

  // base price for percent scale
  const firstIdx = Math.max(0, Math.floor(state.view.offset));
  chart._basePrice = (firstIdx > 0 ? bars[firstIdx - 1] : bars[firstIdx])?.c || 1;

  const panes = chart.panes;
  const pp = panes[0];

  /* ---- grid + axis background ---- */
  const ticks = panes.map((p) => niceTicks(p.scale.min, p.scale.max, p.kind === 'price' ? 6 : 3));
  if (state.settings.grid) {
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    panes.forEach((p, pi) => {
      const list = ticks[pi];
      list.forEach((v) => {
        const y = Math.round(pToY(v, p)) + 0.5;
        if (y < p.top || y > p.top + p.height) return;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
      });
    });
  }

  // vertical grid from real time boundaries (session start, month, ...)
  const tTicks = timeTicks(bars);
  if (state.settings.grid) {
    ctx.strokeStyle = c.grid;
    tTicks.forEach((t) => {
      const x = Math.round(xOf(t.i)) + 0.5;
      if (x < 0 || x > pw) return;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
    });
  }

  /* ---- volume histogram behind the price (TradingView overlay) ---- */
  if (state.settings.volume && bars.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, pp.top, pw, pp.height); ctx.clip();
    drawVolume(bars, pp);
    ctx.restore();
  }

  /* ---- series ---- */
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, pw, pp.height); ctx.clip();
  drawSeries(bars, pp);
  mainIndicators().forEach((ind) => drawIndicatorOnPane(ind._calc, pp, bars));
  if (state.compare && state.compare.bars && state.compare.bars.length) drawCompare(pp);
  ctx.restore();

  // drawings
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, pw, pp.height); ctx.clip();
  const G = {
    x: xOf, y: (p) => pToY(p, pp), W: pw, H: pp.top + pp.height,
    fmt: (v) => fmtPrice(v), colors: c,
  };
  state.drawings.forEach((d) => {
    if (state.hideAll) return;
    window.Drawings.drawOne(ctx, d, G);
  });
  if (state.selection) {
    const d = state.drawings.find((x) => x.id === state.selection);
    if (d) window.Drawings.drawSelection(ctx, d, G);
  }
  if (state.temp) window.Drawings.drawOne(ctx, state.temp, G);
  ctx.restore();

  /* ---- sub panes ---- */
  panes.slice(1).forEach((p) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, p.top, pw, p.height); ctx.clip();
    // separator
    ctx.strokeStyle = c.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(p.top) + 0.5);
    ctx.lineTo(pw, Math.round(p.top) + 0.5); ctx.stroke();
    drawPaneSeries(p);
    ctx.restore();
  });

  /* ---- alerts (price pane) ---- */
  state.alerts.filter((a) => a.symbol === state.symbol && !a.triggered).forEach((a) => {
    const y = pToY(a.price, pp);
    if (y < pp.top || y > pp.top + pp.height) return;
    ctx.save();
    ctx.strokeStyle = '#e8b34a'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8b34a';
    ctx.beginPath();
    ctx.moveTo(pw - 1, y); ctx.lineTo(pw - 7, y - 5);
    ctx.lineTo(pw - 7, y + 5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e8b34a';
    ctx.fillRect(pw, y - 8, AXIS_W, 16);
    ctx.fillStyle = '#131722';
    ctx.font = '10.5px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(a.price), pw + 5, y);
    ctx.restore();
  });

  /* ---- axes ---- */
  drawPriceAxis(panes, ticks);
  drawTimeAxis(bars, tTicks);

  /* ---- last price ---- */
  const last = bars[bars.length - 1];
  if (state.settings.lastPriceLine && last) {
    const y = pToY(last.c, pp);
    const up = last.c >= last.o;
    const col = up ? c.up : c.down;
    ctx.save();
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.fillRect(pw, y - 9, AXIS_W, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(priceAxisText(last.c), pw + 5, y);
    ctx.restore();
  }

  /* ---- crosshair ---- */
  if (state.crosshair) drawCrosshair();

  /* ---- watermark ---- */
  if (state.settings.watermark && bars === state.bars) {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = c.text;
    ctx.textAlign = 'center';
    ctx.font = '600 40px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(state.symbol, pw / 2, pp.height / 2 - 10);
    ctx.font = '400 20px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(`${IV_LABEL[state.interval] || state.interval} · ${state.name}`, pw / 2, pp.height / 2 + 22);
    ctx.restore();
  }

  /* ---- legends ---- */
  renderLegends(bars, panes);
  $('#goLive').hidden = atRightEdge() || state.replay.on;
}

function drawEmpty() {
  const c = C();
  ctx.fillStyle = c.text2;
  ctx.font = '13px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No data — pick a symbol from the watchlist or press Ctrl+K',
    plotW() / 2, chart.H / 2);
  ctx.textAlign = 'left';
}

function heikin(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = i === 0 ? (b.o + b.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ t: b.t, o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), v: b.v });
  }
  return out;
}

function drawSeries(bars, pane) {
  const c = C(), s = state.settings, sp = state.view.spacing;
  const start = Math.max(0, Math.floor(state.view.offset));
  const end = Math.min(bars.length - 1, Math.ceil(state.view.offset + visibleCount() + 1));
  const type = state.chartType;
  const bw = clamp(sp * 0.72, 1, 34);
  const up = s.up, down = s.down;

  if (type === 'columns') {
    const bwPx = Math.max(1, Math.round(sp * 0.72));
    let prior = bars[start] ? bars[start].c : 0;
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b) continue;
      const y = pToY(b.c, pane);
      ctx.fillStyle = b.c >= prior ? up : down;
      ctx.fillRect(Math.round(xOf(i) - bwPx / 2), Math.round(y), bwPx,
        Math.max(1, Math.round(pane.top + pane.height - y)));
      prior = b.c;
    }
    return;
  }

  if (type === 'highlow') {
    for (let i = start; i <= end; i++) {
      const b = bars[i];
      if (!b) continue;
      const x = Math.round(xOf(i)) + 0.5;
      const hi = pToY(b.h, pane), lo = pToY(b.l, pane), cl = pToY(b.c, pane);
      ctx.strokeStyle = b.c >= b.o ? up : down;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, hi); ctx.lineTo(x, lo); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, cl); ctx.lineTo(x + 4, cl); ctx.stroke();
    }
    return;
  }

  if (type === 'baseline') {
    const base = bars[start] ? bars[start].c : 0;
    const yBase = pToY(base, pane);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = c.line2;
    ctx.beginPath(); ctx.moveTo(0, yBase); ctx.lineTo(plotW(), yBase); ctx.stroke();
    ctx.restore();
    for (let i = start; i < end; i++) {
      const a = bars[i], b2 = bars[i + 1];
      if (!a || !b2) continue;
      ctx.strokeStyle = b2.c >= base ? up : down;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(xOf(i), pToY(a.c, pane));
      ctx.lineTo(xOf(i + 1), pToY(b2.c, pane));
      ctx.stroke();
    }
    return;
  }

  if (type === 'line' || type === 'area') {
    let prev = null;
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const b = bars[i]; if (!b) continue;
      const x = xOf(i), y = pToY(b.c, pane);
      if (prev === null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = [x, y];
    }
    ctx.strokeStyle = c.accent; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();
    if (type === 'area') {
      ctx.lineTo(xOf(end), pane.top + pane.height);
      ctx.lineTo(xOf(start), pane.top + pane.height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, pane.top, 0, pane.top + pane.height);
      grad.addColorStop(0, 'rgba(41,98,255,.34)');
      grad.addColorStop(1, 'rgba(41,98,255,0)');
      ctx.fillStyle = grad; ctx.fill();
    }
    return;
  }

  const src = type === 'heikin' ? heikin(bars) : bars;
  const lineMode = sp < 2.6;

  for (let i = start; i <= end; i++) {
    const b = src[i]; if (!b) continue;
    const x = xOf(i), o = pToY(b.o, pane), cl = pToY(b.c, pane),
      hi = pToY(b.h, pane), lo = pToY(b.l, pane);
    const bull = b.c >= b.o;
    const col = bull ? up : down;

    if (type === 'bars') {
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, sp * 0.14);
      ctx.beginPath();
      ctx.moveTo(x, hi); ctx.lineTo(x, lo);
      ctx.moveTo(x - bw / 2, o); ctx.lineTo(x, o);
      ctx.moveTo(x, cl); ctx.lineTo(x + bw / 2, cl);
      ctx.stroke();
      continue;
    }

    const wx = Math.round(x) + 0.5;
    if (lineMode) {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, sp * 0.8);
      ctx.beginPath(); ctx.moveTo(wx, hi); ctx.lineTo(wx, lo); ctx.stroke();
      continue;
    }

    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wx, Math.round(hi));
    ctx.lineTo(wx, Math.round(lo));
    ctx.stroke();

    const bwPx = Math.max(1, Math.round(bw));
    const bx = Math.round(x - bwPx / 2);
    const top = Math.round(Math.min(o, cl));
    const height = Math.max(1, Math.round(Math.abs(cl - o)));
    if (type === 'hollow') {
      ctx.fillStyle = c.bg;
      ctx.fillRect(bx, top, bwPx, height);
      ctx.strokeStyle = col;
      ctx.strokeRect(bx + 0.5, top + 0.5,
        Math.max(1, bwPx - 1), Math.max(1, height - 1));
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(bx, top, bwPx, height);
    }
  }
}

function drawIndicatorOnPane(calc, pane, bars) {
  if (!calc || !calc.lines) return;
  calc.lines.forEach((ln) => {
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = ln.width || 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, Math.floor(state.view.offset));
      i <= Math.min(bars.length - 1, state.view.offset + visibleCount() + 1); i++) {
      const v = ln.vals[i];
      if (v === null || v === undefined) { started = false; continue; }
      const x = xOf(i), y = pToY(v, pane);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

function drawPaneSeries(pane) {
  const c = C();
  const calc = pane.calc || { lines: [] };
  const zero = pToY(clamp(0, pane.scale.min, pane.scale.max), pane);
  const def = window.Indicators.DEFS[pane.ind.type] || {};

  (def.levels || []).forEach((lv) => {
    const y = pToY(lv, pane);
    ctx.save();
    ctx.strokeStyle = c.line2; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW(), y); ctx.stroke();
    ctx.restore();
  });

  calc.lines.forEach((ln) => {
    if (ln.kind === 'hist') {
      const bw = clamp(state.view.spacing * 0.62, 1, 20);
      for (let i = Math.max(0, Math.floor(state.view.offset));
        i <= Math.min(activeBars().length - 1, state.view.offset + visibleCount() + 1); i++) {
        const v = ln.vals[i];
        if (v === null || v === undefined) continue;
        const y = pToY(v, pane);
        const x = xOf(i);
        ctx.fillStyle = ln.color;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x - bw / 2, Math.min(y, zero), bw, Math.max(1, Math.abs(y - zero)));
        ctx.globalAlpha = 1;
      }
      return;
    }
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = ln.width || 1.5;
    ctx.beginPath();
    let started = false;
    const n = activeBars().length;
    for (let i = Math.max(0, Math.floor(state.view.offset));
      i <= Math.min(n - 1, state.view.offset + visibleCount() + 1); i++) {
      const v = ln.vals[i];
      if (v === null || v === undefined) { started = false; continue; }
      const x = xOf(i), y = pToY(v, pane);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

function drawCompare(pane) {
  const bars = activeBars();
  const cmp = state.compare.bars;
  const baseIdx = Math.max(0, Math.floor(state.view.offset));
  const base = bars[Math.min(baseIdx, bars.length - 1)];
  if (!base || !cmp.length) return;
  const anchor = cmp[0].c;
  ctx.save();
  ctx.strokeStyle = '#ff9800';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 3]);
  ctx.beginPath();
  let started = false;
  const len = Math.min(cmp.length, bars.length);
  for (let i = Math.max(0, Math.floor(state.view.offset));
    i <= Math.min(len - 1, state.view.offset + visibleCount() + 1); i++) {
    const mapped = base.c * (cmp[i].c / anchor);
    const x = xOf(i), y = pToY(mapped, pane);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPriceAxis(panes, ticks) {
  const c = C(), W = chart.W, pw = plotW();
  const all = activeBars();
  const last = all[all.length - 1];
  const lastY = last && panes[0] ? pToY(last.c, panes[0]) : -1e9;
  ctx.save();
  ctx.fillStyle = c.panel;
  ctx.fillRect(pw, 0, AXIS_W, chart.H);
  ctx.strokeStyle = c.line;
  ctx.beginPath(); ctx.moveTo(pw + 0.5, 0); ctx.lineTo(pw + 0.5, chart.H); ctx.stroke();

  ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  panes.forEach((p, pi) => {
    const list = ticks[pi] || [];
    ctx.fillStyle = c.text2;
    list.forEach((v) => {
      const y = pToY(v, p);
      if (y < p.top + 6 || y > p.top + p.height - 4) return;
      // keep the scale clear of the last-price tag
      if (p.kind === 'price' && Math.abs(y - lastY) < 11) return;
      const txt = p.kind === 'price' ? priceAxisText(v)
        : (p.ind.type === 'volume' ? fmtCompact(v) : fmtPrice(v, v >= 100 ? 0 : 2));
      ctx.fillText(txt, pw + 6, y);
      ctx.strokeStyle = c.line;
      ctx.beginPath(); ctx.moveTo(pw - 4, Math.round(y) + 0.5);
      ctx.lineTo(pw, Math.round(y) + 0.5); ctx.stroke();
    });
  });
  ctx.restore();
}

function drawTimeAxis(bars, tTicks) {
  const c = C(), pw = plotW(), ph = plotH();
  ctx.save();
  ctx.fillStyle = c.panel;
  ctx.fillRect(0, ph, chart.W, AXIS_H);
  ctx.beginPath(); ctx.moveTo(0, ph + 0.5); ctx.lineTo(chart.W, ph + 0.5);
  ctx.strokeStyle = c.line; ctx.stroke();

  ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.text2;
  tTicks.forEach((t) => {
    if (!bars[t.i]) return;
    const x = xOf(t.i);
    if (x < 24 || x > pw - 24) return;
    ctx.fillText(t.text, x, ph + AXIS_H / 2 + 1);
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, ph);
    ctx.lineTo(Math.round(x) + 0.5, ph + 5);
    ctx.stroke();
  });
  ctx.restore();
}

function drawCrosshair() {
  if (!state.settings.crosshair) return;
  const ch = state.crosshair;
  const bars = activeBars();
  const c = C();
  const pw = plotW(), ph = plotH();
  if (!ch || ch.i < 0 || ch.i >= bars.length) return;
  const x = Math.round(xOf(ch.i)) + 0.5;
  if (x < 0 || x > pw) return;

  ctx.save();
  ctx.strokeStyle = c.text3;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
  const inPlot = ch.y >= 0 && ch.y <= ph;
  if (inPlot) {
    const y = Math.round(ch.y) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  const b = bars[ch.i];
  if (b) {
    const label = DTF.full.format(new Date(b.t)).replace(',', '');
    const w = ctx.measureText(label).width + 12;
    const bx = clamp(x - w / 2, 0, pw - w);
    ctx.fillStyle = c.line2;
    ctx.fillRect(bx, ph + 3, w, 16);
    ctx.strokeStyle = c.line2;
    ctx.strokeRect(bx + 0.5, ph + 3.5, w, 16);
    ctx.fillStyle = c.text;
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + w / 2, ph + 11);
    ctx.textAlign = 'left';
  }

  // value pill on the axis of whichever pane the cursor is over
  if (inPlot) {
    const pane = chart.panes.find((p) => ch.y >= p.top && ch.y <= p.top + p.height)
      || pricePane();
    const value = yToP(ch.y, pane);
    const label = pane.kind === 'price' ? priceAxisText(value)
      : (pane.ind && pane.ind.type === 'volume' ? fmtCompact(value) : fmtPrice(value, 2));
    ctx.fillStyle = c.line2;
    ctx.fillRect(pw, ch.y - 9, AXIS_W, 18);
    ctx.strokeStyle = c.line2;
    ctx.strokeRect(pw + 0.5, ch.y - 9, AXIS_W, 18);
    ctx.fillStyle = c.text;
    ctx.fillText(label, pw + 5, ch.y);
  }
  ctx.restore();
}

function timeTicks(bars) {
  const start = Math.max(0, Math.floor(state.view.offset));
  const end = Math.min(bars.length - 1,
    Math.ceil(state.view.offset + visibleCount() + 1));
  const intraday = ['1m', '3m', '5m', '15m', '30m', '1h'].includes(state.interval);
  const dayKey = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const cands = [];

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const prev = bars[i - 1];
    const d = new Date(b.t);
    if (intraday) {
      if (!prev || dayKey(prev.t) !== dayKey(b.t)) {
        cands.push({ i, pri: 0, text: DTF.dmy.format(d) });
      } else if (new Date(prev.t).getHours() !== d.getHours()) {
        cands.push({ i, pri: 1, text: DTF.hm.format(d) });
      }
    } else if (!prev || new Date(prev.t).getFullYear() !== d.getFullYear()) {
      cands.push({ i, pri: 0, text: DTF.year.format(d) });
    } else if (new Date(prev.t).getMonth() !== d.getMonth()) {
      cands.push({ i, pri: 0, text: DTF.monthOnly.format(d) });
    }
  }

  const minGap = 66;
  const picked = [];
  const accept = (cnd) => {
    const x = xOf(cnd.i);
    if (x < 28 || x > plotW() - 28) return false;
    if (picked.some((p) => Math.abs(xOf(p.i) - x) < minGap)) return false;
    picked.push(cnd);
    return true;
  };

  // day/month boundaries win over plain hour marks, so labels never lose them
  cands.filter((c) => c.pri === 0).sort((a, b) => a.i - b.i).forEach(accept);
  cands.filter((c) => c.pri === 1).sort((a, b) => a.i - b.i).forEach(accept);
  const every = Math.max(1, Math.ceil(minGap / Math.max(2, state.view.spacing)));
  for (let i = start; i <= end; i += every) {
    if (!bars[i]) continue;
    accept({
      i, pri: 2,
      text: intraday ? DTF.hm.format(new Date(bars[i].t))
        : DTF.dmy.format(new Date(bars[i].t)),
    });
  }
  picked.sort((a, b) => a.i - b.i);
  return picked;
}

function drawVolume(bars, pane) {
  const start = Math.max(0, Math.floor(state.view.offset));
  const end = Math.min(bars.length - 1,
    Math.ceil(state.view.offset + visibleCount() + 1));
  let max = 0;
  for (let i = start; i <= end; i++) max = Math.max(max, bars[i]?.v || 0);
  if (!max) return;
  const c = C();
  const h = Math.min(pane.height * 0.22, 130);
  const base = pane.top + pane.height;
  const bw = clamp(Math.round(state.view.spacing * 0.7), 1, 40);
  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (!b) continue;
    const y = base - ((b.v || 0) / max) * h;
    ctx.fillStyle = b.c >= b.o ? c.up : c.down;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(Math.round(xOf(i) - bw / 2), Math.round(y), bw,
      Math.max(1, Math.round(base - y)));
  }
  ctx.globalAlpha = 1;
}

let _legendCache = { top: null, panes: null };

function legendIndRow(ind, idx) {
  const def = window.Indicators.DEFS[ind.type];
  if (!def) return '';
  const calc = ind._calc || { lines: [] };
  const vals = calc.lines.map((ln) => {
    const v = window.Indicators.lastValue([ln], idx);
    if (v === null || v === undefined) return '—';
    return ind.type === 'volume' ? fmtCompact(v) : fmtPrice(v);
  }).join('  ·  ');
  const dot = (calc.lines[0] && calc.lines[0].color)
    || (ind.colors && ind.colors[0]) || '#2962ff';
  const off = ind.visible === false;
  return `<div class="tl-ind" data-ind="${ind.id}" style="opacity:${off ? .45 : 1}">
    <span class="tl-dot" style="background:${dot}"></span>
    <span>${def.short}${paramsText(ind)}<b>${vals}</b></span>
    <span class="tl-act">
      <button data-eye="${ind.id}" title="${off ? 'Show' : 'Hide'}">${svg('eye', 12)}</button>
      <button data-gear="${ind.id}" title="Settings">${svg('gear', 12)}</button>
      <button data-del-ind="${ind.id}" title="Remove">${svg('trash', 12)}</button>
    </span>
  </div>`;
}

function renderLegends(bars, panes) {
  const idx = state.crosshair
    ? clamp(state.crosshair.i, 0, bars.length - 1) : bars.length - 1;
  const b = bars[idx];
  if (!b) return;
  const prev = bars[idx - 1];
  const chg = b.c - (prev ? prev.c : b.o);
  const pct = prev && prev.c ? (chg / prev.c) * 100 : 0;
  const ohlcTypes = ['candles', 'hollow', 'bars', 'heikin', 'columns', 'highlow'];
  const parts = ohlcTypes.includes(state.chartType)
    ? [['O', b.o], ['H', b.h], ['L', b.l], ['C', b.c]]
    : [['C', b.c]];
  const ohlc = parts.map(([k, v]) =>
    `<span><i>${k}</i><b>${fmtPrice(v)}</b></span>`).join('');
  const vol = state.settings.volume
    ? `<span class="tl-vol">Vol <b>${fmtCompact(b.v || 0)}</b></span>` : '';
  const mainRows = state.indicators
    .filter((i) => window.Indicators.DEFS[i.type]?.pane === 'main')
    .map((ind) => legendIndRow(ind, idx)).join('');
  const top = `<div class="tl-row">
      <span class="tl-sym">${esc(state.symbol)}</span>
      <span class="tl-iv">${IV_LABEL[state.interval] || state.interval}</span>
      <span class="tl-ohlc">${ohlc}</span>
      <span class="tl-chg ${chg >= 0 ? 'up' : 'down'}">
        ${chg >= 0 ? '+' : ''}${fmtPrice(chg)} (${fmtPct(pct)})</span>
      ${vol}
    </div>${state.compare ? `<div class="tl-row">
      <span class="tl-dot" style="background:#ff9800"></span>
      <span class="tl-iv">${esc(state.compare.symbol)}</span>
      <span class="tl-ohlc">normalised</span></div>` : ''}${mainRows}`;

  const panesHTML = panes.slice(1).map((p) => {
    if (!p.ind) return '';
    return `<div class="pane-legend" style="top:${Math.round(p.top + 4)}px">
      ${legendIndRow(p.ind, idx)}</div>`;
  }).join('');

  if (_legendCache.top !== top) {
    $('#topLegend').innerHTML = top;
    _legendCache.top = top;
  }
  if (_legendCache.panes !== panesHTML) {
    $('#paneLegends').innerHTML = panesHTML;
    _legendCache.panes = panesHTML;
  }
}

function oldDrawLegends(bars, panes) {
  const c = C();
  const idx = state.crosshair ? state.crosshair.i : bars.length - 1;
  const b = bars[clamp(idx, 0, bars.length - 1)];
  if (!b) return;

  ctx.save();
  ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  let x = 8;
  const y = 12;

  ctx.fillStyle = c.text;
  ctx.font = '600 12px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillText(state.symbol, x, y);
  x += ctx.measureText(state.symbol).width + 6;
  ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.fillStyle = c.text2;
  ctx.fillText(IV_LABEL[state.interval] || state.interval, x, y);
  x += ctx.measureText(IV_LABEL[state.interval] || '').width + 10;

  const prev = bars[Math.max(0, idx - 1)];
  const chg = b.c - (prev ? prev.c : b.o);
  const pct = prev && prev.c ? (chg / prev.c) * 100 : 0;
  const col = chg >= 0 ? c.up : c.down;

  ctx.fillStyle = c.text2;
  const parts = [
    ['O', fmtPrice(b.o)], ['H', fmtPrice(b.h)],
    ['L', fmtPrice(b.l)], ['C', fmtPrice(b.c)],
  ];
  parts.forEach(([k, v]) => {
    ctx.fillStyle = c.text2; ctx.fillText(k, x, y);
    x += ctx.measureText(k).width + 3;
    ctx.fillStyle = c.text; ctx.fillText(v, x, y);
    x += ctx.measureText(v).width + 8;
  });
  ctx.fillStyle = col;
  const chgTxt = `${chg >= 0 ? '+' : ''}${fmtPrice(chg)} (${fmtPct(pct)})`;
  ctx.fillText(chgTxt, x, y);
  x += ctx.measureText(chgTxt).width + 10;
  if (b.v) {
    ctx.fillStyle = c.text2;
    ctx.fillText(fmtCompact(b.v), x, y);
  }

  // main indicators legend
  let ly = 30;
  mainIndicators().forEach((ind) => {
    const def = window.Indicators.DEFS[ind.type];
    const calc = ind._calc;
    let text = `${def.short}${paramsText(ind)}`;
    if (calc) {
      const v = window.Indicators.lastValue(calc.lines, idx);
      if (v !== null) text += '  ' + fmtPrice(v);
    }
    ctx.fillStyle = (ind.colors && ind.colors[0]) || c.accent;
    ctx.fillText(text, 8, ly);
    ly += 16;
  });

  // sub pane legends
  panes.slice(1).forEach((p) => {
    const def = window.Indicators.DEFS[p.ind.type];
    if (!def) return;
    let text = `${def.short}${paramsText(p.ind)}`;
    const v = window.Indicators.lastValue(p.calc.lines, idx);
    if (v !== null) {
      text += '  ' + (p.ind.type === 'volume' ? fmtCompact(v) : fmtPrice(v));
    }
    ctx.fillStyle = c.text2;
    ctx.font = '11.5px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(text, 8, p.top + 12);
    ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
  });

  ctx.restore();
}

function paramsText(ind) {
  const def = window.Indicators.DEFS[ind.type];
  if (!def || !def.params || !def.params.length) return '';
  return ' ' + def.params.map((k) => (ind.params || {})[k]).join(' ');
}

/* ------------------------------ interactions ----------------------------- */
function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function barAt(x) {
  const bars = activeBars();
  return clamp(Math.round(iOf(x)), 0, Math.max(0, bars.length - 1));
}

function priceAt(y) {
  return yToP(y, pricePane());
}

function snapPrice(price) {
  if (!state.magnet) return price;
  const bars = activeBars();
  const i = state.crosshair ? state.crosshair.i : bars.length - 1;
  const b = bars[i]; if (!b) return price;
  const opts = [b.o, b.h, b.l, b.c];
  return opts.reduce((best, v) => Math.abs(v - price) < Math.abs(best - price) ? v : best, opts[0]);
}

function newDrawing(type, pt) {
  const colors = window.Indicators.PALETTE;
  return {
    id: uid(), type, pts: [pt], color: C().draw,
    width: 1.6, visible: true, locked: false,
    colors,
  };
}

function commitDrawing(d) {
  const need = (d.type === 'hline' || d.type === 'vline' || d.type === 'text') ? 1 : 2;
  if (d.pts.length < need) { state.temp = null; return; }
  state.drawings.push(d);
  pushHistory();
  state.temp = null;
  if (!state.keepDrawing) setTool('cursor');
  state.selection = d.id;
  renderPanel();
  saveSoon();
}

function drawingAt(x, y) {
  const pp = pricePane();
  const G = { x: xOf, y: (p) => pToY(p, pp), W: plotW(), H: chart.H };
  for (let i = state.drawings.length - 1; i >= 0; i--) {
    const d = state.drawings[i];
    if (d.visible === false || state.hideAll) continue;
    if (window.Drawings.hit(d, x, y, G)) return d;
  }
  return null;
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const { x, y } = canvasPos(ev);
  try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* no active pointer */ }

  if (state.replay.picking) {
    state.replay.index = clamp(barAt(x) + 1, 6, state.bars.length);
    state.replay.picking = false;
    recomputeIndicators(); computePanes(); clampView();
    schedule(); updateReplayUI();
    return;
  }

  if (x > plotW()) {
    state.drag = {
      mode: 'scale', start: { x, y },
      shift: state.settings.priceShift || 0,
    };
    return;
  }
  const tool = state.tool;

  if (tool !== 'cursor' && tool !== 'measure' && tool !== 'text') {
    const pt = { i: barAt(x), p: snapPrice(priceAt(y)) };
    state.temp = newDrawing(tool, pt);
    state.temp._start = { x, y };
    if (['hline', 'vline'].includes(tool)) {
      state.temp.pts.push({ ...pt });
      commitDrawing(state.temp);
      schedule();
      return;
    }
    state.temp.pts.push({ ...pt });
    schedule();
    return;
  }

  if (tool === 'text') {
    const text = prompt('Text', 'Note');
    if (!text) { setTool('cursor'); return; }
    const d = newDrawing('text', { i: barAt(x), p: priceAt(y) });
    d.text = text;
    commitDrawing(d);
    schedule();
    return;
  }

  if (tool === 'measure') {
    state.temp = newDrawing('measure', { i: barAt(x), p: priceAt(y) });
    state.temp.pts.push({ i: barAt(x), p: priceAt(y) });
    schedule();
    return;
  }

  // cursor: select / drag / pan
  const G = { x: xOf, y: (p) => pToY(p, pricePane()), W: plotW(), H: chart.H };
  let hit = null, handle = -1;
  for (let i = state.drawings.length - 1; i >= 0; i--) {
    const d = state.drawings[i];
    if (d.visible === false || state.hideAll) continue;
    handle = window.Drawings.handleAt(d, x, y, G);
    if (handle >= 0) { hit = d; break; }
    if (window.Drawings.hit(d, x, y, G)) { hit = d; break; }
  }

  if (hit && !hit.locked && !state.lockAll) {
    state.selection = hit.id;
    state.drag = {
      mode: handle >= 0 ? 'handle' : 'move',
      handle, d: hit,
      start: { x, y, i: iOf(x), p: priceAt(y) },
      orig: hit.pts.map((p) => ({ ...p })),
    };
    renderPanel();
    schedule();
    return;
  }
  if (hit) { state.selection = hit.id; schedule(); return; }

  state.selection = null;
  state.drag = { mode: 'pan', start: { x, y }, offset: state.view.offset };
  document.getElementById('app').classList.add('dragging');
  schedule();
});

canvas.addEventListener('pointermove', (ev) => {
  const { x, y } = canvasPos(ev);
  const n = activeBars().length;
  state.crosshair = {
    i: clamp(Math.round(iOf(x)), 0, Math.max(0, n - 1)),
    y: clamp(y, 0, plotH()),
    x,
  };

  if (state.temp) {
    const last = state.temp.pts[state.temp.pts.length - 1];
    const pt = { i: barAt(x), p: snapPrice(priceAt(y)) };
    if (state.temp.type === 'brush') {
      if (Math.abs(x - xOf(last.i)) > 2 || Math.abs(y - pToY(last.p, pricePane())) > 2) {
        state.temp.pts.push(pt);
      }
    } else {
      if (state.temp.pts.length > 1) state.temp.pts[1] = pt;
      else state.temp.pts.push(pt);
    }
  } else if (state.drag) {
    if (state.drag.mode === 'pan') {
      const dx = x - state.drag.start.x;
      state.view.offset = clamp(state.drag.offset - dx / state.view.spacing, 0,
        maxOffset());
    } else if (state.drag.mode === 'scale') {
      state.settings.priceShift = state.drag.shift + (y - state.drag.start.y) / plotH();
    } else {
      const d = state.drag.d;
      if (state.drag.mode === 'move') {
        const di = Math.round(iOf(x) - state.drag.start.i);
        const dp = priceAt(y) - state.drag.start.p;
        d.pts = state.drag.orig.map((p) => ({ i: p.i + di, p: p.p + dp }));
      } else {
        const h = state.drag.handle;
        d.pts[h] = { i: barAt(x), p: snapPrice(priceAt(y)) };
      }
    }
  }
  schedule();
});

canvas.addEventListener('pointerup', (ev) => {
  if (state.temp) {
    if (state.temp.pts.length >= 2) {
      // a click without a drag still places a sensible second point
      const a = state.temp.pts[0], b = state.temp.pts[1];
      if (a && b && Math.abs(a.i - b.i) < 0.5 && Math.abs(a.p - b.p) < 1e-9) {
        b.i = a.i + Math.round(24 / Math.max(1, state.view.spacing / 8));
      }
      commitDrawing(state.temp);
    } else {
      state.temp = null;
    }
    schedule();
    return;
  }
  if (state.drag) {
    if (state.drag.mode === 'move' || state.drag.mode === 'handle') {
      pushHistory(); saveSoon();
    } else if (state.drag.mode === 'scale') saveSoon();
    state.drag = null;
    document.getElementById('app').classList.remove('dragging');
    schedule();
  }
});

canvas.addEventListener('pointerleave', () => {
  state.crosshair = null;
  schedule();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const { x, y } = canvasPos(ev);
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;

  if (x > plotW()) {
    state.settings.priceStretch = clamp((state.settings.priceStretch || 1) / factor, 0.15, 8);
    saveSoon();
    schedule();
    return;
  }
  if (y > plotH()) {
    state.view.spacing = clamp(state.view.spacing * factor, 1.6, 60);
    clampView();
    schedule();
    return;
  }

  const anchor = iOf(x);
  state.view.spacing = clamp(state.view.spacing * factor, 1.6, 60);
  state.view.offset = anchor + 0.5 - x / state.view.spacing;
  clampView();
  schedule();
}, { passive: false });

canvas.addEventListener('dblclick', (ev) => {
  const { x, y } = canvasPos(ev);
  if (x > plotW()) {
    state.settings.priceStretch = 1;
    state.settings.priceShift = 0;
    saveSoon();
    schedule();
    return;
  }
  const d = drawingAt(x, y);
  if (d) { openDrawingProps(d); return; }
  fitView();
  schedule();
});

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (state.temp) { state.temp = null; setTool('cursor'); }
  const { x, y } = canvasPos(ev);

  if (x > plotW()) {
    openMenuAt(ev.clientX, ev.clientY, (pop) => {
      pop.innerHTML = `<div class="pop-title">Price scale</div>`
        + popItem('Reset scale', { act: 'resetScale' })
        + popItem('Regular', { act: 'scaleLinear', on: state.settings.scale === 'linear' })
        + popItem('Logarithmic', { act: 'scaleLog', on: state.settings.scale === 'log' })
        + popItem('Percent', { act: 'scalePercent', on: state.settings.scale === 'percent' });
      pop.onclick = (e) => {
        const b = e.target.closest('.pop-item');
        if (!b) return;
        closePopover();
        if (b.dataset.act === 'resetScale') {
          state.settings.priceStretch = 1;
          state.settings.priceShift = 0;
        } else {
          state.settings.scale = b.dataset.act === 'scaleLog' ? 'log'
            : b.dataset.act === 'scalePercent' ? 'percent' : 'linear';
        }
        updateHeader(); saveSoon(); schedule();
      };
    });
    return;
  }

  const d = drawingAt(x, y);
  const price = priceAt(clamp(y, 0, plotH()));
  const bar = state.bars[barAt(x)];
  const qi = x > plotW() ? -1 : Math.round(iOf(x));

  openMenuAt(ev.clientX, ev.clientY, (pop) => {
    pop.innerHTML = `<div class="pop-title">${esc(state.symbol)} · ${IV_LABEL[state.interval]}</div>`
      + popItem('Reset chart', { act: 'resetChart' })
      + popItem('Fit content', { act: 'fit' })
      + popItem('Go to latest bar', { act: 'realtime' })
      + '<div class="pop-sep"></div>'
      + popItem(`Copy price ${fmtPrice(price)}`, { act: 'copyPrice' })
      + (bar ? popItem('Copy OHLC', { act: 'copyOhlc' }) : '')
      + popItem('Save chart image', { act: 'snapshot' })
      + popItem('Create alert at ' + fmtPrice(price), { act: 'alert' })
      + '<div class="pop-sep"></div>'
      + (d ? popItem('Drawing settings…', { act: 'drawProps' })
        + popItem(d.locked ? 'Unlock drawing' : 'Lock drawing', { act: 'drawLock' })
        + popItem('Delete drawing', { act: 'drawDel' })
        + '<div class="pop-sep"></div>' : '')
      + popItem('Add indicator…', { act: 'indicators' })
      + popItem('Chart settings…', { act: 'settings' })
      + popItem('Object tree', { act: 'objects' })
      + popItem('Hide all drawings', { act: 'hideDrawings', on: state.hideAll })
      + popItem('Remove all drawings', { act: 'clearDrawings' });

    pop.onclick = (e) => {
      const b = e.target.closest('.pop-item');
      if (!b) return;
      const act = b.dataset.act;
      closePopover();
      if (act === 'resetChart') resetChart();
      else if (act === 'fit') { fitView(); schedule(); }
      else if (act === 'realtime') goRealtime();
      else if (act === 'copyPrice') copyText(fmtPrice(price), 'Price copied');
      else if (act === 'copyOhlc' && bar) copyText(
        `O ${fmtPrice(bar.o)} H ${fmtPrice(bar.h)} L ${fmtPrice(bar.l)} C ${fmtPrice(bar.c)}`,
        'OHLC copied');
      else if (act === 'snapshot') takeSnapshot();
      else if (act === 'alert') openAlertModal(price);
      else if (act === 'drawProps' && d) openDrawingProps(d);
      else if (act === 'drawLock' && d) {
        d.locked = !d.locked; saveSoon(); schedule();
        toast(d.locked ? 'Drawing locked' : 'Drawing unlocked', '');
      } else if (act === 'drawDel' && d) {
        state.drawings = state.drawings.filter((x) => x.id !== d.id);
        if (state.selection === d.id) state.selection = null;
        pushHistory(); renderPanel(); saveSoon(); schedule();
      } else if (act === 'indicators') openIndicatorsMenu();
      else if (act === 'settings') openSettings();
      else if (act === 'objects') {
        state.panel = 'objects';
        if ($('#sidebar').classList.contains('collapsed')) togglePanel();
        renderPanel(); saveSoon();
      } else if (act === 'hideDrawings') {
        state.hideAll = !state.hideAll; syncToolbar(); schedule();
      } else if (act === 'clearDrawings') clearDrawings();
    };
  });
});

/* ------------------------------- history -------------------------------- */
const history = { past: [], future: [] };

function snapshotDrawings() { return JSON.stringify(state.drawings); }

function pushHistory() {
  const snap = snapshotDrawings();
  if (history.past.length && history.past[history.past.length - 1] === snap) return;
  history.past.push(snap);
  if (history.past.length > 60) history.past.shift();
  history.future.length = 0;
  updateUndoButtons();
}

function undo() {
  if (!history.past.length) return;
  history.future.push(snapshotDrawings());
  state.drawings = JSON.parse(history.past.pop());
  state.selection = null;
  updateUndoButtons(); renderPanel(); saveSoon(); schedule();
}

function redo() {
  if (!history.future.length) return;
  history.past.push(snapshotDrawings());
  state.drawings = JSON.parse(history.future.pop());
  state.selection = null;
  updateUndoButtons(); renderPanel(); saveSoon(); schedule();
}

function updateUndoButtons() {
  $('#undoBtn').disabled = !history.past.length;
  $('#redoBtn').disabled = !history.future.length;
}

/* --------------------------------- tools -------------------------------- */
const ICON = {
  cursor: '<path d="M5 3l9 7-4.4.8L12 16l-2 .9-2.3-5.1L5 15V3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  cross: '<path d="M10 2v16M2 10h16" stroke="currentColor" stroke-width="1.3"/><circle cx="10" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  trendline: '<path d="M3.5 16 16 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3.5" cy="16" r="2" fill="currentColor"/><circle cx="16" cy="4.5" r="2" fill="currentColor"/>',
  ray: '<path d="M3.5 15.5 15 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M15 5l-2.6.3M15 5l-.4 2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="3.5" cy="15.5" r="1.8" fill="currentColor"/>',
  hline: '<path d="M2 10h16" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="2" fill="currentColor"/>',
  vline: '<path d="M10 2v16" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="9" r="2" fill="currentColor"/>',
  channel: '<path d="M3 13.5 16 5M3 17 16 8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 13.5 16 5l0 3.5L3 17Z" fill="currentColor" opacity=".16"/>',
  fib: '<path d="M2 4h16M2 8h16M2 12h16M2 16h16" stroke="currentColor" stroke-width="1.1" opacity=".75"/><path d="M2 4 18 16" stroke="currentColor" stroke-width="1.3" stroke-dasharray="3 2"/>',
  rect: '<rect x="3" y="5" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  brush: '<path d="M3 16c3.5-1 4-6 7-6s2.5 4 7 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  arrow: '<path d="M3 16 16 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M16 4h-4.6M16 4v4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  text: '<path d="M4 5h12M10 5v11M7.5 16h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  long: '<path d="M3 14h14" stroke="currentColor" stroke-width="1.3"/><rect x="5" y="5" width="10" height="4" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.1"/><rect x="5" y="10" width="10" height="4" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.1"/>',
  short: '<path d="M3 6h14" stroke="currentColor" stroke-width="1.3"/><rect x="5" y="11" width="10" height="4" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="1.1"/><rect x="5" y="6" width="10" height="4" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.1"/>',
  measure: '<path d="M3 13 13 3l4 4-10 10H3v-4Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 7l1.6 1.6M9.6 4.4 11 6M4.4 9.6 6 11" stroke="currentColor" stroke-width="1.2"/>',
  magnet: '<path d="M6 4v6a4 4 0 0 0 8 0V4h-2.6v6a1.4 1.4 0 0 1-2.8 0V4H6Z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  keep: '<path d="M8 3h4v5l2 3v1.5H6V11l2-3V3Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10 12.5V17" stroke="currentColor" stroke-width="1.3"/>',
  lock: '<rect x="5" y="9" width="10" height="7" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 9V7a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  hide: '<path d="M2 10s3-4.5 8-4.5S18 10 18 10s-3 4.5-8 4.5S2 10 2 10Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 16 16 4" stroke="currentColor" stroke-width="1.4"/>',
  remove: '<path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  chat: '<path d="M3 4h14v9H9l-4 3v-3H3V4Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  bell: '<path d="M5 13V8a5 5 0 0 1 10 0v5l1.4 2H3.6L5 13Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  tree: '<path d="M4 4h5M4 10h5M4 16h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="12" y="2.5" width="5" height="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="12" y="8.4" width="5" height="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="12" y="14.4" width="5" height="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  info: '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10 9v5M10 6.2v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  list: '<path d="M3 5h14M3 10h10M3 15h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  gear: '<circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  plus: '<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  eye: '<path d="M2 10s3-4.5 8-4.5S18 10 18 10s-3 4.5-8 4.5S2 10 2 10Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="10" cy="10" r="2.2" fill="currentColor"/>',
  trash: '<path d="M5 6h10l-.8 10H5.8L5 6Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 6h12M8 6V4h4v2" stroke="currentColor" stroke-width="1.3"/>',
  chev: '<path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

function svg(name, size = 20) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}">${ICON[name] || ''}</svg>`;
}

const DRAW_TOOLS = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'cross', label: 'Crosshair' },
  { sep: true },
  { id: 'trendline', label: 'Trend line' },
  { id: 'ray', label: 'Ray' },
  { id: 'hline', label: 'Horizontal line' },
  { id: 'vline', label: 'Vertical line' },
  { id: 'channel', label: 'Parallel channel' },
  { id: 'fib', label: 'Fib retracement' },
  { id: 'brush', label: 'Brush' },
  { id: 'arrow', label: 'Arrow' },
  { sep: true },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'text', label: 'Text' },
  { sep: true },
  { id: 'long', label: 'Long position' },
  { id: 'short', label: 'Short position' },
  { id: 'measure', label: 'Measure' },
  { sep: true },
  { id: 'magnet', label: 'Magnet mode', toggle: true },
  { id: 'keep', label: 'Keep drawing', toggle: true },
  { id: 'lock', label: 'Lock all drawings', toggle: true },
  { id: 'hide', label: 'Hide all drawings', toggle: true },
  { id: 'remove', label: 'Remove objects' },
];

function buildDrawbar() {
  const bar = $('#drawbar');
  bar.innerHTML = '';
  DRAW_TOOLS.forEach((t) => {
    if (t.sep) {
      const s = document.createElement('div');
      s.className = 'db-sep';
      bar.appendChild(s);
      return;
    }
    const b = document.createElement('button');
    b.className = 'db-btn';
    b.dataset.tool = t.id;
    b.title = t.label;
    b.innerHTML = svg(t.toggle && t.id === 'lock' ? 'lock'
      : t.toggle && t.id === 'keep' ? 'keep'
        : t.toggle && t.id === 'hide' ? 'hide'
          : t.toggle && t.id === 'magnet' ? 'magnet' : t.id);
    b.addEventListener('click', () => {
      if (t.toggle) {
        if (t.id === 'magnet') state.magnet = !state.magnet;
        if (t.id === 'keep') state.keepDrawing = !state.keepDrawing;
        if (t.id === 'lock') state.lockAll = !state.lockAll;
        if (t.id === 'hide') state.hideAll = !state.hideAll;
        syncToolbar();
        schedule();
      } else if (t.id === 'remove') {
        removeSelection();
      } else if (t.id === 'cross') {
        setTool('cursor');
        toast('Crosshair', 'Crosshair is always shown on hover.');
      } else {
        setTool(t.id);
      }
    });
    bar.appendChild(b);
  });
  syncToolbar();
}

function setTool(tool) {
  state.tool = tool;
  if (!['cursor'].includes(tool)) state.selection = null;
  state.temp = null;
  syncToolbar();
  schedule();
}

function syncToolbar() {
  $$('#drawbar .db-btn').forEach((b) => {
    const t = b.dataset.tool;
    let on = false;
    if (['magnet', 'keep', 'lock', 'hide'].includes(t)) {
      on = { magnet: state.magnet, keep: state.keepDrawing, lock: state.lockAll, hide: state.hideAll }[t];
    } else {
      on = state.tool === t;
    }
    b.classList.toggle('on', !!on);
  });
  $('#undoBtn').disabled = !history.past.length;
  $('#redoBtn').disabled = !history.future.length;
  $('#replayBtn').classList.toggle('on', state.replay.on);
}

function removeSelection() {
  if (!state.selection) { toast('Remove objects', 'Select a drawing first.'); return; }
  state.drawings = state.drawings.filter((d) => d.id !== state.selection);
  state.selection = null;
  pushHistory(); renderPanel(); saveSoon(); schedule();
}

/* ------------------------------ popovers -------------------------------- */
const popover = $('#popover');
const overlay = $('#overlay');

function closePopover() {
  popover.hidden = true;
  popover.innerHTML = '';
  overlay.hidden = true;
}

overlay.addEventListener('click', closePopover);

function openPopover(anchor, build) {
  closePopover();
  popover.hidden = false;
  overlay.hidden = false;
  build(popover);
  const r = anchor.getBoundingClientRect();
  popover.style.left = Math.min(window.innerWidth - popover.offsetWidth - 8, r.left) + 'px';
  popover.style.top = (r.bottom + 4) + 'px';
}

function popItem(label, opts = {}) {
  return `<button class="pop-item ${opts.on ? 'on' : ''}" data-act="${opts.act || ''}"
    ${opts.value !== undefined ? `data-value="${opts.value}"` : ''}>
    ${opts.swatch ? `<span class="sw" style="background:${opts.swatch}"></span>` : ''}
    <span>${label}</span>
    ${opts.k ? `<span class="k">${opts.k}</span>` : ''}
  </button>`;
}

function openIntervalMenu() {
  openPopover($('#intervalBtn'), (pop) => {
    pop.innerHTML = `<div class="pop-title">Interval</div>` +
      INTERVALS.map(([iv, label]) =>
        popItem(`${IV_LABEL[iv]}  <span class="meta">${label}</span>`,
          { on: state.interval === iv, value: iv, act: 'interval' })).join('');
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      setInterval_(b.dataset.value);
      closePopover();
    };
  });
}

function openTypeMenu() {
  openPopover($('#typeBtn'), (pop) => {
    pop.innerHTML = `<div class="pop-title">Chart type</div>` +
      CHART_TYPES.map(([id, label]) =>
        popItem(label, { on: state.chartType === id, value: id, act: 'type' })).join('');
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      state.chartType = b.dataset.value;
      closePopover(); updateHeader(); schedule(); saveSoon();
    };
  });
}

function openIndicatorsMenu() {
  openPopover($('#indicatorsBtn'), (pop) => {
    const defs = window.Indicators.DEFS;
    pop.innerHTML = `
      <div class="pop-search"><input id="indSearch" placeholder="Search indicators…" autocomplete="off"></div>
      <div id="indList"></div>
      <div class="pop-sep"></div>
      <div class="pop-item" data-act="manage" style="color:var(--text-2)">Applied: ${state.indicators.length}</div>`;
    const list = pop.querySelector('#indList');
    const input = pop.querySelector('#indSearch');
    const draw = (q = '') => {
      const items = Object.entries(defs).filter(([, d]) =>
        d.name.toLowerCase().includes(q.toLowerCase()) ||
        d.short.toLowerCase().includes(q.toLowerCase()));
      list.innerHTML = items.map(([id, d]) =>
        popItem(`${d.short} <span class="meta">— ${d.name}</span>`,
          { value: id, act: 'add' })).join('') ||
        '<div class="pop-empty">No indicators match.</div>';
    };
    draw();
    input.addEventListener('input', () => draw(input.value));
    input.focus();
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b || !b.dataset.value) return;
      addIndicator(b.dataset.value);
      closePopover();
    };
  });
}

function addIndicator(type) {
  const def = window.Indicators.DEFS[type];
  if (!def) return;
  if (type === 'volume') {
    state.settings.volume = !state.settings.volume;
    recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
    toast(state.settings.volume ? 'Volume shown' : 'Volume hidden',
      'Volume is drawn over the price pane.');
    return;
  }
  if (state.indicators.some((i) => i.type === type)) {
    toast('Already applied', def.name + ' is on the chart.');
    return;
  }
  const colors = window.Indicators.PALETTE.filter((_, i) => i >= state.indicators.length);
  const ind = {
    id: uid(), type, params: { ...def.defaults },
    colors: colors.length ? colors : window.Indicators.PALETTE,
    visible: true,
  };
  state.indicators.push(ind);
  if (type === 'volume') state.settings.volume = true;
  recomputeIndicators();
  computePanes();
  renderPanel(); saveSoon(); schedule();
  toast('Indicator added', def.name);
}

function openSettings() {
  const s = state.settings;
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head"><h3>Chart settings</h3>
        <button id="mClose">✕</button></div>
      <div class="modal-body">
        <div class="field"><label>Theme
          <span class="hint">Dark or light workspace</span></label>
          <select id="setTheme">
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
          </select></div>
        <div class="field"><label>Price scale
          <span class="hint">Regular, logarithmic or percent</span></label>
          <select id="setScale">
            <option value="linear" ${s.scale === 'linear' ? 'selected' : ''}>Regular</option>
            <option value="log" ${s.scale === 'log' ? 'selected' : ''}>Logarithmic</option>
            <option value="percent" ${s.scale === 'percent' ? 'selected' : ''}>Percent</option>
          </select></div>
        <div class="field"><label>Grid lines</label>
          <div class="switch ${s.grid ? 'on' : ''}" id="setGrid"></div></div>
        <div class="field"><label>Volume
          <span class="hint">Histogram overlaid on the price pane</span></label>
          <div class="switch ${s.volume ? 'on' : ''}" id="setVolume"></div></div>
        <div class="field"><label>Crosshair</label>
          <div class="switch ${s.crosshair ? 'on' : ''}" id="setCross"></div></div>
        <div class="field"><label>Last price line</label>
          <div class="switch ${s.lastPriceLine ? 'on' : ''}" id="setLast"></div></div>
        <div class="field"><label>Watermark</label>
          <div class="switch ${s.watermark ? 'on' : ''}" id="setMark"></div></div>
        <div class="field"><label>Bullish colour</label>
          <input type="color" id="setUp" value="${s.up}"></div>
        <div class="field"><label>Bearish colour</label>
          <input type="color" id="setDown" value="${s.down}"></div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="setReset">Reset drawings</button>
        <button class="btn" id="setDone">Done</button>
      </div>
    </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  modal.querySelector('#mClose').onclick = close;
  modal.querySelector('#setDone').onclick = () => { saveSoon(); close(); };
  modal.querySelector('#setTheme').onchange = (e) => {
    s.theme = e.target.value;
    document.getElementById('app').dataset.theme = s.theme;
    schedule(); saveSoon();
  };
  modal.querySelector('#setScale').onchange = (e) => { s.scale = e.target.value; computePanes(); schedule(); saveSoon(); };
  const toggle = (el, key, after) => {
    el.onclick = () => {
      s[key] = !s[key];
      el.classList.toggle('on', s[key]);
      if (after) after();
      schedule(); saveSoon();
    };
  };
  toggle(modal.querySelector('#setGrid'), 'grid');
  toggle(modal.querySelector('#setVolume'), 'volume', () => { recomputeIndicators(); computePanes(); renderPanel(); });
  toggle(modal.querySelector('#setCross'), 'crosshair');
  toggle(modal.querySelector('#setLast'), 'lastPriceLine');
  toggle(modal.querySelector('#setMark'), 'watermark');
  modal.querySelector('#setUp').oninput = (e) => { s.up = e.target.value; schedule(); saveSoon(); };
  modal.querySelector('#setDown').oninput = (e) => { s.down = e.target.value; schedule(); saveSoon(); };
  modal.querySelector('#setReset').onclick = () => {
    state.drawings = []; state.selection = null;
    pushHistory(); renderPanel(); saveSoon(); schedule(); close();
    toast('Drawings cleared', 'All drawings for this chart were removed.');
  };
}

function openLayoutMenu() {
  openPopover($('#layoutBtn'), (pop) => {
    pop.innerHTML = `
      <div class="pop-title">Layout</div>
      ${popItem('Save layout', { act: 'save', k: 'Ctrl+S' })}
      ${popItem(state.settings.theme === 'dark' ? 'Light theme' : 'Dark theme', { act: 'theme' })}
      ${popItem('Toggle right panel', { act: 'panel' })}
      <div class="pop-sep"></div>
      ${popItem('Reset chart scale', { act: 'scale' })}
      ${popItem('Reset drawings', { act: 'drawings' })}
      ${popItem('Reset indicators', { act: 'indicators' })}`;
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      const act = b.dataset.act;
      closePopover();
      if (act === 'save') {
        saveState();
        toast('Layout saved', 'Symbol, indicators and drawings restored on reload.', 'success');
      } else if (act === 'theme') {
        state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
        document.getElementById('app').dataset.theme = state.settings.theme;
        schedule(); saveSoon();
      } else if (act === 'panel') {
        togglePanel();
      } else if (act === 'scale') {
        resetChart();
      } else if (act === 'drawings') {
        clearDrawings();
      } else if (act === 'indicators') {
        state.indicators = [];
        recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
        toast('Indicators cleared', '');
      }
    };
  });
}

/* --------------------------- symbol search ------------------------------ */
let SYMBOLS = [];

async function loadStatus() {
  try {
    state.auth = await api('/api/terminal/status');
  } catch (e) {
    state.auth = { authorized: false, message: 'server offline', live: false };
  }
  updateHeader();
}

async function loadSymbols() {
  if (SYMBOLS.length) return SYMBOLS;
  try {
    const d = await api('/api/terminal/symbols');
    SYMBOLS = d.symbols || [];
  } catch (e) { SYMBOLS = []; }
  return SYMBOLS;
}

function openSearch() {
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head"><h3>Symbol search</h3>
        <button id="mClose">✕</button></div>
      <div class="modal-body">
        <div class="search-input">
          <svg viewBox="0 0 16 16" width="15" height="15"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.4 10.4 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <input id="symInput" placeholder="Search symbol or company…" autocomplete="off">
        </div>
        <div class="search-list" id="symList"></div>
      </div>
    </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  modal.querySelector('#mClose').onclick = close;
  const input = modal.querySelector('#symInput');
  const list = modal.querySelector('#symList');

  const paint = (q = '') => {
    const needle = q.trim().toLowerCase();
    const rows = SYMBOLS.filter((s) =>
      !needle || s.symbol.toLowerCase().includes(needle) ||
      s.name.toLowerCase().includes(needle));
    list.innerHTML = rows.slice(0, 60).map((s, i) => {
      const q2 = state.quotes[s.symbol];
      return `<div class="search-row ${i === 0 ? 'sel' : ''}" data-sym="${esc(s.symbol)}">
        <span class="wl-badge" style="background:${badgeColor(s.symbol)}">${s.symbol[0]}</span>
        <div class="grow"><div class="nm">${esc(s.symbol)}</div>
          <div class="sub">${esc(s.name)} · ${esc(s.exchange)}</div></div>
        ${q2 ? `<span class="val ${q2.pct >= 0 ? 'tl-chg up' : 'tl-chg down'}">${fmtPrice(q2.ltp, q2.digits)}</span>` : ''}
      </div>`;
    }).join('') || '<div class="empty"><b>No match</b>Try another ticker.</div>';
    const first = list.querySelector('.search-row');
    if (first) first.classList.add('sel');
  };

  paint('');
  input.addEventListener('input', () => paint(input.value));
  input.addEventListener('keydown', (ev) => {
    const rows = $$('.search-row', list);
    const cur = rows.findIndex((r) => r.classList.contains('sel'));
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (rows[cur + 1]) { rows[cur]?.classList.remove('sel'); rows[cur + 1].classList.add('sel'); rows[cur + 1].scrollIntoView({ block: 'nearest' }); }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (rows[cur - 1]) { rows[cur]?.classList.remove('sel'); rows[cur - 1].classList.add('sel'); rows[cur - 1].scrollIntoView({ block: 'nearest' }); }
    } else if (ev.key === 'Enter') {
      const pick = rows.find((r) => r.classList.contains('sel')) || rows[0];
      if (pick) { selectSymbol(pick.dataset.sym); close(); }
    }
  });
  list.addEventListener('click', (ev) => {
    const row = ev.target.closest('.search-row');
    if (row) { selectSymbol(row.dataset.sym); close(); }
  });
  input.focus();
}

/* ------------------------------ data loads ------------------------------ */
const loading = $('#loading');

function badgeColor(sym) {
  const hash = Array.from(sym).reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  return `hsl(${hue} 55% 45%)`;
}

async function selectSymbol(sym) {
  if (!sym) return;
  saveDrawingsForCurrent();
  state.symbol = sym;
  state.selection = null;
  state.replay.on = false;
  state.drawings = readAllDrawings()[sym + '|' + state.interval] || [];
  history.past.length = 0; history.future.length = 0;
  await loadChart();
  renderPanel();
}

function saveDrawingsForCurrent() {
  const all = readAllDrawings();
  all[drawingsKey()] = state.drawings;
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    raw.drawingsByKey = all;
    localStorage.setItem(LS_KEY, JSON.stringify(raw));
  } catch (e) { /* ignore */ }
}

async function loadChart() {
  loading.hidden = false;
  try {
    const bars = state.interval === '1M' ? 240 : 700;
    const d = await api('/api/terminal/candles', {
      symbol: state.symbol, interval: state.interval, bars,
    });
    state.bars = d.candles || [];
    state.dataVersion++;
    state.meta = d;
    state.name = d.name || d.symbol;
    state.digits = d.digits ?? 2;
    state.source = d.source || 'sample';
    state.quotes[state.symbol] = Object.assign({}, state.quotes[state.symbol], {
      ltp: state.bars.length ? state.bars[state.bars.length - 1].c : null,
      digits: state.digits,
    });
    recomputeIndicators();
    computePanes();
    fitView();
    updateHeader();
    if (state.compare) await loadCompare(state.compare.symbol);
    renderPanel();
  } catch (e) {
    toast('Chart failed to load', String(e.message || e), 'warn');
  } finally {
    loading.hidden = true;
    schedule();
  }
}

function setInterval_(iv) {
  if (!iv || iv === state.interval) return;
  saveDrawingsForCurrent();
  state.interval = iv;
  state.replay.on = false;
  state.drawings = readAllDrawings()[state.symbol + '|' + iv] || [];
  history.past.length = 0; history.future.length = 0;
  $('#intervalLabel').textContent = IV_LABEL[iv] || iv;
  loadChart();
}

function updateHeader() {
  $('#symbolName').textContent = state.symbol;
  $('#symbolBadge').textContent = state.symbol[0];
  $('#symbolBadge').style.background = badgeColor(state.symbol);
  $('#intervalLabel').textContent = IV_LABEL[state.interval] || state.interval;
  const chip = $('#sourceChip');
  if (!state.auth.authorized) {
    chip.textContent = 'CONNECT BROKER';
    chip.title = 'Upstox: ' + (state.auth.message || 'not linked') + ' — click to link';
    chip.classList.remove('live');
    chip.classList.add('warn');
  } else {
    chip.textContent = state.source === 'live' ? 'LIVE' : 'SAMPLE';
    chip.title = state.source === 'live'
      ? 'Live Upstox candles'
      : 'Sample candles — no Upstox instrument key for this symbol';
    chip.classList.toggle('live', state.source === 'live');
    chip.classList.remove('warn');
  }
  const typeRow = CHART_TYPES.find(([id]) => id === state.chartType);
  $('#typeBtn').title = 'Chart type: ' + (typeRow ? typeRow[1] : state.chartType);
  $('#barInfo').textContent = `${state.bars.length} bars`;
  $('#scaleInfo').textContent = state.settings.scale === 'linear' ? 'Regular'
    : state.settings.scale === 'log' ? 'Logarithmic' : 'Percent';
  document.title = `${state.symbol} · ${IV_LABEL[state.interval]} — Terminal`;
}

async function loadCompare(sym) {
  try {
    const d = await api('/api/terminal/candles', { symbol: sym, interval: state.interval, bars: 700 });
    state.compare = { symbol: sym, bars: d.candles || [] };
  } catch (e) { state.compare = null; }
  schedule();
}

/* -------------------------------- quotes -------------------------------- */
async function refreshLive() {
  if (state.replay.on || state.source !== 'live') return;
  try {
    const d = await api('/api/terminal/candles', {
      symbol: state.symbol, interval: state.interval,
      bars: state.interval === '1M' ? 240 : 700,
    });
    if (!d.candles || !d.candles.length) return;
    const follow = atRightEdge(3);
    const grew = Math.max(0, d.candles.length - state.bars.length);
    state.bars = d.candles;
    state.dataVersion++;
    state.source = d.source || state.source;
    state.meta = d;
    if (follow) state.view.offset += grew;
    recomputeIndicators();
    computePanes();
    clampView();
    updateHeader();
    schedule();
  } catch (e) { /* keep the last frame on a failed poll */ }
}

async function refreshQuotes() {
  const syms = Array.from(new Set([
    ...state.watchlist.map((w) => w.symbol),
    state.symbol,
  ])).slice(0, 60);
  if (!syms.length) return;
  try {
    const d = await api('/api/terminal/quotes', { symbols: syms.join(',') });
    (d.quotes || []).forEach((q) => { state.quotes[q.symbol] = q; });
    checkAlerts();
    if (state.panel === 'watchlist') renderPanel();
  } catch (e) { /* offline — keep last quotes */ }
}

const COND_LABEL = {
  crossingUp: 'Crossing up', crossingDown: 'Crossing down', crossing: 'Crossing',
  above: 'Greater than', below: 'Less than',
};

function alertFires(a, q) {
  const prev = a.last;
  a.last = q.ltp;
  const v = q.ltp;
  switch (a.cond || 'crossingUp') {
    case 'above': return v > a.price;
    case 'below': return v < a.price;
    case 'crossing': return prev != null
      && ((prev < a.price && v >= a.price) || (prev > a.price && v <= a.price));
    case 'crossingDown': return prev != null && prev > a.price && v <= a.price;
    default: return prev != null && prev < a.price && v >= a.price;
  }
}

function checkAlerts() {
  state.alerts.forEach((a) => {
    if (a.triggered) return;
    const q = state.quotes[a.symbol];
    if (!q || q.ltp === null || q.ltp === undefined) return;
    if (alertFires(a, q)) {
      a.triggered = true;
      a.firedAt = Date.now();
      a.firedPrice = q.ltp;
      toast('Alert triggered',
        `${a.symbol} ${COND_LABEL[a.cond || 'crossingUp'].toLowerCase()} `
        + `${fmtPrice(a.price, q.digits)} — last ${fmtPrice(q.ltp, q.digits)}`, 'success');
      saveSoon();
      if (state.panel === 'alerts') renderPanel();
    }
  });
}

/* --------------------------------- panel -------------------------------- */
const RAIL = [
  { id: 'watchlist', icon: 'list', title: 'Watchlist, details and news' },
  { id: 'alerts', icon: 'bell', title: 'Alerts' },
  { id: 'objects', icon: 'tree', title: 'Object tree and data window' },
  { id: 'details', icon: 'info', title: 'Symbol details' },
  { sep: true },
  { id: 'copilot', icon: 'chat', title: 'AI Copilot' },
];

function buildRail() {
  const rail = $('#rail');
  rail.innerHTML = '';
  RAIL.forEach((r) => {
    if (r.sep) {
      const d = document.createElement('div');
      d.className = 'rail-sep';
      rail.appendChild(d);
      return;
    }
    const b = document.createElement('button');
    b.className = 'rail-btn';
    b.dataset.panel = r.id;
    b.title = r.title;
    b.innerHTML = svg(r.icon, 16);
    b.addEventListener('click', () => {
      if (r.id === 'copilot') { toast('AI Copilot', 'Coming soon in this build.'); return; }
      state.panel = r.id;
      renderPanel(); saveSoon();
    });
    rail.appendChild(b);
  });
}

function togglePanel() {
  const sb = $('#sidebar');
  sb.classList.toggle('collapsed');
}

function renderPanel() {
  $$('#rail .rail-btn').forEach((b) =>
    b.classList.toggle('on', b.dataset.panel === state.panel));
  const panel = $('#panel');
  if (state.panel === 'watchlist') panel.innerHTML = watchlistHTML();
  else if (state.panel === 'alerts') panel.innerHTML = alertsHTML();
  else if (state.panel === 'objects') panel.innerHTML = objectsHTML();
  else if (state.panel === 'details') panel.innerHTML = detailsHTML();
  wirePanel();
}

function watchlistSorted() {
  const list = state.watchlist.slice();
  const q = (s) => state.quotes[s.symbol] || {};
  if (state.wlSort === 'name') list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  else if (state.wlSort === 'price') list.sort((a, b) => (q(b).ltp || 0) - (q(a).ltp || 0));
  else if (state.wlSort === 'pct') list.sort((a, b) => (q(b).pct || 0) - (q(a).pct || 0));
  return list;
}

function watchlistHTML() {
  const groups = { index: 'Indices', stock: 'Stocks', futures: 'Futures', crypto: 'Crypto', forex: 'Forex' };
  const byGroup = {};
  watchlistSorted().forEach((w) => {
    const q = state.quotes[w.symbol];
    const type = q ? q.type : 'stock';
    (byGroup[type] = byGroup[type] || []).push(w);
  });
  let html = `<div class="panel-head"><span class="panel-title">Watchlist</span>
    <button id="wlSort" title="Sort watchlist">${svg('chev', 15)}</button>
    <button id="wlAdd" title="Add symbol">${svg('plus', 15)}</button>
    <button id="wlSettings" title="Panel settings">${svg('gear', 15)}</button></div>
    <div class="panel-body">`;
  const order = ['index', 'stock', 'futures', 'crypto', 'forex'];
  order.filter((t) => byGroup[t]).forEach((type) => {
    const items = byGroup[type];
    const collapsed = !!state.wlCollapsed[type];
    html += `<div class="wl-group ${collapsed ? 'collapsed' : ''}" data-group="${type}">
      <button data-collapse="${type}" title="Collapse group">${collapsed ? '▸' : '▾'}</button>
      <b>${groups[type] || type}</b><span>${items.length}</span></div>
      <div class="wl-rows">`;
    items.forEach((w) => {
      const q = state.quotes[w.symbol] || {};
      const digits = q.digits ?? 2;
      const pct = q.pct;
      const cls = pct === undefined ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'dn' : 'flat';
      html += `<div class="wl-row ${w.symbol === state.symbol ? 'active' : ''}"
        data-sym="${esc(w.symbol)}" draggable="true">
        <div class="wl-sym">
          <span class="wl-badge" style="background:${badgeColor(w.symbol)}">${esc(w.symbol[0])}</span>
          <div style="min-width:0">
            <div class="wl-name">${esc(w.symbol)}</div>
            <div class="wl-exch">${esc(q.exchange || '')}</div>
          </div>
        </div>
        <div class="wl-last">${q.ltp !== undefined ? fmtPrice(q.ltp, digits) : '—'}</div>
        ${state.settings.wlPct ? `<div class="wl-pct ${cls}">${pct === undefined ? '—'
          : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'}</div>` : '<div></div>'}
        <button class="wl-del" data-del-sym="${esc(w.symbol)}" title="Remove from watchlist">${svg('trash', 12)}</button>
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

function alertsHTML() {
  let html = `<div class="panel-head"><span class="panel-title">Alerts</span>
    <button id="alClear" title="Remove triggered alerts">${svg('trash', 15)}</button>
    <button id="alAdd" title="Create alert">${svg('plus', 15)}</button></div>
    <div class="panel-body">`;
  const list = state.alerts.slice().sort((a, b) =>
    (a.triggered === b.triggered ? 0 : a.triggered ? 1 : -1));
  if (!list.length) {
    html += `<div class="empty"><b>No alerts</b>
      Create a price alert from the bell, the + button, or by right-clicking the chart.</div>`;
  } else {
    list.forEach((a) => {
      const q = state.quotes[a.symbol] || {};
      const digits = q.digits ?? state.digits;
      html += `<div class="list-row">
        <div class="grow"><div>${esc(a.symbol)} · ${esc(COND_LABEL[a.cond || 'crossingUp'])} ${fmtPrice(a.price, digits)}</div>
          <div class="sub">${a.triggered
        ? `Triggered ${a.firedAt ? DTF.hm.format(new Date(a.firedAt)) : ''}${a.firedPrice ? ' @ ' + fmtPrice(a.firedPrice, digits) : ''}`
        : (q.ltp !== undefined ? `Last ${fmtPrice(q.ltp, digits)}` : 'Watching')}${a.note ? ' · ' + esc(a.note) : ''}</div></div>
        <button class="mini-btn" data-alert-open="${esc(a.symbol)}">open</button>
        <button class="mini-btn danger" data-del-alert="${a.id}">${svg('trash', 13)}</button>
      </div>`;
    });
  }
  html += `</div>`;
  return html;
}

function objectsHTML() {
  let html = `<div class="panel-head"><span class="panel-title">Object tree</span>
    <button id="objClear" title="Remove all drawings">${svg('trash', 15)}</button></div>
    <div class="panel-body">`;
  html += `<div class="wl-group"><b>Indicators</b><span>${state.indicators.length}</span></div>`;
  if (!state.indicators.length) {
    html += '<div class="empty" style="padding:12px">No indicators applied.</div>';
  }
  state.indicators.forEach((ind) => {
    const def = window.Indicators.DEFS[ind.type] || {};
    html += `<div class="list-row">
      <span class="sw" style="width:8px;height:8px;border-radius:50%;background:${(ind.colors || [])[0] || '#888'}"></span>
      <div class="grow"><div>${esc(def.name || ind.type)} ${paramsText(ind)}</div></div>
      <button class="mini-btn" data-edit-ind="${ind.id}">${svg('gear', 12)}</button>
      <button class="mini-btn" data-toggle-ind="${ind.id}">${ind.visible === false ? 'off' : 'on'}</button>
      <button class="mini-btn danger" data-del-ind="${ind.id}">${svg('trash', 13)}</button>
    </div>`;
  });
  html += `<div class="wl-group"><b>Drawings</b><span>${state.drawings.length}</span></div>`;
  if (!state.drawings.length) {
    html += '<div class="empty" style="padding:12px">No drawings yet.</div>';
  }
  state.drawings.forEach((d) => {
    html += `<div class="list-row">
      <div class="grow"><div>${esc(d.type)}${d.text ? ' · ' + esc(d.text) : ''}</div></div>
      <button class="mini-btn" data-sel-draw="${d.id}">select</button>
      <button class="mini-btn danger" data-del-draw="${d.id}">${svg('trash', 13)}</button>
    </div>`;
  });
  html += `</div>`;
  return html;
}

function detailsHTML() {
  const q = state.quotes[state.symbol] || {};
  const bars = state.bars;
  const digits = state.digits;
  const last = bars[bars.length - 1] || {};
  const first = bars[0] || {};
  const perf = (n) => {
    if (bars.length < n + 1) return null;
    const a = bars[bars.length - 1 - n].c, b = bars[bars.length - 1].c;
    return (b / a - 1) * 100;
  };
  const rsiVal = bars.length > 20 ? window.Indicators.lastValue(
    window.Indicators.compute({ type: 'rsi', params: { period: 14 } }, bars).lines, bars.length - 1) : null;
  const smaVal = bars.length > 50 ? window.Indicators.lastValue(
    window.Indicators.compute({ type: 'sma', params: { period: 50 } }, bars).lines, bars.length - 1) : null;
  const trend = rsiVal === null ? '—' : rsiVal > 60 ? 'Strong buy' : rsiVal > 50 ? 'Buy'
    : rsiVal > 40 ? 'Neutral' : rsiVal > 30 ? 'Sell' : 'Strong sell';

  return `<div class="panel-head"><span class="panel-title">${esc(state.symbol)}</span></div>
  <div class="panel-body">
    <div class="detail-block">
      <div style="display:flex;align-items:baseline;gap:8px">
        <div style="font-size:20px;font-weight:600;font-variant-numeric:tabular-nums">
          ${fmtPrice(q.ltp ?? last.c, digits)}</div>
        <div class="${(q.pct ?? 0) >= 0 ? 'tl-chg up' : 'tl-chg down'}" style="font-size:12px">
          ${q.chg !== undefined ? (q.chg >= 0 ? '+' : '') + fmtPrice(q.chg, digits) : ''}
          ${q.pct !== undefined ? '(' + fmtPct(q.pct) + ')' : ''}</div>
      </div>
      <div class="sub" style="color:var(--text-3);font-size:11px;margin-top:3px">
        ${esc(state.name)} · ${esc(state.meta?.exchange || '')} · ${IV_LABEL[state.interval]}</div>
    </div>
    <dl class="kv">
      <dt>Open</dt><dd>${fmtPrice(last.o, digits)}</dd>
      <dt>High</dt><dd>${fmtPrice(last.h, digits)}</dd>
      <dt>Low</dt><dd>${fmtPrice(last.l, digits)}</dd>
      <dt>Close</dt><dd>${fmtPrice(last.c, digits)}</dd>
      <dt>Volume</dt><dd>${fmtCompact(last.v || 0)}</dd>
      <dt>Range</dt><dd>${fmtPrice((last.h || 0) - (last.l || 0), digits)}</dd>
      <dt>RSI (14)</dt><dd>${rsiVal === null ? '—' : rsiVal.toFixed(1)}</dd>
      <dt>SMA (50)</dt><dd>${smaVal === null ? '—' : fmtPrice(smaVal, digits)}</dd>
    </dl>
    <div class="detail-block">
      <div class="detail-h">Performance</div>
      <div class="perf-row">
        ${[['1W', 5], ['1M', 21], ['3M', 63], ['1Y', 252]].map(([label, n]) => {
    const v = perf(n);
    return `<div class="perf-chip"><span>${label}</span>
            <b class="${v === null ? '' : v >= 0 ? 'up' : 'dn'}">${v === null ? '—' : fmtPct(v)}</b></div>`;
  }).join('')}
      </div>
    </div>
    <div class="detail-block">
      <div class="detail-h">Technicals</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="chip">${esc(trend)}</span>
        <span style="color:var(--text-3);font-size:11px">RSI ${rsiVal === null ? '—' : rsiVal.toFixed(0)}</span>
      </div>
    </div>
    <div class="detail-block">
      <div class="detail-h">Chart range</div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-2)">
        <span>${first.t ? DTF.dmy.format(new Date(first.t)) : '—'}</span>
        <span>${last.t ? DTF.dmy.format(new Date(last.t)) : '—'}</span>
      </div>
    </div>
  </div>`;
}

function wirePanel() {
  const panel = $('#panel');
  let dragSym = null;

  panel.querySelectorAll('.wl-row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-del-sym]')) return;
      selectSymbol(row.dataset.sym);
    });
    row.addEventListener('dragstart', (ev) => {
      dragSym = row.dataset.sym;
      row.classList.add('drag');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', dragSym);
      }
    });
    row.addEventListener('dragend', () => { row.classList.remove('drag'); dragSym = null; });
    row.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      row.classList.add('drop-before');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      row.classList.remove('drop-before');
      const sym = dragSym || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
      if (!sym || sym === row.dataset.sym) return;
      const from = state.watchlist.findIndex((w) => w.symbol === sym);
      const to = state.watchlist.findIndex((w) => w.symbol === row.dataset.sym);
      if (from < 0 || to < 0) return;
      const [moved] = state.watchlist.splice(from, 1);
      state.watchlist.splice(to, 0, moved);
      state.wlSort = 'manual';
      renderPanel(); saveSoon();
    });
  });

  panel.querySelectorAll('[data-del-sym]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const sym = b.dataset.delSym;
      state.watchlist = state.watchlist.filter((w) => w.symbol !== sym);
      renderPanel(); saveSoon();
      toast('Removed from watchlist', sym);
    };
  });

  panel.querySelectorAll('[data-collapse]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.collapse;
      state.wlCollapsed[k] = !state.wlCollapsed[k];
      renderPanel(); saveSoon();
    };
  });

  const add = panel.querySelector('#wlAdd');
  if (add) add.onclick = openSearch;
  const wlSort = panel.querySelector('#wlSort');
  if (wlSort) wlSort.onclick = openSortMenu;
  const wlSet = panel.querySelector('#wlSettings');
  if (wlSet) wlSet.onclick = openWlSettings;
  const alAdd = panel.querySelector('#alAdd');
  if (alAdd) alAdd.onclick = () => openAlertModal();
  const alClear = panel.querySelector('#alClear');
  if (alClear) alClear.onclick = () => {
    state.alerts = state.alerts.filter((a) => !a.triggered);
    renderPanel(); saveSoon();
  };
  panel.querySelectorAll('[data-alert-open]').forEach((b) => {
    b.onclick = () => selectSymbol(b.dataset.alertOpen);
  });
  panel.querySelectorAll('[data-del-alert]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      state.alerts = state.alerts.filter((a) => a.id !== b.dataset.delAlert);
      renderPanel(); saveSoon();
    };
  });
  panel.querySelectorAll('[data-edit-ind]').forEach((b) => {
    b.onclick = () => {
      const ind = state.indicators.find((i) => i.id === b.dataset.editInd);
      if (ind) openIndicatorSettings(ind);
    };
  });
  panel.querySelectorAll('[data-del-ind]').forEach((b) => {
    b.onclick = () => {
      state.indicators = state.indicators.filter((i) => i.id !== b.dataset.delInd);
      recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
    };
  });
  panel.querySelectorAll('[data-toggle-ind]').forEach((b) => {
    b.onclick = () => {
      const ind = state.indicators.find((i) => i.id === b.dataset.toggleInd);
      if (ind) {
        ind.visible = ind.visible === false;
        recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
      }
    };
  });
  panel.querySelectorAll('[data-sel-draw]').forEach((b) => {
    b.onclick = () => { state.selection = b.dataset.selDraw; schedule(); };
  });
  panel.querySelectorAll('[data-del-draw]').forEach((b) => {
    b.onclick = () => {
      state.drawings = state.drawings.filter((d) => d.id !== b.dataset.delDraw);
      if (state.selection === b.dataset.delDraw) state.selection = null;
      pushHistory(); renderPanel(); saveSoon(); schedule();
    };
  });
  const clear = panel.querySelector('#objClear');
  if (clear) clear.onclick = () => {
    state.drawings = []; state.selection = null;
    pushHistory(); renderPanel(); saveSoon(); schedule();
  };
}

/* -------------------------------- alerts -------------------------------- */
function openAlertModal(preset) {
  const modal = $('#modal');
  const last = state.bars.length ? state.bars[state.bars.length - 1].c : 0;
  const price = preset ?? last;
  modal.hidden = false;
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>Create alert · ${esc(state.symbol)}</h3>
      <button id="mClose">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Condition</label>
        <select id="alCond">
          ${Object.entries(COND_LABEL).map(([v, l]) =>
    `<option value="${v}" ${v === 'crossingUp' ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="field"><label>Value
        <span class="hint">Compared with the last traded price</span></label>
        <input type="number" id="alPrice" step="any" value="${price}"></div>
      <div class="field"><label>Note</label>
        <input type="text" id="alNote" placeholder="optional"></div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="mCancel">Cancel</button>
      <button class="btn" id="alSave">Create alert</button>
    </div>
  </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  modal.querySelector('#mClose').onclick = close;
  modal.querySelector('#mCancel').onclick = close;
  modal.querySelector('#alSave').onclick = () => {
    const p = parseFloat(modal.querySelector('#alPrice').value);
    if (!isFinite(p)) { toast('Invalid price', 'Enter a number.', 'warn'); return; }
    const cond = modal.querySelector('#alCond').value;
    const q = state.quotes[state.symbol];
    state.alerts.push({
      id: uid(), symbol: state.symbol, price: p, cond,
      note: modal.querySelector('#alNote').value.trim(), triggered: false,
      created: Date.now(), last: q ? q.ltp : undefined,
    });
    close();
    state.panel = 'alerts';
    renderPanel(); saveSoon(); schedule();
    toast('Alert created', `${state.symbol} · ${COND_LABEL[cond]} ${fmtPrice(p, state.digits)}`, 'success');
  };
}

/* -------------------------------- replay -------------------------------- */
function toggleReplay() {
  if (!state.bars.length) return;
  state.replay.on = !state.replay.on;
  state.replay.picking = false;
  if (state.replay.on) {
    state.replay.index = Math.max(20, state.bars.length - 60);
    $('#replayBar').hidden = false;
    state.tool = 'cursor';
    setTool('cursor');
    toast('Bar replay', 'Step with ◀ ▶, pick a start bar with ⤓, or press play.');
  } else {
    stopReplayTimer();
    $('#replayBar').hidden = true;
  }
  recomputeIndicators();
  fitView(state.replay.on ? Math.min(state.replay.index, 160) : undefined);
  syncToolbar();
  schedule();
  updateReplayUI();
}

function stopReplayTimer() {
  if (state.replay.timer) clearInterval(state.replay.timer);
  state.replay.timer = null;
  state.replay.playing = false;
}

function updateReplayUI() {
  $('#replayBar').hidden = !state.replay.on;
  if (!state.replay.on) return;
  const at = state.bars[state.replay.index - 1];
  $('#replayStep').textContent = state.replay.picking ? 'click a bar to start'
    : `${state.replay.index} / ${state.bars.length} · ${at
      ? DTF.full.format(new Date(at.t)) : ''}`;
  $('#replayPlay').textContent = state.replay.playing ? '❚❚' : '▶';
  const sel = $('#replaySpeed');
  if (sel && sel.value !== String(state.replay.speed)) sel.value = String(state.replay.speed);
}

function replayStep(n) {
  if (!state.replay.on) return;
  const follow = atRightEdge(3);
  state.replay.index = clamp(state.replay.index + n, 5, state.bars.length);
  recomputeIndicators();
  computePanes();
  if (follow) state.view.offset = maxOffset();
  clampView();
  schedule(); updateReplayUI();
}

/* -------------------------------- toasts -------------------------------- */
function toast(title, sub, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.innerHTML = `<b>${esc(title)}</b>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}

/* ------------------------------- toolbar -------------------------------- */
function bindToolbar() {
  $('#symbolBtn').onclick = openSearch;
  $('#intervalBtn').onclick = openIntervalMenu;
  $('#typeBtn').onclick = openTypeMenu;
  $('#indicatorsBtn').onclick = openIndicatorsMenu;
  $('#searchBtn').onclick = openSearch;
  $('#settingsBtn').onclick = openSettings;
  $('#sourceChip').onclick = () => {
    if (!state.auth.authorized) {
      location.href = '/api/auth/login?next=terminal';
      return;
    }
    toast('Data source', state.source === 'live'
      ? 'Live Upstox candles and quotes.'
      : 'Sample data — this symbol has no Upstox instrument key.', 'success');
  };
  $('#alertBtn').onclick = () => openAlertModal();
  $('#replayBtn').onclick = toggleReplay;
  $('#layoutBtn').onclick = openLayoutMenu;
  $('#saveBtn').onclick = () => {
    saveState();
    toast('Layout saved', 'Everything is restored on reload.', 'success');
  };
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#replayPlay').onclick = () => {
    if (state.replay.playing) stopReplayTimer();
    else {
      state.replay.playing = true;
      startReplayTimer();
    }
    updateReplayUI();
  };
  $('#replayPrev').onclick = () => replayStep(-1);
  $('#replayNext').onclick = () => replayStep(1);
  $('#replayExit').onclick = toggleReplay;

  $('#compareBtn').onclick = openCompareMenu;

  $('#fullscreenBtn').onclick = () => {
    const app = document.getElementById('app');
    if (document.fullscreenElement) document.exitFullscreen();
    else app.requestFullscreen?.().catch(() => toast('Fullscreen blocked', 'Browser refused fullscreen.', 'warn'));
  };

  $('#snapshotBtn').onclick = takeSnapshot;

  $('#tzBtn').onclick = openTimezoneMenu;
  $('#goLive').onclick = goRealtime;
  $('#shortcutsBtn').onclick = openShortcuts;
  $('#replaySpeed').onchange = (ev) => {
    state.replay.speed = clamp(parseInt(ev.target.value, 10) || 420, 40, 4000);
    if (state.replay.playing) {
      stopReplayTimer();
      state.replay.playing = true;
      startReplayTimer();
    }
    updateReplayUI();
  };
  $('#replayStart').onclick = () => {
    if (!state.replay.on) return;
    state.replay.picking = true;
    toast('Replay start', 'Click the bar you want to start from.');
    updateReplayUI();
  };
  $('#replayJump').onclick = () => {
    if (!state.replay.on) return;
    state.replay.index = 6;
    recomputeIndicators(); computePanes(); clampView(); schedule(); updateReplayUI();
  };
  $('#rangeBtn').onclick = () => {
    const bars = activeBars();
    if (!bars.length) return;
    toast('Date range', `${DTF.dmyy.format(new Date(bars[0].t))} → ${DTF.dmyy.format(new Date(bars[bars.length - 1].t))} · ${bars.length} bars`);
  };
}

function takeSnapshot() {
  render();
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.symbol.replace(/\s+/g, '-')}-${state.interval}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Snapshot saved', a.download, 'success');
  }, 'image/png');
}

/* ------------------------------- keyboard -------------------------------- */
document.addEventListener('keydown', (ev) => {
  const el = document.activeElement;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName);
  const mod = ev.ctrlKey || ev.metaKey;

  if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openSearch(); return; }
  if (typing) return;

  if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
  if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && ev.key.toLowerCase() === 's') {
    ev.preventDefault(); saveState(); toast('Layout saved', '', 'success'); return;
  }
  if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
    ev.preventDefault(); openShortcuts(); return;
  }
  if (ev.altKey && ev.key >= '1' && ev.key <= '9') {
    const iv = INTERVALS[+ev.key - 1];
    if (iv) { ev.preventDefault(); setInterval_(iv[0]); }
    return;
  }
  if (ev.altKey && ev.key.toLowerCase() === 'i') { ev.preventDefault(); openIndicatorsMenu(); return; }
  if (ev.altKey && ev.key.toLowerCase() === 'r') { ev.preventDefault(); toggleReplay(); return; }
  if (ev.altKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); openSettings(); return; }

  if (ev.key === 'Escape') {
    closePopover();
    const modal = $('#modal');
    if (!modal.hidden) { modal.hidden = true; modal.innerHTML = ''; schedule(); return; }
    if (state.replay.picking) { state.replay.picking = false; updateReplayUI(); return; }
    if (state.temp) { state.temp = null; schedule(); return; }
    if (state.tool !== 'cursor') { setTool('cursor'); return; }
    state.selection = null; schedule(); return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (state.selection) { ev.preventDefault(); removeSelection(); }
    return;
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    const d = ev.key === 'ArrowLeft' ? -3 : 3;
    if (ev.shiftKey) {
      state.view.spacing = clamp(state.view.spacing * (d > 0 ? 1.12 : 1 / 1.12), 1.6, 60);
    } else {
      state.view.offset = clamp(state.view.offset + d, 0, maxOffset());
    }
    schedule();
    return;
  }
  if (ev.key === '+' || ev.key === '=') {
    state.view.spacing = clamp(state.view.spacing * 1.15, 1.6, 60);
    clampView(); schedule(); return;
  }
  if (ev.key === '-') {
    state.view.spacing = clamp(state.view.spacing / 1.15, 1.6, 60);
    clampView(); schedule(); return;
  }
  if (ev.key.toLowerCase() === 'f') { fitView(); schedule(); return; }
  if (ev.key === 'Home') { state.view.offset = 0; schedule(); return; }
  if (ev.key === 'End') { goRealtime(); return; }
});

/* --------------------------- dialogs and menus -------------------------- */
function startReplayTimer() {
  stopReplayTimer();
  state.replay.playing = true;
  state.replay.timer = setInterval(() => {
    if (state.replay.index >= state.bars.length) {
      stopReplayTimer();
      updateReplayUI();
      return;
    }
    replayStep(1);
  }, state.replay.speed || 420);
}

function openMenuAt(x, y, build) {
  closePopover();
  popover.hidden = false;
  overlay.hidden = false;
  build(popover);
  const w = popover.offsetWidth, h = popover.offsetHeight;
  popover.style.left = clamp(x, 6, Math.max(6, window.innerWidth - w - 6)) + 'px';
  popover.style.top = clamp(y, 6, Math.max(6, window.innerHeight - h - 6)) + 'px';
}

function resetChart() {
  state.settings.priceStretch = 1;
  state.settings.priceShift = 0;
  state.settings.scale = 'linear';
  state.compare = null;
  fitView();
  updateHeader();
  saveSoon();
  schedule();
  toast('Chart reset', 'Scale, zoom and comparison overlays restored.');
}

function goRealtime() {
  state.view.offset = maxOffset();
  schedule();
}

function copyText(text, title) {
  const done = () => toast(title || 'Copied', text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done,
      () => toast('Clipboard blocked', text, 'warn'));
  } else done();
}

function clearDrawings() {
  if (!state.drawings.length) return;
  state.drawings = [];
  state.selection = null;
  pushHistory(); renderPanel(); saveSoon(); schedule();
  toast('Drawings removed', '');
}

function openDrawingProps(d) {
  const modal = $('#modal');
  modal.hidden = false;
  const styles = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>${esc(d.type)} settings</h3><button id="dpClose">✕</button></div>
    <div class="modal-body">
      <div class="set-section">
        <div class="set-line"><label>Colour</label>
          <input type="color" id="dpColor" value="${d.color || '#e8b34a'}"></div>
        <div class="set-line"><label>Line width</label>
          <input type="number" id="dpWidth" min="1" max="5" step="0.5" value="${d.width || 1.5}"></div>
        <div class="set-line"><label>Line style</label>
          <select id="dpStyle">${styles.map(([v, l]) =>
    `<option value="${v}" ${(d.style || 'solid') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${d.type === 'text' ? `<div class="set-line"><label>Text</label>
          <input type="text" id="dpText" value="${esc(d.text || '')}"></div>` : ''}
        <div class="set-line"><label>Locked</label>
          <div class="switch ${d.locked ? 'on' : ''}" id="dpLock"></div></div>
      </div>
      <div class="ind-tools">
        <button class="btn ghost" id="dpVisible">${d.visible === false ? 'Show' : 'Hide'}</button>
        <button class="btn ghost" id="dpDelete" style="color:var(--down)">Delete</button>
        <span style="flex:1"></span>
        <button class="btn" id="dpDone">Done</button>
      </div>
    </div>
  </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; schedule(); };
  const apply = () => {
    d.color = modal.querySelector('#dpColor').value;
    d.width = parseFloat(modal.querySelector('#dpWidth').value) || 1.5;
    d.style = modal.querySelector('#dpStyle').value;
    const t = modal.querySelector('#dpText');
    if (t) d.text = t.value;
    saveSoon(); schedule();
  };
  modal.querySelector('#dpClose').onclick = close;
  modal.querySelector('#dpDone').onclick = () => { apply(); close(); };
  ['dpColor', 'dpWidth', 'dpStyle', 'dpText'].forEach((id) => {
    const el = modal.querySelector('#' + id);
    if (el) el.addEventListener('input', apply);
  });
  modal.querySelector('#dpLock').onclick = (ev) => {
    d.locked = !d.locked;
    ev.currentTarget.classList.toggle('on', d.locked);
    saveSoon();
  };
  modal.querySelector('#dpVisible').onclick = () => {
    d.visible = d.visible === false;
    close(); saveSoon();
  };
  modal.querySelector('#dpDelete').onclick = () => {
    state.drawings = state.drawings.filter((x) => x.id !== d.id);
    if (state.selection === d.id) state.selection = null;
    pushHistory(); renderPanel(); saveSoon(); close();
  };
}

function openIndicatorSettings(ind) {
  const def = window.Indicators.DEFS[ind.type];
  if (!def) return;
  const modal = $('#modal');
  modal.hidden = false;
  const params = def.params || [];
  const fields = params.map((k) => {
    const label = (def.labels && def.labels[k]) || k;
    const v = (ind.params || def.defaults || {})[k];
    return `<div class="set-line"><label>${esc(label)}</label>
      <input type="number" step="any" data-param="${k}" value="${v}"></div>`;
  }).join('');
  const lineCount = (ind._calc && ind._calc.lines.length) || 1;
  const colors = Array.from({ length: lineCount }).map((_, i) => {
    const col = (ind.colors && ind.colors[i]) || window.Indicators.PALETTE[i % 8];
    return `<div class="set-line"><label>Line ${i + 1}</label>
      <input type="color" data-color="${i}" value="${col}"></div>`;
  }).join('');
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>${esc(def.name)}</h3><button id="isClose">✕</button></div>
    <div class="modal-body">
      <div class="set-section"><h4>Inputs</h4>
        ${fields || '<div class="hint-text">This indicator has no inputs.</div>'}</div>
      <div class="set-section"><h4>Style</h4>${colors}</div>
      <div class="hint-text">${def.pane === 'main' ? 'Drawn over the price chart.' : 'Drawn in its own pane below the price.'}</div>
      <div class="ind-tools">
        <button class="btn ghost" id="isVisible">${ind.visible === false ? 'Show' : 'Hide'}</button>
        <button class="btn ghost" id="isDelete" style="color:var(--down)">Remove</button>
        <span style="flex:1"></span>
        <button class="btn ghost" id="isDefaults">Defaults</button>
        <button class="btn" id="isDone">Done</button>
      </div>
    </div>
  </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; schedule(); };
  const refresh = () => {
    recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
  };
  modal.querySelector('#isClose').onclick = close;
  modal.querySelector('#isDone').onclick = close;
  modal.querySelectorAll('[data-param]').forEach((el) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isFinite(v)) return;
      ind.params = ind.params || {};
      ind.params[el.dataset.param] = v;
      refresh();
    });
  });
  modal.querySelectorAll('[data-color]').forEach((el) => {
    el.addEventListener('input', () => {
      ind.colors = ind.colors || [];
      ind.colors[+el.dataset.color] = el.value;
      refresh();
    });
  });
  modal.querySelector('#isVisible').onclick = (ev) => {
    ind.visible = ind.visible === false;
    ev.currentTarget.textContent = ind.visible === false ? 'Show' : 'Hide';
    refresh();
  };
  modal.querySelector('#isDelete').onclick = () => {
    state.indicators = state.indicators.filter((i) => i.id !== ind.id);
    refresh(); close();
  };
  modal.querySelector('#isDefaults').onclick = () => {
    ind.params = { ...def.defaults };
    ind.colors = [];
    refresh(); close();
  };
}

function openTimezoneMenu() {
  openPopover($('#tzBtn'), (pop) => {
    pop.innerHTML = `<div class="pop-title">Timezone</div>`
      + TZONES.map(([tz, off, city]) =>
        popItem(`${city} <span class="meta">${off}</span>`,
          { on: state.settings.tz === tz, value: tz })).join('');
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      const tz = b.dataset.value;
      closePopover();
      applyTimezone(tz);
      startClock();
      schedule();
      const zone = TZONES.find((z) => z[0] === tz);
      toast('Timezone changed', zone ? zone[2] + ' · ' + zone[1] : tz);
    };
  });
}

function openShortcuts() {
  const rows = [
    ['Symbol search', 'Ctrl K'], ['Save layout', 'Ctrl S'],
    ['Undo / redo', 'Ctrl Z / Ctrl Y'], ['Zoom in / out', '+ / −'],
    ['Pan chart', '← →'], ['Zoom with keys', 'Shift ← →'],
    ['Fit content', 'F'], ['Latest bar', 'End'],
    ['First bar', 'Home'], ['Cancel / close', 'Esc'],
    ['Delete selection', 'Del'], ['Intervals', 'Alt 1…9'],
    ['Indicators', 'Alt I'], ['Bar replay', 'Alt R'],
    ['Chart settings', 'Alt P'], ['This list', '?'],
  ];
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>Keyboard shortcuts</h3><button id="scClose">✕</button></div>
    <div class="modal-body"><div class="sc-grid">
      ${rows.map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`).join('')}
    </div></div>
  </div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  modal.querySelector('#scClose').onclick = close;
}

function openCompareMenu() {
  openPopover($('#compareBtn'), (pop) => {
    const items = state.watchlist.filter((w) => w.symbol !== state.symbol);
    pop.innerHTML = `<div class="pop-title">Compare with</div>`
      + (items.length ? items.map((w) => popItem(w.symbol, {
        on: state.compare && state.compare.symbol === w.symbol, value: w.symbol,
      })).join('') : '<div class="pop-empty">Add symbols to the watchlist first.</div>')
      + (state.compare ? '<div class="pop-sep"></div>'
        + popItem('Remove comparison', { value: '__none' }) : '');
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      const v = b.dataset.value;
      closePopover();
      if (v === '__none') {
        state.compare = null;
        toast('Compare removed', '');
        schedule();
        return;
      }
      loadCompare(v).then(() => toast('Compare added', `${v} normalised to ${state.symbol}`));
    };
  });
}

function openSortMenu() {
  openPopover($('#wlSort'), (pop) => {
    pop.innerHTML = `<div class="pop-title">Sort watchlist</div>`
      + [['manual', 'Manual (drag to reorder)'], ['name', 'Symbol A→Z'],
        ['price', 'Price high → low'], ['pct', 'Change % high → low']]
        .map(([v, l]) => popItem(l, { on: state.wlSort === v, value: v })).join('');
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      state.wlSort = b.dataset.value;
      closePopover(); renderPanel(); saveSoon();
    };
  });
}

function openWlSettings() {
  openPopover($('#wlSettings'), (pop) => {
    pop.innerHTML = `<div class="pop-title">Watchlist</div>
      <button class="pop-item" data-toggle="wlPct"><span style="flex:1">Show change %</span>
        <span class="k">${state.settings.wlPct ? 'on' : 'off'}</span></button>
      <button class="pop-item" data-reset><span style="flex:1">Reset list</span></button>`;
    pop.onclick = (ev) => {
      const b = ev.target.closest('.pop-item');
      if (!b) return;
      if (b.dataset.toggle === 'wlPct') state.settings.wlPct = !state.settings.wlPct;
      if (b.hasAttribute('data-reset')) {
        state.watchlist = DEFAULTS_WATCHLIST.map((s) => ({ symbol: s }));
        state.wlSort = 'manual';
      }
      closePopover(); renderPanel(); saveSoon();
    };
  });
}

function bindLegendActions() {
  const act = (ev) => {
    const gear = ev.target.closest('[data-gear]');
    if (gear) {
      ev.stopPropagation();
      const ind = state.indicators.find((i) => i.id === gear.dataset.gear);
      if (ind) openIndicatorSettings(ind);
      return;
    }
    const eye = ev.target.closest('[data-eye]');
    if (eye) {
      ev.stopPropagation();
      const ind = state.indicators.find((i) => i.id === eye.dataset.eye);
      if (ind) {
        ind.visible = ind.visible === false;
        recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
      }
      return;
    }
    const del = ev.target.closest('[data-del-ind]');
    if (del) {
      ev.stopPropagation();
      state.indicators = state.indicators.filter((i) => i.id !== del.dataset.delInd);
      recomputeIndicators(); computePanes(); renderPanel(); saveSoon(); schedule();
    }
  };
  ['#topLegend', '#paneLegends'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('click', act);
    el.addEventListener('dblclick', (ev) => {
      const row = ev.target.closest('[data-ind]');
      if (!row) return;
      const ind = state.indicators.find((i) => i.id === row.dataset.ind);
      if (ind) openIndicatorSettings(ind);
    });
  });
}

/* -------------------------------- boot ---------------------------------- */
function startClock() {
  const tick = () => {
    const zone = TZONES.find((z) => z[0] === TZ) || TZONES[0];
    $('#clock').textContent = `${DTF.clock.format(new Date())} ${zone[1]}`;
  };
  tick();
  if (state._clock) clearInterval(state._clock);
  state._clock = setInterval(tick, 1000);
}

async function boot() {
  restore();
  document.getElementById('app').dataset.theme = state.settings.theme;
  TZ = state.settings.tz || 'Asia/Kolkata';
  DTF = buildDTF(TZ);
  const zone = TZONES.find((z) => z[0] === TZ) || TZONES[0];
  $('#tzBtn').textContent = zone[1];
  $('#tzBtn').title = TZ;
  buildDrawbar();
  buildRail();
  bindToolbar();
  bindLegendActions();
  $('#intervalLabel').textContent = IV_LABEL[state.interval] || state.interval;

  new ResizeObserver(() => resize()).observe($('#chartWrap'));
  resize();
  startClock();

  await loadStatus();
  await loadSymbols();
  await loadChart();
  await refreshQuotes();
  renderPanel();

  const linked = new URLSearchParams(location.search).get('linked');
  if (linked === '1') {
    toast('Broker connected', 'Upstox is linked — live candles stream on supported symbols.', 'success');
    history.replaceState({}, '', location.pathname);
  }

  setInterval(refreshQuotes, 10000);
  setInterval(refreshLive, 15000);
  setInterval(loadStatus, 120000);

  window.addEventListener('beforeunload', saveDrawingsForCurrent);
}

boot();
