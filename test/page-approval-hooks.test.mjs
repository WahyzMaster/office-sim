// W6 (launch readiness D13, D25): a tool_wait that the Claude Code hook bridge sends (src/hooks-bridge.mjs) drives the
// same page code as the Grok one. The events below have the bridge's shape: a Claude tool_start from the transcript,
// then { type: 'tool_wait', sessionId, ts, toolUseId, waiting: true } and never a waiting:false.
// three.js is replaced by a stub module (same loader as page-approval-office.test.mjs); walking and drawing are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
const { Office } = await import('../public/js/office.js');

const HUD = { renderFloors() {}, log() {}, ping() {}, inspect() {}, clearPing() {}, pings: new Set() };
const FLOOR = { key: 'p', label: 'P', release() {}, board: { set() {} } };
const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function setup(id = SID) {
  const office = new Office({ setViewFn() {} }, HUD);
  office.byKey.set('p', FLOOR);
  const a = Object.create(Agent.prototype);
  Object.assign(a, {
    office, id, floor: FLOOR, isSub: false, parentId: null, agentType: '', agent: 'claude-code', name: 'c', childSeq: 0,
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
// what the Claude transcript gives (src/session-util.mjs toolStart) and what the hook bridge adds
const bash = (id, s = 0) => ({ type: 'tool_start', ts: at(s), toolUseId: id, tool: 'Bash', summary: 'npm test', room: 'server' });
const hookWait = (id, s) => ({ type: 'tool_wait', ts: at(s), toolUseId: id, waiting: true });
const ASK = '승인 대기 · Bash npm test';

test('a Claude Code permission prompt (hook tool_wait) sends the character to the approval desk until the tool ends', () => {
  const { a, send } = setup();
  send(bash('toolu_1', 0));
  assert.deepEqual(a.queue.map((i) => [i.kind, i.room]), [['tool', 'server']]);
  send(hookWait('toolu_1', 1));
  assert.deepEqual(a.queue.map((i) => [i.kind, i.room]), [['ask', 'desk']], 'the queued tool visit became the desk visit');
  assert.equal(a.queue[0].question, ASK);
  assert.deepEqual(a.queue[0].options, ['허용', '거절']);
  assert.equal(a.history[0].text, ASK);
  next(a);
  assert.equal(a.room, 'desk');
  arrive(a);
  assert.equal(a.mode, 'ask');
  assert.deepEqual(lastBubble(a), ['ask', ASK]);
  // no waiting:false ever comes from a hook: thinking and speech in between do not close the wait
  send({ type: 'thinking', ts: at(3), text: 'hmm' });
  send({ type: 'say', ts: at(4), text: 'still waiting' });
  wait(a, 30);
  assert.equal(a.pending.get('toolu_1')?.kind, 'ask', 'still at the desk while the tool is open');
  send({ type: 'tool_end', ts: at(40), toolUseId: 'toolu_1', ok: true });
  assert.equal(a.pending.size, 0);
  wait(a, 2);
  assert.deepEqual(lastBubble(a), ['info', '승인됨']);
  assert.equal(a.current, null);
});

test('a denied prompt arrives as the transcript\'s tool_end and shows 거절됨', () => {
  const { a, send } = setup();
  send(bash('toolu_1', 0));
  send(hookWait('toolu_1', 1));
  next(a);
  arrive(a);
  send({ type: 'tool_end', ts: at(9), toolUseId: 'toolu_1', ok: false, errorKind: 'denied', error: 'User rejected tool use' });
  wait(a, 2);
  assert.deepEqual(lastBubble(a), ['denied', '거절됨']);
  assert.equal(a.queue.length, 0);
});

test('the character already works in the tool room: the wait still walks it to the desk', () => {
  const { a, send } = setup();
  send(bash('toolu_1', 0));
  next(a);
  arrive(a);
  assert.equal(a.room, 'server');
  send(hookWait('toolu_1', 1));
  wait(a, 3);
  next(a);
  assert.equal(a.room, 'desk');
  arrive(a);
  assert.deepEqual(lastBubble(a), ['ask', ASK]);
});

test('D25: a page that connects later rebuilds the wait from the snapshot; a snapshot without it ends the wait', () => {
  const session = { type: 'session', agent: 'claude-code', project: 'p', projectLabel: 'P' };
  const withWait = [session, bash('toolu_1', 0), hookWait('toolu_1', 1)].map((e) => ({ sessionId: SID, ...e }));
  const { office, a } = setup();
  office.applySnapshot(withWait);
  assert.deepEqual(a.queue.map((i) => [i.kind, i.room, i.live]), [['ask', 'desk', true]]);
  office.applySnapshot(withWait);
  assert.deepEqual(a.queue.map((i) => i.kind), ['ask'], 'the same snapshot again changes nothing');
  // without the snapshot copy the page would read the open tool as "allowed while I was away"
  office.applySnapshot(withWait.slice(0, 2));
  assert.equal(a.pending.get('toolu_1').kind, 'tool');
});

test('an ask tool keeps its own desk visit: a tool_wait for it changes nothing', () => {
  const { a, send } = setup();
  send({ type: 'tool_start', ts: at(0), toolUseId: 'toolu_q', tool: 'AskUserQuestion', summary: 'Which one?', room: 'desk', question: 'Which one?', options: ['A', 'B'] });
  const it = a.pending.get('toolu_q');
  send(hookWait('toolu_q', 1));
  assert.equal(a.pending.get('toolu_q'), it);
  assert.deepEqual(a.queue, [it]);
  assert.equal(it.question, 'Which one?');
});

test('D14: the synthetic perm_ wait of a session only hooks report names no tool: the office scene does nothing with it', () => {
  const { office, a, send } = setup();
  send(bash('toolu_1', 0));
  send({ type: 'tool_start', ts: at(1), toolUseId: 'toolu_q', tool: 'AskUserQuestion', summary: 'Which one?', room: 'desk', question: 'Which one?', options: ['A', 'B'] });
  const before = { queue: [...a.queue], pending: [...a.pending], bubbles: a.bubbles.length, history: a.history.length };
  send(hookWait('perm_0a1b2c3d', 20)); // long after the open question: it is not closed as stale either
  assert.deepEqual([...a.queue], before.queue);
  assert.deepEqual([...a.pending], before.pending);
  assert.deepEqual([a.bubbles.length, a.history.length], [before.bubbles, before.history]);
  // a session the page never got a `session` event for: no character appears
  office.onEvent({ sessionId: 'hook-only-9', ...hookWait('perm_hook-onl', 21) });
  assert.equal(office.agents.has('hook-only-9'), false);
  assert.equal(office.agents.size, 1);
});
