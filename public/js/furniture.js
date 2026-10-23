// 방마다 놓이는 가구. 전부 기본 도형(상자, 원기둥, 구)으로 만든 저폴리 디오라마.
import * as THREE from 'three';
import { ROOMS } from './rooms.js';
import { themed, glowing, box, BOX } from './scene.js';
import { mulberry32, seedOf } from './rng.js';

const E = Math.PI / 2;
const PLANE = new THREE.PlaneGeometry(1, 1);
const POT = new THREE.CylinderGeometry(0.22, 0.17, 0.4, 10);
const LEAF = new THREE.IcosahedronGeometry(0.42, 0);
const LEAF_S = new THREE.IcosahedronGeometry(0.3, 0);
// 테마를 다시 지을 때마다 새로 만들지 않도록 소품 기하는 모듈에서 한 번만 만든다(층·테마 수만큼 새면 GPU 메모리가 는다).
const RESEARCH_PED = new THREE.CylinderGeometry(0.2, 0.3, 0.95, 12);
const GLOBE_BALL = new THREE.IcosahedronGeometry(0.8, 2);
const GLOBE_WIRE = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.84, 1));
const MAST = new THREE.CylinderGeometry(0.04, 0.06, 1.8, 8);
// 접시 안테나: 구 껍질 조각을 -z 쪽에 두어(오목면이 +z) lookAt 한 방향으로 열리게 하고, 급전 막대는 z 축을 따른다
const DISH = new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3.2).rotateX(-Math.PI / 2);
const FEED = new THREE.CylinderGeometry(0.012, 0.012, 0.56, 6).rotateX(Math.PI / 2);
const MUG = new THREE.CylinderGeometry(0.07, 0.07, 0.16, 10);
const BOOTH_PED = new THREE.CylinderGeometry(0.4, 0.48, 0.86, 16);
const BOOTH_RING = new THREE.TorusGeometry(0.38, 0.026, 8, 24);
const BOOTH_CORE = new THREE.IcosahedronGeometry(0.26, 1);
const BOTTLE = new THREE.CylinderGeometry(0.17, 0.17, 0.5, 12);
export const SCREEN_TEX = [];

let M = null;

export function mats() {
  if (M) return M;
  M = {
    slab: themed('--slab'),
    floor: themed('--floor'),
    corridor: themed('--corridor'),
    wall: themed('--wall'),
    part: themed('--partition'),
    wood: themed('--wood'),
    metal: themed('--metal', { roughness: 0.45, metalness: 0.35 }),
    metalDS: themed('--metal', { roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide }), // 열린 껍질(접시)용 양면
    rack: themed('--rack', { roughness: 0.55 }),
    skin: themed('--skin'),
    user: themed('--user'),
    leaf: themed('--leaf', { flatShading: true }),
    sofa: themed('--sofa'),
    rug: Object.fromEntries(Object.entries(ROOMS).map(([k, r]) => [k, themed(r.token)])),
    dark: new THREE.MeshStandardMaterial({ color: 0x20262e, roughness: 0.6 }),
    ledOn: glowing(new THREE.MeshStandardMaterial({ color: 0x0b2614, emissive: 0x3cf07e }), 1.3),
    ledBusy: glowing(new THREE.MeshStandardMaterial({ color: 0x2a1a05, emissive: 0xffae2b }), 1.5),
    ledOff: new THREE.MeshStandardMaterial({ color: 0x161b21, roughness: 0.6 }),
    lamp: glowing(new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffb43c }), 1.2),
    globe: new THREE.MeshStandardMaterial({ color: 0x3e7fc2, roughness: 0.55, flatShading: true }),
    water: new THREE.MeshStandardMaterial({ color: 0x9fd4ff, roughness: 0.1, transparent: true, opacity: 0.75 }),
    books: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    wire: new THREE.LineBasicMaterial({ color: 0xdff1ff, transparent: true, opacity: 0.55 }),
  };
  M.screens = { code: screenMat('code'), web: screenMat('web'), term: screenMat('term'), doc: screenMat('web') };
  return M;
}

