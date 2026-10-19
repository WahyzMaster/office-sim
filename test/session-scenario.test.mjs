import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionState, projectKey } from '../src/session.mjs';
import { createRecordBuilder, clone } from './fixtures/records.mjs';

const SID = '55555555-5555-4555-8555-555555555555';
const REPO = '/tmp/co-fixture/demo-repo';

function mainState(clock = { t: Date.UTC(2026, 0, 1, 2) }) {
  return new SessionState({ id: SID, file: `/tmp/co-fixture/${SID}.jsonl`, kind: 'main', stem: SID, now: () => clock.t });
}
const of = (evs, type) => evs.filter((e) => e.type === type);

test('4.4 projectKey: originalCwd, worktree parent, cwd, trailing slash', () => {
  assert.equal(projectKey('/x/repo/.worktrees/wt', { originalCwd: '/x/orig/' }), '/x/orig');
  assert.equal(projectKey('/x/repo/.worktrees/wt-1/sub/dir', null), '/x/repo');
  assert.equal(projectKey('/x/repo/.claude/worktrees/wt2', undefined), '/x/repo');
  assert.equal(projectKey('/x/repo/.claude/worktrees/wt2/', null), '/x/repo');
  assert.equal(projectKey('/x/repo/', null), '/x/repo');
  assert.equal(projectKey('/x/my.worktrees/a', null), '/x/my.worktrees/a');
  assert.equal(projectKey(undefined, null), '');
  assert.equal(projectKey('/', null), '/');
});

test('4.4 project comes from the FIRST cwd; worktree badge from the latest cwd or worktree-state', () => {
  const s = mainState();
  const b = createRecordBuilder({ sessionId: SID, cwd: `${REPO}/.worktrees/feat-a/pkg` });
  let evs = [b.queueOperation(), b.customTitle('Demo')].flatMap((r) => s.apply(r));
  assert.equal(of(evs, 'session')[0].project, '');
  evs = s.apply(b.humanPrompt({ text: 'go' }));
  const first = of(evs, 'session')[0];
  assert.deepEqual([first.project, first.projectLabel, first.worktree], [REPO, 'demo-repo', 'feat-a']);
  b.setCwd('/tmp/co-fixture/elsewhere');
  evs = s.apply(b.assistantText({ msgId: 'm1', text: 'moved' }));
  assert.deepEqual([of(evs, 'session')[0].project, of(evs, 'session')[0].worktree], [REPO, null]);
  const ws = { originalCwd: REPO, worktreePath: `${REPO}/.claude/worktrees/wt-b`, worktreeName: 'wt-b', sessionId: SID };
  evs = s.apply(b.worktreeState(ws));
  assert.equal(of(evs, 'session')[0].worktree, 'wt-b');
  evs = s.apply(b.worktreeState(null));
  assert.equal(of(evs, 'session')[0].worktree, null);
  assert.equal(s.firstCwd, `${REPO}/.worktrees/feat-a/pkg`);
});

test('4.3 main title precedence and live session events only on change', () => {
  const s = mainState();
  const b = createRecordBuilder({ sessionId: SID, cwd: REPO });
  assert.equal(s.title, SID.slice(0, 8));
  s.apply(b.lastPrompt(`last ${'p'.repeat(80)}`));
  assert.ok(s.title.startsWith('last ') && Array.from(s.title).length <= 40);
  s.apply(b.humanPrompt({ text: '<command-name>/x</command-name>' }));
  assert.ok(s.title.startsWith('last '), 'tag prompts are not titles');
  s.apply(b.humanPrompt({ text: 'First real prompt' }));
  assert.equal(s.title, 'First real prompt');
  s.apply(b.legacySummary('Legacy summary'));
  assert.equal(s.title, 'Legacy summary');
  s.setInfo({ fileTitle: 'From custom-title.json' });
  assert.equal(s.title, 'From custom-title.json');
  s.apply(b.agentName('agent-label'));
  assert.equal(s.title, 'agent-label');
  let evs = s.apply(b.customTitle('Custom one'));
  assert.deepEqual(of(evs, 'session').map((e) => e.title), ['Custom one']);
  assert.deepEqual(s.apply(b.customTitle('Custom one')), [], 'a re-appended title changes nothing');
  evs = s.apply(b.customTitle('Custom two'));
  assert.equal(of(evs, 'session')[0].title, 'Custom two');
});

