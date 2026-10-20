// Codex conformance fixture (test/adapter-codex-conformance.test.mjs): a synthetic ~/.codex-shaped temp root with every
// kind of thread the adapter must handle, and the live steps that put every event type and every end status on the
// wire. Records come from test/fixtures/codex.mjs (shaped from docs/research/codex-format.json); all content invented.
//   M1  main, code mode (NEW_VERSION), started yesterday (hot folder); exec with inner items, plan item, ask, subs
//   S1  sub of M1 (today), inherited parent context before subagent_history_start_ordinal (dropped at H)
//   S2  sub of S1 (today), H = its line count (the fallback: nothing >= H, the records are its own)
//   S5  sub of M1 whose SubAgentActivity completed is in M1 before attach (F4: never shown)
//   M2  main before code mode (OLD_VERSION) in a 10-day-old folder (cold, resumed), a stale base file and the winning
//       rollback continuation piece; R a /review thread under it (today)
//   M3  main outside the window in a 40-day-old folder (found by uuid as S4's parent); S4 its sub (today)
//   G   guardian thread under M1 and GC its child: hidden entirely (D10a)
// Bait files a Codex root holds next to the rollouts, a .zst rollout, archived rollouts and a symlinked rollout name
// must never be opened. Privacy bait sits in every field the adapter must not show (every token starts with BAIT_).
// Side-effect free at import.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexBuilder, toJsonl, out, patchText, OLD_VERSION, NEW_VERSION } from './codex.mjs';
import { cid, charOf, rolloutPath, setMtime, appendLines, appendIndex } from './codex-tree.mjs';
import { dayKey } from '../../src/adapters/codex/discover.mjs';

export const MCP_UUID = '3f2a9c4e-1b7d-4e8a-9c3f-5d6e7f8a9b0c';
export const CWD = '/work/conf-codex';
export const CWD_SUB = '/work/conf-codex/.worktrees/sub-a';
export const CWD_OLD = '/work/conf-old';
export const T = {
  m1: cid(1), s1: cid(2), s2: cid(3), s5: cid(4), m2: cid(5), piece: cid(55), r: cid(6), m3: cid(7), s4: cid(8),
  g: cid(9), gc: cid(10), link: cid(11), zst: cid(12), arch: cid(13),
};
export const C = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, `codex-${v}`]));
// Every planted token starts with BAIT_; the rest are scrubbed shapes (paths, emails, URL queries, injected text).
export const BAIT = [
  'BAIT_', '/Users/bait-user', 'bait-user/', 'bait.person@example.com', '?token=', '?key=', 'Ignore all previous', 'rm -rf',
  'QkFJVA', 'repo.git', MCP_UUID, MCP_UUID.replace(/-/g, '_'),
];

const DAY = 86_400_000;
const isoDay = (ago) => dayKey(Date.now() - ago * DAY);
const scriptOut = (text) => [{ type: 'input_text', text }];

async function put(root, day, id, recs, { piece = null, mtimeMs = null } = {}) {
  const file = rolloutPath(root, day, id, piece);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, toJsonl(recs));
  if (mtimeMs !== null) await setMtime(file, mtimeMs);
  return file;
}

async function putFile(file, body, files) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  files.push(file);
}

