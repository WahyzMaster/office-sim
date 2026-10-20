// 라이브 승인 대기(P5g tool_wait)의 페이지 규칙 (public/js/approval.js): 순수 함수를 평범한 객체로 시험한다.
// 진짜 Agent/Office 메서드로 따라가는 시험(내 자리 방문, 승인됨/거절됨, 오래된 질문 닫기, 스냅샷 대조)은
// page-approval-office.test.mjs 에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitStart, waitEnd, reconcileWaits, snapshotWaits, liveAskStays, textKey, rememberText, forgetText, forgetTexts,
} from '../public/js/approval.js';
import { compactQueue } from '../public/js/agent-queue.js';

const TEXT = 'run_terminal_command npm test';
const ASK_KEYS = ['kind', 'approval', 'room', 'prefer', 'question', 'options', 'ids', 'open', 'ts', 'activity', 'live', 'resume'];

// Agent.push 와 같이: 넣고 바로 compactQueue 로 정리한다.
function plain() {
  return {
    pending: new Map(),
    queue: [],
    current: null,
    push(it) {
      this.queue.push(it);
      this.queue = compactQueue(this.queue, this.pending);
    },
  };
}

// office.js toolStart 의 도구 intent 와 같은 모양.
function addTool(a, id, room = 'server', text = TEXT) {
  const it = { kind: 'tool', room, ids: [id], open: 1, activity: text };
  a.pending.set(id, it);
  a.push(it);
  return it;
}

const entry = (text = TEXT) => ({ text });

test('waitStart replaces a queued single-id tool in place with the replay-shaped ask plus live and resume', () => {
  const a = plain();
  const t1 = addTool(a, 'A');
  const t2 = addTool(a, 'B', 'dev', 'edit_file a.js');
  const e = entry();
  const ask = waitStart(a, { toolUseId: 'A', ts: '2026-01-01T00:00:05.000Z' }, e);
  assert.deepEqual(ask, {
    kind: 'ask', approval: true, room: 'desk', prefer: 0, question: `승인 대기 · ${TEXT}`, options: ['허용', '거절'],
    ids: ['A'], open: 1, ts: '2026-01-01T00:00:05.000Z', activity: '승인 받으러 가는 중',
    live: true, resume: { room: 'server', text: TEXT },
  });
  assert.deepEqual(Object.keys(ask), ASK_KEYS);
  assert.deepEqual(a.queue, [ask, t2], 'the ask takes the tool place, the next tool stays after it');
  assert.equal(a.pending.get('A'), ask);
  assert.equal(t1.open, 0);
});

test('waitStart on the current tool lowers its open count and pushes the ask', () => {
  const a = plain();
  const t1 = addTool(a, 'A');
  a.current = a.queue.shift();
  const ask = waitStart(a, { toolUseId: 'A', ts: 't' }, entry());
  assert.equal(t1.open, 0, 'the tool can finish, so the character leaves for the desk');
  assert.equal(a.current, t1);
  assert.deepEqual(a.queue, [ask]);
  assert.equal(a.pending.get('A'), ask);
});

test('waitStart on a merged intent takes out only its own id', () => {
  const a = plain();
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) addTool(a, id, 'server', `run_terminal_command ${id}`);
  assert.equal(a.queue.length, 1, 'seven same-room tools merge (agent-queue.js MERGE_AT)');
  const merged = a.queue[0];
  assert.equal(merged.open, 7);
  const ask = waitStart(a, { toolUseId: 'C', ts: 't' }, entry('run_terminal_command C'));
  assert.equal(ask.question, '승인 대기 · run_terminal_command C', 'the per-id text, not the merged label');
  assert.equal(merged.open, 6);
  assert.deepEqual(a.queue, [merged, ask], 'a merged intent is not replaced: the ask goes after it');
  assert.equal(a.pending.get('C'), ask);
  for (const id of ['A', 'B', 'D', 'E', 'F', 'G']) assert.equal(a.pending.get(id), merged);
});

