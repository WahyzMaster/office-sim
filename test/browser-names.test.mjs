// office-sim 이름 (브라우저 쪽): localStorage 키 'office-sim:v1', 옛 키 'claude-office:v1' 에서 한 번 복사, 에이전트 화면 이름.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE, LEGACY_STORE, migratePrefs, loadPrefs, agentLabel, agentBadge, CONTROL_PRESETS, DEFAULT_CONTROL_PRESET, controlPresetOf } from '../public/js/hud.js';
import { BRAND_HUES, brandHue, hueGap, route } from '../public/js/placement.js';
import {
  ROOMS, SLOTS, ELEVATOR, ROOM_THEMES, DEFAULT_ROOM_THEME, roomThemeOf, langOf, detectLang, roomLabel, applyRoomTheme, uiText,
  LEGEND_AGENTS, LEGEND_SIGNALS, legendAgentsFor, legendSignalsFor,
} from '../public/js/rooms.js';
import { THEME_LAYOUTS, corridorWaypoints } from '../public/js/theme-layouts.js';

// Map 으로 만든 가짜 localStorage. 실제 브라우저 저장소는 건드리지 않는다.
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test('storage keys: new key is office-sim:v1, legacy key is claude-office:v1', () => {
  assert.equal(STORE, 'office-sim:v1');
  assert.equal(LEGACY_STORE, 'claude-office:v1');
});

test('migratePrefs copies the legacy prefs once, keeps the old key and never overwrites the new key', () => {
  const old = JSON.stringify({ labels: false, floor: 2 });
  const s = fakeStorage({ [LEGACY_STORE]: old });
  assert.equal(migratePrefs(s), true);
  assert.equal(s.getItem(STORE), old);
  assert.equal(s.getItem(LEGACY_STORE), old, 'the old key is copied, not removed');
  assert.equal(migratePrefs(s), false, 'second call does nothing');

  const both = fakeStorage({ [STORE]: '{"labels":true}', [LEGACY_STORE]: old });
  assert.equal(migratePrefs(both), false);
  assert.equal(both.getItem(STORE), '{"labels":true}');

  const empty = fakeStorage();
  assert.equal(migratePrefs(empty), false);
  assert.equal(empty.map.size, 0);
});

test('loadPrefs reads the new key after migration and survives missing, corrupt or throwing storage', () => {
  assert.deepEqual(loadPrefs(fakeStorage({ [LEGACY_STORE]: '{"floor":3}' })), { floor: 3 });
  assert.deepEqual(loadPrefs(fakeStorage({ [STORE]: '{"floor":1}', [LEGACY_STORE]: '{"floor":3}' })), { floor: 1 });
  assert.deepEqual(loadPrefs(fakeStorage()), {});
  assert.deepEqual(loadPrefs(fakeStorage({ [LEGACY_STORE]: '{not json' })), {});
  assert.deepEqual(loadPrefs(fakeStorage({ [STORE]: '7' })), {});
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(migratePrefs(throwing), false);
  assert.deepEqual(loadPrefs(throwing), {});
});

test('agentLabel: the four agent ids get display labels (with Antigravity surface distinction), unknown ids pass through as-is', () => {
  assert.equal(agentLabel('claude-code'), 'Claude Code');
  assert.equal(agentLabel('codex'), 'Codex');
  assert.equal(agentLabel('grok'), 'Grok');
  assert.equal(agentLabel('antigravity'), 'Antigravity');
  assert.equal(agentLabel('antigravity', 'cli'), 'Antigravity (CLI)');
  assert.equal(agentLabel('antigravity', 'app'), 'Antigravity (App)');
  assert.equal(agentLabel('antigravity', 'ide'), 'Antigravity (IDE)');
  assert.equal(agentLabel('cursor'), 'cursor');
  assert.equal(agentLabel('constructor'), 'constructor');
});

test('controlPresetOf: supports map, figma, orbit and blender presets and falls back to map', () => {
  assert.equal(DEFAULT_CONTROL_PRESET, 'map');
  assert.deepEqual(Object.keys(CONTROL_PRESETS), ['map', 'figma', 'orbit', 'blender']);
  for (const k of ['map', 'figma', 'orbit', 'blender']) {
    assert.equal(controlPresetOf(k), k);
    assert.ok(CONTROL_PRESETS[k].label.length > 0 && CONTROL_PRESETS[k].hint.length > 0);
  }
  assert.equal(controlPresetOf('unknown'), 'map');
  assert.equal(controlPresetOf(undefined), 'map');
});

