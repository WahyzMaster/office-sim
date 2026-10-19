// 방마다 놓이는 가구. 전부 기본 도형(상자, 원기둥, 구)으로 만든 저폴리 디오라마.
import * as THREE from 'three';
import { ROOMS } from './rooms.js';
import { themed, glowing, box, BOX } from './scene.js';

const E = Math.PI / 2;
const PLANE = new THREE.PlaneGeometry(1, 1);
const POT = new THREE.CylinderGeometry(0.22, 0.17, 0.4, 10);
const LEAF = new THREE.IcosahedronGeometry(0.42, 0);
const LEAF_S = new THREE.IcosahedronGeometry(0.3, 0);
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
  };
  M.screens = { code: screenMat('code'), web: screenMat('web'), term: screenMat('term') };
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
  g.fillStyle = kind === 'web' ? '#1b2a3c' : '#0d141b';
  g.fillRect(0, 0, 256, 256);
  const step = kind === 'web' ? 18 : 12;
  for (let y = 10; y < 256; y += step) {
    let x = kind === 'code' ? 10 + ((Math.random() * 4) | 0) * 12 : 10;
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n && x < 236; i++) {
      const w = 14 + Math.random() * 70;
      g.fillStyle = pal[(Math.random() * pal.length) | 0];
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
  const books = [];
  const palette = [0xc0533f, 0x3f6fb0, 0xd9a441, 0x4f8f5b, 0x8a5aa8, 0x2f8f8a, 0xd8d2c4];
  for (const x of [-10.4, -8, -5.6]) {
    box(g, M.wood, 2.0, 2.1, 0.6, x, 0, -7.6);
    for (const y of [0.16, 0.66, 1.16, 1.62]) {
      let bx = x - 0.9;
      while (bx < x + 0.78) {
        const w = 0.1 + Math.random() * 0.12;
        const h = 0.3 + Math.random() * 0.12;
        books.push({ x: bx + w / 2, y: y + h / 2, z: -7.26, w: w - 0.015, h, c: palette[(Math.random() * palette.length) | 0] });
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
  desk(g, -8, -3.9, 2.6, 1.0, 0.7);
  box(g, M.metal, 0.8, 1.2, 0.7, -11.3, 0, -3.1);
  box(g, M.wall, 0.5, 0.04, 0.36, -8.5, 0.77, -3.9, false);
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
  desk(g, 8, -3.7, 1.6, 0.7);
  monitor(g, M.screens.term, 8, 0.79, -3.85, 0);
  return leds;
}

export function buildResearch(g) {
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.95, 12), M.metal);
  ped.position.set(-8, 0.475, 5);
  ped.castShadow = true;
  g.add(ped);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.78, 5);
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 2), M.globe);
  ball.castShadow = true;
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.84, 1)),
    new THREE.LineBasicMaterial({ color: 0xdff1ff, transparent: true, opacity: 0.55 }),
  );
  globe.add(ball, wire);
  globe.rotation.z = 0.35;
  g.add(globe);
  for (const z of [3.5, 6.5]) {
    desk(g, -11.2, z, 0.8, 1.6);
    monitor(g, M.screens.web, -11.4, 0.79, z, E);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.8, 8), M.metal);
  mast.position.set(-4.7, 0.9, 7.3);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), M.metal);
  dish.position.set(-4.7, 1.85, 7.3);
  dish.rotation.set(-0.9, 0.6, 0);
  const tip = box(g, M.lamp, 0.08, 0.08, 0.08, -4.7, 1.9, 7.3, false);
  tip.userData.blink = true;
  g.add(mast, dish);
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
  monitor(g, M.screens.code, 9.35, 0.79, 4.4, E, 0.9, 0.56);
  monitor(g, M.screens.web, 9.35, 0.79, 5.6, E, 0.9, 0.56);
  box(g, M.wall, 0.5, 0.06, 0.38, 9.75, 0.79, 3.95, false);
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 10), M.rug.desk);
  mug.position.set(9.9, 0.87, 6.1);
  g.add(mug);
  // 내 의자와 나
  box(g, M.metal, 0.08, 0.42, 0.08, 10.85, 0, 5, false);
  box(g, M.dark, 0.62, 0.1, 0.62, 10.85, 0.42, 5);
  box(g, M.dark, 0.1, 0.85, 0.62, 11.2, 0.52, 5);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.38, 4, 12), M.user);
  torso.position.set(10.82, 1.0, 5);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), M.skin);
  head.position.set(10.8, 1.6, 5);
  const phones = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.04, 6, 20, Math.PI), M.dark);
  phones.position.set(10.8, 1.6, 5);
  for (const m of [torso, head, phones]) { m.castShadow = true; g.add(m); }
  for (const dz of [-0.28, 0.28]) {
    const arm = box(g, M.user, 0.5, 0.1, 0.1, 10.45, 0.92, 5 + dz);
    arm.rotation.z = 0.25;
  }
  plant(g, 5, 7.4, 1.3);
}

export function buildLounge(g) {
  box(g, M.sofa, 3.0, 0.42, 0.8, 8.8, 0, 1.4);
  box(g, M.sofa, 3.0, 0.55, 0.2, 8.8, 0.42, 1.75);
  box(g, M.sofa, 0.2, 0.62, 0.8, 7.3, 0, 1.4);
  box(g, M.sofa, 0.2, 0.62, 0.8, 10.3, 0, 1.4);
  box(g, M.wall, 0.45, 1.0, 0.45, 11.4, 0, -1.55);
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 12), M.water);
  bottle.position.set(11.4, 1.25, -1.55);
  g.add(bottle);
  plant(g, -10.4, 1.5, 1.0);
  plant(g, 11.5, 1.5, 1.2);
  box(g, M.dark, 0.14, 2.5, 2.5, -11.95, 0, 0);
  const doors = [
    box(g, M.metal, 0.06, 2.2, 0.92, -11.85, 0.02, -0.46, false),
    box(g, M.metal, 0.06, 2.2, 0.92, -11.85, 0.02, 0.46, false),
  ];
  box(g, M.lamp, 0.06, 0.12, 0.5, -11.85, 2.32, 0, false);
  return doors;
}
