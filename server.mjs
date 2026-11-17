// OPTIONAL Wickline server. The app in public/ is a static site that runs anywhere without it.
// Running this adds keyless stock data: it relays Yahoo Finance (which blocks direct browser
// requests from other sites), the live Yahoo price stream, Yahoo screeners and live Nasdaq lists.
// The app detects it automatically (GET /api/health).
// Zero dependencies — needs Node.js 22+ (built-in fetch and WebSocket).

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { fetchUsList } from './lib/market-lists.mjs';
import { cleanSpikes } from './lib/clean-bars.mjs';
import { technicals, buildRow, insights } from './lib/screener.mjs';

// The app's version (package.json), reported by /api/health for the desktop app's update notice.
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Yahoo Finance relay
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const cache = new Map();

async function yahooGet(pathAndQuery, ttlMs) {
  const hit = cache.get(pathAndQuery);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;

  let lastErr = new Error('Yahoo request failed');
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}${pathAndQuery}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data) {
        const msg = data?.chart?.error?.description || data?.finance?.error?.description;
        lastErr = new Error(msg || `Yahoo HTTP ${r.status}`);
        lastErr.status = r.status === 404 ? 404 : 502;
        if (r.status === 404) break;
        continue;
      }
      if (cache.size > 400) cache.clear();
      cache.set(pathAndQuery, { t: Date.now(), data });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  // Yahoo rate-limits bursts; serve the last good copy rather than failing.
  if (hit && lastErr.status !== 404) return hit.data;
  throw lastErr;
}

// Timeframe → Yahoo request settings.
// `spacing` is the bar length in seconds, used to merge Yahoo's irregular "live" points.
const DAY = 86400;
const YAHOO_TF = {
  '1m':  { interval: '1m',  range: '7d',   live: '1d',  spacing: 60 },
  '5m':  { interval: '5m',  range: '60d',  live: '1d',  spacing: 300 },
  '15m': { interval: '15m', range: '60d',  live: '1d',  spacing: 900 },
  '30m': { interval: '30m', range: '60d',  live: '1d',  spacing: 1800 },
  '1h':  { interval: '60m', range: '730d', live: '5d',  spacing: 3600 },
  '2h':  { interval: '60m', range: '730d', live: '5d',  spacing: 3600, aggregate: 2 * 3600 },
  '4h':  { interval: '60m', range: '730d', live: '5d',  spacing: 3600, aggregate: 4 * 3600 },
  '1D':  { interval: '1d',  full: true,    live: '5d',  spacing: DAY, daily: true },
  '1W':  { interval: '1wk', full: true,    live: '1mo', spacing: 7 * DAY, daily: true },
  '1M':  { interval: '1mo', full: true,    live: '3mo', spacing: 28 * DAY, daily: true },
};

