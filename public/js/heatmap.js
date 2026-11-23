// Stock heatmap panel: the largest US stocks as tiles grouped by sector, sized by market cap and
// coloured by how much they moved (today, this week, month, 3 months or year). Data comes from
// the server's /api/screener (the same scan as the Screener); clicking a tile opens its chart.
// The layout and colour functions are pure and unit-tested in test/heatmap.test.mjs.

import { apiUrl, dataMode } from './env.js';
import { $, esc, store } from './util.js';
import { fmtCap } from './screener.js';

/** Periods: the row field, and the change that gets the strongest colour. */
export const PERIODS = [
  ['c', '1D', 'Today', 3], ['r1w', '1W', 'This week', 6], ['r1m', '1M', 'This month', 10],
  ['r3m', '3M', '3 months', 20], ['y1', '1Y', '1 year', 40],
];
const SIZES = [[100, 'Top 100'], [250, 'Top 250'], [500, 'Top 500'], [1000, 'Top 1000']];
const SECTOR_LABEL = 16; // px of sector name above its tiles
const REFRESH_MS = 60000;

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): lays out values (largest first works best) in a
 * rectangle as tiles close to square. Returns [{ x, y, w, h }] in the same order as values.
 */
export function squarify(values, x, y, w, h) {
  const n = values.length;
  const out = new Array(n);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!n || total <= 0 || w <= 0 || h <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  const areas = values.map((v) => (Math.max(0, v) / total) * w * h);
  const rect = { x, y, w, h };
  // The worst (largest) aspect ratio of a row of areas laid along a side of this length.
  const worst = (sum, min, max, side) => {
    const s2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };
  let i = 0;
  while (i < n) {
    const side = Math.min(rect.w, rect.h);
    let j = i, sum = 0, min = Infinity, max = 0, best = Infinity;
    while (j < n) {
      const a = areas[j];
      const r = worst(sum + a, Math.min(min, a), Math.max(max, a), side);
      if (j > i && r > best) break; // adding this tile makes the row worse: start a new row
      best = r; sum += a; min = Math.min(min, a); max = Math.max(max, a); j++;
    }
    if (rect.w >= rect.h) {
      // A column on the left of the remaining space.
      const cw = sum / rect.h || 0;
      let yy = rect.y;
      for (let k = i; k < j; k++) { const hh = cw ? areas[k] / cw : 0; out[k] = { x: rect.x, y: yy, w: cw, h: hh }; yy += hh; }
      rect.x += cw; rect.w -= cw;
    } else {
      // A row along the top.
      const rh = sum / rect.w || 0;
      let xx = rect.x;
      for (let k = i; k < j; k++) { const ww = rh ? areas[k] / rh : 0; out[k] = { x: xx, y: rect.y, w: ww, h: rh }; xx += ww; }
      rect.y += rh; rect.h -= rh;
    }
    i = j;
  }
  return out;
}

// Red to grey to green, like most market maps.
const STOPS = [[-1, [246, 53, 56]], [-0.66, [191, 64, 69]], [-0.33, [139, 68, 78]], [0, [65, 69, 84]],
  [0.33, [53, 118, 78]], [0.66, [47, 158, 79]], [1, [48, 204, 90]]];