function screenMat(kind) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  const pal = {
    code: ['#7cc4ff', '#f5c76b', '#9be39b', '#e88bd3', '#c9d3dd'],
    web: ['#dfe8f2', '#7aa7e0', '#b9c6d4', '#f2b45a'],
    term: ['#5cf08a', '#3fbf6a', '#a9f5c2'],
  }[kind];
  const rng = mulberry32(seedOf(`screen:${kind}`));
  g.fillStyle = kind === 'web' ? '#1b2a3c' : '#0d141b';
  g.fillRect(0, 0, 256, 256);
  const step = kind === 'web' ? 18 : 12;
  for (let y = 10; y < 256; y += step) {
    let x = kind === 'code' ? 10 + ((rng() * 4) | 0) * 12 : 10;
    const n = 1 + ((rng() * 3) | 0);
    for (let i = 0; i < n && x < 236; i++) {
      const w = 14 + rng() * 70;
      g.fillStyle = pal[(rng() * pal.length) | 0];
      g.fillRect(x, y, Math.min(w, 246 - x), kind === 'web' ? 9 : 5);
      x += w + 8;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 0.6);
  SCREEN_TEX.push(t);
  return glowing(new THREE.MeshStandardMaterial({ color: 0x050709, emissive: 0xffffff, emissiveMap: t, roughness: 0.3 }), 1);
}

export function scrollScreens(dt) {
  for (const t of SCREEN_TEX) t.offset.y -= dt * 0.035;
}

function monitor(g, mat, x, y, z, rotY, w = 1.0, h = 0.62) {
  const grp = new THREE.Group();
  grp.position.set(x, y, z);
  grp.rotation.y = rotY;
  box(grp, M.dark, 0.08, 0.14, 0.08, 0, 0, -0.05);
  box(grp, M.dark, w + 0.08, h + 0.08, 0.05, 0, 0.12, -0.03);
  const s = new THREE.Mesh(PLANE, mat);
  s.scale.set(w, h, 1);
  s.position.set(0, 0.16 + h / 2, 0);
  grp.add(s);
  g.add(grp);
}

function desk(g, x, z, w, d, h = 0.72) {
  box(g, M.wood, w, 0.07, d, x, h, z);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(g, M.metal, 0.06, h, 0.06, x + sx * (w / 2 - 0.08), 0, z + sz * (d / 2 - 0.08), false);
  }
}

function plant(g, x, z, s = 1) {
  const pot = new THREE.Mesh(POT, M.wood);
  pot.scale.setScalar(s);
  pot.position.set(x, 0.2 * s, z);
  const a = new THREE.Mesh(LEAF, M.leaf);
  a.scale.setScalar(s);
  a.position.set(x, 0.75 * s, z);
  const b = new THREE.Mesh(LEAF_S, M.leaf);
  b.scale.setScalar(s);
  b.position.set(x + 0.14 * s, 1.08 * s, z - 0.05 * s);
  for (const m of [pot, a, b]) { m.castShadow = true; g.add(m); }
}

