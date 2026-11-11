// Launch readiness D12: the Claude Desktop scan is documented in README.md, README.ko.md and CONTRACT 5.1. These tests
// pin the statements made there against the code: which paths the activity check touches and how (listings and lstat
// only), that the scans are off for a root that is not the default, and that nothing of main.log, of the IndexedDB
// files or of the arguments and results logged in mcp.log reaches the Store or a live event.
// Every path is a temp folder: the real ~/Library and ~/.claude are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { scan } from '../src/discover.mjs';
import { computeClaudeCloudActivity, scanClaudeDesktopCloud } from '../src/desktop-claude.mjs';
import { scanCodexDesktopCloud } from '../src/adapters/codex/desktop-cloud.mjs';
import { scanGrokDesktopBot } from '../src/adapters/grok/desktop-bot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function withTmpDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-disclosure-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** A Claude desktop app tree with BAIT text in every file the scan must not read. */
async function makeClaudeDesktop(tmp) {
  const appSupportDir = path.join(tmp, 'ClaudeSupport');
  const logsDir = path.join(tmp, 'ClaudeLogs');
  const idb = path.join(appSupportDir, 'IndexedDB');
  const level = path.join(idb, 'https_claude.ai_0.indexeddb.leveldb');
  const blob1 = path.join(idb, 'https_claude.ai_0.indexeddb.blob', '1', '06');
  const blob3 = path.join(idb, 'https_claude.ai_0.indexeddb.blob', '3', '0a');
  const blob2 = path.join(idb, 'https_claude.ai_0.indexeddb.blob', '2', '01'); // not a folder the scan lists
  for (const d of [level, blob1, blob3, blob2, logsDir]) await fsp.mkdir(d, { recursive: true });
  for (const [dir, name] of [
    [level, '000001.log'], [level, '000002.ldb'], [level, 'MANIFEST-000001'], [level, 'CURRENT'], [level, 'LOCK'],
    [blob1, '608'], [blob3, '77'], [blob2, '9'], [logsDir, 'main.log'], [logsDir, 'window.log'],
  ]) await fsp.writeFile(path.join(dir, name), `BAIT_FILE_BODY ${name}\n`);
  const mcpPath = path.join(logsDir, 'mcp.log');
  await fsp.writeFile(mcpPath,
    '2026-10-23T05:00:00.000Z [info] [OldServer] Message from client: {"method":"tools/call","params":{"name":"bait_old_tool","arguments":{"q":"BAIT_BEFORE_ATTACH"}},"jsonrpc":"2.0","id":1}\n');
  return { appSupportDir, logsDir, level, blob1, blob3, blob2, mcpPath };
}

test('D12 activity check: only listings and lstat, only the documented IndexedDB and log paths', async () => {
  await withTmpDir(async (tmp) => {
    const d = await makeClaudeDesktop(tmp);
    const calls = [];
    // The injected fs has nothing but these two calls: an open or a read through it would throw.
    const fsApi = {
      readdir: (p, o) => { calls.push(`readdir ${path.relative(tmp, p)}`); return fsp.readdir(p, o); },
      lstat: (p) => { calls.push(`lstat ${path.relative(tmp, p)}`); return fsp.lstat(p); },
    };
    const act = await computeClaudeCloudActivity(fsApi, d);
    const idb = path.join('ClaudeSupport', 'IndexedDB');
    const level = path.join(idb, 'https_claude.ai_0.indexeddb.leveldb');
    const blob = path.join(idb, 'https_claude.ai_0.indexeddb.blob');
    assert.deepEqual(calls.sort(), [
      `lstat ${path.join('ClaudeLogs', 'main.log')}`,
      `lstat ${path.join('ClaudeLogs', 'mcp.log')}`,
      `lstat ${path.join(blob, '1', '06', '608')}`,
      `lstat ${path.join(blob, '3', '0a', '77')}`,
      `lstat ${path.join(level, '000001.log')}`,
      `lstat ${path.join(level, '000002.ldb')}`,
      `lstat ${path.join(level, 'MANIFEST-000001')}`,
      `readdir ${path.join(blob, '1')}`,
      `readdir ${path.join(blob, '1', '06')}`,
      `readdir ${path.join(blob, '3')}`,
      `readdir ${path.join(blob, '3', '0a')}`,
      `readdir ${level}`,
    ].sort());
    // Kept: a count, a size sum, the newest time, the mcp.log size and the anchor (main.log is the anchor, not counted).
    assert.deepEqual(Object.keys(act).sort(), ['anchorIno', 'anchorPath', 'mcpSize', 'mtimeMs', 'sig', 'size']);
    assert.equal(act.anchorPath, path.join(d.logsDir, 'main.log'));
    assert.match(act.sig, /^6:\d+:\d+$/, 'three leveldb files, two blobs and mcp.log');
    assert.equal(act.mcpSize, (await fsp.stat(d.mcpPath)).size);
  });
});

