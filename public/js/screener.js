// Stock screener panel: ready-made ideas (gainers, unusual volume, breakouts, oversold...),
// filters, a sortable table with signal tags, and market insights. Data comes from the
// server's /api/screener (lib/screener.mjs); clicking a row opens it on the active chart.

import { apiUrl, dataMode } from './env.js';
import { $, esc, store, formatVolume } from './util.js';

const has = (r, ...tags) => tags.some((t) => r.sig.includes(t));
const between = (v, lo, hi) => v != null && v >= lo && v <= hi;

/** Ready-made screens. sort: [column, direction] (-1 = largest first). */
export const IDEAS = [
  { id: 'gainers', label: 'Top gainers', hint: 'Biggest rises today', filter: (r) => r.c > 0, sort: ['c', -1] },
  { id: 'losers', label: 'Top losers', hint: 'Biggest drops today', filter: (r) => r.c < 0, sort: ['c', 1] },
  { id: 'unusual', label: 'Unusual volume', hint: 'Trading at least 2× their usual daily volume', filter: (r) => r.rv >= 2, sort: ['rv', -1] },
  { id: 'highs', label: 'Highs & breakouts', hint: "At a 52-week high, or above the last 20 days' range", filter: (r) => has(r, 'new-high', 'breakout'), sort: ['c', -1] },
  { id: 'lows', label: 'Lows & breakdowns', hint: "At a 52-week low, or below the last 20 days' range", filter: (r) => has(r, 'new-low', 'breakdown'), sort: ['c', 1] },
  { id: 'uptrend', label: 'Strong uptrend', hint: 'Above the 50-day average, which is above the 200-day; RSI 50–70', filter: (r) => has(r, 'uptrend') && between(r.rsi, 50, 70), sort: ['r1m', -1] },
  { id: 'downtrend', label: 'Downtrend', hint: 'Below the 50-day average, which is below the 200-day', filter: (r) => has(r, 'downtrend'), sort: ['r1m', 1] },
  { id: 'oversold', label: 'Oversold', hint: 'RSI under 30: fell hard, may bounce', filter: (r) => has(r, 'oversold'), sort: ['rsi', 1] },
  { id: 'overbought', label: 'Overbought', hint: 'RSI over 70: rose hard, may pull back', filter: (r) => has(r, 'overbought'), sort: ['rsi', -1] },
  { id: 'gaps', label: 'Gaps', hint: "Opened 3% or more away from yesterday's close", filter: (r) => has(r, 'gap-up', 'gap-down'), sort: ['gapAbs', -1] },
  { id: 'crosses', label: 'Golden & death crosses', hint: 'The 50-day average crossed the 200-day in the last 10 sessions', filter: (r) => has(r, 'golden-cross', 'death-cross'), sort: ['d50', -1] },
  { id: 'earnings', label: 'Earnings this week', hint: 'Reporting in the next 7 days', filter: (r) => has(r, 'earnings'), sort: ['er', 1] },
  { id: 'all', label: 'All stocks', hint: 'Everything, largest first', filter: () => true, sort: ['m', -1] },
];

const CAPS = [[0, 'Any size'], [3e8, '≥ $300M'], [2e9, '≥ $2B'], [1e10, '≥ $10B'], [2e11, '≥ $200B']];
const VOLS = [[0, 'Any volume'], [1e5, '≥ 100K/day'], [5e5, '≥ 500K/day'], [1e6, '≥ 1M/day'], [5e6, '≥ 5M/day']];

const COLUMNS = [
  ['s', 'Symbol'], ['p', 'Price'], ['c', 'Chg %'], ['rv', 'Rel vol'], ['v', 'Volume'], ['m', 'Mkt cap'],
  ['d50', 'vs 50D'], ['d200', 'vs 200D'], ['h52', 'From 52W high'], ['rsi', 'RSI'], ['r1m', '1M'], ['sig', 'Signals'],
];

