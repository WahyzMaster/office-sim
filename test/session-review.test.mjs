// Review regressions in SessionState (2026-10-19 findings 17, 19, 33). Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, END_TURN_IDLE_MS, SUB_FINAL_IDLE_MS } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '19191919-1717-4333-8333-333333333333';
const AGENT = 'a00000000000019aa';

function harness({ kind = 'main', startMs } = {}) {
  const clock = { t: Date.UTC(2026, 0, 1, 1, 0, 0) };
  const sub = kind !== 'main';
  const b = createRecordBuilder({ sessionId: SID, cwd: '/tmp/office-sim-fixture/repo', agentId: sub ? AGENT : null, startMs: startMs ?? clock.t });
  const s = new SessionState({ id: sub ? AGENT : SID, file: '/tmp/office-sim-fixture/x.jsonl', kind, stem: sub ? AGENT : SID, parentId: sub ? SID : null, now: () => clock.t });
  const feed = (recs, opt) => recs.flatMap((r) => s.apply(r, opt));
  return { s, b, clock, feed };
}
const plans = (evs) => evs.filter((e) => e.type === 'plan').map((e) => `${e.source}(${e.items.length})`);
const brief = (evs) => evs.map((e) => (e.type === 'session_end' ? `session_end/${e.reason}` : e.type));

// ---- 17: ExitPlanMode plan goes out before the blocking approval question ---------------------------------

test('R34 ExitPlanMode: the exit_plan plan precedes its tool_start live, in the same order as snapshotEvents()', () => {
  const { b, s, feed } = harness();
  feed([b.humanPrompt()]);
  const evs = feed([b.exitPlanUse({ msgId: 'm', id: 'x1', plan: '# Plan\n\n## Build the parser\n\n## Write tests\n' })]);
  const kinds = evs.filter((e) => e.type === 'plan' || e.type === 'tool_start').map((e) => e.type);
  assert.deepEqual(kinds, ['plan', 'tool_start'], 'the whiteboard is written before the ask');
  const snap = s.snapshotEvents().filter((e) => e.type === 'plan' || e.type === 'tool_start').map((e) => e.type);
  assert.deepEqual(snap, kinds, 'live order matches snapshot order');
});

// ---- 19: update_plan {items: []} gives the board back to the task list -------------------------------------

test('R36 update_plan cleared to no items shows the task list again (and it stays in the snapshot)', () => {
  const { b, s, feed } = harness();
  const reminder = () => b.taskReminder({ content: [{ id: '1', subject: 'Task one', status: 'pending' }] });
  const evs = feed([b.humanPrompt(), reminder(),
    b.updatePlanUse({ msgId: 'm1', id: 'up1', input: { items: [{ content: 'A', status: 'in_progress' }] } }),
    b.updatePlanResult({ toolUseId: 'up1', text: 'Plan shown (1 steps).' }),
    b.updatePlanUse({ msgId: 'm2', id: 'up2', input: { items: [] } }),
    b.updatePlanResult({ toolUseId: 'up2', text: 'Plan cleared.' }),
    reminder()]);
  assert.deepEqual(plans(evs), ['tasks(1)', 'update_plan(1)', 'update_plan(0)', 'tasks(1)']);
  assert.equal(evs.filter((e) => e.type === 'plan').at(-1).items[0].content, 'Task one');
  assert.deepEqual(plans(s.snapshotEvents()), ['tasks(1)']);
});

test('R36 update_plan cleared with no tasks emits no empty tasks plan', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(),
    b.updatePlanUse({ msgId: 'm1', id: 'up1', input: { items: [{ content: 'A', status: 'in_progress' }] } }),
    b.updatePlanResult({ toolUseId: 'up1', text: 'Plan shown (1 steps).' }),
    b.updatePlanUse({ msgId: 'm2', id: 'up2', input: { items: [] } }),
    b.updatePlanResult({ toolUseId: 'up2', text: 'Plan cleared.' })]);
  assert.deepEqual(plans(evs), ['update_plan(1)', 'update_plan(0)']);
});

// ---- 33: record timestamps ahead of the server clock must not freeze idle timers --------------------------

test('R29 a sub whose final text was replayed with timestamps 10 min ahead still ends after 15 s', () => {
  const clockStart = Date.UTC(2026, 0, 1, 1, 0, 0);
  const { b, s, clock, feed } = harness({ kind: 'sub', startMs: clockStart + 10 * 60_000 });
  feed([b.subagentPrompt(), b.assistantText({ msgId: 'm1', text: 'Final report.', stopReason: 'end_turn' })], { replay: true });
  assert.deepEqual(s.idle(clock.t), [], 'quiet starts now, not in the future');
  assert.deepEqual(brief(s.idle(clock.t + SUB_FINAL_IDLE_MS)), ['session_end/done']);
});

test('R30 a main end_turn replayed 10 min ahead of the clock still closes the turn after 20 s', () => {
  const clockStart = Date.UTC(2026, 0, 1, 1, 0, 0);
  const { b, s, clock, feed } = harness({ startMs: clockStart + 10 * 60_000 });
  feed([b.humanPrompt(), b.assistantText({ msgId: 'm1', text: 'All done.', stopReason: 'end_turn' })], { replay: true });
  assert.deepEqual(s.idle(clock.t), []);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS - 1), []);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS).map((e) => `${e.type}:${e.reason}`), ['turn_end:end_turn']);
});
