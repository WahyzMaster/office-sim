// P5a common end hint (contract 4.0.1): Store.endCharacter and the Runner that strips { hint: 'end', charId } items
// from apply()/idle() results and forwards them. Fake sessions and fake paths only; nothing is read from disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';

const MAIN = '/tmp-fake/end/main.jsonl';
const CHILD = '/tmp-fake/end/child.jsonl';
const ref = (p, kind, charId, extra = {}) => ({ path: p, agent: 'grok', kind, sid: 'grok-m', charId, ...extra });

function fake(id, { kind = 'main', extraSnapshot = [] } = {}) {
  return {
    id, ended: false, out: [], idleOut: [],
    apply() { return this.out.splice(0); },
    idle() { return this.idleOut.splice(0); },
    sessionEvent() {
      return { type: 'session', sessionId: id, ts: 'x', agent: 'grok', project: '/work/end', projectLabel: 'end', title: id,
        branch: null, worktree: null, isSubagent: kind !== 'main', parentSessionId: null };
    },
    snapshotEvents() { return [this.sessionEvent(), ...extraSnapshot]; },
  };
}

function setup({ clock = { t: 1_000_000 } } = {}) {
  const store = new Store({ ringSize: 100, now: () => clock.t });
  const main = fake('grok-m');
  const child = fake('grok-c', { kind: 'sub' });
  store.attachFile(ref(MAIN, 'main', 'grok-m'), main);
  store.attachFile(ref(CHILD, 'sub', 'grok-c', { parentId: 'grok-m' }), child);
  store.announce(MAIN);
  store.announce(CHILD);
  return { store, main, child, clock };
}
const ends = (store, id) => store.ring.filter((x) => x.event.type === 'session_end' && x.event.sessionId === id).map((x) => x.event);
const tool = (id, toolUseId) => ({ type: 'tool_start', sessionId: id, ts: 'x', toolUseId, tool: 't', summary: 's' });

// ---- Store.endCharacter -----------------------------------------------------------------------------------

test('endCharacter emits one session_end for a live character and is idempotent', () => {
  const { store } = setup();
  assert.equal(store.endCharacter('grok-c'), true);
  assert.equal(store.endCharacter('grok-c'), false);
  assert.equal(store.endCharacter('grok-c', 'idle'), false);
  const got = ends(store, 'grok-c');
  assert.equal(got.length, 1);
  assert.equal(got[0].reason, 'done');
  assert.equal(got[0].ts, new Date(1_000_000).toISOString());
  assert.ok(!store.snapshot().events.some((e) => e.sessionId === 'grok-c'), 'the ended character leaves the snapshot');
  assert.ok(store.snapshot().events.some((e) => e.sessionId === 'grok-m'));
});

test('endCharacter: unknown ids, non-strings, not-yet-announced and already ended characters are no-ops', () => {
  const { store } = setup();
  const before = store.seq;
  for (const id of ['nobody', '', null, undefined, 42, {}]) assert.equal(store.endCharacter(id), false);
  store.attachFile(ref('/tmp-fake/end/late.jsonl', 'sub', 'grok-late', { parentId: 'grok-m' }), fake('grok-late', { kind: 'sub' }));
  assert.equal(store.endCharacter('grok-late'), false, 'not announced yet');
  store.ingest(CHILD, [{ type: 'session_end', sessionId: 'grok-c', ts: 'x', reason: 'idle' }]); // ended by its own file
  const seq = store.seq;
  assert.equal(store.endCharacter('grok-c'), false, 'already ended');
  assert.equal(store.seq, seq);
  assert.equal(before + 1, seq, 'only the ingested session_end was pushed');
  store.announce('/tmp-fake/end/late.jsonl');
  assert.ok(store.snapshot().events.some((e) => e.sessionId === 'grok-late'), 'the earlier no-op left it to announce normally');
});

