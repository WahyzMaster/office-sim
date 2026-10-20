import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder, clone } from './fixtures/records.mjs';

const SID = '33333333-3333-4333-8333-333333333333';
const AGENT = 'a00000000000000aa';

function harness({ kind = 'main', ...o } = {}) {
  const clock = { t: Date.UTC(2026, 0, 1, 1, 0, 0) };
  const sub = kind !== 'main';
  const b = createRecordBuilder({ sessionId: SID, cwd: '/tmp/office-sim-fixture/repo', agentId: sub ? AGENT : null });
  const s = new SessionState({ id: sub ? AGENT : SID, file: '/tmp/office-sim-fixture/x.jsonl', kind, stem: sub ? AGENT : SID, parentId: sub ? SID : null, now: () => clock.t, ...o });
  const feed = (recs, opt) => recs.flatMap((r) => s.apply(r, opt));
  return { s, b, clock, feed };
}
const types = (evs) => evs.map((e) => e.type);
const of = (evs, type) => evs.filter((e) => e.type === type);
const ends = (evs) => of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok, e.errorKind]);

test('R7 replay mode emits nothing but builds the same state as live', () => {
  const recs = [];
  const { b } = harness();
  recs.push(b.humanPrompt({ text: 'start' }), b.bashUse({ msgId: 'msg_1', id: 'toolu_1' }), b.bashResult({ toolUseId: 'toolu_1' }),
    b.bashUse({ msgId: 'msg_2', id: 'toolu_2' }));
  const live = harness();
  const rep = harness();
  assert.ok(live.feed(recs).length > 0);
  assert.deepEqual(rep.feed(recs, { replay: true }), []);
  assert.deepEqual(rep.s.debugState(), live.s.debugState());
  // A result written after attach closes the tool opened during replay.
  const more = rep.feed([b.bashResult({ toolUseId: 'toolu_2' })]);
  assert.deepEqual(ends(more), [['toolu_2', true, undefined]]);
});

test('R9 resume re-append run of old uuids yields zero events', () => {
  const { b, feed } = harness();
  const recs = [b.customTitle('Demo'), b.humanPrompt({ text: 'first' }), b.assistantThinking({ msgId: 'msg_1', text: 'Think.' }),
    b.bashUse({ msgId: 'msg_1', id: 'toolu_1' }), b.bashResult({ toolUseId: 'toolu_1' }),
    b.assistantText({ msgId: 'msg_2', text: 'done', stopReason: 'end_turn' }), b.stopHookSummary()];
  assert.ok(feed(recs).length > 0);
  const reappend = [b.lastPrompt('first'), b.customTitle('Demo'), b.worktreeState(null), b.modeRecord(),
    ...recs.filter((r) => r.uuid).map((r) => clone(r, { cwd: '/tmp/office-sim-fixture/other', gitBranch: 'other', promptId: 'P-new' }))];
  assert.deepEqual(feed(reappend), []);
});

test('R9 a tool_use id is never opened twice', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt()]);
  const first = feed([b.bashUse({ msgId: 'msg_1', id: 'toolu_dup' })]);
  const again = feed([b.bashUse({ msgId: 'msg_1', id: 'toolu_dup' })]); // new uuid, same tool id
  assert.equal(of(first, 'tool_start').length, 1);
  assert.equal(of(again, 'tool_start').length, 0);
});

test('R10 fork history: other sessionId emits nothing, uuids still collected', () => {
  const { b, feed, s } = harness();
  const other = '44444444-4444-4444-8444-444444444444';
  const hist = [b.humanPrompt({ text: 'parent', sessionId: other }), b.bashUse({ msgId: 'msg_h', id: 'toolu_h', sessionId: other }),
    { ...b.customTitle('Parent title'), sessionId: other }];
  assert.deepEqual(of(feed(hist), 'tool_start'), []);
  assert.equal(s.title, SID.slice(0, 8));
  assert.equal(s.firstCwd, null);
  // The same uuid later under the own sessionId is a duplicate, not new activity.
  assert.deepEqual(feed([clone(hist[1], { sessionId: SID })]), []);
  const own = feed([b.humanPrompt({ text: 'own work' })]);
  assert.deepEqual(of(own, 'prompt').map((e) => e.text), ['own work']);
});

