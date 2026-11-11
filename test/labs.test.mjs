// 관리자용 도구 스위치 (launch readiness D10) 와 데모 모드의 조용한 네트워크: public/js/labs.js 의 순수 결정,
// 그리고 플라이휠 버튼, RCI·렌즈 알약, 알림 동기화가 labs / isLive 신호를 따르는지. 가짜 DOM 과 기록하는 fetch 만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLabsParam, readLabsPref, resolveLabs, initLabs, isLabs, LABS_CLASS } from '../public/js/labs.js';
import { STORE, LEGACY_STORE, loadPrefs } from '../public/js/hud.js';
import { installFlywheelPanel } from '../public/js/flywheel-panel.js';
import { installSimOverlays } from '../public/js/sim-overlays.js';
import { installSimFlywheelViz } from '../public/js/sim-flywheel-viz.js';
import { installSystemNotifications } from '../public/js/system-notify.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); } };
}

// ---- 순수 결정 ----

test('parseLabsParam: ?labs=1 turns it on, ?labs=0 turns it off, anything else has no say', () => {
  assert.equal(parseLabsParam('?labs=1'), true);
  assert.equal(parseLabsParam('?lang=en&labs=1'), true);
  assert.equal(parseLabsParam('?labs=true'), true);
  assert.equal(parseLabsParam('?labs=on'), true);
  assert.equal(parseLabsParam('?labs=0'), false);
  assert.equal(parseLabsParam('?labs=false'), false);
  assert.equal(parseLabsParam('?labs=off'), false);
  for (const none of ['', '?', '?lang=en', '?labs', '?labs=', '?labs=2', '?labs=yes%20please', '?xlabs=1', undefined, null]) {
    assert.equal(parseLabsParam(none), null, String(none));
  }
});

test('resolveLabs: off by default; ?labs=1 is remembered in the office-sim:v1 preferences; ?labs=0 forgets it', () => {
  assert.equal(STORE, 'office-sim:v1');
  const storage = fakeStorage({ [STORE]: JSON.stringify({ lang: 'en', soundOn: true }) });
  assert.equal(resolveLabs({ search: '', storage }), false, 'off unless asked for');
  assert.deepEqual(JSON.parse(storage.map.get(STORE)), { lang: 'en', soundOn: true }, 'reading writes nothing');

  assert.equal(resolveLabs({ search: '?labs=1', storage }), true);
  assert.deepEqual(JSON.parse(storage.map.get(STORE)), { lang: 'en', soundOn: true, labs: true }, 'the other preferences stay');
  assert.equal(readLabsPref(storage), true);
  assert.equal(loadPrefs(storage).labs, true, 'the Hud loads it with the rest, so its own saves keep it');
  assert.equal(resolveLabs({ search: '', storage }), true, 'the saved preference alone turns it on');
  assert.equal(resolveLabs({ search: '?lang=ko', storage }), true);

  assert.equal(resolveLabs({ search: '?labs=0', storage }), false);
  assert.deepEqual(JSON.parse(storage.map.get(STORE)), { lang: 'en', soundOn: true }, 'the key is removed, not stored as false');
  assert.equal(resolveLabs({ search: '', storage }), false);
});

test('resolveLabs: only a saved true counts; broken or missing storage is simply off and never throws', () => {
  for (const saved of [{ labs: 'true' }, { labs: 1 }, { labs: false }, {}, null, [], 'x']) {
    assert.equal(readLabsPref(fakeStorage({ [STORE]: JSON.stringify(saved) })), false, JSON.stringify(saved));
  }
  assert.equal(readLabsPref(fakeStorage({ [STORE]: '{not json' })), false);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(resolveLabs({ search: '', storage: throwing }), false);
  assert.equal(resolveLabs({ search: '?labs=1', storage: throwing }), true, 'the URL still works for this page load');
  assert.equal(resolveLabs({ search: '?labs=1', storage: null }), true);
  assert.equal(resolveLabs({ search: '', storage: null }), false);
});

test('resolveLabs: saving the flag first does not hide preferences still under the old claude-office key', () => {
  const storage = fakeStorage({ [LEGACY_STORE]: JSON.stringify({ roomTheme: 'hanok' }) });
  assert.equal(resolveLabs({ search: '?labs=1', storage }), true);
  assert.deepEqual(JSON.parse(storage.map.get(STORE)), { roomTheme: 'hanok', labs: true });
  assert.equal(loadPrefs(storage).roomTheme, 'hanok');
});

test('initLabs: sets the body class and isLabs() for this page load', () => {
  const classes = new Set();
  const doc = { body: { classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } } } };
  assert.equal(LABS_CLASS, 'labs');
  assert.equal(initLabs({ search: '', storage: fakeStorage(), doc }), false);
  assert.equal(isLabs(), false);
  assert.equal(classes.has('labs'), false);
  assert.equal(initLabs({ search: '?labs=1', storage: fakeStorage(), doc }), true);
  assert.equal(isLabs(), true);
  assert.equal(classes.has('labs'), true);
  assert.equal(initLabs({ search: '?labs=0', storage: fakeStorage(), doc }), false);
  assert.equal(classes.has('labs'), false);
  assert.doesNotThrow(() => initLabs({ search: '?labs=1', storage: null, doc: null }));
  initLabs({ search: '', storage: null, doc: null });
});

