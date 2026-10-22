// Antigravity pure helpers (src/adapters/antigravity/records.mjs, tools.mjs): one step -> pieces of SessionCore items.
// One test per tool row of the name table (ADAPTERS 6.2 Antigravity column, old and new CLI names) in both transcript
// formats (transcript_full.jsonl native arguments, transcript.jsonl JSON-encoded arguments), the USER_REQUEST
// extraction, the result status rules and the step parser. Then what lines and formats mean for AntigravitySession:
// byte-position ids (UTF-8, step_index collisions, raw lines, exact counts and the offset dedupe key, the same ids in
// replay and live) and the same events from both transcript formats. Synthetic steps only (test/fixtures/antigravity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTIGRAVITY_AGENT, CLOSERS, PASSING, parseStep, callsOf, userRequestOf, userCwdOf, resultEndOf, errorMessageText, planItemsOf,
  runStatusOf,
} from '../src/adapters/antigravity/records.mjs';
import { TOOLS, argString, argList, argsOf, toolNameOf, callStartOf, cwdOfCall } from '../src/adapters/antigravity/tools.mjs';
import { AntigravitySession } from '../src/adapters/antigravity/session.mjs';
import { toolSummary } from '../src/core/tool-summary.mjs';
import {
  createAntigravityBuilder, call, userContent, linePositions, toJsonl, mixedSteps, toolId as tid, AG_ID, FAKE_HOME, WORK,
  UUID_SERVER,
} from './fixtures/antigravity.mjs';

const FORMATS = ['full', 'truncated'];
/** The call as the builder writes it into a planner line of that format (truncated: every argument JSON-encoded). */
const enc = (c, format) => createAntigravityBuilder({ format }).planner({ calls: [c] }).tool_calls[0];
/** callStartOf + the tool_start fields the core derives from its descriptor. */
function startOf(c, format) {
  const r = callStartOf(enc(c, format), format);
  return r.hidden ? r : { ...r, fields: toolSummary(r.start.desc) };
}
const BAIT_RE = /BAIT|agtester|secret-dir|rm -rf|key=|example\.com\/|toolAction|toolSummary/;
const noBait = (v, msg) => assert.doesNotMatch(JSON.stringify(v), BAIT_RE, msg);
const DESC_KEYS = new Set(['tool', 'kind', 'path', 'query', 'command', 'url', 'mcpServer', 'mcpTool']);
/**
 * The descriptor holds only the table's keys. `path`, `command` and `url` are the raw values the core reduces
 * (basename, program name, host), so they are left out of the bait check; every other field, and the start item around
 * it, has none.
 */
function descOnly(start, msg) {
  for (const k of Object.keys(start.desc)) assert.ok(DESC_KEYS.has(k), `${k} is not a descriptor key`);
  const { path, command, url, ...rest } = start.desc;
  noBait({ ...start, desc: rest }, msg);
}

// ---------------------------------------------------------------------------------------------- step parser

test('parseStep: the research record shape, step_index never read, unknown types kept, non-steps -> null', () => {
  const b = createAntigravityBuilder();
  const s = parseStep(b.planner({ content: 'Looking.', thinking: 'Hmm.', calls: [call.viewFile()] }));
  assert.equal(s.type, 'PLANNER_RESPONSE');
  assert.equal(s.status, 'DONE');
  assert.equal(s.content, 'Looking.');
  assert.equal(s.thinking, 'Hmm.');
  assert.equal(s.calls.length, 1);
  assert.equal(s.callsUnreadable, false);
  assert.equal(typeof s.ms, 'number');
  assert.equal(Object.hasOwn(s, 'stepIndex'), false, 'step_index repeats and goes backwards: never used');
  assert.equal(parseStep(b.step('KNOWLEDGE_ARTIFACTS')).type, 'KNOWLEDGE_ARTIFACTS', 'unknown types are tolerated');
  for (const bad of [null, [], 'x', {}, { type: '' }, { type: 7 }, { type: 'has space' }, { type: 'X'.repeat(65) }]) {
    assert.equal(parseStep(bad), null, JSON.stringify(bad));
  }
  const r = parseStep({ type: 'RUN_COMMAND', status: 'DONE', created_at: 'not a date', exit_code: ' 3 ', content: '  ' });
  assert.equal(r.ms, null);
  assert.equal(r.exitCode, 3, 'a numeric string exit code is read');
  assert.equal(r.content, null, 'blank content is no content');
  assert.equal(parseStep({ type: 'GENERIC', exit_code: 'x1' }).exitCode, null);
});

