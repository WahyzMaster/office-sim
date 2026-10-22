// 방 배치, 자리(slot), 도구 -> 방 분류 규칙.
// 방 매핑을 바꾸려면 ROOM_RULES 만 고치면 된다 (위에서부터 먼저 맞는 규칙이 이긴다).
import { layoutOf } from './theme-layouts.js';

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

export const ROOM_THEMES = Object.freeze({
  studio: Object.freeze({
    name: Object.freeze({ ko: 'AI 스튜디오', en: 'AI Studio' }),
    rooms: Object.freeze({
      archive:  Object.freeze({ ko: ['코드 탐색실', 'Read · Grep · Glob · codegraph'],     en: ['Codebase Lab', 'Read · Grep · Glob · codegraph'] }),
      dev:      Object.freeze({ ko: ['코딩 스튜디오', 'Edit · Write · NotebookEdit'],       en: ['Coding Studio', 'Edit · Write · NotebookEdit'] }),
      server:   Object.freeze({ ko: ['터미널·빌드실', 'Bash · git · gh · 터미널'],          en: ['Terminal & Ops', 'Bash · git · gh · terminal'] }),
      research: Object.freeze({ ko: ['웹·MCP 허브', 'WebSearch · WebFetch · MCP'],          en: ['Web & MCP Hub', 'WebSearch · WebFetch · MCP'] }),
      meeting:  Object.freeze({ ko: ['기획·작전실', '계획 · 할 일 -> 화이트보드'],          en: ['Strategy Room', 'Plan · tasks -> whiteboard'] }),
      desk:     Object.freeze({ ko: ['리뷰·승인 부스', 'AskUserQuestion · 권한·계획 승인'], en: ['Review Booth', 'AskUserQuestion · approvals'] }),
      lounge:   Object.freeze({ ko: ['라운지', '대기 · 엘리베이터'],                        en: ['Lounge', 'Idle · elevator'] }),
    }),
  }),
  office: Object.freeze({
    name: Object.freeze({ ko: '테크 오피스', en: 'Tech Office' }),
    rooms: Object.freeze({
      archive:  Object.freeze({ ko: ['라이브러리', 'Read · Grep · Glob · codegraph'],       en: ['Library', 'Read · Grep · Glob · codegraph'] }),
      dev:      Object.freeze({ ko: ['개발존', 'Edit · Write · NotebookEdit'],              en: ['Dev Zone', 'Edit · Write · NotebookEdit'] }),
      server:   Object.freeze({ ko: ['서버룸', 'Bash · git · gh · 터미널'],                 en: ['Server Room', 'Bash · git · gh · terminal'] }),
      research: Object.freeze({ ko: ['리서치랩', 'WebSearch · WebFetch · MCP'],             en: ['Research Lab', 'WebSearch · WebFetch · MCP'] }),
      meeting:  Object.freeze({ ko: ['보드룸', '계획 · 할 일 -> 화이트보드'],               en: ['Boardroom', 'Plan · tasks -> whiteboard'] }),
      desk:     Object.freeze({ ko: ['핫라인 부스', 'AskUserQuestion · 권한·계획 승인'],    en: ['Hotline Booth', 'AskUserQuestion · approvals'] }),
      lounge:   Object.freeze({ ko: ['라운지', '대기 · 엘리베이터'],                        en: ['Lounge', 'Idle · elevator'] }),
    }),
  }),
  palace: Object.freeze({
    name: Object.freeze({ ko: '조선 궁궐', en: 'Joseon Palace' }),
    rooms: Object.freeze({
      archive:  Object.freeze({ ko: ['규장각', '서고 열람 · Read · Grep · Glob'],           en: ['Gyujanggak Archives', 'Royal Library · Read · Grep · Glob'] }),
      dev:      Object.freeze({ ko: ['집현전', '문서 찬집 · Edit · Write'],                 en: ['Jiphyeonjeon Hall', 'Hall of Worthies · Edit · Write'] }),
      server:   Object.freeze({ ko: ['군기시', '화기·병기 · Bash · git · 테스트'],          en: ['Gungisi Arsenal', 'Royal Arsenal · Bash · git · test'] }),
      research: Object.freeze({ ko: ['관상감', '천문·외교 · WebSearch · MCP'],              en: ['Gwansanggam Observatory', 'Observatory · WebSearch · MCP'] }),
      meeting:  Object.freeze({ ko: ['빈청', '국정 어전회의 · 계획 · 할 일'],               en: ['Bincheong Council', 'State Council · Plan · tasks'] }),
      desk:     Object.freeze({ ko: ['승정원', '왕명 출납·윤허 · 질문 · 승인'],             en: ['Seungjeongwon Secretariat', 'Royal Assent · Ask · approvals'] }),
      lounge:   Object.freeze({ ko: ['후원', '휴식 · 가마터'],                              en: ['Huwon Garden', 'Royal Courtyard · Idle'] }),
    }),
  }),
  hanok: Object.freeze({
    name: Object.freeze({ ko: '전통 한옥', en: 'Traditional Hanok' }),
    rooms: Object.freeze({
      archive:  Object.freeze({ ko: ['장판각', '목판 서고 · Read · Grep · Glob'],           en: ['Jangpangak Library', 'Woodblock Archives · Read · Grep'] }),
      dev:      Object.freeze({ ko: ['글방', '집필·서각 · Edit · Write'],                   en: ['Geulbang Study', 'Scholar Study · Edit · Write'] }),
      server:   Object.freeze({ ko: ['대장간', '풀무·담금질 · Bash · git · 빌드'],          en: ['Daejanggan Forge', 'Blacksmith Forge · Bash · build'] }),
      research: Object.freeze({ ko: ['누각', '원경 탐색 · WebSearch · MCP'],                en: ['Nugak Pavilion', 'Lookout Pavilion · WebSearch · MCP'] }),
      meeting:  Object.freeze({ ko: ['대청마루', '도면 강론 · 계획 · 할 일'],               en: ['Daecheong Main Hall', 'Timber Hall · Plan · tasks'] }),
      desk:     Object.freeze({ ko: ['사랑채', '주인장 문답 · 질문 · 승인'],                en: ['Sarangchae Reception', 'Master Reception · Ask · approvals'] }),
      lounge:   Object.freeze({ ko: ['안마당', '휴식 · 대문'],                              en: ['Anmadang Courtyard', 'Inner Courtyard · Idle'] }),
    }),
  }),
  starship: Object.freeze({
    name: Object.freeze({ ko: 'SF 스타십', en: 'Sci-Fi Starship' }),
    rooms: Object.freeze({
      archive:  Object.freeze({ ko: ['데이터 볼트', '기억 코어 · Read · Grep · Glob'],      en: ['Data Vault', 'Memory Core · Read · Grep · Glob'] }),
      dev:      Object.freeze({ ko: ['포지 베이', '매터 합성 · Edit · Write'],              en: ['Forge Bay', 'Matter Synth · Edit · Write'] }),
      server:   Object.freeze({ ko: ['엔진 코어', '원자로·추진 · Bash · git · 빌드'],       en: ['Engine Core', 'Reactor Ops · Bash · git · build'] }),
      research: Object.freeze({ ko: ['센서 어레이', '장거리 스캔 · WebSearch · MCP'],       en: ['Sensor Array', 'Deep Space Scan · WebSearch · MCP'] }),
      meeting:  Object.freeze({ ko: ['택티컬 브리지', '전술 홀로그램 · 계획 · 할 일'],      en: ['Tactical Bridge', 'Holo-Deck · Plan · tasks'] }),
      desk:     Object.freeze({ ko: ['홀로그램 통신실', '사령부 직통 · 질문 · 승인'],       en: ['Holo-Comms Pod', 'Command Uplink · Ask · approvals'] }),
      lounge:   Object.freeze({ ko: ['크루 라운지', '대기 · 터보리프트'],                   en: ['Crew Lounge', 'Standby · Turbolift'] }),
    }),
  }),
});

