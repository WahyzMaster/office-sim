// Codex record helpers (src/adapters/codex/records.mjs): the pure pieces of the Codex normalizer. One test per mapping
// row of ADAPTERS 5.1 / 6.1 / 6.2 (Codex column) that lives in records.mjs, named after the row, then the tool rows end to
// end through CodexSession (pairing, statuses, plan and ask calls, names and rooms, plumbing). Synthetic records only
// (test/fixtures/codex.mjs, shaped from docs/research/codex-format.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_AGENT, ITEM_TEXT_SINCE, HIDDEN_TOOLS, parseRecord, parseVersion, versionAtLeast, textSource, sessionMetaOf,
  metaItemOf, userMessageText, assistantText, agentMessageText, reasoningSummary, reasoningItemSummary, itemDurationMs,
  childIdOf, callNameOf, callStartOf, planItemsOf, webSearchCallOf, outputText, outputEndOf, phraseEnd,
} from '../src/adapters/codex/records.mjs';
import { CodexSession } from '../src/adapters/codex/session.mjs';
import { toolSummary } from '../src/core/tool-summary.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';
import {
  createCodexBuilder, out, patchText, CODEX_THREAD, CODEX_CHILD, OLD_VERSION, NEW_VERSION,
} from './fixtures/codex.mjs';

const b = () => createCodexBuilder();
const payloadOf = (rec) => parseRecord(rec).payload;
// The tool_start fields the core would build from a start piece (tool-summary on the descriptor).
const shown = (start) => toolSummary({ tool: start.tool, ...start.desc });

test('envelope: parseRecord keeps type, payload.type, ordinal and the ms timestamp; junk is null', () => {
  const g = b();
  const r = parseRecord(g.taskStarted());
  assert.equal(r.type, 'event_msg');
  assert.equal(r.sub, 'task_started');
  assert.equal(r.ordinal, 0);
  assert.equal(r.ms, Date.UTC(2026, 9, 20, 9, 0, 0));
  assert.equal(parseRecord(g.compacted()).sub, null, 'compacted has no payload.type');
  for (const junk of [null, [], 'x', {}, { type: 'event_msg' }, { type: '', payload: {} }, { type: 'x', payload: [] }]) {
    assert.equal(parseRecord(junk), null);
  }
  const noOrd = parseRecord({ type: 'event_msg', payload: { type: 'task_started' }, ordinal: -1, timestamp: 'nope' });
  assert.equal(noOrd.ordinal, null);
  assert.equal(noOrd.ms, null);
});

test('cli_version: parse with pre-release suffix, compare, and pick the say/thinking source', () => {
  assert.deepEqual(parseVersion('0.162.0-alpha.17.2'), [0, 162, 0]);
  assert.deepEqual(parseVersion('0.142'), [0, 142, 0]);
  assert.equal(parseVersion('codex'), null);
  assert.equal(versionAtLeast('0.142.5', ITEM_TEXT_SINCE), true);
  assert.equal(versionAtLeast('0.142.4', ITEM_TEXT_SINCE), false);
  assert.equal(versionAtLeast('0.150.0', ITEM_TEXT_SINCE), true);
  assert.equal(textSource(NEW_VERSION), 'item');
  assert.equal(textSource(OLD_VERSION), 'response');
  assert.equal(textSource(undefined), 'response', 'unknown version: response_item exists in every version');
});