test('callsOf: an array keeps every slot, a JSON-encoded array is read, an unreadable value means calls of unknown count', () => {
  assert.deepEqual(callsOf(undefined), { list: [], unreadable: false });
  assert.deepEqual(callsOf([]), { list: [], unreadable: false });
  const two = callsOf([{ name: 'view_file', args: {} }, 'not a call']);
  assert.equal(two.list.length, 2, 'a malformed entry still takes its result slot');
  assert.deepEqual(two.list[1], {});
  assert.equal(callsOf(JSON.stringify([{ name: 'list_dir', args: {} }])).list[0].name, 'list_dir');
  assert.deepEqual(callsOf('[{"name":"view_file","args":{"AbsolutePath":"\\"/x'), { list: [], unreadable: true }, 'cut by the truncation');
  assert.deepEqual(callsOf({ name: 'view_file' }), { list: [], unreadable: true });
  assert.equal(callsOf(Array.from({ length: 300 }, () => ({}))).list.length, 256, 'capped');
});

test('step type sets: three closers abandon waiting calls (not CHECKPOINT); SYSTEM_MESSAGE and CONVERSATION_HISTORY take no result slot', () => {
  assert.equal(ANTIGRAVITY_AGENT, 'antigravity');
  assert.deepEqual([...CLOSERS].sort(), ['ERROR_MESSAGE', 'PLANNER_RESPONSE', 'USER_INPUT']);
  assert.deepEqual([...PASSING].sort(), ['CONVERSATION_HISTORY', 'SYSTEM_MESSAGE']);
});

// ---------------------------------------------------------------------------------------------- USER_REQUEST

test('userRequestOf: only the inner USER_REQUEST text; ADDITIONAL_METADATA, USER_SETTINGS_CHANGE and PLAN never', () => {
  const content = userContent('Fix the login bug', { settings: true, plan: true });
  assert.ok(content.startsWith('<'), 'every real USER_INPUT content starts with a tag (the generic "<" skip would drop it)');
  assert.equal(userRequestOf(content), 'Fix the login bug');
  assert.equal(userRequestOf('<ADDITIONAL_METADATA>BAIT</ADDITIONAL_METADATA><USER_REQUEST>  Run it\n</USER_REQUEST>'), 'Run it');
  assert.equal(userRequestOf('<USER_REQUEST id="1">With attributes</USER_REQUEST>'), 'With attributes');
  assert.equal(userRequestOf('<USER_REQUEST>  </USER_REQUEST><USER_REQUEST>Second block</USER_REQUEST>'), 'Second block');
  assert.equal(userRequestOf('<USER_REQUEST>line one\nline two</USER_REQUEST>'), 'line one\nline two');
});

test('userRequestOf: no block -> null (raw content is never a prompt); a cut block ends at the next tag', () => {
  assert.equal(userRequestOf('Plain text without any block'), null);
  assert.equal(userRequestOf('<ADDITIONAL_METADATA>BAIT_METADATA</ADDITIONAL_METADATA>'), null);
  assert.equal(userRequestOf(''), null);
  assert.equal(userRequestOf(null), null);
  assert.equal(userRequestOf('<USER_REQUEST>Cut by the truncat'), 'Cut by the truncat', 'transcript.jsonl content cut inside the block');
  assert.equal(userRequestOf('<USER_REQUEST>Unclosed<ADDITIONAL_METADATA>BAIT_METADATA</ADDITIONAL_METADATA>'), 'Unclosed');
  assert.equal(userRequestOf('<USER_REQUEST></USER_REQUEST>'), null);
});

