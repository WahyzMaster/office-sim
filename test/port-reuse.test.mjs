// D2 (contract 6): a failed listen on the default port asks GET /healthz whether the listener is already an office-sim.
// Every server here listens on port 0 and the port is injected, so nothing depends on the real default port being free.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { start } from '../src/server.mjs';
import { isOpenableUrl } from '../src/open-url.mjs';
import { baseUrl, isOfficeSimHealth, probeHealthz, reuseRunning, PROBE_TIMEOUT_MS, MAX_PROBE_BODY } from '../src/port-reuse.mjs';

// an answer that does come must not depend on the 1 s production deadline: only the silent and dripping listeners below
// use a short one, where running out of time is the point
const PATIENT = 10_000;
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-reuse-'));
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
// a real office-sim on a free port, reading only a temp root
async function officeSim(extra = {}) {
  const app = await start({ port: 0, root: await tmp(), rescanMs: 60_000, ...extra });
  cleanups.push(() => app.close());
  return app;
}
// another program on a free port: `handler(req, res)` answers; `requests` counts what reached it
async function otherProgram(handler) {
  const seen = { requests: 0, paths: [] };
  const server = http.createServer((req, res) => {
    seen.requests++;
    seen.paths.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return { port: server.address().port, seen };
}
const json = (status, value) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
};
const inUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:1'), { code: 'EADDRINUSE' });
// the injected side effects of reuseRunning
function effects() {
  const written = [];
  const opened = [];
  return { written, opened, write: (s) => written.push(s), openUrl: (u) => opened.push(u) };
}

test('isOfficeSimHealth is the /office skill\'s test: 200, JSON, ok true and an agents array', () => {
  assert.equal(isOfficeSimHealth(200, '{"ok":true,"files":0,"sessions":0,"agents":[],"clients":0}'), true);
  assert.equal(isOfficeSimHealth(200, '{"ok":true,"agents":["claude-code","codex"]}'), true);
  const no = [
    [200, '{"ok":true}'], [200, '{"ok":true,"agents":"claude-code"}'], [200, '{"ok":true,"agents":{}}'], [200, '{"ok":true,"agents":null}'],
    [200, '{"ok":false,"agents":[]}'], [200, '{"ok":1,"agents":[]}'], [200, '{"ok":"true","agents":[]}'], [200, '{"agents":[]}'],
    [200, 'hello'], [200, ''], [200, 'null'], [200, '[]'], [200, '"ok"'], [200, '{"ok":true,"agents":[]'],
    [401, 'unauthorized: open the URL printed by office-sim\n'], [401, '{"ok":true,"agents":[]}'], [404, '{"ok":true,"agents":[]}'],
    [500, '{"ok":true,"agents":[]}'], [undefined, '{"ok":true,"agents":[]}'], [200, undefined], [200, null],
  ];
  for (const [status, body] of no) assert.equal(isOfficeSimHealth(status, body), false, `${status} ${body}`);
});

test('baseUrl is the URL start() prints: brackets around an IPv6 host, a trailing slash, openable by --open', async () => {
  assert.equal(baseUrl('127.0.0.1', 4747), 'http://127.0.0.1:4747/');
  assert.equal(baseUrl('localhost', 4747), 'http://localhost:4747/');
  assert.equal(baseUrl('::1', 4747), 'http://[::1]:4747/');
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(isOpenableUrl(baseUrl(host, 4747)), true, host);
  const app = await officeSim();
  assert.equal(baseUrl('127.0.0.1', app.port), app.url);
});

test('probeHealthz reads a real office-sim /healthz; with --auth the answer is the 401 text', async () => {
  const open = await officeSim();
  const answer = await probeHealthz({ host: '127.0.0.1', port: open.port, timeoutMs: PATIENT });
  assert.equal(answer.status, 200);
  assert.equal(isOfficeSimHealth(answer.status, answer.body), true, answer.body);
  assert.deepEqual(JSON.parse(answer.body).agents, open.agents);
  const auth = await officeSim({ auth: true });
  const denied = await probeHealthz({ host: '127.0.0.1', port: auth.port, timeoutMs: PATIENT });
  assert.deepEqual(denied, { status: 401, body: 'unauthorized: open the URL printed by office-sim\n' });
  assert.equal(isOfficeSimHealth(denied.status, denied.body), false);
});

test('probeHealthz sends one GET /healthz and never throws: a closed port is null', async () => {
  const other = await otherProgram(json(200, { ok: true, agents: [] }));
  assert.deepEqual(await probeHealthz({ host: '127.0.0.1', port: other.port, timeoutMs: PATIENT }), { status: 200, body: '{"ok":true,"agents":[]}' });
  assert.deepEqual(other.seen.paths, ['GET /healthz']);
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  assert.equal(await probeHealthz({ host: '127.0.0.1', port, timeoutMs: PATIENT }), null);
});

test('probeHealthz is bounded in time: a listener that accepts and never answers, or drips forever, is null', async () => {
  assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 2000, `a short default: ${PROBE_TIMEOUT_MS}`);
  const sockets = new Set();
  const silent = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); silent.close(() => r()); }));
  let t0 = Date.now();
  assert.equal(await probeHealthz({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 150 }), null);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`); // only a hang guard
  // headers at once, then one byte every 20 ms without an end: an idle timeout alone would never fire
  const timers = new Set();
  const drip = await otherProgram((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 20);
    timers.add(timer);
    res.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  cleanups.push(async () => { for (const t of timers) clearInterval(t); });
  t0 = Date.now();
  assert.equal(await probeHealthz({ host: '127.0.0.1', port: drip.port, timeoutMs: 200 }), null);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('probeHealthz is bounded in size: a body over the cap is null, however office-sim-like it starts', async () => {
  assert.ok(MAX_PROBE_BODY >= 4096 && MAX_PROBE_BODY <= 1024 * 1024, `cap ${MAX_PROBE_BODY}`);
  const big = await otherProgram(json(200, `{"ok":true,"agents":[],"pad":"${'x'.repeat(MAX_PROBE_BODY)}"}`));
  const t0 = Date.now();
  assert.equal(await probeHealthz({ host: '127.0.0.1', port: big.port, timeoutMs: PATIENT }), null);
  assert.ok(Date.now() - t0 < PATIENT, 'cut off by the size cap, not by the deadline');
  const fits = `{"ok":true,"agents":[],"pad":"${'x'.repeat(MAX_PROBE_BODY - 64)}"}`;
  assert.ok(fits.length <= MAX_PROBE_BODY);
  const ok = await otherProgram(json(200, fits));
  assert.equal((await probeHealthz({ host: '127.0.0.1', port: ok.port, timeoutMs: PATIENT })).body, fits);
});

test('reuseRunning: an office-sim on the default port is reported once and not opened without --open', async () => {
  const app = await officeSim();
  const fx = effects();
  const url = await reuseRunning(inUse(), { portArg: undefined, host: '127.0.0.1', port: app.port, open: false, write: fx.write, openUrl: fx.openUrl, timeoutMs: PATIENT });
  assert.equal(url, app.url);
  assert.deepEqual(fx.written, [`office-sim: already running at ${app.url}\n`]);
  assert.deepEqual(fx.opened, []);
});

test('reuseRunning: with --open the running server\'s URL is opened once, after the line', async () => {
  const app = await officeSim();
  const order = [];
  const url = await reuseRunning(inUse(), {
    portArg: undefined, host: '127.0.0.1', port: app.port, open: true, timeoutMs: PATIENT,
    write: (s) => order.push(['write', s]), openUrl: (u) => order.push(['open', u]),
  });
  assert.equal(url, app.url);
  assert.deepEqual(order, [['write', `office-sim: already running at ${app.url}\n`], ['open', app.url]]);
});

test('reuseRunning never probes when the user passed --port, or when the error is not EADDRINUSE', async () => {
  const other = await otherProgram(json(200, { ok: true, agents: [] }));
  const fx = effects();
  const base = { host: '127.0.0.1', port: other.port, open: true, write: fx.write, openUrl: fx.openUrl, timeoutMs: PATIENT };
  // an explicit --port, even one equal to the port in use: the failure stays a failure (the /office skill relies on it)
  assert.equal(await reuseRunning(inUse(), { ...base, portArg: other.port }), null);
  assert.equal(await reuseRunning(inUse(), { ...base, portArg: 0 }), null);
  for (const err of [Object.assign(new Error('x'), { code: 'EACCES' }), new Error('no code'), new RangeError('port must be 0..65535'), null, undefined]) {
    assert.equal(await reuseRunning(err, { ...base, portArg: undefined }), null);
  }
  assert.equal(other.seen.requests, 0, 'no request was sent');
  assert.deepEqual([fx.written, fx.opened], [[], []]);
  // the same listener is reused once the two conditions hold
  assert.equal(await reuseRunning(inUse(), { ...base, portArg: undefined }), baseUrl('127.0.0.1', other.port));
  assert.equal(other.seen.requests, 1);
});

test('reuseRunning: another program, an --auth office-sim, a silent listener and a closed port are not reused', async () => {
  const hello = await otherProgram((req, res) => res.end('hello'));
  const noAgents = await otherProgram(json(200, { ok: true }));
  const notOk = await otherProgram(json(503, { ok: true, agents: [] }));
  const auth = await officeSim({ auth: true });
  const silent = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const held = new Set();
  silent.on('connection', (s) => held.add(s));
  cleanups.push(() => new Promise((r) => { for (const s of held) s.destroy(); silent.close(() => r()); }));
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  // the listeners that answer are turned down for what they say (a patient deadline); only the silent one runs out of time
  const cases = {
    hello: [hello.port, PATIENT], noAgents: [noAgents.port, PATIENT], notOk: [notOk.port, PATIENT], auth: [auth.port, PATIENT],
    closed: [closedPort, PATIENT], silent: [silent.address().port, 200],
  };
  for (const [name, [port, timeoutMs]] of Object.entries(cases)) {
    const fx = effects();
    const t0 = Date.now();
    const got = await reuseRunning(inUse(), { portArg: undefined, host: '127.0.0.1', port, open: true, write: fx.write, openUrl: fx.openUrl, timeoutMs });
    assert.equal(got, null, name);
    assert.ok(Date.now() - t0 < PATIENT, `${name}: decided before the patient deadline`);
    assert.deepEqual([fx.written, fx.opened], [[], []], `${name}: nothing printed, nothing opened`);
  }
});

test('the probe only asks: src/port-reuse.mjs never listens, so no second port is bound', async () => {
  const src = await fs.readFile(new URL('../src/port-reuse.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.listen\(|createServer/);
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['node:http'], 'node built-ins only');
});
