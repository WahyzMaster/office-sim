// 방 배치, 자리(slot), 도구 -> 방 분류 규칙, 독립 선택 축(공간·캐릭터·LLM 매핑·보행·소리·조명).
import { layoutOf } from './theme-layouts.js';
import {
  LEGEND_AGENTS, LEGEND_DOGS, LEGEND_CATS, LEGEND_BOTS, LEGEND_HUMANS, LEGEND_CATALOG, LEGEND_SIGNALS,
  CHAR_THEMES, DEFAULT_CHAR_THEME, CHARACTER_CATALOG, LLM_SLOTS, DEFAULT_LLM_CHAR_MAP,
  VOICE_MODES, DEFAULT_VOICE_MODE, COLOR_THEMES, DEFAULT_COLOR_THEME, LLM_FILTERS, DEFAULT_LLM_FILTER,
  llmSlotOf, charSpecOf, defaultLlmCharMap, llmCharMapOf, legendCatalogFor, renderCatalogSection,
} from './legend-data.js';

export {
  LEGEND_AGENTS, LEGEND_DOGS, LEGEND_CATS, LEGEND_BOTS, LEGEND_HUMANS, LEGEND_CATALOG, LEGEND_SIGNALS,
  CHAR_THEMES, DEFAULT_CHAR_THEME, CHARACTER_CATALOG, LLM_SLOTS, DEFAULT_LLM_CHAR_MAP,
  VOICE_MODES, DEFAULT_VOICE_MODE, COLOR_THEMES, DEFAULT_COLOR_THEME, LLM_FILTERS, DEFAULT_LLM_FILTER,
  llmSlotOf, charSpecOf, defaultLlmCharMap, llmCharMapOf, legendCatalogFor,
};

export const FLOOR_W = 24;
export const FLOOR_D = 16;
export const CORRIDOR = 2; // 복도: z -2 ~ 2

const N = Math.PI;       // 뒷벽(-z)을 바라봄
const E = Math.PI / 2;   // +x 를 바라봄
const W = -Math.PI / 2;  // -x 를 바라봄
const S = 0;             // +z (카메라 쪽)를 바라봄

export const ROOMS = {
  archive:  { label: '코드 탐색실',    x0: -12, x1: -4, side: 'top',    token: '--r-archive',  hint: 'Read · Grep · Glob · codegraph' },
  dev:      { label: '코딩 스튜디오',  x0: -4,  x1: 4,  side: 'top',    token: '--r-dev',      hint: 'Edit · Write · NotebookEdit' },
  server:   { label: '터미널·빌드실',  x0: 4,   x1: 12, side: 'top',    token: '--r-server',   hint: 'Bash · git · gh · 터미널' },
  research: { label: '웹·MCP 허브',    x0: -12, x1: -4, side: 'bottom', token: '--r-research', hint: 'WebSearch · WebFetch · MCP' },
  meeting:  { label: '기획·작전실',    x0: -4,  x1: 4,  side: 'bottom', token: '--r-meeting',  hint: '계획 · 할 일 -> 화이트보드' },
  desk:     { label: '리뷰·승인 부스', x0: 4,   x1: 12, side: 'bottom', token: '--r-desk',     hint: 'AskUserQuestion · 권한·계획 승인' },
  lounge:   { label: '라운지',         x0: -12, x1: 12, side: 'mid',    token: '--r-lounge',   hint: '대기 · 엘리베이터' },
};

export const DEFAULT_ROOM_THEME = 'studio';
export const DEFAULT_LANG = 'ko';
export const POSTURE_MODES = Object.freeze(['auto', 'tetrapod', 'bipod']);
export const DEFAULT_POSTURE_MODE = 'auto';
export const MOTION_MODES = Object.freeze(['auto', 'jump', 'roll', 'flip', 'spin', 'prop-fly', 'phase']);
export const DEFAULT_MOTION_MODE = 'auto';

