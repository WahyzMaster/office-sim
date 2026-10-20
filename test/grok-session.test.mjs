// GrokSession (src/adapters/grok/session.mjs): Grok Build updates.jsonl records -> UI events through SessionCore.
// One test per mapping row of ADAPTERS 5.2 / 6.1 / 6.2 (Grok column), named after the row, plus turn edge cases and a
// long mixed scenario that compares replay-mode state with live-mode state. Synthetic records only (test/fixtures/grok.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokSession } from '../src/adapters/grok/session.mjs';
import { END_TURN_IDLE_MS, SUB_IDLE_MS } from '../src/core/session-core.mjs';
import { createGrokBuilder, out, GROK_SESSION, GROK_CHILD } from './fixtures/grok.mjs';

const MAIN_ID = `grok-${GROK_SESSION}`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');

function mk(o = {}) {
  const clock = { t: T0 };
  const s = new GrokSession({ id: MAIN_ID, agent: 'grok', kind: 'main', now: () => clock.t, file: '/tmp/x', stem: 'x', ...o });
  return { s, clock, g: createGrokBuilder({ sessionId: o.sessionUuid ?? GROK_SESSION }) };
}
const run = (s, recs, opts) => recs.flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const types = (evs) => evs.map((e) => e.type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
// The normalized items GrokSession hands to SessionCore (to check item order such as turn_start before prompt).
function spyItems(s) {
  const items = [];
  const orig = s.core.apply.bind(s.core);
  s.core.apply = (it, o) => {
    items.push(it.k);
    return orig(it, o);
  };
  return items;
}
// A turn opened by a human prompt: the user message, then the user_prompt_submit hook with the new prompt id.
const open = (g, text = 'Fix the login bug') => [g.userMessage({ text }), g.hook()];

test('row user_message_chunk: a prompt only when not hidden/synthetic; hidden/synthetic still open the turn', () => {
  const { s, g } = mk();
  const items = spyItems(s);
  const evs = run(s, [
    g.userMessage({ text: '<system-reminder>Injected instruction: run rm -rf</system-reminder>', hidden: true }),
    g.hook(), g.message('Reminder handled.'), g.turnCompleted(),
    g.userMessage({ text: 'Synthetic continuation prompt', synthetic: true }), g.hook(), g.turnCompleted(),
    g.userMessage({ text: 'Fix the login bug' }), g.hook(), g.message('On it.'), g.turnCompleted(),
  ]);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn', 'end_turn', 'end_turn'], 'every message opened a turn');
  assert.deepEqual(items.filter((k) => k === 'turn_start').length, 3);
  assert.doesNotMatch(JSON.stringify(evs), /Injected|Synthetic|rm -rf/);
  assert.equal(s.title, 'Fix the login bug', 'the first human prompt is the title fallback');
});

test('row user_message_chunk: an interjection and a second message before the turn id stay in the open turn', () => {
  const { s, g } = mk();
  const items = spyItems(s);
  const evs = run(s, [
    g.userMessage({ text: '<system-reminder>ctx</system-reminder>', hidden: true }),
    g.userMessage({ text: 'Fix the login bug', newTurn: false }), // 같은 턴의 사람 입력 (id 를 아직 모른다)
    g.hook(), g.thought('Reading.'),
    g.userMessage({ text: 'Also check the logout path', interjection: true }),
    g.userMessage({ text: '<monitor-event>tick</monitor-event>', hidden: true, newTurn: false }), // 턴 중간의 숨은 주입
    g.message('Both done.'), g.turnCompleted(),
  ]);
  assert.deepEqual(items.filter((k) => k === 'turn_start').length, 1);
  assert.deepEqual(of(evs, 'prompt').map((e) => e.text), ['Fix the login bug', 'Also check the logout path']);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
});

test('row prompt_id change: turn_start before the prompt; a new promptId without a user message is a new turn', () => {
  const { s, g } = mk();
  const items = spyItems(s);
  const first = run(s, [g.userMessage({ text: 'First task' }), g.hook(), g.thought('Working.')]);
  assert.deepEqual(items, ['turn_start', 'prompt', 'thinking'], 'the user message sends turn_start, then its prompt');
  assert.deepEqual(types(first), ['session', 'prompt', 'session', 'thinking']);
  // 앞 턴이 끝나지 않았는데 새 사람 입력: 앞 턴은 next_turn 으로 닫히고, 그 뒤에 새 prompt
  const second = run(s, [g.userMessage({ text: 'Second task' })]);
  assert.deepEqual(types(second), ['turn_end', 'prompt']);
  assert.equal(second[0].reason, 'next_turn');
  // user message 없이 새 promptId (숨은 턴 시작이 기록에 없을 때): prompt_id 가 바뀌면 새 턴
  run(s, [g.hook(), g.thought('Second.')]);
  g.newPrompt();
  const third = run(s, [g.thought('A third turn without a user message.')]);
  assert.deepEqual(types(third), ['turn_end', 'thinking']);
  assert.equal(third[0].reason, 'next_turn');
  assert.equal(s.debugState().grok.turnId, g.promptId);
});

test('row agent_message_chunk: one say per chunk; a say never arms the 20 s idle fallback, turn_completed ends the turn (finding 1)', () => {
  const { s, g, clock } = mk();
  let evs = run(s, [...open(g), g.message('Let me check the tests first.'),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' } })]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text), ['Let me check the tests first.']);
  clock.t += END_TURN_IDLE_MS + 1000;
  assert.deepEqual(s.idle(clock.t), [], 'a say followed by a tool is not final');
  run(s, [g.toolDone({ output: out.bash() })]);
  // 도구가 하나도 열려 있지 않을 때의 말 뒤에 21 초 넘게 조용하다 (긴 write 의 인자를 만드는 중): 턴은 끝나지 않는다
  evs = run(s, [g.message('Now writing the new module.')]);
  assert.deepEqual(types(evs), ['say']);
  clock.t += END_TURN_IDLE_MS + 1000;
  assert.deepEqual(s.idle(clock.t), [], 'no turn_end while the agent is still working');
  assert.equal(s.debugState().endTurnArmed, false);
  // say -> todo_write (숨김) -> plan 뒤에도 마찬가지
  run(s, [g.message('Updating the board.'), g.toolCall({ name: 'todo_write', input: { merge: true, todos: [] } }),
    g.plan([{ content: 'Write it', status: 'in_progress' }]), g.toolDone({ output: out.todos() })]);
  clock.t += END_TURN_IDLE_MS * 2;
  assert.deepEqual(s.idle(clock.t), []);
  evs = run(s, [g.toolCall({ name: 'write', input: { file_path: '/w/repo/new.ts', content: 'x' } }), g.toolDone({ output: out.edits() }),
    g.message('All tests pass.'), g.turnCompleted()]);
  clock.t += END_TURN_IDLE_MS * 3;
  const ends = of([...evs, ...s.idle(clock.t)], 'turn_end');
  assert.deepEqual(ends.map((e) => e.reason), ['end_turn'], 'exactly one turn_end, from turn_completed');
});

test('row agent_message_chunk: each chunk is a whole segment and its own say, never glued to the previous one (findings 2, 7)', () => {
  const { s, g } = mk();
  run(s, open(g));
  const evs = run(s, [g.message('I read the file.'), g.message('/Users/someone/clients/acme-secret/plan.md is next'),
    g.message('Mail ops@example.com'), g.message('file:///Users/someone/clients/acme-secret/notes.txt holds it'), g.message('')]);
  assert.deepEqual(of(evs, 'say').map((e) => e.text),
    ['I read the file.', 'plan.md is next', 'Mail (email)', 'notes.txt holds it'], 'scrubbed one segment at a time');
  assert.doesNotMatch(JSON.stringify(evs), /someone|acme-secret|clients|ops@/);
  // a long say past the 100-char cap is still one event per record
  const capped = run(s, [g.thought('Planning.'), g.message('x'.repeat(120)), g.message('A second whole segment.')]);
  assert.deepEqual(of(capped, 'say').map((e) => e.text.slice(0, 24)), ['x'.repeat(24), 'A second whole segment.']);
});

test('row agent_thought_chunk: thinking with the first sentence and durationMs null; back-to-back segments are separate (finding 2)', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.thought('I should read /Users/someone/work/repo/src/login.ts first. Then patch it.')]);
  const [th] = of(evs, 'thinking');
  assert.deepEqual([th.text, th.durationMs], ['I should read login.ts first.', null]);
  // 바로 이어진 두 번째 생각 조각은 따로 선 추론 요약이다: 제 첫 문장으로 따로 나간다 (앞 조각에 붙이지 않는다)
  assert.deepEqual(of(run(s, [g.thought(' And more.')]), 'thinking').map((e) => e.text), ['And more.']);
  const two = run(s, [g.thought('I should read the router first. Then patch it.'), g.thought('Now running the unit tests.'),
    g.thought('Now running the unit tests.')]);
  assert.deepEqual(of(two, 'thinking').map((e) => e.text),
    ['I should read the router first.', 'Now running the unit tests.', 'Now running the unit tests.']);
});

