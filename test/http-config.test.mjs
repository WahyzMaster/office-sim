// POST /config cross-origin guard: an Origin whose host differs from the Host header is rejected (403), and the
// body must be application/json (415). Fake deps only; no transcript files are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { request } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const DEPS = { Tailer: NullTailer, scan: async () => [], readSubMeta: async () => null, readJournalLabels: async () => new Map() };

const post = (port, headers, body = JSON.stringify({ intervalMs: 300 })) => request(port, { method: 'POST', path: '/config', headers, body });

test('POST /config: Origin host must equal the Host header; content-type must be application/json', async () => {
  const app = await start({ port: 0, root: '/nonexistent-office-sim-root', publicDir: PUBLIC, deps: DEPS });
  try {
    await app.ready;
    const { port } = app;
    const json = { 'content-type': 'application/json' };
    const host = { host: `127.0.0.1:${port}` };
    const interval = async () => JSON.parse((await request(port, { path: '/config' })).body).intervalMs;
    // loopback but a different origin than the page the request claims to come from
    assert.equal((await post(port, { ...json, ...host, origin: `http://localhost:${port}` })).status, 403);
    assert.equal((await post(port, { ...json, host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` })).status, 403);
    assert.equal((await post(port, { ...json, ...host, origin: 'null' })).status, 403);
    assert.equal((await post(port, { ...json, ...host, origin: `http://127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await post(port, { ...json, ...host, origin: `https://127.0.0.1:${port}` })).status, 403, 'scheme differs');
    assert.equal(await interval(), 250, 'rejected requests change nothing');
    // content type
    assert.equal((await post(port, { ...host, origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(port, { ...host, origin: `http://127.0.0.1:${port}` })).status, 415);
    assert.equal(await interval(), 250);
    // same origin, and no Origin at all (a local CLI client), are accepted
    assert.equal((await post(port, { ...json, ...host, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await post(port, { ...json, host: `localhost:${port}`, origin: `http://localhost:${port}` }, JSON.stringify({ intervalMs: 400 }))).status, 200);
    assert.equal((await post(port, { ...json, ...host }, JSON.stringify({ intervalMs: 500 }))).status, 200);
    assert.equal(await interval(), 500);
  } finally {
    await app.close();
  }
});
