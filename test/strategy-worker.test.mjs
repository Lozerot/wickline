// Runs strategy scripts through the real script worker (in Node). Run: npm test
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

// Minimal stand-in for the worker global, then load the worker module.
let reply = null;
globalThis.self = { postMessage: (m) => { reply = m; } };
await import('../public/js/script-worker.js');
const run = (code, n = 400, ctx = {}) => {
  const data = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + Math.sin(i / 9) * 0.01 + (i % 7 === 0 ? -0.004 : 0.002));
    data.time.push(1700000000 + i * 3600); data.open.push(o); data.close.push(c);
    data.high.push(Math.max(o, c) * 1.003); data.low.push(Math.min(o, c) * 0.997);
    data.volume.push(i % 23 === 0 ? 6000 : 1000); // occasional volume spikes
    p = c;
  }
  const packed = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Float64Array.from(v)]));
  self.onmessage({ data: { id: 1, code, data: packed, inputs: {}, ctx: { tfSec: 3600, ...ctx } } });
  return reply;
};

console.log('strategy script');
{
  const r = run(`
    strategy('EMA Cross', { capital: 5000, commission: 0.1 });
    const fast = ta.ema(close, 9), slow = ta.ema(close, 21);
    plot(fast); plot(slow);
    strategy.entry('Long', 'long', ta.crossover(fast, slow));
    strategy.entry('Short', 'short', ta.crossunder(fast, slow));
    strategy.exit({ stopLoss: 3, takeProfit: 6 });
  `);
  check('runs without error', r.ok, r.error);
  const s = r.result?.strategy;
  check('marked as a strategy', r.result?.meta.strategy === true);
  check('has trades', s?.trades.length > 3, `${s?.trades.length}`);
  check('uses the script capital', s?.props.initialCapital === 5000);
  check('uses the script commission', s?.props.commission === 0.1);
  check('equity curve for every bar', s?.equity.length === 400);
  check('net profit equals the sum of trades', Math.abs(s.summary.netProfit - s.trades.reduce((a, t) => a + t.pnl, 0)) < 1e-6);
  check('trades alternate long/short or exit', s.trades.every((t) => ['long', 'short'].includes(t.side)));
}

console.log('property overrides from the tester');
{
  const r = run(`strategy('X'); strategy.entry('L', 'long', ta.crossover(close, ta.sma(close, 20))); strategy.close(null, ta.crossunder(close, ta.sma(close, 20)));`,
    400, { strategy: { initialCapital: 1000, fillOn: 'close' } });
  check('override applied', r.ok && r.result.strategy.props.initialCapital === 1000 && r.result.strategy.props.fillOn === 'close', r.error);
}

console.log('onBar');
{
  const r = run(`
    strategy('Time stop');
    const up = ta.crossover(close, ta.sma(close, 10));
    strategy.onBar((i, s) => {
      if (!s.position.side && up[i]) s.long('L');
      if (s.position.side && s.position.barsInTrade >= 5) s.close();
    });
  `);
  check('runs', r.ok, r.error);
  check('every trade lasts 5–6 bars', r.result.strategy.trades.length > 0 && r.result.strategy.trades.every((t) => t.bars >= 5 && t.bars <= 6),
    JSON.stringify(r.result?.strategy.trades.map((t) => t.bars)));
}

console.log('errors');
{
  const a = run(`strategy.entry('L', 'long', true);`);
  check('strategy.entry before strategy() explains', !a.ok && /call strategy\(/.test(a.error), a.error);
  const b = run(`strategy('X'); strategy.entry('L', 'up', true);`);
  check('bad direction explains', !b.ok && /'long' or 'short'/.test(b.error), b.error);
  const c = run(`strategy('X');\nstrategy.onBar((i, s) => {\n  if (i === 50) s.nope();\n});`);
  check('error inside onBar reports its line', !c.ok && c.line === 3, `${c.error} line=${c.line}`);
}

console.log('every starter template runs');
{
  // scripts.js expects a browser; give it the two things it touches.
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const { TEMPLATES } = await import('../public/js/scripts.js');
  for (const t of TEMPLATES) {
    const r = run(t.code, 600);
    const s = r.result?.strategy;
    const output = r.ok && (r.result.plots.length > 0 || r.result.markers.length > 0);
    check(`${t.name}`, output && (!s || s.trades.length > 0),
      r.ok ? `plots=${r.result.plots.length} markers=${r.result.markers.length} trades=${s?.trades.length}` : r.error);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
