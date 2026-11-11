// 첫 화면의 기본값 (launch readiness D8, D9): 스크립트가 돌기 전의 office.html 은 영어이고, 스크립트가 돌면 고른 언어로
// 바뀐다 (public/js/static-text.js 와 기존 hud 의 언어 전환). 소리는 꺼진 채 시작한다. DOM 은 작은 가짜로 대신한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { STATIC_TEXT, applyStaticText, installStaticText } from '../public/js/static-text.js';
import { soundPrefOn } from '../public/js/sound.js';
import { detectLang, langOf, uiText, ROOM_THEMES } from '../public/js/rooms.js';
import { shareText } from '../public/js/share.js';
import { pageHead } from '../src/page-shell.mjs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const HTML = read('public/office.html');
const HANGUL = /[가-힣]/;
const openTag = (id) => HTML.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? null;

// ---- D8: 언어 ----

test('detectLang: Korean only for a Korean browser locale, English for every other', () => {
  // D8 그대로: 로케일이 ko 로 시작할 때만 한국어 (대소문자는 가리지 않는다)
  for (const ko of ['ko', 'ko-KR', 'KO-kr', 'ko_KR', 'ko-Kore-KR']) assert.equal(detectLang(ko), 'ko', ko);
  for (const en of ['en', 'en-US', 'fr-FR', 'ja', 'zh-Hans-CN', 'de', 'x-ko', ' ko', '', undefined, null, 42]) {
    assert.equal(detectLang(en), 'en', String(en));
  }
});

test('the served document says lang="en" (the page sets the chosen language once scripts run)', () => {
  assert.match(read('src/server-http.mjs'), /const HEAD = pageHead\(\{ lang: 'en' \}\);/);
  assert.ok(pageHead({ lang: 'en' }).startsWith('<!doctype html><html lang="en">'));
});

test('office.html: nothing a visitor sees or hears before scripts run is Korean', () => {
  // 한국어가 남아도 되는 곳: CSS 와 HTML 주석, 숨겨진 기록 관찰 패널과 그 버튼(page-observe.test 가 문구를 고정한다),
  // 그리고 언어를 스스로 고르는 인라인 스크립트.
  const visible = HTML
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<section id="observe"[\s\S]*?<\/section>/, '')
    .replace(/<button[^>]*id="toggle-observe"[^>]*>[^<]*<\/button>/, '');
  const left = visible.split('\n').filter((line) => HANGUL.test(line)).map((line) => line.trim().slice(0, 90));
  assert.deepEqual(left, []);
  assert.match(openTag('toggle-observe'), / hidden /, 'the Korean observe button is hidden until scripts show it');
  assert.match(HTML.match(/<section id="observe"[^>]*>/)[0], / hidden /);
});

test('office.html: the English defaults are the same strings the scripts set for English (no flash of other wording)', () => {
  const t = uiText('en');
  const s = shareText('en');
  const text = (id) => HTML.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1];
  assert.equal(text('sub'), t.subInterval(250));
  assert.equal(HTML.match(/<span id="source"[^>]*><i><\/i><span>([^<]*)<\/span>/)[1], t.source.demo);
  assert.equal(text('theme-label'), t.themeLabel);
  assert.equal(text('char-label'), t.charLabel);
  assert.equal(text('posture-label'), t.postureLabel);
  assert.equal(text('motion-label'), t.motionLabel);
  assert.equal(text('voice-label'), t.voiceLabel);
  assert.equal(text('control-label'), t.controlLabel);
  assert.equal(text('color-theme'), t.colorLabel.system);
  assert.equal(text('lang-toggle'), 'EN');
  assert.equal(text('capture-clip'), s.clipBtn);
  assert.equal(text('toggle-overlay'), s.overlayBtn);
  assert.equal(text('exit-overlay'), s.overlayExit);
  assert.equal(text('toggle-legend'), t.legendBtn);
  assert.equal(text('toggle-log'), t.logBtn);
  assert.equal(text('close-legend'), t.close);
  assert.equal(text('reset-llm-map'), t.resetCastBtn);
  assert.equal(text('legend-controls'), t.controls.map.hint);
  assert.ok(HTML.includes(`<h2>${t.logTitle}</h2>`));
  assert.ok(HTML.includes(`<h2>${t.legendTitle}</h2>`));
  for (const [k, label] of Object.entries(t.legendSections)) assert.ok(HTML.includes(`data-lg-head="${k}">${label}<`), k);
  for (const [k, v] of Object.entries(ROOM_THEMES)) assert.ok(HTML.includes(`<option value="${k}">${v.name.en}</option>`), k);
  for (const group of [t.postures, t.motions, t.voices]) {
    for (const [k, label] of Object.entries(group)) assert.ok(HTML.includes(`<option value="${k}">${label}</option>`), `${k}: ${label}`);
  }
  for (const [k, spec] of Object.entries(t.controls)) assert.ok(HTML.includes(`<option value="${k}">${spec.label}</option>`), k);
  assert.ok(HTML.includes(`data-llm="all" aria-pressed="true">${t.llmAll}</button>`));
  assert.ok(HTML.includes(`data-act="pet">${t.petBtn}</button>`));
  assert.ok(HTML.includes(`data-act="follow" aria-pressed="false">${t.follow}</button>`));
  assert.ok(HTML.includes(`data-act="close">${t.close}</button>`));
});