/** The tile colour for a change of v% when ±max% is the strongest colour (null: no data). */
export function heatColor(v, max) {
  if (v == null || !Number.isFinite(v)) return 'rgb(46, 48, 56)';
  const t = Math.max(-1, Math.min(1, v / max));
  for (let k = 1; k < STOPS.length; k++) {
    const [t1, c1] = STOPS[k];
    if (t <= t1) {
      const [t0, c0] = STOPS[k - 1];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * f)).join(', ')})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1].join(', ')})`;
}

/** The largest `top` stocks (with a market cap) grouped by sector: [{ name, value, rows }], biggest sector first. */
export function groupBySector(rows, { top = 500, sector = '' } = {}) {
  const largest = rows.filter((r) => r.m > 0).sort((a, b) => b.m - a.m).slice(0, top);
  const by = new Map();
  for (const r of largest) {
    const name = r.sec || 'Other';
    if (sector && name !== sector) continue;
    if (!by.has(name)) by.set(name, { name, value: 0, rows: [] });
    const g = by.get(name);
    g.value += r.m;
    g.rows.push(r);
  }
  return [...by.values()].sort((a, b) => b.value - a.value);
}

/** Tiles for a map of w × h: sectors, then stocks inside each (below its name when there's room). */
export function layoutMap(groups, w, h) {
  const tiles = [];
  const labels = [];
  const boxes = squarify(groups.map((g) => g.value), 0, 0, w, h);
  groups.forEach((g, gi) => {
    const b = boxes[gi];
    const named = b.w > 70 && b.h > 44;
    const top = named ? SECTOR_LABEL : 0;
    if (named) labels.push({ name: g.name, x: b.x, y: b.y, w: b.w, sector: g.name });
    const inner = squarify(g.rows.map((r) => r.m), b.x, b.y + top, b.w, b.h - top);
    g.rows.forEach((r, ri) => tiles.push({ r, ...inner[ri] }));
  });
  return { tiles, labels };
}

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const price = (p) => (p == null ? '—' : `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export class HeatmapPanel {
  constructor({ onPick }) {
    this.onPick = onPick;
    this.el = $('#heatmap');
    this.body = $('#hm-body');
    this.data = null;
    this.timer = null;
    this.state = { period: 'c', top: 500, sector: '', ...store.get('heatmap', {}) };
    this.tip = document.createElement('div');
    this.tip.className = 'hm-tip';
    this.tip.hidden = true;
    document.body.append(this.tip);

    this.el.querySelector('#hm-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.body.addEventListener('mousemove', (e) => this.onHover(e));
    this.body.addEventListener('mouseleave', () => { this.tip.hidden = true; });
    new ResizeObserver(() => { if (this.isOpen && this.data) this.draw(); }).observe(this.body);
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('heatmapHeight', 460), false);
    this.renderBar();
  }

  get isOpen() { return !this.el.hidden; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(240, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('heatmapHeight', height);
  }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('heatmap-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      this.body.innerHTML = `<div class="st-empty"><b>The heatmap runs in the desktop app</b>
        <span>It uses the scan of about 3,000 US stocks, with data a website can't fetch directly. Download the desktop app, or run it with <code>npm start</code>.</span></div>`;
      return;
    }
    if (!this.data) this.body.innerHTML = '<div class="st-empty"><b>Loading the market…</b><span>The first scan of US stocks takes a few seconds.</span></div>';
    this.load();
  }

  close() {
    this.el.hidden = true;
    this.tip.hidden = true;
    document.body.classList.remove('heatmap-open');
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
      this.draw();
    } catch (e) {
      if (!this.data) this.body.innerHTML = `<div class="st-empty"><b>Couldn't load the heatmap</b><span>${esc(e.message)}</span></div>`;
    }
    if (!this.isOpen) return;
    const busy = this.data && this.data.tech.done < this.data.tech.total;
    this.timer = setTimeout(() => this.load(), busy && this.state.period !== 'c' ? 15000 : REFRESH_MS);
  }

  save() { store.set('heatmap', this.state); }

  get period() { return PERIODS.find(([k]) => k === this.state.period) || PERIODS[0]; }

  renderBar() {
    const st = this.state;
    $('#hm-tools').innerHTML = `
      <div class="nw-seg" role="tablist" aria-label="Period">${PERIODS.map(([k, label, title]) => `<button data-hm-period="${k}" class="${st.period === k ? 'on' : ''}" title="${title}">${label}</button>`).join('')}</div>
      <select class="select" data-f="top" aria-label="How many stocks">${SIZES.map(([v, l]) => `<option value="${v}"${st.top === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="hm-crumb">${st.sector ? `<button data-hm-sector="" title="Back to every sector">All sectors</button> › <b>${esc(st.sector)}</b>` : '<span class="muted">Click a sector name to zoom in</span>'}</span>`;
  }

  onChange(e) {
    if (e.target.dataset.f === 'top') { this.state.top = Number(e.target.value); this.save(); this.draw(); }
  }

  onClick(e) {
    const p = e.target.closest('[data-hm-period]');
    if (p) { this.state.period = p.dataset.hmPeriod; this.save(); this.renderBar(); this.draw(); if (this.state.period !== 'c') this.load(); return; }
    const s = e.target.closest('[data-hm-sector]');
    if (s) { this.state.sector = s.dataset.hmSector; this.save(); this.renderBar(); this.draw(); return; }
    const t = e.target.closest('[data-sym]');
    if (t) this.onPick(`YAHOO:${t.dataset.sym}`);
  }

  draw() {
    if (!this.data) return;
    const st = this.state;
    const [key, , title, max] = this.period;
    let groups = groupBySector(this.data.rows, st);
    if (!groups.length && st.sector) { st.sector = ''; this.renderBar(); groups = groupBySector(this.data.rows, st); }
    const box = this.body.getBoundingClientRect();
    const legendH = 26;
    const w = Math.floor(box.width), h = Math.floor(box.height) - legendH;
    if (w < 50 || h < 50) return;
    const { tiles, labels } = layoutMap(groups, w, h);
    this.tiles = tiles;
    const html = [];
    for (const t of tiles) {
      if (t.w < 1 || t.h < 1) continue;
      const v = t.r[key];
      const big = t.w > 56 && t.h > 34;
      const fs = Math.max(9, Math.min(30, Math.min(t.w / 4.2, t.h / 2.6)));
      const text = big
        ? `<b style="font-size:${fs.toFixed(0)}px">${esc(t.r.s)}</b><small style="font-size:${Math.max(9, fs * 0.6).toFixed(0)}px">${pct(v)}</small>`
        : t.w > 26 && t.h > 13 ? `<b style="font-size:${Math.max(8, Math.min(12, t.h / 1.6, t.w / 4)).toFixed(0)}px">${esc(t.r.s)}</b>` : '';
      html.push(`<div class="hm-tile" data-sym="${esc(t.r.s)}" style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${t.w.toFixed(1)}px;height:${t.h.toFixed(1)}px;background:${heatColor(v, max)}">${text}</div>`);
    }
    for (const l of labels) {
      html.push(`<button class="hm-sector" data-hm-sector="${esc(st.sector ? '' : l.sector)}" style="left:${l.x.toFixed(1)}px;top:${l.y.toFixed(1)}px;width:${l.w.toFixed(1)}px" title="${st.sector ? 'Back to every sector' : `Zoom in on ${esc(l.name)}`}">${esc(l.name)}</button>`);
    }
    const missing = key !== 'c' && tiles.filter((t) => t.r[key] == null).length;
    const stops = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
    const legend = `<div class="hm-legend">
      <span class="muted">${esc(title)}${missing ? ` · ${missing} still being calculated` : ''}</span>
      <span class="spacer"></span>
      ${stops.map((s) => `<i style="background:${heatColor(s * max, max)}">${s === 0 ? '0%' : `${s > 0 ? '+' : '−'}${Math.round(Math.abs(s) * max)}%`}</i>`).join('')}
      <span class="muted hm-updated">Size: market cap · updated ${new Date(this.data.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>`;
    this.body.innerHTML = `<div class="hm-map" style="height:${h}px">${html.join('')}</div>${legend}`;
  }

  onHover(e) {
    const t = e.target.closest('.hm-tile');
    if (!t) { this.tip.hidden = true; return; }
    const r = this.data?.rows.find((x) => x.s === t.dataset.sym);
    if (!r) return;
    const line = (label, v) => `<span>${label}</span><b class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</b>`;
    this.tip.innerHTML = `<div class="hm-tip-head"><b>${esc(r.s)}</b> <span>${esc(r.n || '')}</span></div>
      <div class="muted">${esc([r.sec, r.ind].filter(Boolean).join(' · '))}</div>
      <div class="hm-tip-grid"><span>Price</span><b>${price(r.p)}</b>${line('Today', r.c)}${line('1 week', r.r1w)}${line('1 month', r.r1m)}${line('3 months', r.r3m)}${line('1 year', r.y1)}<span>Market cap</span><b>${fmtCap(r.m)}</b></div>`;
    this.tip.hidden = false;
    const pad = 14;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const x = e.clientX + pad + tw > window.innerWidth ? e.clientX - tw - pad : e.clientX + pad;
    const y = e.clientY + pad + th > window.innerHeight ? e.clientY - th - pad : e.clientY + pad;
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${Math.max(4, y)}px`;
  }
}
