// 강아지(dogs) · 고양이(cats) 테마 전용 3D 품종 조형(귀·주둥이·코·수염·반달가슴/점박이 무늬·목줄 방울·꼬리), 2족/4족 자세 변환, 꼬리 모션.
import * as THREE from 'three';
import { pickPetBreed } from './sound.js';

export { pickPetBreed };

const SNOUT_DOG = new THREE.CapsuleGeometry(0.115, 0.11, 6, 12);
const SNOUT_PUFF = new THREE.SphereGeometry(0.082, 10, 8);
const NOSE_DOG = new THREE.SphereGeometry(0.048, 10, 8);
const NOSE_CAT = new THREE.ConeGeometry(0.038, 0.036, 3);
const TONGUE = new THREE.BoxGeometry(0.065, 0.055, 0.024);
const EAR_PRICK = new THREE.ConeGeometry(0.115, 0.25, 12);
const EAR_INNER = new THREE.ConeGeometry(0.068, 0.16, 10);
const EAR_FLOP = new THREE.CapsuleGeometry(0.072, 0.18, 6, 10);
const EAR_FOLD = new THREE.SphereGeometry(0.085, 10, 8);
const COLLAR_RING = new THREE.TorusGeometry(0.235, 0.034, 8, 20);
const BELL = new THREE.SphereGeometry(0.052, 10, 8);
const CHEST_BIB = new THREE.SphereGeometry(0.22, 12, 10);
const CRESCENT_ARM = new THREE.BoxGeometry(0.16, 0.052, 0.04);
const BROW_DOT = new THREE.SphereGeometry(0.038, 8, 6);
const BLAZE_BOX = new THREE.BoxGeometry(0.065, 0.22, 0.06);
const SPOT_DISC = new THREE.SphereGeometry(0.055, 8, 6);
const WHISKER = new THREE.CylinderGeometry(0.005, 0.005, 0.22, 6);
const RUFF_RING = new THREE.TorusGeometry(0.26, 0.075, 10, 20);
const TAIL_LONG = new THREE.CapsuleGeometry(0.055, 0.34, 6, 10);
const TAIL_CURL = new THREE.TorusGeometry(0.145, 0.052, 10, 20, Math.PI * 1.35);
const TAIL_BOB = new THREE.SphereGeometry(0.085, 10, 8);

const DARK_NOSE = new THREE.MeshStandardMaterial({ color: 0x181a20, roughness: 0.35 });
const PINK_MAT = new THREE.MeshStandardMaterial({ color: 0xf48fb1, roughness: 0.55 });
const WHITE_FUR = new THREE.MeshStandardMaterial({ color: 0xfaf8f5, roughness: 0.65 });
const CREAM_FUR = new THREE.MeshStandardMaterial({ color: 0xfdf0d5, roughness: 0.65 });
const TAN_FUR = new THREE.MeshStandardMaterial({ color: 0xd98a3c, roughness: 0.6 });
const SPOT_MAT = new THREE.MeshStandardMaterial({ color: 0x362212, roughness: 0.65 });
const SEAL_MAT = new THREE.MeshStandardMaterial({ color: 0x3b2820, roughness: 0.6 });
const WHISKER_MAT = new THREE.MeshBasicMaterial({ color: 0xfaf8f5 });
const GOLD_BELL = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.25, metalness: 0.75 });

export const DOG_BREEDS = Object.freeze({
  golden:      Object.freeze({ body: 0xe5a93c, legs: 0xc98a2c, ear: 'flop',  tail: 'long', bib: 'cream' }),
  labrador:    Object.freeze({ body: 0xf0d394, legs: 0xd8b46c, ear: 'flop',  tail: 'long', bib: 'none' }),
  'jindo-white': Object.freeze({ body: 0xfaf6ee, legs: 0xede3d2, ear: 'prick', tail: 'curl', bib: 'white' }),
  'jindo-black': Object.freeze({ body: 0x1f232b, legs: 0x15181f, ear: 'prick', tail: 'curl', bib: 'none' }),
  'jindo-bear':  Object.freeze({ body: 0x171a21, legs: 0xd98a3c, ear: 'prick', tail: 'curl', bib: 'crescent', tanBrows: true }),
  collie:      Object.freeze({ body: 0x1b1e24, legs: 0xfaf8f5, ear: 'semi',  tail: 'long', bib: 'white', blaze: true }),
  corgi:       Object.freeze({ body: 0xe0823d, legs: 0xfaf8f5, ear: 'prick', tail: 'bob',  bib: 'white', blaze: true }),
  shiba:       Object.freeze({ body: 0xd97834, legs: 0xfdf0d5, ear: 'prick', tail: 'curl', bib: 'cream', tanBrows: true }),
});

