// D1 floors with Codex (CONTRACT 4.0.1, 4.4): a Codex session and a Claude session in the same folder share a floor (the
// shared projectKey); a Codex-managed worktree <codex root>/worktrees/<id>/<name> joins an existing floor labelled <name>
// (the <id> is opaque), else gets its own floor, always with the <name> badge, and never moves afterwards; its subs follow
// their root main. The Codex Runner waits for the other Runners' first pass (the Grok floor-rule gate). The bin prints
// `office-sim: agents claude-code,codex,grok` in KNOWN_AGENTS order when all three default roots exist. Temp roots and
// invented content only; the real ~/.codex, ~/.grok and ~/.claude are never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start, FIRST_PASS_WAIT_MS } from '../src/server.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { codex, worktreeFloor } from '../src/adapters/codex/index.mjs';
import { Runner } from '../src/server-runner.mjs';
import { Store } from '../src/store.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { cid, charOf, writeRollout, codexTestAdapter } from './fixtures/codex-tree.mjs';
import { gid, groupOf, writeSession } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
// Deadline for waits on real work (scans, attaches, the bin's spawn and start): generous so a slow disk or a loaded
// machine does not fail them (4 s was not enough for four new rollouts at 100 ms per fs call); a regression still fails.
const WAIT_MS = 15_000;
// After SIGINT the bin force-exits within 3 s; a child still there after STOP_MS is stuck and gets SIGKILL.
const STOP_MS = 10_000;
// One /state round trip to the bin: an answer later than this counts as none, so a frozen child cannot hold until() forever.
const PROBE_MS = 2000;
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-codex-floor-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const CLAUDE_IDS = ['c1a0de00-2222-4222-8333-444455556661', 'c1a0de00-2222-4222-8333-444455556662', 'c1a0de00-2222-4222-8333-444455556663'];

// One invented Claude main transcript with that cwd (written aside and moved in, so a scan never sees half a file).
async function claudeSession(root, sid, cwd, text = 'Invented Claude prompt') {
  const dir = path.join(root, `-claude-${sid.slice(-4)}`);
  await fsp.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: sid, cwd, startMs: Date.now() - 4000, stepMs: 10 });
  const tmpFile = path.join(dir, `${sid}.tmp`);
  await fsp.writeFile(tmpFile, toJsonl([mb.humanPrompt({ text }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fsp.rename(tmpFile, path.join(dir, `${sid}.jsonl`));
}

const sessionsOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session');
const byId = (list, id) => list.find((e) => e.sessionId === id);
const floor = (e) => e && [e.project, e.projectLabel, e.worktree];

function startBoth(claudeRoot, codexRoot, extra = {}) {
  return start({ ...FAST, root: claudeRoot, roots: { codex: codexRoot }, adapters: { ...ADAPTERS, codex: codexTestAdapter() }, ...extra });
}

test('worktreeFloor: <root>/worktrees/<id>/<name>[/...] only; the floor to join is <name> (the id is opaque)', () => {
  const root = '/h/.codex';
  assert.deepEqual(worktreeFloor('/h/.codex/worktrees/a1b2/office-sim/src/x', root), { key: '/h/.codex/worktrees/a1b2/office-sim', names: ['office-sim'], badge: 'office-sim' });
  assert.deepEqual(worktreeFloor('/h/.codex/worktrees/a1b2/office-sim', `${root}/`), { key: '/h/.codex/worktrees/a1b2/office-sim', names: ['office-sim'], badge: 'office-sim' });
  for (const p of ['/h/.codex/worktrees/a1b2', '/h/.codex/worktrees/', '/h/.codex/worktreesX/a/b', '/work/repo/.worktrees/feat', '/h/.grok/worktrees/a/b', '', null]) {
    assert.equal(worktreeFloor(p, root), null, String(p));
  }
  assert.equal(worktreeFloor('/h/.codex/worktrees/a/b', ''), null);
});

test('same folder, same floor: a Codex session and a Claude session in one cwd share project; project-local .worktrees too', async () => {
  const claudeRoot = await tmp();
  const codexRoot = await tmp();
  await claudeSession(claudeRoot, CLAUDE_IDS[0], '/work/shared');
  await writeRollout(codexRoot, { id: cid(1), meta: { cwd: '/work/shared' }, items: [{ k: 'turn_start', id: 't1' }, { k: 'say', text: 'hello' }] });
  await writeRollout(codexRoot, { id: cid(2), meta: { cwd: '/work/shared/.worktrees/feat/src' } });
  const app = await startBoth(claudeRoot, codexRoot);
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['claude-code', 'codex']);
    await until(async () => (await sessionsOf(app)).length === 3, WAIT_MS);
    const s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, CLAUDE_IDS[0])), ['/work/shared', 'shared', null]);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/shared', 'shared', null]);
    assert.deepEqual(floor(byId(s, charOf(2))), ['/work/shared', 'shared', 'feat']);
    assert.deepEqual(s.map((e) => e.agent).sort(), ['claude-code', 'codex', 'codex']);
  } finally {
    await app.close();
  }
});