// ---- 스크립트가 바꾸지 않던 글자: aria-label ----

test('STATIC_TEXT: every entry has Korean and English, and office.html starts with the English one', () => {
  assert.ok(STATIC_TEXT.length >= 15);
  const seen = new Set();
  for (const [selector, attr, ko, en] of STATIC_TEXT) {
    assert.equal(attr, 'aria-label');
    assert.match(ko, HANGUL, selector);
    assert.doesNotMatch(en, HANGUL, selector);
    assert.ok(en.trim().length > 2, selector);
    assert.ok(!seen.has(selector), `duplicate ${selector}`);
    seen.add(selector);
    const tag = selector.startsWith('#inspector ')
      ? HTML.match(/<select class="ghost" data-act="motion"[^>]*>/)?.[0]
      : openTag(selector.slice(1));
    assert.ok(tag, `office.html has ${selector}`);
    assert.ok(tag.includes(`aria-label="${en}"`), `${selector} starts as "${en}": ${tag}`);
  }
  // 반대 방향: office.html 의 aria-label 가운데 영어인 것은 모두 표에 있다 (한국어로 바꿔 줄 것이 빠지지 않게)
  const inPage = [...HTML.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((v) => !HANGUL.test(v));
  const known = new Set(STATIC_TEXT.map((e) => e[3]));
  assert.deepEqual(inPage.filter((v) => !known.has(v)), []);
});

function fakeDoc() {
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    return nodes.get(sel);
  };
  const listeners = [];
  return {
    nodes, listeners,
    documentElement: { lang: 'en' },
    querySelector: (sel) => (sel === '#missing' ? null : node(sel)),
    getElementById: (id) => (id === 'lang-toggle' ? { addEventListener: (type, fn) => listeners.push([type, fn]) } : null),
  };
}

test('applyStaticText: sets each label in the chosen language and the document language', () => {
  const doc = fakeDoc();
  applyStaticText('ko', doc);
  assert.equal(doc.documentElement.lang, 'ko');
  for (const [selector, attr, ko] of STATIC_TEXT) assert.equal(doc.nodes.get(selector).attrs[attr], ko, selector);
  applyStaticText('en', doc);
  assert.equal(doc.documentElement.lang, 'en');
  for (const [selector, attr, , en] of STATIC_TEXT) assert.equal(doc.nodes.get(selector).attrs[attr], en, selector);
  // 없는 요소와 없는 문서는 건너뛴다
  assert.doesNotThrow(() => applyStaticText('ko', { documentElement: {}, querySelector: () => null }));
  assert.doesNotThrow(() => applyStaticText('ko', null));
});

test('installStaticText: applies the Hud language at start and again after the language button', () => {
  const doc = fakeDoc();
  const hud = { lang: 'ko' };
  installStaticText({ hud, doc });
  assert.equal(doc.documentElement.lang, 'ko', 'a Korean visitor gets Korean labels once scripts run');
  assert.equal(doc.nodes.get('#stage').attrs['aria-label'], STATIC_TEXT.find((e) => e[0] === '#stage')[2]);
  assert.equal(doc.listeners.length, 1);
  assert.equal(doc.listeners[0][0], 'click');
  hud.lang = 'en'; // hud.bind 의 클릭 처리기가 먼저 돌아 언어를 바꾼다
  doc.listeners[0][1]();
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.nodes.get('#stage').attrs['aria-label'], STATIC_TEXT.find((e) => e[0] === '#stage')[3]);
  assert.match(read('public/js/main.js'), /installStaticText\(\{ hud \}\);/);
  assert.equal(langOf(hud.lang), 'en');
});

// ---- 인라인 스크립트: 시작 문구와 불러오기 실패 문구 ----