test('R12 file order is authoritative even when timestamps go backwards', () => {
  const { b, feed } = harness();
  const use = b.bashUse({ msgId: 'msg_1', id: 'toolu_1' });
  const res = b.bashResult({ toolUseId: 'toolu_1', ts: '2025-12-31T00:00:00.000Z' }); // earlier than the tool_use
  const evs = feed([b.humanPrompt(), use, res]);
  assert.deepEqual(types(evs).filter((t) => t.startsWith('tool')), ['tool_start', 'tool_end']);
  assert.equal(of(evs, 'tool_end')[0].ok, true);
});

test('R13 lines of one msgId stay one message across interleaved results', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.assistantThinking({ msgId: 'msg_A' }), b.bashUse({ msgId: 'msg_A', id: 'toolu_1' }),
    b.bashResult({ toolUseId: 'toolu_1' }), b.hookAttachment(), b.bashUse({ msgId: 'msg_A', id: 'toolu_2' }),
    b.bashResult({ toolUseId: 'toolu_2' })]);
  assert.deepEqual(ends(evs), [['toolu_1', true, undefined], ['toolu_2', true, undefined]]);
});

test('R14 say, thinking and tool_start come from assistant blocks', () => {
  const { b, feed } = harness();
  const use = b.assistantToolUse({ msgId: 'msg_1', id: 'toolu_r', name: 'Read', input: { file_path: '/tmp/office-sim-fixture/deep/notes.md' } });
  use.wireToolInputs = { toolu_r: { file_path: '/tmp/office-sim-fixture/WIRE.md' } };
  const evs = feed([b.humanPrompt(),
    b.assistantThinking({ msgId: 'msg_1', text: '', durationMs: 1200 }),
    b.assistantThinking({ msgId: 'msg_1', text: 'Look at the config first. Then edit.', durationMs: 50 }),
    b.assistantText({ msgId: 'msg_1', text: `Short reply ${'x'.repeat(200)}` }), use]);
  const th = of(evs, 'thinking');
  assert.deepEqual(th.map((e) => [e.text, e.durationMs]), [[null, 1200], ['Look at the config first.', 50]]);
  const say = of(evs, 'say')[0];
  assert.ok(Array.from(say.text).length <= 100);
  const ts = of(evs, 'tool_start')[0];
  assert.deepEqual([ts.toolUseId, ts.tool, ts.summary], ['toolu_r', 'Read', 'notes.md']);
  assert.equal(ts.sessionId, SID);
  assert.equal(ts.ts, use.timestamp);
});

test('R14 synthetic "No response requested." is not said; plumbing tools have no tool_start', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.syntheticNoResponse(),
    b.assistantToolUse({ msgId: 'msg_2', id: 'toolu_c', name: 'mcp__ccd_session__mark_chapter', input: { title: 't' } }),
    b.toolResult({ toolUseId: 'toolu_c', content: 'ok' }), b.assistantToolUse({ msgId: 'msg_2', id: 'toolu_ts', name: 'ToolSearch', input: { query: 'x' } })]);
  assert.deepEqual(of(evs, 'say'), []);
  assert.deepEqual(of(evs, 'tool_start'), []);
  assert.deepEqual(of(evs, 'tool_end'), []);
});

test('R16/R24 out-of-order parallel results pair by id; unknown ids are ignored', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.bashUse({ msgId: 'msg_P', id: 'toolu_1' }), b.bashUse({ msgId: 'msg_P', id: 'toolu_2' }),
    b.bashResult({ toolUseId: 'toolu_2' }), b.bashUse({ msgId: 'msg_P', id: 'toolu_3' }), b.bashResult({ toolUseId: 'toolu_nope' }),
    b.bashResult({ toolUseId: 'toolu_3', ok: false }), b.bashResult({ toolUseId: 'toolu_1' })]);
  assert.deepEqual(ends(evs), [['toolu_2', true, undefined], ['toolu_3', false, 'failed'], ['toolu_1', true, undefined]]);
});

test('R25 failed strips <tool_use_error> and keeps the first line (<= 120)', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.bashUse({ msgId: 'm', id: 't1' }),
    b.toolResult({ toolUseId: 't1', isError: true, content: '<tool_use_error>String to replace not found in file.\nString: secret</tool_use_error>' }),
    b.bashUse({ msgId: 'm', id: 't2' }), b.toolResult({ toolUseId: 't2', isError: true, content: `Exit code 1\n${'y'.repeat(300)}` }),
    b.bashUse({ msgId: 'm', id: 't3' }), b.toolResult({ toolUseId: 't3', isError: true, content: 'z'.repeat(400) })]);
  const e = of(evs, 'tool_end');
  assert.deepEqual(e.map((x) => [x.errorKind, x.error]).slice(0, 2), [['failed', 'String to replace not found in file.'], ['failed', 'Exit code 1']]);
  assert.ok(Array.from(e[2].error).length <= 120);
});

