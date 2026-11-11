// W7 (launch readiness, contract 9.5): public/js/needs-you.js counts the characters that wait on the human, shows the
// count in the tab title and in one top-bar chip, and cycles the selection through them.
// First the pure functions with hand-made agents, then the real Office and Agent classes (three.js replaced by a stub
// module, same loader as page-approval-hooks.test.mjs) with a fake document: no browser, no server.
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
const { BASE_TITLE, needsYouTitle, waitsOnHuman, waitingAgents, nextWaiting, needsYouText, trackDemo, installNeedsYou } = await import('../public/js/needs-you.js');

const settle = () => new Promise((r) => setImmediate(r));

// ---- pure functions -------------------------------------------------------------------------------------------

// intents as office.js toolStart and approval.js waitStart make them
const ask = (extra = {}) => ({ kind: 'ask', approval: false, room: 'desk', question: 'q', ids: ['t'], open: 1, ...extra });
const tool = (extra = {}) => ({ kind: 'tool', room: 'dev', ids: ['t'], open: 1, ...extra });
const agent = (id, pending = [], extra = {}) => ({ id, floor: { index: 0 }, pending: new Map(pending.map((it, i) => [`${id}-${i}`, it])), ...extra });

test('the title: plain at zero, "(N) Office Sim" above', () => {
  assert.equal(BASE_TITLE, 'Office Sim');
  assert.equal(needsYouTitle(0), 'Office Sim');
  assert.equal(needsYouTitle(1), '(1) Office Sim');
  assert.equal(needsYouTitle(12), '(12) Office Sim');
  for (const bad of [-1, NaN, undefined, null, 0.4]) assert.equal(needsYouTitle(bad), 'Office Sim', String(bad));
  assert.match(readFileSync(new URL('../public/office.html', import.meta.url), 'utf8'), /^<title>Office Sim<\/title>/, 'the title office.html starts with');
});

test('waitsOnHuman: an open question, plan approval, a replayed or a live permission wait; not a tool, not an answered ask', () => {
  assert.equal(waitsOnHuman(agent('a', [ask()])), true, 'AskUserQuestion');
  assert.equal(waitsOnHuman(agent('a', [ask({ question: 'Plan approval' })])), true, 'ExitPlanMode goes to the desk like a question');
  assert.equal(waitsOnHuman(agent('a', [ask({ approval: true })])), true, 'a replayed permission wait (awaitsApproval)');
  assert.equal(waitsOnHuman(agent('a', [ask({ approval: true, live: true, resume: { room: 'server', text: 'Bash' } })])), true, 'an open tool_wait');
  assert.equal(waitsOnHuman(agent('a', [tool(), ask()])), true, 'one ask among tools is enough');
  assert.equal(waitsOnHuman(agent('a', [tool(), tool({ open: 3 })])), false, 'open tools wait on nobody');
  assert.equal(waitsOnHuman(agent('a', [ask({ answered: true })])), false, 'an answered ask');
  assert.equal(waitsOnHuman(agent('a')), false);
  for (const odd of [null, undefined, {}, { pending: null }, { pending: new Map([['x', null]]) }]) assert.equal(waitsOnHuman(odd), false);
});

test('waitingAgents: demo characters and hidden ones are left out; the order is floor, then arrival', () => {
  const a = agent('a', [ask()], { floor: { index: 1 } });
  const b = agent('b', [tool()]);
  const c = agent('c', [ask({ approval: true, live: true })]);
  const d = agent('demo-auth', [ask()]);
  const e = agent('e', [ask()], { floor: { index: 1 } });
  const all = [a, b, c, d, e];
  assert.deepEqual(waitingAgents(all).map((x) => x.id), ['c', 'demo-auth', 'a', 'e']);
  assert.deepEqual(waitingAgents(all, { demoIds: new Set(['demo-auth']) }).map((x) => x.id), ['c', 'a', 'e']);
  assert.deepEqual(waitingAgents(all, { demoIds: new Set(['demo-auth']), visible: (x) => x.id !== 'a' }).map((x) => x.id), ['c', 'e']);
  assert.deepEqual(waitingAgents(new Map(all.map((x) => [x.id, x])).values()).length, 4, 'any iterable, like office.agents.values()');
  assert.deepEqual(waitingAgents([]), []);
  assert.deepEqual(waitingAgents([b, null, undefined]), []);
});