const INLINE = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function runBoot({ navLang = 'en-US', search = '', saved, ready = false, storageThrows = false } = {}) {
  const boot = { textContent: HTML.match(/<div id="boot" class="boot">([^<]*)<\/div>/)[1], classes: [], classList: { add(c) { boot.classes.push(c); } } };
  const timers = [];
  const window = { __officeReady: ready };
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => (id === 'boot' ? boot : null) },
    navigator: { language: navLang },
    location: { search },
    localStorage: {
      getItem(k) {
        if (storageThrows) throw new Error('denied');
        return k === 'office-sim:v1' && saved !== undefined ? JSON.stringify(saved) : null;
      },
    },
    URLSearchParams,
    JSON,
    setTimeout: (fn, ms) => timers.push([fn, ms]),
  });
  vm.runInContext(INLINE[0], context);
  return { boot, timers, window };
}

test('boot text: English by default, Korean for a Korean locale; the saved or URL language wins, as in the Hud', () => {
  assert.equal(INLINE.length, 1, 'one inline script (its hash is in the CSP)');
  const en = runBoot();
  assert.equal(en.boot.textContent, 'Building the office…');
  assert.match(runBoot({ navLang: 'fr-FR' }).boot.textContent, /^Building/);
  const ko = runBoot({ navLang: 'ko-KR' });
  assert.equal(ko.boot.textContent, '사무실을 짓는 중…');
  assert.match(runBoot({ navLang: 'ko-KR', saved: { lang: 'en' } }).boot.textContent, /^Building/, 'a saved English choice wins');
  assert.match(runBoot({ navLang: 'en-US', saved: { lang: 'ko' } }).boot.textContent, HANGUL, 'a saved Korean choice wins');
  assert.match(runBoot({ navLang: 'ko-KR', search: '?lang=en' }).boot.textContent, /^Building/);
  assert.match(runBoot({ navLang: 'en-US', search: '?lang=ko', saved: { lang: 'en' } }).boot.textContent, HANGUL, '?lang= wins over the saved one');
  assert.match(runBoot({ navLang: 'ko-KR', storageThrows: true }).boot.textContent, HANGUL, 'blocked storage falls back to the locale');
  assert.match(runBoot({ navLang: 'en-US', storageThrows: true }).boot.textContent, /^Building/);
});

test('load-error text: after 9 s without the 3D engine, in the same language; nothing when the page is ready', () => {
  const en = runBoot();
  assert.equal(en.timers.length, 1);
  assert.equal(en.timers[0][1], 9000);
  en.timers[0][0]();
  assert.match(en.boot.textContent, /three\.js/);
  assert.doesNotMatch(en.boot.textContent, HANGUL);
  assert.deepEqual(en.boot.classes, ['err']);
  const ko = runBoot({ navLang: 'ko-KR' });
  ko.timers[0][0]();
  assert.match(ko.boot.textContent, /three\.js/);
  assert.match(ko.boot.textContent, HANGUL);
  const fine = runBoot({ navLang: 'ko-KR' });
  fine.window.__officeReady = true;
  fine.timers[0][0]();
  assert.equal(fine.boot.textContent, '사무실을 짓는 중…');
  assert.deepEqual(fine.boot.classes, []);
});

// ---- D9: 소리 ----

test('soundPrefOn: off unless the visitor turned it on; mute always wins', () => {
  assert.equal(soundPrefOn(undefined, 'auto'), false, 'no saved choice: off');
  assert.equal(soundPrefOn(null, 'dogs'), false);
  assert.equal(soundPrefOn(false, 'auto'), false);
  assert.equal(soundPrefOn(true, 'auto'), true, 'a saved choice wins');
  assert.equal(soundPrefOn(true, 'cats'), true);
  assert.equal(soundPrefOn(true, 'mute'), false);
  assert.equal(soundPrefOn('true', 'auto'), false, 'only a real saved true');
});

test('sound starts off: the Hud uses soundPrefOn and the button in office.html starts unpressed and says Muted', () => {
  const hud = read('public/js/hud.js');
  assert.match(hud, /this\.soundOn = setSoundEnabled\(soundPrefOn\(p\.soundOn, this\.voiceMode\)\);/);
  assert.doesNotMatch(hud, /p\.soundOn !== false/);
  const btn = openTag('sound-toggle');
  assert.ok(btn.includes('aria-pressed="false"'), btn);
  assert.equal(HTML.match(/id="sound-toggle"[^>]*>([^<]*)</)[1], uiText('en').soundLabel.off);
  const lines = hud.split('\n').length;
  assert.ok(lines <= 500, `hud.js is ${lines} lines`);
});
