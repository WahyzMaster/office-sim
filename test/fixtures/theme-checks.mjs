// 테마 기하 불변식. 검사마다 (b = buildTheme 결과, theme) -> 실패 설명 목록. 테스트는 개수를 KNOWN(theme-known.mjs)과 맞춘다.
import { layoutOf, obstaclesOf } from '../../public/js/theme-layouts.js';
import { route } from '../../public/js/placement.js';
import { THREE } from './load-three-record.mjs';
import { inPolygon, distToPolygon, samplePolyline, polygonArea } from './geom-utils.mjs';

const EPS = 1e-6;
const f2 = (v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const at = (r) => `${r.path} [${r.aabb.min.map(f2)}]..[${r.aabb.max.map(f2)}]`;
const meshesOf = (b) => b.meshes.filter((r) => r.kind === 'Mesh');
const opaque = (r) => !(r.mat.transparent && r.mat.opacity < 0.95);
const slotsOf = (theme) => Object.entries(layoutOf(theme).slots).flatMap(([room, list]) => list.map(([x, z], k) => ({ room, k, x, z })));
const xzOverlap = (a, b, pad = 0) => a.aabb.max[0] + pad >= b.aabb.min[0] && a.aabb.min[0] - pad <= b.aabb.max[0]
  && a.aabb.max[2] + pad >= b.aabb.min[2] && a.aabb.min[2] - pad <= b.aabb.max[2];
const boxOverlap = (r, o) => r.aabb.max[0] > o.x0 && r.aabb.min[0] < o.x1 && r.aabb.max[2] > o.z0 && r.aabb.min[2] < o.z1;

// 바닥면 합집합: 밑면 <= 0.001, 윗면 -0.02..0.2, XZ 넓이 >= 0.5
function groundsOf(b) {
  return (b._grounds ||= meshesOf(b).filter((r) => r.bottom <= 0.001 && r.top >= -0.02 && r.top <= 0.2 && polygonArea(r.outline) >= 0.5));
}
export function onGround(b, x, z, tol = 0.05) {
  return groundsOf(b).some((g) => x >= g.aabb.min[0] - tol && x <= g.aabb.max[0] + tol && z >= g.aabb.min[2] - tol && z <= g.aabb.max[2] + tol
    && inPolygon([x, z], g.outline, tol));
}

// 1. 비균일 스케일 뒤 회전(T*R*S)으로 찌그러지는 4·6·8각 원기둥/원뿔
export function shear(b) {
  const out = [];
  for (const r of meshesOf(b)) {
    const o = r.obj;
    if (!['CylinderGeometry', 'ConeGeometry'].includes(r.geom.type) || ![4, 6, 8].includes(r.geom.params.radialSegments) || r.geom.baked) continue;
    if (Math.abs(o.scale.x - o.scale.z) <= EPS) continue;
    const k = o.rotation.y / (Math.PI / 2);
    if (Math.abs(k - Math.round(k)) < 1e-9) continue;
    out.push(`${at(r)} scale x/z ${o.scale.x}/${o.scale.z} rotY ${o.rotation.y.toFixed(3)}`);
  }
  return out;
}

// 2. 다른 불투명 메시의 속에 통째로 묻힌 메시(보이지 않거나 면이 겹쳐 깜빡인다)
export function hidden(b) {
  const out = [];
  const solids = meshesOf(b).filter((r) => opaque(r) && r.geom.type !== 'PlaneGeometry');
  for (const a of solids) {
    const c = a.aabb.min.map((v, k) => (v + a.aabb.max[k]) / 2);
    const pts = [c, ...a.samples.map((p) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      return d > 1e-3 ? p.map((v, k) => v + ((c[k] - v) * 1e-3) / d) : p;
    })];
    for (const o of solids) {
      if (o === a || !a.aabb.min.every((v, k) => v >= o.aabb.min[k] - 1e-3 && a.aabb.max[k] <= o.aabb.max[k] + 1e-3)) continue;
      if (pts.every((p) => o.contains(p))) { out.push(`${at(a)} inside ${o.path}`); break; }
    }
  }
  return out;
}

