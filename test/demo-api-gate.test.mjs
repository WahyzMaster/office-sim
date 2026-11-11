// Demo sessions never reach the server (launch readiness F1, contract 9.1): the page posts to /api/recap/review and
// /api/focus-terminal only for a session the server knows. That is false in demo mode (the hosted page, #demo: the
// source is not the LiveSource, `isLive()` false) and for the sessions of the first-run demo, whose events carry
// `demo: true` while the source stays live. Fake DOM and a recording fetch only: no browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installAgentExtras, extrasText } from '../public/js/agent-extras.js';
import { installSystemNotifications } from '../public/js/system-notify.js';

const settle = () => new Promise((r) => setImmediate(r));

function recorder(answer = { ok: true }) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push([opts.method ?? 'GET', url, opts.body ? JSON.parse(opts.body) : null]);
    return { ok: true, json: async () => answer };
  };
  return { calls, fetchFn };
}

function extrasSetup(opts = {}) {
  const el = () => ({ dataset: {}, style: {}, children: [], appendChild() {}, append() {}, setAttribute() {}, addEventListener() {}, querySelector: () => null });
  const doc = { getElementById: () => null, createElement: el, head: { appendChild() {} } };
  const selected = [];
  const office = { onEvent() {}, update() {}, select(a) { selected.push(a?.id ?? null); }, agents: new Map(), selected: null };
  const { calls, fetchFn } = recorder({ ok: true, target: 'Terminal' });
  const extras = installAgentExtras({ office, hud: { lang: 'en', el: {} }, doc, win: { addEventListener() {} }, fetchFn, ...opts });
  const agent = (id) => {
    const bubbles = [];
    const a = { id, name: id, bubbles, bubble(kind, text) { bubbles.push([kind, text]); } };
    return a;
  };
  return { office, extras, calls, selected, agent };
}
// a finished turn leaves the "done" badge: selecting the character is what posts the review
const finishTurn = (office, sessionId, demo) => {
  for (const type of ['prompt', 'turn_end']) office.onEvent({ type, sessionId, ...(demo ? { demo: true } : {}) });
};

test('a real session: selecting a finished character posts /api/recap/review, focus posts /api/focus-terminal', async () => {
  for (const opts of [{ isLive: () => true }, {}]) { // {}: a caller that passes no isLive is live, as before
    const s = extrasSetup(opts);
    finishTurn(s.office, 'real-1', false);
    s.office.select(s.agent('real-1'));
    await settle();
    assert.deepEqual(s.calls, [['POST', '/api/recap/review', { sessionId: 'real-1' }]]);
    assert.deepEqual(s.selected, ['real-1'], 'the office still selects');
    const a = s.agent('real-1');
    assert.deepEqual(await s.extras.requestTerminalFocus(a), { ok: true, target: 'Terminal' });
    assert.deepEqual(s.calls.at(-1), ['POST', '/api/focus-terminal', { sessionId: 'real-1' }]);
    assert.deepEqual(a.bubbles, [['info', extrasText('en').focusedMsg('Terminal')]]);
  }
});

test('demo mode (the hosted page, #demo: not live): no /api/recap/review and no /api/focus-terminal', async () => {
  const s = extrasSetup({ isLive: () => false });
  finishTurn(s.office, 'demo-auth', false); // the stand-alone demo source does not mark its events
  s.office.select(s.agent('demo-auth'));
  const a = s.agent('demo-auth');
  assert.deepEqual(await s.extras.requestTerminalFocus(a), { ok: false });
  await settle();
  assert.deepEqual(s.calls, [], 'there is no server to ask');
  assert.deepEqual(s.selected, ['demo-auth'], 'selecting still works');
  assert.equal(s.extras.metricsBySid.get('demo-auth').unreviewedDone, false, 'the badge is still cleared on the page');
  assert.deepEqual(a.bubbles, [['denied', extrasText('en').focusFailMsg]], 'the existing "not found" bubble, no new text');
});

test('the first-run demo (live source, events marked demo): its sessions are never sent to the server', async () => {
  const s = extrasSetup({ isLive: () => true });
  finishTurn(s.office, 'demo-auth', true);
  s.office.select(s.agent('demo-auth'));
  const a = s.agent('demo-auth');
  assert.deepEqual(await s.extras.requestTerminalFocus(a), { ok: false });
  await settle();
  assert.deepEqual(s.calls, [], 'the server is there, but it does not know a demo session');
  assert.deepEqual(a.bubbles, [['denied', extrasText('en').focusFailMsg]]);
  // a real session next to it (or after the demo ended) is sent as usual
  finishTurn(s.office, 'real-1', false);
  s.office.select(s.agent('real-1'));
  await settle();
  assert.deepEqual(s.calls, [['POST', '/api/recap/review', { sessionId: 'real-1' }]]);
  // an id is a demo session only while its events say so: a real session event under the same id is real
  s.office.onEvent({ type: 'session', sessionId: 'demo-auth' });
  finishTurn(s.office, 'demo-auth', false);
  s.office.select(s.agent('demo-auth'));
  await settle();
  assert.deepEqual(s.calls.at(-1), ['POST', '/api/recap/review', { sessionId: 'demo-auth' }]);
});

function notifySetup(opts = {}) {
  const shown = [];
  const btn = { setAttribute() {}, addEventListener() {} };
  const doc = { hidden: true, getElementById: () => null, querySelector: () => null, createElement: () => btn };
  const map = new Map([['office-sim:v1', JSON.stringify({ notify: true })]]);
  const win = {
    localStorage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) },
    Notification: class { constructor(title) { this.title = title; shown.push(this); } },
    addEventListener() {},
    focus() {},
  };
  win.Notification.permission = 'granted';
  const { calls, fetchFn } = recorder({ ok: true, enabled: false, supported: false });
  const office = { agents: new Map(), onEvent() {} };
  installSystemNotifications({ office, hud: { lang: 'en' }, doc, win, fetchFn, ...opts });
  return { office, shown, calls };
}
const ASK = { type: 'tool_start', sessionId: 'sess-1', tool: 'AskUserQuestion', question: 'Open a PR?' };

test('a clicked browser notification asks the server to focus the terminal only in live mode', async () => {
  const live = notifySetup({ isLive: () => true });
  await settle();
  live.office.onEvent(ASK);
  assert.equal(live.shown.length, 1);
  const before = live.calls.length;
  live.shown[0].onclick();
  await settle();
  assert.deepEqual(live.calls.slice(before), [['POST', '/api/focus-terminal', { sessionId: 'sess-1' }]]);

  const demo = notifySetup({ isLive: () => false });
  await settle();
  demo.office.onEvent(ASK); // the stand-alone demo: its events are not marked, so the fallback may announce them
  assert.equal(demo.shown.length, 1);
  demo.shown[0].onclick();
  await settle();
  assert.deepEqual(demo.calls, [], 'no /api/notify and no /api/focus-terminal without a server');
});

test('main wiring: the inspector extras get isLive', () => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /const extras = installAgentExtras\(\{ stage, office, hud, THREE, isLive \}\);/);
  assert.ok(main.indexOf('const isLive = ') < main.indexOf('installAgentExtras('), 'isLive is defined before it is handed over');
});