test('row session_meta: only cwd, branch, version, H and sub labels are read (never account ids, instructions, repo url)', () => {
  const g = b();
  const main = sessionMetaOf(payloadOf(g.sessionMeta()));
  assert.equal(main.id, CODEX_THREAD);
  assert.equal(main.cwd, '/work/codex-repo');
  assert.equal(main.branch, 'feat/login');
  assert.equal(main.cliVersion, NEW_VERSION);
  assert.equal(main.historyStart, null);
  assert.equal(main.spawn, false);
  assert.doesNotMatch(JSON.stringify(main), /BAIT/, 'creator ids, instructions, commit hash and repository url are not kept');
  assert.deepEqual(metaItemOf(main, false), { k: 'meta', cwd: '/work/codex-repo', branch: 'feat/login' });

  const sub = sessionMetaOf(payloadOf(createCodexBuilder({ threadId: CODEX_CHILD }).sessionMeta({
    sub: { parent: CODEX_THREAD, role: 'explorer', nickname: 'Hume', path: '/root/explore_auth' }, historyStart: 5,
  })));
  assert.equal(sub.historyStart, 5);
  assert.deepEqual(metaItemOf(sub, true), { k: 'meta', cwd: '/work/codex-repo', branch: 'feat/login', agentType: 'explorer', title: 'Hume' });
  const noNick = sessionMetaOf(payloadOf(b().sessionMeta({ sub: { role: 'worker', path: '/root/fix_tests' } })));
  assert.equal(metaItemOf(noNick, true).title, 'fix_tests', 'the last agent_path segment is the fallback title');
  assert.deepEqual(metaItemOf(noNick, false), { k: 'meta', cwd: '/work/codex-repo', branch: 'feat/login', subagent: true },
    'a main whose own line says it runs a parent task never sends that task as a prompt');
  const review = sessionMetaOf(payloadOf(b().sessionMeta({ review: true })));
  assert.equal(review.review, true);
  assert.equal(metaItemOf(review, true).agentType, 'review', 'D10d: /review threads are ordinary subagents');
  assert.equal(sessionMetaOf(payloadOf(b().sessionMeta({ guardian: true }))).guardian, true);
  const noGit = sessionMetaOf(payloadOf(b().sessionMeta({ branch: null, cwd: 'relative/dir' })));
  assert.equal(noGit.branch, undefined);
  assert.equal(noGit.cwd, undefined, 'only an absolute cwd');
});

test('row item_completed UserMessage: the first text part; images and other parts are not text', () => {
  const g = b();
  assert.equal(userMessageText(payloadOf(g.userMessage('Fix the login bug', { image: true })).item), 'Fix the login bug');
  assert.equal(userMessageText({ content: [{ type: 'local_image', path: '/x.png' }] }), null);
  assert.equal(userMessageText({}), null);
});

test('row item_completed UserMessage: an IDE / desktop context wrapper gives only the text after the last "## My request:" marker', () => {
  const ide = (request) => ['# Context from my IDE setup:', '', '## Active file: /Users/bait-user/proj/BAIT_ACTIVE_FILE.ts', '',
    '## Open tabs:', '- BAIT_TAB.ts: /Users/bait-user/proj/BAIT_TAB.ts', '', `## My request for Codex:\n${request}`].join('\n');
  const um = (text) => ({ content: [{ type: 'text', text }] });
  assert.equal(userMessageText(um(ide('Fix the login bug\n'))), 'Fix the login bug', 'the legacy / TUI marker');
  assert.equal(userMessageText(um('# Context from my IDE setup:\n\n## Active file: /x/BAIT_A.ts\n\n## My request:\nAdd a test')), 'Add a test',
    'the current marker');
  assert.equal(userMessageText(um('\n# Files mentioned by the user:\n\n## BAIT_F.ts: /x/BAIT_F.ts\n\n## My request:\n  Rename it  ')), 'Rename it',
    'a files-mentioned prefix starts with a newline; trimmed');
  assert.equal(userMessageText(um('[from: BAIT_PERSON]\n# Context from my IDE setup:\n\n## My request for Codex:\nShip it')), 'Ship it',
    'a multi-user prefix in front');
  assert.equal(userMessageText(um('# Context:\n## My request:\nfirst ## My request: BAIT_QUOTED\n## My request:\nThe real one')), 'The real one',
    'the last marker wins');
  assert.equal(userMessageText(um('# Context from my IDE setup:\n\n## Active file: /x/BAIT_A.ts\n\n## My request:\n  ')), null,
    'a wrapper with an empty request is no prompt');
  assert.equal(userMessageText(um('# Plan\n1. Read the code'), ), '# Plan\n1. Read the code', 'a heading without the marker is the text itself');
  assert.equal(userMessageText(um('<environment_context>x</environment_context>')), '<environment_context>x</environment_context>',
    'tags stay for the core to skip');
});

