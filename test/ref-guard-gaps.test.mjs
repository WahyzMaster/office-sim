// Ref guard gaps G1-G3 (contract 4.0.1 F2):
// G1 the rejected-path memory never evicts: past 1000 remembered paths a new rejected path is still refused but not
//    logged or counted on its own (one 'too many' line, once); repeat scans add no log lines and no counts.
// G2 a non-Claude ref's sid must be an id of its own agent, and a main ref's sid must equal its charId, so a sub can
//    never take its parent or its floor from another agent's character.
// G3 a Runner with deps.agent stamps every ref with that agent and refuses a ref that claims another agent instead of
//    parsing it as that agent. Fake sessions, fake paths and temp roots only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { ADAPTERS } from '../src/adapters/index.mjs';
import { request, until } from './fixtures/sse.mjs';
import { FakeAgentSession, fakeAdapter, line } from './fixtures/fake-adapter.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '7d7d7d7d-1111-4222-8333-444455556666';
const INVALID = 'grok: rejected ref with invalid id';
const FOREIGN = 'grok: rejected ref with foreign agent';
const TOO_MANY = 'grok: too many rejected refs, further ones not logged';
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-gaps-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
const state = (id, kind = 'main', agent = 'grok') => new FakeAgentSession({ id, kind, agent });
const badRef = (i) => ({ path: `/fake/grok/bad-${i}.jsonl`, agent: 'grok', sid: `m${i}` }); // no grok- prefix

// ---- G1: no eviction, one overflow line, a lower-bound counter ---------------------------------------------------

test('G1: 1000 rejected paths are logged and counted once each; past the cap one overflow line, then silence', () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  for (let i = 0; i < 1000; i += 1) assert.equal(store.acceptsRef(badRef(i)), false);
  assert.equal(logs.length, 1000);
  assert.ok(logs.every((l) => l === INVALID));
  assert.deepEqual(store.stats(), { rejectedRefs: 1000 });

  assert.equal(store.acceptsRef(badRef(1000)), false, 'the 1001st path is still refused');
  assert.deepEqual(logs.slice(1000), [TOO_MANY], 'one overflow line, no per-path line');
  assert.equal(store.stats().rejectedRefs, 1000, 'the counter stops at the cap (a lower bound)');
  for (let i = 1001; i < 1200; i += 1) assert.equal(store.attachFile(badRef(i), state('x')), null);
  assert.equal(logs.length, 1001, 'further new paths add no line, the overflow line is logged once only');
  assert.equal(store.stats().rejectedRefs, 1000);

  // rescans of every path, remembered or not: no line, no count, nothing evicted (path 0 is still remembered)
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 1200; i += 1) assert.equal(store.acceptsRef(badRef(i)), false);
  }
  assert.equal(logs.length, 1001);
  assert.equal(store.stats().rejectedRefs, 1000);
  assert.equal(store.fileCount, 0);

  // a valid ref still attaches after the overflow
  assert.ok(store.attachFile({ path: '/fake/grok/ok.jsonl', agent: 'grok', sid: 'grok-ok' }, state('grok-ok')));
  assert.equal(logs.length, 1001);
});

test('G1: below the cap, repeat scans of the same paths add no line and no count (attachFile and rekey alike)', () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const from = '/fake/grok/a.jsonl';
  store.attachFile({ path: from, agent: 'grok', sid: 'grok-m1' }, state('grok-m1'));
  const bad = { path: '/fake/grok/b.jsonl', agent: 'grok', sid: 'grok-m1', charId: 'grok-m1', parentId: 'x y' };
  for (let i = 0; i < 5; i += 1) {
    store.attachFile(badRef(7), state('x'));
    store.rekey(from, bad);
  }
  assert.deepEqual(logs, [INVALID, INVALID]);
  assert.equal(store.stats().rejectedRefs, 2);
});

// ---- G2: sid must belong to the ref's own agent --------------------------------------------------------------------

