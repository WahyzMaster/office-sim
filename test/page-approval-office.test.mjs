// 라이브 승인 대기(P5g tool_wait)를 office.js 에 붙인 연결: three.js 를 가짜 모듈로 바꿔(아래 loader) 진짜 Agent/Office 메서드로
// 내 자리 방문, 승인됨/거절됨, 오래된 질문 닫기, 스냅샷 대조까지 따라간다. 걷기와 그리기는 건너뛴다. 순수 규칙은
// page-approval.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { textKey } from '../public/js/approval.js';

const TEXT = 'run_terminal_command npm test';

// ---- 진짜 Agent/Office 메서드로 ----
// 'three' 와 'three/addons/...' 를 아무 속성이나 받아 주는 가짜 모듈로 바꾼다. 이름은 public/js 에서 읽어 만든다.
const PAGE = fileURLToPath(new URL('../public/js/', import.meta.url));
const names = new Set();
for (const f of readdirSync(PAGE).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(PAGE + f, 'utf8');
  for (const m of src.matchAll(/THREE\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'three[^']*'/g)) for (const n of m[1].split(',')) names.add(n.trim());
}
const STUB = `const H = { get(t, k) { if (k === Symbol.toPrimitive) return () => 0; if (k === Symbol.iterator) return function* () {};
  if (k === 'then') return undefined; if (!(k in t.s)) t.s[k] = mk(); return t.s[k]; },
  set(t, k, v) { t.s[k] = v; return true; }, apply() { return mk(); }, construct() { return mk(); } };
function mk() { const f = function () {}; f.s = {}; return new Proxy(f, H); }
export const ${[...names].map((n) => `${n} = mk()`).join(', ')};`;
const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === 'three' || s.startsWith('three/')) return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true };
  return next(s, c);
}`)}`);
globalThis.window ??= { matchMedia: () => ({ matches: false }) };
const { Agent } = await import('../public/js/agent.js');
const { Office, GLOBAL_FLOOR_KEY, GLOBAL_FLOOR_LABEL } = await import('../public/js/office.js');

const HUD = { renderFloors() {}, log() {}, ping() {}, inspect() {}, clearPing() {}, pings: new Set() };
const FLOOR = { key: 'p', label: 'P', release() {}, board: { set() {} } };
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function setup(id = 's1') {
  const office = new Office({ setViewFn() {} }, HUD);
  office.byKey.set('p', FLOOR);
  const a = Object.create(Agent.prototype);
  Object.assign(a, {
    office, id, floor: FLOOR, isSub: false, parentId: null, agentType: '', agent: 'grok', name: 'g', childSeq: 0,
    queue: [], current: null, path: [], room: 'lounge', slot: -1, pending: new Map(), history: [],
    mode: 'idle', activity: '', idleT: 0, bubbleT: 0, panicT: 0, sweatEl: { hidden: true }, bubbles: [],
  });
  a.bubble = function bubble(kind, payload) { this.bubbles.push([kind, typeof payload === 'string' ? payload : payload.question]); };
  a.refreshTag = () => {};
  a.goTo = function goTo(room, prefer = -1) {
    this.room = room;
    this.slot = prefer >= 0 ? prefer : 1;
    this.path = [{}];
  };
  office.agents.set(id, a);
  const send = (ev) => office.onEvent({ sessionId: id, ...ev });
  return { office, a, send };
}

// Agent.update 의 대기열 부분: 다음 일 시작, 도착, 시간 흐름.
const next = (a) => { if (!a.current && a.queue.length) a.start(a.queue.shift()); };
const arrive = (a) => { a.path = []; a.arrived(); };
function wait(a, sec) {
  for (let t = 0; t < sec; t += 0.25) {
    const it = a.current;
    if (!it?.arrived) return;
    it.t += 0.25;
    if (a.isDone(it)) return a.finish(it);
  }
}
const lastBubble = (a) => a.bubbles[a.bubbles.length - 1];
const start = (id, s = 0) => ({ type: 'tool_start', ts: at(s), toolUseId: id, tool: 'run_terminal_command', summary: 'npm test', room: 'server' });
const waitEv = (id, waiting, s) => ({ type: 'tool_wait', ts: at(s), toolUseId: id, waiting });

