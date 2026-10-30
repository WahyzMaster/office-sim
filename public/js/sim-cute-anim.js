// 방(location)별·캐릭터 패밀리별·보행 자세별 디테일 귀여운 모션(Squash & Stretch, 3단계 마이크로 스토리, 손 소품).
import * as THREE from 'three';

export const MICRO_PROP_KEYS = Object.freeze(['book', 'clipboard', 'mug', 'magnifier', 'wrench', 'wand', 'sign']);

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
function meshAt(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rx || ry || rz) m.rotation.set(rx, ry, rz);
  return m;
}
function groupOf(rx = 0, ...children) {
  const g = new THREE.Group();
  if (rx) g.rotation.x = rx;
  g.add(...children);
  g.visible = false;
  return g;
}

// 모듈 단위로 한 번만 생성해 모든 에이전트가 공유하는 소품 기하·재질 (GPU 메모리 누수 0 보장)
let SHARED_PROPS = null;
function getSharedPropAssets() {
  if (SHARED_PROPS) return SHARED_PROPS;
  SHARED_PROPS = {
    geo: {
      cover: new THREE.BoxGeometry(0.11, 0.15, 0.018),
      page: new THREE.BoxGeometry(0.095, 0.135, 0.012),
      board: new THREE.BoxGeometry(0.13, 0.17, 0.018),
      clip: new THREE.BoxGeometry(0.05, 0.025, 0.024),
      mugBody: new THREE.CylinderGeometry(0.052, 0.046, 0.11, 10),
      mugTop: new THREE.CylinderGeometry(0.046, 0.046, 0.012, 10),
      mugHandle: new THREE.TorusGeometry(0.032, 0.009, 6, 12, Math.PI),
      magRim: new THREE.TorusGeometry(0.068, 0.014, 8, 18),
      magLens: new THREE.CylinderGeometry(0.062, 0.062, 0.01, 14),
      rod: new THREE.CylinderGeometry(0.014, 0.014, 0.18, 8),
      wandRod: new THREE.CylinderGeometry(0.01, 0.014, 0.28, 8),
      wandTip: new THREE.SphereGeometry(0.026, 8, 8),
      wrenchShaft: new THREE.BoxGeometry(0.028, 0.18, 0.018),
      wrenchJaw: new THREE.TorusGeometry(0.038, 0.014, 6, 12, Math.PI * 1.35),
      signPlate: new THREE.BoxGeometry(0.16, 0.12, 0.022),
    },
    mat: {
      bookCover: new THREE.MeshStandardMaterial({ color: 0x3b6ea8, roughness: 0.55 }),
      creamPage: new THREE.MeshStandardMaterial({ color: 0xfdf4dc, roughness: 0.65 }),
      woodBoard: new THREE.MeshStandardMaterial({ color: 0xc28b52, roughness: 0.65 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xe0a838, roughness: 0.3, metalness: 0.6 }),
      mugCeramic: new THREE.MeshStandardMaterial({ color: 0xfaf6ee, roughness: 0.35 }),
      coffee: new THREE.MeshStandardMaterial({ color: 0x5c3820, roughness: 0.4 }),
      lens: new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.15, transparent: true, opacity: 0.72 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.28, metalness: 0.72 }),
      wandWood: new THREE.MeshStandardMaterial({ color: 0x8c4a27, roughness: 0.55 }),
      amberGlow: new THREE.MeshStandardMaterial({ color: 0xffb830, emissive: 0xff9800, emissiveIntensity: 0.65, roughness: 0.25 }),
    },
  };
  return SHARED_PROPS;
}

