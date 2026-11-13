// Technical indicators.
// Every calc(bars, params, ctx) returns arrays aligned 1:1 with the bars; NaN = no value (a gap).
// The math helpers are also exported as `ta` for user scripts (see script-worker.js).

import { withAlpha } from './util.js';

const isNum = Number.isFinite;
const DAY = 86400;

// Candle colors of the current theme (live bindings: importers see updates).
export let UP = '#2EBD85';
export let DOWN = '#F6465D';
export function setTrendColors(up, down) { UP = up; DOWN = down; }
const alpha = withAlpha;
export const PALETTE = ['#4FA3F7', '#FF9800', '#E040FB', '#00BCD4', '#FFEB3B', '#4CAF50', '#F06292', '#8D6E63'];

// ---------------------------------------------------------------------------
// Math helpers (all take/return plain arrays)
// ---------------------------------------------------------------------------

const nanArray = (n) => new Array(n).fill(NaN);
const pick = (bars, key) => bars.map((b) => b[key]);

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
export function source(bars, name = 'close') {
  switch (name) {
    case 'hl2': return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return bars.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    case 'open': case 'high': case 'low': case 'volume': return pick(bars, name);
    default: return pick(bars, 'close');
  }
}

export function sma(src, len) {
  const out = nanArray(src.length);
  let sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > len) { sum -= src[i - len]; count = len; }
    if (count === len) out[i] = sum / len;
  }
  return out;
}

/** Exponential average seeded with an SMA. alpha defaults to 2/(len+1); 1/len gives Wilder's RMA. */
export function ema(src, len, alpha = 2 / (len + 1)) {
  const out = nanArray(src.length);
  let prev = NaN, sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) continue;
    if (!isNum(prev)) {
      sum += v; count++;
      if (count === len) { prev = sum / len; out[i] = prev; }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const rma = (src, len) => ema(src, len, 1 / len);

export function wma(src, len) {
  const out = nanArray(src.length);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - j];
      if (!isNum(v)) { ok = false; break; }
      s += v * (len - j);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

/** Rolling sum; NaN while the window holds a missing value. */
export function sum(src, len) {
  const out = nanArray(src.length);
  let s = 0, bad = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNum(v)) s += v; else bad++;
    if (i >= len) { const o = src[i - len]; if (isNum(o)) s -= o; else bad--; }
    if (i >= len - 1 && !bad) out[i] = s;
  }
  return out;
}

export function stdev(src, len) {
  const out = nanArray(src.length);
  let s = 0, sq = 0, bad = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (isNum(v)) { s += v; sq += v * v; } else bad++;
    if (i >= len) { const o = src[i - len]; if (isNum(o)) { s -= o; sq -= o * o; } else bad--; }
    if (i >= len - 1 && !bad) out[i] = Math.sqrt(Math.max(sq / len - (s / len) ** 2, 0));
  }
  return out;
}

function rollingExtreme(src, len, better) {
  const out = nanArray(src.length);
  for (let i = len - 1; i < src.length; i++) {
    let v = NaN;
    for (let j = 0; j < len; j++) {
      const x = src[i - j];
      if (isNum(x) && (!isNum(v) || better(x, v))) v = x;
    }
    out[i] = v;
  }
  return out;
}
export const highest = (src, len) => rollingExtreme(src, len, (a, b) => a > b);
export const lowest = (src, len) => rollingExtreme(src, len, (a, b) => a < b);

/** Bars since the highest (or lowest) value within the last len+1 bars. */
function barsSinceExtreme(src, len, better) {
  const out = nanArray(src.length);
  for (let i = len; i < src.length; i++) {
    let best = src[i], at = 0;
    for (let j = 1; j <= len; j++) if (better(src[i - j], best)) { best = src[i - j]; at = j; }
    out[i] = at;
  }
  return out;
}

export const change = (src, len = 1) => src.map((v, i) => (i >= len ? v - src[i - len] : NaN));
export const mom = change;
export const roc = (src, len) => src.map((v, i) => (i >= len && src[i - len] ? (100 * (v - src[i - len])) / src[i - len] : NaN));

export function cum(src) {
  let s = 0;
  return src.map((v) => (s += isNum(v) ? v : 0));
}

export const shift = (src, k) => src.map((_, i) => (i - k >= 0 && i - k < src.length ? src[i - k] : NaN));

export function linreg(src, len, offset = 0) {
  const out = nanArray(src.length);
  const sx = (len * (len - 1)) / 2;
  const sxx = ((len - 1) * len * (2 * len - 1)) / 6;
  for (let i = len - 1; i < src.length; i++) {
    let sy = 0, sxy = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const y = src[i - len + 1 + j];
      if (!isNum(y)) { ok = false; break; }
      sy += y; sxy += j * y;
    }
    if (!ok) continue;
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx);
    const intercept = (sy - slope * sx) / len;
    out[i] = intercept + slope * (len - 1 - offset);
  }
  return out;
}

export function hma(src, len) {
  const half = wma(src, Math.max(1, Math.round(len / 2)));
  const full = wma(src, len);
  return wma(half.map((v, i) => 2 * v - full[i]), Math.max(1, Math.round(Math.sqrt(len))));
}

export function dema(src, len) {
  const e1 = ema(src, len), e2 = ema(e1, len);
  return e1.map((v, i) => 2 * v - e2[i]);
}

export function tema(src, len) {
  const e1 = ema(src, len), e2 = ema(e1, len), e3 = ema(e2, len);
  return e1.map((v, i) => 3 * v - 3 * e2[i] + e3[i]);
}

export function vwma(src, vol, len) {
  const num = sma(src.map((v, i) => v * vol[i]), len);
  const den = sma(vol, len);
  return num.map((v, i) => (den[i] ? v / den[i] : NaN));
}