// Files next to the rollouts that the allowlist (ADAPTERS 7.1) never opens.
async function writeBaitFiles(root) {
  const files = [];
  const secret = (tag) => `${JSON.stringify({ secret: `BAIT_${tag}`, prompt: 'BAIT_RAW_PROMPT', cwd: '/Users/bait-user/proj' })}\n`;
  for (const [rel, tag] of [
    ['history.jsonl', 'HISTORY'], ['auth.json', 'AUTH'], ['config.toml', 'CONFIG'], ['AGENTS.md', 'AGENTS'],
    ['state_5.sqlite', 'SQLITE'], ['thread_history_1.sqlite', 'SQLITE'], ['logs_2.sqlite', 'SQLITE'], ['sqlite/codex-dev.db', 'SQLITE'],
    ['.codex-global-state.json', 'GLOBAL_STATE'], [`thread-writer-locks/${T.m1}.lock`, 'LOCK'], ['version.json', 'VERSION'],
    ['external_agent_session_imports.json', 'IMPORTS'], ['log/codex-tui.log', 'LOG'], ['shell_snapshots/snap.sh', 'SNAPSHOT'],
    ['worktrees/a1b2/conf-codex/secret.txt', 'WORKTREE_FILE'], ['sessions/index.json', 'INDEX_JSON'],
    [`sessions/${isoDay(0)}/notes.txt`, 'NOTES'],
    [`archived_sessions/rollout-2026-10-20T09-00-00-${T.arch}.jsonl.zst`, 'ARCHIVED'],
  ]) await putFile(path.join(root, rel), secret(tag), files);
  // a plain archived rollout and a compressed one in a live date folder: valid names, never opened
  const arch = createCodexBuilder({ threadId: T.arch, cwd: '/work/BAIT_ARCHIVED' });
  await putFile(path.join(root, 'archived_sessions', `rollout-2026-10-20T09-00-00-${T.arch}.jsonl`), toJsonl([arch.sessionMeta()]), files);
  await putFile(`${rolloutPath(root, isoDay(0), T.zst)}.zst`, 'BAIT_ZST', files);
  // a symlinked rollout name pointing outside sessions/: a link is no entry
  const target = path.join(root, 'outside', 'target.jsonl');
  const lnk = createCodexBuilder({ threadId: T.link, cwd: '/work/BAIT_SYMLINK' });
  await putFile(target, toJsonl([lnk.sessionMeta(), lnk.taskStarted(), lnk.userMessage('BAIT_SYMLINK prompt')]), files);
  const link = rolloutPath(root, isoDay(0), T.link);
  await fsp.symlink(target, link);
  files.push(link);
  return files;
}

// M1 (code mode). Turn 1 is complete at attach; turn 2 is open with an exec whose first inner command was already seen.
function m1Records(m, ids) {
  const recs = [
    m.sessionMeta({ cwd: CWD, branch: 'feat/conf' }), m.turnContext(), m.threadSettings(), m.taskStarted(), m.developer(),
    m.userContext(), m.userMessage('<environment_context>BAIT_INJECTED</environment_context>'),
    m.userMessage('Check /Users/bait-user/secret/notes.md for bait.person@example.com', { image: true }),
    ...m.think('Plan the work first. BAIT_THINKING_TAIL'),
    m.exec('await tools.update_plan({ plan: [{ step: "BAIT_SCRIPT_PLAN", status: "pending" }] });'),
    m.execOutput(out.script('Plan updated BAIT_RESULT_BODY')),
    m.planItem('# Plan\n\n1. Read /Users/bait-user/proj/spec.md\n2. Fix the token check\n```\nBAIT_FENCE\n```'),
    ...m.say('First pass done.', { phase: 'final_answer' }), m.tokenCount(), m.tokenUsage(), m.worldState(), m.taskComplete(),
    m.taskStarted(), m.userMessage('Second request'),
    m.spawnAgent({ agentType: 'worker' }), m.functionOutput({ output: out.spawned() }),
    m.subAgentActivity({ child: T.s5, kind: 'started' }), m.subAgentActivity({ child: T.s5, kind: 'completed' }),
    m.exec('await tools.spawn_agent({ agent_type: "explorer", message: "BAIT_SUB_TASK" });'),
  ];
  ids.execSpawn = m.lastCallId;
  recs.push(m.collabItem(), m.execOutput(out.script('spawned BAIT_RESULT_BODY')));
  recs.push(m.exec('const r = await tools.exec_command({ cmd: "cat /Users/bait-user/BAIT_SCRIPT_ARG" });\ntext(r.output);'));
  ids.exec1 = m.lastCallId;
  recs.push(m.commandItem({ script: 'cat /Users/bait-user/proj/BAIT_CMD_ARG', parsed: 'cat /Users/bait-user/proj/BAIT_CMD_ARG' }));
  return recs;
}

