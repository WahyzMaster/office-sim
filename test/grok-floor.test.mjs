// D1 floors with Grok (CONTRACT 4.0.1, 4.4, 4.6): a Grok session and a Claude session in the same folder share a floor
// (the shared projectKey); a Grok-made worktree <grok root>/worktrees/<repo>/<name> joins an existing floor labelled
// <repo>, else <name>, else gets its own floor, always with the <name> badge, and never moves afterwards; its subs follow.
// Also the root rules: start() never falls back to a default adapter root (ADAPTERS 10), the bin does
// (`office-sim: agents claude-code,grok`). Temp roots and invented content only; the real ~/.grok and ~/.claude are never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { ADAPTERS, defaultRoots, selectAdapters } from '../src/adapters/index.mjs';
import { worktreeFloor } from '../src/adapters/grok/index.mjs';
import { pickFloor } from '../src/store-link.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, sse, until } from './fixtures/sse.mjs';
import { gid, charOf, groupOf, writeSession, grokTestAdapter } from './fixtures/grok-tree.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-grok-floor-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const CLAUDE_IDS = ['c1a0de00-1111-4222-8333-444455556661', 'c1a0de00-1111-4222-8333-444455556662', 'c1a0de00-1111-4222-8333-444455556663'];

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

function startBoth(claudeRoot, grokRoot, extra = {}) {
  return start({ ...FAST, root: claudeRoot, roots: { grok: grokRoot }, adapters: { ...ADAPTERS, grok: grokTestAdapter() }, ...extra });
}

test('worktreeFloor: <root>/worktrees/<repo>/<name>[/...] only; pickFloor tries <repo> before <name>', () => {
  const root = '/h/.grok';
  assert.deepEqual(worktreeFloor('/h/.grok/worktrees/repo/feat/pkg/x', root), { key: '/h/.grok/worktrees/repo/feat', names: ['repo', 'feat'], badge: 'feat' });
  assert.deepEqual(worktreeFloor('/h/.grok/worktrees/repo/feat', `${root}/`), { key: '/h/.grok/worktrees/repo/feat', names: ['repo', 'feat'], badge: 'feat' });
  for (const p of ['/h/.grok/worktrees/repo', '/h/.grok/worktrees/', '/h/.grok/worktreesX/a/b', '/work/repo/.worktrees/feat', '', null]) {
    assert.equal(worktreeFloor(p, root), null, String(p));
  }
  assert.equal(worktreeFloor('/h/.grok/worktrees/a/b', ''), null);
  const floors = [{ project: '/x/feat', projectLabel: 'feat' }, { project: '/y/repo', projectLabel: 'repo' }];
  assert.equal(pickFloor(['repo', 'feat'], floors), floors[1]);
  assert.equal(pickFloor(['nope', 'feat'], floors), floors[0]);
  assert.equal(pickFloor(['nope', ''], floors), null);
  assert.equal(pickFloor(null, floors), null);
});

test('same folder, same floor: a Grok session and a Claude session in one cwd share project; project-local .worktrees too', async () => {
  const claudeRoot = await tmp();
  const grokRoot = await tmp();
  await claudeSession(claudeRoot, CLAUDE_IDS[0], '/work/shared');
  await writeSession(grokRoot, { group: groupOf('/work/shared'), id: gid(1), summary: { cwd: '/work/shared', title: 'Grok in shared' },
    items: [{ k: 'turn_start', id: 'p1' }, { k: 'say', text: 'hello' }] });
  await writeSession(grokRoot, { group: groupOf('/work/shared/.worktrees/feat'), id: gid(2), summary: { cwd: '/work/shared/.worktrees/feat/src' } });
  const app = await startBoth(claudeRoot, grokRoot);
  try {
    await app.ready;
    assert.deepEqual(app.agents, ['claude-code', 'grok']);
    await until(async () => (await sessionsOf(app)).length === 3, 4000);
    const s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, CLAUDE_IDS[0])), ['/work/shared', 'shared', null]);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/shared', 'shared', null]);
    assert.deepEqual(floor(byId(s, charOf(2))), ['/work/shared', 'shared', 'feat']);
    assert.deepEqual(s.map((e) => e.agent).sort(), ['claude-code', 'grok', 'grok']);
  } finally {
    await app.close();
  }
});