test('waitStart does nothing for an ask, a closed tool, an unknown id or a repeat while waiting', () => {
  const a = plain();
  const desk = { kind: 'ask', approval: false, room: 'desk', ids: ['Q'], open: 1 };
  a.pending.set('Q', desk);
  a.queue.push(desk);
  const done = addTool(a, 'Z');
  done.open = 0;
  const before = [...a.queue];
  for (const id of ['Q', 'Z', 'nope']) assert.equal(waitStart(a, { toolUseId: id, ts: 't' }, entry()), null, id);
  assert.deepEqual(a.queue, before);
  assert.equal(a.pending.get('Q'), desk);
  assert.equal(done.open, 0);

  const b = plain();
  addTool(b, 'A');
  const e = entry();
  const ask = waitStart(b, { toolUseId: 'A', ts: 't' }, e);
  assert.equal(waitStart(b, { toolUseId: 'A', ts: 't' }, e), null, 'a second true while waiting');
  assert.deepEqual(b.queue, [ask]);
  waitEnd(b, 'A');
  assert.equal(b.pending.get('A').kind, 'tool');
  // no page latch (P5g review): one true per id and server core, so a true after the allow comes from a new core (a
  // restart whose first snapshot did not carry the wait yet) and the prompt is open again
  const again = waitStart(b, { toolUseId: 'A', ts: 't2' }, e);
  assert.equal(again?.kind, 'ask', 'a true after the allow asks again');
  assert.equal(b.pending.get('A'), again);
});

test('waitStart on a merged intent that carries a failed sibling error still takes out its id (P5g review)', () => {
  const a = plain();
  for (const id of ['F', 'A', 'B', 'C', 'D', 'E', 'G']) addTool(a, id, 'server', `run_terminal_command ${id}`);
  const merged = a.queue[0];
  assert.equal(merged.open, 7);
  // F failed (agent.js toolEnd): it leaves pending, and its error stays on the merged intent
  a.pending.delete('F');
  merged.open -= 1;
  merged.error = 'exit 1';
  merged.errorKind = 'failed';
  const ask = waitStart(a, { toolUseId: 'C', ts: 't' }, entry('run_terminal_command C'));
  assert.equal(ask?.question, '승인 대기 · run_terminal_command C');
  assert.equal(a.pending.get('C'), ask);
  assert.equal(merged.open, 5);
});

test('waitStart falls back to the intent text when the text map has no entry', () => {
  const a = plain();
  addTool(a, 'A', 'research', 'web_search cats');
  const ask = waitStart(a, { toolUseId: 'A', ts: 't' }, undefined);
  assert.equal(ask.question, '승인 대기 · web_search cats');
  assert.deepEqual(ask.resume, { room: 'research', text: 'web_search cats' });
});

test('waitEnd before arrival swaps the tool intent into the ask place', () => {
  const a = plain();
  const busy = addTool(a, 'X', 'dev', 'edit_file a.js');
  addTool(a, 'A');
  const after = addTool(a, 'B', 'archive', 'read_file b.js');
  a.current = a.queue.shift();
  const ask = waitStart(a, { toolUseId: 'A', ts: 't' }, entry());
  assert.deepEqual(a.queue, [ask, after]);
  const tool = waitEnd(a, 'A');
  assert.deepEqual(tool, { kind: 'tool', room: 'server', ids: ['A'], open: 1, activity: TEXT });
  assert.deepEqual(a.queue, [tool, after], 'the character goes straight back to work, no desk visit');
  assert.equal(a.pending.get('A'), tool);
  assert.equal(a.current, busy);
});

test('waitEnd after the ask started marks it answered and pushes the tool intent', () => {
  const a = plain();
  addTool(a, 'A');
  const ask = waitStart(a, { toolUseId: 'A', ts: 't' }, entry());
  a.current = a.queue.shift();
  assert.equal(a.current, ask);
  const tool = waitEnd(a, 'A');
  assert.equal(ask.answered, true);
  assert.equal(ask.open, 0);
  assert.equal(ask.denied, undefined);
  assert.deepEqual(a.queue, [tool]);
  assert.equal(a.pending.get('A'), tool);
  assert.equal(waitEnd(a, 'A'), null, 'a second false does nothing');
});

test('waitEnd ignores replay asks, answered asks, tools and unknown ids', () => {
  const a = plain();
  const replay = { kind: 'ask', approval: true, room: 'desk', ids: ['R'], open: 1 };
  const answered = { kind: 'ask', approval: true, live: true, answered: true, resume: { room: 'server', text: '' }, ids: ['S'], open: 0 };
  a.pending.set('R', replay);
  a.pending.set('S', answered);
  a.queue.push(replay, answered);
  const t = addTool(a, 'T');
  for (const id of ['R', 'S', 'T', 'nope']) assert.equal(waitEnd(a, id), null, id);
  assert.deepEqual(a.queue, [replay, answered, t]);
  assert.equal(replay.answered, undefined);
});