test('userCwdOf: extracts Command Working Directory or Active Workspaces from <user_information> as a cwd fallback', () => {
  const info = '<user_information>\nThe USER\'s OS version is mac.\nActive Workspaces:\n- /work/ws-one\nCommand Working Directory: /work/cwd-dir/\n</user_information><USER_REQUEST>Hello</USER_REQUEST>';
  assert.equal(userCwdOf(info), '/work/cwd-dir');
  assert.equal(userCwdOf('<user_information>\nActive Workspaces:\n- /work/ws-only/\n</user_information>'), '/work/ws-only');
  assert.equal(userCwdOf('<user_information>\nNo paths here\n</user_information>'), null);
  assert.equal(userCwdOf('<USER_REQUEST>Command Working Directory: /work/nope</USER_REQUEST>'), null);
  const { s, b } = mk();
  s.apply(b.userInput('Hi', { raw: info }), { replay: true });
  s.idle(SERVER_T);
  assert.equal(s.firstCwd, '/work/cwd-dir');
});

// ---------------------------------------------------------------------------------------------- results

test('resultEndOf: DONE or no status -> ok; RUNNING -> ok + background (a backgrounded command, never rewritten)', () => {
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'DONE', content: 'BAIT_RESULT_BODY' })), { status: 'ok' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'VIEW_FILE' })), { status: 'ok' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'RUN_COMMAND', status: 'DONE', exit_code: 0 })), { status: 'ok' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'RUN_COMMAND', status: 'RUNNING' })), { status: 'ok', background: true });
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'RUNNING' })), { status: 'ok', background: true });
});

test('resultEndOf: ERROR, an error field or a non-zero exit_code -> failed; the error line is the exit code, else the first error line', () => {
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'ERROR' })), { status: 'failed' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'ERROR', error: '\npermission check failed for read\nBAIT_SECOND_LINE' })),
    { status: 'failed', errorLine: 'permission check failed for read' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'DONE', error: 'tool said no' })), { status: 'failed', errorLine: 'tool said no' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'RUN_COMMAND', status: 'DONE', exit_code: 2, content: 'BAIT_OUTPUT' })),
    { status: 'failed', errorLine: 'Exit code 2' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'RUN_COMMAND', status: 'ERROR', exit_code: 1, error: 'BAIT_STDERR' })),
    { status: 'failed', errorLine: 'Exit code 1' }, 'the exit code wins over free text');
  assert.deepEqual(resultEndOf(parseStep({ type: 'RUN_COMMAND', status: 'RUNNING', exit_code: 5 })), { status: 'failed', errorLine: 'Exit code 5' });
});

test('resultEndOf: INVALID and unknown statuses -> failed without an error line (the core falls back to "failed")', () => {
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'INVALID' })), { status: 'failed' });
  assert.deepEqual(resultEndOf(parseStep({ type: 'GENERIC', status: 'SOMETHING_NEW' })), { status: 'failed' });
});

test('errorMessageText: the first line of error, else of content, else empty (the core falls back to "API error")', () => {
  assert.equal(errorMessageText(parseStep({ type: 'ERROR_MESSAGE', error: 'Overloaded\nBAIT_DETAIL' })), 'Overloaded');
  assert.equal(errorMessageText(parseStep({ type: 'ERROR_MESSAGE', content: '\n  Interrupted by the user  \nBAIT' })), 'Interrupted by the user');
  assert.equal(errorMessageText(parseStep({ type: 'ERROR_MESSAGE' })), '');
});

test('planItemsOf / runStatusOf: the metadata reader\'s checklist items and summary status', () => {
  const items = [{ content: 'Write tests', status: 'completed' }, { step: 'Ship', status: 'pending' }, { status: 'x' }, 'no'];
  assert.deepEqual(planItemsOf(items), items.slice(0, 2));
  assert.deepEqual(planItemsOf({ items: items.slice(0, 1) }), items.slice(0, 1));
  assert.equal(planItemsOf('- [ ] markdown'), null);
  assert.equal(planItemsOf(undefined), null);
  assert.equal(runStatusOf('idle'), 'idle');
  assert.equal(runStatusOf(' RUNNING '), 'running');
  assert.equal(runStatusOf(1), null);
  assert.equal(runStatusOf('done'), null);
});

// ---------------------------------------------------------------------------------------------- argument values