test('Office: an allow at the desk shows 승인됨, then the character walks back to the tool room until tool_end', () => {
  const { office, a, send } = setup();
  send(start('A', 0));
  assert.ok(office.toolTexts.has(textKey('s1', 'A')));
  send(waitEv('A', true, 1));
  assert.equal(a.queue.length, 1);
  assert.equal(a.queue[0].kind, 'ask');
  assert.equal(a.history[0].text, `승인 대기 · ${TEXT}`);
  next(a);
  assert.equal(a.room, 'desk');
  arrive(a);
  assert.equal(a.mode, 'ask');
  assert.deepEqual(lastBubble(a), ['ask', `승인 대기 · ${TEXT}`]);
  send(waitEv('A', false, 9));
  wait(a, 2);
  assert.deepEqual(lastBubble(a), ['info', '승인됨']);
  assert.equal(a.current, null);
  next(a);
  assert.equal(a.room, 'server');
  assert.equal(a.activity, TEXT);
  arrive(a);
  assert.equal(a.mode, 'work');
  wait(a, 3);
  assert.equal(a.current?.kind, 'tool', 'an open tool keeps the character in its room');
  send({ type: 'tool_end', ts: at(12), toolUseId: 'A', ok: true });
  assert.equal(a.pending.size, 0);
  assert.equal(office.toolTexts.has(textKey('s1', 'A')), false, 'the text map is cleaned at tool_end');
  wait(a, 2);
  assert.equal(a.current, null);
});

test('Office: an allow while the ask is still queued sends the character straight to the tool room', () => {
  const { a, send } = setup();
  send({ type: 'tool_start', ts: at(0), toolUseId: 'X', tool: 'edit_file', summary: 'a.js', room: 'dev' });
  next(a);
  arrive(a);
  send(start('A', 1));
  send(waitEv('A', true, 2));
  send(waitEv('A', false, 4));
  assert.deepEqual(a.queue.map((i) => i.kind), ['tool']);
  send({ type: 'tool_end', ts: at(4), toolUseId: 'X', ok: true });
  wait(a, 2);
  next(a);
  assert.equal(a.room, 'server', 'no desk visit');
  assert.ok(!a.bubbles.some(([, t]) => t === '승인됨'));
});

test('Office: a deny arrives as tool_end denied and shows 거절됨 through the ask branch', () => {
  const { a, send } = setup();
  send(start('A', 0));
  send(waitEv('A', true, 1));
  next(a);
  arrive(a);
  send({ type: 'tool_end', ts: at(20), toolUseId: 'A', ok: false, errorKind: 'denied', error: '사용자가 실행을 거절함' });
  assert.deepEqual(a.history[0], { at: a.history[0].at, text: '거절 · 사용자가 실행을 거절함', kind: 'denied' });
  wait(a, 2);
  assert.deepEqual(lastBubble(a), ['denied', '거절됨']);
  assert.equal(a.current, null);
  assert.equal(a.queue.length, 0, 'no return to the tool room after a deny');
});

test('Office: a tool_end while waiting finishes the live ask like replay (ok shows 승인됨, failed panics)', () => {
  const ok = setup();
  ok.send(start('A', 0));
  ok.send(waitEv('A', true, 1));
  next(ok.a);
  arrive(ok.a);
  ok.send({ type: 'tool_end', ts: at(5), toolUseId: 'A', ok: true });
  wait(ok.a, 2);
  assert.deepEqual(lastBubble(ok.a), ['info', '승인됨']);
  ok.send(waitEv('A', false, 6));
  assert.equal(ok.a.queue.length, 0, 'a late false after the end does nothing');

  const bad = setup();
  bad.send(start('A', 0));
  bad.send(waitEv('A', true, 1));
  next(bad.a);
  arrive(bad.a);
  bad.send({ type: 'tool_end', ts: at(5), toolUseId: 'A', ok: false, errorKind: 'failed', error: 'exit 1' });
  wait(bad.a, 2);
  assert.deepEqual(lastBubble(bad.a), ['error', 'exit 1']);
});

