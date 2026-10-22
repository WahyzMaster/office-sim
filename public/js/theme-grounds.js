// 5종 테마별 비직사각형 건물 외형(기단·슬래브·벽·기둥·처마·선체 윙·중정 조경·출입문).
import * as THREE from 'three';
import { ROOMS, FLOOR_W, FLOOR_D, CORRIDOR } from './rooms.js';
import { box } from './scene.js';
import { mats } from './furniture.js';

const CYL = new THREE.CylinderGeometry(1, 1, 1, 16);
const HEX = new THREE.CylinderGeometry(1, 1, 1, 6);
const OCT = new THREE.CylinderGeometry(1, 1, 1, 8);
const CONE4 = new THREE.ConeGeometry(1, 1, 4);
const TORUS = new THREE.TorusGeometry(1, 0.06, 8, 24);
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
  };
  return TM;
}

function cyl(g, mat, rx, rz, h, x, y, z, geom = CYL, rotY = 0) {
  const m = new THREE.Mesh(geom, mat);
  m.scale.set(rx, h, rz);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function roofEave(g, mat, trimMat, w, h, d, x, y, z) {
  box(g, trimMat, w - 0.1, 0.16, d - 0.1, x, y, z);
  const roof = new THREE.Mesh(CONE4, mat);
  roof.scale.set(w * 0.74, h, d * 0.74);
  roof.position.set(x, y + 0.16 + h / 2, z);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
}

function pineTree(g, tm, x, z, s = 1) {
  cyl(g, tm.hanokDark, 0.12 * s, 0.16 * s, 0.9 * s, x, 0, z);
  for (const [dx, dy, dz, r] of [[0, 0.95, 0, 0.48], [0.22, 1.2, -0.1, 0.36], [-0.18, 1.32, 0.12, 0.32]]) {
    const f = new THREE.Mesh(ICOSA, tm.pine);
    f.scale.set(r * s * 1.3, r * s * 0.75, r * s * 1.2);
    f.position.set(x + dx * s, dy * s, z + dz * s);
    f.castShadow = true;
    g.add(f);
  }
}

export function buildThemeGround(g, theme) {
  if (theme === 'palace') return buildPalaceGround(g);
  if (theme === 'hanok') return buildHanokGround(g);
  if (theme === 'starship') return buildStarshipGround(g);
  if (theme === 'office') return buildOfficeGround(g);
  return buildStudioGround(g);
}

// 1. AI 스튜디오: 모서리가 둥근 필렛 슬래브 + 반원형 발코니 포드 + 우드 루버 벽 + 원통 글래스 엘리베이터
function buildStudioGround(g) {
  const M = mats();
  const tm = themeMats();
  box(g, M.slab, FLOOR_W - 2.4, 0.5, FLOOR_D + 0.6, 0, -0.5, 0);
  box(g, M.slab, FLOOR_W + 0.6, 0.5, FLOOR_D - 2.4, 0, -0.5, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    cyl(g, M.slab, 1.5, 1.5, 0.5, sx * (FLOOR_W / 2 - 1.2), -0.5, sz * (FLOOR_D / 2 - 1.2));
  }
  for (const x of [-8, 8]) {
    cyl(g, tm.studioOak, 2.6, 1.6, 0.45, x, -0.45, 7.6);
    cyl(g, M.floor, 2.3, 1.35, 0.03, x, 0, 7.6);
  }
  box(g, M.floor, FLOOR_W - 0.4, 0.02, FLOOR_D - 0.4, 0, 0, 0, false);
  box(g, M.corridor, FLOOR_W - 0.4, 0.03, CORRIDOR * 2, 0, 0, 0, false);
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    box(g, M.rug[k], r.x1 - r.x0 - 1.1, 0.03, 4.9, (r.x0 + r.x1) / 2, 0.01, cz, false);
  }
  box(g, M.wall, FLOOR_W - 0.8, 2.7, 0.22, 0, 0, -FLOOR_D / 2 - 0.1);
  for (let x = -11; x <= 11; x += 1.1) box(g, tm.studioOak, 0.12, 2.5, 0.12, x, 0.1, -FLOOR_D / 2 + 0.04);
  box(g, M.wall, 0.22, 2.7, FLOOR_D - 0.8, -FLOOR_W / 2 - 0.1, 0, 0);
  buildStandardPartitions(g, tm.glassWall, tm.studioOak);
  return buildElevatorDoors(g, M.metal, M.dark, -11.82, 0);
}

