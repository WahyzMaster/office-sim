import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { codex } from '../src/adapters/codex/index.mjs';
import { grok } from '../src/adapters/grok/index.mjs';
import { scan } from '../src/discover.mjs';
import { scanCodex } from '../src/adapters/codex/discover.mjs';
import { scanGrok } from '../src/adapters/grok/discover.mjs';
import { parseMcpLogLine } from '../src/desktop-claude.mjs';
import { parseCodexDesktopCloudLine } from '../src/adapters/codex/desktop-cloud.mjs';
import { parseGrokUnifiedLogLine } from '../src/adapters/grok/desktop-bot.mjs';

async function withTmpDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-cloud-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('parseMcpLogLine parses modern and JSON-RPC tools/call and server result lines', () => {
  const call1 = parseMcpLogLine('2026-10-23T05:44:16.797Z [info] [Context7] Message from client: method="tools/call" id=12 params');
  assert.deepEqual(call1, {
    kind: 'call',
    ts: '2026-10-23T05:44:16.797Z',
    server: 'Context7',
    reqId: '12',
    toolName: 'mcp__Context7__call',
  });

  const call2 = parseMcpLogLine(
    '2026-10-23T05:44:17.000Z [info] [Filesystem] Message from client: {"method":"tools/call","params":{"name":"read_file","arguments":{}},"jsonrpc":"2.0","id":7}',
  );
  assert.deepEqual(call2, {
    kind: 'call',
    ts: '2026-10-23T05:44:17.000Z',
    server: 'Filesystem',
    reqId: '7',
    toolName: 'mcp__Filesystem__read_file',
  });

  const res1 = parseMcpLogLine('2026-10-23T05:44:18.000Z [info] [Filesystem] Message from server: id=7 result');
  assert.deepEqual(res1, {
    kind: 'result',
    ts: '2026-10-23T05:44:18.000Z',
    server: 'Filesystem',
    reqId: '7',
    isError: false,
  });
});

