// Phase 3 (5-Stage Flywheel Process Visualization in 3D Stage & HUD Conveyor):
// - Maps P1..P8 runtime collectors to physical 3D rooms (archive, dev, server, meeting, desk)
// - Renders a spinning 3D Flywheel Rotor Core in the server room + collector/L1-seed 3D arcs
// - Mounts an interactive 5-Stage Conveyor Strip (L3 -> Dedup/2-Tick -> Tier A/B/C -> L1 -> L2)
import { langOf } from './rooms.js';
import { ROOM_CENTERS } from './sim-overlays.js';
import { flywheelView, readFlywheelStatus } from './flywheel-format.js';

export const COLLECTOR_ROOM_MAP = Object.freeze({
  privacy_guard: 'desk',
  runner_health: 'archive',
  tailer_integrity: 'archive',
  permission_wait: 'desk',
  sse_backpressure: 'server',
  session_recap: 'meeting',
  adapter_conformance: 'archive',
  dom_entropy: 'dev',
});

export const COST_LADDER_RUNGS = Object.freeze([
  'skill',
  'script',
  'subagent',
  'hook',
  'gate',
  'memory',
  'always-on',
]);

export const SIM_FLYWHEEL_VIZ_TEXT = Object.freeze({
  ko: Object.freeze({
    conveyorTitle: '플라이휠 5단계 폐루프 파이프라인 (L3 -> 중복제거 -> Tier 라우터 -> L1 계약 -> L2 승격)',
    actions: Object.freeze({
      scan: '1. L3 스캔',
      dedup: '2. 중복·디바운스',
      approve: '3. Tier A 승인',
      seed: '4. L1 계약 시드',
      promote: '5. L2 교훈 승격',
    }),
    stages: Object.freeze({
      s1Title: '1. L3 수집 (P1..P8)',
      s1Sub: (pass, warn, open) => `정상 ${pass} · 디바운스 ${warn} · 오픈 ${open}`,
      s2Title: '2. 3중 중복제거 · 2틱 게이트',
      s2Sub: (fp, dedup, reg) => `지문:${fp} · 억제:${dedup} · 회귀:${reg}`,
      s3Title: '3. Tier A/B/C 라우터',
      s3Sub: (a, b, c) => `Tier A:${a} · B:${b} · C:${c}`,
      s4Title: '4. L1 루프 계약 · 원장',
      s4Sub: (seeded, reqL2) => `시드:${seeded}건 · L2요구:${reqL2 ? '예(>=2회)' : '대기'}`,
      s5Title: '5. L2 승격 · Git Notes',
      s5Sub: (rung) => `harness2-v1 -> [${rung}] + refs/notes/evidence`,
    }),
  }),
  en: Object.freeze({
    conveyorTitle: 'Flywheel 5-Stage Closed-Loop Pipeline (L3 -> Dedup -> Tier Router -> L1 Contract -> L2 Promotion)',
    actions: Object.freeze({
      scan: '1. Scan L3',
      dedup: '2. Dedup Gate',
      approve: '3. Approve Tier A',
      seed: '4. Seed L1',
      promote: '5. Promote L2',
    }),
    stages: Object.freeze({
      s1Title: '1. L3 Collect (P1..P8)',
      s1Sub: (pass, warn, open) => `Pass ${pass} · Debounce ${warn} · Open ${open}`,
      s2Title: '2. 3-Layer Dedup & 2-Tick',
      s2Sub: (fp, dedup, reg) => `fp:${fp} · Suppressed:${dedup} · Reg:${reg}`,
      s3Title: '3. Tier A/B/C Router',
      s3Sub: (a, b, c) => `Tier A:${a} · B:${b} · C:${c}`,
      s4Title: '4. L1 Contract & Ledger',
      s4Sub: (seeded, reqL2) => `Seeded:${seeded} · L2Req:${reqL2 ? 'Yes(>=2)' : 'Standby'}`,
      s5Title: '5. L2 Lesson & Git Notes',
      s5Sub: (rung) => `harness2-v1 -> [${rung}] + refs/notes/evidence`,
    }),
  }),
});

export const simFlywheelVizText = (lang = 'ko') => SIM_FLYWHEEL_VIZ_TEXT[langOf(lang)];

