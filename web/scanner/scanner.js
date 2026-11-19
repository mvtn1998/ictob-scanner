/* ICT OB Scanner — web terminal.
   Left ranking list, TradingView-style OB chart, SM-Rally option strip.
   Everything shown here comes from /api/state and /api/chart; the browser
   never computes an order block, score or rank. */
'use strict';

const $ = (id) => document.getElementById(id);
const TFS = [1, 3, 5, 10, 15, 30, 60];
const C = {
  up: '#089981', down: '#f23645',
  bull: '#00b894', bear: '#ff7675',
  vwap: '#fdcb6e', htf: '#0066ff',
  bg: '#131722', panel: '#2a2e39', grid: '#1e222d',
  text: '#d1d4dc', sub: '#787b86', white: '#ffffff',
};

const S = {
  app: null,
  chart: null,
  selected: null,
  mode: 'RALLY + OPT',
  tf: 5,
  vol: false,
  userPicked: false,
  replay: { on: false, cut: null, total: 0, playing: false, timer: null },
  mouse: null,
  chartSeq: 0,
  oiSeq: 0,
};

/* ------------------------------------------------------------------ util */
async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(await r.text().then(t => t.slice(0, 160)));
  return r.json();
}

function setApi(params) {
  const q = new URLSearchParams(params);
  return fetch('/api/set?' + q.toString()).catch(() => null);
}

function istClock(ms) {
  const d = new Date(ms + 330 * 60000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ------------------------------------------------------------------ boot */
function boot() {
  const tf = $('tf');
  for (const m of TFS) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + ' min';
    if (m === 5) o.selected = true;
    tf.appendChild(o);
  }
  bindEvents();
  pollState();
  setInterval(pollState, 2000);
  setInterval(() => { if (!S.replay.on) pollChart(); }, 2000);
  setInterval(pollOI, 4000);
  setInterval(() => { if (!S.replay.on && !S.replay.playing) { /* clock */ } }, 1000);
  window.addEventListener('resize', debounce(() => {
    if (S.chart) drawChart(S.chart);
    drawBars(lastOI ? lastOI.strip : null);
  }, 120));
}

function bindEvents() {
  $('tf').addEventListener('change', (e) => {
    S.tf = parseInt(e.target.value, 10) || 5;
    setApi({ tv: S.tf });
    if (S.replay.on) exitReplay();
    pollChart();
  });
  $('volCandles').addEventListener('change', (e) => {
    S.vol = e.target.checked;
    setApi({ vol: S.vol ? 1 : 0 });
    if (S.chart) drawChart(S.chart);
  });
  $('refreshBtn').addEventListener('click', () => { pollState(); pollChart(); pollOI(); });

  $('mode').addEventListener('change', async (e) => {
    S.mode = e.target.value;
    if (S.replay.on) exitReplay();
    await setApi({ mode: S.mode });
    $('idxPane').hidden = S.mode !== 'INDICES';
    pollState();
  });
  const applyFilter = debounce(() => setApi({ filter: $('search').value.trim() })
    .then(pollState), 260);
  $('search').addEventListener('input', applyFilter);
  $('clearSearch').addEventListener('click', () => {
    $('search').value = '';
    setApi({ filter: '' }).then(pollState);
  });

  $('backIdx').addEventListener('click', async () => {
    await setApi({ index: '' });
    S.selected = null;
    $('chartEmpty').hidden = false;
    $('chartEmpty').textContent = 'Pick a stock from the index list.';
    pollState();
  });
  const applyChg = () => setApi({ chgmin: $('chgMin').value.trim() })
    .then(pollState);
  $('chgMin').addEventListener('change', applyChg);
  $('chgMin').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyChg(); });
  $('clearChg').addEventListener('click', () => {
    $('chgMin').value = '';
    setApi({ chgmin: '' }).then(pollState);
  });

  /* replay controls */
  $('replayBtn').addEventListener('click', toggleReplay);
  $('rExit').addEventListener('click', exitReplay);
  $('rBack').addEventListener('click', () => replayStep(-1));
  $('rFwd').addEventListener('click', () => replayStep(1));
  $('rPlay').addEventListener('click', replayPlayToggle);
  $('rRange').addEventListener('input', (e) => {
    replayGoto(parseInt(e.target.value, 10));
  });

  $('loginBtn').addEventListener('click', openLogin);
  $('loginClose').addEventListener('click', () => { $('loginModal').hidden = true; });
  $('loginModal').addEventListener('click', (e) => {
    if (e.target === $('loginModal')) $('loginModal').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('loginModal').hidden = true; return; }
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); navStep(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); navStep(-1); }
  });

  $('chart').addEventListener('mousemove', (e) => {
    if (!S.chart) return;
    const r = $('chart').getBoundingClientRect();
    S.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    drawChart(S.chart);
  });
  $('chart').addEventListener('mouseleave', () => {
    S.mouse = null;
    if (S.chart) drawChart(S.chart);
  });
}

