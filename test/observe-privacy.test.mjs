// 기록 관찰의 개인정보 (observe-spec "Privacy", CONTRACT 5 의 관찰 출력). 자유 글 자리마다 BAIT 를 넣은 지어낸 Grok/Codex
// 기록을 ObserveControl 로 관찰하고, 출력 파일과 모든 상태 객체에 BAIT, 임시 루트 경로, 세션 uuid, 보는 파일의 이름이
// 하나도 없는지 본다. 범주 값 자리의 맞지 않는 값은 "?" 가 된다. 실제 ~/.grok, ~/.codex 는 읽지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObserveControl } from '../src/observe/control.mjs';
import { nearDays } from '../src/observe/observer.mjs';
import { activeShape, catValue, lineKinds } from '../src/observe/records.mjs';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const GROK_ID = '0198f0a0-1b2c-7d3e-8f40-0123456789ab';
const CODEX_ID = '0199c0de-0000-7000-8000-00000000beef';
const GROUP = encodeURIComponent('/Users/BAIT_USER/BAIT_REPO');
const ROLLOUT = `rollout-2026-10-20T09-00-00-${CODEX_ID}.jsonl`;
const iso = () => new Date().toISOString();
const line = (o) => `${JSON.stringify(o)}\n`;

const grokUpdates = (ms) => [
  { method: 'session/update', params: { sessionId: GROK_ID, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'BAIT_PROMPT fix it' }, _meta: { modelId: 'BAIT_MODEL' } }, _meta: { agentTimestampMs: ms, promptId: 'BAIT_PROMPT_ID' } }, timestamp: ms / 1000 },
  { method: 'session/update', params: { sessionId: GROK_ID, update: { sessionUpdate: 'tool_call', toolCallId: `call-${GROK_ID}`, title: 'BAIT_TITLE /Users/BAIT_USER/x', rawInput: { command: 'BAIT_COMMAND', cwd: '/Users/BAIT_CWD' }, _meta: { 'x.ai/tool': { name: 'BAIT_TOOL', namespace: 'BAIT_NS' } } }, _meta: { agentTimestampMs: ms } }, timestamp: ms / 1000 },
  { method: 'BAIT method with/slash', params: { update: { sessionUpdate: 'BAIT has spaces', rawOutput: { type: 'MCP', MCP: { server_name: 'BAIT_MCP', output: 'BAIT_OUTPUT' } } } } },
  { method: 'session/update', params: { update: { sessionUpdate: GROK_ID } } },
];
const grokEvents = () => [
  { type: 'tool_started', ts: iso(), tool_name: 'BAIT_TOOL', session_id: GROK_ID, model_id: 'BAIT_MODEL' },
  { type: 'phase_changed', ts: iso(), phase: 'BAIT phase', session_id: GROK_ID },
  { type: 'permission_requested', ts: iso(), tool_name: 'BAIT_TOOL', mcp_server: 'BAIT_MCP', cwd: '/Users/BAIT_CWD' },
  { type: 'permission_resolved', ts: iso(), decision: 'BAIT/decision', error: 'BAIT_ERROR text' },
  { type: 'BAIT_TYPE with space', ts: iso() },
];
const codexLines = () => [
  { timestamp: iso(), type: 'response_item', payload: { type: 'function_call', name: 'BAIT_TOOL', arguments: '{"cmd":"BAIT_COMMAND"}', call_id: CODEX_ID } },
  { timestamp: iso(), type: 'event_msg', payload: { type: 'agent_message', message: 'BAIT_MESSAGE', cwd: '/Users/BAIT_CWD' } },
  { timestamp: iso(), type: 'turn_context', payload: { model: 'BAIT_MODEL', cwd: '/Users/BAIT_CWD', approval_policy: 'BAIT policy' } },
  { timestamp: iso(), type: 'BAIT type!', payload: { type: CODEX_ID } },
];

function fakeTimers() {
  const q = [];
  return {
    setTimeout(fn) { const h = { fn, unref() {} }; q.push(h); return h; },
    clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async fire() { const h = q.shift(); if (h) await h.fn(); },
  };
}