// S1: line 0, then H-1 inherited copies of the parent's context (bait that must vanish at the reset), then its own work.
function s1Records(s1, ids) {
  const p = createCodexBuilder({ threadId: T.m1, cliVersion: NEW_VERSION, cwd: CWD, startMs: Date.now() - 120_000, stepMs: 50 });
  const ctx = [p.sessionMeta(), p.taskStarted(), p.userMessage('BAIT_INHERITED_PROMPT'),
    p.requestUserInput([{ id: 'q', question: 'BAIT_INHERITED_QUESTION', options: [{ label: 'BAIT_INHERITED_OPTION' }] }]),
    p.compacted(), ...p.say('BAIT_INHERITED_SAY')];
  const recs = [s1.sessionMeta({ cwd: CWD_SUB, sub: { parent: T.m1, role: 'explorer', nickname: 'Hume', path: '/root/hume' },
    historyStart: 1 + ctx.length })];
  recs.push(...s1.inherit(ctx));
  recs.push(s1.taskStarted(), s1.userMessage('Task from the parent: BAIT_SUB_TASK in /Users/bait-user/proj'),
    ...s1.think('Search the tree first.'), s1.exec('await tools.spawn_agent({ agent_type: "explorer", message: "BAIT_SUB_TASK" });'),
    s1.execOutput(), s1.exec('await tools.exec_command({ cmd: "rg -n BAIT_SCRIPT_ARG src" });'));
  ids.s1exec = s1.lastCallId;
  recs.push(s1.commandItem({ script: 'rg -n needle /Users/bait-user/proj/src', parsed: 'rg -n needle /Users/bait-user/proj/src' }));
  return recs;
}

// S2: H is its line count (an older migrated file, cli < 0.154): every record is below H and is kept as its own (fallback).
function s2Records(s2, ids) {
  const recs = [s2.sessionMeta({ cwd: CWD, sub: { parent: T.s1, role: 'worker', path: '/root/hume/nested' }, historyStart: 4 }),
    s2.taskStarted(), s2.userMessage('Nested task BAIT_SUB_TASK'),
    s2.exec('await tools.view_image({ path: "/Users/bait-user/BAIT_SCRIPT_ARG.png" });')];
  ids.s2exec = s2.lastCallId;
  return recs;
}

// M2: the stale base (never read) and the continuation piece that wins (ordinal of its line 0 above 0).
function m2Records(base, m2, ids) {
  const stale = [base.sessionMeta({ cwd: CWD_OLD, branch: 'HEAD', cliVersion: OLD_VERSION }), base.taskStarted(),
    base.userMessage('BAIT_STALE_BASE prompt')];
  for (let i = 0; i < 10; i++) stale.push(...base.say(`BAIT_STALE_BASE ${i}`));
  m2.skipTo(8);
  const piece = [m2.sessionMeta({ cwd: CWD_OLD, branch: 'HEAD', cliVersion: OLD_VERSION }), m2.turnContext(), m2.taskStarted(),
    m2.userMessage('Old era first request https://bait.example.com/x?token=BAIT_QUERY_TOKEN'), ...m2.think('Look at the old code.'),
    ...m2.say('Reading.'), m2.execCommand('ls -la /Users/bait-user/proj'), m2.functionOutput({ output: out.execCommand() }),
    m2.taskComplete(), m2.taskStarted(), m2.userMessage('Old era second'), m2.shellCommand('npm test -- BAIT_CMD_ARG')];
  ids.m2open = m2.lastCallId;
  return { stale, piece };
}

function reviewRecords(r, ids) {
  const recs = [r.sessionMeta({ cwd: CWD_OLD, cliVersion: OLD_VERSION, review: true, extra: { parent_thread_id: T.m2 } }),
    r.taskStarted(), r.userMessage('<user_action>BAIT_INJECTED review</user_action>'), r.execCommand('git diff BAIT_CMD_ARG')];
  ids.rOpen = r.lastCallId;
  return recs;
}

