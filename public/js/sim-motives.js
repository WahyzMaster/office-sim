// Phase 1 (Sims & AI Workstudio Micro-Clarity Sidecar):
// - 4 Deterministic Agent Motives (Freshness, Momentum, Alignment, Verification)
// - Sims-style Action Queue Strip & Moodlet Buff/Debuff Chips in #inspector
// - Floating Tool Yield Popups (+Patch, +Pass, +Insight, +Plan) on agent tags
// - 3D Parent <-> Subagent Handoff Tether Arcs across floor rooms
import { langOf, ROOMS } from './rooms.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const SIM_MOTIVES_TEXT = Object.freeze({
  ko: Object.freeze({
    queueTitle: '행동 대기열',
    motivesTitle: '에이전트 활력 지표',
    moodletsTitle: '무들렛 상태',
    freshness: '활력',
    momentum: '몰입',
    alignment: '동기화',
    verification: '검증',
    nowPrefix: '진행',
    nextPrefix: '다음',
    laterPrefix: '예정',
    yields: Object.freeze({
      patch: '+코드패치',
      pass: '+검증통과',
      insight: '+단서획득',
      plan: '+계획갱신',
      retry: '!재시도',
    }),
    moodlets: Object.freeze({
      onARoll: '[+] 연속 성공 탄력',
      compacted: '[+] 컨텍스트 압축 상쾌함',
      subLinked: '[*] 서브에이전트 협업 연결',
      approvalHold: '[!] 사람 승인 대기 중',
      contextHeavy: '[!] 컨텍스트 과부하 주의',
      steady: '[+] 안정적 작업 흐름',
    }),
    queueSteps: Object.freeze({
      archive: '코드 탐색 및 구조 파악',
      dev: '코드 수정 및 구현',
      server: '테스트 및 빌드 검증',
      research: '문서 및 웹 레퍼런스 조회',
      meeting: '화이트보드 작업 계획 동기화',
      desk: '리뷰 및 권한 승인 확인',
      lounge: '라운지 휴식 및 대기',
    }),
  }),
  en: Object.freeze({
    queueTitle: 'Action Queue',
    motivesTitle: 'Agent Motives',
    moodletsTitle: 'Moodlets',
    freshness: 'Freshness',
    momentum: 'Momentum',
    alignment: 'Alignment',
    verification: 'Verification',
    nowPrefix: 'NOW',
    nextPrefix: 'NEXT',
    laterPrefix: 'LATER',
    yields: Object.freeze({
      patch: '+Patch',
      pass: '+Pass',
      insight: '+Insight',
      plan: '+Plan',
      retry: '!Retry',
    }),
    moodlets: Object.freeze({
      onARoll: '[+] On a Roll',
      compacted: '[+] Fresh Compaction',
      subLinked: '[*] Subagent Linked',
      approvalHold: '[!] Approval Hold',
      contextHeavy: '[!] Heavy Context Load',
      steady: '[+] Steady Flow',
    }),
    queueSteps: Object.freeze({
      archive: 'Explore codebase & symbols',
      dev: 'Implement & edit patch',
      server: 'Run test & build check',
      research: 'Query docs & web refs',
      meeting: 'Sync whiteboard plan',
      desk: 'Await human review',
      lounge: 'Lounge smart-terrain idle',
    }),
  }),
});

export const simMotivesText = (lang = 'ko') => SIM_MOTIVES_TEXT[langOf(lang)];

const SOP_NEXT_MAP = Object.freeze({
  archive: ['dev', 'server', 'meeting'],
  research: ['dev', 'server', 'meeting'],
  dev: ['server', 'meeting', 'lounge'],
  server: ['meeting', 'dev', 'lounge'],
  meeting: ['archive', 'dev', 'server'],
  desk: ['dev', 'server', 'meeting'],
  lounge: ['archive', 'dev', 'server'],
});