test('a Grok-made worktree joins the floor labelled <repo>, else <name>, else its own; badge <name>; it never moves', async () => {
  const claudeRoot = await tmp();
  const grokRoot = await tmp();
  await fsp.mkdir(path.join(grokRoot, 'sessions'), { recursive: true });
  await claudeSession(claudeRoot, CLAUDE_IDS[0], '/work/repo-a');
  await claudeSession(claudeRoot, CLAUDE_IDS[1], '/elsewhere/fix-b');
  const wt = (repo, name, sub = '') => path.join(grokRoot, 'worktrees', repo, name, sub);
  const app = await startBoth(claudeRoot, grokRoot);
  let es = null;
  try {
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 2, 4000); // the Claude floors exist first
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await writeSession(grokRoot, { group: groupOf(wt('repo-a', 'feat-1', 'pkg')), id: gid(1), children: [gid(2)],
      summary: { cwd: wt('repo-a', 'feat-1', 'pkg'), title: 'Joins repo-a' }, items: [{ k: 'turn_start', id: 'p1' }] });
    await writeSession(grokRoot, { group: groupOf(wt('repo-a', 'feat-1')), id: gid(2), summary: { cwd: wt('repo-a', 'feat-1'), title: 'Its helper' } });
    await writeSession(grokRoot, { group: groupOf(wt('other', 'fix-b')), id: gid(3), summary: { cwd: wt('other', 'fix-b'), title: 'Joins by name' } });
    await writeSession(grokRoot, { group: groupOf(wt('lonely', 'try-3')), id: gid(4), summary: { cwd: wt('lonely', 'try-3', 'deep'), title: 'Own floor' } });
    // four new sessions: scan, summary.json and replay each, on many fs calls (about 4.3 s with every fs call 100 ms slower)
    await until(async () => (await sessionsOf(app)).length === 6, 15_000);
    let s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/repo-a', 'repo-a', 'feat-1']);
    assert.deepEqual([...floor(byId(s, charOf(2))), byId(s, charOf(2)).parentSessionId], ['/work/repo-a', 'repo-a', 'feat-1', charOf(1)]);
    assert.deepEqual(floor(byId(s, charOf(3))), ['/elsewhere/fix-b', 'fix-b', 'fix-b']);
    assert.deepEqual(floor(byId(s, charOf(4))), [wt('lonely', 'try-3'), 'try-3', 'try-3']);
    // the live wire carried the same floors as /state (the choice is made once and kept)
    const live = (id) => es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === id).map((fr) => floor(fr.data));
    for (const id of [charOf(1), charOf(2), charOf(3), charOf(4)]) {
      assert.ok(live(id).length >= 1, `${id} announced live`);
      assert.ok(live(id).every((f) => JSON.stringify(f) === JSON.stringify(floor(byId(s, id)))), `${id} same floor live and in /state`);
    }
    // a matching floor that shows up later does not move the session (4.4: the first cwd decides)
    const mark = es.frames.length;
    await claudeSession(claudeRoot, CLAUDE_IDS[2], '/work/lonely');
    await until(async () => byId(await sessionsOf(app), CLAUDE_IDS[2]), 4000);
    await new Promise((r) => setTimeout(r, 200));
    s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(4))), [wt('lonely', 'try-3'), 'try-3', 'try-3']);
    assert.ok(!es.frames.slice(mark).some((fr) => fr.data?.sessionId === charOf(4)), 'no event for the worktree session');
    // Claude sessions are untouched by the rule
    assert.deepEqual(floor(byId(s, CLAUDE_IDS[0])), ['/work/repo-a', 'repo-a', null]);
  } finally {
    es?.close();
    await app.close();
  }
});