test('a Codex-made worktree joins the floor labelled <name>, else its own; badge <name>; subs follow; it never moves', async () => {
  const claudeRoot = await tmp();
  const codexRoot = await tmp();
  await fsp.mkdir(path.join(codexRoot, 'sessions'), { recursive: true });
  await claudeSession(claudeRoot, CLAUDE_IDS[0], '/work/repo-a');
  await claudeSession(claudeRoot, CLAUDE_IDS[1], '/elsewhere/fix-b');
  const wt = (id, name, sub = '') => path.join(codexRoot, 'worktrees', id, name, sub);
  const app = await startBoth(claudeRoot, codexRoot);
  let es = null;
  try {
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 2, WAIT_MS); // the Claude floors exist first
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', WAIT_MS);
    await writeRollout(codexRoot, { id: cid(1), meta: { cwd: wt('a1b2', 'repo-a', 'pkg') }, items: [{ k: 'turn_start', id: 't1' }] });
    await writeRollout(codexRoot, { id: cid(2), meta: { cwd: wt('a1b2', 'repo-a'), source: { parent: cid(1) } } });
    await writeRollout(codexRoot, { id: cid(3), meta: { cwd: wt('c3d4', 'fix-b') } });
    await writeRollout(codexRoot, { id: cid(4), meta: { cwd: wt('e5f6', 'lonely', 'deep') } });
    await until(async () => (await sessionsOf(app)).length === 6, WAIT_MS);
    let s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/repo-a', 'repo-a', 'repo-a']);
    assert.deepEqual([...floor(byId(s, charOf(2))), byId(s, charOf(2)).parentSessionId], ['/work/repo-a', 'repo-a', 'repo-a', charOf(1)]);
    assert.deepEqual(floor(byId(s, charOf(3))), ['/elsewhere/fix-b', 'fix-b', 'fix-b']);
    assert.deepEqual(floor(byId(s, charOf(4))), [wt('e5f6', 'lonely'), 'lonely', 'lonely']);
    // the live wire carried the same floors as /state (the choice is made once and kept)
    const live = (id) => es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === id).map((fr) => floor(fr.data));
    for (const id of [charOf(1), charOf(2), charOf(3), charOf(4)]) {
      assert.ok(live(id).length >= 1, `${id} announced live`);
      assert.ok(live(id).every((f) => JSON.stringify(f) === JSON.stringify(floor(byId(s, id)))), `${id} same floor live and in /state`);
    }
    // a matching floor that shows up later does not move the session (4.4: the first cwd decides)
    const mark = es.frames.length;
    await claudeSession(claudeRoot, CLAUDE_IDS[2], '/work/lonely');
    await until(async () => byId(await sessionsOf(app), CLAUDE_IDS[2]), WAIT_MS);
    await new Promise((r) => setTimeout(r, 200));
    s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(4))), [wt('e5f6', 'lonely'), 'lonely', 'lonely']);
    assert.ok(!es.frames.slice(mark).some((fr) => fr.data?.sessionId === charOf(4)), 'no event for the worktree session');
    assert.deepEqual(floor(byId(s, CLAUDE_IDS[0])), ['/work/repo-a', 'repo-a', null], 'Claude sessions are untouched by the rule');
  } finally {
    es?.close();
    await app.close();
  }
});