test('argString: native in transcript_full, JSON-decoded in transcript.jsonl, a cut encoded value is dropped', () => {
  assert.equal(argString('/a/b.ts', 'full'), '/a/b.ts');
  assert.equal(argString('"/usr/bin/node" x.js', 'full'), '"/usr/bin/node" x.js', 'full: a native string is never decoded');
  assert.equal(argString('"/a/b.ts"', 'truncated'), '/a/b.ts');
  assert.equal(argString('"/a/very/long/pa', 'truncated'), undefined, 'cut by the truncation');
  assert.equal(argString('/a/b.ts', 'truncated'), undefined, 'truncated: every value must be encoded');
  assert.equal(argString('10', 'truncated'), undefined, 'an encoded number is not a string');
  assert.equal(argString('"/a/b.ts"'), '/a/b.ts', 'unknown format: a leading quote is decoded');
  assert.equal(argString('[a-z]+\\.ts'), '[a-z]+\\.ts', 'unknown format: a native regex stays');
  assert.equal(argString('"cut'), undefined);
  assert.equal(argString(''), undefined);
  assert.equal(argString('  '), undefined);
  assert.equal(argString(7), undefined);
  assert.equal(argString('x'.repeat(5000)).length, 4096, 'capped before the core');
});

test('argList / argsOf / toolNameOf: native or encoded arrays, encoded args objects, validated names', () => {
  assert.deepEqual(argList([1]), [1]);
  assert.deepEqual(argList('[{"question":"q"}]'), [{ question: 'q' }]);
  assert.equal(argList('[{"question":"q"'), undefined);
  assert.equal(argList('{}'), undefined);
  assert.deepEqual(argsOf({ args: { a: 1 } }), { a: 1 });
  assert.deepEqual(argsOf({ args: '{"a":1}' }), { a: 1 });
  assert.deepEqual(argsOf({ args: '{"a":' }), {});
  assert.deepEqual(argsOf(null), {});
  assert.equal(toolNameOf({ name: 'view_file' }), 'view_file');
  assert.equal(toolNameOf({ name: 'bad name; rm -rf /' }), 'tool');
  assert.equal(toolNameOf({}), 'tool');
});

// ---------------------------------------------------------------------------------------------- tool rows

test('the name table covers both eras of ADAPTERS 6.2 (Antigravity column)', () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [
    'ask_question', 'browser_subagent', 'call_mcp_tool', 'command_status', 'define_subagent', 'edit_file', 'find_by_name',
    'generate_image', 'grep_search', 'invoke_subagent', 'list_dir', 'list_permissions', 'list_resources', 'manage_subagents',
    'manage_task', 'multi_replace_file_content', 'read_file', 'read_resource', 'read_url_content', 'replace_file_content',
    'run_command', 'schedule', 'search_web', 'send_message', 'view_file', 'write_file', 'write_to_file',
  ]);
});

const ROWS = [
  // [row name, call, tool, summary, room]
  ['view_file (old era)', call.viewFile(), 'view_file', 'login.ts', 'archive'],
  ['read_file (1.4.x)', call.readFile(), 'read_file', 'login.ts', 'archive'],
  ['list_dir', call.listDir(), 'list_dir', 'src', 'archive'],
  ['grep_search', call.grep(), 'grep_search', 'refreshToken · src', 'archive'],
  ['find_by_name', call.findByName(), 'find_by_name', '*.spec.ts · test', 'archive'],
  ['write_to_file (old era)', call.writeToFile(), 'write_to_file', 'session.ts', 'dev'],
  ['write_file (1.4.x)', call.writeFile(), 'write_file', 'session.ts', 'dev'],
  ['replace_file_content', call.replace(), 'replace_file_content', 'token.ts', 'dev'],
  ['multi_replace_file_content', call.multiReplace(), 'multi_replace_file_content', 'guard.ts', 'dev'],
  ['edit_file (1.4.x, Target / Replacement never read)', call.editFile(), 'edit_file', 'token.ts', 'dev'],
  ['run_command', call.runCommand(), 'run_command', 'npm test', 'server'],
  ['run_command (archive program)', call.runCommand(`grep -rn token ${FAKE_HOME}/secret-dir`), 'run_command', 'grep', 'archive'],
  ['run_command (research program)', call.runCommand('curl -s https://api.example.com/v1?key=BAIT'), 'run_command', 'curl', 'research'],
  ['run_command (rm -rf)', call.runCommand(`rm -rf ${FAKE_HOME}/secret-dir/build`), 'run_command', 'rm', 'server'],
  ['command_status', call.commandStatus(), 'command_status', 'command_status', 'server'],
  ['manage_task', call.manageTask('kill'), 'manage_task', 'manage_task', 'server'],
  ['search_web', call.searchWeb(), 'search_web', 'oauth refresh token rotation', 'research'],
  ['read_url_content', call.readUrl(), 'read_url_content', 'docs.example.com', 'research'],
  ['list_resources (2.x)', call.listResources(), 'list_resources', 'list_resources', 'research'],
  ['read_resource (2.x)', call.readResource(), 'read_resource', 'read_resource', 'research'],
  ['define_subagent (2.x)', call.defineSubagent(), 'define_subagent', 'define_subagent', 'here'],
  ['invoke_subagent (2.x)', call.invokeSubagent(), 'invoke_subagent', 'invoke_subagent', 'here'],
  ['send_message (2.x)', call.sendMessage(), 'send_message', 'send_message', 'here'],
  ['manage_subagents', call.manageSubagents(), 'manage_subagents', 'manage_subagents', 'here'],
  ['browser_subagent', call.browserSubagent(), 'browser_subagent', 'browser_subagent', 'here'],
  ['generate_image', call.generateImage(), 'generate_image', 'generate_image', 'here'],
  ['schedule (room hint lounge, added by the session)', call.schedule(), 'schedule', 'schedule', 'here'],
  ['an unknown tool (no argument read)', call.unknown(), 'future_tool', 'future_tool', 'here'],
];

