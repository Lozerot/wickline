// End-to-end check of the real app in Electron, with live data (needs internet).
// Run: npm run test:e2e
// Opens the app with its built-in server in a hidden window and checks charts for several
// markets, the theme dialog, the Ext button, multi-chart layouts and console errors.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { startServer } from '../server.mjs';

const profile = path.join(os.tmpdir(), 'wickline-e2e-profile');
rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);

const CHARTS = [
  ['YAHOO:AAPL', '1D'], ['YAHOO:NVDA', '5m'], ['YAHOO:SPY', '1h'], ['YAHOO:^GSPC', '1W'],
  ['YAHOO:EURUSD=X', '15m'], ['YAHOO:GC=F', '1D'], ['YAHOO:SAP.DE', '1D'],
  ['BINANCE:BTCUSDT', '1m'], ['BINANCEF:ETHUSDT', '4h'], ['COINBASE:BTC-USD', '1D'],
];

let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  results.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  const win = new BrowserWindow({ width: 1400, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e?.level ?? level, msg = String(e?.message ?? message);
    // Dropped network connections (e.g. a live stream closed on navigation) aren't app errors.
    if ((lvl === 'error' || lvl === 3) && !/Failed to load resource|ERR_CONNECTION|ERR_ABORTED/.test(msg)) errors.push(msg.slice(0, 200));
  });
  const run = (js) => win.webContents.executeJavaScript(js);
  let page = 0;
  const open = async (sym, tf) => {
    // A new query string forces a fresh page (a different #hash alone wouldn't reload it).
    await win.loadURL(`http://127.0.0.1:${port}/?page=${++page}#s=${encodeURIComponent(sym)}&tf=${tf}`);
    for (let i = 0; i < 40; i++) {
      await wait(500);
      const done = await run(`(() => { const c = document.querySelector('.cell'); if (!c) return false;
        if (!c.querySelector('.overlay.error').hidden) return true;
        return !!c.querySelector('.lg-ohlc')?.innerText.trim() && /\\d/.test(document.title); })()`);
      if (done) break;
    }
    return run(`(() => { const c = document.querySelector('.cell');
      return { legend: c.querySelector('.lg-ohlc')?.innerText.replace(/\\s+/g, ' ').trim(),
        title: c.querySelector('.lg-title')?.innerText.replace(/\\s+/g, ' ').trim(),
        error: c.querySelector('.overlay.error').hidden ? null : c.querySelector('.overlay.error').innerText.replace(/\\s+/g, ' ').slice(0, 120),
        mode: document.body.dataset.mode, tabTitle: document.title }; })()`);
  };

  try {
    // 1. Charts for every kind of market and several timeframes.
    for (const [sym, tf] of CHARTS) {
      const r = await open(sym, tf);
      // The chart must be the one asked for, not a leftover from the previous page.
      const want = sym.split(':')[1].replace(/=X|=F|-USD|\.DE|\^/g, '').replace(/[^A-Z]/g, '').slice(0, 4);
      const titled = (r.title || '').toUpperCase().replace(/[^A-Z]/g, '').includes(want);
      check(`${sym} ${tf} loads`, !r.error && titled && /^O\S+ H\S+ L\S+ C\S+/.test(r.legend || ''),
        r.error || `${(r.title || '').slice(0, 36)} | ${(r.legend || '').slice(0, 44)}`);
    }
    const first = await open('YAHOO:AAPL', '1D');
    check('desktop data mode uses the built-in server', first.mode === 'server', first.mode);
    check('tab title shows symbol and price', /^AAPL [\d,.]+ [▲▼]/.test(first.tabTitle), first.tabTitle);

    // 2. Markets panel lists all US stocks.
    await run(`document.querySelector('.side-tabs [data-tab="markets"], .side-tabs button:nth-child(2)')?.click()`);
    await wait(3000);
    const count = await run(`document.querySelector('#mk-count')?.textContent || ''`);
    check('Markets panel lists thousands of US stocks', Number(count.replace(/\D/g, '')) > 5000, count);

    // 3. Theme dialog: presets and custom colors change the page.
    const accent = () => run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    const before = await accent();
    await run(`document.querySelector('#appearance-btn').click(); document.querySelector('[data-preset="ember"]').click()`);
    await wait(500);
    check('choosing a preset changes the colors', (await accent()) !== before && (await accent()).toUpperCase() === '#F2A33A', await accent());
    await run(`(() => { const i = document.querySelector('[data-key="accent"]'); i.value = '#123456';
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(500);
    check('a custom accent color applies', (await accent()).toUpperCase() === '#123456', await accent());
    await run(`document.querySelector('#appear-reset').click(); document.querySelector('[data-preset="crimson"]').click(); document.querySelector('.appear-done').click()`);
    await wait(300);
    check('reset returns to the default theme', (await accent()).toUpperCase() === '#E5484D', await accent());

    // 4. Ext button: only for stocks on intraday charts.
    const extHidden = () => run(`document.querySelector('#ext-btn').hidden`);
    await open('YAHOO:AAPL', '5m');
    check('Ext button shows on an intraday stock chart', (await extHidden()) === false);
    await open('YAHOO:AAPL', '1D');
    check('Ext button hides on a daily chart', (await extHidden()) === true);
    await open('BINANCE:BTCUSDT', '5m');
    check('Ext button hides for crypto', (await extHidden()) === true);

    // 5. A 4-chart layout renders every chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="4"]').click()`);
    await wait(8000);
    const legends = await run(`[...document.querySelectorAll('.cell .lg-ohlc')].map((e) => e.innerText.trim()).filter(Boolean).length`);
    check('4-chart layout shows 4 charts with data', legends === 4, `${legends} of 4`);

    check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run', false, e.stack);
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  server.close();
  app.exit(failed ? 1 : 0);
});
