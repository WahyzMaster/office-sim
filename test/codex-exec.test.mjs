// Codex code-mode `exec` (src/adapters/codex/exec.mjs, ADAPTERS 6.3, D10 b/c): the outer tool from the first
// tools.<name> identifier, a short visit per inner item_completed item while the exec is open, the exec output as the
// outer end, and tools.update_plan inside scripts not shown. Pure helpers first, then through CodexSession.
// Synthetic records only (test/fixtures/codex.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_SKIP, INNER_ITEM_TYPES, scriptToolNames, firstScriptTool, execStartOf, execEndOf, innerVisitOf,
} from '../src/adapters/codex/exec.mjs';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { toolSummary } from '../src/core/tool-summary.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';
import { createCodexBuilder, out, CODEX_THREAD } from './fixtures/codex.mjs';

const MAIN_ID = `codex-${CODEX_THREAD}`;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const shown = (start) => toolSummary({ tool: start.tool, ...start.desc });
const itemOf = (rec) => rec.payload.item;

function mk() {
  const clock = { t: T0 };
  const s = new CodexSession({ id: MAIN_ID, agent: 'codex', kind: 'main', now: () => clock.t });
  const g = createCodexBuilder();
  return { s, g, clock };
}
const run = (s, recs, opts) => recs.flat().flatMap((r) => s.apply(r, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const opening = (g) => [g.sessionMeta(), g.taskStarted(), g.userMessage('Fix the login bug')];

// ---------------------------------------------------------------------------------------------- pure helpers

test('scriptToolNames: tools.<name> identifiers in order, outside strings and comments, never arguments', () => {
  const script = [
    '// tools.BAIT_IN_COMMENT()',
    '/* tools.BAIT_IN_BLOCK */',
    'const s = "tools.BAIT_IN_STRING"; const t = \'tools.BAIT_SINGLE\'; const u = `tools.BAIT_TEMPLATE`;',
    'const r = await tools.exec_command({ cmd: "rm -rf /Users/bait-user BAIT_SCRIPT_ARG" });',
    'await tools ?. apply_patch({ input: "*** Begin Patch" });',
    'obj.tools.not_this(); mytools.nor_this();',
    'await tools["bracket_name"]({});',
    'await tools.\n  view_image({ path: "/x.png" });',
  ].join('\n');
  assert.deepEqual(scriptToolNames(script), ['exec_command', 'apply_patch', 'view_image']);
  assert.deepEqual(scriptToolNames(''), []);
  assert.deepEqual(scriptToolNames(null), []);
  assert.deepEqual(scriptToolNames('"unterminated\nawait tools.exec_command({})'), [],
    'a line break inside a quote is not JavaScript: the scanner lost track, so nothing it read is trusted');
});

test('scriptToolNames: regex literals and template expressions keep the string state right (no string text as a tool name)', () => {
  // a quote inside a regex literal must not open a string: the later string literal stays a string
  assert.deepEqual(scriptToolNames('const t = s.replace(/"/g, "\'");\nconst x = "tools.BAIT_AFTER_REGEX";\nawait tools.exec_command({});'),
    ['exec_command']);
  assert.deepEqual(scriptToolNames("const q = /'/.test(s); const y = 'tools.BAIT_SINGLE'; await tools.apply_patch('x');"), ['apply_patch']);
  assert.deepEqual(scriptToolNames('const r = /tools.BAIT_IN_REGEX/; await tools.view_image({});'), ['view_image'], 'a regex is not code');
  assert.deepEqual(scriptToolNames('const r = /[/"]tools.BAIT_CLASS/g; await tools.view_image({});'), ['view_image'], 'a / inside a class');
  assert.deepEqual(scriptToolNames('const r = /\\/"/; const s = "tools.BAIT_ESC"; await tools.view_image({});'), ['view_image'], 'escaped /');
  assert.deepEqual(scriptToolNames('if (ok) return /"/.test(s);\nconst s = "tools.BAIT_KEYWORD";\nawait tools.exec_command({});'),
    ['exec_command'], 'a regex after a keyword');
  // division is not a regex: a / b / c, x[1] / 2, (a) / 2
  assert.deepEqual(scriptToolNames('const n = a / b / c; const m = x[1] / 2 + (y) / 3; await tools.exec_command({});'), ['exec_command']);
  // template expressions are code, template text is not; a quote or backtick inside ${} does not end the template
  assert.deepEqual(scriptToolNames('const t = `tools.BAIT_TEXT ${"`"} tools.BAIT_TEXT2`; await tools.exec_command({});'), ['exec_command']);
  assert.deepEqual(scriptToolNames('const t = `a ${await tools.view_image({ path: `x ${"tools.BAIT_NESTED"}` })} b`;'), ['view_image']);
  assert.deepEqual(scriptToolNames('const t = `${ { a: 1 }.a } tools.BAIT_AFTER_BRACES`; await tools.apply_patch("x");'), ['apply_patch']);
  // safety: a scan that ends inside an unterminated literal or comment does not trust what it read before
  assert.deepEqual(scriptToolNames('const r = /"; await tools.BAIT_OPEN_REGEX();'), [], 'an unterminated regex');
  assert.deepEqual(scriptToolNames('await tools.BAIT_BEFORE(); const t = `never closed tools.BAIT_TEMPLATE'), [], 'an unterminated template');
  assert.deepEqual(scriptToolNames('await tools.BAIT_BEFORE(); /* never closed tools.BAIT_COMMENT'), [], 'an unterminated block comment');
});

test('firstScriptTool: update_plan (D10c) and plumbing never decide the summary', () => {
  assert.equal(firstScriptTool('await tools.update_plan({ plan: [] }); await tools.write_stdin({}); await tools.apply_patch("x")'), 'apply_patch');
  assert.equal(firstScriptTool('await tools.update_plan({ plan: [{ step: "BAIT_PLAN_STEP" }] })'), null);
  for (const n of ['update_plan', 'write_stdin', 'wait', 'tool_search']) assert.ok(SCRIPT_SKIP.has(n), n);
});

test('row code-mode exec start: the outer exec tool takes its summary and room from the first script tool', () => {
  const cases = [
    ['await tools.exec_command({ cmd: "npm test" })', { tool: 'exec', summary: 'exec_command', room: 'server' }],
    ['await tools.apply_patch("*** Begin Patch")', { tool: 'exec', summary: 'apply_patch', room: 'dev' }],
    ['await tools.view_image({ path: "/Users/bait-user/x.png" })', { tool: 'exec', summary: 'view_image', room: 'archive' }],
    ['await tools.mcp__github__get_issue({ n: 1 })', { tool: 'exec', summary: 'mcp__github__get_issue', room: 'research' }],
    ['await tools.spawn_agent({ message: "BAIT_SUB_TASK" })', { tool: 'exec', summary: 'spawn_agent', room: 'here' }],
    ['await tools.brand_new({ x: 1 })', { tool: 'exec', summary: 'brand_new', room: 'here' }],
    ['console.log("no tools here")', { tool: 'exec', summary: 'exec', room: 'here' }],
  ];
  for (const [script, want] of cases) assert.deepEqual(shown(execStartOf(script)), want, script);
  const uuid = '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c'.replace(/-/g, '_');
  assert.doesNotMatch(shown(execStartOf(`await tools.mcp__${uuid}__x({})`)).summary, /3f2a9c4e/, 'connector-uuid-like servers are masked');
});

test('row code-mode exec end: Script failed / error -> failed, aborted -> interrupted, anything else printed -> ok', () => {
  assert.deepEqual(execEndOf(out.script()), { status: 'ok' });
  assert.deepEqual(execEndOf(out.scriptFailed()), { status: 'failed', errorLine: 'Script failed' });
  assert.deepEqual(execEndOf(out.scriptError()), { status: 'failed', errorLine: 'Script error' });
  assert.deepEqual(execEndOf(out.script('aborted by user after 2s')), { status: 'interrupted', errorLine: 'Aborted by user' });
  assert.deepEqual(execEndOf(out.script('Exit code: 1\nProcess exited with code 2')), { status: 'ok' },
    'a script that prints a command result is not judged by it (the inner items carry their own status)');
  assert.deepEqual(execEndOf(out.image()), { status: 'ok' });
});

test('row inner CommandExecution: program from parsed_cmd[0], else the -lc script; exit code -> failed', () => {
  const g = createCodexBuilder();
  const v = innerVisitOf(itemOf(g.commandItem({ script: 'cd /Users/bait-user/proj && rg -n BAIT_ARG src', parsed: 'rg -n BAIT_ARG src' })));
  assert.deepEqual(shown(v.start), { tool: 'exec_command', summary: 'rg', room: 'archive' });
  assert.deepEqual(v.end, { status: 'ok' });
  const noParsed = innerVisitOf(itemOf(g.commandItem({ script: 'npm test -- --token=BAIT_QUERY_TOKEN', parsed: null, exitCode: 1 })));
  assert.deepEqual(shown(noParsed.start), { tool: 'exec_command', summary: 'npm test', room: 'server' });
  assert.deepEqual(noParsed.end, { status: 'failed', errorLine: 'Exit code 1' });
  const declined = innerVisitOf({ ...itemOf(g.commandItem()), status: 'declined' });
  assert.deepEqual(declined.end, { status: 'denied', errorLine: 'Command declined' });
  const failedNoCode = innerVisitOf({ ...itemOf(g.commandItem()), status: 'failed', exit_code: null });
  assert.deepEqual(failedNoCode.end, { status: 'failed', errorLine: 'Command failed' });
  assert.doesNotMatch(JSON.stringify([v, noParsed].map((x) => shown(x.start))), /BAIT|bait/);
});

test('row inner FileChange / McpToolCall / WebSearch / ImageView: basenames, MCP names, host or query', () => {
  const g = createCodexBuilder();
  const fc = innerVisitOf(itemOf(g.fileChangeItem({ paths: ['/Users/bait-user/proj/a.ts', '/Users/bait-user/proj/b.ts'] })));
  assert.deepEqual(shown(fc.start), { tool: 'apply_patch', summary: 'a.ts (+1)', room: 'dev' });
  assert.deepEqual(innerVisitOf(itemOf(g.fileChangeItem({ status: 'failed' }))).end, { status: 'failed', errorLine: 'Patch failed' });
  assert.deepEqual(innerVisitOf(itemOf(g.fileChangeItem({ status: 'declined' }))).end, { status: 'denied', errorLine: 'Patch declined' });
  const mcp = innerVisitOf(itemOf(g.mcpItem({ server: 'codegraph', tool: 'codegraph_search' })));
  assert.equal(shown(mcp.start).tool, 'mcp__codegraph__codegraph_search');
  assert.equal(shown(mcp.start).room, undefined);
  const mcpUuid = innerVisitOf(itemOf(g.mcpItem({ server: '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c', status: 'failed', error: 'BAIT_RESULT_BODY' })));
  assert.equal(shown(mcpUuid.start).tool, `mcp__${ZERO_UUID}__get_issue`);
  assert.deepEqual(mcpUuid.end, { status: 'failed', errorLine: 'MCP tool error' });
  const ws = innerVisitOf(itemOf(g.webSearchItem({ query: 'codex rollout format' })));
  assert.deepEqual(shown(ws.start), { tool: 'web_search', summary: 'codex rollout format', room: 'research' });
  const page = innerVisitOf(itemOf(g.webSearchItem({ url: 'https://docs.example.com/p?token=BAIT_QUERY_TOKEN' })));
  assert.equal(shown(page.start).summary, 'docs.example.com');
  const img = innerVisitOf(itemOf(g.imageViewItem()));
  assert.deepEqual(shown(img.start), { tool: 'view_image', summary: 'shot.png', room: 'archive' });
  assert.equal(innerVisitOf(itemOf(g.agentMessageItem('x'))), null, 'other item types are not visits');
  assert.equal(innerVisitOf({ type: 'CommandExecution' }), null, 'no id, no visit');
  assert.deepEqual([...INNER_ITEM_TYPES].sort(), ['CommandExecution', 'FileChange', 'ImageView', 'McpToolCall', 'WebSearch']);
});

// ---------------------------------------------------------------------------------------------- through the session

test('session: each inner item while the exec is open is a short start+end visit, the exec output closes the outer tool', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g),
    g.exec('const a = await tools.exec_command({ cmd: "rg -n login src" });\nawait tools.apply_patch("*** Begin Patch");'),
  ]);
  const outerId = g.lastCallId;
  const starts = of(evs, 'tool_start');
  assert.deepEqual(starts.map((e) => [e.toolUseId, e.tool, e.summary, e.room]), [[outerId, 'exec', 'exec_command', 'server']]);
  const inner = run(s, [g.commandItem({ script: 'rg -n login src' }), g.fileChangeItem(), g.imageViewItem()]);
  assert.deepEqual(inner.map((e) => [e.type, e.tool ?? null, e.ok ?? null]), [
    ['tool_start', 'exec_command', null], ['tool_end', null, true],
    ['tool_start', 'apply_patch', null], ['tool_end', null, true],
    ['tool_start', 'view_image', null], ['tool_end', null, true],
  ]);
  assert.deepEqual(s.snapshotEvents().filter((e) => e.type === 'tool_start').map((e) => e.toolUseId), [outerId],
    'visits never stay open; only the exec does');
  const end = run(s, [g.execOutput()]);
  assert.deepEqual(end.map((e) => [e.type, e.toolUseId, e.ok]), [['tool_end', outerId, true]]);
  assert.deepEqual(s.debugState().codex.exec, []);
});

