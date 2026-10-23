// 직원 색, 걷는 길(lane), 자리가 없을 때 기다리는 곳, 이동 경로·충돌 회피. three.js 없이 쓰는 순수 함수.
import { ROOMS, activeMotionOf, activeThemeOf, doorOf, resolveAgentAppearance, zoneAt } from './rooms.js';
import { corridorWaypoints, layoutOf, obstaclesOf } from './theme-layouts.js';

export const GOLDEN_ANGLE = 137.508;
const FAMILY_SPAN = 48; // 형제 서브에이전트 색이 퍼지는 폭: 부모 브랜드 색 계열 안에서 ±24도
const MIN_HUE_GAP = 8; // 같은 층 메인 세션끼리 이보다 가까운 색이면 황금각만큼 돌린다
export const LANES = 15;
const LANE_GAP = 0.1; // 15칸 x 0.1 = 복도 가운데 ±0.7, 문 폭(±1) 안쪽
const LOUNGE_ROWS = [-1.35, 1.35, -0.75, 0.75, 0];
export const AGENT_RADIUS = 0.24;

// 에이전트 브랜드별 대표 색상(Hue): Claude(테라코타/코랄), Codex(에메랄드/민트), Grok(코스믹 바이올렛), Antigravity(딥마인드 코발트/CLI 시안)
export const BRAND_HUES = Object.freeze({
  'claude-code': 18, 'claude-code:cli': 16, 'claude-code:app': 28,
  codex: 162, 'codex:cli': 156, 'codex:app': 174, grok: 268,
  antigravity: 222, 'antigravity:cli': 195, 'antigravity:ide': 208, 'antigravity:app': 224,
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
  const key = surface && Object.hasOwn(BRAND_HUES, `${agent}:${surface}`)
    ? `${agent}:${surface}` : agent;
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

// 점 (x, z)가 반경 r 로 장애물 AABB 와 겹치면 해당 장애물을 반환한다.
export function hitObstacle(x, z, r = AGENT_RADIUS, theme = activeThemeOf()) {
  for (const o of obstaclesOf(theme)) {
    if (x > o.x0 - r && x < o.x1 + r && z > o.z0 - r && z < o.z1 + r) return o;
  }
  return null;
}

// 선분 (x1,z1)->(x2,z2)이 장애물 AABB 와 교차하는지 검사한다.
export function segmentHitsObstacle(x1, z1, x2, z2, r = 0.2, theme = activeThemeOf()) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(2, Math.ceil(dist / 0.14));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (hitObstacle(x1 + dx * t, z1 + dz * t, r, theme)) return true;
  }
  return false;
}

// 위치 p({x, z})가 장애물 내부로 파고들었을 때 가장 얕은 축으로 밀어낸다.
export function resolveObstacleCollision(p, r = AGENT_RADIUS, theme = activeThemeOf()) {
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const o of obstaclesOf(theme)) {
      if (p.x <= o.x0 - r || p.x >= o.x1 + r || p.z <= o.z0 - r || p.z >= o.z1 + r) continue;
      const dL = p.x - (o.x0 - r);
      const dR = (o.x1 + r) - p.x;
      const dT = p.z - (o.z0 - r);
      const dB = (o.z1 + r) - p.z;
      const m = Math.min(dL, dR, dT, dB);
      if (m === dL) p.x = o.x0 - r - 0.01;
      else if (m === dR) p.x = o.x1 + r + 0.01;
      else if (m === dT) p.z = o.z0 - r - 0.01;
      else p.z = o.z1 + r + 0.01;
      moved = true;
    }
    if (!moved) break;
  }
  p.x = Math.max(-11.65, Math.min(11.65, p.x));
  p.z = Math.max(-7.65, Math.min(7.65, p.z));
  return p;
}

