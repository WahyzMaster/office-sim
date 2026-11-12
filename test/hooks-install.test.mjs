// W6 (launch readiness D13): the settings.json hook installer writes http hooks for PermissionRequest and Notification
// only, and the uninstaller also removes the curl command hooks older versions wrote. Every file is under os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as receiver from '../src/hooks-receiver.mjs';

const { HOOK_EVENTS, HOOK_MARKER, buildHookUrl, installClaudeHooks, uninstallClaudeHooks } = receiver;

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpSettings(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-hooks-install-'));
  dirs.push(dir);
  const settingsPath = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(settingsPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return settingsPath;
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// what versions before 0.12.0 wrote: one curl command per event, for thirteen events
const OLD_COMMAND = `curl -sS -m 1 -X POST -H "Content-Type: application/json" --data-binary @- "http://127.0.0.1:4317/api/hooks/claude" >/dev/null 2>&1 || true # ${HOOK_MARKER}`;
const OLD_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PreCompact',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'TeammateIdle', 'TaskCompleted'];
const oldInstall = () => Object.fromEntries(OLD_EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', command: OLD_COMMAND }] }]]));

test('D13: exactly PermissionRequest and Notification are registered', () => {
  assert.deepEqual([...HOOK_EVENTS], ['PermissionRequest', 'Notification']);
  assert.ok(Object.isFrozen(HOOK_EVENTS));
  assert.equal('buildHookCommand' in receiver, false, 'the curl command builder is gone');
});

test('buildHookUrl: a loopback URL on the hook path, with the marker in the query', () => {
  assert.equal(buildHookUrl(), `http://127.0.0.1:4747/api/hooks/claude?source=${HOOK_MARKER}`);
  assert.equal(buildHookUrl({ port: 4242, host: '::1' }), `http://[::1]:4242/api/hooks/claude?source=${HOOK_MARKER}`);
  for (const host of ['example.com', '0.0.0.0', '10.0.0.5', 'localhost.evil.test']) {
    assert.ok(buildHookUrl({ host }).startsWith('http://127.0.0.1:4747/'), `${host} is never written`);
  }
  for (const port of [0, -1, 70000, 4747.5, '4242', null]) assert.ok(buildHookUrl({ port }).includes(':4747/'), String(port));
  assert.equal(new URL(buildHookUrl()).pathname, '/api/hooks/claude');
});

test('install into a missing file: two http hooks, timeout 2, matcher permission_prompt on Notification', () => {
  const settingsPath = path.join(path.dirname(tmpSettings()), 'nested', 'settings.json');
  const res = installClaudeHooks({ settingsPath, port: 4242 });
  assert.deepEqual(res, { installed: true, settingsPath, events: 2 });
  const url = buildHookUrl({ port: 4242 });
  assert.deepEqual(read(settingsPath), {
    hooks: {
      PermissionRequest: [{ hooks: [{ type: 'http', url, timeout: 2 }] }],
      Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'http', url, timeout: 2 }] }],
    },
  });
  assert.equal(fs.existsSync(`${settingsPath}.office-sim.bak`), false, 'nothing to back up');
});

test('install merges: other settings, other events and other hooks stay; a second run changes nothing', () => {
  const mine = {
    theme: 'dark',
    permissions: { allow: ['Bash(npm test:*)'] },
    hooks: {
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo custom-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
    },
  };
  const settingsPath = tmpSettings(mine);
  const original = fs.readFileSync(settingsPath, 'utf8');
  installClaudeHooks({ settingsPath });
  const once = fs.readFileSync(settingsPath, 'utf8');
  const got = JSON.parse(once);
  assert.equal(got.theme, 'dark');
  assert.deepEqual(got.permissions, mine.permissions);
  assert.deepEqual(got.hooks.PreToolUse, mine.hooks.PreToolUse);
  assert.deepEqual(got.hooks.Notification[0], mine.hooks.Notification[0]);
  assert.deepEqual(got.hooks.Notification[1], { matcher: 'permission_prompt', hooks: [{ type: 'http', url: buildHookUrl(), timeout: 2 }] });
  assert.equal(got.hooks.PermissionRequest.length, 1);
  assert.equal(fs.readFileSync(`${settingsPath}.office-sim.bak`, 'utf8'), original, 'the one-time backup holds the file as it was');

  installClaudeHooks({ settingsPath });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), once, 'idempotent');
  installClaudeHooks({ settingsPath, port: 4242 });
  const moved = read(settingsPath);
  assert.equal(moved.hooks.Notification.length, 2, 'a new port replaces the entry instead of adding one');
  assert.equal(moved.hooks.PermissionRequest[0].hooks[0].url, buildHookUrl({ port: 4242 }));
  assert.equal(fs.readFileSync(`${settingsPath}.office-sim.bak`, 'utf8'), original, 'the backup is written once');
});