// 2. 테크 오피스: 캔틸레버 스텝 데크 + 좌측 루프탑 가든 테라스 + 우측 하단 유리 부스 돌출
function buildOfficeGround(g) {
  const M = mats();
  const tm = themeMats();
  box(g, M.slab, FLOOR_W + 0.6, 0.5, FLOOR_D + 0.6, 0, -0.5, 0);
  box(g, tm.studioOak, 2.2, 0.4, 6.4, -12.8, -0.42, 0);
  box(g, M.slab, 7.2, 0.45, 1.4, 8, -0.45, 8.5);
  box(g, M.floor, FLOOR_W, 0.02, FLOOR_D, 0, 0, 0, false);
  box(g, M.corridor, FLOOR_W, 0.03, CORRIDOR * 2, 0, 0, 0, false);
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    box(g, M.rug[k], r.x1 - r.x0 - 1.0, 0.03, 5.0, (r.x0 + r.x1) / 2, 0.01, cz, false);
  }
  box(g, M.wall, FLOOR_W + 0.3, 2.8, 0.25, 0, 0, -FLOOR_D / 2 - 0.12);
  box(g, M.wall, 0.25, 2.8, FLOOR_D + 0.3, -FLOOR_W / 2 - 0.12, 0, 0);
  buildStandardPartitions(g, M.part, M.metal);
  return buildElevatorDoors(g, M.wall, M.metal, -11.82, 0);
}

function buildStandardPartitions(g, wallMat, capMat) {
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

// 3. 조선 궁궐: 2단 화강암 월대(T자 돌출형) + 주칠 기둥 열주 + 단청 처마 + 중앙 방지원도 연못 + 일주문
function buildPalaceGround(g) {
  const M = mats();
  const tm = themeMats();
  // 비직사각형 2단 화강암 월대(기단): 중앙 정전(집현전·빈청) 축이 남북으로 돌출
  box(g, tm.graniteDark, FLOOR_W + 1.4, 0.32, FLOOR_D + 0.8, 0, -0.58, 0);
  box(g, tm.granite, FLOOR_W + 0.4, 0.28, FLOOR_D - 0.2, 0, -0.26, 0);
  box(g, tm.graniteDark, 9.6, 0.32, 2.2, 0, -0.58, -8.8);
  box(g, tm.granite, 8.8, 0.32, 1.8, 0, -0.26, -8.6);
  box(g, tm.granite, 8.8, 0.26, 1.5, 0, -0.26, 8.5);
  // 월대 둘레 돌난간 동자주
  for (const x of [-11.8, -8, -4.2, 4.2, 8, 11.8]) {
    box(g, tm.granite, 0.24, 0.42, 0.24, x, 0, 7.85);
  }
  box(g, tm.granite, FLOOR_W, 0.02, FLOOR_D, 0, 0, 0, false);
  // 전각 마루 바닥
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5.1 : 5.1;
    box(g, tm.hanokWood, r.x1 - r.x0 - 0.6, 0.08, 5.4, (r.x0 + r.x1) / 2, 0, cz, false);
    box(g, M.rug[k], r.x1 - r.x0 - 1.6, 0.02, 4.2, (r.x0 + r.x1) / 2, 0.09, cz, false);
  }
  // 북쪽 전각 회랑 주칠 배흘림기둥 + 단청 창방 + 기와 처마(컷어웨이)
  for (const x of [-11.6, -8, -4.2, -1.8, 1.8, 4.2, 8, 11.6]) {
    cyl(g, tm.vermilion, 0.2, 0.23, 2.5, x, 0, -7.8);
  }
  for (const z of [-6.5, -3.5, 3.5, 6.5]) cyl(g, tm.vermilion, 0.19, 0.22, 2.3, -11.8, 0, z);
  roofEave(g, tm.tile, tm.dancheong, 9.2, 0.95, 2.4, 0, 2.45, -8.1);
  roofEave(g, tm.tile, tm.dancheong, 8.2, 0.72, 1.8, -8, 2.3, -7.8);
  roofEave(g, tm.tile, tm.dancheong, 8.2, 0.72, 1.8, 8, 2.3, -7.8);
  // 방 사이 전통 주칠·창호 칸막이
  for (const x of [-4, 4]) {
    box(g, tm.vermilion, 0.16, 1.15, 5.6, x, 0, -5);
    box(g, tm.vermilion, 0.16, 1.15, 5.6, x, 0, 5);
  }
  for (const z of [-CORRIDOR, CORRIDOR]) {
    for (const [x0, x1] of [[-11.8, -9.1], [-6.9, -1.1], [1.1, 6.9], [9.1, 11.8]]) {
      box(g, tm.hanokDark, x1 - x0, 0.65, 0.14, (x0 + x1) / 2, 0, z);
      box(g, tm.vermilion, x1 - x0, 0.08, 0.18, (x0 + x1) / 2, 0.65, z);
    }
  }
  // 중앙 후원 방지원도(네모난 연못 + 둥근 섬 + 소나무)
  box(g, tm.graniteDark, 5.6, 0.18, 2.1, 0, 0, 0);
  box(g, M.water, 5.1, 0.14, 1.65, 0, 0.04, 0, false);
  cyl(g, tm.granite, 0.65, 0.75, 0.24, 0, 0.02, 0);
  pineTree(g, tm, 0, 0, 0.85);
  // 서쪽 일주문/홍살문 출입구
  for (const z of [-1.25, 1.25]) cyl(g, tm.vermilion, 0.2, 0.22, 2.6, -11.85, 0, z);
  roofEave(g, tm.tile, tm.dancheong, 1.6, 0.75, 3.4, -11.85, 2.5, 0);
  const dL = box(g, tm.vermilion, 0.1, 1.9, 0.85, -11.85, 0.08, -0.46);
  const dR = box(g, tm.vermilion, 0.1, 1.9, 0.85, -11.85, 0.08, 0.46);
  return [dL, dR];
}

