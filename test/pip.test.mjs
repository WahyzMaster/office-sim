// W9 (launch readiness, contract 9.6, D29 to D31): public/js/pip.js, the mini window. A Document Picture-in-Picture
// window holds the stage while the tab shows a placeholder; the frame loop runs on that window at 30 a second at most.
// Stub documents, stub windows and a stub documentPictureInPicture (test/fixtures/pip-dom.mjs): no browser, no server.
// The frame loop itself, the stage's size source, the wiring in main.js and the documents: test/pip-frames.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabPage, miniWindow } from './fixtures/pip-dom.mjs';
import { installNeedsYou, needsYouText } from '../public/js/needs-you.js';
import { PIP_SIZE, pipSupported, pipText, createFrameLoop, floorToShow, installPip } from '../public/js/pip.js';

const settle = () => new Promise((r) => setImmediate(r));
const HANGUL = /[가-힣]/;

// ---- the mini window ------------------------------------------------------------------------------------------------

const ask = () => new Map([['t', { kind: 'ask' }]]);

function setup({ support = true, lang = 'en', overview = false, focusIndex = 0, extra = false, requestWindow = null, realNeeds = false } = {}) {
  const page = tabPage({ extra });
  const { doc, win, host } = page;
  const time = { now: 1000 };
  const minis = [];
  const requests = [];
  const make = (opts) => {
    requests.push(opts);
    const w = miniWindow(opts);
    w.origin = time.now;
    minis.push(w);
    return Promise.resolve(w);
  };
  if (support) win.documentPictureInPicture = { requestWindow: requestWindow ?? make };
  const stage = {
    renderer: { domElement: page.canvas }, labels: { domElement: page.labels }, sizeOf: null, sizes: [], draws: [],
    setSizeSource(fn) { this.sizeOf = fn; },
    resize() { const b = this.sizeOf?.(); this.sizes.push([b?.width || host.clientWidth, b?.height || host.clientHeight]); },
    render(root) { this.draws.push(`${this.sizes.at(-1)} ${root}`); }, // what was drawn: at which size, which label root
  };
  const floors = [0, 1, 2].map((index) => ({ index, key: `p${index}` }));
  const office = {
    overview, focusIndex, floors, agents: new Map(), focused: [],
    labelRoot() { return this.overview ? 'scene' : `floor ${this.focusIndex}`; },
    focus(i) {
      this.focused.push(i);
      if (i === 'all') this.overview = true;
      else { this.overview = false; this.focusIndex = i; }
    },
  };
  const hud = { lang };
  const steps = [];
  const loop = createFrameLoop((dt) => steps.push(dt), { win, clock: () => time.now });
  const waiting = [];
  const needsYou = realNeeds
    ? installNeedsYou({ office, hud, doc, win: { setInterval() {} }, visible: () => true })
    : { get waiting() { return [...waiting]; }, get count() { return waiting.length; } };
  const pip = installPip({ stage, office, hud, host, loop, needsYou, doc, win });
  loop.start();
  const s = {
    page, doc, win, host, stage, office, hud, steps, loop, waiting, needsYou, pip, minis, requests, time, make,
    control: () => doc.getElementById('pip-open'),
    placeholder: () => doc.getElementById('pip-placeholder'),
    tabFrame(ms = 1000 / 60) { time.now += ms; return win.frame(time.now); },
    miniFrame(w, ms = 40) { time.now += ms; return w.frame(time.now - w.origin); },
    async open() { s.control().click(); await settle(); return minis.at(-1); },
    // a character on a floor: waits when it has an open ask (needs-you.js waitsOnHuman)
    agent(id, floor, pending = ask()) { const a = { id, floor: floors[floor], pending }; office.agents.set(id, a); return a; },
  };
  return s;
}