export const ROOM_THEMES = Object.freeze({
  dogs: Object.freeze({ name: Object.freeze({ ko: '퍼피 파크', en: 'Puppy Park' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['노즈워크 숲', '냄새 탐색 · Read · Grep · Glob'],      en: ['Scent Trail Woods', 'Sniffing · Read · Grep · Glob'] }),
    dev:      Object.freeze({ ko: ['어질리티 훈련장', '장애물 돌파 · Edit · Write'],      en: ['Agility Arena', 'Hurdle Craft · Edit · Write'] }),
    server:   Object.freeze({ ko: ['우다다 트랙', '전력 질주·공놀이 · Bash · git · 빌드'], en: ['Zoomies Track', 'Ball Fetch · Bash · git · build'] }),
    research: Object.freeze({ ko: ['전망 언덕', '동네 정찰 · WebSearch · MCP'],           en: ['Lookout Mound', 'Pack Scout · WebSearch · MCP'] }),
    meeting:  Object.freeze({ ko: ['독 파크 모임터', '작전 회의 · 계획 · 할 일'],         en: ['Bark Council', 'Pack Strategy · Plan · tasks'] }),
    desk:     Object.freeze({ ko: ['간식·칭찬 부스', '간식 조르기 · 질문 · 승인'],        en: ['Treat & Belly-Rub Booth', 'Treat Request · Ask · approvals'] }),
    lounge:   Object.freeze({ ko: ['잔디 마당', '일광욕 · 산책 게이트'],                  en: ['Sunny Lawn', 'Sunbathing · Park Gate'] }),
  }) }),
  cats: Object.freeze({ name: Object.freeze({ ko: '캣 타워 살롱', en: 'Luxury Cat Salon' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['창가 캣타워', '새 구경·탐색 · Read · Grep · Glob'],   en: ['Window Perch', 'Bird Watch · Read · Grep · Glob'] }),
    dev:      Object.freeze({ ko: ['스크래처 공방', '발톱 다듬기 · Edit · Write'],        en: ['Scratcher Studio', 'Claw Craft · Edit · Write'] }),
    server:   Object.freeze({ ko: ['레이저 사냥터', '우다다 사냥 · Bash · git · 빌드'],   en: ['Laser Chase Dome', 'Pounce Ops · Bash · git · build'] }),
    research: Object.freeze({ ko: ['캣닢 온실', '호기심 탐색 · WebSearch · MCP'],         en: ['Catnip Conservatory', 'Curiosity Lab · WebSearch · MCP'] }),
    meeting:  Object.freeze({ ko: ['벨벳 라운지', '고양이 회합 · 계획 · 할 일'],          en: ['Velvet Cushion Hall', 'Feline Council · Plan · tasks'] }),
    desk:     Object.freeze({ ko: ['츄르·집사 호출석', '집사 벨 호출 · 질문 · 승인'],     en: ['Churu Butler Bell', 'Butler Ring · Ask · approvals'] }),
    lounge:   Object.freeze({ ko: ['햇살 해먹', '골골송 · 캣플랩'],                       en: ['Sunbeam Hammock', 'Purring · Cat Flap'] }),
  }) }),
  studio: Object.freeze({ name: Object.freeze({ ko: 'AI 스튜디오', en: 'AI Studio' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['코드 탐색실', 'Read · Grep · Glob · codegraph'],     en: ['Codebase Lab', 'Read · Grep · Glob · codegraph'] }),
    dev:      Object.freeze({ ko: ['코딩 스튜디오', 'Edit · Write · NotebookEdit'],       en: ['Coding Studio', 'Edit · Write · NotebookEdit'] }),
    server:   Object.freeze({ ko: ['터미널·빌드실', 'Bash · git · gh · 터미널'],          en: ['Terminal & Ops', 'Bash · git · gh · terminal'] }),
    research: Object.freeze({ ko: ['웹·MCP 허브', 'WebSearch · WebFetch · MCP'],          en: ['Web & MCP Hub', 'WebSearch · WebFetch · MCP'] }),
    meeting:  Object.freeze({ ko: ['기획·작전실', '계획 · 할 일 -> 화이트보드'],          en: ['Strategy Room', 'Plan · tasks -> whiteboard'] }),
    desk:     Object.freeze({ ko: ['리뷰·승인 부스', 'AskUserQuestion · 권한·계획 승인'], en: ['Review Booth', 'AskUserQuestion · approvals'] }),
    lounge:   Object.freeze({ ko: ['라운지', '대기 · 엘리베이터'],                        en: ['Lounge', 'Idle · elevator'] }),
  }) }),
  office: Object.freeze({ name: Object.freeze({ ko: '테크 오피스', en: 'Tech Office' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['라이브러리', 'Read · Grep · Glob · codegraph'],       en: ['Library', 'Read · Grep · Glob · codegraph'] }),
    dev:      Object.freeze({ ko: ['개발존', 'Edit · Write · NotebookEdit'],              en: ['Dev Zone', 'Edit · Write · NotebookEdit'] }),
    server:   Object.freeze({ ko: ['서버룸', 'Bash · git · gh · 터미널'],                 en: ['Server Room', 'Bash · git · gh · terminal'] }),
    research: Object.freeze({ ko: ['리서치랩', 'WebSearch · WebFetch · MCP'],             en: ['Research Lab', 'WebSearch · WebFetch · MCP'] }),
    meeting:  Object.freeze({ ko: ['보드룸', '계획 · 할 일 -> 화이트보드'],               en: ['Boardroom', 'Plan · tasks -> whiteboard'] }),
    desk:     Object.freeze({ ko: ['핫라인 부스', 'AskUserQuestion · 권한·계획 승인'],    en: ['Hotline Booth', 'AskUserQuestion · approvals'] }),
    lounge:   Object.freeze({ ko: ['라운지', '대기 · 엘리베이터'],                        en: ['Lounge', 'Idle · elevator'] }),
  }) }),
  palace: Object.freeze({ name: Object.freeze({ ko: '조선 궁궐', en: 'Joseon Palace' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['규장각', '서고 열람 · Read · Grep · Glob'],           en: ['Gyujanggak Archives', 'Royal Library · Read · Grep · Glob'] }),
    dev:      Object.freeze({ ko: ['집현전', '문서 찬집 · Edit · Write'],                 en: ['Jiphyeonjeon Hall', 'Hall of Worthies · Edit · Write'] }),
    server:   Object.freeze({ ko: ['군기시', '화기·병기 · Bash · git · 테스트'],          en: ['Gungisi Arsenal', 'Royal Arsenal · Bash · git · test'] }),
    research: Object.freeze({ ko: ['관상감', '천문·외교 · WebSearch · MCP'],              en: ['Gwansanggam Observatory', 'Observatory · WebSearch · MCP'] }),
    meeting:  Object.freeze({ ko: ['빈청', '국정 어전회의 · 계획 · 할 일'],               en: ['Bincheong Council', 'State Council · Plan · tasks'] }),
    desk:     Object.freeze({ ko: ['승정원', '왕명 출납·윤허 · 질문 · 승인'],             en: ['Seungjeongwon Secretariat', 'Royal Assent · Ask · approvals'] }),
    lounge:   Object.freeze({ ko: ['후원', '휴식 · 가마터'],                              en: ['Huwon Garden', 'Royal Courtyard · Idle'] }),
  }) }),
  hanok: Object.freeze({ name: Object.freeze({ ko: '전통 한옥', en: 'Traditional Hanok' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['장판각', '목판 서고 · Read · Grep · Glob'],           en: ['Jangpangak Library', 'Woodblock Archives · Read · Grep'] }),
    dev:      Object.freeze({ ko: ['글방', '집필·서각 · Edit · Write'],                   en: ['Geulbang Study', 'Scholar Study · Edit · Write'] }),
    server:   Object.freeze({ ko: ['대장간', '풀무·담금질 · Bash · git · 빌드'],          en: ['Daejanggan Forge', 'Blacksmith Forge · Bash · build'] }),
    research: Object.freeze({ ko: ['누각', '원경 탐색 · WebSearch · MCP'],                en: ['Nugak Pavilion', 'Lookout Pavilion · WebSearch · MCP'] }),
    meeting:  Object.freeze({ ko: ['대청마루', '도면 강론 · 계획 · 할 일'],               en: ['Daecheong Main Hall', 'Timber Hall · Plan · tasks'] }),
    desk:     Object.freeze({ ko: ['사랑채', '주인장 문답 · 질문 · 승인'],                en: ['Sarangchae Reception', 'Master Reception · Ask · approvals'] }),
    lounge:   Object.freeze({ ko: ['안마당', '휴식 · 대문'],                              en: ['Anmadang Courtyard', 'Inner Courtyard · Idle'] }),
  }) }),
  starship: Object.freeze({ name: Object.freeze({ ko: 'SF 스타십', en: 'Sci-Fi Starship' }), rooms: Object.freeze({
    archive:  Object.freeze({ ko: ['데이터 볼트', '기억 코어 · Read · Grep · Glob'],      en: ['Data Vault', 'Memory Core · Read · Grep · Glob'] }),
    dev:      Object.freeze({ ko: ['포지 베이', '매터 합성 · Edit · Write'],              en: ['Forge Bay', 'Matter Synth · Edit · Write'] }),
    server:   Object.freeze({ ko: ['엔진 코어', '원자로·추진 · Bash · git · 빌드'],       en: ['Engine Core', 'Reactor Ops · Bash · git · build'] }),
    research: Object.freeze({ ko: ['센서 어레이', '장거리 스캔 · WebSearch · MCP'],       en: ['Sensor Array', 'Deep Space Scan · WebSearch · MCP'] }),
    meeting:  Object.freeze({ ko: ['택티컬 브리지', '전술 홀로그램 · 계획 · 할 일'],      en: ['Tactical Bridge', 'Holo-Deck · Plan · tasks'] }),
    desk:     Object.freeze({ ko: ['홀로그램 통신실', '사령부 직통 · 질문 · 승인'],       en: ['Holo-Comms Pod', 'Command Uplink · Ask · approvals'] }),
    lounge:   Object.freeze({ ko: ['크루 라운지', '대기 · 터보리프트'],                   en: ['Crew Lounge', 'Standby · Turbolift'] }),
  }) }),
});

