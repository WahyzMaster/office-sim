// Codex adapter conformance (ADAPTERS 10, CONTRACT 4.7): the shared harness (test/fixtures/conformance.mjs) runs the real
// server with the REAL codex descriptor (date-folder discovery with line-0 facts, continuation pieces, the incremental
// session_index.jsonl title reader, the D1 floor hook, CodexSession over SessionCore) against a synthetic ~/.codex-shaped
// temp root (test/fixtures/codex-conf.mjs): a code-mode main and a pre-code-mode main, nested subs across date folders,
// a /review sub, a parent outside the window, a rollback continuation piece, a guardian thread with a child, bait files
// next to the rollouts and privacy bait in every record field the adapter must never show. Invented content, temp roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runConformance } from './fixtures/conformance.mjs';
import { codexConformanceRoot, codexLiveSteps, BAIT, C, T, CWD, CWD_OLD } from './fixtures/codex-conf.mjs';
import { codex } from '../src/adapters/codex/index.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

const ALL_TYPES = ['session', 'session_end', 'prompt', 'tool_start', 'tool_end', 'thinking', 'say', 'plan', 'turn_end', 'system'];
const MCP_ZERO = `mcp__${ZERO_UUID}__get_issue`;

test('conformance: the real codex adapter passes the shared harness (both eras, nested subs, continuation, guardian, bait everywhere)', async () => {
  const f = await codexConformanceRoot();
  tmpDirs.push(f.root);
  const res = await runConformance(codex, f.root, { live: codexLiveSteps(f), bait: BAIT, neverOpen: f.neverOpen, mustSee: ALL_TYPES, timeoutMs: 6000 });
  const { ids } = f;
  const s = res.stream;

  // allowlist: only the rollouts of shown threads (the winning piece of M2, not its stale base) were scanned or tailed
  const threadOf = (p) => /-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$/.exec(path.basename(p))?.[1];
  assert.deepEqual([...res.opened].map(threadOf).sort(), [T.m1, T.s1, T.s2, T.s5, T.m2, T.r, T.m3, T.s4].sort());
  assert.ok([...res.opened].some((p) => p === f.files.m2) && ![...res.opened].includes(f.files.m2base), 'the continuation piece wins');
  for (const id of [C.g, C.gc, C.s5]) assert.ok(!s.some((e) => e.sessionId === id), `${id} is never shown (guardian D10a, F4)`);

  // sessions: D2 ids, index titles (the first event already has it), fallbacks, floors, nested parents, the review sub
  const sessions = (id) => s.filter((e) => e.type === 'session' && e.sessionId === id);
  const last = (id) => sessions(id).at(-1);
  const row = (id) => {
    const e = last(id);
    return [e.title, e.project, e.projectLabel, e.branch, e.worktree, e.isSubagent, e.parentSessionId, e.agentType ?? null];
  };
  assert.deepEqual(row(C.m1), ['Codex conformance main 2', CWD, 'conf-codex', 'feat/conf', null, false, null, null]);
  assert.deepEqual(sessions(C.m1).map((e) => e.title), ['Codex conformance main', 'Codex conformance main 2'], 'index title from the start, live rename');
  assert.deepEqual(row(C.m2), ['Old era: fix a.py', CWD_OLD, 'conf-old', 'detached', null, false, null, null]);
  assert.deepEqual(row(C.m3), ['A first request that is much longer tha…', CWD_OLD, 'conf-old', null, null, false, null, null],
    'no index entry: the first human prompt (<= 40); git: null -> no branch; a parent outside the window is shown');
  assert.deepEqual(row(C.s1), ['Hume', CWD, 'conf-codex', 'feat/login', 'sub-a', true, C.m1, 'explorer'], 'nickname title, root main floor, badge');
  assert.deepEqual(row(C.s2), ['nested', CWD, 'conf-codex', 'feat/login', null, true, C.s1, 'worker'], 'agent_path tail, nested parent');
  assert.deepEqual(row(C.r), ['Review pass', CWD_OLD, 'conf-old', 'feat/login', null, true, C.m2, 'review'], '/review is an ordinary sub (D10d)');
  assert.deepEqual(row(C.s4), ['Ada', CWD_OLD, 'conf-old', 'feat/login', null, true, C.m3, 'explorer']);

  // code-mode tools: the outer exec (summary and room from the first script tool) and the inner visits keyed by item id
  const start = (id, sid = C.m1) => s.find((e) => e.type === 'tool_start' && e.sessionId === sid && e.toolUseId === id);
  const brief = (id, sid) => {
    const e = start(id, sid);
    return [e.tool, e.summary, e.room ?? null];
  };
  assert.deepEqual(brief(ids.exec1), ['exec', 'exec_command', 'server']);
  assert.deepEqual([ids.vFail, ids.vPatch, ids.vPatchNo, ids.vWeb, ids.vQuery, ids.vImage, ids.vMcp, ids.vMcpBad, ids.vDeclined, ids.vDeploy]
    .map((id) => brief(id)), [
    ['exec_command', 'npm test', 'server'], ['apply_patch', 'app.js (+1)', 'dev'], ['apply_patch', 'login.ts', 'dev'],
    ['web_search', 'docs.bait.example.com', 'research'], ['web_search', 'codex rollout format', 'research'], ['view_image', 'shot.png', 'archive'],
    [MCP_ZERO, 'get issue', null], ['mcp__github__search_code', 'search code', null], ['exec_command', 'rm', 'server'],
    ['exec_command', 'deploy', 'server'],
  ]);
  assert.deepEqual([ids.xPatch, ids.xMcp, ids.xWeb, ids.xUuid, ids.xPlain, ids.xImage, ids.xAbort, ids.xOpen].map((id) => brief(id)), [
    ['exec', 'apply_patch', 'dev'], ['exec', 'mcp__github__search_code', 'research'], ['exec', 'web_search', 'research'],
    ['exec', MCP_ZERO, 'research'], ['exec', 'exec', 'here'], ['exec', 'view_image', 'archive'], ['exec', 'exec_command', 'server'],
    ['exec', 'exec_command', 'server'],
  ], 'identifiers only: comments, strings and plumbing names (wait) are passed over');
  assert.deepEqual(brief(ids.sleep), ['clock.sleep', 'clock.sleep', 'lounge']);
  assert.deepEqual([start(ids.ask).question, start(ids.ask).options, start(ids.ask).room], ['Deploy to prod now?', ['Yes', 'No'], 'desk']);
  assert.ok(!s.some((e) => e.type === 'tool_start' && ['write_stdin', 'wait', 'update_plan'].includes(e.tool)), 'plumbing and update_plan are hidden');
  // pre-code-mode tools: the per-tool calls and their rooms
  assert.deepEqual([ids.rm, ids.bg, ids.shellOk, ids.shellNo, ids.policy, ids.sandbox, ids.timeout, ids.patch, ids.mcpOld, ids.mcpNs, ids.view,
    ids.wsc, ids.wscBad, ids.spawnNo, ids.waitAgent, ids.app, ids.askOk, ids.m2open2].map((id) => brief(id, C.m2)), [
    ['exec_command', 'rm', 'server'], ['exec_command', 'npm run', 'server'], ['shell', 'git status', 'server'], ['shell', 'ls', 'archive'],
    ['exec_command', 'cat', 'archive'], ['exec_command', 'curl', 'research'], ['exec_command', 'sleep', 'server'], ['apply_patch', 'x.py', 'dev'],
    [MCP_ZERO, 'get issue', null], ['mcp__github__search_code', 'search code', null], ['view_image', 'shot.png', 'archive'],
    ['web_search', 'docs.bait.example.com', 'research'], ['web_search', 'codex format', 'research'], ['spawn_agent', 'worker', 'here'],
    ['collaboration.wait_agent', 'collaboration.wait_agent', 'here'], ['codex_app.open_url', 'codex_app.open_url', 'here'],
    ['request_user_input', 'request_user_input', 'desk'], ['shell', 'git log', 'server'],
  ]);

  // end statuses: exit codes, fixed phrases, declines, aborts; the error lines are fixed text, never output words
  const ends = (sid) => Object.fromEntries(s.filter((e) => e.type === 'tool_end' && e.sessionId === sid)
    .map((e) => [e.toolUseId, e.ok ? 'ok' : `${e.errorKind}: ${e.error}`]));
  const m1 = ends(C.m1);
  assert.deepEqual([ids.vFail, ids.vPatch, ids.vPatchNo, ids.vWeb, ids.vMcp, ids.vMcpBad, ids.vDeclined, ids.exec1, ids.xPatch, ids.xMcp,
    ids.xWeb, ids.xUuid, ids.xPlain, ids.sleep, ids.vDeploy, ids.xAbort].map((id) => m1[id]), [
    'failed: Exit code 1', 'ok', 'denied: Patch declined', 'ok', 'ok', 'failed: MCP tool error', 'denied: Command declined', 'failed: Script failed',
    'ok', 'interrupted: Aborted by user', 'denied: Rejected by user', 'failed: Script error', 'ok', 'ok', 'ok', 'interrupted: interrupted',
  ]);
  const m2 = ends(C.m2);
  assert.deepEqual([ids.m2open, ids.rm, ids.bg, ids.shellOk, ids.shellNo, ids.policy, ids.sandbox, ids.sandbox2, ids.timeout, ids.abort, ids.patch,
    ids.patchNo, ids.mcpOld, ids.mcpNs, ids.view, ids.wsc, ids.wscBad, ids.spawnNo, ids.waitAgent, ids.app, ids.askOk].map((id) => m2[id]), [
    'failed: Exit code 3', 'failed: Exit code 2', 'ok', 'ok', 'denied: Rejected by user', 'denied: Approval required by policy',
    'denied: Sandbox denied', 'denied: Sandbox denied', 'failed: Command timed out', 'interrupted: Aborted by user', 'ok',
    'denied: Rejected by user', 'ok', 'failed: search_code failed', 'ok', 'ok', 'failed: failed', 'failed: spawn_agent failed', 'ok', 'ok', 'ok',
  ]);
  assert.ok(!(ids.plan in m2) && !start(ids.plan, C.m2), 'update_plan: no tool_start, no tool_end (R35)');

  // turns, prompts, text (one source per version: no duplicates), system lines, plans
  const turns = (sid) => s.filter((e) => e.type === 'turn_end' && e.sessionId === sid).map((e) => e.reason);
  assert.deepEqual([turns(C.m1), turns(C.m2), turns(C.s1), turns(C.r)], [['api_error', 'interrupt', 'end_turn'], ['end_turn'], [], []]);
  assert.deepEqual(s.filter((e) => e.type === 'prompt').map((e) => [e.sessionId, e.text]), [
    [C.m1, 'Now deploy from proj and mail (email)'], [C.m1, 'Quick check'], [C.m1, 'Third request'], [C.m2, 'Old era third'],
  ], 'a sub never has prompts; role:user messages and <tags> are never prompts');
  assert.deepEqual(s.filter((e) => e.type === 'say').map((e) => [e.sessionId, e.text]), [
    [C.m1, 'Edited app.js; see (email) for review.'], [C.m1, 'All good.'], [C.s1, 'Found it in a.js'], [C.s2, 'Nested result.'],
    [C.m2, 'Old era done.'], [C.r, 'Review: two issues in a.py'],
  ]);
  assert.deepEqual(s.filter((e) => e.type === 'thinking').map((e) => [e.sessionId, e.text, e.durationMs]), [[C.m1, 'Edit the app next.', 1200]]);
  assert.deepEqual(s.filter((e) => e.type === 'system').map((e) => [e.sessionId, e.kind, e.text]), [
    [C.m1, 'compact', 'Conversation compacted'], [C.m1, 'api_error', 'Upstream 500 at api.bait.example.com'],
  ]);
  const plans = s.filter((e) => e.type === 'plan');
  assert.deepEqual(plans.map((e) => [e.sessionId, e.source]), [[C.m1, 'exit_plan'], [C.m2, 'update_plan']]);
  assert.deepEqual(plans[1].items, [{ content: 'Read a.py', status: 'completed' }, { content: 'Fix it', status: 'in_progress' },
    { content: 'Ship', status: 'pending' }]);
  assert.ok(plans[0].items.some((it) => it.content === 'Read spec.md'));

  // subs: S1 ends at its parent's SubAgentActivity completed (not at started / interacted); S2 lives on after the fallback
  assert.deepEqual(s.filter((e) => e.type === 'session_end').map((e) => [e.sessionId, e.reason]), [[C.s1, 'done']]);
  // /state: live characters with exactly their open tools (the ask with its fields, the S2 fallback exec)
  assert.deepEqual(res.state.filter((e) => e.type === 'session').map((e) => e.sessionId).sort(), [C.m1, C.m2, C.m3, C.s2, C.r, C.s4].sort());
  assert.deepEqual(res.state.filter((e) => e.type === 'tool_start').map((e) => [e.sessionId, e.toolUseId]).sort(), [
    [C.m1, ids.ask], [C.m1, ids.xOpen], [C.s2, ids.s2exec], [C.m2, ids.m2open2], [C.r, ids.rOpen2], [C.s4, ids.s4exec],
  ].sort());
  assert.deepEqual([res.stats.applyErrors, res.stats.badLines, res.stats.rejectedRefs], [0, 0, 0]);
});