test('endCharacter: reason idle is kept, anything else becomes done; it works for any adapter, Claude index untouched', () => {
  const { store } = setup();
  store.endCharacter('grok-c', 'idle');
  store.endCharacter('grok-m', 'weird');
  assert.deepEqual([ends(store, 'grok-c')[0].reason, ends(store, 'grok-m')[0].reason], ['idle', 'done']);
  const SID = '5e5e5e5e-1111-4222-8333-444455556666';
  const A = 'a0000000000005e01';
  const claudeSub = `/tmp-fake/projects/-p/${SID}/subagents/agent-${A}.jsonl`;
  const claude = fake(A, { kind: 'sub' });
  store.attachFile({ path: claudeSub, kind: 'sub' }, claude, { meta: { agentType: 'Explore' } });
  store.announce(claudeSub);
  assert.equal(store.endCharacter(A), true);
  assert.equal(store.index(SID).doneAgents.has(A), false, 'the common rule does not write the Claude done index');
  assert.equal(ends(store, A).length, 1);
});

test('endCharacter: tail lines of the ended character inside the grace window are dropped, later work revives it', () => {
  const { store, clock } = setup();
  store.endCharacter('grok-c');
  clock.t += 1000;
  assert.equal(store.ingest(CHILD, [tool('grok-c', 'late')]), 0, 'a late tail line within 5 s is dropped');
  clock.t += 6000;
  store.ingest(CHILD, [tool('grok-c', 'again')]);
  const tail = store.ring.slice(-2).map((x) => `${x.event.type}:${x.event.sessionId}`);
  assert.deepEqual(tail, ['session:grok-c', 'tool_start:grok-c'], 're-announced before its new work');
  assert.ok(store.snapshot().events.some((e) => e.sessionId === 'grok-c'));
  assert.equal(store.endCharacter('grok-c'), true, 'live again, so it can end again');
});

test('hint items never become events: ingest drops them (without ending anyone) and snapshot skips them', () => {
  const clock = { t: 1_000_000 };
  const store = new Store({ ringSize: 100, now: () => clock.t });
  const main = fake('grok-m', { extraSnapshot: [{ hint: 'end', charId: 'grok-c' }] });
  store.attachFile(ref(MAIN, 'main', 'grok-m'), main);
  store.attachFile(ref(CHILD, 'sub', 'grok-c', { parentId: 'grok-m' }), fake('grok-c', { kind: 'sub' }));
  store.announce(MAIN);
  store.announce(CHILD);
  assert.equal(store.ingest(MAIN, [{ hint: 'end', charId: 'grok-c' }]), 0);
  assert.equal(ends(store, 'grok-c').length, 0, 'ingest is not the forwarding path: the Runner is');
  assert.ok(!store.ring.some((x) => 'hint' in x.event));
  assert.ok(!store.snapshot().events.some((e) => 'hint' in e));
});

// ---- Runner: strip and forward -------------------------------------------------------------------------------

function runnerWith(store, files) {
  class NullTailer { forget() {} }
  const r = new Runner({ opts: { intervalMs: 50, rescanMs: 1000, idleMs: 1000, activeMinutes: 30, root: '/tmp-fake' },
    deps: { agent: 'grok', Tailer: NullTailer, scan: async () => [] }, store, log: () => {} });
  for (const [p, state, kind] of files) r.files.set(p, { ref: { path: p }, state, charId: state.id, kind, ready: true });
  return r;
}

test('Runner.onLine: hints are stripped from apply() and forwarded in array order; live events still flow', () => {
  const { store, main } = setup();
  const r = runnerWith(store, [[MAIN, main, 'main']]);
  const f = r.files.get(MAIN);
  const start = store.seq;
  main.out = [tool('grok-m', 'g1'), { hint: 'end', charId: 'grok-c' }, { hint: 'other', charId: 'grok-m' }, tool('grok-m', 'g2')];
  r.onLine(f, JSON.stringify({ k: 'x' }), false);
  const got = store.ring.filter((x) => x.seq > start).map((x) => `${x.event.type}:${x.event.sessionId}`);
  assert.deepEqual(got, ['tool_start:grok-m', 'session_end:grok-c', 'tool_start:grok-m'], 'unknown hint kinds are dropped too');
  assert.ok(!store.ring.some((x) => 'hint' in x.event));
});

