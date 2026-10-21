// 기록 관찰 페이지 (public/js/observe-panel.js, sources.js 의 observe 갈래, office.html 의 버튼과 패널).
// 순수 도우미(이름표, 시간 형식, 상태 읽기, 화면 모델, 요청)는 평범한 객체로 시험한다. ObservePanel(작은 가짜 DOM)은
// test/page-observe-panel.test.mjs 에 있다.
// 서버 상태는 손으로 만든 합성 값이다(실제 기록 폴더는 읽지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECK_LABELS, TEXT, PANEL_PARTS, checkLabel, clock, readStatus, observeView, postObserve, ObserveModel,
} from '../public/js/observe-panel.js';
import { LiveSource } from '../public/js/sources.js';
import { IDS, checklist, status, ALL_DONE, LAST } from './fixtures/observe-status.mjs';

const view = (over, opt) => observeView(readStatus(status(over)), opt);

test('labels: the four checklist ids have Korean labels; an unknown id shows as itself', () => {
  assert.deepEqual(Object.keys(CHECK_LABELS), IDS);
  for (const id of IDS) assert.match(checkLabel(id), /[가-힣]/, id);
  assert.equal(checkLabel('grok-wait'), 'Grok 권한 창 1초 넘게 기다림');
  assert.equal(checkLabel('new-item'), 'new-item');
  assert.equal(checkLabel('toString'), 'toString');
});

test('clock: mm:ss, h:mm:ss over an hour, 00:00 for junk', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(999), '00:00');
  assert.equal(clock(723000), '12:03');
  assert.equal(clock(59 * 60000 + 59999), '59:59');
  assert.equal(clock(3723000), '1:02:03');
  for (const bad of [-5, NaN, undefined, '723000', Infinity]) assert.equal(clock(bad), '00:00', String(bad));
});

test('readStatus: only objects with a boolean available are statuses', () => {
  for (const bad of [null, undefined, 'x', 3, {}, { type: 'observe' }, { available: 'true' }, { available: 1 }]) {
    assert.equal(readStatus(bad), null, JSON.stringify(bad));
  }
  const s = readStatus(status({ running: true, ready: true, elapsedMs: 1500.7, startedAt: '2026-10-21T15:30:00.000Z' }));
  assert.equal(s.available, true);
  assert.equal(s.running, true);
  assert.equal(s.ready, true);
  assert.equal(s.elapsedMs, 1500);
  assert.equal(s.startedAt, '2026-10-21T15:30:00.000Z');
  assert.deepEqual(s.agents, { grok: true, codex: true });
  assert.equal(s.checklist.length, 4);
  assert.equal(readStatus(status({ available: false, running: true, ready: true })).running, false, 'unavailable is never running');
  assert.equal(readStatus(status({ running: false, ready: true })).ready, false, 'ready only while running');
});

test('observeView: hidden without a status', () => {
  assert.deepEqual(observeView(null), { visible: false });
  assert.deepEqual(observeView(readStatus({ type: 'observe' })), { visible: false });
});

test('observeView: idle shows the start button, the checklist targets and the grok-wait hint', () => {
  const v = view();
  assert.equal(v.visible, true);
  assert.deepEqual(v.button, { state: 'idle', text: '기록 관찰', label: '기록 관찰', title: '평소 쓰는 Grok·Codex 기록이 덧붙는 모양을 셉니다.' });
  assert.equal(v.clock, '');
  assert.deepEqual(v.action, { kind: 'start', label: '관찰 시작', primary: true, disabled: false });
  assert.deepEqual(v.items.map((i) => [i.label, i.progress, i.ratio]), [
    ['Grok 작업 기록(updates) 덧붙음', '목표 20', 0],
    ['Grok 권한 창 1초 넘게 기다림', '목표 1', 0],
    ['Grok 실행 중 세션 목록 읽기', '목표 1', 0],
    ['Codex 작업 기록(rollout) 덧붙음', '목표 20', 0],
  ]);
  // 멈춘 상태에 지난 수가 실려 와도 진행으로 보이지 않는다(지난 결과는 last 줄에 나온다)
  const stale = view({ checklist: checklist(ALL_DONE), last: LAST });
  assert.ok(stale.items.every((i) => !i.done && i.ratio === 0 && i.progress.startsWith('목표 ')));
  assert.equal(stale.hint, TEXT.waitHint);
  assert.equal(v.hint, TEXT.waitHint);
  assert.equal(v.note, null);
  assert.equal(v.last, null);
  assert.equal(v.stateText, '관찰하지 않고 있어요.');
});