test('startup: a Grok-made worktree already there at start joins its repo floor even when Claude attaches slower (finding 9)', async () => {
  const claudeRoot = await tmp();
  const grokRoot = await tmp();
  // other active Claude projects whose folders sort first, then the repo's main
  await claudeSession(claudeRoot, 'c1a0de00-1111-4222-8333-444455550001', '/work/aaa-one');
  await claudeSession(claudeRoot, 'c1a0de00-1111-4222-8333-444455550002', '/work/aaa-two');
  await claudeSession(claudeRoot, CLAUDE_IDS[2], '/work/office-demo');
  const wt = path.join(grokRoot, 'worktrees', 'office-demo', 'feat-x');
  await writeSession(grokRoot, { group: groupOf(wt), id: gid(1), summary: { cwd: wt, title: 'Grok in a worktree' }, items: [{ k: 'turn_start', id: 'p1' }] });
  // Claude's first walk is slow (many files): the Grok Runner, rescanning every 60 ms, must still wait for it
  const { scan } = await import('../src/discover.mjs');
  const slowScan = async (root, o) => {
    await new Promise((r) => setTimeout(r, 400));
    return scan(root, o);
  };
  const app = await startBoth(claudeRoot, grokRoot, { deps: { scan: slowScan } });
  let es = null;
  try {
    es = await sse(app.port);
    await app.ready;
    await until(async () => (await sessionsOf(app)).length === 4, 4000);
    const s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(1))), ['/work/office-demo', 'office-demo', 'feat-x']);
    const live = es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(1)).map((fr) => floor(fr.data));
    assert.ok(live.length >= 1 && live.every((f) => f[0] === '/work/office-demo'), JSON.stringify(live));
    assert.deepEqual(floor(byId(s, CLAUDE_IDS[2])), ['/work/office-demo', 'office-demo', null], 'Claude is untouched');
  } finally {
    es?.close();
    await app.close();
  }
});

test('RunnerGroup first rescan: a floor-rule Runner scans after the others, at most firstPassWaitMs later; then all together (finding 9)', async () => {
  const { RunnerGroup, FIRST_PASS_WAIT_MS } = await import('../src/server.mjs');
  assert.equal(FIRST_PASS_WAIT_MS, 10_000);
  const order = [];
  let release = null;
  const claude = { rescan: () => new Promise((r) => { release = () => { order.push('claude'); r('c'); }; }) };
  const grokR = { floorRule: true, gate: null, async rescan() { await this.gate; order.push('grok'); return 'g'; } };
  const g = new RunnerGroup([{ id: 'claude-code', runner: claude }, { id: 'grok', runner: grokR }]);
  const first = g.rescan();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(order, [], 'the Grok Runner waits for the first Claude pass');
  release();
  assert.deepEqual(await first, ['c', 'g'], 'results keep the Runner order');
  assert.deepEqual(order, ['claude', 'grok']);
  grokR.gate = null;
  claude.rescan = async () => { order.push('claude 2'); return 'c'; };
  assert.deepEqual(await g.rescan(), ['c', 'g']);
  // a first pass that never ends (a stalled mount) holds the Grok Runner for firstPassWaitMs only
  const stuck = { rescan: () => new Promise(() => {}) };
  const late = { floorRule: true, gate: null, at: 0, async rescan() { await this.gate; this.at = Date.now(); return 'g'; } };
  const g2 = new RunnerGroup([{ id: 'claude-code', runner: stuck }, { id: 'grok', runner: late }]);
  g2.firstPassWaitMs = 80;
  const t0 = Date.now();
  void g2.rescan();
  await until(() => late.at > 0, 2000);
  assert.ok(late.at - t0 >= 70, `waited ${late.at - t0} ms`);
});

test('Claude session events are the same with or without the Grok adapter running next to them (ts stripped)', async () => {
  const claudeRoot = await tmp();
  const grokRoot = await tmp();
  await claudeSession(claudeRoot, CLAUDE_IDS[0], '/work/same');
  await writeSession(grokRoot, { group: groupOf('/work/same'), id: gid(1), summary: { cwd: '/work/same', title: 'Neighbour' } });
  const strip = (list) => list.filter((e) => e.agent === 'claude-code').map((e) => JSON.stringify({ ...e, ts: undefined }));
  const alone = await start({ ...FAST, root: claudeRoot });
  let a;
  try {
    await alone.ready;
    assert.deepEqual(alone.agents, ['claude-code'], 'no roots.grok: grok is not started');
    await until(async () => (await sessionsOf(alone)).length === 1, 4000);
    a = strip(await sessionsOf(alone));
  } finally {
    await alone.close();
  }
  const both = await startBoth(claudeRoot, grokRoot);
  try {
    await both.ready;
    await until(async () => (await sessionsOf(both)).length === 2, 4000);
    assert.deepEqual(strip(await sessionsOf(both)), a);
  } finally {
    await both.close();
  }
});