test('install over an older install: the thirteen curl hooks go, the two http hooks come', () => {
  const settingsPath = tmpSettings({ hooks: { ...oldInstall(), Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { hooks: [{ type: 'command', command: OLD_COMMAND }] }] } });
  installClaudeHooks({ settingsPath });
  const got = read(settingsPath);
  assert.deepEqual(Object.keys(got.hooks).sort(), ['Notification', 'PermissionRequest', 'Stop']);
  assert.deepEqual(got.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.equal(JSON.stringify(got).includes('curl'), false);
});

test('install refuses what it cannot merge, and leaves the file as it was', () => {
  for (const [content, re] of [
    ['{ not json', /unparseable/],
    ['[1, 2]', /non-object/],
    [JSON.stringify({ hooks: ['x'] }), /hooks field is not an object/],
    // a value that is no list under one of our two events: adding our entry would replace it, so it is refused too
    [JSON.stringify({ hooks: { PermissionRequest: 'x' } }), /settings\.json: hooks\.PermissionRequest is not an array$/],
    [JSON.stringify({ hooks: { PermissionRequest: [], Notification: { a: 1 } } }), /settings\.json: hooks\.Notification is not an array$/],
    [JSON.stringify({ theme: 'dark', hooks: { PermissionRequest: null } }), /hooks\.PermissionRequest is not an array$/],
    [JSON.stringify({ hooks: { Notification: 0 } }), /hooks\.Notification is not an array$/],
  ]) {
    const settingsPath = tmpSettings(content);
    assert.throws(() => installClaudeHooks({ settingsPath }), re);
    assert.throws(() => receiver.planClaudeHooks({ settingsPath }), re, 'the plan refuses the same file, so nothing is printed as a plan');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), content);
    assert.equal(fs.existsSync(`${settingsPath}.office-sim.bak`), false, 'and no backup is written');
  }
  assert.throws(() => installClaudeHooks({ settingsPath: '' }), TypeError);
});

test('a value that is no list under another event is not ours to judge: it stays exactly as it is', () => {
  const odd = { Stop: 'x', PreToolUse: { a: 1 }, SessionStart: null };
  const settingsPath = tmpSettings({ hooks: odd });
  installClaudeHooks({ settingsPath });
  const got = read(settingsPath).hooks;
  assert.deepEqual({ Stop: got.Stop, PreToolUse: got.PreToolUse, SessionStart: got.SessionStart }, odd);
  assert.deepEqual(Object.keys(got).sort(), ['Notification', 'PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(uninstallClaudeHooks({ settingsPath }).removedCount, 2);
  assert.deepEqual(read(settingsPath), { hooks: odd });
});

test('uninstall removes the http hooks and the older curl hooks, and only those', () => {
  const settingsPath = tmpSettings({
    theme: 'dark',
    hooks: {
      ...oldInstall(),
      Notification: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo custom-hook' }] },
        { hooks: [{ type: 'command', command: OLD_COMMAND }] },
      ],
      // one matcher group shared by a hook of the user's and one of ours: only ours goes
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }, { type: 'command', command: OLD_COMMAND }] }],
      UserPromptSubmit: [],
    },
  });
  installClaudeHooks({ settingsPath });
  const un = uninstallClaudeHooks({ settingsPath });
  assert.equal(un.removed, true);
  assert.equal(un.removedCount, 2, 'the two http hooks; the curl hooks went at install');
  assert.deepEqual(read(settingsPath), {
    theme: 'dark',
    hooks: {
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo custom-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
      UserPromptSubmit: [],
    },
  });

  const oldOnly = tmpSettings({ model: 'x', hooks: oldInstall() });
  assert.deepEqual(uninstallClaudeHooks({ settingsPath: oldOnly }), { removed: true, removedCount: 13, settingsPath: oldOnly });
  assert.deepEqual(read(oldOnly), { model: 'x' }, 'an emptied hooks object is removed');
});

test('uninstall with nothing of ours: no write; missing or unparseable files are handled', () => {
  const content = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}';
  const settingsPath = tmpSettings(content);
  assert.deepEqual(uninstallClaudeHooks({ settingsPath }), { removed: false, removedCount: 0, settingsPath });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), content, 'the file is not rewritten');
  const missing = path.join(path.dirname(settingsPath), 'none.json');
  assert.deepEqual(uninstallClaudeHooks({ settingsPath: missing }), { removed: false, removedCount: 0, settingsPath: missing });
  assert.equal(fs.existsSync(missing), false, 'nothing is created');
  const broken = tmpSettings('{ nope');
  assert.throws(() => uninstallClaudeHooks({ settingsPath: broken }), /unparseable/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ nope');
});