test('4.3 branch is the latest gitBranch, HEAD shows as detached', () => {
  const s = mainState();
  const b = createRecordBuilder({ sessionId: SID, cwd: REPO, gitBranch: 'main' });
  s.apply(b.humanPrompt());
  assert.equal(s.sessionEvent().branch, 'main');
  b.setBranch('HEAD');
  const evs = s.apply(b.assistantText({ msgId: 'm', text: 'x' }));
  assert.equal(of(evs, 'session')[0].branch, 'detached');
});

test('4.3 subagent title and identity fields', () => {
  const agentId = 'a0000000000000bb';
  const s = new SessionState({ id: agentId, kind: 'sub', stem: agentId, parentId: SID, agentType: null, now: () => 0 });
  const ev = () => s.sessionEvent();
  assert.deepEqual([ev().title, ev().isSubagent, ev().parentSessionId, ev().agentType], [agentId, true, SID, null]);
  s.setInfo({ subMeta: { agentType: 'Explore' } });
  assert.deepEqual([ev().title, ev().agentType], ['Explore', 'Explore']);
  s.setInfo({ subMeta: { agentType: 'Explore', workflowPhase: 'phase 2' } });
  assert.equal(ev().title, 'phase 2');
  s.setInfo({ journalLabel: 'review: parser' });
  assert.equal(ev().title, 'review: parser');
  s.setInfo({ subMeta: { agentType: 'Explore', description: 'Explore the demo' } });
  assert.equal(ev().title, 'Explore the demo');
  const out = s.setInfo({ subMeta: { agentType: 'Explore', description: 'Explore the demo', name: 'scout' }, parentProject: REPO });
  assert.deepEqual(out.map((e) => [e.type, e.title, e.project]), [['session', 'scout', REPO]]);
  // Subagent records carry the parent's sessionId; they are not fork history.
  const b = createRecordBuilder({ sessionId: SID, agentId, cwd: `${REPO}/.worktrees/wt-sub` });
  const evs = [b.subagentPrompt(), b.bashUse({ msgId: 'm', id: 't' })].flatMap((r) => s.apply(r));
  assert.equal(of(evs, 'tool_start').length, 1);
  assert.equal(s.sessionEvent().worktree, 'wt-sub');
});

// ------------------------------------------------------------------------------------------------
// Long mixed scenario: the same stream applied in replay mode and in live mode must give one state.