// ---- 가짜 DOM (flywheel-panel / sim-studio 테스트와 같은 모양) ----

function fakeDom() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    return {
      tagName: String(tag).toUpperCase(), id: '', className: '', textContent: '', title: '', hidden: false, disabled: false,
      dataset: {}, style: {}, attributes: new Map(), children: [],
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) ?? null; },
      appendChild(c) { if (c?.id) byId.set(c.id, c); this.children.push(c); return c; },
      insertBefore(c) { return this.appendChild(c); },
      append(...n) { for (const c of n) this.appendChild(c); },
      replaceChildren(...n) { this.children = []; for (const c of n) this.appendChild(c); },
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      dispatch(type, ev = {}) { for (const fn of listeners.get(type) ?? []) fn(ev); },
    };
  };
  const hudRoot = Object.assign(make('div'), { id: 'hud' });
  byId.set('hud', hudRoot);
  const controls = Object.assign(make('div'), { className: 'controls' });
  const doc = {
    head: make('head'), body: make('body'), hidden: true,
    createElement: make,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) => (sel === '.bar .controls' ? controls : null),
  };
  const winListeners = new Map();
  const win = {
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener(type, fn) { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    dispatch(type, ev = {}) { for (const fn of winListeners.get(type) ?? []) fn(ev); },
  };
  return { doc, win, controls, byId };
}
const key = (k) => ({ key: k, target: {}, preventDefault() {} });
function recorder(body = {}) {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push([init?.method ?? 'GET', url]); return { ok: true, json: async () => body }; };
  return { calls, fetchFn };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- 플라이휠 버튼과 패널 ----

test('flywheel panel: with labs off the button is hidden, Y does nothing and no /api/flywheel request is made', async () => {
  const { doc, win, byId } = fakeDom();
  const { calls, fetchFn } = recorder();
  const api = installFlywheelPanel({ hud: { lang: 'en' }, source: {}, doc, win, fetchFn, labs: false });
  await settle();
  const btn = byId.get('flywheel-toggle');
  assert.ok(btn, 'the feature is still there');
  assert.equal(btn.hidden, true);
  assert.equal(byId.get('flywheel-panel').hidden, true);
  win.dispatch('keydown', key('y'));
  assert.equal(api.open, false, 'the shortcut is a labs tool too');
  await api.triggerScan();
  await settle();
  assert.deepEqual(calls, [], 'no scan at load, none on demand');
});

test('flywheel panel: with labs on it scans at load as before; in demo mode (not live) it stays silent', async () => {
  const on = fakeDom();
  const live = recorder();
  const apiOn = installFlywheelPanel({ hud: { lang: 'en' }, source: {}, doc: on.doc, win: on.win, fetchFn: live.fetchFn, labs: true, isLive: () => true });
  await settle();
  assert.equal(on.byId.get('flywheel-toggle').hidden, false);
  assert.deepEqual(live.calls, [['GET', '/api/flywheel?scan=1']]);
  on.win.dispatch('keydown', key('y'));
  assert.equal(apiOn.open, true);

  const demo = fakeDom();
  const quiet = recorder();
  const apiDemo = installFlywheelPanel({ hud: { lang: 'en' }, source: {}, doc: demo.doc, win: demo.win, fetchFn: quiet.fetchFn, labs: true, isLive: () => false });
  await settle();
  assert.equal(demo.byId.get('flywheel-toggle').hidden, false, 'labs still shows the button in the demo');
  demo.win.dispatch('keydown', key('y')); // 패널을 열면 스캔을 시도한다
  await apiDemo.triggerScan();
  await settle();
  assert.equal(apiDemo.open, true);
  assert.deepEqual(quiet.calls, [], 'the hosted page and #demo have no /api/flywheel');
});

// ---- RCI · 렌즈 알약 ----

test('sim overlays: with labs off the RCI and Lens pill is hidden and V does nothing; the Tune toggle stays', () => {
  const { doc, win, byId, controls } = fakeDom();
  const office = { floors: [], agents: new Map(), onEvent() {} };
  const ctl = installSimOverlays({ office, hud: { lang: 'en' }, doc, win, labs: false });
  assert.equal(byId.get('sim-hud-pill').hidden, true);
  const more = byId.get('sim-more-toggle');
  assert.ok(more, 'Tune is not maintainer tooling');
  assert.notEqual(more.hidden, true);
  assert.equal(more.textContent, 'Tune');
  more.dispatch('click');
  assert.equal(controls.dataset.more, 'open');
  win.dispatch('keydown', key('v'));
  assert.equal(ctl.mode, 'normal', 'no lens can be switched on without its control');
  office.onEvent({ sessionId: 'a1', type: 'tool_start', tool: 'Edit' });
  assert.equal(byId.get('sim-hud-pill').hidden, true, 'live events do not bring it back');
});

