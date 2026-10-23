// 'three' 를 기록용 구현(three-record.mjs)으로 바꿔 끼우고, 진짜 Floor.prototype.rebuildTheme 로 테마를 짓는다.
// 기록용 구현에 없는 THREE 이름(렌더러·카메라·조명 등)은 page-approval-office.test.mjs 처럼 아무거나 받는 Proxy 로 채운다.
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from './three-record.mjs';
import { convexHull } from './geom-utils.mjs';

export { THREE };
export const THEMES = Object.freeze(['studio', 'office', 'palace', 'hanok', 'starship', 'dogs', 'cats']);

const PAGE = fileURLToPath(new URL('../../public/js/', import.meta.url));
const names = new Set();
for (const f of readdirSync(PAGE).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(PAGE + f, 'utf8');
  for (const m of src.matchAll(/THREE\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
}
const extra = [...names].filter((n) => !(n in THREE));
const PROXY = `const H = { get(t, k) { if (k === Symbol.toPrimitive) return () => 0; if (k === Symbol.iterator) return function* () {};
  if (k === 'then') return undefined; if (!(k in t.s)) t.s[k] = mk(); return t.s[k]; },
  set(t, k, v) { t.s[k] = v; return true; }, apply() { return mk(); }, construct() { return mk(); } };
function mk() { const f = function () {}; f.s = {}; return new Proxy(f, H); }`;
const recUrl = new URL('./three-record.mjs', import.meta.url).href;
const addonsUrl = new URL('./three-addons-stub.mjs', import.meta.url).href;
// 기하·재질·텍스처는 Proxy 로 채우면 메시가 샘플 없이 모든 검사에서 조용히 빠진다 -> 쓰는 순간 실패하게 한다.
const unimplemented = (n) => `export class ${n} { constructor() { throw new Error('three-record: ${n} is not implemented'); } }`;
const proxied = extra.filter((n) => !/(Geometry|Material|Texture)$/.test(n));
const WRAP = [
  `export * from ${JSON.stringify(recUrl)};`,
  PROXY,
  proxied.length ? `export const ${proxied.map((n) => `${n} = mk()`).join(', ')};` : '',
  ...extra.filter((n) => !proxied.includes(n)).map(unimplemented),
].join('\n');
const WRAP_URL = `data:text/javascript,${encodeURIComponent(WRAP)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === 'three') return { url: ${JSON.stringify(WRAP_URL)}, shortCircuit: true };
  if (s.startsWith('three/')) return { url: ${JSON.stringify(addonsUrl)}, shortCircuit: true };
  return next(s, c);
}`)}`);

// 밝은 테마 CSS 토큰(office.html 첫 :root 블록)을 getComputedStyle 로 돌려준다 -> 재질 색이 브라우저와 같다.
const html = readFileSync(fileURLToPath(new URL('../../public/office.html', import.meta.url)), 'utf8');
const rootBlock = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
const TOKENS = Object.fromEntries([...rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 0 }) : () => {}),
  set: (t, k, v) => { t[k] = v; return true; },
});
globalThis.window ??= { matchMedia: () => ({ matches: false }), devicePixelRatio: 1, addEventListener() {} };
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }), documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: (n) => TOKENS[n] ?? '' });

const { Floor } = await import('../../public/js/floor.js');
export { Floor };

export const root = new THREE.Group();
export const mat = new THREE.MeshStandardMaterial();
const BOARD = { material: new THREE.MeshStandardMaterial({ emissive: 0xffffff }) };
BOARD.material.isBoard = true;

// rebuildTheme 가 쓰는 Floor 필드만 가진 가짜 층.
export function makeFloor() {
  return { archGroup: new THREE.Group(), board: BOARD, shadows: true, setShadows() {}, refreshSigns() {} };
}

const hex = (c) => `#${c.getHexString()}`;

// 메시 하나의 월드 기록. samples 는 월드 [x, y, z] 목록, outline 은 XZ 볼록 껍질(Extrude 는 원래 도형).
export function recordOf(o, globe = null) {
  const W = o.matrixWorldOf();
  const g = o.geometry;
  const inst = o.isInstancedMesh;
  const local = g?.samples;
  if (!Array.isArray(local) || !local.length) throw new Error(`three-record: ${o.src || '?'} ${g?.type} has no samples`);
  const m0 = o.material;
  if (!(m0?.isMeshStandardMaterial || m0?.isMeshBasicMaterial || m0?.isLineBasicMaterial)) throw new Error(`three-record: ${o.src || '?'} unknown material`);
  const samples = inst
    ? o.matrices.filter(Boolean).flatMap((m) => local.map((p) => new THREE.Vector3(...p).applyMatrix4(W.clone().multiply(m)).toArray()))
    : local.map((p) => new THREE.Vector3(...p).applyMatrix4(W).toArray());
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of samples) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  let outline;
  if (g.type === 'ExtrudeGeometry') {
    outline = g.polygon.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(g.bake).applyMatrix4(W)).map((v) => [v.x, v.z]);
  } else {
    outline = convexHull(samples.map(([x, , z]) => [x, z]));
  }
  let inGlobe = false;
  for (let p = o; p; p = p.parent) if (p === globe) inGlobe = true;
  const m = o.material || {};
  const p = g.parameters || {};
  const inv = W.clone().invert();
  return {
    obj: o,
    kind: inst ? 'InstancedMesh' : o.isLineSegments ? 'LineSegments' : 'Mesh',
    geom: { type: g.type, params: p, baked: g.baked, uuid: g.uuid },
    mat: {
      ref: m, color: m.color ? hex(m.color) : null, transparent: !!m.transparent, opacity: m.opacity ?? 1,
      emissive: m.emissive && m.emissive.getHex() ? hex(m.emissive) : null, side: m.side, depthWrite: m.depthWrite,
      polygonOffset: !!m.polygonOffset, board: !!m.isBoard, screen: !!m.emissiveMap,
    },
    castShadow: !!o.castShadow,
    samples,
    aabb: { min, max },
    top: max[1],
    bottom: min[1],
    outline,
    flatTop: g.type === 'BoxGeometry' || g.type === 'ExtrudeGeometry' || (g.type === 'CylinderGeometry' && p.radiusTop > 0),
    inGlobe,
    count: inst ? o.count : 1,
    path: `${o.src || '?'} ${g.type}${m.color ? ` ${hex(m.color)}` : ''}`,
    contains: (pt) => !inst && g.contains(new THREE.Vector3(...pt).applyMatrix4(inv).toArray()),
  };
}

// 진짜 Floor.prototype.rebuildTheme 로 짓고, 만든 기하·재질 수와 Math.random 호출 수를 센다.
export function buildTheme(theme, floor = makeFloor()) {
  const before = { ...THREE.stats };
  const orig = Math.random;
  let randomCalls = 0;
  Math.random = () => { randomCalls++; return orig(); };
  try {
    Floor.prototype.rebuildTheme.call(floor, theme);
  } finally {
    Math.random = orig;
  }
  const meshes = [];
  floor.archGroup.traverse((o) => { if (o.isMesh || o.isLineSegments) meshes.push(recordOf(o, floor.globe)); });
  return {
    floor,
    root: floor.archGroup,
    doors: floor.doors,
    leds: floor.leds,
    globe: floor.globe,
    meshes,
    stats: {
      geometries: THREE.stats.geometries - before.geometries,
      materials: THREE.stats.materials - before.materials,
      disposed: THREE.stats.disposed - before.disposed,
      randomCalls,
    },
  };
}
