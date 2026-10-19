// Store + SessionState regressions: subagent task deltas (R36), relocation bookkeeping, snapshot/relink cost.
// In-memory synthetic records only (no file IO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '12121212-3434-4565-8787-909090909090';
const A1 = 'a0000000000000ab1';
const ROOT = '/tmp-fake/projects/-proj-demo';
const MAIN = `${ROOT}/${SID}.jsonl`;
const SUB = (id, root = ROOT) => `${root}/${SID}/subagents/agent-${id}.jsonl`;
const T = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function mainState(recs) {
  const s = new SessionState({ id: SID, file: MAIN, kind: 'main', stem: SID });
  for (const r of recs) s.apply(r, { replay: true });
  return s;
}
function mainRecs() {
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: Date.UTC(2026, 0, 1), stepMs: 1000 });
  const recs = [m.humanPrompt({ text: 'Invented tasks' }),
    m.taskCreateUse({ msgId: 'm1', id: 'c1', subject: 'Write module' }), m.taskCreateResult({ toolUseId: 'c1', taskId: '1', subject: 'Write module' }),
    m.taskCreateUse({ msgId: 'm2', id: 'c2', subject: 'Test module' }), m.taskCreateResult({ toolUseId: 'c2', taskId: '2', subject: 'Test module' })];
  return { m, recs }; // records at T(0)..T(4)
}
const update = (toolUseId, taskId, status, ts) => ({ ts, toolUseId, name: 'TaskUpdate', input: { taskId, status }, text: `Updated task #${taskId} status` });
const statuses = (evs) => evs.filter((e) => e.type === 'plan').map((e) => e.items.map((it) => it.status));
const planOf = (s) => statuses(s.snapshotEvents());

// ---- SessionState.applyExternalTask -----------------------------------------------------------------------

test('R36 a subagent TaskUpdate applies to the main task list and emits a plan event', () => {
  const s = mainState(mainRecs().recs);
  assert.deepEqual(planOf(s), [['pending', 'pending']]);
  assert.deepEqual(statuses(s.applyExternalTask(update('u1', '1', 'completed', T(10)))), [['completed', 'pending']]);
  assert.deepEqual(statuses(s.applyExternalTask(update('u1', '1', 'completed', T(10)))), [], 'same tool_use id applies once');
});

test('R36 a subagent delta older than the main task_reminder or a newer main update does not roll back', () => {
  const { m, recs } = mainRecs();
  m.tick(10_000);
  const s = mainState([...recs, m.taskReminder({ content: [{ id: '1', subject: 'Write module', status: 'in_progress' }, { id: '2', subject: 'Test module', status: 'pending' }] })]);
  assert.deepEqual(s.applyExternalTask(update('u1', '1', 'completed', T(6))), [], 'older than the reminder');
  const s2 = mainState([...recs, m.taskUpdateUse({ msgId: 'm3', id: 'mu', taskId: '2', status: 'completed' }), m.taskUpdateResult({ toolUseId: 'mu', taskId: '2' })]);
  assert.deepEqual(s2.applyExternalTask(update('u2', '2', 'in_progress', T(8))), [], 'older than the main update of #2');
  assert.deepEqual(statuses(s2.applyExternalTask(update('u3', '1', 'in_progress', T(30)))), [['in_progress', 'completed']]);
});

test('R36 an update_plan session ignores subagent task deltas on the whiteboard', () => {
  const { m, recs } = mainRecs();
  const s = mainState([...recs, m.updatePlanUse({ msgId: 'm9', id: 'up', input: { items: [{ content: 'Plan A', status: 'in_progress' }] } }),
    m.updatePlanResult({ toolUseId: 'up', text: 'Plan shown (1 steps).' })]);
  assert.deepEqual(s.applyExternalTask(update('u1', '1', 'completed', T(30))), []);
});

test('R36 Store buffers sub deltas until the main is announced, then applies them before the snapshot', () => {
  const store = new Store();
  const got = [];
  store.subscribe((x) => got.push(x.event));
  const sub = new SessionState({ id: A1, file: SUB(A1), kind: 'sub', stem: A1, parentId: SID });
  store.attachFile({ path: SUB(A1), kind: 'sub' }, sub);
  store.taskDeltas(SUB(A1), [update('u1', '1', 'completed', T(10))]);
  const main = mainState(mainRecs().recs);
  store.attachFile({ path: MAIN, kind: 'main' }, main);
  store.announce(MAIN);
  assert.deepEqual(statuses(store.snapshot().events), [['completed', 'pending']]);
  // Live delta after the announce goes out as a main plan event; a repeat of the same tool_use id does nothing.
  got.length = 0;
  store.taskDeltas(SUB(A1), [update('u2', '2', 'in_progress', T(20)), update('u1', '1', 'completed', T(10))]);
  assert.deepEqual(got.filter((e) => e.type === 'plan').map((e) => [e.sessionId, e.items.map((it) => it.status)]),
    [[SID, ['completed', 'in_progress']]]);
});

