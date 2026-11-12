// W9 (launch readiness, contract 9.6, D30): the frame loop of public/js/pip.js. The 30 per second cap as a pure
// function, the loop that runs on one window at a time, the stage's size source (scene.js), the wiring in main.js,
// and the documents. The mini window itself: test/pip.test.mjs. No browser, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { tabPage, miniWindow } from './fixtures/pip-dom.mjs';
import { FRAME_CAP_MS, FRAME_SLACK_MS, MAX_DT_S, frameStart, frameStep, createFrameLoop } from '../public/js/pip.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} is not ${b}`);

// ---- the 30 per second cap, as a pure function --------------------------------------------------------------------

// Frame times of a display (ms), from the start time on. Returns the frames that ran step, with the dt they got.
function play(hz, seconds, { minMs = FRAME_CAP_MS, jitter = () => 0 } = {}) {
  let state = frameStart(0);
  const ran = [];
  const n = Math.round(hz * seconds);
  for (let k = 1; k <= n; k += 1) {
    const t = (k * 1000) / hz + jitter(k);
    const r = frameStep(state, t, minMs);
    state = r.state;
    if (r.dt !== null) ran.push({ k, t, dt: r.dt });
  }
  return ran;
}

test('the cap: at 60 Hz every second frame runs step, and dt is the real time since the frame that ran before', () => {
  assert.equal(FRAME_CAP_MS, 1000 / 30);
  assert.equal(MAX_DT_S, 0.1);
  const ran = play(60, 1);
  assert.deepEqual(ran.map((f) => f.k), Array.from({ length: 30 }, (_, i) => 2 * i + 1), 'frames 1, 3, 5, ... 59');
  near(ran[0].dt, 1 / 60, 'the first frame: the time since the start');
  for (const f of ran.slice(1)) near(f.dt, 2 / 60, `frame ${f.k}`);
  near(ran.reduce((sum, f) => sum + f.dt, 0), 59 / 60, 'the skipped time is not lost: the dts add up to the time of the last frame that ran');
});

test('the cap: every fourth frame at 120 Hz, every frame at 30 Hz, and never more than 30 a second on any display', () => {
  assert.deepEqual(play(120, 1).map((f) => f.k).slice(0, 4), [1, 5, 9, 13]);
  assert.equal(play(120, 1).length, 30);
  assert.equal(play(30, 1).length, 30, 'a 30 Hz display loses no frame');
  assert.equal(play(24, 1).length, 24);
  for (const hz of [50, 59.94, 60, 60.02, 62.5, 75, 90, 100, 120, 144, 165, 240]) {
    const ran = play(hz, 10);
    assert.ok(ran.length <= 301, `${hz} Hz: ${ran.length} steps in 10 s`);
    assert.ok(ran.length >= 200, `${hz} Hz: ${ran.length} steps in 10 s is too few`);
    for (let i = 1; i < ran.length; i += 1) {
      assert.ok(ran[i].t - ran[i - 1].t >= FRAME_CAP_MS - FRAME_SLACK_MS - 1e-6, `${hz} Hz: two steps ${ran[i].t - ran[i - 1].t} ms apart`);
    }
  }
  // frame times that wobble around the 60 Hz grid still give every second frame, not every third
  const wobble = play(60, 2, { jitter: (k) => (k % 2 ? 0.3 : -0.3) });
  assert.equal(wobble.length, 60);
});

test('the cap: without a limit every frame runs; dt is clamped to 0.1 s and never negative; a skipped frame changes nothing', () => {
  const all = play(60, 1, { minMs: 0 });
  assert.equal(all.length, 60);
  for (const f of all) near(f.dt, 1 / 60);
  const start = frameStart(1000);
  assert.equal(frameStep(start, 6000, 0).dt, 0.1, 'five seconds later (a tab that was hidden): the existing clamp');
  assert.equal(frameStep(start, 6000, FRAME_CAP_MS).dt, 0.1);
  assert.equal(frameStep(start, 990, 0).dt, 0, 'a frame time before the start time');
  const first = frameStep(start, 1010, FRAME_CAP_MS);
  near(first.dt, 0.01, 'the first frame of a source runs at once');
  const skipped = frameStep(first.state, 1026, FRAME_CAP_MS);
  assert.equal(skipped.dt, null);
  assert.equal(skipped.state, first.state, 'same state: the next frame that runs measures from the last one that ran');
  near(frameStep(skipped.state, 1043.4, FRAME_CAP_MS).dt, 0.0334);
  // up to the slack early is on time: 33.2 ms after a frame that ran
  near(frameStep(first.state, 1043.2, FRAME_CAP_MS).dt, 0.0332, 'a frame a little early is not pushed to the next one');
  assert.equal(frameStep(first.state, 1010 + FRAME_CAP_MS - FRAME_SLACK_MS - 0.5, FRAME_CAP_MS).dt, null);
});