export const CAT_BREEDS = Object.freeze({
  savannah:  Object.freeze({ body: 0xe2b468, legs: 0xc99648, ear: 'serval', tail: 'cat',   bib: 'cream', spots: true, eye: 0xf59e0b }),
  mainecoon: Object.freeze({ body: 0xc8643b, legs: 0xa34824, ear: 'serval', tail: 'plume', bib: 'ruff',  eye: 0xf59e0b }),
  bengal:    Object.freeze({ body: 0xd97e32, legs: 0xb8621e, ear: 'cat',    tail: 'cat',   bib: 'cream', spots: true, eye: 0x10b981 }),
  persian:   Object.freeze({ body: 0xf4f7f6, legs: 0xb8c9c4, ear: 'cat',    tail: 'plume', bib: 'ruff',  eye: 0x14b8a6 }),
  british:   Object.freeze({ body: 0x75889c, legs: 0x5e7084, ear: 'cat',    tail: 'cat',   bib: 'none',  eye: 0xf59e0b }),
  siamese:   Object.freeze({ body: 0xf5ebd6, legs: 0x3b2820, ear: 'seal',   tail: 'seal',  bib: 'none',  sealMask: true, eye: 0x38bdf8 }),
  ragdoll:   Object.freeze({ body: 0xfaf8f5, legs: 0x8a9eb5, ear: 'blue',   tail: 'plume', bib: 'ruff',  eye: 0x3b82f6 }),
  fold:      Object.freeze({ body: 0xf2b365, legs: 0xfaf8f5, ear: 'fold',   tail: 'cat',   bib: 'white', eye: 0x10b981 }),
});