// ---- relocation bookkeeping -------------------------------------------------------------------------------

class FakeState {
  constructor(id) { this.id = id; }
  sessionEvent() {
    return { type: 'session', sessionId: this.id, ts: T(0), project: '/work/demo', projectLabel: 'demo', title: 't', branch: 'main',
      worktree: null, isSubagent: false, parentSessionId: null, agentType: null };
  }
  snapshotEvents() { return [this.sessionEvent()]; }
  get ended() { return false; }
}
const notification = (taskId) => ({ type: 'user', uuid: `n-${taskId}`, sessionId: SID, timestamp: T(5), origin: { kind: 'task-notification' },
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } });

test('a shown subagent moved to a new path and completed during the move gets session_end done on re-attach', () => {
  const store = new Store();
  const got = [];
  store.subscribe((x) => got.push(`${x.event.type}:${x.event.sessionId}${x.event.reason ? `/${x.event.reason}` : ''}`));
  const NEW = '/tmp-fake/projects/-proj-moved';
  store.attachFile({ path: MAIN, kind: 'main' }, new FakeState(SID));
  store.announce(MAIN);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1));
  store.announce(SUB(A1));
  store.detachFile(MAIN, { moved: true });
  store.detachFile(SUB(A1), { moved: true });
  got.length = 0;
  store.attachFile({ path: `${NEW}/${SID}.jsonl`, kind: 'main' }, new FakeState(SID));
  store.observe(`${NEW}/${SID}.jsonl`, notification(A1)); // replayed at the new path
  store.announce(`${NEW}/${SID}.jsonl`);
  store.attachFile({ path: SUB(A1, NEW), kind: 'sub' }, new FakeState(A1));
  store.announce(SUB(A1, NEW));
  assert.deepEqual(got.filter((x) => x.startsWith('session_end')), [`session_end:${A1}/done`]);
});

test('a shown subagent whose re-attach fails after a move gets session_end idle', () => {
  const store = new Store();
  const got = [];
  store.subscribe((x) => got.push(`${x.event.type}:${x.event.sessionId}${x.event.reason ? `/${x.event.reason}` : ''}`));
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1));
  store.announce(SUB(A1));
  store.detachFile(SUB(A1), { moved: true });
  store.attachFile({ path: SUB(A1, '/tmp-fake/projects/-x'), kind: 'sub' }, new FakeState(A1));
  store.detachFile(SUB(A1, '/tmp-fake/projects/-x')); // the new path vanished during its replay
  assert.deepEqual(got.filter((x) => x.startsWith('session_end')), [`session_end:${A1}/idle`]);
  assert.equal(store.movedShown.size, 0);
});

// ---- cost: snapshot ordering and relinkAll stay near linear ------------------------------------------------

test('snapshot() with thousands of live orphan subagents stays fast (no quadratic parent lookup)', () => {
  const store = new Store({ ringSize: 10 });
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const id = `a${i.toString(16).padStart(16, '0')}`;
    const p = SUB(id);
    store.attachFile({ path: p, kind: 'sub' }, new FakeState(id));
    store.byPath.get(p).announced = true; // live, parent main not attached (orphan)
  }
  const t0 = process.hrtime.bigint();
  const snap = store.snapshot();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(snap.events.length, N);
  assert.ok(ms < 800, `snapshot took ${ms.toFixed(0)} ms`);
});

test('relinkAll() does not rescan every file once per session', () => {
  const store = new Store({ ringSize: 10 });
  for (let i = 0; i < 300; i++) {
    const sid = `${i.toString(16).padStart(8, '0')}-3434-4565-8787-909090909090`;
    const root = `/tmp-fake/projects/-p${i}`;
    store.attachFile({ path: `${root}/${sid}.jsonl`, kind: 'main' }, new FakeState(sid));
    store.attachFile({ path: `${root}/${sid}/subagents/agent-a${i.toString(16).padStart(16, '0')}.jsonl`, kind: 'sub' },
      new FakeState(`a${i.toString(16).padStart(16, '0')}`));
  }
  const values = store.byPath.values.bind(store.byPath);
  let calls = 0;
  store.byPath.values = () => { calls += 1; return values(); };
  store.relinkAll();
  assert.ok(calls <= 1, `byPath scanned ${calls} times for 300 sessions`);
});
