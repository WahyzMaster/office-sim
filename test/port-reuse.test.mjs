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
import {
  baseUrl, isOfficeSimHealth, probeHealthz, reuseRunning, PROBE_TIMEOUT_MS, MAX_PROBE_BODY,
  REUSE_FLAGS, reuseAllowed, listenFailureHint, onListenFailure,
} from '../src/port-reuse.mjs';
import { parseArgs } from '../src/cli-args.mjs';

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

// ---- D18: only a run that says nothing but what to open reuses the running office-sim ----

const OLD_HINT = ' (port in use: try --port 0 or another port)';

test('D18 reuseAllowed: true only when argv holds nothing but --open, --no-open and --demo', () => {
  assert.deepEqual([...REUSE_FLAGS], ['--open', '--no-open', '--demo']);
  for (const argv of [[], ['--open'], ['--no-open'], ['--demo'], ['--demo', '--no-open'], ['--open', '--no-open', '--demo', '--open']]) {
    assert.equal(reuseAllowed(argv), true, argv.join(' '));
    assert.doesNotThrow(() => parseArgs(argv), 'each is an argv the bin accepts');
  }
  // every other option of the bin, alone and next to an allowed one; the = form; things that are not flags at all
  for (const argv of [
    ['--port', '4747'], ['--port=4747'], ['--port', '0'], ['--host', 'localhost'], ['--interval', '500'], ['--active', '5'], ['--rescan', '1000'],
    ['--claude-root', '/tmp/x'], ['--root', '/tmp/x'], ['--agents', 'codex'], ['--codex-root', '/tmp/x'], ['--grok-root', '/tmp/x'],
    ['--antigravity-root', '/tmp/x'], ['--plugins', 'gemini-cli'], ['--gemini-cli-root', '/tmp/x'], ['--auth'], ['--cdn'], ['--notify'],
    ['--notify', 'all'], ['--replay', 'x.jsonl'], ['--replay', 'x.jsonl', '--speed', '2', '--loop'],
    ['--demo', '--cdn'], ['--auth', '--open'], ['--no-open', '--agents', 'claude-code'],
    ['--open=1'], ['--demo=yes'], ['--OPEN'], ['-h'], ['--help'], ['demo'], [''], ['--open', ''],
  ]) assert.equal(reuseAllowed(argv), false, argv.join(' '));
  for (const notArgv of [undefined, null, '--open', { 0: '--open', length: 1 }]) assert.equal(reuseAllowed(notArgv), false, String(notArgv));
});

test('D18 listenFailureHint: the old hint, or one line that names the running URL and --port', () => {
  assert.equal(listenFailureHint(inUse()), OLD_HINT);
  assert.equal(listenFailureHint(inUse(), null), OLD_HINT);
  const hint = listenFailureHint(inUse(), 'http://127.0.0.1:4747/');
  assert.match(hint, /^ \(.*\)$/);
  assert.ok(hint.includes('office-sim running at http://127.0.0.1:4747/'), hint);
  assert.match(hint, /try --port 0 or another port\)$/);
  for (const flag of REUSE_FLAGS) assert.ok(hint.includes(flag), `names ${flag}`);
  assert.equal(hint.includes('\n'), false, 'one line');
  for (const err of [Object.assign(new Error('x'), { code: 'EACCES' }), new Error('no code'), null, undefined]) {
    assert.equal(listenFailureHint(err, 'http://127.0.0.1:4747/'), '');
    assert.equal(listenFailureHint(err), '');
  }
});

test('D18 onListenFailure: a run with only --open / --no-open / --demo reuses the running office-sim', async () => {
  const app = await officeSim();
  for (const [argv, open] of [[[], false], [['--demo'], false], [['--no-open', '--demo'], false], [['--open'], true], [['--demo', '--open'], true]]) {
    const fx = effects();
    const got = await onListenFailure(inUse(), { argv, portArg: undefined, host: '127.0.0.1', port: app.port, open, write: fx.write, openUrl: fx.openUrl, timeoutMs: PATIENT });
    assert.deepEqual(got, { reused: app.url, hint: '' }, argv.join(' '));
    assert.deepEqual(fx.written, [`office-sim: already running at ${app.url}\n`], argv.join(' '));
    assert.deepEqual(fx.opened, open ? [app.url] : [], argv.join(' '));
  }
});

