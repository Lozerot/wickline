// Tests for server.mjs that need no internet: health check, static files, safety checks.
import assert from 'node:assert/strict';
import { startServer } from '../server.mjs';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${port}`;
const get = (path) => fetch(base + path);

await test('health check identifies the app', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.app, 'wickline');
  assert.match(j.version, /^\d+\.\d+\.\d+/); // used by the desktop app's update notice
  assert.ok(j.features.includes('yahoo'));
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

await test('serves the app', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /html/);
  assert.match(await r.text(), /<title>Wickline<\/title>/);
});

await test('serves scripts as JavaScript', async () => {
  const r = await get('/js/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

await test('refuses paths outside the app folder', async () => {
  for (const p of ['/..%2fpackage.json', '/%2e%2e/server.mjs', '/..%5c..%5cpackage.json']) {
    const r = await get(p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /"name":\s*"wickline"|startServer/);
  }
});

await test('unknown files are 404', async () => {
  assert.equal((await get('/nope.js')).status, 404);
});

await test('chart API wants a symbol', async () => {
  const r = await get('/api/yahoo/chart?tf=1D');
  assert.equal(r.status, 400);
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
