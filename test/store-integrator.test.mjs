// Integrator regressions (review 2026-10-19): finding 16 on the attach/replay path and finding 4 through the real Store.
// Synthetic, invented records only (no file IO, never the real ~/.claude).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '16161616-2222-4333-8444-555555555555';
const A1 = 'a0000000000001601';
const ROOT = '/tmp-fake/projects/-proj-integ';
const MAIN = `${ROOT}/${SID}.jsonl`;
const SUB = (id) => `${ROOT}/${SID}/subagents/agent-${id}.jsonl`;
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
  const store = new Store({ ringSize: 200, now: () => 1_000_000 });
  const got = [];
  store.subscribe((item) => got.push(item.event));
  return { store, got };
}
const toolUse = (id, name = 'Agent') => ({
  type: 'assistant', uuid: `u-${id}`, sessionId: SID, timestamp: TS,
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: { description: 'look', prompt: 'SECRET' } }] },
});
const result = (toolUseId, toolUseResult, content = 'ok', block = {}) => ({
  type: 'user', uuid: `r-${toolUseId}`, sessionId: SID, timestamp: TS,
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...block }] }, toolUseResult,
});
// errored results carry a string toolUseResult: no agentId, no trailer (docs/research/jsonl-format.json)
const interrupted = (tu) => result(tu, 'Error: [Request interrupted by user for tool use]',
  [{ type: 'text', text: '[Request interrupted by user for tool use]' }], { is_error: true });
const openTool = { type: 'tool_start', sessionId: A1, ts: TS, toolUseId: 'toolu_open', tool: 'Bash', summary: 'node' };
const liveIds = (store) => new Set(store.snapshot().events.map((e) => e.sessionId));

// main replayed first (rescanOnce prepares mains before subs), the sub attaches afterwards
function replayMain(store, recs) {
  store.attachFile({ path: MAIN, kind: 'main' }, new FakeState(SID));
  for (const r of recs) store.observe(MAIN, r);
  store.announce(MAIN);
}

test('R29 restart: an errored sync Agent result replayed before its sub attaches keeps the sub hidden', () => {
  const { store, got } = mkStore();
  replayMain(store, [toolUse('toolu_ag'), interrupted('toolu_ag')]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1, [openTool]), { meta: { agentType: 'Explore', toolUseId: 'toolu_ag' } });
  const n = got.length;
  store.announce(SUB(A1));
  assert.equal(got.slice(n).length, 0, 'no session or tool_start for a sub the parent stopped waiting for');
  assert.equal(liveIds(store).has(A1), false);
  // control: a completed result in the same restart order hides the sub too
  const c = mkStore();
  replayMain(c.store, [toolUse('toolu_ag'), result('toolu_ag', { status: 'completed', agentId: A1 })]);
  c.store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1), { meta: { toolUseId: 'toolu_ag' } });
  c.store.announce(SUB(A1));
  assert.equal(liveIds(c.store).has(A1), false);
});

test('R29 restart: a sub resumed by SendMessage after the errored call stays live', () => {
  const { store } = mkStore();
  const text = JSON.stringify({ success: true, resumedAgentId: A1 });
  replayMain(store, [toolUse('toolu_ag'), interrupted('toolu_ag'), toolUse('toolu_sm', 'SendMessage'),
    result('toolu_sm', { success: true, resumedAgentId: A1 }, [{ type: 'text', text }])]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1, [openTool]), { meta: { toolUseId: 'toolu_ag' } });
  store.announce(SUB(A1));
  assert.ok(liveIds(store).has(A1), 'resumed sub is live');
});

test('R29 meta late: the errored result arrives before meta.json; setMeta ends the sub once', () => {
  const { store, got } = mkStore();
  replayMain(store, [toolUse('toolu_ag')]);
  store.attachFile({ path: SUB(A1), kind: 'sub' }, new FakeState(A1, [openTool]));
  store.announce(SUB(A1));
  assert.ok(liveIds(store).has(A1));
  store.observe(MAIN, interrupted('toolu_ag'));
  assert.ok(liveIds(store).has(A1), 'not resolvable yet');
  const n = got.length;
  store.setMeta(SUB(A1), { agentType: 'Explore', toolUseId: 'toolu_ag' });
  const ends = got.slice(n).filter((e) => e.type === 'session_end');
  assert.deepEqual(ends.map((e) => `${e.sessionId}/${e.reason}`), [`${A1}/done`]);
  assert.equal(liveIds(store).has(A1), false);
  store.setMeta(SUB(A1), { agentType: 'Explore', toolUseId: 'toolu_ag' });
  store.observe(MAIN, interrupted('toolu_ag'));
  assert.equal(got.slice(n).filter((e) => e.type === 'session_end').length, 1, 'ended once');
});

test('finding 4: a sub agentType and parentAgentId from meta are scrubbed through the real Store (live, snapshot, /state)', () => {
  const { store, got } = mkStore();
  const mb = createRecordBuilder({ sessionId: SID, cwd: '/work/demo' });
  const main = new SessionState({ id: SID, kind: 'main', stem: SID, now: () => Date.parse('2026-01-01T00:10:00Z') });
  store.attachFile({ path: MAIN, kind: 'main' }, main);
  for (const r of [mb.humanPrompt({ text: 'go' }), mb.assistantText({ msgId: 'm1', text: 'ok' })]) main.apply(r, { replay: true });
  store.announce(MAIN);
  const meta = {
    agentType: `victim.person@corp.example /Users/victim/XAGTDIR/t ${'q'.repeat(80)}`,
    parentAgentId: '../victim.person@corp.example/XPAR',
  };
  // wired the way server-runner.mjs prepare() wires them
  const ref = { path: SUB(A1), kind: 'sub' };
  const sub = new SessionState({ id: A1, kind: 'sub', stem: SID, parentId: store.parentFor(ref, meta), agentType: meta.agentType, subMeta: meta });
  store.attachFile(ref, sub, { meta });
  store.announce(SUB(A1));
  const sb = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: A1 });
  store.ingest(SUB(A1), sub.apply(sb.assistantText({ msgId: 's1', text: 'working' })));
  store.setMeta(SUB(A1), { ...meta });
  const subSessions = [...got, ...store.snapshot().events].filter((e) => e.type === 'session' && e.sessionId === A1);
  assert.ok(subSessions.length >= 1);
  for (const ev of subSessions) {
    const blob = JSON.stringify(ev);
    for (const leak of ['victim.person', 'XAGTDIR', 'XPAR', '/Users/']) assert.equal(blob.includes(leak), false, `leaked ${leak}: ${blob}`);
    assert.equal(ev.parentSessionId, SID, 'invalid parentAgentId falls back to the main session');
    assert.ok(Array.from(ev.agentType).length <= 60, ev.agentType);
    assert.ok(ev.agentType.startsWith('(email) t'), ev.agentType);
  }
  // a valid parentAgentId is still used
  assert.equal(store.parentFor({ path: SUB('a0000000000001602'), kind: 'sub' }, { parentAgentId: 'a0000000000001699' }), 'a0000000000001699');
});