/* --------------------------------------------------------------- state -- */
async function pollState() {
  let app;
  try { app = await getJson('/api/state'); } catch (e) { return; }
  S.app = app;
  S.mode = app.mode;
  if (!S.selected) S.selected = app.selected || null;

  $('userLbl').textContent = 'user: ' + (app.demo ? '-' : (app.auth.user || '-'));
  $('masterLbl').textContent = app.master + ' · ' + (app.demo ? 'SAMPLE feed' : 'live');
  const badge = $('feedBadge');
  badge.textContent = app.demo ? 'SAMPLE' : 'LIVE';
  badge.className = 'feed' + (app.demo ? '' : ' live');

  const titles = {
    'OB VOL (x)': 'STOCKS — BY OB VOLUME (x)',
    'OPTION + TPM': 'STOCKS — OPTION DETAIL + TPM',
    'RALLY + OPT': 'STOCKS — RALLY + OPTION/TPM',
    'INDICES': 'INDICES — CLICK TO OPEN ITS F&O STOCKS',
  };
  $('rankTitle').textContent = titles[app.mode] || titles['OB VOL (x)'];
  if ($('mode').value !== app.mode) $('mode').value = app.mode;
  if (parseInt($('tf').value, 10) !== app.tv) $('tf').value = app.tv;
  if ($('volCandles').checked !== !!app.vol) $('volCandles').checked = !!app.vol;
  S.vol = !!app.vol;
  S.tf = app.tv;

  const idx = app.mode === 'INDICES';
  $('thSym').textContent = idx ? 'INDEX' : 'SYMBOL';
  $('thX').textContent = idx ? 'CHG %' : 'OB VOL x';
  $('thObs').textContent = idx ? '' : 'OBs';
  $('thCell').textContent = idx ? ''
    : app.mode === 'RALLY + OPT' ? 'RALLY+OPT'
      : app.mode === 'OPTION + TPM' ? 'OPT+TPM' : 'SCORE';

  renderRows(app.rows || [], idx);
  renderIndexPane(app);
  renderMeter(app.meter);

  const phase = app.phase || {};
  $('statusText').textContent =
    `tracking ${app.tracking} F&O stocks · ${app.utc} UTC · selected: ` +
    `${app.selected || '—'} · symbols with errors: ${app.errors} · ` +
    `${phase.msg || ''} · session ${app.session}`;
  $('leftFoot').textContent = `${(app.rows || []).length} rows · ` +
    `${app.mode}${app.demo ? ' · sample session' : ''}`;
  $('optStatus').textContent = idx && app.index
    ? `${app.constituents.length} F&O stocks` : '';

  if (!S.userPicked && !S.selected && app.rows && app.rows.length
      && app.mode !== 'INDICES') {
    pick(app.rows[0].s, false);
  }
  if (!S.selected && app.mode === 'INDICES') {
    $('chartEmpty').hidden = false;
    $('chartEmpty').textContent =
      'INDICES mode — click an index, then a stock in its list.';
  }
}

