// 테마 공용 도구: 테마 재질(themeMats), 기본 도형(cyl·roofEave·pineTree), 공용 구조물(칸막이·엘리베이터 문),
// 소품 헬퍼(lowTable·scrollScreen·boardFrame·populateShelves). theme-grounds*.js 와 theme-props*.js 가 함께 쓴다.
import * as THREE from 'three';
import { FLOOR_W, CORRIDOR } from './rooms.js';
import { box, BOX } from './scene.js';
import { mats } from './furniture.js';
import { mulberry32, seedOf } from './rng.js';
import { obstaclesOf } from './theme-layouts.js';

const E = Math.PI / 2;
const PLANE = new THREE.PlaneGeometry(1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 16);
// 네모뿔 지붕: 회전을 기하에 구워 둔다. 메시에서 비균일 스케일 뒤에 돌리면(T*R*S) 지붕이 마름모 칼날로 찌그러진다.
const ROOF4 = new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4);
const ICOSA = new THREE.IcosahedronGeometry(1, 0);
// 납작한 타원 받침(캣타워 등)용 48각 원기둥: 16각이면 넓은 타원의 모서리가 보인다
export const CYL48 = new THREE.CylinderGeometry(1, 1, 1, 48);
export const CYL32 = new THREE.CylinderGeometry(1, 1, 1, 32);
// 꼭짓점이 축 위에 있는 납작한 마름모 판(rx == rz 로만 쓴다: 비균일 스케일 뒤 회전은 찌그러진다)
export const DIAMOND4 = new THREE.CylinderGeometry(1, 1, 1, 4);
export const HALF_SPHERE = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);

let TM = null;
export function themeMats() {
  if (TM) return TM;
  TM = {
    granite: new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.75 }),
    graniteDark: new THREE.MeshStandardMaterial({ color: 0xbcb6a8, roughness: 0.8 }),
    vermilion: new THREE.MeshStandardMaterial({ color: 0xb82924, roughness: 0.5 }),
    dancheong: new THREE.MeshStandardMaterial({ color: 0x246b5b, roughness: 0.55 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.35, metalness: 0.65 }),
    tile: new THREE.MeshStandardMaterial({ color: 0x272d34, roughness: 0.65 }),
    hanokWood: new THREE.MeshStandardMaterial({ color: 0x8c5a32, roughness: 0.65 }),
    hanokDark: new THREE.MeshStandardMaterial({ color: 0x54361d, roughness: 0.7 }),
    courtyard: new THREE.MeshStandardMaterial({ color: 0xdccfba, roughness: 0.9 }),
    hanji: new THREE.MeshStandardMaterial({ color: 0xf4efe4, roughness: 0.6, transparent: true, opacity: 0.88 }),
    onggi: new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.35 }),
    blossom: new THREE.MeshStandardMaterial({ color: 0xf4afb8, roughness: 0.6, flatShading: true }),
    pine: new THREE.MeshStandardMaterial({ color: 0x2d5a3c, roughness: 0.7, flatShading: true }),
    hull: new THREE.MeshStandardMaterial({ color: 0x1e2636, roughness: 0.4, metalness: 0.55 }),
    hullDeck: new THREE.MeshStandardMaterial({ color: 0x283347, roughness: 0.48, metalness: 0.4 }),
    hullTrim: new THREE.MeshStandardMaterial({ color: 0x3b4d6b, roughness: 0.35, metalness: 0.6 }),
    forceField: new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.6, transparent: true, opacity: 0.28 }),
    plasmaCyan: new THREE.MeshStandardMaterial({ color: 0xa5f3fc, emissive: 0x06b6d4, emissiveIntensity: 1.5 }),
    plasmaViolet: new THREE.MeshStandardMaterial({ color: 0xe9d5ff, emissive: 0x9333ea, emissiveIntensity: 1.4 }),
    studioOak: new THREE.MeshStandardMaterial({ color: 0xc89d6c, roughness: 0.55 }),
    glassWall: new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.34 }),
    lawn: new THREE.MeshStandardMaterial({ color: 0x86c478, roughness: 0.85 }),
    lawnDark: new THREE.MeshStandardMaterial({ color: 0x5c9a50, roughness: 0.88 }),
    fenceWood: new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.65 }),
    agilityBlue: new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.4 }),
    agilityYellow: new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.4 }),
    velvetCream: new THREE.MeshStandardMaterial({ color: 0xf5ebe0, roughness: 0.72 }),
    roseGold: new THREE.MeshStandardMaterial({ color: 0xd69f7e, roughness: 0.35, metalness: 0.45 }),
    plushPink: new THREE.MeshStandardMaterial({ color: 0xf4acb7, roughness: 0.65 }),
    sisal: new THREE.MeshStandardMaterial({ color: 0xcba376, roughness: 0.88 }),
    scrollBack: new THREE.MeshStandardMaterial({ color: 0xe8dfca, roughness: 0.6 }),
  };
  return TM;
}