// 장애물 및 기존 점유 위치(occupied)와 겹치지 않는 가장 가까운 안전 좌표를 찾는다.
export function safeSpawnPos(x, z, r = AGENT_RADIUS, theme = activeThemeOf(), occupied = [], minGap = 0.52) {
  const isFree = (cx, cz) => {
    if (cx < -11.6 || cx > 11.6 || cz < -7.6 || cz > 7.6) return false;
    if (hitObstacle(cx, cz, r, theme)) return false;
    return occupied.every((o) => Math.hypot(cx - o.x, cz - o.z) >= minGap);
  };
  if (isFree(x, z)) return { x, z };
  for (let ring = 1; ring <= 10; ring++) {
    const rad = ring * 0.34;
    const n = ring * 8;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const cx = Math.round((x + Math.cos(ang) * rad) * 100) / 100;
      const cz = Math.round((z + Math.sin(ang) * rad) * 100) / 100;
      if (isFree(cx, cz)) return { x: cx, z: cz };
    }
  }
  const fallback = resolveObstacleCollision({ x, z }, r, theme);
  return { x: Math.round(fallback.x * 100) / 100, z: Math.round(fallback.z * 100) / 100 };
}

// 2D 격자 A* + 가시선(line-of-sight) 단순화로 가구·장애물을 우회하는 경유점을 구한다.
export function findSafePath(x1, z1, x2, z2, theme = activeThemeOf(), r = 0.2) {
  if (!segmentHitsObstacle(x1, z1, x2, z2, r, theme)) return [{ x: x2, z: z2 }];
  const step = 0.4;
  const pad = 3.2;
  const minX = Math.max(-11.6, Math.min(x1, x2) - pad);
  const maxX = Math.min(11.6, Math.max(x1, x2) + pad);
  const minZ = Math.max(-7.6, Math.min(z1, z2) - pad);
  const maxZ = Math.min(7.6, Math.max(z1, z2) + pad);
  const cols = Math.max(2, Math.round((maxX - minX) / step));
  const rows = Math.max(2, Math.round((maxZ - minZ) / step));
  const toCell = (x, z) => [
    Math.max(0, Math.min(cols, Math.round((x - minX) / step))),
    Math.max(0, Math.min(rows, Math.round((z - minZ) / step))),
  ];
  const toWorld = (c, rw) => ({
    x: Math.round((minX + c * step) * 100) / 100,
    z: Math.round((minZ + rw * step) * 100) / 100,
  });
  const [sc, sr] = toCell(x1, z1);
  const [gc, gr] = toCell(x2, z2);
  const keyOf = (c, rw) => rw * (cols + 1) + c;
  const startK = keyOf(sc, sr);
  const goalK = keyOf(gc, gr);

  const open = [{ c: sc, r: sr, k: startK, g: 0, f: Math.hypot(gc - sc, gr - sr) }];
  const bestG = new Map([[startK, 0]]);
  const came = new Map();
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]];

  let reached = false;
  let guard = 0;
  while (open.length > 0 && guard++ < 900) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.k === goalK) { reached = true; break; }
    const curW = toWorld(cur.c, cur.r);
    for (const [dc, dr, cost] of dirs) {
      const nc = cur.c + dc;
      const nr = cur.r + dr;
      if (nc < 0 || nc > cols || nr < 0 || nr > rows) continue;
      const nk = keyOf(nc, nr);
      const wp = toWorld(nc, nr);
      if (nk !== goalK && hitObstacle(wp.x, wp.z, r, theme)) continue;
      if (segmentHitsObstacle(curW.x, curW.z, wp.x, wp.z, r, theme)) continue;
      const ng = cur.g + cost;
      if (ng >= (bestG.get(nk) ?? Infinity)) continue;
      bestG.set(nk, ng);
      came.set(nk, cur.k);
      open.push({ c: nc, r: nr, k: nk, g: ng, f: ng + Math.hypot(gc - nc, gr - nr) });
    }
  }
  if (!reached) return [{ x: x2, z: z2 }];

  const raw = [{ x: x2, z: z2 }];
  let curK = goalK;
  while (came.has(curK) && curK !== startK) {
    const c = curK % (cols + 1);
    const rw = Math.floor(curK / (cols + 1));
    raw.push(toWorld(c, rw));
    curK = came.get(curK);
  }
  raw.push({ x: x1, z: z1 });
  raw.reverse();

  // 가시선(String-pulling) 단순화: 직선으로 갈 수 있는 중간 격자점은 건너뛴다.
  const smooth = [];
  let anchor = raw[0];
  let idx = 1;
  while (idx < raw.length) {
    let furthest = idx;
    for (let j = raw.length - 1; j > idx; j--) {
      if (!segmentHitsObstacle(anchor.x, anchor.z, raw[j].x, raw[j].z, r, theme)) {
        furthest = j;
        break;
      }
    }
    smooth.push(raw[furthest]);
    anchor = raw[furthest];
    idx = furthest + 1;
  }
  return smooth;
}