function rowHtml(r, idxMode) {
  const cls = [];
  if (r.tag) cls.push('t-' + r.tag);
  if (idxMode) cls.push('idx');
  const tag = cls.length ? ' class="' + cls.join(' ') + '"' : '';
  const x = r.x === undefined ? '' : r.x;
  const obs = r.obs === undefined || r.obs === null ? '' : r.obs;
  return `<tr${tag} data-sym="${esc(r.s)}">` +
    `<td class="sym">${esc(r.s)}</td>` +
    `<td class="x num">${esc(String(x))}</td>` +
    `<td class="c num">${esc(String(obs))}</td>` +
    `<td class="c num">${esc(String(r.cell || ''))}</td>` +
    `<td class="ltp num">${esc(String(r.ltp || '—'))}</td></tr>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderRows(rows, idxMode) {
  const body = $('rankBody');
  body.innerHTML = rows.map(r => rowHtml(r, idxMode)).join('');
  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => onRowClick(tr.dataset.sym));
  });
  markSelected();
}

function renderIndexPane(app) {
  const idx = app.mode === 'INDICES';
  $('idxPane').hidden = !(idx && app.index);
  if (!(idx && app.index)) return;
  $('idxLbl').textContent = `${app.index} · ${app.constituents.length} F&O stocks` +
    (app.idx_chg_min !== null && app.idx_chg_min !== undefined
      ? ` | chg ≥ ${app.idx_chg_min}%` : '');
  const body = $('idxBody');
  body.innerHTML = (app.constituents || []).map(r => rowHtml(r, true)).join('');
  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => onRowClick(tr.dataset.sym));
  });
  markSelected();
}

function markSelected() {
  document.querySelectorAll('#rankBody tr, #idxBody tr').forEach(tr => {
    tr.classList.toggle('sel', tr.dataset.sym === S.selected);
  });
}

function onRowClick(sym) {
  if (!sym) return;
  if (S.replay.on) exitReplay();
  S.userPicked = true;
  const wasIndex = S.mode === 'INDICES' &&
    ($('rankBody').querySelector(`tr[data-sym="${CSS.escape(sym)}"]`) !== null);
  if (wasIndex) {
    setApi({ index: sym }).then(() => { pollState(); });
    return;
  }
  pick(sym, true);
}

function pick(sym, scroll) {
  if (!sym) return;
  S.selected = sym;
  markSelected();
  fetch('/api/select?symbol=' + encodeURIComponent(sym)).catch(() => {});
  if (scroll) {
    const tr = $('rankBody').querySelector(`tr[data-sym="${CSS.escape(sym)}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }
  $('chartEmpty').hidden = true;
  pollChart();
  pollOI();
}

function navStep(d) {
  const rows = S.app && S.app.rows ? S.app.rows : [];
  if (!rows.length) return;
  let i = rows.findIndex(r => r.s === S.selected);
  i = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + d));
  onRowClick(rows[i].s);
  pick(rows[i].s, true);
}

/* --------------------------------------------------------------- chart -- */
async function pollChart() {
  if (S.replay.on) return;
  if (!S.selected) return;
  const seq = ++S.chartSeq;
  let d;
  try {
    d = await getJson(`/api/chart?symbol=${encodeURIComponent(S.selected)}&tf=${S.tf}`);
  } catch (e) { return; }
  if (seq !== S.chartSeq) return;
  if (d.error) {
    $('chartEmpty').hidden = false;
    $('chartEmpty').textContent = d.error;
    return;
  }
  $('chartEmpty').hidden = true;
  S.chart = d;
  drawChart(d);
}

