import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { codex } from '../src/adapters/codex/index.mjs';
import { scan } from '../src/discover.mjs';
import { scanCodex } from '../src/adapters/codex/discover.mjs';
import { parseMcpLogLine } from '../src/desktop-claude.mjs';
import { parseCodexDesktopCloudLine } from '../src/adapters/codex/desktop-cloud.mjs';

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
