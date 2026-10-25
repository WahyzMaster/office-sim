// P1–P4 Roadmap tests:
// - P1: Opt-in Claude Hook Receiver + merge-safe ~/.claude/settings.json installer
// - P2: Click 3D Character -> Focus Native Terminal Tab (TTY resolution + JXA/AppleScript focus)
// - P3: 3D Context Window Fuel Ring + Compaction Burst + Token/USD Spend Estimator
// - P4: Unreviewed "Done (✓)" Badge + 1-click Sprint Session Recap Card
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  HOOK_EVENTS,
  HOOK_MARKER,
  parseClaudeHookPayload,
  buildHookCommand,
  installClaudeHooks,
  uninstallClaudeHooks,
} from '../src/hooks-receiver.mjs';
import {
  normalizeTtyDevice,
  resolveSessionTty,
  focusTerminalForSession,
} from '../src/terminal-focus.mjs';
import { SessionRecapTracker } from '../src/session-recap.mjs';
import {
  computeContextFuelColor,
  applyEventToMetrics,
  formatMetricsSummary,
} from '../public/js/agent-extras.js';
import { start } from '../src/server.mjs';
import { request } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
class NullTailer {
  async readAll() { return { offset: 0 }; }
  async poll() { return { bytes: 0 }; }
  forget() {}
}
const DEPS = {
  Tailer: NullTailer,
  scan: async () => [],
  readSubMeta: async () => null,
  readJournalLabels: async () => new Map(),
};

test('P1: parseClaudeHookPayload maps SessionStart, Notification, PreToolUse, PostToolUseFailure, PreCompact, and Stop with privacy scrubbing', () => {
  const startEv = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'SessionStart',
    cwd: '/Users/secretuser/work/office-sim',
  });
  assert.equal(startEv.sessionId, 'sess-hook-1');
  assert.equal(startEv.events[0].type, 'session');
  assert.equal(startEv.events[0].projectLabel, 'office-sim');

  const perm = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude wants permission to run Bash',
  });
  assert.equal(perm.waitingApproval, true);
  assert.equal(perm.events[0].type, 'tool_wait');
  assert.equal(perm.events[0].waiting, true);

  const activeHookTools = new Map();
  const preTool = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/Users/secretuser/work/office-sim/src/server.mjs' },
  }, { activeHookTools });
  assert.equal(preTool.events[0].type, 'tool_start');
  assert.equal(preTool.events[0].tool, 'Edit');
  assert.equal(preTool.events[0].summary, 'server.mjs');
  assert.ok(!JSON.stringify(preTool).includes('secretuser'), 'no absolute user path leaked');

  const fail = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Edit',
    error: 'exit code 1',
  }, { activeHookTools });
  assert.equal(fail.events[0].type, 'tool_end');
  assert.equal(fail.events[0].ok, false);
  assert.equal(fail.events[0].errorKind, 'failed');

  const compact = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'PreCompact',
  });
  assert.equal(compact.events[0].type, 'system');
  assert.equal(compact.events[0].kind, 'compact');

  const stop = parseClaudeHookPayload({
    session_id: 'sess-hook-1',
    hook_event_name: 'Stop',
  });
  assert.equal(stop.events[0].type, 'turn_end');
});