const TAGS = {
  'new-high': ['52W high', 'up'], breakout: ['Breakout', 'up'], 'new-low': ['52W low', 'down'], breakdown: ['Breakdown', 'down'],
  uptrend: ['Uptrend', 'up'], downtrend: ['Downtrend', 'down'], 'golden-cross': ['Golden cross', 'up'], 'death-cross': ['Death cross', 'down'],
  oversold: ['Oversold', 'info'], overbought: ['Overbought', 'info'], 'unusual-volume': ['Volume', 'info'],
  'gap-up': ['Gap up', 'up'], 'gap-down': ['Gap down', 'down'], earnings: ['Earnings', 'info'],
};

const pct = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export function fmtCap(m) {
  if (!m) return '—';
  if (m >= 1e12) return `$${(m / 1e12).toFixed(2)}T`;
  if (m >= 1e9) return `$${(m / 1e9).toFixed(m >= 1e11 ? 0 : 1)}B`;
  return `$${(m / 1e6).toFixed(0)}M`;
}
const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function tag(r, t) {
  const [label, tone] = TAGS[t] || [t, 'info'];
  let text = label, title = '';
  if (t === 'unusual-volume') text = `Vol ${r.rv.toFixed(1)}×`;
  if (t === 'gap-up' || t === 'gap-down') text = `Gap ${pct(r.gap, 1)}`;
  if (t === 'earnings' && r.er) { text = `Earnings ${day(r.er)}`; title = 'Next earnings report'; }
  if (t === 'golden-cross' || t === 'death-cross') title = `${r.cross?.daysAgo === 0 ? 'Today' : `${r.cross?.daysAgo} sessions ago`}`;
  return `<span class="sc-tag ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

/** Rows that pass an idea and the filters, sorted. Exported for tests. */
export function applyScreen(rows, { idea = 'gainers', cap = 0, vol = 0, sector = '', priceMin = 0 } = {}, sort = null) {
  const def = IDEAS.find((x) => x.id === idea) || IDEAS[0];
  const [key, dir] = sort || def.sort;
  const val = (r) => (key === 'gapAbs' ? Math.abs(r.gap ?? 0) : key === 'sig' ? r.sig.length : r[key]);
  return rows
    .filter((r) => (r.m || 0) >= cap && ((r.av ?? r.v) || 0) >= vol && (!sector || r.sec === sector) && (r.p || 0) >= priceMin && def.filter(r))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // missing values last, whatever the direction
      if (y == null) return -1;
      return typeof x === 'string' ? dir * x.localeCompare(y) : dir * (x - y);
    });
}

export class Screener {
  constructor({ onPick, getActiveSymbol }) {
    this.onPick = onPick;
    this.getActiveSymbol = getActiveSymbol;
    this.el = $('#screener');
    this.body = $('#sc-body');
    this.data = null;
    this.timer = null;
    this.selected = -1;
    this.shown = [];
    const saved = store.get('screener', {});
    this.state = { idea: 'gainers', cap: 2e9, vol: 5e5, sector: '', priceMin: 0, ...saved };
    this.sort = null; // column clicked by the user (else the idea's own order)

    this.el.querySelector('#sc-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('screenerHeight', 430), false);
  }

  get isOpen() { return !this.el.hidden; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(220, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('screenerHeight', height);
  }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('screener-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      this.body.innerHTML = `<div class="st-empty"><b>The screener runs in the desktop app</b>
        <span>It scans about 3,000 US stocks with data a website can't fetch directly. Download the desktop app, or run it with <code>npm start</code>.</span></div>`;
      return;
    }
    if (!this.data) this.body.innerHTML = '<div class="st-empty"><b>Scanning about 3,000 US stocks…</b><span>The first scan takes a few seconds.</span></div>';
    this.load();
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('screener-open');
    clearTimeout(this.timer);
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  async load() {
    clearTimeout(this.timer);
    try {
      const r = await fetch(apiUrl('api/screener'));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      this.data = j;
      this.render();
    } catch (e) {
      if (!this.data) this.body.innerHTML = `<div class="st-empty"><b>Couldn't load the screener</b><span>${esc(e.message)}</span></div>`;
    }
    if (!this.isOpen) return;
    // Faster while the trend metrics are still being calculated.
    const busy = this.data && this.data.tech.done < this.data.tech.total;
    this.timer = setTimeout(() => this.load(), busy ? 15000 : 60000);
  }

  save() { store.set('screener', this.state); }

  onChange(e) {
    const k = e.target.dataset?.f;
    if (!k) return;
    this.state[k] = k === 'sector' ? e.target.value : Number(e.target.value) || 0;
    this.save();
    this.selected = -1;
    this.render();
  }

  onClick(e) {
    const idea = e.target.closest('[data-idea]');
    if (idea) { this.state.idea = idea.dataset.idea; this.sort = null; this.selected = -1; this.save(); this.render(); return; }
    const sector = e.target.closest('[data-sector]');
    if (sector) { this.state.sector = this.state.sector === sector.dataset.sector ? '' : sector.dataset.sector; this.save(); this.render(); return; }
    const th = e.target.closest('[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      const cur = this.sort || IDEAS.find((x) => x.id === this.state.idea).sort;
      this.sort = [key, cur[0] === key ? -cur[1] : key === 's' || key === 'sec' ? 1 : -1];
      this.render();
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row) this.pick(Number(row.dataset.row));
  }

  onKey(e) {
    if (!e.target.closest('.sc-table-wrap') || !this.shown.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.max(0, Math.min(this.shown.length - 1, this.selected + (e.key === 'ArrowDown' ? 1 : -1)));
    this.pick(next);
  }

  pick(i) {
    const r = this.shown[i];
    if (!r) return;
    this.selected = i;
    this.body.querySelectorAll('[data-row]').forEach((el) => el.classList.toggle('active', Number(el.dataset.row) === i));
    this.body.querySelector(`[data-row="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    // Holding an arrow key flips through rows quickly; load the chart once it settles.
    clearTimeout(this.pickTimer);
    this.pickTimer = setTimeout(() => this.onPick(`YAHOO:${r.s}`), 120);
  }

  render() {
    const d = this.data;
    if (!d || !this.isOpen) return;
    const st = this.state;
    const all = applyScreen(d.rows, st, this.sort);
    this.shown = all.slice(0, 300);
    const sort = this.sort || IDEAS.find((x) => x.id === st.idea).sort;
    const sectors = [...new Set(d.rows.map((r) => r.sec).filter(Boolean))].sort();
    const active = this.getActiveSymbol?.();
    const i = d.insights;
    const breadth = i.up + i.down ? Math.round((i.up / (i.up + i.down)) * 100) : 50;
    const option = (list, cur) => list.map(([v, l]) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${l}</option>`).join('');
    const sectorChip = (s) => `<button class="sc-sector${st.sector === s.sec ? ' on' : ''}" data-sector="${esc(s.sec)}" title="${s.up} up, ${s.down} down · click to filter">
        ${esc(s.sec)} <b class="${cls(s.change)}">${pct(s.change)}</b></button>`;
    const cell = (r, key) => {
      switch (key) {
        case 's': return `<td class="sc-sym" title="${esc([r.n, r.sec, r.ind].filter(Boolean).join(' · '))}"><b>${esc(r.s)}</b><span>${esc(r.n || '')}</span></td>`;
        case 'p': return `<td>${r.p != null ? r.p.toLocaleString('en-US', { maximumFractionDigits: r.p < 1 ? 4 : 2, minimumFractionDigits: 2 }) : '—'}</td>`;
        case 'c': case 'd50': case 'd200': case 'h52': case 'r1m': return `<td class="${cls(r[key])}">${pct(r[key])}</td>`;
        case 'rv': return `<td class="${r.rv >= 2 ? 'hot' : ''}">${r.rv != null ? `${r.rv.toFixed(2)}×` : '—'}</td>`;
        case 'v': return `<td>${r.v != null ? formatVolume(r.v) : '—'}</td>`;
        case 'm': return `<td>${fmtCap(r.m)}</td>`;
        case 'rsi': return `<td class="${r.rsi > 70 ? 'down' : r.rsi < 30 ? 'up' : ''}">${r.rsi != null ? r.rsi.toFixed(0) : '—'}</td>`;
        case 'sec': return `<td class="sc-sec">${esc(r.sec)}</td>`;
        case 'sig': return `<td class="sc-tags">${r.sig.slice(0, 3).map((t) => tag(r, t)).join('')}</td>`;
        default: return '<td></td>';
      }
    };
    // Keep the table's scroll position and keyboard focus across refreshes.
    const oldWrap = this.body.querySelector('.sc-table-wrap');
    const scroll = oldWrap?.scrollTop || 0;
    const focused = !!oldWrap && document.activeElement === oldWrap;
    const updated = new Date(d.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const techNote = d.tech.done < d.tech.total ? ` · calculating trends ${d.tech.done.toLocaleString()} of ${d.tech.total.toLocaleString()}` : '';
    this.body.innerHTML = `
      <div class="sc-insights">
        <div class="sc-breadth" title="Stocks up vs down today">
          <span class="up">${i.up.toLocaleString()} up</span>
          <span class="sc-bar"><i style="width:${breadth}%"></i></span>
          <span class="down">${i.down.toLocaleString()} down</span>
        </div>
        <span class="sc-stat" title="Share of stocks above their 50-day moving average">Above 50D <b>${i.above50 ?? '—'}%</b></span>
        <span class="sc-stat" title="Share of stocks above their 200-day moving average">Above 200D <b>${i.above200 ?? '—'}%</b></span>
        <button class="sc-stat link" data-idea="highs">52W highs <b class="up">${i.newHighs}</b></button>
        <button class="sc-stat link" data-idea="lows">52W lows <b class="down">${i.newLows}</b></button>
        <button class="sc-stat link" data-idea="unusual">Unusual volume <b>${i.unusualVolume}</b></button>
        <button class="sc-stat link" data-idea="earnings">Earnings this week <b>${i.earnings}</b></button>
      </div>
      <div class="sc-sectors">${i.sectors.slice(0, 4).map(sectorChip).join('')}<span class="sc-dots">…</span>${i.sectors.slice(-3).map(sectorChip).join('')}</div>
      <div class="sc-ideas" role="tablist">${IDEAS.map((x) => `<button data-idea="${x.id}" class="${x.id === st.idea ? 'on' : ''}" title="${esc(x.hint)}">${esc(x.label)}</button>`).join('')}</div>
      <div class="sc-filters">
        <select class="select" data-f="cap" aria-label="Market cap">${option(CAPS, st.cap)}</select>
        <select class="select" data-f="vol" aria-label="Average volume">${option(VOLS, st.vol)}</select>
        <select class="select" data-f="sector" aria-label="Sector"><option value="">All sectors</option>${sectors.map((s) => `<option${s === st.sector ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <label class="sc-price">Price ≥ <input type="number" min="0" step="1" data-f="priceMin" value="${st.priceMin || ''}" placeholder="0"></label>
        <span class="muted sc-count">${all.length.toLocaleString()} match${all.length === 1 ? '' : 'es'}${all.length > 300 ? ' · showing the first 300' : ''}</span>
        <span class="spacer"></span>
        <span class="muted sc-updated">${d.limited ? 'Basic data only (Yahoo quotes unavailable) · ' : ''}Updated ${updated}${techNote}</span>
      </div>
      <div class="sc-table-wrap" tabindex="0" aria-label="Screener results: use the arrow keys to flip through charts">
        ${this.shown.length ? `<table class="sc-table">
          <thead><tr>${COLUMNS.map(([k, label]) => `<th data-sort="${k}" class="${sort[0] === k ? `sorted ${sort[1] > 0 ? 'asc' : 'desc'}` : ''}">${label}</th>`).join('')}</tr></thead>
          <tbody>${this.shown.map((r, n) => `<tr data-row="${n}" class="${r.s === active ? 'current ' : ''}${n === this.selected ? 'active' : ''}">${COLUMNS.map(([k]) => cell(r, k)).join('')}</tr>`).join('')}</tbody>
        </table>` : '<div class="st-empty"><b>No stocks match</b><span>Try another idea or loosen the filters (market cap, volume, sector, price).</span></div>'}
      </div>`;
    const wrap = this.body.querySelector('.sc-table-wrap');
    wrap.scrollTop = scroll;
    if (focused) wrap.focus({ preventScroll: true });
  }
}
