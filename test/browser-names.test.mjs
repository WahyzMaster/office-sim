// office-sim 이름 (브라우저 쪽): localStorage 키 'office-sim:v1', 옛 키 'claude-office:v1' 에서 한 번 복사, 에이전트 화면 이름.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE, LEGACY_STORE, migratePrefs, loadPrefs, agentLabel, agentBadge, CONTROL_PRESETS, DEFAULT_CONTROL_PRESET, controlPresetOf } from '../public/js/hud.js';
import { BRAND_HUES, brandHue, hueGap } from '../public/js/placement.js';

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