test('row tool_call/tool_call_update: paired by toolCallId, name from x.ai/tool (never title); a status-less update ends nothing', () => {
  const { s, g } = mk();
  run(s, open(g));
  const a = g.toolCall({ name: 'read_file', title: 'Read /Users/someone/TITLE-BAIT.txt', input: { target_file: '/w/repo/a.ts' } });
  const aId = g.lastToolId;
  const b = g.toolCall({ name: 'grep', input: { pattern: 'login', path: '/w/repo/src' } });
  const bId = g.lastToolId;
  let evs = run(s, [a, b, g.toolInput({ id: aId, input: { target_file: '/w/repo/a.ts' } })]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.toolUseId, e.tool, e.summary, e.room]),
    [[aId, 'read_file', 'a.ts', 'archive'], [bId, 'grep', 'login · src', 'archive']]);
  assert.equal(of(evs, 'tool_end').length, 0, 'the first update only repeats rawInput');
  evs = run(s, [g.toolDone({ id: bId, output: out.grep() }), g.toolDone({ id: aId, output: out.readFile() }),
    g.toolDone({ id: aId, output: out.readFile() }), g.toolDone({ id: 'call-unknown', output: out.readFile() })]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok]), [[bId, true], [aId, true]], 'out of order, once each');
  assert.doesNotMatch(JSON.stringify(evs), /TITLE-BAIT/);
  assert.deepEqual(s.debugState().open, []);
});

