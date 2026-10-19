// End-to-end: real discover + tailer + SessionState + Store + HTTP/SSE against a synthetic projects root.
// Every record is invented (test/fixtures/records.mjs). The real ~/.claude is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { createRecordBuilder, clone, toJsonl } from './fixtures/records.mjs';
import { request, sse } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '5e5e5e5e-1111-4222-8333-444455556666';
const FORK_SID = '0f0f0f0f-2222-4333-8444-555566667777';
const A1 = 'a1b2c3d4e5f607182'; // plain subagent (a + 16 hex)
const A2 = 'a2c4e6f8091a2b3c4'; // background subagent that appears while the server runs
const W1 = 'a9f8e7d6c5b4a3921'; // workflow subagent
const RUN = 'wf_0a1b2c3d-001';
const CWD = '/work/invented-app'; // project key by contract 4.4 (not under the temp root)
const READ_PATH = `${CWD}/src/parser.mjs`;
const WRITE_PATH = `${CWD}/notes/plan.md`;

// Strings that must never reach the browser (section 5).
const SECRETS = [
  'SECRET_TOKEN_XYZ', // Bash command
  'OLD_SECRET_TEXT', 'NEW_SECRET_TEXT', // Edit old_string / new_string
  'FILE_CONTENT_SECRET', // Write content
  'RESULT_SECRET_LINE', // tool_result content
  'INVENTED AGENT PROMPT', 'INVENTED WF PROMPT', // subagent prompts
  'SECRET_SCRIPT', // Workflow script
  'FORK_SECRET_PROMPT', // fork history
  'Invented agent report', // sync Agent result body
  READ_PATH, WRITE_PATH, '/tmp/out.output', '/tmp/x.output', // full paths
];

const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

const line = (rec) => JSON.stringify(rec) + '\n';

async function buildRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-office-e2e-'));
  tmpDirs.push(root);
  const dir = path.join(root, '-work-invented-app');
  const subDir = path.join(dir, SID, 'subagents');
  const runDir = path.join(subDir, 'workflows', RUN);
  await fs.mkdir(runDir, { recursive: true });
  const t0 = Date.now() - 5000; // recent timestamps: replayed growth must not trip the idle timers
  const m = createRecordBuilder({ sessionId: SID, cwd: CWD, startMs: t0, stepMs: 10 });
  const s = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: A1, startMs: t0, stepMs: 10 });
  const w = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: W1, startMs: t0, stepMs: 10 });

  const seedMain = [
    m.humanPrompt({ text: 'Build the invented widget' }),
    m.assistantToolUse({ msgId: 'msg_m1', id: 'toolu_wf1', name: 'Workflow', input: { description: 'Invented review flow', script: 'SECRET_SCRIPT' } }),
    m.workflowAsyncResult({ toolUseId: 'toolu_wf1', taskId: 'wtask0001', runId: RUN }),
    m.assistantToolUse({ msgId: 'msg_m2', id: 'toolu_ag1', name: 'Agent', input: { description: 'Survey the parser', prompt: 'INVENTED AGENT PROMPT', subagent_type: 'Explore' } }),
  ];
  const seedSub = [
    s.subagentPrompt({ text: 'INVENTED AGENT PROMPT' }),
    s.assistantToolUse({ msgId: 'msg_s1', id: 'toolu_s1', name: 'Read', input: { file_path: READ_PATH } }),
  ];
  const seedWf = [
    w.subagentPrompt({ text: 'INVENTED WF PROMPT' }),
    w.assistantToolUse({ msgId: 'msg_w1', id: 'toolu_w1', name: 'Glob', input: { pattern: '**/*.mjs' } }),
  ];
  const paths = {
    root,
    main: path.join(dir, `${SID}.jsonl`),
    sub: path.join(subDir, `agent-${A1}.jsonl`),
    wf: path.join(runDir, `agent-${W1}.jsonl`),
  };
  await fs.writeFile(paths.main, toJsonl(seedMain));
  await fs.writeFile(paths.sub, toJsonl(seedSub));
  await fs.writeFile(path.join(subDir, `agent-${A1}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Survey the parser', toolUseId: 'toolu_ag1', spawnDepth: 1 }));
  await fs.writeFile(paths.wf, toJsonl(seedWf));
  await fs.writeFile(path.join(runDir, `agent-${W1}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  await fs.writeFile(path.join(runDir, 'journal.jsonl'), toJsonl([
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: W1, label: 'Check invented edge cases', phase: 'review' },
  ]));
  paths.subDir = subDir;
  return { paths, m, s, seedMain };
}

// Field subset match: every key in `want` must equal the event's value.
function pick(ev, want) {
  const out = {};
  for (const k of Object.keys(want)) out[k] = ev[k];
  return out;
}