function drawChart(d) {
  const cv = $('chart');
  const wrap = cv.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W < 40 || H < 40) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  const cs = d.candles || [];
  if (!cs.length) return;
  const n = cs.length;
  const M = { l: 8, r: 62, t: 8, b: 24 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  if (pw < 30 || ph < 30) return;

  const total = n + 13.5;
  const X = (i) => M.l + (i + 1.5) / total * pw;
  const barW = pw / total;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) {
    if (c[3] < lo) lo = c[3];
    if (c[2] > hi) hi = c[2];
  }
  if (!isFinite(lo) || !isFinite(hi)) return;
  const span = (hi - lo) || (hi * 0.01) || 1;
  lo -= span * 0.036; hi += span * 0.036;
  const Y = (p) => M.t + (hi - p) / (hi - lo) * ph;

  /* ---- grid + price scale (right) ---- */
  const steps = 6;
  g.font = '10px Consolas, monospace';
  g.textBaseline = 'middle';
  for (let i = 0; i <= steps; i++) {
    const p = lo + (hi - lo) * i / steps;
    const y = Math.round(Y(p)) + 0.5;
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(M.l, y); g.lineTo(M.l + pw, y); g.stroke();
    g.fillStyle = C.sub;
    g.textAlign = 'left';
    g.fillText(p.toFixed(2), M.l + pw + 6, y);
  }
  g.strokeStyle = C.panel;
  g.beginPath();
  g.moveTo(M.l + pw + 0.5, M.t); g.lineTo(M.l + pw + 0.5, M.t + ph);
  g.stroke();

  /* ---- time scale ---- */
  const choices = [1, 2, 3, 4, 6, 10, 12, 15, 20, 30, 60, 120, 240];
  const step = choices.find(s => n / s <= 14) || 480;
  const ticks = [];
  for (let i = 0; i < n; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== n - 1) ticks.push(n - 1);
  g.textAlign = 'center';
  g.fillStyle = C.sub;
  for (const i of ticks) {
    const x = X(i);
    if (x > M.l + pw - 2) continue;
    g.fillText(istClock(cs[i][0]), x, H - M.b / 2 + 2);
  }

  /* ---- candles ---- */
  let vmax = 0;
  for (const c of cs) if (c[5] > vmax) vmax = c[5];
  for (let i = 0; i < n; i++) {
    const [, o, h, l, c, v] = cs[i];
    const col = c >= o ? C.up : C.down;
    const x = X(i);
    g.strokeStyle = col;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, Y(h));
    g.lineTo(Math.round(x) + 0.5, Y(l));
    g.stroke();
    let bw = barW * 0.65;
    if (S.vol && vmax > 0) bw = barW * (0.14 + 0.74 * Math.sqrt(Math.max(v, 0) / vmax));
    const x0 = x - bw / 2, x1 = x + bw / 2;
    const y0 = Y(Math.max(o, c)), y1 = Y(Math.min(o, c));
    g.fillStyle = col;
    g.fillRect(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));
  }

  /* ---- session VWAP ---- */
  if ((d.vwap || []).length > 1) {
    g.strokeStyle = C.vwap;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    d.vwap.forEach(([i, val], k) => {
      const x = X(i), y = Y(val);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
  }

  /* ---- order blocks (active only, right edge = last bar) ---- */
  const lastIdx = n - 1;
  for (const ob of d.obs || []) {
    const col = ob.dir === 1 ? C.bull : C.bear;
    const x0 = X(Math.max(0, Math.min(ob.x0, lastIdx)));
    const x1 = X(lastIdx);
    const yTop = Y(ob.top), yBot = Y(ob.bottom);
    g.fillStyle = hexA(col, 0.16);
    g.strokeStyle = hexA(col, 0.95);
    g.lineWidth = 1;
    const w = Math.max(x1 - x0, 1);
    g.fillRect(x0, yTop, w, Math.max(yBot - yTop, 1));
    g.strokeRect(x0 + 0.5, yTop + 0.5, w - 1, Math.max(yBot - yTop - 1, 1));
    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = hexA(col, 0.9);
    g.beginPath();
    g.moveTo(x0, Y(ob.mid)); g.lineTo(x1, Y(ob.mid)); g.stroke();
    g.restore();
    if (ob.grade) {
      const label = `${ob.dir === 1 ? 'BULL' : 'BEAR'} ${ob.grade}` +
        `${ob.tag || ''}${ob.fvg ? ' [FVG]' : ''} ` +
        `(${(ob.vol_ratio || 0).toFixed(2)}x Vol)`;
      g.font = '10px "Segoe UI", sans-serif';
      g.fillStyle = '#ffffff';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(label, x1 - 3, Y(ob.mid), Math.max(w - 6, 0));
    }
  }

  /* ---- HTF levels: PDH/PDL, PWH/PWL, PMH/PML (blue, session only) ---- */
  const htf = d.htf || {};
  const xLab = X(lastIdx + 6);
  g.font = '10px "Segoe UI", sans-serif';
  for (const name of ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML']) {
    const lvl = htf[name];
    if (lvl === null || lvl === undefined) continue;
    const y = Y(lvl);
    if (y < M.t - 2 || y > M.t + ph + 2) continue;
    g.strokeStyle = C.htf;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(0), y); g.lineTo(xLab, y); g.stroke();
    g.fillStyle = C.htf;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(name, xLab + 4, y);
  }

  /* ---- last price: dotted line + right-axis tag with countdown ---- */
  const last = cs[n - 1][4];
  const prev = n > 1 ? cs[n - 2][4] : cs[n - 1][1];
  const lcol = last >= prev ? C.up : C.down;
  const yLast = Y(last);
  g.save();
  g.setLineDash([1, 3]);
  g.strokeStyle = hexA(lcol, 0.6);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(M.l, yLast); g.lineTo(M.l + pw, yLast); g.stroke();
  g.restore();
  const tagH = 30, tagW = M.r - 2;
  const tagY = Math.max(M.t, Math.min(M.t + ph - tagH, yLast - tagH / 2));
  g.fillStyle = lcol;
  roundRect(g, M.l + pw + 1, tagY, tagW, tagH, 3);
  g.fill();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = 'bold 10.5px Consolas, monospace';
  g.textBaseline = 'middle';
  g.fillText(last.toFixed(2), M.l + pw + 1 + tagW / 2, tagY + 10);
  g.font = '9px Consolas, monospace';
  g.fillText(d.countdown || '', M.l + pw + 1 + tagW / 2, tagY + 21);

  /* ---- title + sub (top-left, like the Tk chart) ---- */
  const title = `${d.symbol} · ${d.tf}m` + (d.sector ? ' · ' + d.sector : '')
    + (d.badge ? ' · ' + d.badge : '');
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = 'bold 12px "Segoe UI", sans-serif';
  g.fillStyle = d.badge ? '#ffb454' : C.text;
  g.fillText(title, M.l + 4, M.t + 13);
  g.font = '10px "Segoe UI", sans-serif';
  g.fillStyle = C.sub;
  g.fillText(`Top OB vol ${(d.max_x || 0).toFixed(1)}x   |   days shown: 1   |   ` +
    `rel vol ${(d.rel_vol || 0).toFixed(2)}x   |   ` +
    `${d.demo ? 'sample session' : 'live'}`, M.l + 4, M.t + 27);

  /* ---- crosshair ---- */
  if (S.mouse && S.mouse.x > M.l && S.mouse.x < M.l + pw &&
      S.mouse.y > M.t && S.mouse.y < M.t + ph) {
    const { x, y } = S.mouse;
    g.save();
    g.setLineDash([3, 3]);
    g.strokeStyle = '#5d6470';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, M.t); g.lineTo(x, M.t + ph); g.stroke();
    g.beginPath(); g.moveTo(M.l, y); g.lineTo(M.l + pw, y); g.stroke();
    g.restore();
    const price = hi - (y - M.t) / ph * (hi - lo);
    g.fillStyle = '#363a45';
    g.fillRect(M.l + pw + 1, y - 8, tagW, 16);
    g.fillStyle = '#e6edf3';
    g.font = '9.5px Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(price.toFixed(2), M.l + pw + 1 + tagW / 2, y);
    const idx = Math.round((x - M.l) / pw * total - 1.5);
    if (idx >= 0 && idx < n) {
      const t = istClock(cs[idx][0]);
      g.fillStyle = '#363a45';
      g.fillRect(Math.min(x - 25, M.l + pw - 50), H - M.b + 1, 50, 16);
      g.fillStyle = '#e6edf3';
      g.fillText(t, Math.min(x, M.l + pw - 25), H - M.b + 9);
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function hexA(hex, a) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const gg = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${gg},${b},${a})`;
}

/* ------------------------------------------------------------ replay --- */
function toggleReplay() {
  if (S.replay.on) { exitReplay(); return; }
  if (!S.chart) return;
  S.replay.on = true;
  S.replay.total = (S.chart.candles || []).length;
  if (!S.replay.total) { S.replay.on = false; return; }
  S.replay.cut = S.replay.total - 1;
  $('replaybar').hidden = false;
  $('replayBtn').textContent = '✕ Replay';
  const range = $('rRange');
  range.min = 1; range.max = S.replay.total - 1; range.value = S.replay.cut;
  $('rNow').textContent = replayLabel();
  fetchReplay();
}

function exitReplay() {
  S.replay.on = false;
  S.replay.playing = false;
  clearInterval(S.replay.timer);
  S.replay.timer = null;
  $('replaybar').hidden = true;
  $('replayBtn').textContent = '▶ Replay';
  $('rPlay').textContent = '▶ Play';
  pollChart();
}

function replayLabel() {
  if (!S.chart || !S.chart.candles || !S.chart.candles.length) return '';
  const cs = S.chart.candles;
  return `${istClock(cs[cs.length - 1][0])} · ${S.replay.cut + 1}/${S.replay.total}`;
}

function replayGoto(i) {
  const total = S.replay.total || 1;
  S.replay.cut = Math.max(1, Math.min(total - 1, i));
  $('rRange').value = S.replay.cut;
  fetchReplay();
}

function replayStep(d) {
  if (!S.replay.on) return;
  replayGoto(S.replay.cut + d);
}

async function fetchReplay() {
  if (!S.selected) return;
  const seq = ++S.chartSeq;
  let d;
  try {
    d = await getJson(`/api/chart?symbol=${encodeURIComponent(S.selected)}&tf=${S.tf}&cut=${S.replay.cut}`);
  } catch (e) { return; }
  if (seq !== S.chartSeq || !S.replay.on) return;
  if (d.error) return;
  S.chart = d;
  drawChart(d);
  $('rNow').textContent = replayLabel();
}

function replayPlayToggle() {
  if (S.replay.playing) {
    S.replay.playing = false;
    clearInterval(S.replay.timer);
    S.replay.timer = null;
    $('rPlay').textContent = '▶ Play';
    return;
  }
  S.replay.playing = true;
  $('rPlay').textContent = '❚❚ Pause';
  S.replay.timer = setInterval(() => {
    if (S.replay.cut >= S.replay.total - 1) {
      S.replay.playing = false;
      clearInterval(S.replay.timer);
      S.replay.timer = null;
      $('rPlay').textContent = '▶ Play';
      return;
    }
    replayGoto(S.replay.cut + 1);
  }, 340);
}

/* ---------------------------------------------------------------- OI ---- */
let lastOI = null;

async function pollOI() {
  if (!S.selected) return;
  const seq = ++S.oiSeq;
  let d;
  try {
    d = await getJson('/api/oi?symbol=' + encodeURIComponent(S.selected));
  } catch (e) { return; }
  if (seq !== S.oiSeq) return;
  lastOI = d;
  renderOI(d);
}

function fmtBig(v) {
  v = Number(v || 0);
  for (const [div, suf] of [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']]) {
    if (Math.abs(v) >= div) return (v / div).toFixed(1) + suf;
  }
  return v.toFixed(0);
}

function renderOI(d) {
  const pre = $('oiCard');
  const sym = S.selected || '—';
  if (!d || !d.strip) {
    const err = d && d.error ? d.error : 'loading…';
    pre.textContent = `OPTION DETAIL — ${sym}\n${err}`;
    drawBars(null);
    $('contPct').textContent = '—';
    $('contPct').style.color = '#787b86';
    $('contNote').textContent = '';
    $('tpmTitle').textContent = 'Trade activity / min';
    return;
  }
  const s = d.strip;
  const tr = s.track || {};
  const pct = (s.pct === null || s.pct === undefined) ? null : Number(s.pct);
  const favor = s.day_favor || 'NEUTRAL';
  const lines = [];
  lines.push(`OPTION DETAIL — ${s.symbol}`);
  lines.push(`spot ${Number(s.spot).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}   ` +
    (pct !== null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '') +
    `   expiry ${s.expiry}`);
  lines.push(`flow ${s.flow}   PCR ${Number(s.pcr).toFixed(2)}`);
  lines.push(`CE vol ${fmtBig(s.ce_vol)}   PE vol ${fmtBig(s.pe_vol)}   ` +
    (pct !== null ? `day favor ${pct >= 0 ? 'CE' : 'PE'} · ${favor}`
      : `day favor ${s.track_side || (s.flow_side || '')} (flow) · ${favor}`));
  if (tr && tr.strike) {
    const basis = s.track_basis || 'day';
    lines.push(`track ${tr.side} ${Number(tr.strike).toFixed(0)}  (ATM ${basis})  ` +
      `LTP ${Number(tr.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  ` +
      `${tr.grade}  (score ${Number(tr.score).toFixed(0)})`);
  }
  const rows = s.rows || [];
  if (rows.length) {
    lines.push('');
    lines.push(`${'STRIKE'.padStart(7)}  ${'SIDE'.padEnd(4)}  ` +
      `${'LTP'.padStart(9)}  ${'SPR%'.padStart(5)}  ` +
      `${'VOL'.padStart(8)}  ${'IV'.padStart(4)}  GRADE`);
    lines.push('-'.repeat(52));
    for (const r of rows) {
      const iv = r.iv ? Number(r.iv).toFixed(0) : '-';
      lines.push(
        `${Number(r.strike).toFixed(0).padStart(7)}  ${String(r.side).padEnd(4)}  ` +
        `${Number(r.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(9)}  ` +
        `${Number(r.spr).toFixed(1).padStart(5)}  ` +
        `${String(r.vol).padStart(8)}  ${iv.padStart(4)}  ${r.grade}`);
    }
  } else if (s.zero_vol) {
    lines.push('');
    lines.push('no traded volume today (illiquid / market');
    lines.push('closed) — card built from OI only');
  }
  pre.textContent = lines.join('\n');

  $('tpmTitle').textContent = tr && tr.strike
    ? `Trade activity / min — ${Number(tr.strike).toFixed(0)}${tr.side || ''}`
    : 'Trade activity / min';
  drawBars(s);
  const cont = Number(s.cont || 0);
  $('contPct').textContent = (s.tpm || []).length ? `${cont.toFixed(0)}%` : '—';
  $('contPct').style.color = s.cont_color || C.text;
  $('contNote').textContent = (s.tpm || []).length
    ? `${s.cont_verdict || ''} · ${s.cont_note || ''}` : '';
}

function drawBars(strip) {
  const cv = $('tpmBars');
  const box = cv.parentElement;
  const W = box.clientWidth, H = box.clientHeight - 16;
  if (W < 10 || H < 10) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const tpm = (strip && strip.tpm) || [];
  if (!tpm.length) {
    g.fillStyle = C.sub;
    g.font = '10px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('no 1-min data yet', W / 2, H / 2);
    return;
  }
  const padB = 13, padT = 4, padL = 2, padR = 2;
  const vmax = Math.max(...tpm.map(b => Number(b.v) || 0), 1);
  const bw = (W - padL - padR) / tpm.length;
  for (let i = 0; i < tpm.length; i++) {
    const v = Number(tpm[i].v) || 0;
    const h = (H - padB - padT) * (v / vmax);
    g.fillStyle = v > 0 ? '#00e676' : '#16232e';
    g.fillRect(padL + i * bw, H - padB - h, Math.max(bw - 0.6, 0.6), Math.max(h, 0.8));
  }
  g.fillStyle = C.sub;
  g.font = '9px "Segoe UI", sans-serif';
  g.textBaseline = 'alphabetic';
  const marks = [0, Math.floor(tpm.length / 2), tpm.length - 1];
  const aligns = ['left', 'center', 'right'];
  marks.forEach((i, k) => {
    g.textAlign = aligns[k];
    const x = padL + i * bw + bw / 2;
    g.fillText(tpm[i].t || '', x, H - 2);
  });
}

/* --------------------------------------------------------------- meter -- */
function renderMeter(m) {
  if (!m) return;
  $('mUp').textContent = `${m.up} up`;
  $('mDown').textContent = `${m.down} down`;
  $('mFlat').textContent = `${m.flat} flat`;
  const total = Math.max(1, m.up + m.down + m.flat);
  $('bUp').style.width = (m.up / total * 100) + '%';
  $('bDown').style.width = (m.down / total * 100) + '%';
  $('bFlat').style.width = (m.flat / total * 100) + '%';
  fillPills($('topPills'), m.top, 'pos');
  fillPills($('worstPills'), m.worst, 'neg');
}

function fillPills(box, rows, cls) {
  box.innerHTML = '';
  if (!rows || !rows.length) {
    box.innerHTML = '<span class="pill">—</span>';
    return;
  }
  for (const r of rows) {
    const el = document.createElement('span');
    el.className = 'pill ' + cls;
    el.innerHTML = `<b>${esc(r.s)}</b><span>${esc(r.chg)}</span>`;
    el.addEventListener('click', () => { S.userPicked = true; pick(r.s, true); });
    box.appendChild(el);
  }
}

/* --------------------------------------------------------------- login -- */
function openLogin() {
  $('loginModal').hidden = false;
  if (!$('lRedirect').value) {
    $('lRedirect').value = location.origin + '/callback';
  }
  $('loginMsg').textContent = '';
  $('loginMsg').className = 'msg';
}

function loginMsg(text, ok) {
  $('loginMsg').textContent = text;
  $('loginMsg').className = 'msg ' + (ok ? 'ok' : 'err');
}

async function postAuth(payload) {
  const r = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let d = {};
  try { d = await r.json(); } catch (e) { /* ignore */ }
  return { ok: r.ok, data: d };
}

function initLogin() {
  $('lOpen').addEventListener('click', async (e) => {
    e.preventDefault();
    const key = $('lKey').value.trim();
    const secret = $('lSecret').value.trim();
    const redirect = $('lRedirect').value.trim();
    if (!key || !secret || !redirect) {
      loginMsg('API key, secret and redirect URI are required.', false);
      return;
    }
    const res = await postAuth({
      api_key: key, api_secret: secret, redirect_uri: redirect, save_only: true,
    });
    if (!res.ok) { loginMsg(res.data.error || 'could not save credentials', false); return; }
    window.open('/api/auth/login', '_blank');
    loginMsg('Login page opened — paste the redirected URL below.', true);
  });

  $('lLogin').addEventListener('click', async () => {
    loginMsg('exchanging code…', true);
    const res = await postAuth({
      api_key: $('lKey').value.trim(),
      api_secret: $('lSecret').value.trim(),
      redirect_uri: $('lRedirect').value.trim(),
      code: $('lCode').value.trim(),
    });
    if (!res.ok) { loginMsg(res.data.error || 'login failed', false); return; }
    loginMsg('broker linked — reloading…', true);
    setTimeout(() => location.reload(), 900);
  });

  $('lUseToken').addEventListener('click', async () => {
    const token = $('lToken').value.trim();
    if (!token) { loginMsg('paste an access token first', false); return; }
    const res = await postAuth({ token });
    if (!res.ok) { loginMsg(res.data.error || 'could not save token', false); return; }
    loginMsg('token saved — reloading…', true);
    setTimeout(() => location.reload(), 900);
  });
}

document.addEventListener('DOMContentLoaded', () => { boot(); initLogin(); });