test('row response_item message: only role assistant output_text is text (role user / developer is injected context)', () => {
  const g = b();
  assert.equal(assistantText(payloadOf(g.assistantMessage('Done.'))), 'Done.');
  assert.equal(assistantText(payloadOf(g.userContext())), null);
  assert.equal(assistantText(payloadOf(g.developer())), null);
  assert.equal(agentMessageText(payloadOf(g.agentMessageItem('Item text.')).item), 'Item text.');
});

test('row reasoning: the first non-empty summary entry from either duplicate, else null; duration from the item times', () => {
  const g = b();
  assert.equal(reasoningSummary(payloadOf(g.reasoningResponse(['', 'Second entry.']))), 'Second entry.');
  assert.equal(reasoningSummary(payloadOf(g.reasoningResponse([]))), null, 'encrypted only: no text');
  const rec = payloadOf(g.reasoningItem(['Item summary.'], { durMs: 750 }));
  assert.equal(reasoningItemSummary(rec.item), 'Item summary.');
  assert.equal(itemDurationMs(rec), 750);
  assert.equal(itemDurationMs(payloadOf(g.reasoningItem(['x'], { started: false }))), null);
  assert.equal(itemDurationMs({ started_at_ms: 10, completed_at_ms: 5 }), null);
});

test('row SubAgentActivity: the child D2 id is codex-<agent_thread_id>, junk ids are refused', () => {
  assert.equal(childIdOf(CODEX_CHILD), `${CODEX_AGENT}-${CODEX_CHILD}`);
  for (const bad of [null, '', 'a/b', 'x'.repeat(59), '-lead']) assert.equal(childIdOf(bad), null);
});

test('row function_call exec_command / shell_command: the command string -> program name only, server room', () => {
  const g = b();
  const ec = callStartOf(payloadOf(g.execCommand('cd /Users/bait-user/proj && rm -rf build --token=BAIT_QUERY_TOKEN')));
  assert.equal(ec.name, 'exec_command');
  assert.deepEqual(shown(ec.start), { tool: 'exec_command', summary: 'rm', room: 'server' });
  const sc = callStartOf(payloadOf(g.shellCommand('git status')));
  assert.deepEqual(shown(sc.start), { tool: 'shell_command', summary: 'git status', room: 'server' });
  const grep = callStartOf(payloadOf(g.execCommand('rg -n login src')));
  assert.equal(shown(grep.start).room, 'archive', 'the program-name room rule (CONTRACT 3.1)');
  assert.doesNotMatch(JSON.stringify([ec, sc].map((c) => shown(c.start))), /bait|BAIT|-rf/);
});

test('row function_call shell: argv [bash, -lc, script] is unwrapped to the script program; workdir is never read', () => {
  const g = b();
  const c = callStartOf(payloadOf(g.shell(['bash', '-lc', 'npm test -- --grep BAIT_ARG'])));
  assert.deepEqual(shown(c.start), { tool: 'shell', summary: 'npm test', room: 'server' });
  const plain = callStartOf(payloadOf(g.shell(['ls', '-la', '/Users/bait-user'])));
  assert.equal(shown(plain.start).summary, 'ls');
  assert.equal(JSON.stringify(c.start.desc).includes('workdir'), false);
});

test('row custom_tool_call apply_patch: file names from the patch headers only, dev room', () => {
  const c = callStartOf(payloadOf(b().applyPatch(patchText(['src/a.ts', '/Users/bait-user/proj/b.ts']))), 'custom');
  assert.deepEqual(shown(c.start), { tool: 'apply_patch', summary: 'a.ts (+1)', room: 'dev' });
  const other = callStartOf(payloadOf(b().customCall({ name: 'future_tool', input: 'BAIT_TOOL_INPUT' })), 'custom');
  assert.deepEqual(shown(other.start), { tool: 'future_tool', summary: 'future_tool', room: 'here' });
  const exec = callStartOf(payloadOf(b().exec('await tools.view_image({ path: "x" })')), 'custom');
  assert.equal(exec.exec, true);
  assert.match(exec.script, /tools\.view_image/);
});