test('D12 off switch: a root that is not the default runs no desktop scan and touches nothing', async () => {
  await withTmpDir(async (tmp) => {
    const calls = [];
    const fsApi = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); throw new Error('unexpected fs call'); } });
    assert.deepEqual(await scanClaudeDesktopCloud(path.join(tmp, 'projects'), { fs: fsApi }), []);
    assert.deepEqual(calls, []);
    // The ChatGPT desktop and Grok Bot scans have the same rule (they return before any fs call).
    assert.deepEqual(await scanCodexDesktopCloud(path.join(tmp, 'codex')), []);
    assert.deepEqual(await scanGrokDesktopBot(path.join(tmp, 'grok')), []);
  });
});

test('D12 what reaches the page: fixed strings, the MCP server and tool name, nothing of the bodies', async () => {
  await withTmpDir(async (tmp) => {
    const d = await makeClaudeDesktop(tmp);
    const projectsRoot = path.join(tmp, 'projects');
    await fsp.mkdir(projectsRoot, { recursive: true });
    const store = new Store();
    const live = [];
    store.subscribe((msg) => { live.push(msg); });
    const deps = await claudeCode.deps();
    const runner = new Runner({
      opts: { root: projectsRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps: { ...deps, scan: (root, opts) => scan(root, { ...opts, appSupportDir: d.appSupportDir, logsDir: d.logsDir }) },
      store,
      log: () => {},
    });
    await runner.rescanOnce();
    const session = store.snapshot().events.find((e) => e.type === 'session');
    assert.deepEqual(
      { id: session.sessionId, agent: session.agent, surface: session.surface, title: session.title, project: session.project, label: session.projectLabel },
      { id: 'claude-desktop-cloud', agent: 'claude-code', surface: 'app', title: 'Claude Desktop Chat', project: '/Claude Desktop', label: 'Claude Desktop' },
    );
    // The Store key of the character is the anchor file (main.log): the path POST /api/focus-terminal hands to lsof.
    assert.equal(store.byChar.get('claude-desktop-cloud').path, path.join(d.logsDir, 'main.log'));

    await fsp.appendFile(d.mcpPath,
      '2026-10-23T05:01:00.000Z [info] [Filesystem] Message from client: {"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/Users/someone/BAIT_ARG_PATH.txt","note":"BAIT_ARG_TEXT"}},"jsonrpc":"2.0","id":9}\n'
      + '2026-10-23T05:01:00.500Z [info] [Filesystem] Message from client: {"method":"notifications/progress","params":{"note":"BAIT_OTHER_LINE"},"jsonrpc":"2.0"}\n');
    await runner.pollAll();
    await fsp.appendFile(d.mcpPath,
      '2026-10-23T05:01:01.000Z [info] [Filesystem] Message from server: {"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"BAIT_RESULT_BODY"}]}}\n');
    await runner.pollAll();

    const events = live.map((m) => m.event).filter((e) => e && e.sessionId === 'claude-desktop-cloud');
    const start = events.find((e) => e.type === 'tool_start');
    assert.equal(start.tool, 'mcp__Filesystem__read_file');
    assert.equal(start.summary, 'read file');
    assert.equal(start.ts, '2026-10-23T05:01:00.000Z');
    const end = events.find((e) => e.type === 'tool_end');
    assert.equal(end.toolUseId, start.toolUseId);
    assert.equal(end.ok, true);
    assert.deepEqual(events.filter((e) => e.type === 'say').map((e) => e.text), ['Completed Filesystem']);
    assert.equal(events.filter((e) => e.type === 'tool_start').length, 1, 'the line before the attach opens no call');

    const page = JSON.stringify(live) + JSON.stringify(store.snapshot());
    for (const bait of ['BAIT', 'bait_old_tool', 'OldServer', 'someone', tmp, 'ClaudeSupport', 'ClaudeLogs', 'main.log', 'mcp.log', '000001', 'MANIFEST', 'indexeddb']) {
      assert.equal(page.includes(bait), false, `${bait} reached the page`);
    }
  });
});

test('D12 documents: README.md, README.ko.md and CONTRACT 5.1 name the paths and what is done with them', () => {
  const paths = ['~/Library/Application Support/Claude/IndexedDB/', 'https_claude.ai_0.indexeddb.leveldb',
    'https_claude.ai_0.indexeddb.blob', '~/Library/Logs/Claude/', '`main.log`', '`mcp.log`', '128 KiB', '`"name"`',
    '~/Library/Logs/com.openai.codex/', '~/Library/Application Support/com.openai.chat/', '~/.grokbot/',
    '~/Library/Application Support/Grok Bot/', '`Cookies`', '--claude-root', '--replay'];
  for (const rel of ['README.md', 'README.ko.md']) {
    const text = read(rel);
    for (const p of paths) assert.ok(text.includes(p), `${rel} does not mention ${p}`);
    assert.match(text, /docs\/CONTRACT\.md\) (section 5\.1|5\.1절)/, `${rel} points at CONTRACT 5.1`);
  }
  assert.match(read('README.md'), /no IndexedDB file is ever opened/);
  assert.match(read('README.ko.md'), /IndexedDB 파일은 어떤 것도 열지 않습니다/);

  const s5 = read('docs/CONTRACT.md').split('\n## 5. Privacy and rooms')[1].split('\n## 6. ')[0];
  const s51 = s5.split('\n### 5.1 Desktop apps: paths outside the agent roots (launch readiness D12)')[1];
  assert.ok(s51, 'CONTRACT 5.1');
  for (const re of [
    /`~\/Library\/Application Support\/Claude`/, /`~\/Library\/Logs\/Claude`/, /https_claude\.ai_0\.indexeddb\.leveldb/,
    /https_claude\.ai_0\.indexeddb\.blob\/1\//, /No IndexedDB file and not `main\.log` is ever opened/,
    /at most the last 128 KiB per read \(`MAX_MCP_READ_BYTES`/, /the first `"name": "<text>"`/, /Known limit:/,
    /`mcp__<server>__<name>`/, /`Completed <server>`/, /`claude-desktop-cloud`/, /`lsof -t -- <anchor file>`/,
    /`~\/Library\/Logs\/com\.openai\.codex`/, /`~\/Library\/Application Support\/com\.openai\.chat\/`/,
    /`~\/\.grokbot\/`/, /`Cookies`, `Preferences`/, /sand-client-persistence/, /`~\/\.grok\/logs\/unified\.jsonl`/,
    /None has a switch of its own/, /`--replay` \(no scan runs there\)/,
  ]) assert.match(s51, re);
  // The constant the text quotes is the one in the code.
  assert.match(read('src/desktop-claude.mjs'), /const MAX_MCP_READ_BYTES = 128 \* 1024;/);
});
