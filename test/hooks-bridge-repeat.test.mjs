// W6 repair round (launch readiness D13 to D16): what the hook bridge does with a body that arrives twice, with a
// Notification while a request is still held, with a session only hooks report (D14), with held waits nobody asks
// about again, and with a transcript_path that is spelled another way than the Claude root (D15).
// Fake store and fake clock (test/fixtures/hooks-bridge.mjs); the folders of the D15 tests are made under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEDUP_MS, HOLD_MS } from '../src/hooks-bridge.mjs';
import { parseClaudeHookPayload } from '../src/hooks-receiver.mjs';
import { SID, SUB, T0, CLAUDE, WAIT_KEYS, OK, setup, permission, notification } from './fixtures/hooks-bridge.mjs';

const ids = (waits) => waits().map((w) => w.toolUseId);

test('a PermissionRequest that arrives twice while it is held is held once: the next tool of that name gets no wait', () => {
  assert.equal(DEDUP_MS, 1000);
  const { bridge, start, end, waits, clock } = setup();
  assert.deepEqual(bridge.handle(permission()), OK);
  clock.ms += 5; // the same hook installed twice (settings.json and the plugin): two bodies for one prompt
  assert.deepEqual(bridge.handle(permission()), OK);
  assert.deepEqual([bridge.stats().held, bridge.stats().duplicates], [1, 1]);
  clock.ms += 3000; // still held (a slow rescan): the same body is a repeat for as long as the first one is held
  bridge.handle(permission());
  assert.deepEqual([bridge.stats().held, bridge.stats().duplicates], [1, 2]);
  start('toolu_A');
  assert.deepEqual(ids(waits), ['toolu_A']);
  end('toolu_A');
  clock.ms += 3000; // within the 10 s a second held copy would have lived
  start('toolu_B');
  assert.deepEqual(ids(waits), ['toolu_A'], 'B never prompted');
  assert.deepEqual([bridge.stats().held, bridge.stats().waits], [0, 1]);
});

test('two open tools of one name and one prompt posted twice: only the newest is marked; after 1 s it is a new prompt', () => {
  const { bridge, start, waits, clock } = setup();
  start('toolu_1');
  start('toolu_2');
  bridge.handle(permission());
  clock.ms += DEDUP_MS - 1;
  bridge.handle(permission());
  assert.deepEqual(ids(waits), ['toolu_2']);
  assert.deepEqual([bridge.stats().duplicates, bridge.stats().held], [1, 0]);
  clock.ms += 1; // 1 s after the first: a person answered it and the next prompt opened
  bridge.handle(permission());
  assert.deepEqual(ids(waits), ['toolu_2', 'toolu_1']);
});

test('a repeat is told by the ids of the body: a late subagent request sent twice is not held behind the parent\'s wait', () => {
  const { bridge, store, start, waits, clock } = setup();
  start('toolu_parent');
  bridge.handle(permission({ agent_id: SUB })); // the Store has no such subagent yet: the parent's matching tool
  clock.ms += 5;
  bridge.handle(permission({ agent_id: SUB }));
  assert.deepEqual([waits().length, bridge.stats().held, bridge.stats().duplicates], [1, 0, 1]);
  store.byChar.set(SUB, { agent: CLAUDE, sid: SID, kind: 'sub' });
  store.push({ type: 'tool_start', sessionId: SUB, ts: new Date(clock.ms).toISOString(), toolUseId: 'toolu_sub', tool: 'Bash', summary: 'Bash' });
  assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SID, 'toolu_parent']]);

  // other ids, another tool name or another session are other prompts, also in the same instant
  const other = setup({ chars: { [SID]: { agent: CLAUDE, sid: SID, kind: 'main' }, [SUB]: { agent: CLAUDE, sid: SID, kind: 'sub' } } });
  other.bridge.handle(permission());
  other.bridge.handle(permission({ agent_id: SUB }));
  other.bridge.handle(permission({ tool_name: 'Edit' }));
  assert.deepEqual([other.bridge.stats().held, other.bridge.stats().duplicates], [3, 0]);
  // also when the Store does not have the subagent yet: its request is not a repeat of the parent's
  const late = setup();
  late.bridge.handle(permission());
  late.bridge.handle(permission({ agent_id: SUB }));
  assert.deepEqual(late.bridge.held.map((h) => h.charId), [SID, SUB]);
  assert.equal(late.bridge.stats().duplicates, 0);
});