function scenario() {
  const b = createRecordBuilder({ sessionId: SID, cwd: REPO, gitBranch: 'main' });
  const other = '66666666-6666-4666-8666-666666666666';
  const r = [];
  // Fork history from another session, then own metadata block.
  r.push(b.humanPrompt({ text: 'inherited', sessionId: other }), b.bashUse({ msgId: 'msg_old', id: 'toolu_old', sessionId: other }));
  r.push(b.queueOperation(), b.customTitle('Scenario'), b.agentName('scenario-agent'), b.modeRecord());
  // Turn 1: plan, parallel tools with interleaved and out-of-order results, tasks, end_turn + stop hook.
  r.push(b.humanPrompt({ text: 'Build the invented feature' }));
  r.push(b.assistantThinking({ msgId: 'msg_1', text: 'Start with a plan. Then code.', durationMs: 900 }));
  r.push(b.updatePlanUse({ msgId: 'msg_1', id: 'up1', input: { items: [
    { content: 'Read', status: 'in_progress' }, { content: 'Edit', status: 'pending' }, { content: 'Test', status: 'pending' }] } }));
  r.push(b.updatePlanResult({ toolUseId: 'up1', text: 'Plan shown (3 steps).' }));
  r.push(b.assistantToolUse({ msgId: 'msg_2', id: 'rd1', name: 'Read', input: { file_path: `${REPO}/src/a.mjs` } }));
  r.push(b.assistantToolUse({ msgId: 'msg_2', id: 'rd2', name: 'Read', input: { file_path: `${REPO}/src/b.mjs` } }));
  r.push(b.toolResult({ toolUseId: 'rd2', content: 'b' }), b.hookAttachment());
  r.push(b.assistantToolUse({ msgId: 'msg_2', id: 'gr1', name: 'Grep', input: { pattern: 'x', path: REPO } }));
  r.push(b.toolResult({ toolUseId: 'gr1', content: 'hits' }), b.toolResult({ toolUseId: 'rd1', content: 'a' }));
  r.push(b.updatePlanUse({ msgId: 'msg_3', id: 'up2', input: { advance: true } }), b.updatePlanResult({ toolUseId: 'up2', text: 'Plan updated: step 2 of 3 is in progress.' }));
  r.push(b.taskReminder({ content: [{ id: '1', subject: 'side task', status: 'pending' }] }));
  r.push(b.taskCreateUse({ msgId: 'msg_3', id: 'tc1', subject: 'another' }), b.taskCreateResult({ toolUseId: 'tc1', taskId: '2', subject: 'another' }));
  r.push(b.bashUse({ msgId: 'msg_4', id: 'bs1', command: 'npm test' }), b.bashResult({ toolUseId: 'bs1', ok: false }));
  r.push(b.bashUse({ msgId: 'msg_4', id: 'bs2' }), b.userRejected({ toolUseId: 'bs2' }), b.interruptMarker({ forTool: true }));
  // Turn 2: api errors, ask (answered), an abandoned stream, wrap_up.
  r.push(b.humanPrompt({ text: 'Continue please' }), b.apiErrorRetry({ attempt: 1, max: 10, status: 529 }));
  r.push(b.askUse({ msgId: 'msg_5', id: 'ask1' }), b.askResult({ toolUseId: 'ask1' }));
  r.push(b.bashUse({ msgId: 'msg_6', id: 'lost1' }), b.assistantThinking({ msgId: 'msg_7' }));
  r.push(b.agentUse({ msgId: 'msg_7', id: 'ag1', background: true }), b.agentAsyncResult({ toolUseId: 'ag1' }));
  r.push(b.queuedPrompt({ text: 'and also the docs' }));
  r.push(b.wrapUpUse({ msgId: 'msg_8', id: 'wu1' }), b.wrapUpResult({ toolUseId: 'wu1' }), b.stopHookSummary());
  // Turn 3: notification turn, compaction, exit plan (rejected, then interrupt), another prompt.
  r.push(b.notification({ toolUseId: 'ag1', taskId: 'a0123456789abcdef' }), b.notification({ toolUseId: 'ag1', taskId: 'a0123456789abcdef', carrier: 'attachment' }));
  r.push(b.compactBoundary(), b.compactSummary(), b.assistantText({ msgId: 'msg_9', text: 'Noted.', stopReason: 'end_turn' }));
  r.push(b.humanPrompt({ text: 'Now plan the next part' }), b.exitPlanUse({ msgId: 'msg_10', id: 'ex1' }));
  r.push(b.exitPlanResult({ toolUseId: 'ex1', approved: false }), b.syntheticNoResponse());
  r.push(b.humanPrompt({ text: 'Plan again' }), b.exitPlanUse({ msgId: 'msg_11', id: 'ex2' }), b.exitPlanResult({ toolUseId: 'ex2', approved: true }));
  r.push(b.taskUpdateUse({ msgId: 'msg_12', id: 'tu1', taskId: '1', status: 'in_progress' }), b.taskUpdateResult({ toolUseId: 'tu1', taskId: '1' }));
  r.push(b.syntheticApiError({ text: 'API Error: invented limit reached' }));
  // Turn 4: still running at the end of the file (open tool + open ask).
  r.push(b.humanPrompt({ text: 'Last request' }), b.bashUse({ msgId: 'msg_13', id: 'run1' }), b.askUse({ msgId: 'msg_13', id: 'ask2' }));
  // Resume re-append: metadata block then old records again with new cwd / branch / promptId.
  const old = r.filter((x) => x.uuid && x.sessionId === SID).slice(5, 25);
  r.push(b.lastPrompt('Last request'), b.customTitle('Scenario'), b.agentName('scenario-agent'));
  for (const x of old) r.push(clone(x, { cwd: `${REPO}/.worktrees/resumed`, gitBranch: 'resumed', promptId: 'P-resumed' }));
  return r;
}