test('no Document Picture-in-Picture: no control, no style, no listener, and nothing is returned', () => {
  for (const dpip of [undefined, null, {}, { requestWindow: 'yes' }]) {
    const page = tabPage();
    if (dpip !== undefined) page.win.documentPictureInPicture = dpip;
    assert.equal(pipSupported(page.win), false);
    const before = page.doc.all().length;
    const untouched = new Proxy({}, { get(_, k) { throw new Error(`touched .${String(k)}`); } });
    const got = installPip({ stage: untouched, office: untouched, hud: untouched, host: page.host, loop: untouched, needsYou: untouched, doc: page.doc, win: page.win });
    assert.equal(got, null);
    assert.equal(page.doc.all().length, before, 'no element was added');
    assert.equal(page.doc.getElementById('pip-open'), null);
    assert.equal(page.langToggle.count('click'), 0);
    assert.equal(page.win.count('resize') + page.win.count('pagehide'), 0);
    assert.equal(page.win.observers.length, 0);
    assert.equal(page.win.pending, 0);
  }
  assert.equal(pipSupported(null), false);
  assert.equal(pipSupported({ documentPictureInPicture: { requestWindow() {} } }), true);
});

test('with support: one chip-style button in the top bar, with Korean and English text', () => {
  const s = setup();
  const c = s.control();
  assert.ok(c, 'the module makes the control (office.html has no markup for it)');
  assert.equal(s.doc.all().filter((el) => el.id === 'pip-open').length, 1);
  assert.equal(c.tagName, 'BUTTON');
  assert.equal(c.className, 'chip');
  assert.equal(c.attrs.type, 'button');
  assert.equal(s.page.controls.children.indexOf(c), s.page.controls.children.indexOf(s.page.source) + 1, 'after the source chip');
  assert.equal(c.children[0].textContent, 'Mini window');
  assert.equal(c.title, pipText('en').hint);
  assert.equal(c.attrs['aria-label'], c.title);
  assert.match(c.title, /mini window/i, 'the accessible name carries the visible label');
  assert.match(c.title, /on top/);
  assert.ok(s.doc.head.children.some((el) => el.id === 'pip-style' && el.textContent.includes('#pip-placeholder')));
  assert.equal(s.placeholder(), null, 'no placeholder before it is opened');
  assert.equal(s.requests.length, 0, 'no window is asked for before a click');
  assert.equal(s.pip.open, false);

  const ko = setup({ lang: 'ko' }).control();
  assert.equal(ko.children[0].textContent, '미니 창');
  assert.equal(ko.title, pipText('ko').hint);
  assert.match(ko.attrs['aria-label'], /미니 창/);
  for (const key of Object.keys(pipText('en'))) {
    assert.match(pipText('ko')[key], HANGUL, `ko.${key}`);
    assert.doesNotMatch(pipText('en')[key], HANGUL, `en.${key}`);
  }
  assert.deepEqual(Object.keys(pipText('ko')), Object.keys(pipText('en')));
  assert.equal(pipText('en').back, 'Back to tab');
  assert.equal(pipText('ko').back, '탭으로 돌아가기');

  // with the needs-you chip in the bar, the control comes after it
  const both = setup({ realNeeds: true });
  const kids = both.page.controls.children.map((el) => el.id);
  assert.deepEqual(kids.slice(0, 3), ['source', 'needs-you', 'pip-open']);
});

