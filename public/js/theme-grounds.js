// 테마별 건물 외형 분기(buildThemeGround)와 스튜디오·오피스·궁궐·한옥 외형(기단·슬래브·벽·기둥·처마·중정 조경·출입문).
// 스타십·강아지·고양이 외형은 theme-grounds-ext.js, 공용 도구는 theme-kit.js.
import * as THREE from 'three';
import { ROOMS, FLOOR_W, FLOOR_D, CORRIDOR } from './rooms.js';
import { box } from './scene.js';
import { mats } from './furniture.js';
import { themeMats, cyl, roofEave, pineTree, buildStandardPartitions, buildElevatorDoors, buildCorridorRails, RAIL_STYLES } from './theme-kit.js';
import { buildStarshipGround, buildDogsGround, buildCatsGround } from './theme-grounds-ext.js';
import { layoutOf } from './theme-layouts.js';

export { themeMats } from './theme-kit.js';

const ICOSA = new THREE.IcosahedronGeometry(1, 0);

export function buildThemeGround(g, theme) {
  if (theme === 'palace') return buildPalaceGround(g);
  if (theme === 'hanok') return buildHanokGround(g);
  if (theme === 'starship') return buildStarshipGround(g);
  if (theme === 'dogs') return buildDogsGround(g);
  if (theme === 'cats') return buildCatsGround(g);
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
    // 발코니 포드 윗면은 슬래브(0)와 다른 높이에 둔다 -> 같은 높이면 경계에서 줄무늬가 깜빡인다
    cyl(g, tm.studioOak, 2.6, 1.6, 0.45, x, -0.465, 7.6);
    cyl(g, M.floor, 2.3, 1.35, 0.045, x, -0.015, 7.6);
  }
  box(g, M.floor, FLOOR_W - 0.4, 0.02, FLOOR_D - 0.4, 0, 0, 0, false);
  box(g, M.corridor, FLOOR_W - 0.4, 0.03, CORRIDOR * 2, 0, 0, 0, false);
  for (const [k, r] of Object.entries(ROOMS)) {
    if (k === 'lounge') continue;
    const cz = r.side === 'top' ? -5 : 5;
    box(g, M.rug[k], r.x1 - r.x0 - 1.1, 0.03, 4.9, (r.x0 + r.x1) / 2, 0.01, cz, false);
  }
  // 북·서 벽은 둥근 모서리(중심 (-10.8, -6.8), 슬래브 반지름 1.5) 앞에서 끝나고, 사이를 곡면 벽(현 4조각)으로 잇는다.
  // 벽 끝은 모두 필렛 슬래브 위(반지름 1.466 < 내접 1.471)에 선다.
  box(g, M.wall, 22.0, 2.7, 0.22, 0.2, 0, -8.1);
  box(g, M.wall, 0.22, 2.7, 14.0, -12.1, 0, 0.2);
  for (let i = 0; i < 4; i++) {
    const phi = ((i + 0.5) * Math.PI) / 8;
    const m = box(g, M.wall, 0.567, 2.7, 0.22, -10.8 - 1.275 * Math.sin(phi), 0, -6.8 - 1.275 * Math.cos(phi));
    m.rotation.y = phi;
  }
  for (let x = -9.9; x <= 11.05; x += 1.1) box(g, tm.studioOak, 0.12, 2.5, 0.12, x, 0.02, -FLOOR_D / 2 + 0.04);
  buildStandardPartitions(g, tm.glassWall, tm.studioOak);
  return buildElevatorDoors(g, M.metal, M.dark, layoutOf('studio').elevator.frameX, 0);
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
  return buildElevatorDoors(g, M.wall, M.metal, layoutOf('office').elevator.frameX, 0);
}