test('a request while every open tool of that name already waits is not held (the next tool_start must not inherit it)', () => {
  const { bridge, start, waits, clock } = setup();
  start('toolu_A');
  bridge.handle(permission());
  clock.ms += 5000; // A was allowed and still runs; a request for a tool the tailer has not read yet
  bridge.handle(permission());
  assert.deepEqual([bridge.stats().held, bridge.stats().unmatched], [0, 1]);
  start('toolu_B');
  clock.ms += 6000;
  bridge.handle(notification());
  assert.deepEqual(ids(waits), ['toolu_A'], 'the limit CONTRACT 7.2 lists under Not shown');
});

test('a Notification while the request is still held takes its place: the newest open tool is marked and the held one is used up', () => {
  const { bridge, start, waits, clock } = setup();
  start('toolu_e', 'Edit');
  bridge.handle(permission({ tool_name: 'NameTheTranscriptNeverShows' }));
  assert.equal(bridge.stats().held, 1);
  clock.ms += 6000;
  assert.deepEqual(bridge.handle(notification()), OK);
  assert.deepEqual(waits().map((w) => [w.toolUseId, Object.keys(w).sort().join()]), [['toolu_e', WAIT_KEYS.join()]]);
  assert.equal(bridge.stats().held, 0, 'one prompt, one wait: the held request is gone');
  start('toolu_late', 'NameTheTranscriptNeverShows');
  assert.equal(waits().length, 1);
  clock.ms += 5; // the Notification hook installed twice
  bridge.handle(notification());
  assert.equal(waits().length, 1);
});

test('a Notification with nothing open to mark leaves the held request alone', () => {
  const { bridge, start, waits, clock } = setup();
  bridge.handle(permission({ tool_name: 'Edit' }));
  clock.ms += 6000;
  bridge.handle(notification());
  assert.deepEqual([waits().length, bridge.stats().held, bridge.stats().unmatched], [0, 1, 1]);
  clock.ms += 1000;
  start('toolu_e', 'Edit');
  assert.deepEqual(ids(waits), ['toolu_e']);
});

test('a subagent the Store never gets under that agent_id: the Notification marks the parent\'s open tool', () => {
  const UNKNOWN = 'a9999999999999999';
  for (const extra of [{ agent_id: UNKNOWN }, {}]) { // whether the Notification carries the agent_id is not known
    const { bridge, start, waits, clock } = setup();
    start('toolu_agent', 'Agent');
    bridge.handle(permission({ agent_id: UNKNOWN, agent_type: 'Explore' }));
    assert.deepEqual([waits().length, bridge.stats().held], [0, 1], 'held for a character that never comes');
    clock.ms += 6000;
    bridge.handle(notification(extra));
    assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SID, 'toolu_agent']]);
    assert.equal(bridge.stats().held, 0);
  }
});

test('with two requests held, a Notification that marks a tool uses up the oldest one of that session only', () => {
  const OTHER = 'ffffffff-1111-4222-8333-444455556666';
  const { bridge, store, start, waits, clock } = setup({ chars: {
    [SID]: { agent: CLAUDE, sid: SID, kind: 'main' }, [SUB]: { agent: CLAUDE, sid: SID, kind: 'sub' }, [OTHER]: { agent: CLAUDE, sid: OTHER, kind: 'main' },
  } });
  start('toolu_e', 'Edit');
  bridge.handle(permission({ session_id: OTHER, transcript_path: undefined, tool_name: 'Write' }));
  bridge.handle(permission({ tool_name: 'Mystery' }));
  clock.ms += 5900;
  bridge.handle(permission({ agent_id: SUB })); // a subagent's prompt, about to meet its tool_start
  clock.ms += 100;
  bridge.handle(notification());
  assert.deepEqual(ids(waits), ['toolu_e']);
  assert.deepEqual(bridge.held.map((h) => [h.sid, h.charId, h.tool]), [[OTHER, OTHER, 'Write'], [SID, SUB, 'Bash']]);
  store.push({ type: 'tool_start', sessionId: SUB, ts: new Date(clock.ms).toISOString(), toolUseId: 'toolu_sub', tool: 'Bash', summary: 'Bash' });
  assert.deepEqual(waits().map((w) => [w.sessionId, w.toolUseId]), [[SID, 'toolu_e'], [SUB, 'toolu_sub']]);
});