test('R25 denied by toolDenialKind', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.bashUse({ msgId: 'm', id: 't1' }),
    b.toolResult({ toolUseId: 't1', isError: true, toolDenialKind: 'automode-blocked', content: 'Denied by the classifier. Reason: invented' })]);
  assert.deepEqual(ends(evs), [['t1', false, 'denied']]);
  // Raw-feedback variant: the content is only the user's words, so the error text is fixed.
  const raw = feed([b.bashUse({ msgId: 'm', id: 't2' }),
    b.toolResult({ toolUseId: 't2', isError: true, toolDenialKind: 'permission-rule', content: 'my private feedback words' })]);
  assert.deepEqual(of(raw, 'tool_end').map((e) => [e.errorKind, e.error]), [['denied', 'denied']]);
});

test('R25 parallel user rejections followed by one marker are all interrupted', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt(), b.bashUse({ msgId: 'm', id: 'p1' }), b.bashUse({ msgId: 'm', id: 'p2' })]);
  assert.deepEqual(feed([b.userRejected({ toolUseId: 'p1' }), b.userRejected({ toolUseId: 'p2' })]), []);
  const evs = feed([b.interruptMarker({ forTool: true })]);
  assert.deepEqual(ends(evs), [['p1', false, 'interrupted'], ['p2', false, 'interrupted']]);
});

test('R25 denied by generated text prefix, with paths, urls and commands hidden', () => {
  const { b, feed } = harness();
  const cases = [
    ['Permission to use Bash with command rm -rf /tmp/office-sim-fixture/secret has been denied.', 'Permission to use Bash has been denied.'],
    ['Permission for this action was denied by the Claude Code auto mode classifier.', null],
    ['PreToolUse:Bash hook error: [/tmp/office-sim-fixture/hooks/guard.sh]: blocked https://example.invalid/a?token=1', 'PreToolUse:Bash hook error: [guard.sh]: blocked example.invalid'],
    ['<tool_use_error>Blocked: invented policy</tool_use_error>', 'Blocked: invented policy'],
  ];
  feed([b.humanPrompt()]);
  cases.forEach(([content, expected], i) => {
    const evs = feed([b.bashUse({ msgId: 'm', id: `t${i}` }), b.toolResult({ toolUseId: `t${i}`, isError: true, content })]);
    const end = of(evs, 'tool_end')[0];
    assert.equal(end.errorKind, 'denied', content);
    if (expected) assert.equal(end.error, expected);
  });
  // Without is_error the same words are ordinary output.
  const ok = feed([b.bashUse({ msgId: 'm', id: 'tx' }), b.toolResult({ toolUseId: 'tx', content: 'Permission to use is documented here.' })]);
  assert.equal(of(ok, 'tool_end')[0].ok, true);
});

test('R25 interrupted when the marker follows a user-rejected result', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt(), b.bashUse({ msgId: 'm', id: 't1' })]);
  assert.deepEqual(feed([b.userRejected({ toolUseId: 't1' })]), [], 'held for one record');
  const evs = feed([b.interruptMarker({ forTool: true })]);
  assert.deepEqual(types(evs), ['tool_end', 'turn_end']);
  assert.deepEqual(ends(evs), [['t1', false, 'interrupted']]);
  assert.equal(of(evs, 'turn_end')[0].reason, 'interrupt');
});

test('R25 user-rejected with no marker becomes denied on the next record or in idle', () => {
  const { b, feed, s, clock } = harness();
  feed([b.humanPrompt(), b.askUse({ msgId: 'm', id: 'ask1' }), b.askResult({ toolUseId: 'ask1', answered: false })]);
  const next = feed([b.assistantText({ msgId: 'm2', text: 'ok, stopping' })]);
  assert.deepEqual(ends(next), [['ask1', false, 'denied']]);
  assert.equal(types(next)[0], 'tool_end');
  feed([b.bashUse({ msgId: 'm3', id: 't2' }), b.userRejected({ toolUseId: 't2' })]);
  assert.deepEqual(s.idle(clock.t + 1000), []);
  assert.deepEqual(ends(s.idle(clock.t + 2000)), [['t2', false, 'denied']]);
});

