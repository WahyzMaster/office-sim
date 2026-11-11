// 첫 실행의 빈 사무실 (launch readiness D6, 페이지 쪽): public/js/empty-state.js 의 순수 결정(firstRunStep), 배너 문구,
// 그리고 가짜 office / hud / 데모 공급원으로 따라가는 조종기(createFirstRun). 브라우저도 서버도 띄우지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GRACE_S, DEFAULT_ACTIVE_MINUTES, FIRST_RUN_START, firstRunStep, hasSession, emptyBannerText, createFirstRun,
} from '../public/js/empty-state.js';
import { Hud } from '../public/js/hud.js';
import { uiText } from '../public/js/rooms.js';

const SESSION = { type: 'session', sessionId: 'real-1', agent: 'claude-code', project: '/repo/app' };
const TOOL = { type: 'tool_start', sessionId: 'real-1', toolUseId: 't1', tool: 'Read' };

// 입력을 차례로 넣고 마지막 상태와 그동안의 동작을 돌려준다.
function run(inputs, start = FIRST_RUN_START) {
  let state = start;
  const actions = [];
  for (const input of inputs) {
    const r = firstRunStep(state, input);
    state = r.state;
    actions.push(r.action);
  }
  return { state, actions };
}
const emptySnap = { type: 'snapshot', hasSession: false, partial: false };
const fullSnap = { type: 'snapshot', hasSession: true, partial: false };
const liveConfig = { type: 'config', replay: false };
const tick = (dt) => ({ type: 'tick', dt });

// ---- 순수 결정 ----

test('hasSession: true only when the snapshot carries a session event', () => {
  assert.equal(hasSession([]), false);
  assert.equal(hasSession(undefined), false);
  assert.equal(hasSession([TOOL, { type: 'plan' }]), false);
  assert.equal(hasSession([TOOL, SESSION]), true);
  assert.equal(hasSession([null, 'x', SESSION]), true);
});

test('firstRunStep: an empty complete snapshot plus a live config starts the demo only after the grace time', () => {
  const armed = run([emptySnap]);
  assert.equal(armed.state.phase, 'armed', 'the snapshot alone decides nothing: the config says whether this is a replay');
  assert.deepEqual(armed.actions, ['apply']);
  const grace = run([liveConfig], armed.state);
  assert.equal(grace.state.phase, 'grace');
  assert.deepEqual(grace.actions, [null]);
  const early = run([tick(GRACE_S / 2)], grace.state);
  assert.equal(early.state.phase, 'grace');
  assert.deepEqual(early.actions, [null]);
  const due = run([tick(GRACE_S / 2), tick(0.016)], early.state);
  assert.equal(due.state.phase, 'demo');
  assert.equal(due.actions.filter((a) => a === 'start').length, 1, 'the demo starts exactly once');
  assert.deepEqual(run([tick(5), tick(5)], due.state).actions, [null, null], 'no second start');
});

test('firstRunStep: a session inside the grace time goes live and the demo never starts', () => {
  const grace = run([emptySnap, liveConfig, tick(0.2)]).state;
  const byEvent = run([{ type: 'event', eventType: 'session' }, tick(10), emptySnap, tick(10)], grace);
  assert.equal(byEvent.state.phase, 'live');
  assert.deepEqual(byEvent.actions, ['apply', null, 'apply', null]);
  const bySnapshot = run([fullSnap, tick(10)], grace);
  assert.equal(bySnapshot.state.phase, 'live');
  assert.deepEqual(bySnapshot.actions, ['apply', null]);
});

test('firstRunStep: a first snapshot with a session is live for good (an office that empties later stays live)', () => {
  const r = run([fullSnap, liveConfig, tick(10), emptySnap, liveConfig, tick(10), { type: 'event', eventType: 'session_end' }, tick(10)]);
  assert.equal(r.state.phase, 'live');
  assert.equal(r.actions.includes('start'), false);
  assert.equal(r.actions.includes('switch'), false);
  assert.equal(r.actions.includes('ignore'), false, 'in live mode every snapshot reaches the office');
});

test('firstRunStep: replay mode never shows the demo, whichever of snapshot and config comes first', () => {
  const replayConfig = { type: 'config', replay: true };
  const a = run([emptySnap, replayConfig, tick(10), emptySnap, tick(10)]);
  assert.equal(a.state.phase, 'live');
  assert.equal(a.actions.includes('start'), false);
  const b = run([replayConfig, emptySnap, tick(10)]);
  assert.equal(b.state.phase, 'live');
  assert.equal(b.actions.includes('start'), false);
});