function normalizeChart(json, tfCfg) {
  const res = json?.chart?.result?.[0];
  if (!res) throw Object.assign(new Error(json?.chart?.error?.description || 'No data'), { status: 404 });

  const m = res.meta || {};
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const off = m.gmtoffset || 0; // show times in the exchange's local time, like TradingView

  let bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    let t = ts[i] + off;
    if (tfCfg.daily) t = Math.floor(t / DAY) * DAY;
    bars.push({ time: t, open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  bars.sort((a, b) => a.time - b.time);

  // Merge points that are closer together than one bar (Yahoo appends a live/closing point).
  const merged = [];
  for (const b of bars) {
    const prev = merged[merged.length - 1];
    if (prev && b.time - prev.time < tfCfg.spacing) {
      prev.high = Math.max(prev.high, b.high);
      prev.low = Math.min(prev.low, b.low);
      prev.close = b.close;
      prev.volume = Math.max(prev.volume, b.volume);
    } else {
      merged.push({ ...b });
    }
  }
  bars = merged;

  // Yahoo adds a zero-volume "official close" point at the end of a session (e.g. 16:00 for US stocks).
  // Fold it into the session's last real bar instead of showing a flat extra candle.
  if (!tfCfg.daily) {
    bars = bars.filter((b, i) => {
      const prev = bars[i - 1], next = bars[i + 1];
      const isClosePrint = b.volume === 0 && b.open === b.close && b.high === b.low && prev && prev.volume > 0
        && (!next || Math.floor(next.time / DAY) !== Math.floor(b.time / DAY));
      if (!isClosePrint) return true;
      prev.close = b.close;
      prev.high = Math.max(prev.high, b.close);
      prev.low = Math.min(prev.low, b.close);
      return false;
    });
  }

  // Bad prints (mostly pre-market / after-hours) would squash the chart; clip them.
  if (!tfCfg.daily) bars = cleanSpikes(bars);

  if (tfCfg.aggregate) bars = aggregate(bars, tfCfg.aggregate);

  return {
    meta: {
      symbol: m.symbol,
      name: m.longName || m.shortName || m.symbol,
      currency: m.currency || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      type: m.instrumentType || '',
      precision: Number.isInteger(m.priceHint) ? m.priceHint : 2,
      price: m.regularMarketPrice,
      tzOffset: off,
    },
    bars,
  };
}

// Build larger bars (e.g. 4h from 1h), anchored to the first bar of each day.
function aggregate(bars, size) {
  const out = [];
  let dayKey = null, anchor = 0, cur = null;
  for (const b of bars) {
    const dk = Math.floor(b.time / DAY);
    if (dk !== dayKey) { dayKey = dk; anchor = b.time; }
    const bucket = anchor + Math.floor((b.time - anchor) / size) * size;
    if (cur && cur.time === bucket) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      cur = { ...b, time: bucket };
      out.push(cur);
    }
  }
  return out;
}

async function yahooChart(symbol, tf, live, prepost = false) {
  const cfg = YAHOO_TF[tf];
  if (!cfg) throw Object.assign(new Error(`Unsupported timeframe ${tf}`), { status: 400 });
  // prepost: also pre-market and after-hours bars (intraday only; daily bars are the regular session).
  const params = new URLSearchParams({ interval: cfg.interval, includePrePost: prepost && !cfg.daily ? 'true' : 'false' });
  if (live) params.set('range', cfg.live);
  else if (cfg.full) { params.set('period1', '0'); params.set('period2', String(Math.floor(Date.now() / 1000))); }
  else params.set('range', cfg.range);
  // Round period2 so the cache key stays stable for a minute.
  if (params.has('period2')) params.set('period2', String(Math.floor(Date.now() / 60000) * 60));
  const json = await yahooGet(`/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, live ? 8000 : 60000);
  return normalizeChart(json, cfg);
}

/** Last price, previous close and name for many symbols (Yahoo's spark endpoint, 20 per request). */
async function yahooQuotes(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  const results = await Promise.allSettled(chunks.map(async (chunk) => {
    const json = await yahooGet(`/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=1d&interval=1d`, 15000);
    return (json.spark?.result || []).map((r) => {
      const m = r.response?.[0]?.meta || {};
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose;
      return {
        symbol: r.symbol,
        name: m.shortName || m.longName || r.symbol,
        price,
        prevClose: prev ?? null,
        change: prev ? ((price - prev) / prev) * 100 : null,
        precision: Number.isInteger(m.priceHint) ? m.priceHint : 2,
        exchange: m.fullExchangeName || m.exchangeName || '',
      };
    });
  }));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((q) => Number.isFinite(q.price));
}

const SCREENERS = new Set([
  'day_gainers', 'day_losers', 'most_actives', 'small_cap_gainers', 'undervalued_growth_stocks',
  'growth_technology_stocks', 'undervalued_large_caps', 'aggressive_small_caps', 'most_shorted_stocks',
  'top_mutual_funds', 'portfolio_anchors', 'solid_large_growth_funds', 'conservative_foreign_funds', 'high_yield_bond',
]);

/** Yahoo's predefined stock screens, plus 'trending'. */
async function yahooScreener(id) {
  if (id === 'trending') {
    const json = await yahooGet('/v1/finance/trending/US?count=25', 120000);
    const symbols = (json.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
    return yahooQuotes(symbols);
  }
  if (!SCREENERS.has(id)) throw Object.assign(new Error('Unknown screener'), { status: 400 });
  const json = await yahooGet(`/v1/finance/screener/predefined/saved?scrIds=${id}&count=50`, 120000);
  return (json.finance?.result?.[0]?.quotes || []).map((q) => ({
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: q.regularMarketChangePercent,
    precision: Number.isInteger(q.priceHint) ? q.priceHint : 2,
    exchange: q.fullExchangeName || '',
  })).filter((q) => q.symbol && Number.isFinite(q.price));
}

async function yahooSearch(q) {
  const params = new URLSearchParams({ q, quotesCount: '25', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' });
  const json = await yahooGet(`/v1/finance/search?${params}`, 300000);
  return (json.quotes || [])
    .filter((x) => x.symbol && x.quoteType !== 'OPTION')
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      exchange: x.exchDisp || x.exchange || '',
      type: x.typeDisp || x.quoteType || '',
      quoteType: x.quoteType || '',
    }));
}

// ---------------------------------------------------------------------------
// Full market lists: every US-listed stock and ETF (from Nasdaq's public screener)
// ---------------------------------------------------------------------------

const UNIVERSE_TTL = 10 * 60 * 1000;
const universeCache = new Map();

async function loadUniverse(id) {
  const hit = universeCache.get(id);
  if (hit && Date.now() - hit.t < UNIVERSE_TTL) return hit;
  try {
    const rows = await fetchUsList(id);
    const entry = { t: Date.now(), rows, body: gzipSync(JSON.stringify(rows)) };
    universeCache.set(id, entry);
    return entry;
  } catch (e) {
    if (hit) return hit; // serve the last good copy
    throw Object.assign(new Error(`Couldn't load the market list: ${e.message}`), { status: 502 });
  }
}
const universe = async (id) => (await loadUniverse(id)).body;

// ---------------------------------------------------------------------------
// Stock screener (lib/screener.mjs): Yahoo quote data for the largest US stocks, plus
// trend metrics (RSI, momentum, moving-average crosses) from a year of daily closes,
// computed in the background and kept for a few hours.
// ---------------------------------------------------------------------------

const SCREENER_SIZE = 3000; // stocks covered, largest by market cap
const TECH_SIZE = 1500; // how many of them get the trend metrics
const TECH_TTL = 6 * 3600 * 1000;
const QUOTE_FIELDS = [
  'shortName', 'regularMarketPrice', 'regularMarketChangePercent', 'regularMarketVolume', 'regularMarketOpen',
  'regularMarketPreviousClose', 'averageDailyVolume10Day', 'averageDailyVolume3Month', 'marketCap', 'fiftyDayAverage',
  'twoHundredDayAverage', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'fiftyTwoWeekChangePercent', 'trailingPE',
  'earningsTimestamp', 'earningsTimestampStart', 'averageAnalystRating', 'preMarketChangePercent', 'postMarketChangePercent', 'marketState',
].join(',');

// Yahoo's quote endpoint needs a session cookie and a "crumb" token, fetched the way a browser does.
let yahooSession = null;
async function getYahooSession(force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.t < 6 * 3600 * 1000) return yahooSession;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('No Yahoo session');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(10000),
  });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40 || /[<{\s]/.test(crumb)) throw new Error('No Yahoo crumb');
  yahooSession = { cookie, crumb, t: Date.now() };
  return yahooSession;
}