// 에이전트 양손 끝에 소품 그룹을 한 번만 부착하고 .visible 토글로만 제어한다.
export function ensureAgentMicroProps(agent) {
  if (!agent?.arms || agent.arms.length < 2) return null;
  const [armL, armR] = agent.arms;
  if (agent.microProps && agent.microProps.armL === armL && agent.microProps.armR === armR) return agent.microProps;
  const { geo: g, mat: m } = getSharedPropAssets();
  const holderL = new THREE.Group();
  holderL.position.set(0, -0.40, 0.08);
  const holderR = new THREE.Group();
  holderR.position.set(0, -0.40, 0.08);

  const bookFlipPage = meshAt(g.page, m.creamPage, 0.044, 0, 0.012, 0, -0.26, 0);
  const book = groupOf(0.55, meshAt(g.cover, m.bookCover, -0.048, 0, 0, 0, 0.28), meshAt(g.cover, m.bookCover, 0.048, 0, 0, 0, -0.28), meshAt(g.page, m.creamPage, -0.044, 0, 0.01, 0, 0.26), bookFlipPage);
  const clipboard = groupOf(0.45, meshAt(g.board, m.woodBoard), meshAt(g.page, m.creamPage, 0, -0.005, 0.012), meshAt(g.clip, m.gold, 0, 0.072, 0.014));
  const mug = groupOf(Math.PI / 2, meshAt(g.mugBody, m.mugCeramic), meshAt(g.mugTop, m.coffee, 0, 0.052, 0), meshAt(g.mugHandle, m.mugCeramic, 0.05, 0, 0, 0, 0, -Math.PI / 2));
  const mRod = meshAt(g.rod, m.wandWood);
  mRod.scale.set(0.8, 0.65, 0.8);
  const magnifier = groupOf(Math.PI / 2.2, meshAt(g.magRim, m.gold, 0, 0.11, 0), meshAt(g.magLens, m.lens, 0, 0.11, 0, Math.PI / 2), mRod);
  const wrench = groupOf(Math.PI / 2.4, meshAt(g.wrenchShaft, m.chrome, 0, 0.04, 0), meshAt(g.wrenchJaw, m.chrome, 0, 0.145, 0, 0, 0, 0.4));
  const wand = groupOf(Math.PI / 2.3, meshAt(g.wandRod, m.wandWood, 0, 0.11, 0), meshAt(g.wandTip, m.amberGlow, 0, 0.255, 0));
  const sign = groupOf(0, meshAt(g.rod, m.wandWood, 0, 0.05, 0), meshAt(g.signPlate, m.amberGlow, 0, 0.16, 0));

  holderL.add(book, clipboard);
  holderR.add(mug, magnifier, wrench, wand, sign);
  armL.add(holderL);
  armR.add(holderR);
  agent.microProps = { armL, armR, holderL, holderR, book, bookFlipPage, clipboard, mug, magnifier, wrench, wand, sign };
  return agent.microProps;
}

function volumeSquash(sy) {
  const clamped = Math.max(0.84, Math.min(1.18, sy));
  const sxz = 1 - (clamped - 1) * 0.5;
  return v3(sxz, clamped, sxz);
}