test('row function_call update_plan: a plan-kind call carrying [{ step, status }] as items (source update_plan)', () => {
  const c = callStartOf(payloadOf(b().updatePlan([{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'in_progress' }])));
  assert.equal(c.start.desc.kind, 'plan');
  assert.equal(c.start.source, 'update_plan');
  assert.deepEqual(c.start.items, [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }]);
  assert.doesNotMatch(JSON.stringify(c), /BAIT_EXPLANATION/, 'explanation is never read');
  const broken = callStartOf({ type: 'function_call', name: 'update_plan', call_id: 'c', arguments: '{not json' });
  assert.equal(broken.start.items, undefined, 'unparsable arguments carry no plan');
  assert.deepEqual(planItemsOf({ plan: 'x' }), null);
});

test('row function_call request_user_input: questions -> question and option labels (header, ids, descriptions dropped)', () => {
  const c = callStartOf(payloadOf(b().requestUserInput()));
  assert.equal(c.start.desc.kind, 'ask');
  assert.deepEqual(c.start.questions, [{ question: 'Which database should I use?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]);
  assert.doesNotMatch(JSON.stringify(c), /BAIT/);
  assert.equal(shown(c.start).room, 'desk');
  const asyncAsk = callStartOf({ type: 'function_call', name: 'request_user_input_async', call_id: 'c', arguments: '{"questions":[]}' });
  assert.equal(asyncAsk.start.desc.kind, 'ask');
});

test('row spawn_agent and collaboration.*: agent calls stay at the desk (here), the summary is the agent type only', () => {
  const g = b();
  const spawn = callStartOf(payloadOf(g.spawnAgent({ agentType: 'explorer' })));
  assert.deepEqual(shown(spawn.start), { tool: 'collaboration.spawn_agent', summary: 'explorer', room: 'here' });
  assert.doesNotMatch(JSON.stringify(spawn), /BAIT/, 'message and task_name are never read');
  const old = callStartOf(payloadOf(g.spawnAgent({ namespaced: false, agentType: 'worker' })));
  assert.deepEqual(shown(old.start), { tool: 'spawn_agent', summary: 'worker', room: 'here' });
  for (const name of ['wait_agent', 'send_message', 'followup_task', 'list_agents', 'interrupt_agent', 'close_agent', 'send_input']) {
    const c = callStartOf(payloadOf(g.collab(name)));
    assert.deepEqual(shown(c.start), { tool: `collaboration.${name}`, summary: `collaboration.${name}`, room: 'here' }, name);
  }
});

test('row MCP: old mcp__<server>__<tool> names and the namespace form give the same tool name; uuid servers are masked', () => {
  const g = b();
  const old = shown(callStartOf(payloadOf(g.mcp({ server: 'github', tool: 'get_issue' }))).start);
  const ns = shown(callStartOf(payloadOf(g.mcp({ server: 'github', tool: 'get_issue', namespaced: true }))).start);
  assert.equal(old.tool, 'mcp__github__get_issue');
  assert.equal(ns.tool, 'mcp__github__get_issue');
  assert.equal(old.room, undefined, 'MCP tools carry no room hint (the page classifies them, D4)');
  const uuid = '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c';
  assert.equal(shown(callStartOf(payloadOf(g.mcp({ server: uuid, namespaced: true }))).start).tool, `mcp__${ZERO_UUID}__get_issue`);
  assert.equal(shown(callStartOf(payloadOf(g.mcp({ server: uuid }))).start).tool, `mcp__${ZERO_UUID}__get_issue`);
  assert.doesNotMatch(JSON.stringify([old, ns]), /BAIT/);
});

test('row view_image, web.run, clock.sleep and unknown names: rooms by kind, clock.sleep marked for the lounge', () => {
  const g = b();
  assert.deepEqual(shown(callStartOf(payloadOf(g.viewImage('/Users/bait-user/proj/shot.png'))).start),
    { tool: 'view_image', summary: 'shot.png', room: 'archive' });
  const web = callStartOf({ type: 'function_call', name: 'run', namespace: 'web', call_id: 'c', arguments: '{"q":"BAIT_SEARCH_QUERY"}' });
  assert.deepEqual(shown(web.start), { tool: 'web.run', summary: 'web.run', room: 'research' });
  const sleep = callStartOf(payloadOf(g.clockSleep()));
  assert.equal(sleep.lounge, true);
  assert.equal(sleep.name, 'clock.sleep');
  const unknown = callStartOf({ type: 'function_call', name: 'brand_new_tool', call_id: 'c', arguments: '{"x":"BAIT_TOOL_INPUT"}' });
  assert.deepEqual(shown(unknown.start), { tool: 'brand_new_tool', summary: 'brand_new_tool', room: 'here' });
  const bad = callStartOf({ type: 'function_call', name: 'bad name/x', call_id: 'c', arguments: '{}' });
  assert.equal(bad.start.tool, 'tool', 'a name outside the tool-name charset is not shown');
  assert.deepEqual(callNameOf({ name: 'sleep', namespace: 'clock' }), { name: 'sleep', namespace: 'clock', full: 'clock.sleep' });
});

test('row plumbing: write_stdin, wait, search_tool_bm25, list_mcp_resources, get_goal are hidden', () => {
  const g = b();
  assert.equal(callStartOf(payloadOf(g.writeStdin())).hidden, true);
  assert.equal(callStartOf(payloadOf(g.waitCall())).hidden, true);
  for (const name of ['search_tool_bm25', 'list_mcp_resources', 'get_goal']) {
    assert.ok(HIDDEN_TOOLS.has(name));
    assert.equal(callStartOf({ type: 'function_call', name, call_id: 'c', arguments: '{}' }).hidden, true, name);
  }
  assert.equal(callStartOf(payloadOf(g.mcp({ server: 'srv', tool: 'wait', namespaced: true }))).hidden, undefined,
    'an MCP tool that happens to be called wait is not plumbing');
});

test('row output exit codes: Exit code, Process exited, JSON metadata.exit_code; the body is never read', () => {
  assert.deepEqual(outputEndOf(out.shellCommand({ exitCode: 0, body: 'Process exited with code 9' })), { status: 'ok' });
  assert.deepEqual(outputEndOf(out.shellCommand({ exitCode: 1 })), { status: 'failed', errorLine: 'Exit code 1' });
  assert.deepEqual(outputEndOf(out.execCommand({ exitCode: 0, body: 'Exit code: 5' })), { status: 'ok' });
  assert.deepEqual(outputEndOf(out.execCommand({ exitCode: 124 })), { status: 'failed', errorLine: 'Exit code 124' });
  assert.deepEqual(outputEndOf(out.json({ exitCode: 2, body: 'rejected by user' })), { status: 'failed', errorLine: 'Exit code 2' });
  assert.deepEqual(outputEndOf(out.json({ exitCode: 0 })), { status: 'ok' });
  assert.deepEqual(outputEndOf({ output: 'x', metadata: { exit_code: 3 } }), { status: 'failed', errorLine: 'Exit code 3' });
  assert.deepEqual(outputEndOf(out.answers()), { status: 'ok' }, 'other JSON (answers, MCP results) is ok');
  assert.deepEqual(outputEndOf(out.mcpResult()), { status: 'ok' });
  assert.deepEqual(outputEndOf(out.planUpdated()), { status: 'ok' });
  assert.deepEqual(outputEndOf(out.image()), { status: 'ok' }, 'an image-only output has no text');
  assert.equal(outputText(out.script('first')), 'first');
  assert.equal(outputText({}), null);
});

test('row output content arrays and JSON arrays are result bodies: never judged by their words', () => {
  assert.deepEqual(outputEndOf([{ type: 'input_text', text: 'Deploy failed: rejected by user BAIT_RESULT_BODY' }]), { status: 'ok' });
  assert.deepEqual(outputEndOf('[{"type":"text","text":"aborted by user; approval required by policy"}]'), { status: 'ok' });
  assert.deepEqual(outputEndOf('Build failed: not JSON'), { status: 'failed', errorLine: 'tool failed' },
    'a plain-text output keeps the fixed-phrase rule (the line names our tool, not the text)');
});

test('row output Process running with session ID: ok with background (R28)', () => {
  assert.deepEqual(outputEndOf(out.execCommand({ running: true })), { status: 'ok', background: true });
});

test('row output denied: rejected by user, exec command rejected, patch rejected, approval policy, sandbox', () => {
  const denied = (line) => ({ status: 'denied', errorLine: line });
  assert.deepEqual(outputEndOf(out.rejected()), denied('Rejected by user'));
  assert.deepEqual(outputEndOf(out.execRejected()), denied('Rejected by user'));
  assert.deepEqual(outputEndOf(out.patchRejected()), denied('Rejected by user'));
  assert.deepEqual(outputEndOf(out.policy()), denied('Approval required by policy'));
  assert.deepEqual(outputEndOf(out.sandbox()), denied('Sandbox denied'));
  assert.deepEqual(outputEndOf(out.failedInSandbox()), denied('Sandbox denied'));
  assert.doesNotMatch(JSON.stringify([out.rejected(), out.sandbox()].map((o) => outputEndOf(o))), /BAIT/, 'fixed lines only');
});

test('row output aborted by user: interrupted', () => {
  assert.deepEqual(outputEndOf(out.aborted()), { status: 'interrupted', errorLine: 'Aborted by user' });
});

test('row output failures: timed out, Script failed / error, <tool> failed (the line names our tool, not the text)', () => {
  assert.deepEqual(outputEndOf(out.timedOut()), { status: 'failed', errorLine: 'Command timed out' });
  assert.deepEqual(outputEndOf(out.scriptFailed()[0].text), { status: 'failed', errorLine: 'Script failed' });
  assert.deepEqual(outputEndOf(out.scriptError()[0].text), { status: 'failed', errorLine: 'Script error' });
  assert.deepEqual(outputEndOf(out.toolFailed(), 'collaboration.spawn_agent'), { status: 'failed', errorLine: 'collaboration.spawn_agent failed' });
  assert.deepEqual(phraseEnd('secret-host failed: x', 'bad name/!'), { status: 'failed', errorLine: 'tool failed' });
  assert.equal(phraseEnd('All good.'), null);
});

test('row web_search_call: a web visit by url host or query', () => {
  const g = b();
  const q = webSearchCallOf(payloadOf(g.webSearchCall({ query: 'codex rollout format' })));
  assert.deepEqual(toolSummary(q.desc), { tool: 'web_search', summary: 'codex rollout format', room: 'research' });
  const u = webSearchCallOf(payloadOf(g.webSearchCall({ url: 'https://docs.example.com/page?token=BAIT_QUERY_TOKEN' })));
  assert.deepEqual(toolSummary(u.desc), { tool: 'web_search', summary: 'docs.example.com', room: 'research' });
  assert.deepEqual(webSearchCallOf(payloadOf(g.webSearchCall({ status: 'failed' }))).end, { status: 'failed' });
});


// Session-level helpers for the tool rows below (the same rows end to end: records -> SessionCore events).
const MAIN_ID = `codex-${CODEX_THREAD}`;
function mk({ version = NEW_VERSION } = {}) {
  return { s: new CodexSession({ id: MAIN_ID, agent: 'codex', kind: 'main', now: () => Date.parse('2026-10-20T09:00:00.000Z') }),
    g: createCodexBuilder({ cliVersion: version }) };
}
const run = (s, recs, opts) => recs.flat().flatMap((rec) => s.apply(rec, opts));
const of = (evs, type) => evs.filter((e) => e.type === type);
const noTs = (evs) => evs.map(({ ts, ...rest }) => rest);
const opening = (g, text = 'Fix the login bug') => [g.sessionMeta(), g.taskStarted(), g.userMessage(text)];

// ---------------------------------------------------------------------------------------------- tool rows through CodexSession

test('row function_call / *_output (old version): calls pair by call_id in any order, ends carry exit codes', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  run(s, opening(g));
  const a = g.execCommand('npm test');
  const aId = g.lastCallId;
  const c = g.shellCommand('git status');
  const cId = g.lastCallId;
  const evs = run(s, [a, c, g.functionOutput({ callId: cId, output: out.shellCommand({ exitCode: 0 }) }),
    g.functionOutput({ callId: aId, output: out.execCommand({ exitCode: 1 }) }), g.functionOutput({ callId: 'call_unknown' })]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.toolUseId, e.tool, e.summary]), [[aId, 'exec_command', 'npm test'], [cId, 'shell_command', 'git status']]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => [e.toolUseId, e.ok, e.error ?? null]), [[cId, true, null], [aId, false, 'Exit code 1']]);
});