test('Claude Desktop Cloud Chat discovery + Runner + Store emits app character and MCP tool events', async () => {
  await withTmpDir(async (tmp) => {
    const projectsRoot = path.join(tmp, 'projects');
    const appSupportDir = path.join(tmp, 'ClaudeSupport');
    const logsDir = path.join(tmp, 'ClaudeLogs');
    const idbDir = path.join(appSupportDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
    const blobDir = path.join(appSupportDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob', '1', '06');
    await fsp.mkdir(projectsRoot, { recursive: true });
    await fsp.mkdir(idbDir, { recursive: true });
    await fsp.mkdir(blobDir, { recursive: true });
    await fsp.mkdir(logsDir, { recursive: true });

    await fsp.writeFile(path.join(idbDir, '000001.log'), 'conversationUuid');
    await fsp.writeFile(path.join(blobDir, '608'), 'react-query-cache');
    await fsp.writeFile(path.join(logsDir, 'main.log'), '2026-10-23T05:00:00.000Z [info] main ready\n');
    const mcpPath = path.join(logsDir, 'mcp.log');
    await fsp.writeFile(mcpPath, '2026-10-23T05:00:00.000Z [info] [Figma] Message from client: method="initialize" id=0 params\n');

    const store = new Store();
    const baseDeps = await claudeCode.deps();
    const deps = {
      ...baseDeps,
      scan: (root, opts) => scan(root, { ...opts, appSupportDir, logsDir }),
    };
    const runner = new Runner({
      opts: { root: projectsRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps,
      store,
      log: () => {},
    });

    await runner.rescanOnce();
    const snap1 = store.snapshot();
    const sessionEv = snap1.events.find((e) => e.type === 'session' && e.sessionId === 'claude-desktop-cloud');
    assert.ok(sessionEv, 'expected claude-desktop-cloud session event');
    assert.equal(sessionEv.agent, 'claude-code');
    assert.equal(sessionEv.surface, 'app');
    assert.equal(sessionEv.title, 'Claude Desktop Chat');
    assert.equal(sessionEv.projectLabel, 'Claude Desktop');

    // Append an MCP tool call to mcp.log and poll.
    await fsp.appendFile(
      mcpPath,
      '2026-10-23T05:01:00.000Z [info] [Filesystem] Message from client: {"method":"tools/call","params":{"name":"read_file","arguments":{}},"jsonrpc":"2.0","id":9}\n',
    );
    await runner.pollAll();
    const snap2 = store.snapshot();
    const openTool = snap2.events.find((e) => e.type === 'tool_start' && e.sessionId === 'claude-desktop-cloud');
    assert.ok(openTool, 'expected open MCP tool_start on claude-desktop-cloud');
    assert.equal(openTool.tool, 'mcp__Filesystem__read_file');

    // Complete the MCP tool call.
    await fsp.appendFile(
      mcpPath,
      '2026-10-23T05:01:01.000Z [info] [Filesystem] Message from server: id=9 result\n',
    );
    await runner.pollAll();
    const snap3 = store.snapshot();
    assert.equal(
      snap3.events.some((e) => e.type === 'tool_start' && e.sessionId === 'claude-desktop-cloud'),
      false,
      'expected MCP tool to close after server result',
    );
  });
});

test('parseCodexDesktopCloudLine matches only real cloud conversation lifecycle lines', () => {
  const noise1 = parseCodexDesktopCloudLine(
    '2026-10-23T06:00:00.000Z INFO [1] response_routed conversationId=69e32c0f-c8bc-83aa-ad47-accc6bcde906 method=account/read',
  );
  assert.equal(noise1, null);

  const noise2 = parseCodexDesktopCloudLine(
    '2026-10-23T06:00:00.000Z INFO [1] Received turn/started for unknown conversation conversationId=019dab45-fd5b-72d1-b9d8-d2d79c11ca49',
  );
  assert.equal(noise2, null);

  const hit1 = parseCodexDesktopCloudLine(
    '2026-10-23T06:01:00.000Z INFO [1] [IAB] chatgpt_conversation_refetch_started conversationId=69e32c0f-c8bc-83aa-ad47-accc6bcde906',
  );
  assert.equal(hit1?.kind, 'start');
  assert.equal(hit1?.uuid, '69e32c0f-c8bc-83aa-ad47-accc6bcde906');

  const hit2 = parseCodexDesktopCloudLine(
    '2026-10-23T06:01:05.000Z INFO [1] [desktop-notifications] received turn-complete conversationId=69e32c0f-c8bc-83aa-ad47-accc6bcde906',
  );
  assert.equal(hit2?.kind, 'complete');
  assert.equal(hit2?.uuid, '69e32c0f-c8bc-83aa-ad47-accc6bcde906');

  const dotTurn = parseCodexDesktopCloudLine(
    '2026-10-23T06:02:03.295Z error [electron-message-handler] Received turn/started for unknown conversation conversationId=01a1675a-246f-7ff0-ae35-d97ecbfd7883 rendererWebContentsId=2 rendererWindowAppearance=avatarOverlay rendererWindowFocused=false rendererWindowId=2 rendererWindowVisible=true',
  );
  assert.equal(dotTurn?.kind, 'start');
  assert.equal(dotTurn?.uuid, '01a1675a-246f-7ff0-ae35-d97ecbfd7883');
  assert.equal(dotTurn?.dot, true);

  const dotWin = parseCodexDesktopCloudLine(
    '2026-10-23T06:50:16.642Z info [window-manager] window ready-to-show appearance=avatarOverlay hostId=local startupElapsedMs=236 webContentsId=2 windowId=2',
    'fe7f460b-9e92-43cd-aa7c-6d1ef1e18a53',
  );
  assert.equal(dotWin?.kind, 'sync');
  assert.equal(dotWin?.uuid, 'fe7f460b-9e92-43cd-aa7c-6d1ef1e18a53');
  assert.equal(dotWin?.dot, true);
});

test('ChatGPT Desktop cloud log + ChatGPT Classic .data discovery + Runner + Store emits app characters', async () => {
  await withTmpDir(async (tmp) => {
    const codexRoot = path.join(tmp, 'codex');
    const logsRoot = path.join(tmp, 'CodexLogs');
    const classicRoot = path.join(tmp, 'ChatGPTClassic');
    const now = Date.now();
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const dayRel = path.join(`${d.getFullYear()}`, pad(d.getMonth() + 1), pad(d.getDate()));

    const logDayDir = path.join(logsRoot, dayRel);
    const classicConvDir = path.join(classicRoot, 'conversations-v3-user');
    await fsp.mkdir( path.join(codexRoot, 'sessions'), { recursive: true });
    await fsp.mkdir(logDayDir, { recursive: true });
    await fsp.mkdir(classicConvDir, { recursive: true });

    const cloudUuid = '69e32c0f-c8bc-83aa-ad47-accc6bcde906';
    const deletedUuid = '6adaf810-6d40-83ee-92e5-a5e9b3fe558a';
    const classicUuid = '44444444-5555-4666-8777-888888888888';
    const nowIso = new Date(now).toISOString();
    const logPath = path.join(logDayDir, 'codex-desktop-1-t0-test.log');
    await fsp.writeFile(
      logPath,
      [
        `${nowIso} INFO [1] [IAB] chatgpt_conversation_refetch_started conversationId=${cloudUuid}`,
        `${nowIso} INFO [1] [IAB] chatgpt_conversation_refetch_started conversationId=${deletedUuid}`,
        `${nowIso} WARN [1] sa_server_request_failed errorCode=conversation_deleted status=404 url=/conversations/${deletedUuid}`,
      ].join('\n') + '\n',
    );
    const dataPath = path.join(classicConvDir, `${classicUuid}.data`);
    await fsp.writeFile(dataPath, 'encrypted-conversation-state');

    const store = new Store();
    const baseDeps = await codex.deps();
    const deps = {
      ...baseDeps,
      scan: (root, opts) => scanCodex(root, { ...opts, logsRoot, classicRoot }),
    };
    const runner = new Runner({
      opts: { root: codexRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps,
      store,
      log: () => {},
    });

    await runner.rescanOnce();
    const snap = store.snapshot();
    const cloudSession = snap.events.find((e) => e.type === 'session' && e.sessionId === `codex-${cloudUuid}`);
    assert.ok(cloudSession, 'expected ChatGPT Desktop cloud session');
    assert.equal(cloudSession.agent, 'codex');
    assert.equal(cloudSession.surface, 'app');
    assert.equal(cloudSession.projectLabel, 'ChatGPT Desktop');
    assert.equal(
      snap.events.some((e) => e.type === 'session' && e.sessionId === `codex-${deletedUuid}`),
      false,
      'expected deleted cloud conversation to be ignored',
    );

    const classicSession = snap.events.find((e) => e.type === 'session' && e.sessionId === `codex-${classicUuid}`);
    assert.ok(classicSession, 'expected ChatGPT Classic session');
    assert.equal(classicSession.agent, 'codex');
    assert.equal(classicSession.surface, 'app');
    assert.equal(classicSession.projectLabel, 'ChatGPT Classic');
  });
});

test('ChatGPT Dot companion window (avatarOverlay) and Grok Bot desktop + unified log discovery emit bot sessions', async () => {
  await withTmpDir(async (tmp) => {
    const codexRoot = path.join(tmp, 'codex');
    const logsRoot = path.join(tmp, 'CodexLogs');
    const grokRoot = path.join(tmp, 'grok');
    const grokBotRoot = path.join(tmp, 'grokbot');
    const appSupportRoot = path.join(tmp, 'GrokBotSupport');
    const persistDir = path.join(appSupportRoot, 'sand-client-persistence');
    const unifiedLogPath = path.join(grokRoot, 'logs', 'unified.jsonl');

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const dayRel = nowIso.slice(0, 10).replace(/-/g, path.sep);
    const logDayDir = path.join(logsRoot, dayRel);

    await fsp.mkdir(path.join(codexRoot, 'sessions'), { recursive: true });
    await fsp.mkdir(logDayDir, { recursive: true });
    await fsp.mkdir(path.join(grokRoot, 'sessions'), { recursive: true });
    await fsp.mkdir(path.dirname(unifiedLogPath), { recursive: true });
    await fsp.mkdir(grokBotRoot, { recursive: true });
    await fsp.mkdir(persistDir, { recursive: true });

    const dotDesktopUuid = 'fe7f460b-9e92-43cd-aa7c-6d1ef1e18a53';
    const hydratedCloudUuid = '6adb03b7-5e8c-83e8-ac6c-d4a53c7a6a65';
    const dotLogPath = path.join(logDayDir, `codex-desktop-${dotDesktopUuid}-34659-t0-i1-065009-0.log`);
    await fsp.writeFile(
      dotLogPath,
      [
        `${nowIso} INFO [1] [IAB] chatgpt_conversation_refetch_started conversationId=${hydratedCloudUuid}`,
        `${nowIso} info [window-manager] window ready-to-show appearance=avatarOverlay hostId=local startupElapsedMs=236 webContentsId=2 windowId=2`,
      ].join('\n') + '\n',
    );

    const grokBotUuid = 'b1bc694a-77df-43f3-8635-835395346f0e';
    await fsp.writeFile(
      path.join(grokBotRoot, 'local-exec-daemon.log'),
      '[sand-local-exec-daemon] started (pid 34912); serving local exec over the gateway\n',
    );
    await fsp.writeFile(
      path.join(persistDir, 'bots.blob'),
      JSON.stringify({
        schemaVersion: 2,
        value: {
          rows: [{ id: grokBotUuid, name: 'New Bot', title: '', updatedAt: now, lastActivityAt: now }],
        },
      }),
    );

    const unifiedSid = '01a15e48-cd59-7322-b1c5-ef969cd799ff';
    const parsedLine = parseGrokUnifiedLogLine(
      JSON.stringify({ ts: nowIso, src: 'shell', sid: unifiedSid, msg: 'shell.turn.inference_start' }),
    );
    assert.equal(parsedLine?.sid, unifiedSid);
    assert.equal(parsedLine?.completed, false);
    await fsp.writeFile(
      unifiedLogPath,
      `${JSON.stringify({ ts: nowIso, src: 'shell', sid: unifiedSid, msg: 'shell.turn.inference_start' })}\n`,
    );

    const store = new Store();
    const codexDeps = await codex.deps();
    const codexRunner = new Runner({
      opts: { root: codexRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps: { ...codexDeps, scan: (root, opts) => scanCodex(root, { ...opts, logsRoot, classicRoot: '' }) },
      store,
      log: () => {},
    });
    const grokDeps = await grok.deps();
    const grokRunner = new Runner({
      opts: { root: grokRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps: {
        ...grokDeps,
        scan: (root, opts) => scanGrok(root, { ...opts, grokBotRoot, appSupportRoot, unifiedLogPath }),
      },
      store,
      log: () => {},
    });

    await codexRunner.rescanOnce();
    await grokRunner.rescanOnce();

    const snap = store.snapshot();
    const dotSession = snap.events.find((e) => e.type === 'session' && e.sessionId === `codex-${dotDesktopUuid}`);
    assert.ok(dotSession, 'expected ChatGPT Dot companion session');
    assert.equal(dotSession.agent, 'codex');
    assert.equal(dotSession.surface, 'app');
    assert.equal(dotSession.project, '/ChatGPT Dot');
    assert.equal(dotSession.projectLabel, 'ChatGPT Dot');
    assert.equal(dotSession.title, 'ChatGPT Dot');

    const botSession = snap.events.find((e) => e.type === 'session' && e.sessionId === `grok-${grokBotUuid}`);
    assert.ok(botSession, 'expected Grok Bot desktop session');
    assert.equal(botSession.agent, 'grok');
    assert.equal(botSession.surface, 'app');
    assert.equal(botSession.project, '/Grok Bot');
    assert.equal(botSession.projectLabel, 'Grok Bot');
    assert.equal(botSession.title, 'Grok Bot · New Bot');

    const cliSession = snap.events.find((e) => e.type === 'session' && e.sessionId === `grok-${unifiedSid}`);
    assert.ok(cliSession, 'expected Grok unified log session');
    assert.equal(cliSession.agent, 'grok');
    assert.equal(cliSession.surface, 'cli');
    assert.equal(cliSession.project, '/Grok Bot');
  });
});