export function cyl(g, mat, rx, rz, h, x, y, z, geom = CYL, rotY = 0, shadow = true) {
  const m = new THREE.Mesh(geom, mat);
  m.scale.set(rx, h, rz);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rotY;
  m.castShadow = shadow;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

export function roofEave(g, mat, trimMat, w, h, d, x, y, z) {
  box(g, trimMat, w - 0.1, 0.16, d - 0.1, x, y, z);
  const roof = new THREE.Mesh(ROOF4, mat);
  roof.scale.set(w * 0.74, h, d * 0.74);
  roof.position.set(x, y + 0.16 + h / 2, z);
  roof.castShadow = true;
  g.add(roof);
}

export function pineTree(g, tm, x, z, s = 1) {
  cyl(g, tm.hanokDark, 0.12 * s, 0.16 * s, 0.9 * s, x, 0, z);
  for (const [dx, dy, dz, r] of [[0, 0.95, 0, 0.48], [0.22, 1.2, -0.1, 0.36], [-0.18, 1.32, 0.12, 0.32]]) {
    const f = new THREE.Mesh(ICOSA, tm.pine);
    f.scale.set(r * s * 1.3, r * s * 0.75, r * s * 1.2);
    f.position.set(x + dx * s, dy * s, z + dz * s);
    f.castShadow = true;
    g.add(f);
  }
}

export function buildStandardPartitions(g, wallMat, capMat) {
  for (const z of [-CORRIDOR, CORRIDOR]) {
    let x = -FLOOR_W / 2;
    for (const dx of [-8, 0, 8]) {
      const end = dx - 1;
      if (end > x) {
        box(g, wallMat, end - x, 0.9, 0.12, (x + end) / 2, 0, z);
        box(g, capMat, end - x, 0.06, 0.16, (x + end) / 2, 0.9, z);
      }
      x = dx + 1;
    }
    box(g, wallMat, FLOOR_W / 2 - x, 0.9, 0.12, (x + FLOOR_W / 2) / 2, 0, z);
    box(g, capMat, FLOOR_W / 2 - x, 0.06, 0.16, (x + FLOOR_W / 2) / 2, 0.9, z);
  }
  for (const x of [-4, 4]) {
    box(g, wallMat, 0.12, 0.9, 6, x, 0, -5);
    box(g, wallMat, 0.12, 0.9, 6, x, 0, 5);
  }
}

export function buildElevatorDoors(g, frameMat, doorMat, x, z) {
  box(g, frameMat, 0.35, 2.5, 2.2, x, 0, z);
  // 문짝 뒤 어두운 칸: 닫히면 가운데 틈으로만 보이고, 열리면 엘리베이터 안쪽으로 보인다
  box(g, mats().dark, 0.02, 2.06, 1.76, x + 0.19, 0, z, false);
  const dL = box(g, doorMat, 0.08, 2.1, 0.85, x + 0.18, 0, z - 0.46);
  const dR = box(g, doorMat, 0.08, 2.1, 0.85, x + 0.18, 0, z + 0.46);
  return [dL, dR];
}

export function lowTable(g, mat, legMat, x, z, w, d, h = 0.58) {
  box(g, mat, w, 0.08, d, x, h, z);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(g, legMat, 0.08, h, 0.08, x + sx * (w / 2 - 0.1), 0, z + sz * (d / 2 - 0.1), false);
  }
}

// 두루마리·홀로 화면: 아래 막대는 책상 윗면에 살짝 묻히고(caller y 기준 0..0.06), 화면 뒤에는 불투명 뒤판을 댄다.
// 뒤판이 없으면 반대쪽에서 볼 때 화면 평면이 사라진다(한쪽 면만 그린다). 뒤판에 frameMat(빛나는 재질)은 쓰지 않는다.
export function scrollScreen(g, frameMat, screenMat, x, y, z, rotY, w = 0.95, h = 0.58, backMat = mats().dark) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z);
  grp.rotation.y = rotY;
  box(grp, frameMat, w + 0.12, 0.06, 0.06, 0, 0, 0);
  box(grp, frameMat, w + 0.12, 0.06, 0.06, 0, h + 0.06, 0);
  const s = new THREE.Mesh(PLANE, screenMat);
  s.scale.set(w, h, 1);
  s.position.set(0, 0.03 + h / 2, 0.02);
  grp.add(s);
  box(grp, backMat, w + 0.04, h + 0.1, 0.02, 0, 0.01, -0.025);
  g.add(grp);
}

export function boardFrame(g, frameMat, trimMat, board, x = -3.55, z = 5) {
  const grp = new THREE.Group();
  grp.position.set(x, 0, z);
  grp.rotation.y = E;
  g.add(grp);
  box(grp, frameMat, 4.5, 2.3, 0.1, 0, 0.5, -0.06);
  box(grp, trimMat, 4.7, 0.14, 0.18, 0, 2.75, -0.06);
  const plane = new THREE.Mesh(PLANE, board.material);
  plane.scale.set(4.2, 2.0, 1);
  plane.position.set(0, 1.65, 0);
  grp.add(plane);
  box(grp, frameMat, 0.12, 0.55, 0.12, -1.9, 0, -0.06);
  box(grp, frameMat, 0.12, 0.55, 0.12, 1.9, 0, -0.06);
}