for (const [row, c, tool, summary, room] of ROWS) {
  for (const format of FORMATS) {
    test(`row ${row} [${format}]: tool ${tool}, summary "${summary}", room ${room}; free-text arguments never read`, () => {
      const r = startOf(c, format);
      assert.equal(r.name, tool);
      assert.equal(r.fields.tool, tool);
      assert.equal(r.fields.summary, summary);
      assert.equal(r.fields.room, room);
      descOnly(r.start, 'only the table\'s argument keys reach the descriptor');
      noBait(r.fields, 'the tool_start fields carry no argument text');
    });
  }
}

for (const format of FORMATS) {
  test(`row call_mcp_tool [${format}]: mcp__<server>__<tool> from ServerName / ToolName, a uuid server masked, Arguments never read`, () => {
    const r = startOf(call.mcp('github', 'get_issue'), format);
    assert.equal(r.fields.tool, 'mcp__github__get_issue');
    assert.equal(r.fields.room, undefined, 'MCP names carry no room hint (the page classifies them)');
    descOnly(r.start);
    noBait(r.fields);
    const u = startOf(call.mcp(UUID_SERVER, 'search'), format);
    assert.equal(u.fields.tool, 'mcp__00000000-0000-0000-0000-000000000000__search');
    assert.doesNotMatch(JSON.stringify(u.fields), new RegExp(UUID_SERVER));
    assert.equal(startOf({ name: 'call_mcp_tool', args: {} }, format).fields.tool, 'call_mcp_tool');
  });

  test(`row ask_question [${format}]: kind ask with the question texts and option names only`, () => {
    const r = startOf(call.askQuestion([
      { question: 'Which store?', options: ['Postgres', { label: 'SQLite', description: 'BAIT_OPTION_DESCRIPTION' }, 'Redis', 'Mongo', 'Fifth'] },
      { question: 'Second?', options: [] },
    ]), format);
    assert.equal(r.start.kind, 'ask');
    assert.deepEqual(r.start.questions, [
      { question: 'Which store?', options: ['Postgres', 'SQLite', 'Redis', 'Mongo'] }, { question: 'Second?', options: [] },
    ]);
    assert.equal(r.fields.room, 'desk');
    descOnly(r.start);
  });

  test(`row list_permissions [${format}]: hidden plumbing (it still takes a result slot in the session)`, () => {
    assert.deepEqual(callStartOf(enc(call.listPermissions(), format), format), { hidden: true, name: 'list_permissions' });
  });

  test(`cwdOfCall [${format}]: an absolute run_command Cwd only, never part of the descriptor`, () => {
    assert.equal(cwdOfCall(enc(call.runCommand('ls', WORK), format), format), WORK);
    assert.equal(cwdOfCall(enc(call.runCommand('ls', 'relative/dir'), format), format), null);
    assert.equal(cwdOfCall(enc(call.viewFile(), format), format), null);
    assert.equal(callStartOf(enc(call.runCommand('ls', WORK), format), format).start.desc.cwd, undefined);
    assert.doesNotMatch(JSON.stringify(callStartOf(enc(call.runCommand('ls', WORK), format), format)), /ag-repo/);
  });
}