test('session: inner items outside an open exec are ignored (pre-code-mode CommandExecution duplicates exec_command)', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g), g.execCommand('npm test'), g.commandItem({ script: 'npm test' }), g.functionOutput({ output: out.execCommand() }),
    g.fileChangeItem(), g.mcpItem(),
  ]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.tool), ['exec_command']);
  assert.equal(of(evs, 'tool_end').length, 1);
});

test('session: a failing script, a failing inner command and an MCP error keep their own statuses', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g), g.exec('await tools.exec_command({ cmd: "npm test" })'), g.commandItem({ script: 'npm test', exitCode: 2 }),
    g.mcpItem({ status: 'failed', error: 'BAIT_RESULT_BODY' }), g.execOutput(out.scriptFailed()),
  ]);
  const ends = of(evs, 'tool_end').map((e) => [e.ok, e.errorKind ?? null, e.error ?? null]);
  assert.deepEqual(ends, [[false, 'failed', 'Exit code 2'], [false, 'failed', 'MCP tool error'], [false, 'failed', 'Script failed']]);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT/);
});

test('session: tools.update_plan inside a script is not shown (D10c): no plan event, no plan from the script text', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g),
    g.exec('await tools.update_plan({ plan: [{ step: "BAIT_PLAN_STEP", status: "in_progress" }] });'), g.execOutput(),
  ]);
  assert.equal(of(evs, 'plan').length, 0);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.tool, e.summary, e.room]), [['exec', 'exec', 'here']]);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT_PLAN_STEP/);
});

