/* ==========================================================================
   Terminal — indicator math and drawing-tool rendering.
   Pure functions, no DOM. Exposed as window.Indicators / window.Drawings.
   ========================================================================== */
'use strict';

(function () {
  /* ------------------------------ math utils ---------------------------- */
  const nulls = (n) => new Array(n).fill(null);

  function sma(vals, p) {
    const out = nulls(vals.length), n = Math.max(1, p | 0);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(vals, p) {
    const out = nulls(vals.length), n = Math.max(1, p | 0), k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < vals.length; i++) {
      if (i === n - 1) {
        let s = 0;
        for (let j = 0; j < n; j++) s += vals[j];
        prev = s / n;
        out[i] = prev;
      } else if (i >= n) {
        prev = vals[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function wma(vals, p) {
    const out = nulls(vals.length), n = Math.max(1, p | 0), den = n * (n + 1) / 2;
    for (let i = n - 1; i < vals.length; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += vals[i - j] * (n - j);
      out[i] = s / den;
    }
    return out;
  }

  function stdev(vals, p) {
    const out = nulls(vals.length), n = Math.max(1, p | 0);
    for (let i = n - 1; i < vals.length; i++) {
      let m = 0;
      for (let j = 0; j < n; j++) m += vals[i - j];
      m /= n;
      let v = 0;
      for (let j = 0; j < n; j++) v += (vals[i - j] - m) ** 2;
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }

  function rsi(bars, p) {
    const n = Math.max(2, p | 0), out = nulls(bars.length);
    let gain = 0, loss = 0;
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].c - bars[i - 1].c;
      const g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i <= n) {
        gain += g; loss += l;
        if (i === n) {
          gain /= n; loss /= n;
          out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
        }
      } else {
        gain = (gain * (n - 1) + g) / n;
        loss = (loss * (n - 1) + l) / n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    }
    return out;
  }

  function atr(bars, p) {
    const n = Math.max(1, p | 0), out = nulls(bars.length);
    let prev = null;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].c;
      const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
      if (i <= n) {
        prev = prev === null ? tr : prev + tr;
        if (i === n) { prev /= n; out[i] = prev; }
      } else {
        prev = (prev * (n - 1) + tr) / n;
        out[i] = prev;
      }
    }
    return out;
  }

  function vwap(bars) {
    const out = nulls(bars.length);
    let pv = 0, vol = 0, day = '';
    for (let i = 0; i < bars.length; i++) {
      const d = new Date(bars[i].t).toDateString();
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
      pv += tp * (bars[i].v || 0);
      vol += bars[i].v || 0;
      out[i] = vol ? pv / vol : tp;
    }
    return out;
  }

  function obv(bars) {
    const out = [0];
    for (let i = 1; i < bars.length; i++) {
      const dir = Math.sign(bars[i].c - bars[i - 1].c);
      out[i] = out[i - 1] + dir * (bars[i].v || 0);
    }
    return out;
  }

  function macd(bars, fast, slow, sig) {
    const closes = bars.map((b) => b.c);
    const f = ema(closes, fast), s = ema(closes, slow);
    const line = closes.map((_, i) =>
      (f[i] === null || s[i] === null) ? null : f[i] - s[i]);
    const raw = line.map((v) => (v === null ? 0 : v));
    const sigArr = ema(raw, sig);
    const hist = line.map((v, i) =>
      (v === null || sigArr[i] === null) ? null : v - sigArr[i]);
    return { line, signal: sigArr, hist };
  }

  function stoch(bars, p, smooth) {
    const k = nulls(bars.length);
    for (let i = p - 1; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < p; j++) {
        hi = Math.max(hi, bars[i - j].h);
        lo = Math.min(lo, bars[i - j].l);
      }
      const c = bars[i].c;
      k[i] = hi === lo ? 50 : (c - lo) / (hi - lo) * 100;
    }
    const filled = k.map((v) => (v === null ? 50 : v));
    const d = sma(filled, smooth);
    const dOut = d.map((v, i) => (k[i] === null ? null : v));
    return { k, d: dOut };
  }

  function highestAt(vals, p, i) {
    let m = -Infinity;
    for (let j = Math.max(0, i - p + 1); j <= i; j++) m = Math.max(m, vals[j]);
    return m;
  }
  function lowestAt(vals, p, i) {
    let m = Infinity;
    for (let j = Math.max(0, i - p + 1); j <= i; j++) m = Math.min(m, vals[j]);
    return m;
  }

  function psar(bars, step, maxAf) {
    const n = bars.length, out = nulls(n);
    if (n < 3) return out;
    let up = bars[1].c >= bars[0].c;
    let af = step;
    let ep = up ? Math.max(bars[0].h, bars[1].h) : Math.min(bars[0].l, bars[1].l);
    let sar = up ? Math.min(bars[0].l, bars[1].l) : Math.max(bars[0].h, bars[1].h);
    out[0] = up ? bars[0].l : bars[0].h;
    for (let i = 2; i < n; i++) {
      sar = sar + af * (ep - sar);
      if (up) {
        sar = Math.min(sar, bars[i - 1].l, bars[i - 2].l);
        if (bars[i].l < sar) { up = false; sar = ep; ep = bars[i].l; af = step; }
        else if (bars[i].h > ep) { ep = bars[i].h; af = Math.min(maxAf, af + step); }
      } else {
        sar = Math.max(sar, bars[i - 1].h, bars[i - 2].h);
        if (bars[i].h > sar) { up = true; sar = ep; ep = bars[i].h; af = step; }
        else if (bars[i].l < ep) { ep = bars[i].l; af = Math.min(maxAf, af + step); }
      }
      out[i] = sar;
    }
    return out;
  }

  function supertrend(bars, period, mult) {
    const n = bars.length, a = atr(bars, period), out = nulls(n);
    let fu = null, fl = null, st = null, up = true;
    for (let i = 0; i < n; i++) {
      if (a[i] === null) continue;
      const hl2 = (bars[i].h + bars[i].l) / 2;
      const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
      const prevC = i ? bars[i - 1].c : bars[i].c;
      fu = (fu === null || bu < fu || prevC > fu) ? bu : fu;
      fl = (fl === null || bl > fl || prevC < fl) ? bl : fl;
      if (st === null) st = up ? fl : fu;
      else if (up && bars[i].c < fl) { up = false; st = fu; }
      else if (!up && bars[i].c > fu) { up = true; st = fl; }
      else st = up ? fl : fu;
      out[i] = st;
    }
    return out;
  }

  function adx(bars, p) {
    const n = bars.length, plus = nulls(n), minus = nulls(n), out = nulls(n);
    if (n < p * 2 + 1) return { adx: out, plus, minus };
    const tr = [0], pd = [0], md = [0];
    for (let i = 1; i < n; i++) {
      const b = bars[i], pb = bars[i - 1];
      tr[i] = Math.max(b.h - b.l, Math.abs(b.h - pb.c), Math.abs(b.l - pb.c));
      const upM = b.h - pb.h, dnM = pb.l - b.l;
      pd[i] = upM > dnM && upM > 0 ? upM : 0;
      md[i] = dnM > upM && dnM > 0 ? dnM : 0;
    }
    let trS = 0, pS = 0, mS = 0;
    const dx = [];
    for (let i = 1; i < n; i++) {
      if (i <= p) {
        trS += tr[i]; pS += pd[i]; mS += md[i];
        if (i < p) continue;
      } else {
        trS = trS - trS / p + tr[i];
        pS = pS - pS / p + pd[i];
        mS = mS - mS / p + md[i];
      }
      const pdi = trS ? 100 * pS / trS : 0;
      const mdi = trS ? 100 * mS / trS : 0;
      plus[i] = pdi; minus[i] = mdi;
      dx.push({ i, v: (pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0 });
    }
    const smoothed = sma(dx.map((d) => d.v), p);
    dx.forEach((d, k) => { if (smoothed[k] !== null) out[d.i] = smoothed[k]; });
    return { adx: out, plus, minus };
  }

  function cci(bars, p) {
    const n = bars.length, out = nulls(n);
    const tp = bars.map((b) => (b.h + b.l + b.c) / 3);
    for (let i = p - 1; i < n; i++) {
      let m = 0;
      for (let j = 0; j < p; j++) m += tp[i - j];
      m /= p;
      let dev = 0;
      for (let j = 0; j < p; j++) dev += Math.abs(tp[i - j] - m);
      dev /= p;
      out[i] = dev ? (tp[i] - m) / (0.015 * dev) : 0;
    }
    return out;
  }

  function willr(bars, p) {
    const n = bars.length, out = nulls(n);
    for (let i = p - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < p; j++) {
        hi = Math.max(hi, bars[i - j].h);
        lo = Math.min(lo, bars[i - j].l);
      }
      out[i] = hi === lo ? -50 : -100 * (hi - bars[i].c) / (hi - lo);
    }
    return out;
  }

  function mfi(bars, p) {
    const n = bars.length, out = nulls(n);
    const tp = bars.map((b) => (b.h + b.l + b.c) / 3);
    const pos = [0], neg = [0];
    for (let i = 1; i < n; i++) {
      const flow = tp[i] * (bars[i].v || 0);
      const up = tp[i] > tp[i - 1];
      pos[i] = up ? flow : 0;
      neg[i] = up ? 0 : flow;
    }
    for (let i = p; i < n; i++) {
      let ps = 0, ns = 0;
      for (let j = 0; j < p; j++) { ps += pos[i - j]; ns += neg[i - j]; }
      out[i] = ns === 0 ? 100 : 100 - 100 / (1 + ps / ns);
    }
    return out;
  }

  function roc(bars, p) {
    const n = bars.length, out = nulls(n);
    for (let i = p; i < n; i++) {
      const base = bars[i - p].c;
      out[i] = base ? (bars[i].c / base - 1) * 100 : null;
    }
    return out;
  }

  function donchian(bars, p) {
    const n = bars.length;
    const upper = nulls(n), lower = nulls(n), mid = nulls(n);
    for (let i = p - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < p; j++) {
        hi = Math.max(hi, bars[i - j].h);
        lo = Math.min(lo, bars[i - j].l);
      }
      upper[i] = hi; lower[i] = lo; mid[i] = (hi + lo) / 2;
    }
    return { upper, lower, mid };
  }

  function keltner(bars, p, mult) {
    const closes = bars.map((b) => b.c);
    const mid = ema(closes, p), a = atr(bars, p);
    const n = bars.length;
    const upper = nulls(n), lower = nulls(n);
    for (let i = 0; i < n; i++) {
      if (mid[i] === null || a[i] === null) continue;
      upper[i] = mid[i] + mult * a[i];
      lower[i] = mid[i] - mult * a[i];
    }
    return { mid, upper, lower };
  }

  /* Classic floor-trader pivots from the previous session. */
  function pivots(bars) {
    const n = bars.length;
    const pp = nulls(n), r1 = nulls(n), s1 = nulls(n), r2 = nulls(n), s2 = nulls(n);
    let key = null, cur = null, prev = null;
    for (let i = 0; i < n; i++) {
      const d = new Date(bars[i].t).toDateString();
      if (d !== key) {
        if (cur) prev = cur;
        cur = { h: bars[i].h, l: bars[i].l, c: bars[i].c };
        key = d;
      } else {
        cur.h = Math.max(cur.h, bars[i].h);
        cur.l = Math.min(cur.l, bars[i].l);
        cur.c = bars[i].c;
      }
      if (!prev) continue;
      const P = (prev.h + prev.l + prev.c) / 3;
      const range = prev.h - prev.l;
      pp[i] = P; r1[i] = 2 * P - prev.l; s1[i] = 2 * P - prev.h;
      r2[i] = P + range; s2[i] = P - range;
    }
    return { pp, r1, s1, r2, s2 };
  }

  /* ------------------------------ definitions --------------------------- */
  const DEFS = {
    sma: {
      name: 'Simple Moving Average', short: 'SMA', pane: 'main',
      defaults: { period: 20 }, params: ['period'],
      calc: (b, p) => ({ lines: [{ vals: sma(b.map((x) => x.c), p.period) }] }),
    },
    ema: {
      name: 'Exponential Moving Average', short: 'EMA', pane: 'main',
      defaults: { period: 21 }, params: ['period'],
      calc: (b, p) => ({ lines: [{ vals: ema(b.map((x) => x.c), p.period) }] }),
    },
    wma: {
      name: 'Weighted Moving Average', short: 'WMA', pane: 'main',
      defaults: { period: 20 }, params: ['period'],
      calc: (b, p) => ({ lines: [{ vals: wma(b.map((x) => x.c), p.period) }] }),
    },
    bb: {
      name: 'Bollinger Bands', short: 'BB', pane: 'main',
      defaults: { period: 20, mult: 2 }, params: ['period', 'mult'],
      calc: (b, p) => {
        const c = b.map((x) => x.c);
        const mid = sma(c, p.period), sd = stdev(c, p.period);
        return {
          lines: [
            { vals: mid.map((m, i) => m === null ? null : m + sd[i] * p.mult), kind: 'line' },
            { vals: mid, kind: 'line' },
            { vals: mid.map((m, i) => m === null ? null : m - sd[i] * p.mult), kind: 'line' },
          ],
        };
      },
    },
    vwap: {
      name: 'Volume Weighted Average Price', short: 'VWAP', pane: 'main',
      defaults: {}, params: [],
      calc: (b) => ({ lines: [{ vals: vwap(b) }] }),
    },
    volume: {
      name: 'Volume', short: 'Vol', pane: 'sub',
      defaults: {}, params: [], histogram: true,
      calc: (b) => ({ lines: [{ vals: b.map((x) => x.v || 0), kind: 'hist' }] }),
    },
    rsi: {
      name: 'Relative Strength Index', short: 'RSI', pane: 'sub',
      defaults: { period: 14 }, params: ['period'], fixed: [0, 100], levels: [30, 70],
      calc: (b, p) => ({ lines: [{ vals: rsi(b, p.period) }] }),
    },
    macd: {
      name: 'MACD', short: 'MACD', pane: 'sub',
      defaults: { fast: 12, slow: 26, signal: 9 }, params: ['fast', 'slow', 'signal'],
      calc: (b, p) => {
        const m = macd(b, p.fast, p.slow, p.signal);
        return {
          lines: [
            { vals: m.hist, kind: 'hist' },
            { vals: m.line, kind: 'line' },
            { vals: m.signal, kind: 'line' },
          ],
        };
      },
    },
    atr: {
      name: 'Average True Range', short: 'ATR', pane: 'sub',
      defaults: { period: 14 }, params: ['period'],
      calc: (b, p) => ({ lines: [{ vals: atr(b, p.period) }] }),
    },
    stoch: {
      name: 'Stochastic', short: 'Stoch', pane: 'sub',
      defaults: { period: 14, smooth: 3 }, params: ['period', 'smooth'],
      fixed: [0, 100], levels: [20, 80],
      calc: (b, p) => {
        const s = stoch(b, p.period, p.smooth);
        return { lines: [{ vals: s.k, kind: 'line' }, { vals: s.d, kind: 'line' }] };
      },
    },
    obv: {
      name: 'On Balance Volume', short: 'OBV', pane: 'sub',
      defaults: {}, params: [], labels: {},
      calc: (b) => ({ lines: [{ vals: obv(b) }] }),
    },
    supertrend: {
      name: 'Supertrend', short: 'ST', pane: 'main',
      defaults: { period: 10, mult: 3 }, params: ['period', 'mult'],
      labels: { period: 'ATR length', mult: 'Multiplier' },
      calc: (b, p) => ({ lines: [{ vals: supertrend(b, p.period, p.mult) }] }),
    },
    psar: {
      name: 'Parabolic SAR', short: 'PSAR', pane: 'main',
      defaults: { step: 0.02, max: 0.2 }, params: ['step', 'max'],
      labels: { step: 'Step', max: 'Max step' },
      calc: (b, p) => ({ lines: [{ vals: psar(b, p.step, p.max), kind: 'dots' }] }),
    },
    donchian: {
      name: 'Donchian Channels', short: 'DC', pane: 'main',
      defaults: { period: 20 }, params: ['period'], labels: { period: 'Length' },
      calc: (b, p) => {
        const d = donchian(b, p.period);
        return { lines: [{ vals: d.upper }, { vals: d.mid }, { vals: d.lower }] };
      },
    },
    keltner: {
      name: 'Keltner Channels', short: 'KC', pane: 'main',
      defaults: { period: 20, mult: 2 }, params: ['period', 'mult'],
      labels: { period: 'Length', mult: 'Multiplier' },
      calc: (b, p) => {
        const k = keltner(b, p.period, p.mult);
        return { lines: [{ vals: k.upper }, { vals: k.mid }, { vals: k.lower }] };
      },
    },
    pivots: {
      name: 'Pivot Points (session)', short: 'Pivots', pane: 'main',
      defaults: {}, params: [], labels: {},
      calc: (b) => {
        const p = pivots(b);
        return {
          lines: [
            { vals: p.pp }, { vals: p.r1 }, { vals: p.s1 },
            { vals: p.r2 }, { vals: p.s2 },
          ],
        };
      },
    },
    adx: {
      name: 'Average Directional Index', short: 'ADX', pane: 'sub',
      defaults: { period: 14 }, params: ['period'], labels: { period: 'Length' },
      fixed: [0, 60], levels: [20],
      calc: (b, p) => {
        const r = adx(b, p.period);
        return {
          lines: [
            { vals: r.adx, color: '#2962ff' },
            { vals: r.plus, color: '#26a69a' },
            { vals: r.minus, color: '#ef5350' },
          ],
        };
      },
    },
    cci: {
      name: 'Commodity Channel Index', short: 'CCI', pane: 'sub',
      defaults: { period: 20 }, params: ['period'], labels: { period: 'Length' },
      levels: [-100, 100],
      calc: (b, p) => ({ lines: [{ vals: cci(b, p.period) }] }),
    },
    willr: {
      name: 'Williams %R', short: '%R', pane: 'sub',
      defaults: { period: 14 }, params: ['period'], labels: { period: 'Length' },
      fixed: [-100, 0], levels: [-80, -20],
      calc: (b, p) => ({ lines: [{ vals: willr(b, p.period) }] }),
    },
    mfi: {
      name: 'Money Flow Index', short: 'MFI', pane: 'sub',
      defaults: { period: 14 }, params: ['period'], labels: { period: 'Length' },
      fixed: [0, 100], levels: [20, 80],
      calc: (b, p) => ({ lines: [{ vals: mfi(b, p.period) }] }),
    },
    roc: {
      name: 'Rate of Change', short: 'ROC', pane: 'sub',
      defaults: { period: 9 }, params: ['period'], labels: { period: 'Length' },
      levels: [0],
      calc: (b, p) => ({ lines: [{ vals: roc(b, p.period) }] }),
    },
  };

  const PALETTE = ['#2962ff', '#ff9800', '#e91e63', '#00bcd4',
    '#8bc34a', '#ab47bc', '#f5c542', '#ff5252'];

  function compute(ind, bars) {
    const def = DEFS[ind.type];
    if (!def || !bars.length) return { lines: [], def };
    const res = def.calc(bars, ind.params || def.defaults);
    const lines = (res.lines || []).map((ln, idx) => ({
      vals: ln.vals,
      kind: ln.kind || (def.histogram ? 'hist' : 'line'),
      color: ln.color || (ind.colors && ind.colors[idx]) || PALETTE[idx % PALETTE.length],
      width: ln.width || 1.5,
    }));
    return { lines, def };
  }

  function lastValue(lines, index) {
    for (const ln of lines) {
      for (let i = Math.min(index, ln.vals.length - 1); i >= 0; i--) {
        if (ln.vals[i] !== null && ln.vals[i] !== undefined) return ln.vals[i];
      }
    }
    return null;
  }

  window.Indicators = { DEFS, PALETTE, compute, lastValue, sma, ema };
})();