test('observeView: running shows the clock on the button, progress and an early-end note', () => {
  const v = view({ running: true, elapsedMs: 723000, checklist: checklist({ 'grok-updates': 5, 'grok-active': 1 }) });
  assert.equal(v.button.state, 'running');
  assert.equal(v.button.text, '관찰 중 · 12:03');
  assert.equal(v.clock, '12:03');
  assert.equal(v.ready, false);
  assert.deepEqual(v.action, { kind: 'stop', label: '지금 끝내기', primary: false, disabled: false });
  assert.match(v.note, /지금 끝내도 모인 만큼 저장돼요/);
  const [updates, , active] = v.items;
  assert.equal(updates.progress, '5/20');
  assert.equal(updates.ratio, 0.25);
  assert.equal(active.progress, '1/1 · 다 모임');
  assert.equal(active.done, true);
  assert.equal(v.last, null);
  // 바깥에서 준 경과 시간이 상태의 elapsedMs 보다 앞선다(로컬 시계)
  assert.equal(view({ running: true, elapsedMs: 1000 }, { elapsedMs: 3723000 }).button.text, '관찰 중 · 1:02:03');
});

test('observeView: ready turns the button into "충분히 모였어요" and the end button into the primary action', () => {
  const v = view({ running: true, ready: true, elapsedMs: 60000, checklist: checklist(ALL_DONE) });
  assert.equal(v.button.state, 'ready');
  assert.equal(v.items[0].progress, '23/20 · 다 모임');
  assert.equal(v.button.text, '충분히 모였어요');
  assert.match(v.stateText, /^충분히 모였어요/);
  assert.deepEqual(v.action, { kind: 'stop', label: '관찰 끝내기', primary: true, disabled: false });
  assert.equal(v.note, null);
  assert.equal(v.hint, null, 'grok-wait done -> no hint');
  assert.ok(v.items.every((i) => i.done && i.ratio === 1));
});

test('observeView: off items are greyed with a reason and do not block ready', () => {
  const v = view({
    agents: { grok: true, codex: false }, running: true, ready: true,
    checklist: checklist({ 'grok-updates': 20, 'grok-wait': 1, 'grok-active': 1 }, ['codex-rollout']),
  });
  const codex = v.items.find((i) => i.id === 'codex-rollout');
  assert.deepEqual({ off: codex.off, progress: codex.progress, ratio: codex.ratio, note: codex.note },
    { off: true, progress: '건너뜀', ratio: 0, note: 'Codex 기록을 읽지 않아 건너뛰어요' });
  assert.equal(v.button.state, 'ready');
  const grokOff = view({ checklist: checklist({ 'codex-rollout': 3 }, ['grok-updates', 'grok-wait', 'grok-active']) });
  assert.equal(grokOff.hint, null, 'no grok-wait hint when Grok is off');
  assert.equal(grokOff.items[1].note, 'Grok 기록을 읽지 않아 건너뛰어요');
});

test('observeView: available:false explains why and disables start', () => {
  const v = view({ available: false, agents: { grok: false, codex: false }, checklist: checklist({}, IDS) });
  assert.equal(v.visible, true);
  assert.equal(v.button.state, 'off');
  assert.equal(v.button.text, '기록 관찰');
  assert.equal(v.stateText, TEXT.unavailable);
  assert.deepEqual(v.action, { kind: 'start', label: '관찰 시작', primary: false, disabled: true });
  assert.deepEqual(v.items, []);
  assert.equal(v.hint, null);
});

