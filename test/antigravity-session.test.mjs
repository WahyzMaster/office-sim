// AntigravitySession (src/adapters/antigravity/session.mjs): Antigravity transcript steps -> UI events through SessionCore.
// One test per mapping row of ADAPTERS 5.3 / 6.1 (Antigravity column), named after the row; position pairing of results
// (missing, extra and swapped results, the abandoned closes, hidden calls, passing steps, unreadable calls); the
// USER_REQUEST extraction; the quiet-time end_turn, next_turn and the summary status; the metadata handed over by
// setInfo (workspace and the run_command Cwd fallback, task.md tasks); rooms and snapshots; and a long mixed scenario that
// compares replay-mode state with live-mode state in both transcript formats. The byte-position ids (stable across
// replay and live) and the format equivalence are in test/antigravity-records.test.mjs. Synthetic steps only
// (test/fixtures/antigravity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravitySession } from '../src/adapters/antigravity/session.mjs';
import { END_TURN_IDLE_MS } from '../src/core/session-core.mjs';
import { createAntigravityBuilder, call, linePositions, mixedSteps, toolId as tid, AG_ID, WORK } from './fixtures/antigravity.mjs';

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const SERVER_T = T0 + 3_600_000; // the server clock, an hour after the fixture's records

function mk({ format = 'full', facts, ...o } = {}) {
  const clock = { t: SERVER_T };
  const s = new AntigravitySession({
    id: AG_ID, agent: 'antigravity', kind: 'main', now: () => clock.t, file: '/tmp/x', stem: 'x', subMeta: null,
    journalLabel: null, facts: facts === undefined ? { full: format === 'full', base: 'antigravity-cli' } : facts, ...o,
  });
  return { s, clock, b: createAntigravityBuilder({ format }) };
}
const run = (s, steps, opts) => steps.flatMap((st) => s.apply(st, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
// The normalized items AntigravitySession hands to SessionCore (item order checks).
function spyItems(s) {
  const items = [];
  const orig = s.core.apply.bind(s.core);
  s.core.apply = (it, o) => {
    items.push(it.k);
    return orig(it, o);
  };
  return items;
}
const BAIT_RE = /BAIT|agtester|secret-dir|rm -rf|key=|toolAction|toolSummary|@example\.com|0b3c5d7e/;

// ---------------------------------------------------------------------------------------------- identity

test('first line: the session event comes first, agent antigravity, no cwd yet, title fallback from the conversation id', () => {
  const { s, b } = mk();
  const evs = run(s, [b.planner({ content: 'Looking around.' })]);
  assert.deepEqual(noTs(evs)[0], {
    type: 'session', sessionId: AG_ID, agent: 'antigravity', project: '', projectLabel: '', title: '3f6c2a1e',
    branch: null, worktree: null, isSubagent: false, parentSessionId: null,
  });
  assert.equal(s.firstCwd, null);
  assert.equal(s.ended, false);
  assert.equal(s.title, '3f6c2a1e');
});

// ---------------------------------------------------------------------------------------------- USER_INPUT

test('row USER_INPUT: turn_start before the prompt; the prompt is the inner USER_REQUEST only', () => {
  const { s, b } = mk();
  const items = spyItems(s);
  const evs = run(s, [b.userInput('Fix the login bug in ~/work/app.ts')]);
  assert.deepEqual(items, ['turn_start', 'prompt'], 'CONTRACT 4.0.2 order rule');
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug in app.ts']);
  assert.equal(s.title, 'Fix the login bug in app.ts', 'the first USER_REQUEST is the title fallback');
  assert.doesNotMatch(JSON.stringify([evs, s.snapshotEvents(), s.debugState()]), BAIT_RE, 'ADDITIONAL_METADATA never shows');
});

test('row USER_INPUT: USER_SETTINGS_CHANGE and PLAN blocks are dropped; content without USER_REQUEST opens the turn, no prompt', () => {
  const { s, b } = mk();
  const evs = run(s, [b.userInput('Ship it', { settings: true, plan: true })]);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Ship it']);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
  const m = mk();
  const items = spyItems(m.s);
  const evs2 = run(m.s, [m.b.userInput('', { raw: '<ADDITIONAL_METADATA>BAIT_METADATA</ADDITIONAL_METADATA>' }),
    m.b.userInput('', { raw: 'plain text without a block BAIT_RAW' })]);
  assert.deepEqual(items, ['turn_start', 'turn_start']);
  assert.deepEqual(of(evs2, 'prompt'), []);
  assert.equal(m.s.debugState().turnOpen, true, 'the turn is open all the same');
  assert.doesNotMatch(JSON.stringify(evs2), /BAIT/);
});

test('row USER_INPUT: an open previous turn ends next_turn; its calls still waiting end abandoned first', () => {
  const { s, b } = mk();
  const steps = [b.userInput('First'), b.planner({ calls: [call.viewFile()] }), b.userInput('Second')];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  const tail = noTs(evs.slice(evs.findIndex((e) => e.type === 'tool_start') + 1));
  assert.deepEqual(tail.filter((e) => e.type !== 'session'), [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: false, errorKind: 'abandoned', error: 'no result' },
    { type: 'turn_end', sessionId: AG_ID, reason: 'next_turn' },
    { type: 'prompt', sessionId: AG_ID, text: 'Second' },
  ]);
  assert.deepEqual(s.debugState().antigravity.pending, []);
});

// ---------------------------------------------------------------------------------------------- PLANNER_RESPONSE

test('row PLANNER_RESPONSE.thinking: a thinking event with its first sentence and no duration', () => {
  const { s, b } = mk();
  const evs = run(s, [b.userInput(), b.planner({ thinking: 'Reading the auth module first. Then the tests.' })]);
  assert.deepEqual(noTs(of(evs, 'thinking')), [{ type: 'thinking', sessionId: AG_ID, text: 'Reading the auth module first.', durationMs: null }]);
  assert.deepEqual(of(run(s, [b.planner({ thinking: '   ' })]), 'thinking'), [], 'blank thinking is no thinking');
});

test('row PLANNER_RESPONSE.content: say; final (arms end_turn) only when the step has no tool_calls', () => {
  const { s, b } = mk();
  const evs = run(s, [b.userInput(), b.planner({ content: 'Let me look at the code.', calls: [call.listDir()] })]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Let me look at the code.']);
  assert.equal(s.debugState().endTurnArmed, false, 'a say with calls is not the last word');
  run(s, [b.result(), b.planner({ content: 'All done.', calls: [] })]);
  assert.equal(s.debugState().endTurnArmed, true, 'no tool_calls (also an empty list): final');
  assert.equal(s.debugState().antigravity.final, true);
});

test('row PLANNER_RESPONSE.tool_calls: one tool_start per call, id <conversation>:<line position>:<i>, after thinking and say', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ thinking: 'Plan.', content: 'Two reads.', calls: [call.viewFile(), call.grep()] })];
  const pos = linePositions(steps);
  const items = spyItems(s);
  const evs = run(s, steps);
  assert.deepEqual(items, ['turn_start', 'prompt', 'thinking', 'say', 'tool_start', 'tool_start']);
  assert.deepEqual(noTs(of(evs, 'tool_start')), [
    { type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[1], 0), tool: 'view_file', summary: 'login.ts', room: 'archive' },
    { type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[1], 1), tool: 'grep_search', summary: 'refreshToken · src', room: 'archive' },
  ]);
  assert.deepEqual(s.debugState().antigravity.pending, [tid(pos[1], 0), tid(pos[1], 1)]);
});

