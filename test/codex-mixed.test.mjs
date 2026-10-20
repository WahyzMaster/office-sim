// Claude Code, Codex and Grok side by side (CONTRACT 4.4, 4.7 Floors, D1): start() with a Claude, a Codex and a Grok
// temp root whose sessions work in the same project folder, using the REAL registered descriptors (no test adapter, no
// replaced deps) and real-shaped records (test/fixtures/records.mjs, codex.mjs, grok.mjs). The three agents' characters
// share one floor; a Codex sub in a project-local worktree follows its main with a badge; a Codex-managed worktree
// (<codex root>/worktrees/<id>/<name>/...) that appears later joins the floor whose label is <name>, and one whose name
// matches no floor gets its own. /healthz lists the adapters in KNOWN_AGENTS order. Temp roots and invented content only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { KNOWN_AGENTS } from '../src/adapters/index.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { createGrokBuilder, out as grokOut } from './fixtures/grok.mjs';
import { gid, charOf as grokChar, groupOf, writeSession } from './fixtures/grok-tree.mjs';
import { createCodexBuilder, toJsonl as codexJsonl } from './fixtures/codex.mjs';
import { cid, charOf, rolloutPath, today, appendLines, appendIndex } from './fixtures/codex-tree.mjs';
import { request, sse, until } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAST = { port: 0, publicDir: PUBLIC, intervalMs: 50, rescanMs: 60, idleMs: 50, activeMinutes: 30 };
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const PROJECT = '/work/office-demo';
const CLAUDE_SID = 'c1a0de00-2222-4333-8444-555566667779';