test('observeView: after an end the saved file name, a counts-only line and the Claude line show', () => {
  const v = view({ last: LAST });
  assert.deepEqual(v.last, {
    file: 'observe-20261021-153000.jsonl',
    reason: '직접 끝냄',
    counts: '파일 3개 · 덧붙음 57번 · 체크리스트 4/4 채움',
    claude: "Claude 에게 '관찰 결과 반영해 줘' 라고 하면 이 파일을 읽어 문서에 반영해요",
  });
  assert.equal(v.stateText, '관찰을 끝냈어요. 다시 시작하면 새 파일에 모아요.');
  const partial = view({ last: { ...LAST, checklist: checklist({ 'grok-updates': 20 }, ['codex-rollout']) } });
  assert.equal(partial.last.counts, '파일 3개 · 덧붙음 57번 · 체크리스트 1/3 채움', 'off items are not counted');
  assert.equal(view({ running: true, last: LAST }).last, null, 'the last result hides while a new run is going');
  assert.equal(view({ last: { ...LAST, checklist: [] } }).last.counts, '파일 3개 · 덧붙음 57번');
});

test('privacy: nothing but counts, known ids and a plain file name reaches the view', () => {
  const BAIT = 'BAIT-7d1e';
  const raw = status({
    cwd: `/Users/${BAIT}/repo`, title: BAIT, prompt: BAIT, sessionId: `${BAIT}-uuid`,
    agents: { grok: true, codex: true, model: BAIT },
    startedAt: `${BAIT} 2020`,
    checklist: [
      ...checklist({ 'grok-updates': 4 }),
      { id: `x-${BAIT}`, have: 1, need: 1, done: true, off: false },
      { id: 'grok-updates', have: BAIT, need: 20, label: BAIT },
      { id: 'codex-rollout', have: 1, need: 20, note: `/tmp/${BAIT}` },
    ],
    totals: { files: 1, appends: 2, name: BAIT },
    last: {
      file: `/Users/${BAIT}/.observe/observe-20261021-153000.jsonl`, endedAt: BAIT, dir: `/tmp/${BAIT}`,
      checklist: [{ id: BAIT, have: 1 }], totals: { files: BAIT, appends: 2, path: BAIT },
    },
  });
  const s = readStatus(raw);
  assert.equal(s.startedAt, null, 'a lenient Date.parse string is not an ISO time');
  for (const v of [observeView(s), observeView(s, { elapsedMs: 5000 })]) {
    const out = JSON.stringify(v);
    assert.ok(!out.includes(BAIT), out);
    for (const p of ['/Users', '/tmp', '.observe/']) assert.ok(!out.includes(p), `no path (${p})`);
  }
  const v = observeView(s);
  assert.equal(v.last.file, null, 'a path is never shown');
  assert.equal(v.last.claude, null, 'no "read this file" line without a file name');
  assert.equal(v.last.counts, '파일 0개 · 덧붙음 2번');
  assert.equal(JSON.stringify(s).includes(BAIT), false, 'readStatus keeps only known fields');
});

test('postObserve sends POST /observe {action} as JSON and returns the status', async () => {
  const calls = [];
  const ok = async (url, init) => {
    calls.push([url, init]);
    return { ok: true, status: 200, json: async () => status({ running: true }) };
  };
  const r = await postObserve('start', ok);
  assert.deepEqual(calls, [['/observe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"start"}',
  }]]);
  assert.equal(r.status.running, true);
  assert.equal(r.error, undefined);
});