// ---------------------------------------------------------------------------------------------- results

test('row result lines: the next N result lines after a planner line with N calls are its results, in order', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.runCommand(), call.listDir()] }),
    b.result({ type: 'VIEW_FILE' }), b.runResult({ exitCode: 0 }), b.result()];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(noTs(of(evs, 'tool_end')), [0, 1, 2].map((i) => ({ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], i), ok: true })));
  assert.deepEqual(s.debugState().open, []);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/, 'result content (tool output) is never read');
});

test('row result status: ERROR, error and exit_code -> failed with a reduced first line; RUNNING -> ok (background launch)', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.runCommand(), call.viewFile(), call.runCommand('npm run dev'), call.grep(), call.listDir()] }),
    b.runResult({ exitCode: 2 }),
    b.result({ status: 'ERROR', error: 'permission check failed for read /Users/agtester/secret-dir/x.env\nBAIT_SECOND_LINE' }),
    b.runResult({ status: 'RUNNING' }), b.result({ status: 'RUNNING' }), b.result({ status: 'ERROR' })];
  const pos = linePositions(steps);
  const ends = noTs(of(run(s, steps), 'tool_end'));
  const at = (i) => ({ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], i) });
  assert.deepEqual(ends, [
    { ...at(0), ok: false, errorKind: 'failed', error: 'Exit code 2' },
    { ...at(1), ok: false, errorKind: 'failed', error: 'permission check failed for read x.env' },
    { ...at(2), ok: true },
    { ...at(3), ok: true },
    { ...at(4), ok: false, errorKind: 'failed', error: 'failed' },
  ]);
  assert.ok(ends.every((e) => !('background' in e)), 'background is never on a tool_end (CONTRACT 2)');
});