let activeTheme = DEFAULT_ROOM_THEME;
let activeLang = DEFAULT_LANG;

export const roomThemeOf = (k) => (Object.hasOwn(ROOM_THEMES, k) ? k : DEFAULT_ROOM_THEME);
export const activeThemeOf = () => activeTheme;
export const langOf = (l) => (l === 'en' ? 'en' : 'ko');
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
    themeLabel: '공간',
    controlLabel: '조작',
    legendBtn: '범례 안내',
    logBtn: '활동 기록',
    logTitle: '활동 기록',
    legendTitle: '범례 안내',
    legendSections: Object.freeze({
      rooms: '공간 · 방 안내',
      agents: '캐릭터 · 에이전트',
      signals: '상태 · 색깔 신호',
      controls: '카메라 · 단축키',
    }),
    allNo: '전체',
    allName: '모든 프로젝트 층 보기',
    globalFloor: '전역 · 미지정',
    globalTitle: '워크스페이스 경로가 지정되지 않은 전역 세션',
    askBadge: (approving, asking) => `${approving === asking ? '승인' : '질문'} ${asking}`,
    follow: '따라가기',
    close: '닫기',
    mode: Object.freeze({ idle: '대기', work: '작업 중', think: '생각 중', write: '계획 작성', ask: '질문 중', panic: '식은땀', moving: '이동 중', approval: '승인 대기' }),
    rows: Object.freeze({ project: '프로젝트', agent: '에이전트', branch: '브랜치', status: '상태', activity: '하는 일', queue: '남은 일' }),
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
    themeLabel: 'Theme',
    controlLabel: 'Controls',
    legendBtn: 'Legend & Help',
    logBtn: 'Activity Log',
    logTitle: 'Activity Log',
    legendTitle: 'Visual Legend',
    legendSections: Object.freeze({
      rooms: 'Rooms & Zones',
      agents: 'Characters & Agents',
      signals: 'Status & Color Signals',
      controls: 'Camera & Shortcuts',
    }),
    allNo: 'ALL',
    allName: 'All Project Floors',
    globalFloor: 'Global · Unassigned',
    globalTitle: 'Global sessions without a workspace path',
    askBadge: (approving, asking) => `${approving === asking ? 'Approve' : 'Ask'} ${asking}`,
    follow: 'Follow',
    close: 'Close',
    mode: Object.freeze({ idle: 'Idle', work: 'Working', think: 'Thinking', write: 'Planning', ask: 'Asking', panic: 'Error', moving: 'Moving', approval: 'Awaiting Approval' }),
    rows: Object.freeze({ project: 'Project', agent: 'Agent', branch: 'Branch', status: 'Status', activity: 'Activity', queue: 'Queued' }),
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