export function applyPetMesh(agent, theme, posture = 'tetrapod', explicitBreed = '') {
  const isDog = theme === 'dogs' || String(theme).startsWith('dog:');
  const isTetra = posture === 'tetrapod';
  const breedKey = explicitBreed || pickPetBreed(agent, theme);
  const spec = isDog ? (DOG_BREEDS[breedKey] || DOG_BREEDS.golden) : (CAT_BREEDS[breedKey] || CAT_BREEDS.savannah);

  agent.bodyMat.color.setHex(spec.body);
  agent.legsMat.color.setHex(spec.legs);
  if (!agent.petHeadMat) agent.petHeadMat = new THREE.MeshStandardMaterial({ roughness: 0.58 });
  agent.petHeadMat.color.setHex(spec.body);
  agent.head.material = agent.petHeadMat;
  if (agent.packMesh) agent.packMesh.visible = false;

  const cg = agent.costumeGroup;
  const bg = agent.flair;

  // 목줄(브랜드 컬러) + 금방울 인식표
  const collar = new THREE.Mesh(COLLAR_RING, agent.accentMat);
  collar.rotation.x = isTetra ? Math.PI * 0.28 : Math.PI / 2;
  collar.position.set(0, isTetra ? 0.69 : 1.1, isTetra ? 0.29 : 0);
  const bell = new THREE.Mesh(BELL, GOLD_BELL);
  bell.position.set(0, isTetra ? 0.52 : 1.05, isTetra ? 0.42 : 0.25);
  cg.add(collar, bell);

  // 가슴털 / 반달가슴곰(네눈박이) 반달 무늬 / 랙돌 목 갈기 / 표범 로제트 점무늬
  if (spec.bib === 'white' || spec.bib === 'cream') {
    const bib = new THREE.Mesh(CHEST_BIB, spec.bib === 'white' ? WHITE_FUR : CREAM_FUR);
    bib.scale.set(isTetra ? 0.82 : 0.85, isTetra ? 0.85 : 1.1, isTetra ? 0.55 : 0.45);
    bib.position.set(0, isTetra ? 0.54 : 0.82, isTetra ? 0.33 : 0.24);
    cg.add(bib);
  } else if (spec.bib === 'crescent') {
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(CRESCENT_ARM, WHITE_FUR);
      arm.position.set(sx * 0.055, isTetra ? 0.56 : 0.86, isTetra ? 0.41 : 0.305);
      arm.rotation.z = sx * 0.48;
      cg.add(arm);
    }
  } else if (spec.bib === 'ruff') {
    const ruff = new THREE.Mesh(RUFF_RING, WHITE_FUR);
    ruff.rotation.x = isTetra ? Math.PI * 0.28 : Math.PI / 2;
    ruff.position.set(0, isTetra ? 0.68 : 1.08, isTetra ? 0.27 : 0);
    cg.add(ruff);
  }
  if (spec.spots) {
    const pts = isTetra
      ? [[-0.24, 0.62, 0.08], [0.24, 0.58, -0.08], [-0.22, 0.64, -0.18], [0.22, 0.66, 0.14], [0, 0.81, -0.05]]
      : [[-0.18, 0.88, 0.26], [0.19, 0.74, 0.25], [-0.22, 0.72, -0.22], [0.2, 0.9, -0.22], [0, 0.65, -0.28]];
    for (const [x, y, z] of pts) {
      const sp = new THREE.Mesh(SPOT_DISC, SPOT_MAT);
      sp.scale.set(1, 0.85, 0.35);
      sp.position.set(x, y, z);
      cg.add(sp);
    }
  }

  // 꼬리 (활발히 흔드는 강아지 꼬리 / 말린 진돗개 꼬리 / 웰시코기 식빵 단미 / 우아한 고양이 꼬리)
  const tailPivot = agent.tailPivot = new THREE.Group();
  tailPivot.position.set(0, isTetra ? 0.66 : 0.62, isTetra ? -0.40 : -0.26);
  tailPivot.userData = { isDog, tailType: spec.tail };
  const tailMat = spec.tail === 'seal' ? SEAL_MAT : spec.tail === 'plume' ? agent.legsMat : agent.bodyMat;
  if (spec.tail === 'curl') {
    const curl = new THREE.Mesh(TAIL_CURL, tailMat);
    curl.rotation.y = Math.PI / 2;
    curl.position.set(0, 0.16, -0.08);
    tailPivot.add(curl);
  } else if (spec.tail === 'bob') {
    const bob = new THREE.Mesh(TAIL_BOB, WHITE_FUR);
    bob.position.set(0, 0.04, -0.05);
    tailPivot.add(bob);
  } else {
    const tMesh = new THREE.Mesh(TAIL_LONG, tailMat);
    tMesh.position.set(0, 0.16, -0.1);
    tMesh.rotation.x = isDog ? -0.65 : -0.35;
    if (spec.tail === 'plume') tMesh.scale.set(1.45, 1.1, 1.45);
    tailPivot.add(tMesh);
  }
  cg.add(tailPivot);

  // 머리 조형: 주둥이 · 코 · 혀/수염 · 무늬 · 품종별 귀
  if (isDog) {
    const snoutMat = spec.blaze ? WHITE_FUR : spec.tanBrows ? TAN_FUR : spec.bib === 'cream' ? CREAM_FUR : agent.petHeadMat;
    const snout = new THREE.Mesh(SNOUT_DOG, snoutMat);
    snout.rotation.x = Math.PI / 2;
    snout.scale.set(1.1, 1, 0.82);
    snout.position.set(0, -0.055, 0.25);
    const nose = new THREE.Mesh(NOSE_DOG, DARK_NOSE);
    nose.scale.set(1.15, 0.85, 0.9);
    nose.position.set(0, -0.01, 0.39);
    const tongue = new THREE.Mesh(TONGUE, PINK_MAT);
    tongue.position.set(0, -0.125, 0.33);
    tongue.rotation.x = 0.35;
    bg.add(snout, nose, tongue);
    if (spec.blaze) {
      const blaze = new THREE.Mesh(BLAZE_BOX, WHITE_FUR);
      blaze.position.set(0, 0.08, 0.28);
      bg.add(blaze);
    }
    if (spec.tanBrows) {
      for (const sx of [-1, 1]) {
        const dot = new THREE.Mesh(BROW_DOT, spec.bib === 'cream' ? CREAM_FUR : TAN_FUR);
        dot.scale.set(1.1, 0.75, 0.5);
        dot.position.set(sx * 0.105, 0.105, 0.285);
        bg.add(dot);
      }
    }
    for (const sx of [-1, 1]) {
      if (spec.ear === 'flop') {
        const flop = new THREE.Mesh(EAR_FLOP, agent.legsMat);
        flop.scale.set(0.75, 1.05, 0.45);
        flop.position.set(sx * 0.29, 0.02, 0.02);
        flop.rotation.z = sx * 0.22;
        bg.add(flop);
      } else {
        const ear = new THREE.Mesh(EAR_PRICK, agent.petHeadMat);
        ear.position.set(sx * 0.19, 0.33, 0.02);
        ear.rotation.z = -sx * (spec.ear === 'semi' ? 0.32 : 0.18);
        ear.rotation.x = spec.ear === 'semi' ? 0.28 : 0.08;
        const inner = new THREE.Mesh(EAR_INNER, PINK_MAT);
        inner.position.set(sx * 0.19, 0.31, 0.06);
        inner.rotation.copy(ear.rotation);
        bg.add(ear, inner);
      }
    }
  } else {
    if (spec.sealMask) {
      const mask = new THREE.Mesh(CHEST_BIB, SEAL_MAT);
      mask.scale.set(0.88, 0.68, 0.35);
      mask.position.set(0, -0.01, 0.24);
      bg.add(mask);
    }
    const puffMat = spec.sealMask ? SEAL_MAT : WHITE_FUR;
    for (const sx of [-1, 1]) {
      const puff = new THREE.Mesh(SNOUT_PUFF, puffMat);
      puff.scale.set(1.05, 0.82, 0.75);
      puff.position.set(sx * 0.062, -0.055, 0.265);
      bg.add(puff);
      for (const wy of [-0.04, -0.07]) {
        const w = new THREE.Mesh(WHISKER, WHISKER_MAT);
        w.rotation.z = Math.PI / 2 + sx * (wy === -0.04 ? 0.12 : -0.1);
        w.position.set(sx * 0.19, wy, 0.28);
        bg.add(w);
      }
    }
    const nose = new THREE.Mesh(NOSE_CAT, PINK_MAT);
    nose.rotation.x = Math.PI / 2;
    nose.rotation.z = Math.PI;
    nose.position.set(0, -0.02, 0.335);
    bg.add(nose);

    const earMat = spec.ear === 'seal' ? SEAL_MAT : spec.ear === 'blue' ? agent.legsMat : agent.petHeadMat;
    for (const sx of [-1, 1]) {
      if (spec.ear === 'fold') {
        const fold = new THREE.Mesh(EAR_FOLD, earMat);
        fold.scale.set(1.1, 0.55, 0.9);
        fold.position.set(sx * 0.22, 0.24, 0.08);
        fold.rotation.z = -sx * 0.55;
        fold.rotation.x = 0.4;
        bg.add(fold);
      } else {
        const tall = spec.ear === 'serval' ? 1.28 : 1.0;
        const ear = new THREE.Mesh(EAR_PRICK, earMat);
        ear.scale.set(0.95, tall, 0.75);
        ear.position.set(sx * 0.19, 0.33 * tall, 0.02);
        ear.rotation.z = -sx * 0.2;
        const inner = new THREE.Mesh(EAR_INNER, PINK_MAT);
        inner.scale.set(0.9, tall, 0.7);
        inner.position.set(sx * 0.19, 0.31 * tall, 0.055);
        inner.rotation.z = -sx * 0.2;
        bg.add(ear, inner);
      }
    }
  }
}