let activeTheme = DEFAULT_ROOM_THEME;
let activeCharTheme = DEFAULT_CHAR_THEME;
let activeLang = DEFAULT_LANG;
let activePostureMode = DEFAULT_POSTURE_MODE;
let activeMotionMode = DEFAULT_MOTION_MODE;
let activeVoiceMode = DEFAULT_VOICE_MODE;
let activeColorTheme = DEFAULT_COLOR_THEME;
let activeLlmFilter = DEFAULT_LLM_FILTER;
let activeLlmCharMap = defaultLlmCharMap();

export const roomThemeOf = (k) => (Object.hasOwn(ROOM_THEMES, k) ? k : DEFAULT_ROOM_THEME);
export const activeThemeOf = () => activeTheme;

export const charThemeOf = (k) => (Object.hasOwn(CHAR_THEMES, k) ? k : DEFAULT_CHAR_THEME);
export const activeCharThemeOf = () => activeCharTheme;
export const setCharTheme = (k) => { activeCharTheme = charThemeOf(k); return activeCharTheme; };

export const langOf = (l) => (l === 'en' ? 'en' : 'ko');
export const activeLangOf = () => activeLang;
export const tr = (ko, en, lang = activeLang) => (lang === 'en' ? en : ko);
export const postureModeOf = (m) => (POSTURE_MODES.includes(m) ? m : DEFAULT_POSTURE_MODE);
export const activePostureOf = () => activePostureMode;
export const setPostureMode = (m) => { activePostureMode = postureModeOf(m); return activePostureMode; };
export const motionModeOf = (m) => (MOTION_MODES.includes(m) ? m : DEFAULT_MOTION_MODE);
export const activeMotionOf = () => activeMotionMode;
export const setMotionMode = (m) => { activeMotionMode = motionModeOf(m); return activeMotionMode; };

