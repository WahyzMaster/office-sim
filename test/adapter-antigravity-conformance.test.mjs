// Antigravity adapter conformance (ADAPTERS 10, CONTRACT 4.8): the shared harness (test/fixtures/conformance.mjs) runs the
// real server with the REAL antigravity descriptor (allowlist discovery in antigravity-cli/ and antigravity-ide/, the
// transcript_full.jsonl / transcript.jsonl preference and its live switch, the AntigravityMeta watcher over the summaries
// protobuf, annotations and task.md, AntigravitySession over SessionCore) against a synthetic ~/.gemini-shaped temp root
// (test/fixtures/antigravity-conf.mjs): CLI conversations in both transcript forms and both tool eras, a legacy IDE
// conversation with a task list, a conversation that leaves the active window, bait files next to the transcripts and
// in the desktop app root, and privacy bait in every field the adapter must never show (toolAction / toolSummary, file
// contents, command arguments, the Cwd, result bodies, metadata blocks, system and checkpoint text, never-read summary
// fields). Invented content, temp roots only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { runConformance } from './fixtures/conformance.mjs';
import { antigravityConformanceRoot, antigravityLiveSteps, BAIT, C, PROJECT, PROJECT_OLD } from './fixtures/antigravity-conf.mjs';
import { antigravity } from '../src/adapters/antigravity/index.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';
import { END_TURN_IDLE_MS } from '../src/core/session-core.mjs';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

const ALL_TYPES = ['session', 'session_end', 'prompt', 'tool_start', 'tool_end', 'thinking', 'say', 'plan', 'turn_end', 'system'];