test('firstRunStep: a partial snapshot does not count; a complete one after a known live config goes straight to grace', () => {
  const partial = run([{ type: 'snapshot', hasSession: false, partial: true }, liveConfig, tick(10)]);
  assert.equal(partial.state.phase, 'wait', 'the server is still attaching files: nothing is decided');
  assert.equal(partial.actions.includes('start'), false);
  const later = run([emptySnap], partial.state);
  assert.equal(later.state.phase, 'grace', 'the config already said live, so no second config is needed');
  assert.equal(run([tick(GRACE_S + 0.1)], later.state).actions[0], 'start');
});

test('firstRunStep: other events before the first snapshot pass through and decide nothing', () => {
  const r = run([{ type: 'event', eventType: 'tool_start' }, tick(10)]);
  assert.equal(r.state.phase, 'wait');
  assert.deepEqual(r.actions, ['apply', null]);
});

test('firstRunStep: during the demo an empty snapshot is ignored and the first real session switches to live', () => {
  const demo = run([emptySnap, liveConfig, tick(GRACE_S + 0.1)]).state;
  assert.equal(demo.phase, 'demo');
  // 다시 붙은 서버의 빈 스냅샷이 사무실에 닿으면 데모 직원이 모두 퇴근한다: 넘기지 않는다
  const idle = run([emptySnap, { type: 'snapshot', hasSession: false, partial: true }, liveConfig,
    { type: 'event', eventType: 'tool_start' }, { type: 'event', eventType: 'session_end' }, tick(60)], demo);
  assert.equal(idle.state.phase, 'demo');
  assert.deepEqual(idle.actions, ['ignore', 'ignore', null, 'apply', 'apply', null]);
  const byEvent = run([{ type: 'event', eventType: 'session' }], demo);
  assert.equal(byEvent.state.phase, 'live');
  assert.deepEqual(byEvent.actions, ['switch']);
  const bySnapshot = run([fullSnap], demo);
  assert.equal(bySnapshot.state.phase, 'live');
  assert.deepEqual(bySnapshot.actions, ['switch']);
  // 한 번 라이브가 되면 끝: 다음 session 과 스냅샷은 그냥 지나간다
  assert.deepEqual(run([{ type: 'event', eventType: 'session' }, emptySnap, tick(60)], byEvent.state).actions, ['apply', 'apply', null]);
});

test('firstRunStep: never mutates the state it was given and tolerates junk input', () => {
  const frozen = Object.freeze({ ...FIRST_RUN_START });
  assert.doesNotThrow(() => firstRunStep(frozen, emptySnap));
  assert.deepEqual(firstRunStep(frozen, null), { state: frozen, action: null });
  assert.deepEqual(firstRunStep(frozen, { type: 'nope' }), { state: frozen, action: null });
  const grace = run([emptySnap, liveConfig]).state;
  assert.equal(firstRunStep(grace, tick(NaN)).state.phase, 'grace');
  assert.equal(firstRunStep(grace, tick(-5)).state.phase, 'grace');
});

// ---- 배너 문구 ----

test('emptyBannerText: Korean and English, with the --active window and the four agents', () => {
  assert.equal(DEFAULT_ACTIVE_MINUTES, 30);
  assert.equal(
    emptyBannerText('en'),
    'No agent session in the last 30 minutes. Start Claude Code, Codex, Grok or Antigravity and it appears here. This is a demo.',
  );
  const ko = emptyBannerText('ko');
  assert.match(ko, /30분/);
  assert.match(ko, /[가-힣]/);
  assert.match(ko, /데모/);
  for (const name of ['Claude Code', 'Codex', 'Grok', 'Antigravity']) assert.ok(ko.includes(name), name);
  assert.doesNotMatch(emptyBannerText('en', 45), /[가-힣]/);
  assert.match(emptyBannerText('en', 45), /last 45 minutes/);
  assert.match(emptyBannerText('ko', 45), /45분/);
  for (const bad of [0, -1, NaN, null, '10', Infinity]) assert.match(emptyBannerText('en', bad), /last 30 minutes/, String(bad));
});

// ---- 조종기: 가짜 office, hud, 문서 ----