/** Write the whole root. Returns { root, files, ids, builders, neverOpen }. */
export async function codexConformanceRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-conf-codex-'));
  const now = Date.now();
  const mk = (threadId, cliVersion = NEW_VERSION, startMs = now - 60_000, cwd = CWD) => createCodexBuilder({ threadId, cliVersion, cwd, startMs, stepMs: 20 });
  const b = { m1: mk(T.m1), s1: mk(T.s1), s2: mk(T.s2, '0.150.0'), s5: mk(T.s5), m2: mk(T.m2, OLD_VERSION, now - 60_000, CWD_OLD),
    r: mk(T.r, OLD_VERSION, now - 60_000, CWD_OLD), m3: mk(T.m3, OLD_VERSION, now - 2 * 3_600_000 - 60_000),
    s4: mk(T.s4, NEW_VERSION, now - 30_000), g: mk(T.g), gc: mk(T.gc) };
  const ids = {};
  const files = {};
  files.m1 = await put(root, isoDay(1), T.m1, m1Records(b.m1, ids));
  files.s1 = await put(root, isoDay(0), T.s1, s1Records(b.s1, ids));
  files.s2 = await put(root, isoDay(0), T.s2, s2Records(b.s2, ids));
  files.s5 = await put(root, isoDay(0), T.s5, [b.s5.sessionMeta({ sub: { parent: T.m1, role: 'worker' } }), b.s5.taskStarted(),
    ...b.s5.say('Finished child BAIT_FINISHED_CHILD'), b.s5.taskComplete()]);
  const { stale, piece } = m2Records(mk(T.m2, OLD_VERSION, now - 300_000, CWD_OLD), b.m2, ids);
  files.m2base = await put(root, isoDay(10), T.m2, stale, { mtimeMs: now - 120_000 });
  files.m2 = await put(root, isoDay(10), T.m2, piece, { piece: T.piece });
  files.r = await put(root, isoDay(0), T.r, reviewRecords(b.r, ids));
  const m3 = b.m3;
  files.m3 = await put(root, isoDay(40), T.m3, [m3.sessionMeta({ cwd: CWD_OLD, branch: null }), m3.taskStarted(),
    m3.userMessage('A first request that is much longer than forty characters in total'), m3.spawnAgent({ agentType: 'explorer' }),
    m3.functionOutput({ output: out.spawned() })], { mtimeMs: now - 2 * 3_600_000 });
  const s4 = b.s4;
  files.s4 = await put(root, isoDay(0), T.s4, [s4.sessionMeta({ cwd: CWD_OLD, sub: { parent: T.m3, role: 'explorer', nickname: 'Ada' } }),
    s4.taskStarted(), s4.exec('await tools.mcp__github__get_issue({ id: "BAIT_SCRIPT_ARG" });')]);
  ids.s4exec = s4.lastCallId;
  const g = b.g;
  files.g = await put(root, isoDay(0), T.g, [g.sessionMeta({ cwd: CWD, guardian: true, extra: { parent_thread_id: T.m1 } }), g.taskStarted(),
    ...g.say('BAIT_GUARDIAN_SAY'), g.execCommand('BAIT_GUARDIAN_CMD')]);
  files.gc = await put(root, isoDay(0), T.gc, [b.gc.sessionMeta({ cwd: CWD, sub: { parent: T.g, role: 'worker' } }), b.gc.taskStarted(),
    ...b.gc.say('BAIT_GUARDIAN_CHILD')]);
  await appendIndex(root, [[T.m1, 'Codex conformance main'], [T.m2, 'Old era: fix /Users/bait-user/proj/a.py'],
    [T.g, 'BAIT_GUARDIAN_TITLE'], [T.gc, 'BAIT_GUARDIAN_TITLE']]);
  await fsp.appendFile(path.join(root, 'session_index.jsonl'), `not json BAIT_INDEX_BAD\n${JSON.stringify({ id: T.r, thread_name: 'Review pass',
    updated_at: '2026-10-20T09:00:00Z', cwd: '/Users/bait-user/BAIT_INDEX_EXTRA', prompt: 'BAIT_INDEX_EXTRA' })}\n`);
  const bait = await writeBaitFiles(root);
  return { root, files, ids, b, neverOpen: [...bait, files.m2base, files.g, files.gc] };
}