export function alma(src, len, offset = 0.85, sigma = 6) {
  const out = nanArray(src.length);
  const m = offset * (len - 1), s = len / sigma;
  const w = Array.from({ length: len }, (_, j) => Math.exp(-((j - m) ** 2) / (2 * s * s)));
  const norm = w.reduce((a, b) => a + b, 0);
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - len + 1 + j];
      if (!isNum(v)) { ok = false; break; }
      acc += v * w[j];
    }
    if (ok) out[i] = acc / norm;
  }
  return out;
}

export function rsi(src, len) {
  const gain = src.map((v, i) => (i === 0 ? NaN : Math.max(v - src[i - 1], 0)));
  const loss = src.map((v, i) => (i === 0 ? NaN : Math.max(src[i - 1] - v, 0)));
  const ag = rma(gain, len), al = rma(loss, len);
  return ag.map((g, i) => (!isNum(g) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const m = f.map((v, i) => v - s[i]);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: m.map((v, i) => v - sig[i]) };
}

export function bb(src, len = 20, mult = 2) {
  const basis = sma(src, len), dev = stdev(src, len);
  return { basis, upper: basis.map((b, i) => b + mult * dev[i]), lower: basis.map((b, i) => b - mult * dev[i]) };
}

/** Raw stochastic %K of src within the high/low range of the last len bars. */
export function stoch(src, high, low, len) {
  const hh = highest(high, len), ll = lowest(low, len);
  return src.map((v, i) => (hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
}

export function cci(src, len) {
  const ma = sma(src, len);
  return src.map((v, i) => {
    if (!isNum(ma[i])) return NaN;
    let md = 0;
    for (let j = 0; j < len; j++) md += Math.abs(src[i - j] - ma[i]);
    md /= len;
    return md ? (v - ma[i]) / (0.015 * md) : 0;
  });
}

export function tr(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export const atr = (bars, len) => rma(tr(bars), len);

export function mfi(bars, len) {
  const tp = source(bars, 'hlc3');
  const pos = tp.map((v, i) => (i > 0 && v > tp[i - 1] ? v * bars[i].volume : 0));
  const neg = tp.map((v, i) => (i > 0 && v < tp[i - 1] ? v * bars[i].volume : 0));
  const sp = sum(pos, len), sn = sum(neg, len);
  return sp.map((p, i) => (!isNum(p) ? NaN : sn[i] === 0 ? 100 : 100 - 100 / (1 + p / sn[i])));
}

export function obv(bars) {
  let s = 0;
  return bars.map((b, i) => (s += i === 0 ? 0 : Math.sign(b.close - bars[i - 1].close) * b.volume));
}

export function wpr(bars, len) {
  const hh = highest(pick(bars, 'high'), len), ll = lowest(pick(bars, 'low'), len);
  return bars.map((b, i) => (hh[i] === ll[i] ? -50 : (-100 * (hh[i] - b.close)) / (hh[i] - ll[i])));
}

export function dmi(bars, diLen = 14, adxLen = 14) {
  const plusDM = bars.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.high - bars[i - 1].high, down = bars[i - 1].low - b.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = bars.map((b, i) => {
    if (i === 0) return NaN;
    const up = b.high - bars[i - 1].high, down = bars[i - 1].low - b.low;
    return down > up && down > 0 ? down : 0;
  });
  const trur = rma(tr(bars), diLen);
  const plus = rma(plusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const minus = rma(minusDM, diLen).map((v, i) => (100 * v) / trur[i]);
  const dx = plus.map((p, i) => { const s = p + minus[i]; return Math.abs(p - minus[i]) / (s === 0 ? 1 : s); });
  return { plus, minus, adx: rma(dx, adxLen).map((v) => 100 * v) };
}

export function supertrend(bars, factor = 3, len = 10) {
  const a = atr(bars, len);
  const value = nanArray(bars.length), direction = nanArray(bars.length);
  let fu = NaN, fl = NaN, dir = 1;
  for (let i = 0; i < bars.length; i++) {
    if (!isNum(a[i])) continue;
    const b = bars[i];
    const hl2 = (b.high + b.low) / 2;
    const bu = hl2 + factor * a[i], bl = hl2 - factor * a[i];
    const pc = i > 0 ? bars[i - 1].close : b.close;
    const nfu = !isNum(fu) || bu < fu || pc > fu ? bu : fu;
    const nfl = !isNum(fl) || bl > fl || pc < fl ? bl : fl;
    if (isNum(fu)) {
      if (dir === -1 && b.close > nfu) dir = 1;
      else if (dir === 1 && b.close < nfl) dir = -1;
    }
    fu = nfu; fl = nfl;
    value[i] = dir === 1 ? fl : fu;
    direction[i] = dir;
  }
  return { value, direction };
}

/** VWAP that restarts every day (bar times are in exchange/local time). */
export function vwap(bars) {
  const out = nanArray(bars.length);
  let day = null, pv = 0, vol = 0;
  bars.forEach((b, i) => {
    const d = Math.floor(b.time / DAY);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume; vol += b.volume;
    out[i] = vol > 0 ? pv / vol : tp;
  });
  return out;
}

export function psar(bars, start = 0.02, inc = 0.02, max = 0.2) {
  const n = bars.length;
  const out = nanArray(n), dir = nanArray(n);
  if (n < 2) return { sar: out, dir };
  let up = bars[1].close >= bars[0].close;
  let ep = up ? bars[0].high : bars[0].low;
  let sar = up ? bars[0].low : bars[0].high;
  let af = start;
  for (let i = 1; i < n; i++) {
    const b = bars[i], p1 = bars[i - 1], p2 = bars[Math.max(0, i - 2)];
    sar += af * (ep - sar);
    if (up) {
      sar = Math.min(sar, p1.low, p2.low);
      if (b.low < sar) { up = false; sar = ep; ep = b.low; af = start; }
      else if (b.high > ep) { ep = b.high; af = Math.min(af + inc, max); }
    } else {
      sar = Math.max(sar, p1.high, p2.high);
      if (b.high > sar) { up = true; sar = ep; ep = b.high; af = start; }
      else if (b.low < ep) { ep = b.low; af = Math.min(af + inc, max); }
    }
    out[i] = sar;
    dir[i] = up ? 1 : -1;
  }
  return { sar: out, dir };
}

export const crossover = (a, b) => a.map((v, i) => {
  const bv = Array.isArray(b) ? b[i] : b, bp = Array.isArray(b) ? b[i - 1] : b;
  return i > 0 && v > bv && a[i - 1] <= bp;
});
export const crossunder = (a, b) => a.map((v, i) => {
  const bv = Array.isArray(b) ? b[i] : b, bp = Array.isArray(b) ? b[i - 1] : b;
  return i > 0 && v < bv && a[i - 1] >= bp;
});
export const cross = (a, b) => crossover(a, b).map((x, i) => x || crossunder(a, b)[i]);

/** Price at pivot-high bars (higher than `left` bars before and `right` bars after), NaN elsewhere. */
export function pivothigh(src, left = 5, right = 5) {
  return src.map((v, i) => {
    if (i < left || i + right >= src.length) return NaN;
    for (let j = 1; j <= left; j++) if (!(v > src[i - j])) return NaN;
    for (let j = 1; j <= right; j++) if (!(v >= src[i + j])) return NaN;
    return v;
  });
}
export function pivotlow(src, left = 5, right = 5) {
  return src.map((v, i) => {
    if (i < left || i + right >= src.length) return NaN;
    for (let j = 1; j <= left; j++) if (!(v < src[i - j])) return NaN;
    for (let j = 1; j <= right; j++) if (!(v <= src[i + j])) return NaN;
    return v;
  });
}

// ---------------------------------------------------------------------------
// Indicator definitions
// ---------------------------------------------------------------------------

const P = (key, label, def, min = 1, max = 1000, step = 1) => ({ key, label, def, min, max, step });
const SRC = (def = 'close') => ({ key: 'source', label: 'Source', def, type: 'select', options: SOURCES });
const levelsFill = (top, bottom, color) => ({ from: '_top', to: '_bottom', color, consts: { _top: top, _bottom: bottom } });

/** Builds a simple single-line moving average definition. */
const maDef = (name, short, description, len, fn) => ({
  name, short, description, category: 'Moving averages', overlay: true,
  params: [P('length', 'Length', len), SRC()],
  plots: [{ key: 'ma', title: short, color: 'auto' }],
  calc: (bars, p) => ({ ma: fn(source(bars, p.source), p.length, bars) }),
});

export const CATEGORIES = [
  'Moving averages', 'Bands & channels', 'Trend', 'Oscillators', 'Momentum', 'Trend strength', 'Volume', 'Volatility',
];

export const INDICATORS = {
  // --- Moving averages ------------------------------------------------------
  sma: maDef('Moving Average (SMA)', 'SMA', 'Simple moving average', 20, sma),
  ema: maDef('Moving Average Exponential (EMA)', 'EMA', 'Exponential moving average', 21, (s, len) => ema(s, len)),
  wma: maDef('Moving Average Weighted (WMA)', 'WMA', 'Linearly weighted moving average', 9, wma),
  hma: maDef('Hull Moving Average', 'HMA', 'Fast, smooth moving average with little lag', 9, hma),
  dema: maDef('Double EMA', 'DEMA', 'Double exponential moving average', 9, dema),
  tema: maDef('Triple EMA', 'TEMA', 'Triple exponential moving average', 9, tema),
  smma: maDef('Smoothed Moving Average', 'SMMA', 'Wilder-smoothed average (RMA)', 7, rma),
  vwma: maDef('Volume Weighted Moving Average', 'VWMA', 'Moving average weighted by volume', 20, (s, len, bars) => vwma(s, pick(bars, 'volume'), len)),
  alma: maDef('Arnaud Legoux Moving Average', 'ALMA', 'Gaussian-weighted moving average', 9, (s, len) => alma(s, len)),
  lsma: maDef('Least Squares Moving Average', 'LSMA', 'Linear regression end point', 25, (s, len) => linreg(s, len)),
  macross: {
    name: 'MA Cross', short: 'MA Cross', description: 'Fast and slow moving averages', category: 'Moving averages', overlay: true,
    params: [P('fast', 'Fast length', 9), P('slow', 'Slow length', 21), { key: 'kind', label: 'Type', def: 'EMA', type: 'select', options: ['EMA', 'SMA'] }],
    plots: [{ key: 'fast', title: 'Fast', color: '#00BCD4' }, { key: 'slow', title: 'Slow', color: '#FF9800' }],
    calc: (bars, p) => {
      const c = source(bars), f = p.kind === 'SMA' ? sma : ema;
      return { fast: f(c, p.fast), slow: f(c, p.slow) };
    },
  },

  // --- Bands & channels -------------------------------------------------------
  bb: {
    name: 'Bollinger Bands', short: 'BB', description: 'SMA with bands at N standard deviations', category: 'Bands & channels', overlay: true,
    params: [P('length', 'Length', 20), P('mult', 'StdDev', 2, 0.1, 10, 0.1), SRC()],
    plots: [
      { key: 'upper', title: 'Upper', color: '#4FA3F7', width: 1 },
      { key: 'basis', title: 'Basis', color: '#FF6D00', width: 1 },
      { key: 'lower', title: 'Lower', color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => bb(source(bars, p.source), p.length, p.mult),
  },
  keltner: {
    name: 'Keltner Channels', short: 'KC', description: 'EMA with bands at N × ATR', category: 'Bands & channels', overlay: true,
    params: [P('length', 'Length', 20), P('mult', 'Multiplier', 2, 0.1, 10, 0.1), P('atrLength', 'ATR length', 10)],
    plots: [
      { key: 'upper', title: 'Upper', color: '#4FA3F7', width: 1 },
      { key: 'basis', title: 'Basis', color: '#4FA3F7', width: 1 },
      { key: 'lower', title: 'Lower', color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const basis = ema(source(bars), p.length), a = atr(bars, p.atrLength);
      return { basis, upper: basis.map((v, i) => v + p.mult * a[i]), lower: basis.map((v, i) => v - p.mult * a[i]) };
    },
  },
  donchian: {
    name: 'Donchian Channels', short: 'DC', description: 'Highest high and lowest low over N bars', category: 'Bands & channels', overlay: true,
    params: [P('length', 'Length', 20)],
    plots: [
      { key: 'upper', title: 'Upper', color: '#4FA3F7', width: 1 },
      { key: 'basis', title: 'Basis', color: '#FF6D00', width: 1 },
      { key: 'lower', title: 'Lower', color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const upper = highest(pick(bars, 'high'), p.length), lower = lowest(pick(bars, 'low'), p.length);
      return { upper, lower, basis: upper.map((v, i) => (v + lower[i]) / 2) };
    },
  },
  envelopes: {
    name: 'Envelopes', short: 'Env', description: 'Moving average with bands at ±N percent', category: 'Bands & channels', overlay: true,
    params: [P('length', 'Length', 20), P('percent', 'Percent', 10, 0.1, 100, 0.1)],
    plots: [
      { key: 'upper', title: 'Upper', color: '#4FA3F7', width: 1 },
      { key: 'basis', title: 'Basis', color: '#FF6D00', width: 1 },
      { key: 'lower', title: 'Lower', color: '#4FA3F7', width: 1 },
    ],
    fills: [{ from: 'upper', to: 'lower', color: 'rgba(33, 150, 243, 0.07)' }],
    calc: (bars, p) => {
      const basis = sma(source(bars), p.length), k = p.percent / 100;
      return { basis, upper: basis.map((v) => v * (1 + k)), lower: basis.map((v) => v * (1 - k)) };
    },
  },

  // --- Trend ----------------------------------------------------------------------
  supertrend: {
    name: 'Supertrend', short: 'Supertrend', description: 'ATR-based trend-following stop line', category: 'Trend', overlay: true,
    params: [P('length', 'ATR length', 10), P('factor', 'Factor', 3, 0.1, 20, 0.1)],
    plots: [
      { key: 'up', title: 'Up trend', color: UP, optional: true },
      { key: 'down', title: 'Down trend', color: DOWN, optional: true },
    ],
    calc: (bars, p) => {
      const { value, direction } = supertrend(bars, p.factor, p.length);
      return {
        up: value.map((v, i) => (direction[i] === 1 ? v : NaN)),
        down: value.map((v, i) => (direction[i] === -1 ? v : NaN)),
      };
    },
  },
  ichimoku: {
    name: 'Ichimoku Cloud', short: 'Ichimoku', description: 'Conversion, base, lagging span and cloud', category: 'Trend', overlay: true, hideLastValue: true,
    params: [P('conversion', 'Conversion length', 9), P('base', 'Base length', 26), P('spanB', 'Span B length', 52), P('displacement', 'Displacement', 26)],
    plots: [
      { key: 'conversion', title: 'Conversion', color: '#4FA3F7', width: 1 },
      { key: 'base', title: 'Base', color: '#B71C1C', width: 1 },
      { key: 'lagging', title: 'Lagging span', color: '#43A047', width: 1 },
      { key: 'spanA', title: 'Leading span A', color: '#A5D6A7', width: 1 },
      { key: 'spanB', title: 'Leading span B', color: '#EF9A9A', width: 1 },
    ],
    fills: [{ from: 'spanA', to: 'spanB', colors: ['rgba(67, 160, 71, 0.12)', 'rgba(244, 67, 54, 0.12)'] }],
    calc: (bars, p) => {
      const h = pick(bars, 'high'), l = pick(bars, 'low');
      const mid = (len) => { const hh = highest(h, len), ll = lowest(l, len); return hh.map((v, i) => (v + ll[i]) / 2); };
      const conversion = mid(p.conversion), base = mid(p.base), b52 = mid(p.spanB);
      const d = p.displacement - 1;
      const a = conversion.map((v, i) => (v + base[i]) / 2);
      return {
        conversion, base,
        lagging: bars.map((_, i) => (i + d < bars.length ? bars[i + d].close : NaN)),
        spanA: shift(a, d), spanB: shift(b52, d),
      };
    },
  },
  psar: {
    name: 'Parabolic SAR', short: 'SAR', description: 'Stop-and-reverse dots that trail the trend', category: 'Trend', overlay: true,
    params: [P('start', 'Start', 0.02, 0.001, 1, 0.001), P('inc', 'Increment', 0.02, 0.001, 1, 0.001), P('max', 'Maximum', 0.2, 0.01, 1, 0.01)],
    plots: [{ key: 'sar', title: 'SAR', type: 'dots', colorFn: (i, out) => (out.dir[i] === 1 ? UP : DOWN) }],
    calc: (bars, p) => psar(bars, p.start, p.inc, p.max),
  },
  vwap: {
    name: 'VWAP', short: 'VWAP', description: 'Volume-weighted average price, resets each day', category: 'Trend', overlay: true,
    params: [],
    plots: [{ key: 'vwap', title: 'VWAP', color: '#4FA3F7' }],
    calc: (bars) => ({ vwap: vwap(bars) }),
  },
  pivots: {
    name: 'Pivot Points Standard', short: 'Pivots', description: 'Support and resistance from the previous period', category: 'Trend', overlay: true, hideLastValue: true,
    params: [{ key: 'kind', label: 'Type', def: 'Traditional', type: 'select', options: ['Traditional', 'Fibonacci'] }],
    plots: [
      { key: 'r3', title: 'R3', color: '#EC5246', width: 1, type: 'step' },
      { key: 'r2', title: 'R2', color: '#EC5246', width: 1, type: 'step' },
      { key: 'r1', title: 'R1', color: '#EC5246', width: 1, type: 'step' },
      { key: 'p', title: 'P', color: '#FF9800', width: 1, type: 'step' },
      { key: 's1', title: 'S1', color: '#34B886', width: 1, type: 'step' },
      { key: 's2', title: 'S2', color: '#34B886', width: 1, type: 'step' },
      { key: 's3', title: 'S3', color: '#34B886', width: 1, type: 'step' },
    ],
    calc: (bars, p, ctx = {}) => {
      // Period: day for intraday charts, week for daily, month for weekly, year for monthly.
      const sec = ctx.tfSec || 3600;
      const periodOf = (t) => {
        if (sec < DAY) return Math.floor(t / DAY);
        const d = new Date(t * 1000);
        if (sec < 7 * DAY) return Math.floor((t / DAY + 3) / 7);
        if (sec < 28 * DAY) return d.getUTCFullYear() * 12 + d.getUTCMonth();
        return d.getUTCFullYear();
      };
      const keys = ['p', 'r1', 's1', 'r2', 's2', 'r3', 's3'];
      const out = Object.fromEntries(keys.map((k) => [k, nanArray(bars.length)]));
      let cur = null, ph = -Infinity, pl = Infinity, pc = NaN, lv = null, curH = -Infinity, curL = Infinity;
      bars.forEach((b, i) => {
        const per = periodOf(b.time);
        if (per !== cur) {
          if (cur !== null) { ph = curH; pl = curL; pc = bars[i - 1].close; }
          cur = per; curH = -Infinity; curL = Infinity;
          if (isNum(pc)) {
            const pp = (ph + pl + pc) / 3, r = ph - pl;
            lv = p.kind === 'Fibonacci'
              ? { p: pp, r1: pp + 0.382 * r, s1: pp - 0.382 * r, r2: pp + 0.618 * r, s2: pp - 0.618 * r, r3: pp + r, s3: pp - r }
              : { p: pp, r1: 2 * pp - pl, s1: 2 * pp - ph, r2: pp + r, s2: pp - r, r3: ph + 2 * (pp - pl), s3: pl - 2 * (ph - pp) };
          }
          curH = b.high; curL = b.low;
          return; // leave a gap at the first bar of each period
        }
        curH = Math.max(curH, b.high); curL = Math.min(curL, b.low);
        if (lv) for (const k of keys) out[k][i] = lv[k];
      });
      return out;
    },
  },

  // --- Oscillators ------------------------------------------------------------------
  rsi: {
    name: 'Relative Strength Index', short: 'RSI', description: 'Momentum oscillator, 0–100', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 14), SRC()],
    levels: [70, 30],
    fills: [levelsFill(70, 30, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'rsi', title: 'RSI', color: '#7E57C2' }],
    calc: (bars, p) => ({ rsi: rsi(source(bars, p.source), p.length) }),
  },
  stochrsi: {
    name: 'Stochastic RSI', short: 'Stoch RSI', description: 'Stochastic applied to RSI', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('k', 'K', 3), P('d', 'D', 3), P('rsiLength', 'RSI length', 14), P('stochLength', 'Stochastic length', 14)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'k', title: 'K', color: '#4FA3F7' }, { key: 'd', title: 'D', color: '#FF6D00' }],
    calc: (bars, p) => {
      const r = rsi(source(bars), p.rsiLength);
      const k = sma(stoch(r, r, r, p.stochLength), p.k);
      return { k, d: sma(k, p.d) };
    },
  },
  stoch: {
    name: 'Stochastic', short: 'Stoch', description: 'Close relative to the recent high–low range', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', '%K length', 14), P('smooth', '%K smoothing', 3), P('d', '%D smoothing', 3)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'k', title: '%K', color: '#4FA3F7' }, { key: 'd', title: '%D', color: '#FF6D00' }],
    calc: (bars, p) => {
      const k = sma(stoch(source(bars), pick(bars, 'high'), pick(bars, 'low'), p.length), p.smooth);
      return { k, d: sma(k, p.d) };
    },
  },
  cci: {
    name: 'Commodity Channel Index', short: 'CCI', description: 'Distance of price from its average', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 20), SRC('hlc3')],
    levels: [100, -100],
    fills: [levelsFill(100, -100, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'cci', title: 'CCI', color: '#4FA3F7' }],
    calc: (bars, p) => ({ cci: cci(source(bars, p.source), p.length) }),
  },
  willr: {
    name: 'Williams %R', short: '%R', description: 'Close within the recent range, 0 to −100', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 14)],
    levels: [-20, -80],
    fills: [levelsFill(-20, -80, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'r', title: '%R', color: '#7E57C2' }],
    calc: (bars, p) => ({ r: wpr(bars, p.length) }),
  },
  mfi: {
    name: 'Money Flow Index', short: 'MFI', description: 'Volume-weighted RSI', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 14)],
    levels: [80, 20],
    fills: [levelsFill(80, 20, 'rgba(126, 87, 194, 0.08)')],
    plots: [{ key: 'mfi', title: 'MF', color: '#7E57C2' }],
    calc: (bars, p) => ({ mfi: mfi(bars, p.length) }),
  },
  uo: {
    name: 'Ultimate Oscillator', short: 'UO', description: 'Buying pressure across three timeframes', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('fast', 'Fast', 7), P('middle', 'Middle', 14), P('slow', 'Slow', 28)],
    plots: [{ key: 'uo', title: 'UO', color: '#F44336' }],
    calc: (bars, p) => {
      const bp = bars.map((b, i) => b.close - Math.min(b.low, i ? bars[i - 1].close : b.low));
      const t = bars.map((b, i) => Math.max(b.high, i ? bars[i - 1].close : b.high) - Math.min(b.low, i ? bars[i - 1].close : b.low));
      const avg = (len) => { const a = sum(bp, len), c = sum(t, len); return a.map((v, i) => v / c[i]); };
      const a1 = avg(p.fast), a2 = avg(p.middle), a3 = avg(p.slow);
      return { uo: a1.map((v, i) => (100 * (4 * v + 2 * a2[i] + a3[i])) / 7) };
    },
  },
  cmo: {
    name: 'Chande Momentum Oscillator', short: 'CMO', description: 'Net up vs down moves, −100 to 100', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 9)],
    levels: [50, -50],
    plots: [{ key: 'cmo', title: 'CMO', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const ch = change(source(bars));
      const su = sum(ch.map((v) => (v > 0 ? v : 0)), p.length), sd = sum(ch.map((v) => (v < 0 ? -v : 0)), p.length);
      return { cmo: su.map((u, i) => (u + sd[i] ? (100 * (u - sd[i])) / (u + sd[i]) : 0)) };
    },
  },
  fisher: {
    name: 'Fisher Transform', short: 'Fisher', description: 'Turns prices into a near-normal distribution', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 9)],
    levels: [1.5, 0, -1.5],
    plots: [{ key: 'fisher', title: 'Fisher', color: '#4FA3F7' }, { key: 'trigger', title: 'Trigger', color: '#FF6D00' }],
    calc: (bars, p) => {
      const h = source(bars, 'hl2'), hh = highest(h, p.length), ll = lowest(h, p.length);
      const fisher = nanArray(bars.length), trigger = nanArray(bars.length);
      let v = 0, f = 0;
      for (let i = 0; i < bars.length; i++) {
        if (!isNum(hh[i])) continue;
        const r = hh[i] - ll[i];
        v = 0.66 * ((r ? (h[i] - ll[i]) / r : 0.5) - 0.5) + 0.67 * v;
        v = Math.max(-0.999, Math.min(0.999, v));
        trigger[i] = f;
        f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * f;
        fisher[i] = f;
      }
      return { fisher, trigger };
    },
  },
  tsi: {
    name: 'True Strength Index', short: 'TSI', description: 'Double-smoothed momentum', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('long', 'Long length', 25), P('short', 'Short length', 13), P('signal', 'Signal length', 13)],
    levels: [0],
    plots: [{ key: 'tsi', title: 'TSI', color: '#4FA3F7' }, { key: 'signal', title: 'Signal', color: '#EC5246' }],
    calc: (bars, p) => {
      const pc = change(source(bars));
      const ds = ema(ema(pc, p.long), p.short), dsa = ema(ema(pc.map(Math.abs), p.long), p.short);
      const t = ds.map((v, i) => (dsa[i] ? (100 * v) / dsa[i] : NaN));
      return { tsi: t, signal: ema(t, p.signal) };
    },
  },
  trix: {
    name: 'TRIX', short: 'TRIX', description: 'Rate of change of a triple-smoothed EMA', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 18)],
    levels: [0],
    plots: [{ key: 'trix', title: 'TRIX', color: '#EC5246' }],
    calc: (bars, p) => {
      const e = ema(ema(ema(source(bars).map(Math.log), p.length), p.length), p.length);
      return { trix: change(e).map((v) => v * 10000) };
    },
  },
  dpo: {
    name: 'Detrended Price Oscillator', short: 'DPO', description: 'Price minus a displaced moving average', category: 'Oscillators', overlay: false,
    params: [P('length', 'Length', 21)],
    levels: [0],
    plots: [{ key: 'dpo', title: 'DPO', color: '#43A047' }],
    calc: (bars, p) => {
      const c = source(bars), ma = sma(c, p.length), back = Math.floor(p.length / 2) + 1;
      return { dpo: c.map((v, i) => (i >= back ? v - ma[i - back] : NaN)) };
    },
  },
  coppock: {
    name: 'Coppock Curve', short: 'Coppock', description: 'Long-term momentum (WMA of two ROCs)', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('wma', 'WMA length', 10), P('longRoc', 'Long ROC', 14), P('shortRoc', 'Short ROC', 11)],
    levels: [0],
    plots: [{ key: 'c', title: 'Coppock', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const c = source(bars), a = roc(c, p.longRoc), b = roc(c, p.shortRoc);
      return { c: wma(a.map((v, i) => v + b[i]), p.wma) };
    },
  },
  bbpct: {
    name: 'Bollinger Bands %B', short: '%B', description: 'Where price sits within the bands', category: 'Oscillators', overlay: false, precision: 2,
    params: [P('length', 'Length', 20), P('mult', 'StdDev', 2, 0.1, 10, 0.1)],
    levels: [1, 0],
    fills: [levelsFill(1, 0, 'rgba(38, 166, 154, 0.08)')],
    plots: [{ key: 'b', title: '%B', color: '#26A69A' }],
    calc: (bars, p) => {
      const c = source(bars), { upper, lower } = bb(c, p.length, p.mult);
      return { b: c.map((v, i) => (v - lower[i]) / (upper[i] - lower[i])) };
    },
  },

  // --- Momentum ---------------------------------------------------------------------
  macd: {
    name: 'MACD', short: 'MACD', description: 'Moving average convergence/divergence', category: 'Momentum', overlay: false,
    params: [P('fast', 'Fast length', 12), P('slow', 'Slow length', 26), P('signal', 'Signal length', 9), SRC()],
    plots: [
      {
        key: 'hist', title: 'Histogram', type: 'histogram',
        colorFn: (i, out) => {
          const h = out.hist[i], prev = out.hist[i - 1];
          if (h >= 0) return isNum(prev) && h < prev ? '#B2DFDB' : '#26A69A';
          return isNum(prev) && h > prev ? '#FFCDD2' : '#FF5252';
        },
      },
      { key: 'macd', title: 'MACD', color: '#4FA3F7' },
      { key: 'signal', title: 'Signal', color: '#FF6D00' },
    ],
    calc: (bars, p) => macd(source(bars, p.source), p.fast, p.slow, p.signal),
  },
  ao: {
    name: 'Awesome Oscillator', short: 'AO', description: '5 vs 34 bar SMA of the bar midpoint', category: 'Momentum', overlay: false,
    params: [],
    plots: [{ key: 'ao', title: 'AO', type: 'histogram', colorFn: (i, out) => (out.ao[i] >= (out.ao[i - 1] ?? -Infinity) ? '#34B886' : '#EC5246') }],
    calc: (bars) => { const h = source(bars, 'hl2'), a = sma(h, 5), b = sma(h, 34); return { ao: a.map((v, i) => v - b[i]) }; },
  },
  mom: {
    name: 'Momentum', short: 'Mom', description: 'Close minus the close N bars ago', category: 'Momentum', overlay: false,
    params: [P('length', 'Length', 10), SRC()],
    levels: [0],
    plots: [{ key: 'mom', title: 'Mom', color: '#4FA3F7' }],
    calc: (bars, p) => ({ mom: change(source(bars, p.source), p.length) }),
  },
  roc: {
    name: 'Rate Of Change', short: 'ROC', description: 'Percent change over N bars', category: 'Momentum', overlay: false, precision: 2,
    params: [P('length', 'Length', 9), SRC()],
    levels: [0],
    plots: [{ key: 'roc', title: 'ROC', color: '#4FA3F7' }],
    calc: (bars, p) => ({ roc: roc(source(bars, p.source), p.length) }),
  },
  bop: {
    name: 'Balance of Power', short: 'BoP', description: 'Buyers vs sellers within each bar', category: 'Momentum', overlay: false, precision: 2,
    params: [],
    levels: [0],
    plots: [{ key: 'bop', title: 'BoP', color: '#EC5246' }],
    calc: (bars) => ({ bop: bars.map((b) => (b.high === b.low ? 0 : (b.close - b.open) / (b.high - b.low))) }),
  },
  efi: {
    name: 'Elder Force Index', short: 'EFI', description: 'Price change × volume, smoothed', category: 'Momentum', overlay: false, format: 'volume',
    params: [P('length', 'Length', 13)],
    levels: [0],
    plots: [{ key: 'efi', title: 'EFI', color: '#EC5246' }],
    calc: (bars, p) => ({ efi: ema(change(source(bars)).map((v, i) => v * bars[i].volume), p.length) }),
  },

  // --- Trend strength ---------------------------------------------------------------
  adx: {
    name: 'Directional Movement Index', short: 'DMI', description: 'ADX trend strength with +DI and −DI', category: 'Trend strength', overlay: false, precision: 2,
    params: [P('diLength', 'DI length', 14), P('adxLength', 'ADX smoothing', 14)],
    plots: [
      { key: 'adx', title: 'ADX', color: '#F50057' },
      { key: 'plus', title: '+DI', color: '#4FA3F7' },
      { key: 'minus', title: '−DI', color: '#FF6D00' },
    ],
    calc: (bars, p) => dmi(bars, p.diLength, p.adxLength),
  },
  aroon: {
    name: 'Aroon', short: 'Aroon', description: 'Bars since the recent high and low', category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', 'Length', 14)],
    plots: [{ key: 'up', title: 'Up', color: '#FB8C00' }, { key: 'down', title: 'Down', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const hs = barsSinceExtreme(pick(bars, 'high'), p.length, (a, b) => a > b);
      const ls = barsSinceExtreme(pick(bars, 'low'), p.length, (a, b) => a < b);
      return { up: hs.map((v) => (100 * (p.length - v)) / p.length), down: ls.map((v) => (100 * (p.length - v)) / p.length) };
    },
  },
  vortex: {
    name: 'Vortex Indicator', short: 'VI', description: 'Upward vs downward trend movement', category: 'Trend strength', overlay: false, precision: 3,
    params: [P('length', 'Length', 14)],
    plots: [{ key: 'plus', title: 'VI+', color: '#4FA3F7' }, { key: 'minus', title: 'VI−', color: '#E91E63' }],
    calc: (bars, p) => {
      const vp = bars.map((b, i) => (i ? Math.abs(b.high - bars[i - 1].low) : NaN));
      const vm = bars.map((b, i) => (i ? Math.abs(b.low - bars[i - 1].high) : NaN));
      const t = sum(tr(bars), p.length), sp = sum(vp, p.length), sm = sum(vm, p.length);
      return { plus: sp.map((v, i) => v / t[i]), minus: sm.map((v, i) => v / t[i]) };
    },
  },
  chop: {
    name: 'Choppiness Index', short: 'CHOP', description: 'Trending (low) vs sideways (high) market', category: 'Trend strength', overlay: false, precision: 2,
    params: [P('length', 'Length', 14)],
    levels: [61.8, 38.2],
    fills: [levelsFill(61.8, 38.2, 'rgba(33, 150, 243, 0.07)')],
    plots: [{ key: 'chop', title: 'CHOP', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const s = sum(tr(bars), p.length);
      const hh = highest(pick(bars, 'high'), p.length), ll = lowest(pick(bars, 'low'), p.length);
      return { chop: s.map((v, i) => (100 * Math.log10(v / (hh[i] - ll[i]))) / Math.log10(p.length)) };
    },
  },

  // --- Volume ------------------------------------------------------------------------
  volume: {
    name: 'Volume', short: 'Vol', description: 'Traded volume per bar', category: 'Volume', overlay: true, scale: 'volume', format: 'volume',
    params: [],
    plots: [{
      key: 'vol', title: 'Volume', type: 'histogram',
      colorFn: (i, out, bars) => alpha(bars[i].close >= bars[i].open ? UP : DOWN, 0.45),
    }],
    calc: (bars) => ({ vol: bars.map((b) => b.volume) }),
  },
  obv: {
    name: 'On Balance Volume', short: 'OBV', description: 'Running total of signed volume', category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'obv', title: 'OBV', color: '#4FA3F7' }],
    calc: (bars) => ({ obv: obv(bars) }),
  },
  ad: {
    name: 'Accumulation/Distribution', short: 'A/D', description: 'Volume weighted by where the close sits in the bar', category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'ad', title: 'A/D', color: '#999915' }],
    calc: (bars) => ({ ad: cum(bars.map((b) => (b.high === b.low ? 0 : (((b.close - b.low) - (b.high - b.close)) / (b.high - b.low)) * b.volume))) }),
  },
  cmf: {
    name: 'Chaikin Money Flow', short: 'CMF', description: 'Accumulation vs distribution over N bars', category: 'Volume', overlay: false, precision: 3,
    params: [P('length', 'Length', 20)],
    levels: [0],
    plots: [{ key: 'cmf', title: 'CMF', color: '#43A047' }],
    calc: (bars, p) => {
      const mfv = bars.map((b) => (b.high === b.low ? 0 : (((b.close - b.low) - (b.high - b.close)) / (b.high - b.low)) * b.volume));
      const a = sum(mfv, p.length), v = sum(pick(bars, 'volume'), p.length);
      return { cmf: a.map((x, i) => (v[i] ? x / v[i] : 0)) };
    },
  },
  chaikinosc: {
    name: 'Chaikin Oscillator', short: 'Chaikin Osc', description: 'Momentum of Accumulation/Distribution', category: 'Volume', overlay: false, format: 'volume',
    params: [P('fast', 'Fast', 3), P('slow', 'Slow', 10)],
    levels: [0],
    plots: [{ key: 'osc', title: 'Chaikin Osc', color: '#EC407A' }],
    calc: (bars, p) => {
      const ad = INDICATORS.ad.calc(bars).ad;
      const f = ema(ad, p.fast), s = ema(ad, p.slow);
      return { osc: f.map((v, i) => v - s[i]) };
    },
  },
  pvt: {
    name: 'Price Volume Trend', short: 'PVT', description: 'Volume scaled by percent price change, cumulative', category: 'Volume', overlay: false, format: 'volume',
    params: [],
    plots: [{ key: 'pvt', title: 'PVT', color: '#4FA3F7' }],
    calc: (bars) => ({ pvt: cum(bars.map((b, i) => (i ? ((b.close - bars[i - 1].close) / bars[i - 1].close) * b.volume : 0))) }),
  },
  volosc: {
    name: 'Volume Oscillator', short: 'Vol Osc', description: 'Fast vs slow volume EMA, in percent', category: 'Volume', overlay: false, precision: 2,
    params: [P('fast', 'Short length', 5), P('slow', 'Long length', 10)],
    levels: [0],
    plots: [{ key: 'osc', title: 'Vol Osc', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const v = pick(bars, 'volume'), f = ema(v, p.fast), s = ema(v, p.slow);
      return { osc: f.map((x, i) => (s[i] ? (100 * (x - s[i])) / s[i] : 0)) };
    },
  },

  // --- Volatility ----------------------------------------------------------------------
  atr: {
    name: 'Average True Range', short: 'ATR', description: 'Average bar range including gaps', category: 'Volatility', overlay: false,
    params: [P('length', 'Length', 14)],
    plots: [{ key: 'atr', title: 'ATR', color: '#EC5246' }],
    calc: (bars, p) => ({ atr: atr(bars, p.length) }),
  },
  hv: {
    name: 'Historical Volatility', short: 'HV', description: 'Annualized standard deviation of returns, in percent', category: 'Volatility', overlay: false, precision: 2,
    params: [P('length', 'Length', 10)],
    plots: [{ key: 'hv', title: 'HV', color: '#4FA3F7' }],
    calc: (bars, p, ctx = {}) => {
      const r = bars.map((b, i) => (i ? Math.log(b.close / bars[i - 1].close) : NaN));
      const per = (ctx.tfSec || DAY) > DAY ? 7 : 1;
      return { hv: stdev(r, p.length).map((v) => 100 * v * Math.sqrt(365 / per)) };
    },
  },
  bbw: {
    name: 'Bollinger BandWidth', short: 'BBW', description: 'Width of the bands relative to the basis', category: 'Volatility', overlay: false, precision: 4,
    params: [P('length', 'Length', 20), P('mult', 'StdDev', 2, 0.1, 10, 0.1)],
    plots: [{ key: 'w', title: 'BBW', color: '#4FA3F7' }],
    calc: (bars, p) => {
      const { upper, lower, basis } = bb(source(bars), p.length, p.mult);
      return { w: upper.map((u, i) => (u - lower[i]) / basis[i]) };
    },
  },
  stdevind: {
    name: 'Standard Deviation', short: 'StdDev', description: 'Standard deviation of the close', category: 'Volatility', overlay: false,
    params: [P('length', 'Length', 20), SRC()],
    plots: [{ key: 'sd', title: 'StdDev', color: '#4FA3F7' }],
    calc: (bars, p) => ({ sd: stdev(source(bars, p.source), p.length) }),
  },
};