const STYLE_CSS = `
#sim-flywheel-conveyor {
  position: fixed;
  bottom: 162px;
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 32px));
  z-index: 26;
  pointer-events: auto;
  background: rgba(252, 249, 242, 0.96);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(58, 42, 29, 0.24);
  border-radius: 12px;
  box-shadow: 0 12px 30px rgba(28, 20, 14, 0.18);
  padding: 8px 11px;
  color: #2b2118;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#sim-flywheel-conveyor[hidden] { display: none !important; }
.sim-fw-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sim-fw-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.sim-fw-btn {
  border: 1px solid rgba(58, 42, 29, 0.22);
  background: #fff;
  color: #2b2118;
  border-radius: 7px;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.sim-fw-btn:hover { background: #f3ece0; }
.sim-fw-stages {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 5px;
}
.sim-fw-stage {
  border: 1px solid rgba(58, 42, 29, 0.18);
  border-radius: 8px;
  padding: 5px 7px;
  background: rgba(255, 255, 255, 0.86);
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sim-fw-stage.active {
  border-color: #7c3aed;
  background: #f5f3ff;
  transform: translateY(-1px);
}
.sim-fw-stage b { font-size: 10.5px; color: #1e1b4b; }
.sim-fw-stage span { font-size: 9.5px; color: #5c4938; }
`;

export function buildFlywheelPipelineModel(rawStatus = null, lang = 'ko') {
  const vm = flywheelView(rawStatus, { lang });
  const cards = vm.zone2 || [];
  const activeSignals = vm.zone3?.activeSignals || [];
  const latestCycle = vm.zone4?.[0] || {};

  let passCount = 0;
  let debounceCount = 0;
  let openCount = 0;
  const roomSignals = {};

  for (const c of cards) {
    const room = COLLECTOR_ROOM_MAP[c.kind] || 'server';
    if (!roomSignals[room]) roomSignals[room] = [];
    roomSignals[room].push({ kind: c.kind, priorityLabel: c.priorityLabel, status: c.status });
    if (c.status === 'pass') passCount += 1;
  }

  let tierACount = 0;
  let tierBCount = 0;
  let tierCCount = 0;
  let regressionCount = 0;
  let seededCount = 0;
  let firstPendingFp = null;
  let firstOpenFp = null;

  for (const sig of activeSignals) {
    if (sig.debounced) debounceCount += 1;
    else openCount += 1;
    if (sig.regression) regressionCount += 1;
    if (sig.status === 'seeded') seededCount += 1;
    if (!firstOpenFp) firstOpenFp = sig.fingerprint;
    if (sig.recommendedAction?.status === 'pending_approval' && !firstPendingFp) {
      firstPendingFp = sig.fingerprint;
    }
    const track = String(sig.trackLabel || '').toLowerCase();
    if (track.includes('privacy') || track.includes('3d')) tierCCount += 1;
    else if (sig.recommendedAction) tierACount += 1;
    else tierBCount += 1;
  }

  const fpPreview = firstOpenFp ? `${String(firstOpenFp).slice(0, 6)}..` : 'nominal';
  const compDedup = cards.reduce((acc, c) => acc + (Number(c.dedupSuppressedCount) || 0), 0);
  const rawCycleDedup = Number(rawStatus?.cycles?.[0]?.dedupSuppressedCount ?? rawStatus?.cycleHistory?.[0]?.dedupSuppressedCount) || 0;
  const dedupSuppressed = Number(latestCycle.dedupSuppressedCount) || compDedup || rawCycleDedup;
  const requiresL2Promotion = activeSignals.some((s) => Number(s.occurrenceCount) >= 2 || s.regression);
  const targetRung = requiresL2Promotion ? 'gate' : seededCount > 0 ? 'script' : 'skill';

  return {
    overallStatus: vm.zone1?.overallStatus || 'pass',
    stage1: { passCount, debounceCount, openCount, roomSignals },
    stage2: { fpPreview, dedupSuppressed, regressionCount },
    stage3: { tierACount, tierBCount, tierCCount, firstPendingFp },
    stage4: { seededCount, firstOpenFp, requiresL2Promotion },
    stage5: { targetRung, schema: 'harness2-v1', notesRef: 'refs/notes/evidence' },
  };
}

