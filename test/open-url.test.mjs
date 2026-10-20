// P4 --open (contract 6): src/open-url.mjs picks the platform opener, passes the URL as one argv element, spawns it
// detached with stdio ignored, and turns every failure into one log line. The bin tests never open a real browser:
// PATH holds only a temp folder with fake `open` / `xdg-open` scripts (or nothing at all).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openerCommand, openUrl, isOpenableUrl } from '../src/open-url.mjs';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { request, until } from './fixtures/sse.mjs';

const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const URL1 = 'http://127.0.0.1:4317/';
const TOKEN_URL = 'http://127.0.0.1:50123/?t=AbC_-123xyz';
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-open-'));
  tmpDirs.push(d);
  return d;
}

// fake child_process.spawn: records calls; `behave(child)` can emit events on the returned child
function fakeSpawn(behave = () => {}) {
  const calls = [];
  const fn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.unrefCalls = 0;
    child.unref = () => { child.unrefCalls++; };
    calls.push({ cmd, args, options, child });
    behave(child);
    return child;
  };
  return { fn, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- openerCommand / openUrl --------------------------------------------------------------------------------

test('openerCommand: darwin open, win32 cmd /c start "", everything else xdg-open; the URL is the last, single argv element', () => {
  assert.deepEqual(openerCommand(URL1, 'darwin'), { cmd: 'open', args: [URL1], options: {} });
  assert.deepEqual(openerCommand(URL1, 'win32'), { cmd: 'cmd', args: ['/c', 'start', '""', URL1], options: { windowsVerbatimArguments: true } });
  for (const p of ['linux', 'freebsd', 'openbsd', 'android']) {
    assert.deepEqual(openerCommand(TOKEN_URL, p), { cmd: 'xdg-open', args: [TOKEN_URL], options: {} }, p);
  }
});

test('openUrl spawns the opener once, detached with stdio ignored, unref-ed, the URL as one argv element', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const s = fakeSpawn();
    const logs = [];
    assert.equal(openUrl(TOKEN_URL, { platform, spawn: s.fn, log: (m) => logs.push(m) }), true);
    assert.equal(s.calls.length, 1, platform);
    const [{ cmd, args, options, child }] = s.calls;
    assert.equal(cmd, openerCommand(TOKEN_URL, platform).cmd);
    assert.equal(args.at(-1), TOKEN_URL);
    assert.equal(args.filter((a) => a.includes('127.0.0.1')).length, 1, 'the URL is one argv element, never split');
    assert.equal(options.detached, true);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.windowsVerbatimArguments, platform === 'win32' ? true : undefined);
    assert.equal(child.unrefCalls, 1);
    assert.deepEqual(logs, []);
  }
});

test('openUrl: an async spawn error (ENOENT) and a following exit give exactly one log line, without the URL', async () => {
  const s = fakeSpawn((child) => setImmediate(() => {
    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
    child.emit('exit', -2);
    child.emit('error', Object.assign(new Error('again'), { code: 'EAGAIN' }));
  }));
  const logs = [];
  assert.equal(openUrl(TOKEN_URL, { platform: 'linux', spawn: s.fn, log: (m) => logs.push(m) }), true);
  await tick();
  await tick();
  assert.deepEqual(logs, ['open failed: xdg-open: ENOENT']);
  assert.ok(!logs.join('').includes('AbC_-123xyz'), 'no token in the log');
});

test('openUrl: a synchronous spawn throw is one log line and returns false; a non-zero exit is one log line', async () => {
  const logs = [];
  const thrower = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  assert.equal(openUrl(URL1, { platform: 'darwin', spawn: thrower, log: (m) => logs.push(m) }), false);
  assert.deepEqual(logs, ['open failed: open: EPERM']);

  const exitLogs = [];
  const s = fakeSpawn((child) => setImmediate(() => { child.emit('exit', 3); child.emit('exit', 4); }));
  openUrl(URL1, { platform: 'darwin', spawn: s.fn, log: (m) => exitLogs.push(m) });
  await tick();
  assert.deepEqual(exitLogs, ['open failed: open exited 3']);

  const okLogs = [];
  const ok = fakeSpawn((child) => setImmediate(() => child.emit('exit', 0)));
  openUrl(URL1, { platform: 'darwin', spawn: ok.fn, log: (m) => okLogs.push(m) });
  await tick();
  assert.deepEqual(okLogs, [], 'exit 0 logs nothing');
});

test('openUrl refuses anything but a loopback http URL (no spawn, one log line)', () => {
  const bad = ['file:///etc/passwd', 'https://127.0.0.1:4317/', 'http://example.com/', 'http://127.0.0.1:4317/a&calc',
    'http://127.0.0.1:4317/ x', 'http://127.0.0.1:4317/%2e%2e', 'http://127.0.0.1:4317', '', null, undefined, 42];
  for (const url of bad) {
    const s = fakeSpawn();
    const logs = [];
    assert.equal(openUrl(url, { platform: 'win32', spawn: s.fn, log: (m) => logs.push(m) }), false, String(url));
    assert.equal(s.calls.length, 0, String(url));
    assert.deepEqual(logs, ['open failed: not a loopback http URL'], String(url));
  }
  for (const good of [URL1, TOKEN_URL, 'http://localhost:1/', 'http://[::1]:65535/#demo', `${TOKEN_URL}#demo`]) {
    assert.equal(isOpenableUrl(good), true, good);
  }
});