export const voiceModeOf = (v) => (VOICE_MODES.includes(v) ? v : DEFAULT_VOICE_MODE);
export const activeVoiceModeOf = () => activeVoiceMode;
export const setVoiceMode = (v) => { activeVoiceMode = voiceModeOf(v); return activeVoiceMode; };

export const colorThemeOf = (c) => (COLOR_THEMES.includes(c) ? c : DEFAULT_COLOR_THEME);
export const activeColorThemeOf = () => activeColorTheme;
export const setColorTheme = (c) => { activeColorTheme = colorThemeOf(c); return activeColorTheme; };

export const llmFilterOf = (f) => (LLM_FILTERS.includes(f) ? f : DEFAULT_LLM_FILTER);
export const activeLlmFilterOf = () => activeLlmFilter;
export const setLlmFilter = (f) => { activeLlmFilter = llmFilterOf(f); return activeLlmFilter; };
export const isLlmVisible = (agent, filter = activeLlmFilter) => {
  const f = llmFilterOf(filter);
  if (f === 'all' || !agent) return true;
  const id = agent.brandOverride || agent.agent || 'claude-code';
  return id === f;
};

export const activeLlmCharMapOf = () => ({ ...activeLlmCharMap });
export function setLlmCharMap(slotOrMap, spec) {
  if (typeof slotOrMap === 'string') {
    const val = charSpecOf(spec);
    if (slotOrMap === 'claude-code' || slotOrMap === 'codex') {
      activeLlmCharMap[slotOrMap] = activeLlmCharMap[`${slotOrMap}:app`] = activeLlmCharMap[`${slotOrMap}:cli`] = val;
    } else if (LLM_SLOTS.includes(slotOrMap)) activeLlmCharMap[slotOrMap] = val;
  } else if (slotOrMap && typeof slotOrMap === 'object') {
    activeLlmCharMap = llmCharMapOf(slotOrMap);
  }
  return activeLlmCharMapOf();
}
export function resetLlmCharMap() {
  activeLlmCharMap = defaultLlmCharMap();
  return activeLlmCharMapOf();
}

export const effectivePosture = (themeOrSpec = activeCharTheme, mode = activePostureMode) => {
  const m = postureModeOf(mode);
  if (m === 'tetrapod' || m === 'bipod') return m;
  const s = String(themeOrSpec || '');
  return (s === 'dogs' || s === 'cats' || s.startsWith('dog:') || s.startsWith('cat:')) ? 'tetrapod' : 'bipod';
};

// 에이전트 외형·품종·보행·보이스 3단계 해석기:
// 1순위: 에이전트 개별 오버라이드(agent.charOverride / agent.petBreed)
// 2순위: 사용자 지정 LLM별 캐릭터 배정(llmCharMap[slot])
// 3순위: 글로벌 캐릭터 테마(charTheme)의 LLM별 기본값(DEFAULT_LLM_CHAR_MAP)
export function resolveAgentAppearance(agent = {}, opts = {}) {
  const slot = llmSlotOf(agent);
  const cTheme = charThemeOf(opts.charTheme ?? opts.theme ?? activeCharTheme);
  const map = opts.llmCharMap ? llmCharMapOf(opts.llmCharMap) : activeLlmCharMap;
  let spec = 'auto';
  if (agent.charOverride && agent.charOverride !== 'auto' && Object.hasOwn(CHARACTER_CATALOG, agent.charOverride)) {
    spec = agent.charOverride;
  } else if (agent.petBreed) {
    spec = (cTheme === 'cats' || String(agent.petBreed) in { savannah: 1, mainecoon: 1, persian: 1, bengal: 1, british: 1, siamese: 1, ragdoll: 1, fold: 1 })
      ? `cat:${agent.petBreed}` : `dog:${agent.petBreed}`;
  } else if (map[slot] && map[slot] !== 'auto') {
    spec = map[slot];
  } else if (cTheme.startsWith('dog:') || cTheme.startsWith('cat:') || cTheme.startsWith('bot:')) {
    spec = cTheme;
  } else {
    const pack = DEFAULT_LLM_CHAR_MAP[cTheme] || DEFAULT_LLM_CHAR_MAP.studio;
    spec = pack[slot] || 'human:studio';
  }

  let family = 'human';
  let style = 'studio';
  let breed = '';
  if (spec.startsWith('dog:')) { family = 'dogs'; style = 'dogs'; breed = spec.slice(4); }
  else if (spec.startsWith('cat:')) { family = 'cats'; style = 'cats'; breed = spec.slice(4); }
  else if (spec.startsWith('bot:')) { family = 'bots'; style = 'bots'; breed = spec.slice(4); }
  else if (spec.startsWith('human:')) { family = 'human'; style = spec.slice(6) || 'studio'; }

  const pMode = agent.postureOverride && agent.postureOverride !== 'auto'
    ? agent.postureOverride : (opts.posture ?? opts.postureMode ?? activePostureMode);
  const posture = effectivePosture(spec, pMode);

  const vMode = voiceModeOf(
    agent.voiceOverride && agent.voiceOverride !== 'auto'
      ? agent.voiceOverride : (opts.voiceMode ?? activeVoiceMode),
  );
  let voiceKind = family === 'dogs' ? 'dogs' : family === 'cats' ? 'cats' : family === 'bots' ? 'bots' : 'synth';
  let voiceStyle = style;
  if (vMode === 'dogs') voiceKind = 'dogs';
  else if (vMode === 'cats') voiceKind = 'cats';
  else if (vMode === 'bots') voiceKind = 'bots';
  else if (vMode === 'chime') { voiceKind = 'synth'; voiceStyle = 'palace'; }
  else if (vMode === 'chirp') { voiceKind = 'synth'; voiceStyle = 'starship'; }
  else if (vMode === 'blip') { voiceKind = 'synth'; voiceStyle = 'studio'; }
  else if (vMode === 'mute') { voiceKind = 'mute'; }

  return { slot, charSpec: spec, family, style, breed, posture, voiceMode: vMode, voiceKind, voiceStyle };
}

