// Phase 2 (Impeccable Floating SimHUD Pill, SimCity RCI Meter & 5-Mode 3D Stage Lenses):
// - Top-Center Floating SimHUD Pill (#sim-hud-pill) anchored over #stage (Impeccable Operate mode)
// - SimCity RCI Workload Balance Meter (R: Read/Explore, C: Code/Edit, I: Integrate/Verify)
// - 5-Mode Viewport Overlay Switcher (Shortcut V: 1 Normal, 2 Heatmap, 3 Desire, 4 Friction, 5 Flywheel)
import { langOf, ROOMS } from './rooms.js';

export const OVERLAY_MODES = Object.freeze(['normal', 'heatmap', 'desire', 'friction', 'flywheel']);

export const SIM_OVERLAYS_TEXT = Object.freeze({
  ko: Object.freeze({
    rciTitle: 'SimCity식 RCI 작업 수요 균형 (R: 탐색 · C: 구현 · I: 검증)',
    lensLabel: '뷰 렌즈 (V)',
    modes: Object.freeze({
      normal: '1: 기본',
      heatmap: '2: 비용 열지도',
      desire: '3: 이동 동선',
      friction: '4: 병목·대기',
      flywheel: '5: 플라이휠',
    }),
  }),
  en: Object.freeze({
    rciTitle: 'SimCity RCI Workload Demand Balance (R: Read · C: Code · I: Verify)',
    lensLabel: 'Lens (V)',
    modes: Object.freeze({
      normal: '1: Normal',
      heatmap: '2: Heatmap',
      desire: '3: Desire',
      friction: '4: Friction',
      flywheel: '5: Flywheel',
    }),
  }),
});

export const simOverlaysText = (lang = 'ko') => SIM_OVERLAYS_TEXT[langOf(lang)];

const STYLE_CSS = `
#sim-hud-pill {
  position: fixed;
  top: 58px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(252, 249, 242, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(58, 42, 29, 0.2);
  box-shadow: 0 8px 24px rgba(28, 20, 14, 0.14);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: #2b2118;
}
.sim-rci-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  border-right: 1px solid rgba(58, 42, 29, 0.18);
}
.sim-rci-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 16px;
  padding: 2px 3px;
  border-radius: 4px;
  background: rgba(58, 42, 29, 0.08);
}
.sim-rci-bar {
  width: 5px;
  border-radius: 2px;
  transition: height 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sim-rci-bar.r { background: #3b82f6; }
.sim-rci-bar.c { background: #10b981; }
.sim-rci-bar.i { background: #a855f7; }
.sim-lens-btn {
  border: 1px solid rgba(58, 42, 29, 0.18);
  background: rgba(255, 255, 255, 0.78);
  color: #2b2118;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sim-lens-btn:hover { background: #f5efe4; }
.sim-lens-btn[aria-pressed="true"] {
  background: #2b2118;
  color: #fffdf9;
  border-color: #2b2118;
}
@media (max-width: 900px) {
  #sim-hud-pill { top: 96px; max-width: calc(100vw - 24px); overflow-x: auto; }
}
`;

export const ROOM_CENTERS = Object.freeze({
  archive:  Object.freeze({ x: -8, z: -5, w: 7.4, d: 5.4 }),
  dev:      Object.freeze({ x: 0,  z: -5, w: 7.4, d: 5.4 }),
  server:   Object.freeze({ x: 8,  z: -5, w: 7.4, d: 5.4 }),
  research: Object.freeze({ x: -8, z: 5,  w: 7.4, d: 5.4 }),
  meeting:  Object.freeze({ x: 0,  z: 5,  w: 7.4, d: 5.4 }),
  desk:     Object.freeze({ x: 8,  z: 5,  w: 7.4, d: 5.4 }),
  lounge:   Object.freeze({ x: 0,  z: 0,  w: 23.2, d: 3.4 }),
});

export function classifyEventRci(evOrTool = {}) {
  const tool = String(evOrTool?.tool || evOrTool?.name || evOrTool?.room || '').toLowerCase();
  if (/read|grep|glob|search|fetch|archive|research|explore|codegraph/.test(tool)) return 'r';
  if (/edit|write|patch|notebook|todo|plan|task|dev|meeting/.test(tool)) return 'c';
  if (/bash|test|git|exec|ask|approve|server|desk|mcp/.test(tool)) return 'i';
  return 'r';
}