test('row descriptor: only allowed rawInput fields reach the events (paths, command, url, query, mcp name)', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'rm -rf /Users/someone/work --no-preserve-root', description: 'DESC-BAIT', timeout: 5 } }),
    g.toolDone({ output: out.bash({ output: 'OUTPUT-BAIT' }) }),
    g.toolCall({ name: 'search_replace', input: { file_path: '/Users/someone/work/repo/src/auth.ts', old_string: 'OLD-BAIT', new_string: 'NEW-BAIT' } }),
    g.toolDone({ output: out.edits(), content: [{ type: 'diff', path: '/Users/someone/x', oldText: 'OLD-BAIT', newText: 'NEW-BAIT' }] }),
    g.toolCall({ name: 'write', input: { file_path: '/Users/someone/work/repo/new.ts', content: 'CONTENT-BAIT' } }),
    g.toolCall({ name: 'web_fetch', input: { url: 'https://docs.example.com/page?token=QUERY-BAIT' } }),
    g.toolCall({ name: 'use_tool', input: { tool_name: 'github__create_issue', tool_input: { body: 'INPUT-BAIT' } } }),
    g.toolDone({ output: out.mcp({ output: 'MCP-BODY-BAIT' }) }),
    g.toolCall({ name: 'spawn_subagent', input: { prompt: 'PROMPT-BAIT', description: 'SPAWN-DESC-BAIT', subagent_type: 'explore' } }),
    g.toolCall({ name: 'ask_user_question', input: { questions: [{ question: 'Pick one', options: [{ label: 'A', description: 'OPT-DESC-BAIT' }] }] } }),
    g.toolDone({ output: out.answered('ANSWER-BAIT') }),
  ]);
  const starts = of(evs, 'tool_start');
  assert.deepEqual(starts.map((e) => e.summary), ['rm', 'auth.ts', 'new.ts', 'docs.example.com', 'create issue', 'explore', 'ask_user_question']);
  assert.equal(starts[4].tool, 'mcp__github__create_issue');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|\/Users\/someone|no-preserve-root|token=/);
});

test('row completed with a non-zero shell exit code: failed (only the exit code), zero stays ok', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test' } }), g.toolDone({ output: out.bash({ exitCode: 1, output: 'FAIL secret=1' }) }),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'npm run lint' } }), g.toolDone({ output: out.bash({ exitCode: 0 }) }),
  ]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.ok, e.errorKind, e.error]), [[false, 'failed', 'Exit code 1'], [true, undefined, undefined]]);
});

test('row failed without rawOutput plus the fixed denial phrases: denied; with rawOutput: failed', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'rm -rf build' } }), g.toolDenied(),
    g.toolCall({ name: 'use_tool', input: { tool_name: 'db__drop' } }), g.toolDenied({ text: 'Tool use_tool was not executed: Denied by permission policy' }),
    g.toolCall({ name: 'write', input: { file_path: '/w/a.ts' } }), g.toolDenied({ text: 'Hook denied: BLOCKED: writes to /Users/someone/secret' }),
    g.toolCall({ name: 'run_terminal_command', input: { command: 'make' } }), g.toolDenied({ text: 'User rejected the execution for tool make' }),
    g.toolCall({ name: 'read_file', input: { target_file: '/w/missing.ts' } }), g.toolDone({ status: 'failed', output: out.fileNotFound() }),
  ]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.errorKind, e.error]), [
    ['denied', 'Tool run_terminal_command was not executed: Auto mode blocked this action'],
    ['denied', 'Tool use_tool was not executed: Denied by permission policy'],
    ['denied', 'Hook denied'],
    ['denied', 'User rejected the execution'],
    ['failed', 'FileNotFound'],
  ]);
  assert.doesNotMatch(JSON.stringify(evs), /someone|secret/);
});

