// Grok record helpers (src/adapters/grok/records.mjs): envelope, tool table, end status, plan, retry, child ids.
// Synthetic records from test/fixtures/grok.mjs shaped like docs/research/grok-format.json; no file system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecord, recordMs, contentText, firstContentLine, userMessageOf, toolNameOf, xaiKindOf, toolStartOf, toolEndOf,
  denialLine, bashExitCode, planItemsOf, turnReasonOf, retrySystem, childIdOf, HIDDEN_TOOLS,
} from '../src/adapters/grok/records.mjs';
import { toolSummary } from '../src/core/tool-summary.mjs';
import { EXIT_PLAN_QUESTION, EXIT_PLAN_OPTIONS } from '../src/session-util.mjs';
import { createGrokBuilder, out, textContent, GROK_SESSION, GROK_CHILD } from './fixtures/grok.mjs';

const upd = (rec) => rec.params.update;
const start = (rec) => {
  const u = upd(rec);
  return toolStartOf(toolNameOf(u), u.rawInput, xaiKindOf(u));
};
const startOf = (name, input) => start(createGrokBuilder().toolCall({ name, input }));
const endOf = (name, o) => {
  const g = createGrokBuilder();
  g.toolCall({ name });
  return toolEndOf(name, upd(g.toolDone(o)));
};

test('envelope: both methods parse; promptId from _meta (ACP) or hook prompt_id; seconds timestamp -> ms', () => {
  const g = createGrokBuilder();
  const um = parseRecord(g.userMessage({ text: 'hi' }));
  assert.equal(um.kind, 'user_message_chunk');
  assert.equal(um.promptId, null, 'the user message carries no promptId (research)');
  assert.equal(um.sessionId, GROK_SESSION);
  const hook = parseRecord(g.hook());
  assert.equal(hook.kind, 'hook_execution');
  assert.equal(hook.promptId, g.promptId, 'hook_execution.prompt_id is the turn id');
  const th = g.thought('x');
  const p = parseRecord(th);
  assert.equal(p.promptId, g.promptId);
  assert.equal(p.ms, th.timestamp * 1000);
  assert.equal(parseRecord(g.turnCompleted()).promptId, null, 'turn_completed is read by the session, not here');
});

test('envelope: a non-Grok line (Claude record, wrong method, no update kind) is null', () => {
  assert.equal(parseRecord({ type: 'user', message: { role: 'user', content: 'x' }, sessionId: 's' }), null);
  assert.equal(parseRecord({ method: 'session/request_permission', params: { update: { sessionUpdate: 'x' } } }), null);
  assert.equal(parseRecord({ method: 'session/update', params: { update: { text: 'x' } } }), null);
  assert.equal(parseRecord({ method: 'session/update', params: null }), null);
  assert.equal(parseRecord([1, 2]), null);
  assert.equal(parseRecord(null), null);
});

test('recordMs: seconds, ms tolerated, agentTimestampMs fallback, junk -> null', () => {
  assert.equal(recordMs({ timestamp: 1792486800 }), 1792486800000);
  assert.equal(recordMs({ timestamp: 1792486800.5 }), 1792486800500);
  assert.equal(recordMs({ timestamp: 1792486800123 }), 1792486800123);
  assert.equal(recordMs({}, { agentTimestampMs: 1792486800999 }), 1792486800999);
  assert.equal(recordMs({ timestamp: 'x' }, { agentTimestampMs: 'y' }), null);
  assert.equal(recordMs({ timestamp: -5 }), null);
  assert.equal(recordMs({ timestamp: Infinity }), null);
});

test('text: content block or list; first content line of tool_call_update content', () => {
  assert.equal(contentText({ type: 'text', text: 'a' }), 'a');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(contentText({ type: 'image', data: 'x' }), null);
  assert.equal(contentText('raw'), null);
  assert.equal(firstContentLine(textContent('\n  first\nsecond')), 'first');
  assert.equal(firstContentLine([{ type: 'diff', path: '/a', oldText: 'x', newText: 'y' }]), '');
  assert.equal(firstContentLine(null), '');
});