// 4. 전통 한옥: 안마당(중정) + ㅁ자 툇마루 + 남서쪽 돌출 누각(research) + 동쪽 장독대 + 솟을대문
function buildHanokGround(g) {
  const M = mats();
  const tm = themeMats();
  // 장대석 기단 + 남서쪽 돌출 누각 기단 + 동쪽 반원형 장독대 기단
  box(g, tm.granite, FLOOR_W + 0.2, 0.42, FLOOR_D + 0.2, 0, -0.42, 0);
  box(g, tm.graniteDark, 9.4, 0.48, 7.2, -8.4, -0.48, 5.4); // 남서쪽 누각 돌출부
  cyl(g, tm.granite, 2.2, 2.4, 0.42, 12.2, -0.42, 0); // 동쪽 장독대 반원 테라스
  box(g, tm.courtyard, FLOOR_W - 0.2, 0.02, FLOOR_D - 0.2, 0, 0, 0, false);
  // 방마다 원목 대청·온돌 마루
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5.1 : 5.1;
    const extraW = k === 'research' ? 1.0 : 0;
    box(g, tm.hanokWood, r.x1 - r.x0 - 0.4 + extraW, 0.14, 5.5, (r.x0 + r.x1) / 2 - extraW / 2, 0, cz, false);
    box(g, M.rug[k], r.x1 - r.x0 - 1.6, 0.02, 4.1, (r.x0 + r.x1) / 2, 0.15, cz, false);
  }
  // 북쪽 기와 돌담과 서까래 처마 + 남서쪽 누각 정자 기둥·처마
  box(g, tm.courtyard, FLOOR_W, 2.2, 0.24, 0, 0, -FLOOR_D / 2 - 0.1);
  roofEave(g, tm.tile, tm.hanokDark, FLOOR_W + 0.8, 0.65, 1.5, 0, 2.15, -FLOOR_D / 2 - 0.1);
  for (const [px, pz] of [[-12.6, 2.3], [-12.6, 8.3], [-4.4, 8.3]]) {
    cyl(g, tm.hanokDark, 0.18, 0.2, 2.35, px, 0, pz);
  }
  roofEave(g, tm.tile, tm.hanokDark, 3.2, 0.75, 6.6, -12.4, 2.3, 5.3);
  // 방 사이 한지 창호 격자 칸막이
  for (const x of [-4, 4]) {
    box(g, tm.hanji, 0.1, 1.1, 5.4, x, 0.14, -5);
    box(g, tm.hanokDark, 0.14, 0.08, 5.5, x, 1.22, -5);
    box(g, tm.hanji, 0.1, 1.1, 5.4, x, 0.14, 5);
    box(g, tm.hanokDark, 0.14, 0.08, 5.5, x, 1.22, 5);
  }
  // 안마당 중앙 화단(소나무·매화·석등)과 디딤돌 + 동쪽 장독대 항아리
  box(g, tm.graniteDark, 4.8, 0.16, 1.7, 0, 0, 0);
  pineTree(g, tm, -0.9, 0, 0.95);
  const plum = new THREE.Mesh(ICOSA, tm.blossom);
  plum.scale.set(0.55, 0.45, 0.55);
  plum.position.set(1.1, 0.85, 0.1);
  g.add(plum);
  cyl(g, tm.hanokDark, 0.08, 0.12, 0.7, 1.1, 0, 0.1);
  for (const x of [-9.5, -7.5, -5.5, 5.5, 7.5, 9.5]) box(g, tm.granite, 0.65, 0.04, 0.42, x, 0.01, 0, false);
  for (const [jx, jz, jr] of [[11.9, -0.6, 0.24], [12.4, 0, 0.28], [11.9, 0.6, 0.22]]) {
    cyl(g, tm.onggi, jr, jr * 0.75, 0.46, jx, 0.02, jz);
  }
  // 서쪽 솟을대문
  for (const z of [-1.2, 1.2]) cyl(g, tm.hanokDark, 0.18, 0.2, 2.4, -11.7, 0, z);
  roofEave(g, tm.tile, tm.hanokDark, 1.5, 0.7, 3.2, -11.7, 2.35, 0);
  const dL = box(g, tm.hanokWood, 0.1, 1.85, 0.84, -11.7, 0.06, -0.46);
  const dR = box(g, tm.hanokWood, 0.1, 1.85, 0.84, -11.7, 0.06, 0.46);
  return [dL, dR];
}

