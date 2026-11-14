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
    // ?e2e exposes the charts to this test as window.__wickline.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}#s=${encodeURIComponent(sym)}&tf=${tf}`);
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

    // 5. After the user drags the price axis (which turns auto-scaling off), the next symbol still
    //    opens on its latest bars with its prices in view, not into empty space.
    await open('YAHOO:AAPL', '1h');
    const box = await run(`(() => { const r = window.__wickline.views()[0].chartEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    const ax = box.x + box.w - 25;
    mouse('mouseDown', ax, box.y + box.h * 0.3);
    for (let s = 1; s <= 12; s++) { mouse('mouseMove', ax, box.y + box.h * (0.3 + 0.025 * s)); await wait(16); }
    mouse('mouseUp', ax, box.y + box.h * 0.6);
    await wait(500);
    const dragged = await run(`window.__wickline.views()[0].main.priceScale().options().autoScale`);
    check('dragging the price axis turns auto-scaling off (test setup)', dragged === false);
    await run(`window.__wickline.views()[0].setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 40; i++) { // until BTC's data is on the chart
      await wait(500);
      if (await run(`(() => { const v = window.__wickline.views()[0]; return !!v.feed && v.q('.overlay.loading').hidden && v.bars.at(-1)?.close > 1000; })()`)) break;
    }
    await wait(800);
    const view = await run(`(() => { const v = window.__wickline.views()[0]; const n = v.bars.length;
      const lr = v.chart.timeScale().getVisibleLogicalRange(); const last = v.bars[n - 1];
      const top = v.main.coordinateToPrice(5), bot = v.main.coordinateToPrice(v.chartEl.clientHeight * 0.5);
      return { n, to: lr.to, last: last.close, top, bot, auto: v.main.priceScale().options().autoScale }; })()`);
    check('a new symbol opens on its latest bars', view.to >= view.n - 1 && view.to <= view.n + 15, `view ends at ${Math.round(view.to)} of ${view.n}`);
    check('a new symbol opens with its prices in view', view.auto && view.last <= view.top && view.last >= Math.min(view.bot, view.top) - Math.abs(view.top) * 0.5,
      `last ${view.last} scale ${Math.round(view.bot)}..${Math.round(view.top)}`);

    // 6. Update notice: a newer release on GitHub (faked here) shows a notice that can be dismissed.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}`);
    await run(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('api.github.com')
      ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/keptaduona/wickline/releases/tag/v99.0.0', draft: false, prerelease: false }), { status: 200 }))
      : real(u, o); })()`);
    await wait(7000);
    const upd = await run(`({ hidden: document.querySelector('#update').hidden, text: document.querySelector('#update-link').textContent, href: document.querySelector('#update-link').href })`);
    check('update notice shows a newer release', !upd.hidden && /99\.0\.0/.test(upd.text) && /releases\/tag\/v99/.test(upd.href), upd.text);
    await run(`document.querySelector('#update-dismiss').click()`);
    check('dismissing hides the notice', (await run(`document.querySelector('#update').hidden`)) === true);

    // 7. A 4-chart layout renders every chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="4"]').click()`);
    await wait(8000);
    const legends = await run(`[...document.querySelectorAll('.cell .lg-ohlc')].map((e) => e.innerText.trim()).filter(Boolean).length`);
    check('4-chart layout shows 4 charts with data', legends === 4, `${legends} of 4`);

    // 8. Sync across charts (Layout menu): symbol and timeframe, in the layout and in pop-outs.
    const symbols = () => run(`window.__wickline.views().map((v) => v.state.symbol)`);
    const tfs = () => run(`window.__wickline.views().map((v) => v.state.tf)`);
    const active = (js) => run(`(() => { const v = window.__wickline.views().find((x) => x.el.classList.contains('active')); ${js} })()`);
    const toggleSync = async (kind) => {
      await run(`document.querySelector('#layout-btn').click()`);
      await wait(200);
      await run(`document.querySelector('[data-sync="${kind}"]').click(); document.querySelector('#layout-btn').click()`);
      await wait(500);
    };
    check('charts start with their own symbols', new Set(await symbols()).size > 1, (await symbols()).join(', '));
    const pop = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
    await pop.loadURL(`http://127.0.0.1:${port}/?popout=1&e2e#s=${encodeURIComponent('YAHOO:MSFT')}&tf=1D`);
    await wait(2500);
    const popSymbol = () => pop.webContents.executeJavaScript(`window.__wickline.views()[0].state.symbol`);
    await toggleSync('symbol');
    const activeSym = await active('return v.state.symbol;');
    const all = await symbols();
    check('turning symbol sync on puts every chart on the active symbol', all.every((s) => s === activeSym), all.join(', '));
    await active(`v.setSymbol('YAHOO:NVDA');`);
    await wait(1500);
    const afterChange = await symbols();
    check('a new symbol on the active chart goes to every chart', afterChange.every((s) => s === 'YAHOO:NVDA'), afterChange.join(', '));
    check('...and to pop-out windows', (await popSymbol()) === 'YAHOO:NVDA', await popSymbol());
    await pop.webContents.executeJavaScript(`window.__wickline.views()[0].setSymbol('BINANCE:ETHUSDT')`);
    await wait(1500);
    check('a pop-out window can lead too', (await symbols()).every((s) => s === 'BINANCE:ETHUSDT'), (await symbols()).join(', '));
    await toggleSync('interval');
    await active(`v.setTimeframe('15m');`);
    await wait(1500);
    check('timeframe sync changes every chart', (await tfs()).every((t) => t === '15m'), (await tfs()).join(', '));
    check('the Layout button shows that charts are synced', await run(`!!document.querySelector('#layout-btn .sync-dot')`));
    await toggleSync('symbol');
    await toggleSync('interval');
    await active(`v.setSymbol('YAHOO:AAPL'); v.setTimeframe('1D');`);
    await wait(1500);
    const sOff = await symbols(), tOff = await tfs();
    check('with sync off, only the active chart changes', sOff.filter((s) => s === 'YAHOO:AAPL').length === 1 && tOff.filter((t) => t === '1D').length === 1,
      `${sOff.join(', ')} | ${tOff.join(', ')}`);
    pop.destroy();

    // 9. Symbol search: one box for every source, and each result says where its data comes from.
    const search = async (q) => {
      await run(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
      await wait(2500);
      return run(`[...document.querySelectorAll('#search-results .sr-row')].map((r) => ({ t: r.querySelector('.sr-ticker').textContent, src: r.querySelector('.sr-badge')?.textContent }))`);
    };
    await run(`document.querySelector('#symbol-btn').click()`);
    await wait(300);
    check('search has no category selector', !(await run(`!!document.querySelector('#search-tabs')`)));
    const aapl = await search('AAPL');
    check('search puts the exact ticker first', aapl[0]?.t === 'AAPL' && aapl[0]?.src === 'Yahoo', JSON.stringify(aapl.slice(0, 3)));
    const btc = await search('BTC');
    const sources = new Set(btc.map((r) => r.src));
    check('one search covers stocks and crypto exchanges, each row labeled', btc.every((r) => r.src) && sources.has('Yahoo') && sources.has('Binance'), [...sources].join(', '));
    await run(`document.querySelector('#search-modal .close').click()`);

    check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run', false, e.stack);
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  server.close();
  app.exit(failed ? 1 : 0);
});