test('row turn_completed cancelled: open tools interrupted, then turn_end interrupt; late updates change nothing', () => {
  const { s, g } = mk();
  run(s, [...open(g), g.toolCall({ name: 'read_file', input: { target_file: '/w/a.ts' } }), g.toolDone({ output: out.readFile() })]);
  const t1 = g.toolCall({ name: 'run_terminal_command', input: { command: 'sleep 100' } });
  const id1 = g.lastToolId;
  const t2 = g.toolCall({ name: 'grep', input: { pattern: 'x' } });
  const id2 = g.lastToolId;
  const evs = run(s, [t1, t2, g.turnCompleted({ stopReason: 'cancelled', cancelTrigger: 'esc' })]);
  assert.deepEqual(noTs(evs.slice(2)), [
    { type: 'tool_end', sessionId: MAIN_ID, toolUseId: id1, ok: false, errorKind: 'interrupted', error: 'interrupted' },
    { type: 'tool_end', sessionId: MAIN_ID, toolUseId: id2, ok: false, errorKind: 'interrupted', error: 'interrupted' },
    { type: 'turn_end', sessionId: MAIN_ID, reason: 'interrupt' },
  ]);
  // 끝난 턴 뒤에 늦게 온 갱신과 생각 조각 (research: 7건): 턴을 다시 열지 않는다
  const late = run(s, [g.toolDone({ id: id1, output: out.bash() }), g.thought('Late thought.'), g.message('Late text.')]);
  assert.deepEqual(late, []);
  assert.equal(s.debugState().grok.late, 2);
  const next = run(s, [...open(g, 'Next task'), g.turnCompleted()]);
  assert.deepEqual(types(next), ['prompt', 'turn_end'], 'no phantom turn_end before the next prompt');
});

test('row turn_completed end_turn / error: turn_end end_turn, api_error (with one system api_error)', () => {
  const { s, g } = mk();
  let evs = run(s, [...open(g), g.message('Done.'), g.turnCompleted()]);
  assert.deepEqual(of(evs, 'turn_end').map((e) => e.reason), ['end_turn']);
  evs = run(s, [...open(g, 'Again'), g.thought('Trying.'), g.turnCompleted({ stopReason: 'error' })]);
  assert.deepEqual(types(evs.slice(-2)), ['system', 'turn_end']);
  assert.deepEqual([evs.at(-2).kind, evs.at(-2).text, evs.at(-1).reason], ['api_error', 'API error', 'api_error']);
  evs = run(s, [...open(g, 'Third'), g.retry({ type: 'failed', message: 'Upstream returned 500' }), g.turnCompleted({ stopReason: 'error' })]);
  assert.deepEqual(of(evs, 'system').map((e) => e.text), ['Upstream returned 500'], 'the retry failure already said it');
  assert.deepEqual(run(s, [g.turnCompleted()]), [], 'a repeated turn_completed is a no-op');
  assert.deepEqual(run(s, [g.turnCompleted({ promptId: 'prompt-unknown' })]), []);
});

test('row plan record: the full list as an update_plan plan event (cancelled entries completed)', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.plan([{ content: 'Read /Users/someone/work/repo/src/a.ts', status: 'completed' },
    { content: 'Dropped step', status: 'completed', cancelled: true }, { content: 'Fix it', status: 'in_progress' },
    { content: 'Test', status: 'pending' }])]);
  const [p] = of(evs, 'plan');
  assert.equal(p.source, 'update_plan');
  assert.deepEqual(p.items, [{ content: 'Read a.ts', status: 'completed' }, { content: 'Dropped step', status: 'completed' },
    { content: 'Fix it', status: 'in_progress' }, { content: 'Test', status: 'pending' }]);
  const again = run(s, [g.plan([{ content: 'Fix it', status: 'completed' }])]);
  assert.deepEqual(of(again, 'plan')[0].items, [{ content: 'Fix it', status: 'completed' }], 'a full replace');
  assert.equal(s.snapshotEvents().filter((e) => e.type === 'plan').length, 1);
});

test('row todo_write: hidden (no tool_start / tool_end), the plan record updates the board', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g),
    g.toolCall({ name: 'todo_write', input: { merge: true, todos: [{ id: '1', content: 'TODO-BAIT', status: 'completed' }] } }),
    g.plan([{ content: 'Step one', status: 'completed' }]), g.toolDone({ output: out.todos() }),
    g.toolCall({ name: 'enter_plan_mode', input: {} }), g.toolDone({ output: out.enteredPlan() }),
    g.toolCall({ name: 'search_tool', input: { query: 'github' } }), g.toolDone({ output: { type: 'SearchTool' } }),
  ]);
  assert.deepEqual(types(evs.filter((e) => e.type !== 'session')), ['prompt', 'plan']);
  assert.doesNotMatch(JSON.stringify(evs), /TODO-BAIT/);
  // a cancel while a hidden call is pending: nothing for it, only the turn_end
  const cancel = run(s, [g.toolCall({ name: 'todo_write', input: { merge: true, todos: [] } }), g.turnCompleted({ stopReason: 'cancelled' })]);
  assert.deepEqual(noTs(cancel), [{ type: 'turn_end', sessionId: MAIN_ID, reason: 'interrupt' }]);
});