test('trackDemo: an event marked demo makes its session a demo character; a real session event takes the id back', () => {
  const ids = new Set();
  trackDemo(ids, { type: 'session', sessionId: 's1', demo: true });
  trackDemo(ids, { type: 'tool_start', sessionId: 's2', demo: true });
  assert.deepEqual([...ids], ['s1', 's2']);
  trackDemo(ids, { type: 'tool_start', sessionId: 's1' });
  assert.equal(ids.has('s1'), true, 'only a session event without the mark makes it real');
  trackDemo(ids, { type: 'session', sessionId: 's1' });
  assert.deepEqual([...ids], ['s2']);
  for (const odd of [null, undefined, {}, { demo: true }]) trackDemo(ids, odd);
  assert.deepEqual([...ids], ['s2']);
});

test('nextWaiting: the one after the selected character, around the end; the first when the selection is elsewhere', () => {
  const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextWaiting([a, b, c], null), a);
  assert.equal(nextWaiting([a, b, c], { id: 'other' }), a);
  assert.equal(nextWaiting([a, b, c], a), b);
  assert.equal(nextWaiting([a, b, c], b), c);
  assert.equal(nextWaiting([a, b, c], c), a);
  assert.equal(nextWaiting([a], a), a, 'one character: it stays selected');
  assert.equal(nextWaiting([], a), null);
});

test('the chip text exists in Korean and English and carries the count', () => {
  const ko = needsYouText('ko');
  const en = needsYouText('en');
  assert.equal(en.chip(3), 'Needs you 3');
  assert.equal(ko.chip(3), '확인 필요 3');
  assert.match(en.hint(1), /^1 character is waiting/);
  assert.match(en.hint(3), /^3 characters are waiting/);
  assert.match(ko.hint(3), /3명/);
  assert.notEqual(ko.hint(3), en.hint(3));
  assert.equal(needsYouText('fr'), ko, 'the page rule: only en is English (rooms.js langOf)');
});

// ---- the real Office and Agent, a fake document ------------------------------------------------------------------

class FakeEl {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; this.parent = null; this.dataset = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  appendChild(el) { el.parent = this; this.children.push(el); return el; }
  append(...els) { for (const el of els) this.appendChild(el); }
  insertAdjacentElement(where, el) {
    assert.equal(where, 'afterend');
    el.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, el);
    return el;
  }
  click() { for (const fn of this.listeners.click ?? []) fn({ preventDefault() {} }); }
}
function fakeDoc() {
  const controls = new FakeEl('div');
  const source = controls.appendChild(Object.assign(new FakeEl('span'), { id: 'source' }));
  const tail = controls.appendChild(Object.assign(new FakeEl('span'), { id: 'tail' }));
  const langToggle = controls.appendChild(Object.assign(new FakeEl('button'), { id: 'lang-toggle' }));
  const head = new FakeEl('head');
  const byId = { source, tail, 'lang-toggle': langToggle };
  const all = () => [...head.children, ...controls.children];
  return {
    title: 'Office Sim', head, controls, source, langToggle,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => byId[id] ?? all().find((el) => el.id === id) ?? null,
    querySelector: (sel) => (sel === '.bar .controls' ? controls : null),
  };
}

const HUD = { lang: 'en', renderFloors() {}, log() {}, ping() {}, inspect() {}, clearPing() {}, pings: new Set() };
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function setup({ hud = { ...HUD }, visible = () => true } = {}) {
  const office = new Office({ setViewFn() {}, setGoal() {} }, hud);
  const focused = [];
  const selected = [];
  office.focus = (i) => { focused.push(i); office.focusIndex = i; office.overview = false; };
  office.select = (a, opts) => { office.selected = a; selected.push([a?.id ?? null, opts ?? null]); };
  const floors = [0, 1].map((index) => ({ key: `p${index}`, label: `P${index}`, index, release() {}, board: { set() {} }, agents: new Set() }));
  for (const f of floors) office.byKey.set(f.key, f);
  const add = (id, floor = 0) => {
    const a = Object.create(Agent.prototype);
    Object.assign(a, {
      office, id, floor: floors[floor], isSub: false, parentId: null, agentType: '', agent: 'claude-code', name: id, childSeq: 0,
      queue: [], current: null, path: [], room: 'lounge', slot: -1, pending: new Map(), history: [],
      mode: 'idle', activity: '', idleT: 0, bubbleT: 0, panicT: 0, sweatEl: { hidden: true },
    });
    a.bubble = () => {};
    a.refreshTag = () => {};
    a.goTo = function goTo(room) { this.room = room; this.path = [{}]; };
    a.leave = () => {};
    office.agents.set(id, a);
    return a;
  };
  const doc = fakeDoc();
  const timers = [];
  const win = { setInterval: (fn, ms) => { timers.push([fn, ms]); return timers.length; } };
  const needs = installNeedsYou({ office, hud, doc, win, visible });
  const send = (sessionId, ev) => office.onEvent({ sessionId, ...ev });
  const chip = () => doc.getElementById('needs-you');
  return { office, doc, needs, add, send, chip, focused, selected, timers, hud };
}
const question = (id, s = 1) => ({ type: 'tool_start', ts: at(s), toolUseId: id, tool: 'AskUserQuestion', summary: 'Which one?', question: 'Which one?', options: ['A', 'B'] });
const bash = (id, s = 1) => ({ type: 'tool_start', ts: at(s), toolUseId: id, tool: 'Bash', room: 'server', summary: 'npm test' });