test('G2: a non-Claude sid must fit <agent>- when present; a main ref\'s sid must equal its charId', () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const ok = [
    { path: '/fake/grok/m1.jsonl', agent: 'grok', sid: 'grok-m1' },
    { path: '/fake/grok/m2.jsonl', agent: 'grok', kind: 'main', sid: 'grok-m2', charId: 'grok-m2' },
    { path: '/fake/grok/m3.jsonl', agent: 'grok', sessionId: 'grok-m3' },
    { path: '/fake/grok/s1.jsonl', agent: 'grok', kind: 'sub', sid: 'grok-m1', charId: 'grok-s1' },
    { path: '/fake/grok/s2.jsonl', agent: 'grok', kind: 'sub', charId: 'grok-s2', parentId: 'grok-m1' },
  ];
  const bad = [
    { path: '/fake/grok/x1.jsonl', agent: 'grok', kind: 'sub', sid: 'codex-m1', charId: 'grok-x1' },
    { path: '/fake/grok/x2.jsonl', agent: 'grok', kind: 'sub', sid: 'codex-m1', charId: 'grok-x2', parentId: 'grok-m1' },
    { path: '/fake/grok/x3.jsonl', agent: 'grok', kind: 'sub', sid: SID, charId: 'grok-x3' },
    { path: '/fake/grok/x4.jsonl', agent: 'grok', kind: 'sub', sid: 'm1', charId: 'grok-x4' },
    { path: '/fake/grok/x5.jsonl', agent: 'grok', kind: 'sub', sid: '', charId: 'grok-x5' },
    { path: '/fake/grok/x6.jsonl', agent: 'grok', kind: 'sub', sessionId: 'codex-m1', charId: 'grok-x6' },
    { path: '/fake/grok/x7.jsonl', agent: 'grok', kind: 'main', sid: 'grok-m1', charId: 'grok-x7' },
    { path: '/fake/grok/x8.jsonl', agent: 'grok', kind: 'main', charId: 'grok-x8' },
    { path: '/fake/grok/x9.jsonl', agent: 'grok', kind: 'main', sid: 'codex-m9', charId: 'grok-x9' },
  ];
  for (const ref of ok) assert.ok(store.attachFile(ref, state(ref.charId ?? ref.sid ?? ref.sessionId, ref.kind)), ref.path);
  for (const ref of bad) {
    assert.equal(store.attachFile(ref, state(ref.charId, ref.kind)), null, `rejected ${ref.path}`);
    assert.equal(store.entry(ref.path), null);
  }
  assert.equal(store.fileCount, ok.length);
  assert.deepEqual(logs, Array(bad.length).fill(INVALID));
  assert.equal(store.stats().rejectedRefs, bad.length);
  assert.equal(store.parentFor(ok[3]), 'grok-m1');
  assert.equal(store.parentFor(ok[4]), 'grok-m1');
  // rekey onto a ref whose sid belongs to another agent is refused too
  assert.equal(store.rekey(ok[3].path, { ...ok[3], path: '/fake/grok/s1b.jsonl', sid: 'codex-m1' }), false);
  assert.ok(store.entry(ok[3].path));
});

test('G2: a grok sub naming a codex main as its sid gets neither that parent nor that floor', () => {
  const store = new Store();
  const codex = state('codex-m1', 'main', 'codex');
  codex.apply({ k: 'meta', cwd: '/work/codex-floor', title: 'C' });
  store.attachFile({ path: '/fake/codex/m1.jsonl', agent: 'codex', sid: 'codex-m1' }, codex);
  store.announce('/fake/codex/m1.jsonl');
  const sub = state('grok-c1', 'sub');
  sub.apply({ k: 'meta', cwd: '/work/grok-own', title: 'G' });
  const ref = { path: '/fake/grok/c1.jsonl', agent: 'grok', kind: 'sub', sid: 'codex-m1', charId: 'grok-c1', parentId: null };
  assert.equal(store.attachFile(ref, sub), null, 'refused');
  store.announce(ref.path);
  store.relinkAll();
  const all = [...store.ring.map((x) => x.event), ...store.snapshot().events];
  assert.ok(!all.some((e) => e.sessionId === 'grok-c1'), 'the grok sub never shows');
  assert.ok(!all.some((e) => e.parentSessionId === 'codex-m1'));
  assert.equal(sub.parentProject, null, 'no floor was handed to the grok session');
});

// ---- G3: the Runner's own agent wins -------------------------------------------------------------------------------

class EmptyTailer { async readAll() { return { offset: 0 }; } forget() {} }
function runner(store, agent, logs = []) {
  const made = [];
  class Recorder extends FakeAgentSession { constructor(o) { super(o); made.push(o); } }
  const deps = { SessionState: Recorder, Tailer: EmptyTailer, scan: async () => [] };
  if (agent) deps.agent = agent;
  const r = new Runner({ opts: { intervalMs: 50, rescanMs: 1000, idleMs: 1000, activeMinutes: 30, root: '/tmp-fake' },
    deps, store, log: (m) => logs.push(m) });
  return { r, made };
}

