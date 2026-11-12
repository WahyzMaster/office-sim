// W6 (launch readiness D13 to D16, D25): the Claude Code hook bridge, with a fake store and a fake clock
// (test/fixtures/hooks-bridge.mjs). Nothing here opens a socket or a real agent folder; the one test that needs a
// linked folder makes it under os.tmpdir(). Repeated bodies, the Notification fallback and sessions only hooks report
// are in test/hooks-bridge-repeat.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { HOOK_MAX_BODY } from '../src/hooks-bridge.mjs';
import { ROOT, SID, SUB, T0, CLAUDE, WAIT_KEYS, OK, setup, permission, notification } from './fixtures/hooks-bridge.mjs';

test('the hook body limit is 1 MiB (D16)', () => {
  assert.equal(HOOK_MAX_BODY, 1024 * 1024);
});

test('immediate match: a PermissionRequest marks the open tool of that name, with exactly the Grok fields (D25)', () => {
  const { bridge, start, waits, events, clock } = setup();
  start('toolu_1');
  clock.ms += 400;
  assert.deepEqual(bridge.handle(permission()), OK);
  assert.equal(waits().length, 1);
  const [w] = waits();
  assert.deepEqual(Object.keys(w).sort(), WAIT_KEYS);
  assert.deepEqual(w, { type: 'tool_wait', sessionId: SID, ts: new Date(T0 + 400).toISOString(), toolUseId: 'toolu_1', waiting: true });
  assert.equal(events.indexOf(w), events.length - 1);
  assert.equal(bridge.stats().waits, 1);
});

test('the newest open tool of that name without a wait is chosen; a prompt with nothing left to mark is a no-op', () => {
  const { bridge, start, waits, clock } = setup();
  start('toolu_old');
  start('toolu_new');
  start('toolu_read', 'Read'); // newer, but another name
  bridge.handle(permission());
  assert.deepEqual(waits().map((w) => w.toolUseId), ['toolu_new']);
  clock.ms += 2000; // a second prompt: the same body within 1 s would be a repeat of the first (hooks-bridge-repeat)
  bridge.handle(permission());
  assert.deepEqual(waits().map((w) => w.toolUseId), ['toolu_new', 'toolu_old'], 'at most one waiting:true per toolUseId');
  clock.ms += 2000;
  bridge.handle(permission());
  assert.equal(waits().length, 2, 'every Bash already waits: nothing new, nothing held');
  assert.deepEqual([bridge.stats().held, bridge.stats().unmatched, bridge.stats().duplicates], [0, 1, 0]);
});

test('the tool name is compared as it is on the wire (a connector uuid in an mcp name is masked)', () => {
  const { bridge, start, waits } = setup();
  start('toolu_m', 'mcp__00000000-0000-0000-0000-000000000000__get_issue');
  bridge.handle(permission({ tool_name: 'mcp__5f3c1a2b-7d4e-4c1a-9b2e-1a2b3c4d5e6f__get_issue' }));
  assert.deepEqual(waits().map((w) => w.toolUseId), ['toolu_m']);
});

test('a PermissionRequest without a usable tool_name marks nothing and holds nothing (no name, no match)', () => {
  const { bridge, start, waits } = setup();
  start('toolu_1');
  for (const tool_name of [undefined, '', 7, 'x'.repeat(201), { name: 'Bash' }]) assert.deepEqual(bridge.handle(permission({ tool_name })), OK);
  assert.deepEqual([waits().length, bridge.stats().held, bridge.stats().ignored], [0, 0, 5]);
});

test('only Claude Code characters are tracked: a tool of another adapter is never the target', () => {
  const { bridge, store, waits } = setup({ chars: { [SID]: { agent: CLAUDE, sid: SID, kind: 'main' }, 'grok-s1': { agent: 'grok', sid: SID, kind: 'sub' } } });
  store.push({ type: 'tool_start', sessionId: 'grok-s1', ts: new Date(T0).toISOString(), toolUseId: 'g1', tool: 'Bash', summary: 'Bash' });
  bridge.handle(permission({ agent_id: 'grok-s1' }));
  bridge.handle(permission());
  assert.equal(waits().length, 0);
  assert.equal(bridge.open.has('grok-s1'), false);
});

