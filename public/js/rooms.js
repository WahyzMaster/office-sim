// 방 배치, 자리(slot), 도구 -> 방 분류 규칙.
// 방 매핑을 바꾸려면 ROOM_RULES 만 고치면 된다 (위에서부터 먼저 맞는 규칙이 이긴다).

export const FLOOR_W = 24;
export const FLOOR_D = 16;
export const CORRIDOR = 2; // 복도: z -2 ~ 2

const N = Math.PI;       // 뒷벽(-z)을 바라봄
const E = Math.PI / 2;   // +x 를 바라봄
const W = -Math.PI / 2;  // -x 를 바라봄
const S = 0;             // +z (카메라 쪽)를 바라봄

export const ROOMS = {
  archive:  { label: '자료실',     x0: -12, x1: -4, side: 'top',    token: '--r-archive',  hint: 'Read · Grep · Glob · codegraph' },
  dev:      { label: '개발실',     x0: -4,  x1: 4,  side: 'top',    token: '--r-dev',      hint: 'Edit · Write · NotebookEdit' },
  server:   { label: '서버실',     x0: 4,   x1: 12, side: 'top',    token: '--r-server',   hint: 'Bash · git · gh · 터미널' },
  research: { label: '정보검색실', x0: -12, x1: -4, side: 'bottom', token: '--r-research', hint: 'WebSearch · WebFetch · MCP' },
  meeting:  { label: '회의실',     x0: -4,  x1: 4,  side: 'bottom', token: '--r-meeting',  hint: '계획 · 할 일 -> 화이트보드' },
  desk:     { label: '내 자리',    x0: 4,   x1: 12, side: 'bottom', token: '--r-desk',     hint: 'AskUserQuestion · 계획 승인' },
  lounge:   { label: '라운지',     x0: -12, x1: 12, side: 'mid',    token: '--r-lounge',   hint: '대기 · 엘리베이터' },
};

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

export function doorOf(key) {
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