export const LEGEND_AGENTS = Object.freeze([
  Object.freeze({
    id: 'claude',
    swatch: 'background:#d97757;border-radius:50%;box-shadow:0 0 0 2px rgba(217,119,87,0.28)',
    label: Object.freeze({ ko: 'Claude', en: 'Claude' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '테라코타 · 베레모 + 골드 안테나', en: 'Terracotta · Beret + gold antenna' }),
      office:   Object.freeze({ ko: '테라코타 · 베레모 + 사원증', en: 'Terracotta · Beret + ID lanyard' }),
      palace:   Object.freeze({ ko: '테라코타 · 정자관 + 홍포 관복', en: 'Terracotta · Jeongjagwan crown + crimson robe' }),
      hanok:    Object.freeze({ ko: '테라코타 · 선비 유건 + 배자·망태기', en: 'Terracotta · Scholar Yugeon + vest & basket' }),
      starship: Object.freeze({ ko: '테라코타 · 커맨더 헬멧 + 아크 코어', en: 'Terracotta · Commander helmet + arc core' }),
    }),
  }),
  Object.freeze({
    id: 'codex',
    swatch: 'background:#10b981;border-radius:50%;box-shadow:0 0 0 2px rgba(16,185,129,0.28)',
    label: Object.freeze({ ko: 'Codex', en: 'Codex' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '에메랄드 · 사이버 바이저 + 발광 눈', en: 'Emerald · Cyber visor + glowing LEDs' }),
      office:   Object.freeze({ ko: '에메랄드 · 사이버 바이저 + 사원증', en: 'Emerald · Cyber visor + ID lanyard' }),
      palace:   Object.freeze({ ko: '에메랄드 · 흑립 갓 + 어사화·청포 관복', en: 'Emerald · Gat hat + royal Eosahwa plume' }),
      hanok:    Object.freeze({ ko: '에메랄드 · 대나무 삿갓 + 청록 배자', en: 'Emerald · Bamboo Satgat hat + jade vest' }),
      starship: Object.freeze({ ko: '에메랄드 · 전술 HUD 바이저 + 제트팩', en: 'Emerald · Tactical HUD visor + jetpack' }),
    }),
  }),
  Object.freeze({
    id: 'grok',
    swatch: 'background:#a855f7;border-radius:50%;box-shadow:0 0 0 2px rgba(168,85,247,0.28)',
    label: Object.freeze({ ko: 'Grok', en: 'Grok' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '바이올렛 · 블랙홀 궤도 링 + 별 위성', en: 'Violet · Black-hole orbit ring + star' }),
      office:   Object.freeze({ ko: '바이올렛 · 블랙홀 궤도 링 + 사원증', en: 'Violet · Black-hole orbit ring + lanyard' }),
      palace:   Object.freeze({ ko: '바이올렛 · 관상감 사모 + 황금 혼천의 링', en: 'Violet · Samo cap + golden armillary ring' }),
      hanok:    Object.freeze({ ko: '바이올렛 · 전립 + 금빛 상모·별 장식', en: 'Violet · Jeonrip cap + golden plume' }),
      starship: Object.freeze({ ko: '바이올렛 · 제로G 중력장 실드 + 위성', en: 'Violet · Zero-G gravity shield + orbiter' }),
    }),
  }),
  Object.freeze({
    id: 'agy-cli',
    swatch: 'background:#06b6d4;border-radius:50%;box-shadow:0 0 0 2px rgba(6,182,212,0.28)',
    label: Object.freeze({ ko: 'AGY·CLI', en: 'AGY·CLI' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '시안 · 이중 반중력 링 + 부유 크리스탈', en: 'Cyan · Dual anti-gravity halo + crystal' }),
      office:   Object.freeze({ ko: '시안 · 반중력 헤일로 링 + 사원증', en: 'Cyan · Anti-gravity halo + lanyard' }),
      palace:   Object.freeze({ ko: '시안 · 금관·옥비녀 + 비취 후광 링', en: 'Cyan · Gold crown & jade pin + halo' }),
      hanok:    Object.freeze({ ko: '시안 · 망건·옥관자 + 비취 구슬', en: 'Cyan · Headband & jade button + orb' }),
      starship: Object.freeze({ ko: '시안 · 그래비티 코어 링 + 플라즈마 제트', en: 'Cyan · Gravity core rings + plasma jet' }),
    }),
  }),
  Object.freeze({
    id: 'agy-app',
    swatch: 'background:#3b82f6;border-radius:50%;box-shadow:0 0 0 2px rgba(59,130,246,0.28)',
    label: Object.freeze({ ko: 'AGY·App', en: 'AGY·App' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '코발트 · 앱/IDE 반중력 링 + 크리스탈', en: 'Cobalt · App/IDE anti-gravity ring + crystal' }),
      office:   Object.freeze({ ko: '코발트 · 앱/IDE 반중력 링 + 사원증', en: 'Cobalt · App/IDE anti-gravity ring + lanyard' }),
      palace:   Object.freeze({ ko: '코발트 · 청옥 비녀 금관 + 청색 관복', en: 'Cobalt · Sapphire pin crown + blue robe' }),
      hanok:    Object.freeze({ ko: '코발트 · 청옥 관자 망건 + 쪽빛 배자', en: 'Cobalt · Sapphire headband + indigo vest' }),
      starship: Object.freeze({ ko: '코발트 · 함교 반중력 슈트 + 코발트 코어', en: 'Cobalt · Bridge gravity suit + cobalt core' }),
    }),
  }),
  Object.freeze({
    id: 'sub',
    swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%',
    label: Object.freeze({ ko: '서브에이전트', en: 'Subagent' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '소형(0.74×) · 회전 프로펠러 모자 (부모 색상 계승)', en: '0.74× mini · Spinning propeller cap (parent hue)' }),
      office:   Object.freeze({ ko: '소형(0.74×) · 회전 프로펠러 모자 (부모 색상 계승)', en: '0.74× mini · Spinning propeller cap (parent hue)' }),
      palace:   Object.freeze({ ko: '소형(0.74×) · 색동 바람개비 머리장식 (부모 색상 계승)', en: '0.74× mini · Spinning pinwheel ornament' }),
      hanok:    Object.freeze({ ko: '소형(0.74×) · 색동 바람개비 머리장식 (부모 색상 계승)', en: '0.74× mini · Spinning pinwheel ornament' }),
      starship: Object.freeze({ ko: '소형(0.74×) · 호버 드론 로터 (부모 색상 계승)', en: '0.74× mini · Hover drone rotor (parent hue)' }),
    }),
  }),
]);