test('row list_permissions: hidden (no tool_start, no tool_end), but it takes its result slot so the next call stays paired', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.listPermissions(), call.viewFile()] }), b.result({ status: 'ERROR', error: 'BAIT_PERMS' }), b.result()];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(pos[1], 1)]);
  assert.deepEqual(noTs(of(evs, 'tool_end')), [{ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 1), ok: true }]);
  assert.doesNotMatch(JSON.stringify(evs), /list_permissions|BAIT/);
});

test('row SYSTEM_MESSAGE / CONVERSATION_HISTORY: no event, and they take no result slot', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.conversationHistory(), b.planner({ calls: [call.viewFile()] }), b.systemMessage(),
    b.conversationHistory(), b.result({ status: 'ERROR', error: 'the real result' })];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(noTs(of(evs, 'tool_end')), [{ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[2], 0), ok: false, errorKind: 'failed', error: 'the real result' }]);
  assert.deepEqual(types(evs).filter((t) => t !== 'session'), ['prompt', 'tool_start', 'tool_end']);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
});

test('row unknown step types: a result line while calls wait (positional rule), ignored otherwise', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.step('KNOWLEDGE_ARTIFACTS'), b.planner({ calls: [call.browserSubagent()] }),
    b.step('BROWSER_SUBAGENT', { status: 'ERROR', error: 'browser crashed' }), b.step('INVOKE_SUBAGENT')];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(noTs(of(evs, 'tool_end')), [{ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[2], 0), ok: false, errorKind: 'failed', error: 'browser crashed' }]);
  assert.equal(s.debugState().antigravity.orphans, 2, 'the two unknown steps without a waiting call');
  assert.equal(s.skipped, 0, 'unknown types are not malformed');
});

// ---------------------------------------------------------------------------------------------- closers

test('row PLANNER_RESPONSE as closer: calls without a result line end abandoned before the new line\'s work, the turn goes on', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.grep()] }), b.result(),
    b.planner({ thinking: 'Next.', calls: [call.listDir()] })];
  const pos = linePositions(steps);
  const evs = run(s, steps).filter((e) => e.type !== 'session');
  assert.deepEqual(noTs(evs.slice(3)), [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: true },
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 1), ok: false, errorKind: 'abandoned', error: 'no result' },
    { type: 'thinking', sessionId: AG_ID, text: 'Next.', durationMs: null },
    { type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[3], 0), tool: 'list_dir', summary: 'src', room: 'archive' },
  ]);
  assert.equal(of(evs, 'turn_end').length, 0);
  assert.equal(s.debugState().turnOpen, true);
});

