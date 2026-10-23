// 퍼피 파크(dogs)·캣 타워 살롱(cats) 테마 가구·소품. { leds, globe } 를 돌려주고 회의실 보드를 연결한다.
import * as THREE from 'three';
import { box } from './scene.js';
import { mats } from './furniture.js';
import { themeMats, lowTable, scrollScreen, boardFrame } from './theme-kit.js';

const E = Math.PI / 2;
const CYL = new THREE.CylinderGeometry(1, 1, 1, 14);
const TORUS = new THREE.TorusGeometry(1, 0.06, 8, 24);
const ICOSA = new THREE.IcosahedronGeometry(1, 1);

// 4. 퍼피 파크 (dogs): 노즈워크 숲, 어질리티 허들, 볼 런처(leds), 회전 테니스공·소화전(globe), 간식 부스
export function buildDogsProps(g, board) {
  const M = mats();
  const tm = themeMats();
  const leds = [];
  for (const x of [-10.4, -8, -5.6]) {
    box(g, tm.fenceWood, 1.8, 1.4, 0.65, x, 0, -7.2);
    box(g, tm.agilityYellow, 1.5, 0.14, 0.55, x, 0.55, -7.15, false);
    box(g, tm.agilityBlue, 1.5, 0.14, 0.55, x, 1.05, -7.15, false);
  }
  lowTable(g, tm.fenceWood, tm.hanokDark, -8, -4.35, 2.4, 0.75, 0.55);
  for (const x of [-8.6, -7.4]) scrollScreen(g, tm.fenceWood, M.screens.doc, x, 0.6, -4.5, 0, 0.78, 0.46);
  for (const x of [-2.5, 0, 2.5]) {
    box(g, tm.agilityBlue, 0.12, 0.9, 0.12, x - 0.7, 0, -6.5);
    box(g, tm.agilityBlue, 0.12, 0.9, 0.12, x + 0.7, 0, -6.5);
    box(g, tm.agilityYellow, 1.5, 0.1, 0.1, x, 0.58, -6.5);
  }
  for (const x of [-1.3, 1.3]) {
    lowTable(g, tm.fenceWood, tm.hanokDark, x, -4.1, 1.2, 0.65, 0.58);
    scrollScreen(g, tm.agilityBlue, M.screens.code, x, 0.62, -4.25, 0, 0.82, 0.5);
  }
  for (const x of [5.5, 7.2, 8.8, 10.4]) {
    box(g, tm.agilityBlue, 1.1, 1.6, 0.75, x, 0, -7.1);
    for (let r = 0; r < 4; r++) leds.push(box(g, M.ledOn, 0.42, 0.1, 0.42, x, 0.38 + r * 0.34, -6.8, false));
  }
  lowTable(g, tm.fenceWood, tm.hanokDark, 8, -3.9, 1.5, 0.65, 0.58);
  scrollScreen(g, tm.agilityYellow, M.screens.term, 8, 0.62, -4.05, 0);
  // 전망 언덕: 빨간 소화전 + 회전 대형 테니스공(globe)
  const hyd = new THREE.Mesh(CYL, tm.vermilion);
  hyd.scale.set(0.32, 0.85, 0.32);
  hyd.position.set(-8, 0.42, 5);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.55, 5);
  const ball = new THREE.Mesh(ICOSA, tm.agilityYellow);
  ball.scale.setScalar(0.56);
  const seam = new THREE.Mesh(TORUS, M.white);
  seam.scale.setScalar(0.58);
  seam.rotation.x = 0.7;
  globe.add(ball, seam);
  g.add(hyd, globe);
  for (const z of [3.6, 6.4]) {
    lowTable(g, tm.fenceWood, tm.hanokDark, -11.0, z, 0.8, 1.4, 0.58);
    scrollScreen(g, tm.fenceWood, M.screens.web, -11.2, 0.62, z, E);
  }
  boardFrame(g, tm.fenceWood, tm.agilityYellow, board);
  lowTable(g, tm.fenceWood, tm.hanokDark, 0.8, 5, 1.35, 3.0, 0.55);
  lowTable(g, tm.fenceWood, tm.hanokDark, 9.5, 5, 1.0, 2.4, 0.62);
  scrollScreen(g, tm.agilityBlue, M.screens.code, 9.3, 0.66, 4.35, E, 0.84, 0.5);
  scrollScreen(g, tm.agilityYellow, M.screens.web, 9.3, 0.66, 5.65, E, 0.84, 0.5);
  const jar = new THREE.Mesh(CYL, tm.gold);
  jar.scale.set(0.45, 1.1, 0.45);
  jar.position.set(10.7, 0.55, 5);
  g.add(jar);
  return { leds, globe };
}