const STYLE_CSS = `
.sim-insp-card { margin-top: 6px; padding: 7px 9px; border-radius: 9px; background: rgba(58, 42, 29, 0.05); border: 1px solid rgba(58, 42, 29, 0.14); display: flex; flex-direction: column; gap: 6px; font-size: 11px; font-variant-numeric: tabular-nums; }
.sim-queue-row { display: flex; align-items: center; gap: 4px; overflow-x: auto; padding-bottom: 2px; }
.sim-q-chip { padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(58, 42, 29, 0.2); background: rgba(255, 255, 255, 0.85); white-space: nowrap; font-size: 10.5px; }
.sim-q-chip.now { background: #2b2118; color: #fffdf9; font-weight: 700; }
.sim-motives-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 10px; }
.sim-motive-item { display: grid; grid-template-columns: 58px 1fr 32px; align-items: center; gap: 5px; font-size: 10.5px; }
.sim-motive-track { height: 7px; border-radius: 999px; background: rgba(58, 42, 29, 0.14); overflow: hidden; }
.sim-motive-fill { height: 100%; border-radius: 999px; transition: width 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.sim-moodlets-row { display: flex; flex-wrap: wrap; gap: 4px; }
.sim-moodlet { padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; border: 1px solid rgba(58, 42, 29, 0.16); }
.sim-moodlet.good { background: #dcfce7; color: #166534; }
.sim-moodlet.warn { background: #fef3c7; color: #92400e; }
.sim-moodlet.bad { background: #fee2e2; color: #991b1b; }
.sim-moodlet.info { background: #e0e7ff; color: #1e40af; }
.sim-yield-pop { display: inline-block; margin-left: 4px; padding: 1px 5px; border-radius: 999px; font-size: 10px; font-weight: 700; background: #fef08a; color: #713f12; border: 1px solid rgba(113, 63, 18, 0.3); }
`;

export function createAgentMotiveState() {
  return {
    consecutiveOkTools: 0,
    consecutiveErrors: 0,
    testPasses: 0,
    planUpdates: 0,
    lastToolName: '',
    lastYield: null,
    waitingSinceMs: null,
    parentSessionId: null,
  };
}

export function classifyToolYield(toolName = '', ok = true, lang = 'ko') {
  const t = simMotivesText(lang).yields;
  if (ok === false) return { kind: 'retry', label: t.retry };
  const name = String(toolName || '').toLowerCase();
  if (/edit|write|patch|replace/.test(name)) return { kind: 'patch', label: t.patch };
  if (/bash|test|exec|run/.test(name)) return { kind: 'pass', label: t.pass };
  if (/todo|plan|task/.test(name)) return { kind: 'plan', label: t.plan };
  return { kind: 'insight', label: t.insight };
}

export function applyEventToMotives(state, ev, nowMs = Date.now()) {
  const s = state || createAgentMotiveState();
  if (!ev || typeof ev !== 'object') return s;
  if (ev.parentSessionId && typeof ev.parentSessionId === 'string') {
    s.parentSessionId = ev.parentSessionId;
  }
  switch (ev.type) {
    case 'tool_start':
      s.lastToolName = String(ev.tool || 'tool');
      if (ev.approval || ev.waiting) s.waitingSinceMs = s.waitingSinceMs ?? nowMs;
      break;
    case 'tool_use': {
      const first = Array.isArray(ev.tools) && ev.tools[0] ? ev.tools[0].name : 'tool';
      s.lastToolName = String(first || 'tool');
      break;
    }
    case 'tool_end':
    case 'tool_result': {
      const failed = ev.ok === false || Number(ev.errors) > 0;
      s.waitingSinceMs = null;
      if (failed) {
        s.consecutiveErrors += 1;
        s.consecutiveOkTools = 0;
        s.lastYield = classifyToolYield(s.lastToolName, false);
      } else {
        s.consecutiveOkTools += 1;
        s.consecutiveErrors = 0;
        const y = classifyToolYield(s.lastToolName, true);
        if (y.kind === 'pass') s.testPasses += 1;
        if (y.kind === 'plan') s.planUpdates += 1;
        s.lastYield = y;
      }
      break;
    }
    case 'ask':
      s.waitingSinceMs = s.waitingSinceMs ?? nowMs;
      break;
    case 'user':
    case 'prompt':
    case 'turn_end':
      s.waitingSinceMs = null;
      break;
    default:
      break;
  }
  return s;
}

export function computeAgentMotives(motiveState, metricsState, agentLike = {}, nowMs = Date.now()) {
  const ms = motiveState || createAgentMotiveState();
  const met = metricsState || {};
  const ctxTok = Number(met.contextTokens) || 0;
  const ctxWin = Number(met.contextWindow) || 200_000;
  const ctxPct = clamp(Math.round((ctxTok / Math.max(1, ctxWin)) * 100), 0, 100);

  const freshness = clamp(100 - ctxPct + (Number(met.compactions) > 0 ? 10 : 0), 5, 100);
  const isWaiting = agentLike?.mode === 'ask' || Boolean(ms.waitingSinceMs);
  const waitSec = ms.waitingSinceMs ? Math.max(0, (nowMs - ms.waitingSinceMs) / 1000) : 0;

  const momentum = clamp(
    55 + ms.consecutiveOkTools * 9 - ms.consecutiveErrors * 22 - (isWaiting ? 20 : 0),
    5,
    100,
  );
  const alignment = isWaiting
    ? clamp(Math.round(100 - waitSec * 1.8), 15, 95)
    : clamp(88 + Math.min(12, ms.planUpdates * 6), 40, 100);
  const verification = clamp(
    82 + ms.testPasses * 6 - (Number(met.toolErrors) || 0) * 16,
    10,
    100,
  );

  return {
    freshness,
    momentum,
    alignment,
    verification,
    contextPct: ctxPct,
    isWaiting,
    waitSeconds: Math.round(waitSec),
  };
}

