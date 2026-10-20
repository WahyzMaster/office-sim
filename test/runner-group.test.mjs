// P5a RunnerGroup (contract 4.0.1, 6): one Runner per enabled adapter on one Store; summed counters, forwarded loop
// controls, and a server that still starts (empty office) when the Claude root is missing or unreadable.
// Temp roots and fake runners only; the real ~/.claude is never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, RunnerGroup } from '../src/server.mjs';
import { Runner } from '../src/server-runner.mjs';
import { Store } from '../src/store.mjs';
import { request } from './fixtures/sse.mjs';
import { writeReplayFixture } from './fixtures/replay-fixture.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const CLAUDE_ONLY = { 'claude-code': claudeCode };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-group-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function fakeRunner({ files = 0, badLines = 0, skipped = 0, applyErrors = 0, closeFails = false } = {}) {
  const calls = [];
  return {
    calls,
    files: new Map(Array.from({ length: files }, (_, i) => [`/f${i}`, {}])),
    badLines, applyErrors, tailer: { skippedLines: skipped },
    startLoops() { calls.push('startLoops'); },
    async rescan() { calls.push('rescan'); return true; },
    setInterval(ms) { calls.push(`setInterval:${ms}`); },
    async close() {
      await new Promise((r) => setTimeout(r, 20));
      calls.push('close');
      if (closeFails) throw new Error('close failed');
    },
  };
}

// ---- unit ---------------------------------------------------------------------------------------------------

test('RunnerGroup sums files, badLines, skippedLines and applyErrors over its Runners', () => {
  const a = fakeRunner({ files: 2, badLines: 1, skipped: 3, applyErrors: 0 });
  const b = fakeRunner({ files: 5, badLines: 4, skipped: 0, applyErrors: 2 });
  const noTailer = { ...fakeRunner({ files: 1 }), tailer: undefined };
  const g = new RunnerGroup([{ id: 'claude-code', runner: a }, { id: 'grok', runner: b }, { id: 'codex', runner: noTailer }]);
  assert.deepEqual(g.ids, ['claude-code', 'grok', 'codex']);
  assert.deepEqual(g.runners, [a, b, noTailer]);
  assert.equal(g.fileCount, 8);
  assert.deepEqual(g.stats(), { files: 8, badLines: 5, skippedLines: 3, applyErrors: 2 });
});

test('RunnerGroup forwards startLoops, rescan, setInterval and close to every Runner; close waits for all', async () => {
  const a = fakeRunner();
  const b = fakeRunner({ closeFails: true });
  const c = fakeRunner();
  const g = new RunnerGroup([{ id: 'claude-code', runner: a }, { id: 'grok', runner: b }, { id: 'codex', runner: c }]);
  g.startLoops();
  assert.deepEqual(await g.rescan(), [true, true, true]);
  g.setInterval(120);
  await g.close(); // one Runner failing to close does not stop the others or reject
  for (const r of [a, b, c]) assert.deepEqual(r.calls, ['startLoops', 'rescan', 'setInterval:120', 'close']);
});

test('an empty RunnerGroup is an empty office: zero counters, rescan and close resolve', async () => {
  const g = new RunnerGroup([]);
  assert.deepEqual(g.ids, []);
  assert.deepEqual(g.stats(), { files: 0, badLines: 0, skippedLines: 0, applyErrors: 0 });
  g.startLoops();
  g.setInterval(100);
  assert.deepEqual(await g.rescan(), []);
  await g.close();
});

test('RunnerGroup.setInterval brings the pending poll of every Runner earlier (each Runner has its own opts copy)', async () => {
  const store = new Store();
  const base = { intervalMs: 5000, rescanMs: 60_000, idleMs: 60_000, activeMinutes: 30, root: '/tmp-fake' };
  class NullTailer { async poll() { return { bytes: 0 }; } forget() {} }
  const deps = { Tailer: NullTailer, scan: async () => [] };
  const runners = ['claude-code', 'grok'].map((id) => ({ id, runner: new Runner({ opts: { ...base }, deps: { ...deps, agent: id }, store, log: () => {} }) }));
  const g = new RunnerGroup(runners);
  g.startLoops();
  try {
    const before = runners.map(({ runner }) => runner.pollDue);
    g.setInterval(100);
    runners.forEach(({ runner }, i) => {
      assert.equal(runner.opts.intervalMs, 100);
      assert.ok(runner.pollDue < before[i] - 1000, `runner ${i} rescheduled its poll`);
    });
    assert.equal(base.intervalMs, 5000, 'the shared base options are not mutated');
  } finally {
    await g.close();
  }
});