// M1 live: the open exec gets its inner items (every visit kind and status) and fails; then every outer exec status,
// text, plumbing, compaction, ignored types and an api error; then an interrupt, a plain turn and an open ask.
function m1Live(m, ids) {
  const step1 = [];
  const visit = (rec, key) => { step1.push(rec); ids[key] = m.lastItemId; };
  visit(m.commandItem({ script: 'npm test', parsed: 'npm test', exitCode: 1 }), 'vFail');
  visit(m.fileChangeItem({ paths: ['/Users/bait-user/proj/src/app.js', '/Users/bait-user/proj/src/b.js'] }), 'vPatch');
  visit(m.fileChangeItem({ status: 'declined' }), 'vPatchNo');
  visit(m.webSearchItem({ url: 'https://docs.bait.example.com/page?token=BAIT_QUERY_TOKEN&u=bait.person@example.com' }), 'vWeb');
  visit(m.webSearchItem({ query: 'codex rollout format' }), 'vQuery');
  visit(m.imageViewItem(), 'vImage');
  visit(m.mcpItem({ server: MCP_UUID }), 'vMcp');
  visit(m.mcpItem({ server: 'github', tool: 'search_code', status: 'failed', error: 'BAIT_RESULT_BODY' }), 'vMcpBad');
  visit(m.commandItem({ script: 'rm -rf /Users/bait-user/proj', parsed: null, status: 'declined' }), 'vDeclined');
  step1.push(m.execOutput(out.scriptFailed(), ids.exec1));
  const step2 = [];
  const exec = (script, output, key) => { step2.push(m.exec(script)); ids[key] = m.lastCallId; if (output) step2.push(m.execOutput(output)); };
  exec('await tools.apply_patch("*** Begin Patch\\n*** Update File: /Users/bait-user/proj/a.js\\nBAIT_PATCH_BODY");', null, 'xPatch');
  step2.push(m.fileChangeItem({ paths: ['/Users/bait-user/proj/a.js'] }), m.execOutput(out.script()));
  exec('// tools.exec_command("BAIT_SCRIPT_ARG")\nconst s = "tools.view_image";\nawait tools.mcp__github__search_code({ q: "BAIT_SCRIPT_ARG" });',
    scriptOut('aborted by user after 2s'), 'xMcp');
  exec('await tools.web_search({ query: "BAIT_SCRIPT_ARG" });', scriptOut('exec rejected by user BAIT_DENY_REASON'), 'xWeb');
  exec(`await tools.mcp__${MCP_UUID.replace(/-/g, '_')}__get_issue({ id: "BAIT_SCRIPT_ARG" });`, out.scriptError(), 'xUuid');
  exec('text("hello BAIT_SCRIPT_ARG")', out.script(), 'xPlain');
  exec('await tools.wait({ cell_id: "c1" });\nawait tools.view_image({ path: "/Users/bait-user/BAIT_SCRIPT_ARG.png" });', out.script(), 'xImage');
  step2.push(...m.think('Edit the app next. BAIT_THINKING_TAIL'), ...m.say('Edited app.js; see bait.person@example.com for review.'));
  step2.push(m.clockSleep());
  ids.sleep = m.lastCallId;
  step2.push(m.functionOutput({ output: 'slept' }), m.writeStdin(), m.functionOutput({ output: out.execCommand() }));
  step2.push(m.compacted(), m.compaction(), m.contextCompactionItem(), m.extensionItem(), m.unknown(), m.unknownEvent(), m.goalUpdated(),
    m.interAgentMeta(), m.agentMessage(), m.commandItem({ script: 'BAIT_STRAY_CMD', parsed: 'BAIT_STRAY_CMD' }));
  step2.push(m.taskComplete({ error: 'Upstream 500 at https://api.bait.example.com/v1?key=BAIT_QUERY_TOKEN\nBAIT_SYSTEM_SECOND_LINE' }));
  const step3 = [m.taskStarted(), m.userMessage('Now deploy from /Users/bait-user/proj and mail bait.person@example.com'),
    m.exec('await tools.exec_command({ cmd: "deploy BAIT_SCRIPT_ARG" });')];
  ids.xAbort = m.lastCallId;
  step3.push(m.commandItem({ script: 'deploy', parsed: 'deploy' }));
  ids.vDeploy = m.lastItemId;
  step3.push(m.turnAborted(), m.taskStarted(), m.userMessage('Quick check'), ...m.say('All good.', { phase: 'final_answer' }), m.taskComplete(),
    m.taskStarted(), m.userMessage('Third request'), m.requestUserInput([{ id: 'q1', header: 'BAIT_HEADER', question: 'Deploy to /Users/bait-user/prod now?',
      options: [{ label: 'Yes', description: 'BAIT_OPTION_DESC' }, { label: 'No', description: 'BAIT_OPTION_DESC' }] }]));
  ids.ask = m.lastCallId;
  step3.push(m.exec('await tools.exec_command({ cmd: "ls BAIT_SCRIPT_ARG" });'));
  ids.xOpen = m.lastCallId;
  return [step1, step2, step3];
}

