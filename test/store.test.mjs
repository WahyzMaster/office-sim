// Store 단위 테스트: 가짜 SessionState + 메모리 안의 합성 레코드만 쓴다 (파일 IO 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { refIdentity, parseNotifications, subTitle, clip, linkFacts } from '../src/store-link.mjs';

const SID = '11111111-2222-4333-8444-555555555555';
const A1 = 'a0123456789abcdef';
const A2 = 'afedcba9876543210';
const W1 = 'a00000000000000aa';
const W2 = 'a00000000000000bb';
const RUN = 'wf_12345678-abc';
const ROOT = '/tmp-fake/projects/-proj-demo';
const MAIN = `${ROOT}/${SID}.jsonl`;
const SUB = (id) => `${ROOT}/${SID}/subagents/agent-${id}.jsonl`;
const WF = (id) => `${ROOT}/${SID}/subagents/workflows/${RUN}/agent-${id}.jsonl`;
const TS = '2026-10-19T01:02:03.000Z';

class FakeState {
  constructor(id, { project = '/work/demo', title = 'state title', ended = false, extra = [] } = {}) {
    this.id = id;
    this.project = project;
    this._title = title;
    this._ended = ended;
    this.extra = extra;
  }
  sessionEvent() {
    return {
      type: 'session', sessionId: this.id, ts: TS, project: this.project, projectLabel: this.project.split('/').pop(),
      title: this._title, branch: 'main', worktree: null, isSubagent: false, parentSessionId: null, agentType: null,
    };
  }
  snapshotEvents() { return [this.sessionEvent(), ...this.extra]; }
  get ended() { return this._ended; }
}

function mkStore(opts = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = new Store({ ringSize: 50, now: clock.now, ...opts });
  const got = [];
  store.subscribe((item) => got.push(item));
  return { store, got, clock, types: () => got.map((x) => `${x.event.type}:${x.event.sessionId}`) };
}

function attach(store, path, kind, state, extra) {
  const ref = { path, kind };
  const info = store.attachFile(ref, state, extra);
  return info;
}

const agentUse = (id, name = 'Agent', sessionId = SID) => ({
  type: 'assistant', uuid: `u-${id}`, sessionId, timestamp: TS,
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: { description: 'look around', prompt: 'SECRET PROMPT' } }] },
});
const result = (toolUseId, toolUseResult, content = 'ok', extra = {}) => ({
  type: 'user', uuid: `r-${toolUseId}`, sessionId: SID, timestamp: TS,
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content }] },
  toolUseResult, ...extra,
});
const noteText = ({ taskId, toolUseId, status }) => '<task-notification>\n'
  + (taskId ? `<task-id>${taskId}</task-id>\n` : '') + (toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : '')
  + (status ? `<status>${status}</status>\n` : '') + '<summary>invented summary</summary>\n</task-notification>';
const notification = (n, uuid = 'n1') => ({
  type: 'user', uuid, sessionId: SID, timestamp: TS, promptId: `p-${uuid}`, origin: { kind: 'task-notification' },
  message: { role: 'user', content: noteText(n) },
});
const queued = (n, uuid = 'q1') => ({
  type: 'attachment', uuid, sessionId: SID, timestamp: TS,
  attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: noteText(n), origin: { kind: 'task-notification' } },
});

// 메인 + (선택) 서브 하나를 붙이고 announce 까지.
function setupMain(store, mainRecords = []) {
  attach(store, MAIN, 'main', new FakeState(SID));
  for (const r of mainRecords) store.observe(MAIN, r);
  store.announce(MAIN);
}