// ---- server -----------------------------------------------------------------------------------------------------

test('server with a missing Claude root starts, serves / and /healthz with agents [] and an empty /state', async () => {
  const parent = await tmp();
  const missing = path.join(parent, 'no-such-projects');
  const logs = [];
  const app = await start({ port: 0, root: missing, publicDir: PUBLIC, rescanMs: 100, log: (m) => logs.push(m) });
  try {
    await app.ready;
    assert.deepEqual([app.agents, app.notImplemented], [[], []]);
    const page = await request(app.port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<!doctype html>/);
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.deepEqual(health, { ok: true, files: 0, sessions: 0, clients: 0, agents: [] });
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.deepEqual(st.events, []);
    assert.deepEqual(app.stats(), { files: 0, badLines: 0, skippedLines: 0, applyErrors: 0, rejectedRefs: 0 });
    assert.deepEqual(logs, ['claude-code: root not found, adapter off'], 'one log line, no path in it');
    // the root showing up later switches the adapter on (F1, test/late-root.test.mjs); this one stays empty
    await fs.mkdir(missing);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(JSON.parse((await request(app.port, { path: '/healthz' })).body).files, 0);
  } finally {
    await app.close();
  }
});

test('server with an unreadable Claude root (a file) logs once and serves an empty office', async () => {
  const parent = await tmp();
  const file = path.join(parent, 'projects');
  await fs.writeFile(file, 'not a directory');
  const logs = [];
  const app = await start({ port: 0, root: file, publicDir: PUBLIC, log: (m) => logs.push(m) });
  try {
    await app.ready;
    assert.deepEqual(app.agents, []);
    assert.deepEqual(logs, ['claude-code: root not readable (ENOTDIR), adapter off']);
    assert.deepEqual(JSON.parse((await request(app.port, { path: '/healthz' })).body).agents, []);
  } finally {
    await app.close();
  }
});

test('server agents option: narrows the enabled set and reports requested ids that are not implemented', async () => {
  const root = await tmp();
  const both = await start({ port: 0, root, publicDir: PUBLIC, agents: ['claude-code', 'antigravity'] });
  try {
    // antigravity is implemented since P5e but has no root here: skipped, not reported
    assert.deepEqual([both.agents, both.notImplemented], [['claude-code'], []]);
  } finally {
    await both.close();
  }
  // a requested id that is not implemented is reported: a registry without antigravity (as before P5e)
  const older = await start({ port: 0, root, publicDir: PUBLIC, agents: ['claude-code', 'antigravity'], adapters: CLAUDE_ONLY });
  try {
    assert.deepEqual([older.agents, older.notImplemented], [['claude-code'], ['antigravity']]);
  } finally {
    await older.close();
  }
  const codexOnly = await start({ port: 0, root, publicDir: PUBLIC, agents: ['codex', 'antigravity'] });
  try {
    await codexOnly.ready;
    // codex (P5d) and antigravity (P5e) are implemented but have no root here: skipped, not reported
    assert.deepEqual([codexOnly.agents, codexOnly.notImplemented], [[], []]);
    assert.deepEqual(JSON.parse((await request(codexOnly.port, { path: '/healthz' })).body).agents, []);
  } finally {
    await codexOnly.close();
  }
});

test('server rejects unknown agents and bad roots before listening', async () => {
  const root = await tmp();
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, agents: ['cursor'] }), { name: 'RangeError', message: /unknown agent "cursor"/ });
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, agents: 'claude-code' }), RangeError);
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, roots: { 'claude-code': root } }), /no root option for "claude-code"/);
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, roots: { cursor: root } }), RangeError);
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, roots: { codex: '' } }), /roots\.codex must be a directory path/);
  await assert.rejects(start({ port: 0, root, publicDir: PUBLIC, roots: ['x'] }), RangeError);
});

test('server roots option: each implemented adapter runs on its own root (all four since P5e); a missing root is off', async () => {
  const root = await tmp();
  const app = await start({ port: 0, root, publicDir: PUBLIC, roots: { codex: path.join(root, 'nope'), grok: '~/x', antigravity: root } });
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['claude-code', 'antigravity'], 'antigravity (P5e) runs on its root; codex and grok roots are missing');
  } finally {
    await app.close();
  }
});

