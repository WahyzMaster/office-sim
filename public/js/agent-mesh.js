// 직원 몸(three.js 메시), 브랜드별 액세서리, 색칠, 몸짓 애니메이션.
import * as THREE from 'three';
import { mats } from './furniture.js';
import { glowing } from './scene.js';

const CAPSULE = new THREE.CapsuleGeometry(0.31, 0.36, 6, 14);
const HEAD = new THREE.SphereGeometry(0.31, 20, 16);
const EYE = new THREE.SphereGeometry(0.048, 10, 8);
const SPARK = new THREE.SphereGeometry(0.018, 6, 6);
const CHEEK = new THREE.SphereGeometry(0.042, 8, 6);
const LIMB = new THREE.BoxGeometry(1, 1, 1);
const HAND = new THREE.SphereGeometry(0.068, 8, 6);
const SHOE = new THREE.CapsuleGeometry(0.075, 0.08, 4, 8);
const PACK = new THREE.BoxGeometry(0.32, 0.32, 0.15);
const COLLAR = new THREE.TorusGeometry(0.22, 0.042, 8, 18);
const BERET = new THREE.CylinderGeometry(0.23, 0.28, 0.09, 16);
const GEM = new THREE.OctahedronGeometry(0.095, 0);
const VISOR = new THREE.TorusGeometry(0.275, 0.042, 8, 20, Math.PI * 0.68);
const EAR_HEX = new THREE.CylinderGeometry(0.085, 0.085, 0.06, 6);
const ORBIT_RING = new THREE.TorusGeometry(0.43, 0.024, 10, 32);
const LEV_RING = new THREE.TorusGeometry(0.33, 0.025, 10, 24);
const HEADBAND = new THREE.TorusGeometry(0.315, 0.024, 8, 20, Math.PI);
const BILL = new THREE.BoxGeometry(0.34, 0.036, 0.18);
const PROP_STEM = new THREE.CylinderGeometry(0.02, 0.02, 0.14, 8);
const PROP_BLADE = new THREE.BoxGeometry(0.34, 0.016, 0.045);

const EYE_MAT = new THREE.MeshBasicMaterial({ color: 0x181d24 });
const SPARK_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff });
const BLUSH_MAT = new THREE.MeshBasicMaterial({ color: 0xf48fb1, transparent: true, opacity: 0.65 });

const BRAND_ACCENT = {
  'claude-code': { color: 0xffd9b3, emissive: 0xff9e5e, glow: 0.9 },
  codex: { color: 0xa7f3d0, emissive: 0x10b981, glow: 1.2 },
  grok: { color: 0xe9d5ff, emissive: 0xa855f7, glow: 1.25 },
  antigravity: { color: 0xbfdbfe, emissive: 0x3b82f6, glow: 1.3 },
  'antigravity:cli': { color: 0xa5f3fc, emissive: 0x06b6d4, glow: 1.35 },
};

function limb(rig, mat, footMat, x, y, sx, sy, isLeg) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  const m = new THREE.Mesh(LIMB, mat);
  m.scale.set(sx, sy, sx);
  m.position.y = -sy / 2;
  m.castShadow = true;
  pivot.add(m);
  const tip = new THREE.Mesh(isLeg ? SHOE : HAND, footMat);
  if (isLeg) {
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, -sy + 0.02, 0.04);
  } else {
    tip.position.set(0, -sy - 0.01, 0);
  }
  tip.castShadow = true;
  pivot.add(tip);
  rig.add(pivot);
  return pivot;
}