test('postObserve maps failures to a short panel message and never throws', async () => {
  const reply = (code, body = {}) => async () => ({ ok: code < 300, status: code, json: async () => body });
  assert.deepEqual(await postObserve('start', async () => { throw new Error('net down /secret/path'); }),
    { error: '관찰을 시작하지 못했어요. 서버에 연결하지 못했어요.' });
  assert.deepEqual(await postObserve('stop', reply(401)),
    { error: '관찰을 끝내지 못했어요. 인증이 풀렸어요. office-sim 이 알려 준 주소로 다시 열어 주세요.' });
  assert.match((await postObserve('start', reply(403))).error, /막았어요/);
  assert.match((await postObserve('start', reply(404))).error, /켜지 않았어요/);
  assert.equal((await postObserve('start', reply(400, { error: 'bad action /x' }))).error, '관찰을 시작하지 못했어요. 서버가 거절했어요 (400).');
  assert.match((await postObserve('start', reply(200, { hello: 1 }))).error, /응답을 읽지 못했어요/);
  const notJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  assert.match((await postObserve('start', notJson)).error, /응답을 읽지 못했어요/);
});

test('ObserveModel: the clock runs locally while observing and freezes when stopped', () => {
  let t = 1000;
  const m = new ObserveModel(() => t);
  assert.equal(m.apply({ type: 'config', intervalMs: 250 }), false);
  assert.equal(m.view().visible, false);
  assert.equal(m.apply(status({ running: true, elapsedMs: 5000 })), true);
  t = 8000;
  assert.equal(m.elapsed(), 12000);
  assert.equal(m.view().button.text, '관찰 중 · 00:12');
  m.apply(status({ running: false, elapsedMs: 9000, last: LAST }));
  t = 60000;
  assert.equal(m.elapsed(), 9000);
  m.reset();
  assert.equal(m.view().visible, false);
});

test('ObserveModel.send: busy right away, ignores repeats and the wrong action, keeps a newer SSE status', async () => {
  const m = new ObserveModel(() => 0);
  const never = () => assert.fail('must not post');
  assert.equal(await m.send('start', never), false, 'no status yet');
  m.apply(status());
  assert.equal(await m.send('stop', never), false, 'stop while stopped');
  let resolve;
  const post = (action) => {
    assert.equal(action, 'start');
    return new Promise((r) => { resolve = r; });
  };
  const sent = m.send('start', post);
  assert.equal(m.busy, 'start');
  assert.deepEqual(m.view().action, { kind: 'start', label: '시작하는 중…', primary: true, disabled: true });
  assert.equal(await m.send('start', never), false, 'a second click while busy does nothing');
  m.apply(status({ running: true, elapsedMs: 1000, checklist: checklist({ 'grok-updates': 2 }) })); // SSE 가 먼저 온다
  resolve({ status: status({ running: true, elapsedMs: 0 }) });
  assert.equal(await sent, true);
  assert.equal(m.busy, null);
  assert.equal(m.status.elapsedMs, 1000, 'the late POST reply does not roll back the newer status');
  assert.equal(m.status.checklist[0].have, 2);

  const m2 = new ObserveModel(() => 0);
  m2.apply(status());
  assert.equal(await m2.send('start', async () => ({ status: status({ running: true, elapsedMs: 7000 }) })), true);
  assert.equal(m2.status.running, true, 'the POST reply is applied when nothing newer came');
  assert.equal(m2.view().action.label, '지금 끝내기');
});

test('ObserveModel.send: errors show in the view and clear when the observation starts or stops', async () => {
  const m = new ObserveModel(() => 0);
  m.apply(status());
  assert.equal(await m.send('start', async () => ({ error: '관찰을 시작하지 못했어요. 서버에 연결하지 못했어요.' })), false);
  assert.equal(m.busy, null);
  assert.equal(m.view().error, '관찰을 시작하지 못했어요. 서버에 연결하지 못했어요.');
  assert.equal(m.view().action.disabled, false, 'can try again');
  m.apply(status()); // 같은 상태: 오류는 남는다
  assert.ok(m.view().error);
  m.apply(status({ running: true }));
  assert.equal(m.view().error, null);
  assert.equal(await m.send('stop', async () => { throw new Error('boom'); }), false);
  assert.equal(m.view().error, '관찰 요청을 보내지 못했어요.');
  const off = new ObserveModel(() => 0);
  off.apply(status({ available: false }));
  assert.equal(await off.send('start', () => assert.fail('must not post')), false);
});