test('Runner: replayed lines ingest nothing but still forward hints; idle() and publish() hints are forwarded', () => {
  const { store, main, child } = setup();
  const r = runnerWith(store, [[MAIN, main, 'main'], [CHILD, child, 'sub']]);
  const f = r.files.get(MAIN);
  const start = store.seq;
  main.out = [tool('grok-m', 'replayed'), { hint: 'end', charId: 'grok-c', reason: 'idle' }];
  r.onLine(f, JSON.stringify({ k: 'x' }), true);
  let got = store.ring.filter((x) => x.seq > start).map((x) => `${x.event.type}:${x.event.sessionId}:${x.event.reason ?? ''}`);
  assert.deepEqual(got, ['session_end:grok-c:idle']);

  // idle(): a later hint for a live character + an ordinary event
  const third = fake('grok-t', { kind: 'sub' });
  const T = '/tmp-fake/end/third.jsonl';
  store.attachFile(ref(T, 'sub', 'grok-t', { parentId: 'grok-m' }), third);
  store.announce(T);
  const s2 = store.seq;
  main.idleOut = [{ hint: 'end', charId: 'grok-t' }, tool('grok-m', 'from-idle')];
  r.idleAll();
  got = store.ring.filter((x) => x.seq > s2).map((x) => `${x.event.type}:${x.event.sessionId}`);
  assert.deepEqual(got, ['session_end:grok-t', 'tool_start:grok-m']);

  // publish(): the file's own idle events are discarded (not announced yet), hints about others go through
  const fourth = fake('grok-4', { kind: 'sub' });
  const F4 = '/tmp-fake/end/fourth.jsonl';
  store.attachFile(ref(F4, 'sub', 'grok-4', { parentId: 'grok-m' }), fourth);
  store.announce(F4);
  const fresh = fake('grok-n');
  const N = '/tmp-fake/end/new.jsonl';
  store.attachFile(ref(N, 'main', 'grok-n', { sid: 'grok-n' }), fresh);
  r.files.set(N, { ref: { path: N }, state: fresh, charId: 'grok-n', kind: 'main', ready: false });
  fresh.idleOut = [tool('grok-n', 'own-idle'), { hint: 'end', charId: 'grok-4' }];
  const s3 = store.seq;
  r.publish(r.files.get(N));
  got = store.ring.filter((x) => x.seq > s3).map((x) => `${x.event.type}:${x.event.sessionId}`);
  assert.equal(got[0], 'session_end:grok-4');
  assert.ok(!got.includes('tool_start:grok-n'), 'its own idle events were state-only');
  assert.ok(!store.ring.some((x) => 'hint' in x.event));
});

test('Runner.stamp: a ref without agent gets deps.agent; an existing agent is kept', () => {
  const store = new Store();
  const r = runnerWith(store, []);
  assert.equal(r.stamp({ path: '/a' }).agent, 'grok');
  assert.equal(r.stamp({ path: '/a', agent: '' }).agent, 'grok');
  assert.equal(r.stamp({ path: '/a', agent: 'codex' }).agent, 'codex');
  const bare = new Runner({ opts: {}, deps: { Tailer: class { forget() {} } }, store, log: () => {} });
  assert.equal(bare.stamp({ path: '/a' }).agent, undefined, 'no deps.agent: the Store falls back to claude-code');
});

test('Runner.prepare and retryMeta read sub meta / journal labels only when deps have the readers', async () => {
  const store = new Store();
  const made = [];
  class Recorder { constructor(o) { made.push(o); Object.assign(this, fake(o.id, { kind: o.kind })); } }
  class EmptyTailer { async readAll() { return { offset: 0 }; } forget() {} }
  const r = new Runner({ opts: { intervalMs: 50 }, deps: { agent: 'claude-code', SessionState: Recorder, Tailer: EmptyTailer, scan: async () => [] },
    store, log: () => {} });
  const SID = '5f5f5f5f-1111-4222-8333-444455556666';
  const wf = `/tmp-fake/projects/-p/${SID}/subagents/workflows/run1/agent-a0000000000005f01.jsonl`;
  const sub = `/tmp-fake/projects/-p/${SID}/subagents/agent-a0000000000005f02.jsonl`;
  assert.ok(await r.prepare({ path: wf, kind: 'wf' }));
  assert.ok(await r.prepare({ path: sub, kind: 'sub' }));
  assert.deepEqual(made.map((o) => [o.kind, o.subMeta, o.journalLabel, o.agent]), [['wf', null, null, 'claude-code'], ['sub', null, null, 'claude-code']]);
  assert.deepEqual(store.pendingMeta(), [sub], 'the Claude sub still waits for its meta.json');
  await r.retryMeta(); // no reader: nothing is called, nothing throws
  assert.equal(store.entry(sub).metaPending, true);
});