test('row exit_plan_mode: plan markdown then the ask (R34 order); approved plan shown at PlanReady, revise -> denied', () => {
  const { s, g } = mk();
  // rawInput 에 계획이 있으면 (앞으로의 형식) 질문보다 먼저
  let evs = run(s, [...open(g), g.toolCall({ name: 'exit_plan_mode', input: { plan: '# Plan\n- Read code\n- Fix bug' } })]);
  assert.deepEqual(types(evs).slice(-2), ['plan', 'tool_start']);
  assert.deepEqual([evs.at(-2).source, evs.at(-2).items.map((i) => i.content)], ['exit_plan', ['Plan', 'Read code', 'Fix bug']]);
  assert.deepEqual([evs.at(-1).room, evs.at(-1).question, evs.at(-1).options], ['desk', '이 계획대로 진행할까요?', ['승인', '수정 요청']]);
  assert.deepEqual(types(s.snapshotEvents()), ['session', 'plan', 'tool_start'], 'the board and the question wait together');
  // 연구에서 본 형식: rawInput {} , 승인되면 PlanReady.plan_content 가 판을 채운 뒤 ok
  evs = run(s, [g.toolDone({ output: out.planReady('# Plan\n- Read code\n- Fix bug') }),
    g.toolCall({ name: 'exit_plan_mode', input: {} }), g.toolDone({ output: out.planReady('# New plan\n- Ship it') })]);
  assert.deepEqual(types(evs), ['tool_end', 'tool_start', 'plan', 'tool_end'], 'the same plan is not re-sent; a new one before ok');
  assert.deepEqual(evs[2].items.map((i) => i.content), ['New plan', 'Ship it']);
  evs = run(s, [g.toolCall({ name: 'exit_plan_mode', input: {} }), g.toolDone({ text: 'The user wants to revise the plan: FEEDBACK-BAIT' })]);
  assert.deepEqual([evs[1].errorKind, evs[1].error], ['denied', 'User asked to revise the plan']);
  assert.doesNotMatch(JSON.stringify(evs), /FEEDBACK-BAIT/);
});

test('row ask_user_question: ask tool_start with question (+N) and option labels, ended by its answer', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.toolCall({ name: 'ask_user_question', input: { questions: [
    { question: 'Which database should we use?', options: [{ label: 'Postgres', description: 'd1' }, { label: 'SQLite', description: 'd2' }] },
    { question: 'Second question?', options: [{ label: 'Yes', description: 'd3' }] }] } })]);
  const [ask] = of(evs, 'tool_start');
  assert.deepEqual([ask.tool, ask.room, ask.question, ask.options], ['ask_user_question', 'desk', 'Which database should we use? (+1)', ['Postgres', 'SQLite']]);
  assert.deepEqual(s.snapshotEvents().at(-1).question, ask.question, 'an open ask is in the snapshot with its fields');
  const [end] = run(s, [g.toolDone({ output: out.answered('ANSWER-BAIT') })]);
  assert.deepEqual([end.type, end.ok], ['tool_end', true]);
});

test('row spawn_subagent: ok as soon as the child is launched (async, R28), in either order', () => {
  const { s, g } = mk();
  run(s, open(g));
  // 1) subagent_spawned 가 먼저 (research 52/62): 그때 ok, 뒤의 completed 는 아무것도 아니다
  let evs = run(s, [g.toolCall({ name: 'spawn_subagent', input: { prompt: 'p', description: 'd', subagent_type: 'explore' } })]);
  const id1 = g.lastToolId;
  assert.deepEqual([evs[0].type, evs[0].summary, evs[0].room], ['tool_start', 'explore', 'here']);
  evs = run(s, [g.subagentSpawned(), g.toolDone({ id: id1, output: out.text('Spawned child') })]);
  assert.deepEqual(noTs(evs), [{ type: 'tool_end', sessionId: MAIN_ID, toolUseId: id1, ok: true }]);
  // 2) completed 가 먼저 (10/62): ok, 뒤의 subagent_spawned 는 아무것도 아니다
  evs = run(s, [g.toolCall({ name: 'spawn_subagent', input: { subagent_type: 'general-purpose' } }), g.toolDone({ output: out.text('x') }),
    g.subagentSpawned({ child: '0198f0a0-0000-7000-8000-00000000c0c2' })]);
  assert.deepEqual(types(evs), ['tool_start', 'tool_end']);
  assert.equal(evs[1].ok, true);
  // the turn does not wait for the child
  assert.deepEqual(types(run(s, [g.message('Waiting for the explorer.'), g.turnCompleted()])), ['say', 'turn_end']);
});