test('installed: the chip sits after the source chip, hidden at zero, and the title is plain', async () => {
  const s = setup();
  const chip = s.chip();
  assert.ok(chip, 'the module injects the chip (office.html has no markup for it)');
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.attrs.type, 'button');
  assert.equal(chip.className, 'chip');
  assert.equal(s.doc.controls.children.indexOf(chip), s.doc.controls.children.indexOf(s.doc.source) + 1);
  assert.equal(chip.hidden, true);
  assert.equal(s.doc.title, 'Office Sim');
  assert.equal(s.needs.count, 0);
  assert.ok(s.doc.head.children.some((el) => el.id === 'needs-you-style' && el.textContent.includes('#needs-you[hidden]')), 'a hidden chip must not show: .chip sets display');
  assert.deepEqual(s.timers.map(([, ms]) => ms), [1000], 'one slow timer for what changes without an event (the LLM filter)');
});

test('a question, a plan approval and a permission wait count as soon as the event arrives; their end takes them out', async () => {
  const s = setup();
  s.add('s1');
  s.add('s2');
  s.add('s3', 1);
  s.send('s1', question('q1'));
  await settle(); // the count follows events without a frame: a hidden tab runs no frames, and that is when the title matters
  assert.equal(s.doc.title, '(1) Office Sim');
  assert.equal(s.chip().hidden, false);
  assert.equal(s.chip().children[1].textContent, 'Needs you 1');
  assert.match(s.chip().attrs['aria-label'], /^1 character is waiting/);
  assert.equal(s.chip().title, s.chip().attrs['aria-label']);

  s.send('s2', { type: 'tool_start', ts: at(2), toolUseId: 'p1', tool: 'ExitPlanMode', summary: 'Plan approval' });
  s.send('s3', bash('b1', 2));
  await settle();
  assert.equal(s.doc.title, '(2) Office Sim', 'an open tool is not a wait');
  s.send('s3', { type: 'tool_wait', ts: at(3), toolUseId: 'b1', waiting: true });
  await settle();
  assert.equal(s.doc.title, '(3) Office Sim', 'an open tool_wait');
  assert.equal(s.chip().children[1].textContent, 'Needs you 3');
  assert.deepEqual(s.needs.waiting.map((a) => a.id), ['s1', 's2', 's3']);

  s.send('s3', { type: 'tool_wait', ts: at(4), toolUseId: 'b1', waiting: false }); // allowed (Grok): back to work
  await settle();
  assert.equal(s.doc.title, '(2) Office Sim');
  s.send('s1', { type: 'tool_end', ts: at(5), toolUseId: 'q1', ok: true });
  s.send('s2', { type: 'tool_end', ts: at(5), toolUseId: 'p1', ok: false, errorKind: 'denied' });
  await settle();
  assert.equal(s.doc.title, 'Office Sim');
  assert.equal(s.chip().hidden, true);
  assert.equal(s.needs.count, 0);
});

test('a hook wait that only ends with the tool, a stale question and a session end all clear the count', async () => {
  const s = setup();
  s.add('s1');
  s.add('s2');
  s.send('s1', bash('b1'));
  s.send('s1', { type: 'tool_wait', ts: at(2), toolUseId: 'b1', waiting: true }); // Claude Code through hooks: never a false
  s.send('s2', question('q1'));
  await settle();
  assert.equal(s.doc.title, '(2) Office Sim');
  s.send('s1', { type: 'tool_end', ts: at(9), toolUseId: 'b1', ok: true });
  await settle();
  assert.equal(s.doc.title, '(1) Office Sim');
  s.send('s2', { type: 'prompt', ts: at(10), text: 'next' }); // the answer was missed: a new prompt closes the question
  await settle();
  assert.equal(s.doc.title, 'Office Sim');
  s.send('s2', question('q2', 11));
  await settle();
  assert.equal(s.doc.title, '(1) Office Sim');
  s.send('s2', { type: 'session_end', ts: at(12) });
  await settle();
  assert.equal(s.doc.title, 'Office Sim');
});