test('agentBadge and brandHue: compact badges and distinct brand hue families per agent and surface', () => {
  assert.equal(agentBadge('claude-code'), 'Claude');
  assert.equal(agentBadge('codex'), 'Codex');
  assert.equal(agentBadge('grok'), 'Grok');
  assert.equal(agentBadge('antigravity'), 'AGY');
  assert.equal(agentBadge('antigravity', 'cli'), 'AGY·CLI');
  assert.equal(agentBadge('antigravity', 'app'), 'AGY·App');
  assert.equal(agentBadge('antigravity', 'ide'), 'AGY·IDE');
  assert.equal(agentBadge(''), '');

  const hClaude = brandHue('claude-code', '', 'sid-1');
  const hCodex = brandHue('codex', '', 'sid-2');
  const hGrok = brandHue('grok', '', 'sid-3');
  const hAgyCli = brandHue('antigravity', 'cli', 'sid-4');
  const hAgyApp = brandHue('antigravity', 'app', 'sid-4');
  assert.ok(hueGap(hClaude, BRAND_HUES['claude-code']) <= 20);
  assert.ok(hueGap(hCodex, BRAND_HUES.codex) <= 20);
  assert.ok(hueGap(hGrok, BRAND_HUES.grok) <= 20);
  assert.ok(hueGap(hAgyCli, BRAND_HUES['antigravity:cli']) <= 20);
  assert.ok(hueGap(hAgyApp, BRAND_HUES['antigravity:app']) <= 20);
  assert.notEqual(hAgyCli, hAgyApp);
  const hAgyApp2 = brandHue('antigravity', 'app', 'sid-4', [hAgyApp]);
  assert.ok(hueGap(hAgyApp, hAgyApp2) >= 4);
});

test('ROOM_THEMES and applyRoomTheme: supports studio, office, palace, hanok and starship in KO and EN', () => {
  assert.equal(DEFAULT_ROOM_THEME, 'studio');
  assert.deepEqual(Object.keys(ROOM_THEMES), ['studio', 'office', 'palace', 'hanok', 'starship']);
  assert.equal(roomThemeOf('palace'), 'palace');
  assert.equal(roomThemeOf('hanok'), 'hanok');
  assert.equal(roomThemeOf('invalid'), 'studio');
  assert.equal(langOf('en'), 'en');
  assert.equal(langOf('ko'), 'ko');
  assert.equal(langOf('fr'), 'ko');
  assert.equal(detectLang('en-US'), 'en');
  assert.equal(detectLang('ko-KR'), 'ko');

  assert.equal(roomLabel('archive', 'palace', 'ko'), '규장각');
  assert.equal(roomLabel('desk', 'palace', 'ko'), '승정원');
  assert.equal(roomLabel('dev', 'hanok', 'ko'), '글방');
  assert.equal(roomLabel('desk', 'hanok', 'ko'), '사랑채');
  assert.equal(roomLabel('desk', 'studio', 'en'), 'Review Booth');

  applyRoomTheme('palace', 'ko');
  assert.equal(ROOMS.archive.label, '규장각');
  assert.equal(ROOMS.desk.label, '승정원');
  applyRoomTheme('studio', 'en');
  assert.equal(ROOMS.archive.label, 'Codebase Lab');
  assert.equal(ROOMS.desk.label, 'Review Booth');
  applyRoomTheme('studio', 'ko');
  assert.equal(ROOMS.archive.label, '코드 탐색실');
  assert.equal(ROOMS.desk.label, '리뷰·승인 부스');
  assert.equal(uiText('en').globalFloor, 'Global · Unassigned');
  assert.equal(uiText('ko').globalFloor, '전역 · 미지정');
});

test('THEME_LAYOUTS and route: non-rectangular ring themes detour around central pond/courtyard/warp core', () => {
  for (const k of ['studio', 'office', 'palace', 'hanok', 'starship']) {
    assert.ok(THEME_LAYOUTS[k], k);
    for (const r of Object.keys(ROOMS)) assert.ok(THEME_LAYOUTS[k].slots[r]?.length > 0, `${k}.${r}`);
  }
  // spine themes walk straight along z = lane without extra detour waypoints
  assert.deepEqual(corridorWaypoints(-8, 0, 8, 0, 0, 'studio'), []);
  // ring themes (palace, hanok, starship) insert perimeter waypoints when crossing x = 0
  const palaceWps = corridorWaypoints(-8, -0.2, 8, -0.2, 0, 'palace');
  assert.equal(palaceWps.length, 2);
  assert.ok(Math.abs(palaceWps[0].z) >= 1.3, 'detours outside central pond');

  applyRoomTheme('hanok', 'ko');
  assert.equal(ELEVATOR.x, -11.6);
  assert.equal(SLOTS.research[0][0], -10.6, 'hanok protruding pavilion slot is active');
  const hanokRoute = route({ x: -10.3, z: -6.2 }, 'server', 5.6, -5.7, 0, 'hanok');
  assert.ok(hanokRoute.some((p) => Math.abs(p.z) >= 1.3 && Math.abs(p.x) <= 3.5), 'route detours along veranda');
  applyRoomTheme('studio', 'ko');
});

test('LEGEND_AGENTS and LEGEND_SIGNALS: provide theme-adaptive agent swatches and status color signals in KO/EN', () => {
  assert.equal(LEGEND_AGENTS.length, 6);
  assert.equal(LEGEND_SIGNALS.length, 7);
  const palaceKo = legendAgentsFor('palace', 'ko');
  assert.ok(palaceKo.find((a) => a.id === 'claude')?.desc.includes('정자관'));
  assert.ok(palaceKo.find((a) => a.id === 'codex')?.desc.includes('흑립 갓'));
  const starshipEn = legendAgentsFor('starship', 'en');
  assert.ok(starshipEn.find((a) => a.id === 'sub')?.desc.includes('Hover drone rotor'));
  const signalsKo = legendSignalsFor('ko');
  assert.ok(signalsKo.some((s) => s.id === 'error' && s.desc.includes('식은땀')));
  const signalsEn = legendSignalsFor('en');
  assert.ok(signalsEn.some((s) => s.id === 'ask' && s.desc.includes('approval')));
});
