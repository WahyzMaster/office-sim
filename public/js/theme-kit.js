// 테마 공용 도구: 테마 재질(themeMats), 기본 도형(cyl·roofEave·pineTree), 공용 구조물(칸막이·엘리베이터 문),
// 소품 헬퍼(lowTable·scrollScreen·boardFrame·populateShelves). theme-grounds*.js 와 theme-props*.js 가 함께 쓴다.
import * as THREE from 'three';
import { FLOOR_W, CORRIDOR } from './rooms.js';
import { box, BOX } from './scene.js';
import { mats } from './furniture.js';
import { mulberry32, seedOf } from './rng.js';

const E = Math.PI / 2;
const PLANE = new THREE.PlaneGeometry(1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 16);
// 네모뿔 지붕: 회전을 기하에 구워 둔다. 메시에서 비균일 스케일 뒤에 돌리면(T*R*S) 지붕이 마름모 칼날로 찌그러진다.
const ROOF4 = new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4);
const ICOSA = new THREE.IcosahedronGeometry(1, 0);

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
  };
  return TM;
}

export function cyl(g, mat, rx, rz, h, x, y, z, geom = CYL, rotY = 0) {
  const m = new THREE.Mesh(geom, mat);
  m.scale.set(rx, h, rz);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rotY;
  m.castShadow = true;
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

export function scrollScreen(g, frameMat, screenMat, x, y, z, rotY, w = 0.95, h = 0.58) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z);
  grp.rotation.y = rotY;
  box(grp, frameMat, w + 0.12, 0.06, 0.06, 0, h + 0.12, 0);
  box(grp, frameMat, w + 0.12, 0.06, 0.06, 0, 0.06, 0);
  const s = new THREE.Mesh(PLANE, screenMat);
  s.scale.set(w, h, 1);
  s.position.set(0, 0.09 + h / 2, 0.02);
  grp.add(s);
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