export function buildBrandFlair(agent) {
  if (agent.brandGroup) agent.brandGroup.parent?.remove(agent.brandGroup);
  if (agent.baseRing) agent.baseRing.parent?.remove(agent.baseRing);
  agent.flair = null;
  agent.baseRing = null;

  const key = agent.agent === 'antigravity' && agent.surface === 'cli' ? 'antigravity:cli' : agent.agent;
  const spec = BRAND_ACCENT[key] || BRAND_ACCENT[agent.agent] || { color: 0xe2e8f0, emissive: 0x64748b, glow: 0.6 };
  agent.accentMat = glowing(
    new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.emissive, roughness: 0.25, metalness: 0.2 }),
    spec.glow,
  );

  const bg = agent.brandGroup = new THREE.Group();
  agent.head.add(bg);

  if (agent.agent === 'claude-code') {
    // Claude: 따뜻한 베레모 + 전면 스파크 스타 엠블럼
    const hat = new THREE.Group();
    hat.position.set(0.03, 0.25, -0.02);
    hat.rotation.set(-0.12, 0, -0.18);
    const beret = new THREE.Mesh(BERET, agent.bodyMat);
    beret.castShadow = true;
    hat.add(beret);
    const star = new THREE.Group();
    star.position.set(0, 0.11, 0.14);
    const g1 = new THREE.Mesh(GEM, agent.accentMat);
    const g2 = new THREE.Mesh(GEM, agent.accentMat);
    g2.rotation.y = Math.PI / 4;
    g2.rotation.z = Math.PI / 4;
    star.add(g1, g2);
    hat.add(star);
    bg.add(hat);
    agent.flair = star;
  } else if (agent.agent === 'codex') {
    // Codex: 에메랄드 사이버 바이저 + 육각 헤드셋 + 회전 크리스탈
    const visor = new THREE.Mesh(VISOR, agent.accentMat);
    visor.position.set(0, 0.02, 0.03);
    visor.rotation.set(Math.PI / 2, 0, -Math.PI * 0.34);
    bg.add(visor);
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(EAR_HEX, agent.legsMat);
      ear.position.set(sx * 0.31, 0.02, 0);
      ear.rotation.z = Math.PI / 2;
      bg.add(ear);
    }
    const gem = new THREE.Mesh(GEM, agent.accentMat);
    gem.position.set(0, 0.43, 0);
    bg.add(gem);
    agent.flair = gem;
  } else if (agent.agent === 'grok') {
    // Grok: 토성/슬래시 궤도 링 + 위성 + 다크 셰이드
    const shade = new THREE.Mesh(VISOR, EYE_MAT);
    shade.position.set(0, 0.03, 0.03);
    shade.rotation.set(Math.PI / 2, 0, -Math.PI * 0.34);
    bg.add(shade);
    const orbit = new THREE.Group();
    orbit.position.set(0, 0.12, 0);
    orbit.rotation.set(1.22, 0.3, -0.32);
    const ring = new THREE.Mesh(ORBIT_RING, agent.accentMat);
    const moon = new THREE.Mesh(HAND, agent.accentMat);
    moon.scale.setScalar(0.65);
    moon.position.set(0.43, 0, 0);
    orbit.add(ring, moon);
    bg.add(orbit);
    agent.flair = orbit;
  } else if (agent.agent === 'antigravity') {
    // Antigravity: 발밑 반중력 부양 링 + 머리 위 프리즘 + CLI(터미널 캡) / App(헤일로 헤드셋)
    const lev = new THREE.Mesh(LEV_RING, agent.accentMat);
    lev.rotation.x = Math.PI / 2;
    lev.position.set(0, 0.05, 0);
    agent.rig.add(lev);
    agent.baseRing = lev;
    if (agent.surface === 'cli') {
      const bill = new THREE.Mesh(BILL, agent.accentMat);
      bill.position.set(0, 0.17, 0.24);
      bill.rotation.x = 0.12;
      bg.add(bill);
    } else {
      const band = new THREE.Mesh(HEADBAND, agent.accentMat);
      band.position.set(0, 0.02, 0);
      bg.add(band);
      for (const sx of [-1, 1]) {
        const cup = new THREE.Mesh(EAR_HEX, agent.accentMat);
        cup.position.set(sx * 0.31, 0.01, 0);
        cup.rotation.z = Math.PI / 2;
        bg.add(cup);
      }
    }
    const prism = new THREE.Mesh(GEM, agent.accentMat);
    prism.scale.set(1.1, 1.35, 1.1);
    prism.position.set(0, 0.48, 0);
    bg.add(prism);
    agent.flair = prism;
  }

  if (agent.isSub) {
    const prop = new THREE.Group();
    prop.position.set(0, agent.agent === 'antigravity' || agent.agent === 'codex' ? 0.64 : 0.38, 0);
    const stem = new THREE.Mesh(PROP_STEM, agent.legsMat);
    const blade = new THREE.Mesh(PROP_BLADE, agent.accentMat);
    blade.position.y = 0.07;
    prop.add(stem, blade);
    bg.add(prop);
    agent.propeller = blade;
  } else {
    agent.propeller = null;
  }
}