test('held then matched: the hook arrives before the tailer saw the tool_use; tool_wait follows the tool_start at once', () => {
  const { bridge, start, waits, events, clock } = setup();
  assert.deepEqual(bridge.handle(permission({ tool_name: 'Edit' })), OK);
  assert.equal(waits().length, 0);
  assert.equal(bridge.stats().held, 1);
  clock.ms += 300;
  start('toolu_other', 'Read');
  assert.equal(waits().length, 0, 'another tool name does not take the held wait');
  start('toolu_e', 'Edit');
  assert.deepEqual(events.slice(-2).map((e) => [e.type, e.toolUseId]), [['tool_start', 'toolu_e'], ['tool_wait', 'toolu_e']]);
  assert.equal(waits()[0].ts, new Date(T0).toISOString(), 'ts is the time the hook arrived');
  assert.equal(bridge.stats().held, 0);
});

test('held then expired: a tool_start after the time to live gets no wait', () => {
  const { bridge, start, waits, clock } = setup({ holdMs: 10_000 });
  bridge.handle(permission({ tool_name: 'Edit' }));
  clock.ms += 10_001;
  start('toolu_late', 'Edit');
  assert.equal(waits().length, 0);
  assert.deepEqual([bridge.stats().held, bridge.stats().expired], [0, 1]);
});

test('at most 64 waits are held: the oldest ones are dropped first', () => {
  const { bridge, start, waits } = setup();
  for (let i = 0; i < 70; i += 1) bridge.handle(permission({ tool_name: `Tool${i}` }));
  assert.equal(bridge.stats().held, 64);
  assert.equal(bridge.stats().dropped, 6);
  for (let i = 0; i < 70; i += 1) start(`toolu_${i}`, `Tool${i}`);
  assert.deepEqual(waits().map((w) => w.toolUseId), Array.from({ length: 64 }, (_, i) => `toolu_${i + 6}`));
});

test('an ask-type tool is never chosen, by a PermissionRequest or by a Notification', () => {
  const { bridge, start, waits } = setup();
  start('toolu_ask', 'AskUserQuestion', { question: 'Which one?', options: ['A', 'B'] });
  start('toolu_plan', 'ExitPlanMode', { question: 'Proceed?', options: ['Yes', 'No'] });
  bridge.handle(permission({ tool_name: 'ExitPlanMode' }));
  bridge.handle(permission({ tool_name: 'AskUserQuestion' }));
  assert.deepEqual([waits().length, bridge.stats().held], [0, 0], 'an ask tool is neither marked nor held');
  bridge.handle(notification());
  assert.deepEqual([waits().length, bridge.stats().held], [0, 0], 'the open ask already shows the prompt');
  bridge.handle(permission({ tool_name: 'Bash' }));
  start('toolu_ask2', 'Bash', { question: 'An ask under another name', options: [] });
  assert.equal(waits().length, 0, 'a held wait does not go to a tool_start with ask fields');
  start('toolu_b', 'Bash');
  assert.deepEqual(waits().map((w) => w.toolUseId), ['toolu_b']);
});

test('a later Notification for the same prompt is a no-op once the wait was sent, also when it was held first', () => {
  const { bridge, start, waits } = setup();
  start('toolu_1');
  start('toolu_2', 'Read');
  bridge.handle(permission());
  assert.deepEqual(bridge.handle(notification()), OK);
  assert.deepEqual(waits().map((w) => w.toolUseId), ['toolu_1'], 'the open Read is not marked by the Notification');
  assert.equal(bridge.stats().duplicates, 1);
  const held = setup();
  held.start('toolu_r', 'Read');
  held.bridge.handle(permission({ tool_name: 'Edit' }));
  held.clock.ms += 250;
  held.start('toolu_e', 'Edit'); // the tailer read the tool_use line: the held wait is sent
  held.clock.ms += 6000;
  held.bridge.handle(notification());
  assert.deepEqual(held.waits().map((w) => w.toolUseId), ['toolu_e'], 'the open Read is not marked by the Notification');
});