// 자리가 꽉 찼을 때 k 번째로 기다리는 곳 [x, z, 바라보는 방향]. 가구·장애물과 겹치지 않는다.
export function overflowPos(room, k, theme = activeThemeOf()) {
  if (room === 'lounge') {
    const row = LOUNGE_ROWS[Math.floor(k / 7) % LOUNGE_ROWS.length];
    const candX = -6.2 + (k % 7) * 0.95;
    const safe = safeSpawnPos(candX, row, AGENT_RADIUS, theme);
    return [safe.x, safe.z, 0];
  }
  const d = doorOf(room, theme);
  const top = ROOMS[room].side === 'top';
  const row = Math.floor(k / 5) % 2;
  const col = (k % 5) - 2;
  const candX = d.x + col * 0.52;
  const candZ = d.inner + (top ? -1 : 1) * (0.25 + row * 0.45);
  const safe = safeSpawnPos(candX, candZ, AGENT_RADIUS, theme);
  return [safe.x, safe.z, top ? Math.PI : 0];
}

function corridorDoorZ(room, lane, theme) {
  const lay = layoutOf(theme);
  if (lay.walkway === 'ring' && lay.obstacle) {
    const top = ROOMS[room]?.side === 'top';
    return (top ? lay.obstacle.zNorth : lay.obstacle.zSouth) + lane * 0.25;
  }
  return lane;
}

// 방 사이 경로. 문을 지날 때도 lane 만큼 옆으로 비켜 걸어서 같이 출발한 직원이 겹치지 않는다.
// 중정/연못/워프코어 및 방 내부 가구(테이블·글로브·랙·소파)를 자동으로 우회한다.
export function route(p, toRoom, tx, tz, lane, theme = activeThemeOf()) {
  const raw = [];
  const from = zoneAt(p.x, p.z);
  let cx = p.x;
  let cz = p.z;
  const doorLane = Math.max(-0.55, Math.min(0.55, lane));
  if (from !== toRoom) {
    if (from !== 'lounge') {
      const d = doorOf(from, theme);
      const outZ = corridorDoorZ(from, lane, theme);
      raw.push({ x: d.x + doorLane, z: d.inner }, { x: d.x + doorLane, z: outZ });
      cx = d.x + doorLane;
      cz = outZ;
    }
    const targetX = toRoom !== 'lounge' ? doorOf(toRoom, theme).x + doorLane : tx;
    const targetZ = toRoom !== 'lounge' ? corridorDoorZ(toRoom, lane, theme) : tz;
    raw.push(...corridorWaypoints(cx, cz, targetX, targetZ, lane, theme));
    if (toRoom !== 'lounge') {
      const d = doorOf(toRoom, theme);
      const inZ = corridorDoorZ(toRoom, lane, theme);
      raw.push({ x: d.x + doorLane, z: inZ }, { x: d.x + doorLane, z: d.inner });
    }
  } else if (from === 'lounge') {
    raw.push(...corridorWaypoints(cx, cz, tx, tz, lane, theme));
  }
  raw.push({ x: tx, z: tz });

  const pts = [];
  let prev = { x: p.x, z: p.z };
  for (const wp of raw) {
    if (Math.hypot(wp.x - prev.x, wp.z - prev.z) < 0.05) continue;
    const sub = findSafePath(prev.x, prev.z, wp.x, wp.z, theme, 0.18);
    for (const s of sub) pts.push(s);
    prev = pts[pts.length - 1] || wp;
  }
  if (!pts.length) pts.push({ x: tx, z: tz });
  return pts;
}

// 막힌 길 돌파용 곡예 모션(점프·구르기·공중제비·회전돌파·프로펠러 비행·무중력 활공) 규격.
export const MANEUVER_SPECS = Object.freeze({
  jump:       Object.freeze({ kind: 'jump',     dur: 0.46, height: 0.92, speedMult: 1.55, ko: '폴짝!',     en: 'Hop!' }),
  roll:       Object.freeze({ kind: 'roll',     dur: 0.44, height: 0.28, speedMult: 1.70, ko: '데구르르!', en: 'Roll!' }),
  flip:       Object.freeze({ kind: 'flip',     dur: 0.48, height: 1.12, speedMult: 1.65, ko: '공중제비!', en: 'Flip!' }),
  spin:       Object.freeze({ kind: 'spin',     dur: 0.45, height: 0.62, speedMult: 1.62, ko: '빙글!',     en: 'Spin!' }),
  'prop-fly': Object.freeze({ kind: 'prop-fly', dur: 0.52, height: 0.88, speedMult: 1.60, ko: '붕붕~',     en: 'Whirr~' }),
  phase:      Object.freeze({ kind: 'phase',    dur: 0.48, height: 0.90, speedMult: 1.65, ko: '무중력!',   en: 'Phase!' }),
});

