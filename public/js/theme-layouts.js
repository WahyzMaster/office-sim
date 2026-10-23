// 5종 테마별 건물 평면(비직사각형 날개·중정·회랑), 방 출입문, 작업 슬롯(SLOTS), 우회 보행 경로(route).
// three.js 에 의존하지 않는 순수 좌표·경로 모듈이라 노드 테스트에서 바로 검증할 수 있다.

const N = Math.PI;       // 뒷벽(-z)을 바라봄
const E = Math.PI / 2;   // +x 를 바라봄
const W = -Math.PI / 2;  // -x 를 바라봄
const S = 0;             // +z (카메라 쪽)를 바라봄

const BASE_DOORS = Object.freeze({
  archive:  { x: -8, z: -2, inner: -2.9, sign: [-8, 1.55, -2] },
  dev:      { x: 0,  z: -2, inner: -2.9, sign: [0, 1.55, -2] },
  server:   { x: 8,  z: -2, inner: -2.9, sign: [8, 1.55, -2] },
  research: { x: -8, z: 2,  inner: 2.9,  sign: [-8, 1.55, 2] },
  meeting:  { x: 0,  z: 2,  inner: 2.9,  sign: [0, 1.55, 2] },
  desk:     { x: 8,  z: 2,  inner: 2.9,  sign: [8, 1.55, 2] },
  lounge:   { x: -11.2, z: 0, inner: 0,  sign: [-11.7, 3.0, 0] },
});