// ---- --open flag --------------------------------------------------------------------------------------------

test('parseArgs --open is a switch: no value, no key without the flag; USAGE lists it after --auth', () => {
  assert.deepEqual(parseArgs(['--open']), { open: true });
  assert.deepEqual(parseArgs(['--open', '--auth', '--port', '0']), { open: true, auth: true, port: 0 });
  assert.throws(() => parseArgs(['--open=1']), /--open takes no value/);
  assert.equal('open' in parseArgs(['--port', '0']), false);
  const auth = USAGE.indexOf('  --auth ');
  const open = USAGE.indexOf('  --open ');
  assert.ok(auth >= 0 && open > auth, 'USAGE: --open after --auth');
  assert.match(USAGE, /--open {15}open the printed URL/);
});

// ---- bin --open (fake openers on PATH) ----------------------------------------------------------------------

const unixOnly = { skip: process.platform === 'win32' ? 'fake openers are sh scripts' : false };

// a temp PATH with fake `open` and `xdg-open` that append "<argc>\n<argv...>" to $OPEN_LOG and exit with $OPEN_EXIT
async function fakeOpeners() {
  const dir = await tmp();
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const script = '#!/bin/sh\nprintf \'%s\\n\' "$#" "$@" >> "$OPEN_LOG"\nexit "${OPEN_EXIT:-0}"\n';
  for (const name of ['open', 'xdg-open']) await fs.writeFile(path.join(bin, name), script, { mode: 0o755 });
  return { dir, bin, logFile: path.join(dir, 'open.log') };
}

async function runBin(args, envExtra) {
  const home = await tmp();
  const env = { ...process.env, HOME: home, ...envExtra };
  const child = spawn(process.execPath, [BIN, '--port', '0', '--claude-root', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  await until(() => out.includes('office-sim: agents'), 5000);
  const url = out.split('\n')[0].replace(/^office-sim: /, '');
  const stop = async () => {
    child.kill('SIGTERM');
    assert.equal(await exited, 0, err);
  };
  return { url, out: () => out, err: () => err, stop };
}
const readLog = (f) => fs.readFile(f, 'utf8').catch(() => '');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('bin --open calls the opener once with the printed URL as one argument', unixOnly, async () => {
  const fake = await fakeOpeners();
  const run = await runBin(['--open'], { PATH: fake.bin, OPEN_LOG: fake.logFile });
  try {
    assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    await until(async () => (await readLog(fake.logFile)).length > 0, 5000);
    await settle(300);
    assert.equal(await readLog(fake.logFile), `1\n${run.url}\n`, 'one call, one argument: the printed URL');
    assert.equal(run.err().includes('open failed'), false, run.err());
  } finally {
    await run.stop();
  }
});

test('bin --open --auth opens the printed token URL', unixOnly, async () => {
  const fake = await fakeOpeners();
  const run = await runBin(['--open', '--auth'], { PATH: fake.bin, OPEN_LOG: fake.logFile });
  try {
    assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    await until(async () => (await readLog(fake.logFile)).length > 0, 5000);
    await settle(300);
    assert.equal(await readLog(fake.logFile), `1\n${run.url}\n`);
  } finally {
    await run.stop();
  }
});

test('bin without --open never calls the opener (no behaviour change)', unixOnly, async () => {
  const fake = await fakeOpeners();
  const run = await runBin([], { PATH: fake.bin, OPEN_LOG: fake.logFile });
  try {
    await settle(500);
    assert.equal(await readLog(fake.logFile), '');
  } finally {
    await run.stop();
  }
});

test('bin --open with no opener on PATH, or one that fails: one log line without the URL, the server keeps serving', unixOnly, async () => {
  for (const envExtra of [{ PATH: (await tmp()) }, { OPEN_EXIT: '3' }]) {
    const fake = await fakeOpeners();
    const run = await runBin(['--open', '--auth'], { PATH: fake.bin, OPEN_LOG: fake.logFile, ...envExtra });
    try {
      await until(() => run.err().includes('open failed'), 5000);
      await settle(300);
      const lines = run.err().split('\n').filter((l) => l.includes('open failed'));
      assert.equal(lines.length, 1, run.err());
      assert.match(lines[0], envExtra.OPEN_EXIT ? /^\[office-sim\] open failed: (open|xdg-open) exited 3$/ : /^\[office-sim\] open failed: (open|xdg-open): ENOENT$/);
      assert.ok(!run.err().includes(new URL(run.url).searchParams.get('t')), 'no token in stderr');
      const port = Number(new URL(run.url).port);
      assert.equal((await request(port, { path: '/healthz' })).status, 401, 'still serving (401 without the cookie)');
    } finally {
      await run.stop();
    }
  }
});