test('row function_call shell (argv) and apply_patch: program from argv, file names from patch headers', () => {
  const { s, g } = mk({ version: '0.45.0' });
  const evs = run(s, [
    ...opening(g), g.shell(['bash', '-lc', 'pytest -k BAIT_ARG']), g.functionOutput({ output: out.json({ exitCode: 0 }) }),
    g.applyPatch(patchText(['src/auth/login.ts'])), g.customOutput({ output: out.shellCommand({ exitCode: 0 }) }),
    g.applyPatch(), g.customOutput({ output: out.patchRejected() }),
  ]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.tool, e.summary, e.room]),
    [['shell', 'pytest', 'server'], ['apply_patch', 'login.ts', 'dev'], ['apply_patch', 'login.ts', 'dev']]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.errorKind ?? 'ok'), ['ok', 'ok', 'denied']);
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|bait/);
});

test('row output: background, denied, interrupted and failed results through the session', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  run(s, opening(g));
  const cases = [
    [out.execCommand({ running: true }), true, undefined, undefined],
    [out.rejected(), false, 'denied', 'Rejected by user'],
    [out.policy(), false, 'denied', 'Approval required by policy'],
    [out.sandbox(), false, 'denied', 'Sandbox denied'],
    [out.aborted(), false, 'interrupted', 'Aborted by user'],
    [out.timedOut(), false, 'failed', 'Command timed out'],
  ];
  for (const [output, ok, kind, error] of cases) {
    const evs = run(s, [g.execCommand('npm run dev'), g.functionOutput({ output })]);
    const end = of(evs, 'tool_end')[0];
    assert.equal(end.ok, ok, String(output));
    assert.equal(end.errorKind, kind);
    assert.equal(end.error, error);
    assert.equal('background' in end, false, 'background never shows on tool_end (CONTRACT 2)');
  }
});

