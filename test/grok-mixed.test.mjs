// Claude Code and Grok side by side (CONTRACT 4.4, 4.6 D1): start() with a Claude temp root and a Grok temp root whose
// sessions work in the same project folder, using the REAL registered grok descriptor (discovery with its link grace,
// summary.json sidecar, GrokSession) and real-shaped records (test/fixtures/grok.mjs). Both agents' characters share one
// floor, a Grok sub in another cwd group follows its main, and a Grok-made worktree session
// (<grok root>/worktrees/<repo>/<name>/...) joins that floor with a <name> badge. /healthz lists both adapters.
// Temp roots and invented content only; the real ~/.grok and ~/.claude are never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { createGrokBuilder, out } from './fixtures/grok.mjs';
import { gid, charOf, groupOf, writeSession, appendLines } from './fixtures/grok-tree.mjs';
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
const CLAUDE_SID = 'c1a0de00-2222-4333-8444-555566667771';

async function claudeSession(root, sid, cwd) {
  const dir = path.join(root, '-work-office-demo');
  await fsp.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: sid, cwd, startMs: Date.now() - 4000, stepMs: 10 });
  const file = path.join(dir, `${sid}.tmp`);
  await fsp.writeFile(file, toJsonl([mb.humanPrompt({ text: 'Invented Claude prompt' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fsp.rename(file, path.join(dir, `${sid}.jsonl`)); // written aside: a scan never sees half a file
}

// One Grok session in real record shape: a prompt, a thought, an open read (so the character is busy on the floor).
function grokRecords(id, text) {
  const g = createGrokBuilder({ sessionId: id, startMs: Date.now() - 5000, stepMs: 20 });
  return [
    g.hook({ event: 'session_start' }), g.userMessage({ text }), g.hook({ event: 'user_prompt_submit' }), g.thought('Look first.'),
    g.toolCall({ name: 'read_file', input: { target_file: `${PROJECT}/README.md` } }), g.toolDone({ output: out.readFile() }),
    g.toolCall({ name: 'grep', input: { pattern: 'TODO', path: `${PROJECT}/src` } }),
  ];
}
const subKind = (type) => ({ session_kind: 'subagent', agent_name: type });

const sessionsOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'session');
const byId = (list, id) => list.find((e) => e.sessionId === id);
const floor = (e) => e && [e.project, e.projectLabel, e.worktree];

test('one project folder, two agents: Claude and Grok share a floor, the Grok sub and a Grok-made worktree join it; /healthz agents', async () => {
  const claudeRoot = await tmp('office-sim-mixed-claude-');
  const grokRoot = await tmp('office-sim-mixed-grok-');
  await claudeSession(claudeRoot, CLAUDE_SID, PROJECT);
  const subCwd = `${PROJECT}/.worktrees/helper`;
  await writeSession(grokRoot, { group: groupOf(PROJECT), id: gid(11), children: [gid(12)], items: grokRecords(gid(11), 'Grok main task'),
    summary: { cwd: PROJECT, title: 'Grok in the demo', branch: 'main' } });
  await writeSession(grokRoot, { group: groupOf(subCwd), id: gid(12), items: grokRecords(gid(12), 'Parent task'),
    summary: { cwd: subCwd, title: 'Grok helper', branch: 'helper', extra: subKind('explore') } });
  const app = await start({ ...FAST, root: claudeRoot, roots: { grok: grokRoot } }); // the registered adapters, nothing replaced
  let es = null;
  try {
    assert.deepEqual(app.agents, ['claude-code', 'grok']);
    await app.ready;
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.equal(health.ok, true);
    assert.deepEqual(health.agents, ['claude-code', 'grok']);
    await until(async () => (await sessionsOf(app)).length === 3, 5000);
    let s = await sessionsOf(app);
    assert.deepEqual(s.map((e) => [e.sessionId, e.agent]).sort(), [[CLAUDE_SID, 'claude-code'], [charOf(11), 'grok'], [charOf(12), 'grok']].sort());
    assert.deepEqual(floor(byId(s, CLAUDE_SID)), [PROJECT, 'office-demo', null]);
    assert.deepEqual(floor(byId(s, charOf(11))), [PROJECT, 'office-demo', null]);
    assert.deepEqual([...floor(byId(s, charOf(12))), byId(s, charOf(12)).parentSessionId, byId(s, charOf(12)).agentType],
      [PROJECT, 'office-demo', 'helper', charOf(11), 'explore']);
    assert.equal(byId(s, charOf(11)).title, 'Grok in the demo');
    const tools = JSON.parse((await request(app.port, { path: '/state' })).body).events.filter((e) => e.type === 'tool_start');
    assert.deepEqual(tools.map((e) => [e.sessionId, e.tool, e.summary, e.room]).sort(),
      [[charOf(11), 'grep', 'TODO · src', 'archive'], [charOf(12), 'grep', 'TODO · src', 'archive']]);

    // a Grok-made worktree of the same repository appears later: it joins the 'office-demo' floor with its badge
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    const wtCwd = path.join(grokRoot, 'worktrees', 'office-demo', 'feat-x', 'pkg');
    const file = await writeSession(grokRoot, { group: groupOf(wtCwd), id: gid(13), items: grokRecords(gid(13), 'Work in the worktree'),
      summary: { cwd: wtCwd, title: 'Grok worktree', branch: 'feat-x' } });
    await until(async () => byId(await sessionsOf(app), charOf(13)), 6000); // the link grace (1 s) holds a new folder first
    s = await sessionsOf(app);
    assert.deepEqual(floor(byId(s, charOf(13))), [PROJECT, 'office-demo', 'feat-x']);
    const live = es.frames.filter((fr) => fr.data?.type === 'session' && fr.data.sessionId === charOf(13)).map((fr) => floor(fr.data));
    assert.ok(live.length >= 1 && live.every((f) => JSON.stringify(f) === JSON.stringify([PROJECT, 'office-demo', 'feat-x'])), 'live = /state');
    // it keeps working on that floor; nothing else moved
    const g = createGrokBuilder({ sessionId: gid(13), startMs: Date.now(), stepMs: 20, promptId: 'prompt-0001-0198f0a0' });
    await appendLines(file, [g.message('Worktree change ready.')]);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === charOf(13), 4000);
    s = await sessionsOf(app);
    assert.deepEqual([CLAUDE_SID, charOf(11), charOf(12), charOf(13)].map((id) => byId(s, id).project), [PROJECT, PROJECT, PROJECT, PROJECT]);
    const stats = app.stats();
    assert.deepEqual([stats.applyErrors, stats.badLines, stats.rejectedRefs], [0, 0, 0]);
  } finally {
    es?.close();
    await app.close();
  }
});
