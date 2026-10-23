// 로봇(bots) 캐릭터 패밀리 전용 3D 메카·드로이드 조형(LED 바이저·듀엣 공명기·도트 오브·블랙홀 궤도 링·반중력 코어·드론 로터) 및 모션.
import * as THREE from 'three';
import { glowing } from './scene.js';
import { pickBotModel } from './sound.js';

export { pickBotModel };

const VISOR_PLATE = new THREE.BoxGeometry(0.44, 0.16, 0.14);
const LED_EYE = new THREE.SphereGeometry(0.046, 10, 8);
const DOT_CORE = new THREE.SphereGeometry(0.088, 14, 12);
const ORB_RING = new THREE.TorusGeometry(0.37, 0.022, 10, 28);
const SATURN_RING = new THREE.TorusGeometry(0.45, 0.026, 10, 32);
const DUET_RING = new THREE.TorusGeometry(0.28, 0.02, 10, 24);
const CHEST_RING = new THREE.TorusGeometry(0.11, 0.024, 8, 20);
const HOVER_RING = new THREE.TorusGeometry(0.34, 0.026, 10, 24);
const EAR_HEX = new THREE.CylinderGeometry(0.088, 0.088, 0.065, 6);
const ANT_STEM = new THREE.CylinderGeometry(0.018, 0.022, 0.22, 8);
const ANT_TIP = new THREE.SphereGeometry(0.048, 10, 8);
const PRISM_GEM = new THREE.OctahedronGeometry(0.105, 0);
const BILL_PLATE = new THREE.BoxGeometry(0.36, 0.036, 0.18);
const X_BAR = new THREE.BoxGeometry(0.24, 0.045, 0.035);
const JET_POD = new THREE.CylinderGeometry(0.072, 0.092, 0.32, 10);
const JET_FLAME = new THREE.ConeGeometry(0.058, 0.16, 8);
const HEATSINK = new THREE.BoxGeometry(0.30, 0.28, 0.14);
const ROTOR_BLADE = new THREE.BoxGeometry(0.38, 0.016, 0.048);
const ROVER_TAIL = new THREE.CylinderGeometry(0.016, 0.022, 0.32, 8);

const DARK_VISOR = new THREE.MeshStandardMaterial({ color: 0x0f141c, roughness: 0.18, metalness: 0.82 });
const CHROME_MAT = new THREE.MeshStandardMaterial({ color: 0xdbe4ee, roughness: 0.22, metalness: 0.78 });

export const BOT_MODELS = Object.freeze({
  'claude-duet': Object.freeze({
    body: 0xf08c5b, legs: 0x362a26, head: 0xfaf3eb, eye: 0xffd199,
    hover: false, crest: 'duet', chest: 'duet', pack: 'thruster',
  }),
  'claude-code': Object.freeze({
    body: 0xd97757, legs: 0x28211f, head: 0xe28463, eye: 0xffe4cc,
    hover: false, crest: 'spark', chest: 'core', pack: 'heatsink', bill: true,
  }),
  'chatgpt-dot': Object.freeze({
    body: 0x14b8a6, legs: 0x152c29, head: 0x22d3be, eye: 0xe6fffa,
    hover: true, crest: 'dot-orb', chest: 'dot', pack: 'none',
  }),
  'codex-droid': Object.freeze({
    body: 0x10b981, legs: 0x142820, head: 0x233830, eye: 0xa7f3d0,
    hover: false, crest: 'hex-gem', chest: 'hex', pack: 'thruster', ears: true,
  }),
  'grok-bot': Object.freeze({
    body: 0x231d33, legs: 0x14111f, head: 0x2d2542, eye: 0xe9d5ff,
    hover: true, crest: 'saturn', chest: 'x-core', pack: 'thruster',
  }),
  'agy-probe': Object.freeze({
    body: 0x06b6d4, legs: 0x122a33, head: 0x1b3d4a, eye: 0xa5f3fc,
    hover: true, crest: 'prism-ring', chest: 'hex', pack: 'thruster', ears: true,
  }),
  'agy-mech': Object.freeze({
    body: 0x3b82f6, legs: 0x172542, head: 0x253b66, eye: 0xbfdbfe,
    hover: true, crest: 'prism-crown', chest: 'core', pack: 'thruster', ears: true,
  }),
  'mini-drone': Object.freeze({
    body: 0xf59e0b, legs: 0x252830, head: 0xfbbf24, eye: 0x7dd3fc,
    hover: true, crest: 'rotor', chest: 'dot', pack: 'none', inheritHue: true,
  }),
});