test('truncated format: a value cut by the truncation is dropped (the summary falls back to the tool name)', () => {
  const b = createAntigravityBuilder({ format: 'truncated' });
  const line = b.planner({ calls: [call.writeToFile(), call.runCommand()], cutArgs: ['TargetFile', 'CommandLine'] });
  assert.ok(line.truncated_fields.includes('tool_calls'));
  const w = callStartOf(line.tool_calls[0], 'truncated');
  assert.equal(w.start.desc.path, undefined);
  assert.equal(toolSummary(w.start.desc).summary, 'write_to_file');
  const r = callStartOf(line.tool_calls[1], 'truncated');
  assert.equal(toolSummary(r.start.desc).summary, 'run_command');
  assert.equal(r.start.desc.command, undefined);
  descOnly(w.start);
  descOnly(r.start);
});

test('full format: a native command that starts with a quote is still read through programOf', () => {
  const r = callStartOf(enc(call.runCommand('"/usr/local/bin/node" scripts/build.mjs --secret=BAIT'), 'full'), 'full');
  assert.equal(toolSummary(r.start.desc).summary, 'node');
  const unknown = callStartOf(enc(call.runCommand('"/usr/local/bin/node" scripts/build.mjs'), 'full'), null);
  assert.equal(toolSummary(unknown.start.desc).summary, 'run_command', 'unknown format: an undecodable quoted value is dropped');
});

// ---------------------------------------------------------------------------------------------- session: lines and formats

const SERVER_T = Date.UTC(2026, 9, 20, 10, 0, 0);
function mk({ format = 'full', facts } = {}) {
  const s = new AntigravitySession({ id: AG_ID, agent: 'antigravity', kind: 'main', now: () => SERVER_T, file: '/tmp/x',
    facts: facts === undefined ? { full: format === 'full', base: 'antigravity-cli' } : facts });
  return { s, b: createAntigravityBuilder({ format }) };
}
const run = (s, steps, opts) => steps.flatMap((st) => s.apply(st, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);

test('positions: tool ids carry the UTF-8 byte position of their line (newline included), also after multi-byte text', () => {
  const { s, b } = mk();
  const steps = [b.userInput('로그인 버그를 고쳐 줘 — ünïcødé'), b.planner({ thinking: '생각 중입니다.', calls: [call.viewFile()] }),
    b.result(), b.planner({ calls: [call.listDir(), call.grep()] })];
  const pos = linePositions(steps);
  assert.ok(pos[1] > JSON.stringify(steps[0]).length + 1, 'byte length, not the UTF-16 length');
  const evs = run(s, steps);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(pos[1], 0), tid(pos[3], 0), tid(pos[3], 1)]);
  assert.equal(s.position, Buffer.byteLength(toJsonl(steps), 'utf8'), 'the count equals the file size');
});

test('positions: two lines with the same step_index (or one that steps back) are different steps with different ids', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile()], index: 7 }), b.result({ index: 7 }),
    b.planner({ calls: [call.viewFile()], index: 7 }), b.result({ index: 3 })];
  const pos = linePositions(steps);
  const evs = run(s, steps);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(pos[1], 0), tid(pos[3], 0)]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok]), [[tid(pos[1], 0), true], [tid(pos[3], 0), true]]);
});

test('positions: raw line strings give the same ids as parsed records; blank and unparseable raw lines still advance', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result(), b.planner({ calls: [call.grep()] })];
  const a = mk();
  const parsed = run(a.s, steps);
  const raw = toJsonl(steps).split('\n').slice(0, -1).flatMap((line) => s.apply(line));
  assert.deepEqual(raw, parsed);
  const c = mk();
  const lines = toJsonl(steps).split('\n').slice(0, -1);
  const withJunk = [lines[0], '', '{not json', lines[1], lines[2], lines[3]].flatMap((line) => c.s.apply(line));
  const extra = 1 + Buffer.byteLength('{not json') + 1;
  const pos = linePositions(steps);
  assert.deepEqual(of(withJunk, 'tool_start').map((e) => e.toolUseId), [tid(pos[1] + extra, 0), tid(pos[3] + extra, 0)]);
  assert.equal(c.s.skipped, 1, 'the unparseable line is counted, the blank one is not');
});