test('Office: live asks survive thinking, say and sibling tool_start; prompt and turn_end close them', () => {
  for (const closer of ['prompt', 'turn_end']) {
    const { a, send } = setup();
    send(start('A', 0));
    send(waitEv('A', true, 1));
    send({ type: 'thinking', ts: at(2), text: 'hmm' });
    send({ type: 'say', ts: at(30), text: 'still here' });
    send({ ...start('B', 40), tool: 'read_file', summary: 'x', room: 'archive' });
    assert.equal(a.pending.get('A')?.kind, 'ask', 'the live ask is still open');
    assert.equal(a.pending.get('A').answered, undefined);
    send({ type: closer, ts: at(50) });
    assert.equal(a.pending.has('A'), false, closer);
  }
  // 재생 모드 질문은 예전처럼 thinking 에 닫힌다.
  const { a, send } = setup();
  send({ ...start('R', 0), awaitsApproval: true });
  send({ type: 'thinking', ts: at(1), text: 'hmm' });
  assert.equal(a.pending.has('R'), false);
});

test('Office: replay awaitsApproval asks keep their shape and ignore tool_wait', () => {
  const { office, a, send } = setup();
  send({ ...start('R', 0), awaitsApproval: true });
  const it = a.pending.get('R');
  assert.deepEqual(it, {
    kind: 'ask', approval: true, room: 'desk', prefer: 0, question: `승인 대기 · ${TEXT}`, options: ['허용', '거절'],
    ids: ['R'], open: 1, ts: at(0), activity: '승인 받으러 가는 중',
  });
  assert.equal(office.toolTexts.has(textKey('s1', 'R')), false);
  send(waitEv('R', true, 1));
  send(waitEv('R', false, 2));
  assert.equal(a.pending.get('R'), it);
  assert.equal(it.answered, undefined);
  assert.deepEqual(a.queue, [it]);
});

test('Office.applySnapshot: an open tool without its tool_wait ends the live wait; a waiting one stays', () => {
  const { office, a, send } = setup();
  send(start('A', 0));
  send(start('B', 0));
  send(waitEv('A', true, 1));
  send(waitEv('B', true, 1));
  send(start('C', 2));
  next(a);
  assert.equal(a.current.ids[0], 'A');
  arrive(a);
  const session = { type: 'session', project: 'p', projectLabel: 'P' };
  office.applySnapshot([session, start('A', 0), start('B', 0), waitEv('B', true, 1)].map((e) => ({ sessionId: 's1', ...e })));
  assert.equal(a.pending.get('A').kind, 'tool', 'A was allowed while disconnected');
  assert.equal(a.pending.get('B').kind, 'ask', 'B still waits');
  assert.equal(a.pending.has('C'), false, 'C ended while disconnected');
  assert.deepEqual([...office.toolTexts.keys()].sort(), [textKey('s1', 'A'), textKey('s1', 'B')]);
  wait(a, 2);
  assert.deepEqual(lastBubble(a), ['info', '승인됨']);
});

test('Office.applySnapshot: a wait the page missed is rebuilt from tool_start then tool_wait', () => {
  const { office, a } = setup();
  const evs = [{ type: 'session', project: 'p', projectLabel: 'P' }, start('A', 0), waitEv('A', true, 1)].map((e) => ({ sessionId: 's1', ...e }));
  office.applySnapshot(evs);
  assert.deepEqual(a.queue.map((i) => i.kind), ['ask']);
  assert.equal(a.queue[0].live, true);
  assert.equal(a.pending.get('A'), a.queue[0]);
  office.applySnapshot(evs);
  assert.deepEqual(a.queue.map((i) => i.kind), ['ask'], 'the same snapshot again changes nothing');
});

test('Office: session_end clears the text map of that session only', () => {
  const { office, send } = setup();
  send(start('A', 0));
  office.toolTexts.set(textKey('s2', 'Z'), { text: 'z' });
  send({ type: 'session_end', ts: at(1) });
  assert.deepEqual([...office.toolTexts.keys()], [textKey('s2', 'Z')]);
});

// ---- P5g review ----