// 5. SF 스타십: 팔각형 브리지 데크 + 좌우 육각 윙 포드 + 후방 플라즈마 추진기 + 중앙 홀로그램 워프 링
function buildStarshipGround(g) {
  const M = mats();
  const tm = themeMats();
  // 비직사각형 우주선 선체: 중앙 팔각 브리지 + 좌우 4개 육각 윙 포드
  cyl(g, tm.hull, 11.2, 8.6, 0.52, 0, -0.52, 0, OCT, Math.PI / 8);
  for (const [wx, wz] of [[-8.2, -4.8], [8.2, -4.8], [-8.2, 4.8], [8.2, 4.8]]) {
    cyl(g, tm.hull, 4.9, 4.4, 0.48, wx, -0.5, wz, HEX);
    cyl(g, tm.hullDeck, 4.6, 4.1, 0.04, wx, 0, wz, HEX);
  }
  cyl(g, tm.hullDeck, 10.7, 8.2, 0.03, 0, 0, 0, OCT, Math.PI / 8);
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    box(g, M.rug[k], r.x1 - r.x0 - 1.6, 0.03, 4.4, (r.x0 + r.x1) / 2, 0.02, cz, false);
  }
  // 후방 플라즈마 추진기 노즐 3기 (북쪽 외벽 바깥으로 돌출)
  for (const tx of [-5.5, 0, 5.5]) {
    const nozzle = new THREE.Mesh(CYL, tm.hullTrim);
    nozzle.scale.set(0.65, 0.9, 0.65);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(tx, -0.1, -8.55);
    const glow = new THREE.Mesh(CYL, tm.plasmaCyan);
    glow.scale.set(0.48, 0.2, 0.48);
    glow.rotation.x = Math.PI / 2;
    glow.position.set(tx, -0.1, -9.0);
    g.add(nozzle, glow);
  }
  // 에너지 실드 격벽 칸막이
  for (const x of [-4, 4]) {
    box(g, tm.hullTrim, 0.18, 1.25, 0.24, x, 0, -2.2);
    box(g, tm.hullTrim, 0.18, 1.25, 0.24, x, 0, 2.2);
    box(g, tm.forceField, 0.06, 1.05, 5.2, x, 0.05, -5, false);
    box(g, tm.forceField, 0.06, 1.05, 5.2, x, 0.05, 5, false);
  }
  // 브리지 중앙 홀로그램 워프 코어 링 (x: 0, z: 0)
  cyl(g, tm.hull, 2.2, 2.2, 0.14, 0, 0, 0);
  const ring1 = new THREE.Mesh(TORUS, tm.plasmaCyan);
  ring1.scale.setScalar(1.65);
  ring1.rotation.x = Math.PI / 2;
  ring1.position.set(0, 0.18, 0);
  const ring2 = new THREE.Mesh(TORUS, tm.plasmaViolet);
  ring2.scale.setScalar(1.1);
  ring2.rotation.x = Math.PI / 2;
  ring2.position.set(0, 0.32, 0);
  const core = new THREE.Mesh(ICOSA, tm.plasmaCyan);
  core.scale.setScalar(0.38);
  core.position.set(0, 0.65, 0);
  g.add(ring1, ring2, core);
  // 좌측 블라스트 에어락/터보리프트 포털
  return buildElevatorDoors(g, tm.hullTrim, tm.plasmaCyan, -11.82, 0);
}

function buildElevatorDoors(g, frameMat, doorMat, x, z) {
  box(g, frameMat, 0.35, 2.5, 2.2, x, 0, z);
  const dL = box(g, doorMat, 0.08, 2.1, 0.85, x + 0.18, 0, z - 0.46);
  const dR = box(g, doorMat, 0.08, 2.1, 0.85, x + 0.18, 0, z + 0.46);
  return [dL, dR];
}