test('user message flags: hideFromScrollback / syntheticPrompt -> hidden, interjection kept', () => {
  const g = createGrokBuilder();
  assert.deepEqual(userMessageOf(upd(g.userMessage({ text: 'hi' }))), { text: 'hi', hidden: false, interjection: false, indexed: true });
  assert.equal(userMessageOf(upd(g.userMessage({ text: 'typed mid-turn', promptIndex: null }))).indexed, false, 'no promptIndex');
  assert.equal(userMessageOf(upd(g.userMessage({ text: '<system-reminder>x', hidden: true }))).hidden, true);
  assert.equal(userMessageOf(upd(g.userMessage({ text: 'go', synthetic: true }))).hidden, true);
  assert.equal(userMessageOf(upd(g.userMessage({ text: 'also this', interjection: true }))).interjection, true);
});

test('tool name: x.ai/tool name, never title; server web search by rawInput.backend; else null', () => {
  const g = createGrokBuilder();
  const r = upd(g.toolCall({ name: 'read_file', title: 'Read /Users/someone/secret.txt', input: { target_file: '/a/b.txt' } }));
  assert.equal(toolNameOf(r), 'read_file');
  assert.equal(xaiKindOf(r), 'read');
  assert.equal(toolNameOf(upd(g.toolCall({ name: null, input: { backend: 'x', variant: 'y' } }))), 'web_search');
  assert.equal(toolNameOf({ title: 'run_terminal_command', rawInput: {} }), null, 'title is never a name');
  assert.equal(toolNameOf({ _meta: { 'x.ai/tool': { name: 'has space /x' } } }), null);
});

// ADAPTERS 6.2 (Grok column): the room every tool lands in, through the shared tool-summary.
test('room table (ADAPTERS 6.2 Grok column)', () => {
  const room = (name, input = {}) => toolSummary(startOf(name, input).desc).room;
  assert.equal(room('read_file', { target_file: '/w/a.ts' }), 'archive');
  assert.equal(room('grep', { pattern: 'TODO', path: '/w/src' }), 'archive');
  assert.equal(room('list_dir', { target_directory: '/w/src' }), 'archive');
  assert.equal(room('search_replace', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }), 'dev');
  assert.equal(room('write', { file_path: '/w/a.ts', content: 'x' }), 'dev');
  assert.equal(room('run_terminal_command', { command: 'npm test' }), 'server');
  assert.equal(room('run_terminal_command', { command: 'grep -rn foo .' }), 'archive', 'program-name rule');
  assert.equal(room('run_terminal_command', { command: 'curl https://example.com/x?q=1' }), 'research');
  assert.equal(room('monitor', { command: 'tail -f log.txt' }), 'archive');
  assert.equal(room('get_command_or_subagent_output', { task_ids: ['t1'] }), 'server');
  assert.equal(room('kill_command_or_subagent', { task_id: 't1' }), 'server');
  assert.equal(room('web_fetch', { url: 'https://docs.example.com/a?b=c' }), 'research');
  assert.equal(toolSummary(start(createGrokBuilder().toolCall({ name: null, input: { backend: 'b', variant: 'v' } })).desc).room, 'research');
  assert.equal(room('use_tool', { tool_name: 'github__get_issue' }), undefined, 'MCP: no hint, the page classifies mcp__ names');
  assert.equal(room('use_tool', { file: '/w/call.json' }), 'research', 'use_tool without a name');
  assert.equal(room('ask_user_question', { questions: [] }), 'desk');
  assert.equal(room('exit_plan_mode', {}), 'desk');
  assert.equal(room('spawn_subagent', { prompt: 'p', description: 'd', subagent_type: 'explore' }), 'here');
  assert.equal(room('scheduler_list', {}), 'here');
  assert.equal(room('some_future_tool', {}), 'here', 'an unknown tool stays here');
  for (const name of ['todo_write', 'enter_plan_mode', 'search_tool']) assert.deepEqual(startOf(name, { todos: [] }), { hidden: true }, name);
  assert.deepEqual([...HIDDEN_TOOLS].sort(), ['enter_plan_mode', 'search_tool', 'todo_write']);
});