/* ==========================================================================
   Drawing tools: rendering + hit testing.
   Geometry is supplied by the chart (G) so drawings stay in data space.
   ========================================================================== */
(function () {
  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  function line(ctx, x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  function arrowHead(ctx, x0, y0, x1, y1, size) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - size * Math.cos(a - 0.42), y1 - size * Math.sin(a - 0.42));
    ctx.lineTo(x1 - size * Math.cos(a + 0.42), y1 - size * Math.sin(a + 0.42));
    ctx.closePath(); ctx.fill();
  }

  function label(ctx, text, x, y, color, bg) {
    ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
    const w = ctx.measureText(text).width + 8, h = 16;
    ctx.fillStyle = bg; ctx.fillRect(x, y - h / 2, w, h);
    ctx.fillStyle = color; ctx.fillText(text, x + 4, y + 4);
  }

  function pts(d, G) {
    return d.pts.map((p) => ({ x: G.x(p.i), y: G.y(p.p), p: p.p, i: p.i }));
  }

  function drawOne(ctx, d, G) {
    const P = pts(d, G);
    if (!P.length || d.visible === false) return;
    const col = d.color || G.colors.draw;
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = d.width || 1.4;
    ctx.setLineDash(d.style === 'dashed' ? [7, 4]
      : d.style === 'dotted' ? [2, 3] : (d.dash || []));
    const y0 = P[0].x, y1 = P[1] ? P[1].x : P[0].x;

    switch (d.type) {
      case 'trendline':
        if (P[1]) line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
        break;
      case 'ray':
        if (P[1]) {
          const dx = P[1].x - P[0].x, dy = P[1].y - P[0].y;
          const k = dx === 0 ? 1 : (G.W - P[0].x) / dx;
          line(ctx, P[0].x, P[0].y, P[0].x + dx * Math.max(k, 1), P[0].y + dy * Math.max(k, 1));
        }
        break;
      case 'arrow':
        if (P[1]) {
          line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
          arrowHead(ctx, P[0].x, P[0].y, P[1].x, P[1].y, 9);
        }
        break;
      case 'hline':
        line(ctx, 0, P[0].y, G.W, P[0].y);
        label(ctx, G.fmt(P[0].p), Math.max(4, G.W - 92), P[0].y - 9, col, G.colors.panel);
        break;
      case 'vline':
        line(ctx, P[0].x, 0, P[0].x, G.H);
        break;
      case 'channel':
        if (P[1]) {
          const off = P[2] ? P[2].y - (P[0].y + (P[1].y - P[0].y) *
            ((P[2].x - P[0].x) / ((P[1].x - P[0].x) || 1))) : 28;
          ctx.beginPath();
          ctx.moveTo(P[0].x, P[0].y); ctx.lineTo(P[1].x, P[1].y);
          ctx.moveTo(P[0].x, P[0].y + off); ctx.lineTo(P[1].x, P[1].y + off);
          ctx.stroke();
          ctx.globalAlpha = 0.10;
          ctx.beginPath();
          ctx.moveTo(P[0].x, P[0].y); ctx.lineTo(P[1].x, P[1].y);
          ctx.lineTo(P[1].x, P[1].y + off); ctx.lineTo(P[0].x, P[0].y + off);
          ctx.closePath(); ctx.fill();
        }
        break;
      case 'rect':
        if (P[1]) {
          const x = Math.min(P[0].x, P[1].x), y = Math.min(P[0].y, P[1].y);
          const w = Math.abs(P[1].x - P[0].x), h = Math.abs(P[1].y - P[0].y);
          ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
        }
        break;
      case 'ellipse':
        if (P[1]) {
          const cx = (P[0].x + P[1].x) / 2, cy = (P[0].y + P[1].y) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(P[1].x - P[0].x) / 2,
            Math.abs(P[1].y - P[0].y) / 2, 0, 0, Math.PI * 2);
          ctx.globalAlpha = 0.12; ctx.fill();
          ctx.globalAlpha = 1; ctx.stroke();
        }
        break;
      case 'brush':
        ctx.beginPath();
        P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        break;
      case 'fib': {
        if (!P[1]) break;
        const xa = Math.min(P[0].x, P[1].x), xb = Math.max(P[0].x, P[1].x);
        const pa = P[0].p, pb = P[1].p;
        FIB.forEach((f) => {
          const price = pa + (pb - pa) * f;
          const y = G.y(price);
          ctx.globalAlpha = f === 0 || f === 1 ? 1 : 0.65;
          line(ctx, xa, y, xb, y);
          ctx.globalAlpha = 1;
          label(ctx, `${(f * 100).toFixed(1)}%  ${G.fmt(price)}`, xb + 4, y, G.colors.text2, G.colors.panel);
        });
        ctx.globalAlpha = 0.07;
        ctx.fillRect(xa, Math.min(P[0].y, P[1].y), xb - xa, Math.abs(P[1].y - P[0].y));
        ctx.globalAlpha = 1;
        break;
      }
      case 'text': {
        ctx.font = '12px -apple-system, Segoe UI, Roboto, sans-serif';
        const t = d.text || 'Text';
        const w = ctx.measureText(t).width + 10;
        ctx.fillStyle = G.colors.panel; ctx.fillRect(P[0].x - 2, P[0].y - 15, w, 19);
        ctx.fillStyle = col; ctx.fillText(t, P[0].x + 3, P[0].y - 1);
        break;
      }
      case 'measure': {
        if (!P[1]) break;
        const dp = P[1].p - P[0].p;
        const pct = (dp / P[0].p) * 100;
        const bars = Math.round(P[1].i - P[0].i);
        const x = Math.min(P[0].x, P[1].x), w = Math.abs(P[1].x - P[0].x);
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = dp >= 0 ? G.colors.up : G.colors.down;
        ctx.fillRect(x, Math.min(P[0].y, P[1].y), w, Math.abs(P[1].y - P[0].y));
        ctx.globalAlpha = 1;
        ctx.setLineDash([4, 3]);
        line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
        ctx.setLineDash([]);
        const txt = `${dp >= 0 ? '+' : ''}${G.fmt(dp)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ${bars} bars`;
        label(ctx, txt, Math.max(4, P[1].x - 150), P[1].y - 14,
          dp >= 0 ? G.colors.up : G.colors.down, G.colors.panel);
        break;
      }
      case 'long':
      case 'short': {
        if (!P[1]) break;
        const entry = P[0].p, stop = P[1].p;
        const dir = d.type === 'long' ? 1 : -1;
        const risk = Math.abs(entry - stop) || entry * 0.01;
        const target = entry + dir * risk * 2;
        const x = Math.min(P[0].x, P[1].x), w = Math.max(40, Math.abs(P[1].x - P[0].x));
        const ye = G.y(entry), yt = G.y(target), ys = G.y(stop);
        ctx.fillStyle = G.colors.up; ctx.globalAlpha = 0.16;
        ctx.fillRect(x, Math.min(ye, yt), w, Math.abs(ye - yt));
        ctx.fillStyle = G.colors.down; ctx.globalAlpha = 0.16;
        ctx.fillRect(x, Math.min(ye, ys), w, Math.abs(ye - ys));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = G.colors.up; line(ctx, x, ye, x + w, ye);
        label(ctx, `Entry ${G.fmt(entry)}`, x + 4, ye - 10, G.colors.text, G.colors.panel);
        label(ctx, `Target ${G.fmt(target)}  R:R 1:2`, x + 4, yt - 10, G.colors.up, G.colors.panel);
        label(ctx, `Stop ${G.fmt(stop)}`, x + 4, ys + 10, G.colors.down, G.colors.panel);
        break;
      }
      default:
        if (P[1]) line(ctx, P[0].x, P[0].y, P[1].x, P[1].y);
    }
    ctx.restore();
  }

  function drawSelection(ctx, d, G) {
    const P = pts(d, G);
    ctx.save();
    ctx.fillStyle = '#2962ff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    P.forEach((p) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
    ctx.restore();
  }

  function segDist(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = dx * dx + dy * dy || 1;
    let t = ((px - x0) * dx + (py - y0) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    const cx = x0 + t * dx, cy = y0 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function hit(d, x, y, G) {
    if (d.visible === false) return false;
    const P = pts(d, G);
    if (!P.length) return false;
    switch (d.type) {
      case 'hline': return Math.abs(y - P[0].y) < 7;
      case 'vline': return Math.abs(x - P[0].x) < 7;
      case 'text': {
        const w = (d.text || 'Text').length * 7 + 12;
        return x >= P[0].x - 4 && x <= P[0].x + w && Math.abs(y - P[0].y + 6) < 14;
      }
      case 'rect':
      case 'ellipse':
      case 'channel':
      case 'long':
      case 'short':
      case 'fib': {
        if (!P[1]) return false;
        const x0 = Math.min(P[0].x, P[1].x), x1 = Math.max(P[0].x, P[1].x);
        const y0 = Math.min(P[0].y, P[1].y), y1 = Math.max(P[0].y, P[1].y);
        return x >= x0 - 6 && x <= x1 + 6 && y >= y0 - 6 && y <= y1 + 6;
      }
      case 'brush': {
        for (let i = 1; i < P.length; i++) {
          if (segDist(x, y, P[i - 1].x, P[i - 1].y, P[i].x, P[i].y) < 6) return true;
        }
        return false;
      }
      default:
        if (!P[1]) return Math.hypot(x - P[0].x, y - P[0].y) < 8;
        return segDist(x, y, P[0].x, P[0].y, P[1].x, P[1].y) < 6;
    }
  }

  function handleAt(d, x, y, G) {
    const P = pts(d, G);
    for (let i = 0; i < P.length; i++) {
      if (Math.hypot(x - P[i].x, y - P[i].y) < 7) return i;
    }
    return -1;
  }

  window.Drawings = { drawOne, drawSelection, hit, handleAt, FIB };
})();