export const LEGEND_SIGNALS = Object.freeze([
  Object.freeze({
    id: 'speech',
    swatch: 'background:#fffdf8;border:1.5px solid #2b2a27;border-radius:6px',
    label: Object.freeze({ ko: '일반 말풍선', en: 'Speech Bubble' }),
    desc: Object.freeze({ ko: '도구 실행 · 대답 · 작업 완료', en: 'Tool execution · reply · task done' }),
  }),
  Object.freeze({
    id: 'think',
    swatch: 'background:#fffdf8;border:1.5px dotted #6b6358;border-radius:50%',
    label: Object.freeze({ ko: '구름 말풍선', en: 'Cloud Bubble' }),
    desc: Object.freeze({ ko: '에이전트 추론 · 생각 중 (손글씨체)', en: 'Internal reasoning · thinking' }),
  }),
  Object.freeze({
    id: 'ask',
    swatch: 'background:#fff3c4;border:1.5px solid #e0a32a;border-radius:6px',
    label: Object.freeze({ ko: '노랑·주황 배지', en: 'Amber Badge' }),
    desc: Object.freeze({ ko: '질문(선택지 칩) · 권한·계획 승인 대기', en: 'User question or tool/plan approval wait' }),
  }),
  Object.freeze({
    id: 'error',
    swatch: 'background:linear-gradient(135deg,#e5534b 55%,#4fa3ff 55%);border-radius:4px',
    label: Object.freeze({ ko: '빨강·파란 땀', en: 'Red + Sweat' }),
    desc: Object.freeze({ ko: '도구 실패·오류 말풍선 + 파란 식은땀 방울', en: 'Tool error bubble + blue sweat drops' }),
  }),
  Object.freeze({
    id: 'denied',
    swatch: 'background:#ece7dc;border:1.5px dashed #8a8175;border-radius:6px',
    label: Object.freeze({ ko: '회색 점선', en: 'Dashed Gray' }),
    desc: Object.freeze({ ko: '권한 요청 거절 · 작업 방향 변경 지시', en: 'Permission denied or redirected by user' }),
  }),
  Object.freeze({
    id: 'floor',
    swatch: 'background:transparent;border:2px solid #2fb36a;box-shadow:0 0 0 2px rgba(196,61,52,0.35);border-radius:50%',
    label: Object.freeze({ ko: '층 테두리 링', en: 'Floor Ring' }),
    desc: Object.freeze({ ko: '초록 펄스 = 다른 층 새 활동 · 빨강 = 오류 발생', en: 'Green pulse = new activity · Red = error' }),
  }),
  Object.freeze({
    id: 'source',
    swatch: 'background:linear-gradient(90deg,#2fb36a 34%,#e0a32a 34% 67%,#7c5cd6 67%);border-radius:50%',
    label: Object.freeze({ ko: '연결 상태 점', en: 'Source Dot' }),
    desc: Object.freeze({ ko: '초록 라이브 · 노랑 재연결 · 보라 재생 · 기본 데모', en: 'Green Live · Amber Retry · Purple Replay' }),
  }),
]);