test('tool table: summaries from the allowed fields only (basename, program, host, query, mcp name)', () => {
  const sum = (name, input) => toolSummary(startOf(name, input).desc);
  assert.equal(sum('read_file', { target_file: '/Users/someone/work/repo/src/login.ts', offset: 3, limit: 9 }).summary, 'login.ts');
  assert.equal(sum('list_dir', { target_directory: '/Users/someone/work/repo/src' }).summary, 'src');
  assert.equal(sum('grep', { pattern: 'TODO', path: '/Users/someone/work/repo/src' }).summary, 'TODO · src');
  assert.equal(sum('run_terminal_command', { command: 'git push --force origin main', description: 'Push it' }).summary, 'git push');
  assert.equal(sum('web_fetch', { url: 'https://docs.example.com/a/b?token=1' }).summary, 'docs.example.com');
  const mcp = sum('use_tool', { tool_name: 'github__get_issue', tool_input: { body: 'secret' } });
  assert.deepEqual([mcp.tool, mcp.summary], ['mcp__github__get_issue', 'get issue']);
  assert.equal(sum('use_tool', { tool_name: '3f2a9c1e-1111-4222-8333-444455556666__list' }).tool, 'mcp__00000000-0000-0000-0000-000000000000__list');
  assert.equal(sum('use_tool', { tool_name: 'plainname' }).tool, 'mcp__plainname');
  assert.equal(sum('spawn_subagent', { prompt: 'Read every secret', description: 'Sweep rm -rf', subagent_type: 'explore' }).summary, 'explore');
  const bg = startOf('run_terminal_command', { command: 'npm run dev', background: true });
  assert.equal(bg.desc.background, true);
  assert.equal(startOf('monitor', { command: 'tail -f x' }).desc.background, true, 'monitors are background tasks');
  assert.equal(startOf('run_terminal_command', { command: 'ls' }).desc.background, undefined);
  assert.deepEqual(startOf('some_future_tool', { path: '/x' }), { desc: { tool: 'some_future_tool', kind: 'other' } });
  const unknownRead = start(createGrokBuilder().toolCall({ name: 'read_file', input: {} }));
  assert.equal(unknownRead.desc.kind, 'read');
});

test('tool table: descriptors carry no other rawInput field', () => {
  const bait = {
    target_file: '/Users/someone/a.txt', file_path: '/Users/someone/b.txt', target_directory: '/Users/someone/dir',
    pattern: 'needle', path: '/Users/someone/p', command: 'echo hi', url: 'https://h.example.com/p?q=1', tool_name: 's__t',
    description: 'DESC-BAIT', prompt: 'PROMPT-BAIT', content: 'CONTENT-BAIT', old_string: 'OLD-BAIT', new_string: 'NEW-BAIT',
    tool_input: { k: 'INPUT-BAIT' }, todos: [{ content: 'TODO-BAIT' }], timeout: 9, glob: 'GLOB-BAIT', subagent_type: 'explore',
  };
  const allowed = new Set(['tool', 'kind', 'path', 'query', 'command', 'url', 'mcpServer', 'mcpTool', 'description', 'background']);
  for (const name of ['read_file', 'list_dir', 'search_replace', 'write', 'grep', 'run_terminal_command', 'monitor', 'web_fetch',
    'use_tool', 'spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent', 'scheduler_list', 'exit_plan_mode']) {
    const s = startOf(name, bait);
    for (const k of Object.keys(s.desc)) assert.ok(allowed.has(k), `${name}: ${k}`);
    assert.doesNotMatch(JSON.stringify(s), /BAIT/, name);
  }
});

test('ask tools: ask_user_question questions (labels only); exit_plan_mode fixed question, plan only from rawInput.plan', () => {
  const ask = startOf('ask_user_question', {
    questions: [{ question: 'Which DB?', options: [{ label: 'Postgres', description: 'DESC-BAIT' }, { label: 'SQLite', description: 'x' }] },
      { question: 'Second?', options: [] }],
  });
  assert.equal(ask.desc.kind, 'ask');
  assert.deepEqual(ask.questions[0], { question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] });
  assert.equal(ask.questions.length, 2);
  assert.doesNotMatch(JSON.stringify(ask), /DESC-BAIT/);
  const exit = startOf('exit_plan_mode', {});
  assert.deepEqual([exit.question, exit.options, exit.markdown], [EXIT_PLAN_QUESTION, EXIT_PLAN_OPTIONS, undefined]);
  assert.equal(startOf('exit_plan_mode', { plan: '# P\n- a' }).markdown, '# P\n- a');
});