test('refIdentity derives kind, sid, charId and runId from the layout', () => {
  assert.deepEqual(refIdentity({ path: MAIN, kind: 'main' }), { kind: 'main', sid: SID, charId: SID, runId: null, runDir: null });
  const s = refIdentity({ path: SUB(A1) });
  assert.equal(s.kind, 'sub');
  assert.equal(s.sid, SID);
  assert.equal(s.charId, A1);
  const w = refIdentity({ path: WF(W1), kind: 'wf' });
  assert.equal(w.kind, 'wf');
  assert.equal(w.sid, SID);
  assert.equal(w.charId, W1);
  assert.equal(w.runId, RUN);
  assert.equal(w.runDir, `${ROOT}/${SID}/subagents/workflows/${RUN}`);
});

test('ingest assigns increasing seq ids from seqStart and notifies listeners', () => {
  const { store, got } = mkStore({ seqStart: 100 });
  const n = store.ingest('/nowhere.jsonl', [{ type: 'say', sessionId: 'x', ts: TS, text: 'hi' }, { type: 'say', sessionId: 'x', ts: TS, text: 'yo' }]);
  assert.equal(n, 2);
  assert.deepEqual(got.map((g) => g.seq), [101, 102]);
  assert.equal(store.seq, 102);
  const fn = () => { throw new Error('boom'); };
  store.subscribe(fn); // 리스너 예외는 다른 리스너를 막지 않는다
  store.ingest('/nowhere.jsonl', [{ type: 'say', sessionId: 'x', ts: TS, text: 'z' }]);
  assert.equal(got.length, 3);
  store.unsubscribe(fn);
});

test('since() replays only missed events and returns null for gaps or foreign seqs', () => {
  const { store } = mkStore({ ringSize: 5 });
  for (let i = 0; i < 8; i++) store.ingest('/x.jsonl', [{ type: 'say', sessionId: 'x', ts: TS, text: String(i) }]);
  assert.equal(store.seq, 8);
  assert.deepEqual(store.since(6).map((x) => x.seq), [7, 8]);
  assert.deepEqual(store.since(3).map((x) => x.seq), [4, 5, 6, 7, 8]); // ring = 4..8, 3 is the edge
  assert.equal(store.since(2), null);
  assert.deepEqual(store.since(8), []);
  assert.equal(store.since(99), null); // 다른 서버 실행의 id
  assert.equal(store.since('abc'), null);
  assert.equal(store.since(undefined), null);
});

test('announce emits session + snapshotEvents once, snapshot orders main before subs', () => {
  const { store, types } = mkStore();
  const plan = { type: 'plan', sessionId: SID, ts: TS, items: [{ content: 'a', status: 'pending' }], source: 'update_plan' };
  attach(store, MAIN, 'main', Object.assign(new FakeState(SID), { extra: [plan] }));
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'Explore', toolUseId: 'toolu_A1' } });
  store.observe(MAIN, agentUse('toolu_A1'));
  // 아직 announce 전: 스냅샷에 없다 (replay 중인 반쪽 상태)
  assert.equal(store.snapshot().events.length, 0);
  store.announce(SUB(A1));
  store.announce(MAIN);
  assert.deepEqual(types().slice(0, 1), [`session:${A1}`]);
  assert.ok(types().includes(`session:${SID}`));
  assert.ok(types().includes(`plan:${SID}`));
  const snap = store.snapshot();
  assert.equal(snap.seq, store.seq);
  assert.deepEqual(snap.events.map((e) => `${e.type}:${e.sessionId}`), [`session:${SID}`, `plan:${SID}`, `session:${A1}`]);
});

test('plain sub links to the Agent tool_use in the main file and inherits the floor', () => {
  const { store, got } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  const info = attach(store, SUB(A1), 'sub', new FakeState(A1, { project: '/work/demo/.worktrees/x', title: 'SECRET PROMPT' }),
    { meta: { agentType: 'Explore', description: 'Find the parser', toolUseId: 'toolu_A1' } });
  assert.equal(info.parentId, SID);
  store.announce(SUB(A1));
  const ev = got.at(-1).event;
  assert.equal(ev.type, 'session');
  assert.equal(ev.sessionId, A1);
  assert.equal(ev.isSubagent, true);
  assert.equal(ev.parentSessionId, SID);
  assert.equal(ev.agentType, 'Explore');
  assert.equal(ev.title, 'Find the parser'); // 상태의 제목(=Agent prompt)은 절대 쓰지 않는다
  assert.equal(ev.project, '/work/demo');
  assert.equal(ev.projectLabel, 'demo');
});