test('row function_call update_plan (pre-0.146): no tool_start; the board changes when the call ends ok', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const evs = run(s, [...opening(g), g.updatePlan([{ step: 'Read the code', status: 'completed' }, { step: 'Fix it', status: 'in_progress' }])]);
  assert.equal(of(evs, 'tool_start').length, 0);
  assert.equal(of(evs, 'plan').length, 0, 'not before the output (R35)');
  const done = run(s, [g.functionOutput({ output: out.planUpdated() })]);
  assert.deepEqual(noTs(done), [{ type: 'plan', sessionId: MAIN_ID, source: 'update_plan',
    items: [{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }] }]);
  const failed = run(s, [g.updatePlan([{ step: 'Other', status: 'pending' }]), g.functionOutput({ output: out.toolFailed('update_plan', 'bad') })]);
  assert.equal(of(failed, 'plan').length, 0, 'a failed plan call leaves the board');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT_EXPLANATION/);
});

test('row function_call request_user_input: an ask at the desk with question and option labels, ok at its answers', () => {
  const { s, g } = mk({ version: OLD_VERSION });
  const evs = run(s, [...opening(g), g.requestUserInput()]);
  const start = of(evs, 'tool_start')[0];
  assert.deepEqual([start.tool, start.room, start.question, start.options], ['request_user_input', 'desk', 'Which database should I use?', ['Postgres', 'SQLite']]);
  assert.deepEqual(s.snapshotEvents().find((e) => e.type === 'tool_start').options, ['Postgres', 'SQLite'], 'an open ask is in the snapshot');
  const done = run(s, [g.functionOutput({ output: out.answers() })]);
  assert.deepEqual(of(done, 'tool_end').map((e) => e.ok), [true]);
  assert.doesNotMatch(JSON.stringify([evs, done]), /BAIT/);
});