// 캐릭터 정체성(서브에이전트·Antigravity·고양이·강아지·인간형)과 정체 인원수에 맞춰 곡예 모션을 고른다.
export function pickManeuverKind(agent = {}, blockerCount = 1, seq = 0, explicitKind = '') {
  if (explicitKind && MANEUVER_SPECS[explicitKind]) return explicitKind;
  const ov = agent.motionOverride && agent.motionOverride !== 'auto' ? agent.motionOverride : activeMotionOf();
  if (ov && MANEUVER_SPECS[ov]) return ov;
  const family = agent.charFamily || resolveAgentAppearance(agent).family;
  if (agent.isSub) return blockerCount >= 2 && seq % 2 === 1 ? 'roll' : 'prop-fly';
  if (agent.agent === 'antigravity' && family === 'human') return seq % 3 === 2 ? 'roll' : (seq % 3 === 1 ? 'spin' : 'phase');
  if (family === 'cats') return blockerCount >= 3 && seq % 2 === 1 ? 'roll' : (seq % 3 === 2 ? 'spin' : 'flip');
  if (family === 'dogs') return blockerCount >= 2 ? 'roll' : (seq % 3 === 2 ? 'spin' : (seq % 2 === 1 ? 'roll' : 'jump'));
  return blockerCount >= 2 ? 'roll' : (seq % 3 === 2 ? 'spin' : (seq % 2 === 1 ? 'roll' : 'jump'));
}

const posOf = (a) => a?.group?.position || a?.root?.position || a?.position || null;

// 중간 경유점(path[0])이 다른 캐릭터에게 막혔을 때 다음 경유점(path[1])으로 시야가 열려 있으면 바로 건너뛴다.
export function shouldSkipWaypoint(pos, path, agents = [], theme = activeThemeOf(), self = null) {
  if (!pos || !Array.isArray(path) || path.length < 2) return false;
  const wp0 = path[0];
  const wp1 = path[1];
  const d0 = Math.hypot(wp0.x - pos.x, wp0.z - pos.z);
  if (d0 > 0.78 || segmentHitsObstacle(pos.x, pos.z, wp1.x, wp1.z, 0.18, theme)) return false;
  for (const b of agents) {
    if (!b || b === self || b.group?.visible === false) continue;
    const pb = posOf(b);
    if (pb && Math.hypot(pb.x - wp0.x, pb.z - wp0.z) < 0.54) return true;
  }
  return false;
}

// 이동 방향 전방 원뿔(cone) 안에 다른 캐릭터가 길을 막고 있는지(다중 밀집·좁은 문/복도 병목) 검사한다.
export function detectBlockage(agent, agents = [], theme = activeThemeOf()) {
  const pa = posOf(agent);
  const target = agent?.path?.[0];
  if (!pa || !target) return { blocked: false, count: 0, blocker: null };
  const dx = target.x - pa.x;
  const dz = target.z - pa.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.08) return { blocked: false, count: 0, blocker: null };
  const ux = dx / dist;
  const uz = dz / dist;
  let count = 0;
  let nearest = null;
  let minFwd = Infinity;
  for (const b of agents) {
    if (!b || b === agent || b.maneuver || b.group?.visible === false) continue;
    if (agent.floor && b.floor && agent.floor !== b.floor) continue;
    const pb = posOf(b);
    if (!pb) continue;
    const rx = pb.x - pa.x;
    const rz = pb.z - pa.z;
    const fwd = rx * ux + rz * uz;
    const lat = Math.abs(-rx * uz + rz * ux);
    if (fwd > 0.08 && fwd < 1.25 && lat < 0.42) {
      count += 1;
      if (fwd < minFwd) { minFwd = fwd; nearest = b; }
    }
  }
  if (!count) return { blocked: false, count: 0, blocker: null };
  const leftBlocked = !!hitObstacle(pa.x - uz * 0.48, pa.z + ux * 0.48, 0.2, theme);
  const rightBlocked = !!hitObstacle(pa.x + uz * 0.48, pa.z - ux * 0.48, 0.2, theme);
  const headOn = nearest?.path?.length > 0 && ((nearest.path[0].x - posOf(nearest).x) * ux + (nearest.path[0].z - posOf(nearest).z) * uz) < 0;
  const blocked = count >= 2 || leftBlocked || rightBlocked || (minFwd < 0.92 && (!nearest?.path?.length || headOn));
  return { blocked, count, blocker: nearest };
}

