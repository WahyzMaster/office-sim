// Regression tests for review findings in SessionState: R29 mid-message false ends and silent turn reopen.
// Synthetic records only (test/fixtures/records.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, SUB_UNFINISHED_IDLE_MS } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const SID = '66666666-6666-4666-8666-666666666666';
const AGENT = 'a0000000000000c0d';

function harness(kind = 'main') {
  const clock = { t: Date.UTC(2026, 0, 1, 1, 0, 0) };
  const sub = kind !== 'main';
  const b = createRecordBuilder({ sessionId: SID, cwd: '/tmp/office-sim-fixture/repo', agentId: sub ? AGENT : null });
  const s = new SessionState({ id: sub ? AGENT : SID, file: '/tmp/office-sim-fixture/x.jsonl', kind, stem: sub ? AGENT : SID, parentId: sub ? SID : null, now: () => clock.t });
  const feed = (recs) => recs.flatMap((r) => s.apply(r));
  return { s, b, clock, feed };
}
const brief = (evs) => evs.map((e) => (e.type === 'session_end' ? `session_end/${e.reason}` : e.type));
const turnEnds = (evs) => evs.filter((e) => e.type === 'turn_end').map((e) => e.reason);

// ---- R29: no session_end while the current API message is unfinished ---------------------------------

test('R29 text line with stop_reason null, 16 s quiet, then the same message\'s tool_use: no end, no resurrect', () => {
  for (const kind of ['sub', 'wf']) {
    const { b, s, clock, feed } = harness(kind);
    feed([b.subagentPrompt(), b.assistantText({ msgId: 'm1', text: 'I will write the file now.' })]);
    assert.deepEqual(s.idle(clock.t + 16_000), [], kind);
    clock.t += 32_000;
    const evs = feed([b.assistantToolUse({ msgId: 'm1', id: 'toolu_w', name: 'Write', input: { file_path: '/tmp/x.md', content: 'x' } })]);
    assert.deepEqual(brief(evs), ['tool_start'], kind);
    assert.equal(s.ended, false);
  }
});

test('R29 thinking line, 121 s quiet, then the same message\'s tool_use: no idle end', () => {
  const { b, s, clock, feed } = harness('wf');
  feed([b.subagentPrompt(), b.assistantThinking({ msgId: 'm1', text: 'Plan the output.' })]);
  assert.deepEqual(s.idle(clock.t + 121_000), []);
  clock.t += 300_000;
  const evs = feed([b.assistantToolUse({ msgId: 'm1', id: 'toolu_so', name: 'StructuredOutput', input: { summary: 'x' } })]);
  assert.deepEqual(brief(evs), ['tool_start']);
});

test('R29 final text with end_turn / stop_sequence / refusal ends after 15 s', () => {
  for (const stopReason of ['end_turn', 'stop_sequence', 'refusal']) {
    const { b, s, clock, feed } = harness('sub');
    feed([b.subagentPrompt(), b.assistantText({ msgId: 'm1', text: 'Final report.', stopReason })]);
    assert.deepEqual(s.idle(clock.t + 14_999), [], stopReason);
    assert.deepEqual(brief(s.idle(clock.t + 15_000)), ['session_end/done'], stopReason);
  }
});

test('R29 text with stop_reason null at EOF only ends after the unfinished-message limit', () => {
  const { b, s, clock, feed } = harness('sub');
  feed([b.subagentPrompt(), b.assistantText({ msgId: 'm1', text: 'Halfway there.' })]);
  assert.deepEqual(s.idle(clock.t + 15_000), []);
  assert.deepEqual(s.idle(clock.t + 120_000), []);
  assert.deepEqual(s.idle(clock.t + SUB_UNFINISHED_IDLE_MS - 1), []);
  assert.deepEqual(brief(s.idle(clock.t + SUB_UNFINISHED_IDLE_MS)), ['session_end/idle']);
});

test('R29 a tool_result clears the unfinished flag: plain 120 s idle rule applies again', () => {
  const { b, s, clock, feed } = harness('sub');
  feed([b.subagentPrompt(), b.bashUse({ msgId: 'm1', id: 't1' }), b.bashResult({ toolUseId: 't1' })]);
  assert.deepEqual(s.idle(clock.t + 119_999), []);
  assert.deepEqual(brief(s.idle(clock.t + 120_000)), ['session_end/idle']);
});

// ---- R30/R32: assistant work under a known promptId silently reopens a closed turn ---------------------

test('compact-summary-first main: work after the summary ends with stop_hook', () => {
  const { b, feed } = harness();
  const evs = feed([b.compactBoundary(), b.compactSummary({ promptId: 'PC' }), b.bashUse({ msgId: 'm1', id: 't1' }),
    b.bashResult({ toolUseId: 't1' }), b.assistantText({ msgId: 'm2', text: 'Done.', stopReason: 'end_turn' }), b.stopHookSummary()]);
  assert.deepEqual(turnEnds(evs), ['stop_hook']);
});

test('compact-summary-first main with no stop hook ends through the end_turn fallback', () => {
  const { b, s, clock, feed } = harness();
  feed([b.compactBoundary(), b.compactSummary({ promptId: 'PC' }), b.bashUse({ msgId: 'm1', id: 't1' }),
    b.bashResult({ toolUseId: 't1' }), b.assistantText({ msgId: 'm2', text: 'Done.', stopReason: 'end_turn' })]);
  assert.deepEqual(turnEnds(s.idle(clock.t + 20_000)), ['end_turn']);
});

test('work after a stop_hook-closed turn under the same promptId gets its own turn_end', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt({ promptId: 'P1' }), b.assistantText({ msgId: 'm1', text: 'First.', stopReason: 'end_turn' }),
    b.stopHookSummary(), b.metaUser({ promptId: 'P1' }), b.bashUse({ msgId: 'm2', id: 't1' }), b.bashResult({ toolUseId: 't1' }),
    b.assistantText({ msgId: 'm3', text: 'Second.', stopReason: 'end_turn' }), b.stopHookSummary()]);
  assert.deepEqual(turnEnds(evs), ['stop_hook', 'stop_hook']);
});

test('a reused-promptId user record alone does not reopen the turn (no extra next_turn)', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt({ promptId: 'P1' }), b.assistantText({ msgId: 'm1', text: 'First.', stopReason: 'end_turn' }),
    b.stopHookSummary(), b.metaUser({ promptId: 'P1' }), b.humanPrompt({ promptId: 'P2' })]);
  assert.deepEqual(turnEnds(evs), ['stop_hook']);
});

test('a synthetic assistant line does not reopen a closed turn', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt({ promptId: 'P1' }), b.assistantText({ msgId: 'm1', text: 'First.', stopReason: 'end_turn' }),
    b.stopHookSummary(), b.syntheticNoResponse(), b.stopHookSummary()]);
  assert.deepEqual(turnEnds(evs), ['stop_hook']);
});