// ---- LiveSource: observe 메시지는 onObserve 로만 간다 ----

test('LiveSource routes observe frames to onObserve and never to the office or the tail counter', () => {
  const saved = { es: globalThis.EventSource, raf: globalThis.requestAnimationFrame };
  let es = null;
  let frames = 0;
  globalThis.EventSource = class { constructor(url) { this.url = url; es = this; } close() {} };
  globalThis.requestAnimationFrame = () => { frames += 1; return 1; };
  try {
    const emitted = [];
    const seen = [];
    const configs = [];
    const src = new LiveSource((ev) => emitted.push(ev), () => {});
    src.onConfig = (m) => configs.push(m);
    src.onObserve = (m) => seen.push(m);
    src.start();
    assert.equal(es.url, '/events');
    const frame = (msg) => es.onmessage({ data: JSON.stringify(msg) });
    frame({ type: 'config', intervalMs: 250 });
    frame(status({ running: true }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].running, true);
    assert.equal(configs.length, 1);
    assert.deepEqual(emitted, []);
    assert.equal(frames, 0, 'no tail flash for a control message');
    src.onObserve = undefined;
    frame(status());
    assert.deepEqual(emitted, [], 'without a handler the frame is dropped, not sent to the office');
    frame({ type: 'say', sessionId: 's', text: 'hi' });
    assert.equal(emitted.length, 1, 'other events still go to the office');
    assert.equal(frames, 1);
  } finally {
    globalThis.EventSource = saved.es;
    globalThis.requestAnimationFrame = saved.raf;
  }
});

// ---- office.html: 버튼, 패널, 720px 배치 ----