// 순수 수학 안무 계산기: Node 테스트에서도 WebGL 없이 7개 방 × 2자세 × 4패밀리 동작을 검증할 수 있다.
export function computeStationChoreography(opts = {}) {
  const { room = 'lounge', mode = 'idle', isTetra = false, charFamily = 'human', t = 0, joyProgress = 0, reduced = false } = opts;
  const isCat = charFamily === 'cats';
  const isBot = charFamily === 'bots';
  const pose = {
    armL: v3(), armR: v3(), legL: 0, legR: 0,
    head: { x: 0, y: 0, z: 0, yOffset: 0 },
    rig: { pitch: 0, yaw: 0, roll: 0, bob: 0 },
    squash: v3(1, 1, 1), propL: null, propR: null, propFlip: 0, activityBeat: 'focus',
  };

  if (joyProgress > 0 && joyProgress < 1 && !reduced) {
    const j = Math.sin(joyProgress * Math.PI);
    pose.activityBeat = 'joy';
    pose.rig.bob = j * 0.11;
    pose.squash = volumeSquash(1 + j * 0.12);
    pose.armL = v3((isTetra ? -0.92 : -2.42) * j, 0, -0.28 * j);
    pose.armR = v3((isTetra ? -0.92 : -2.42) * j, 0, 0.28 * j);
    pose.head.x = -0.18 * j;
    return pose;
  }

  const effRoom = mode === 'ask' ? 'desk' : mode === 'idle' && !room ? 'lounge' : (room || 'lounge');
  const activeWork = mode === 'work' || mode === 'write' || mode === 'think' || mode === 'ask';

  if (effRoom === 'archive' && activeWork) {
    if (isTetra) {
      if (isCat) {
        pose.head.y = reduced ? 0.18 : Math.sin(t * 2.4) * 0.34;
        pose.head.z = reduced ? 0.08 : Math.cos(t * 2.4) * 0.15;
        pose.armL.x = reduced ? -0.35 : Math.min(0, Math.sin(t * 8.5)) * 0.62;
        pose.armR.x = reduced ? -0.15 : Math.min(0, -Math.sin(t * 8.5)) * 0.62;
        pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 4.2)) * 0.02;
      } else {
        pose.head.yOffset = -0.085;
        pose.head.x = 0.32 + (reduced ? 0 : Math.sin(t * 18) * 0.055);
        pose.head.y = reduced ? 0.15 : Math.sin(t * 3.1) * 0.26;
        pose.rig.pitch = 0.08;
        pose.armL.x = reduced ? -0.4 : -0.42 + Math.sin(t * 19) * 0.32;
        pose.armR.x = reduced ? -0.2 : -0.42 + Math.cos(t * 19) * 0.32;
        if (!reduced) pose.squash = volumeSquash(1 + Math.sin(t * 9.5) * 0.03);
      }
    } else {
      pose.propL = 'book';
      pose.armL = v3(-1.04, 0.18, 0.28);
      const cyc = t % 4.0;
      if (reduced || cyc < 2.6) {
        pose.head.y = reduced ? 0.18 : Math.sin(t * 2.6) * 0.28;
        pose.head.x = 0.16 + (reduced ? 0 : Math.sin(t * 5.2) * 0.04);
        pose.armR = v3(-0.92 + (reduced ? 0 : Math.sin(t * 7) * 0.08), -0.14, -0.22);
        pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 4)) * 0.015;
      } else if (cyc < 3.1) {
        const p = (cyc - 2.6) / 0.5;
        pose.activityBeat = 'windup';
        pose.rig.pitch = 0.08 * p;
        pose.head.x = 0.22;
        pose.armR = v3(-1.02, -0.1, -0.34);
        pose.squash = volumeSquash(1 - 0.05 * p);
      } else {
        const arc = Math.sin(((cyc - 3.1) / 0.9) * Math.PI);
        pose.activityBeat = 'delight';
        pose.propFlip = arc * 1.15;
        pose.armR = v3(-1.08 - arc * 0.18, -0.12 + arc * 0.24, -0.34 + arc * 0.56);
        pose.head.x = 0.18 - arc * 0.08;
        pose.squash = volumeSquash(1 + arc * 0.045);
      }
    }
    return pose;
  }

  if (effRoom === 'dev' && activeWork) {
    if (isTetra) {
      pose.rig.pitch = -0.08;
      pose.rig.bob = reduced ? 0 : 0.025 + Math.abs(Math.sin(t * 13)) * 0.024;
      pose.armL = v3(reduced ? -0.78 : -0.82 + Math.sin(t * 26) * 0.28, 0, 0.16);
      pose.armR = v3(reduced ? -0.68 : -0.82 - Math.sin(t * 26) * 0.28, 0, -0.16);
      pose.head.y = reduced ? 0.12 : Math.sin(t * 2.8) * 0.18;
      pose.head.x = 0.08;
      if (!reduced) pose.squash = volumeSquash(1 + Math.sin(t * 13) * 0.034);
    } else {
      const cyc = t % 4.5;
      if (reduced || cyc < 3.1) {
        const speed = isBot ? 34 : 28;
        pose.armL = v3(-1.08 + (reduced ? 0 : Math.sin(t * speed) * 0.16), 0.12, 0.26);
        pose.armR = v3(-1.08 + (reduced ? 0 : Math.cos(t * speed) * 0.16), -0.12, -0.26);
        pose.head.y = reduced ? -0.12 : Math.sin(t * 1.9) * 0.20;
        pose.head.x = 0.09;
        pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 11)) * 0.022;
        if (!reduced) pose.squash = volumeSquash(1 + Math.sin(t * 11) * 0.035);
      } else if (cyc < 3.5) {
        pose.activityBeat = 'windup';
        pose.propR = 'mug';
        pose.armL = v3(-0.95, 0.1, 0.22);
        pose.armR = v3(-1.15, -0.16, -0.22);
        pose.squash = volumeSquash(0.96);
      } else {
        const sip = Math.sin(((cyc - 3.5) / 1.0) * Math.PI);
        pose.activityBeat = 'delight';
        pose.propR = 'mug';
        pose.armL = v3(-0.88, 0.1, 0.20);
        pose.armR = v3(-1.15 - sip * 0.38, -0.22, -0.28);
        pose.head.x = -0.16 * sip;
        pose.squash = volumeSquash(1 + sip * 0.04);
      }
    }
    return pose;
  }

  if (effRoom === 'server' && activeWork) {
    if (isTetra) {
      const cyc = t % 3.4;
      if (reduced || cyc < 2.3) {
        pose.activityBeat = 'windup';
        pose.rig.pitch = 0.14;
        pose.rig.roll = reduced ? 0 : Math.sin(t * 22) * 0.06;
        pose.armL.x = -0.68;
        pose.armR.x = -0.68;
        pose.head.x = -0.14;
        if (!reduced) pose.squash = volumeSquash(0.92);
      } else {
        const hop = Math.sin(((cyc - 2.3) / 1.1) * Math.PI);
        pose.activityBeat = 'delight';
        pose.rig.bob = hop * 0.085;
        pose.rig.pitch = -0.06 * hop;
        pose.armL.x = -0.68 - hop * 0.42;
        pose.armR.x = -0.68 - hop * 0.42;
        pose.squash = volumeSquash(1 + hop * 0.08);
      }
    } else {
      pose.propR = 'wrench';
      const cyc = t % 3.8;
      if (reduced || cyc < 2.4) {
        pose.rig.pitch = 0.08;
        pose.armL = v3(-0.85, 0, 0.16);
        pose.armR = v3(-1.22 + (reduced ? 0 : Math.sin(t * 11) * 0.30), 0.12, reduced ? -0.15 : Math.cos(t * 11) * 0.22);
        pose.propFlip = reduced ? 0 : Math.sin(t * 11) * 0.45;
        pose.head.x = -0.14 + (reduced ? 0 : Math.sin(t * 2.4) * 0.22);
        pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 5.5)) * 0.018;
      } else if (cyc < 2.9) {
        pose.activityBeat = 'windup';
        pose.rig.pitch = 0.11;
        pose.armL = v3(-1.08, 0, 0.2);
        pose.armR = v3(-1.12, 0, -0.2);
        pose.squash = volumeSquash(0.93);
      } else {
        const pump = Math.sin(((cyc - 2.9) / 0.9) * Math.PI);
        pose.activityBeat = 'delight';
        pose.rig.bob = pump * 0.055;
        pose.armL = v3(-0.75, 0, 0.14);
        pose.armR = v3(-1.4 - pump * 0.95, 0, 0.18 * pump);
        pose.head.x = -0.15 * pump;
        pose.squash = volumeSquash(1 + pump * 0.07);
      }
    }
    return pose;
  }

  if (effRoom === 'research' && activeWork) {
    if (isTetra) {
      pose.head.yOffset = 0.065;
      pose.rig.pitch = -0.10;
      pose.head.y = reduced ? 0.22 : Math.sin(t * 1.7) * 0.38;
      pose.head.z = reduced ? 0.10 : Math.cos(t * 3.4) * 0.15;
      pose.armR.x = -0.76 + (reduced ? 0 : Math.sin(t * 5) * 0.12);
      pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 2.5)) * 0.018;
    } else {
      pose.propR = 'magnifier';
      const cyc = t % 4.2;
      if (reduced || cyc < 2.8) {
        pose.rig.pitch = 0.12;
        pose.armL = v3(-0.52, 0, 0.18);
        pose.armR = v3(-1.38 + (reduced ? 0 : Math.sin(t * 3.5) * 0.08), -0.24, -0.30);
        pose.head.y = reduced ? 0.16 : Math.cos(t * 2.1) * 0.24;
        pose.head.z = reduced ? 0.12 : Math.sin(t * 2.1) * 0.16;
        pose.head.x = 0.12;
      } else if (cyc < 3.3) {
        pose.activityBeat = 'windup';
        pose.rig.pitch = 0.17;
        pose.armR = v3(-1.42, -0.26, -0.32);
        pose.head.x = 0.18;
        pose.squash = volumeSquash(0.94);
      } else {
        const pop = Math.sin(((cyc - 3.3) / 0.9) * Math.PI);
        pose.activityBeat = 'delight';
        pose.rig.pitch = 0.12 - pop * 0.16;
        pose.rig.bob = pop * 0.07;
        pose.armL = v3(-0.52 - pop * 1.35, 0, -0.22 * pop);
        pose.armR = v3(-1.35, -0.2, -0.24);
        pose.head.x = -0.14 * pop;
        pose.squash = volumeSquash(1 + pop * 0.085);
      }
    }
    return pose;
  }

  if (effRoom === 'meeting' && activeWork) {
    if (isTetra) {
      pose.rig.pitch = -0.09;
      pose.head.y = reduced ? 0.15 : Math.sin(t * 2.0) * 0.28;
      pose.head.x = reduced ? 0.12 : Math.abs(Math.sin(t * 5.5)) * 0.18;
      pose.armR.x = -0.65 + (reduced ? 0 : Math.sin(t * 9) * 0.24);
      pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 5.5)) * 0.022;
    } else {
      pose.propL = 'clipboard';
      pose.propR = 'wand';
      pose.armL = v3(-0.88, 0.16, 0.24);
      const cyc = t % 4.0;
      if (reduced || cyc < 2.7) {
        pose.armR = v3(-1.32 + (reduced ? 0 : Math.sin(t * 4.8) * 0.28), reduced ? 0.18 : Math.cos(t * 2.4) * 0.34, -0.18 + (reduced ? 0 : Math.sin(t * 2.4) * 0.20));
        pose.rig.yaw = reduced ? 0 : Math.sin(t * 1.6) * 0.14;
        pose.head.y = reduced ? 0.12 : Math.sin(t * 2.4) * 0.18;
      } else if (cyc < 3.2) {
        pose.activityBeat = 'windup';
        pose.armR = v3(-1.05, 0, -0.12);
        pose.head.x = 0.22;
        pose.head.y = -0.18;
      } else {
        const nod = Math.abs(Math.sin(((cyc - 3.2) / 0.8) * Math.PI * 2));
        pose.activityBeat = 'delight';
        pose.armR = v3(-1.25 - nod * 0.2, 0.12, -0.15);
        pose.head.x = nod * 0.24;
        pose.squash = volumeSquash(1 + nod * 0.04);
      }
    }
    return pose;
  }

  if (effRoom === 'desk' && (mode === 'ask' || activeWork)) {
    if (isTetra) {
      pose.rig.pitch = -0.14;
      pose.armL.x = -0.45;
      pose.armR = v3(-1.18 + (reduced ? 0 : Math.sin(t * 13) * 0.28), 0, -0.15);
      pose.head.z = 0.16 + (reduced ? 0.10 : Math.sin(t * 2.8) * 0.24);
      pose.head.x = -0.18;
      pose.rig.bob = reduced ? 0 : Math.abs(Math.sin(t * 5.5)) * 0.038;
      if (!reduced) pose.squash = volumeSquash(1 + Math.abs(Math.sin(t * 5.5)) * 0.045);
    } else {
      pose.propR = 'sign';
      const hop = reduced ? 0 : Math.max(0, Math.sin(t * 5.2));
      pose.armR = v3(-2.55 + (reduced ? 0 : Math.sin(t * 6) * 0.12), 0, reduced ? 0.15 : Math.sin(t * 11) * 0.28);
      pose.armL = v3(-0.75 + (reduced ? 0 : Math.cos(t * 5.5) * 0.22), 0, -0.18);
      pose.head.z = reduced ? 0.18 : Math.sin(t * 3.2) * 0.24;
      pose.head.x = -0.12;
      pose.rig.bob = hop * 0.065;
      if (!reduced) pose.squash = volumeSquash(1 + hop * 0.06);
    }
    return pose;
  }

  const cyc = t % 8.0;
  if (isTetra) {
    if (isCat && cyc >= 2.4 && cyc < 5.4) {
      pose.activityBeat = 'delight';
      pose.armR = v3(-1.32 + (reduced ? 0 : Math.sin(t * 10) * 0.18), 0, -0.28);
      pose.head.z = -0.24;
      pose.head.x = 0.16 + (reduced ? 0 : Math.sin(t * 10) * 0.08);
      pose.rig.bob = reduced ? 0 : Math.sin(t * 2.4) * 0.014;
    } else if (!isCat && cyc >= 5.0 && cyc < 6.8) {
      pose.activityBeat = 'delight';
      pose.rig.pitch = 0.11;
      pose.armL.x = -0.62;
      pose.armR.x = -0.62;
      pose.head.x = -0.12;
      if (!reduced) pose.squash = volumeSquash(0.94);
    } else {
      pose.activityBeat = 'rest';
      pose.rig.bob = reduced ? 0 : Math.sin(t * 2.4) * 0.016;
      pose.head.z = reduced ? 0 : Math.sin(t * 1.4) * 0.08;
      if (!reduced) pose.squash = volumeSquash(1 + Math.sin(t * 2.4) * 0.024);
    }
  } else if (cyc < 4.8) {
    pose.propR = 'mug';
    const sip = cyc >= 1.8 && cyc <= 3.8 ? (reduced ? 0.8 : Math.sin(((cyc - 1.8) / 2.0) * Math.PI)) : 0;
    pose.armR = v3(-0.52 - sip * 0.92, -0.14 * sip, -0.12 - sip * 0.18);
    pose.head.x = -0.16 * sip;
    pose.head.z = reduced ? 0 : Math.sin(t * 1.4) * 0.05;
    pose.rig.roll = reduced ? 0 : Math.sin(t * 1.5) * 0.03;
    pose.rig.bob = reduced ? 0 : Math.sin(t * 2.2) * 0.016;
  } else if (cyc < 6.4) {
    pose.activityBeat = 'delight';
    const s = reduced ? 0.7 : Math.sin(((cyc - 4.8) / 1.6) * Math.PI);
    pose.armL = v3(-2.35 * s, 0, -0.36 * s);
    pose.armR = v3(-2.35 * s, 0, 0.36 * s);
    pose.head.x = -0.18 * s;
    pose.rig.bob = reduced ? 0 : s * 0.03;
    if (!reduced) pose.squash = volumeSquash(1 + s * 0.075);
  } else {
    pose.activityBeat = 'rest';
    pose.head.x = 0.14 + (reduced ? 0 : Math.abs(Math.sin(t * 2.4)) * 0.09);
    pose.head.z = reduced ? 0 : Math.sin(t * 1.2) * 0.07;
    pose.rig.bob = reduced ? 0 : Math.sin(t * 2.2) * 0.015;
    if (!reduced) pose.squash = volumeSquash(0.985 + Math.sin(t * 2.2) * 0.02);
  }
  return pose;
}

