// Server attach / rescan regressions with the real discover + tailer + SessionState + Store against a synthetic
// temp root. Every record is invented (test/fixtures/records.mjs); the real ~/.claude is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { scan as realScan } from '../src/discover.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const MIN = 60_000;
const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });

async function mkRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-office-attach-'));
  tmpDirs.push(root);
  return root;
}

// Session layout helper: main file, plain subs, workflow agents (with optional meta).
function layout(root, sid, dirName = '-work-demo') {
  const dir = path.join(root, dirName);
  const sub = (id) => path.join(dir, sid, 'subagents', `agent-${id}.jsonl`);
  const wf = (run, id) => path.join(dir, sid, 'subagents', 'workflows', run, `agent-${id}.jsonl`);
  return { dir, main: path.join(dir, `${sid}.jsonl`), sub, wf };
}
async function write(file, recs, meta) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, toJsonl(recs));
  if (meta) await fs.writeFile(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
}

const ringEvents = (app) => app.store.ring.map((x) => x.event);
const brief = (evs) => evs.map((e) => `${e.type}:${e.sessionId}${e.toolUseId ? `/${e.toolUseId}` : ''}${e.reason ? `/${e.reason}` : ''}`);

async function run(root, fn, opts = {}) {
  const app = await start({ port: 0, intervalMs: 50, rescanMs: 60_000, idleMs: 50, activeMinutes: 30, root, publicDir: PUBLIC, ...opts });
  try {
    await app.ready;
    await fn(app);
  } finally {
    await app.close();
  }
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
}

// ---- stale files at attach: run idle() on the replayed state before announcing ----------------------------

test('attach: an agent that already ended by timeout is never announced; settled tools are not shown open', async () => {
  const root = await mkRoot();
  const SID = '7a7a7a7a-1111-4222-8333-444455556666';
  const SID2 = '7b7b7b7b-1111-4222-8333-444455556666';
  const W = 'a00000000000000e1';
  const L = 'a00000000000000e2';
  const L1 = layout(root, SID);
  const L2 = layout(root, SID2);
  const old = Date.now() - 10 * MIN;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: old, stepMs: 10 });
  const m2 = createRecordBuilder({ sessionId: SID2, cwd: '/work/demo', startMs: old, stepMs: 10 });
  const w = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: W, startMs: old, stepMs: 10 });
  const l = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: L, startMs: Date.now() - 5000, stepMs: 10 });
  await write(L1.main, [
    m.humanPrompt({ text: 'Start the invented task' }),
    m.agentUse({ msgId: 'mm1', id: 'toolu_ag', description: 'Look around' }),
    m.bashUse({ msgId: 'mm1', id: 'toolu_b' }),
    m.userRejected({ toolUseId: 'toolu_b' }), // held; the interrupt marker never came
  ]);
  await write(L2.main, [m2.humanPrompt({ text: 'Second invented task' }), m2.assistantText({ msgId: 'mm2', text: 'All done.', stopReason: 'end_turn' })]);
  await write(L1.wf('wf_run-001', W), [w.subagentPrompt(), w.assistantText({ msgId: 'mw1', text: 'Review finished.', stopReason: 'end_turn' })],
    { agentType: 'workflow-subagent' });
  await write(L1.sub(L), [l.subagentPrompt(), l.assistantToolUse({ msgId: 'ml1', id: 'toolu_l1', name: 'Grep', input: { pattern: 'x' } })],
    { agentType: 'Explore', description: 'Look around', toolUseId: 'toolu_ag' });
  await run(root, async (app) => {
    const got = () => brief(ringEvents(app));
    assert.ok(got().includes(`session:${SID}`));
    assert.ok(got().includes(`session:${SID2}`));
    assert.ok(!got().some((x) => x.startsWith(`session:${W}`)), `finished wf agent announced: ${got()}`);
    assert.ok(!got().includes(`tool_start:${SID}/toolu_b`), 'held rejection shown as an open tool');
    assert.ok(got().includes(`session:${L}`), 'control sub with an open tool is announced');
    assert.ok(got().includes(`tool_start:${L}/toolu_l1`));
    await sleep(300); // several idle ticks
    const late = got().filter((x) => /^(session_end|tool_end|turn_end)/.test(x));
    assert.deepEqual(late, [], 'nothing settles right after attach');
  });
});

// ---- nested subs: replay every new file of a session before announcing any of them -----------------------