// 2족(bipod) ↔ 4족(tetrapod) 골격 변환: 몸통·목깃·가방·머리·앞다리(arms)·뒷다리(legs)·꼬리 위치를 재배치한다.
export function applyPostureRig(agent, theme, posture, skinMat) {
  const isTetra = posture === 'tetrapod';
  const isPet = theme === 'dogs' || theme === 'cats' || String(theme).startsWith('dog:') || String(theme).startsWith('cat:');
  agent.posture = isTetra ? 'tetrapod' : 'bipod';

  if (agent.torsoMesh) {
    agent.torsoMesh.position?.set(0, isTetra ? 0.56 : 0.78, 0);
    agent.torsoMesh.rotation?.set(isTetra ? Math.PI / 2 : 0, 0, 0);
    agent.torsoMesh.scale?.set(isTetra ? 0.88 : 1, isTetra ? 1.08 : 1, isTetra ? 0.84 : 1);
  }
  if (agent.collarMesh) {
    agent.collarMesh.visible = !isPet && !isTetra;
  }
  if (agent.packMesh) {
    agent.packMesh.position?.set(0, isTetra ? 0.84 : 0.78, isTetra ? -0.02 : -0.23);
    agent.packMesh.rotation?.set(isTetra ? -Math.PI / 2 : 0, 0, 0);
  }
  if (agent.head) {
    agent.head.position?.set(0, isTetra ? 0.88 : 1.44, isTetra ? 0.40 : 0);
    agent.head.rotation?.set(0, 0, 0);
  }
  if (agent.legs?.length === 2) {
    agent.legs[0].position?.set(isTetra ? -0.17 : -0.13, 0.44, isTetra ? -0.23 : 0);
    agent.legs[1].position?.set(isTetra ? 0.17 : 0.13, 0.44, isTetra ? -0.23 : 0);
  }
  if (agent.arms?.length === 2) {
    agent.arms[0].position?.set(isTetra ? -0.17 : -0.38, isTetra ? 0.42 : 1.02, isTetra ? 0.24 : 0);
    agent.arms[1].position?.set(isTetra ? 0.17 : 0.38, isTetra ? 0.42 : 1.02, isTetra ? 0.24 : 0);
    for (const arm of agent.arms) {
      if (arm.userData?.tip && skinMat) {
        arm.userData.tip.material = (isPet || isTetra) ? agent.legsMat : skinMat;
      }
    }
  }
  if (isTetra && !agent.tailPivot && agent.costumeGroup) {
    const tp = agent.tailPivot = new THREE.Group();
    tp.position.set(0, 0.66, -0.40);
    tp.userData = { isDog: true, tailType: 'long' };
    const tMesh = new THREE.Mesh(TAIL_LONG, agent.bodyMat);
    tMesh.position.set(0, 0.16, -0.1);
    tMesh.rotation.x = -0.55;
    tp.add(tMesh);
    agent.costumeGroup.add(tp);
  } else if (agent.tailPivot) {
    agent.tailPivot.position?.set(0, isTetra ? 0.66 : 0.62, isTetra ? -0.40 : -0.26);
  }
}