test('R27 abandoned on a new msgId while the tool has no result', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.bashUse({ msgId: 'msg_A', id: 't1' }), b.assistantThinking({ msgId: 'msg_B' })]);
  assert.deepEqual(ends(evs), [['t1', false, 'abandoned']]);
});

test('R27 abandoned on an interrupt marker or a new turn', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt(), b.bashUse({ msgId: 'msg_A', id: 't1' })]);
  const intr = feed([b.interruptMarker({ forTool: false })]);
  assert.deepEqual(ends(intr), [['t1', false, 'abandoned']]);
  feed([b.humanPrompt({ text: 'again' }), b.bashUse({ msgId: 'msg_C', id: 't2' })]);
  const turn = feed([b.notification({ toolUseId: 'toolu_other' })]);
  assert.deepEqual(types(turn), ['tool_end', 'turn_end']);
  assert.deepEqual(ends(turn), [['t2', false, 'abandoned']]);
});

test('R27 a pending tool with no new msgId stays open however long', () => {
  const { b, feed, s, clock } = harness();
  feed([b.humanPrompt(), b.bashUse({ msgId: 'msg_A', id: 't1' }), b.hookAttachment()]);
  assert.deepEqual(s.idle(clock.t + 3_600_000), []);
  assert.deepEqual(s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => e.toolUseId), ['t1']);
});

test('R28 async agent and workflow launches end ok; the subagent lives on', () => {
  const { b, feed, s } = harness();
  const evs = feed([b.humanPrompt(), b.agentUse({ msgId: 'm', id: 'ag1', background: true }), b.agentAsyncResult({ toolUseId: 'ag1' }),
    b.assistantToolUse({ msgId: 'm', id: 'wf1', name: 'Workflow', input: { script: 'x', description: 'Run the demo' } }),
    b.workflowAsyncResult({ toolUseId: 'wf1' })]);
  assert.equal(of(evs, 'tool_start')[0].background, true);
  assert.deepEqual(ends(evs), [['ag1', true, undefined], ['wf1', true, undefined]]);
  assert.equal(of(s.snapshotEvents(), 'tool_start').length, 0);
  assert.deepEqual(of(evs, 'session_end'), []);
});

test('R30 turn_end reasons: stop_hook, wrap_up, next_turn; fires once per turn', () => {
  const { b, feed } = harness();
  let evs = feed([b.humanPrompt(), b.assistantText({ msgId: 'm1', text: 'hi', stopReason: 'end_turn' }), b.stopHookSummary(), b.stopHookSummary()]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['stop_hook']);
  evs = feed([b.humanPrompt({ text: 'two' }), b.wrapUpUse({ msgId: 'm2', id: 'w1' }), b.wrapUpResult({ toolUseId: 'w1' }), b.stopHookSummary()]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['wrap_up']);
  assert.deepEqual(of(evs, 'tool_start'), []);
  evs = feed([b.humanPrompt({ text: 'three' }), b.bashUse({ msgId: 'm3', id: 't3' }), b.bashResult({ toolUseId: 't3' }), b.humanPrompt({ text: 'four' })]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn']);
  assert.ok(types(evs).indexOf('turn_end') < types(evs).lastIndexOf('prompt'));
});

test('R30 end_turn fallback through idle(nowMs) after 20 s of no growth (no stop hook needed)', () => {
  const { b, feed, s, clock } = harness();
  feed([b.humanPrompt(), b.assistantText({ msgId: 'm1', text: 'done', stopReason: 'end_turn' })]);
  assert.deepEqual(s.idle(clock.t + 19_999), []);
  clock.t += 10_000;
  feed([b.hookAttachment()]); // growth restarts the 20 s window
  assert.deepEqual(s.idle(clock.t + 15_000), []);
  const evs = s.idle(clock.t + 20_000);
  assert.deepEqual(evs.map((e) => [e.type, e.reason]), [['turn_end', 'end_turn']]);
  assert.equal(evs[0].ts, new Date(clock.t + 20_000).toISOString());
  assert.deepEqual(s.idle(clock.t + 60_000), []);
});

test('R30 end_turn on a later line is cleared by a tool_use line of a new message', () => {
  const { b, feed, s, clock } = harness();
  feed([b.humanPrompt(), b.assistantText({ msgId: 'm1', text: 'step', stopReason: 'end_turn' }), b.bashUse({ msgId: 'm2', id: 't' })]);
  assert.deepEqual(s.idle(clock.t + 60_000), []);
});

test('R30 reused promptId is the same turn; a new prompt after the end reopens it', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt({ promptId: 'P1' }), b.metaUser({ promptId: 'P1' }), b.stopHookSummary()]);
  const evs = feed([b.humanPrompt({ promptId: 'P1', text: 'more' }), b.assistantText({ msgId: 'm', text: 'x' }), b.stopHookSummary()]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['stop_hook']);
});