export function populateShelves(g, shelfMat, palette, xs, { z = -7.4, y0 = 0.08, rng = mulberry32(seedOf(`shelves:${xs.join()}:${z}`)) } = {}) {
  const items = [];
  for (const x of xs) {
    box(g, shelfMat, 2.0, 2.15, 0.58, x, y0, z);
    for (const y of [0.24, 0.72, 1.2, 1.68].map((v) => v + y0 - 0.08)) {
      let bx = x - 0.88;
      while (bx < x + 0.76) {
        const w = 0.11 + rng() * 0.12;
        const h = 0.28 + rng() * 0.12;
        items.push({ x: bx + w / 2, y: y + h / 2, z: z + 0.28, w: w - 0.015, h, c: palette[(rng() * palette.length) | 0] });
        bx += w;
      }
    }
  }
  const inst = new THREE.InstancedMesh(BOX, mats().books, items.length);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  items.forEach((b, i) => {
    m4.makeScale(b.w, b.h, 0.16).setPosition(b.x, b.y, b.z);
    inst.setMatrixAt(i, m4);
    inst.setColorAt(i, col.set(b.c));
  });
  inst.receiveShadow = true;
  g.add(inst);
}

// 복도 칸막이 충돌 상자(obstaclesOf 의 part-*)를 그대로 따라 난간을 그린다. 문틈은 충돌 상자가 이미 비워 둔다.
// style.clip(z) 밖(바닥 가장자리)은 자르고 0.3 보다 짧은 토막은 건너뛴다. 모든 조각은 상자(x0..x1, z +-0.12) 안에 둔다.
export function buildCorridorRails(g, theme, style) {
  for (const o of obstaclesOf(theme)) {
    if (!/^part-/.test(o.tag)) continue;
    const z = (o.z0 + o.z1) / 2;
    const lim = style.clip(z);
    const x0 = Math.max(o.x0, -lim);
    const x1 = Math.min(o.x1, lim);
    if (x1 - x0 < 0.3) continue;
    style.span(g, x0, x1, z, { doorW: o.x0 > -11.9, doorE: o.x1 < 11.9 });
  }
}

const span = (x0, x1) => ({ L: x1 - x0, cx: (x0 + x1) / 2 });
export const RAIL_STYLES = Object.freeze({
  // 한옥: 툇마루 난간(아래 띠 + 0.5 간격 살 + 위 띠, 높이 0.48)
  hanok: { clip: () => 12.0, span(g, x0, x1, z) {
    const tm = themeMats();
    const { L, cx } = span(x0, x1);
    box(g, tm.hanokDark, L, 0.05, 0.08, cx, 0.02, z);
    for (let x = x0 + 0.03; x <= x1 - 0.03 + 1e-9; x += 0.5) box(g, tm.hanokDark, 0.06, 0.4, 0.06, x, 0.02, z);
    box(g, tm.hanokDark, L, 0.06, 0.1, cx, 0.42, z);
  } },
  // 스타십: 턱 + 반투명 역장 띠 + 양끝 기둥
  starship: { clip: () => 11.2, span(g, x0, x1, z) {
    const tm = themeMats();
    const { L, cx } = span(x0, x1);
    box(g, tm.hullTrim, L, 0.14, 0.18, cx, 0, z);
    box(g, tm.forceField, L, 0.8, 0.05, cx, 0.14, z, false);
    for (const x of [x0 + 0.08, x1 - 0.08]) box(g, tm.hullTrim, 0.16, 1.1, 0.24, x, 0, z);
  } },
  // 퍼피 파크: 피켓 울타리(기둥 1.0 이하 간격 + 가로대 2줄, 높이 0.62)
  dogs: { clip: () => 10.7, span(g, x0, x1, z) {
    const tm = themeMats();
    const { L, cx } = span(x0, x1);
    const a = x0 + 0.05, b = x1 - 0.05;
    const n = Math.max(1, Math.ceil((b - a) / 1.0));
    for (let i = 0; i <= n; i++) box(g, tm.fenceWood, 0.1, 0.62, 0.1, a + ((b - a) * i) / n, 0, z);
    for (const y of [0.22, 0.46]) box(g, tm.fenceWood, L, 0.07, 0.06, cx, y, z);
  } },
  // 캣 살롱: 로즈골드 낮은 벽 + 분홍 쿠션 갓 + 문틈 쪽 사이잘 기둥
  cats: { clip: (z) => (z < 0 ? 11.15 : 11.45), span(g, x0, x1, z, { doorW, doorE }) {
    const tm = themeMats();
    const { L, cx } = span(x0, x1);
    box(g, tm.roseGold, L, 0.5, 0.1, cx, 0, z);
    box(g, tm.plushPink, L, 0.08, 0.16, cx, 0.5, z);
    if (doorW) cyl(g, tm.sisal, 0.09, 0.09, 0.75, x0 + 0.09, 0, z);
    if (doorE) cyl(g, tm.sisal, 0.09, 0.09, 0.75, x1 - 0.09, 0, z);
  } },
});