// 3. 자리·문·엘리베이터·서 있는 물체가 바닥 위에 있는지
export function support(b, theme) {
  const out = [];
  const L = layoutOf(theme);
  for (const s of slotsOf(theme)) {
    const ring = [[0, 0], ...Array.from({ length: 8 }, (_, i) => [0.24 * Math.cos((i * Math.PI) / 4), 0.24 * Math.sin((i * Math.PI) / 4)])];
    if (ring.some(([dx, dz]) => !onGround(b, s.x + dx, s.z + dz))) out.push(`slot ${s.room}#${s.k} (${s.x}, ${s.z})`);
  }
  for (const [room, d] of Object.entries(L.doors)) if (!onGround(b, d.x, d.inner)) out.push(`door ${room} (${d.x}, ${d.inner})`);
  if (!onGround(b, L.elevator.x, L.elevator.z)) out.push(`spawn (${L.elevator.x}, ${L.elevator.z})`);
  for (const r of meshesOf(b)) {
    if (r.bottom < -0.05 || r.bottom > 0.12 || r.top <= 0.12 || r.inGlobe) continue;
    const foot = r.samples.filter((p) => p[1] <= r.bottom + 0.01);
    const off = foot.filter(([x, , z]) => !onGround(b, x, z));
    if (off.length) out.push(`${at(r)} off floor at (${f2(off[0][0])}, ${f2(off[0][2])})`);
  }
  return out;
}

// 4. 자리 밑 바닥 윗면 <= 0.06 (직원 발은 y = 0)
export function floorTop(b, theme) {
  const lows = meshesOf(b).filter((r) => r.bottom <= 0.2 && r.top <= 0.3);
  const out = [];
  for (const s of slotsOf(theme)) {
    let top = -Infinity, who = null;
    for (const r of lows) if (r.top > top && inPolygon([s.x, s.z], r.outline)) { top = r.top; who = r; }
    if (top > 0.06 + EPS) out.push(`slot ${s.room}#${s.k} stands on ${f2(top)} (${who.path})`);
  }
  return out;
}

// 5. 고리 보행 테마: 중앙 장식이 걷는 띠(|z| = zRing +- 0.375, x0..x1)에 들어오지 않는지
export function ringClear(b, theme) {
  const L = layoutOf(theme);
  if (L.walkway !== 'ring' || !L.obstacle) return [];
  const { x0, x1, zNorth, zSouth } = L.obstacle;
  const bands = [[zNorth - 0.375, zNorth + 0.375], [zSouth - 0.375, zSouth + 0.375]];
  const out = [];
  for (const r of meshesOf(b)) {
    if (r.top <= 0.08) continue;
    let hit = r.samples.some(([x, , z]) => x >= x0 && x <= x1 && bands.some(([lo, hi]) => z >= lo && z <= hi));
    for (const [lo, hi] of bands) {
      if (hit || r.aabb.max[0] < x0 || r.aabb.min[0] > x1 || r.aabb.max[2] < lo || r.aabb.min[2] > hi) continue;
      for (let x = Math.max(x0, r.aabb.min[0]); x <= Math.min(x1, r.aabb.max[0]) && !hit; x += 0.05) {
        for (let z = Math.max(lo, r.aabb.min[2]); z <= Math.min(hi, r.aabb.max[2]) && !hit; z += 0.05) hit = inPolygon([x, z], r.outline);
      }
    }
    if (hit) out.push(at(r));
  }
  return out;
}