test('R30 no turn events in subagent files', () => {
  const { b, feed } = harness({ kind: 'sub' });
  const evs = feed([b.subagentPrompt(), b.assistantText({ msgId: 'm', text: 'x', stopReason: 'end_turn' }), b.stopHookSummary(),
    b.interruptMarker({ forTool: false })]);
  assert.deepEqual(of(evs, 'turn_end'), []);
});

test('R31 api_error retry text and synthetic api error ends the turn', () => {
  const { b, feed } = harness();
  let evs = feed([b.humanPrompt(), b.apiErrorRetry({ attempt: 2, max: 10, status: 529 }), b.apiErrorRetry({ attempt: 3, max: 10, status: null })]);
  assert.deepEqual(of(evs, 'system').map((e) => [e.kind, e.text]), [['api_error', 'API 재시도 2/10 (529)'], ['api_error', 'API 재시도 3/10']]);
  assert.deepEqual(of(evs, 'turn_end'), []);
  evs = feed([b.bashUse({ msgId: 'm1', id: 't1' }), b.syntheticApiError({ text: 'API Error: invented limit\nsecond line' })]);
  assert.deepEqual(types(evs), ['tool_start', 'tool_end', 'system', 'turn_end']);
  assert.equal(of(evs, 'system')[0].text, 'API Error: invented limit');
  assert.equal(of(evs, 'turn_end')[0].reason, 'api_error');
  assert.deepEqual(of(evs, 'say'), []);
});

test('R32 compact boundary emits system compact; the summary record starts no turn', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt({ promptId: 'P1' })]);
  const evs = feed([b.compactBoundary(), b.compactSummary({ promptId: 'P2' }), b.metaUser({ promptId: 'P2' })]);
  assert.deepEqual(of(evs, 'system').map((e) => e.kind), ['compact']);
  assert.deepEqual(of(evs, 'turn_end'), []);
  assert.deepEqual(of(feed([b.modelRefusalFallback()]), 'system').map((e) => e.kind), ['refusal']);
});

test('R33 AskUserQuestion carries question/options and ends ok when answered', () => {
  const { b, feed } = harness();
  const qs = [{ question: `Pick a layout for the invented page? ${'q'.repeat(200)}`, header: 'Layout', options: [
    { label: 'Grid' }, { label: 'List' }, { label: 'Cards' }, { label: 'Table' }, { label: 'Fifth' }] },
  { question: 'Second?', header: 'Two', options: [{ label: 'A' }] }, { question: 'Third?', header: 'Three', options: [] }];
  const evs = feed([b.humanPrompt(), b.askUse({ msgId: 'm', id: 'ask1', questions: qs }), b.askResult({ toolUseId: 'ask1' })]);
  const st = of(evs, 'tool_start')[0];
  assert.ok(st.question.endsWith(' (+2)'));
  assert.ok(Array.from(st.question.replace(' (+2)', '')).length <= 160);
  assert.deepEqual(st.options, ['Grid', 'List', 'Cards', 'Table']);
  assert.deepEqual(ends(evs), [['ask1', true, undefined]]);
});

test('R34 ExitPlanMode: approval question, exit_plan plan, approved ok / rejected denied', () => {
  const { b, feed } = harness();
  let evs = feed([b.humanPrompt(), b.exitPlanUse({ msgId: 'm', id: 'x1', plan: '# Plan\n\n## Build the parser\n\n## Write tests\n' })]);
  const st = of(evs, 'tool_start')[0];
  assert.deepEqual([st.question, st.options], ['이 계획대로 진행할까요?', ['승인', '수정 요청']]);
  const plan = of(evs, 'plan')[0];
  assert.equal(plan.source, 'exit_plan');
  assert.ok(plan.items.length >= 1 && plan.items.every((it) => it.status === 'pending'));
  assert.ok(!JSON.stringify(evs).includes('# Plan'));
  evs = feed([b.exitPlanResult({ toolUseId: 'x1', approved: true })]);
  assert.deepEqual(ends(evs), [['x1', true, undefined]]);
  feed([b.exitPlanUse({ msgId: 'm2', id: 'x2' }), b.exitPlanResult({ toolUseId: 'x2', approved: false })]);
  evs = feed([b.assistantText({ msgId: 'm3', text: 'revising' })]);
  assert.deepEqual(ends(evs), [['x2', false, 'denied']]);
});