test('row CHECKPOINT: system compact with the fixed text (the compaction body is never read); waiting calls keep waiting', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.runCommand()] }), b.checkpoint(), b.result()];
  const pos = linePositions(steps);
  const evs = run(s, steps).filter((e) => e.type !== 'session');
  assert.deepEqual(noTs(evs.slice(2)), [
    { type: 'system', sessionId: AG_ID, kind: 'compact', text: 'Conversation compacted' },
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: true },
  ], 'the late result after the checkpoint is its result (P5e review finding 1)');
  assert.equal(s.debugState().antigravity.orphans, 0);
  assert.equal(s.debugState().turnOpen, true, 'a compaction does not end the turn');
});

test('row ERROR_MESSAGE: waiting calls end abandoned, system api_error from its first line, the turn is not ended', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.errorMessage(), b.planner({ content: 'Retrying.', calls: [call.viewFile()] })];
  const pos = linePositions(steps);
  const evs = run(s, steps).filter((e) => e.type !== 'session');
  assert.deepEqual(noTs(evs.slice(2, 4)), [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: false, errorKind: 'abandoned', error: 'no result' },
    { type: 'system', sessionId: AG_ID, kind: 'api_error', text: 'Model provider overloaded, retrying' },
  ]);
  assert.equal(of(evs, 'turn_end').length, 0);
  assert.equal(s.debugState().turnOpen, true);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(pos[1], 0), tid(pos[3], 0)], 'same call, new line, new id');
  const { s: s2, b: b2 } = mk();
  const sys = of(run(s2, [b2.errorMessage(undefined, { error: undefined, content: '' })]), 'system');
  assert.deepEqual(sys.map((e) => e.text), ['API error'], 'no text -> the core fallback');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|agtester/);
});

// ---------------------------------------------------------------------------------------------- position pairing

test('pairing: results are paired by position even when their typed result types come in another order', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.runCommand()] }),
    b.runResult({ exitCode: 3 }), b.result({ type: 'VIEW_FILE' })];
  const pos = linePositions(steps);
  const ends = noTs(of(run(s, steps), 'tool_end'));
  assert.deepEqual(ends, [
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: false, errorKind: 'failed', error: 'Exit code 3' },
    { type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 1), ok: true },
  ], 'no call id in the records: the file position decides, never the result type');
});

test('pairing: a missing result ends abandoned at the next closer; an extra result line is ignored and counted', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile(), call.grep(), call.listDir()] }), b.result(),
    b.planner({ calls: [call.readFile()] }), b.result(), b.result({ status: 'ERROR', error: 'extra' })];
  const pos = linePositions(steps);
  const ends = noTs(of(run(s, steps), 'tool_end'));
  assert.deepEqual(ends.map((e) => [e.toolUseId, e.errorKind ?? 'ok']), [
    [tid(pos[1], 0), 'ok'], [tid(pos[1], 1), 'abandoned'], [tid(pos[1], 2), 'abandoned'], [tid(pos[3], 0), 'ok'],
  ]);
  assert.equal(s.debugState().antigravity.orphans, 1);
  assert.deepEqual(s.debugState().open, []);
});

test('pairing: a result that lands after the next USER_INPUT is ignored (its call was already abandoned with the turn)', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.runCommand()] }), b.userInput('Stop that'), b.runResult()];
  const pos = linePositions(steps);
  const ends = noTs(of(run(s, steps), 'tool_end'));
  assert.deepEqual(ends, [{ type: 'tool_end', sessionId: AG_ID, toolUseId: tid(pos[1], 0), ok: false, errorKind: 'abandoned', error: 'no result' }]);
  assert.equal(s.debugState().antigravity.orphans, 1);
});