export function buildActionQueue(agentLike = {}, motiveState = {}, lang = 'ko') {
  const t = simMotivesText(lang);
  const room = ROOMS[agentLike.room] ? agentLike.room : 'lounge';
  const currentAct = String(agentLike.activity || t.queueSteps[room] || room);
  const nextRooms = SOP_NEXT_MAP[room] || SOP_NEXT_MAP.lounge;
  return [
    { status: 'now', room, label: `${t.nowPrefix}: ${currentAct}` },
    { status: 'next', room: nextRooms[0], label: `${t.nextPrefix}: ${t.queueSteps[nextRooms[0]]}` },
    { status: 'later', room: nextRooms[1], label: `${t.laterPrefix}: ${t.queueSteps[nextRooms[1]]}` },
  ];
}

export function deriveMoodlets(motiveState, metricsState, agentLike = {}, lang = 'ko') {
  const ms = motiveState || createAgentMotiveState();
  const met = metricsState || {};
  const t = simMotivesText(lang).moodlets;
  const motives = computeAgentMotives(ms, met, agentLike);
  const out = [];

  if (ms.consecutiveOkTools >= 3) out.push({ id: 'on_a_roll', tone: 'good', label: t.onARoll });
  if (Number(met.compactions) > 0) out.push({ id: 'compacted', tone: 'good', label: t.compacted });
  if (agentLike?.isSub || ms.parentSessionId) out.push({ id: 'sub_linked', tone: 'info', label: t.subLinked });
  if (motives.isWaiting) out.push({ id: 'approval_hold', tone: 'warn', label: t.approvalHold });
  if (motives.contextPct >= 75) out.push({ id: 'context_heavy', tone: 'bad', label: t.contextHeavy });
  if (out.length === 0) out.push({ id: 'steady', tone: 'good', label: t.steady });
  return out;
}

function motiveColor(val) {
  if (val >= 70) return '#22c55e';
  if (val >= 40) return '#f59e0b';
  return '#ef4444';
}