test('sim overlays: with labs on (and by default) the pill shows and V cycles the lens', () => {
  for (const opts of [{ labs: true }, {}]) {
    const { doc, win, byId } = fakeDom();
    const ctl = installSimOverlays({ office: { floors: [], agents: new Map(), onEvent() {} }, hud: { lang: 'en' }, doc, win, ...opts });
    assert.notEqual(byId.get('sim-hud-pill').hidden, true);
    win.dispatch('keydown', key('v'));
    assert.equal(ctl.mode, 'heatmap');
  }
});

test('flywheel conveyor: its buttons post nothing with labs off or in demo mode', async () => {
  for (const [opts, expected] of [[{ labs: false }, 0], [{ labs: true, isLive: () => false }, 0], [{ labs: true, isLive: () => true }, 1]]) {
    const { doc, win, byId } = fakeDom();
    const office = { floors: [], agents: new Map(), onEvent() {}, update() {} };
    const overlays = installSimOverlays({ office, hud: { lang: 'en' }, doc, win });
    const { calls, fetchFn } = recorder();
    installSimFlywheelViz({ office, hud: { lang: 'en' }, overlays, doc, fetchFn, ...opts });
    overlays.setMode('flywheel');
    const conveyor = byId.get('sim-flywheel-conveyor');
    const scanBtn = conveyor.children[0].children[1].children[0];
    assert.equal(scanBtn.dataset.step, '0');
    scanBtn.dispatch('click');
    await settle();
    assert.equal(calls.length, expected, JSON.stringify(Object.keys(opts)));
  }
});

// ---- 알림 동기화 ----

function notifySetup({ isLive, stored } = {}) {
  const storage = fakeStorage(stored ? { [STORE]: JSON.stringify(stored) } : {});
  const { doc, win, byId } = fakeDom();
  const shown = [];
  win.localStorage = storage;
  win.Notification = class { constructor(title) { shown.push(title); } };
  win.Notification.permission = 'granted';
  win.Notification.requestPermission = async () => 'granted';
  const { calls, fetchFn } = recorder({ ok: true, enabled: false, supported: false });
  const office = { agents: new Map(), onEvent() {} };
  const ctl = installSystemNotifications({ office, hud: { lang: 'en' }, doc, win, fetchFn, ...(isLive ? { isLive } : {}) });
  return { ctl, calls, win, byId, office, shown, storage };
}

test('notifications: in demo mode (not live) neither the load nor the toggle calls /api/notify; the choice is still saved', async () => {
  const s = notifySetup({ isLive: () => false });
  await settle();
  assert.deepEqual(s.calls, []);
  s.win.dispatch('keydown', key('n'));
  await settle();
  assert.equal(s.ctl.enabled, true);
  assert.equal(JSON.parse(s.storage.map.get(STORE)).notify, true);
  await s.ctl.syncToServer({ test: true });
  assert.deepEqual(s.calls, [], 'the hosted page and #demo have no /api/notify');
});

test('notifications: live (and by default) the load reads /api/notify and the toggle posts to it', async () => {
  for (const opts of [{ isLive: () => true }, {}]) {
    const s = notifySetup(opts);
    await settle();
    assert.deepEqual(s.calls, [['GET', '/api/notify']]);
    s.win.dispatch('keydown', key('n'));
    await settle();
    assert.deepEqual(s.calls.at(-1), ['POST', '/api/notify']);
  }
});

test('notifications: events of the first-run demo are never announced as if an agent needed you', async () => {
  const s = notifySetup({ isLive: () => true, stored: { notify: true } });
  await settle();
  const ask = { type: 'tool_start', sessionId: 'demo-auth', tool: 'AskUserQuestion', question: 'Open a PR?' };
  s.office.onEvent({ ...ask, demo: true });
  assert.deepEqual(s.shown, [], 'a demo question is not a real one');
  s.office.onEvent({ ...ask, sessionId: 'real-1' });
  assert.equal(s.shown.length, 1, 'the same event from a real session is announced');
});

// ---- 연결: main.js 와 office.html ----

test('main wiring: labs is resolved before the Hud loads its preferences and reaches the gated modules with isLive', () => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.ok(main.indexOf('initLabs()') > 0 && main.indexOf('initLabs()') < main.indexOf('new Hud()'),
    '?labs=1 must be saved before the Hud takes its in-memory copy of the preferences (it saves that copy wholesale)');
  assert.match(main, /const isLive = \(\) => source instanceof LiveSource;/);
  assert.match(main, /installSystemNotifications\(\{ office, hud, isLive \}\)/);
  assert.match(main, /installFlywheelPanel\(\{ hud, source, isLive, labs \}\)/);
  assert.match(main, /installSimOverlays\(\{ office, hud, extras, THREE, labs \}\)/);
  assert.match(main, /installSimFlywheelViz\(\{ office, hud, source, overlays, THREE, isLive, labs \}\)/);
});

test('office.html: the tail-interval input is hidden unless the body carries the labs class', () => {
  const html = readFileSync(new URL('../public/office.html', import.meta.url), 'utf8');
  assert.match(html, /body:not\(\.labs\) label\[for="interval"\] \{ display: none; \}/);
  assert.match(html, /<label class="interval" for="interval">tail <input id="interval"/, 'the control itself is still there');
});