// 3. 조선 궁궐: 2단 화강암 월대(T자 돌출형) + 주칠 기둥 열주 + 단청 처마 + 중앙 방지원도 연못 + 일주문
function buildPalaceGround(g) {
  const M = mats();
  const tm = themeMats();
  // 비직사각형 2단 화강암 월대(기단): 중앙 정전(집현전·빈청) 축이 남북으로 돌출
  box(g, tm.graniteDark, FLOOR_W + 1.4, 0.32, FLOOR_D + 0.8, 0, -0.58, 0);
  box(g, tm.granite, FLOOR_W + 0.4, 0.28, FLOOR_D - 0.2, 0, -0.26, 0);
  box(g, tm.graniteDark, 9.6, 0.32, 2.2, 0, -0.58, -8.8);
  box(g, tm.granite, 8.8, 0.28, 1.8, 0, -0.26, -8.6);
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
    // 마루는 얇게(윗면 0.03): 직원 발은 y = 0 이라 두꺼우면 발목까지 묻힌다
    box(g, tm.hanokWood, r.x1 - r.x0 - 0.6, 0.03, 5.4, (r.x0 + r.x1) / 2, 0, cz, false);
    box(g, M.rug[k], r.x1 - r.x0 - 1.6, 0.01, 4.2, (r.x0 + r.x1) / 2, 0.03, cz, false);
  }
  // 북쪽 전각 회랑 주칠 배흘림기둥 + 단청 창방 + 기와 처마(컷어웨이)
  for (const x of [-11.6, -8, -4.2, -1.8, 1.8, 4.2, 8, 11.6]) {
    cyl(g, tm.vermilion, 0.2, 0.23, 2.5, x, 0, -7.8);
  }
  for (const z of [-6.5, -3.5, 3.5, 6.5]) cyl(g, tm.vermilion, 0.19, 0.22, 2.3, -11.8, 0, z);
  // 처마는 열주 선(z -7.8) 위에만 걸쳐 북쪽 방을 가리지 않는다
  roofEave(g, tm.tile, tm.dancheong, 9.2, 0.95, 1.3, 0, 2.45, -8.15);
  roofEave(g, tm.tile, tm.dancheong, 8.2, 0.72, 1.0, -8, 2.3, -7.95);
  roofEave(g, tm.tile, tm.dancheong, 8.2, 0.72, 1.0, 8, 2.3, -7.95);
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
  const gx = layoutOf('palace').elevator.frameX;
  const dL = box(g, tm.vermilion, 0.1, 1.9, 0.85, gx, 0.08, -0.46);
  const dR = box(g, tm.vermilion, 0.1, 1.9, 0.85, gx, 0.08, 0.46);
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
    // 마루 윗면 0.03(안마당 0.02 바로 위): 직원 발이 묻히지 않는다
    box(g, tm.hanokWood, r.x1 - r.x0 - 0.4 + extraW, 0.14, 5.5, (r.x0 + r.x1) / 2 - extraW / 2, -0.11, cz, false);
    box(g, M.rug[k], r.x1 - r.x0 - 1.6, 0.02, 4.1, (r.x0 + r.x1) / 2, 0.03, cz, false);
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
    for (const s of [-1, 1]) {
      box(g, tm.hanji, 0.1, 1.22, 5.7, x, 0.02, s * 4.925);
      box(g, tm.hanokDark, 0.14, 0.08, 5.85, x, 1.22, s * 4.925);
    }
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
  // 안마당 둘레 툇마루 난간: 직원이 이미 멈춰 서는 복도 칸막이 충돌 상자를 눈에 보이게
  buildCorridorRails(g, 'hanok', RAIL_STYLES.hanok);
  // 서쪽 솟을대문
  for (const z of [-1.2, 1.2]) cyl(g, tm.hanokDark, 0.18, 0.2, 2.4, -11.7, 0, z);
  roofEave(g, tm.tile, tm.hanokDark, 1.5, 0.7, 3.2, -11.7, 2.35, 0);
  // 문짝은 기둥 서쪽(x -11.95)에 달아 직원이 나타나는 자리(-11.6)와 겹치지 않는다
  const gx = layoutOf('hanok').elevator.frameX;
  const dL = box(g, tm.hanokWood, 0.1, 1.85, 0.84, gx, 0.06, -0.46);
  const dR = box(g, tm.hanokWood, 0.1, 1.85, 0.84, gx, 0.06, 0.46);
  return [dL, dR];
}
