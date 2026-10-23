// office-sim 이름 (브라우저 쪽): localStorage 키 'office-sim:v1', 옛 키 'claude-office:v1' 에서 한 번 복사, 에이전트 화면 이름.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE, LEGACY_STORE, migratePrefs, loadPrefs, agentLabel, agentBadge, CONTROL_PRESETS, DEFAULT_CONTROL_PRESET, controlPresetOf } from '../public/js/hud.js';
import {
  BRAND_HUES, brandHue, hueGap, route,
  hitObstacle, segmentHitsObstacle, resolveObstacleCollision, safeSpawnPos, findSafePath, separateAgents,
} from '../public/js/placement.js';
import {
  ROOMS, SLOTS, ELEVATOR, ROOM_THEMES, DEFAULT_ROOM_THEME, roomThemeOf, langOf, detectLang, roomLabel, applyRoomTheme, uiText,
  LEGEND_AGENTS, LEGEND_CATALOG, LEGEND_SIGNALS, legendAgentsFor, legendCatalogFor, legendSignalsFor,
  POSTURE_MODES, DEFAULT_POSTURE_MODE, postureModeOf, setPostureMode, effectivePosture,
  CHAR_THEMES, charThemeOf, activeCharThemeOf, setCharTheme,
  VOICE_MODES, voiceModeOf, setVoiceMode, COLOR_THEMES, colorThemeOf, setColorTheme,
  LLM_FILTERS, llmFilterOf, setLlmFilter, isLlmVisible,
  CHARACTER_CATALOG, DEFAULT_LLM_CHAR_MAP, activeLlmCharMapOf, setLlmCharMap, resetLlmCharMap, resolveAgentAppearance,
} from '../public/js/rooms.js';
import {
  CharacterVoice, DogVoice, CatVoice, SynthVoice, voiceFor, makeSound, setSoundEnabled, isSoundEnabled,
} from '../public/js/sound.js';
import { THEME_LAYOUTS, corridorWaypoints, obstaclesOf } from '../public/js/theme-layouts.js';
import { MockSource } from '../public/js/sources.js';

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

test('ROOM_THEMES and applyRoomTheme: supports dogs, cats, studio, office, palace, hanok and starship in KO and EN', () => {
  assert.equal(DEFAULT_ROOM_THEME, 'studio');
  assert.deepEqual(Object.keys(ROOM_THEMES), ['dogs', 'cats', 'studio', 'office', 'palace', 'hanok', 'starship']);
  assert.equal(roomThemeOf('palace'), 'palace');
  assert.equal(roomThemeOf('hanok'), 'hanok');
  assert.equal(roomThemeOf('dogs'), 'dogs');
  assert.equal(roomThemeOf('cats'), 'cats');
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
  assert.equal(roomLabel('archive', 'dogs', 'ko'), '노즈워크 숲');
  assert.equal(roomLabel('desk', 'cats', 'ko'), '츄르·집사 호출석');
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
  for (const k of ['studio', 'office', 'palace', 'hanok', 'starship', 'dogs', 'cats']) {
    assert.ok(THEME_LAYOUTS[k], k);
    for (const r of Object.keys(ROOMS)) assert.ok(THEME_LAYOUTS[k].slots[r]?.length > 0, `${k}.${r}`);
  }
  // spine themes walk straight along z = lane without extra detour waypoints
  assert.deepEqual(corridorWaypoints(-8, 0, 8, 0, 0, 'studio'), []);
  // ring themes (palace, hanok, starship, dogs, cats) insert perimeter waypoints when crossing x = 0
  const palaceWps = corridorWaypoints(-8, -0.2, 8, -0.2, 0, 'palace');
  assert.equal(palaceWps.length, 2);
  assert.ok(Math.abs(palaceWps[0].z) >= 1.3, 'detours outside central pond');
  assert.equal(corridorWaypoints(-8, -0.2, 8, -0.2, 0, 'dogs').length, 2);
  assert.equal(corridorWaypoints(-8, -0.2, 8, -0.2, 0, 'cats').length, 2);

  applyRoomTheme('hanok', 'ko');
  assert.equal(ELEVATOR.x, -11.6);
  assert.equal(SLOTS.research[0][0], -10.6, 'hanok protruding pavilion slot is active');
  const hanokRoute = route({ x: -10.3, z: -6.2 }, 'server', 5.6, -5.7, 0, 'hanok');
  assert.ok(hanokRoute.some((p) => Math.abs(p.z) >= 1.3 && Math.abs(p.x) <= 3.5), 'route detours along veranda');
  applyRoomTheme('studio', 'ko');
});

