// 직원 몸(three.js 메시), 테마별 의상(궁궐 관복·한옥 배자·스타십 우주복·스튜디오/오피스), 브랜드별 액세서리, 몸짓 애니메이션.
import * as THREE from 'three';
import { mats } from './furniture.js';
import { animateTail, applyPetMesh, applyPostureRig } from './pet-mesh.js';
import { activeCharThemeOf, effectivePosture, resolveAgentAppearance } from './rooms.js';
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
const BELT = new THREE.TorusGeometry(0.305, 0.028, 8, 20);
const GAT_BRIM = new THREE.CylinderGeometry(0.52, 0.52, 0.022, 24);
const GAT_CROWN = new THREE.CylinderGeometry(0.18, 0.21, 0.24, 16);
const SATGAT = new THREE.ConeGeometry(0.48, 0.24, 16);
const JET_CYL = new THREE.CylinderGeometry(0.075, 0.095, 0.34, 10);
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
const GAT_MAT = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.35, transparent: true, opacity: 0.9 });
const BAMBOO_MAT = new THREE.MeshStandardMaterial({ color: 0xd4b483, roughness: 0.65 });
const GOLD_MAT = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.65 });

const BRAND_ACCENT = {
  'claude-code': { color: 0xffd9b3, emissive: 0xff9e5e, glow: 0.9 },
  'claude-code:app': { color: 0xffe4cc, emissive: 0xffb366, glow: 1.2 },
  'claude-code:cli': { color: 0xffd9b3, emissive: 0xff9e5e, glow: 0.9 },
  codex: { color: 0xa7f3d0, emissive: 0x10b981, glow: 1.2 },
  'codex:app': { color: 0x99f6e4, emissive: 0x14b8a6, glow: 1.3 },
  'codex:cli': { color: 0xa7f3d0, emissive: 0x10b981, glow: 1.2 },
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
  pivot.userData.tip = tip;
  pivot.add(tip);
  rig.add(pivot);
  return pivot;
}

function buildThemeCostume(agent, theme) {
  if (!agent.rig) return;
  if (agent.costumeGroup) agent.costumeGroup.parent?.remove(agent.costumeGroup);
  const cg = agent.costumeGroup = new THREE.Group();
  agent.rig.add(cg);
  if (agent.packMesh) agent.packMesh.visible = theme === 'studio' || theme === 'office';

  if (theme === 'palace') {
    // 조선 궁궐 관복: 금박 흉배(가슴 패치) + 각대(관복 허리띠) + 등 뒤 교지 두루마리 전서통
    const badge = new THREE.Mesh(LIMB, GOLD_MAT);
    badge.scale.set(0.22, 0.22, 0.03);
    badge.position.set(0, 0.84, 0.3);
    const belt = new THREE.Mesh(BELT, GOLD_MAT);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.66;
    const scroll = new THREE.Mesh(JET_CYL, GOLD_MAT);
    scroll.rotation.z = 0.55;
    scroll.position.set(0, 0.84, -0.26);
    cg.add(badge, belt, scroll);
  } else if (theme === 'hanok') {
    // 전통 한옥 배자: 고름 리본 + 등 뒤 대나무 서책 망태기
    const goreum = new THREE.Mesh(LIMB, agent.accentMat);
    goreum.scale.set(0.06, 0.26, 0.03);
    goreum.position.set(0.08, 0.82, 0.31);
    goreum.rotation.z = -0.2;
    const basket = new THREE.Mesh(PACK, BAMBOO_MAT);
    basket.position.set(0, 0.78, -0.24);
    cg.add(goreum, basket);
  } else if (theme === 'starship') {
    // SF 스타십: 가슴 아크 리액터 코어 + 트윈 제트팩 추진기
    const core = new THREE.Mesh(EAR_HEX, agent.accentMat);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.84, 0.3);
    cg.add(core);
    for (const sx of [-0.11, 0.11]) {
      const pod = new THREE.Mesh(JET_CYL, agent.legsMat);
      pod.position.set(sx, 0.8, -0.25);
      const flame = new THREE.Mesh(HAND, agent.accentMat);
      flame.scale.set(0.65, 0.9, 0.65);
      flame.position.set(sx, 0.58, -0.25);
      cg.add(pod, flame);
    }
  } else if (theme === 'office') {
    // 테크 오피스: 사원증 케이스
    const idCard = new THREE.Mesh(LIMB, SPARK_MAT);
    idCard.scale.set(0.11, 0.15, 0.025);
    idCard.position.set(0.1, 0.82, 0.31);
    cg.add(idCard);
  }
}