function digest(s) {
  return { state: s.debugState(), snapshot: s.snapshotEvents(), title: s.title, ended: s.ended, firstCwd: s.firstCwd };
}

test('scenario: replay mode and live mode build the identical state', () => {
  const recs = scenario();
  const live = mainState();
  const liveEvents = recs.flatMap((rec) => live.apply(rec));
  const replay = mainState();
  for (const rec of recs) assert.deepEqual(replay.apply(rec, { replay: true }), []);
  assert.deepEqual(digest(replay), digest(live));
  // Half replay (attach) + half live gives the same state as all live.
  const mixed = mainState();
  recs.forEach((rec, i) => mixed.apply(rec, { replay: i < recs.length / 2 }));
  assert.deepEqual(digest(mixed), digest(live));

  const reasons = of(liveEvents, 'turn_end').map((e) => e.reason);
  assert.deepEqual(reasons, ['interrupt', 'wrap_up', 'next_turn', 'next_turn', 'api_error']);
  const byId = Object.fromEntries(of(liveEvents, 'tool_end').map((e) => [e.toolUseId, e.ok ? 'ok' : e.errorKind]));
  assert.deepEqual(byId, {
    rd2: 'ok', gr1: 'ok', rd1: 'ok', tc1: 'ok', bs1: 'failed', bs2: 'interrupted', ask1: 'ok', lost1: 'abandoned',
    ag1: 'ok', ex1: 'denied', ex2: 'ok', tu1: 'ok',
  });
  assert.ok(!of(liveEvents, 'tool_start').some((e) => e.toolUseId === 'toolu_old'), 'fork history stays silent');
  assert.deepEqual(of(liveEvents, 'prompt').map((e) => e.text),
    ['Build the invented feature', 'Continue please', 'and also the docs', 'Now plan the next part', 'Plan again', 'Last request']);
  assert.deepEqual(of(liveEvents, 'system').map((e) => e.kind), ['api_error', 'compact', 'api_error']);
  const plans = of(liveEvents, 'plan').map((e) => e.source);
  assert.deepEqual(plans, ['update_plan', 'update_plan', 'exit_plan', 'exit_plan']);

  const snap = live.snapshotEvents();
  assert.deepEqual(snap.map((e) => e.type), ['session', 'plan', 'tool_start', 'tool_start']);
  assert.deepEqual(of(snap, 'tool_start').map((e) => e.toolUseId), ['run1', 'ask2']);
  assert.equal(of(snap, 'tool_start')[1].question, 'Which layout should the demo use?');
  assert.equal(snap[0].title, 'Scenario');
  assert.equal(snap[0].branch, 'main', 're-appended copies do not move the branch');
  // No raw content leaks: file paths, commands, plan markdown.
  const wire = JSON.stringify(liveEvents);
  for (const bad of [`${REPO}/src`, 'npm test', '# Plan', 'invented prompt']) assert.ok(!wire.includes(bad), bad);
});

test('scenario: idle after attach closes the open turn only through the end_turn rule', () => {
  const recs = scenario();
  const s = mainState();
  for (const rec of recs) s.apply(rec, { replay: true });
  // The last turn is still running (open tools, no end_turn): idle never ends it.
  assert.deepEqual(s.idle(Date.UTC(2027, 0, 1)), []);
});
