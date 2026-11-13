// Three.js office view, snapshot reconciliation, floor layout, and simulation tick helpers.
import * as THREE from 'three';
import { Agent } from './agent.js';
import { FLOOR_GAP, EXPLODE_GAP } from './floor.js';
import { activeThemeOf, tr } from './rooms.js';
import { separateAgents } from './placement.js';
import { floorDetail, crowdStride, lodTier } from './detail.js';
import { reconcileWaits, snapshotWaits, forgetTexts } from './approval.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function rehomeOfficeAgent(office, old, info, floor) {
  const from = old.floor;
  const has = (k) => k in info;
  const merged = {
    sessionId: old.id,
    project: floor.key,
    title: info.title || old.name,
    branch: info.branch || old.branch,
    worktree: has('worktree') ? info.worktree : old.worktree,
    isSubagent: has('isSubagent') ? !!info.isSubagent : old.isSub,
    parentSessionId: has('parentSessionId') ? info.parentSessionId : old.parentId,
    agentType: info.agentType || old.agentType,
    agent: info.agent || old.agent,
    surface: info.surface || old.surface || '',
    charOverride: old.charOverride || 'auto',
    postureOverride: old.postureOverride || 'auto',
    motionOverride: old.motionOverride || 'auto',
  };
  const carry = old.current && old.current.kind !== 'leave' ? [old.current] : [];
  for (const it of carry) {
    it.arrived = false;
    it.t = 0;
  }
  const spawn = floor === from ? { x: old.group.position.x, z: old.group.position.z } : null;
  old.dispose();
  office.agents.delete(old.id);
  const a = new Agent(office, merged, floor, spawn);
  a.queue = [...carry, ...old.queue];
  a.pending = old.pending;
  a.history = old.history;
  a.childSeq = old.childSeq;
  const prevTier = lodTier(office.agents.size);
  office.agents.set(a.id, a);
  if (lodTier(office.agents.size) !== prevTier) office.layout();
  else office.dress(a);
  if (office.selected === old) office.select(a, { silent: true });
  if (floor !== from) {
    for (const kid of [...office.agents.values()]) {
      if (kid.parentId === a.id && kid.floor === from) office.rehome(kid, {}, floor);
    }
    office.pruneEmptyFloors();
  }
  office.hud.renderFloors(office);
  return a;
}

export function applyOfficeSnapshot(office, events, meta = {}) {
  if (meta.reset) {
    for (const a of [...office.agents.values()]) office.removeAgent(a);
    for (const f of office.floors) f.board?.clear?.();
    office.inbox.boxes?.clear?.();
    office.toolTexts.clear();
  }
  const live = new Set();
  const open = new Map();
  for (const e of events) {
    if (e.type === 'session') live.add(e.sessionId);
    else if (e.type === 'tool_start') {
      if (!open.has(e.sessionId)) open.set(e.sessionId, new Set());
      open.get(e.sessionId).add(e.toolUseId);
    }
  }
  const waits = snapshotWaits(events);
  for (const ev of events) office.onEvent({ ...ev, replay: true });
  for (const a of [...office.agents.values()]) {
    if (live.has(a.id)) {
      const ids = open.get(a.id) || new Set();
      reconcileWaits(a, ids, waits.get(a.id) || new Set());
      a.abandonPending(ids);
      forgetTexts(office.toolTexts, a.id, ids);
    } else if (!meta.partial) {
      a.abandonPending();
      forgetTexts(office.toolTexts, a.id);
      a.leave();
    }
  }
  if (meta.reset) office.catchUp();
}