async function nestedRoot({ withParentId, childDone }) {
  const root = await mkRoot();
  const SID = '7c7c7c7c-1111-4222-8333-444455556666';
  const C = 'a0000000000000001'; // sorts before the parent
  const P = 'affffffffffffff01';
  const L = layout(root, SID);
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const p = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: P, startMs: t0, stepMs: 10 });
  const c = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: C, startMs: t0, stepMs: 10 });
  await write(L.main, [m.humanPrompt({ text: 'Nested invented task' }), m.agentUse({ msgId: 'mm1', id: 'toolu_p', description: 'Parent agent' })]);
  const parentRecs = [p.subagentPrompt(), p.agentUse({ msgId: 'mp1', id: 'toolu_pb', description: 'Child agent' })];
  if (childDone) {
    parentRecs.push(p.toolResult({ toolUseId: 'toolu_pb', content: [{ type: 'text', text: 'Invented nested report.' }, { type: 'text', text: `agentId: ${C} (use SendMessage to continue)` }] }));
  }
  parentRecs.push(p.assistantToolUse({ msgId: 'mp2', id: 'toolu_pr', name: 'Read', input: { file_path: '/work/demo/a.txt' } }));
  await write(L.sub(P), parentRecs, { agentType: 'general-purpose', description: 'Parent agent', toolUseId: 'toolu_p', spawnDepth: 1 });
  await write(L.sub(C), [c.subagentPrompt(), c.assistantToolUse({ msgId: 'mc1', id: 'toolu_c1', name: 'Glob', input: { pattern: '*.txt' } })],
    { agentType: 'Explore', description: 'Child agent', toolUseId: 'toolu_pb', spawnDepth: 2, ...(withParentId ? { parentAgentId: P } : {}) });
  return { root, SID, C, P };
}

for (const withParentId of [false, true]) {
  test(`nested child completed in its parent's file is never announced (parentAgentId ${withParentId ? 'set' : 'missing'})`, async () => {
    const { root, SID, C, P } = await nestedRoot({ withParentId, childDone: true });
    await run(root, async (app) => {
      const evs = ringEvents(app);
      assert.deepEqual(evs.filter((e) => e.sessionId === C).map((e) => e.type), [], brief(evs).join(' '));
      const order = brief(evs).filter((x) => x.startsWith('session:'));
      assert.deepEqual(order, [`session:${SID}`, `session:${P}`]);
    });
  });

  test(`nested running child is announced once, after its parent, with the parent linked (parentAgentId ${withParentId ? 'set' : 'missing'})`, async () => {
    const { root, SID, C, P } = await nestedRoot({ withParentId, childDone: false });
    await run(root, async (app) => {
      const sessions = ringEvents(app).filter((e) => e.type === 'session');
      assert.deepEqual(sessions.map((e) => e.sessionId), [SID, P, C]);
      assert.equal(sessions[2].parentSessionId, P);
    });
  });
}

// ---- a main whose children are still writing stays attached --------------------------------------------

test('main file older than --active stays attached while its workflow agent writes; children inherit its floor', async () => {
  const root = await mkRoot();
  const SID = '7d7d7d7d-1111-4222-8333-444455556666';
  const W = 'a00000000000000f1';
  const L = layout(root, SID);
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const w = createRecordBuilder({ sessionId: SID, cwd: '/work/demo/packages/x', agentId: W, startMs: t0, stepMs: 10 });
  await write(L.main, [m.humanPrompt({ text: 'Launch the invented workflow' }),
    m.assistantToolUse({ msgId: 'mm1', id: 'toolu_wf', name: 'Workflow', input: { description: 'Invented flow' } }),
    m.workflowAsyncResult({ toolUseId: 'toolu_wf', taskId: 'wtask0009', runId: 'wf_run-009' })]);
  const stale = new Date(Date.now() - 45 * MIN);
  await fs.utimes(L.main, stale, stale);
  const wfFile = L.wf('wf_run-009', W);
  await write(wfFile, [w.subagentPrompt(), w.assistantToolUse({ msgId: 'mw1', id: 'toolu_w1', name: 'Glob', input: { pattern: '*' } })]);
  await run(root, async (app) => {
    const sessions = () => ringEvents(app).filter((e) => e.type === 'session');
    assert.ok(sessions().some((e) => e.sessionId === SID), 'stale main with a live child is attached at startup');
    const wfS = sessions().find((e) => e.sessionId === W);
    assert.equal(wfS.parentSessionId, SID);
    assert.equal(wfS.project, '/work/demo', 'the wf agent inherits the main floor');
    await fs.utimes(L.main, stale, stale);
    await fs.appendFile(wfFile, toJsonl([w.toolResult({ toolUseId: 'toolu_w1', content: 'a\nb' })]));
    await sleep(400); // several rescans with the main still 45 min old
    assert.deepEqual(ringEvents(app).filter((e) => e.type === 'session_end' && e.sessionId === SID), []);
  }, { rescanMs: 100 });
});