test('D18 onListenFailure: with any other option the conflict stays an error that names the running URL and --port', async () => {
  const app = await officeSim();
  for (const argv of [['--replay', 'x.jsonl'], ['--auth'], ['--agents', 'codex'], ['--claude-root', '/tmp/x'], ['--notify'], ['--cdn'], ['--demo', '--cdn'], ['--open', '--active', '5']]) {
    const fx = effects();
    const got = await onListenFailure(inUse(), { argv, portArg: undefined, host: '127.0.0.1', port: app.port, open: true, write: fx.write, openUrl: fx.openUrl, timeoutMs: PATIENT });
    assert.equal(got.reused, null, argv.join(' '));
    assert.equal(got.hint, listenFailureHint(inUse(), app.url), argv.join(' '));
    assert.ok(got.hint.includes(app.url) && got.hint.includes('--port'), got.hint);
    assert.deepEqual([fx.written, fx.opened], [[], []], `${argv.join(' ')}: nothing printed on stdout, nothing opened`);
  }
});

test('D18 onListenFailure: an explicit --port stays a failure, probes that port for the URL hint, and skips invalid ports (< 1)', async () => {
  const like = await otherProgram(json(200, { ok: true, agents: [] })); // answers /healthz the way an office-sim does
  const fx = effects();
  const base = { host: '127.0.0.1', port: 4747, open: true, write: fx.write, openUrl: fx.openUrl, timeoutMs: PATIENT };
  const expectedUrl = baseUrl('127.0.0.1', like.port);
  for (const argv of [['--port', String(like.port)], ['--port', String(like.port), '--demo'], ['--port', String(like.port), '--replay', 'x.jsonl']]) {
    assert.deepEqual(
      await onListenFailure(inUse(), { ...base, argv, portArg: like.port }),
      { reused: null, hint: listenFailureHint(inUse(), expectedUrl) },
      argv.join(' '),
    );
  }
  assert.equal(like.seen.requests, 3, 'explicit --port probes portArg (never default 4747) for the running URL hint');
  assert.deepEqual(
    await onListenFailure(inUse(), { ...base, argv: ['--port', '0'], portArg: 0 }),
    { reused: null, hint: OLD_HINT },
    'invalid portArg (< 1) sends no probe and keeps OLD_HINT',
  );
  assert.equal(like.seen.requests, 3);
  assert.deepEqual([fx.written, fx.opened], [[], []]);
  const hello = await otherProgram((req, res) => res.end('hello'));
  for (const argv of [[], ['--demo'], ['--cdn'], ['--auth']]) {
    assert.deepEqual(await onListenFailure(inUse(), { ...base, port: hello.port, argv, portArg: undefined }), { reused: null, hint: OLD_HINT }, argv.join(' '));
  }
  assert.deepEqual([fx.written, fx.opened], [[], []]);
  // an error that is not a busy port: no probe, no hint
  const before = like.seen.requests;
  assert.deepEqual(await onListenFailure(new RangeError('port must be 0..65535'), { ...base, argv: [], portArg: undefined }), { reused: null, hint: '' });
  assert.deepEqual(await onListenFailure(new RangeError('x'), { ...base, argv: ['--cdn'], portArg: undefined }), { reused: null, hint: '' });
  assert.equal(like.seen.requests, before);
});

test('the bin hands the failed listen to onListenFailure with its own argv, and prints the hint it returns', async () => {
  const src = await fs.readFile(new URL('../src/cli-main.mjs', import.meta.url), 'utf8');
  assert.match(src, /const argv = process\.argv\.slice\(2\);/);
  assert.match(src, /args = parseArgs\(argv\);/);
  assert.match(src, /await onListenFailure\(err, \{\s+argv, portArg: args\.port, host: args\.host \?\? DEFAULTS\.host, port: DEFAULTS\.port, open,/);
  assert.match(src, /process\.stderr\.write\(`office-sim: \$\{err\?\.message \?\? err\}\$\{hint\}\\n`\);\n\s+process\.exit\(1\);/);
  assert.doesNotMatch(src, /port in use/, 'the hint text lives in src/port-reuse.mjs');
  // D19 in the reuse case: --demo without an opened browser prints the demo line for the running server's URL
  assert.match(src, /if \(reused\) \{\n\s+if \(demo && !open\) process\.stdout\.write\(demoLine\(reused\)\);/);
});

test('the probe only asks: src/port-reuse.mjs never listens, so no second port is bound', async () => {
  const src = await fs.readFile(new URL('../src/port-reuse.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.listen\(|createServer/);
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['node:http'], 'node built-ins only');
});