function fakeDoc() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), id: '', className: '', textContent: '', title: '', hidden: false, children: [], attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { if (c.id) byId.set(c.id, c); this.children.push(c); return c; },
      replaceChildren(...n) { this.children = [...n]; },
    };
    return node;
  };
  const head = make('head');
  const body = make('body');
  const hudRoot = Object.assign(make('div'), { id: 'hud' });
  const logList = Object.assign(make('ol'), { id: 'log-list', children: ['old demo line', 'another'] });
  const chip = Object.assign(make('span'), { id: 'source' });
  for (const n of [hudRoot, logList, chip]) byId.set(n.id, n);
  return {
    head, body, hudRoot, logList, chip, byId,
    createElement: make,
    getElementById: (id) => byId.get(id) ?? null,
  };
}

function setup({ lang = 'en' } = {}) {
  const calls = [];
  const doc = fakeDoc();
  const office = {
    applySnapshot(events, meta) { calls.push(['applySnapshot', events, meta]); },
    onEvent(ev) { calls.push(['onEvent', ev]); },
    pruneEmptyFloors(keep) { calls.push(['pruneEmptyFloors', keep]); },
  };
  const hud = {
    lang,
    setSource(state) { calls.push(['setSource', state]); },
    renderFloors(o) { calls.push(['renderFloors', o === office]); },
    observe: { setConnected(on) { calls.push(['observe.setConnected', on]); } },
  };
  const demos = [];
  const makeDemo = () => {
    const demo = { ticks: [], langs: [], tick(...a) { this.ticks.push(a); }, setLang(l) { this.langs.push(l); } };
    demos.push(demo);
    return demo;
  };
  const ctl = createFirstRun({ office, hud, makeDemo, doc });
  const names = () => calls.map((c) => c[0]);
  const banner = () => doc.byId.get('empty-banner') ?? null;
  // 서버의 첫 연결: 열림 -> 스냅샷 -> config. 그 뒤 프레임이 grace 를 넘긴다.
  const startDemo = (minutes) => {
    ctl.onStatus('live');
    ctl.onSnapshot([], {});
    ctl.onConfig({ type: 'config', intervalMs: 250, ...(minutes ? { activeMinutes: minutes } : {}) });
    for (let t = 0; t < GRACE_S + 0.2; t += 0.1) ctl.tick(0.1, 0.1, 250);
  };
  return { ctl, calls, names, doc, office, hud, demos, banner, startDemo };
}

test('createFirstRun: an empty first snapshot shows the demo under the banner, with the chip as demo', () => {
  const s = setup();
  assert.equal(s.ctl.demoing, false);
  s.ctl.onStatus('live');
  assert.deepEqual(s.calls.at(-1), ['setSource', 'live']);
  assert.equal(s.ctl.onSnapshot([], {}), true, 'an empty snapshot before the demo still reaches the office');
  assert.deepEqual(s.calls.at(-1), ['applySnapshot', [], { partial: false, reset: false }]);
  s.ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30 });
  s.ctl.tick(0.1, 0.1, 250);
  assert.equal(s.demos.length, 0, 'not before the grace time');
  assert.equal(s.banner(), null);
  for (let t = 0; t < GRACE_S + 0.2; t += 0.1) s.ctl.tick(0.1, 0.1, 250);
  assert.equal(s.demos.length, 1);
  assert.equal(s.ctl.demoing, true);
  assert.equal(s.ctl.phase, 'demo');
  assert.deepEqual(s.calls.at(-1), ['setSource', 'demo']);
  const banner = s.banner();
  assert.ok(banner, 'the banner is in the document');
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, emptyBannerText('en', 30));
  assert.equal(banner.attrs.role, 'status');
  assert.ok(s.doc.hudRoot.children.includes(banner), 'inside #hud, so the overlay mode hides it with the rest');
  assert.equal(s.hud.demoNote('en'), emptyBannerText('en', 30), 'the chip tooltip does not tell a running server to be started');
  assert.equal(s.hud.demoNote('ko'), emptyBannerText('ko', 30));
  assert.deepEqual(s.doc.head.children.map((c) => c.id), ['empty-state-style'], 'its style is injected once');
  createFirstRun({ office: s.office, hud: s.hud, makeDemo: () => ({ tick() {} }), doc: s.doc });
  assert.equal(s.doc.head.children.length, 1, 'a second controller on the same document adds no second style');
  // 데모 공급원은 프레임마다 같은 dt 로 돈다
  s.ctl.tick(0.05, 0.05, 250);
  assert.deepEqual(s.demos[0].ticks.at(-1), [0.05, 0.05, 250]);
});