export function defaultParams(type, defs = INDICATORS) {
  const out = {};
  for (const p of defs[type]?.params || []) out[p.key] = p.def;
  return out;
}

export function indicatorLabel(def, inst) {
  const vals = (def.params || []).map((p) => inst.params?.[p.key] ?? p.def);
  return vals.length ? `${def.short} ${vals.join(' ')}` : def.short;
}

export function heikinAshi(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = heikinAshiAt(bars, out, i);
  return out;
}

export function heikinAshiAt(bars, ha, i) {
  const b = bars[i];
  const close = (b.open + b.high + b.low + b.close) / 4;
  const open = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
  return {
    time: b.time, open, close,
    high: Math.max(b.high, open, close),
    low: Math.min(b.low, open, close),
  };
}

/** The toolkit user scripts get as `ta` (bar-based helpers are bound to the chart's bars in the worker). */
export const TA = {
  sma, ema, wma, rma, hma, dema, tema, alma, linreg, stdev, sum, cum, highest, lowest, change, mom, roc, shift,
  rsi, macd, bb, stoch, cci, crossover, crossunder, cross, pivothigh, pivotlow, vwma,
  // these take the chart's bars as their first argument; the worker binds them
  bars: { atr, tr, mfi, obv, wpr, dmi, supertrend, vwap, psar },
};
