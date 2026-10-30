// Phase 2 (SimCity RCI Meter, 5-Mode 3D Stage Lenses & Top-Bar Progressive Disclosure):
// - Inline #sim-hud-pill mounted inside .bar .controls with persistent DOM refs (never detaches open <select>)
// - SimCity RCI Workload Balance Meter (R: Read/Explore, C: Code/Edit, I: Integrate/Verify)
// - 5-Mode Viewport Overlay Selector (Shortcut V: 1 Normal, 2 Heatmap, 3 Desire, 4 Friction, 5 Flywheel)
// - Progressive disclosure toggle (#sim-more-toggle) for secondary appearance/camera controls
import { langOf, ROOMS } from './rooms.js';

export const OVERLAY_MODES = Object.freeze(['normal', 'heatmap', 'desire', 'friction', 'flywheel']);

export const SIM_OVERLAYS_TEXT = Object.freeze({
  ko: Object.freeze({
    rciTitle: 'SimCity식 RCI 작업 수요 균형 (R: 탐색 · C: 구현 · I: 검증)',
    lensLabel: '렌즈 (V)',
    moreBtn: '세부 설정',
    moreTitle: '캐릭터·보행·모션·소리·조작·주기 등 세부 설정 펼치기/접기',
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
    moreBtn: 'Tune',
    moreTitle: 'Show or hide secondary character, motion, voice, camera & tail interval controls',
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  font: 500 11px/1.2 var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--fg);
}
.sim-rci-box {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-right: 6px;
  border-right: 1px solid var(--line);
}
.sim-rci-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
  padding: 1px 2px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.sim-rci-bar {
  width: 4px;
  border-radius: 1.5px;
  transition: height 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sim-rci-bar.r { background: #3b82f6; }
.sim-rci-bar.c { background: #10b981; }
.sim-rci-bar.i { background: #a855f7; }
#sim-lens-select {
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel-solid);
  color: var(--fg);
  font: 500 11.5px/1.2 var(--font-ui, sans-serif);
  cursor: pointer;
}
.controls[data-more="collapsed"] label[for="interval"],
.controls[data-more="collapsed"] label[for="char-theme"],
.controls[data-more="collapsed"] label[for="posture-mode"],
.controls[data-more="collapsed"] label[for="motion-mode"],
.controls[data-more="collapsed"] label[for="voice-mode"],
.controls[data-more="collapsed"] label[for="control-preset"] {
  display: none;
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
  let moreOpen = false;
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

  const controlsHost = doc?.querySelector?.('.bar .controls') ?? null;
  if (controlsHost && !controlsHost.dataset?.more) {
    if (controlsHost.dataset) controlsHost.dataset.more = 'collapsed';
  }

  let moreBtn = doc?.getElementById?.('sim-more-toggle') ?? null;
  if (!moreBtn && doc && controlsHost) {
    moreBtn = doc.createElement('button');
    moreBtn.type = 'button';
    moreBtn.id = 'sim-more-toggle';
    moreBtn.className = 'ghost';
    moreBtn.setAttribute('aria-pressed', 'false');
    moreBtn.addEventListener('click', () => {
      moreOpen = !moreOpen;
      if (controlsHost.dataset) controlsHost.dataset.more = moreOpen ? 'open' : 'collapsed';
      moreBtn.setAttribute('aria-pressed', String(moreOpen));
    });
    controlsHost.appendChild(moreBtn);
  }

  let pill = doc?.getElementById?.('sim-hud-pill') ?? null;
  if (!pill && doc) {
    const host = controlsHost ?? doc.getElementById?.('hud') ?? doc.body;
    if (host) {
      pill = doc.createElement('div');
      pill.id = 'sim-hud-pill';
      pill.setAttribute('role', 'group');
      host.appendChild(pill);
    }
  }

  let pillRefs = null;
  function ensurePillDom() {
    if (!pill || !doc) return null;
    if (pillRefs && pill.children?.length > 0) return pillRefs;
    pill.replaceChildren();

    const rciBox = doc.createElement('div');
    rciBox.className = 'sim-rci-box';
    const bars = doc.createElement('div');
    bars.className = 'sim-rci-bars';
    const barNodes = {};
    for (const k of ['r', 'c', 'i']) {
      const b = doc.createElement('span');
      b.className = `sim-rci-bar ${k}`;
      bars.appendChild(b);
      barNodes[k] = b;
    }
    const rciTxt = doc.createElement('span');
    rciBox.append(bars, rciTxt);
    pill.appendChild(rciBox);

    const lensTag = doc.createElement('span');
    pill.appendChild(lensTag);

    const select = doc.createElement('select');
    select.id = 'sim-lens-select';
    const optNodes = {};
    for (const mode of OVERLAY_MODES) {
      const opt = doc.createElement('option');
      opt.value = mode;
      select.appendChild(opt);
      optNodes[mode] = opt;
    }
    select.addEventListener('change', (e) => setMode(e?.target?.value || select.value));
    pill.appendChild(select);

    pillRefs = { rciBox, barNodes, rciTxt, lensTag, select, optNodes, renderedLang: '' };
    return pillRefs;
  }

  function recordCommute(fromRoom, toRoom) {
    if (!fromRoom || !toRoom || fromRoom === toRoom) return;
    const pair = [fromRoom, toRoom].sort().join('->');
    commuteEdges.set(pair, (commuteEdges.get(pair) || 0) + 1);
  }

  function renderPill({ forceSelectSync = false } = {}) {
    const refs = ensurePillDom();
    if (!refs) return;
    const lang = hud?.lang || 'ko';
    const t = simOverlaysText(lang);
    const rci = computeRciBalance(rciCounts);

    refs.rciBox.title = t.rciTitle;
    refs.barNodes.r.style.height = `${Math.max(20, rci.rPct)}%`;
    refs.barNodes.c.style.height = `${Math.max(20, rci.cPct)}%`;
    refs.barNodes.i.style.height = `${Math.max(20, rci.iPct)}%`;
    refs.rciTxt.textContent = `R:${rci.rPct}% C:${rci.cPct}% I:${rci.iPct}%`;

    if (refs.renderedLang !== lang) {
      refs.renderedLang = lang;
      refs.lensTag.textContent = t.lensLabel;
      refs.select.setAttribute('aria-label', t.lensLabel);
      for (const mode of OVERLAY_MODES) {
        if (refs.optNodes[mode]) refs.optNodes[mode].textContent = t.modes[mode];
      }
      if (moreBtn) {
        moreBtn.textContent = t.moreBtn;
        moreBtn.title = t.moreTitle;
      }
    }

    // Never mutate select.value while the user has the native dropdown focused unless mode changed explicitly
    if (forceSelectSync || (doc?.activeElement !== refs.select && refs.select.value !== activeMode)) {
      refs.select.value = activeMode;
      for (const mode of OVERLAY_MODES) {
        if (refs.optNodes[mode]) refs.optNodes[mode].selected = mode === activeMode;
      }
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
    renderPill({ forceSelectSync: true });
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
      renderPill({ forceSelectSync: false });
      if (activeMode !== 'normal') sync3DOverlays();
    };
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => renderPill({ forceSelectSync: false }));

  win?.addEventListener?.('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'v') {
      e.preventDefault();
      const idx = (OVERLAY_MODES.indexOf(activeMode) + 1) % OVERLAY_MODES.length;
      setMode(OVERLAY_MODES[idx]);
    } else if (e.key === 'Escape' && activeMode !== 'normal' && !office?.selected) {
      setMode('normal');
    }
  });

  renderPill({ forceSelectSync: true });

  return {
    get mode() { return activeMode; },
    setMode,
    onModeChange: (fn) => { modeListeners.add(fn); return () => modeListeners.delete(fn); },
    getRci: () => computeRciBalance(rciCounts),
    sync3DOverlays,
    renderPill,
  };
}