// Real-data regression (read-only counts check): request_user_input_async names its question `title`, so the question
// text was dropped and two questions gave the invalid question " (+1)" (CONTRACT 2: a question needs text).
test('row function_call request_user_input_async: the title is the question, string options are labels, ok at { accepted }', () => {
  const { s, g } = mk({ version: NEW_VERSION });
  const evs = run(s, [...opening(g), g.requestUserInputAsync()]);
  const start = of(evs, 'tool_start')[0];
  assert.deepEqual([start.tool, start.room, start.question, start.options], ['request_user_input_async', 'desk', 'Ship the fix now? (+1)', ['Yes', 'Later']]);
  const one = run(s, [g.functionOutput({ output: '{"accepted":true}' }), g.requestUserInputAsync([{ title: 'Deploy /Users/bait-user/app?', options: null }])]);
  assert.deepEqual(of(one, 'tool_end').map((e) => e.ok), [true]);
  assert.deepEqual([of(one, 'tool_start')[0].question, of(one, 'tool_start')[0].options], ['Deploy app?', []]);
  const both = callStartOf(payloadOf(g.requestUserInput([{ id: 'q', question: 'Pick one', title: 'BAIT_TITLE', options: [] }])));
  assert.equal(both.start.questions[0].question, 'Pick one', '`question` wins over `title` when both are there');
});

