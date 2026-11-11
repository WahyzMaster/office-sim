// W6 (launch readiness D13 to D16, D25): POST /api/hooks/claude against the real server on port 0, with a temporary
// Claude root and invented transcripts (test/fixtures/records.mjs). The real ~/.claude is never touched and no Claude
// Code runs: the hook bodies below are fixtures shaped like the hook reference describes them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { createRecordBuilder, toJsonl } from './fixtures/records.mjs';
import { request, sse, until } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const SID = '6d6d6d6d-1111-4222-8333-444455556666';
const SUB = 'a0f1e2d3c4b5a6978';
const CWD = '/work/invented-hooks';
const WAIT_KEYS = ['sessionId', 'toolUseId', 'ts', 'type', 'waiting'];
// text that exists only in hook bodies: none of it may reach the page
const BAIT = ['HOOK_RAW_INPUT_SECRET', 'HOOK_RAW_DESCRIPTION', 'HOOK_RAW_MESSAGE', 'HOOK_RAW_SUGGESTION', 'HOOK_BIG_BODY'];

const tmpDirs = [];
after(async () => { for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }); });
const line = (rec) => `${JSON.stringify(rec)}\n`;

async function office(seed = (m) => [m.humanPrompt({ text: 'Run the invented checks' })], { sub = null } = {}) {
  const notified = []; // native notifications, caught before any OS command (the exec function is a fake)
  const notifyOpts = { enabled: true, categories: ['ask'], platform: 'darwin', execFileFn: (_c, _a, _o, cb) => cb(null, 'ok'), onNotify: (n) => notified.push(n) };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-hooks-http-'));
  tmpDirs.push(root);
  const dir = path.join(root, '-work-invented-hooks');
  await fs.mkdir(path.join(dir, SID, 'subagents'), { recursive: true });
  const t0 = Date.now() - 5000; // recent timestamps: the replayed growth must not trip the idle timers
  const m = createRecordBuilder({ sessionId: SID, cwd: CWD, startMs: t0, stepMs: 10 });
  const main = path.join(dir, `${SID}.jsonl`);
  await fs.writeFile(main, toJsonl(seed(m)));
  if (sub) {
    const s = createRecordBuilder({ sessionId: SID, cwd: CWD, agentId: SUB, startMs: t0, stepMs: 10 });
    await fs.writeFile(path.join(dir, SID, 'subagents', `agent-${SUB}.jsonl`), toJsonl(sub(s)));
    await fs.writeFile(path.join(dir, SID, 'subagents', `agent-${SUB}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Survey', toolUseId: 'toolu_agent1' }));
  }
  const app = await start({ port: 0, intervalMs: 50, rescanMs: 200, activeMinutes: 30, root, publicDir: PUBLIC, notifyOpts });
  await app.ready;
  const post = (body, { path: p = '/api/hooks/claude', headers = { 'content-type': 'application/json' } } = {}) => request(app.port, {
    method: 'POST', path: p, headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const state = async () => {
    const res = await request(app.port, { path: '/state' });
    return { text: res.body, events: JSON.parse(res.body).events };
  };
  const permission = (extra = {}) => ({
    session_id: SID, transcript_path: main, cwd: CWD, permission_mode: 'default', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: 'echo HOOK_RAW_INPUT_SECRET', description: 'HOOK_RAW_DESCRIPTION' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'HOOK_RAW_SUGGESTION' }] }], ...extra,
  });
  return { app, root, main, m, post, state, permission, notified, append: (recs) => fs.appendFile(main, recs.map(line).join('')) };
}

const bash = (m, id = 'toolu_bash1') => m.assistantToolUse({ msgId: `msg_${id}`, id, name: 'Bash', input: { command: 'npm test', description: 'Run tests' } });
const noBait = (text, what) => { for (const b of BAIT) assert.equal(text.includes(b), false, `${b} in ${what}`); };

test('a PermissionRequest for an open tool: 200 {}, tool_wait on the wire and in /state right after its tool_start', async () => {
  const o = await office((m) => [m.humanPrompt({ text: 'Run the invented checks' }), bash(m)]);
  let client;
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_bash1'));
    client = await sse(o.app.port);
    const snap = await client.nextData();
    assert.equal(snap.data.type, 'snapshot');
    assert.equal(snap.data.events.some((e) => e.type === 'tool_wait'), false);
    assert.equal((await client.nextData()).data.type, 'config'); // from here on every data frame is an event

    const res = await o.post(o.permission());
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}', 'exactly {} (D16)');
    const live = (await client.nextData()).data;
    assert.deepEqual(Object.keys(live).sort(), WAIT_KEYS, 'exactly the Grok fields (D25)');
    assert.deepEqual({ ...live, ts: null }, { type: 'tool_wait', sessionId: SID, ts: null, toolUseId: 'toolu_bash1', waiting: true });

    const st = await o.state();
    const i = st.events.findIndex((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_bash1');
    assert.deepEqual(st.events[i + 1], live, '/state: a copy right after the tool_start');
    assert.equal(st.events.filter((e) => e.type === 'tool_wait').length, 1);
    noBait(st.text, '/state');
    assert.equal(st.text.includes(o.root), false, 'the transcript path of the hook body is not in /state');
    // the native notifier and the recap see it like a Grok tool_wait: one ask notification with the tool's summary
    assert.deepEqual(o.notified.map((n) => [n.category, n.title, n.body]), [['ask', 'Office Sim · Waiting for Approval', st.events[i].summary]]);
    const recap = JSON.parse((await request(o.app.port, { path: `/api/recap?sessionId=${SID}` })).body);
    assert.deepEqual([recap.toolCalls, recap.toolErrors, recap.unreviewedDone], [1, 0, false], 'a wait is not a tool call');

    // a page that connects now still sees the wait (D25)
    const late = await sse(o.app.port);
    try {
      const evs = (await late.nextData()).data.events;
      const j = evs.findIndex((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_bash1');
      assert.deepEqual(evs[j + 1], live);
    } finally {
      late.close();
    }

    // the Notification of the same prompt (about six seconds later in real use) and a repeated request add nothing
    assert.equal((await o.post({ session_id: SID, transcript_path: o.main, cwd: CWD, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'HOOK_RAW_MESSAGE' })).body, '{}');
    assert.equal((await o.post(o.permission())).body, '{}');
    await o.append([o.m.toolResult({ toolUseId: 'toolu_bash1', content: 'ok' })]);
    const end = (await client.nextData()).data;
    assert.deepEqual([end.type, end.toolUseId, end.ok], ['tool_end', 'toolu_bash1', true], 'nothing came between the wait and the tool_end');
    assert.equal(o.notified.length, 1, 'no second notification for the same prompt');
    const after = await o.state();
    assert.equal(after.events.some((e) => e.type === 'tool_wait' || e.type === 'tool_start'), false, 'the wait ends with its tool');
    noBait(client.frames.map((f) => f.raw).join('\n'), 'the SSE stream');
  } finally {
    client?.close();
    await o.app.close();
  }
});

test('the hook before the tool_use line: the wait is held and sent right after the tool_start (wire order)', async () => {
  const o = await office();
  let client;
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'session'));
    client = await sse(o.app.port);
    await client.nextData(); // snapshot
    assert.equal((await o.post(o.permission({ tool_name: 'Edit', tool_input: { file_path: `${CWD}/a.mjs`, old_string: 'HOOK_RAW_INPUT_SECRET', new_string: 'x' } }))).body, '{}');
    assert.equal(o.app.hooks.stats().held, 1);
    await o.append([o.m.assistantToolUse({ msgId: 'msg_e1', id: 'toolu_edit1', name: 'Edit', input: { file_path: `${CWD}/a.mjs`, old_string: 'a', new_string: 'b' } })]);
    const first = (await client.next((f) => f.data?.type === 'tool_start')).data;
    const second = (await client.nextData()).data;
    assert.equal(first.toolUseId, 'toolu_edit1');
    assert.deepEqual([second.type, second.toolUseId, second.waiting], ['tool_wait', 'toolu_edit1', true]);
    assert.deepEqual(Object.keys(second).sort(), WAIT_KEYS);
    assert.equal(o.app.hooks.stats().held, 0);
    assert.deepEqual(o.notified.map((n) => [n.title, n.body]), [['Office Sim · Waiting for Approval', first.summary]], 'the notifier saw the tool_start first');
    noBait(client.frames.map((f) => f.raw).join('\n') + (await o.state()).text, 'the wire');
  } finally {
    client?.close();
    await o.app.close();
  }
});

test('one prompt posted twice before its tool_use line (the hook installed twice): one wait, and the next Bash gets none', async () => {
  const o = await office();
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'session'));
    assert.equal((await o.post(o.permission())).body, '{}');
    assert.equal((await o.post(o.permission(), { path: '/api/hooks/claude?source=office-sim-claude-hook' })).body, '{}');
    assert.deepEqual([o.app.hooks.stats().held, o.app.hooks.stats().duplicates], [1, 1]);
    await o.append([bash(o.m, 'toolu_A')]);
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_wait' && e.toolUseId === 'toolu_A'));
    await o.append([o.m.toolResult({ toolUseId: 'toolu_A', content: 'ok' }), bash(o.m, 'toolu_B')]);
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_B'));
    const { events, text } = await o.state();
    assert.equal(events.some((e) => e.type === 'tool_wait'), false, 'B never prompted: /state has its tool_start and no tool_wait');
    assert.deepEqual([o.app.hooks.stats().waits, o.app.hooks.stats().held, o.app.hooks.stats().openWaits], [1, 0, 0]);
    assert.equal(o.notified.length, 1, 'one native notification for the one prompt');
    noBait(text, '/state');
  } finally {
    await o.app.close();
  }
});

test('D14: a session only hooks report keeps its Notification: the synthetic wait reaches the pages and the native notifier', async () => {
  const o = await office();
  const HOOK_ONLY = 'hook-only-http-1';
  let client;
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'session'));
    client = await sse(o.app.port);
    await client.nextData(); // snapshot
    assert.equal((await client.nextData()).data.type, 'config');
    const res = await o.post({ session_id: HOOK_ONLY, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'HOOK_RAW_MESSAGE' });
    assert.deepEqual([res.status, res.body], [200, '{}']);
    const live = (await client.nextData()).data;
    assert.deepEqual({ ...live, ts: null }, { type: 'tool_wait', sessionId: HOOK_ONLY, ts: null, toolUseId: 'perm_hook-onl', waiting: true });
    assert.deepEqual(Object.keys(live).sort(), WAIT_KEYS, 'exactly the D25 fields');
    assert.deepEqual(o.notified.map((n) => [n.category, n.title, n.body]), [['ask', 'Office Sim · Waiting for Approval', 'Command awaiting approval']]);
    // the older form (no notification_type; the message says it) is mapped as before too
    const old = await o.post({ session_id: 'hook-only-http-2', hook_event_name: 'Notification', message: 'Claude needs your approval HOOK_RAW_MESSAGE' });
    assert.deepEqual([old.status, old.body], [200, '{}']);
    assert.deepEqual([(await client.nextData()).data.toolUseId, o.app.hooks.stats().legacy], ['perm_hook-onl', 2]);
    const st = await o.state();
    assert.equal(st.events.some((e) => e.type === 'tool_wait'), false, 'a session that is not in the Store is in no snapshot');
    noBait(client.frames.map((f) => f.raw).join('\n') + st.text, 'the wire');
  } finally {
    client?.close();
    await o.app.close();
  }
});

test('a subagent prompt (agent_id) sends the subagent character to wait, not its parent', async () => {
  const o = await office(
    (m) => [m.humanPrompt({ text: 'Survey it' }), m.assistantToolUse({ msgId: 'msg_a1', id: 'toolu_agent1', name: 'Agent', input: { description: 'Survey', prompt: 'p', subagent_type: 'Explore' } })],
    { sub: (s) => [s.subagentPrompt({ text: 'p' }), bash(s, 'toolu_sub1')] },
  );
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_start' && e.sessionId === SUB));
    assert.equal((await o.post(o.permission({ agent_id: SUB, agent_type: 'Explore' }))).body, '{}');
    const { events } = await o.state();
    const waits = events.filter((e) => e.type === 'tool_wait');
    assert.deepEqual(waits.map((w) => [w.sessionId, w.toolUseId]), [[SUB, 'toolu_sub1']]);
    const i = events.findIndex((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_sub1');
    assert.equal(events[i + 1], waits[0]);
  } finally {
    await o.app.close();
  }
});

test('D14 and D15: other hook events of a followed session and a foreign transcript_path change nothing', async () => {
  const o = await office((m) => [m.humanPrompt({ text: 'Run the invented checks' }), bash(m)]);
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_start'));
    const seq = o.app.store.seq;
    for (const hook_event_name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'PreCompact']) {
      const res = await o.post({ session_id: SID, transcript_path: o.main, cwd: CWD, hook_event_name, tool_name: 'Bash', tool_input: { command: 'HOOK_RAW_INPUT_SECRET' } });
      assert.deepEqual([res.status, res.body], [200, '{}'], hook_event_name);
    }
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-hooks-other-'));
    tmpDirs.push(other);
    const foreign = await o.post(o.permission({ transcript_path: path.join(other, 'sessions', `${SID}.jsonl`) }));
    assert.deepEqual([foreign.status, foreign.body], [200, '{}']);
    assert.equal(o.app.store.seq, seq, 'no event was pushed');
    assert.deepEqual([o.app.hooks.stats().foreign, o.app.hooks.stats().ignored, o.app.hooks.stats().waits], [1, 6, 0]);
    assert.equal((await o.state()).events.some((e) => e.type === 'tool_wait'), false);
  } finally {
    await o.app.close();
  }
});

test('D16: the hook route reads up to 1 MiB; the other JSON routes keep 4096 bytes; 400 only for bad JSON or no session id', async () => {
  const o = await office((m) => [m.humanPrompt({ text: 'Run the invented checks' }), bash(m)]);
  try {
    await until(async () => (await o.state()).events.some((e) => e.type === 'tool_start'));
    const big = JSON.stringify(o.permission({ tool_name: 'Write', tool_input: { file_path: `${CWD}/big.txt`, content: 'HOOK_BIG_BODY '.repeat(15_000) } }));
    assert.ok(Buffer.byteLength(big) > 200_000 && Buffer.byteLength(big) < 1024 * 1024);
    const accepted = await o.post(big);
    assert.deepEqual([accepted.status, accepted.body], [200, '{}'], 'a 200 KB hook body is accepted');
    assert.equal(o.app.hooks.stats().held, 1, 'and handled: no Write is open yet, so the wait is held');

    const config = await o.post(JSON.stringify({ intervalMs: 100, pad: 'x'.repeat(5000) }), { path: '/config' });
    assert.equal(config.status, 413, 'a 5 KB body is still refused on /config');
    assert.deepEqual(JSON.parse(config.body), { error: 'body too large' });

    const huge = await o.post(JSON.stringify(o.permission({ tool_input: { content: 'x'.repeat(1024 * 1024) } })));
    assert.equal(huge.status, 413, 'over 1 MiB is refused on the hook route too');

    for (const [body, why] of [['{ not json', 'unparseable JSON'], ['[]', 'not an object'], [JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), 'no session id']]) {
      assert.equal((await o.post(body)).status, 400, why);
    }
    assert.equal((await o.post(o.permission(), { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request(o.app.port, { path: '/api/hooks/claude' })).status, 405);
    assert.equal((await o.post(o.permission(), { path: '/api/hooks/claude?source=office-sim-claude-hook' })).body, '{}', 'the marker query of the installed URL is accepted');
    noBait((await o.state()).text, '/state');
  } finally {
    await o.app.close();
  }
});
