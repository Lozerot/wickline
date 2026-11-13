// Tests for public/js/indicators.js: known values for the core math, and every built-in
// indicator runs on realistic data without throwing and stays aligned with the bars.
import assert from 'node:assert/strict';
import { sma, ema, rsi, stdev, highest, lowest, crossover, crossunder, atr, INDICATORS, defaultParams, heikinAshi } from '../public/js/indicators.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A deterministic random walk with intraday-like bars.
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const bars = [];
let c = 100;
for (let i = 0; i < 400; i++) {
  const o = c;
  c = Math.max(1, o + (rnd() - 0.48) * 3);
  bars.push({ time: 1_700_000_000 + i * 300, open: o, high: Math.max(o, c) + rnd(), low: Math.min(o, c) - rnd(), close: c, volume: Math.round(1000 + rnd() * 5000) });
}

test('sma of 1..5 over 3', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test('ema seeds and converges', () => {
  const out = ema([10, 10, 10, 10, 10], 3);
  assert.ok(close(out.at(-1), 10));
  const up = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.ok(up.at(-1) > 8 && up.at(-1) < 10, `ema ${up.at(-1)}`);
});

test('rsi is 100 on a straight rise and 0 on a straight fall', () => {
  const rise = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.ok(close(rsi(rise, 14).at(-1), 100, 1e-6));
  const fall = rise.slice().reverse();
  assert.ok(close(rsi(fall, 14).at(-1), 0, 1e-6));
});

test('rsi stays within 0..100 on random data', () => {
  for (const v of rsi(bars.map((b) => b.close), 14)) if (Number.isFinite(v)) assert.ok(v >= 0 && v <= 100, String(v));
});

test('stdev of a constant is 0', () => {
  assert.ok(close(stdev([5, 5, 5, 5, 5], 3).at(-1), 0));
});

test('highest / lowest over a window', () => {
  assert.equal(highest([1, 5, 3, 2, 4], 3).at(-1), 4);
  assert.equal(lowest([1, 5, 3, 2, 4], 3).at(-1), 2);
});

test('crossover / crossunder mark exactly the crossing bar', () => {
  const a = [1, 2, 3, 2, 1], b = [2, 2, 2, 2, 2];
  assert.deepEqual(crossover(a, b).map(Boolean), [false, false, true, false, false]);
  assert.deepEqual(crossunder(a, b).map(Boolean), [false, false, false, false, true]);
});

test('atr is positive once warmed up', () => {
  const out = atr(bars, 14);
  assert.ok(out.at(-1) > 0);
});

test('heikin ashi keeps the bar count', () => {
  assert.equal(heikinAshi(bars).length, bars.length);
});

test(`every built-in indicator (${Object.keys(INDICATORS).length}) runs and stays aligned with the bars`, () => {
  for (const [type, def] of Object.entries(INDICATORS)) {
    let out;
    try {
      out = def.calc(bars, defaultParams(type), { tf: { sec: 300, daily: false } });
    } catch (e) {
      throw new Error(`${type}: ${e.message}`);
    }
    for (const plot of def.plots) {
      const values = out[plot.key];
      if (plot.optional && values == null) continue;
      assert.ok(Array.isArray(values), `${type}.${plot.key} is not an array`);
      assert.equal(values.length, bars.length, `${type}.${plot.key} has ${values.length} values for ${bars.length} bars`);
      if (!plot.optional) assert.ok(values.slice(-40).some((v) => v == null || Number.isFinite(v) || typeof v === 'boolean'), `${type}.${plot.key} has no values at the end`);
    }
  }
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