test('D14: a session only hooks report keeps its Notification: the synthetic perm_ wait, with exactly the D25 fields', () => {
  const HOOK_ONLY = 'hook-only-2';
  const { bridge, events, waits, clock } = setup({ chars: {} });
  const hook = (extra) => bridge.handle({ session_id: HOOK_ONLY, hook_event_name: 'Notification', cwd: '/Users/dev/RAW_CWD_BAIT', ...extra });
  assert.deepEqual(hook({ notification_type: 'permission_prompt', message: 'RAW_MESSAGE_BAIT' }), OK);
  assert.deepEqual(events, [{ type: 'tool_wait', sessionId: HOOK_ONLY, ts: new Date(T0).toISOString(), toolUseId: 'perm_hook-onl', waiting: true }]);
  assert.deepEqual(Object.keys(events[0]).sort(), WAIT_KEYS);
  clock.ms += 5; // the hook installed twice: one wait
  hook({ notification_type: 'permission_prompt', message: 'RAW_MESSAGE_BAIT' });
  assert.equal(events.length, 1);
  clock.ms += 2000; // the older form: no notification_type, the message says it
  assert.deepEqual(hook({ message: 'Claude needs your approval to run RAW_MESSAGE_BAIT' }), OK);
  assert.deepEqual(events[1], { ...events[0], ts: new Date(clock.ms).toISOString() });
  hook({ message: 'The task is finished' });
  hook({ notification_type: 'idle_prompt', message: 'Claude is idle' });
  assert.equal(events.length, 2, 'a Notification that is not about a permission sends nothing');
  assert.deepEqual([bridge.stats().legacy, bridge.stats().openWaits, bridge.stats().held], [2, 0, 0]);
  assert.equal(JSON.stringify(events).includes('BAIT'), false);
  assert.deepEqual(bridge.decorate(events), events, 'no tool_start names the synthetic id: nothing to copy into a snapshot');

  // a tool the hooks themselves opened (an older install with PreToolUse) is marked instead, once
  clock.ms += 2000;
  bridge.handle({ session_id: HOOK_ONLY, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/Users/dev/p/a.mjs' } });
  hook({ notification_type: 'permission_prompt' });
  assert.deepEqual(waits().at(-1), { type: 'tool_wait', sessionId: HOOK_ONLY, ts: new Date(clock.ms).toISOString(), toolUseId: events.at(-2).toolUseId, waiting: true });
  clock.ms += 2000;
  hook({ notification_type: 'permission_prompt' });
  assert.equal(waits().length, 3, 'the prompt already shows on that tool: no synthetic wait on top');

  // a session the Store follows gets no synthetic wait, in either form (D14: the transcript is its source)
  const followed = setup();
  followed.bridge.handle(notification());
  followed.bridge.handle(notification({ notification_type: undefined, message: 'Claude needs your permission' }));
  assert.deepEqual([followed.events.length, followed.bridge.stats().unmatched, followed.bridge.stats().ignored], [0, 1, 1]);
});

test('hook-only sessions: a failed tool sends a fixed error line, tool_output is never read, and an odd tool name sends nothing', () => {
  const activeHookTools = new Map();
  const hook = (hook_event_name, extra = {}) => parseClaudeHookPayload({ session_id: 'hook-only-3', hook_event_name, ...extra }, { activeHookTools, now: () => T0 });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'deploy --token BAITINPUT' } });
  const failed = hook('PostToolUseFailure', { tool_name: 'Bash', error: 'BAITERR q password=BAITPW', tool_output: 'BAITOUTPUT raw stdout line p secret=BAITSECRETVALUE' });
  assert.deepEqual(failed.events.map((e) => [e.type, e.ok, e.errorKind, e.error]), [['tool_end', false, 'failed', 'Tool failed']]);
  hook('PreToolUse', { tool_name: 'Bash', tool_input: {} });
  const flagged = hook('PostToolUse', { tool_name: 'Bash', is_error: true, tool_output: 'BAITOUTPUT secret=BAITSECRETVALUE' });
  assert.equal(flagged.events[0].error, 'Tool failed');
  assert.equal(JSON.stringify([failed, flagged]).includes('BAIT'), false);

  for (const tool_name of ['BAITTOOLNAME <script>', 'a b', 'x'.repeat(129), '', 'tool\nname', '../../etc']) {
    for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      assert.deepEqual(hook(ev, { tool_name, tool_input: {} }).events, [], `${ev} ${JSON.stringify(tool_name).slice(0, 30)}`);
    }
  }
  const mcp = hook('PreToolUse', { tool_name: 'mcp__5f3c1a2b-7d4e-4c1a-9b2e-1a2b3c4d5e6f__get_issue', tool_input: {} });
  assert.equal(mcp.events[0].tool, 'mcp__00000000-0000-0000-0000-000000000000__get_issue', 'a connector uuid is masked, as in a transcript');
  assert.match(mcp.events[0].toolUseId, /^[A-Za-z0-9_.:-]+$/);
  assert.equal(hook('PreToolUse', { tool_name: `mcp__plugin_server__${'t'.repeat(100)}`, tool_input: {} }).events.length, 1, 'long mcp names (up to 128) stay');
});

