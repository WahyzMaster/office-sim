// Maintenance PR 2 (contract 6): GET /healthz keeps its first five keys and adds the build (version, commit), the start
// time, the error counters and one entry per enabled adapter (scan time, scan error code, counters). Only numbers, ISO
// times and error codes (EACCES, SCAN_CAPPED): no path, file name, session id or message. Temp roots and port 0 only;
// the real ~/.claude, ~/.codex, ~/.grok and ~/.gemini are never read (the bin runs under a temp HOME).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, until } from './fixtures/sse.mjs';
import { fakeAdapter } from './fixtures/fake-adapter.mjs';
import { NEW_KEYS, OLD_KEYS, PACKAGE_VERSION, assertHealthShape } from './fixtures/healthz.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SID = '4ea17402-1111-4222-8333-444455556666';
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 40, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-healthz-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const health = async (app) => JSON.parse((await request(app.port, { path: '/healthz' })).body);
const claude = (h) => h.runners['claude-code'];

// A Claude root with one live main transcript (synthetic records), plus optional extra raw text at the end.
async function claudeRoot(extra = '') {
  const root = await tmp();
  const dir = path.join(root, '-work-healthz');
  await fs.mkdir(dir);
  const b = createRecordBuilder({ sessionId: SID, cwd: '/work/healthz', startMs: Date.now() - 5000, stepMs: 10 });
  const file = path.join(dir, `${SID}.jsonl`);
  await fs.writeFile(file, toJsonl([b.humanPrompt({ text: 'Healthz demo' }), b.assistantText({ msgId: 'msg_1', text: 'On it.' })]) + extra);
  return { root, file, b };
}

// No temp root (or its realpath), transcript file name or session id anywhere in the body.
async function assertNoPath(body, root, extra = []) {
  for (const s of [root, await fs.realpath(root), SID, `${SID}.jsonl`, ...extra]) assert.ok(!body.includes(s), `body carries ${s}`);
}

