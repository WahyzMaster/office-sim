// 직원 색, 걷는 길(lane), 자리가 없을 때 기다리는 곳, 이동 경로. three.js 없이 쓰는 순수 함수.
import { ROOMS, activeThemeOf, doorOf, zoneAt } from './rooms.js';
import { corridorWaypoints } from './theme-layouts.js';

export const GOLDEN_ANGLE = 137.508;
const FAMILY_SPAN = 48; // 형제 서브에이전트 색이 퍼지는 폭: 부모 브랜드 색 계열 안에서 ±24도
const MIN_HUE_GAP = 8; // 같은 층 메인 세션끼리 이보다 가까운 색이면 황금각만큼 돌린다
export const LANES = 15;
const LANE_GAP = 0.1; // 15칸 x 0.1 = 복도 가운데 ±0.7, 문 폭(±1) 안쪽
const LOUNGE_ROWS = [-1.3, 1.3, -0.7, 0.7, 0];

// 에이전트 브랜드별 대표 색상(Hue): Claude(테라코타), Codex(에메랄드), Grok(코스믹 바이올렛), Antigravity(딥마인드 코발트/CLI 시안)
export const BRAND_HUES = Object.freeze({
  'claude-code': 18,
  codex: 162,
  grok: 268,
  antigravity: 222,
  'antigravity:cli': 195,
  'antigravity:ide': 208,
  'antigravity:app': 224,
});

export function hueOf(id) {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// 메인 세션: id 에서 뽑은 색을 쓰되, 같은 층에 비슷한 색이 있으면 황금각씩 돌려 피한다.
export function spreadHue(base, taken) {
  for (let i = 0; i < 12; i++) {
    const h = (base + i * GOLDEN_ANGLE) % 360;
    if (taken.every((t) => hueGap(h, t) >= MIN_HUE_GAP)) return Math.round(h * 10) / 10;
  }
  return base % 360;
}

// 브랜드 색상 계열 안에서 세션마다 미세한 톤 차이를 준다(브랜드 정체성 유지 + 같은 층 동료 구분).
export function brandHue(agent, surface, id, taken = []) {
  const key = agent === 'antigravity' && surface && Object.hasOwn(BRAND_HUES, `antigravity:${surface}`)
    ? `antigravity:${surface}` : agent;
  if (!Object.hasOwn(BRAND_HUES, key)) return spreadHue(hueOf(id), taken);
  const center = BRAND_HUES[key];
  const seed = ((hueOf(id) % 17) - 8) * 1.2;
  for (let i = 0; i < 9; i++) {
    const shift = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 4.5;
    const h = (((center + seed + shift) % 360) + 360) % 360;
    if (taken.every((t) => hueGap(h, t) >= 4)) return Math.round(h * 10) / 10;
  }
  return (((center + seed) % 360) + 360) % 360;
}

// 서브에이전트: 부모 색 계열을 지키면서 형제 순번 k 마다 황금각 비율로 흩어 서로 다른 색을 준다.
export function familyHue(parentHue, k) {
  const frac = ((k * GOLDEN_ANGLE) / 360) % 1;
  const h = parentHue + 18 + frac * FAMILY_SPAN - FAMILY_SPAN / 2;
  return Math.round((((h % 360) + 360) % 360) * 10) / 10;
}

// 형제끼리 밝기도 세 단계로 번갈아 바꿔 색 차이를 키운다.
export function familyLight(k) { return 0.5 + ((k % 3) - 1) * 0.07; }

// 층마다 나눠 주는 lane 번호 k -> 복도에서 걷는 z 오프셋. 0, +1, -1, +2, -2 ... 순서로 가운데부터 채운다.
export function laneOffset(k) {
  const i = k % LANES;
  const n = Math.ceil(i / 2);
  return (i % 2 ? n : -n) * LANE_GAP;
}

// 자리가 꽉 찼을 때 k 번째로 기다리는 곳 [x, z, 바라보는 방향].
export function overflowPos(room, k) {
  if (room === 'lounge') {
    const row = LOUNGE_ROWS[Math.floor(k / 7) % LOUNGE_ROWS.length];
    return [-6 + (k % 7) * 0.9, row, 0];
  }
  const d = doorOf(room);
  const top = ROOMS[room].side === 'top';
  const row = Math.floor(k / 7) % 3;
  return [d.x + ((k % 7) - 3) * 0.45, d.inner + (top ? -1 : 1) * (0.4 + row * 0.55), top ? Math.PI : 0];
}

// 방 사이 경로. 문을 지날 때도 lane 만큼 옆으로 비켜 걸어서 같이 출발한 직원이 겹치지 않는다.
// 중정/연못/워프코어가 있는 테마(palace, hanok, starship)는 회랑 둘레길 경유점을 자동으로 끼워 넣는다.
export function route(p, toRoom, tx, tz, lane, theme = activeThemeOf()) {
  const pts = [];
  const from = zoneAt(p.x, p.z);
  let cx = p.x;
  let cz = p.z;
  if (from !== toRoom) {
    if (from !== 'lounge') {
      const d = doorOf(from, theme);
      pts.push({ x: d.x + lane, z: d.inner }, { x: d.x + lane, z: lane });
      cx = d.x + lane;
      cz = lane;
    }
    const targetX = toRoom !== 'lounge' ? doorOf(toRoom, theme).x + lane : tx;
    const targetZ = toRoom !== 'lounge' ? lane : tz;
    pts.push(...corridorWaypoints(cx, cz, targetX, targetZ, lane, theme));
    if (toRoom !== 'lounge') {
      const d = doorOf(toRoom, theme);
      pts.push({ x: d.x + lane, z: lane }, { x: d.x + lane, z: d.inner });
    }
  } else if (from === 'lounge') {
    pts.push(...corridorWaypoints(cx, cz, tx, tz, lane, theme));
  }
  pts.push({ x: tx, z: tz });
  return pts;
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