test('pairing: unreadable tool_calls (cut by the truncation) show no tool, skip result lines until the next closer, never final', () => {
  const { s, b } = mk({ format: 'truncated' });
  const cut = { ...b.planner({ content: 'Writing the file.' }), tool_calls: '[{"name":"write_to_file","args":{"TargetFile":"\\"/Users/agt' };
  const steps = [b.userInput(), cut, b.result(), b.result(), b.planner({ calls: [call.listDir()] }), b.result()];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.equal(s.debugState().endTurnArmed, false);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(pos[4], 0)]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok]), [[tid(pos[4], 0), true]]);
  assert.equal(s.debugState().antigravity.orphans, 0, 'swallowed results are not orphans');
  assert.doesNotMatch(JSON.stringify(evs), /agt/);
});

// ---------------------------------------------------------------------------------------------- turn end

test('end_turn: a final say followed by END_TURN_IDLE_MS of quiet ends the turn, once', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result(), b.planner({ content: 'Done.' })]);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS - 1), []);
  assert.deepEqual(noTs(s.idle(clock.t + END_TURN_IDLE_MS)), [{ type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' }]);
  assert.deepEqual(s.idle(clock.t + 10 * END_TURN_IDLE_MS), [], 'once');
  assert.equal(s.ended, false, 'a main never idles out by itself');
});

test('end_turn: work after a final say disarms it; a USER_INPUT before the quiet time ends the turn next_turn', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ content: 'Done?' }), b.planner({ thinking: 'Not yet.', calls: [call.listDir()] })]);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS * 2), [], 'disarmed by the next planner line');
  const evs = run(s, [b.result(), b.planner({ content: 'Now done.' }), b.userInput('Next task')]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn']);
  assert.deepEqual(s.idle(clock.t + END_TURN_IDLE_MS * 2), [], 'the new turn has no final say yet');
});

test('end_turn on attach: a replayed final say older than the quiet time ends at the first idle()', () => {
  const { s, b, clock } = mk();
  assert.deepEqual(run(s, [b.userInput(), b.planner({ content: 'Done.' })], { replay: true }), []);
  assert.deepEqual(noTs(s.idle(clock.t)), [{ type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' }]);
});

test('setInfo status idle: ends an armed turn at once; ignored when not armed or while calls wait; running changes nothing', () => {
  const { s, b } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.viewFile()] })]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'calls are running');
  s.setInfo({ status: 'running' }); // an idle read early is remembered (finding 7, test/antigravity-fixes.test.mjs); running forgets it
  run(s, [b.result(), b.planner({ content: 'Done.' })]);
  assert.deepEqual(s.setInfo({ status: 'running' }), []);
  assert.deepEqual(noTs(s.setInfo({ status: 'idle' })), [{ type: 'turn_end', sessionId: AG_ID, reason: 'end_turn' }]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'the turn is closed');
  run(s, [b.userInput('Again'), b.planner({ thinking: 'Working.' })]);
  assert.deepEqual(s.setInfo({ status: 'idle' }), [], 'no final say: a stale status never cuts a working turn');
});

// ---------------------------------------------------------------------------------------------- metadata (setInfo)

test('setInfo: title, branch and the workspace cwd go to the core; the workspace beats the run_command Cwd of the replay', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.runCommand('npm test', '/work/ag-repo/packages/api')] }), b.runResult()], { replay: true });
  assert.equal(s.firstCwd, null, 'the Cwd is only remembered during the replay');
  s.setInfo({ title: 'Login fix', cwd: WORK, branch: 'feat/login', status: 'running' });
  s.idle(clock.t);
  const ev = s.sessionEvent();
  assert.equal(s.firstCwd, WORK);
  assert.equal(ev.project, WORK);
  assert.equal(ev.projectLabel, 'ag-repo');
  assert.equal(ev.title, 'Login fix');
  assert.equal(ev.branch, 'feat/login');
});