// 6. 충돌 상자마다 눈에 보이는 물체(윗면 >= 0.3)가 받치고 있는지
export function coverage(b, theme) {
  const tall = meshesOf(b).filter((r) => r.top >= 0.3);
  const out = [];
  const covered = (x, z, o) => tall.some((r) => boxOverlap(r, o) && inPolygon([x, z], r.outline));
  for (const o of obstaclesOf(theme)) {
    let pts = [], need;
    if (/^part-/.test(o.tag)) {
      need = 0.6;
      for (let x = o.x0; x <= o.x1 + EPS; x += 0.05) pts.push([x, (o.z0 + o.z1) / 2]);
    } else if (/^div-/.test(o.tag)) {
      need = 0.85;
      for (let z = o.z0; z <= o.z1 + EPS; z += 0.05) pts.push([(o.x0 + o.x1) / 2, z]);
    } else if (o.tag === 'lounge-sofa') {
      need = 0.6;
      for (let x = o.x0; x <= o.x1 + EPS; x += 0.05) for (let z = o.z0; z <= o.z1 + EPS; z += 0.05) pts.push([x, z]);
    } else continue;
    pts = pts.filter(([x, z]) => onGround(b, x, z, 0));
    if (!pts.length) continue;
    const frac = pts.filter(([x, z]) => covered(x, z, o)).length / pts.length;
    if (frac < need - EPS) out.push(`${o.tag} ${(frac * 100).toFixed(0)}% covered (< ${need * 100}%)`);
  }
  return out;
}

// 7. 돌아가는 연구실 구체와 걷는 직원 머리(반지름 0.31, 높이 1.44) 사이 거리
export function globe(b, theme) {
  const c = b.globe.getWorldPosition(new THREE.Vector3());
  let R = 0;
  for (const r of meshesOf(b)) if (r.inGlobe) for (const p of r.samples) R = Math.max(R, Math.hypot(p[0] - c.x, p[1] - c.y, p[2] - c.z));
  const box = obstaclesOf(theme).find((o) => o.tag === 'research-globe');
  const dMin = Math.min(c.x - box.x0, box.x1 - c.x, c.z - box.z0, box.z1 - c.z) + 0.18;
  const have = Math.hypot(dMin, c.y - 1.44);
  return have + EPS >= R + 0.31 ? [] : [`globe R ${R.toFixed(3)} at y ${c.y.toFixed(2)}: head clearance ${have.toFixed(3)} < ${(R + 0.31).toFixed(3)}`];
}

