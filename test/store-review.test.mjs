// Store review regressions (2026-10-19 findings 14, 16): resurrect bookkeeping and errored parent Agent calls.
// Fake SessionState + in-memory synthetic records only (no file IO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

const SID = '14141414-2222-4333-8444-555555555555';
const A1 = 'a0000000000001401';
const W1 = 'a00000000000014a1';
const W2 = 'a00000000000014a2';
const RUN = 'wf_14141414-abc';
const ROOT = '/tmp-fake/projects/-proj-review';
const MAIN = `${ROOT}/${SID}.jsonl`;
const SUB = (id) => `${ROOT}/${SID}/subagents/agent-${id}.jsonl`;
const WF = (id) => `${ROOT}/${SID}/subagents/workflows/${RUN}/agent-${id}.jsonl`;
const TS = '2026-10-19T01:02:03.000Z';

class FakeState {
  constructor(id, extra = []) { this.id = id; this.extra = extra; }
  sessionEvent() {
    return { type: 'session', sessionId: this.id, ts: TS, project: '/work/demo', projectLabel: 'demo', title: 't', branch: 'main',
      worktree: null, isSubagent: false, parentSessionId: null, agentType: null };
  }
  snapshotEvents() { return [this.sessionEvent(), ...this.extra]; }
  get ended() { return false; }
}