// 상태별 꼬리 흔들기 모션: 대기(진자/S자), 이동(경쾌한 흔들기/수직 안테나), 질문·발성(프로펠러 8자), 에러(내림/부풀림).
export function animateTail(agent, reduced = false) {
  const tp = agent.tailPivot;
  if (!tp) return;
  if (reduced) {
    tp.rotation.set(0, 0, 0);
    tp.scale.setScalar(1);
    return;
  }
  const t = agent.t || 0;
  const isDog = tp.userData?.isDog !== false;
  const excited = agent.mode === 'ask' || agent.soundT > 0;
  const panic = agent.panicT > 0;
  const walking = agent.path?.length > 0;

  if (isDog) {
    tp.scale.setScalar(1);
    if (panic) {
      tp.rotation.set(-0.72, 0, Math.sin(t * 28) * 0.12);
    } else if (excited) {
      tp.rotation.set(0.24 + Math.cos(t * 22) * 0.22, Math.cos(t * 22) * 0.42, Math.sin(t * 22) * 0.72);
    } else if (walking) {
      tp.rotation.set(0.12, Math.cos(t * 15) * 0.24, Math.sin(t * 15) * 0.52);
    } else {
      const f = agent.mode === 'work' ? 11.5 : 7.5;
      const amp = agent.mode === 'work' ? 0.48 : 0.36;
      tp.rotation.set(0, Math.sin(t * f) * amp * 0.35, Math.sin(t * f) * amp);
    }
  } else if (panic) {
    tp.scale.set(1.45, 1.15, 1.45);
    tp.rotation.set(0.45, 0, Math.sin(t * 32) * 0.18);
  } else {
    tp.scale.setScalar(1);
    if (excited) {
      tp.rotation.set(0.38 + Math.sin(t * 10) * 0.12, Math.cos(t * 8) * 0.2, Math.sin(t * 16) * 0.42);
    } else if (walking) {
      tp.rotation.set(0.32, Math.cos(t * 6.5) * 0.14, Math.sin(t * 6.5) * 0.24);
    } else {
      tp.rotation.set(Math.sin(t * 1.7) * 0.12, Math.cos(t * 1.7) * 0.28, Math.sin(t * 3.4) * 0.38);
    }
  }
}