test('LEGEND_AGENTS and LEGEND_SIGNALS: provide theme-adaptive agent/pet swatches and status color signals in KO/EN', () => {
  assert.equal(LEGEND_AGENTS.length, 6);
  assert.equal(LEGEND_SIGNALS.length, 7);
  const palaceKo = legendAgentsFor('palace', 'ko');
  assert.ok(palaceKo.find((a) => a.id === 'claude')?.desc.includes('정자관'));
  assert.ok(palaceKo.find((a) => a.id === 'codex')?.desc.includes('흑립 갓'));
  const dogsKo = legendAgentsFor('dogs', 'ko');
  assert.equal(dogsKo.length, 8);
  assert.ok(dogsKo.some((d) => d.id === 'dog-jindo-bear' && d.desc.includes('반달 가슴털')));
  assert.ok(dogsKo.some((d) => d.id === 'dog-collie' && d.label === '보더 콜리'));
  const catsEn = legendAgentsFor('cats', 'en');
  assert.equal(catsEn.length, 6);
  assert.ok(catsEn.some((c) => c.id === 'cat-savannah' && c.desc.includes('Highest-priced cat')));
  const starshipEn = legendAgentsFor('starship', 'en');
  assert.ok(starshipEn.find((a) => a.id === 'sub')?.desc.includes('Hover drone rotor'));
  const signalsKo = legendSignalsFor('ko');
  assert.ok(signalsKo.some((s) => s.id === 'error' && s.desc.includes('식은땀')));
  const signalsEn = legendSignalsFor('en');
  assert.ok(signalsEn.some((s) => s.id === 'ask' && s.desc.includes('approval')));
  assert.equal(LEGEND_CATALOG.length, 19);
  assert.equal(legendCatalogFor('ko', 'all').length, 19);
  assert.equal(legendCatalogFor('ko', 'dogs').length, 8);
  assert.equal(legendCatalogFor('ko', 'cats').length, 6);
  assert.equal(legendCatalogFor('en', 'human').length, 5);
});

test('POSTURE_MODES and effectivePosture: auto resolves tetrapod for dogs/cats and bipod for humanoid themes', () => {
  assert.deepEqual(POSTURE_MODES, ['auto', 'tetrapod', 'bipod']);
  assert.equal(DEFAULT_POSTURE_MODE, 'auto');
  assert.equal(postureModeOf('tetrapod'), 'tetrapod');
  assert.equal(postureModeOf('bipod'), 'bipod');
  assert.equal(postureModeOf('invalid'), 'auto');
  assert.equal(effectivePosture('dogs', 'auto'), 'tetrapod');
  assert.equal(effectivePosture('cats', 'auto'), 'tetrapod');
  assert.equal(effectivePosture('studio', 'auto'), 'bipod');
  assert.equal(effectivePosture('dogs', 'bipod'), 'bipod');
  assert.equal(effectivePosture('studio', 'tetrapod'), 'tetrapod');
  setPostureMode('auto');
});

test('CharacterVoice abstraction and DogVoice/CatVoice/SynthVoice implementations (bark, meow, purr, chime)', () => {
  const base = new CharacterVoice();
  assert.throws(() => base.resolve(), /must be implemented/);
  assert.throws(() => base.play(), /must be implemented/);

  const dog = voiceFor({ id: 's1', agent: 'claude-code' }, 'dogs');
  assert.ok(dog instanceof DogVoice);
  assert.equal(dog.makeSound('click').soundId, 'bark');
  assert.equal(dog.makeSound('pet').soundId, 'happyBark');
  assert.equal(dog.makeSound('error').soundId, 'whimper');

  const cat = voiceFor({ id: 's2', agent: 'claude-code' }, 'cats');
  assert.ok(cat instanceof CatVoice);
  assert.equal(cat.makeSound('click').soundId, 'meow');
  assert.equal(cat.makeSound('work').soundId, 'purr');
  assert.equal(cat.makeSound('error').soundId, 'hiss');

  const palace = voiceFor({ id: 's3', agent: 'codex' }, 'palace');
  assert.ok(palace instanceof SynthVoice);
  assert.equal(palace.makeSound('click').soundId, 'chime');

  const agent = { id: 's1', agent: 'antigravity', surface: 'app' };
  const s1 = makeSound(agent, 'ask', { theme: 'dogs', lang: 'ko', force: true });
  assert.equal(s1.soundId, 'bark');
  assert.equal(s1.text, '왈! 왈!');
  assert.ok(agent.soundT > 0);
  assert.equal(agent.vocalText, '왈! 왈!');

  assert.equal(setSoundEnabled(false), false);
  assert.equal(isSoundEnabled(), false);
  assert.equal(setSoundEnabled(true), true);
});