export function buildBrandFlair(agent, theme = activeCharThemeOf(), posture = undefined) {
  if (!agent.head || !agent.rig) return;
  if (agent.brandGroup) agent.brandGroup.parent?.remove(agent.brandGroup);
  if (agent.baseRing) agent.baseRing.parent?.remove(agent.baseRing);
  agent.flair = null;
  agent.baseRing = null;
  agent.tailPivot = null;
  agent.propeller = null;

  const resolved = resolveAgentAppearance(agent, { charTheme: theme, posture });
  const style = resolved.style;
  const effPosture = posture ? effectivePosture(resolved.charSpec, posture) : resolved.posture;
  agent.charFamily = resolved.family;
  agent.charSpec = resolved.charSpec;

  const brandId = agent.brandOverride || agent.agent;
  const key = agent.surface && BRAND_ACCENT[`${brandId}:${agent.surface}`] ? `${brandId}:${agent.surface}` : brandId;
  const spec = BRAND_ACCENT[key] || BRAND_ACCENT[brandId] || { color: 0xe2e8f0, emissive: 0x64748b, glow: 0.6 };
  agent.accentMat = glowing(
    new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.emissive, roughness: 0.25, metalness: 0.2 }),
    spec.glow,
  );
  buildThemeCostume(agent, style);

  const bg = agent.brandGroup = new THREE.Group();
  agent.head.add(bg);

  if (resolved.family === 'dogs' || resolved.family === 'cats') {
    agent.flair = bg;
    applyPetMesh(agent, resolved.family, effPosture, resolved.breed);
    applyPostureRig(agent, resolved.family, effPosture, mats().skin);
    return;
  }
  agent.head.material = mats().skin;
  tintAgent(agent);

  if (brandId === 'claude-code') {
    // Claude: 궁궐(정자관+옥관자), 한옥(유건+매듭별), 기본/스타십(베레모/크레스트+스파크 스타 + App 헤일로 / CLI 챙)
    const hat = new THREE.Group();
    hat.position.set(style === 'palace' || style === 'hanok' ? 0 : 0.03, 0.26, -0.01);
    if (style !== 'palace' && style !== 'hanok') hat.rotation.set(-0.12, 0, -0.18);
    const crown = new THREE.Mesh(style === 'palace' ? GAT_CROWN : BERET, style === 'palace' ? GAT_MAT : agent.bodyMat);
    crown.castShadow = true;
    hat.add(crown);
    if (style !== 'palace' && style !== 'hanok') {
      if (agent.surface === 'app') {
        const halo = new THREE.Mesh(LEV_RING, agent.accentMat);
        halo.rotation.x = Math.PI / 2;
        halo.scale.setScalar(0.88);
        halo.position.y = 0.04;
        hat.add(halo);
      } else if (agent.surface === 'cli') {
        const bill = new THREE.Mesh(BILL, agent.accentMat);
        bill.position.set(0, -0.02, 0.22);
        bill.rotation.x = 0.12;
        hat.add(bill);
      }
    }
    const star = new THREE.Group();
    star.position.set(0, style === 'palace' ? 0.16 : 0.11, 0.14);
    const g1 = new THREE.Mesh(GEM, agent.accentMat);
    const g2 = new THREE.Mesh(GEM, agent.accentMat);
    g2.rotation.y = Math.PI / 4;
    g2.rotation.z = Math.PI / 4;
    star.add(g1, g2);
    hat.add(star);
    bg.add(hat);
    agent.flair = star;
  } else if (brandId === 'codex') {
    // Codex: 궁궐(흑립 갓+어사화), 한옥(대나무 삿갓+에메랄드 구슬), 기본/스타십(사이버 바이저+육각 헤드셋 + App 헤드밴드 / CLI 챙)
    const visor = new THREE.Mesh(VISOR, agent.accentMat);
    visor.position.set(0, 0.02, 0.03);
    visor.rotation.set(Math.PI / 2, 0, -Math.PI * 0.34);
    bg.add(visor);
    if (style === 'palace') {
      const brim = new THREE.Mesh(GAT_BRIM, GAT_MAT);
      brim.position.set(0, 0.24, 0);
      const top = new THREE.Mesh(GAT_CROWN, GAT_MAT);
      top.position.set(0, 0.36, 0);
      bg.add(brim, top);
    } else if (style === 'hanok') {
      const cone = new THREE.Mesh(SATGAT, BAMBOO_MAT);
      cone.position.set(0, 0.32, 0);
      bg.add(cone);
    } else {
      if (agent.surface === 'app') {
        const band = new THREE.Mesh(HEADBAND, agent.accentMat);
        band.position.set(0, 0.02, 0);
        bg.add(band);
      } else if (agent.surface === 'cli') {
        const bill = new THREE.Mesh(BILL, agent.accentMat);
        bill.position.set(0, 0.17, 0.24);
        bill.rotation.x = 0.12;
        bg.add(bill);
      }
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(EAR_HEX, agent.legsMat);
        ear.position.set(sx * 0.31, 0.02, 0);
        ear.rotation.z = Math.PI / 2;
        bg.add(ear);
      }
    }
    const gem = new THREE.Mesh(GEM, agent.accentMat);
    gem.position.set(0, style === 'palace' ? 0.56 : 0.46, 0);
    bg.add(gem);
    agent.flair = gem;
  } else if (brandId === 'grok') {
    // Grok: 궁궐(사모 관모+혼천의 고리), 한옥(전립+반딧불 고리), 기본/스타십(다크 셰이드+토성 궤도 링)
    const shade = new THREE.Mesh(VISOR, EYE_MAT);
    shade.position.set(0, 0.03, 0.03);
    shade.rotation.set(Math.PI / 2, 0, -Math.PI * 0.34);
    bg.add(shade);
    if (style === 'palace' || style === 'hanok') {
      const cap = new THREE.Mesh(BERET, GAT_MAT);
      cap.position.set(0, 0.25, 0);
      bg.add(cap);
      if (style === 'palace') {
        const wings = new THREE.Mesh(PROP_BLADE, GAT_MAT);
        wings.scale.set(1.4, 1.8, 1.5);
        wings.position.set(0, 0.24, -0.14);
        bg.add(wings);
      }
    }
    const orbit = new THREE.Group();
    orbit.position.set(0, 0.14, 0);
    orbit.rotation.set(1.22, 0.3, -0.32);
    const ring = new THREE.Mesh(ORBIT_RING, style === 'palace' ? GOLD_MAT : agent.accentMat);
    const moon = new THREE.Mesh(HAND, agent.accentMat);
    moon.scale.setScalar(0.65);
    moon.position.set(0.43, 0, 0);
    orbit.add(ring, moon);
    bg.add(orbit);
    agent.flair = orbit;
  } else if (brandId === 'antigravity') {
    // Antigravity: 발밑 반중력/구름/파문 링 + 머리 위 프리즘 + CLI/App 또는 방건/망건
    const lev = new THREE.Mesh(LEV_RING, agent.accentMat);
    lev.rotation.x = Math.PI / 2;
    lev.position.set(0, 0.05, 0);
    agent.rig.add(lev);
    agent.baseRing = lev;
    if (style === 'palace') {
      const crown = new THREE.Mesh(GAT_CROWN, GOLD_MAT);
      crown.scale.set(0.85, 0.85, 0.85);
      crown.position.set(0, 0.28, 0);
      bg.add(crown);
    } else if (style === 'hanok') {
      const band = new THREE.Mesh(BELT, GAT_MAT);
      band.rotation.x = Math.PI / 2;
      band.position.set(0, 0.14, 0);
      bg.add(band);
    } else if (agent.surface === 'cli') {
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
    prism.position.set(0, 0.5, 0);
    bg.add(prism);
    agent.flair = prism;
  }

  if (agent.isSub) {
    const prop = new THREE.Group();
    prop.position.set(0, brandId === 'antigravity' || brandId === 'codex' ? 0.68 : 0.42, 0);
    const stem = new THREE.Mesh(PROP_STEM, agent.legsMat);
    const blade = new THREE.Mesh(PROP_BLADE, style === 'palace' ? GOLD_MAT : agent.accentMat);
    blade.position.y = 0.07;
    prop.add(stem, blade);
    bg.add(prop);
    agent.propeller = blade;
  } else {
    agent.propeller = null;
  }
  applyPostureRig(agent, style, effPosture, mats().skin);
}