test('the resumed tool intent can merge into a same-room neighbour: pending follows absorb', () => {
  const a = plain();
  addTool(a, 'A');
  const ask = waitStart(a, { toolUseId: 'A', ts: 't' }, entry());
  a.current = a.queue.shift();
  assert.equal(a.current, ask);
  ['dev', 'archive', 'dev', 'archive', 'dev'].forEach((room, i) => addTool(a, `B${i}`, room, `t ${i}`));
  const g = addTool(a, 'G');
  const tool = waitEnd(a, 'A');
  assert.equal(a.queue.includes(tool), false, 'seven queued: the tool intent is absorbed into G');
  assert.equal(a.pending.get('A'), g);
  assert.deepEqual(g.ids, ['G', 'A']);
  assert.equal(g.open, 2);
});

test('snapshotWaits keeps only waiting:true per session', () => {
  const w = snapshotWaits([
    { type: 'session', sessionId: 's1' },
    { type: 'tool_start', sessionId: 's1', toolUseId: 'A' },
    { type: 'tool_wait', sessionId: 's1', toolUseId: 'A', waiting: true },
    { type: 'tool_wait', sessionId: 's1', toolUseId: 'B', waiting: false },
    { type: 'tool_wait', sessionId: 's2', toolUseId: 'C', waiting: true },
  ]);
  assert.deepEqual([...w.keys()], ['s1', 's2']);
  assert.deepEqual([...w.get('s1')], ['A']);
  assert.deepEqual([...w.get('s2')], ['C']);
});

test('reconcileWaits ends only live, unanswered asks whose tool is open without a wait', () => {
  const a = plain();
  addTool(a, 'A');
  addTool(a, 'B');
  addTool(a, 'C');
  waitStart(a, { toolUseId: 'A', ts: 't' }, entry());
  waitStart(a, { toolUseId: 'B', ts: 't' }, entry());
  const gone = waitStart(a, { toolUseId: 'C', ts: 't' }, entry());
  const replay = { kind: 'ask', approval: true, room: 'desk', ids: ['R'], open: 1 };
  a.pending.set('R', replay);
  a.queue.push(replay);
  const n = reconcileWaits(a, new Set(['A', 'B', 'R']), new Set(['B']));
  assert.equal(n, 1);
  assert.equal(a.pending.get('A').kind, 'tool', 'allowed while disconnected');
  assert.equal(a.pending.get('B').kind, 'ask', 'still waiting in the snapshot');
  assert.equal(a.pending.get('C'), gone, 'not open: left to abandonPending');
  assert.equal(a.pending.get('R'), replay, 'replay awaitsApproval asks are never touched');
  assert.equal(replay.answered, undefined);
});

test('liveAskStays: live asks ignore thinking, say and tool_start; prompt and turn_end still close them', () => {
  const live = { kind: 'ask', live: true };
  for (const t of ['thinking', 'say', 'tool_start']) assert.equal(liveAskStays(live, t), true, t);
  for (const t of ['prompt', 'turn_end']) assert.equal(liveAskStays(live, t), false, t);
  for (const t of ['thinking', 'say', 'tool_start', 'prompt']) assert.equal(liveAskStays({ kind: 'ask', approval: true }, t), false, t);
});

test('text map helpers: one entry per session and id, cleared per id or per session with a keep set', () => {
  const m = new Map();
  rememberText(m, 's1', 'A', 'a');
  rememberText(m, 's1', 'B', 'b');
  rememberText(m, 's2', 'A', 'x');
  assert.deepEqual(m.get(textKey('s1', 'A')), { text: 'a' });
  forgetText(m, 's1', 'A');
  assert.equal(m.has(textKey('s1', 'A')), false);
  rememberText(m, 's1', 'C', 'c');
  forgetTexts(m, 's1', new Set(['C']));
  assert.deepEqual([...m.keys()], [textKey('s2', 'A'), textKey('s1', 'C')]);
  forgetTexts(m, 's1');
  assert.deepEqual([...m.keys()], [textKey('s2', 'A')]);
});