test('positions: { line } gives the exact byte count; { offset } is the dedupe key (a re-delivered line is skipped)', () => {
  const { s, b } = mk();
  const steps = [b.userInput(), b.planner({ calls: [call.viewFile()] }), b.result()];
  const spaced = steps.map((st) => JSON.stringify(st, null, 1).replace(/\n/g, ' ')); // other bytes than JSON.stringify
  const evs = steps.flatMap((st, i) => s.apply(st, { line: spaced[i] }));
  const p1 = Buffer.byteLength(spaced[0]) + 1;
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.toolUseId), [tid(p1, 0)]);
  const { s: s2 } = mk();
  const pos = linePositions(steps);
  const first = steps.flatMap((st, i) => s2.apply(st, { offset: pos[i] }));
  const again = steps.flatMap((st, i) => s2.apply(st, { offset: pos[i] })); // the Tailer re-delivers from an older chunk
  assert.equal(of(first, 'tool_end').length, 1);
  assert.deepEqual(again, []);
  assert.equal(s2.debugState().antigravity.repeats, 3);
});

test('positions: replaying the first half and reading the rest live gives the ids of a fully live read', () => {
  const b = createAntigravityBuilder();
  const steps = mixedSteps(b);
  const half = 11;
  const full = mk();
  const allLive = run(full.s, steps);
  const split = mk();
  assert.deepEqual(run(split.s, steps.slice(0, half), { replay: true }), []);
  split.s.idle(SERVER_T);
  const rest = run(split.s, steps.slice(half));
  const ids = (evs) => evs.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => `${e.type}:${e.toolUseId}`);
  const restIds = ids(rest);
  assert.ok(restIds.length > 0);
  assert.deepEqual(restIds, ids(allLive).slice(-restIds.length));
  assert.deepEqual(split.s.snapshotEvents(), full.s.snapshotEvents());
  assert.equal(split.s.position, full.s.position);
});

test('transcript.jsonl (truncated format): the same events as transcript_full.jsonl apart from the line positions', () => {
  const full = mk({ format: 'full' });
  const trunc = mk({ format: 'truncated' });
  const strip = (evs, pos) => evs.map((e) => {
    const c = { ...e };
    if (c.toolUseId) c.toolUseId = c.toolUseId.replace(/:(\d+):/, (m, p) => `:L${pos.indexOf(Number(p))}:`);
    return c;
  });
  const fs = mixedSteps(full.b);
  const ts = mixedSteps(trunc.b);
  assert.ok(ts.some((st) => st.tool_calls?.some((c) => typeof c.args.AbsolutePath === 'string' && c.args.AbsolutePath.startsWith('"'))));
  const a = strip(run(full.s, fs), linePositions(fs));
  const z = strip(run(trunc.s, ts), linePositions(ts));
  assert.deepEqual(z, a);
});

test('facts: a known format is used per file; without facts the format is decided per value (both still read)', () => {
  const t = mk({ format: 'truncated', facts: null });
  const steps = [t.b.userInput(), t.b.planner({ calls: [call.viewFile(), call.runCommand()] })];
  const evs = run(t.s, steps);
  assert.deepEqual(of(evs, 'tool_start').map((e) => e.summary), ['login.ts', 'npm test']);
  assert.equal(t.s.debugState().antigravity.format, null);
  assert.equal(mk({ format: 'full' }).s.debugState().antigravity.format, 'full');
  assert.equal(mk({ format: 'truncated' }).s.debugState().antigravity.format, 'truncated');
  const wrong = mk({ format: 'full', facts: { full: false } }); // a full-format line read as truncated: values dropped
  const evs2 = run(wrong.s, [wrong.b.userInput(), wrong.b.planner({ calls: [call.viewFile()] })]);
  assert.deepEqual(of(evs2, 'tool_start').map((e) => e.summary), ['view_file']);
});