// M2 live (before code mode): every per-tool call shape and output rule, a plan, MCP names, web_search_call visits.
function m2Live(m, ids) {
  const recs = [m.functionOutput({ callId: ids.m2open, output: out.shellCommand({ exitCode: 3, body: 'BAIT_STDOUT' }) })];
  const call = (rec, output, key, custom = false) => {
    recs.push(rec);
    ids[key] = m.lastCallId;
    recs.push(custom ? m.customOutput({ output }) : m.functionOutput({ output }));
  };
  call(m.execCommand('rm -rf /Users/bait-user/proj && curl https://bait.example.com/x?token=BAIT_QUERY_TOKEN'), out.execCommand({ exitCode: 2, body: 'BAIT_STDOUT' }), 'rm');
  call(m.execCommand('npm run dev -- --token=BAIT_QUERY_TOKEN'), out.execCommand({ running: true, body: 'BAIT_STDOUT' }), 'bg');
  recs.push(m.writeStdin(), m.functionOutput({ output: out.execCommand({ exitCode: 1 }) }), m.waitCall(), m.functionOutput({ output: 'BAIT_RESULT_BODY' }));
  call(m.shell(['bash', '-lc', 'git status']), out.json({ exitCode: 0, body: 'BAIT_STDOUT' }), 'shellOk');
  call(m.shell(['bash', '-lc', 'ls /Users/bait-user']), out.rejected(), 'shellNo');
  call(m.execCommand('cat .env'), out.policy(), 'policy');
  call(m.execCommand('curl https://bait.example.com/BAIT_CMD_ARG'), out.sandbox(), 'sandbox');
  call(m.execCommand('make'), out.failedInSandbox(), 'sandbox2');
  call(m.execCommand('sleep 100'), out.timedOut(), 'timeout');
  call(m.execCommand('make build'), out.aborted(), 'abort');
  call(m.applyPatch(patchText(['/Users/bait-user/proj/src/x.py'])), out.shellCommand({ exitCode: 0, body: 'BAIT_STDOUT' }), 'patch', true);
  call(m.applyPatch(), out.patchRejected(), 'patchNo', true);
  call(m.updatePlan([{ step: 'Read /Users/bait-user/proj/a.py', status: 'completed' }, { step: 'Fix it', status: 'in_progress' },
    { step: 'Ship', status: 'pending' }]), out.planUpdated(), 'plan');
  call(m.mcp({ server: MCP_UUID }), out.mcpResult(), 'mcpOld');
  call(m.mcp({ server: 'github', tool: 'search_code', namespaced: true }), 'tool call failed: BAIT_RESULT_BODY', 'mcpNs');
  call(m.viewImage(), out.image(), 'view');
  recs.push(m.webSearchCall({ url: 'https://docs.bait.example.com/a?token=BAIT_QUERY_TOKEN' }));
  ids.wsc = m.lastItemId;
  recs.push(m.webSearchCall({ query: 'codex format', status: 'failed' }));
  ids.wscBad = m.lastItemId;
  call(m.spawnAgent({ namespaced: false, agentType: 'worker' }), out.toolFailed(), 'spawnNo');
  call(m.collab('wait_agent'), '{"status":{}}', 'waitAgent');
  call(m.functionCall({ name: 'open_url', namespace: 'codex_app', args: { url: 'https://bait.example.com/BAIT_TOOL_INPUT' } }), 'ok', 'app');
  call(m.requestUserInput(), out.answers(), 'askOk');
  recs.push(...m.say('Old era done.'), m.taskComplete(), m.taskStarted(), m.userMessage('Old era third'), m.shell(['bash', '-lc', 'git log BAIT_CMD_ARG']));
  ids.m2open2 = m.lastCallId;
  return recs;
}