test('session: parallel execs keep the window open until the last one ends; a new turn abandons an open exec', () => {
  const { s, g } = mk();
  const evs = run(s, [...opening(g), g.exec('await tools.exec_command({})')]);
  const first = g.lastCallId;
  evs.push(...run(s, [g.exec('await tools.apply_patch("x")')]));
  const second = g.lastCallId;
  evs.push(...run(s, [g.execOutput(out.script(), first), g.commandItem({ script: 'ls' })]));
  assert.equal(of(evs, 'tool_start').filter((e) => e.tool === 'exec_command').length, 1, 'still inside the second exec');
  const next = run(s, [g.taskStarted(), g.commandItem({ script: 'ls' })]);
  assert.deepEqual(of(next, 'tool_end').map((e) => [e.toolUseId, e.errorKind]), [[second, 'abandoned']]);
  assert.equal(of(next, 'tool_start').length, 0, 'the window closed with the turn');
  assert.deepEqual(of(next, 'turn_end').map((e) => e.reason), ['next_turn']);
});

test('session: turn_aborted interrupts an open exec; an aborted script output is interrupted too', () => {
  const { s, g } = mk();
  const a = run(s, [...opening(g), g.exec('await tools.exec_command({})'), g.turnAborted()]);
  assert.deepEqual(of(a, 'tool_end').map((e) => e.errorKind), ['interrupted']);
  assert.deepEqual(of(a, 'turn_end').map((e) => e.reason), ['interrupt']);
  const b = run(s, [g.taskStarted(), g.exec('await tools.exec_command({})'), g.execOutput(out.script('aborted by user after 1.0s'))]);
  assert.deepEqual(of(b, 'tool_end').map((e) => e.errorKind), ['interrupted']);
});

test('session: an inner item id that repeats gives one visit; a plumbing call never opens the code-mode window', () => {
  const { s, g } = mk();
  const cmd = g.commandItem({ script: 'ls', id: 'cmd_same' });
  const evs = run(s, [
    ...opening(g), g.waitCall(), g.commandItem({ script: 'ls' }), g.exec('await tools.exec_command({})'), cmd,
    g.commandItem({ script: 'ls', id: 'cmd_same' }), g.execOutput(),
  ]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId).filter((id) => id.startsWith('cmd_')), ['cmd_same']);
  assert.equal(of(evs, 'tool_end').length, 2);
});