test('replay stays Claude-only (D12): agents claude-code whatever --agents says, unimplemented ids still reported', async () => {
  const dir = await tmp('office-sim-group-replay-');
  const { mainPath } = await writeReplayFixture(dir);
  const root = await tmp();
  const app = await start({ port: 0, root, publicDir: PUBLIC, replay: mainPath, speed: 1000, intervalMs: 50, agents: ['antigravity'] });
  try {
    await app.ready;
    // antigravity is implemented since P5e: not reported, and replay still runs claude-code only
    assert.deepEqual([app.agents, app.notImplemented], [['claude-code'], []]);
    assert.deepEqual(JSON.parse((await request(app.port, { path: '/healthz' })).body).agents, ['claude-code']);
  } finally {
    await app.close();
  }
  // a registry without antigravity (as before P5e): the requested id is still reported in replay
  const older = await start({ port: 0, root, publicDir: PUBLIC, replay: mainPath, speed: 1000, intervalMs: 50, agents: ['antigravity'], adapters: CLAUDE_ONLY });
  try {
    await older.ready;
    assert.deepEqual([older.agents, older.notImplemented], [['claude-code'], ['antigravity']]);
    assert.deepEqual(JSON.parse((await request(older.port, { path: '/healthz' })).body).agents, ['claude-code']);
  } finally {
    await older.close();
  }
});

test('replay reports notImplemented in KNOWN_AGENTS order, deduped, the same as live mode', async () => {
  const dir = await tmp('office-sim-group-replay-');
  const { mainPath } = await writeReplayFixture(dir);
  const root = await tmp();
  for (const [agents, want] of [[['antigravity', 'codex', 'antigravity'], ['codex', 'antigravity']], [['antigravity', 'codex'], ['codex', 'antigravity']]]) {
    // a registry without codex (as before P5d), so two ids are unimplemented and their order shows
    const replay = await start({ port: 0, root, publicDir: PUBLIC, replay: mainPath, speed: 1000, intervalMs: 50, agents, adapters: CLAUDE_ONLY });
    try {
      assert.deepEqual(replay.notImplemented, want, `replay ${agents}`);
    } finally {
      await replay.close();
    }
    const live = await start({ port: 0, root, publicDir: PUBLIC, agents, adapters: CLAUDE_ONLY });
    try {
      assert.deepEqual(live.notImplemented, want, `live ${agents}`);
    } finally {
      await live.close();
    }
  }
});

test('Runner logs a failing scan once per error code, without the path, and one "scan recovered" line', async () => {
  const logs = [];
  const results = ['EACCES', 'EACCES', 'EACCES', 'EIO', 'EIO', null, null, 'EACCES'];
  const scan = async (root) => {
    const code = results.shift();
    if (code) throw Object.assign(new Error(`${code}: permission denied, scandir '${root}'`), { code });
    return [];
  };
  class NullTailer { async poll() { return { bytes: 0 }; } forget() {} }
  const opts = { intervalMs: 5000, rescanMs: 60_000, idleMs: 60_000, activeMinutes: 30, root: '/some/secret/root' };
  const runner = new Runner({ opts, deps: { Tailer: NullTailer, scan, agent: 'claude-code' }, store: new Store(), log: (m) => logs.push(m) });
  try {
    for (let i = 0; i < 8; i++) assert.equal(await runner.rescan(), true);
    assert.deepEqual(logs, ['scan failed: EACCES', 'scan failed: EIO', 'scan recovered', 'scan failed: EACCES']);
    assert.ok(logs.every((l) => !l.includes('/some/secret/root')), 'no path in scan log lines');
  } finally {
    await runner.close();
  }
});

test('a root probe that never answers times out: the server still listens and serves an empty office', async () => {
  const root = await tmp();
  const logs = [];
  const hung = () => new Promise(() => {}); // a stalled network or FUSE mount
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 2000); });
  const started = start({ port: 0, root, publicDir: PUBLIC, probe: hung, probeTimeoutMs: 50, log: (m) => logs.push(m) });
  const app = await Promise.race([started, deadline]);
  clearTimeout(timer);
  if (app === 'timeout') {
    started.then((a) => a.close(), () => {});
    assert.fail('start() did not resolve while the root probe hung');
  }
  try {
    await app.ready;
    assert.deepEqual([app.agents, app.notImplemented], [[], []]);
    assert.deepEqual(JSON.parse((await request(app.port, { path: '/healthz' })).body).agents, []);
    assert.deepEqual(logs, ['claude-code: root not readable (ETIMEDOUT), adapter off']);
  } finally {
    await app.close();
  }
});