async function claudeSession(root) {
  const dir = path.join(root, '-work-office-demo');
  await fsp.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: CLAUDE_SID, cwd: PROJECT, startMs: Date.now() - 4000, stepMs: 10 });
  const file = path.join(dir, `${CLAUDE_SID}.tmp`);
  await fsp.writeFile(file, toJsonl([mb.humanPrompt({ text: 'Invented Claude prompt' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fsp.rename(file, path.join(dir, `${CLAUDE_SID}.jsonl`)); // written aside: a scan never sees half a file
}

async function grokSession(root) {
  const g = createGrokBuilder({ sessionId: gid(21), startMs: Date.now() - 5000, stepMs: 20 });
  const items = [g.hook({ event: 'session_start' }), g.userMessage({ text: 'Grok main task' }), g.hook({ event: 'user_prompt_submit' }),
    g.toolCall({ name: 'read_file', input: { target_file: `${PROJECT}/README.md` } }), g.toolDone({ output: grokOut.readFile() }),
    g.toolCall({ name: 'grep', input: { pattern: 'TODO', path: `${PROJECT}/src` } })];
  await writeSession(root, { group: groupOf(PROJECT), id: gid(21), items, summary: { cwd: PROJECT, title: 'Grok in the demo', branch: 'main' } });
}

// One Codex rollout in real record shape (code mode): a prompt, then an open exec whose first script tool is a shell
// command (the character is busy in the server room). Written aside and moved in. sub: { parent, role }.
async function codexRollout(root, id, cwd, { sub = null, text = 'Codex task' } = {}) {
  const b = createCodexBuilder({ threadId: id, cwd, branch: 'main', startMs: Date.now() - 5000, stepMs: 20 });
  const recs = [b.sessionMeta(sub ? { sub: { parent: sub.parent, role: sub.role } } : {}), b.taskStarted(), b.userMessage(text),
    b.exec('await tools.exec_command({ cmd: "npm test" });')];
  const file = rolloutPath(root, today(), id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.tmp`, codexJsonl(recs));
  await fsp.rename(`${file}.tmp`, file);
  return { file, b };
}

const stateOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events;
const sessionsOf = async (app) => (await stateOf(app)).filter((e) => e.type === 'session');
const byId = (list, id) => list.find((e) => e.sessionId === id);
const floor = (e) => e && [e.project, e.projectLabel, e.worktree];

test('one project folder, three agents: Claude, Codex and Grok share a floor; Codex subs and worktrees follow D1; /healthz agents', async () => {
  const claudeRoot = await tmp('office-sim-mixed3-claude-');
  const codexRoot = await tmp('office-sim-mixed3-codex-');
  const grokRoot = await tmp('office-sim-mixed3-grok-');
  await claudeSession(claudeRoot);
  await grokSession(grokRoot);
  const main = await codexRollout(codexRoot, cid(31), PROJECT, { text: 'Codex main task' });
  await codexRollout(codexRoot, cid(32), `${PROJECT}/.worktrees/helper`, { sub: { parent: cid(31), role: 'explorer' } });
  await appendIndex(codexRoot, [[cid(31), 'Codex in the demo']]);
  const app = await start({ ...FAST, root: claudeRoot, roots: { codex: codexRoot, grok: grokRoot } }); // the registered adapters
  let es = null;
  try {
    assert.deepEqual(app.agents, ['claude-code', 'codex', 'grok']);
    assert.deepEqual(app.agents, KNOWN_AGENTS.filter((id) => app.agents.includes(id)), 'KNOWN_AGENTS order');
    await app.ready;
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.equal(health.ok, true);
    assert.deepEqual(health.agents, ['claude-code', 'codex', 'grok']);
    await until(async () => (await sessionsOf(app)).length === 4, 6000);
    let s = await sessionsOf(app);
    assert.deepEqual(s.map((e) => [e.sessionId, e.agent]).sort(),
      [[CLAUDE_SID, 'claude-code'], [charOf(31), 'codex'], [charOf(32), 'codex'], [grokChar(21), 'grok']].sort());
    for (const id of [CLAUDE_SID, charOf(31), grokChar(21)]) assert.deepEqual(floor(byId(s, id)), [PROJECT, 'office-demo', null], id);
    const sub = byId(s, charOf(32));
    assert.deepEqual([...floor(sub), sub.isSubagent, sub.parentSessionId, sub.agentType], [PROJECT, 'office-demo', 'helper', true, charOf(31), 'explorer']);
    assert.equal(byId(s, charOf(31)).title, 'Codex in the demo');
    const tools = (await stateOf(app)).filter((e) => e.type === 'tool_start' && e.sessionId.startsWith('codex-'));
    assert.deepEqual(tools.map((e) => [e.sessionId, e.tool, e.summary, e.room]).sort(),
      [[charOf(31), 'exec', 'exec_command', 'server'], [charOf(32), 'exec', 'exec_command', 'server']]);

    // Codex-managed worktrees appear later: <name> = office-demo joins that floor; an unknown <name> gets its own floor
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const wtCwd = path.join(codexRoot, 'worktrees', 'a1b2', 'office-demo', 'pkg');
    const lonely = path.join(codexRoot, 'worktrees', 'ff00', 'lonely-repo');
    const wt = await codexRollout(codexRoot, cid(33), wtCwd, { text: 'Work in the worktree' });
    await codexRollout(codexRoot, cid(34), lonely, { text: 'Work elsewhere' });
    await until(async () => byId(await sessionsOf(app), charOf(33)) && byId(await sessionsOf(app), charOf(34)), 6000);
    s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(33))), [PROJECT, 'office-demo', 'office-demo']);
    assert.deepEqual(floor(byId(s, charOf(34))), [lonely, 'lonely-repo', 'lonely-repo']);
    const live = es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(33)).map((fr) => floor(fr.data));
    assert.ok(live.length >= 1 && live.every((x) => JSON.stringify(x) === JSON.stringify([PROJECT, 'office-demo', 'office-demo'])), 'live = /state');
    // the worktree session keeps working on that floor; nothing else moved
    await appendLines(wt.file, [wt.b.execOutput(), ...wt.b.say('Worktree change ready.')]);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === charOf(33), 4000);
    await appendLines(main.file, [main.b.execOutput(), ...main.b.say('Main change ready.')]);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === charOf(31), 4000);
    s = await sessionsOf(app);
    assert.deepEqual([CLAUDE_SID, charOf(31), charOf(32), charOf(33), grokChar(21)].map((id) => byId(s, id).project), Array(5).fill(PROJECT));
    const stats = app.stats();
    assert.deepEqual([stats.applyErrors, stats.badLines, stats.rejectedRefs], [0, 0, 0]);
  } finally {
    es?.close();
    await app.close();
  }
});

// Finding 1 (v2 multi-agent): a child that the parent completed and then re-tasked many times. On attach, the parent's
// replay must not end a child whose last lifecycle entry is a re-task (interacted / started), while a child whose last
// entry is completed stays hidden (4.0.1 F4). Real descriptor, real record shapes, only the Codex adapter.
test('attach: a re-tasked Codex child (completed, then interacted) is shown busy; a child whose last entry is completed stays hidden', async () => {
  const codexRoot = await tmp('office-sim-retask-codex-');
  const claudeRoot = await tmp('office-sim-retask-claude-');
  const [parent, busy, done] = [cid(41), cid(42), cid(43)];
  const [parentChar, busyChar] = [charOf(41), charOf(42)];
  const write = async (id, recs) => {
    const file = rolloutPath(codexRoot, today(), id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.tmp`, codexJsonl(recs));
    await fsp.rename(`${file}.tmp`, file);
  };
  const m = createCodexBuilder({ threadId: parent, cwd: PROJECT, startMs: Date.now() - 8000, stepMs: 20 });
  await write(parent, [m.sessionMeta(), m.taskStarted(), m.userMessage('Coordinate the helpers'),
    m.subAgentActivity({ child: busy, kind: 'started' }), m.subAgentActivity({ child: done, kind: 'started' }),
    m.subAgentActivity({ child: busy, kind: 'completed' }), m.subAgentActivity({ child: done, kind: 'completed' }),
    m.collab('followup_task', { target: '/root/helper' }), m.functionOutput({ output: '{}' }),
    m.subAgentActivity({ child: busy, kind: 'interacted' }), m.collab('wait_agent')]);
  const child = (id, own) => {
    const c = createCodexBuilder({ threadId: id, cwd: PROJECT, startMs: Date.now() - 6000, stepMs: 20 });
    return [c.sessionMeta({ sub: { parent, role: 'worker' } }), ...own(c)];
  };
  await write(busy, child(busy, (c) => [c.taskStarted(), c.exec('await tools.exec_command({ cmd: "npm test" });'), c.execOutput(),
    c.taskComplete(), c.taskStarted(), c.exec('await tools.exec_command({ cmd: "npm run build" });')]));
  await write(done, child(done, (c) => [c.taskStarted(), ...c.say('Finished.', { phase: 'final_answer' }), c.taskComplete()]));
  const app = await start({ ...FAST, root: claudeRoot, agents: ['codex'], roots: { codex: codexRoot } });
  try {
    await app.ready;
    await until(async () => byId(await sessionsOf(app), busyChar), 6000);
    await new Promise((r) => setTimeout(r, 300)); // more rescans and idle ticks
    const s = await sessionsOf(app);
    assert.deepEqual(s.map((e) => e.sessionId).sort(), [parentChar, busyChar].sort(), 'the finished child never shows');
    const tools = (await stateOf(app)).filter((e) => e.type === 'tool_start' && e.sessionId === busyChar);
    assert.deepEqual(tools.map((e) => [e.tool, e.summary, e.room]), [['exec', 'exec_command', 'server']], 'the re-tasked child is busy');
  } finally {
    await app.close();
  }
});