// agent 에 group, rig, head, legs, arms, pickMeshes, bodyMat, legsMat 를 붙인다.
export function buildAgentMesh(agent) {
  const M = mats();
  agent.bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 });
  agent.legsMat = new THREE.MeshStandardMaterial({ roughness: 0.72 });
  const g = agent.group = new THREE.Group();
  const rig = agent.rig = new THREE.Group();
  g.add(rig);

  const torso = new THREE.Mesh(CAPSULE, agent.bodyMat);
  torso.position.y = 0.78;
  const collar = new THREE.Mesh(COLLAR, M.wall);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.09;
  const pack = new THREE.Mesh(PACK, agent.legsMat);
  pack.position.set(0, 0.78, -0.23);
  pack.castShadow = true;

  const head = agent.head = new THREE.Mesh(HEAD, M.skin);
  head.position.y = 1.44;
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(EYE, EYE_MAT);
    eye.position.set(sx * 0.105, 0.025, 0.272);
    const spark = new THREE.Mesh(SPARK, SPARK_MAT);
    spark.position.set(sx * 0.105 - 0.016, 0.046, 0.308);
    const cheek = new THREE.Mesh(CHEEK, BLUSH_MAT);
    cheek.position.set(sx * 0.175, -0.045, 0.248);
    cheek.scale.set(1.32, 0.68, 0.45);
    head.add(eye, spark, cheek);
  }
  rig.add(torso, collar, pack, head);
  agent.legs = [-1, 1].map((sx) => limb(rig, agent.legsMat, agent.bodyMat, sx * 0.13, 0.44, 0.14, 0.4, true));
  agent.arms = [-1, 1].map((sx) => limb(rig, agent.bodyMat, M.skin, sx * 0.38, 1.02, 0.11, 0.38, false));

  tintAgent(agent);
  buildBrandFlair(agent);
  if (agent.isSub) g.scale.setScalar(0.74);

  torso.castShadow = true;
  head.castShadow = true;
  torso.userData.agent = agent;
  head.userData.agent = agent;
  agent.pickMeshes = [torso, head];
}

// 색이 바뀌면(부모가 바뀐 서브에이전트 등) 재질만 다시 칠한다.
export function tintAgent(agent) {
  agent.bodyMat.color.setHSL(agent.hue / 360, 0.66, agent.light, THREE.SRGBColorSpace);
  agent.legsMat.color.setHSL(agent.hue / 360, 0.42, 0.26, THREE.SRGBColorSpace);
}

// 캐릭터 팔다리·고개·브랜드 장식 애니메이션.
export function animateAgentMesh(agent, reduced = false) {
  const t = agent.t;
  let leg = 0;
  let armL = 0;
  let armR = 0;
  let bob = 0;
  let tilt = 0;
  let shake = 0;
  if (agent.path.length) {
    const f = 9.5 * (1 + Math.min(agent.queue.length, 6) * 0.25);
    leg = Math.sin(t * f) * 0.65;
    armL = -leg * 0.85;
    armR = leg * 0.85;
    bob = Math.abs(Math.sin(t * f)) * 0.06;
    tilt = Math.sin(t * f * 0.5) * 0.06;
  } else {
    switch (agent.mode) {
      case 'work':
        armL = -1.1 + Math.sin(t * 22) * 0.2;
        armR = -1.1 + Math.cos(t * 19) * 0.2;
        bob = Math.abs(Math.sin(t * 6)) * 0.018;
        break;
      case 'think':
        armR = -2.3;
        tilt = 0.2;
        bob = Math.sin(t * 2) * 0.018;
        break;
      case 'write':
        armR = -2.5 + Math.sin(t * 14) * 0.25;
        armL = -0.2;
        break;
      case 'ask':
        armR = -2.75 + Math.sin(t * 6) * 0.14;
        bob = Math.sin(t * 3.2) * 0.025;
        break;
      default:
        bob = Math.sin(t * 2.4) * 0.018;
        tilt = Math.sin(t * 1.2) * 0.03;
    }
  }
  if (agent.panicT > 0) {
    armL = -2.6 + Math.sin(t * 30) * 0.3;
    armR = -2.6 - Math.sin(t * 30) * 0.3;
    shake = reduced ? 0 : Math.sin(t * 70) * 0.04;
  }
  const floatOffset = agent.agent === 'antigravity' && !reduced ? 0.03 + Math.sin(t * 3.2) * 0.025 : 0;
  agent.legs[0].rotation.x = leg;
  agent.legs[1].rotation.x = -leg;
  agent.arms[0].rotation.x = armL;
  agent.arms[1].rotation.x = armR;
  agent.rig.position.y = (reduced ? 0 : bob) + floatOffset;
  agent.rig.position.x = shake;
  agent.head.rotation.z = tilt;
  if (!reduced && agent.flair) {
    agent.flair.rotation.y = t * 1.8;
    if (agent.agent === 'antigravity' || agent.agent === 'codex') {
      agent.flair.position.y = (agent.agent === 'antigravity' ? 0.48 : 0.43) + Math.sin(t * 3.2) * 0.025;
    }
  }
  if (!reduced && agent.propeller) {
    agent.propeller.rotation.y = t * (agent.path.length ? 18 : 7);
  }
}