export function applyBotMesh(agent, theme, posture = 'bipod', explicitModel = '') {
  const isTetra = posture === 'tetrapod';
  const modelKey = explicitModel || pickBotModel(agent, theme);
  const spec = BOT_MODELS[modelKey] || BOT_MODELS['claude-code'];

  agent.bodyMat.roughness = 0.28;
  agent.bodyMat.metalness = 0.62;
  agent.legsMat.roughness = 0.36;
  agent.legsMat.metalness = 0.58;

  if (!agent.botHeadMat) {
    agent.botHeadMat = new THREE.MeshStandardMaterial({ roughness: 0.24, metalness: 0.65 });
  }
  if (spec.inheritHue && typeof agent.hue === 'number') {
    agent.bodyMat.color.setHSL(agent.hue / 360, 0.72, 0.54, THREE.SRGBColorSpace);
    agent.legsMat.color.setHSL(agent.hue / 360, 0.35, 0.22, THREE.SRGBColorSpace);
    agent.botHeadMat.color.setHSL(agent.hue / 360, 0.75, 0.62, THREE.SRGBColorSpace);
  } else {
    agent.bodyMat.color.setHex(spec.body);
    agent.legsMat.color.setHex(spec.legs);
    agent.botHeadMat.color.setHex(spec.head);
  }
  agent.head.material = agent.botHeadMat;
  if (agent.packMesh) agent.packMesh.visible = false;

  const eyeMat = glowing(
    new THREE.MeshStandardMaterial({ color: spec.eye, emissive: spec.eye, roughness: 0.15, metalness: 0.1 }),
    1.35,
  );
  agent.botEyeMat = eyeMat;

  const cg = agent.costumeGroup;
  const bg = agent.flair;

  // 1. 얼굴 바이저 플레이트 & LED 눈 (ChatGPT Dot 은 중앙 원형 도트 코어 + 동심원 파동 링)
  const visor = new THREE.Mesh(VISOR_PLATE, DARK_VISOR);
  visor.position.set(0, 0.02, 0.245);
  bg.add(visor);

  if (spec.crest === 'dot-orb') {
    const dotEye = new THREE.Mesh(DOT_CORE, eyeMat);
    dotEye.scale.set(1.05, 1.05, 0.55);
    dotEye.position.set(0, 0.02, 0.295);
    bg.add(dotEye);
  } else {
    for (const sx of [-1, 1]) {
      const led = new THREE.Mesh(LED_EYE, eyeMat);
      led.scale.set(1.25, 0.85, 0.55);
      led.position.set(sx * 0.105, 0.025, 0.305);
      bg.add(led);
    }
  }

  if (spec.bill) {
    const bill = new THREE.Mesh(BILL_PLATE, agent.accentMat);
    bill.position.set(0, 0.13, 0.24);
    bill.rotation.x = 0.1;
    bg.add(bill);
  }
  if (spec.ears) {
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(EAR_HEX, CHROME_MAT);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(sx * 0.315, 0.02, 0);
      bg.add(ear);
    }
  }

  // 2. 모델별 헤드 크레스트·궤도 링·안테나 (agent.botOrbit 에 연결해 회전 모션 부여)
  const orbit = new THREE.Group();
  agent.botOrbit = orbit;
  bg.add(orbit);

  if (spec.crest === 'duet') {
    // Claude Duet: 좌우 대칭 하모닉 공명 안테나 + 상단 이중 듀엣 헤일로 링
    for (const sx of [-1, 1]) {
      const stem = new THREE.Mesh(ANT_STEM, CHROME_MAT);
      stem.position.set(sx * 0.14, 0.34, 0);
      stem.rotation.z = -sx * 0.22;
      const tip = new THREE.Mesh(ANT_TIP, sx < 0 ? agent.accentMat : eyeMat);
      tip.position.set(sx * 0.18, 0.45, 0);
      bg.add(stem, tip);
    }
    orbit.position.set(0, 0.46, 0);
    const ring1 = new THREE.Mesh(DUET_RING, agent.accentMat);
    ring1.rotation.x = Math.PI / 2;
    const ring2 = new THREE.Mesh(DUET_RING, eyeMat);
    ring2.rotation.x = Math.PI / 3;
    ring2.scale.setScalar(0.76);
    orbit.add(ring1, ring2);
  } else if (spec.crest === 'spark') {
    // Claude Bot: 중앙 안테나 스템 + 8각 스파크 스타
    const stem = new THREE.Mesh(ANT_STEM, CHROME_MAT);
    stem.position.set(0, 0.34, 0);
    bg.add(stem);
    orbit.position.set(0, 0.48, 0);
    const g1 = new THREE.Mesh(PRISM_GEM, agent.accentMat);
    const g2 = new THREE.Mesh(PRISM_GEM, eyeMat);
    g2.rotation.y = Math.PI / 4;
    g2.rotation.z = Math.PI / 4;
    orbit.add(g1, g2);
  } else if (spec.crest === 'dot-orb') {
    // ChatGPT Dot: 구형 오브 감싸는 틸트 보이스 웨이브 링 + 궤도 도트 위성
    orbit.position.set(0, 0.04, 0);
    orbit.rotation.set(0.95, 0.25, -0.28);
    const waveRing = new THREE.Mesh(ORB_RING, agent.accentMat);
    const satDot = new THREE.Mesh(ANT_TIP, eyeMat);
    satDot.position.set(0.37, 0, 0);
    orbit.add(waveRing, satDot);
  } else if (spec.crest === 'hex-gem') {
    // Codex Droid: 머리 위 데이터 옥타헤드론 크리스탈
    orbit.position.set(0, 0.46, 0);
    const gem = new THREE.Mesh(PRISM_GEM, agent.accentMat);
    const ring = new THREE.Mesh(DUET_RING, eyeMat);
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(0.72);
    orbit.add(gem, ring);
  } else if (spec.crest === 'saturn') {
    // Grok Bot: 블랙홀 강착 원반 궤도 링 + 회전 위성
    orbit.position.set(0, 0.12, 0);
    orbit.rotation.set(1.18, 0.32, -0.35);
    const ring = new THREE.Mesh(SATURN_RING, agent.accentMat);
    const moon = new THREE.Mesh(ANT_TIP, eyeMat);
    moon.scale.setScalar(1.25);
    moon.position.set(0.45, 0, 0);
    orbit.add(ring, moon);
  } else if (spec.crest === 'prism-ring' || spec.crest === 'prism-crown') {
    // AGY Probe / Astral Bot: 부유 프리즘 + 카운터 회전 링
    orbit.position.set(0, 0.48, 0);
    const prism = new THREE.Mesh(PRISM_GEM, agent.accentMat);
    prism.scale.set(1.08, 1.32, 1.08);
    const ring = new THREE.Mesh(DUET_RING, eyeMat);
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(spec.crest === 'prism-crown' ? 0.95 : 0.78);
    orbit.add(prism, ring);
  } else if (spec.crest === 'rotor') {
    // Mini Drone Bot: 동축 이중 프로펠러 로터
    const stem = new THREE.Mesh(ANT_STEM, CHROME_MAT);
    stem.scale.set(1, 0.7, 1);
    stem.position.set(0, 0.32, 0);
    const rotor = new THREE.Group();
    rotor.position.set(0, 0.41, 0);
    const b1 = new THREE.Mesh(ROTOR_BLADE, agent.accentMat);
    const b2 = new THREE.Mesh(ROTOR_BLADE, eyeMat);
    b2.rotation.y = Math.PI / 2;
    rotor.add(b1, b2);
    bg.add(stem, rotor);
    agent.propeller = rotor;
  }

  // 3. 가슴 코어 엠블럼 & 등 추진기/방열팩 (2족/4족 로버 자세 모두 대응)
  const cy = isTetra ? 0.54 : 0.82;
  const cz = isTetra ? 0.32 : 0.305;
  if (spec.chest === 'duet') {
    for (const sx of [-0.055, 0.055]) {
      const r = new THREE.Mesh(CHEST_RING, sx < 0 ? agent.accentMat : eyeMat);
      r.position.set(sx, cy, cz);
      cg.add(r);
    }
  } else if (spec.chest === 'dot') {
    const d = new THREE.Mesh(DOT_CORE, eyeMat);
    d.scale.set(1, 1, 0.45);
    d.position.set(0, cy, cz);
    cg.add(d);
  } else if (spec.chest === 'x-core') {
    for (const rz of [-0.72, 0.72]) {
      const bar = new THREE.Mesh(X_BAR, agent.accentMat);
      bar.rotation.z = rz;
      bar.position.set(0, cy, cz);
      cg.add(bar);
    }
  } else {
    const hex = new THREE.Mesh(EAR_HEX, agent.accentMat);
    hex.rotation.x = Math.PI / 2;
    hex.position.set(0, cy, cz);
    cg.add(hex);
  }

  if (spec.pack === 'heatsink' && !isTetra) {
    const hs = new THREE.Mesh(HEATSINK, CHROME_MAT);
    hs.position.set(0, 0.78, -0.23);
    cg.add(hs);
  } else if (spec.pack === 'thruster' && !isTetra) {
    for (const sx of [-0.11, 0.11]) {
      const pod = new THREE.Mesh(JET_POD, CHROME_MAT);
      pod.position.set(sx, 0.8, -0.24);
      const flame = new THREE.Mesh(JET_FLAME, eyeMat);
      flame.rotation.x = Math.PI;
      flame.position.set(sx, 0.58, -0.24);
      cg.add(pod, flame);
    }
  }

  // 4족 보행(tetrapod) 선택 시 로봇 로버 테일 안테나 장착
  if (isTetra) {
    const tp = agent.tailPivot = new THREE.Group();
    tp.position.set(0, 0.66, -0.40);
    tp.userData = { isDog: true, tailType: 'long' };
    const rod = new THREE.Mesh(ROVER_TAIL, CHROME_MAT);
    rod.position.set(0, 0.15, -0.06);
    rod.rotation.x = -0.35;
    const beacon = new THREE.Mesh(ANT_TIP, eyeMat);
    beacon.position.set(0, 0.30, -0.11);
    tp.add(rod, beacon);
    cg.add(tp);
  }

  // 호버링 봇은 바닥 자기부상·반중력 링 부착
  if (spec.hover) {
    const lev = new THREE.Mesh(HOVER_RING, agent.accentMat);
    lev.rotation.x = Math.PI / 2;
    lev.position.set(0, 0.05, 0);
    agent.rig.add(lev);
    agent.baseRing = lev;
  }
}

export function animateBot(agent, reduced = false) {
  if (agent.charFamily !== 'bots' || reduced) return;
  const t = agent.t || 0;
  const modelKey = agent.charSpec?.startsWith('bot:') ? agent.charSpec.slice(4) : pickBotModel(agent, 'bots');
  const spec = BOT_MODELS[modelKey] || BOT_MODELS['claude-code'];
  if (spec.hover && agent.rig) {
    agent.rig.position.y += 0.035 + Math.sin(t * 3.8) * 0.026;
  }
  if (agent.botOrbit) {
    const fast = agent.maneuver || agent.mode === 'work' || agent.soundT > 0;
    agent.botOrbit.rotation.y = t * (fast ? 5.2 : 2.1);
  }
}