test('Independent selections and custom LLM-to-character mapping (llmCharMap + per-agent overrides)', () => {
  // Place and Character are completely independent
  applyRoomTheme('palace', 'ko');
  setCharTheme('dogs');
  setPostureMode('auto');
  setVoiceMode('auto');
  resetLlmCharMap();

  assert.equal(ROOMS.archive.label, '규장각', 'Place is palace');
  assert.equal(activeCharThemeOf(), 'dogs', 'Character theme is independently dogs');
  assert.ok(Object.keys(CHAR_THEMES).length >= 20);
  assert.ok(Object.keys(CHARACTER_CATALOG).includes('dog:golden'));
  assert.ok(Object.keys(CHARACTER_CATALOG).includes('cat:savannah'));
  assert.ok(Object.keys(CHARACTER_CATALOG).includes('human:palace'));

  // Tier 3: default mapping from activeCharTheme ('dogs')
  const claudeDefault = resolveAgentAppearance({ agent: 'claude-code', surface: '' });
  assert.equal(claudeDefault.charSpec, DEFAULT_LLM_CHAR_MAP.dogs['claude-code']);
  assert.equal(claudeDefault.family, 'dogs');
  assert.equal(claudeDefault.breed, 'golden');
  assert.equal(claudeDefault.posture, 'tetrapod');
  assert.equal(claudeDefault.voiceKind, 'dogs');

  // Tier 2: custom LLM-to-character mapping overrides global charTheme for that LLM only
  setLlmCharMap('codex', 'cat:bengal');
  setLlmCharMap('grok', 'human:starship');
  assert.equal(activeLlmCharMapOf().codex, 'cat:bengal');
  const codexMapped = resolveAgentAppearance({ agent: 'codex', surface: '' });
  assert.equal(codexMapped.charSpec, 'cat:bengal');
  assert.equal(codexMapped.family, 'cats');
  assert.equal(codexMapped.breed, 'bengal');
  assert.equal(codexMapped.posture, 'tetrapod');
  const grokMapped = resolveAgentAppearance({ agent: 'grok', surface: '' });
  assert.equal(grokMapped.charSpec, 'human:starship');
  assert.equal(grokMapped.family, 'human');
  assert.equal(grokMapped.style, 'starship');
  assert.equal(grokMapped.posture, 'bipod');

  // Tier 1: per-agent charOverride & postureOverride take highest priority
  const customSession = resolveAgentAppearance({
    agent: 'codex',
    surface: '',
    charOverride: 'dog:corgi',
    postureOverride: 'bipod',
  });
  assert.equal(customSession.charSpec, 'dog:corgi');
  assert.equal(customSession.breed, 'corgi');
  assert.equal(customSession.posture, 'bipod');

  // Independent voiceMode, colorTheme, and llmFilter
  assert.equal(setVoiceMode('chime'), 'chime');
  assert.equal(voiceModeOf('invalid'), 'auto');
  assert.equal(resolveAgentAppearance({ agent: 'claude-code' }).voiceStyle, 'palace');
  assert.deepEqual(VOICE_MODES, ['auto', 'dogs', 'cats', 'chime', 'chirp', 'blip', 'mute']);
  assert.deepEqual(COLOR_THEMES, ['system', 'light', 'dark']);
  assert.equal(setColorTheme('dark'), 'dark');
  assert.equal(colorThemeOf('invalid'), 'system');
  assert.deepEqual(LLM_FILTERS, ['all', 'claude-code', 'codex', 'grok', 'antigravity']);
  setLlmFilter('codex');
  assert.equal(isLlmVisible({ agent: 'codex' }), true);
  assert.equal(isLlmVisible({ agent: 'claude-code' }), false);
  setLlmFilter('all');
  assert.equal(llmFilterOf('invalid'), 'all');

  // Reset restores defaults
  resetLlmCharMap();
  setCharTheme('studio');
  setPostureMode('auto');
  setVoiceMode('auto');
  setColorTheme('system');
  applyRoomTheme('studio', 'ko');
});