export function pruneEmptyFloors(office, keep = 1) {
  if (office.floors.length <= keep) return;
  let removed = false;
  for (let i = office.floors.length - 1; i >= 0 && office.floors.length > keep; i--) {
    const f = office.floors[i];
    if (f.agents.size > 0) continue;
    office.floors.splice(i, 1);
    office.byKey.delete(f.key);
    office.hud.clearPing(f);
    f.dispose(office.stage);
    if (office.focusIndex > i) office.focusIndex -= 1;
    removed = true;
  }
  if (!removed) return;
  office.floors.forEach((f, idx) => {
    f.index = idx;
    f.renameTag();
  });
  office.focusIndex = clamp(office.focusIndex, 0, Math.max(0, office.floors.length - 1));
  office.layout();
}

export function refreshOfficeLabels(office, globalKey, globalLabel, theme = null, postureChanged = false) {
  const gf = office.byKey.get(globalKey);
  if (gf) gf.label = globalLabel;
  const themeChanged = theme && office.theme !== theme;
  if (theme) office.theme = theme;
  for (const f of office.floors) {
    if (themeChanged) f.rebuildTheme?.(theme);
    else f.refreshSigns?.();
    f.board?.draw?.();
  }
  for (const a of office.agents.values()) {
    if (a.activity === '출근' || a.activity === 'Arrived') a.activity = tr('출근', 'Arrived');
    else if (a.activity === '대기 중' || a.activity === 'Idle') a.activity = tr('대기 중', 'Idle');
    if (themeChanged || postureChanged) a.refreshTheme?.(office.theme);
    else a.refreshTag?.();
  }
}

export function layoutFloors(office, opts = {}) {
  document.body.classList.toggle('overview', office.overview);
  office.stage.setOverview?.(office.overview);
  const load = { agentCount: office.agents.size, floorCount: office.floors.length };
  for (const f of office.floors) {
    f.goalY = f.index * (office.overview ? EXPLODE_GAP : FLOOR_GAP);
    const d = floorDetail(f.index, office.focusIndex, office.overview, load);
    f.group.visible = d.visible;
    f.group.matrixWorldAutoUpdate = d.visible;
    f.animate = d.animate;
    if (f.shadows !== d.shadows) f.setShadows(d.shadows);
    f.setLabelsVisible(d.labels);
    for (const a of f.agents) a.setLabelsVisible(d.labels);
  }
  const n = office.floors.length;
  const y = office.overview ? ((n - 1) * EXPLODE_GAP) / 2 : office.focusIndex * FLOOR_GAP;
  office.stage.setGoal(new THREE.Vector3(0, y + 0.6, 0), opts);
  office.stage.setLampY(office.overview ? -100 : office.focusIndex * FLOOR_GAP);
  office.stage.resize();
}

export function hitOfficeAgent(office, ndc) {
  const meshes = [];
  for (const a of office.agents.values()) if (a.floor.group.visible) meshes.push(...a.pickMeshes);
  office.raycaster.setFromCamera(ndc, office.stage.camera);
  const hit = office.raycaster.intersectObjects(meshes, false)[0];
  return hit ? hit.object.userData.agent : null;
}

export function stepOffice(office, dt, realDt) {
  office.tickSeq = ((office.tickSeq || 0) + 1) | 0;
  const total = office.agents.size;
  const theme = activeThemeOf();
  for (const f of [...office.floors]) {
    f.busy = {};
    for (const a of f.agents) if (a.mode === 'work' && !a.path.length) f.busy[a.room] = true;
    const stride = crowdStride(total, !office.overview && f.index === office.focusIndex);
    const prevAnim = f.animate;
    if (prevAnim && stride > 1 && (office.tickSeq % stride) !== 0) f.animate = false;
    f.update(dt, realDt);
    for (const a of [...f.agents]) a.update(dt);
    f.animate = prevAnim;
    if (f.group.visible && f.agents.size > 1) separateAgents([...f.agents], dt, 0.56, theme);
  }
  if (office.follow && office.selected) {
    office.selected.group.getWorldPosition(office.tmp);
    office.tmp.y += 0.6;
    office.stage.setGoal(office.tmp, { snapPan: true });
  }
  office.stage.update(realDt);
}