export function buildArchive(g) {
  const rng = mulberry32(seedOf('archive'));
  const books = [];
  const palette = [0xc0533f, 0x3f6fb0, 0xd9a441, 0x4f8f5b, 0x8a5aa8, 0x2f8f8a, 0xd8d2c4];
  for (const x of [-10.15, -8, -5.6]) { // 서쪽 서가는 북서 곡면 벽에서 비켜 둔다
    box(g, M.wood, 2.0, 2.1, 0.6, x, 0, -7.6);
    for (const y of [0.16, 0.66, 1.16, 1.62]) {
      let bx = x - 0.9;
      while (bx < x + 0.78) {
        const w = 0.1 + rng() * 0.12;
        const h = 0.3 + rng() * 0.12;
        books.push({ x: bx + w / 2, y: y + h / 2, z: -7.26, w: w - 0.015, h, c: palette[(rng() * palette.length) | 0] });
        bx += w;
      }
    }
  }
  const inst = new THREE.InstancedMesh(BOX, M.books, books.length);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  books.forEach((b, i) => {
    m4.makeScale(b.w, b.h, 0.14).setPosition(b.x, b.y, b.z);
    inst.setMatrixAt(i, m4);
    inst.setColorAt(i, col.set(b.c));
  });
  inst.receiveShadow = true;
  g.add(inst);
  desk(g, -8, -4.35, 2.4, 0.75, 0.7);
  box(g, M.metal, 0.8, 1.2, 0.7, -11.3, 0, -3.1);
  box(g, M.wall, 0.5, 0.04, 0.36, -8.5, 0.77, -4.35, false);
}

export function buildDev(g) {
  for (const x of [-2.6, 0, 2.6]) {
    desk(g, x, -6.75, 2.0, 0.9);
    monitor(g, M.screens.code, x, 0.79, -6.95, 0);
    box(g, M.dark, 0.7, 0.03, 0.22, x, 0.79, -6.45, false);
  }
  box(g, M.dark, 0.5, 0.95, 0.45, -3.35, 0, -2.75);
  plant(g, 3.35, -2.75, 0.9);
}

export function buildServer(g) {
  const leds = [];
  for (const x of [5.3, 7.1, 8.9, 10.7]) {
    box(g, M.rack, 1.4, 2.4, 1.0, x, 0, -7.3);
    for (let r = 0; r < 7; r++) {
      for (const dx of [-0.4, 0.38]) {
        leds.push(box(g, M.ledOn, 0.14, 0.05, 0.03, x + dx, 0.38 + r * 0.27, -6.785, false));
      }
      box(g, M.dark, 0.5, 0.012, 0.02, x, 0.36 + r * 0.27, -6.79, false);
    }
  }
  desk(g, 8, -3.9, 1.5, 0.65);
  monitor(g, M.screens.term, 8, 0.79, -4.05, 0);
  return leds;
}

export function buildResearch(g) {
  const ped = new THREE.Mesh(RESEARCH_PED, M.metal);
  ped.position.set(-8, 0.475, 5);
  ped.castShadow = true;
  g.add(ped);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.78, 5);
  const ball = new THREE.Mesh(GLOBE_BALL, M.globe);
  ball.castShadow = true;
  const wire = new THREE.LineSegments(
    GLOBE_WIRE,
    M.wire,
  );
  globe.add(ball, wire);
  globe.rotation.z = 0.35;
  g.add(globe);
  for (const z of [3.5, 6.5]) {
    desk(g, -11.2, z, 0.8, 1.6);
    monitor(g, M.screens.web, -11.4, 0.79, z, E);
  }
  // 위성 안테나: 접시 꼭짓점이 기둥 끝(mastTop)에 닿고 dir 방향으로 열린다. 급전 막대 끝에 깜빡이는 수신기.
  const mast = new THREE.Mesh(MAST, M.metal);
  mast.position.set(-4.9, 0.9, 7.1);
  const mastTop = new THREE.Vector3(-4.9, 1.8, 7.1);
  const dir = new THREE.Vector3(0.75, 0.9, -0.75).normalize();
  const dish = new THREE.Mesh(DISH, M.metalDS);
  dish.position.copy(mastTop).addScaledVector(dir, 0.42);
  dish.lookAt(dish.position.clone().add(dir));
  const feed = new THREE.Mesh(FEED, M.metal);
  feed.position.copy(mastTop).addScaledVector(dir, 0.33);
  feed.lookAt(feed.position.clone().add(dir));
  const tipAt = mastTop.clone().addScaledVector(dir, 0.6);
  const tip = box(g, M.lamp, 0.08, 0.08, 0.08, tipAt.x, tipAt.y - 0.04, tipAt.z, false);
  tip.userData.blink = true;
  g.add(mast, dish, feed);
  return globe;
}