export function legendAgentsFor(themeKey = activeTheme, lang = activeLang) {
  const th = roomThemeOf(themeKey);
  const l = langOf(lang);
  return LEGEND_AGENTS.map((a) => ({
    id: a.id,
    swatch: a.swatch,
    label: a.label[l],
    desc: (a.desc[th] || a.desc.studio)[l],
  }));
}

export function legendSignalsFor(lang = activeLang) {
  const l = langOf(lang);
  return LEGEND_SIGNALS.map((s) => ({
    id: s.id,
    swatch: s.swatch,
    label: s.label[l],
    desc: s.desc[l],
  }));
}

export function renderLegend(legendEl, themeKey = activeTheme, lang = activeLang) {
  if (!legendEl) return;
  const t = uiText(lang);
  const h2 = legendEl.querySelector('h2');
  if (h2) h2.textContent = t.legendTitle;
  for (const [k, txt] of Object.entries(t.legendSections)) {
    const hd = legendEl.querySelector(`[data-lg-head="${k}"]`);
    if (hd) hd.textContent = txt;
  }
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
    for (const it of legendAgentsFor(themeKey, lang)) {
      const li = legendEl.ownerDocument.createElement('li');
      li.dataset.agentId = it.id;
      li.tabIndex = 0;
      li.innerHTML = '<canvas class="ag-model" width="128" height="144" aria-hidden="true"></canvas><div class="ag-tag"><i></i><b></b></div><span role="tooltip"></span>';
      li.querySelector('i').setAttribute('style', it.swatch);
      li.querySelector('b').textContent = it.label;
      li.querySelector('span').textContent = it.desc;
      agentUl.append(li);
    }
    if (typeof window !== 'undefined' && typeof WebGLRenderingContext !== 'undefined') {
      import('./legend-models.js').then((m) => m.mountLegendModels(agentUl)).catch(() => {});
    }
  }
  fillList(legendEl.querySelector('[data-lg="signals"]'), legendSignalsFor(lang));
}