async function yahooQuoteBatch(symbols, retry = true) {
  const sess = await getYahooSession();
  const q = new URLSearchParams({ symbols: symbols.join(','), fields: QUOTE_FIELDS, crumb: sess.crumb });
  const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?${q}`, {
    headers: { 'User-Agent': UA, Cookie: sess.cookie }, signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await getYahooSession(true); return yahooQuoteBatch(symbols, false); }
  if (!r.ok) throw new Error(`Yahoo quotes HTTP ${r.status}`);
  return (await r.json()).quoteResponse?.result || [];
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

let quoteCache = { t: 0, map: new Map(), ok: false };
async function screenerQuotes(symbols) {
  if (Date.now() - quoteCache.t < 60000) return quoteCache;
  const map = new Map();
  await mapLimit(chunks(symbols, 200), 3, async (batch) => {
    try { for (const q of await yahooQuoteBatch(batch)) map.set(q.symbol, q); } catch { /* leave these out */ }
  });
  if (!map.size && quoteCache.map.size) return quoteCache; // keep the last good data
  quoteCache = { t: Date.now(), map, ok: map.size > 0 };
  return quoteCache;
}

const techCache = new Map(); // symbol -> { t, tech }
let techJob = null;
function refreshTechnicals(symbols) {
  if (techJob) return;
  const stale = symbols.filter((sym) => !(techCache.get(sym)?.t > Date.now() - TECH_TTL));
  if (!stale.length) return;
  techJob = mapLimit(chunks(stale, 20), 2, async (batch) => {
    for (const host of YAHOO_HOSTS) {
      try {
        const r = await fetch(`https://${host}/v7/finance/spark?symbols=${encodeURIComponent(batch.join(','))}&range=1y&interval=1d`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        for (const x of (await r.json()).spark?.result || []) {
          const closes = x.response?.[0]?.indicators?.quote?.[0]?.close || [];
          techCache.set(x.symbol, { t: Date.now(), tech: technicals(closes) });
        }
        return;
      } catch { /* try the other host */ }
    }
  }).finally(() => { techJob = null; });
}