// ---- the loop: one chain of frames, on one window at a time ----------------------------------------------------------

test('the loop: one pending frame at a time, on the window in use; a callback of an earlier request does nothing', () => {
  const tab = tabPage().win;
  const mini = miniWindow();
  const time = { now: 1000 };
  const steps = [];
  let each = 0;
  const loop = createFrameLoop((dt) => steps.push(dt), { win: tab, clock: () => time.now });
  loop.use(tab);
  assert.equal(tab.pending, 0, 'not started: switching the source asks for no frame');
  loop.start();
  loop.start();
  assert.equal(tab.pending, 1, 'start twice is one loop');
  assert.equal(loop.source, tab);
  time.now = 1016;
  tab.frame(1016);
  time.now = 1032;
  tab.frame(1032);
  assert.equal(steps.length, 2);
  near(steps[0], 0.016);
  near(steps[1], 0.016);
  assert.equal(tab.pending, 1);

  // to the mini window: its frame times start at its own zero (a new document), 30 a second at most
  const stale = tab.issued.at(-1);
  loop.use(mini, FRAME_CAP_MS, () => { each += 1; });
  assert.equal(loop.source, mini);
  assert.deepEqual([tab.pending, mini.pending], [0, 1], 'the pending frame of the tab is cancelled');
  stale(1048);
  assert.equal(steps.length, 2, 'a cancelled callback that still fires runs nothing');
  assert.deepEqual([tab.pending, mini.pending], [0, 1], 'and asks for nothing');
  time.now = 1100;
  mini.frame(5); // clock 1100 is 5 ms on the mini window's own clock
  assert.equal(steps.length, 3);
  near(steps[2], 0.068, 'the real time since the last frame of the tab (1032 -> 1100), not a difference of two clocks');
  assert.equal(each, 1);
  time.now = 1116;
  mini.frame(21);
  assert.equal(steps.length, 3, '16 ms later: skipped');
  assert.equal(each, 1, 'the after-frame call follows only a frame that ran');
  time.now = 1134;
  mini.frame(39);
  assert.equal(steps.length, 4);
  near(steps[3], 0.034);
  assert.deepEqual([tab.pending, mini.pending], [0, 1]);

  // and back: every frame again, no call after it
  loop.use(tab);
  assert.deepEqual([tab.pending, mini.pending], [1, 0]);
  for (const fn of mini.issued) fn(60);
  assert.equal(steps.length, 4, 'callbacks of the closed window run nothing');
  time.now = 1150;
  tab.frame(1150);
  time.now = 1166;
  tab.frame(1166);
  assert.equal(steps.length, 6);
  near(steps[4], 0.016);
  assert.equal(each, 2);
  assert.deepEqual([tab.pending, mini.pending], [1, 0]);
});

// ---- the stage, the wiring, the documents ------------------------------------------------------------------------------

test('scene.js: resize() takes the size from a size source while one is set, and from its host otherwise', async () => {
  // three.js replaced by a stub module that accepts anything (the loader of needs-you.test.mjs)
  const names = new Set();
  for (const f of readdirSync(new URL('../public/js/', import.meta.url)).filter((n) => n.endsWith('.js'))) {
    const src = read(`public/js/${f}`);
    for (const m of src.matchAll(/THREE\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'three[^']*'/g)) for (const n of m[1].split(',')) names.add(n.trim());
  }
  const stub = `const H = { get(t, k) { if (k === Symbol.toPrimitive) return () => 0; if (k === Symbol.iterator) return function* () {};
    if (k === 'then') return undefined; if (!(k in t.s)) t.s[k] = mk(); return t.s[k]; },
    set(t, k, v) { t.s[k] = v; return true; }, apply() { return mk(); }, construct() { return mk(); } };
  function mk() { const f = function () {}; f.s = {}; return new Proxy(f, H); }
  export const ${[...names].map((n) => `${n} = mk()`).join(', ')};`;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
    if (s === 'three' || s.startsWith('three/')) return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true };
    return next(s, c);
  }`)}`);
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768, addEventListener() {} };
  const { createStage } = await import('../public/js/scene.js');
  const stage = createStage({ clientWidth: 1000, clientHeight: 600, appendChild() {} });
  const sizes = [];
  stage.renderer.setSize = (w, h) => sizes.push([w, h]);
  stage.resize();
  stage.setSizeSource(() => ({ width: 420, height: 268 }));
  stage.resize();
  stage.setSizeSource(() => ({ width: 0, height: 0 })); // not laid out yet: the host's size, never zero
  stage.resize();
  stage.setSizeSource(() => null);
  stage.resize();
  stage.setSizeSource(null);
  stage.resize();
  assert.deepEqual(sizes, [[1000, 600], [420, 268], [1000, 600], [1000, 600], [1000, 600]]);
});