export const detectLang = (navLang = globalThis.navigator?.language) => (
  typeof navLang === 'string' && navLang.toLowerCase().startsWith('en') ? 'en' : 'ko'
);

export function roomLabel(roomKey, themeKey = activeTheme, lang = activeLang) {
  const t = ROOM_THEMES[roomThemeOf(themeKey)];
  const l = langOf(lang);
  return t?.rooms?.[roomKey]?.[l]?.[0] ?? ROOMS[roomKey]?.label ?? roomKey;
}

export function applyRoomTheme(themeKey = activeTheme, lang = activeLang) {
  activeTheme = roomThemeOf(themeKey);
  activeLang = langOf(lang);
  const spec = ROOM_THEMES[activeTheme].rooms;
  const lay = layoutOf(activeTheme);
  for (const [k, r] of Object.entries(ROOMS)) {
    const pair = spec[k]?.[activeLang];
    if (pair) [r.label, r.hint] = pair;
    if (lay.slots?.[k]) SLOTS[k] = lay.slots[k];
  }
  if (lay.elevator) Object.assign(ELEVATOR, lay.elevator);
  return { theme: activeTheme, lang: activeLang };
}

export const UI_TEXT = Object.freeze({
  ko: Object.freeze({
    subInterval: (ms) => `세션 기록을 ${ms}ms마다 따라 읽어요`,
    subReplay: (speed) => `지난 세션 기록을 ${speed}배속으로 다시 보여 줘요`,
    source: Object.freeze({ demo: '데모 데이터', live: '라이브 · 연결됨', retry: '라이브 · 재연결 중', down: '서버 없음 · 데모 재생' }),
    sourceTitle: Object.freeze({
      demo: '예시 세션을 재생하고 있어요. 로컬 서버를 실행하면 실제 에이전트 세션이 보여요.',
      replay: '지난 세션 기록을 기록된 시간 간격대로 재생하고 있어요.',
      live: '로컬 서버의 /events 스트림을 받고 있어요.',
    }),
    themeLabel: '공간', charLabel: '캐릭터', llmLabel: 'LLM', llmAll: '전체',
    postureLabel: '보행',
    postures: Object.freeze({ auto: '자동 (캐릭터별)', tetrapod: '4족 보행 (네발)', bipod: '2족 보행 (두발)' }),
    motionLabel: '모션',
    motions: Object.freeze({ auto: '자동 (캐릭터별)', jump: '점프 (폴짝)', roll: '구르기 (데구르르)', flip: '공중제비 (캣플립)', spin: '회전 (빙글)', 'prop-fly': '프로펠러 비행 (붕붕)', phase: '무중력 활공 (페이즈)' }),
    voiceLabel: '소리',
    voices: Object.freeze({ auto: '자동 (캐릭터별)', dogs: '강아지 (멍멍)', cats: '고양이 (야옹)', bots: '로봇 (삐리릭)', chime: '국악 (옥소리)', chirp: '스타십 (비프)', blip: '스튜디오 (블립)', mute: '음소거' }),
    colorLabel: Object.freeze({ system: '조명: 자동', light: '조명: 낮', dark: '조명: 밤' }),
    soundLabel: Object.freeze({ on: '소리 켜짐', off: '음소거' }),
    petBtn: '쓰다듬기 · 소리', controlLabel: '조작', legendBtn: '범례·배정', logBtn: '활동 기록',
    logTitle: '활동 기록', legendTitle: '범례 및 LLM 캐릭터 배정', resetCastBtn: '기본 배정 복원',
    legendSections: Object.freeze({ rooms: '공간 · 방 안내', agents: 'LLM별 캐릭터 배정', catalog: '캐릭터 · 품종 도감 (29종)', signals: '상태 · 색깔 신호', controls: '카메라 · 단축키' }),
    allNo: '전체', allName: '모든 프로젝트 층 보기', globalFloor: '전역 · 미지정',
    globalTitle: '워크스페이스 경로가 지정되지 않은 전역 세션',
    askBadge: (approving, asking) => `${approving === asking ? '승인' : '질문'} ${asking}`,
    follow: '따라가기', close: '닫기',
    mode: Object.freeze({ idle: '대기', work: '작업 중', think: '생각 중', write: '계획 작성', ask: '질문 중', panic: '식은땀', moving: '이동 중', approval: '승인 대기' }),
    rows: Object.freeze({ project: '프로젝트', agent: '에이전트', branch: '브랜치', status: '상태', activity: '하는 일', queue: '남은 일', charOverride: '개별 캐릭터', postureOverride: '개별 보행', motionOverride: '개별 모션' }),
    subBadge: (type) => `서브 (${type || '보조'})`,
    worktreeBadge: (wt) => `워크트리 ${wt}`,
    queueCount: (n) => `${n}건`,
    controls: Object.freeze({
      map: Object.freeze({ label: '구글 맵', hint: '구글 맵: 좌클릭 드래그 이동 · 우클릭/Ctrl+드래그 회전·기울기 · 휠 확대 · WASD/방향키 이동 · Shift+방향키 회전·기울기 · R 초기화 · F/더블클릭 따라가기 · 1-9/[/]/0 층 이동' }),
      figma: Object.freeze({ label: '피그마', hint: '피그마: 휠/두손가락 이동 · Ctrl/핀치+휠 확대 · Space+드래그/휠클릭 이동 · 드래그 회전 · Shift+0/1/2 시점·맞춤·포커스 · R 초기화 · 1-9/[/]/0 층 이동' }),
      orbit: Object.freeze({ label: '3D 오빗', hint: '3D 오빗: 좌클릭 드래그 회전 · 우클릭/Shift/Space+드래그 이동 · 휠 확대 · WASD/방향키 이동 · Q/E 회전 · R 초기화 · F/더블클릭 따라가기 · 1-9/[/]/0 층 이동' }),
      blender: Object.freeze({ label: '블렌더', hint: '블렌더: 휠클릭/Alt+드래그 회전 · Shift+휠클릭/좌·우클릭 이동 · 휠 확대 · WASD/방향키 이동 · ./F 선택 포커스 · Home/R 초기화 · 1-9/[/]/0 층 이동' }),
    }),
  }),
  en: Object.freeze({
    subInterval: (ms) => `Tailing session logs every ${ms}ms`,
    subReplay: (speed) => `Replaying recorded session at ${speed}×`,
    source: Object.freeze({ demo: 'Demo Data', live: 'Live · Connected', retry: 'Live · Reconnecting', down: 'No Server · Demo Mode' }),
    sourceTitle: Object.freeze({
      demo: 'Playing sample sessions. Run the local server to stream your live agent sessions.',
      replay: 'Replaying recorded session logs with original timing.',
      live: 'Connected to local /events stream.',
    }),
    themeLabel: 'Place', charLabel: 'Character', llmLabel: 'LLM', llmAll: 'All',
    postureLabel: 'Posture',
    postures: Object.freeze({ auto: 'Auto (By Character)', tetrapod: 'Tetrapod (4-Leg)', bipod: 'Bipod (2-Leg)' }),
    motionLabel: 'Motion',
    motions: Object.freeze({ auto: 'Auto (By Character)', jump: 'Jump (Vault)', roll: 'Roll (Dodge Roll)', flip: 'Flip (Somersault)', spin: 'Spin (360° Pirouette)', 'prop-fly': 'Propeller Fly (Hover)', phase: 'Zero-G Phase (Glide)' }),
    voiceLabel: 'Voice',
    voices: Object.freeze({ auto: 'Auto (By Character)', dogs: 'Dog (Bark)', cats: 'Cat (Meow)', bots: 'Bot (Droid Bleep)', chime: 'Royal (Chime)', chirp: 'Starship (Chirp)', blip: 'Studio (Blip)', mute: 'Muted' }),
    colorLabel: Object.freeze({ system: 'Light: Auto', light: 'Light: Day', dark: 'Light: Night' }),
    soundLabel: Object.freeze({ on: 'Sound On', off: 'Muted' }),
    petBtn: 'Pet · Voice', controlLabel: 'Controls', legendBtn: 'Legend & Cast', logBtn: 'Activity Log',
    logTitle: 'Activity Log', legendTitle: 'Visual Legend & LLM Cast', resetCastBtn: 'Reset Cast',
    legendSections: Object.freeze({ rooms: 'Rooms & Zones', agents: 'LLM Character Mapping', catalog: 'Character & Breed Catalog (29)', signals: 'Status & Color Signals', controls: 'Camera & Shortcuts' }),
    allNo: 'ALL', allName: 'All Project Floors', globalFloor: 'Global · Unassigned',
    globalTitle: 'Global sessions without a workspace path',
    askBadge: (approving, asking) => `${approving === asking ? 'Approve' : 'Ask'} ${asking}`,
    follow: 'Follow', close: 'Close',
    mode: Object.freeze({ idle: 'Idle', work: 'Working', think: 'Thinking', write: 'Planning', ask: 'Asking', panic: 'Error', moving: 'Moving', approval: 'Awaiting Approval' }),
    rows: Object.freeze({ project: 'Project', agent: 'Agent', branch: 'Branch', status: 'Status', activity: 'Activity', queue: 'Queued', charOverride: 'Character', postureOverride: 'Posture', motionOverride: 'Motion' }),
    subBadge: (type) => `Sub (${type || 'helper'})`,
    worktreeBadge: (wt) => `worktree ${wt}`,
    queueCount: (n) => `${n}`,
    controls: Object.freeze({
      map: Object.freeze({ label: 'Google Maps', hint: 'Google Maps: Left-drag pan · Right/Ctrl+drag orbit & tilt · Wheel zoom · WASD/Arrows pan · Shift+Arrows orbit & tilt · R reset · F/Double-click follow · 1-9/[/]/0 floor' }),
      figma: Object.freeze({ label: 'Figma', hint: 'Figma: Wheel/two-finger pan · Ctrl/Pinch+wheel zoom · Space+drag/Middle-drag pan · Drag orbit · Shift+0/1/2 view/fit/focus · R reset · 1-9/[/]/0 floor' }),
      orbit: Object.freeze({ label: '3D Orbit', hint: '3D Orbit: Left-drag orbit · Right/Shift/Space+drag pan · Wheel zoom · WASD/Arrows pan · Q/E rotate · R reset · F/Double-click follow · 1-9/[/]/0 floor' }),
      blender: Object.freeze({ label: 'Blender', hint: 'Blender: Middle/Alt+drag orbit · Shift+Middle/Left/Right-drag pan · Wheel zoom · WASD/Arrows pan · ./F focus selected · Home/R reset · 1-9/[/]/0 floor' }),
    }),
  }),
});