let screenerCache = null;
async function screener() {
  if (screenerCache && Date.now() - screenerCache.t < 30000) return screenerCache.body;
  const { rows: all } = await loadUniverse('us-stocks');
  const top = all.filter((r) => r.m > 0 && r.p > 0).sort((a, b) => b.m - a.m).slice(0, SCREENER_SIZE);
  const symbols = top.map((r) => r.s);
  refreshTechnicals(symbols.slice(0, TECH_SIZE));
  const quotes = await screenerQuotes(symbols);
  const now = Date.now() / 1000;
  const rows = top.map((b) => buildRow(b, quotes.map.get(b.s), techCache.get(b.s)?.tech, now));
  const info = insights(rows);
  for (const r of rows) { delete r.sma50; delete r.sma200; delete r.hi52; delete r.lo52; delete r.hi20; delete r.lo20; }
  const techTotal = Math.min(TECH_SIZE, symbols.length);
  const body = gzipSync(JSON.stringify({
    updated: Date.now(),
    limited: !quotes.ok, // only the basic list data (Yahoo's quote data was unavailable)
    tech: { done: symbols.slice(0, techTotal).filter((sym) => techCache.has(sym)).length, total: techTotal },
    insights: info,
    rows,
  }));
  screenerCache = { t: Date.now(), body };
  return body;
}

// ---------------------------------------------------------------------------
// Yahoo live prices: one upstream WebSocket, fanned out to browsers over SSE
// ---------------------------------------------------------------------------

const YAHOO_STREAM_URL = 'wss://streamer.finance.yahoo.com/?version=2';

/** Decodes the protobuf "PricingData" message Yahoo sends (only the fields we use). */
function decodePricing(buf) {
  const f = {};
  let i = 0;
  const varint = () => {
    let r = 0n, shift = 0n, b;
    do { b = buf[i++]; r |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80 && i < buf.length);
    return r;
  };
  const zigzag = (v) => Number((v >> 1n) ^ -(v & 1n));
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) f[field] = varint();
    else if (wire === 1) { f[field] = buf.readDoubleLE(i); i += 8; }
    else if (wire === 2) { const len = Number(varint()); f[field] = buf.toString('utf8', i, i + len); i += len; }
    else if (wire === 5) { f[field] = buf.readFloatLE(i); i += 4; }
    else break;
  }
  return {
    s: f[1],                                         // symbol
    p: typeof f[2] === 'number' ? Number(f[2].toPrecision(7)) : NaN, // price (sent as float32)
    t: f[3] != null ? zigzag(f[3]) : Date.now(),     // time, ms
    m: f[7] != null ? Number(f[7]) : 0,              // session: 0 pre, 1 regular, 2 post, 3 extended
    v: f[9] != null ? zigzag(f[9]) : undefined,      // day volume
  };
}

class YahooStreamer {
  constructor() {
    this.ws = null;
    this.refs = new Map();   // symbol -> number of subscribed browsers
    this.clients = new Set();
    this.retry = 0;
    this.idleTimer = null;
  }