export function computeRciBalance(counts = { r: 0, c: 0, i: 0 }) {
  const r = Math.max(0, Number(counts?.r) || 0);
  const c = Math.max(0, Number(counts?.c) || 0);
  const i = Math.max(0, Number(counts?.i) || 0);
  const total = r + c + i;
  if (total === 0) {
    return { rPct: 34, cPct: 33, iPct: 33, total: 0, dominant: 'balanced' };
  }
  const rPct = Math.round((r / total) * 100);
  const cPct = Math.round((c / total) * 100);
  const iPct = Math.max(0, 100 - rPct - cPct);
  const dominant = r >= c && r >= i ? 'r' : c >= r && c >= i ? 'c' : 'i';
  return { rPct, cPct, iPct, total, dominant };
}

export function computeRoomOverlayState(floorLike = {}, metricsBySid = new Map(), mode = 'normal') {
  const out = {};
  const agents = [...(floorLike.agents || [])];
  for (const roomKey of Object.keys(ROOMS)) {
    const roomAgents = agents.filter((a) => a.room === roomKey);
    const waitingQueue = Array.isArray(floorLike.waiting?.[roomKey])
      ? floorLike.waiting[roomKey].filter(Boolean).length
      : 0;
    const askingCount = roomAgents.filter((a) => a.mode === 'ask').length;
    let maxContextPct = 0;
    let totalErrors = 0;
    for (const a of roomAgents) {
      const m = metricsBySid.get?.(a.id) || {};
      const pct = Math.round(((Number(m.contextTokens) || 0) / Math.max(1, Number(m.contextWindow) || 200_000)) * 100);
      if (pct > maxContextPct) maxContextPct = pct;
      totalErrors += Number(m.toolErrors) || 0;
    }

    let colorHex = 0x22c55e;
    let opacity = 0;
    if (mode === 'heatmap') {
      opacity = roomAgents.length > 0 ? 0.34 : 0.12;
      colorHex = maxContextPct >= 75 ? 0xef4444 : maxContextPct >= 45 || roomAgents.length >= 2 ? 0xf59e0b : 0x22c55e;
    } else if (mode === 'friction') {
      const stress = waitingQueue * 2 + askingCount * 2 + totalErrors;
      opacity = stress > 0 ? 0.42 : 0.1;
      colorHex = stress >= 2 ? 0xef4444 : stress === 1 ? 0xf59e0b : 0x22c55e;
    } else if (mode === 'flywheel') {
      opacity = roomKey === 'server' ? 0.36 : roomKey === 'desk' || roomKey === 'meeting' ? 0.26 : 0.16;
      colorHex = roomKey === 'server' ? 0x8b5cf6 : roomKey === 'meeting' ? 0x10b981 : 0x6366f1;
    }
    out[roomKey] = { colorHex, opacity, agentCount: roomAgents.length, waitingQueue, askingCount, maxContextPct };
  }
  return out;
}