test('createFirstRun: the banner uses the --active window from the config and follows the language', () => {
  const s = setup({ lang: 'ko' });
  s.startDemo(45);
  assert.equal(s.banner().textContent, emptyBannerText('ko', 45));
  s.hud.lang = 'en';
  s.ctl.setLang('en');
  assert.equal(s.banner().textContent, emptyBannerText('en', 45));
  assert.deepEqual(s.demos[0].langs, ['en'], 'the demo sessions are re-labelled too');
  const n = s.calls.length;
  s.ctl.onConfig({ type: 'config', intervalMs: 500, activeMinutes: 10 });
  assert.equal(s.banner().textContent, emptyBannerText('en', 10));
  assert.equal(s.hud.demoNote('en'), emptyBannerText('en', 10));
  assert.deepEqual(s.calls.slice(n), [['setSource', 'demo']], 'the chip tooltip is refreshed for the new window');
});

test('createFirstRun: while the demo runs, reconnects keep the chip on demo and empty snapshots never reach the office', () => {
  const s = setup();
  s.startDemo();
  const before = s.calls.length;
  s.ctl.onStatus('retry');
  assert.deepEqual(s.calls.slice(before), [['setSource', 'demo'], ['observe.setConnected', false]]);
  s.ctl.onStatus('live');
  assert.deepEqual(s.calls.at(-1), ['setSource', 'demo']);
  const n = s.calls.length;
  assert.equal(s.ctl.onSnapshot([], {}), false);
  assert.equal(s.ctl.onSnapshot([], { reset: true }), false);
  s.ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30 });
  assert.equal(s.calls.length, n, 'a restarted server sends an empty snapshot: the demo staff must not be sent home');
  assert.equal(s.ctl.demoing, true);
  // session 이 아닌 라이브 이벤트는 그대로 사무실로 간다 (모르는 직원이라 맡겨 둘 뿐이다)
  s.ctl.onEvent(TOOL);
  assert.deepEqual(s.calls.at(-1), ['onEvent', TOOL]);
  assert.equal(s.ctl.demoing, true);
});

test('createFirstRun: the first real session event stops the demo, clears the office through the reset path, then shows it', () => {
  const s = setup();
  s.startDemo();
  const demo = s.demos[0];
  const ticksBefore = demo.ticks.length;
  const n = s.calls.length;
  s.ctl.onEvent(SESSION);
  assert.deepEqual(s.calls.slice(n), [
    ['applySnapshot', [], { reset: true }],
    ['pruneEmptyFloors', 0],
    ['renderFloors', true],
    ['setSource', 'live'],
    ['onEvent', SESSION],
  ]);
  assert.equal(s.ctl.demoing, false);
  assert.equal(s.ctl.phase, 'live');
  assert.equal(s.hud.demoNote, null, 'the chip tooltip is the usual one again');
  assert.equal(s.banner().hidden, true);
  assert.deepEqual(s.doc.logList.children, [], 'the demo lines leave the activity log');
  s.ctl.tick(0.1, 0.1, 250);
  assert.equal(demo.ticks.length, ticksBefore, 'the demo source is no longer driven');
  // 그 뒤는 평소의 라이브: 빈 스냅샷도 사무실로 가고 (직원 퇴근), 데모는 다시 시작하지 않는다
  assert.equal(s.ctl.onSnapshot([], {}), true);
  assert.deepEqual(s.calls.at(-1), ['applySnapshot', [], { partial: false, reset: false }]);
  for (let t = 0; t < 10; t += 0.1) s.ctl.tick(0.1, 0.1, 250);
  assert.equal(s.demos.length, 1);
  s.ctl.onStatus('retry');
  assert.deepEqual(s.calls.at(-1), ['setSource', 'retry']);
});

test('createFirstRun: a later snapshot with a session switches the same way and is then applied as given', () => {
  const s = setup();
  s.startDemo();
  const n = s.calls.length;
  const events = [SESSION, TOOL];
  assert.equal(s.ctl.onSnapshot(events, { partial: true }), true);
  assert.deepEqual(s.calls.slice(n), [
    ['applySnapshot', [], { reset: true }],
    ['pruneEmptyFloors', 0],
    ['renderFloors', true],
    ['setSource', 'live'],
    ['applySnapshot', events, { partial: true, reset: false }],
  ]);
  assert.equal(s.banner().hidden, true);
  assert.equal(s.ctl.demoing, false);
});

