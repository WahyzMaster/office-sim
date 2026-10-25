import '../scripts/fake-root-guard.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  APPLESCRIPT_NOTIFY,
  WIN_TOAST_SCRIPT,
  NOTIFY_CATEGORIES,
  DEFAULT_NOTIFY_CATEGORIES,
  parseNotifyArg,
  dispatchNativeNotification,
  SystemNotifier,
} from '../src/system-notify.mjs';
import { parseArgs } from '../src/cli-args.mjs';
import { focusTerminalForSession, WIN_FOCUS_SCRIPT } from '../src/terminal-focus.mjs';
import { start } from '../src/server.mjs';
import {
  shouldDispatchBrowserNotification,
  classifyBrowserNotifyEvent,
  installSystemNotifications,
} from '../public/js/system-notify.js';

const SID_MAIN = '11111111-1111-4111-8111-111111111111';
const SID_SUB = '22222222-2222-4222-8222-222222222222';

describe('System Notifications — CLI & Argument Parsing', () => {
  it('defaults to disabled with ask,error,done categories', () => {
    assert.deepEqual(parseNotifyArg(undefined), { enabled: false, categories: ['ask', 'error', 'done'] });
    assert.deepEqual(parseNotifyArg(true), { enabled: true, categories: ['ask', 'error', 'done'] });
    assert.deepEqual(parseNotifyArg('all'), { enabled: true, categories: [...NOTIFY_CATEGORIES] });
    assert.deepEqual(parseNotifyArg('ask,tool_error'), { enabled: true, categories: ['ask', 'tool_error'] });
    assert.deepEqual(parseNotifyArg('off'), { enabled: false, categories: [...DEFAULT_NOTIFY_CATEGORIES] });
  });

  it('parses --notify and --notify=<categories> in CLI args without eating following flags', () => {
    assert.deepEqual(parseArgs(['--notify']), { notify: true, notifyCategories: ['ask', 'error', 'done'] });
    assert.deepEqual(parseArgs(['--notify', '--port', '4318']), {
      notify: true,
      notifyCategories: ['ask', 'error', 'done'],
      port: 4318,
    });
    assert.deepEqual(parseArgs(['--notify=ask,error']), { notify: true, notifyCategories: ['ask', 'error'] });
    assert.deepEqual(parseArgs(['--notify', 'ask,done,tool_error']), {
      notify: true,
      notifyCategories: ['ask', 'done', 'tool_error'],
    });
    assert.throws(() => parseArgs(['--notify=bogus']), /unknown notify category/);
  });
});

describe('System Notifications — Zero-Injection Native Dispatch (macOS & Windows)', () => {
  it('dispatches macOS notification via /usr/bin/osascript positional argv without interpolation', async () => {
    const calls = [];
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null, 'ok:osascript\n');
    };
    const malicious = 'Deploy "prod"? $(rm -rf /) `id`\n\tline2';
    const res = await dispatchNativeNotification(
      { title: 'Office Sim · Input Needed', subtitle: 'Claude · office-sim', body: malicious, sound: 'Submarine' },
      { platform: 'darwin', execFileFn: fakeExec },
    );
    assert.equal(res.ok, true);
    assert.equal(res.platform, 'darwin');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, '/usr/bin/osascript');
    assert.deepEqual(calls[0].args, [
      '-e',
      APPLESCRIPT_NOTIFY,
      '--',
      'Deploy "prod"? $(rm -rf /) `id` line2',
      'Office Sim · Input Needed',
      'Claude · office-sim',
      'Submarine',
    ]);
  });

  it('dispatches Windows Toast notification via powershell.exe environment variables and CreateTextNode', async () => {
    const calls = [];
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null, 'ok:winrt\n');
    };
    const maliciousXml = '<script>alert(1)</script> & "$env:USERNAME"';
    const res = await dispatchNativeNotification(
      { title: 'Office Sim · Agent Error', subtitle: 'Codex · repo', body: maliciousXml },
      { platform: 'win32', execFileFn: fakeExec },
    );
    assert.equal(res.ok, true);
    assert.equal(res.platform, 'win32');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.deepEqual(calls[0].args, [
      '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', WIN_TOAST_SCRIPT,
    ]);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.env.OFFICE_SIM_NOTIFY_TITLE, 'Office Sim · Agent Error');
    assert.equal(calls[0].opts.env.OFFICE_SIM_NOTIFY_SUB, 'Codex · repo');
    assert.equal(calls[0].opts.env.OFFICE_SIM_NOTIFY_BODY, maliciousXml);
    assert.ok(WIN_TOAST_SCRIPT.includes('CreateTextNode'));
  });

  it('returns unsupported_platform cleanly on Linux without throwing', async () => {
    const res = await dispatchNativeNotification(
      { title: 'Test', body: 'Body' },
      { platform: 'linux', execFileFn: () => { throw new Error('should not run'); } },
    );
    assert.deepEqual(res, { ok: false, platform: 'linux', error: 'unsupported_platform' });
  });
});

