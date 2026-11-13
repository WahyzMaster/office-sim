// 곡예 돌파 모션(maneuver), 정체 감지 및 캐릭터 간 충돌 분리. three.js 없이 쓰는 순수 함수.
import { activeMotionOf, activeThemeOf, resolveAgentAppearance } from './rooms.js';
import { AGENT_RADIUS, hitObstacle, segmentHitsObstacle, resolveObstacleCollision } from './placement.js';

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
  if (family === 'bots') return blockerCount >= 2 && seq % 2 === 1 ? 'prop-fly' : (seq % 3 === 2 ? 'roll' : (seq % 3 === 1 ? 'spin' : 'phase'));
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
      if (a.maneuver || b.maneuver) continue;
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
      const tx = -nz;
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