const BASE_SLOTS = Object.freeze({
  archive:  [[-10.4, -6.3, N], [-8, -6.3, N], [-5.6, -6.3, N], [-8.8, -3.2, N], [-7.2, -3.2, N]],
  dev:      [[-2.6, -5.5, N], [0, -5.5, N], [2.6, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
  server:   [[5.3, -5.8, N], [7.1, -5.8, N], [8.9, -5.8, N], [10.7, -5.8, N], [8, -2.9, N]],
  research: [[-10.1, 3.5, W], [-10.1, 6.5, W], [-6.6, 5, W], [-8, 6.6, N]],
  meeting:  [[-2.5, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.3, N]],
  desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
  lounge:   [[5.0, -1.3, S], [6.4, -1.3, S], [7.8, -1.3, S], [9.2, -1.3, S], [10.4, -1.3, S],
             [3.6, -1.3, S], [2.2, -1.3, S], [0.8, -1.3, S]],
});

const RING_LOUNGE_SLOTS = Object.freeze([
  [4.8, -1.35, S], [6.2, -1.35, S], [7.6, -1.35, S], [9.0, -1.35, S],
  [4.8, 1.35, N], [6.2, 1.35, N], [-5.2, -1.35, S], [-6.6, -1.35, S],
]);

export const THEME_LAYOUTS = Object.freeze({
  studio: Object.freeze({
    walkway: 'spine',
    // x,z = 직원이 나타나고 사라지는 곳, frameX = 엘리베이터 틀(포털) 또는 대문 문짝(gate)의 x
    elevator: { x: -11.2, z: 0, frameX: -11.82, kind: 'portal' },
    doors: BASE_DOORS,
    slots: BASE_SLOTS,
  }),
  office: Object.freeze({
    walkway: 'spine',
    elevator: { x: -11.2, z: 0, frameX: -11.82, kind: 'portal' },
    doors: BASE_DOORS,
    slots: BASE_SLOTS,
  }),
  palace: Object.freeze({
    // 중앙 후원 연못(방지원도, x: -3.2 ~ 3.2)을 피해 남북 회랑(z = ±1.45)으로 우회 보행
    walkway: 'ring',
    obstacle: { x0: -3.4, x1: 3.4, zNorth: -1.45, zSouth: 1.45 },
    elevator: { x: -11.45, z: 0, frameX: -11.85, kind: 'gate' },
    doors: Object.freeze({
      ...BASE_DOORS,
      dev:    { x: 0,      z: -2, inner: -3.1, sign: [0, 1.85, -2] },
      lounge: { x: -11.45, z: 0,  inner: 0,    sign: [-12.1, 3.1, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.4, -6.2, N], [-8, -6.2, N], [-5.6, -6.2, N], [-8.8, -3.2, N], [-7.2, -3.2, N]],
      dev:      [[-2.5, -5.6, N], [0, -5.6, N], [2.5, -5.6, N], [-1.4, -3.2, N], [1.4, -3.2, N]],
      server:   [[5.5, -5.7, N], [7.2, -5.7, N], [8.8, -5.7, N], [10.5, -5.7, N], [8, -3.0, N]],
      research: [[-10.1, 3.7, W], [-10.1, 6.3, W], [-6.5, 5, W], [-8, 6.7, N]],
      meeting:  [[-2.4, 5, W], [-0.5, 3.8, E], [-0.5, 6.2, E], [2.1, 3.8, W], [2.1, 6.2, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   [[5.2, -1.45, S], [6.6, -1.45, S], [8.0, -1.45, S], [9.4, -1.45, S],
                 [4.8, 1.45, N], [6.2, 1.45, N], [-5.4, -1.45, S], [-6.8, -1.45, S]],
    }),
  }),
  hanok: Object.freeze({
    // 중앙 안마당 화단·우물(x: -3.0 ~ 3.0)을 피해 툇마루/디딤돌 둘레길(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -3.2, x1: 3.2, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -11.6, z: 0, frameX: -11.95, kind: 'gate' },
    doors: Object.freeze({
      ...BASE_DOORS,
      research: { x: -8.4, z: 2, inner: 3.1, sign: [-8.4, 1.75, 2] },
      lounge:   { x: -11.6, z: 0, inner: 0,  sign: [-11.9, 3.0, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.3, -6.2, N], [-8, -6.2, N], [-5.7, -6.2, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
      dev:      [[-2.4, -5.5, N], [0, -5.5, N], [2.4, -5.5, N], [-1.3, -3.2, N], [1.3, -3.2, N]],
      server:   [[5.6, -5.7, N], [7.3, -5.7, N], [9.0, -5.7, N], [10.4, -5.7, N], [8, -3.0, N]],
      research: [[-10.6, 4.0, W], [-10.6, 6.6, W], [-7.0, 5.3, W], [-8.5, 7.0, N]],
      meeting:  [[-2.4, 5, W], [-0.5, 3.8, E], [-0.5, 6.2, E], [2.1, 3.8, W], [2.1, 6.2, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   RING_LOUNGE_SLOTS,
    }),
  }),
  starship: Object.freeze({
    // 중앙 홀로그램 워프 코어 링(x: -2.6 ~ 2.6) 둘레의 브리지 링 통로(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -2.8, x1: 2.8, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -11.2, z: 0, frameX: -11.82, kind: 'portal' },
    doors: Object.freeze({
      ...BASE_DOORS,
      lounge: { x: -11.2, z: 0, inner: 0, sign: [-12.1, 3.0, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.2, -6.1, N], [-8, -6.1, N], [-5.8, -6.1, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
      dev:      [[-2.5, -5.5, N], [0, -5.5, N], [2.5, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
      server:   [[5.5, -5.7, N], [7.2, -5.7, N], [8.8, -5.7, N], [10.4, -5.7, N], [8, -3.0, N]],
      research: [[-10.0, 3.6, W], [-10.0, 6.4, W], [-6.6, 5, W], [-8, 6.6, N]],
      meeting:  [[-2.4, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   RING_LOUNGE_SLOTS,
    }),
  }),
  dogs: Object.freeze({
    // 중앙 강아지 발바닥 분수대·어질리티 링(x: -2.6 ~ 2.6) 둘레의 잔디 산책로(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -2.8, x1: 2.8, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -10.8, z: 0, frameX: -11.42, kind: 'portal' },
    doors: Object.freeze({
      ...BASE_DOORS,
      lounge: { x: -10.8, z: 0, inner: 0, sign: [-11.8, 3.0, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.4, -6.2, N], [-8, -6.2, N], [-5.6, -6.2, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
      dev:      [[-2.5, -5.5, N], [0, -5.5, N], [2.5, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
      server:   [[5.5, -5.7, N], [7.2, -5.7, N], [8.8, -5.7, N], [10.4, -5.7, N], [8, -3.0, N]],
      research: [[-10.0, 3.6, W], [-10.0, 6.4, W], [-6.6, 5, W], [-8, 6.6, N]],
      meeting:  [[-2.4, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   RING_LOUNGE_SLOTS,
    }),
  }),
  cats: Object.freeze({
    // 중앙 대형 캣타워·실타래 분수(x: -2.5 ~ 2.5) 둘레의 벨벳 캣워크(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -2.7, x1: 2.7, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -10.8, z: 0, frameX: -11.42, kind: 'portal' },
    doors: Object.freeze({
      ...BASE_DOORS,
      lounge: { x: -10.8, z: 0, inner: 0, sign: [-11.8, 3.0, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.2, -6.2, N], [-8, -6.2, N], [-5.8, -6.2, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
      dev:      [[-2.5, -5.5, N], [0, -5.5, N], [2.5, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
      server:   [[5.6, -5.7, N], [7.2, -5.7, N], [8.8, -5.7, N], [10.2, -5.7, N], [8, -3.0, N]],
      research: [[-10.0, 3.6, W], [-10.0, 6.4, W], [-6.6, 5, W], [-8, 6.6, N]],
      meeting:  [[-2.4, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   RING_LOUNGE_SLOTS,
    }),
  }),
});

export function layoutOf(theme) {
  return THEME_LAYOUTS[theme] || THEME_LAYOUTS.studio;
}

const OBSTACLE_CACHE = new Map();

// 방 벽체·칸막이·중정 구조물·책상·서버랙·글로브·소파의 2D AABB 충돌 박스 목록을 반환한다.
export function obstaclesOf(theme = 'studio') {
  const key = THEME_LAYOUTS[theme] ? theme : 'studio';
  if (OBSTACLE_CACHE.has(key)) return OBSTACLE_CACHE.get(key);
  const lay = layoutOf(key);
  const d = lay.doors;
  const obs = [
    // 외벽 (출입문 제외)
    { x0: -12.3, x1: 12.3, z0: -8.3, z1: -7.85, tag: 'wall-north' },
    { x0: -12.3, x1: 12.3, z0: 7.85, z1: 8.3, tag: 'wall-south' },
    { x0: -12.3, x1: -11.88, z0: -8.3, z1: -1.1, tag: 'wall-west-n' },
    { x0: -12.3, x1: -11.88, z0: 1.1, z1: 8.3, tag: 'wall-west-s' },
    { x0: 11.88, x1: 12.3, z0: -8.3, z1: 8.3, tag: 'wall-east' },
    // 방 사이 세로 칸막이 벽 (x = -4, +4)
    { x0: -4.12, x1: -3.88, z0: -8.0, z1: -2.0, tag: 'div-top-w' },
    { x0: 3.88, x1: 4.12, z0: -8.0, z1: -2.0, tag: 'div-top-e' },
    { x0: -4.12, x1: -3.88, z0: 2.0, z1: 8.0, tag: 'div-bot-w' },
    { x0: 3.88, x1: 4.12, z0: 2.0, z1: 8.0, tag: 'div-bot-e' },
    // 복도 가로 칸막이 벽 (z = -2 북쪽 3개 방 문 제외한 구간)
    { x0: -12.0, x1: d.archive.x - 0.95, z0: -2.12, z1: -1.88, tag: 'part-n-1' },
    { x0: d.archive.x + 0.95, x1: d.dev.x - 0.95, z0: -2.12, z1: -1.88, tag: 'part-n-2' },
    { x0: d.dev.x + 0.95, x1: d.server.x - 0.95, z0: -2.12, z1: -1.88, tag: 'part-n-3' },
    { x0: d.server.x + 0.95, x1: 12.0, z0: -2.12, z1: -1.88, tag: 'part-n-4' },
    // 복도 가로 칸막이 벽 (z = +2 남쪽 3개 방 문 제외한 구간)
    { x0: -12.0, x1: d.research.x - 0.95, z0: 1.88, z1: 2.12, tag: 'part-s-1' },
    { x0: d.research.x + 0.95, x1: d.meeting.x - 0.95, z0: 1.88, z1: 2.12, tag: 'part-s-2' },
    { x0: d.meeting.x + 0.95, x1: d.desk.x - 0.95, z0: 1.88, z1: 2.12, tag: 'part-s-3' },
    { x0: d.desk.x + 0.95, x1: 12.0, z0: 1.88, z1: 2.12, tag: 'part-s-4' },
    // archive 가구 (뒷벽 서가 + 중앙 열람 테이블)
    { x0: -11.4, x1: -4.6, z0: -7.9, z1: -6.75, tag: 'archive-shelves' },
    { x0: -9.2, x1: -6.8, z0: -4.73, z1: -3.97, tag: 'archive-desk' },
    // dev 가구 (뒷벽 코딩 데스크 3조)
    { x0: -3.6, x1: 3.6, z0: -7.2, z1: -6.08, tag: 'dev-desks' },
    // server 가구 (뒷벽 서버랙/화로/코어 + 터미널/모루 테이블)
    { x0: 4.6, x1: 11.4, z0: -7.8, z1: -6.28, tag: 'server-racks' },
    { x0: 7.25, x1: 8.75, z0: -4.23, z1: -3.57, tag: 'server-desk' },
    // research 가구 (중앙 구체 기단 + 서쪽 벽 연구 테이블)
    key === 'hanok'
      ? { x0: -8.9, x1: -7.9, z0: 4.8, z1: 5.8, tag: 'research-globe' }
      : { x0: -8.5, x1: -7.5, z0: 4.5, z1: 5.5, tag: 'research-globe' },
    key === 'hanok'
      ? { x0: -11.8, x1: -11.0, z0: 3.2, z1: 7.2, tag: 'research-desks' }
      : { x0: -11.6, x1: -10.65, z0: 2.7, z1: 7.3, tag: 'research-desks' },
    // meeting 가구 (회의 테이블 + 서쪽 보드)
    { x0: 0.1, x1: 1.5, z0: 3.4, z1: 6.6, tag: 'meeting-table' },
    { x0: -3.7, x1: -3.35, z0: 2.8, z1: 7.2, tag: 'meeting-board' },
    // desk 가구 (승인 데스크 + 비콘 단상)
    { x0: 9.0, x1: 11.4, z0: 3.4, z1: 6.6, tag: 'desk-main' },
    // lounge 소파/평상 (남동쪽 파티션 벽 앞)
    { x0: 9.1, x1: 11.1, z0: 1.3, z1: 1.86, tag: 'lounge-sofa' },
  ];
  if (key === 'studio' || key === 'office') {
    obs.push(
      { x0: -11.7, x1: -10.9, z0: -3.45, z1: -2.75, tag: 'archive-cabinet' },
      { x0: 11.15, x1: 11.65, z0: -1.8, z1: -1.3, tag: 'lounge-water' },
    );
  }
  if (key === 'dogs' || key === 'cats') {
    obs.push(
      { x0: -1.9, x1: -0.7, z0: -4.43, z1: -3.77, tag: 'dev-table-w' },
      { x0: 0.7, x1: 1.9, z0: -4.43, z1: -3.77, tag: 'dev-table-e' },
    );
  }
  if (lay.obstacle) {
    obs.push({
      x0: lay.obstacle.x0 + 0.35,
      x1: lay.obstacle.x1 - 0.35,
      z0: -0.92,
      z1: 0.92,
      tag: 'corridor-center',
    });
  }
  const frozen = Object.freeze(obs.map((o) => Object.freeze(o)));
  OBSTACLE_CACHE.set(key, frozen);
  return frozen;
}

// 복도 구간 (x1, z1) -> (x2, z2) 이동 시 중정/연못/워프코어(obstacle)를 가로지르면 회랑 둘레길로 우회한다.
export function corridorWaypoints(x1, z1, x2, z2, lane, theme) {
  const lay = layoutOf(theme);
  if (lay.walkway !== 'ring' || !lay.obstacle) return [];
  const { x0, x1: ox1, zNorth, zSouth } = lay.obstacle;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const crossesCenter = minX < ox1 - 0.1 && maxX > x0 + 0.1;
  if (!crossesCenter) return [];
  const nZ = zNorth + lane * 0.25;
  const sZ = zSouth + lane * 0.25;
  // 남북으로 중정을 가로지르는 경우(예: dev <-> meeting) 서쪽(x0) 또는 동쪽(ox1) 회랑으로 우회
  if ((z1 < -0.5 && z2 > 0.5) || (z1 > 0.5 && z2 < -0.5)) {
    const useWest = Math.abs(x1 - x0) + Math.abs(x2 - x0) <= Math.abs(x1 - ox1) + Math.abs(x2 - ox1);
    const sideX = useWest ? x0 : ox1;
    return [
      { x: sideX, z: z1 < 0 ? nZ : sZ },
      { x: sideX, z: z2 < 0 ? nZ : sZ },
    ];
  }
  const chooseNorth = (z1 + z2) <= 0;
  const ringZ = chooseNorth ? nZ : sZ;
  const entryX = x1 < x0 ? x0 : x1 > ox1 ? ox1 : x1;
  const exitX = x2 < x0 ? x0 : x2 > ox1 ? ox1 : x2;
  const pts = [{ x: entryX, z: ringZ }];
  if (Math.abs(exitX - entryX) > 0.2) pts.push({ x: exitX, z: ringZ });
  return pts;
}