// 곡예 모션(jump·roll·flip·spin·prop-fly·phase)의 정규화 시간 u(0..1)에 따른 3D 골격 회전·높이 포즈를 계산한다.
export function computeManeuverPose(m, t = 0, isTetra = false, reduced = false) {
  if (!m || !(m.dur > 0) || reduced) return null;
  const u = Math.min(1, Math.max(0, m.t / m.dur));
  const arc = Math.sin(u * Math.PI);
  const s2 = Math.sin(u * Math.PI * 2);
  const ease = u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2;
  const bob = arc * (m.height || 0.9);
  if (m.kind === 'roll') return { bob, rigPitch: ease * Math.PI * 2, rigYaw: 0, rigRoll: 0, headPitch: 0.48 * arc, leg: 1.05 * arc, legSym: true, armL: (isTetra ? -1.05 : -1.75) * arc, armR: (isTetra ? -1.05 : -1.75) * arc };
  if (m.kind === 'flip') return { bob, rigPitch: -ease * Math.PI * 2, rigYaw: 0, rigRoll: arc * 0.48, headPitch: -0.2 * arc, leg: -0.82 * arc, legSym: true, armL: -1.25 * arc, armR: -1.25 * arc };
  if (m.kind === 'spin') return { bob, rigPitch: 0, rigYaw: ease * Math.PI * 2, rigRoll: s2 * 0.24, headPitch: 0, leg: 0.58 * arc, legSym: false, armL: -1.45 * arc, armR: -0.55 * arc };
  if (m.kind === 'prop-fly') return { bob, rigPitch: 0.22 * arc, rigYaw: 0, rigRoll: s2 * 0.22, headPitch: 0, leg: Math.sin(t * 28) * 0.42, legSym: false, armL: (isTetra ? -0.5 : -1.45) * arc, armR: (isTetra ? -0.5 : -1.45) * arc };
  if (m.kind === 'phase') return { bob, rigPitch: -0.18 * arc, rigYaw: s2 * 0.28, rigRoll: 0, headPitch: 0, leg: 0.42 * arc, legSym: true, armL: (isTetra ? -0.4 : -1.2) * arc, armR: (isTetra ? -0.4 : -1.2) * arc };
  return { bob, rigPitch: s2 * 0.32, rigYaw: 0, rigRoll: 0, headPitch: -0.25 * arc, leg: 0.78 * arc, legSym: true, armL: (isTetra ? -0.75 : -2.25) * arc, armR: (isTetra ? -0.75 : -2.25) * arc };
}

// 에이전트에게 곡예 돌파 모션(maneuver)을 시작시키고 사운드 트리거 종류를 반환한다.
export function startAgentManeuver(agent, blockerCount = 1, explicitKind = '', manual = false) {
  const seq = agent.maneuverSeq || 0;
  agent.maneuverSeq = seq + 1;
  const kind = pickManeuverKind(agent, blockerCount, seq, explicitKind);
  agent.maneuver = { ...(MANEUVER_SPECS[kind] || MANEUVER_SPECS.jump), t: 0, blockerCount, manual };
  agent.stallT = 0;
  return kind === 'roll' ? 'roll' : 'hop';
}