test('tool end: completed -> ok; a status-less update -> null (the first update only repeats rawInput)', () => {
  assert.deepEqual(endOf('read_file', { output: out.readFile() }), { status: 'ok' });
  assert.deepEqual(endOf('grep', { output: out.grep({ exitCode: 1 }) }), { status: 'ok' }, 'grep exit 1 is not a shell failure');
  const g = createGrokBuilder();
  g.toolCall({ name: 'read_file' });
  assert.equal(toolEndOf('read_file', upd(g.toolInput({ input: { target_file: '/a' } }))), null);
  assert.equal(toolEndOf('read_file', { status: 'in_progress' }), null);
  assert.equal(toolEndOf('read_file', null), null);
});

test('tool end: completed Bash with a non-zero exit code -> failed with only the exit code', () => {
  assert.deepEqual(endOf('run_terminal_command', { output: out.bash({ exitCode: 2, output: 'secret token=abc' }) }),
    { status: 'failed', errorLine: 'Exit code 2' });
  assert.deepEqual(endOf('run_terminal_command', { output: out.bash({ exitCode: 0 }) }), { status: 'ok' });
  assert.equal(bashExitCode(out.bash({ exitCode: 127 })), 127);
  assert.equal(bashExitCode({ type: 'Bash', exit_code: 3 }), 3, 'a flat payload is read too');
  assert.equal(bashExitCode(out.grep({ exitCode: 1 })), null);
});

test('tool end: background launch -> ok + background; spawn_subagent completed -> ok', () => {
  assert.deepEqual(endOf('run_terminal_command', { output: out.background() }), { status: 'ok', background: true });
  assert.deepEqual(endOf('spawn_subagent', { output: out.text('Spawned 0198f0a0-9e8d-7c6b-8a59-fedcba987654') }), { status: 'ok' });
  assert.deepEqual(endOf('spawn_subagent', {}), { status: 'ok' });
});

test('tool end: failed with rawOutput -> failed with error/message, exit code or the variant name, never a body', () => {
  assert.deepEqual(endOf('read_file', { status: 'failed', output: out.fileNotFound() }), { status: 'failed', errorLine: 'FileNotFound' });
  assert.deepEqual(endOf('search_replace', { status: 'failed', output: out.noMatch() }), { status: 'failed', errorLine: 'NoMatchesFound' });
  assert.deepEqual(endOf('read_file', { status: 'failed', output: { type: 'ReadFile', ReadFile: { type: 'IsADirectory', path: '/x' } } }),
    { status: 'failed', errorLine: 'IsADirectory' });
  assert.deepEqual(endOf('use_tool', { status: 'failed', output: out.error('rate_limited', 'Too many requests') }),
    { status: 'failed', errorLine: 'rate_limited' });
  assert.deepEqual(endOf('use_tool', { status: 'failed', output: out.mcp({ isError: true, output: 'BODY-BAIT' }) }),
    { status: 'failed', errorLine: 'MCP tool error' });
  assert.deepEqual(endOf('run_terminal_command', { status: 'failed', output: out.bash({ exitCode: 1, output: 'BODY-BAIT' }) }),
    { status: 'failed', errorLine: 'Exit code 1' });
  assert.deepEqual(endOf('web_fetch', { status: 'failed', output: { type: 'WebFetch', WebFetch: { body: 'BODY-BAIT' } } }), { status: 'failed' });
});

test('tool end: failed without rawOutput + the fixed denial phrases -> denied with a fixed line', () => {
  const denied = (text, name = 'run_terminal_command') => endOf(name, { status: 'failed', text });
  assert.deepEqual(denied('Tool run_terminal_command was not executed: Auto mode blocked this action because rm -rf'),
    { status: 'denied', errorLine: 'Tool run_terminal_command was not executed: Auto mode blocked this action' });
  assert.deepEqual(denied('Tool use_tool was not executed: Denied by permission policy (rule 3)', 'use_tool'),
    { status: 'denied', errorLine: 'Tool use_tool was not executed: Denied by permission policy' });
  assert.deepEqual(denied('Tool x was not executed: something else /Users/someone/secret'),
    { status: 'denied', errorLine: 'Tool run_terminal_command was not executed' });
  assert.deepEqual(denied('Hook denied: BLOCKED: rm -rf /Users/someone'), { status: 'denied', errorLine: 'Hook denied' });
  assert.deepEqual(denied('User rejected the execution for tool run_terminal_command'), { status: 'denied', errorLine: 'User rejected the execution' });
  assert.deepEqual(denied('Rejected: file edits are not allowed in plan mode', 'write'),
    { status: 'denied', errorLine: 'Rejected: file edits are not allowed in plan mode' });
  assert.deepEqual(denied('Rejected: other reason here'), { status: 'denied', errorLine: 'Rejected' });
  assert.deepEqual(denied('Something broke: /Users/someone/x'), { status: 'failed' }, 'no phrase: failed, the text is not kept');
  assert.deepEqual(endOf('read_file', { status: 'failed' }), { status: 'failed' });
  assert.equal(denialLine('', 'x'), null);
  assert.equal(denialLine('Tool a was not executed: Auto mode blocked this action', 'bad name/..'), 'Tool tool was not executed: Auto mode blocked this action');
  assert.equal(denialLine('Hook denied: x', '..:'), 'Hook denied');
  assert.equal(denialLine('Tool a was not executed: Denied by permission policy', 'a.b:c'), 'Tool tool was not executed: Denied by permission policy');
});

