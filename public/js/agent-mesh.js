// 직원 몸(three.js 메시)과 색칠. agent.js 가 너무 길어지지 않게 따로 뺐다.
import * as THREE from 'three';
import { mats } from './furniture.js';

const CAPSULE = new THREE.CapsuleGeometry(0.3, 0.42, 4, 12);
const HEAD = new THREE.SphereGeometry(0.27, 18, 14);
const EYE = new THREE.SphereGeometry(0.04, 8, 6);
const LIMB = new THREE.BoxGeometry(1, 1, 1);
const CAP = new THREE.ConeGeometry(0.16, 0.3, 10);
const EYE_MAT = new THREE.MeshBasicMaterial({ color: 0x1b2026 });

function limb(rig, mat, x, y, sx, sy) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  const m = new THREE.Mesh(LIMB, mat);
  m.scale.set(sx, sy, sx);
  m.position.y = -sy / 2;
  m.castShadow = true;
  pivot.add(m);
  rig.add(pivot);
  return pivot;
}

// agent 에 group, rig, head, legs, arms, pickMeshes, bodyMat, legsMat 를 붙인다.
export function buildAgentMesh(agent) {
  const M = mats();
  agent.bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  agent.legsMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  tintAgent(agent);
  const g = agent.group = new THREE.Group();
  const rig = agent.rig = new THREE.Group();
  g.add(rig);
  const torso = new THREE.Mesh(CAPSULE, agent.bodyMat);
  torso.position.y = 0.8;
  const head = agent.head = new THREE.Mesh(HEAD, M.skin);
  head.position.y = 1.42;
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(EYE, EYE_MAT);
    eye.position.set(sx * 0.095, 0.03, 0.235);
    head.add(eye);
  }
  rig.add(torso, head);
  agent.legs = [-1, 1].map((sx) => limb(rig, agent.legsMat, sx * 0.13, 0.46, 0.15, 0.46));
  agent.arms = [-1, 1].map((sx) => limb(rig, agent.bodyMat, sx * 0.38, 1.04, 0.11, 0.44));
  if (agent.isSub) {
    const cap = new THREE.Mesh(CAP, agent.legsMat);
    cap.position.set(0, 0.3, 0);
    head.add(cap);
    g.scale.setScalar(0.72);
  }
  torso.castShadow = true;
  head.castShadow = true;
  torso.userData.agent = agent;
  head.userData.agent = agent;
  agent.pickMeshes = [torso, head];
}

// 색이 바뀌면(부모가 바뀐 서브에이전트) 재질만 다시 칠한다.
export function tintAgent(agent) {
  agent.bodyMat.color.setHSL(agent.hue / 360, 0.58, agent.light, THREE.SRGBColorSpace);
  agent.legsMat.color.setHSL(agent.hue / 360, 0.35, 0.26, THREE.SRGBColorSpace);
}