test('key order: the old five first, then build, start time, counters, runners; version, commit from the build option', async () => {
  const root = await tmp();
  const plain = await start({ ...FAST, root });
  const built = await start({ ...FAST, root, build: { commit: 'ac7a0b1c45c8' } });
  try {
    await Promise.all([plain.ready, built.ready]);
    const h = await health(plain);
    assert.deepEqual(Object.keys(h).slice(0, 5), ['ok', 'files', 'sessions', 'agents', 'clients']);
    assert.deepEqual(Object.keys(h), [...OLD_KEYS, ...NEW_KEYS]);
    assertHealthShape(h);
    assert.equal(h.version, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(h.version, PACKAGE_VERSION);
    assert.equal(h.commit, null, 'start() without build');
    assert.equal((await health(built)).commit, 'ac7a0b1c45c8');
    const t = Date.parse(h.startedAt);
    assert.ok(t <= Date.now() && Date.now() - t < 60_000);
    const later = await health(plain);
    assert.equal(later.startedAt, h.startedAt, 'startedAt is fixed for the run');
    assert.ok(later.uptimeMs >= h.uptimeMs);
  } finally {
    await plain.close();
    await built.close();
  }
  // a commit is a hex sha or null: anything else (a path, text) is refused before the server listens
  for (const build of [{ commit: root }, { commit: 'not a sha' }, { commit: 12345 }, 'ac7a0b1c45c8', ['ac7a0b1c45c8']]) {
    await assert.rejects(start({ ...FAST, root, build }), RangeError, JSON.stringify(build));
  }
  const nullCommit = await start({ ...FAST, root, build: { commit: null } });
  try {
    assert.equal((await health(nullCommit)).commit, null);
  } finally {
    await nullCommit.close();
  }
});

test('runners: one entry per enabled adapter in agents order; a late adapter appears once it turns on', async () => {
  const parent = await tmp();
  const codexRoot = path.join(parent, 'codex');
  const grokRoot = path.join(parent, 'grok');
  await fs.mkdir(codexRoot);
  const adapters = {
    'claude-code': ADAPTERS['claude-code'],
    codex: fakeAdapter({ id: 'codex', files: () => [] }),
    grok: fakeAdapter({ id: 'grok', files: () => [] }),
  };
  const app = await start({ ...FAST, root: parent, roots: { codex: codexRoot, grok: grokRoot }, adapters });
  try {
    await app.ready;
    const h = await health(app);
    assert.deepEqual(h.agents, ['claude-code', 'codex']);
    assert.deepEqual(Object.keys(h.runners), h.agents);
    assertHealthShape(h);
    await fs.mkdir(grokRoot);
    await until(async () => (await health(app)).agents.includes('grok'), 3000);
    const on = await health(app);
    assert.deepEqual(Object.keys(on.runners), ['claude-code', 'codex', 'grok']);
    await until(async () => (await health(app)).runners.grok.lastScanAt !== null, 3000);
    assertHealthShape(await health(app));
    await assertNoPath(JSON.stringify(await health(app)), parent, [codexRoot, grokRoot]);
  } finally {
    await app.close();
  }
});

test('scan time after ready; a coded scan error shows only its code and keeps the last scan time; a good scan clears it', async () => {
  const root = await tmp();
  let mode = 'ok';
  const scan = async () => {
    await sleep(30);
    if (mode === 'code') throw Object.assign(new Error(`EACCES: permission denied, scandir '${root}'`), { code: 'EACCES' });
    if (mode === 'text') throw new Error(`cannot list ${root}`); // no code: the message carries the path
    if (mode === 'capped') throw Object.assign(new Error(`codex scan cap reached (days) under ${root}`), { code: 'SCAN_CAPPED' });
    if (mode === 'bad code') throw Object.assign(new Error('odd'), { code: `scan of ${root}` }); // a code that is not one
    return [];
  };
  const logs = [];
  const app = await start({ ...FAST, root, deps: { scan }, log: (m) => logs.push(m) });
  try {
    await app.ready;
    const first = claude(await health(app));
    assert.ok(Number.isInteger(first.lastScanMs) && first.lastScanMs >= 20, `lastScanMs ${first.lastScanMs}`);
    assert.ok(Date.parse(first.lastScanAt) <= Date.now());
    assert.equal(first.scanErr, null);
    mode = 'code';
    await until(async () => claude(await health(app)).scanErr === 'EACCES', 3000);
    const failing = await health(app);
    await sleep(200); // several failing rescans
    const still = await health(app);
    assert.equal(claude(still).scanErr, 'EACCES');
    assert.deepEqual([claude(still).lastScanMs, claude(still).lastScanAt], [claude(failing).lastScanMs, claude(failing).lastScanAt]);
    assert.equal(still.loopErrors, 0, 'a failed scan is not a loop error');
    await assertNoPath(JSON.stringify(still), root, ['permission denied']);
    mode = 'text';
    await until(async () => claude(await health(app)).scanErr === 'EUNKNOWN', 3000);
    await assertNoPath(JSON.stringify(await health(app)), root, ['cannot list']);
    // the adapters' own scan cap (contract 4.4, 4.5, 4.6) shows as its code, not as an unknown error
    mode = 'capped';
    await until(async () => claude(await health(app)).scanErr === 'SCAN_CAPPED', 3000);
    assertHealthShape(await health(app));
    await assertNoPath(JSON.stringify(await health(app)), root, ['scan cap reached']);
    mode = 'bad code';
    await until(async () => claude(await health(app)).scanErr === 'EUNKNOWN', 3000);
    await assertNoPath(JSON.stringify(await health(app)), root, ['scan of']);
    mode = 'ok';
    await until(async () => claude(await health(app)).scanErr === null, 3000);
    const back = claude(await health(app));
    assert.ok(Date.parse(back.lastScanAt) > Date.parse(claude(still).lastScanAt));
    assert.deepEqual(logs.filter((l) => l === 'scan failed: EACCES' || l === 'scan recovered'), ['scan failed: EACCES', 'scan recovered']);
    assert.ok(logs.includes('scan failed: SCAN_CAPPED'));
  } finally {
    await app.close();
  }
});

test('lastScanMs is measured on a monotonic clock: a wall clock step back during a scan gives no negative time', async () => {
  const root = await tmp();
  const realNow = Date.now;
  let shift = 0;
  let armed = false;
  const scan = async () => {
    await sleep(20);
    if (armed) {
      shift = -3_600_000; // the wall clock steps back one hour while the scan awaits (NTP, sleep and wake)
      armed = false;
    }
    return [];
  };
  Date.now = () => realNow() + shift;
  const app = await start({ ...FAST, root, deps: { scan } });
  try {
    await app.ready;
    armed = true;
    await until(() => !armed, 3000); // the Runner stores the scan time right after scan() returns, before this check
    shift = 0;
    const r = claude(await health(app));
    assert.ok(Number.isInteger(r.lastScanMs) && r.lastScanMs >= 0 && r.lastScanMs < 60_000, `lastScanMs ${r.lastScanMs}`);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});

test('a garbage line counts badLines 1, in the sum and in its runner; nothing of the transcript is in the body', async () => {
  const { root } = await claudeRoot('{not json at all\n');
  const app = await start({ ...FAST, root, agents: ['claude-code'] });
  try {
    await app.ready;
    await until(async () => (await health(app)).sessions === 1, 3000);
    const h = await health(app);
    assert.deepEqual([h.files, h.badLines, claude(h).badLines, claude(h).applyErrors, h.linkErrors], [1, 1, 1, 0, 0]);
    assertHealthShape(h);
    await assertNoPath(JSON.stringify(h), root, ['-work-healthz', '/work/healthz', 'Healthz demo']);
  } finally {
    await app.close();
  }
});

test('a loop that throws on every tick: loopErrors counts each one, the log has one line per distinct error', async () => {
  const root = await tmp();
  let value = null; // null: refs.filter throws a TypeError; 42: another TypeError; []: the tick succeeds
  let fails = 0;
  let oks = 0;
  const scan = async () => {
    if (Array.isArray(value)) oks += 1;
    else fails += 1;
    return value;
  };
  const logs = [];
  const app = await start({ ...FAST, root, rescanMs: 20, deps: { scan }, log: (m) => logs.push(m) });
  try {
    await app.ready;
    await until(() => fails >= 5, 3000);
    value = 42;
    await until(() => fails >= 10, 3000);
    value = [];
    await until(() => oks >= 2, 3000); // ticks never overlap: every failing tick has ended
    const h = await health(app);
    assert.equal(h.loopErrors, fails);
    assert.equal(claude(h).loopErrors, fails);
    assert.ok(Number.isInteger(claude(h).lastScanMs), 'the scan call itself completed');
    const lines = logs.filter((l) => l.includes('loop failed'));
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.ok(lines.every((l) => l.startsWith('rescan loop failed: ')));
    assert.notEqual(lines[0], lines[1]);
    assertHealthShape(h);
  } finally {
    await app.close();
  }
});

test('link failures: every one counted, at most 20 logged', async () => {
  const { root, file, b } = await claudeRoot();
  const logs = [];
  const app = await start({ ...FAST, root, agents: ['claude-code'], log: (m) => logs.push(m) });
  try {
    await app.ready;
    await until(async () => (await health(app)).sessions === 1, 3000);
    app.store.observe = () => { throw new Error('invented link failure'); };
    const recs = Array.from({ length: 25 }, (_, i) => b.assistantText({ msgId: `msg_${i + 2}`, text: `step ${i}` }));
    await fs.appendFile(file, toJsonl(recs));
    await until(async () => (await health(app)).linkErrors === 25, 3000);
    const h = await health(app);
    assert.deepEqual([claude(h).linkErrors, h.applyErrors, h.badLines, h.loopErrors], [25, 0, 0, 0]);
    assert.equal(logs.filter((l) => l.startsWith('link failed in ')).length, 20);
    assert.ok(!JSON.stringify(h).includes('invented link failure'), 'no message text in the body');
    await assertNoPath(JSON.stringify(h), root);
  } finally {
    await app.close();
  }
});

test('--auth: /healthz without the cookie is still 401 with the old body', async () => {
  const app = await start({ ...FAST, root: await tmp(), auth: true });
  try {
    const r = await request(app.port, { path: '/healthz' });
    assert.equal(r.status, 401);
    assert.equal(r.body, 'unauthorized: open the URL printed by office-sim\n');
  } finally {
    await app.close();
  }
});

// Runs a bin under a temp HOME on port 0 with a temp Claude root, reads /healthz once, stops it with SIGTERM.
async function runBin(bin, root, env = {}) {
  const child = spawn(process.execPath, [bin, '--port', '0', '--agents', 'claude-code', '--claude-root', root, '--rescan', '200'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root, ...env } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const url = await until(() => /^office-sim: http:\/\/127\.0\.0\.1:(\d+)\/\noffice-sim: agents .*\n/.exec(out), 5000);
    const body = JSON.parse((await request(Number(url[1]), { path: '/healthz' })).body);
    return { body, url: url[0] };
  } finally {
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(out, /^office-sim: http:\/\/127\.0\.0\.1:\d+\/\noffice-sim: agents claude-code\noffice-sim: stopping\n$/, 'stdout lines as before');
  }
}

// git without the caller's GIT_* variables, user config, hooks or signing (for the checkout's sha and the test's temp repos)
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
function git(cwd, args, home = cwd) {
  return execFileSync('git', ['-c', 'user.name=office-sim-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}
function checkoutSha() {
  try {
    return git(REPO, ['rev-parse', '--short=12', 'HEAD'], os.tmpdir());
  } catch {
    return null; // no git here: the bin reports null too
  }
}

test('bin: commit is the checkout short sha (null when git cannot tell), version from package.json; stdout unchanged', async () => {
  const expected = checkoutSha();
  const root = await tmp();
  const { body } = await runBin(BIN, root);
  assertHealthShape(body);
  assert.equal(body.commit, expected);
  assert.equal(body.version, PACKAGE_VERSION);
  await assertNoPath(JSON.stringify(body), root, [REPO]);
  // the same bin copied outside any git checkout (src linked back): commit null, the server still starts
  const base = await tmp('office-sim-healthz-copy-');
  await fs.mkdir(path.join(base, 'bin'));
  await fs.copyFile(BIN, path.join(base, 'bin', 'office-sim.mjs'));
  await fs.symlink(fileURLToPath(new URL('../src', import.meta.url)), path.join(base, 'src'));
  const copy = await runBin(path.join(base, 'bin', 'office-sim.mjs'), await tmp());
  assert.equal(copy.body.commit, null);
  assert.equal(copy.body.version, PACKAGE_VERSION);
});

test('bin: a copy inside another git repository, or an inherited GIT_DIR, never shows that repository\'s commit', async (t) => {
  const outer = await tmp('office-sim-healthz-outer-');
  let outerSha;
  try {
    git(outer, ['init', '-q']);
    git(outer, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'outer']);
    outerSha = git(outer, ['rev-parse', '--short=12', 'HEAD']);
  } catch {
    t.skip('git is not available');
    return;
  }
  // an unpacked (not cloned) copy vendored in the other repository: not a checkout of its own, so null
  const base = path.join(outer, 'vendor', 'office-sim');
  await fs.mkdir(path.join(base, 'bin'), { recursive: true });
  await fs.copyFile(BIN, path.join(base, 'bin', 'office-sim.mjs'));
  await fs.symlink(fileURLToPath(new URL('../src', import.meta.url)), path.join(base, 'src'));
  const nested = await runBin(path.join(base, 'bin', 'office-sim.mjs'), await tmp());
  assert.equal(nested.body.commit, null, `the enclosing repository's ${outerSha}`);
  // the checkout's own bin started with the other repository's GIT_DIR (say from its git hook): still its own sha
  const hooked = await runBin(BIN, await tmp(), { GIT_DIR: path.join(outer, '.git'), GIT_WORK_TREE: outer });
  assert.notEqual(hooked.body.commit, outerSha);
  assert.equal(hooked.body.commit, checkoutSha());
});