  attach(client) {
    this.clients.add(client);
    const fresh = [];
    for (const s of client.symbols) {
      const n = this.refs.get(s) || 0;
      this.refs.set(s, n + 1);
      if (!n) fresh.push(s);
    }
    clearTimeout(this.idleTimer);
    if (!this.ws) this.connect();
    else if (fresh.length && this.ws.readyState === 1) this.ws.send(JSON.stringify({ subscribe: fresh }));
  }

  detach(client) {
    if (!this.clients.delete(client)) return;
    const gone = [];
    for (const s of client.symbols) {
      const n = (this.refs.get(s) || 1) - 1;
      if (n <= 0) { this.refs.delete(s); gone.push(s); } else this.refs.set(s, n);
    }
    if (gone.length && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ unsubscribe: gone }));
    if (!this.refs.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.refs.size) return;
        const ws = this.ws;
        this.ws = null;
        ws?.close();
      }, 30000);
    }
  }

  connect() {
    if (typeof WebSocket === 'undefined') return; // Node < 22: fall back to polling only
    const ws = new WebSocket(YAHOO_STREAM_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.refs.size) ws.send(JSON.stringify({ subscribe: [...this.refs.keys()] }));
    };
    ws.onmessage = (ev) => {
      let tick;
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        if (!msg.message) return;
        tick = decodePricing(Buffer.from(msg.message, 'base64'));
      } catch {
        return;
      }
      if (!tick.s || !Number.isFinite(tick.p)) return;
      for (const c of this.clients) if (c.symbols.has(tick.s)) c.send(tick);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.refs.size) return;
      setTimeout(() => { if (!this.ws && this.refs.size) this.connect(); }, Math.min(1000 * 2 ** this.retry++, 30000));
    };
    ws.onerror = () => {}; // a close event follows
  }
}

const streamer = new YahooStreamer();

function handleStream(url, req, res) {
  const symbols = new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    ...CORS,
  });
  res.write('retry: 3000\n\n');
  const client = { symbols, send: (tick) => res.write(`data: ${JSON.stringify(tick)}\n\n`) };
  streamer.attach(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    streamer.detach(client);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// The API carries public market data only, so any site may use it (e.g. a static Wickline
// on GitHub Pages pointed at this server in its settings).
const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

async function handleApi(url, req, res) {
  const p = url.searchParams;
  if (url.pathname === '/api/health') return sendJson(res, 200, { app: 'wickline', version: VERSION, features: ['yahoo', 'stream', 'universe', 'screener', 'stock-screener'] });
  if (url.pathname === '/api/yahoo/stream') return handleStream(url, req, res);
  try {
    const u = /^\/api\/universe\/(us-stocks|us-etfs)$/.exec(url.pathname);
    if (u) {
      const body = await universe(u[1]);
      res.writeHead(200, {
        'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=300', Vary: 'Accept-Encoding', ...CORS,
      });
      return res.end(body);
    }
    if (url.pathname === '/api/yahoo/chart') {
      const symbol = p.get('symbol');
      if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
      return sendJson(res, 200, await yahooChart(symbol, p.get('tf') || '1D', p.get('live') === '1', p.get('prepost') === '1'));
    }
    if (url.pathname === '/api/yahoo/quotes') {
      const symbols = (p.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
      return sendJson(res, 200, await yahooQuotes(symbols));
    }
    if (url.pathname === '/api/screener') {
      const body = await screener();
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', ...CORS });
      return res.end(body);
    }
    if (url.pathname === '/api/yahoo/screener') {
      return sendJson(res, 200, await yahooScreener(p.get('id') || 'most_actives'));
    }
    if (url.pathname === '/api/yahoo/search') {
      const q = (p.get('q') || '').trim();
      return sendJson(res, 200, q ? await yahooSearch(q) : []);
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    return sendJson(res, e.status || 502, { error: e.message || String(e) });
  }
}

async function serveFile(filePath, res) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleApi(url, req, res);

  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  return serveFile(filePath, res);
}

/** Starts the server (also used by the desktop app). Resolves with the port it listens on. */
export function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}

// `npm start` / `node server.mjs`
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { port } = await startServer();
  console.log(`Wickline running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
}