export const uiText = (lang = activeLang) => UI_TEXT[langOf(lang)];

export function legendAgentsFor(themeKey = activeCharTheme, lang = activeLang) {
  const l = langOf(lang);
  if (themeKey === 'dogs') return LEGEND_DOGS.map((d) => ({ id: d.id, spec: d.spec, swatch: d.swatch, label: d.label[l], desc: d.desc[l] }));
  if (themeKey === 'cats') return LEGEND_CATS.map((c) => ({ id: c.id, spec: c.spec, swatch: c.swatch, label: c.label[l], desc: c.desc[l] }));
  if (themeKey === 'bots') return LEGEND_BOTS.map((b) => ({ id: b.id, spec: b.spec, swatch: b.swatch, label: b.label[l], desc: b.desc[l] }));
  const th = Object.hasOwn(ROOM_THEMES, themeKey) && themeKey !== 'dogs' && themeKey !== 'cats' ? themeKey : 'studio';
  return LEGEND_AGENTS.map((a) => ({ id: a.id, slot: a.slot, swatch: a.swatch, label: a.label[l], desc: (a.desc[th] || a.desc.studio)[l] }));
}

export function legendSignalsFor(lang = activeLang) {
  const l = langOf(lang);
  return LEGEND_SIGNALS.map((s) => ({ id: s.id, swatch: s.swatch, label: s.label[l], desc: s.desc[l] }));
}