test('a Notification without an earlier wait marks the newest open non-ask tool and is never held', () => {
  const { bridge, start, waits } = setup();
  assert.deepEqual(bridge.handle(notification()), OK);
  assert.equal(bridge.stats().held, 0, 'no open tool: dropped, not held');
  start('toolu_1', 'Read');
  start('toolu_2', 'Bash');
  assert.equal(waits().length, 0);
  bridge.handle(notification());
  assert.deepEqual(waits().map((w) => [w.toolUseId, Object.keys(w).sort().join()]), [['toolu_2', WAIT_KEYS.join()]]);
  bridge.handle(notification({ notification_type: 'idle_prompt', message: 'waiting for permission to continue' }));
  assert.equal(waits().length, 1, 'only notification_type permission_prompt counts');
});

test('D15: a transcript_path outside the configured Claude root is ignored and counted', () => {
  const { bridge, start, waits, events } = setup();
  start('toolu_1');
  const before = events.length;
  for (const p of [
    path.join(os.tmpdir(), 'office-sim-hooks-unit', 'other-agent', 'sessions', 'x.jsonl'),
    path.join(ROOT, '..', 'elsewhere', `${SID}.jsonl`),
    `${ROOT}-evil/x.jsonl`,
    ROOT,
    '',
  ]) assert.deepEqual(bridge.handle(permission({ transcript_path: p })), OK, p);
  assert.equal(events.length, before);
  assert.equal(bridge.stats().foreign, 5);
  bridge.handle(permission({ transcript_path: undefined }));
  assert.equal(waits().length, 1, 'no transcript_path: accepted');
});

test('D15: a Claude root reached through a link is also known by its real spelling, looked up only when a path fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-hooks-link-'));
  try {
    fs.mkdirSync(path.join(dir, 'real', 'projects'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
    const linked = path.join(dir, 'link', 'projects');
    const real = fs.realpathSync(linked);
    assert.notEqual(real, linked);
    const { bridge, start, waits, clock } = setup({ claudeRoot: linked });
    start('toolu_1');
    start('toolu_2');
    assert.equal(bridge.realRoot, undefined, 'the root folder is not touched when the bridge is made');
    bridge.handle(permission({ transcript_path: path.join(linked, '-w', `${SID}.jsonl`) }));
    assert.deepEqual([waits().length, bridge.realRoot], [1, undefined], 'a path inside the root as given needs no lookup');
    clock.ms += 2000; // a second prompt, not a repeat
    bridge.handle(permission({ transcript_path: path.join(real, '-w', `${SID}.jsonl`) }));
    assert.deepEqual([waits().length, bridge.realRoot, bridge.stats().foreign], [2, real, 0]);
    bridge.handle(permission({ transcript_path: path.join(dir, 'real', 'elsewhere', `${SID}.jsonl`) }));
    assert.equal(bridge.stats().foreign, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent: agent_id names the character; its open tool is marked, not the parent\'s', () => {
  const { bridge, store, waits } = setup({ chars: {
    [SID]: { agent: CLAUDE, sid: SID, kind: 'main' }, [SUB]: { agent: CLAUDE, sid: SID, kind: 'sub' },
  } });
  const ts = new Date(T0).toISOString();
  store.push({ type: 'tool_start', sessionId: SID, ts, toolUseId: 'toolu_parent', tool: 'Bash', summary: 'Bash' });
  store.push({ type: 'tool_start', sessionId: SUB, ts, toolUseId: 'toolu_sub', tool: 'Bash', summary: 'Bash' });
  bridge.handle(permission({ agent_id: SUB, agent_type: 'Explore' }));
  assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SUB, 'toolu_sub']]);
  bridge.handle(permission());
  assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SUB, 'toolu_sub'], [SID, 'toolu_parent']]);
});