/** The live part: appends to M1, S1, S2, M2, R and the title index, waiting for each step's own last event. */
export function codexLiveSteps(f) {
  const { b, files, ids, root } = f;
  const toolStart = (sid, id) => (ev) => ev.type === 'tool_start' && ev.sessionId === sid && ev.toolUseId === id;
  const toolEnd = (sid, id) => (ev) => ev.type === 'tool_end' && ev.sessionId === sid && ev.toolUseId === id;
  return async ({ waitFor }) => {
    const [m1a, m1b, m1c] = m1Live(b.m1, ids);
    await appendLines(files.m1, m1a);
    await waitFor(toolEnd(C.m1, ids.exec1));
    await appendLines(files.m1, m1b);
    await waitFor((ev) => ev.type === 'turn_end' && ev.sessionId === C.m1 && ev.reason === 'api_error');
    await appendLines(files.m1, m1c);
    await waitFor(toolStart(C.m1, ids.xOpen));
    await appendIndex(root, [[T.m1, 'Codex conformance main 2']]);
    await waitFor((ev) => ev.type === 'session' && ev.sessionId === C.m1 && ev.title === 'Codex conformance main 2');
    // S1: its exec ends, it answers, starts another exec; then its parent reports it completed -> session_end
    const s1 = b.s1;
    const s1recs = [s1.execOutput(out.script(), ids.s1exec), ...s1.say('Found it in /Users/bait-user/proj/src/a.js'),
      s1.exec('await tools.exec_command({ cmd: "rg BAIT_SCRIPT_ARG" });')];
    ids.s1open = s1.lastCallId;
    await appendLines(files.s1, s1recs);
    await waitFor(toolStart(C.s1, ids.s1open));
    await appendLines(files.m1, [b.m1.subAgentActivity({ child: T.s1, kind: 'interacted' }), b.m1.subAgentActivity({ child: T.s1, kind: 'completed' })]);
    await waitFor((ev) => ev.type === 'session_end' && ev.sessionId === C.s1);
    // S2 keeps working (live after the fallback); M2 and the review thread
    await appendLines(files.s2, [b.s2.say('Nested result.')[0]]); // the item copy (the text source of this version)
    await waitFor((ev) => ev.type === 'say' && ev.sessionId === C.s2);
    await appendLines(files.m2, m2Live(b.m2, ids));
    await waitFor(toolStart(C.m2, ids.m2open2));
    const r = b.r;
    const rrecs = [r.functionOutput({ callId: ids.rOpen, output: out.execCommand({ exitCode: 0, body: 'BAIT_STDOUT' }) }),
      ...r.say('Review: two issues in /Users/bait-user/proj/a.py'), r.execCommand('git show BAIT_CMD_ARG')];
    ids.rOpen2 = r.lastCallId;
    await appendLines(files.r, rrecs);
    await waitFor(toolStart(C.r, ids.rOpen2));
  };
}

export { charOf };