test('nested sub without parentAgentId is linked by searching sibling agent files', () => {
  const { store, got } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'general-purpose', name: 'outer', toolUseId: 'toolu_A1' } });
  store.observe(SUB(A1), { ...agentUse('toolu_N1'), isSidechain: true, agentId: A1 });
  store.announce(SUB(A1));
  attach(store, SUB(A2), 'sub', new FakeState(A2), { meta: { agentType: 'Plan', toolUseId: 'toolu_N1', spawnDepth: 2 } });
  store.announce(SUB(A2));
  const ev = got.at(-1).event;
  assert.equal(ev.sessionId, A2);
  assert.equal(ev.parentSessionId, A1);
  assert.equal(ev.title, 'Plan'); // name/description 이 없으면 agentType
  // 스냅샷은 부모(A1) 다음에 자식(A2)
  const order = store.snapshot().events.filter((e) => e.type === 'session').map((e) => e.sessionId);
  assert.deepEqual(order, [SID, A1, A2]);
});

test('parentAgentId is trusted when the tool_use is not indexed', () => {
  const { store } = mkStore();
  setupMain(store);
  const info = attach(store, SUB(A2), 'sub', new FakeState(A2), { meta: { agentType: 'x', toolUseId: 'toolu_zz', parentAgentId: A1 } });
  assert.equal(info.parentId, A1);
});

test('missing meta falls back to the main session, then relinks when meta arrives', () => {
  const { store, got } = mkStore();
  setupMain(store);
  attach(store, SUB(A2), 'sub', new FakeState(A2));
  store.announce(SUB(A2));
  assert.deepEqual(store.pendingMeta(), [SUB(A2)]);
  let ev = got.at(-1).event;
  assert.equal(ev.parentSessionId, SID);
  assert.equal(ev.title, A2);
  // 형제 서브 A1 이 붙고, 그 안에서 toolu_N1 을 썼다
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', name: 'outer', toolUseId: 'toolu_none' } });
  store.observe(SUB(A1), agentUse('toolu_N1'));
  store.announce(SUB(A1));
  const before = got.length;
  store.setMeta(SUB(A2), { agentType: 'Explore', name: 'inner', toolUseId: 'toolu_N1' });
  assert.deepEqual(store.pendingMeta(), []);
  ev = got.slice(before).map((g) => g.event).find((e) => e.sessionId === A2);
  assert.equal(ev.type, 'session');
  assert.equal(ev.parentSessionId, A1);
  assert.equal(ev.title, 'inner');
  // 같은 내용이면 다시 보내지 않는다
  const n = got.length;
  store.relinkAll();
  assert.equal(got.length, n);
});

test('toolUseResult.agentId links a sub whose meta is still missing', () => {
  const { store, got } = mkStore();
  setupMain(store);
  attach(store, SUB(A1), 'sub', new FakeState(A1));
  store.announce(SUB(A1));
  attach(store, SUB(A2), 'sub', new FakeState(A2));
  store.announce(SUB(A2));
  store.observe(SUB(A1), agentUse('toolu_N2'));
  store.observe(SUB(A1), result('toolu_N2', { isAsync: true, status: 'async_launched', agentId: A2 }, 'Async agent launched successfully.'));
  const ev = got.at(-1).event;
  assert.equal(ev.type, 'session');
  assert.equal(ev.sessionId, A2);
  assert.equal(ev.parentSessionId, A1);
});