test('startup: a Codex worktree session already there at start joins its floor even when Claude attaches slower', async () => {
  const claudeRoot = await tmp();
  const codexRoot = await tmp();
  await claudeSession(claudeRoot, 'c1a0de00-2222-4222-8333-444455550001', '/work/aaa-one');
  await claudeSession(claudeRoot, 'c1a0de00-2222-4222-8333-444455550002', '/work/aaa-two');
  await claudeSession(claudeRoot, CLAUDE_IDS[2], '/work/office-demo');
  const wt = path.join(codexRoot, 'worktrees', '9f9f', 'office-demo');
  await writeRollout(codexRoot, { id: cid(1), meta: { cwd: wt }, items: [{ k: 'turn_start', id: 't1' }] });
  // Claude's first walk is slow (many files): the Codex Runner, rescanning every 60 ms, must still wait for it
  const { scan } = await import('../src/discover.mjs');
  const slowScan = async (root, o) => {
    await new Promise((r) => setTimeout(r, 400));
    return scan(root, o);
  };
  const app = await startBoth(claudeRoot, codexRoot, { deps: { scan: slowScan } });
  let es = null;
  try {
    es = await sse(app.port);
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 4, WAIT_MS);
    const s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/office-demo', 'office-demo', 'office-demo']);
    const live = es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1)).map((fr) => floor(fr.data));
    assert.ok(live.length >= 1 && live.every((f) => f[0] === '/work/office-demo'), JSON.stringify(live));
  } finally {
    es?.close();
    await app.close();
  }
});

test('startup, Codex only: a worktree main joins the floor of a plain Codex main of the same scan, whatever the uuid order', async () => {
  const LOW = '00000000-0000-7000-8000-000000000001';
  const HIGH = 'ffffffff-0000-7000-8000-000000000002';
  for (const [wtId, plainId] of [[LOW, HIGH], [HIGH, LOW]]) {
    const codexRoot = await tmp();
    const claudeRoot = await tmp();
    await writeRollout(codexRoot, { id: wtId, meta: { cwd: path.join(codexRoot, 'worktrees', 'a1b2', 'office-demo') } });
    await writeRollout(codexRoot, { id: plainId, meta: { cwd: '/work/office-demo' } });
    const app = await start({ ...FAST, root: claudeRoot, agents: ['codex'], roots: { codex: codexRoot }, adapters: { ...ADAPTERS, codex: codexTestAdapter() } });
    try {
      await app.ready;
      await until(async () => (await sessionsOf(app)).length === 2, WAIT_MS);
      const s = await sessionsOf(app);
      const order = wtId === LOW ? 'worktree uuid first' : 'worktree uuid last';
      assert.deepEqual(floor(byId(s, `codex-${wtId}`)), ['/work/office-demo', 'office-demo', 'office-demo'], order);
      assert.deepEqual(floor(byId(s, `codex-${plainId}`)), ['/work/office-demo', 'office-demo', null], order);
    } finally {
      await app.close();
    }
  }
});

test('the real Codex deps turn the floor rule (and so the first-pass gate) on; the rule is registered for codex only', async () => {
  const store = new Store();
  const deps = await codex.deps({ SessionState: class {}, Tailer: class {} });
  const runner = new Runner({ opts: { root: '/h/.codex', rescanMs: 1000, idleMs: 1000, intervalMs: 250, activeMinutes: 30 }, deps, store, log: () => {} });
  assert.equal(runner.floorRule, true);
  assert.equal(typeof runner.sidecars?.check, 'function', 'the titles watcher is the Runner\'s metadata watcher');
  assert.deepEqual([...store.floorRules.keys()], ['codex']);
  assert.deepEqual(store.floorRules.get('codex')('/h/.codex/worktrees/x/y/z'), { key: '/h/.codex/worktrees/x/y', names: ['y'], badge: 'y' });
  await runner.close();
});