test('cwd fallback: with no workspace, the first absolute run_command Cwd is applied when the replay ends (first idle)', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput(), b.planner({ calls: [call.runCommand('ls', 'relative/dir'), call.runCommand('ls', WORK)] }),
    b.runResult(), b.runResult(), b.planner({ calls: [call.runCommand('ls', '/work/other')] })], { replay: true });
  assert.equal(s.firstCwd, null);
  assert.equal(s.debugState().antigravity.cwdFallback, true);
  const evs = s.idle(clock.t);
  assert.equal(s.firstCwd, WORK, 'the first absolute Cwd, not a later one');
  assert.equal(of(evs, 'session').at(-1).project, WORK);
  assert.ok(s.lastActivityMs < clock.t, 'applied without growth: an old turn can still end at this idle()');
});

test('cwd fallback live: after the replay the first Cwd applies at once while no cwd is known; the session event comes first', () => {
  const { s, b } = mk();
  s.idle(SERVER_T); // attach of an empty file: the replay ended without any Cwd
  const evs = run(s, [b.userInput(), b.planner({ calls: [call.viewFile(), call.runCommand('npm test', WORK)] })]);
  const i = evs.findIndex((e) => e.type === 'session' && e.project === WORK);
  assert.ok(i >= 0 && i < evs.findIndex((e) => e.type === 'tool_start'), 'the moved session event precedes the line\'s tools');
  run(s, [b.runResult(), b.runResult(), b.planner({ calls: [call.runCommand('ls', '/work/elsewhere')] })]);
  assert.equal(s.firstCwd, WORK);
  s.setInfo({ cwd: '/work/late-workspace' });
  assert.equal(s.firstCwd, WORK, 'the floor stays on the first cwd (4.4)');
  const json = JSON.stringify(evs.filter((e) => e.type !== 'session'));
  assert.doesNotMatch(json, /ag-repo/, 'the Cwd is never part of a tool summary');
});

test('setInfo tasks: a plan with source tasks; the same list is not sent again; an empty list only clears a board it filled', () => {
  const { s, b, clock } = mk();
  run(s, [b.userInput()], { replay: true });
  const tasks = [{ content: 'Read the auth module', status: 'completed' }, { content: 'Fix /Users/agtester/x/token.ts', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' }];
  assert.deepEqual(s.setInfo({ tasks }), [], 'before the replay ends: state only');
  s.idle(clock.t);
  const plan = s.snapshotEvents().find((e) => e.type === 'plan');
  assert.deepEqual(plan.items, [{ content: 'Read the auth module', status: 'completed' },
    { content: 'Fix token.ts', status: 'in_progress' }, { content: 'Run the tests', status: 'pending' }]);
  assert.equal(plan.source, 'tasks');
  assert.deepEqual(s.setInfo({ tasks }), [], 'identical tasks snapshot');
  const next = s.setInfo({ tasks: tasks.map((t) => ({ ...t, status: 'completed' })) });
  assert.deepEqual(of(next, 'plan').map((e) => e.items.map((it) => it.status)), [['completed', 'completed', 'completed']]);
  assert.deepEqual(of(s.setInfo({ tasks: [] }), 'plan').map((e) => e.items), [[]], 'cleared');
  const { s: s2 } = mk();
  s2.idle(SERVER_T);
  assert.deepEqual(of(s2.setInfo({ tasks: [] }), 'plan'), [], 'an empty checklist never shown is not sent');
  assert.deepEqual(s2.setInfo(null), []);
});

// ---------------------------------------------------------------------------------------------- rooms and snapshot

test('schedule: its tool_start has the lounge room hint, live and in the snapshot (ADAPTERS 6.2)', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.schedule()] })];
  const pos = linePositions(steps);
  const start = of(run(s, steps), 'tool_start');
  assert.deepEqual(noTs(start), [{ type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[1], 0), tool: 'schedule', summary: 'schedule', room: 'lounge' }]);
  assert.equal(s.snapshotEvents().find((e) => e.type === 'tool_start').room, 'lounge');
  run(s, [b.result({ status: 'RUNNING' })]);
  assert.equal(s.snapshotEvents().some((e) => e.type === 'tool_start'), false);
  assert.equal(s.debugState().antigravity.pending.length, 0);
});

