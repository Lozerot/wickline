import { searchCrypto, searchYahoo, warmSymbolLists } from './datafeed.js';
import { $, esc } from './util.js';

const TABS = [
  ['all', 'All'], ['stocks', 'Stocks'], ['funds', 'Funds'], ['futures', 'Futures'],
  ['forex', 'Forex'], ['crypto', 'Crypto'], ['indices', 'Indices'],
];

const p = (full, ticker, name, exchange, type, category) => ({ full, ticker, name, exchange, type, category });
const POPULAR = [
  p('BINANCE:BTCUSDT', 'BTCUSDT', 'BTC / USDT', 'Binance', 'Crypto', 'crypto'),
  p('BINANCE:ETHUSDT', 'ETHUSDT', 'ETH / USDT', 'Binance', 'Crypto', 'crypto'),
  p('BINANCEF:BTCUSDT', 'BTCUSDT.P', 'BTC / USDT perpetual', 'Binance Futures', 'Crypto perpetual', 'crypto'),
  p('COINBASE:BTC-USD', 'BTC-USD', 'BTC / USD', 'Coinbase', 'Crypto', 'crypto'),
  p('YAHOO:AAPL', 'AAPL', 'Apple Inc.', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:NVDA', 'NVDA', 'NVIDIA Corporation', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:TSLA', 'TSLA', 'Tesla, Inc.', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:SPY', 'SPY', 'SPDR S&P 500 ETF', 'NYSE Arca', 'ETF', 'funds'),
  p('YAHOO:QQQ', 'QQQ', 'Invesco QQQ (Nasdaq 100)', 'NASDAQ', 'ETF', 'funds'),
  p('YAHOO:^GSPC', '^GSPC', 'S&P 500', 'Index', 'Index', 'indices'),
  p('YAHOO:^IXIC', '^IXIC', 'NASDAQ Composite', 'Index', 'Index', 'indices'),
  p('YAHOO:^GDAXI', '^GDAXI', 'DAX', 'Index', 'Index', 'indices'),
  p('YAHOO:EURUSD=X', 'EURUSD=X', 'EUR / USD', 'Forex', 'Currency', 'forex'),
  p('YAHOO:USDJPY=X', 'USDJPY=X', 'USD / JPY', 'Forex', 'Currency', 'forex'),
  p('YAHOO:GC=F', 'GC=F', 'Gold Futures', 'COMEX', 'Futures', 'futures'),
  p('YAHOO:CL=F', 'CL=F', 'Crude Oil Futures', 'NYMEX', 'Futures', 'futures'),
  p('YAHOO:ES=F', 'ES=F', 'S&P 500 E-mini Futures', 'CME', 'Futures', 'futures'),
];

const TITLES = { open: 'Symbol search', add: 'Add to watchlist', compare: 'Compare symbol', alert: 'Symbol for the alert' };

export class SymbolSearch {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.el = $('#search-modal');
    this.input = $('#search-input');
    this.list = $('#search-results');
    this.tabsEl = $('#search-tabs');
    this.mode = 'open';
    this.tab = 'all';
    this.crypto = [];
    this.yahoo = [];
    this.rows = [];
    this.active = 0;
    this.seq = 0;
    this.yahooTimer = null;

    this.tabsEl.innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}">${label}</button>`).join('');
    this.tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this.tab = b.dataset.tab;
      this.render(this.input.value.trim());
      this.input.focus();
    });
    this.input.addEventListener('input', () => this.query());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.close(); });
    this.el.querySelector('.close').addEventListener('click', () => this.close());
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (row) this.pick(Number(row.dataset.i));
    });
  }

  get isOpen() { return !this.el.hidden; }

  open(mode = 'open', text = '') {
    this.mode = mode;
    this.el.hidden = false;
    this.el.querySelector('.search-title').textContent = TITLES[mode] || TITLES.open;
    this.input.value = text;
    this.input.focus();
    this.query();
    warmSymbolLists();
  }

  query() {
    const q = this.input.value.trim();
    const seq = ++this.seq;
    clearTimeout(this.yahooTimer);
    // Drop results for the previous text right away, so Enter never picks a stale row.
    this.crypto = [];
    this.yahoo = [];
    this.render(q);
    if (!q) return;
    searchCrypto(q)
      .then((rows) => { if (seq === this.seq) { this.crypto = rows; this.render(q); } })
      .catch(() => { if (seq === this.seq) { this.crypto = []; this.render(q); } });
    this.yahooTimer = setTimeout(() => {
      searchYahoo(q)
        .then((rows) => { if (seq === this.seq) { this.yahoo = rows; this.render(q); } })
        .catch(() => { if (seq === this.seq) { this.yahoo = []; this.render(q); } });
    }, 220);
  }

  render(q) {
    this.tabsEl.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const inTab = (r) => this.tab === 'all' || r.category === this.tab;
    const sections = [];
    if (!q) {
      sections.push([this.tab === 'all' ? 'Popular' : `Popular · ${TABS.find(([k]) => k === this.tab)[1]}`, POPULAR.filter(inTab)]);
    } else {
      const Q = q.toUpperCase().replace(/[\s/\-_]/g, '');
      const exactCrypto = this.crypto.length && this.crypto[0].ticker.replace(/[-.P]/g, '').startsWith(Q) && Q.length >= 3
        && /^[A-Z0-9]+$/.test(Q) && !this.yahoo.some((r) => r.ticker === Q);
      const y = ['Stocks, funds, indices, forex & futures', this.yahoo.filter(inTab)];
      const c = ['Crypto · Binance, Binance Futures, Coinbase', this.crypto.filter(inTab)];
      sections.push(...(exactCrypto ? [c, y] : [y, c]));
    }
    this.rows = [];
    let html = '';
    for (const [title, rows] of sections) {
      if (!rows.length) continue;
      html += `<div class="sr-section">${esc(title)}</div>`;
      for (const r of rows) {
        const i = this.rows.push(r) - 1;
        html += `<div class="sr-row" data-i="${i}">
          <span class="sr-ticker">${esc(r.ticker)}</span>
          <span class="sr-name">${esc(r.name)}</span>
          <span class="sr-type">${esc(r.type)}</span>
          <span class="sr-exch">${esc(r.exchange)}</span>
        </div>`;
      }
    }
    if (!html) html = `<div class="sr-empty">${q ? 'Searching…' : 'Type to search.'}</div>`;
    this.list.innerHTML = html;
    this.active = 0;
    this.highlight();
    // Enter was pressed before results arrived: take the best match now.
    if (this.pendingEnter && this.rows.length) { this.pendingEnter = false; this.pick(0); }
  }

  highlight() {
    this.list.querySelectorAll('.sr-row').forEach((el) => {
      const on = Number(el.dataset.i) === this.active;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { this.active = Math.min(this.active + 1, this.rows.length - 1); this.highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.active = Math.max(this.active - 1, 0); this.highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (this.rows.length) this.pick(this.active);
      else if (this.input.value.trim()) {
        // Results may still be loading: wait briefly for them, then fall back to the raw text.
        this.pendingEnter = true;
        const text = this.input.value.trim();
        setTimeout(() => { if (this.pendingEnter && this.isOpen) { this.pendingEnter = false; this.pickRaw(text); } }, 2500);
      }
    } else if (e.key === 'Escape') { this.close(); e.stopPropagation(); }
  }

  pick(i) {
    const r = this.rows[i];
    if (!r) return;
    this.close();
    this.onSelect(r.full, this.mode);
  }

  pickRaw(text) {
    this.close();
    const t = text.toUpperCase().replace(/\s+/g, '');
    const looksCrypto = /^[A-Z0-9]{2,12}(USDT|USDC|FDUSD|BTC|ETH|BNB)$/.test(t);
    const full = t.includes(':') ? t : looksCrypto ? `BINANCE:${t}` : `YAHOO:${t}`;
    this.onSelect(full, this.mode);
  }

  close() {
    this.el.hidden = true;
    this.pendingEnter = false;
    clearTimeout(this.yahooTimer);
  }
}