export function buildMeeting(g, board) {
  const grp = new THREE.Group();
  grp.position.set(-3.55, 0, 5);
  grp.rotation.y = E;
  g.add(grp);
  box(grp, M.metal, 4.4, 2.2, 0.08, 0, 0.55, -0.06);
  const plane = new THREE.Mesh(PLANE, board.material);
  plane.scale.set(4.2, 2.0, 1);
  plane.position.set(0, 1.65, -0.01);
  grp.add(plane);
  box(grp, M.metal, 0.08, 0.6, 0.08, -1.9, 0, -0.06);
  box(grp, M.metal, 0.08, 0.6, 0.08, 1.9, 0, -0.06);
  box(grp, M.metal, 1.6, 0.05, 0.16, 0, 0.55, 0.05, false);
  desk(g, 0.8, 5, 1.4, 3.2);
  plant(g, 3.4, 7.4, 1.1);
}

export function buildDesk(g) {
  desk(g, 9.6, 5, 1.0, 2.6);
  monitor(g, M.screens.code, 9.35, 0.79, 4.35, E, 0.9, 0.56);
  monitor(g, M.screens.web, 9.35, 0.79, 5.65, E, 0.9, 0.56);
  // 중앙 승인 패드(허용/거절 버튼)와 마이크 스탠드
  box(g, M.dark, 0.36, 0.05, 0.48, 9.68, 0.79, 5.0, false);
  box(g, M.ledOn, 0.12, 0.03, 0.14, 9.68, 0.83, 4.88, false);
  box(g, M.ledBusy, 0.12, 0.03, 0.14, 9.68, 0.83, 5.12, false);
  box(g, M.metal, 0.04, 0.24, 0.04, 9.52, 0.79, 5.0, false);
  box(g, M.dark, 0.1, 0.07, 0.07, 9.48, 1.03, 5.0, false);
  const mug = new THREE.Mesh(MUG, M.rug.desk);
  mug.position.set(9.9, 0.87, 6.1);
  g.add(mug);
  // 리뷰·승인 홀로그램 인터콤 부스 (층마다 사람이 복제되지 않도록 원격 홀로그램 비콘으로 구성)
  for (const dz of [-1.55, 1.55]) box(g, M.part, 1.5, 1.55, 0.1, 10.45, 0, 5 + dz);
  const ped = new THREE.Mesh(BOOTH_PED, M.metal);
  ped.position.set(10.8, 0.43, 5);
  ped.castShadow = true;
  const ring = new THREE.Mesh(BOOTH_RING, M.ledOn);
  ring.position.set(10.8, 1.28, 5);
  ring.rotation.x = Math.PI / 2;
  const core = new THREE.Mesh(BOOTH_CORE, M.water);
  core.position.set(10.8, 1.28, 5);
  const beacon = box(g, M.lamp, 0.1, 0.1, 0.1, 10.8, 1.62, 5, false);
  beacon.userData.blink = true;
  g.add(ped, ring, core);
  plant(g, 5, 7.4, 1.3);
}

export function buildLoungeProps(g) {
  box(g, M.sofa, 2.0, 0.42, 0.55, 10.1, 0, 1.58);
  box(g, M.sofa, 2.0, 0.55, 0.16, 10.1, 0.42, 1.80);
  box(g, M.sofa, 0.16, 0.62, 0.55, 9.1, 0, 1.58);
  box(g, M.sofa, 0.16, 0.62, 0.55, 11.1, 0, 1.58);
  box(g, M.wall, 0.45, 1.0, 0.45, 11.4, 0, -1.55);
  const bottle = new THREE.Mesh(BOTTLE, M.water);
  bottle.position.set(11.4, 1.25, -1.55);
  g.add(bottle);
  plant(g, -10.4, 1.55, 0.9);
  plant(g, 11.55, 1.55, 0.85);
}
