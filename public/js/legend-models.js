// 범례 패널(캐릭터·에이전트)의 3D 캐릭터 모형 썸네일 렌더러.
// WebGL 컨텍스트 개수를 아끼기 위해 작은 오프스크린 렌더러 하나를 공유해 각 카드의 2D <canvas> 에 그린다.
// 카드에 마우스를 올리면 해당 캐릭터 모형이 부드럽게 회전하며 손짓한다.
import * as THREE from 'three';
import { buildAgentMesh, animateAgentMesh } from './agent-mesh.js';

const W = 128;
const H = 144;

const MODEL_SPECS = Object.freeze({
  claude:    Object.freeze({ agent: 'claude-code', surface: '',    hue: 18,  light: 0.53, isSub: false }),
  codex:     Object.freeze({ agent: 'codex',       surface: '',    hue: 158, light: 0.53, isSub: false }),
  grok:      Object.freeze({ agent: 'grok',        surface: '',    hue: 275, light: 0.53, isSub: false }),
  'agy-cli': Object.freeze({ agent: 'antigravity', surface: 'cli', hue: 192, light: 0.53, isSub: false }),
  'agy-app': Object.freeze({ agent: 'antigravity', surface: 'app', hue: 220, light: 0.53, isSub: false }),
  sub:       Object.freeze({ agent: 'claude-code', surface: '',    hue: 38,  light: 0.62, isSub: true }),
});

let studio = null;
let hoverRaf = 0;
let activeHover = null;

function ensureStudio() {
  if (studio) return studio;
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') return null;
  try {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xfff6e8, 1.35));
    const key = new THREE.DirectionalLight(0xfffdf8, 1.55);
    key.position.set(2.4, 4.2, 3.2);
    const rim = new THREE.DirectionalLight(0x9ec5ff, 0.75);
    rim.position.set(-2.5, 2.2, -2.0);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.5, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.8 }),
    );
    pad.position.y = -0.025;
    const holder = new THREE.Group();
    scene.add(key, rim, pad, holder);

    const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 20);
    camera.position.set(0, 1.18, 3.85);
    camera.lookAt(0, 1.0, 0);

    studio = { renderer, scene, camera, holder };
    return studio;
  } catch {
    return null;
  }
}

function drawEntry(entry, angle = -0.38, wave = false) {
  const st = ensureStudio();
  if (!st || !entry?.canvas) return;
  const { dummy, canvas } = entry;
  st.holder.clear();
  st.holder.add(dummy.group);
  dummy.mode = wave ? 'ask' : 'idle';
  animateAgentMesh(dummy, false);
  if (!wave && dummy.arms?.[1]) dummy.arms[1].rotation.x = -0.45;
  dummy.group.rotation.y = angle;
  st.renderer.render(st.scene, st.camera);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(st.renderer.domElement, 0, 0, canvas.width, canvas.height);
}

function stopHover() {
  if (hoverRaf) cancelAnimationFrame(hoverRaf);
  hoverRaf = 0;
  if (activeHover) {
    const prev = activeHover;
    activeHover = null;
    prev.dummy.t = 0.8;
    drawEntry(prev, -0.38, false);
  }
}

function startHover(entry) {
  stopHover();
  activeHover = entry;
  let last = performance.now();
  const loop = (now) => {
    if (activeHover !== entry) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    entry.dummy.t += dt;
    const angle = -0.38 + Math.sin(entry.dummy.t * 2.2) * 0.65;
    drawEntry(entry, angle, true);
    hoverRaf = requestAnimationFrame(loop);
  };
  hoverRaf = requestAnimationFrame(loop);
}

export function mountLegendModels(agentUl) {
  stopHover();
  if (!agentUl || !ensureStudio()) return;
  for (const li of agentUl.querySelectorAll('li[data-agent-id]')) {
    const id = li.dataset.agentId;
    const spec = MODEL_SPECS[id] || MODEL_SPECS.claude;
    const canvas = li.querySelector('canvas.ag-model');
    if (!canvas) continue;
    const dummy = {
      agent: spec.agent,
      surface: spec.surface,
      hue: spec.hue,
      light: spec.light,
      isSub: spec.isSub,
      t: 0.8,
      path: [],
      queue: [],
      mode: 'idle',
      panicT: 0,
    };
    buildAgentMesh(dummy);
    const entry = { dummy, canvas };
    drawEntry(entry, -0.38, false);
    li.addEventListener('pointerenter', () => startHover(entry));
    li.addEventListener('pointerleave', () => { if (activeHover === entry) stopHover(); });
    li.addEventListener('focus', () => startHover(entry));
    li.addEventListener('blur', () => { if (activeHover === entry) stopHover(); });
  }
}