export function resetAgentCutePose(agent, isTetra = false) {
  if (agent.microProps) {
    for (const k of MICRO_PROP_KEYS) if (agent.microProps[k]) agent.microProps[k].visible = false;
  }
  if (agent.arms?.length === 2) {
    agent.arms[0].rotation.y = 0;
    agent.arms[0].rotation.z = 0;
    agent.arms[1].rotation.y = 0;
    agent.arms[1].rotation.z = 0;
  }
  if (agent.head) {
    agent.head.rotation.y = 0;
    agent.head.position.y = isTetra ? 0.88 : 1.44;
  }
  if (agent.torsoMesh?.scale) {
    agent.torsoMesh.scale.set(isTetra ? 0.88 : 1, isTetra ? 1.08 : 1, isTetra ? 0.84 : 1);
  }
}

export function applyLocationCuteAnim(agent, isTetra = false, reduced = false) {
  const t = agent.t || 0;
  if (!agent._cuteState) agent._cuteState = { lastMode: agent.mode, joyUntil: 0 };
  const st = agent._cuteState;
  if ((st.lastMode === 'work' || st.lastMode === 'write' || st.lastMode === 'ask') && agent.mode === 'idle' && !(agent.panicT > 0)) {
    st.joyUntil = t + 0.42;
  }
  st.lastMode = agent.mode;
  const joyEnd = Math.max(st.joyUntil || 0, agent.joyBurstT || 0);
  const joyProgress = joyEnd > t ? Math.max(0.15, 1 - (joyEnd - t) / 0.42) : 0;

  const pose = computeStationChoreography({
    room: agent.room || 'lounge',
    mode: agent.mode || 'idle',
    isTetra,
    charFamily: agent.charFamily || 'human',
    t,
    joyProgress,
    reduced,
  });

  const props = ensureAgentMicroProps(agent);
  if (props) {
    const hideAll = isTetra || agent.panicT > 0;
    for (const k of MICRO_PROP_KEYS) {
      if (props[k]) props[k].visible = !hideAll && (pose.propL === k || pose.propR === k);
    }
    if (props.bookFlipPage) props.bookFlipPage.rotation.y = -0.26 + pose.propFlip;
    if (props.wrench && pose.propR === 'wrench') props.wrench.rotation.z = pose.propFlip;
  }

  if (agent.arms?.length === 2) {
    agent.arms[0].rotation.set(pose.armL.x, pose.armL.y, pose.armL.z);
    agent.arms[1].rotation.set(pose.armR.x, pose.armR.y, pose.armR.z);
  }
  if (agent.head) {
    agent.head.position.y = (isTetra ? 0.88 : 1.44) + pose.head.yOffset;
    agent.head.rotation.y = pose.head.y;
  }
  if (agent.torsoMesh?.scale) {
    const { x, y, z } = pose.squash;
    if (isTetra) agent.torsoMesh.scale.set(0.88 * x, 1.08 * z, 0.84 * y);
    else agent.torsoMesh.scale.set(x, y, z);
  }
  return pose;
}