describe('System Notifications — Decision 2 Anti-Noise Rules & Event Classification', () => {
  it('Rule 1: ignores routine mid-turn tool_end failures by default, but fires when tool_error is opted in', () => {
    let clock = 10_000;
    const sent = [];
    const notifier = new SystemNotifier({
      enabled: true,
      categories: ['ask', 'error', 'done'],
      platform: 'darwin',
      now: () => clock,
      execFileFn: (_cmd, _args, _opts, cb) => cb(null, 'ok'),
      onNotify: (item) => sent.push(item),
    });

    notifier.observeEvent({
      type: 'session',
      sessionId: SID_MAIN,
      agent: 'grok',
      title: 'Grok Worker',
      project: '/Users/someone/secret/office-sim',
    });

    notifier.observeEvent({
      type: 'tool_end',
      sessionId: SID_MAIN,
      toolUseId: 'tu-grep',
      tool: 'Bash',
      summary: 'grep -rn foo src/',
      ok: false,
      errorKind: 'failed',
    });
    assert.equal(sent.length, 0);

    notifier.configure({ categories: ['ask', 'error', 'done', 'tool_error'] });
    clock += 5000;
    notifier.observeEvent({
      type: 'tool_end',
      sessionId: SID_MAIN,
      toolUseId: 'tu-test',
      tool: 'Bash',
      summary: 'npm test',
      ok: false,
      errorKind: 'failed',
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].category, 'tool_error');
    assert.equal(sent[0].subtitle, 'Grok Worker · office-sim');
    assert.ok(!sent[0].subtitle.includes('/Users/someone'), 'never leaks full path');
  });

  it('Rule 1b: coalesces repeated system api_error retries within 15s window', () => {
    let clock = 20_000;
    const sent = [];
    const notifier = new SystemNotifier({
      enabled: true,
      categories: ['ask', 'error', 'done'],
      platform: 'darwin',
      now: () => clock,
      execFileFn: (_cmd, _args, _opts, cb) => cb(null, 'ok'),
      onNotify: (item) => sent.push(item),
    });

    notifier.observeEvent({ type: 'session', sessionId: SID_MAIN, title: 'Claude', projectLabel: 'office-sim' });
    notifier.observeEvent({ type: 'system', sessionId: SID_MAIN, kind: 'api_error', text: '529 Overloaded (attempt 1)' });
    assert.equal(sent.length, 1);

    clock += 6000;
    notifier.observeEvent({ type: 'system', sessionId: SID_MAIN, kind: 'api_error', text: '529 Overloaded (attempt 2)' });
    assert.equal(sent.length, 1, 'coalesced retry within 15s');

    clock += 10_000;
    notifier.observeEvent({ type: 'system', sessionId: SID_MAIN, kind: 'api_error', text: '529 Overloaded (attempt 3)' });
    assert.equal(sent.length, 2);
  });

  it('Rule 2 & 3: deduplicates dual turn_end (Stop hook + 20s idle timer) and ignores next_turn / interrupt / subagents', () => {
    let clock = 50_000;
    const sent = [];
    const notifier = new SystemNotifier({
      enabled: true,
      categories: ['ask', 'error', 'done'],
      platform: 'darwin',
      now: () => clock,
      execFileFn: (_cmd, _args, _opts, cb) => cb(null, 'ok'),
      onNotify: (item) => sent.push(item),
    });

    notifier.observeEvent({ type: 'session', sessionId: SID_MAIN, title: 'Main Agent', projectLabel: 'office-sim' });
    notifier.observeEvent({
      type: 'session', sessionId: SID_SUB, title: 'Sub Agent', projectLabel: 'office-sim', isSubagent: true, parentSessionId: SID_MAIN,
    });

    notifier.observeEvent({ type: 'turn_end', sessionId: SID_SUB, reason: 'end_turn' });
    notifier.observeEvent({ type: 'turn_end', sessionId: SID_MAIN, reason: 'next_turn' });
    notifier.observeEvent({ type: 'turn_end', sessionId: SID_MAIN, reason: 'interrupt' });
    assert.equal(sent.length, 0);

    notifier.observeEvent({ type: 'turn_end', sessionId: SID_MAIN });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].category, 'done');

    clock += 20_000;
    notifier.observeEvent({ type: 'turn_end', sessionId: SID_MAIN, reason: 'end_turn' });
    assert.equal(sent.length, 1, 'turnNotified latch suppresses duplicate 20s idle turn_end');

    clock += 5000;
    notifier.observeEvent({ type: 'prompt', sessionId: SID_MAIN, text: 'Next task' });
    clock += 5000;
    notifier.observeEvent({ type: 'turn_end', sessionId: SID_MAIN, reason: 'end_turn' });
    assert.equal(sent.length, 2, 'fires again after a new prompt');
  });

  it('Rule 4 & 5: enriches Grok tool_wait from cached tool_start and excludes Codex request_user_input_async', () => {
    let clock = 90_000;
    const sent = [];
    const notifier = new SystemNotifier({
      enabled: true,
      categories: ['ask', 'error', 'done'],
      platform: 'darwin',
      now: () => clock,
      execFileFn: (_cmd, _args, _opts, cb) => cb(null, 'ok'),
      onNotify: (item) => sent.push(item),
    });

    notifier.observeEvent({ type: 'session', sessionId: SID_MAIN, title: 'Codex', projectLabel: 'office-sim' });
    notifier.observeEvent({
      type: 'tool_start', sessionId: SID_MAIN, toolUseId: 'tu-async', tool: 'request_user_input_async', room: 'desk', summary: 'Async check',
    });
    assert.equal(sent.length, 0);

    notifier.observeEvent({
      type: 'tool_start', sessionId: SID_MAIN, toolUseId: 'tu-ask', tool: 'AskUserQuestion', summary: 'Which database should we target?',
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].category, 'ask');
    assert.equal(sent[0].body, 'Which database should we target?');

    clock += 5000;
    notifier.observeEvent({
      type: 'tool_start', sessionId: SID_MAIN, toolUseId: 'tu-grok-1', tool: 'run_terminal_command', room: 'server', summary: 'git push origin master',
    });
    assert.equal(sent.length, 1);

    notifier.observeEvent({ type: 'tool_wait', sessionId: SID_MAIN, toolUseId: 'tu-grok-1', waiting: true });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].category, 'ask');
    assert.equal(sent[1].body, 'git push origin master');
  });
});