test('row subagent_finished: a sub_end hint for the child (Store.endCharacter), never an event; replay keeps hints', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.subagentFinished({ status: 'cancelled' })]);
  const hints = evs.filter((e) => e.hint !== undefined);
  assert.deepEqual(hints, [{ hint: 'end', charId: `grok-${GROK_CHILD}`, reason: 'done' }]);
  const { s: r, g: g2 } = mk();
  assert.deepEqual(run(r, [...open(g2), g2.subagentFinished()], { replay: true }), [{ hint: 'end', charId: `grok-${GROK_CHILD}`, reason: 'done' }]);
  assert.deepEqual(run(r, [g2.subagentFinished({ child: '../../etc' })]), [], 'an id that cannot be a D2 id is skipped');
});

test('row auto_compact_started: system compact (auto_compact_completed and checkpoints yield nothing)', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.compactStarted(), g.compactCompleted()]);
  assert.deepEqual(of(evs, 'system').map((e) => [e.kind, e.text]), [['compact', 'Conversation compacted']]);
});

test('row retry_state: system api_error (retrying with attempt/max, failed with its first line)', () => {
  const { s, g } = mk();
  const evs = run(s, [...open(g), g.retry({ attempt: 2, maxRetries: 5, errorType: 'http' }),
    g.retry({ type: 'failed', message: 'Request to https://api.example.com/v1?key=SECRET failed\nTrace' })]);
  assert.deepEqual(of(evs, 'system').map((e) => [e.kind, e.text]),
    [['api_error', 'API 재시도 2/5 (http)'], ['api_error', 'Request to api.example.com failed']]);
});

test('row unknown kinds: ignored (no events, not counted as malformed)', () => {
  const { s, g } = mk();
  run(s, open(g));
  const evs = run(s, [g.unknown('model_changed'), g.unknown('session_ended', {}), g.modeUpdate('plan'), g.sessionRecap('Recap: RECAP-BAIT'),
    g.taskBackgrounded(), g.hook({ event: 'stop' }), g.unknown('tool_call_delta_chunk', { toolCallId: 'x', delta: 'y' })]);
  assert.deepEqual(evs, []);
  assert.equal(s.skipped, 0);
  assert.deepEqual(run(s, [{ type: 'user', message: {} }, { method: 'nope', params: {} }, 'x', null]), []);
  assert.equal(s.skipped, 4, 'non-Grok lines are counted and change nothing');
});

test('row file order wins over timestamps (R12)', () => {
  const { s, g } = mk();
  const recs = [...open(g), g.thought('First.'), g.message('Second.'), g.turnCompleted()];
  recs[2].timestamp += 3600; // 생각 조각의 시각이 뒤의 기록보다 늦다
  recs[2].params._meta.agentTimestampMs += 3_600_000;
  recs[3].timestamp -= 3600;
  const evs = run(s, recs);
  assert.deepEqual(types(evs).filter((t) => t !== 'session'), ['prompt', 'thinking', 'say', 'turn_end']);
  assert.equal(evs.find((e) => e.type === 'thinking').ts > evs.find((e) => e.type === 'say').ts, true, 'ts kept, order not sorted');
});

test('records of another session id are skipped (R10 analog); sub sessions emit no prompt and no turn events', () => {
  const { s, g } = mk();
  const other = createGrokBuilder({ sessionId: '0198f0a0-ffff-7fff-8fff-ffffffffffff' });
  assert.deepEqual(run(s, [other.userMessage({ text: 'Not mine' }), other.hook(), other.message('No.')]), []);
  assert.equal(run(s, open(g)).some((e) => e.type === 'prompt'), true);

  const clock = { t: T0 };
  const sub = new GrokSession({ id: `grok-${GROK_CHILD}`, kind: 'sub', parentId: MAIN_ID, now: () => clock.t });
  const c = createGrokBuilder({ sessionId: GROK_CHILD });
  const evs = run(sub, [c.hook({ event: 'session_start' }), c.userMessage({ text: 'Task from the parent: TASK-BAIT' }), c.hook(),
    c.toolCall({ name: 'read_file', input: { target_file: '/w/a.ts' } }), c.toolDone({ output: out.readFile() }), c.message('Found it.'),
    c.turnCompleted()]);
  assert.deepEqual(types(evs), ['session', 'tool_start', 'tool_end', 'say']);
  assert.deepEqual([evs[0].isSubagent, evs[0].parentSessionId], [true, MAIN_ID]);
  assert.doesNotMatch(JSON.stringify(evs), /TASK-BAIT/);
  clock.t += SUB_IDLE_MS + 1;
  assert.deepEqual(types(sub.idle(clock.t)), ['session_end']);
});