test('office.html: the observe button and panel start hidden, carry every data-ob part and fit the 720 px grid', () => {
  const html = readFileSync(new URL('../public/office.html', import.meta.url), 'utf8');
  assert.ok(html.split('\n').length < 500, 'office.html stays under 500 lines');
  const btn = html.match(/<button[^>]*id="toggle-observe"[^>]*>/)?.[0];
  assert.ok(btn, 'button exists');
  for (const a of [' hidden', 'aria-pressed="false"', 'aria-controls="observe"', 'class="ghost"']) assert.ok(btn.includes(a), a);
  const panel = html.match(/<section id="observe"[^>]*>/)?.[0];
  assert.ok(panel?.includes(' hidden') && panel.includes('class="panel"'), 'panel starts hidden and uses the panel style');
  const parts = [...html.matchAll(/data-ob="([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(parts, [...PANEL_PARTS].sort());
  assert.ok(html.includes('평소처럼 Grok·Codex 를 쓰면 기록이 덧붙는 모양만 셉니다. 내용은 남기지 않아요.'));
  const narrow = html.slice(html.indexOf('@media (max-width: 720px)'));
  const rows = narrow.match(/grid-template-rows: ([^;]+);/)[1].trim().split(/\s+(?![^(]*\))/);
  const placed = ['observe', 'legend', 'log', 'inspector'].map((id) => Number(narrow.match(new RegExp(`#${id} \\{[^}]*grid-row: (\\d+)`))[1]));
  assert.equal(new Set(placed).size, placed.length, 'each narrow panel has its own row');
  assert.ok(placed.every((r) => r <= rows.length), `rows ${placed} within ${rows.length}`);
});

// ---- 리뷰 수정: 연결 끊김, 버튼 이름과 툴팁, 720px 배치, 알림 자리 ----

test('observeView: the top-bar button keeps a stable accessible name and its tooltips say what pressing it does', () => {
  assert.equal(view().button.label, '기록 관찰');
  assert.equal(view({ available: false }).button.label, '기록 관찰');
  const running = view({ running: true, elapsedMs: 12000 });
  assert.equal(running.button.label, '기록 관찰, 관찰 중', 'no ticking clock in the name');
  assert.equal(running.button.title, '기록 관찰 중이에요. 눌러서 패널을 열고 닫아요.');
  const ready = view({ running: true, ready: true, checklist: checklist(ALL_DONE) });
  assert.equal(ready.button.label, '기록 관찰, 충분히 모였어요');
  assert.equal(ready.button.title, "충분히 모였어요. 패널의 '관찰 끝내기' 를 눌러 끝내세요.");
});

test('ObserveModel: a lost connection freezes the clock, blocks the button and says so; the next status replaces it', async () => {
  let t = 1000;
  const m = new ObserveModel(() => t);
  m.setConnected(false); // 상태가 오기 전: 아무것도 바뀌지 않는다
  assert.equal(m.view().visible, false);
  m.apply(status({ running: true, elapsedMs: 5000 }));
  t = 3000;
  m.setConnected(false);
  t = 60000;
  assert.equal(m.elapsed(), 7000, 'the clock stops at the disconnect');
  let v = m.view();
  assert.equal(v.clock, '00:07');
  assert.equal(v.stateText, TEXT.disconnected);
  assert.equal(v.action.disabled, true);
  assert.equal(v.note, null);
  assert.equal(await m.send('stop', () => assert.fail('must not post while disconnected')), false);
  m.setConnected(true);
  assert.equal(m.view().stateText, TEXT.disconnected, 'still the old status until a new one arrives');
  m.apply(status({ running: false, last: null })); // 서버가 다시 떴다: 앞의 관찰은 요약 없이 끊겼다
  v = m.view();
  assert.equal(v.stateText, TEXT.cutOff);
  assert.equal(v.action.disabled, false);
  m.apply(status({ running: true }));
  assert.equal(m.view().stateText, '관찰 중이에요. 체크리스트가 다 차면 알려 드려요.');
  m.apply(status({ running: false, last: LAST }));
  assert.equal(m.view().stateText, '관찰을 끝냈어요. 다시 시작하면 새 파일에 모아요.', 'a normal stop is not a cut-off');
  const blip = new ObserveModel(() => 0); // 서버는 그대로이고 연결만 잠깐 끊긴 경우
  blip.apply(status({ running: true }));
  blip.setConnected(false);
  blip.apply(status({ running: true, elapsedMs: 9000 }));
  assert.equal(blip.view().stateText, '관찰 중이에요. 체크리스트가 다 차면 알려 드려요.');
});

test('main wiring: the connection state of the live source reaches the observe panel', () => {
  const hud = readFileSync(new URL('../public/js/hud.js', import.meta.url), 'utf8');
  const setSource = hud.slice(hud.indexOf('  setSource(state) {'), hud.indexOf('  flashTail('));
  assert.match(setSource, /this\.observe\.setConnected\(state !== 'retry'\)/);
  assert.match(hud, /new ObservePanel\(\$\('toggle-observe'\), \$\('observe'\), \{ announce: \$\('observe-announce'\) \}\)/);
});

test('office.html: at 720 px the panel is bounded to its row; the button has a stable name; an announcer sits outside the panel', () => {
  const html = readFileSync(new URL('../public/office.html', import.meta.url), 'utf8');
  const narrow = html.slice(html.indexOf('@media (max-width: 720px)'));
  const rule = narrow.match(/#observe \{([^}]*)\}/)[1];
  assert.match(rule, /align-self: stretch/, 'an auto row may shrink below the panel; stretch keeps the panel inside it');
  assert.match(rule, /max-height: 45vh/);
  assert.match(html, /<button[^>]*id="toggle-observe"[^>]*aria-label="기록 관찰"/);
  const announce = html.match(/<p id="observe-announce"[^>]*>/)?.[0];
  assert.ok(announce?.includes('aria-live="polite"') && announce.includes('class="sr-only"'), announce);
  const panel = html.slice(html.indexOf('<section id="observe"'), html.indexOf('</section>', html.indexOf('<section id="observe"')));
  assert.equal(panel.includes('observe-announce'), false, 'outside the panel (a hidden panel announces nothing)');
  assert.match(html, /\.ghost:disabled, \.ghost\[aria-disabled="true"\] \{/);
});