describe('System Notifications — Decision 3 Windows Terminal Focus & HTTP /api/notify', () => {
  it('focuses Windows terminal / IDE window by project title via PowerShell WScript.Shell AppActivate', async () => {
    const calls = [];
    const fakeStore = {
      byChar: new Map([[SID_MAIN, { path: 'C:\\tmp\\s.jsonl', lastSession: { projectLabel: 'office-sim' } }]]),
    };
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null, 'matched:WindowsTerminal\r\n');
    };
    const res = await focusTerminalForSession(SID_MAIN, { store: fakeStore, platform: 'win32', execFileFn: fakeExec });
    assert.equal(res.ok, true);
    assert.equal(res.method, 'window-title');
    assert.equal(res.target, 'WindowsTerminal');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.ok(calls[0].args.includes(WIN_FOCUS_SCRIPT));
    assert.equal(calls[0].opts.env.OFFICE_SIM_TARGET_PROJECT, 'office-sim');
  });

  it('serves GET and POST /api/notify on localhost and enforces same-origin protection', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-notify-test-'));
    const nativeCalls = [];
    const srv = await start({
      port: 0,
      host: '127.0.0.1',
      root: tmpDir,
      agents: ['claude-code'],
      notifyOpts: {
        platform: 'darwin',
        execFileFn: (cmd, args, _opts, cb) => {
          nativeCalls.push({ cmd, args });
          cb(null, 'ok:osascript');
        },
      },
    });

    try {
      await srv.ready;
      const baseUrl = `http://127.0.0.1:${srv.port}`;

      const getRes = await fetch(`${baseUrl}/api/notify`);
      assert.equal(getRes.status, 200);
      const status0 = await getRes.json();
      assert.equal(status0.enabled, false);
      assert.equal(status0.supported, true);

      const badRes = await fetch(`${baseUrl}/api/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(badRes.status, 403);

      const postRes = await fetch(`${baseUrl}/api/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, categories: ['ask', 'error', 'done'], test: true }),
      });
      assert.equal(postRes.status, 200);
      const status1 = await postRes.json();
      assert.equal(status1.enabled, true);
      assert.equal(nativeCalls.length, 1);

      srv.store.push({
        type: 'session', sessionId: SID_MAIN, agent: 'claude-code', title: 'Claude Dev', projectLabel: 'office-sim', ts: new Date().toISOString(),
      });
      srv.store.push({
        type: 'tool_start', sessionId: SID_MAIN, toolUseId: 'tu-live-1', tool: 'AskUserQuestion', question: 'Approve deployment?', ts: new Date().toISOString(),
      });
      assert.equal(nativeCalls.length, 2);
      assert.ok(nativeCalls[1].args.includes('Approve deployment?'));
    } finally {
      await srv.close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('System Notifications — Browser Fallback & HUD Toggle (public/js/system-notify.js)', () => {
  it('only dispatches browser Notification when enabled, granted, hidden, and not already handled by server native', () => {
    assert.equal(
      shouldDispatchBrowserNotification({
        enabled: true, permission: 'granted', docHidden: true, serverNativeSupported: true, serverNativeEnabled: true,
      }),
      false,
    );
    assert.equal(
      shouldDispatchBrowserNotification({
        enabled: true, permission: 'granted', docHidden: true, serverNativeSupported: false, serverNativeEnabled: false,
      }),
      true,
    );
  });

  it('classifies browser events in KO and EN and wires HUD #notify-toggle + shortcut N', async () => {
    const koAsk = classifyBrowserNotifyEvent(
      { type: 'tool_start', sessionId: SID_MAIN, tool: 'AskUserQuestion', question: '진행할까요?' },
      { name: '클로드', floor: { label: 'office-sim' } },
      'ko',
    );
    assert.equal(koAsk.category, 'ask');
    assert.equal(koAsk.title, '클로드 (office-sim) · 응답 대기');

    const enDone = classifyBrowserNotifyEvent(
      { type: 'turn_end', sessionId: SID_MAIN, reason: 'end_turn', text: 'All tests pass' },
      { name: 'Claude', floor: { label: 'office-sim' } },
      'en',
    );
    assert.equal(enDone.category, 'done');
    assert.equal(enDone.title, 'Claude (office-sim) · Turn Complete');

    const storeMap = new Map();
    const fakeStorage = { getItem: (k) => storeMap.get(k) ?? null, setItem: (k, v) => storeMap.set(k, v) };
    const posted = [];
    const fakeBtn = {
      id: '', type: '', className: '', textContent: '', title: '', attrs: {}, listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
    };
    const fakeControls = { children: [], appendChild(el) { this.children.push(el); }, insertBefore(el) { this.children.push(el); } };
    const keyListeners = [];
    const fakeDoc = {
      hidden: true,
      getElementById: () => null,
      querySelector: (sel) => (sel === '.bar .controls' ? fakeControls : null),
      createElement: () => fakeBtn,
    };
    const fakeWin = {
      localStorage: fakeStorage,
      Notification: { permission: 'granted', requestPermission: async () => 'granted' },
      addEventListener: (ev, fn) => { if (ev === 'keydown') keyListeners.push(fn); },
    };
    const fakeFetch = async (_url, opts) => {
      if (opts?.method === 'POST') posted.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, enabled: posted.at(-1)?.enabled ?? false, supported: true }) };
    };
    const ctrl = installSystemNotifications({
      office: { onEvent() {} }, hud: { lang: 'en' }, doc: fakeDoc, win: fakeWin, fetchFn: fakeFetch,
    });

    assert.equal(ctrl.enabled, false);
    assert.equal(fakeBtn.textContent, 'Notify Off');

    keyListeners[0]({ key: 'n', target: {}, preventDefault() {} });
    assert.equal(ctrl.enabled, true);
    assert.equal(fakeBtn.textContent, 'Notify On');
    assert.equal(JSON.parse(storeMap.get('office-sim:v1')).notify, true);
    assert.equal(posted.at(-1).enabled, true);
    assert.equal(posted.at(-1).test, true);
  });
});