test('wf agents: parent is the main session, title comes from the journal label', () => {
  const { store, got } = mkStore();
  setupMain(store);
  attach(store, WF(W1), 'wf', new FakeState(W1), { meta: { agentType: 'workflow-subagent', spawnDepth: 1 } });
  store.announce(WF(W1));
  assert.equal(got.at(-1).event.parentSessionId, SID);
  assert.equal(got.at(-1).event.title, 'workflow-subagent');
  assert.deepEqual(store.pendingLabels().map((p) => p.charId), [W1]);
  store.setLabel(WF(W1), 'review:parser');
  assert.equal(got.at(-1).event.title, 'review:parser');
  assert.deepEqual(store.pendingLabels(), []);
});

test('sync Agent completion in the parent ends the sub once (R29)', () => {
  const { store, got, clock } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  const subState = new FakeState(A1);
  attach(store, SUB(A1), 'sub', subState, { meta: { agentType: 'Explore', toolUseId: 'toolu_A1' } });
  store.announce(SUB(A1));
  store.observe(MAIN, result('toolu_A1', { status: 'completed', agentId: A1, agentType: 'Explore', prompt: 'SECRET' }));
  const end = got.at(-1).event;
  assert.deepEqual([end.type, end.sessionId, end.reason], ['session_end', A1, 'done']);
  // SessionState 가 나중에 자기 session_end 를 내도 한 번만 나간다
  const n = got.length;
  store.ingest(SUB(A1), [{ type: 'session_end', sessionId: A1, ts: TS, reason: 'done' }]);
  // 같은 결과 레코드가 resume 으로 다시 붙어도 다시 끝내지 않는다
  store.observe(MAIN, result('toolu_A1', { status: 'completed', agentId: A1 }));
  assert.equal(got.length, n);
  // 끝난 직후 같은 파일의 꼬리 이벤트는 버린다
  store.ingest(SUB(A1), [{ type: 'say', sessionId: A1, ts: TS, text: 'final words' }]);
  assert.equal(got.length, n);
  assert.equal(store.snapshot().events.some((e) => e.sessionId === A1), false);
  // 유예가 지나 다시 일하면 session 부터 다시 보낸다
  clock.advance(6000);
  store.ingest(SUB(A1), [{ type: 'tool_start', sessionId: A1, ts: TS, toolUseId: 't9', tool: 'Read', summary: 'x.mjs' }]);
  assert.deepEqual(got.slice(n).map((g) => g.event.type), ['session', 'tool_start']);
  assert.equal(got[n].event.parentSessionId, SID);
});

test('nested sync completion without toolUseResult uses the agentId trailer', () => {
  const { store, got } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', toolUseId: 'toolu_A1' } });
  store.observe(SUB(A1), agentUse('toolu_N1'));
  store.announce(SUB(A1));
  attach(store, SUB(A2), 'sub', new FakeState(A2), { meta: { agentType: 'y', toolUseId: 'toolu_N1' } });
  store.announce(SUB(A2));
  store.observe(SUB(A1), result('toolu_N1', undefined, [
    { type: 'text', text: 'invented report' },
    { type: 'text', text: `agentId: ${A2} (use SendMessage with to: '${A2}' to continue this agent)` },
  ]));
  assert.deepEqual([got.at(-1).event.type, got.at(-1).event.sessionId], ['session_end', A2]);
});

test('task notifications end async subs by tool-use-id or task-id; progress and mirrors are ignored', () => {
  const { store, got, types } = mkStore();
  setupMain(store, [agentUse('toolu_A1'), agentUse('toolu_A2')]);
  store.observe(MAIN, result('toolu_A1', { isAsync: true, status: 'async_launched', agentId: A1 }));
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', toolUseId: 'toolu_A1' } });
  attach(store, SUB(A2), 'sub', new FakeState(A2), { meta: { agentType: 'x', toolUseId: 'toolu_A2' } });
  store.announce(SUB(A1));
  store.announce(SUB(A2));
  let n = got.length;
  store.observe(MAIN, notification({ taskId: 'bgshell1', status: null }, 'p0')); // 진행 알림
  store.observe(MAIN, notification({ toolUseId: 'toolu_A1', taskId: A1 }, 'p1')); // status 없음
  assert.equal(got.length, n);
  store.observe(MAIN, notification({ toolUseId: 'toolu_A1', taskId: A1, status: 'completed' }, 'n1'));
  assert.deepEqual(types().slice(n), [`session_end:${A1}`]);
  n = got.length;
  store.observe(MAIN, queued({ toolUseId: 'toolu_A1', taskId: A1, status: 'completed' })); // 같은 알림의 거울
  assert.equal(got.length, n);
  store.observe(MAIN, notification({ taskId: A2, status: 'killed' }, 'n2')); // task-id 만 있어도 된다
  assert.deepEqual(types().slice(n), [`session_end:${A2}`]);
});