test('Office: a wait on a tool merged with a failed same-room tool still sends the character to the desk', () => {
  const { a, send } = setup();
  for (const id of ['F', 'C', 'B', 'D', 'E', 'G', 'H']) send({ ...start(id, 0), summary: id });
  assert.equal(a.queue.length, 1, 'a backlog: seven server-room tools merge');
  send({ type: 'tool_end', ts: at(1), toolUseId: 'F', ok: false, errorKind: 'failed', error: 'exit 1' });
  send(waitEv('C', true, 2));
  assert.equal(a.pending.get('C')?.kind, 'ask');
  assert.deepEqual(a.queue.map((i) => i.kind), ['tool', 'ask']);
  assert.equal(a.history[0].text, '승인 대기 · run_terminal_command C', 'the newest log line');
});

test('Office: after a restart whose first snapshot lacks a still-open wait, the new server core\'s true asks again', () => {
  const { office, a, send } = setup();
  send(start('A', 0));
  send(waitEv('A', true, 1));
  next(a);
  arrive(a);
  const session = { type: 'session', project: 'p', projectLabel: 'P' };
  // the new server has read the transcript but not yet events.jsonl: tool_start A, no tool_wait
  office.applySnapshot([session, start('A', 0)].map((e) => ({ sessionId: 's1', ...e })));
  assert.equal(a.pending.get('A').kind, 'tool');
  send(waitEv('A', true, 3)); // its next events.jsonl read finds the prompt still open
  assert.equal(a.pending.get('A')?.kind, 'ask', 'the character goes back to the desk');
  assert.equal(a.pending.get('A').live, true);
});

test('Office: an allow after a long desk wait shows 승인됨 at once and keeps the character at the desk 1.2 s', () => {
  const { a, send } = setup();
  send(start('A', 0));
  send(waitEv('A', true, 1));
  next(a);
  arrive(a);
  const ask = a.current;
  wait(a, 5);
  assert.equal(a.mode, 'ask', 'still waiting after 5 s at the desk');
  send(waitEv('A', false, 9));
  assert.deepEqual(lastBubble(a), ['info', '승인됨'], 'at the allow, not 1.2 s later');
  assert.notEqual(a.mode, 'ask', 'no longer counted as an open approval (HUD, inspect)');
  wait(a, 1);
  assert.equal(a.current, ask, 'still at the desk 1 s after the allow');
  wait(a, 1);
  assert.equal(a.current, null);
  next(a);
  assert.equal(a.room, 'server');
});

test('Office: an allow while the character walks to the desk never shows the open question on arrival', () => {
  const { a, send } = setup();
  send(start('A', 0));
  send(waitEv('A', true, 1));
  next(a);
  assert.deepEqual([a.room, a.current.kind, a.current.arrived], ['desk', 'ask', false]);
  send(waitEv('A', false, 2));
  arrive(a);
  assert.notEqual(a.mode, 'ask');
  assert.ok(!a.bubbles.some(([kind]) => kind === 'ask'), 'no 승인 대기 bubble with 허용/거절 chips');
  assert.deepEqual(lastBubble(a), ['info', '승인됨']);
  wait(a, 2);
  assert.equal(a.current, null);
  next(a);
  assert.equal(a.room, 'server');
  // a deny during the walk: no open question either, 거절됨 after the dwell
  const d = setup();
  d.send(start('A', 0));
  d.send(waitEv('A', true, 1));
  next(d.a);
  d.send({ type: 'tool_end', ts: at(2), toolUseId: 'A', ok: false, errorKind: 'denied', error: 'denied' });
  arrive(d.a);
  assert.notEqual(d.a.mode, 'ask');
  wait(d.a, 2);
  assert.deepEqual(lastBubble(d.a), ['denied', '거절됨']);
  assert.ok(!d.a.bubbles.some(([kind]) => kind === 'ask'));
});

test('Office.upsert: workspace-less main sessions share the unified _global floor instead of agent-named floors', () => {
  const { office } = setup();
  const seen = [];
  office.floorFor = (key, label) => {
    seen.push([key, label]);
    return null;
  };
  office.upsert({ sessionId: 'agy-1', agent: 'antigravity', project: '', projectLabel: '', isSubagent: false });
  office.upsert({ sessionId: 'cx-1', agent: 'codex', project: '', projectLabel: '', isSubagent: false });
  assert.deepEqual(seen, [
    [GLOBAL_FLOOR_KEY, GLOBAL_FLOOR_LABEL],
    [GLOBAL_FLOOR_KEY, GLOBAL_FLOOR_LABEL],
  ]);
});
