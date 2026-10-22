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
  archive:  [[-10.4, -6.4, N], [-8, -6.4, N], [-5.6, -6.4, N], [-8.8, -3.0, N], [-7.2, -3.0, N]],
  dev:      [[-2.6, -5.5, N], [0, -5.5, N], [2.6, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
  server:   [[5.3, -5.9, N], [7.1, -5.9, N], [8.9, -5.9, N], [10.7, -5.9, N], [8, -2.8, N]],
  research: [[-10.1, 3.5, W], [-10.1, 6.5, W], [-6.6, 5, W], [-8, 6.6, N]],
  meeting:  [[-2.5, 5, W], [-0.5, 3.7, E], [-0.5, 6.3, E], [2.1, 3.7, W], [2.1, 6.3, W], [0.8, 7.4, N]],
  desk:     [[8.4, 5, E], [7.1, 3.8, E], [7.1, 6.2, E], [5.9, 5, E]],
  lounge:   [[5.0, -1.3, S], [6.4, -1.3, S], [7.8, -1.3, S], [9.2, -1.3, S], [10.6, -1.3, S],
             [3.6, -1.3, S], [2.2, -1.3, S], [0.8, -1.3, S]],
});

export const THEME_LAYOUTS = Object.freeze({
  studio: Object.freeze({
    walkway: 'spine',
    elevator: { x: -11.2, z: 0 },
    doors: BASE_DOORS,
    slots: BASE_SLOTS,
  }),
  office: Object.freeze({
    walkway: 'spine',
    elevator: { x: -11.2, z: 0 },
    doors: BASE_DOORS,
    slots: BASE_SLOTS,
  }),
  palace: Object.freeze({
    // 중앙 후원 연못(방지원도, x: -3.2 ~ 3.2)을 피해 남북 회랑(z = ±1.45)으로 우회 보행
    walkway: 'ring',
    obstacle: { x0: -3.4, x1: 3.4, zNorth: -1.45, zSouth: 1.45 },
    elevator: { x: -11.8, z: 0 },
    doors: Object.freeze({
      ...BASE_DOORS,
      dev:    { x: 0,     z: -2, inner: -3.1, sign: [0, 1.85, -2] },
      lounge: { x: -11.8, z: 0,  inner: 0,    sign: [-12.1, 3.1, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.4, -6.3, N], [-8, -6.3, N], [-5.6, -6.3, N], [-8.8, -3.2, N], [-7.2, -3.2, N]],
      dev:      [[-2.5, -5.8, N], [0, -5.8, N], [2.5, -5.8, N], [-1.4, -3.4, N], [1.4, -3.4, N]],
      server:   [[5.5, -5.8, N], [7.2, -5.8, N], [8.8, -5.8, N], [10.5, -5.8, N], [8, -3.1, N]],
      research: [[-10.2, 3.7, W], [-10.2, 6.3, W], [-6.5, 5, W], [-8, 6.7, N]],
      meeting:  [[-2.4, 5, W], [-0.4, 3.8, E], [-0.4, 6.2, E], [2.0, 3.8, W], [2.0, 6.2, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   [[5.2, -1.45, S], [6.6, -1.45, S], [8.0, -1.45, S], [9.4, -1.45, S],
                 [5.2, 1.45, N], [6.6, 1.45, N], [-5.4, -1.45, S], [-6.8, -1.45, S]],
    }),
  }),
  hanok: Object.freeze({
    // 중앙 안마당 화단·우물(x: -3.0 ~ 3.0)을 피해 툇마루/디딤돌 둘레길(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -3.2, x1: 3.2, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -11.6, z: 0 },
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
      meeting:  [[-2.4, 5, W], [-0.4, 3.8, E], [-0.4, 6.2, E], [2.0, 3.8, W], [2.0, 6.2, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   [[4.8, -1.35, S], [6.2, -1.35, S], [7.6, -1.35, S], [9.0, -1.35, S],
                 [4.8, 1.35, N], [6.2, 1.35, N], [-5.2, -1.35, S], [-6.6, -1.35, S]],
    }),
  }),
  starship: Object.freeze({
    // 중앙 홀로그램 워프 코어 링(x: -2.6 ~ 2.6) 둘레의 브리지 링 통로(z = ±1.4)로 보행
    walkway: 'ring',
    obstacle: { x0: -2.8, x1: 2.8, zNorth: -1.4, zSouth: 1.4 },
    elevator: { x: -11.8, z: 0 },
    doors: Object.freeze({
      ...BASE_DOORS,
      lounge: { x: -11.8, z: 0, inner: 0, sign: [-12.1, 3.0, 0] },
    }),
    slots: Object.freeze({
      archive:  [[-10.2, -6.1, N], [-8, -6.1, N], [-5.8, -6.1, N], [-8.8, -3.1, N], [-7.2, -3.1, N]],
      dev:      [[-2.5, -5.5, N], [0, -5.5, N], [2.5, -5.5, N], [-1.3, -3.1, N], [1.3, -3.1, N]],
      server:   [[5.5, -5.8, N], [7.2, -5.8, N], [8.8, -5.8, N], [10.4, -5.8, N], [8, -3.0, N]],
      research: [[-10.0, 3.6, W], [-10.0, 6.4, W], [-6.6, 5, W], [-8, 6.6, N]],
      meeting:  [[-2.4, 5, W], [-0.4, 3.7, E], [-0.4, 6.3, E], [2.0, 3.7, W], [2.0, 6.3, W], [0.8, 7.2, N]],
      desk:     [[8.3, 5, E], [7.0, 3.8, E], [7.0, 6.2, E], [5.8, 5, E]],
      lounge:   [[4.8, -1.35, S], [6.2, -1.35, S], [7.6, -1.35, S], [9.0, -1.35, S],
                 [4.8, 1.35, N], [6.2, 1.35, N], [-5.2, -1.35, S], [-6.6, -1.35, S]],
    }),
  }),
});

export function layoutOf(theme) {
  return THEME_LAYOUTS[theme] || THEME_LAYOUTS.studio;
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
  const chooseNorth = (z1 + z2) <= 0;
  const ringZ = (chooseNorth ? zNorth : zSouth) + lane * 0.25;
  const entryX = x1 < x0 ? x0 : x1 > ox1 ? ox1 : x1;
  const exitX = x2 < x0 ? x0 : x2 > ox1 ? ox1 : x2;
  const pts = [{ x: entryX, z: ringZ }];
  if (Math.abs(exitX - entryX) > 0.2) pts.push({ x: exitX, z: ringZ });
  return pts;
}