test('a held wait is dropped once it is 10 s old: at the next counter read or pushed event, without another hook', () => {
  const { bridge, store, clock } = setup();
  bridge.handle(permission({ tool_name: 'Edit' }));
  clock.ms += HOLD_MS - 1;
  assert.equal(bridge.stats().held, 1);
  clock.ms += 60_000;
  assert.deepEqual([bridge.stats().held, bridge.stats().expired, bridge.held.length], [0, 1, 0]);

  bridge.handle(permission({ tool_name: 'Write' }));
  clock.ms += 60_000;
  store.push({ type: 'say', sessionId: 'someone-else', ts: new Date(clock.ms).toISOString(), text: 'hello' });
  assert.equal(bridge.held.length, 0, 'any pushed event drops it');
  assert.equal(bridge.recent.size, 0, 'and the 1 s memory of the repeat rule');
  assert.equal(bridge.stats().expired, 2);
});

test('D15: a root given in its real spelling and a transcript_path through a link to it: the folder part is resolved, no file is opened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-hooks-rlink-'));
  try {
    fs.mkdirSync(path.join(dir, 'real', 'projects', '-w'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'elsewhere'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'real', 'projects', 'out'), 'dir');
    const real = fs.realpathSync(path.join(dir, 'real', 'projects'));
    const linked = path.join(dir, 'link', 'projects');
    const { bridge, start, waits, clock } = setup({ claudeRoot: real });
    for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) start(id);
    const send = (transcript_path) => { clock.ms += 2000; bridge.handle(permission({ transcript_path })); };
    send(path.join(linked, '-w', `${SID}.jsonl`)); // the folder exists, the file does not
    assert.deepEqual([waits().length, bridge.stats().foreign], [1, 0]);
    send(path.join(linked, '-new-project', 'deeper', `${SID}.jsonl`)); // the nearest folder that exists is resolved
    assert.deepEqual([waits().length, bridge.stats().foreign], [2, 0]);
    send(path.join(dir, 'link', 'other', `${SID}.jsonl`));
    send(linked); // the root itself, through the link
    send(path.join(dir, 'elsewhere', `${SID}.jsonl`));
    send(`${path.join(dir, 'link')}\0/projects/x.jsonl`);
    send(path.join(linked, 'x'.repeat(5000), 'y.jsonl'));
    assert.deepEqual([waits().length, bridge.stats().foreign], [2, 5]);
    // by spelling inside the root: accepted without a lookup, wherever a link below the root leads (nothing is opened)
    send(path.join(real, 'out', `${SID}.jsonl`));
    assert.deepEqual([waits().length, bridge.stats().foreign], [3, 5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D15: on a volume that ignores letter case, a transcript_path in another case is inside the root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-hooks-case-'));
  try {
    fs.mkdirSync(path.join(dir, 'Projects', '-w'), { recursive: true });
    if (!fs.existsSync(path.join(dir, 'PROJECTS'))) return t.skip('this volume tells letter case apart');
    const { bridge, start, waits } = setup({ claudeRoot: path.join(dir, 'Projects') });
    start('toolu_1');
    bridge.handle(permission({ transcript_path: path.join(dir, 'PROJECTS', '-W', `${SID}.jsonl`) }));
    assert.deepEqual([waits().length, bridge.stats().foreign], [1, 0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return undefined;
});