test('row spawn_agent / collaboration / MCP / view_image / clock.sleep: names, summaries and rooms', () => {
  const { s, g } = mk();
  const evs = run(s, [
    ...opening(g), g.spawnAgent({ agentType: 'explorer' }), g.functionOutput({ output: out.spawned() }),
    g.collab('wait_agent'), g.functionOutput({ output: '{}' }), g.mcp({ server: 'github', tool: 'get_issue', namespaced: true }),
    g.functionOutput({ output: out.mcpResult() }), g.mcp({ server: 'codegraph', tool: 'codegraph_search' }),
    g.functionOutput({ output: out.mcpResult() }), g.viewImage(), g.functionOutput({ output: out.image() }), g.clockSleep(),
  ]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.tool, e.summary, e.room ?? null]), [
    ['collaboration.spawn_agent', 'explorer', 'here'], ['collaboration.wait_agent', 'collaboration.wait_agent', 'here'],
    ['mcp__github__get_issue', 'get issue', null], ['mcp__codegraph__codegraph_search', 'codegraph search', null],
    ['view_image', 'shot.png', 'archive'], ['clock.sleep', 'clock.sleep', 'lounge'],
  ]);
  assert.equal(s.snapshotEvents().find((e) => e.type === 'tool_start').room, 'lounge', 'the lounge hint is in the snapshot too');
  assert.doesNotMatch(JSON.stringify(evs), /BAIT|bait/);
});

test('row plumbing: write_stdin, wait, search_tool_bm25, list_mcp_resources, get_goal never show, nor their outputs', () => {
  const { s, g } = mk();
  run(s, opening(g));
  const recs = [g.writeStdin(), g.functionOutput({ output: out.execCommand({ exitCode: 3 }) }), g.waitCall(), g.functionOutput()];
  for (const name of ['search_tool_bm25', 'list_mcp_resources', 'get_goal']) {
    recs.push(g.functionCall({ name, args: { q: 'BAIT_SEARCH_QUERY' } }), g.functionOutput({ output: 'BAIT_RESULT_BODY' }));
  }
  assert.deepEqual(run(s, recs), []);
});

test('row web_search_call (0.91-0.142.5): one short web visit', () => {
  const { s, g } = mk({ version: '0.120.0' });
  const evs = run(s, [...opening(g), g.webSearchCall({ query: 'codex rollout format' })]);
  assert.deepEqual(of(evs, 'tool_start').map((e) => [e.tool, e.summary, e.room]), [['web_search', 'codex rollout format', 'research']]);
  assert.deepEqual(of(evs, 'tool_end').map((e) => e.ok), [true]);
});