export function renderLegend(legendEl, themeKey = activeTheme, lang = activeLang, onMapChange = null) {
  if (!legendEl) return;
  const l = langOf(lang);
  const t = uiText(l);
  const h2 = legendEl.querySelector('h2');
  if (h2) h2.textContent = t.legendTitle;
  for (const [k, txt] of Object.entries(t.legendSections)) {
    const hd = legendEl.querySelector(`[data-lg-head="${k}"]`);
    if (hd) hd.textContent = txt;
  }
  const resetBtn = legendEl.querySelector('#reset-llm-map');
  if (resetBtn) resetBtn.textContent = t.resetCastBtn;

  const fillList = (ul, items) => {
    if (!ul) return;
    ul.replaceChildren();
    for (const it of items) {
      const li = legendEl.ownerDocument.createElement('li');
      li.innerHTML = '<i></i><b></b><span></span>';
      li.querySelector('i').setAttribute('style', it.swatch);
      li.querySelector('b').textContent = it.label;
      li.querySelector('span').textContent = it.desc;
      ul.append(li);
    }
  };
  const roomUl = legendEl.querySelector('[data-lg="rooms"]') || legendEl.querySelector('ul');
  fillList(roomUl, Object.values(ROOMS).map((r) => ({
    swatch: `background:var(${r.token})`,
    label: r.label,
    desc: r.hint,
  })));
  const agentUl = legendEl.querySelector('[data-lg="agents"]');
  if (agentUl) {
    agentUl.replaceChildren();
    const map = activeLlmCharMapOf();
    for (const a of LEGEND_AGENTS) {
      const li = legendEl.ownerDocument.createElement('li');
      li.dataset.agentId = a.id;
      li.dataset.llmSlot = a.slot;
      li.tabIndex = 0;
      const [baseAgent, slotSurface = ''] = a.slot.split(':');
      const resolved = resolveAgentAppearance({
        agent: baseAgent === 'sub' ? 'claude-code' : baseAgent,
        surface: slotSurface,
        isSub: a.slot === 'sub',
      });
      const charTitle = CHARACTER_CATALOG[resolved.charSpec]?.[l] || a.label[l];
      li.dataset.charSpec = resolved.charSpec;
      li.innerHTML = '<canvas class="ag-model" width="128" height="144" aria-hidden="true"></canvas><div class="ag-tag"><i></i><b></b></div><small class="ag-sub"></small><select class="ag-map"></select><span role="tooltip"></span>';
      li.querySelector('i').setAttribute('style', a.swatch);
      li.querySelector('b').textContent = a.label[l];
      li.querySelector('.ag-sub').textContent = charTitle;
      li.querySelector('span').textContent = `${a.label[l]} -> ${charTitle}`;
      const sel = li.querySelector('select.ag-map');
      if (sel) {
        sel.setAttribute('aria-label', `${a.label[l]} ${t.charLabel}`);
        for (const [specKey, labels] of Object.entries(CHARACTER_CATALOG)) {
          const opt = legendEl.ownerDocument.createElement('option');
          opt.value = specKey;
          opt.textContent = specKey === 'auto' ? `${labels[l]} (${charTitle})` : labels[l];
          sel.append(opt);
        }
        sel.value = map[a.slot] || 'auto';
        for (const ev of ['pointerdown', 'mousedown', 'click']) sel.addEventListener(ev, (e) => e.stopPropagation());
        sel.addEventListener('change', (e) => {
          e.stopPropagation();
          setLlmCharMap(a.slot, sel.value);
          onMapChange?.(a.slot, sel.value);
        });
      }
      agentUl.append(li);
    }
  }
  renderCatalogSection(legendEl, l, activeCharTheme, (pickedTheme) => {
    setCharTheme(pickedTheme);
    onMapChange?.('charTheme', pickedTheme);
  });
  if (typeof window !== 'undefined' && typeof WebGLRenderingContext !== 'undefined') {
    import('./legend-models.js').then((m) => m.mountLegendModels(legendEl)).catch(() => {});
  }
  fillList(legendEl.querySelector('[data-lg="signals"]'), legendSignalsFor(l));
}