test('R35 update_plan: items, advance, done/start, reconciled with the result text', () => {
  const { b, feed } = harness();
  feed([b.humanPrompt()]);
  const step = (id, input, text) => of(feed([b.updatePlanUse({ msgId: `m_${id}`, id, input }), b.updatePlanResult({ toolUseId: id, text })]), 'plan');
  let p = step('u1', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }], scope: 'first_task' }, 'Plan shown (3 steps).');
  assert.deepEqual(p.map((e) => [e.source, e.items.map((i) => i.status).join()]), [['update_plan', 'in_progress,pending,pending']]);
  p = step('u2', { advance: true }, 'Plan updated: step 2 of 3 is in progress.');
  assert.equal(p[0].items.map((i) => i.status).join(), 'completed,in_progress,pending');
  p = step('u3', { done: [2], start: 3 }, 'Plan updated: step 3 of 3 is in progress.');
  assert.equal(p[0].items.map((i) => i.status).join(), 'completed,completed,in_progress');
  // Result text disagrees with the replay: trust the text for the in_progress position.
  step('u4', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] }, 'Plan shown (3 steps).');
  p = step('u5', { advance: true }, 'Plan updated: step 3 of 3 is in progress.');
  assert.equal(p[0].items[2].status, 'in_progress');
  // Failed call: no plan event; plumbing never shows as a tool.
  const evs = feed([b.updatePlanUse({ msgId: 'm6', id: 'u6', input: { advance: true } }), b.toolResult({ toolUseId: 'u6', isError: true, content: 'bad' })]);
  assert.deepEqual(types(evs), []);
});

test('R36 tasks: reminder snapshot then TaskCreate/TaskUpdate deltas; update_plan wins', () => {
  const { b, feed } = harness();
  let evs = feed([b.humanPrompt(), b.taskReminder({ content: [{ id: '1', subject: 'Old task', status: 'in_progress' }] })]);
  assert.deepEqual(of(evs, 'plan').map((e) => [e.source, e.items]), [['tasks', [{ content: 'Old task', status: 'in_progress' }]]]);
  assert.deepEqual(of(feed([b.taskReminder({ content: [{ id: '1', subject: 'Old task', status: 'in_progress' }] })]), 'plan'), []);
  evs = feed([b.taskCreateUse({ msgId: 'm', id: 'tc', subject: 'New task' }), b.taskCreateResult({ toolUseId: 'tc', taskId: '2', subject: 'New task' }),
    b.taskUpdateUse({ msgId: 'm', id: 'tu', taskId: '2', status: 'completed' }), b.taskUpdateResult({ toolUseId: 'tu', taskId: '2' })]);
  const plans = of(evs, 'plan');
  assert.deepEqual(plans.at(-1).items, [{ content: 'Old task', status: 'in_progress' }, { content: 'New task', status: 'completed' }]);
  assert.equal(of(evs, 'tool_start').length, 2);
  feed([b.updatePlanUse({ msgId: 'm2', id: 'up', input: { items: [{ content: 'X', status: 'in_progress' }] } }), b.updatePlanResult({ toolUseId: 'up', text: 'Plan shown (1 steps).' })]);
  evs = feed([b.taskReminder({ content: [] })]);
  assert.deepEqual(of(evs, 'plan'), []);
});

test('prompt events: truncated to 80, tags skipped, queued prompts stay in the turn', () => {
  const { b, feed } = harness();
  let evs = feed([b.humanPrompt({ text: `Please ${'w'.repeat(200)}` })]);
  assert.ok(Array.from(of(evs, 'prompt')[0].text).length <= 80);
  evs = feed([b.humanPrompt({ text: '<bash-input>ls</bash-input>' })]);
  assert.deepEqual(of(evs, 'prompt'), []);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn']);
  evs = feed([b.queuedPrompt({ text: 'also this' })]);
  assert.deepEqual(types(evs), ['prompt']);
  assert.deepEqual(of(feed([b.interruptMarker({ forTool: false })]), 'prompt'), []);
});