test('P1: installClaudeHooks and uninstallClaudeHooks merge safely in os.tmpdir() with backup and idempotency', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-hooks-'));
  try {
    const settingsPath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: 'dark',
      hooks: {
        Notification: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo custom-hook' }] },
        ],
      },
    }, null, 2));

    const res1 = installClaudeHooks({ settingsPath, port: 4242 });
    assert.equal(res1.installed, true);
    assert.equal(res1.events, HOOK_EVENTS.length);

    const afterInstall = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(afterInstall.theme, 'dark');
    assert.equal(afterInstall.hooks.Notification.length, 2, 'preserved existing hook + added office-sim hook');
    assert.ok(buildHookCommand({ port: 4242 }).includes(HOOK_MARKER));

    // Backup file created once
    const bak = await fs.readFile(`${settingsPath}.office-sim.bak`, 'utf8');
    assert.ok(bak.includes('echo custom-hook'));

    // Re-running installClaudeHooks is idempotent
    installClaudeHooks({ settingsPath, port: 4242 });
    const afterReinstall = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(afterReinstall.hooks.Notification.length, 2, 'idempotent install');

    // Uninstall removes only office-sim hooks
    const un = uninstallClaudeHooks({ settingsPath });
    assert.equal(un.removed, true);
    const afterUninstall = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(afterUninstall.hooks.Notification.length, 1);
    assert.equal(afterUninstall.hooks.Notification[0].hooks[0].command, 'echo custom-hook');
    assert.equal(afterUninstall.hooks.PreCompact, undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('P2: normalizeTtyDevice, resolveSessionTty, and focusTerminalForSession resolve TTY and focus terminal tab', async () => {
  assert.equal(normalizeTtyDevice('ttys007'), '/dev/ttys007');
  assert.equal(normalizeTtyDevice('/dev/ttys007'), '/dev/ttys007');
  assert.equal(normalizeTtyDevice('??'), null);
  assert.equal(normalizeTtyDevice('../etc/passwd'), null);

  const fakeExec = (cmd, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (cmd === 'lsof') return callback(null, '9123\n', '');
    if (cmd === 'ps') return callback(null, 'ttys012\n', '');
    if (cmd === '/usr/bin/osascript') return callback(null, 'matched:iTerm2\n', '');
    return callback(null, '', '');
  };

  const resolved = await resolveSessionTty({
    sessionId: 's1',
    filePath: '/tmp/fake-session.jsonl',
    execFileFn: fakeExec,
  });
  assert.equal(resolved.tty, '/dev/ttys012');
  assert.equal(resolved.pid, 9123);

  const fakeStore = {
    byChar: new Map([
      ['s1', { path: '/tmp/fake-session.jsonl', lastSession: { projectLabel: 'office-sim' } }],
    ]),
  };
  const focused = await focusTerminalForSession('s1', {
    store: fakeStore,
    platform: 'darwin',
    execFileFn: fakeExec,
  });
  assert.equal(focused.ok, true);
  assert.equal(focused.tty, '/dev/ttys012');
  assert.equal(focused.method, 'tty');
  assert.equal(focused.target, 'iTerm2');
});

test('P3 & P4: SessionRecapTracker and agent-extras compute context fuel ring colors, compactions, unreviewed done badge, and Markdown recap', () => {
  assert.equal(computeContextFuelColor(25), '#2fb36a');
  assert.equal(computeContextFuelColor(65), '#e0a32a');
  assert.equal(computeContextFuelColor(90), '#f0554a');

  const m = applyEventToMetrics(null, {
    type: 'assistant',
    usage: { input_tokens: 140_000, output_tokens: 5_000 },
  });
  assert.equal(m.contextTokens, 145_000);
  assert.ok(m.contextPct > 0.7);
  assert.ok(m.estimatedCostUsd > 0);
  const formatted = formatMetricsSummary(m, 'Claude', 'office-sim');
  assert.equal(formatted.pct, 73);
  assert.match(formatted.markdown, /Sprint Session Recap — Claude \(office-sim\)/);

  const afterCompact = applyEventToMetrics(m, { type: 'system', kind: 'compact' });
  assert.equal(afterCompact.compactions, 1);

  const afterTurnEnd = applyEventToMetrics(afterCompact, { type: 'turn_end', waiting: true });
  assert.equal(afterTurnEnd.unreviewedDone, true);

  const tracker = new SessionRecapTracker();
  tracker.observeEvent({
    type: 'session',
    sessionId: 's-recap',
    agent: 'claude-code',
    title: 'Fix P4',
    projectLabel: 'office-sim',
  });
  tracker.observeEvent({
    type: 'tool_start',
    sessionId: 's-recap',
    tool: 'Edit',
    summary: 'server-http.mjs',
  });
  tracker.observeEvent({
    type: 'say',
    sessionId: 's-recap',
    text: 'Updated server-http routes for P1 to P4.',
  });
  tracker.observeEvent({ type: 'system', sessionId: 's-recap', kind: 'compact' });
  tracker.observeEvent({ type: 'turn_end', sessionId: 's-recap' });

  const sRecap = tracker.getRecap('s-recap');
  assert.equal(sRecap.compactions, 1);
  assert.equal(sRecap.unreviewedDone, true);
  assert.deepEqual(sRecap.filesTouched, ['server-http.mjs']);
  assert.match(sRecap.markdown, /## Sprint Session Recap — Fix P4 \(office-sim\)/);
  assert.match(sRecap.markdown, /server-http\.mjs/);

  const list = tracker.summaryList();
  assert.equal(list.length, 1);

  assert.equal(tracker.markReviewed('s-recap'), true);
  assert.equal(tracker.getRecap('s-recap').unreviewedDone, false);
});

test('P1–P4 HTTP integration: /api/hooks/claude, /api/focus-terminal, /api/recap, and /api/recap/review', async () => {
  const fakeExec = (cmd, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (cmd === '/usr/bin/osascript') return callback(null, 'matched:iTerm2\n', '');
    return callback(null, '', '');
  };
  const app = await start({
    port: 0,
    root: '/nonexistent-office-sim-root',
    publicDir: PUBLIC,
    deps: DEPS,
    focusOpts: { platform: 'darwin', execFileFn: fakeExec },
  });
  try {
    await app.ready;
    const { port } = app;
    const headers = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
    };

    // 1. P1: POST /api/hooks/claude SessionStart + PreToolUse + Stop
    await request(port, {
      method: 'POST',
      path: '/api/hooks/claude',
      headers,
      body: JSON.stringify({
        session_id: 'hook-live-1',
        hook_event_name: 'SessionStart',
        cwd: '/Users/dev/project',
      }),
    });
    const hookRes = await request(port, {
      method: 'POST',
      path: '/api/hooks/claude',
      headers,
      body: JSON.stringify({
        session_id: 'hook-live-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/Users/dev/project/index.mjs' },
        cwd: '/Users/dev/project',
      }),
    });
    assert.equal(hookRes.status, 200);
    assert.equal(JSON.parse(hookRes.body).sessionId, 'hook-live-1');

    await request(port, {
      method: 'POST',
      path: '/api/hooks/claude',
      headers,
      body: JSON.stringify({
        session_id: 'hook-live-1',
        hook_event_name: 'Stop',
      }),
    });

    // 2. P4: GET /api/recap?sessionId=hook-live-1 returns recap including index.mjs and unreviewedDone=true
    const recapRes = await request(port, { method: 'GET', path: '/api/recap?sessionId=hook-live-1' });
    assert.equal(recapRes.status, 200);
    const recapBody = JSON.parse(recapRes.body);
    assert.equal(recapBody.unreviewedDone, true);
    assert.ok(recapBody.markdown.includes('index.mjs'));

    // 3. P4: POST /api/recap/review clears unreviewedDone
    const revRes = await request(port, {
      method: 'POST',
      path: '/api/recap/review',
      headers,
      body: JSON.stringify({ sessionId: 'hook-live-1' }),
    });
    assert.equal(revRes.status, 200);
    assert.equal(JSON.parse(revRes.body).ok, true);

    const recapAfter = JSON.parse((await request(port, { method: 'GET', path: '/api/recap?sessionId=hook-live-1' })).body);
    assert.equal(recapAfter.unreviewedDone, false);

    // 4. P2: POST /api/focus-terminal focuses the TTY
    const focusRes = await request(port, {
      method: 'POST',
      path: '/api/focus-terminal',
      headers,
      body: JSON.stringify({ sessionId: 'hook-live-1', tty: 'ttys004' }),
    });
    assert.equal(focusRes.status, 200);
    const focusBody = JSON.parse(focusRes.body);
    assert.equal(focusBody.ok, true);
    assert.equal(focusBody.tty, '/dev/ttys004');
    assert.equal(focusBody.target, 'iTerm2');
  } finally {
    await app.close();
  }
});