test('a Workflow notification ends every agent of its run', () => {
  const { store, types } = mkStore();
  setupMain(store, [agentUse('toolu_W', 'Workflow')]);
  store.observe(MAIN, result('toolu_W', { status: 'async_launched', taskType: 'local_workflow', taskId: 'tk1234567', runId: RUN }));
  attach(store, WF(W1), 'wf', new FakeState(W1), { meta: { agentType: 'workflow-subagent' } });
  attach(store, WF(W2), 'wf', new FakeState(W2), { meta: { agentType: 'workflow-subagent' } });
  store.announce(WF(W1));
  store.announce(WF(W2));
  store.ingest(WF(W1), [{ type: 'session_end', sessionId: W1, ts: TS, reason: 'done' }]); // W1 은 먼저 끝났다
  const n = types().length;
  store.observe(MAIN, notification({ taskId: 'tk1234567', toolUseId: 'toolu_W', status: 'completed' }));
  assert.deepEqual(types().slice(n), [`session_end:${W2}`]);
});

test('a sub that finished before attach is not announced, and a resume clears done', () => {
  const { store, got } = mkStore();
  setupMain(store, [agentUse('toolu_A1'), result('toolu_A1', { status: 'completed', agentId: A1 })]);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', toolUseId: 'toolu_A1' } });
  const n = got.length;
  store.announce(SUB(A1));
  assert.equal(got.length, n);
  assert.equal(store.snapshot().events.some((e) => e.sessionId === A1), false);
  // SendMessage 로 다시 깨우면 done 이 풀리고, 새 활동에서 session 부터 다시 나온다
  store.observe(MAIN, agentUse('toolu_S1', 'SendMessage'));
  store.observe(MAIN, result('toolu_S1', { success: true, message: 'x', resumedAgentId: A1 }));
  store.ingest(SUB(A1), [{ type: 'say', sessionId: A1, ts: TS, text: 'again' }]);
  assert.deepEqual(got.slice(n).map((g) => g.event.type), ['session', 'say']);
  assert.equal(store.snapshot().events.some((e) => e.sessionId === A1), true);
});

test('a sub whose own file ends its turn (toolEndsTurn) ends, a main wrap_up does not', () => {
  const { store, types } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  attach(store, WF(W1), 'wf', new FakeState(W1), { meta: { agentType: 'w' } });
  store.announce(WF(W1));
  const n = types().length;
  const so = { ...agentUse('toolu_SO'), message: { id: 'm', content: [{ type: 'tool_use', id: 'toolu_SO', name: 'StructuredOutput', input: {} }] } };
  store.observe(WF(W1), so);
  store.observe(WF(W1), { ...result('toolu_SO', { ok: true }), toolEndsTurn: true, agentId: W1, isSidechain: true });
  store.observe(MAIN, { ...result('toolu_wrap', []), mcpMeta: { _meta: { 'claude/endTurn': true } } });
  assert.deepEqual(types().slice(n), [`session_end:${W1}`]);
});