test('conformance: the real antigravity adapter passes the shared harness (both files, both eras, CLI + IDE, switch, bait everywhere)', async () => {
  const f = await antigravityConformanceRoot();
  tmpDirs.push(f.root);
  const res = await runConformance(antigravity, f.root, {
    live: antigravityLiveSteps(f), bait: BAIT, neverOpen: f.neverOpen, mustSee: ALL_TYPES, timeoutMs: 8000,
  });
  const { ids } = f;
  const s = res.stream;
  if (process.env.AGY_CONF_DUMP) for (const e of s) console.log(JSON.stringify({ ...e, ts: undefined }));

  // allowlist: the scan reported and the Tailer read only the chosen transcripts (A3's late full file and A1's
  // transcript.jsonl only had their lines counted); A4 moved from transcript.jsonl to transcript_full.jsonl
  assert.deepEqual([...res.opened].sort(), [f.files.a1, f.files.a2, f.files.a3, f.files.a4, f.files.a4full, f.files.b1].sort());
  assert.ok(!s.some((e) => e.sessionId === C.desk), 'the desktop app root is never read (D6)');

  // sessions: D2 ids, titles (annotation > summary > first prompt), floors from the summary workspace or the Cwd fallback
  const sessions = (id) => s.filter((e) => e.type === 'session' && e.sessionId === id);
  const row = (id) => {
    const e = sessions(id).at(-1);
    return [e.title, e.project, e.projectLabel, e.branch, e.worktree, e.isSubagent, e.parentSessionId];
  };
  assert.deepEqual(row(C.a1), ['Fix the login flow in app.ts', PROJECT, 'conf-agy', 'feat/agy-conf', null, false, null]);
  assert.deepEqual(row(C.a2), ['Add a cache layer for the session store…', PROJECT, 'conf-agy', null, null, false, null],
    'no summary entry: the first USER_REQUEST (<= 40) and the first run_command Cwd');
  assert.deepEqual(row(C.a3), ['Old conversation in old', PROJECT_OLD, 'conf-agy-old', 'main', null, false, null]);
  assert.deepEqual(row(C.a4), ['Switching conversation', PROJECT, 'conf-agy', null, null, false, null]);
  assert.deepEqual(row(C.b1), ['IDE task list', PROJECT, 'conf-agy', 'detached', null, false, null]);
  assert.equal(sessions(C.a1)[0].title, 'Fix the login flow in app.ts', 'the first session event already has the metadata');
  assert.ok(sessions(C.a4).length >= 2, 'A4 is announced again from its new file');

  // tool starts: names of both eras, summaries from allowed fields only, rooms (ADAPTERS 6.2 Antigravity column)
  const start = (id) => s.find((e) => e.type === 'tool_start' && e.toolUseId === id);
  const brief = (id) => {
    const e = start(id);
    return e ? [e.tool, e.summary, e.room ?? null] : null;
  };
  assert.deepEqual([ids.view, ids.grep, ids.replace, ids.npmTest, ids.dev, ids.sched, ids.mcpUuid, ids.mcpGh, ids.web, ids.url,
    ids.write, ids.multi, ids.find, ids.readFile, ids.writeFile, ids.unknown, ids.cmdStatus, ids.killTask, ids.editFile].map(brief), [
    ['view_file', 'login.ts', 'archive'], ['grep_search', 'refreshToken · src', 'archive'], ['replace_file_content', 'token.ts', 'dev'],
    ['run_command', 'npm test', 'server'], ['run_command', 'npm run', 'server'], ['schedule', 'schedule', 'lounge'],
    [`mcp__${ZERO_UUID}__get_issue`, 'get issue', null], ['mcp__github__search_code', 'search code', null],
    ['search_web', 'oauth refresh token rotation', 'research'], ['read_url_content', 'docs.example.com', 'research'],
    ['write_to_file', 'session.ts', 'dev'], ['multi_replace_file_content', 'guard.ts', 'dev'], ['find_by_name', '*.spec.ts · test', 'archive'],
    ['read_file', 'login.ts', 'archive'], ['write_file', 'session.ts', 'dev'], ['future_tool', 'future_tool', 'here'],
    ['command_status', 'command_status', 'server'], ['manage_task', 'manage_task', 'server'], ['edit_file', 'token.ts', 'dev'],
  ]);
  assert.equal(start(ids.perms), undefined, 'list_permissions is hidden plumbing');
  assert.equal(start(ids.a2read), undefined, 'a call that started and ended in the attach replay is not on the wire');
  assert.deepEqual([ids.a2git, ids.a2write, ids.a2grep, ids.browser, ids.subagents, ids.image, ids.status, ids.task].map(brief), [
    ['run_command', 'git status', 'server'], ['write_file', 'write_file', 'dev'],
    ['grep_search', 'cacheKey · src', 'archive'], ['browser_subagent', 'browser_subagent', 'here'],
    ['manage_subagents', 'manage_subagents', 'here'], ['generate_image', 'generate_image', 'here'],
    ['command_status', 'command_status', 'server'], ['manage_task', 'manage_task', 'server'],
  ], 'transcript.jsonl arguments are decoded per field; a value cut by the truncation falls back to the tool name');
  assert.ok(!s.some((e) => e.type === 'tool_start' && e.sessionId === C.a2 && e.tool === 'run_command' && e.summary !== 'git status'),
    'tool_calls cut by the truncation: no tool is shown for that line');
  assert.deepEqual([start(ids.ask).question, start(ids.ask).options, start(ids.ask).room],
    ['Which database should the session store use?', ['Postgres', 'SQLite', 'Redis'], 'desk']);
  assert.deepEqual([start(ids.a2ask).question, start(ids.a2ask).options], ['Which store: db or Redis? (+1)', ['Postgres', 'SQLite', 'Redis', 'Memcached']]);

  // tool ends: by position (typed result types in another order), exit codes, ERROR, INVALID, RUNNING, abandoned closes
  const ends = Object.fromEntries(s.filter((e) => e.type === 'tool_end').map((e) => [e.toolUseId, e.ok ? 'ok' : `${e.errorKind}: ${e.error}`]));
  assert.deepEqual([ids.view, ids.grep, ids.replace, ids.npmTest, ids.dev, ids.sched, ids.mcpUuid, ids.mcpGh, ids.web, ids.url, ids.write,
    ids.multi, ids.find, ids.ask, ids.readFile, ids.writeFile, ids.a2git, ids.a2write, ids.a2grep, ids.browser, ids.subagents,
    ids.image, ids.status, ids.task].map((id) => ends[id]), [
    'ok', 'ok', 'ok', 'failed: Exit code 1', 'ok', 'ok', 'failed: MCP server unavailable', 'ok', 'ok', 'abandoned: no result', 'ok', 'ok',
    'abandoned: no result', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'failed: failed',
  ], 'the git status result was the cut last line at attach: it ends when the line is complete');
  assert.ok(!(ids.perms in ends) && !(ids.unknown in ends) && !(ids.editFile in ends) && !(ids.a2ask in ends));

  // prompts (the inner USER_REQUEST only, scrubbed), thinking, say, system lines
  assert.deepEqual(s.filter((e) => e.type === 'prompt').map((e) => [e.sessionId, e.text]), [
    [C.a1, 'Now ask me about the store in db.ts, mail (email)'], [C.a1, 'One more thing'], [C.a2, 'Second request, about cache.ts'],
  ], 'an input without a USER_REQUEST block (B1) gives no prompt; metadata blocks never');
  assert.deepEqual(s.filter((e) => e.type === 'thinking').map((e) => [e.sessionId, e.text, e.durationMs]),
    [[C.a1, 'Reading the auth module first.', null], [C.a1, 'Summarize the answer.', null]]);
  assert.deepEqual(s.filter((e) => e.type === 'say').map((e) => [e.sessionId, e.text]), [
    [C.a1, 'Found the expiry check.'], [C.a1, 'Done. Token check fixed; see notes.md for details.'], [C.a1, 'Postgres it is.'],
    [C.a2, 'Running the migration.'], [C.a2, 'Cache added.'], [C.b1, 'The page renders.'], [C.a4, 'Now from the full file.'],
  ]);
  assert.deepEqual(s.filter((e) => e.type === 'system').map((e) => [e.sessionId, e.kind, e.text]), [
    [C.a1, 'api_error', 'Model provider overloaded, retrying'], [C.a1, 'compact', 'Conversation compacted'],
  ]);

  assert.ok(f.statusEndMs < END_TURN_IDLE_MS / 4, `end_turn came ${f.statusEndMs} ms after the closing answer: from the summary status`);
  // turns: status idle ends the first A1 turn at once (end_turn); a USER_INPUT ends the next one (next_turn); an
  // ERROR_MESSAGE or CHECKPOINT does not end a turn
  assert.deepEqual(s.filter((e) => e.type === 'turn_end').map((e) => [e.sessionId, e.reason]),
    [[C.a1, 'end_turn'], [C.a1, 'next_turn'], [C.a2, 'next_turn']]);
  // plans: the IDE task.md checklist (source tasks), the snapshot board and the live change
  const plans = s.filter((e) => e.type === 'plan');
  assert.deepEqual(plans.map((e) => [e.sessionId, e.source]), [[C.b1, 'tasks'], [C.b1, 'tasks']]);
  assert.deepEqual(plans[0].items, [
    { content: 'Read the store module', status: 'completed' }, { content: 'Add a cache layer, see notes', status: 'in_progress' },
    { content: 'Test store.spec.ts', status: 'pending' }, { content: 'Ship it', status: 'pending' },
  ]);
  assert.deepEqual(plans[1].items.map((it) => it.status), ['completed', 'completed', 'in_progress', 'pending']);

  // session ends: A3 left the active window; A4 moved without an end
  assert.deepEqual(s.filter((e) => e.type === 'session_end').map((e) => [e.sessionId, e.reason]), [[C.a3, 'idle']]);
  // /state: live characters with exactly their open tools
  assert.deepEqual(res.state.filter((e) => e.type === 'session').map((e) => e.sessionId).sort(), [C.a1, C.a2, C.a4, C.b1].sort());
  assert.deepEqual(res.state.filter((e) => e.type === 'tool_start').map((e) => [e.sessionId, e.toolUseId]).sort(), [
    [C.a1, ids.unknown], [C.a1, ids.cmdStatus], [C.a1, ids.killTask], [C.a1, ids.editFile], [C.a2, ids.a2ask],
  ].sort());
  assert.deepEqual([res.stats.applyErrors, res.stats.badLines, res.stats.rejectedRefs], [0, 0, 0]);
  assert.deepEqual(res.logs.filter((l) => /failed|rejected/.test(l)), []);
});
