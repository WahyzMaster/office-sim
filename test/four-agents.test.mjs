// Claude Code, Codex, Grok and Antigravity side by side (CONTRACT 4.4, 4.8 Floors, D1, D3): start() with four temp roots
// whose sessions work in the same project folder, using the REAL registered descriptors (no test adapter, no replaced
// deps) and real-shaped records (test/fixtures/records.mjs, codex.mjs, grok.mjs, antigravity.mjs). The four agents'
// characters share one floor: the Antigravity CLI conversation through its summaries workspace, the legacy IDE one
// through the run_command Cwd fallback. /healthz and start().agents list all four in KNOWN_AGENTS order and nothing is
// reported as not implemented. Temp roots and invented content only.
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
import { cid, charOf as codexChar, rolloutPath, today } from './fixtures/codex-tree.mjs';
import { createAntigravityBuilder, call } from './fixtures/antigravity.mjs';
import { aid, charOf as agyChar, IDE, writeConversation, writeSummaries, appendLines } from './fixtures/antigravity-tree.mjs';
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

const PROJECT = '/work/office-four';
const CLAUDE_SID = 'c1a0de00-4444-4333-8444-555566667779';

async function claudeSession(root) {
  const dir = path.join(root, '-work-office-four');
  await fsp.mkdir(dir, { recursive: true });
  const mb = createRecordBuilder({ sessionId: CLAUDE_SID, cwd: PROJECT, startMs: Date.now() - 4000, stepMs: 10 });
  const file = path.join(dir, `${CLAUDE_SID}.tmp`);
  await fsp.writeFile(file, toJsonl([mb.humanPrompt({ text: 'Invented Claude prompt' }), mb.assistantText({ msgId: 'msg_1', text: 'On it.' })]));
  await fsp.rename(file, path.join(dir, `${CLAUDE_SID}.jsonl`));
}

async function grokSession(root) {
  const g = createGrokBuilder({ sessionId: gid(41), startMs: Date.now() - 5000, stepMs: 20 });
  const items = [g.hook({ event: 'session_start' }), g.userMessage({ text: 'Grok main task' }), g.hook({ event: 'user_prompt_submit' }),
    g.toolCall({ name: 'read_file', input: { target_file: `${PROJECT}/README.md` } }), g.toolDone({ output: grokOut.readFile() })];
  await writeSession(root, { group: groupOf(PROJECT), id: gid(41), items, summary: { cwd: PROJECT, title: 'Grok in the four', branch: 'main' } });
}

async function codexRollout(root, id) {
  const b = createCodexBuilder({ threadId: id, cwd: PROJECT, branch: 'main', startMs: Date.now() - 5000, stepMs: 20 });
  const file = rolloutPath(root, today(), id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.tmp`, codexJsonl([b.sessionMeta(), b.taskStarted(), b.userMessage('Codex task'),
    b.exec('await tools.exec_command({ cmd: "npm test" });')]));
  await fsp.rename(`${file}.tmp`, file);
}

// Antigravity: a CLI conversation (transcript_full.jsonl, summaries workspace = PROJECT; its run_command Cwd points
// elsewhere and must not decide the floor) and a legacy IDE one (transcript.jsonl, no summary entry: the Cwd fallback).
async function antigravityConversations(root) {
  const cli = createAntigravityBuilder({ format: 'full', start: Date.now() - 6000 });
  const files = await writeConversation(root, { id: aid(41), full: [cli.userInput('Antigravity task'),
    cli.planner({ thinking: 'Look first.', calls: [call.runCommand('npm test', '/work/elsewhere/sub')] })] });
  await writeSummaries(root, [{ id: aid(41), title: 'Antigravity in the four', status: 2, cwd: PROJECT, branch: 'main' }]);
  const ide = createAntigravityBuilder({ format: 'truncated', start: Date.now() - 6000 });
  await writeConversation(root, { id: aid(42), base: IDE, full: null, plain: [ide.userInput('IDE task'),
    ide.planner({ calls: [call.listDir(`${PROJECT}/src`), call.runCommand('git status', PROJECT)] }), ide.result()] });
  return { cli, file: files.full };
}

const stateOf = async (app) => JSON.parse((await request(app.port, { path: '/state' })).body).events;
const sessionsOf = async (app) => (await stateOf(app)).filter((e) => e.type === 'session');

test('one project folder, four agents: Claude, Codex, Grok and Antigravity share a floor; agents and /healthz in KNOWN_AGENTS order', async () => {
  const roots = { claude: await tmp('office-sim-four-claude-'), codex: await tmp('office-sim-four-codex-'), grok: await tmp('office-sim-four-grok-'),
    antigravity: await tmp('office-sim-four-gemini-') };
  await claudeSession(roots.claude);
  await grokSession(roots.grok);
  await codexRollout(roots.codex, cid(41));
  const agy = await antigravityConversations(roots.antigravity);
  const app = await start({ ...FAST, root: roots.claude, roots: { codex: roots.codex, grok: roots.grok, antigravity: roots.antigravity } });
  let es = null;
  try {
    assert.deepEqual(app.agents, ['claude-code', 'codex', 'grok', 'antigravity']);
    assert.deepEqual([...KNOWN_AGENTS], app.agents, 'every known adapter is implemented and on, in KNOWN_AGENTS order');
    assert.deepEqual(app.notImplemented, []);
    await app.ready;
    const health = JSON.parse((await request(app.port, { path: '/healthz' })).body);
    assert.equal(health.ok, true);
    assert.deepEqual(health.agents, [...KNOWN_AGENTS]);
    await until(async () => (await sessionsOf(app)).length === 5, 6000);
    const s = await sessionsOf(app);
    assert.deepEqual(s.map((e) => [e.sessionId, e.agent]).sort(), [
      [CLAUDE_SID, 'claude-code'], [codexChar(41), 'codex'], [grokChar(41), 'grok'], [agyChar(41), 'antigravity'], [agyChar(42), 'antigravity'],
    ].sort());
    for (const e of s) assert.deepEqual([e.project, e.projectLabel, e.worktree, e.isSubagent], [PROJECT, 'office-four', null, false], e.sessionId);
    const agyMain = s.find((e) => e.sessionId === agyChar(41));
    assert.deepEqual([agyMain.title, agyMain.branch], ['Antigravity in the four', 'main']);
    assert.equal(s.find((e) => e.sessionId === agyChar(42)).title, 'IDE task', 'no summary entry: the first USER_REQUEST');
    const tools = (await stateOf(app)).filter((e) => e.type === 'tool_start' && e.sessionId.startsWith('antigravity-'));
    assert.deepEqual(tools.map((e) => [e.sessionId, e.tool, e.summary, e.room]).sort(), [
      [agyChar(41), 'run_command', 'npm test', 'server'], [agyChar(42), 'run_command', 'git status', 'server'],
    ].sort());

    // the Antigravity character keeps working live on the shared floor
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 4000);
    await appendLines(agy.file, [agy.cli.runResult({ exitCode: 0 }), agy.cli.planner({ content: 'Tests pass.' })]);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === agyChar(41) && fr.data.text === 'Tests pass.', 4000);
    assert.ok(!es.frames.some((fr) => fr.data?.type === 'session' && fr.data.project !== PROJECT), 'no character moved floor');
    const stats = app.stats();
    assert.deepEqual([stats.applyErrors, stats.badLines, stats.rejectedRefs], [0, 0, 0]);
  } finally {
    es?.close();
    await app.close();
  }
});