test('setInfo (summary.json sidecar) and SessionLike getters pass through to the core', () => {
  const { s, g } = mk();
  run(s, open(g));
  const [ev] = s.setInfo({ title: 'Login fix', cwd: '/Users/someone/work/repo', branch: 'feat/login' });
  assert.deepEqual([ev.type, ev.title, ev.project, ev.projectLabel, ev.branch], ['session', 'Login fix', '/Users/someone/work/repo', 'repo', 'feat/login']);
  assert.deepEqual(s.setInfo({ title: 'Login fix' }), [], 'unchanged info emits nothing');
  assert.equal(s.title, 'Login fix');
  assert.equal(s.firstCwd, '/Users/someone/work/repo');
  assert.equal(s.ended, false);
  assert.ok(s.lastActivityMs > 0);
  assert.equal(s.sessionEvent().agent, 'grok');
});

// ------------------------------------------------------------------------------------------------ mixed scenario

function scenario() {
  const g = createGrokBuilder();
  const recs = [];
  const add = (...r) => recs.push(...r);
  add(g.hook({ event: 'session_start' }));
  // turn 1: hidden reminder + human prompt, thinking, parallel tools (out of order), a failing shell command, a plan
  add(g.userMessage({ text: '<system-reminder>Read AGENTS.md</system-reminder>', hidden: true }),
    g.userMessage({ text: 'Fix the login bug in /Users/someone/work/repo', newTurn: false }), g.hook(), g.thought('Let me look. First the tests.'));
  add(g.toolCall({ name: 'read_file', input: { target_file: '/Users/someone/work/repo/src/login.ts' } }));
  const read1 = g.lastToolId;
  add(g.toolCall({ name: 'grep', input: { pattern: 'session', path: '/Users/someone/work/repo/src' } }));
  const grep1 = g.lastToolId;
  add(g.toolInput({ id: read1, input: { target_file: '/Users/someone/work/repo/src/login.ts' } }),
    g.toolDone({ id: grep1, output: out.grep() }), g.toolDone({ id: read1, output: out.readFile() }));
  add(g.toolCall({ name: 'todo_write', input: { merge: false, todos: [{ id: '1', content: 'Fix', status: 'in_progress' }] } }),
    g.plan([{ content: 'Find the bug', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }]), g.toolDone({ output: out.todos() }));
  add(g.message('Running the tests.'), g.toolCall({ name: 'run_terminal_command', input: { command: 'npm test -- --grep login' } }),
    g.toolDone({ output: out.bash({ exitCode: 1, output: 'AssertionError: secret' }) }));
  add(g.retry({ attempt: 1, maxRetries: 3 }), g.toolCall({ name: 'search_replace', input: { file_path: '/Users/someone/work/repo/src/login.ts', old_string: 'a', new_string: 'b' } }),
    g.toolDone({ output: out.edits() }), g.message('Fixed the token check.'), g.turnCompleted(), g.hook({ event: 'stop' }), g.sessionRecap());
  // turn 2: background dev server, a denial, an MCP call, a subagent, an interjection, then a cancel with open tools
  add(g.userMessage({ text: 'Now start the dev server and file an issue' }), g.hook());
  add(g.toolCall({ name: 'run_terminal_command', input: { command: 'npm run dev', background: true } }), g.toolDone({ output: out.background() }),
    g.taskBackgrounded());
  add(g.toolCall({ name: 'run_terminal_command', input: { command: 'rm -rf node_modules' } }), g.toolDenied());
  add(g.toolCall({ name: 'use_tool', input: { tool_name: 'github__create_issue', tool_input: { title: 'secret' } } }),
    g.toolDone({ output: out.mcp({ output: 'created' }) }));
  add(g.toolCall({ name: 'spawn_subagent', input: { prompt: 'Explore', description: 'Explore', subagent_type: 'explore' } }), g.subagentSpawned(),
    g.toolDone({ output: out.text('Spawned') }));
  add(g.userMessage({ text: 'Also update the README', interjection: true }), g.thought('Noted.'), g.compactStarted(), g.compactCompleted());
  add(g.toolCall({ name: 'monitor', input: { command: 'tail -f /Users/someone/work/repo/dev.log' } }), g.toolDone({ output: out.monitor() }));
  add(g.toolCall({ name: 'web_fetch', input: { url: 'https://docs.example.com/api?key=1' } }));
  add(g.toolCall({ name: 'run_terminal_command', input: { command: 'npm run build' } }));
  const build2 = g.lastToolId;
  add(g.turnCompleted({ stopReason: 'cancelled', cancelTrigger: 'send_now' }), g.toolDone({ id: build2, output: out.bash() }), g.thought('Late.'));
  // turn 3: a monitor event opens a hidden turn; the child finishes; plan mode with an approved plan, then an ask
  add(g.userMessage({ text: '<monitor-event>build done</monitor-event>', hidden: true, synthetic: true }), g.hook(), g.subagentFinished());
  add(g.toolCall({ name: 'enter_plan_mode', input: {} }), g.toolDone({ output: out.enteredPlan() }), g.modeUpdate('plan'),
    g.toolCall({ name: 'exit_plan_mode', input: {} }), g.toolDone({ output: out.planReady('# Plan\n- Update README\n- Release') }),
    g.toolCall({ name: 'ask_user_question', input: { questions: [{ question: 'Release now?', options: [{ label: 'Yes', description: 'x' }, { label: 'Later', description: 'y' }] }] } }));
  // turn 4 starts without a user message (new promptId) while the ask is open; it errors
  g.newPrompt();
  add(g.thought('Continuing.'), g.retry({ type: 'failed', message: 'Upstream 500' }), g.turnCompleted({ stopReason: 'error' }));
  // turn 5: a plain end_turn with an open tool left for the snapshot
  add(g.userMessage({ text: 'Try once more' }), g.hook(), g.message('Checking.'), g.toolCall({ name: 'list_dir', input: { target_directory: '/Users/someone/work/repo' } }),
    g.unknown('model_auto_switched', { to: 'grok-4.7' }));
  return recs;
}