test('a snapshot counts too, also one whose reconciliation closes a question without an event', async () => {
  const s = setup();
  s.add('s1');
  s.office.applySnapshot([{ type: 'session', sessionId: 's1', ts: at(0) }, { sessionId: 's1', ...question('q1') }], {});
  await settle();
  assert.equal(s.doc.title, '(1) Office Sim');
  s.office.applySnapshot([{ type: 'session', sessionId: 's1', ts: at(0) }], {}); // reconnect: the question is no longer open
  await settle();
  assert.equal(s.doc.title, 'Office Sim');
  s.send('s1', question('q2', 3));
  await settle();
  assert.equal(s.doc.title, '(1) Office Sim');
  s.office.applySnapshot([], {}); // nobody is left: every open question is closed
  await settle();
  assert.equal(s.doc.title, 'Office Sim');
});

test('characters of the first-run demo (events marked demo) are not counted; a real session with that id is', async () => {
  const s = setup();
  s.add('demo-auth');
  s.add('real');
  s.send('demo-auth', { ...question('q1'), demo: true });
  await settle();
  assert.equal(s.doc.title, 'Office Sim', 'a demo question does not wait on anybody');
  assert.equal(s.chip().hidden, true);
  s.send('real', question('q2'));
  await settle();
  assert.equal(s.doc.title, '(1) Office Sim');
  assert.deepEqual(s.needs.waiting.map((a) => a.id), ['real']);
  s.needs.cycle();
  assert.deepEqual(s.selected.map(([id]) => id), ['real'], 'the chip never selects a demo character');
  s.send('demo-auth', { type: 'session', ts: at(5) }); // the same id from the server, without the mark
  await settle();
  assert.equal(s.doc.title, '(2) Office Sim');
});

test('the chip cycles the selection through the waiting characters, floor by floor, without petting them', async () => {
  const s = setup();
  for (const [id, floor] of [['a', 0], ['b', 1], ['c', 0]]) s.add(id, floor);
  s.office.focusIndex = 0;
  for (const id of ['a', 'b', 'c']) s.send(id, question(`q-${id}`));
  await settle();
  assert.deepEqual(s.needs.waiting.map((a) => a.id), ['a', 'c', 'b'], 'floor 0 first');
  const chip = s.chip();
  chip.click();
  chip.click();
  chip.click();
  chip.click();
  assert.deepEqual(s.selected.map(([id]) => id), ['a', 'c', 'b', 'a']);
  for (const [, opts] of s.selected) assert.deepEqual(opts, { focusPan: true, silent: true }, 'silent: select() would pet the character and replace its question bubble');
  assert.deepEqual(s.focused, [1, 0], 'the floor is focused only when the character is on another one');
  // overview: the character's floor is focused even when it is the current index
  s.office.overview = true;
  s.office.selected = null;
  chip.click();
  assert.deepEqual(s.focused, [1, 0, 0]);
  // nobody waits any more: a click does nothing
  for (const id of ['a', 'b', 'c']) s.send(id, { type: 'tool_end', ts: at(9), toolUseId: `q-${id}`, ok: true });
  await settle();
  const before = s.selected.length;
  assert.equal(s.needs.cycle(), null);
  assert.equal(s.selected.length, before);
});

test('the LLM filter and the language are followed: a hidden character is not counted, the label is rewritten', async () => {
  let hide = null;
  const s = setup({ visible: (a) => a.id !== hide });
  s.add('a');
  s.add('b');
  s.send('a', question('q1'));
  s.send('b', question('q2'));
  await settle();
  assert.equal(s.doc.title, '(2) Office Sim');
  hide = 'a'; // the filter changed: no event tells the module, the timer does
  s.timers[0][0]();
  assert.equal(s.doc.title, '(1) Office Sim');
  assert.equal(s.chip().children[1].textContent, 'Needs you 1');
  s.hud.lang = 'ko';
  s.doc.langToggle.click();
  assert.equal(s.chip().children[1].textContent, '확인 필요 1');
  assert.match(s.chip().attrs['aria-label'], /1명/);
  assert.equal(s.doc.title, '(1) Office Sim', 'the title is not translated');
});

test('without a document, or without an office, nothing is installed', () => {
  assert.equal(installNeedsYou({ office: null, hud: HUD, doc: fakeDoc() }), null);
  assert.equal(installNeedsYou({ office: { agents: new Map() }, hud: HUD, doc: null }), null);
});

test('main.js installs it, and office.html stays without markup for it', () => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ installNeedsYou \} from '\.\/needs-you\.js';/);
  assert.match(main, /\ninstallNeedsYou\(\{ office, hud \}\);/);
  assert.doesNotMatch(readFileSync(new URL('../public/office.html', import.meta.url), 'utf8'), /needs-you/);
});