test('fork history in a main file (different sessionId) is not indexed', () => {
  const { store } = mkStore();
  setupMain(store, [agentUse('toolu_F1', 'Agent', '99999999-0000-4000-8000-000000000000')]);
  const info = attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', toolUseId: 'toolu_F1' } });
  assert.equal(info.parentId, SID); // 폴백(메인)이지 fork 의 소유자가 아니다
  assert.equal(store.entry(SUB(A1)).resolved, false);
});

test('privacy: prompt events from sub files are dropped, main prompts pass', () => {
  const { store, types } = mkStore();
  setupMain(store);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x' } });
  store.announce(SUB(A1));
  const n = types().length;
  store.ingest(SUB(A1), [{ type: 'prompt', sessionId: A1, ts: TS, text: 'SECRET PROMPT' }]);
  store.ingest(MAIN, [{ type: 'prompt', sessionId: SID, ts: TS, text: 'hello' }]);
  assert.deepEqual(types().slice(n), [`prompt:${SID}`]);
});

test('main session updates refresh the floor of subs announced before it', () => {
  const { store, got } = mkStore();
  attach(store, SUB(A1), 'sub', new FakeState(A1, { project: '/elsewhere/wt' }), { meta: { agentType: 'x' } });
  store.announce(SUB(A1));
  assert.equal(got.at(-1).event.project, '/elsewhere/wt');
  attach(store, MAIN, 'main', new FakeState(SID, { project: '/work/demo' }));
  store.announce(MAIN);
  const ev = got.map((g) => g.event).filter((e) => e.sessionId === A1).at(-1);
  assert.equal(ev.project, '/work/demo');
});

test('ended states are left out of announce and snapshot; re-attach of a shown file says goodbye', () => {
  const { store, types } = mkStore();
  setupMain(store);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x' } });
  store.announce(SUB(A1));
  const n = types().length;
  attach(store, SUB(A1), 'sub', new FakeState(A1, { ended: true }), { meta: { agentType: 'x' } }); // reset 후 다시 붙임
  store.announce(SUB(A1));
  assert.deepEqual(types().slice(n), [`session_end:${A1}`]);
  assert.equal(store.snapshot().events.some((e) => e.sessionId === A1), false);
  assert.equal(store.fileCount, 2);
});

test('detachFile removes the entry and frees the session index when its last file leaves', () => {
  const { store } = mkStore();
  setupMain(store, [agentUse('toolu_A1')]);
  attach(store, SUB(A1), 'sub', new FakeState(A1), { meta: { agentType: 'x', toolUseId: 'toolu_A1' } });
  assert.equal(store.detachFile(SUB(A1)), true);
  assert.equal(store.detachFile(SUB(A1)), false);
  assert.equal(store.indexes.has(SID), true);
  store.detachFile(MAIN);
  assert.equal(store.indexes.has(SID), false);
  assert.equal(store.fileCount, 0);
  assert.equal(store.sessionCount, 0);
});

test('helpers: notifications, titles, clipping, cheap fact extraction', () => {
  assert.deepEqual(parseNotifications(noteText({ taskId: 't1', toolUseId: 'toolu_1', status: 'failed' })),
    [{ taskId: 't1', toolUseId: 'toolu_1', status: 'failed' }]);
  assert.deepEqual(parseNotifications('plain text'), []);
  assert.equal(subTitle({ name: '  ', description: 'desc' }, null, A1), 'desc');
  assert.equal(subTitle(null, 'label', A1), 'label');
  assert.equal(subTitle({ workflowPhase: 'phase', agentType: 't' }, null, A1), 'phase');
  assert.equal(subTitle(null, null, A1), A1);
  const long = '가'.repeat(70) + '\u0007';
  assert.equal(Array.from(clip(long, 60)).length, 60);
  assert.equal(Array.from(subTitle({ name: "나".repeat(90) }, null, A1)).length, 80);
  assert.equal(linkFacts({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), null);
  assert.equal(linkFacts({ type: 'system', subtype: 'api_error' }), null);
  assert.equal(linkFacts({ type: 'user', message: { content: 'hello <task-notification>' } }), null);
});
