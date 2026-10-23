// 스타십·퍼피 파크·캣 살롱 건물 외형: 비직사각형 선체·잔디·고양이 얼굴 바닥, 중앙 장식, 출입문.
import * as THREE from 'three';
import { ROOMS, FLOOR_W, FLOOR_D } from './rooms.js';
import { box } from './scene.js';
import { mats } from './furniture.js';
import { themeMats, cyl, pineTree, buildElevatorDoors } from './theme-kit.js';
import { layoutOf } from './theme-layouts.js';

const CYL = new THREE.CylinderGeometry(1, 1, 1, 16);
const HEX = new THREE.CylinderGeometry(1, 1, 1, 6);
const OCT = new THREE.CylinderGeometry(1, 1, 1, 8);
const CONE4 = new THREE.ConeGeometry(1, 1, 4);
const TORUS = new THREE.TorusGeometry(1, 0.06, 8, 24);
const ICOSA = new THREE.IcosahedronGeometry(1, 0);

// 5. SF 스타십: 팔각형 브리지 데크 + 좌우 육각 윙 포드 + 후방 플라즈마 추진기 + 중앙 홀로그램 워프 링
export function buildStarshipGround(g) {
  const M = mats();
  const tm = themeMats();
  // 비직사각형 우주선 선체: 중앙 팔각 브리지 + 좌우 4개 육각 윙 포드
  cyl(g, tm.hull, 11.2, 8.6, 0.52, 0, -0.52, 0, OCT, Math.PI / 8);
  for (const [wx, wz] of [[-8.2, -4.8], [8.2, -4.8], [-8.2, 4.8], [8.2, 4.8]]) {
    cyl(g, tm.hull, 4.9, 4.4, 0.48, wx, -0.5, wz, HEX);
    cyl(g, tm.hullDeck, 4.6, 4.1, 0.04, wx, 0, wz, HEX);
  }
  cyl(g, tm.hullDeck, 10.7, 8.2, 0.03, 0, 0, 0, OCT, Math.PI / 8);
  // 동·서 갱웨이: 팔각 선체의 평평한 옆면(x +-10.35) 밖에 있는 엘리베이터·출입 지점·라운지 벤치를 받친다
  for (const sx of [-1, 1]) {
    box(g, tm.hull, 3.04, 0.48, 5.2, sx * 10.92, -0.5, 0);
    box(g, tm.hullDeck, 2.7, 0.04, 4.8, sx * 10.85, 0, 0);
  }
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
  return buildElevatorDoors(g, tm.hullTrim, tm.plasmaCyan, layoutOf('starship').elevator.frameX, 0);
}

// 6. 퍼피 파크(dogs): 대형 뼈다귀 모양 잔디 공원 + 나무 피켓 펜스 + 중앙 강아지 발바닥 분수대·어질리티 후프
export function buildDogsGround(g) {
  const M = mats();
  const tm = themeMats();
  // 비직사각형 뼈다귀(Bone) 실루엣 잔디 파크: 중앙 잔디판 + 네 모서리 원형 마디 광장
  box(g, tm.lawnDark, FLOOR_W - 2.4, 0.44, FLOOR_D - 1.2, 0, -0.44, 0);
  box(g, tm.lawn, FLOOR_W - 2.6, 0.04, FLOOR_D - 1.4, 0, 0, 0, false);
  for (const [bx, bz] of [[-10.2, -5.8], [10.2, -5.8], [-10.2, 5.8], [10.2, 5.8]]) {
    cyl(g, tm.lawnDark, 3.6, 3.3, 0.44, bx, -0.44, bz);
    cyl(g, tm.lawn, 3.45, 3.15, 0.04, bx, 0, bz);
  }
  // 서쪽 출입 잔디판: 뼈다귀 가운데 판(x -10.8) 밖으로 나간 엘리베이터 틀·문짝을 받친다
  box(g, tm.lawnDark, 1.15, 0.44, 3.0, -11.075, -0.44, 0);
  box(g, tm.lawn, 1.0, 0.035, 2.8, -11.1, 0, 0, false);
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    cyl(g, M.rug[k], 3.1, 2.3, 0.03, (r.x0 + r.x1) / 2, 0.02, cz);
  }
  // 나무 피켓 펜스 울타리
  for (let x = -10.5; x <= 10.5; x += 1.5) {
    box(g, tm.fenceWood, 0.16, 0.95, 0.08, x, 0, -7.4);
  }
  box(g, tm.fenceWood, 21.5, 0.1, 0.08, 0, 0.65, -7.4);
  box(g, tm.fenceWood, 21.5, 0.1, 0.08, 0, 0.32, -7.4);
  for (const x of [-4, 4]) {
    box(g, tm.fenceWood, 0.14, 0.72, 4.4, x, 0, -5);
    box(g, tm.fenceWood, 0.14, 0.72, 4.4, x, 0, 5);
  }
  // 중앙 강아지 발바닥 분수대 + 어질리티 점프 링 (x: 0, z: 0)
  cyl(g, tm.granite, 2.3, 2.1, 0.18, 0, 0, 0);
  cyl(g, M.leaf, 2.0, 1.8, 0.05, 0, 0.15, 0);
  cyl(g, tm.fenceWood, 0.68, 0.55, 0.14, 0, 0.16, 0.25);
  for (const [px, pz] of [[-0.68, -0.35], [-0.24, -0.62], [0.24, -0.62], [0.68, -0.35]]) {
    cyl(g, tm.fenceWood, 0.26, 0.26, 0.14, px, 0.16, pz);
  }
  const hoop = new THREE.Mesh(TORUS, tm.agilityYellow);
  hoop.scale.setScalar(0.58);
  hoop.position.set(0, 0.85, 0.25);
  g.add(hoop);
  pineTree(g, tm, -11.2, -6.2, 0.95);
  pineTree(g, tm, 11.2, -6.2, 0.95);
  return buildElevatorDoors(g, tm.fenceWood, tm.agilityBlue, layoutOf('dogs').elevator.frameX, 0);
}