test('G3: Runner.prepare refuses a ref that claims another agent; no session object, one line, no path', async () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const { r, made } = runner(store, 'grok', logs);
  const spoofs = [
    { path: `/tmp-fake/projects/-p/${SID}.jsonl`, agent: 'claude-code' }, // would parse with the Claude path rules
    { path: '/tmp-fake/g/codex.jsonl', agent: 'codex', sid: 'codex-m1' },
  ];
  for (let i = 0; i < 3; i += 1) for (const ref of spoofs) assert.equal(await r.prepare({ ...ref }), null);
  assert.equal(made.length, 0, 'no session object for a spoofed ref');
  assert.equal(store.fileCount, 0);
  assert.equal(store.entry(spoofs[0].path), null);
  assert.deepEqual(logs, [FOREIGN, FOREIGN], 'one line per path, the Runner\'s own agent, no path');
  assert.equal(store.stats().rejectedRefs, 2);

  // its own refs: a missing or empty agent is stamped, the same agent is kept
  const own = [{ path: '/tmp-fake/g/a.jsonl', sid: 'grok-a' }, { path: '/tmp-fake/g/b.jsonl', agent: '', sid: 'grok-b' },
    { path: '/tmp-fake/g/c.jsonl', agent: 'grok', sid: 'grok-c' }];
  for (const ref of own) assert.ok(await r.prepare(ref));
  assert.deepEqual(own.map((ref) => store.entry(ref.path)?.agent), ['grok', 'grok', 'grok']);
  assert.deepEqual(made.map((o) => o.agent), ['grok', 'grok', 'grok']);
  assert.equal(logs.length, 2);
});

test('G3: a Runner without deps.agent keeps today\'s behaviour (the ref\'s agent, else claude-code)', async () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  const { r } = runner(store, null, logs);
  assert.ok(await r.prepare({ path: '/tmp-fake/c/codex.jsonl', agent: 'codex', sid: 'codex-m1' }));
  assert.ok(await r.prepare({ path: `/tmp-fake/projects/-p/${SID}.jsonl` }));
  assert.equal(store.entry('/tmp-fake/c/codex.jsonl').agent, 'codex');
  assert.equal(store.entry(`/tmp-fake/projects/-p/${SID}.jsonl`).agent, 'claude-code');
  assert.deepEqual([logs, store.stats()], [[], { rejectedRefs: 0 }]);
});

test('G3 server: refs claiming another agent are never parsed or read; one line per path across rescans', async () => {
  const root = await tmp();
  const body = line({ k: 'meta', cwd: '/work/gaps', title: 'T' }) + line({ k: 'tool', id: 't1', tool: 'read_file', summary: 'a.txt' });
  const claudeDir = path.join(root, '-p');
  await fs.mkdir(claudeDir);
  const p = (name) => path.join(root, name);
  const spoofClaude = path.join(claudeDir, `${SID}.jsonl`);
  for (const f of [p('main.jsonl'), p('codex.jsonl'), spoofClaude]) await fs.writeFile(f, body);
  const files = () => [
    { path: p('main.jsonl'), kind: 'main', sid: 'grok-m1', charId: 'grok-m1' },
    { path: p('codex.jsonl'), agent: 'codex', kind: 'main', sid: 'codex-m1', charId: 'codex-m1' },
    { path: spoofClaude, agent: 'claude-code' },
  ];
  let made = 0;
  const adapter = fakeAdapter({ id: 'grok', files });
  const counting = { ...adapter, async deps() {
    const deps = await adapter.deps();
    return { ...deps, SessionState: class extends deps.SessionState { constructor(o) { super(o); made += 1; } } };
  } };
  const logs = [];
  const app = await start({
    port: 0, root: path.join(root, 'no-claude'), roots: { grok: root }, adapters: { ...ADAPTERS, grok: counting },
    publicDir: PUBLIC, intervalMs: 50, rescanMs: 40, idleMs: 50, activeMinutes: 30, log: (m) => logs.push(m),
  });
  try {
    await app.ready;
    await until(() => app.stats().files === 1, 3000);
    await sleep(200); // several rescans
    assert.deepEqual(logs.filter((l) => l.includes('rejected')), [FOREIGN, FOREIGN]);
    assert.ok(logs.every((l) => !l.includes(root)), 'no path in any log line');
    assert.equal(app.stats().rejectedRefs, 2);
    assert.equal(made, 1, 'no session object is built for a spoofed ref, on any rescan');
    assert.equal(app.store.entry(spoofClaude), null);
    assert.equal(app.store.entry(p('codex.jsonl')), null);
    const st = JSON.parse((await request(app.port, { path: '/state' })).body);
    assert.deepEqual([...new Set(st.events.map((e) => e.sessionId))], ['grok-m1']);
    assert.ok(st.events.every((e) => e.type !== 'session' || e.agent === 'grok'));
  } finally {
    await app.close();
  }
});