test('subagent not known to the store: the parent\'s matching open tool, else held for the subagent only', () => {
  const fallback = setup();
  fallback.start('toolu_parent');
  fallback.bridge.handle(permission({ agent_id: SUB }));
  assert.deepEqual(fallback.waits().map((w) => [w.sessionId, w.toolUseId]), [[SID, 'toolu_parent']]);

  const { bridge, store, start, waits } = setup();
  start('toolu_agent', 'Agent');
  bridge.handle(permission({ agent_id: SUB }));
  assert.deepEqual([waits().length, bridge.stats().held], [0, 1]);
  start('toolu_parent_late'); // the parent's own later Bash is not the prompt of the subagent
  assert.equal(waits().length, 0);
  store.byChar.set(SUB, { agent: CLAUDE, sid: SID, kind: 'sub' }); // the next rescan attaches the subagent file
  store.push({ type: 'tool_start', sessionId: SUB, ts: new Date(T0).toISOString(), toolUseId: 'toolu_sub', tool: 'Bash', summary: 'Bash' });
  assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SUB, 'toolu_sub']]);

  const other = setup({ chars: {
    [SID]: { agent: CLAUDE, sid: SID, kind: 'main' }, [SUB]: { agent: CLAUDE, sid: 'ffffffff-1111-4222-8333-444455556666', kind: 'sub' },
  } });
  other.store.push({ type: 'tool_start', sessionId: SUB, ts: new Date(T0).toISOString(), toolUseId: 'toolu_x', tool: 'Bash', summary: 'Bash' });
  other.bridge.handle(permission({ agent_id: SUB }));
  assert.equal(other.waits().length, 0, 'a character of another session is not this session\'s subagent');
});

test('tool_end and session_end drop the tracked wait; decorate() inserts the open one right after its tool_start', () => {
  const { bridge, store, start, end, waits, clock } = setup();
  start('toolu_a');
  start('toolu_b', 'Read');
  bridge.handle(permission());
  const session = { type: 'session', sessionId: SID, ts: new Date(T0).toISOString() };
  const a = { type: 'tool_start', sessionId: SID, ts: session.ts, toolUseId: 'toolu_a', tool: 'Bash', summary: 'Bash' };
  const b = { ...a, toolUseId: 'toolu_b', tool: 'Read' };
  const snap = [session, a, b];
  const out = bridge.decorate(snap);
  assert.deepEqual(out, [session, a, waits()[0], b]);
  assert.notEqual(out[2], waits()[0], 'a copy, not the live object');
  assert.equal(JSON.stringify(out[2]), JSON.stringify(waits()[0]), 'JSON-identical to the live event');
  assert.deepEqual(snap, [session, a, b], 'the snapshot array itself is not changed');
  assert.deepEqual(bridge.decorate([session, b]), [session, b], 'a wait whose tool is not in the snapshot adds nothing');
  end('toolu_a');
  assert.deepEqual(bridge.decorate(snap), snap);
  assert.equal(bridge.stats().openWaits, 0);
  end('toolu_b');
  assert.equal(bridge.open.size, 0, 'a character without open tools takes no room');

  clock.ms += 2000; // the next prompt
  start('toolu_c');
  bridge.handle(permission());
  assert.equal(bridge.stats().openWaits, 1);
  store.push({ type: 'session_end', sessionId: SID, ts: session.ts, reason: 'done' });
  assert.equal(bridge.stats().openWaits, 0);
  start('toolu_d');
  bridge.handle(notification());
  assert.equal(waits().length, 3, 'after the session ended, the old wait no longer blocks a new prompt');
});

test('an open tool keeps its snapshot copy through prompt and turn_end (the /state rule of the Grok wait) and gets one true only', () => {
  for (const between of ['prompt', 'turn_end', 'thinking']) {
    const { bridge, store, start, end, waits } = setup();
    start('toolu_a');
    bridge.handle(permission());
    const a = { type: 'tool_start', sessionId: SID, ts: new Date(T0).toISOString(), toolUseId: 'toolu_a', tool: 'Bash', summary: 'Bash' };
    store.push({ type: between, sessionId: SID, ts: a.ts });
    assert.deepEqual(bridge.decorate([a]), [a, waits()[0]], `${between}: the tool is open and its last tool_wait is true`);
    bridge.handle(permission());
    bridge.handle(notification());
    assert.equal(waits().length, 1, 'the open tool had its one waiting:true');
    assert.equal(bridge.stats().held, 0);
    end('toolu_a');
    assert.deepEqual(bridge.decorate([a]), [a]);
  }
});