export function installSimFlywheelViz({
  office,
  hud,
  source = null,
  overlays = null,
  THREE = null,
  doc = globalThis.document,
  fetchFn = globalThis.fetch,
} = {}) {
  let latestRaw = null;
  let activeStageIdx = 0;
  let beamPulseT = 0;

  if (doc?.head && !doc.getElementById?.('sim-flywheel-viz-style')) {
    const style = doc.createElement('style');
    style.id = 'sim-flywheel-viz-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  let conveyor = doc?.getElementById?.('sim-flywheel-conveyor') ?? null;
  if (!conveyor && doc) {
    const hudRoot = doc.getElementById?.('hud') ?? doc.body;
    if (hudRoot) {
      conveyor = doc.createElement('section');
      conveyor.id = 'sim-flywheel-conveyor';
      conveyor.hidden = true;
      hudRoot.appendChild(conveyor);
    }
  }

  async function postFlywheel(payload) {
    if (typeof fetchFn !== 'function') return null;
    try {
      const res = await fetchFn('/api/flywheel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res?.ok) return null;
      const data = await res.json();
      if (data?.status) latestRaw = data.status;
      else if (data?.components) latestRaw = data;
      renderConveyor();
      sync3DFlywheel();
      return data;
    } catch {
      return null;
    }
  }

  function renderConveyor() {
    if (!conveyor || !doc) return;
    const isFlywheelMode = overlays?.mode === 'flywheel';
    conveyor.hidden = !isFlywheelMode;
    if (conveyor.hidden) return;

    const lang = hud?.lang || 'ko';
    const t = simFlywheelVizText(lang);
    const model = buildFlywheelPipelineModel(latestRaw, lang);
    conveyor.replaceChildren();

    const head = doc.createElement('div');
    head.className = 'sim-fw-head';
    const title = doc.createElement('strong');
    title.textContent = t.conveyorTitle;
    const actRow = doc.createElement('div');
    actRow.className = 'sim-fw-actions';

    const stepDefs = [
      [t.actions.scan, 0, () => postFlywheel({ action: 'scan', triggerSource: 'on_demand' })],
      [t.actions.dedup, 1, null],
      [t.actions.approve, 2, () => model.stage3.firstPendingFp && postFlywheel({ action: 'approve', fingerprint: model.stage3.firstPendingFp })],
      [t.actions.seed, 3, () => model.stage4.firstOpenFp && postFlywheel({ action: 'seed', fingerprint: model.stage4.firstOpenFp })],
      [t.actions.promote, 4, null],
    ];
    for (const [label, idx, handler] of stepDefs) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'sim-fw-btn';
      btn.dataset.step = String(idx);
      btn.textContent = label;
      btn.addEventListener('click', () => {
        activeStageIdx = idx;
        beamPulseT = 2.5;
        if (handler) void handler();
        renderConveyor();
        sync3DFlywheel();
      });
      actRow.appendChild(btn);
    }
    head.append(title, actRow);
    conveyor.appendChild(head);

    const stagesGrid = doc.createElement('div');
    stagesGrid.className = 'sim-fw-stages';
    const stageCards = [
      [t.stages.s1Title, t.stages.s1Sub(model.stage1.passCount, model.stage1.debounceCount, model.stage1.openCount)],
      [t.stages.s2Title, t.stages.s2Sub(model.stage2.fpPreview, model.stage2.dedupSuppressed, model.stage2.regressionCount)],
      [t.stages.s3Title, t.stages.s3Sub(model.stage3.tierACount, model.stage3.tierBCount, model.stage3.tierCCount)],
      [t.stages.s4Title, t.stages.s4Sub(model.stage4.seededCount, model.stage4.requiresL2Promotion)],
      [t.stages.s5Title, t.stages.s5Sub(model.stage5.targetRung)],
    ];
    stageCards.forEach(([stTitle, stSub], idx) => {
      const node = doc.createElement('div');
      node.className = `sim-fw-stage${idx === activeStageIdx ? ' active' : ''}`;
      const b = doc.createElement('b');
      b.textContent = stTitle;
      const sp = doc.createElement('span');
      sp.textContent = stSub;
      node.append(b, sp);
      stagesGrid.appendChild(node);
    });
    conveyor.appendChild(stagesGrid);
  }

  function sync3DFlywheel() {
    if (!THREE || !office?.floors) return;
    const isFlywheelMode = overlays?.mode === 'flywheel';
    const model = buildFlywheelPipelineModel(latestRaw, hud?.lang || 'ko');
    const rotorColor = model.overallStatus === 'fail' ? 0xef4444 : model.overallStatus === 'warn' ? 0xf59e0b : 0x8b5cf6;

    for (const floor of office.floors) {
      if (!floor?.group) continue;
      if (!floor._flywheel3DGroup) {
        floor._flywheel3DGroup = new THREE.Group();
        floor._flywheel3DGroup.name = 'sim-flywheel-3d';
        floor.group.add(floor._flywheel3DGroup);
      }
      const fg = floor._flywheel3DGroup;
      while (fg.children.length) {
        const ch = fg.children.pop();
        ch.geometry?.dispose?.();
        ch.material?.dispose?.();
      }
      if (!isFlywheelMode) continue;

      const srv = ROOM_CENTERS.server;
      const mtg = ROOM_CENTERS.meeting;
      const rotorPos = new THREE.Vector3(srv.x, 2.0, srv.z);

      // 3D Flywheel Rotor Core in server room
      const torusGeo = new THREE.TorusGeometry(0.72, 0.1, 12, 28);
      torusGeo.rotateX(Math.PI / 2);
      const torusMat = new THREE.MeshBasicMaterial({ color: rotorColor, transparent: true, opacity: 0.88 });
      const rotorMesh = new THREE.Mesh(torusGeo, torusMat);
      rotorMesh.position.copy(rotorPos);
      rotorMesh.name = 'flywheel-rotor';
      fg.add(rotorMesh);

      // L3 Collector Room -> Server Rotor Arcs
      for (const roomKey of ['archive', 'dev', 'desk']) {
        const rc = ROOM_CENTERS[roomKey];
        if (!rc) continue;
        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(rc.x, 1.1, rc.z),
          new THREE.Vector3((rc.x + srv.x) * 0.5, 2.8, (rc.z + srv.z) * 0.5),
          rotorPos,
        );
        const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(20));
        const mat = new THREE.LineBasicMaterial({ color: rotorColor, transparent: true, opacity: 0.72 });
        fg.add(new THREE.Line(geo, mat));
      }

      // Server Rotor -> Meeting Whiteboard L1/L2 Contract Beam
      const wbCurve = new THREE.QuadraticBezierCurve3(
        rotorPos,
        new THREE.Vector3((srv.x + mtg.x) * 0.5, 3.1, (srv.z + mtg.z) * 0.5),
        new THREE.Vector3(mtg.x, 1.5, mtg.z),
      );
      const wbGeo = new THREE.BufferGeometry().setFromPoints(wbCurve.getPoints(22));
      const wbMat = new THREE.LineBasicMaterial({
        color: activeStageIdx >= 3 || beamPulseT > 0 ? 0x10b981 : 0x7c3aed,
        transparent: true,
        opacity: 0.9,
      });
      fg.add(new THREE.Line(wbGeo, wbMat));
    }
  }

  if (overlays?.onModeChange) {
    overlays.onModeChange(() => {
      renderConveyor();
      sync3DFlywheel();
    });
  }

  if (source && typeof source === 'object') {
    const prevOnFlywheel = source.onFlywheel;
    source.onFlywheel = (msg) => {
      if (typeof prevOnFlywheel === 'function') prevOnFlywheel(msg);
      if (readFlywheelStatus(msg)) {
        latestRaw = msg;
        renderConveyor();
        sync3DFlywheel();
      }
    };
  }

  if (office) {
    const origUpdate = office.update.bind(office);
    office.update = (dt, realDt) => {
      origUpdate(dt, realDt);
      if (beamPulseT > 0) beamPulseT = Math.max(0, beamPulseT - (realDt || dt || 0.016));
      if (overlays?.mode !== 'flywheel') return;
      for (const f of office.floors) {
        const rotor = f._flywheel3DGroup?.getObjectByName?.('flywheel-rotor');
        if (rotor) rotor.rotation.z += (realDt || dt || 0.016) * (beamPulseT > 0 ? 4.2 : 1.4);
      }
    };
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => renderConveyor());

  return {
    getModel: () => buildFlywheelPipelineModel(latestRaw, hud?.lang || 'ko'),
    updateStatus: (msg) => {
      latestRaw = msg;
      renderConveyor();
      sync3DFlywheel();
    },
    renderConveyor,
    sync3DFlywheel,
  };
}
