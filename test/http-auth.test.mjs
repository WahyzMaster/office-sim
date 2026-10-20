// Opt-in per-run token (2026-10-19 finding 7): with --auth every route needs the cookie that GET /?t=<token>
// sets; without it nothing changes. Fake deps only; the token is generated in-process, never passed via argv/env.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { request, sse, until } from './fixtures/sse.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PUBLIC = here('../public');
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const DEPS = { Tailer: NullTailer, scan: async () => [], readSubMeta: async () => null, readJournalLabels: async () => new Map() };
const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

async function withApp(fn, over = {}) {
  const app = await start({ port: 0, root: '/nonexistent-office-sim-root', publicDir: PUBLIC, deps: DEPS, ...over });
  try {
    await app.ready;
    await fn(app);
  } finally {
    await app.close();
  }
}
const ROUTES = ['/', '/index.html', '/state', '/config', '/healthz', '/js/main.js'];
const postConfig = (port, headers = {}) => request(port, { method: 'POST', path: '/config', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ intervalMs: 300 }) });

test('--auth: the printed URL carries a fresh token; GET /?t= sets an HttpOnly SameSite=Strict cookie and redirects', async () => {
  await withApp(async (app) => {
    const { port, token } = app;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.equal(app.url, `http://127.0.0.1:${port}/?t=${token}`);
    const r = await request(port, { path: `/?t=${token}` });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const cookie = r.headers['set-cookie']?.[0] ?? '';
    const parts = cookie.split(';').map((s) => s.trim());
    assert.equal(parts[0], `osim_${port}=${token}`);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(parts.includes(attr), `${attr} in ${cookie}`);
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  }, { auth: true });
});

test('--auth: every route answers 401 without the cookie, or with a wrong token or cookie; 200 with it', async () => {
  await withApp(async ({ port, token }) => {
    const good = { cookie: `other=1; osim_${port}=${token}` };
    const bad = { cookie: `osim_${port}=${token.slice(0, -1)}x` };
    for (const p of ROUTES) {
      assert.equal((await request(port, { path: p })).status, 401, `${p} without a cookie`);
      assert.equal((await request(port, { path: p, headers: bad })).status, 401, `${p} with a wrong cookie`);
      assert.equal((await request(port, { path: p, headers: { cookie: `osim_${port + 1}=${token}` } })).status, 401, `${p} cookie of another port`);
      assert.equal((await request(port, { path: p, headers: good })).status, 200, `${p} with the cookie`);
    }
    assert.equal((await request(port, { path: '/?t=wrong' })).status, 401);
    assert.equal((await request(port, { path: `/?t=${token}x` })).status, 401);
    const denied = await request(port, { path: '/state' });
    assert.match(denied.body, /open the URL printed by office-sim/);
    assert.equal((await postConfig(port)).status, 401);
    assert.equal((await postConfig(port, good)).status, 200);
    const es = await sse(port, good);
    assert.equal(es.res.statusCode, 200);
    assert.equal((await es.next((fr) => fr.data?.type === 'snapshot')).data.type, 'snapshot');
    es.close();
    const noAuth = await sse(port);
    assert.equal(noAuth.res.statusCode, 401);
    noAuth.close();
    // the Host guard still runs first
    assert.equal((await request(port, { path: `/?t=${token}`, headers: { host: 'evil.example' } })).status, 403);
  }, { auth: true });
});

test('without --auth nothing changes: no token in the URL, no cookie needed', async () => {
  await withApp(async (app) => {
    assert.equal(app.url, `http://127.0.0.1:${app.port}/`);
    assert.equal(app.token, null);
    for (const p of ROUTES) assert.equal((await request(app.port, { path: p })).status, 200, p);
    assert.equal((await request(app.port, { path: '/?t=anything' })).status, 200);
  });
});

test('parseArgs: --auth is a flag without a value', () => {
  assert.deepEqual(parseArgs(['--auth']), { auth: true });
  assert.deepEqual(parseArgs(['--auth', '--port', '0']), { auth: true, port: 0 });
  assert.deepEqual(parseArgs(['--port', '0', '--auth']), { port: 0, auth: true });
  assert.throws(() => parseArgs(['--auth=yes']), /--auth takes no value/);
  assert.match(USAGE, /--auth/);
});

test('bin --auth prints the token URL; the cookie it sets opens the API', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-auth-'));
  tmpDirs.push(root);
  // HOME = the temp root: the bin's default roots (~/.grok since P5c) never reach the real folders
  const child = spawn(process.execPath, [here('../bin/office-sim.mjs'), '--port', '0', '--claude-root', root, '--auth'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const m = await until(() => /^office-sim: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9_-]{43})\n/.exec(out), 5000);
    const port = Number(m[1]);
    assert.equal((await request(port, { path: '/healthz' })).status, 401);
    const cookie = (await request(port, { path: `/?t=${m[2]}` })).headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(port, { path: '/healthz', headers: { cookie } })).status, 200);
  } finally {
    child.kill('SIGINT');
    assert.equal(await exited, 0);
  }
});