export function installSimMotives({
  office,
  hud,
  extras = null,
  THREE = null,
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  const motivesBySid = new Map();

  if (doc?.head && !doc.getElementById?.('sim-motives-style')) {
    const style = doc.createElement('style');
    style.id = 'sim-motives-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  const ensureMotive = (sid) => {
    if (!motivesBySid.has(sid)) motivesBySid.set(sid, createAgentMotiveState());
    return motivesBySid.get(sid);
  };

  function showYieldBadge(agent, yieldObj) {
    if (!agent?.tagEl || !yieldObj || !doc) return;
    let badge = agent.tagEl.querySelector('.sim-yield-pop');
    if (!badge) {
      badge = doc.createElement('span');
      badge.className = 'sim-yield-pop';
      agent.tagEl.appendChild(badge);
    }
    badge.textContent = yieldObj.label;
    badge.hidden = false;
    agent._yieldHideAt = (win?.performance?.now?.() ?? Date.now()) + 2600;
  }

  function renderInspectorMotives(agent) {
    const insp = hud?.el?.insp;
    if (!insp || !agent || !doc) return;
    const lang = hud?.lang || 'ko';
    const t = simMotivesText(lang);
    const ms = ensureMotive(agent.id);
    const met = extras?.metricsBySid?.get?.(agent.id) || {};
    const motives = computeAgentMotives(ms, met, agent);
    const queue = buildActionQueue(agent, ms, lang);
    const moodlets = deriveMoodlets(ms, met, agent, lang);

    let card = insp.querySelector('.sim-insp-card');
    if (!card) {
      card = doc.createElement('div');
      card.className = 'sim-insp-card';
      const dl = insp.querySelector('dl');
      if (dl) insp.insertBefore(card, dl);
      else insp.appendChild(card);
    }
    card.replaceChildren();

    const qRow = doc.createElement('div');
    qRow.className = 'sim-queue-row';
    for (const item of queue) {
      const chip = doc.createElement('span');
      chip.className = `sim-q-chip${item.status === 'now' ? ' now' : ''}`;
      chip.textContent = item.label;
      qRow.appendChild(chip);
    }
    card.appendChild(qRow);

    const mGrid = doc.createElement('div');
    mGrid.className = 'sim-motives-grid';
    const pairs = [
      [t.freshness, motives.freshness],
      [t.momentum, motives.momentum],
      [t.alignment, motives.alignment],
      [t.verification, motives.verification],
    ];
    for (const [label, val] of pairs) {
      const row = doc.createElement('div');
      row.className = 'sim-motive-item';
      const b = doc.createElement('b');
      b.textContent = label;
      const track = doc.createElement('div');
      track.className = 'sim-motive-track';
      const fill = doc.createElement('div');
      fill.className = 'sim-motive-fill';
      fill.style.width = `${val}%`;
      fill.style.background = motiveColor(val);
      track.appendChild(fill);
      const num = doc.createElement('span');
      num.textContent = `${val}%`;
      row.append(b, track, num);
      mGrid.appendChild(row);
    }
    card.appendChild(mGrid);

    const moodRow = doc.createElement('div');
    moodRow.className = 'sim-moodlets-row';
    for (const m of moodlets) {
      const chip = doc.createElement('span');
      chip.className = `sim-moodlet ${m.tone}`;
      chip.textContent = m.label;
      moodRow.appendChild(chip);
    }
    card.appendChild(moodRow);
  }

  function syncFloorTethers(floor) {
    if (!THREE || !floor?.group) return;
    if (!floor._tetherGroup) {
      floor._tetherGroup = new THREE.Group();
      floor._tetherGroup.name = 'sim-handoff-tethers';
      floor.group.add(floor._tetherGroup);
    }
    const tg = floor._tetherGroup;
    while (tg.children.length) {
      const ch = tg.children.pop();
      ch.geometry?.dispose?.();
      ch.material?.dispose?.();
    }
    const agents = [...(floor.agents || [])];
    if (agents.length < 2) return;
    const lead = agents.find((a) => !a.isSub) || agents[0];
    for (const sub of agents) {
      if (sub === lead) continue;
      const ms = motivesBySid.get(sub.id);
      if (!sub.isSub && !ms?.parentSessionId) continue;
      const parent = (ms?.parentSessionId && office.agents.get(ms.parentSessionId)) || lead;
      if (!parent || parent.floor !== floor) continue;
      const p0 = parent.group.position;
      const p2 = sub.group.position;
      const mid = new THREE.Vector3((p0.x + p2.x) * 0.5, Math.max(p0.y, p2.y) + 1.65, (p0.z + p2.z) * 0.5);
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(p0.x, p0.y + 0.9, p0.z),
        mid,
        new THREE.Vector3(p2.x, p2.y + 0.9, p2.z),
      );
      const pts = curve.getPoints(18);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.65 });
      tg.add(new THREE.Line(geo, mat));
    }
  }

  if (office) {
    const origOnEvent = office.onEvent.bind(office);
    office.onEvent = (ev) => {
      origOnEvent(ev);
      if (!ev?.sessionId) return;
      const ms = ensureMotive(ev.sessionId);
      const prevYield = ms.lastYield;
      applyEventToMotives(ms, ev);
      const a = office.agents.get(ev.sessionId);
      if (a && ms.lastYield && ms.lastYield !== prevYield && !ev.replay) {
        showYieldBadge(a, classifyToolYield(ms.lastToolName, ms.consecutiveErrors === 0, hud?.lang));
      }
      if (a && office.selected === a) renderInspectorMotives(a);
    };

    const origSelect = office.select.bind(office);
    office.select = (a, opts) => {
      origSelect(a, opts);
      if (a) renderInspectorMotives(a);
    };

    const origUpdate = office.update.bind(office);
    let tetherAccum = 0;
    office.update = (dt, realDt) => {
      origUpdate(dt, realDt);
      const now = win?.performance?.now?.() ?? Date.now();
      for (const a of office.agents.values()) {
        if (a._yieldHideAt && now >= a._yieldHideAt) {
          const b = a.tagEl?.querySelector?.('.sim-yield-pop');
          if (b) b.hidden = true;
          a._yieldHideAt = 0;
        }
      }
      tetherAccum += realDt || dt || 0.016;
      if (tetherAccum >= 0.25) {
        tetherAccum = 0;
        for (const f of office.floors) if (f.group?.visible) syncFloorTethers(f);
      }
    };
  }

  return { motivesBySid, renderInspectorMotives, ensureMotive };
}