test('Materialized non-overlapping obstacles, safe pathfinding and dynamic agent separation', () => {
  for (const [theme, lay] of Object.entries(THEME_LAYOUTS)) {
    const obs = obstaclesOf(theme);
    assert.ok(obs.length >= 20, `${theme} has materialized obstacles`);
    for (const [room, slots] of Object.entries(lay.slots)) {
      slots.forEach(([sx, sz], idx) => {
        assert.equal(hitObstacle(sx, sz, 0.24, theme), null, `${theme}.${room}[${idx}] does not overlap any obstacle`);
        const d = lay.doors[room];
        const pts = route({ x: d.x, z: d.inner }, room, sx, sz, 0, theme);
        let prev = { x: d.x, z: d.inner };
        for (const p of pts) {
          assert.equal(segmentHitsObstacle(prev.x, prev.z, p.x, p.z, 0.16, theme), false, `${theme}.${room}[${idx}] route avoids obstacles`);
          prev = p;
        }
      });
    }
  }

  // Direct segment across research globe (-8, 5) hits obstacle, and findSafePath detours around it
  assert.equal(segmentHitsObstacle(-8, 2.9, -8, 6.6, 0.2, 'studio'), true);
  const detour = findSafePath(-8, 2.9, -8, 6.6, 'studio', 0.2);
  assert.ok(detour.length >= 2, 'detours around research globe');
  let prev = { x: -8, z: 2.9 };
  for (const p of detour) {
    assert.equal(segmentHitsObstacle(prev.x, prev.z, p.x, p.z, 0.18, 'studio'), false);
    prev = p;
  }

  // resolveObstacleCollision pushes a point out of the meeting room table (x: 0.1..1.5, z: 3.4..6.6)
  const insideTable = { x: 0.8, z: 5.0 };
  assert.ok(hitObstacle(insideTable.x, insideTable.z, 0.24, 'studio'));
  resolveObstacleCollision(insideTable, 0.24, 'studio');
  assert.equal(hitObstacle(insideTable.x, insideTable.z, 0.2, 'studio'), null);

  // safeSpawnPos avoids both obstacles and occupied agent positions
  const sp = safeSpawnPos(0.8, 5.0, 0.24, 'studio', [{ x: -0.5, z: 5.0 }]);
  assert.equal(hitObstacle(sp.x, sp.z, 0.24, 'studio'), null);
  assert.ok(Math.hypot(sp.x - (-0.5), sp.z - 5.0) >= 0.5);

  // separateAgents pushes two overlapping agents apart while keeping them outside obstacles
  const f = {};
  const a1 = { floor: f, path: [{ x: 0, z: 0 }], group: { visible: true, position: { x: 0, z: 0 } } };
  const a2 = { floor: f, path: [], group: { visible: true, position: { x: 0.1, z: 0 } } };
  for (let i = 0; i < 10; i++) separateAgents([a1, a2], 0.05, 0.56, 'studio');
  assert.ok(Math.hypot(a2.group.position.x - a1.group.position.x, a2.group.position.z - a1.group.position.z) >= 0.55);
});

test('MockSource localizes demo session titles, thoughts, plans, questions and speech bubbles between KO and EN', () => {
  applyRoomTheme('studio', 'en');
  const enEvents = [];
  const enSrc = new MockSource((ev) => enEvents.push(ev));
  for (let i = 0; i < 60; i++) enSrc.tick(0.5, 0.3, 250);
  const enSession = enEvents.find((e) => e.type === 'session' && e.sessionId === 'demo-auth');
  const enThink = enEvents.find((e) => e.type === 'thinking' && e.sessionId === 'demo-auth' && e.text);
  const enPlan = enEvents.find((e) => e.type === 'plan' && e.sessionId === 'demo-auth');
  assert.equal(enSession?.title, 'Audit OAuth Session Guard');
  assert.match(enThink?.text || '', /session guard/i);
  assert.equal(enPlan?.items?.[0]?.content, 'Trace token verification flow');
  for (const e of enEvents) {
    if (e.title) assert.doesNotMatch(e.title, /[가-힣]/);
    if (e.text) assert.doesNotMatch(e.text, /[가-힣]/);
    if (e.question) assert.doesNotMatch(e.question, /[가-힣]/);
  }

  applyRoomTheme('studio', 'ko');
  enSrc.setLang();
  const koRelocalized = enEvents.filter((e) => e.type === 'session' && e.sessionId === 'demo-auth').pop();
  assert.equal(koRelocalized?.title, 'OAuth 세션 가드 점검');
});