// agent 에 group, rig, head, legs, arms, pickMeshes, bodyMat, legsMat 를 붙인다.
export function buildAgentMesh(agent) {
  const M = mats();
  agent.bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 });
  agent.legsMat = new THREE.MeshStandardMaterial({ roughness: 0.72 });
  const g = agent.group = new THREE.Group();
  const rig = agent.rig = new THREE.Group();
  g.add(rig);

  const torso = agent.torsoMesh = new THREE.Mesh(CAPSULE, agent.bodyMat);
  torso.position.y = 0.78;
  const collar = agent.collarMesh = new THREE.Mesh(COLLAR, M.wall);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.09;
  const pack = agent.packMesh = new THREE.Mesh(PACK, agent.legsMat);
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

// 캐릭터 팔다리·고개·브랜드 장식 애니메이션 (2족 보행 및 4족 대각선 트로트 보행·발성·꼬리 모션).
export function animateAgentMesh(agent, reduced = false) {
  const t = agent.t;
  const isTetra = agent.posture === 'tetrapod';
  const isCat = agent.charFamily ? agent.charFamily === 'cats' : activeCharThemeOf() === 'cats';
  let leg = 0;
  let armL = 0;
  let armR = 0;
  let bob = 0;
  let tilt = 0;
  let headPitch = 0;
  let shake = 0;
  let rigPitch = 0;
  let legSym = false;
  const m = agent.maneuver;
  if (m && m.dur > 0 && !reduced) {
    const u = Math.min(1, Math.max(0, m.t / m.dur));
    const arc = Math.sin(u * Math.PI);
    const ease = u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2;
    bob = arc * (m.height || 0.9);
    if (m.kind === 'roll' || m.kind === 'flip') {
      rigPitch = ease * Math.PI * 2;
      leg = 0.85 * arc;
      legSym = true;
      armL = armR = (isTetra ? -0.9 : -1.9) * arc;
    } else if (m.kind === 'jump') {
      rigPitch = Math.sin(u * Math.PI * 2) * 0.28;
      leg = 0.72 * arc;
      legSym = true;
      armL = armR = (isTetra ? -0.65 : -2.1) * arc;
    } else if (m.kind === 'prop-fly' || m.kind === 'phase') {
      tilt = Math.sin(u * Math.PI * 2) * 0.16;
      leg = Math.sin(t * 24) * 0.35;
      armL = armR = (isTetra ? -0.45 : -1.4) * arc;
    }
  } else if (agent.path.length) {
    const f = (isTetra ? 10.5 : 9.5) * (1 + Math.min(agent.queue.length, 6) * 0.24);
    leg = Math.sin(t * f) * 0.64;
    armL = isTetra ? leg : -leg * 0.85;
    armR = isTetra ? -leg : leg * 0.85;
    bob = Math.abs(Math.sin(t * f)) * 0.058;
    tilt = Math.sin(t * f * 0.5) * 0.055;
  } else if (isTetra) {
    switch (agent.mode) {
      case 'work':
        armL = isCat ? Math.max(0, Math.sin(t * 8)) * -0.45 : -0.35 + Math.sin(t * 18) * 0.32;
        armR = isCat ? Math.max(0, -Math.sin(t * 8)) * -0.45 : -0.35 + Math.cos(t * 18) * 0.32;
        bob = Math.abs(Math.sin(t * 6)) * 0.018;
        break;
      case 'think':
        tilt = 0.26 * Math.sin(t * 2.2) + 0.16;
        bob = Math.sin(t * 2) * 0.016;
        break;
      case 'write':
        armR = -0.55 + Math.sin(t * 14) * 0.28;
        tilt = 0.12;
        break;
      case 'ask':
        armL = -0.65;
        armR = -0.65;
        headPitch = -0.18 + Math.sin(t * 6) * 0.1;
        bob = Math.abs(Math.sin(t * 5)) * 0.032;
        break;
      default:
        bob = Math.sin(t * 2.4) * 0.016;
        tilt = Math.sin(t * 1.2) * 0.03;
    }
  } else {
    switch (agent.mode) {
      case 'work':
        armL = -1.1 + Math.sin(t * 22) * 0.2;
        armR = -1.1 + Math.cos(t * 19) * 0.2;
        bob = Math.abs(Math.sin(t * 6)) * 0.018;
        break;
      case 'think':
        armR = -2.3;
        tilt = 0.22;
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
  if (agent.soundT > 0 && !reduced) {
    headPitch = -0.22 * Math.abs(Math.sin(t * 16));
    bob += Math.abs(Math.sin(t * 14)) * 0.04;
  }
  if (agent.panicT > 0) {
    armL = (isTetra ? -0.9 : -2.6) + Math.sin(t * 30) * 0.3;
    armR = (isTetra ? -0.9 : -2.6) - Math.sin(t * 30) * 0.3;
    shake = reduced ? 0 : Math.sin(t * 70) * 0.04;
  }
  const floatOffset = agent.agent === 'antigravity' && !reduced ? 0.03 + Math.sin(t * 3.2) * 0.025 : 0;
  const pivotY = isTetra ? 0.56 : 0.78;
  agent.legs[0].rotation.x = leg;
  agent.legs[1].rotation.x = legSym ? leg : -leg;
  agent.arms[0].rotation.x = armL;
  agent.arms[1].rotation.x = armR;
  agent.rig.rotation.x = rigPitch;
  agent.rig.position.y = (reduced ? 0 : bob + pivotY * (1 - Math.cos(rigPitch))) + floatOffset;
  agent.rig.position.z = reduced ? 0 : -pivotY * Math.sin(rigPitch);
  agent.rig.position.x = shake;
  agent.head.rotation.z = tilt;
  agent.head.rotation.x = headPitch;
  if (agent.baseRing) {
    const ringScale = m?.kind === 'phase' && !reduced ? 1 + Math.sin((m.t / m.dur) * Math.PI) * 0.42 : 1;
    agent.baseRing.scale.setScalar(ringScale);
  }
  if (!reduced && agent.flair && !agent.tailPivot) {
    agent.flair.rotation.y = t * (m?.kind === 'phase' ? 6.4 : 1.8);
    if (agent.agent === 'antigravity' || agent.agent === 'codex') {
      agent.flair.position.y = (agent.agent === 'antigravity' ? 0.48 : 0.43) + Math.sin(t * 3.2) * 0.025;
    }
  }
  animateTail(agent, reduced);
  if (!reduced && agent.propeller) {
    agent.propeller.rotation.y = t * (m?.kind === 'prop-fly' ? 48 : agent.path.length ? 18 : 7);
  }
}