test('main.js runs its one loop through pip.js and hands the mini window what it needs; office.html has no markup for it', () => {
  const main = read('public/js/main.js');
  assert.match(main, /import \{ createFrameLoop, installPip \} from '\.\/pip\.js';/);
  assert.match(main, /\nconst needsYou = installNeedsYou\(\{ office, hud \}\);/, 'the needs-you reader is kept for the mini window');
  assert.match(main, /\nconst loop = createFrameLoop\(step\);/);
  assert.match(main, /\ninstallPip\(\{ stage, office, hud, host: document\.getElementById\('stage'\), loop, needsYou \}\);/);
  assert.match(main, /\nloop\.start\(\);/);
  assert.ok(main.indexOf('installPip(') < main.indexOf('loop.start()'));
  assert.doesNotMatch(main, /requestAnimationFrame/, 'main.js asks for no frame of its own: one loop');
  assert.ok(main.includes('installBench({ office, stage, frame: step })'), 'the bench still gets step itself');
  assert.doesNotMatch(read('public/office.html'), /pip-|documentPictureInPicture/);
  assert.ok(main.split('\n').length <= 500);
});

test('pip.js sends nothing and stores nothing, and stays under the line cap', () => {
  const src = read('public/js/pip.js');
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|cookie|https?:\/\//);
  assert.match(src, /from '\.\/needs-you\.js'/, 'the count text comes from needs-you.js, not from a copy');
  assert.doesNotMatch(src, /확인 필요|Needs you/);
  assert.ok(src.split('\n').length <= 500, 'pip.js line cap');
  for (const rel of ['public/js/scene.js', 'public/js/main.js', 'public/office.html', 'public/js/rooms.js', 'public/js/hud.js']) {
    assert.ok(read(rel).split('\n').length <= 500, `${rel} line cap`);
  }
});

test('the documents describe the mini window: the specification, both READMEs, the changelog, CLAUDE.md', () => {
  const contract = read('docs/CONTRACT.md');
  const at = contract.indexOf('\n### 9.6 ');
  assert.ok(at > contract.indexOf('\n### 9.5 ') && at < contract.indexOf('\n## 10. '), 'a subsection 9.6 after 9.5');
  const s96 = contract.slice(at, contract.indexOf('\n## 10. '));
  for (const re of [/documentPictureInPicture/, /requestWindow/, /placeholder/, /30/, /pagehide/, /D29/, /D30/, /D31/, /public\/js\/pip\.js/, /test\/pip\.test\.mjs/]) assert.match(s96, re);
  assert.match(contract.slice(contract.indexOf('\n## 1. Layout'), contract.indexOf('\n## 2. ')), /js\/pip\.js/);
  for (const [rel, heading, words] of [
    ['README.md', '## Features', [/Mini window/, /Chrome/, /Edge/, /Safari/, /Firefox/]],
    ['README.ko.md', '## 기능', [/미니 창/, /Chrome/, /Edge/, /Safari/, /Firefox/]],
  ]) {
    const all = read(rel).split('\n');
    const from = all.indexOf(heading);
    const to = all.findIndex((l, i) => i > from && l.startsWith('## '));
    const bullets = all.slice(from + 1, to).filter((l) => l.startsWith('- ') && words[0].test(l));
    assert.equal(bullets.length, 1, `${rel}: one feature bullet`);
    for (const re of words) assert.match(bullets[0], re, rel);
  }
  const en = read('README.md').split('\n');
  const ko = read('README.ko.md').split('\n');
  assert.equal(en.length, ko.length, 'the two READMEs keep the same number of lines');
  assert.equal(en.findIndex((l) => /^- \*\*Mini window/.test(l)), ko.findIndex((l) => /^- \*\*미니 창/.test(l)), 'the bullet is on the same line in both');
  const changelog = read('CHANGELOG.md');
  const added = changelog.slice(changelog.indexOf('### Added'), changelog.indexOf('### Removed'));
  assert.match(added, /mini window/i);
  assert.match(added, /Chrome/);
  assert.ok(read('CLAUDE.md').includes('public/js/pip.js'));
});
