// 스트리머·OBS 오버레이 모드(?overlay=1, ?chroma=...), 5초 클립 캡처(public/js/share.js), npm 배포 및 후원 메타데이터 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CHROMA_PRESETS, SHARE_TEXT, shareText, normalizeChroma, parseOverlayMode,
  clipFilename, pickRecorderMime, installShareControls,
} from '../public/js/share.js';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('normalizeChroma and parseOverlayMode: supports ?overlay=1, #overlay, chroma presets, hex colors, and explicit off', () => {
  assert.equal(normalizeChroma('green'), CHROMA_PRESETS.green);
  assert.equal(normalizeChroma('BLUE'), '#0000ff');
  assert.equal(normalizeChroma('magenta'), '#ff00ff');
  assert.equal(normalizeChroma('#12ab34'), '#12ab34');
  assert.equal(normalizeChroma('12AB34'), '#12ab34');
  assert.equal(normalizeChroma('invalid'), null);
  assert.equal(normalizeChroma(null), null);

  assert.deepEqual(parseOverlayMode('', ''), { overlay: false, chroma: null });
  assert.deepEqual(parseOverlayMode('?overlay=1', ''), { overlay: true, chroma: null });
  assert.deepEqual(parseOverlayMode('?overlay=true', ''), { overlay: true, chroma: null });
  assert.deepEqual(parseOverlayMode('?overlay', ''), { overlay: true, chroma: null });
  assert.deepEqual(parseOverlayMode('', '#overlay'), { overlay: true, chroma: null });
  assert.deepEqual(parseOverlayMode('?chroma=green', ''), { overlay: true, chroma: '#00ff00' });
  assert.deepEqual(parseOverlayMode('?overlay=1&chroma=00ff00', ''), { overlay: true, chroma: '#00ff00' });
  assert.deepEqual(parseOverlayMode('?overlay=0&chroma=green', '#overlay'), { overlay: false, chroma: '#00ff00' });
});

test('clipFilename and pickRecorderMime: formats deterministic timestamped filenames and selects supported WebM codec', () => {
  const d = new Date(2026, 9, 23, 14, 5, 9); // 2026-10-23 14:05:09 local
  assert.equal(clipFilename('webm', d), 'office-sim-20261023-140509.webm');
  assert.equal(clipFilename('.png', d), 'office-sim-20261023-140509.png');

  assert.equal(pickRecorderMime((m) => m.includes('vp9')), 'video/webm;codecs=vp9');
  assert.equal(pickRecorderMime((m) => m === 'video/webm'), 'video/webm');
  assert.equal(pickRecorderMime(() => false), '');
});

test('installShareControls: toggles overlay class and stage background, handles O/Escape keys, and records PNG/WebM', () => {
  const makeEl = () => {
    const listeners = {};
    const attrs = {};
    return {
      textContent: '',
      title: '',
      hidden: false,
      disabled: false,
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k]; },
      addEventListener(ev, fn) { (listeners[ev] ??= []).push(fn); },
      click(e = {}) { for (const fn of listeners.click || []) fn(e); },
      remove() {},
    };
  };

  const els = {
    'toggle-overlay': makeEl(),
    'exit-overlay': makeEl(),
    'capture-clip': makeEl(),
  };
  const downloads = [];
  const bodyClasses = new Set();
  const doc = {
    body: {
      classList: {
        toggle(c, on) { if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
      },
      appendChild(a) { downloads.push({ href: a.href, download: a.download }); },
    },
    getElementById: (id) => els[id] || null,
    createElement: () => makeEl(),
  };

  const winListeners = {};
  const win = {
    location: { search: '?overlay=1&chroma=green', hash: '' },
    addEventListener(ev, fn) { (winListeners[ev] ??= []).push(fn); },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; },
  };

  let overlayBg = null;
  const stage = {
    renderer: {
      domElement: {
        toDataURL: () => 'data:image/png;base64,AAA',
      },
    },
    setOverlayBg(bg) { overlayBg = bg; },
    render() {},
  };
  const langBtn = makeEl();
  const hud = { lang: 'ko', el: { langBtn }, office: { labelRoot: () => null } };

  const ctrl = installShareControls({ stage, hud, doc, win });
  assert.equal(ctrl.state.overlay, true);
  assert.equal(bodyClasses.has('overlay'), true);
  assert.equal(overlayBg, '#00ff00');
  assert.equal(els['exit-overlay'].hidden, false);
  assert.equal(els['toggle-overlay'].textContent, SHARE_TEXT.ko.overlayBtn);

  // Switch language to English
  hud.lang = 'en';
  langBtn.click();
  assert.equal(els['toggle-overlay'].textContent, SHARE_TEXT.en.overlayBtn);
  assert.equal(els['capture-clip'].textContent, SHARE_TEXT.en.clipBtn);

  // Press Escape to exit overlay mode
  for (const fn of winListeners.keydown || []) fn({ key: 'Escape', target: { closest: () => null }, preventDefault() {} });
  assert.equal(ctrl.state.overlay, false);
  assert.equal(bodyClasses.has('overlay'), false);
  assert.equal(overlayBg, null);
  assert.equal(els['exit-overlay'].hidden, true);

  // Press O to re-enable overlay mode
  for (const fn of winListeners.keydown || []) fn({ key: 'o', target: { closest: () => null }, preventDefault() {} });
  assert.equal(ctrl.state.overlay, true);
  assert.equal(overlayBg, '#00ff00');

  // Shift+Click or fallback without MediaRecorder triggers PNG download
  els['capture-clip'].click({ shiftKey: true });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].href, 'data:image/png;base64,AAA');
  assert.match(downloads[0].download, /^office-sim-\d{8}-\d{6}\.png$/);
  assert.equal(shareText('ko').clipBtn, '5초 클립');
});

test('package.json, FUNDING.yml, and source files stay under 500 lines and include npm + sponsorship metadata', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.ok(Array.isArray(pkg.funding) && pkg.funding.length >= 2);
  assert.ok(pkg.files.includes('scripts/install-skill.mjs'));
  assert.ok(!pkg.files.includes('scripts/'), 'fake-* test scripts are excluded from published tarball');

  const funding = read('.github/FUNDING.yml');
  assert.match(funding, /github:\s*\[WahyzMaster\]/);
  assert.match(funding, /buy_me_a_coffee:\s*wahyzdad/);

  const publishWf = read('.github/workflows/publish.yml');
  assert.match(publishWf, /branches:\s*\n\s*-\s*master/);
  assert.match(publishWf, /contents:\s*write/);
  assert.match(publishWf, /chore\(release\):/);
  assert.match(publishWf, /npm version "\$BUMP"/);
  assert.match(publishWf, /npm publish --provenance --access public/);

  for (const rel of ['public/office.html', 'public/js/share.js', 'public/js/scene.js', 'public/js/main.js', 'public/js/hud.js']) {
    const lines = read(rel).split('\n').length;
    assert.ok(lines <= 500, `${rel} is ${lines} lines (must be <= 500)`);
  }
});