test('roots: start() never probes a default adapter root; defaultRoots() is what the bin passes', async () => {
  assert.deepEqual(defaultRoots(), { codex: '~/.codex', grok: '~/.grok', antigravity: '~/.gemini' });
  const probed = [];
  const probe = async (root, id) => { probed.push([id, root]); return 'ENOENT'; };
  const logs = [];
  const app = await start({ ...FAST, root: path.join(await tmp(), 'none'), probe, log: (m) => logs.push(m) });
  try {
    await app.ready;
    assert.deepEqual(app.agents, []);
    assert.deepEqual(probed.map((p) => p[0]), ['claude-code'], 'grok without a root is not probed');
    assert.deepEqual(logs, ['claude-code: root not found, adapter off']);
  } finally {
    await app.close();
  }
  const home = os.homedir();
  assert.ok(!probed.some(([, r]) => typeof r === 'string' && (r.startsWith(path.join(home, '.grok')) || r.startsWith(path.join(home, '.gemini')))));
  const sel = await selectAdapters({ agents: ['grok'], roots: {}, probe });
  assert.deepEqual([sel.enabled, sel.off, sel.notImplemented], [[], [], []]);
  const given = await selectAdapters({ agents: ['grok'], roots: { grok: '/tmp-fake/grok' }, probe: async () => null });
  assert.deepEqual(given.enabled.map((x) => [x.id, x.root]), [['grok', '/tmp-fake/grok']]);
});

test('bin: "office-sim: agents claude-code,grok" when both default roots exist (HOME is a temp dir)', async () => {
  const home = await tmp('office-sim-grok-home-');
  await claudeSession(path.join(home, '.claude', 'projects'), CLAUDE_IDS[0], '/work/bin');
  await writeSession(path.join(home, '.grok'), { group: groupOf('/work/bin'), id: gid(1), summary: { cwd: '/work/bin', title: 'Bin grok' } });
  const run = (args) => {
    const child = spawn(process.execPath, [BIN, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
    let out = '';
    let err = '';
    // a spawn that fails (ENOENT, or EAGAIN / EMFILE under load) emits 'error' and never 'exit': settle on it too,
    // with code null and the error in err()
    const exited = new Promise((r) => {
      child.on('exit', (code) => r(code));
      child.on('error', (e) => { err += `${e}\n`; r(null); });
    });
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    // SIGINT, then SIGKILL if the bin is still there after 10 s (its own force exit is 3 s): the wait always ends,
    // and a killed or never-started child gives code null, so the code-0 check fails instead of hanging
    const stop = () => {
      child.kill('SIGINT');
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      return exited.finally(() => clearTimeout(killer));
    };
    return { child, exited, stop, out: () => out, err: () => err };
  };
  const both = run([]);
  try {
    await until(() => both.out().includes('office-sim: agents'), 5000);
    assert.equal(both.out().split('\n')[1], 'office-sim: agents claude-code,grok');
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(both.out())[1]);
    await until(async () => (JSON.parse((await request(port, { path: '/state' })).body).events.filter((e) => e.type === 'session').length === 2), 5000);
  } finally {
    assert.equal(await both.stop(), 0, both.err());
  }
  // --grok-root wins over the default; a missing one turns grok off with one log line, no path
  const off = run(['--grok-root', path.join(home, 'no-grok')]);
  try {
    await until(() => off.out().includes('office-sim: agents'), 5000);
    assert.equal(off.out().split('\n')[1], 'office-sim: agents claude-code');
    await until(() => off.err().includes('grok: root not found, adapter off'), 5000);
    assert.ok(!off.err().includes(home));
  } finally {
    assert.equal(await off.stop(), 0, off.err());
  }
});