// [x, z, 바라보는 방향]. 첫 번째 자리가 그 방의 "대표 자리"(화이트보드 앞, 내 책상 앞).
export const SLOTS = {
  archive:  [[-10.4, -6.4, N], [-8, -6.4, N], [-5.6, -6.4, N], [-8.8, -3.0, N], [-7.2, -3.0, N]],
  dev:      [[-2.6, -5.5, N], [0, -5.5, N], [2.6, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
  server:   [[5.3, -5.9, N], [7.1, -5.9, N], [8.9, -5.9, N], [10.7, -5.9, N], [8, -2.8, N]],
  research: [[-10.1, 3.5, W], [-10.1, 6.5, W], [-6.6, 5, W], [-8, 6.6, N]],
  meeting:  [[-2.5, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.4, N]],
  desk:     [[8.4, 5, E], [7.1, 3.8, E], [7.1, 6.2, E], [5.9, 5, E]],
  lounge:   [[5.0, -1.3, S], [6.4, -1.3, S], [7.8, -1.3, S], [9.2, -1.3, S], [10.6, -1.3, S],
             [3.6, -1.3, S], [2.2, -1.3, S], [0.8, -1.3, S]],
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
// 서버는 Bash 명령어 종류처럼 이름만으로 알 수 없는 경우에 room 힌트를 보낸다(grep/cat -> 자료실, curl -> 정보검색실).

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