test('snapshot: open tools with their ask fields; a closed tool is gone', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.askQuestion(), call.mcp()] })];
  const pos = linePositions(steps);
  run(s, steps);
  const snap = noTs(s.snapshotEvents());
  assert.deepEqual(snap.slice(1), [
    { type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[1], 0), tool: 'ask_question', summary: 'ask_question', room: 'desk',
      question: 'Which database should the session store use?', options: ['Postgres', 'SQLite', 'Redis'] },
    { type: 'tool_start', sessionId: AG_ID, toolUseId: tid(pos[1], 1), tool: 'mcp__github__get_issue', summary: 'get issue' },
  ]);
  run(s, [b.result({ type: 'ASK_QUESTION' })]);
  assert.deepEqual(s.snapshotEvents().slice(1).map((e) => e.toolUseId), [tid(pos[1], 1)]);
});

test('malformed input: non-step lines are counted in skipped and never throw', () => {
  const { s } = mk();
  for (const bad of [null, 42, [], {}, { type: 'X Y' }, { type: 'PLANNER_RESPONSE', tool_calls: 7 }]) assert.doesNotThrow(() => s.apply(bad));
  assert.equal(s.skipped, 5);
  assert.deepEqual(s.debugState().antigravity.pending, []);
  assert.doesNotThrow(() => s.setInfo('x'));
  assert.doesNotThrow(() => s.idle(NaN));
});

// ---------------------------------------------------------------------------------------------- long mixed scenario


test('long mixed scenario: replay-mode state equals live-mode state, in both transcript formats', () => {
  for (const format of ['full', 'truncated']) {
    const replay = mk({ format });
    const steps = mixedSteps(replay.b);
    assert.deepEqual(run(replay.s, steps, { replay: true }), [], `${format}: replay returns nothing`);
    replay.s.idle(SERVER_T);
    const lv = mk({ format });
    const evs = run(lv.s, mixedSteps(lv.b));
    lv.s.idle(SERVER_T);
    assert.deepEqual(replay.s.snapshotEvents(), lv.s.snapshotEvents(), format);
    assert.deepEqual(replay.s.debugState(), lv.s.debugState(), format);
    assert.equal(replay.s.firstCwd, WORK);
    const d = lv.s.debugState();
    assert.equal(d.open.length, 3, `${format}: the unknown tool, command_status and manage_task still wait`);
    assert.equal(d.antigravity.orphans, 0);
    assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['next_turn', 'next_turn']);
    assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug', 'Now ask me about the store', 'One more']);
    assert.deepEqual(of(evs, 'system').map((e) => e.kind), ['api_error', 'compact']);
    const ends = of(evs, 'tool_end');
    assert.equal(of(evs, 'tool_start').length, 17, `${format}: list_permissions is hidden`);
    assert.deepEqual(ends.map((e) => e.errorKind ?? 'ok'), [
      'ok', 'ok', 'ok', 'failed', 'ok', 'ok', 'ok', 'abandoned', 'ok', 'failed', 'ok', 'ok', 'ok', 'ok',
    ]);
    assert.equal(of(evs, 'tool_start').find((e) => e.tool === 'schedule').room, 'lounge');
    assert.doesNotMatch(JSON.stringify([evs, lv.s.snapshotEvents(), lv.s.debugState()]), BAIT_RE, `${format}: privacy`);
  }
});