test('e2e: snapshot, live tail, subagents, privacy', async () => {
  const { paths, m, s, seedMain } = await buildRoot();
  const app = await start({ port: 0, intervalMs: 50, rescanMs: 200, activeMinutes: 30, root: paths.root, publicDir: PUBLIC });
  const es = { frames: [] };
  try {
    await app.ready;
    const client = await sse(app.port);
    Object.assign(es, client);

    const expect = async (type, want = {}, ms = 3000) => {
      const fr = await client.nextData(ms);
      assert.equal(fr.data.type, type, `expected ${type}, got ${JSON.stringify(fr.data)}`);
      assert.deepEqual(pick(fr.data, want), want, `${type} fields`);
      assert.match(fr.id, /^\d+$/);
      return fr.data;
    };
    const append = (file, recs) => fs.appendFile(file, recs.map(line).join(''));
    // Nothing else may arrive before the marker `say`: proves the preceding records emitted no event.
    const sayMarker = async (text, msgId) => {
      await append(paths.main, [m.assistantText({ msgId, text })]);
      await expect('say', { sessionId: SID, text });
    };

    // ---- snapshot ---------------------------------------------------------------------------------
    const first = client.frames[0] ?? (await client.next());
    assert.equal(first.retry, 2000);
    const snap = await expect('snapshot');
    const brief = snap.events.map((e) => `${e.type}:${e.sessionId}${e.toolUseId ? `:${e.toolUseId}` : ''}`);
    assert.deepEqual(brief, [
      `session:${SID}`, `tool_start:${SID}:toolu_ag1`,
      `session:${A1}`, `tool_start:${A1}:toolu_s1`,
      `session:${W1}`, `tool_start:${W1}:toolu_w1`,
    ]);
    const [mainS, agentStart, subS, readStart, wfS, globStart] = snap.events;
    assert.deepEqual(pick(mainS, { project: CWD, projectLabel: 'invented-app', title: 'Build the invented widget', branch: 'main', worktree: null, isSubagent: false, parentSessionId: null }),
      { project: CWD, projectLabel: 'invented-app', title: 'Build the invented widget', branch: 'main', worktree: null, isSubagent: false, parentSessionId: null });
    assert.deepEqual(pick(agentStart, { tool: 'Agent', summary: 'Survey the parser · Explore' }), { tool: 'Agent', summary: 'Survey the parser · Explore' });
    assert.deepEqual(pick(subS, { project: CWD, projectLabel: 'invented-app', title: 'Survey the parser', isSubagent: true, parentSessionId: SID, agentType: 'Explore' }),
      { project: CWD, projectLabel: 'invented-app', title: 'Survey the parser', isSubagent: true, parentSessionId: SID, agentType: 'Explore' });
    assert.deepEqual(pick(readStart, { tool: 'Read', summary: 'parser.mjs' }), { tool: 'Read', summary: 'parser.mjs' });
    assert.deepEqual(pick(wfS, { project: CWD, title: 'Check invented edge cases', isSubagent: true, parentSessionId: SID, agentType: 'workflow-subagent' }),
      { project: CWD, title: 'Check invented edge cases', isSubagent: true, parentSessionId: SID, agentType: 'workflow-subagent' });
    assert.deepEqual(pick(globStart, { tool: 'Glob', summary: '**/*.mjs' }), { tool: 'Glob', summary: '**/*.mjs' });
    await expect('config', { intervalMs: 50, activeMinutes: 30 });

    // ---- plain subagent works, then the parent's sync Agent result ends it (R29) ----------------
    await append(paths.sub, [
      s.toolResult({ toolUseId: 'toolu_s1', content: 'RESULT_SECRET_LINE file body' }),
      s.assistantText({ msgId: 'msg_s2', text: 'Found the invented parser entry.' }),
    ]);
    await expect('tool_end', { sessionId: A1, toolUseId: 'toolu_s1', ok: true });
    await expect('say', { sessionId: A1, text: 'Found the invented parser entry.' });
    const agentDone = m.agentSyncResult({ toolUseId: 'toolu_ag1', agentId: A1 });
    await append(paths.main, [agentDone]);
    await expect('tool_end', { sessionId: SID, toolUseId: 'toolu_ag1', ok: true });
    await expect('session_end', { sessionId: A1, reason: 'done' });

    // ---- thinking (signature-only -> null text) -------------------------------------------------
    await append(paths.main, [m.assistantThinking({ msgId: 'msg_m3', text: '', durationMs: 1200 })]);
    await expect('thinking', { sessionId: SID, text: null, durationMs: 1200 });

    // ---- Bash: a tool_use line split across two writes, room hint, failed result ----------------
    const bash1 = line(m.assistantToolUse({ msgId: 'msg_m3', id: 'toolu_b1', name: 'Bash', input: { command: 'grep -rn SECRET_TOKEN_XYZ ./src', description: 'Search invented token' } }));
    const cut = Math.floor(bash1.length / 2);
    await fs.appendFile(paths.main, bash1.slice(0, cut));
    await sleep(200); // several polls see only the partial line
    assert.deepEqual(client.pending(), []);
    await fs.appendFile(paths.main, bash1.slice(cut));
    await expect('tool_start', { sessionId: SID, toolUseId: 'toolu_b1', tool: 'Bash', summary: 'Search invented token', room: 'archive' });
    await append(paths.main, [m.toolResult({ toolUseId: 'toolu_b1', isError: true, content: 'Exit code 1\nRESULT_SECRET_LINE', toolUseResult: 'Error: Exit code 1' })]);
    await expect('tool_end', { toolUseId: 'toolu_b1', ok: false, errorKind: 'failed', error: 'Exit code 1' });
    assert.deepEqual(pick(app.stats(), { badLines: 0, skippedLines: 0, applyErrors: 0 }), { badLines: 0, skippedLines: 0, applyErrors: 0 });

    await append(paths.main, [
      m.assistantToolUse({ msgId: 'msg_m3', id: 'toolu_b2', name: 'Bash', input: { command: `cd ${CWD} && npm test -- --grep SECRET_TOKEN_XYZ` } }),
      m.toolResult({ toolUseId: 'toolu_b2', content: 'RESULT_SECRET_LINE passing', toolUseResult: { stdout: 'RESULT_SECRET_LINE', stderr: '', interrupted: false } }),
    ]);
    const b2 = await expect('tool_start', { toolUseId: 'toolu_b2', tool: 'Bash', summary: 'npm test', room: 'server' });
    assert.equal('background' in b2, false);
    await expect('tool_end', { toolUseId: 'toolu_b2', ok: true });

    // ---- Edit denied by a permission rule (R25, not held) ---------------------------------------
    await append(paths.main, [
      m.assistantToolUse({ msgId: 'msg_m3', id: 'toolu_e1', name: 'Edit', input: { file_path: READ_PATH, old_string: 'OLD_SECRET_TEXT', new_string: 'NEW_SECRET_TEXT' } }),
      m.toolResult({ toolUseId: 'toolu_e1', isError: true, toolDenialKind: 'permission-rule', content: 'Permission to use Edit has been denied by a project rule.\nRESULT_SECRET_LINE' }),
    ]);
    await expect('tool_start', { toolUseId: 'toolu_e1', tool: 'Edit', summary: 'parser.mjs' });
    await expect('tool_end', { toolUseId: 'toolu_e1', ok: false, errorKind: 'denied', error: 'Permission to use Edit has been denied by a project rule.' });

    // ---- Write rejected, then the interrupt marker: interrupted + turn_end interrupt ------------
    await append(paths.main, [m.assistantToolUse({ msgId: 'msg_m3', id: 'toolu_w2', name: 'Write', input: { file_path: WRITE_PATH, content: 'FILE_CONTENT_SECRET' } })]);
    await expect('tool_start', { toolUseId: 'toolu_w2', tool: 'Write', summary: 'plan.md' });
    await append(paths.main, [m.userRejected({ toolUseId: 'toolu_w2' }), m.interruptMarker({ forTool: true })]);
    await expect('tool_end', { toolUseId: 'toolu_w2', ok: false, errorKind: 'interrupted' });
    await expect('turn_end', { sessionId: SID, reason: 'interrupt' });

    // ---- new turn: prompt, update_plan (plumbing, plan only), AskUserQuestion -------------------
    await append(paths.main, [m.humanPrompt({ text: 'Now plan the invented rollout' })]);
    await expect('prompt', { sessionId: SID, text: 'Now plan the invented rollout' });
    const items = [
      { content: 'Read the parser', status: 'completed' },
      { content: 'Write invented tests', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' },
    ];
    await append(paths.main, [
      m.updatePlanUse({ msgId: 'msg_m4', id: 'toolu_p1', input: { items } }),
      m.updatePlanResult({ toolUseId: 'toolu_p1', text: 'Plan updated: step 2 of 3 is in progress.' }),
    ]);
    await expect('plan', { sessionId: SID, source: 'update_plan', items });
    await append(paths.main, [m.askUse({ msgId: 'msg_m5', id: 'toolu_q1' })]);
    await expect('tool_start', {
      toolUseId: 'toolu_q1', tool: 'AskUserQuestion', summary: 'Layout',
      question: 'Which layout should the demo use?', options: ['Grid', 'List'],
    });
    await append(paths.main, [m.askResult({ toolUseId: 'toolu_q1' })]);
    await expect('tool_end', { toolUseId: 'toolu_q1', ok: true });

    // ---- resume re-append of old records (R7/R9): nothing replays -------------------------------
    await append(paths.main, [...seedMain, agentDone].map((r) => clone(r)));
    await sayMarker('Resumed invented session.', 'msg_m6');

    // ---- fork history (R10): other sessionId, fresh uuids -> no events --------------------------
    const fork = (rec, n) => clone(rec, { sessionId: FORK_SID, uuid: `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
    await append(paths.main, [
      fork(m.humanPrompt({ text: 'FORK_SECRET_PROMPT' }), 1),
      fork(m.assistantToolUse({ msgId: 'msg_f1', id: 'toolu_f1', name: 'Bash', input: { command: 'echo SECRET_TOKEN_XYZ' } }), 2),
      fork(m.assistantText({ msgId: 'msg_f1', text: 'FORK_SECRET_PROMPT reply' }), 3),
    ]);
    await sayMarker('Back on the invented main line.', 'msg_m7');

    // ---- background Agent: async launch, a new subagent file appears live, a notification ends it -
    await append(paths.main, [
      m.agentUse({ msgId: 'msg_m9', id: 'toolu_ag2', description: 'Draft invented docs', subagentType: 'general-purpose', background: true }),
      m.agentAsyncResult({ toolUseId: 'toolu_ag2', agentId: A2 }),
    ]);
    await expect('tool_start', { toolUseId: 'toolu_ag2', tool: 'Agent', summary: 'Draft invented docs · general-purpose', background: true });
    await expect('tool_end', { toolUseId: 'toolu_ag2', ok: true }); // R28 async_launched
    const s2 = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: A2, startMs: Date.now(), stepMs: 10 });
    const subPath2 = path.join(paths.subDir, `agent-${A2}.jsonl`);
    await fs.writeFile(path.join(paths.subDir, `agent-${A2}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Draft invented docs', toolUseId: 'toolu_ag2', spawnDepth: 1 }));
    await fs.writeFile(`${subPath2}.tmp`, toJsonl([
      s2.subagentPrompt({ text: 'INVENTED AGENT PROMPT' }),
      s2.assistantToolUse({ msgId: 'msg_x1', id: 'toolu_x1', name: 'Write', input: { file_path: WRITE_PATH, content: 'FILE_CONTENT_SECRET' } }),
    ]));
    await fs.rename(`${subPath2}.tmp`, subPath2); // appears whole: one rescan attaches it
    await expect('session', { sessionId: A2, isSubagent: true, parentSessionId: SID, title: 'Draft invented docs', agentType: 'general-purpose', project: CWD, projectLabel: 'invented-app' });
    await expect('tool_start', { sessionId: A2, toolUseId: 'toolu_x1', tool: 'Write', summary: 'plan.md' });
    await append(paths.main, [m.notification({ toolUseId: 'toolu_ag2', taskId: A2, status: 'completed', summary: 'Invented docs drafted' })]);
    await expect('turn_end', { sessionId: SID, reason: 'next_turn' });
    await expect('session_end', { sessionId: A2, reason: 'done' });

    // ---- workflow notification: new turn (next_turn) and the workflow agent ends ----------------
    await append(paths.main, [m.notification({ toolUseId: 'toolu_wf1', taskId: 'wtask0001', status: 'completed', summary: 'Invented workflow finished' })]);
    await expect('turn_end', { sessionId: SID, reason: 'next_turn' });
    await expect('session_end', { sessionId: W1, reason: 'done' });

    // ---- final answer + stop hook ---------------------------------------------------------------
    await append(paths.main, [m.assistantText({ msgId: 'msg_m8', text: 'All invented work is done.' }), m.stopHookSummary()]);
    await expect('say', { sessionId: SID, text: 'All invented work is done.' });
    await expect('turn_end', { sessionId: SID, reason: 'stop_hook' });

    await sleep(150);
    assert.deepEqual(client.pending().map((fr) => fr.data.type), [], 'no trailing events');

    // ---- /state and /healthz --------------------------------------------------------------------
    const state = await request(app.port, { path: '/state' });
    const st = JSON.parse(state.body);
    // ended subagents are gone; the main keeps its whiteboard plan (no tools are open)
    assert.deepEqual(st.events.map((e) => `${e.type}:${e.sessionId}`), [`session:${SID}`, `plan:${SID}`]);
    assert.deepEqual(st.events[1].items, items);
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.deepEqual(health, { ok: true, files: 4, sessions: 4, clients: 1 });

    // ---- privacy: no frame and no /state body carries content, commands or fixture paths -------
    const realRoot = await fs.realpath(paths.root);
    const forbidden = [...SECRETS, paths.root, realRoot, path.dirname(paths.main)];
    const blobs = [...client.frames.map((fr) => fr.raw), state.body];
    for (const needle of forbidden) {
      const hit = blobs.find((b) => b.includes(needle));
      assert.equal(hit, undefined, `leaked ${JSON.stringify(needle)}`);
    }
    client.close();
  } finally {
    es.close?.();
    await app.close();
  }
});