test('records.mjs: categorical values outside the regex, id-like values and unknown methods become "?"', () => {
  assert.equal(catValue('tool_call'), 'tool_call');
  for (const v of ['has space', 'a/b', '', 'x'.repeat(65), GROK_ID, GROK_ID.replace(/-/g, ''), 'deadbeefdeadbeef00', 42, null, {}]) {
    assert.equal(catValue(v), '?', String(v));
  }
  assert.deepEqual(lineKinds('grok-updates', { method: 'other/method', params: { update: { sessionUpdate: 'x' } } }), ['method:?', 'sessionUpdate:x']);
  assert.deepEqual(lineKinds('codex-index', { id: GROK_ID, thread_name: 'BAIT' }), []);
  assert.deepEqual(lineKinds('grok-events', { type: 'tool_started', tool_name: 'BAIT_TOOL', phase: 'x', decision: 'y' }), ['type:tool_started']);
  const shape = activeShape(JSON.stringify({ [GROK_ID]: { [GROK_ID]: 'BAIT', pid: 1 } }));
  assert.deepEqual(shape, { shape: 'object', rows: 1, keys: { '?': 'string', pid: 'number' } });
});

test('the output file and every status object hold no BAIT, root path, session uuid or watched file name', async () => {
  const grok = await tmp('office-sim-observe-priv-grok-');
  const codex = await tmp('office-sim-observe-priv-codex-');
  const out = path.join(await tmp('office-sim-observe-priv-out-'), '.observe');
  const sdir = path.join(grok, 'sessions', GROUP, GROK_ID);
  await fsp.mkdir(sdir, { recursive: true });
  await fsp.writeFile(path.join(sdir, 'updates.jsonl'), line(grokUpdates(Date.now())[0]));
  await fsp.writeFile(path.join(sdir, 'events.jsonl'), '');
  await fsp.writeFile(path.join(sdir, 'summary.json'), JSON.stringify({ generated_title: 'BAIT_SUMMARY' }));
  await fsp.writeFile(path.join(grok, 'active_sessions.json'), JSON.stringify([{ session_id: GROK_ID, pid: 7, cwd: '/Users/BAIT_CWD', opened_at: iso(), 'BAIT key': 'BAIT_VALUE' }]));
  const day = path.join(codex, 'sessions', ...nearDays(Date.now())[0].split('/'));
  await fsp.mkdir(day, { recursive: true });
  await fsp.writeFile(path.join(day, ROLLOUT), line({ timestamp: iso(), type: 'session_meta', payload: { id: CODEX_ID, cwd: '/Users/BAIT_CWD' } }));
  await fsp.writeFile(path.join(codex, 'session_index.jsonl'), '');

  const statuses = [];
  const timers = fakeTimers();
  const ctl = new ObserveControl({ roots: { grok, codex }, dir: out, timers, onChange: (s) => statuses.push(s), notifyMs: 0 });
  statuses.push(await ctl.start());
  await timers.fire();
  await fsp.appendFile(path.join(sdir, 'updates.jsonl'), grokUpdates(Date.now()).map(line).join(''));
  await fsp.appendFile(path.join(sdir, 'events.jsonl'), grokEvents().map(line).join(''));
  await fsp.appendFile(path.join(day, ROLLOUT), codexLines().map(line).join(''));
  await fsp.appendFile(path.join(codex, 'session_index.jsonl'), line({ id: CODEX_ID, thread_name: 'BAIT_THREAD_NAME', updated_at: iso() }));
  await timers.fire();
  statuses.push(ctl.status());
  statuses.push(await ctl.stop());
  await ctl.close();

  const [name] = await fsp.readdir(out);
  const text = await fsp.readFile(path.join(out, name), 'utf8');
  const recs = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(recs.filter((r) => r.type === 'append').length >= 4, 'every kind was observed');
  assert.equal(recs.filter((r) => r.type === 'active').length, 1);
  const values = recs.filter((r) => r.type === 'append').flatMap((r) => Object.keys(r.kinds));
  for (const k of ['method:?', 'sessionUpdate:?', 'type:?', 'phase:?', 'decision:?', 'payload.type:?']) assert.ok(values.includes(k), k);

  const reals = await Promise.all([grok, codex, out].map((d) => fsp.realpath(d)));
  const forbidden = [
    'BAIT', grok, codex, out, ...reals, GROK_ID, CODEX_ID, GROUP, ROLLOUT, 'updates.jsonl', 'events.jsonl', 'session_index.jsonl',
    'active_sessions.json', 'summary.json', 'Users', os.homedir(),
  ];
  const blobs = [['output file', text], ...statuses.map((s, i) => [`status ${i}`, JSON.stringify(s)])];
  assert.ok(statuses.length >= 4);
  for (const [what, blob] of blobs) {
    for (const f of forbidden) assert.equal(blob.includes(f), false, `${what} contains ${f}`);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(blob), false, `${what} has a uuid`);
  }
  assert.equal(statuses.at(-1).last.file, name, 'the status names the output file only');
});