// 7. 캣 타워 살롱(cats): 고양이 얼굴·귀 실루엣 벨벳 라운지 + 좌우 삼각 고양이 귀 썬룸 + 중앙 3단 캣타워
export function buildCatsGround(g) {
  const M = mats();
  const tm = themeMats();
  // 고양이 얼굴 모양 플로어: 둥근 볼 + 좌·우 북쪽 삼각 고양이 귀 썬룸 돌출부
  cyl(g, tm.roseGold, 12.2, 8.2, 0.44, 0, -0.44, 0.4);
  cyl(g, tm.velvetCream, 11.9, 7.9, 0.04, 0, 0, 0.4);
  for (const sx of [-1, 1]) {
    cyl(g, tm.roseGold, 4.4, 4.4, 0.44, sx * 8.0, -0.44, -5.6, CONE4, sx * 0.12);
    cyl(g, tm.velvetCream, 4.1, 4.1, 0.04, sx * 8.0, 0, -5.6, CONE4, sx * 0.12);
    cyl(g, tm.plushPink, 2.5, 2.5, 0.03, sx * 8.0, 0.02, -5.9, CONE4, sx * 0.12);
  }
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    cyl(g, M.rug[k], 3.0, 2.2, 0.03, (r.x0 + r.x1) / 2, 0.02, cz);
  }
  // 로즈골드 아치 파티션
  for (const x of [-4, 4]) {
    cyl(g, tm.sisal, 0.16, 0.16, 1.35, x, 0, -3.2);
    cyl(g, tm.sisal, 0.16, 0.16, 1.35, x, 0, 3.2);
    box(g, tm.roseGold, 0.1, 0.85, 4.2, x, 0, -5);
    box(g, tm.roseGold, 0.1, 0.85, 4.2, x, 0, 5);
  }
  // 중앙 3단 럭셔리 캣타워 & 황금 실타래 (x: 0, z: 0)
  cyl(g, tm.roseGold, 2.1, 2.1, 0.12, 0, 0, 0);
  for (const [px, pz, h] of [[-0.85, -0.45, 0.9], [0.85, -0.45, 1.35], [0, 0.55, 1.8]]) {
    cyl(g, tm.sisal, 0.16, 0.16, h, px, 0.12, pz);
    cyl(g, tm.plushPink, 0.78, 0.78, 0.1, px, 0.12 + h, pz);
  }
  const yarn = new THREE.Mesh(ICOSA, tm.gold);
  yarn.scale.setScalar(0.32);
  yarn.position.set(0, 2.28, 0.55);
  g.add(yarn);
  return buildElevatorDoors(g, tm.roseGold, tm.plushPink, layoutOf('cats').elevator.frameX, 0);
}