test('D14: for a session the store follows, every other hook event is dropped; an unknown session keeps the old events', () => {
  const followed = setup();
  for (const hook_event_name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd']) {
    assert.deepEqual(followed.bridge.handle({ session_id: SID, hook_event_name, tool_name: 'Write', tool_input: { file_path: '/w/x.mjs' }, cwd: '/w' }), OK);
  }
  assert.equal(followed.events.length, 0);
  assert.equal(followed.bridge.stats().ignored, 6);

  const { bridge, events } = setup({ chars: {} });
  const hook = (hook_event_name, extra = {}) => bridge.handle({ session_id: 'hook-only-1', hook_event_name, cwd: '/Users/dev/project', ...extra });
  assert.deepEqual(hook('SessionStart'), OK);
  assert.deepEqual(hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/Users/dev/project/index.mjs' } }), OK);
  assert.deepEqual(events.map((e) => e.type), ['session', 'tool_start']);
  assert.equal(events[1].summary, 'index.mjs');
  assert.deepEqual(hook('PermissionRequest', { tool_name: 'Write', tool_input: { content: 'x' } }), OK);
  assert.deepEqual(events[2], { type: 'tool_wait', sessionId: 'hook-only-1', ts: events[2].ts, toolUseId: events[1].toolUseId, waiting: true });
  hook('PostToolUse', { tool_name: 'Write' });
  hook('Stop');
  assert.deepEqual(events.slice(3).map((e) => e.type), ['tool_end', 'turn_end']);
  assert.equal(bridge.stats().openWaits, 0);
});

test('another adapter\'s character id is never driven by a Claude hook', () => {
  const { bridge, store, waits, events } = setup({ chars: { 'grok-m1': { agent: 'grok', sid: 'grok-m1', kind: 'main' } } });
  store.push({ type: 'tool_start', sessionId: 'grok-m1', ts: new Date(T0).toISOString(), toolUseId: 't1', tool: 'Bash', summary: 'Bash' });
  bridge.handle(permission({ session_id: 'grok-m1', transcript_path: undefined }));
  bridge.handle({ session_id: 'grok-m1', hook_event_name: 'Stop' });
  assert.deepEqual([waits().length, events.length, bridge.stats().foreign], [0, 1, 2]);
});

test('D16: 400 only without a usable session id; everything else answers 200 {}', () => {
  const { bridge } = setup();
  for (const bad of [null, [], 'text', 7, {}, { session_id: '' }, { session_id: 12 }, { session_id: '../etc', hook_event_name: 'Stop' }]) {
    const res = bridge.handle(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(Object.keys(res.body), ['error']);
  }
  for (const fine of [{ session_id: SID }, { session_id: SID, hook_event_name: 'NoSuchEvent' }, { session_id: SID, hook_event_name: 7 }]) {
    assert.deepEqual(bridge.handle(fine), OK);
  }
});

test('D16: nothing of the raw body is kept: no tool_input, message, cwd or path, in events, snapshots or the bridge itself', () => {
  const BAIT = ['RAW_COMMAND_BAIT', 'RAW_MESSAGE_BAIT', 'RAW_CWD_BAIT', 'RAW_PATH_BAIT', 'RAW_EXTRA_BAIT', 'RAW_MODE_BAIT'];
  const { bridge, start, events } = setup();
  const body = (extra) => permission({
    tool_input: { command: 'echo RAW_COMMAND_BAIT', description: 'RAW_COMMAND_BAIT' }, cwd: '/work/RAW_CWD_BAIT',
    transcript_path: path.join(ROOT, 'RAW_PATH_BAIT', `${SID}.jsonl`), permission_mode: 'RAW_MODE_BAIT',
    permission_suggestions: [{ type: 'RAW_EXTRA_BAIT' }], message: 'RAW_MESSAGE_BAIT', ...extra,
  });
  start('toolu_1');
  bridge.handle(body());                       // matched at once
  bridge.handle(body({ tool_name: 'Edit' }));  // held
  bridge.handle(notification({ message: 'RAW_MESSAGE_BAIT', title: 'RAW_EXTRA_BAIT', cwd: '/work/RAW_CWD_BAIT' }));
  assert.equal(bridge.stats().held, 1);
  const seen = [
    JSON.stringify(events), JSON.stringify(bridge.decorate(events)), JSON.stringify(bridge.stats()),
    util.inspect(bridge, { depth: 12, maxArrayLength: null, maxStringLength: null, showHidden: true }),
  ].join('\n');
  for (const bait of BAIT) assert.equal(seen.includes(bait), false, bait);
});