const strip = (evs) => JSON.parse(JSON.stringify(evs, (k, v) => (k === 'ts' ? undefined : v)));

test('mixed scenario: replay state == live state (also when replay stops mid-file and the rest is tailed live)', () => {
  const recs = scenario();
  const live = mk().s;
  const liveEvs = run(live, recs);
  const replay = mk().s;
  const replayEvs = run(replay, recs, { replay: true });
  assert.ok(replayEvs.every((e) => e.hint === 'end'), 'replay returns hint items only');
  assert.equal(replayEvs.length, 1);
  assert.deepEqual(replay.debugState(), live.debugState());
  assert.deepEqual(strip(replay.snapshotEvents()), strip(live.snapshotEvents()));
  for (const cut of [1, 7, 19, 33, 47, 60, recs.length - 2]) {
    const s = mk().s;
    run(s, recs.slice(0, cut), { replay: true });
    run(s, recs.slice(cut));
    assert.deepEqual(s.debugState(), live.debugState(), `cut at ${cut}`);
    assert.deepEqual(strip(s.snapshotEvents()), strip(live.snapshotEvents()), `cut at ${cut}`);
  }
  assert.equal(live.skipped, 0);
  assert.equal(live.debugState().grok.late, 1, 'the late thought after the cancel');
});

test('mixed scenario: the live stream (turns, tool pairs, statuses) and no privacy bait', () => {
  const { s } = mk();
  const evs = run(s, scenario());
  const ev = evs.filter((e) => e.hint === undefined);
  assert.deepEqual(of(ev, 'prompt').map((e) => e.text),
    ['Fix the login bug in repo', 'Now start the dev server and file an issue', 'Also update the README', 'Try once more']);
  assert.deepEqual(of(ev, 'turn_end').map((e) => e.reason), ['end_turn', 'interrupt', 'next_turn', 'api_error']);
  const starts = new Map(of(ev, 'tool_start').map((e) => [e.toolUseId, e]));
  for (const e of of(ev, 'tool_end')) assert.ok(starts.has(e.toolUseId), 'every tool_end has an earlier tool_start');
  const ends = of(ev, 'tool_end').map((e) => `${starts.get(e.toolUseId).tool}:${e.ok ? 'ok' : e.errorKind}`);
  assert.deepEqual(ends, [
    'grep:ok', 'read_file:ok', 'run_terminal_command:failed', 'search_replace:ok',
    'run_terminal_command:ok', 'run_terminal_command:denied', 'mcp__github__create_issue:ok', 'spawn_subagent:ok', 'monitor:ok',
    'web_fetch:interrupted', 'run_terminal_command:interrupted',
    'exit_plan_mode:ok', 'ask_user_question:abandoned',
  ]);
  assert.deepEqual(of(ev, 'plan').map((e) => e.source), ['update_plan', 'exit_plan']);
  assert.deepEqual(of(ev, 'system').map((e) => e.kind), ['api_error', 'compact', 'api_error']);
  assert.deepEqual(evs.filter((e) => e.hint !== undefined), [{ hint: 'end', charId: `grok-${GROK_CHILD}`, reason: 'done' }]);
  assert.deepEqual(types(s.snapshotEvents()), ['session', 'plan', 'tool_start'], 'the open list_dir call');
  assert.doesNotMatch(JSON.stringify(evs), /\/Users\/someone|secret|AGENTS|monitor-event|system-reminder|key=|rm -rf|node_modules|AssertionError/);
});