test('createFirstRun: a session that arrives inside the grace time is shown at once and no demo, banner or reset happens', () => {
  const s = setup();
  s.ctl.onStatus('live');
  s.ctl.onSnapshot([], {});
  s.ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30 });
  s.ctl.tick(0.3, 0.3, 250);
  s.ctl.onEvent(SESSION);
  assert.deepEqual(s.calls.at(-1), ['onEvent', SESSION]);
  for (let t = 0; t < 10; t += 0.1) s.ctl.tick(0.1, 0.1, 250);
  assert.equal(s.demos.length, 0);
  assert.equal(s.banner(), null);
  assert.equal(s.names().includes('pruneEmptyFloors'), false);
  assert.equal(s.calls.some((c) => c[0] === 'applySnapshot' && c[2]?.reset === true), false);
});

test('createFirstRun: a first snapshot with sessions and the replay mode never start the demo', () => {
  const live = setup();
  live.ctl.onStatus('live');
  assert.equal(live.ctl.onSnapshot([SESSION], {}), true);
  live.ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30 });
  for (let t = 0; t < 10; t += 0.1) live.ctl.tick(0.1, 0.1, 250);
  assert.equal(live.demos.length, 0);
  assert.equal(live.ctl.phase, 'live');

  const replay = setup();
  replay.ctl.onStatus('live');
  replay.ctl.onSnapshot([], {});
  replay.ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30, replay: { state: 'loading', speed: 1 } });
  for (let t = 0; t < 10; t += 0.1) replay.ctl.tick(0.1, 0.1, 250);
  assert.equal(replay.demos.length, 0);
  assert.equal(replay.banner(), null);
  // 재생의 seek 스냅샷(reset)은 그대로 넘어간다
  assert.equal(replay.ctl.onSnapshot([], { reset: true }), true);
  assert.deepEqual(replay.calls.at(-1), ['applySnapshot', [], { partial: false, reset: true }]);
});

test('Hud.setSource: the demo chip shows the first-run note as its tooltip while one is set, the usual text otherwise', () => {
  const chip = { dataset: {}, title: '', label: { textContent: '' }, querySelector() { return this.label; } };
  const hud = Object.assign(Object.create(Hud.prototype), { lang: 'en', el: { source: chip }, observe: { setConnected() {} } });
  hud.setSource('demo');
  assert.equal(chip.title, uiText('en').sourceTitle.demo);
  hud.demoNote = (lang) => emptyBannerText(lang, 45);
  hud.setSource('demo');
  assert.equal(chip.dataset.state, 'demo');
  assert.equal(chip.label.textContent, uiText('en').source.demo);
  assert.equal(chip.title, emptyBannerText('en', 45));
  hud.lang = 'ko'; // 언어나 공간 테마를 바꾸면 hud 가 setSource 를 다시 부른다: 그때도 같은 안내가 남는다
  hud.setSource('demo');
  assert.equal(chip.title, emptyBannerText('ko', 45));
  hud.setSource('live');
  assert.equal(chip.title, uiText('ko').sourceTitle.live, 'only the demo state uses the note');
  hud.demoNote = null;
  hud.setSource('demo');
  assert.equal(chip.title, uiText('ko').sourceTitle.demo);
});

// ---- main.js 연결 (브라우저 없이는 불러올 수 없어 글자로 확인한다) ----

test('main wiring: live mode keeps the LiveSource and drives the first-run controller; the demo never becomes the source', () => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ createFirstRun \} from '\.\/empty-state\.js';/);
  assert.match(main, /firstRun = createFirstRun\(\{ office, hud, makeDemo/);
  assert.match(main, /new LiveSource\(\(ev\) => firstRun\.onEvent\(ev\)/, 'live events pass through the controller');
  assert.match(main, /firstRun\.onSnapshot\(events, msg\)/);
  assert.match(main, /firstRun\.onConfig\(msg\)/);
  assert.match(main, /firstRun\?\.tick\(dt, realDt, cfg\.intervalMs\)/, 'the overlay demo ticks in the frame loop next to the live source');
  assert.match(main, /demo: true/, 'overlay demo events are marked so they are not announced as real');
  // #demo 와 로컬이 아닌 곳(호스팅 데모)은 예전 그대로 MockSource 가 공급원이다
  assert.match(main, /else if \(local && window\.location\.hash !== '#demo'\) \{/);
  assert.match(main, /\} else \{\n  startDemo\(\);\n\}/);
  const lines = main.split('\n').length;
  assert.ok(lines <= 500, `main.js is ${lines} lines`);
});