export function installSimOverlays({
  office,
  hud,
  extras = null,
  THREE = null,
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  let activeMode = 'normal';
  const rciCounts = { r: 4, c: 5, i: 3 };
  const commuteEdges = new Map();
  const lastRoomBySid = new Map();
  const modeListeners = new Set();

  if (doc?.head && !doc.getElementById?.('sim-overlays-style')) {
    const style = doc.createElement('style');
    style.id = 'sim-overlays-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  let pill = doc?.getElementById?.('sim-hud-pill') ?? null;
  if (!pill && doc) {
    const hudRoot = doc.getElementById?.('hud') ?? doc.body;
    if (hudRoot) {
      pill = doc.createElement('div');
      pill.id = 'sim-hud-pill';
      pill.setAttribute('role', 'toolbar');
      hudRoot.appendChild(pill);
    }
  }

  function recordCommute(fromRoom, toRoom) {
    if (!fromRoom || !toRoom || fromRoom === toRoom) return;
    const pair = [fromRoom, toRoom].sort().join('->');
    commuteEdges.set(pair, (commuteEdges.get(pair) || 0) + 1);
  }

  function renderPill() {
    if (!pill || !doc) return;
    const lang = hud?.lang || 'ko';
    const t = simOverlaysText(lang);
    const rci = computeRciBalance(rciCounts);
    pill.replaceChildren();

    const rciBox = doc.createElement('div');
    rciBox.className = 'sim-rci-box';
    rciBox.title = t.rciTitle;
    const bars = doc.createElement('div');
    bars.className = 'sim-rci-bars';
    for (const [k, pct] of [['r', rci.rPct], ['c', rci.cPct], ['i', rci.iPct]]) {
      const b = doc.createElement('span');
      b.className = `sim-rci-bar ${k}`;
      b.style.height = `${Math.max(20, pct)}%`;
      bars.appendChild(b);
    }
    const txt = doc.createElement('span');
    txt.textContent = `R:${rci.rPct}% C:${rci.cPct}% I:${rci.iPct}%`;
    rciBox.append(bars, txt);
    pill.appendChild(rciBox);

    const lensTag = doc.createElement('strong');
    lensTag.textContent = t.lensLabel;
    pill.appendChild(lensTag);

    for (const mode of OVERLAY_MODES) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'sim-lens-btn';
      btn.dataset.mode = mode;
      btn.setAttribute('aria-pressed', String(activeMode === mode));
      btn.textContent = t.modes[mode];
      btn.addEventListener('click', () => setMode(mode));
      pill.appendChild(btn);
    }
  }

  function sync3DOverlays() {
    if (!THREE || !office?.floors) return;
    for (const floor of office.floors) {
      if (!floor?.group) continue;
      if (!floor._simOverlayGroup) {
        floor._simOverlayGroup = new THREE.Group();
        floor._simOverlayGroup.name = 'sim-floor-overlays';
        floor.group.add(floor._simOverlayGroup);
      }
      const og = floor._simOverlayGroup;
      while (og.children.length) {
        const ch = og.children.pop();
        ch.geometry?.dispose?.();
        ch.material?.dispose?.();
      }
      if (activeMode === 'normal') continue;

      if (activeMode === 'desire') {
        const defaultPairs = [['archive', 'dev', 3], ['dev', 'server', 5], ['server', 'meeting', 2]];
        for (const [rA, rB, baseWeight] of defaultPairs) {
          const pairKey = [rA, rB].sort().join('->');
          const count = (commuteEdges.get(pairKey) || 0) + baseWeight;
          const cA = ROOM_CENTERS[rA];
          const cB = ROOM_CENTERS[rB];
          if (!cA || !cB) continue;
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(cA.x, 0.25, cA.z),
            new THREE.Vector3((cA.x + cB.x) * 0.5, 1.35 + Math.min(1.2, count * 0.1), (cA.z + cB.z) * 0.5),
            new THREE.Vector3(cB.x, 0.25, cB.z),
          );
          const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(22));
          const mat = new THREE.LineBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.85 });
          og.add(new THREE.Line(geo, mat));
        }
        continue;
      }

      const states = computeRoomOverlayState(floor, extras?.metricsBySid, activeMode);
      for (const [roomKey, st] of Object.entries(states)) {
        if (st.opacity <= 0.01) continue;
        const rc = ROOM_CENTERS[roomKey];
        if (!rc) continue;
        const geo = new THREE.PlaneGeometry(rc.w, rc.d);
        geo.rotateX(-Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({
          color: st.colorHex,
          transparent: true,
          opacity: st.opacity,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(rc.x, 0.04, rc.z);
        og.add(mesh);
      }
    }
  }

  function setMode(nextMode) {
    if (!OVERLAY_MODES.includes(nextMode)) return;
    activeMode = nextMode;
    renderPill();
    sync3DOverlays();
    for (const fn of modeListeners) {
      try { fn(activeMode); } catch { /* ignore */ }
    }
  }

  if (office) {
    const origOnEvent = office.onEvent.bind(office);
    office.onEvent = (ev) => {
      origOnEvent(ev);
      if (!ev) return;
      const bucket = classifyEventRci(ev);
      rciCounts[bucket] = (rciCounts[bucket] || 0) + 1;
      if (ev.sessionId) {
        const a = office.agents.get(ev.sessionId);
        if (a?.room) {
          const prev = lastRoomBySid.get(ev.sessionId);
          if (prev && prev !== a.room) recordCommute(prev, a.room);
          lastRoomBySid.set(ev.sessionId, a.room);
        }
      }
      renderPill();
      if (activeMode !== 'normal') sync3DOverlays();
    };
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => renderPill());

  win?.addEventListener?.('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'v') {
      e.preventDefault();
      const idx = (OVERLAY_MODES.indexOf(activeMode) + 1) % OVERLAY_MODES.length;
      setMode(OVERLAY_MODES[idx]);
    }
  });

  renderPill();

  return {
    get mode() { return activeMode; },
    setMode,
    onModeChange: (fn) => { modeListeners.add(fn); return () => modeListeners.delete(fn); },
    getRci: () => computeRciBalance(rciCounts),
    sync3DOverlays,
    renderPill,
  };
}