test('summaries come from summarize.mjs and never carry raw input', () => {
  const { b, feed } = harness();
  const evs = feed([b.humanPrompt(), b.bashUse({ msgId: 'm', id: 't1', command: 'cd /tmp/office-sim-fixture && SECRET=1 curl https://example.invalid/x', description: undefined })]);
  const st = of(evs, 'tool_start')[0];
  assert.ok(!JSON.stringify(st).includes('SECRET'));
  assert.ok(!JSON.stringify(st).includes('/tmp/office-sim-fixture'));
  assert.equal(st.tool, 'Bash');
});

test('snapshotEvents: session, current plan, open tool_starts incl. an open ask; nothing ended', () => {
  const { b, feed, s } = harness();
  feed([b.humanPrompt(), b.updatePlanUse({ msgId: 'm', id: 'u1', input: { items: [{ content: 'A', status: 'in_progress' }] } }),
    b.updatePlanResult({ toolUseId: 'u1', text: 'Plan shown (1 steps).' }), b.bashUse({ msgId: 'm', id: 'done1' }), b.bashResult({ toolUseId: 'done1' }),
    b.bashUse({ msgId: 'm', id: 'run1' }), b.askUse({ msgId: 'm', id: 'ask1' })]);
  const snap = s.snapshotEvents();
  assert.deepEqual(types(snap), ['session', 'plan', 'tool_start', 'tool_start']);
  assert.deepEqual(of(snap, 'tool_start').map((e) => e.toolUseId), ['run1', 'ask1']);
  const ask = of(snap, 'tool_start')[1];
  assert.equal(ask.question, 'Which layout should the demo use?');
  assert.deepEqual(ask.options, ['Grid', 'List']);
  assert.deepEqual(of(snap, 'plan')[0].items, [{ content: 'A', status: 'in_progress' }]);
});

test('R29 subagent ends on its own endTurn result, after a final text, or when idle', () => {
  let h = harness({ kind: 'sub' });
  let evs = h.feed([h.b.subagentPrompt(), h.b.assistantToolUse({ msgId: 'm', id: 'so', name: 'StructuredOutput', input: { summary: 'x' } }),
    h.b.toolResult({ toolUseId: 'so', content: 'ok', toolEndsTurn: true })]);
  assert.deepEqual(of(evs, 'session_end').map((e) => [e.sessionId, e.reason]), [[AGENT, 'done']]);
  assert.equal(h.s.ended, true);
  assert.deepEqual(h.feed([h.b.assistantText({ msgId: 'm9', text: 'bye' })]), []);
  assert.deepEqual(h.s.snapshotEvents(), []);
  evs = h.feed([h.b.subagentPrompt({ text: 'resumed' }), h.b.assistantText({ msgId: 'm10', text: 'back' })]);
  assert.deepEqual(types(evs), ['session', 'say']);
  h = harness({ kind: 'sub' });
  // A final text carries stop_reason end_turn; a null stop_reason is a mid-message line (see session-fixes.test.mjs).
  h.feed([h.b.subagentPrompt(), h.b.assistantText({ msgId: 'm', text: 'Final report.', stopReason: 'end_turn' })]);
  assert.deepEqual(h.s.idle(h.clock.t + 14_999), []);
  assert.deepEqual(h.s.idle(h.clock.t + 15_000).map((e) => [e.type, e.reason]), [['session_end', 'done']]);
  h = harness({ kind: 'wf' });
  h.feed([h.b.subagentPrompt(), h.b.assistantThinking({ msgId: 'm' })]);
  // A thinking line with stop_reason null leaves the message unfinished: the longer quiet limit applies.
  assert.deepEqual(h.s.idle(h.clock.t + 120_000), []);
  assert.deepEqual(h.s.idle(h.clock.t + 600_000).map((e) => [e.type, e.reason]), [['session_end', 'idle']]);
  h = harness({ kind: 'sub' });
  h.feed([h.b.subagentPrompt(), h.b.bashUse({ msgId: 'm', id: 't' })]);
  assert.deepEqual(h.s.idle(h.clock.t + 600_000), [], 'a pending tool keeps the subagent alive');
});
