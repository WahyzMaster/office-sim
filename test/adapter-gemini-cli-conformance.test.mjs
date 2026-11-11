// Conformance, plug-in registry, dual-format (`.jsonl` + `.json`), CLI flag, and fake-root-guard tests
// for the optional `gemini-cli` plug-in adapter (`src/adapters/plugins.mjs`, `src/adapters/gemini-cli/`).
// Uses synthetic `os.tmpdir()` roots exclusively; never touches real `~/.gemini`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { KNOWN_AGENTS } from '../src/adapters/index.mjs';
import {
  KNOWN_PLUGINS, PLUGIN_ADAPTERS, validatePluginDescriptor, checkPlugins, resolvePluginAdapters, pluginDefaultRoots,
} from '../src/adapters/plugins.mjs';
import { geminiCli } from '../src/adapters/gemini-cli/index.mjs';
import { charIdOf } from '../src/adapters/gemini-cli/discover.mjs';
import { parseArgs } from '../src/cli-args.mjs';
import { runConformance } from './fixtures/conformance.mjs';
import { request, sse, until } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const FAKE_SCRIPT = fileURLToPath(new URL('../scripts/fake-gemini-cli-append.mjs', import.meta.url));

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

async function tmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function runFakeScript(args, home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [FAKE_SCRIPT, ...args],
      { env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home }, timeout: 15_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

test('gemini-cli plug-in passes the unmodified test/fixtures/conformance.mjs harness and enforces allowlist-only discovery', async () => {
  const root = await tmp('office-sim-gcli-conf-');
  const projDir = path.join(root, 'tmp', 'proj-alpha-hash');
  const chatsDir = path.join(projDir, 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  await fsp.writeFile(path.join(projDir, '.project_root'), '/work/invented-gcli-project\n', 'utf8');

  // Sensitive / unrelated files under `<root>` and `<projDir>` that MUST NEVER be opened
  const oauthBait = path.join(root, 'oauth_creds.json');
  const accountsBait = path.join(root, 'google_accounts.json');
  const settingsBait = path.join(root, 'settings.json');
  const logsBait = path.join(projDir, 'logs.json');
  const agyDir = path.join(root, 'antigravity-cli', 'brain');
  await fsp.mkdir(agyDir, { recursive: true });
  const agyTranscript = path.join(agyDir, 'transcript.jsonl');
  await fsp.writeFile(oauthBait, '{"refresh_token":"SECRET_OAUTH_TOKEN_BAIT_991"}');
  await fsp.writeFile(accountsBait, '{"active":"secret-user@example.org"}');
  await fsp.writeFile(settingsBait, '{"apiKey":"SECRET_GEMINI_API_KEY_BAIT"}');
  await fsp.writeFile(logsBait, '[{"message":"RAW_LOGS_JSON_BAIT"}]');
  await fsp.writeFile(agyTranscript, '{"type":"USER_INPUT","content":"AGY_CROSS_ADAPTER_BAIT"}\n');

  // Symlinked session file inside `chats/` must also be skipped (`lstat` + `O_NOFOLLOW`)
  const secretOutside = path.join(root, 'outside-secret.jsonl');
  await fsp.writeFile(secretOutside, '{"type":"user","content":"SYMLINK_BAIT_992"}\n');
  const symlinkSession = path.join(chatsDir, 'session-symlink-target.jsonl');
  await fsp.symlink(secretOutside, symlinkSession);

  const rawId = '2026-04-21T06-00-a1b2c3d4';
  const sessionFile = path.join(chatsDir, `session-${rawId}.jsonl`);
  const t0 = Date.now() - 4000;
  const iso = (d) => new Date(t0 + d).toISOString();
  const initialLines = [
    {
      type: 'session_metadata',
      timestamp: iso(0),
      cwd: '/work/invented-gcli-project',
      branch: 'feat/gcli-adapter',
      title: 'Invented Gemini CLI Feature',
    },
    {
      type: 'user',
      timestamp: iso(100),
      content: 'Audit src/router.mjs and verify tests',
    },
    {
      type: 'gemini',
      timestamp: iso(300),
      thoughts: [{ subject: 'Router check', description: 'Reading router implementation first.' }],
      toolCalls: [
        {
          id: 'tc_plan_1',
          name: 'write_todos',
          args: {
            todos: [
              { description: 'Read router module', status: 'in_progress' },
              { description: 'Run test suite', status: 'pending' },
            ],
          },
          status: 'success',
        },
        {
          id: 'tc_read_1',
          name: 'read_file',
          args: { file_path: '/work/invented-gcli-project/src/router.mjs', secretBody: 'RAW_TOOL_SECRET_BAIT' },
          status: 'executing',
        },
      ],
    },
    {
      type: 'tool_result',
      timestamp: iso(600),
      id: 'tc_read_1',
      status: 'success',
      output: 'CONST_FILE_BODY_BAIT_NEVER_ON_WIRE',
    },
  ];
  await fsp.writeFile(sessionFile, `${initialLines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

  const cid = charIdOf(rawId);
  const res = await runConformance(geminiCli, root, {
    bait: [
      'SECRET_OAUTH_TOKEN_BAIT_991',
      'secret-user@example.org',
      'SECRET_GEMINI_API_KEY_BAIT',
      'RAW_LOGS_JSON_BAIT',
      'AGY_CROSS_ADAPTER_BAIT',
      'SYMLINK_BAIT_992',
      'RAW_TOOL_SECRET_BAIT',
      'CONST_FILE_BODY_BAIT_NEVER_ON_WIRE',
      '/work/invented-gcli-project/src/router.mjs',
    ],
    neverOpen: [oauthBait, accountsBait, settingsBait, logsBait, agyTranscript, symlinkSession, secretOutside],
    mustSee: ['session', 'prompt', 'thinking', 'plan', 'tool_start', 'tool_end', 'say', 'turn_end'],
    live: async ({ waitFor }) => {
      const liveLines = [
        {
          type: 'user',
          timestamp: new Date().toISOString(),
          content: 'Now run the router test suite',
        },
        {
          type: 'gemini',
          timestamp: new Date().toISOString(),
          thoughts: [{ subject: 'Test run', description: 'Executing unit test suite.' }],
          toolCalls: [{ id: 'tc_sh_1', name: 'run_shell_command', args: { command: 'npm test -- --secret-token=BAIT' }, status: 'executing' }],
        },
        {
          type: 'tool_result',
          timestamp: new Date().toISOString(),
          id: 'tc_sh_1',
          status: 'success',
        },
        {
          type: 'gemini',
          timestamp: new Date().toISOString(),
          content: 'All router checks passed cleanly.',
        },
        {
          type: 'turn_end',
          timestamp: new Date().toISOString(),
          reason: 'end_turn',
        },
      ];
      await fsp.appendFile(sessionFile, `${liveLines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
      await waitFor((ev) => ev.type === 'turn_end' && ev.sessionId === cid);
    },
  });

  const sess = res.stream.find((e) => e.type === 'session' && e.sessionId === cid);
  assert.equal(sess?.agent, 'gemini-cli');
  assert.equal(sess?.surface, 'cli');
  assert.equal(sess?.projectLabel, 'invented-gcli-project');
  assert.equal(sess?.branch, 'feat/gcli-adapter');
});

test('gemini-cli plug-in tails rewritten ConversationRecord .json files and coexists cleanly via start({ plugins })', async () => {
  const root = await tmp('office-sim-gcli-json-');
  const projDir = path.join(root, 'proj-json-01');
  const chatsDir = path.join(projDir, 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  await fsp.writeFile(path.join(projDir, '.project_root'), '/work/json-floor\n', 'utf8');

  const rawId = 'conv-json-77';
  const cid = charIdOf(rawId);
  const jsonFile = path.join(chatsDir, `session-${rawId}.json`);
  const t0 = new Date().toISOString();

  await fsp.writeFile(jsonFile, JSON.stringify({
    sessionId: rawId,
    startTime: t0,
    lastUpdated: t0,
    summary: 'JSON Conversation Session',
    messages: [
      { id: 'm1', type: 'user', timestamp: t0, content: 'Check JSON conversation tailing' },
      {
        id: 'm2',
        type: 'gemini',
        timestamp: t0,
        toolCalls: [{ id: 'jcall_1', name: 'grep_search', args: { pattern: 'createStage' }, status: 'executing' }],
      },
    ],
  }, null, 2));

  const emptyClaude = await tmp('office-sim-gcli-empty-claude-');
  const logs = [];
  const app = await start({
    port: 0,
    publicDir: PUBLIC,
    root: emptyClaude,
    plugins: ['gemini-cli'],
    agents: ['gemini-cli'],
    roots: { 'gemini-cli': root },
    intervalMs: 50,
    rescanMs: 60,
    idleMs: 50,
    activeMinutes: 30,
    log: (m) => logs.push(m),
  });

  let es = null;
  try {
    assert.deepEqual([...KNOWN_AGENTS], ['claude-code', 'codex', 'grok', 'antigravity'], 'default KNOWN_AGENTS remains unchanged');
    assert.deepEqual(app.agents, ['gemini-cli']);
    await app.ready;
    es = await sse(app.port);
    await es.next((fr) => fr.data?.type === 'snapshot', 3000);

    await until(async () => {
      const evs = JSON.parse((await request(app.port, { path: '/state' })).body).events;
      return evs.some((e) => e.type === 'tool_start' && e.sessionId === cid && e.toolUseId === 'jcall_1');
    }, 3000);

    // Rewrite the `.json` file in-place (same path/inode) transitioning `jcall_1` -> `success` and adding final reply
    const t1 = new Date().toISOString();
    await fsp.writeFile(jsonFile, JSON.stringify({
      sessionId: rawId,
      startTime: t0,
      lastUpdated: t1,
      summary: 'JSON Conversation Session',
      messages: [
        { id: 'm1', type: 'user', timestamp: t0, content: 'Check JSON conversation tailing' },
        {
          id: 'm2',
          type: 'gemini',
          timestamp: t0,
          toolCalls: [{ id: 'jcall_1', name: 'grep_search', args: { pattern: 'createStage' }, status: 'success' }],
        },
        { id: 'm3', type: 'gemini', timestamp: t1, content: 'Found createStage in scene.js.' },
      ],
    }, null, 2));

    await es.next((fr) => fr.data?.type === 'tool_end' && fr.data.sessionId === cid && fr.data.toolUseId === 'jcall_1' && fr.data.ok === true, 3000);
    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === cid && fr.data.text.includes('Found createStage'), 3000);

    // 1) Atomic-rename save of the same conversation (new inode at same path) emits live delta without freezing
    const t2 = new Date().toISOString();
    const atomicTmp = `${jsonFile}.tmp`;
    await fsp.writeFile(atomicTmp, JSON.stringify({
      sessionId: rawId,
      startTime: t0,
      lastUpdated: t2,
      summary: 'JSON Conversation Session',
      messages: [
        { id: 'm1', type: 'user', timestamp: t0, content: 'Check JSON conversation tailing' },
        { id: 'm2', type: 'gemini', timestamp: t0, toolCalls: [{ id: 'jcall_1', name: 'grep_search', args: { pattern: 'createStage' }, status: 'success' }] },
        { id: 'm3', type: 'gemini', timestamp: t1, content: 'Found createStage in scene.js.' },
        { id: 'm4', type: 'user', timestamp: t2, content: 'Follow-up after atomic rename' },
        { id: 'm5', type: 'gemini', timestamp: t2, content: 'Atomic rename handled cleanly.' },
      ],
    }, null, 2));
    await fsp.rename(atomicTmp, jsonFile);

    await es.next((fr) => fr.data?.type === 'say' && fr.data.sessionId === cid && fr.data.text.includes('Atomic rename handled'), 3000);

    // 2) Truncated / replaced ConversationRecord (different doc.sessionId / fewer messages) triggers reset -> re-attach
    const t3 = new Date().toISOString();
    await fsp.writeFile(atomicTmp, JSON.stringify({
      sessionId: `${rawId}-restarted`,
      startTime: t3,
      lastUpdated: t3,
      summary: 'Restarted JSON Session',
      messages: [
        {
          id: 'r1',
          type: 'gemini',
          timestamp: t3,
          toolCalls: [{ id: 'jcall_reset_1', name: 'read_file', args: { file_path: '/work/json-floor/index.mjs' }, status: 'executing' }],
        },
      ],
    }, null, 2));
    await fsp.rename(atomicTmp, jsonFile);

    await until(async () => {
      const evs = JSON.parse((await request(app.port, { path: '/state' })).body).events;
      return evs.some((e) => e.type === 'tool_start' && e.sessionId === cid && e.toolUseId === 'jcall_reset_1');
    }, 3000);

    // 3) Replacing `.json` path with a symlink is rejected via O_NOFOLLOW (`ELOOP` -> `{ gone: true }`, 0 loopErrors)
    const symlinkTarget = path.join(root, 'symlink-json-bait.json');
    await fsp.writeFile(symlinkTarget, JSON.stringify({
      sessionId: `${rawId}-symlink`,
      messages: [{ id: 's1', type: 'gemini', timestamp: t3, content: 'SYMLINK_JSON_SWAP_BAIT_771' }],
    }));
    await fsp.unlink(jsonFile);
    await fsp.symlink(symlinkTarget, jsonFile);

    await until(async () => {
      const evs = JSON.parse((await request(app.port, { path: '/state' })).body).events;
      return !evs.some((e) => e.sessionId === cid);
    }, 3000);
    assert.equal(es.frames.some((fr) => JSON.stringify(fr.data ?? '').includes('SYMLINK_JSON_SWAP_BAIT_771')), false);
    assert.equal(app.stats().applyErrors, 0);
    assert.equal(app.stats().badLines, 0);
    assert.equal(logs.some((m) => /failed|loop error/i.test(m)), false, `unexpected runner errors: ${logs.join('; ')}`);
  } finally {
    es?.close();
    await app.close();
  }
});

test('plugins.mjs, parseArgs and fake-gemini-cli-append.mjs enforce descriptor validation and ~/.gemini guardrails', async () => {
  assert.deepEqual([...KNOWN_PLUGINS], ['gemini-cli']);
  assert.equal(PLUGIN_ADAPTERS['gemini-cli'], geminiCli);
  assert.deepEqual(checkPlugins(['gemini-cli', 'gemini-cli']), ['gemini-cli']);
  assert.throws(() => checkPlugins(['unknown-plugin']), /unknown plugin/);
  assert.throws(() => validatePluginDescriptor({ id: 'claude-code', defaultRoot: '/tmp/x', deps: async () => ({}) }), /cannot shadow/);
  assert.throws(() => validatePluginDescriptor({ id: 'bad/id', defaultRoot: '/tmp/x', deps: async () => ({}) }), /invalid plugin adapter id/);

  const merged = resolvePluginAdapters(['gemini-cli']);
  assert.equal(merged['gemini-cli'], geminiCli);
  assert.deepEqual(pluginDefaultRoots(['gemini-cli']), { 'gemini-cli': '~/.gemini/tmp' });

  const parsed = parseArgs(['--plugins', 'gemini-cli', '--agents', 'claude-code,gemini-cli', '--gemini-cli-root', '/tmp/synth-gcli']);
  assert.deepEqual(parsed.plugins, ['gemini-cli']);
  assert.deepEqual(parsed.agents, ['claude-code', 'gemini-cli']);
  assert.equal(parsed.roots['gemini-cli'], '/tmp/synth-gcli');
  assert.throws(() => parseArgs(['--agents', 'gemini-cli']), /unknown agent "gemini-cli"/, 'without --plugins gemini-cli, gemini-cli is rejected');

  // Verify scripts/fake-gemini-cli-append.mjs refuses real ~/.gemini (inside fake HOME) and succeeds in a separate temp dir
  const fakeHome = await tmp('office-sim-gcli-fake-home-');
  const realGemini = path.join(fakeHome, '.gemini');
  await fsp.mkdir(realGemini, { recursive: true });

  const refused = await runFakeScript(['--root', path.join(realGemini, 'tmp'), '--once'], fakeHome);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /refusing to write into the real ~\/\.gemini/);

  const safeRoot = await tmp('office-sim-gcli-safe-out-');
  const ok = await runFakeScript(['--root', safeRoot, '--once'], fakeHome);
  assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
  const writtenChats = await fsp.readdir(path.join(safeRoot, 'synthetic-proj-01', 'chats'));
  assert.equal(writtenChats.length, 1);
  assert.match(writtenChats[0], /^session-.*\.jsonl$/);
});
