// 궁궐(palace), 한옥(hanok), 스타십(starship) 테마 전용 3D 가구·소품 빌더.
// 모든 테마 빌더는 { leds, globe } 를 반환하고 회의실 화이트보드(board.material)를 연결해 Floor.update 와 호환된다.
import * as THREE from 'three';
import { box, BOX } from './scene.js';
import { mats } from './furniture.js';
import { themeMats } from './theme-grounds.js';

const E = Math.PI / 2;
const PLANE = new THREE.PlaneGeometry(1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 14);
const TORUS = new THREE.TorusGeometry(1, 0.06, 8, 24);
const ICOSA = new THREE.IcosahedronGeometry(1, 1);

function lowTable(g, mat, legMat, x, z, w, d, h = 0.58) {
  box(g, mat, w, 0.08, d, x, h, z);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(g, legMat, 0.08, h, 0.08, x + sx * (w / 2 - 0.1), 0, z + sz * (d / 2 - 0.1), false);
  }
}

function scrollScreen(g, frameMat, screenMat, x, y, z, rotY, w = 0.95, h = 0.58) {
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

function boardFrame(g, frameMat, trimMat, board, x = -3.55, z = 5) {
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

function populateShelves(g, shelfMat, palette, xs, z = -7.4) {
  const items = [];
  for (const x of xs) {
    box(g, shelfMat, 2.0, 2.15, 0.58, x, 0.08, z);
    for (const y of [0.24, 0.72, 1.2, 1.68]) {
      let bx = x - 0.88;
      while (bx < x + 0.76) {
        const w = 0.11 + Math.random() * 0.12;
        const h = 0.28 + Math.random() * 0.12;
        items.push({ x: bx + w / 2, y: y + h / 2, z: z + 0.28, w: w - 0.015, h, c: palette[(Math.random() * palette.length) | 0] });
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

// ---- 3. 조선 궁궐 (palace) ----
export function buildPalaceProps(g, board) {
  const M = mats();
  const tm = themeMats();
  // 규장각 (archive): 주칠 어서각 서가 + 어람 서안
  populateShelves(g, tm.vermilion, [0xd9a441, 0xc0533f, 0x246b5b, 0xe8dfca, 0x3f6fb0], [-10.4, -8, -5.6]);
  lowTable(g, tm.vermilion, tm.hanokDark, -8, -3.9, 2.6, 1.0, 0.65);
  box(g, tm.gold, 0.45, 0.06, 0.32, -8, 0.73, -3.9, false);

  // 집현전 (dev): 학사 서안 3조 + 한지 두루마리 화면
  for (const x of [-2.5, 0, 2.5]) {
    lowTable(g, tm.hanokDark, tm.vermilion, x, -6.6, 2.0, 0.9, 0.68);
    scrollScreen(g, tm.gold, M.screens.code, x, 0.74, -6.85, 0);
  }

  // 군기시 (server): 병기·화포 가대 + 봉수대 화로 불꽃(leds)
  const leds = [];
  for (const x of [5.5, 7.2, 8.8, 10.5]) {
    box(g, tm.hanokDark, 1.3, 1.9, 0.8, x, 0.08, -7.2);
    box(g, tm.gold, 1.36, 0.08, 0.86, x, 1.98, -7.2);
    // 화로 기단과 불꽃(LED 역할)
    const brazier = new THREE.Mesh(CYL, tm.graniteDark);
    brazier.scale.set(0.32, 0.45, 0.32);
    brazier.position.set(x, 0.3, -6.35);
    g.add(brazier);
    for (const dx of [-0.12, 0.12]) {
      leds.push(box(g, M.ledBusy, 0.16, 0.22, 0.16, x + dx, 0.54, -6.35, false));
    }
  }
  lowTable(g, tm.vermilion, tm.hanokDark, 8, -3.7, 1.6, 0.75, 0.68);
  scrollScreen(g, tm.gold, M.screens.term, 8, 0.74, -3.85, 0, 0.85, 0.52);

  // 관상감 (research): 화강암 기단 위 회전하는 황금 혼천의(globe) + 관측 서안
  box(g, tm.granite, 1.1, 0.75, 1.1, -8, 0.08, 5);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.65, 5);
  for (const [rx, ry, s] of [[0, 0, 0.85], [1.1, 0.4, 0.72], [0.5, 1.2, 0.58]]) {
    const r = new THREE.Mesh(TORUS, tm.gold);
    r.scale.setScalar(s);
    r.rotation.set(rx, ry, 0);
    globe.add(r);
  }
  const core = new THREE.Mesh(ICOSA, tm.dancheong);
  core.scale.setScalar(0.28);
  globe.add(core);
  g.add(globe);
  for (const z of [3.7, 6.3]) {
    lowTable(g, tm.hanokDark, tm.vermilion, -11.1, z, 0.85, 1.5, 0.68);
    scrollScreen(g, tm.gold, M.screens.web, -11.3, 0.74, z, E);
  }

  // 빈청 (meeting): 어전 병풍 보드 + 대신 회의 탁자
  boardFrame(g, tm.vermilion, tm.gold, board);
  lowTable(g, tm.vermilion, tm.hanokDark, 0.8, 5, 1.4, 3.1, 0.68);

  // 승정원 (desk): 왕명 출납 단상 + 황금 옥새(어보) + 청사초롱 비콘
  lowTable(g, tm.vermilion, tm.gold, 9.5, 5, 1.0, 2.5, 0.72);
  scrollScreen(g, tm.gold, M.screens.code, 9.3, 0.78, 4.35, E, 0.86, 0.52);
  scrollScreen(g, tm.gold, M.screens.web, 9.3, 0.78, 5.65, E, 0.86, 0.52);
  // 황금 옥새 단상과 청사초롱 등불
  box(g, tm.vermilion, 0.85, 0.92, 0.85, 10.8, 0.08, 5);
  box(g, tm.gold, 0.42, 0.28, 0.42, 10.8, 1.0, 5);
  const sealTop = box(g, M.lamp, 0.18, 0.18, 0.18, 10.8, 1.28, 5, false);
  sealTop.userData.blink = true;
  for (const [dz, mat] of [[-1.35, tm.vermilion], [1.35, tm.dancheong]]) {
    box(g, tm.hanokDark, 0.08, 1.65, 0.08, 10.6, 0.08, 5 + dz);
    box(g, mat, 0.32, 0.48, 0.32, 10.6, 1.25, 5 + dz);
  }
  // 후원 평상
  lowTable(g, tm.hanokWood, tm.hanokDark, 8.8, 1.45, 2.8, 0.85, 0.42);
  return { leds, globe };
}

// ---- 4. 전통 한옥 (hanok) ----
export function buildHanokProps(g, board) {
  const M = mats();
  const tm = themeMats();
  // 장판각 (archive): 팔만대장경 스타일 원목 경판 서가 + 독서상
  populateShelves(g, tm.hanokDark, [0x8c5a32, 0xd8ccb8, 0x6e4726, 0xc9b496], [-10.3, -8, -5.7]);
  lowTable(g, tm.hanokWood, tm.hanokDark, -8, -3.9, 2.5, 0.95, 0.62);

  // 글방 (dev): 선비 서안 3조 + 한지 두루마리 모니터 + 호롱불
  for (const x of [-2.4, 0, 2.4]) {
    lowTable(g, tm.hanokWood, tm.hanokDark, x, -6.5, 1.9, 0.85, 0.62);
    scrollScreen(g, tm.hanokDark, M.screens.code, x, 0.68, -6.75, 0);
    box(g, M.lamp, 0.1, 0.14, 0.1, x + 0.68, 0.68, -6.35, false);
  }

  // 대장간 (server): 황토 화덕·굴뚝 + 불꽃(leds) + 쇠 모루 + 담금질 물통
  const leds = [];
  for (const x of [5.6, 7.3, 9.0, 10.4]) {
    box(g, tm.graniteDark, 1.25, 1.35, 0.9, x, 0.14, -7.1);
    box(g, tm.hanokDark, 0.55, 0.9, 0.55, x, 1.49, -7.2);
    for (const dx of [-0.22, 0.22]) {
      leds.push(box(g, M.ledBusy, 0.2, 0.18, 0.14, x + dx, 0.55, -6.62, false));
    }
  }
  box(g, M.dark, 0.75, 0.55, 0.42, 8, 0.14, -3.7); // 모루(Anvil)
  const barrel = new THREE.Mesh(CYL, tm.hanokDark);
  barrel.scale.set(0.32, 0.62, 0.32);
  barrel.position.set(9.4, 0.45, -3.7);
  g.add(barrel);

  // 누각 (research): 정자 계자난간 + 천문 풍향구의(globe) + 서안
  for (const [x, z, w, d] of [[-8.4, 8.2, 8.2, 0.12], [-12.5, 5.3, 0.12, 5.8]]) {
    box(g, tm.hanokDark, w, 0.48, d, x, 0.14, z);
  }
  const ped = new THREE.Mesh(CYL, tm.hanokDark);
  ped.scale.set(0.22, 0.95, 0.28);
  ped.position.set(-8.4, 0.6, 5.3);
  g.add(ped);
  const globe = new THREE.Group();
  globe.position.set(-8.4, 1.68, 5.3);
  const ring = new THREE.Mesh(TORUS, tm.gold);
  ring.scale.setScalar(0.76);
  const ball = new THREE.Mesh(ICOSA, tm.dancheong);
  ball.scale.setScalar(0.52);
  globe.add(ring, ball);
  g.add(globe);
  for (const z of [3.9, 6.5]) {
    lowTable(g, tm.hanokWood, tm.hanokDark, -11.4, z, 0.8, 1.4, 0.62);
    scrollScreen(g, tm.hanokDark, M.screens.web, -11.6, 0.68, z, E);
  }

  // 대청마루 (meeting): 원목 한지 현판 보드 + 대청 다과 탁자
  boardFrame(g, tm.hanokDark, tm.hanokWood, board);
  lowTable(g, tm.hanokWood, tm.hanokDark, 0.8, 5, 1.35, 3.0, 0.62);

  // 사랑채 (desk): 주인장 문답 다상 + 석등 비콘 + 다기 세트
  lowTable(g, tm.hanokWood, tm.hanokDark, 9.5, 5, 1.0, 2.4, 0.66);
  scrollScreen(g, tm.hanokDark, M.screens.code, 9.3, 0.72, 4.35, E, 0.84, 0.5);
  scrollScreen(g, tm.hanokDark, M.screens.web, 9.3, 0.72, 5.65, E, 0.84, 0.5);
  box(g, tm.graniteDark, 0.65, 0.85, 0.65, 10.8, 0.14, 5);
  const lantern = box(g, M.lamp, 0.34, 0.34, 0.34, 10.8, 1.0, 5, false);
  lantern.userData.blink = true;
  box(g, tm.tile, 0.58, 0.16, 0.58, 10.8, 1.36, 5);
  // 안마당 평상
  lowTable(g, tm.hanokWood, tm.hanokDark, 7.6, 1.35, 2.8, 0.85, 0.42);
  return { leds, globe };
}

// ---- 5. SF 스타십 (starship) ----
export function buildStarshipProps(g, board) {
  const M = mats();
  const tm = themeMats();
  // 데이터 볼트 (archive): 육각 크리스탈 데이터 모놀리스 3기 + 콘솔
  for (const x of [-10.2, -8, -5.8]) {
    const base = new THREE.Mesh(CYL, tm.hullTrim);
    base.scale.set(0.85, 0.3, 0.85);
    base.position.set(x, 0.15, -7.2);
    const crystal = new THREE.Mesh(CYL, tm.plasmaCyan);
    crystal.scale.set(0.55, 1.9, 0.55);
    crystal.position.set(x, 1.25, -7.2);
    g.add(base, crystal);
  }
  lowTable(g, tm.hullTrim, tm.hull, -8, -3.9, 2.4, 0.9, 0.72);

  // 포지 베이 (dev): 플로팅 홀로그램 워크스테이션 3기
  for (const x of [-2.5, 0, 2.5]) {
    lowTable(g, tm.hullTrim, tm.hull, x, -6.6, 1.9, 0.85, 0.72);
    scrollScreen(g, tm.plasmaCyan, M.screens.code, x, 0.78, -6.85, 0);
  }

  // 엔진 코어 (server): 워프 플라즈마 코어 기둥 4기 + 에너지 링(leds)
  const leds = [];
  for (const x of [5.5, 7.2, 8.8, 10.4]) {
    const col = new THREE.Mesh(CYL, tm.hullTrim);
    col.scale.set(0.52, 2.35, 0.52);
    col.position.set(x, 1.18, -7.1);
    g.add(col);
    for (let r = 0; r < 5; r++) {
      leds.push(box(g, M.ledOn, 0.58, 0.08, 0.58, x, 0.42 + r * 0.38, -7.1, false));
    }
  }
  lowTable(g, tm.hullTrim, tm.hull, 8, -3.7, 1.6, 0.75, 0.72);
  scrollScreen(g, tm.plasmaCyan, M.screens.term, 8, 0.78, -3.85, 0);

  // 센서 어레이 (research): 홀로그램 성도 구체(globe) + 딥스페이스 스캐너
  const ped = new THREE.Mesh(CYL, tm.hullTrim);
  ped.scale.set(0.45, 0.85, 0.55);
  ped.position.set(-8, 0.42, 5);
  g.add(ped);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.75, 5);
  const starBall = new THREE.Mesh(ICOSA, tm.plasmaCyan);
  starBall.scale.setScalar(0.68);
  const orbit = new THREE.Mesh(TORUS, tm.plasmaViolet);
  orbit.scale.setScalar(0.95);
  orbit.rotation.x = 0.8;
  globe.add(starBall, orbit);
  g.add(globe);
  for (const z of [3.6, 6.4]) {
    lowTable(g, tm.hullTrim, tm.hull, -11.0, z, 0.8, 1.5, 0.72);
    scrollScreen(g, tm.plasmaCyan, M.screens.web, -11.2, 0.78, z, E);
  }

  // 택티컬 브리지 (meeting): 시안 프레임 전술 홀로그램 월 + 커맨드 테이블
  boardFrame(g, tm.hullTrim, tm.plasmaCyan, board);
  lowTable(g, tm.hullTrim, tm.hull, 0.8, 5, 1.4, 3.1, 0.72);

  // 홀로그램 통신실 (desk): 성간 홀로 프로젝터 포드 + 승인 콘솔
  lowTable(g, tm.hullTrim, tm.hull, 9.5, 5, 1.0, 2.5, 0.74);
  scrollScreen(g, tm.plasmaCyan, M.screens.code, 9.3, 0.8, 4.35, E, 0.88, 0.54);
  scrollScreen(g, tm.plasmaCyan, M.screens.web, 9.3, 0.8, 5.65, E, 0.88, 0.54);
  const pod = new THREE.Mesh(CYL, tm.hullTrim);
  pod.scale.set(0.62, 0.5, 0.62);
  pod.position.set(10.8, 0.25, 5);
  const holoRing = new THREE.Mesh(TORUS, tm.plasmaCyan);
  holoRing.scale.setScalar(0.52);
  holoRing.rotation.x = Math.PI / 2;
  holoRing.position.set(10.8, 1.25, 5);
  const holoCore = new THREE.Mesh(ICOSA, tm.plasmaViolet);
  holoCore.scale.setScalar(0.32);
  holoCore.position.set(10.8, 1.25, 5);
  g.add(pod, holoRing, holoCore);
  lowTable(g, tm.hullTrim, tm.hull, 7.6, 1.35, 2.8, 0.8, 0.42);
  return { leds, globe };
}