function mkStore() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = new Store({ ringSize: 100, now: clock.now });
  const got = [];
  store.subscribe((item) => got.push(item.event));
  const brief = (evs = got) => evs.map((e) => `${e.type}:${e.sessionId}${e.reason ? `/${e.reason}` : ''}`);
  return { store, got, clock, brief };
}
const toolUse = (id, name = 'Agent') => ({
  type: 'assistant', uuid: `u-${id}`, sessionId: SID, timestamp: TS,
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: { description: 'look', prompt: 'SECRET' } }] },
});
const result = (toolUseId, toolUseResult, content = 'ok', block = {}) => ({
  type: 'user', uuid: `r-${toolUseId}`, sessionId: SID, timestamp: TS,
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...block }] }, toolUseResult,
});
const notification = (taskId, toolUseId) => ({
  type: 'user', uuid: `n-${taskId}`, sessionId: SID, timestamp: TS, origin: { kind: 'task-notification' },
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ''}<status>completed</status>\n</task-notification>` },
});
const toolStart = (sessionId, toolUseId) => ({ type: 'tool_start', sessionId, ts: TS, toolUseId, tool: 'Read', summary: 'x.mjs' });
const live = (store) => new Set(store.snapshot().events.map((e) => e.sessionId));

function withMain(store, recs = []) {
  store.attachFile({ path: MAIN, kind: 'main' }, new FakeState(SID));
  for (const r of recs) store.observe(MAIN, r);
  store.announce(MAIN);
}

// ---- 14: a resurrected agent is live again in snapshot() ----------------------------------------------

test('R29 a sub that works again after its sync completion is back in snapshot() and can end again', () => {
  const { store, clock, brief, got } = mkStore();
  withMain(store, [toolUse('toolu_A1')]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1), { meta: { agentType: 'Explore', toolUseId: 'toolu_A1' } });
  store.announce(SUB(A1));
  store.observe(MAIN, result('toolu_A1', { status: 'completed', agentId: A1 }));
  assert.equal(live(store).has(A1), false);
  clock.advance(6000);
  store.ingest(SUB(A1), [toolStart(A1, 'toolu_e4')]);
  assert.ok(live(store).has(A1), 'resurrected sub is in the snapshot');
  assert.ok(store.snapshot().events.some((e) => e.sessionId === A1 && e.type === 'session'));
  assert.equal(store.isDone(store.entry(SUB(A1))), false);
  // a later completion of a new run ends it again
  const n = got.length;
  store.observe(MAIN, notification(A1));
  assert.deepEqual(brief(got.slice(n)), [`session_end:${A1}/done`]);
  assert.equal(live(store).has(A1), false);
});

test('R29 a wf agent that works again after its run notification is live, the rest of the run stays done', () => {
  const { store, clock } = mkStore();
  withMain(store, [toolUse('toolu_W', 'Workflow')]);
  store.observe(MAIN, result('toolu_W', { status: 'async_launched', taskType: 'local_workflow', taskId: 'tk1414141', runId: RUN }));
  for (const id of [W1, W2]) {
    store.attachFile({ path: WF(id), kind: 'wf' }, new FakeState(id), { meta: { agentType: 'workflow-subagent' } });
    store.announce(WF(id));
  }
  store.observe(MAIN, notification('tk1414141', 'toolu_W'));
  assert.deepEqual([...live(store)], [SID]);
  clock.advance(6000);
  store.ingest(WF(W1), [toolStart(W1, 'toolu_w9')]);
  assert.deepEqual([...live(store)].sort(), [SID, W1].sort(), 'only the agent that resumed is live');
});

test('R29 a nested SendMessage resume (no toolUseResult, JSON text) revives the agent without the grace drop', () => {
  const { store, brief, got } = mkStore();
  withMain(store, [toolUse('toolu_A1')]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1), { meta: { agentType: 'Explore', toolUseId: 'toolu_A1' } });
  store.announce(SUB(A1));
  store.observe(MAIN, result('toolu_A1', { status: 'completed', agentId: A1 }));
  store.observe(MAIN, toolUse('toolu_sm', 'SendMessage'));
  const text = JSON.stringify({ success: true, message: 'resumed', resumedAgentId: A1 });
  store.observe(MAIN, result('toolu_sm', undefined, [{ type: 'text', text }]));
  const n = got.length;
  store.ingest(SUB(A1), [toolStart(A1, 'toolu_r1')]); // inside the 5 s grace, but resumed explicitly
  assert.deepEqual(brief(got.slice(n)), [`session:${A1}`, `tool_start:${A1}`]);
  assert.ok(live(store).has(A1));
});

// ---- 16: an interrupted / errored sync Agent call ends its subagent --------------------------------------

test('R29 an is_error result for the sync Agent call ends its sub (open tool included), once', () => {
  const { store, brief, got } = mkStore();
  withMain(store, [toolUse('toolu_ag_H')]);
  const open = toolStart(A1, 'toolu_h2');
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1, [open]), { meta: { agentType: 'Explore', toolUseId: 'toolu_ag_H' } });
  store.announce(SUB(A1));
  assert.ok(store.snapshot().events.some((e) => e.toolUseId === 'toolu_h2'));
  const n = got.length;
  const interrupted = result('toolu_ag_H', 'Error: [Request interrupted by user for tool use]',
    [{ type: 'text', text: '[Request interrupted by user for tool use]' }], { is_error: true });
  store.observe(MAIN, interrupted);
  assert.deepEqual(brief(got.slice(n)), [`session_end:${A1}/done`]);
  assert.equal(live(store).has(A1), false);
  store.observe(MAIN, interrupted); // replayed again: no second end
  assert.equal(got.length, n + 1);
});

test('R29 an is_error Agent result with no subagent file does nothing; an async launch never ends the sub', () => {
  const { store, got } = mkStore();
  withMain(store, [toolUse('toolu_blocked'), toolUse('toolu_bg')]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1), { meta: { agentType: 'Explore', toolUseId: 'toolu_bg' } });
  store.announce(SUB(A1));
  const n = got.length;
  store.observe(MAIN, result('toolu_blocked', 'Error: blocked', 'blocked by auto mode', { is_error: true }));
  store.observe(MAIN, result('toolu_bg', { isAsync: true, status: 'async_launched', agentId: A1 }, 'Async agent launched successfully.'));
  assert.equal(got.slice(n).some((e) => e.type === 'session_end'), false);
  assert.ok(live(store).has(A1));
});