// ---- relocation: a completion that lands during the move still reaches open pages ------------------------

test('relocated session: a subagent completed during the move gets session_end done', async () => {
  const root = await mkRoot();
  const SID = '7e7e7e7e-1111-4222-8333-444455556666';
  const A = 'a00000000000000a7';
  const from = layout(root, SID, '-work-old');
  const to = layout(root, SID, '-work-new');
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const s = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: A, startMs: t0, stepMs: 10 });
  await write(from.main, [m.humanPrompt({ text: 'Invented relocation task' }), m.agentUse({ msgId: 'mm1', id: 'toolu_bg', description: 'Background look', background: true }),
    m.agentAsyncResult({ toolUseId: 'toolu_bg', agentId: A })]);
  await write(from.sub(A), [s.subagentPrompt(), s.assistantToolUse({ msgId: 'ms1', id: 'toolu_x1', name: 'Grep', input: { pattern: 'y' } })],
    { agentType: 'Explore', description: 'Background look', toolUseId: 'toolu_bg' });
  let frozen = null;
  const scan = async (r, o) => frozen ?? realScan(r, o);
  await run(root, async (app) => {
    assert.ok(brief(ringEvents(app)).includes(`session:${A}`));
    frozen = await realScan(root, { activeMs: 30 * MIN }); // hold the old layout while the files move
    await fs.mkdir(to.dir, { recursive: true });
    await fs.rename(path.join(from.dir, SID), path.join(to.dir, SID));
    await fs.rename(from.main, to.main);
    await fs.appendFile(to.main, toJsonl([m.notification({ toolUseId: 'toolu_bg', taskId: A })]));
    await sleep(150);
    frozen = null;
    const ok = await waitFor(() => ringEvents(app).some((e) => e.type === 'session_end' && e.sessionId === A));
    assert.ok(ok, `no session_end for the moved sub: ${brief(ringEvents(app)).join(' ')}`);
    assert.equal(ringEvents(app).find((e) => e.type === 'session_end' && e.sessionId === A).reason, 'done');
  }, { rescanMs: 50, deps: { scan } });
});

// ---- subagent TaskUpdate reaches the main whiteboard (shared task list, R36) ---------------------------------

test('a subagent TaskUpdate updates the main task whiteboard (replay and live)', async () => {
  const root = await mkRoot();
  const SID = '7f7f7f7f-1111-4222-8333-444455556666';
  const A = 'a00000000000000b8';
  const L = layout(root, SID);
  const t0 = Date.now() - 5000;
  const m = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', startMs: t0, stepMs: 10 });
  const s = createRecordBuilder({ sessionId: SID, cwd: '/work/demo', agentId: A, startMs: t0 + 1000, stepMs: 10 });
  await write(L.main, [m.humanPrompt({ text: 'Invented task list' }),
    m.taskCreateUse({ msgId: 'mm1', id: 'toolu_c1', subject: 'Write module' }), m.taskCreateResult({ toolUseId: 'toolu_c1', taskId: '1', subject: 'Write module' }),
    m.taskCreateUse({ msgId: 'mm2', id: 'toolu_c2', subject: 'Test module' }), m.taskCreateResult({ toolUseId: 'toolu_c2', taskId: '2', subject: 'Test module' }),
    m.agentUse({ msgId: 'mm3', id: 'toolu_ag', description: 'Helper' })]);
  const subFile = L.sub(A);
  await write(subFile, [s.subagentPrompt(), s.taskUpdateUse({ msgId: 'ms1', id: 'toolu_u1', taskId: '1', status: 'completed' }),
    s.taskUpdateResult({ toolUseId: 'toolu_u1', taskId: '1', toolUseResult: undefined })],
  { agentType: 'general-purpose', description: 'Helper', toolUseId: 'toolu_ag' });
  const mainPlan = (evs) => evs.filter((e) => e.type === 'plan' && e.sessionId === SID).map((e) => e.items.map((it) => it.status));
  await run(root, async (app) => {
    assert.deepEqual(mainPlan(app.store.snapshot().events), [['completed', 'pending']]);
    await fs.appendFile(subFile, toJsonl([s.taskUpdateUse({ msgId: 'ms2', id: 'toolu_u2', taskId: '2', status: 'in_progress' }),
      s.taskUpdateResult({ toolUseId: 'toolu_u2', taskId: '2', toolUseResult: undefined })]));
    const ok = await waitFor(() => mainPlan(ringEvents(app)).some((st) => st[1] === 'in_progress'));
    assert.ok(ok, 'live sub update reaches the main whiteboard');
    assert.deepEqual(mainPlan(app.store.snapshot().events), [['completed', 'in_progress']]);
  });
});