// 에이전트의 한 프레임 경로 이동·경유점 건너뛰기·정체 감지·곡예 돌파(maneuver) 상태를 갱신한다.
export function stepAgentPath(agent, dt, baseSpeed, theme = activeThemeOf()) {
  const pos = posOf(agent);
  agent.maneuverCd = Math.max(0, (agent.maneuverCd || 0) - dt);
  if (agent.maneuver && (agent.maneuver.t += dt) >= agent.maneuver.dur) {
    agent.maneuver = null;
    agent.maneuverCd = 1.2;
  }
  if (!pos || !agent.path?.length) {
    agent.stallT = agent.prevStep = 0;
    return { moving: false, heading: null, arrived: false, soundTrigger: null };
  }
  if (!agent.maneuver && agent.prevStep > 0.001 && typeof agent.prevX === 'number') {
    const netMoved = Math.hypot(pos.x - agent.prevX, pos.z - agent.prevZ);
    agent.stallT = netMoved < agent.prevStep * 0.45 ? (agent.stallT || 0) + dt : Math.max(0, (agent.stallT || 0) - dt * 2);
  }
  const peers = agent.floor?.agents ? [...agent.floor.agents] : (agent.peers || []);
  while (agent.path.length >= 2 && shouldSkipWaypoint(pos, agent.path, peers, theme, agent)) agent.path.shift();
  let soundTrigger = null;
  if (!agent.maneuver && agent.maneuverCd <= 0) {
    const blk = detectBlockage(agent, peers, theme);
    if (blk.blocked || (agent.stallT || 0) >= 0.22) soundTrigger = startAgentManeuver(agent, Math.max(1, blk.count));
  }
  const target = agent.path[0];
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  const step = baseSpeed * (agent.maneuver ? agent.maneuver.speedMult : 1) * dt;
  agent.prevX = pos.x;
  agent.prevZ = pos.z;
  agent.prevStep = step;
  if (dist <= step) {
    pos.x = target.x;
    pos.z = target.z;
    agent.path.shift();
  } else {
    pos.x += (dx / dist) * step;
    pos.z += (dz / dist) * step;
  }
  resolveObstacleCollision(pos, 0.2, theme);
  const arrived = agent.path.length === 0;
  if (arrived) { if (!agent.maneuver?.manual) agent.maneuver = null; agent.stallT = agent.prevStep = 0; }
  return { moving: true, heading: dist > 0.01 ? Math.atan2(dx, dz) : null, arrived, soundTrigger };
}

// 같은 층 에이전트끼리 이동·정지 중 몸체가 겹치지 않도록 밀어내고(우측통행 접선 회피 포함) 장애물 밖으로 유지한다.
export function separateAgents(agents, dt = 0.016, minDist = 0.56, theme = activeThemeOf()) {
  const list = agents.filter((a) => a && a.group?.visible !== false && posOf(a));
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const pa = posOf(a);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (a.floor && b.floor && a.floor !== b.floor) continue;
      if (a.maneuver || b.maneuver) continue; // 공중 점프·구르기 돌파 중인 캐릭터는 수평 충돌을 통과한다
      const pb = posOf(b);
      let dx = pb.x - pa.x;
      let dz = pb.z - pa.z;
      let dist = Math.hypot(dx, dz);
      if (dist >= minDist) continue;
      if (dist < 0.001) {
        dx = 0.01;
        dz = 0;
        dist = 0.01;
      }
      const overlap = (minDist - dist);
      const nx = dx / dist;
      const nz = dz / dist;
      const tx = -nz; // 우측통행 접선 벡터 (정면 교착 방지)
      const tz = nx;
      const aMoving = a.path?.length > 0;
      const bMoving = b.path?.length > 0;
      const push = Math.min(overlap * 0.65, dt * 3.8);
      const slide = push * 0.48;
      if (aMoving && !bMoving) {
        const bYield = b.mode === 'idle' ? 0.25 : 0;
        pa.x += -nx * push * (1 - bYield) + tx * slide;
        pa.z += -nz * push * (1 - bYield) + tz * slide;
        pb.x += nx * push * bYield;
        pb.z += nz * push * bYield;
      } else if (!aMoving && bMoving) {
        const aYield = a.mode === 'idle' ? 0.25 : 0;
        pb.x += nx * push * (1 - aYield) - tx * slide;
        pb.z += nz * push * (1 - aYield) - tz * slide;
        pa.x -= nx * push * aYield;
        pa.z -= nz * push * aYield;
      } else {
        pa.x += (-nx * push + tx * slide) * 0.5;
        pa.z += (-nz * push + tz * slide) * 0.5;
        pb.x += (nx * push - tx * slide) * 0.5;
        pb.z += (nz * push - tz * slide) * 0.5;
      }
    }
    resolveObstacleCollision(pa, AGENT_RADIUS * 0.85, theme);
  }
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
