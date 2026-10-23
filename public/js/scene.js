// 렌더러, 카메라, 조명, 테마(CSS 토큰 -> 재질 색) 관리.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROOMS, roomCenter } from './rooms.js';

export const BOX = new THREE.BoxGeometry(1, 1, 1);
const THEMED = [];
const GLOWING = [];
let glow = 1;

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const cssNum = (name, fallback = 0) => {
  const v = parseFloat(css(name));
  return Number.isFinite(v) ? v : fallback;
};

// CSS 토큰에 묶인 재질. 테마가 바뀌면 applyTheme() 가 색을 다시 칠한다.
export function themed(token, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, ...opts });
  THEMED.push({ m, token });
  const v = css(token);
  if (v) m.color.set(v);
  return m;
}

// 밤에는 더 밝게 빛나는 재질(모니터, LED, 화이트보드).
export function glowing(m, base = 1) {
  GLOWING.push({ m, base });
  m.emissiveIntensity = base * glow;
  return m;
}

// y 는 바닥 기준. 상자의 밑면이 y 에 놓인다.
export function box(parent, m, w, h, d, x, y, z, shadow = true) {
  const mesh = new THREE.Mesh(BOX, m);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function createStage(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  host.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -400, 800);
  const ISO = new THREE.Vector3(1, 0.92, 1).normalize().multiplyScalar(160);
  camera.position.copy(ISO);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minZoom = 0.4;
  controls.maxZoom = 4;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.25;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.keyPanSpeed = 0;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 90 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(14, 26, 9);

  // 밤 조명: 초점이 맞은 층에만 방마다 하나씩.
  const lamps = new THREE.Group();
  for (const key of Object.keys(ROOMS)) {
    const c = key === 'lounge' ? { x: 4, z: 0 } : roomCenter(key);
    const l = new THREE.PointLight(0xffd9a6, 0, 15, 1.6);
    l.position.set(c.x, 3.1, c.z);
    lamps.add(l);
  }
  scene.add(lamps);
  let lampGoal = 0;

  const goal = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const sph = new THREE.Spherical();
  let snapPan = false;
  let onUserPan = null;
  let preset = 'map';
  let spaceDown = false;
  let overlayBg = null;
  let lastTarget = new THREE.Vector3();
  let viewFn = (aspect) => Math.max(9.8, 14.5 / aspect);

  function syncMouseButtons(e = null) {
    if (preset === 'map') {
      controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    } else if (preset === 'figma') {
      controls.mouseButtons.LEFT = spaceDown ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    } else if (preset === 'blender') {
      controls.mouseButtons.LEFT = e?.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
      controls.mouseButtons.MIDDLE = e?.shiftKey ? THREE.MOUSE.PAN : (e?.ctrlKey || e?.metaKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE);
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    } else {
      controls.mouseButtons.LEFT = spaceDown ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    }
  }
  syncMouseButtons();

  renderer.domElement.addEventListener('pointerdown', (e) => syncMouseButtons(e), { capture: true });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (preset !== 'figma' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    panBy(dx * 0.018, -dy * 0.018);
  }, { capture: true, passive: false });

  controls.addEventListener('change', () => {
    const dx = controls.target.x - lastTarget.x;
    const dz = controls.target.z - lastTarget.z;
    if (dx * dx + dz * dz > 1e-4) {
      snapPan = false;
      onUserPan?.();
    }
    lastTarget.copy(controls.target);
  });

  function resize() {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    const aspect = w / h;
    const half = viewFn(aspect);
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  }

  function applyTheme() {
    for (const { m, token } of THEMED) {
      const v = css(token);
      if (v) m.color.set(v);
    }
    if (overlayBg === 'transparent') {
      scene.background = null;
      renderer.setClearColor?.(0x000000, 0);
    } else if (overlayBg) {
      scene.background = new THREE.Color(overlayBg);
      renderer.setClearColor?.(scene.background, 1);
    } else {
      scene.background = new THREE.Color(css('--scene-bg') || '#dde4ea');
      renderer.setClearColor?.(scene.background, 1);
    }
    hemi.color.set(css('--sky') || '#ffffff');
    hemi.groundColor.set(css('--ground') || '#888888');
    hemi.intensity = cssNum('--hemi', 1.2);
    sun.color.set(css('--sun-color') || '#ffffff');
    sun.intensity = cssNum('--sun', 2.4);
    const lamp = cssNum('--lamp', 0);
    lamps.children.forEach((l) => { l.intensity = lamp; });
    glow = cssNum('--glow', 1);
    for (const { m, base } of GLOWING) m.emissiveIntensity = base * glow;
  }

  function update(realDt) {
    const k = Math.min(1, realDt * 4);
    tmp.copy(goal).sub(anchor).multiplyScalar(k);
    anchor.add(tmp);
    controls.target.add(tmp);
    camera.position.add(tmp);
    if (snapPan) {
      tmp.copy(anchor).sub(controls.target).multiplyScalar(Math.min(1, realDt * 7));
      controls.target.add(tmp);
      camera.position.add(tmp);
      if (controls.target.distanceToSquared(anchor) < 0.0004) snapPan = false;
    }
    const ox = controls.target.x - anchor.x;
    const oz = controls.target.z - anchor.z;
    const cx = Math.min(18, Math.max(-18, ox)) - ox;
    const cz = Math.min(18, Math.max(-18, oz)) - oz;
    if (cx || cz) {
      controls.target.x += cx;
      controls.target.z += cz;
      camera.position.x += cx;
      camera.position.z += cz;
    }
    lastTarget.copy(controls.target);
    sun.position.copy(controls.target).add(SUN_OFFSET);
    sun.target.position.copy(controls.target);
    lamps.position.y += (lampGoal - lamps.position.y) * k;
    controls.update();
    lastTarget.copy(controls.target);
  }

  function panBy(dx, dz) {
    if (!dx && !dz) return;
    snapPan = false;
    onUserPan?.();
    fwd.subVectors(controls.target, camera.position);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(-1, 0, -1);
    fwd.normalize();
    right.set(-fwd.z, 0, fwd.x);
    const scale = 1 / Math.max(0.4, camera.zoom);
    tmp.set(0, 0, 0).addScaledVector(right, dx * scale).addScaledVector(fwd, dz * scale);
    controls.target.add(tmp);
    camera.position.add(tmp);
    lastTarget.copy(controls.target);
  }

  function rotateBy(dTheta, dPhi = 0) {
    tmp.subVectors(camera.position, controls.target);
    sph.setFromVector3(tmp);
    sph.theta += dTheta;
    sph.phi = Math.min(controls.maxPolarAngle, Math.max(controls.minPolarAngle, sph.phi + dPhi));
    tmp.setFromSpherical(sph);
    camera.position.copy(controls.target).add(tmp);
  }

  function zoomBy(factor) {
    camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
  }

  function resetView() {
    snapPan = true;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.position.copy(anchor).add(ISO);
    controls.target.copy(anchor);
    lastTarget.copy(controls.target);
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    renderer, labels, scene, camera, controls, resize, applyTheme, update,
    panBy, rotateBy, zoomBy, resetView,
    zoomTo(z) {
      camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, z));
      camera.updateProjectionMatrix();
    },
    setControlPreset(p) {
      preset = p || 'map';
      syncMouseButtons();
    },
    setSpaceDown(down) {
      if (spaceDown === !!down) return;
      spaceDown = !!down;
      syncMouseButtons();
    },
    setGoal(v, opts = {}) {
      goal.copy(v);
      if (opts.snapPan) snapPan = true;
    },
    setOverview(ov) { controls.screenSpacePanning = !!ov; },
    setOnUserPan(fn) { onUserPan = fn; },
    setLampY(y) { lampGoal = y; },
    setOverlayBg(bg) { overlayBg = bg || null; applyTheme(); },
    setViewFn(fn) { viewFn = fn; resize(); },
    // labelRoot: CSS 라벨을 계산할 묶음 (기본은 장면 전체). 숨은 층의 라벨까지 매 프레임 돌지 않게 한다.
    render(labelRoot = scene) {
      renderer.render(scene, camera);
      labels.render(labelRoot, camera);
    },
  };
}