// 8. 걷는 경로(엘리베이터->자리, 문->자리, 자리->다른 방 자리; lane -0.7/0/0.7)가 서 있는 물체와 0.24 이상 떨어지는지
const ROUTES = new Map();
function routeSamples(theme) {
  if (ROUTES.has(theme)) return ROUTES.get(theme);
  const L = layoutOf(theme);
  const obs = obstaclesOf(theme);
  const seen = new Set();
  const pts = [];
  const add = (start, room, x, z, lane) => {
    const path = [[start.x, start.z], ...route(start, room, x, z, lane, theme).map((p) => [p.x, p.z])];
    for (const [px, pz] of samplePolyline(path, 0.1)) {
      const key = `${Math.round(px * 20)},${Math.round(pz * 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!obs.some((o) => px > o.x0 && px < o.x1 && pz > o.z0 && pz < o.z1)) pts.push([px, pz]);
    }
  };
  const slots = slotsOf(theme);
  for (const lane of [-0.7, 0, 0.7]) {
    for (const s of slots) {
      add({ x: L.elevator.x, z: L.elevator.z }, s.room, s.x, s.z, lane);
      const d = L.doors[s.room];
      if (s.room !== 'lounge') add({ x: d.x, z: d.inner }, s.room, s.x, s.z, lane);
      for (const t of slots) if (t.room !== s.room) add({ x: s.x, z: s.z }, t.room, t.x, t.z, lane);
    }
  }
  ROUTES.set(theme, pts);
  return pts;
}
export function routeClear(b, theme) {
  const pts = routeSamples(theme);
  const out = [];
  for (const r of meshesOf(b)) {
    if (r.top < 0.5 || r.bottom > 0.3 || !opaque(r) || r.inGlobe) continue;
    // 엘리베이터 문짝·틀, 대문 기둥은 제외(출입 지점은 support·bounds 와 layout 검사가 본다)
    if (b.doors.includes(r.obj) || (r.aabb.max[0] <= -11.0 && r.top >= 2.0 && Math.abs(r.aabb.min[2]) <= 1.6 && Math.abs(r.aabb.max[2]) <= 1.6)) continue;
    let worst = null;
    for (const p of pts) {
      if (p[0] < r.aabb.min[0] - 0.24 || p[0] > r.aabb.max[0] + 0.24 || p[1] < r.aabb.min[2] - 0.24 || p[1] > r.aabb.max[2] + 0.24) continue;
      const d = inPolygon(p, r.outline) ? 0 : distToPolygon(p, r.outline);
      if (d < 0.24 - EPS && (!worst || d < worst.d)) worst = { d, p };
    }
    if (worst) out.push(`${at(r)} ${worst.d.toFixed(3)} from route at (${f2(worst.p[0])}, ${f2(worst.p[1])})`);
  }
  return out;
}

// 9. 화면·보드 평면 뒤 0.06 안에 불투명 상자가 있는지(뒤에서 보면 사라지지 않게)
export function screenBack(b) {
  const out = [];
  const boxes = meshesOf(b).filter((r) => r.geom.type === 'BoxGeometry' && opaque(r));
  for (const r of meshesOf(b)) {
    if (r.geom.type !== 'PlaneGeometry' || !(r.mat.screen || r.mat.board)) continue;
    const W = r.obj.matrixWorldOf();
    const o = new THREE.Vector3(0, 0, 0).applyMatrix4(W);
    const n = new THREE.Vector3(0, 0, 1).applyMatrix4(W).sub(o).normalize();
    let hit = 0, total = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const p = new THREE.Vector3(-0.45 + i * 0.225, -0.45 + j * 0.225, 0).applyMatrix4(W);
      total++;
      if ([0.02, 0.03, 0.04, 0.05, 0.06].some((d) => { const q = p.clone().addScaledVector(n, -d).toArray(); return boxes.some((x) => x.contains(q)); })) hit++;
    }
    if (hit / total < 0.9) out.push(`${at(r)} back covered ${hit}/${total}`);
  }
  return out;
}

// 10. 재질이 다른 두 평평한 윗면이 같은 높이(0.003 이내)에서 겹침 -> 깜빡임(z-fighting)
function clipArea(subject, clip) {
  let poly = subject;
  for (let i = 0; i < clip.length && poly.length; i++) {
    const [ax, az] = clip[i], [bx, bz] = clip[(i + 1) % clip.length];
    const side = ([x, z]) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
    const next = [];
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    poly = next;
  }
  return poly.length > 2 ? polygonArea(poly) : 0;
}
function overlapArea(a, b) {
  if (a.geom.type !== 'ExtrudeGeometry' && b.geom.type !== 'ExtrudeGeometry') return clipArea(a.outline, b.outline);
  let n = 0;
  const x0 = Math.max(a.aabb.min[0], b.aabb.min[0]), x1 = Math.min(a.aabb.max[0], b.aabb.max[0]);
  const z0 = Math.max(a.aabb.min[2], b.aabb.min[2]), z1 = Math.min(a.aabb.max[2], b.aabb.max[2]);
  for (let x = x0; x <= x1; x += 0.05) for (let z = z0; z <= z1; z += 0.05) if (inPolygon([x, z], a.outline) && inPolygon([x, z], b.outline)) n++;
  return n * 0.0025;
}
export function coplanar(b) {
  const up = (r) => { const W = r.obj.matrixWorldOf(); const o = new THREE.Vector3().applyMatrix4(W); const v = new THREE.Vector3(0, 1, 0).applyMatrix4(W).sub(o); return Math.abs(v.x) + Math.abs(v.z) < 1e-6 * v.length(); };
  const flats = meshesOf(b).filter((r) => r.flatTop && up(r)).sort((p, q) => p.top - q.top);
  const out = [];
  for (let i = 0; i < flats.length; i++) {
    for (let j = i + 1; j < flats.length && flats[j].top - flats[i].top <= 0.003; j++) {
      const a = flats[i], c = flats[j];
      if (a.mat.ref === c.mat.ref || !xzOverlap(a, c)) continue;
      const area = overlapArea(a, c);
      if (area > 0.0025) out.push(`${a.path} / ${c.path} tops ${a.top.toFixed(3)}/${c.top.toFixed(3)} overlap ${area.toFixed(3)} m2`);
    }
  }
  return out;
}

export const CHECKS = { shear, hidden, support, floorTop, ringClear, coverage, globe, routeClear, screenBack, coplanar };