// 5. 캣 타워 살롱 (cats): 창가 캣타워, 스크래처 소파, 레이저 돔(leds), 회전 실타래(globe), 츄르·집사 벨 부스
export function buildCatsProps(g, board) {
  const M = mats();
  const tm = themeMats();
  const leds = [];
  for (const x of [-10.2, -8, -5.8]) {
    const post = new THREE.Mesh(CYL, tm.sisal);
    post.scale.set(0.18, 1.8, 0.18);
    post.position.set(x, 0.9, -7.2);
    g.add(post);
    box(g, tm.plushPink, 1.3, 0.14, 0.9, x, 0.9, -7.2);
    box(g, tm.velvetCream, 1.1, 0.14, 0.8, x, 1.75, -7.2);
  }
  lowTable(g, tm.roseGold, tm.sisal, -8, -4.35, 2.4, 0.75, 0.55);
  for (const x of [-8.6, -7.4]) scrollScreen(g, tm.roseGold, M.screens.doc, x, 0.6, -4.5, 0, 0.78, 0.46);
  for (const x of [-2.5, 0, 2.5]) {
    box(g, tm.sisal, 1.6, 0.48, 0.7, x, 0, -6.5);
    box(g, tm.plushPink, 1.5, 0.1, 0.62, x, 0.48, -6.5, false);
  }
  for (const x of [-1.3, 1.3]) {
    lowTable(g, tm.roseGold, tm.sisal, x, -4.1, 1.2, 0.65, 0.58);
    scrollScreen(g, tm.plushPink, M.screens.code, x, 0.62, -4.25, 0, 0.82, 0.5);
  }
  for (const x of [5.6, 7.2, 8.8, 10.2]) {
    const tower = new THREE.Mesh(CYL, tm.roseGold);
    tower.scale.set(0.42, 1.65, 0.42);
    tower.position.set(x, 0.82, -7.1);
    g.add(tower);
    for (let r = 0; r < 4; r++) leds.push(box(g, M.ledOn, 0.36, 0.09, 0.36, x, 0.38 + r * 0.35, -6.65, false));
  }
  lowTable(g, tm.roseGold, tm.sisal, 8, -3.9, 1.5, 0.65, 0.58);
  scrollScreen(g, tm.roseGold, M.screens.term, 8, 0.62, -4.05, 0);
  // 캣닢 온실: 캣닢 화분대 + 회전 황금 실타래(globe)
  const ped = new THREE.Mesh(CYL, tm.sisal);
  ped.scale.set(0.38, 0.9, 0.38);
  ped.position.set(-8, 0.45, 5);
  const globe = new THREE.Group();
  globe.position.set(-8, 1.6, 5);
  const yarn = new THREE.Mesh(ICOSA, tm.plushPink);
  yarn.scale.setScalar(0.58);
  const loop = new THREE.Mesh(TORUS, tm.gold);
  loop.scale.setScalar(0.75);
  loop.rotation.x = 0.85;
  globe.add(yarn, loop);
  g.add(ped, globe);
  for (const z of [3.6, 6.4]) {
    lowTable(g, tm.roseGold, tm.sisal, -11.0, z, 0.8, 1.4, 0.58);
    scrollScreen(g, tm.roseGold, M.screens.web, -11.2, 0.62, z, E);
  }
  boardFrame(g, tm.roseGold, tm.plushPink, board);
  lowTable(g, tm.roseGold, tm.sisal, 0.8, 5, 1.35, 3.0, 0.55);
  lowTable(g, tm.roseGold, tm.sisal, 9.5, 5, 1.0, 2.4, 0.62);
  scrollScreen(g, tm.roseGold, M.screens.code, 9.3, 0.66, 4.35, E, 0.84, 0.5);
  scrollScreen(g, tm.plushPink, M.screens.web, 9.3, 0.66, 5.65, E, 0.84, 0.5);
  const bell = new THREE.Mesh(CYL, tm.gold);
  bell.scale.set(0.48, 0.55, 0.48);
  bell.position.set(10.7, 0.28, 5);
  g.add(bell);
  return { leds, globe };
}