test('tool end: exit_plan_mode PlanReady -> ok + the approved plan; completed without rawOutput -> denied (revise/abandon)', () => {
  assert.deepEqual(endOf('exit_plan_mode', { output: out.planReady('# P\n- One') }), { status: 'ok', markdown: '# P\n- One' });
  assert.deepEqual(endOf('exit_plan_mode', { text: 'The user wants to revise the plan: FEEDBACK-BAIT' }),
    { status: 'denied', errorLine: 'User asked to revise the plan' });
  assert.deepEqual(endOf('exit_plan_mode', { text: 'The user chose to abandon the plan.' }), { status: 'denied', errorLine: 'User abandoned the plan' });
  assert.deepEqual(endOf('exit_plan_mode', {}), { status: 'denied', errorLine: 'Plan not approved' });
  assert.deepEqual(endOf('exit_plan_mode', { output: out.text('x') }), { status: 'ok' });
  assert.deepEqual(endOf('ask_user_question', { output: out.answered('ANSWER-BAIT') }), { status: 'ok' });
});

test('plan entries: full list, cancelled -> completed, non-array -> null', () => {
  const g = createGrokBuilder();
  const items = planItemsOf(upd(g.plan([{ content: 'A', status: 'pending' }, { content: 'B', status: 'completed', cancelled: true },
    { content: 'C', status: 'in_progress' }])));
  assert.deepEqual(items, [{ content: 'A', status: 'pending' }, { content: 'B', status: 'completed' }, { content: 'C', status: 'in_progress' }]);
  assert.deepEqual(planItemsOf({ entries: [{ content: 'x', status: 'cancelled' }, 'junk', { status: 'pending' }] }),
    [{ content: 'x', status: 'completed' }, { content: '', status: 'pending' }]);
  assert.equal(planItemsOf({ entries: 'x' }), null);
});

test('turn reasons, retry text, child ids', () => {
  assert.deepEqual(['end_turn', 'cancelled', 'error', 'max_tokens', undefined].map(turnReasonOf),
    ['end_turn', 'interrupt', 'api_error', 'end_turn', 'end_turn']);
  const g = createGrokBuilder();
  assert.deepEqual(retrySystem(upd(g.retry({ attempt: 2, maxRetries: 5, errorType: 'api' }))), { kind: 'api_error', text: 'API 재시도 2/5 (api)' });
  assert.deepEqual(retrySystem({ type: 'retrying', error_type: 'Bad Type!' }), { kind: 'api_error', text: 'API 재시도 ?/?' });
  assert.deepEqual(retrySystem(upd(g.retry({ type: 'failed', message: 'Upstream 500\nstack' }))), { kind: 'api_error', text: 'Upstream 500' });
  assert.deepEqual(retrySystem({ type: 'failed' }), { kind: 'api_error', text: 'API error' });
  assert.equal(retrySystem({ type: 'other' }), null);
  assert.equal(childIdOf(upd(g.subagentFinished())), `grok-${GROK_CHILD}`);
  assert.equal(childIdOf({ subagent_id: 'abc' }, 'grok'), 'grok-abc');
  assert.equal(childIdOf({ child_session_id: '../x' }), null);
  assert.equal(childIdOf({ child_session_id: 'a'.repeat(59) }), null, 'the D2 id must stay within 64 chars');
});