test('open: the click asks for a small window, then styles and root attributes are copied and the stage moves in', async () => {
  const s = setup({ overview: true, focusIndex: 1 });
  s.tabFrame();
  assert.equal(s.steps.length, 1);
  s.control().click();
  assert.deepEqual(s.requests, [{ width: 420, height: 300 }], 'requestWindow runs inside the click: the browser wants a user gesture');
  assert.deepEqual(PIP_SIZE, { width: 420, height: 300 });
  assert.equal(s.page.canvas.parentNode, s.host, 'nothing moves before the window exists');
  assert.equal(s.placeholder(), null);
  await settle();
  const mini = s.minis[0];
  const pdoc = mini.document;
  assert.equal(s.pip.open, true);

  // styles: every style element and stylesheet link of the page, in order, then the mini window's own rules
  const head = pdoc.head.children;
  assert.deepEqual(head.map((el) => el.tagName), ['STYLE', 'LINK', 'STYLE', 'STYLE'], 'the icon link is not copied');
  assert.equal(head[0].textContent, ':root { --accent: #0f766e; } .labels { position: absolute; }');
  assert.deepEqual(head[1].attrs, { rel: 'stylesheet', href: 'http://127.0.0.1:1/extra.css', media: 'screen' });
  assert.equal(head[2].textContent, '#needs-you[hidden] { display: none; }');
  assert.equal(head[3].id, 'pip-style');
  assert.match(head[3].textContent, /#pip-bar/);
  for (const el of head) assert.equal(el.ownerDocument, pdoc, 'made in the mini document');
  assert.equal(s.doc.head.children.length, 5, 'the page keeps its own (4 and the module style)');

  // root attributes, so the theme tokens and the fonts resolve the same
  assert.equal(pdoc.documentElement.getAttribute('lang'), 'en');
  assert.equal(pdoc.documentElement.getAttribute('data-theme'), 'dark');

  // the nodes themselves moved, canvas first (the renderer is not made again)
  const holder = pdoc.getElementById('stage');
  assert.deepEqual(holder.children, [s.page.canvas, s.page.labels]);
  assert.equal(s.page.canvas.ownerDocument, pdoc);
  assert.equal(s.page.labels.ownerDocument, pdoc);
  assert.deepEqual(s.host.children, []);
  assert.equal(holder.getAttribute('role'), 'img');
  assert.equal(holder.getAttribute('aria-label'), '3D office');

  // one line under it: the waiting count (hidden at zero) and the way back
  const bar = pdoc.getElementById('pip-bar');
  assert.deepEqual(pdoc.body.children, [holder, bar]);
  const [count, back] = bar.children;
  assert.deepEqual([count.id, back.id], ['pip-count', 'pip-back']);
  assert.equal(count.hidden, true);
  assert.equal(back.tagName, 'BUTTON');
  assert.equal(back.textContent, 'Back to tab');
  assert.equal(pdoc.title, 'Office Sim');

  // the tab: a placeholder right after the stage host (outside it: the host is an image to assistive technology)
  const ph = s.placeholder();
  assert.equal(s.host.nextSibling, ph);
  assert.equal(ph.children[0].textContent, pipText('en').away);
  assert.match(ph.children[0].textContent, /mini window/);
  assert.equal(ph.children[1].tagName, 'BUTTON');
  assert.equal(ph.children[1].textContent, pipText('en').bring);

  // size, frames and view
  assert.deepEqual(s.stage.sizes.at(-1), [420, 300]);
  assert.deepEqual([s.win.pending, mini.pending], [0, 1], 'the loop moved to the mini window');
  assert.deepEqual(s.office.focused, [1], 'overview is left for the floor that was focused');
  assert.equal(s.office.overview, false);
  const before = s.steps.length;
  for (let i = 0; i < 60; i += 1) s.miniFrame(mini, 1000 / 60);
  assert.equal(s.steps.length - before, 30, 'one second of 60 Hz frames: 30 steps');
  assert.deepEqual([s.win.pending, mini.pending], [0, 1]);
  assert.deepEqual(s.office.focused, [1], 'nobody waits: frames change no view');
});

test('a refused or throwing requestWindow leaves the page as it was, without an unhandled rejection', async () => {
  const refusals = {
    rejects: () => Promise.reject(new Error('NotAllowedError')),
    throws: () => { throw new Error('boom'); },
    'gives nothing': () => Promise.resolve(null),
    'gives no document': () => Promise.resolve({}),
  };
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const [name, requestWindow] of Object.entries(refusals)) {
      const s = setup({ overview: true, focusIndex: 2, extra: true, requestWindow });
      const nodes = s.doc.all().length;
      s.control().click();
      await settle();
      await settle();
      assert.equal(s.pip.open, false, name);
      assert.equal(s.doc.all().length, nodes, `${name}: no node added or removed`);
      assert.deepEqual(s.host.children, [s.page.canvas, s.page.labels, s.page.tail], name);
      assert.equal(s.placeholder(), null, name);
      assert.deepEqual([s.stage.sizeOf, s.stage.sizes.length, s.stage.draws.length], [null, 0, 0], name);
      assert.deepEqual(s.office.focused, [], name);
      assert.equal(s.office.overview, true, name);
      assert.equal(s.win.pending, 1, `${name}: the tab keeps its one loop`);
      assert.equal(s.tabFrame(), 1, name);
      assert.equal(s.steps.length, 1, name);
      assert.equal(s.win.observers.length, 0, name);
      // the next click may ask again
      s.win.documentPictureInPicture.requestWindow = s.make;
      const mini = await s.open();
      assert.equal(s.pip.open, true, `${name}: a later click opens`);
      assert.equal(s.page.canvas.ownerDocument, mini.document, name);
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('a second click, while the request is pending or while the mini window is open, does nothing', async () => {
  const s = setup();
  s.control().click();
  s.control().click();
  await settle();
  assert.equal(s.requests.length, 1, 'a double click asks once');
  const mini = s.minis[0];
  const snapshot = () => [s.requests.length, s.minis.length, s.doc.all().length, mini.document.all().length, s.win.pending, mini.pending, s.stage.sizes.length];
  const before = snapshot();
  s.control().click();
  await settle();
  assert.deepEqual(snapshot(), before);
  assert.equal(mini.closed, false);
  assert.equal(s.doc.all().filter((el) => el.id === 'pip-placeholder').length, 1);
});

const WAYS = {
  'the button of the mini window': (s, mini) => mini.document.getElementById('pip-back').click(),
  'the button of the placeholder': (s) => s.placeholder().children[1].click(),
  "the window's own close button (pagehide)": (s, mini) => mini.close(),
};
for (const [name, closeIt] of Object.entries(WAYS)) {
  test(`close by ${name}: nodes, placeholder, frames, size and view are as before; twice is harmless; it opens again`, async () => {
    const s = setup({ overview: true, focusIndex: 2, extra: true });
    const mini = await s.open();
    s.waiting.push({ id: 'a', floor: s.office.floors[0] });
    s.miniFrame(mini);
    assert.deepEqual(s.office.focused, [2, 0], 'while open the view followed a waiting character');
    closeIt(s, mini);

    const restored = () => {
      assert.deepEqual(s.host.children, [s.page.canvas, s.page.labels, s.page.tail], 'canvas, labels, and what followed them');
      assert.equal(s.page.canvas.ownerDocument, s.doc);
      assert.equal(s.page.labels.ownerDocument, s.doc);
      assert.equal(s.placeholder(), null);
      assert.equal(s.pip.open, false);
      assert.equal(s.stage.sizeOf, null);
      assert.deepEqual(s.stage.sizes.at(-1), [1280, 720], 'the size of the tab');
      assert.deepEqual([s.win.pending, mini.pending], [1, 0], 'one loop, on the tab');
      assert.deepEqual([s.office.overview, s.office.focusIndex], [true, 2], 'the view from before the mini window');
      assert.equal(s.win.observers.length, 0);
    };
    restored();
    assert.equal(mini.closed, true, 'the mini window is gone');
    assert.deepEqual([mini.count('pagehide'), mini.count('resize')], [0, 0]);
    assert.deepEqual(s.office.focused, [2, 0, 2, 'all']);
    assert.equal(s.win.focused, name === 'the button of the mini window' ? 1 : 0, 'only "Back to tab" brings the tab forward');

    // full rate again, and nothing left of the old chain
    const n = s.steps.length;
    for (let i = 0; i < 6; i += 1) s.tabFrame();
    assert.equal(s.steps.length - n, 6);
    for (const fn of mini.issued) fn(99999);
    mini.dispatch('resize');
    assert.equal(s.steps.length - n, 6);

    // closing again, any way, changes nothing
    const sizes = s.stage.sizes.length;
    s.pip.close();
    mini.close();
    mini.dispatch('pagehide');
    restored();
    assert.deepEqual(s.office.focused, [2, 0, 2, 'all']);
    assert.equal(s.stage.sizes.length, sizes);

    // open again: one loop, on the new window
    const again = await s.open();
    assert.notEqual(again, mini);
    assert.equal(s.requests.length, 2);
    assert.deepEqual(again.document.getElementById('stage').children, [s.page.canvas, s.page.labels]);
    assert.deepEqual(s.host.children, [s.page.tail]);
    assert.deepEqual([s.win.pending, mini.pending, again.pending], [0, 0, 1]);
    const m = s.steps.length;
    for (let i = 0; i < 60; i += 1) s.miniFrame(again, 1000 / 60);
    assert.equal(s.steps.length - m, 30, 'still 30 a second: no doubled frames after open, close, open');
    for (const fn of [...s.win.issued, ...mini.issued]) fn(99999);
    assert.equal(s.steps.length - m, 30);
    closeIt(s, again);
    assert.deepEqual(s.host.children, [s.page.canvas, s.page.labels, s.page.tail]);
    assert.deepEqual([s.win.pending, mini.pending, again.pending], [1, 0, 0]);
    assert.deepEqual([s.office.overview, s.office.focusIndex], [true, 2]);
  });
}

test('close: a floor that moved or went away while the mini window was open', async () => {
  const s = setup({ focusIndex: 2 });
  const mini = await s.open();
  assert.deepEqual(s.office.focused, [], 'one floor was shown already: the view is not touched at open');
  s.office.focus(0);
  s.office.floors.shift(); // the first floor emptied: the remembered floor is now the second
  mini.close();
  assert.deepEqual(s.office.focused, [0, 1]);

  const t = setup({ focusIndex: 2 });
  const mini2 = await t.open();
  t.office.focus(0);
  t.office.floors.pop(); // the remembered floor is gone: its number is used (Office.focus keeps it in range)
  mini2.close();
  assert.deepEqual(t.office.focused, [0, 2]);

  const u = setup({ focusIndex: 1 });
  const mini3 = await u.open();
  mini3.close();
  assert.deepEqual(u.office.focused, [], 'nothing changed while open: no focus call, so the pan and the follow mode stay');
  assert.deepEqual(u.stage.sizes.at(-1), [1280, 720], 'the size is restored all the same');
});

test('floorToShow: the floor of the first waiting character, unless one waits on the shown floor', () => {
  const on = (i) => ({ id: `a${i}`, floor: { index: i } });
  assert.equal(floorToShow([], 0), null);
  assert.equal(floorToShow(null, 0), null);
  assert.equal(floorToShow([on(1)], 1), null);
  assert.equal(floorToShow([on(0), on(2)], 2), null, 'one of them is on the shown floor');
  assert.equal(floorToShow([on(1), on(2)], 0), 1, 'the first of the list (needs-you orders it by floor, then arrival)');
  assert.equal(floorToShow([on(2)], 0), 2);
  assert.equal(floorToShow([{ id: 'x' }], 0), null, 'a character without a floor moves nothing');
});

test('one floor: a character that waits elsewhere is followed when the list changes; the line and the title show the count', async () => {
  const s = setup({ focusIndex: 1, realNeeds: true });
  const mini = await s.open();
  const pdoc = mini.document;
  const count = pdoc.getElementById('pip-count');
  const turn = () => { s.needsYou.refresh(); s.miniFrame(mini); };

  const a = s.agent('a', 1);
  turn();
  assert.deepEqual(s.office.focused, [], 'it waits on the shown floor');
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, needsYouText('en').chip(1));
  assert.ok(!count.title, 'the count is no button: the chip\'s tooltip, which promises a click, is not copied');
  assert.equal(pdoc.title, '(1) Office Sim', 'the title of the tab, count included');

  const b = s.agent('b', 2);
  turn();
  assert.deepEqual(s.office.focused, [], 'one of the two waits on the shown floor');
  assert.equal(count.textContent, 'Needs you 2');
  assert.equal(pdoc.title, '(2) Office Sim');

  a.pending = new Map(); // answered
  turn();
  assert.deepEqual(s.office.focused, [2], 'nobody waits on the shown floor any more: go to the one who waits');
  assert.equal(count.textContent, 'Needs you 1');

  s.office.focus(0); // by hand, from the tab
  for (let i = 0; i < 5; i += 1) turn();
  assert.deepEqual(s.office.focused, [2, 0], 'the list did not change: a floor chosen by hand stays');

  s.agent('c', 1);
  turn();
  assert.deepEqual(s.office.focused, [2, 0, 1], 'a new wait, none on the shown floor: the first of the list');

  b.pending = new Map();
  s.office.agents.get('c').pending = new Map();
  turn();
  assert.deepEqual(s.office.focused, [2, 0, 1], 'nobody waits: the view stays');
  assert.equal(count.hidden, true);
  assert.equal(pdoc.title, 'Office Sim');
});

test('one floor at open: a character that already waits elsewhere is shown at once, with one focus call', async () => {
  const s = setup({ overview: true, focusIndex: 0 });
  s.waiting.push({ id: 'b', floor: s.office.floors[2] });
  const mini = await s.open();
  assert.deepEqual(s.office.focused, [2]);
  assert.equal(s.office.overview, false);
  assert.equal(mini.document.getElementById('pip-count').textContent, 'Needs you 1');
  mini.close();
  assert.deepEqual([s.office.overview, s.office.focusIndex], [true, 0], 'close goes back to what was remembered');
});

test('the language button relabels the control, the placeholder and the line of the mini window', async () => {
  const s = setup();
  s.waiting.push({ id: 'a', floor: s.office.floors[0] });
  const mini = await s.open();
  const pdoc = mini.document;
  // on the page hud.bind and static-text.js handle the click first (they were installed first)
  s.hud.lang = 'ko';
  s.doc.documentElement.setAttribute('lang', 'ko');
  s.host.setAttribute('aria-label', '3D 사무실');
  s.page.langToggle.click();
  const ko = pipText('ko');
  assert.equal(s.control().children[0].textContent, '미니 창');
  assert.equal(s.control().title, ko.hint);
  assert.equal(s.control().attrs['aria-label'], ko.hint);
  assert.equal(s.placeholder().children[0].textContent, ko.away);
  assert.equal(s.placeholder().children[1].textContent, ko.bring);
  assert.equal(pdoc.getElementById('pip-back').textContent, '탭으로 돌아가기');
  assert.equal(pdoc.getElementById('pip-count').textContent, '확인 필요 1');
  assert.ok(!pdoc.getElementById('pip-count').title);
  assert.equal(pdoc.documentElement.getAttribute('lang'), 'ko');
  assert.equal(pdoc.getElementById('stage').getAttribute('aria-label'), '3D 사무실');
  assert.deepEqual(s.office.focused, [], 'a language change moves no view');

  mini.close();
  s.hud.lang = 'en';
  s.page.langToggle.click(); // closed: only the control is left to relabel
  assert.equal(s.control().children[0].textContent, 'Mini window');
  assert.equal(s.page.langToggle.count('click'), 1, 'one listener, installed once');
});

test('data-theme is kept in step while the mini window is open, also when the attribute goes away', async () => {
  const s = setup();
  const mini = await s.open();
  const root = s.doc.documentElement;
  const proot = mini.document.documentElement;
  assert.equal(s.win.observers.length, 1);
  assert.equal(s.win.observers[0].target, root);
  assert.equal(s.win.observers[0].options.attributes, true);
  assert.ok(s.win.observers[0].options.attributeFilter.includes('data-theme'));
  root.setAttribute('data-theme', 'light');
  s.win.mutated(root, 'data-theme');
  assert.equal(proot.getAttribute('data-theme'), 'light');
  root.removeAttribute('data-theme'); // "system" deletes the attribute (hud.js)
  s.win.mutated(root, 'data-theme');
  assert.equal(proot.getAttribute('data-theme'), null);
  mini.close();
  assert.equal(s.win.observers.length, 0, 'closed: nothing is watched');
});

test('size: the stage follows the mini window at open and at each resize of it, and the tab again after close', async () => {
  const s = setup({ overview: true, focusIndex: 1 });
  const mini = await s.open();
  assert.deepEqual(s.stage.sizes.at(-1), [420, 300]);
  // a resize empties the canvas, and the next step may be several frames away: it is drawn at once, at the new size
  assert.equal(s.stage.draws.at(-1), '420,300 floor 1', 'drawn after the view was set, with the labels of the shown floor');
  const holder = mini.document.getElementById('stage');
  Object.assign(holder, { clientWidth: 500, clientHeight: 330 }); // the room above the line, once the document is laid out
  const drawn = s.stage.draws.length;
  mini.dispatch('resize');
  assert.deepEqual(s.stage.sizes.at(-1), [500, 330]);
  assert.deepEqual(s.stage.draws.slice(drawn), ['500,330 floor 1'], 'one draw per resize');
  s.stage.resize(); // what Office.layout() does at every focus: it must not snap back to the size of the tab
  assert.deepEqual(s.stage.sizes.at(-1), [500, 330]);
  mini.close();
  assert.deepEqual(s.stage.sizes.at(-1), [1280, 720]);
  assert.equal(s.stage.draws.at(-1), '1280,720 scene', 'back in the tab: drawn at its size, in the view from before');
  const n = s.stage.sizes.length;
  mini.dispatch('resize');
  assert.equal(s.stage.sizes.length, n, 'a closed window resizes nothing');
});

test('input: one pointerup listener on the mini window ends the drag cursor; the canvas gets none, and the cursor does not come back to the tab', async () => {
  const s = setup();
  const mini = await s.open();
  assert.deepEqual(Object.keys(mini.listeners).filter((t) => mini.count(t) > 0).sort(), ['pagehide', 'pointerup', 'resize']);
  assert.deepEqual(Object.keys(s.page.canvas.listeners), [], 'the canvas gets no listener from this module');
  assert.deepEqual(Object.keys(mini.document.getElementById('stage').listeners), []);
  // main.js sets the class at pointerdown on the canvas and removes it at a pointerup on the tab's window, which a
  // pointerup inside the mini window never reaches: the module ends it there
  s.page.canvas.classList.add('dragging');
  mini.dispatch('pointerup');
  assert.equal(s.page.canvas.classList.contains('dragging'), false, 'a drag released in the mini window ends the grab cursor');
  s.page.canvas.classList.add('dragging');
  mini.close();
  assert.equal(s.page.canvas.classList.contains('dragging'), false, 'the stage comes back without it');
  assert.equal(mini.count('pointerup'), 0, 'the listener leaves with the window');
});

test('the mini window hides the room signs (D32): its own rules end with a rule for .sign', async () => {
  const s = setup();
  const mini = await s.open();
  const own = mini.document.getElementById('pip-style');
  assert.match(own.textContent, /\.sign \{ display: none; \}/);
});