test('bin: "office-sim: agents claude-code,codex,grok" when the three default roots exist (HOME is a temp dir)', async () => {
  const home = await tmp('office-sim-codex-home-');
  await claudeSession(path.join(home, '.claude', 'projects'), CLAUDE_IDS[0], '/work/bin');
  await writeRollout(path.join(home, '.codex'), { id: cid(1), meta: { cwd: '/work/bin' } });
  await writeSession(path.join(home, '.grok'), { group: groupOf('/work/bin'), id: gid(1), summary: { cwd: '/work/bin', title: 'Bin grok' } });
  const run = (args) => {
    const child = spawn(process.execPath, [BIN, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    return { child, exited: new Promise((r) => child.on('exit', (code) => r(code))), out: () => out, err: () => err };
  };
  // The bin's sessions, or null when it does not answer within PROBE_MS (the late request is left to stop()'s kill).
  const sessionsAt = async (port) => {
    let timer;
    const late = new Promise((res) => { timer = setTimeout(res, PROBE_MS, null); });
    try {
      const r = await Promise.race([request(port, { path: '/state' }), late]);
      return r && JSON.parse(r.body).events.filter((e) => e.type === 'session');
    } finally {
      clearTimeout(timer);
    }
  };
  // SIGINT, then the exit code (null when killed by a signal), or 'timeout' after SIGKILL when the child outlives STOP_MS.
  // Never throws and never waits unbounded; the body's probes are bounded too (PROBE_MS), so a frozen child fails at the
  // body's deadline, a failing body keeps its own error, and no server is left behind.
  const stop = async (r) => {
    r.child.kill('SIGINT');
    let timer;
    const late = new Promise((res) => { timer = setTimeout(() => res('timeout'), STOP_MS); });
    try {
      const code = await Promise.race([r.exited, late]);
      if (code === 'timeout') {
        r.child.kill('SIGKILL');
        await r.exited;
      }
      return code;
    } finally {
      clearTimeout(timer);
    }
  };
  const t0 = Date.now(); // before the spawn, so strictly before the bin's first-pass gate starts its fallback timer
  const all = run([]);
  let allCode;
  try {
    await until(() => all.out().includes('office-sim: agents'), WAIT_MS);
    assert.equal(all.out().split('\n')[1], 'office-sim: agents claude-code,codex,grok');
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(all.out())[1]);
    await until(async () => {
      const s = await sessionsAt(port);
      return s?.length === 3 && s.every((e) => e.project === '/work/bin');
    }, WAIT_MS);
    // The Codex and Grok Runners went after Claude's first pass, not at the gate's fallback. This bound must stay at or
    // below FIRST_PASS_WAIT_MS: WAIT_MS is longer, so a gate that only opens at its fallback would pass the wait above.
    const took = Date.now() - t0;
    assert.ok(took < FIRST_PASS_WAIT_MS, `three sessions after ${took} ms: the first-pass gate waited for its fallback`);
  } finally {
    allCode = await stop(all);
  }
  assert.equal(allCode, 0, all.err()); // only when the body passed (a failed wait above reports itself, not this)
  // --codex-root wins over the default; a missing one turns codex off with one log line, no path
  const off = run(['--codex-root', path.join(home, 'no-codex')]);
  let offCode;
  try {
    await until(() => off.out().includes('office-sim: agents'), WAIT_MS);
    assert.equal(off.out().split('\n')[1], 'office-sim: agents claude-code,grok');
    await until(() => off.err().includes('codex: root not found, adapter off'), WAIT_MS);
    assert.ok(!off.err().includes(home));
    // One answer before SIGINT: the bin installs its SIGINT handler just after the agents line, so a signal sent on that
    // line alone can meet the default action (exit by signal, code null) although the bin is correct.
    const offPort = Number(/127\.0\.0\.1:(\d+)/.exec(off.out())[1]);
    await until(() => sessionsAt(offPort), WAIT_MS);
  } finally {
    offCode = await stop(off);
  }
  assert.equal(offCode, 0, off.err());
});