// [x, z, 바라보는 방향]. 첫 번째 자리가 그 방의 "대표 자리"(화이트보드 앞, 내 책상 앞).
export const SLOTS = {
  archive:  [[-10.4, -6.2, N], [-8, -6.2, N], [-5.6, -6.2, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
  dev:      [[-2.5, -5.5, N], [0, -5.5, N], [2.5, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
  server:   [[5.5, -5.8, N], [7.2, -5.8, N], [8.8, -5.8, N], [10.5, -5.8, N], [8, -3.0, N]],
  research: [[-10.0, 3.6, W], [-10.0, 6.4, W], [-6.4, 5, W], [-8, 6.8, N]],
  meeting:  [[-2.4, 5, W], [-0.5, 3.8, E], [-0.5, 6.2, E], [2.1, 3.8, W], [2.1, 6.2, W], [0.8, 7.2, N]],
  desk:     [[8.3, 5, E], [7.1, 3.8, E], [7.1, 6.2, E], [5.9, 5, E]],
  lounge:   [[-9.8, -1.35, S], [-5.8, -1.35, S], [-4.4, -1.35, S], [4.2, -1.35, S],
             [5.8, -1.35, S], [9.8, -1.35, S], [-5.8, 1.35, N], [9.8, 1.35, N]],
};

export const ELEVATOR = { x: -11.2, z: 0 };

export const ROOM_RULES = [
  ['ignore',   /^(mcp__ccd_\w+|ToolSearch|ListAgents|ListMcpResourcesTool|mcp__visualize__read_me|mcp__serena__initial_instructions|mcp__firebase__firebase_get_environment|mcp__computer-use__(request_access|request_full_control|release_full_control|app_release)|mcp__claude-in-chrome__(tabs_context_mcp|list_connected_browsers)|mcp__Claude_Browser__(tabs_context|preview_list))$/],
  ['meeting',  /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|EnterPlanMode)$/],
  ['desk',     /^(AskUserQuestion|ExitPlanMode)$/],
  ['archive',  /^(Read|Glob|Grep|LS|Skill|NotebookRead|mcp__codegraph__\w+|mcp__serena__(find|get|list|read|search)_\w+|mcp__morph-mcp__(codebase_search|reflex_\w+))$/],
  ['dev',      /^(Edit|MultiEdit|Write|NotebookEdit|mcp__morph-mcp__edit_file|mcp__serena__(replace|insert|rename|safe_delete|write|edit)_\w+)$/],
  ['server',   /^(Bash|BashOutput|KillShell|Monitor|TaskOutput|TaskStop|EnterWorktree|ExitWorktree|mcp__terminal__\w+|mcp__github__\w+|mcp__cloudrun__\w+|mcp__(plugin_firebase_)?firebase__\w+)$/],
  ['lounge',   /^ScheduleWakeup$/],
  ['here',     /^(Agent|Task|Workflow|SendMessage|advisor|StructuredOutput|SubagentHandback|PushNotification|SendUserFile|Artifact)$/],
  ['research', /^(WebSearch|WebFetch|mcp__.+)$/],
];

export function classify(tool) {
  for (const [room, re] of ROOM_RULES) if (re.test(tool)) return room;
  return 'here';
}

export function toolLabel(tool) {
  if (!tool.startsWith('mcp__')) return tool;
  const [, server = '', ...rest] = tool.split('__');
  const name = /^[0-9a-f-]{20,}$/.test(server) ? 'mcp' : server.replace(/^plugin_[a-z]+_/, '');
  return `${name}·${rest.join('__')}`;
}

export function roomCenter(key) {
  const r = ROOMS[key];
  const z = r.side === 'top' ? -5 : r.side === 'bottom' ? 5 : 0;
  return { x: (r.x0 + r.x1) / 2, z };
}

export function doorOf(key, themeKey = activeTheme) {
  const d = layoutOf(roomThemeOf(themeKey)).doors?.[key];
  if (d) return d;
  const r = ROOMS[key];
  const top = r.side === 'top';
  return { x: (r.x0 + r.x1) / 2, z: top ? -CORRIDOR : CORRIDOR, inner: top ? -CORRIDOR - 0.9 : CORRIDOR + 0.9 };
}

export function zoneAt(x, z) {
  if (z >= -CORRIDOR && z <= CORRIDOR) return 'lounge';
  const side = z < 0 ? 'top' : 'bottom';
  for (const [k, r] of Object.entries(ROOMS)) {
    if (r.side === side && x >= r.x0 && x <= r.x1) return k;
  }
  return 'lounge';
}
