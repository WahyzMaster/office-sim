// Phase 4 (SimTower Floor Prestige & Queue Overflow Badges in #floors):
// - SimTower 1..5 Star Floor Prestige Rating & Room Slot Queue Badges ([Q:n]) in #floors
// - Pure advisor evaluation helpers (no redundant bottom #sim-advisor-strip banner)
import { langOf } from './rooms.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const SIM_ADVISOR_TEXT = Object.freeze({
  ko: Object.freeze({
    domains: Object.freeze({
      FLYWHEEL: '플라이휠',
      APPROVAL: '승인대기',
      QUEUE: '방대기열',
      CONTEXT: '컨텍스트',
      PRESTIGE: '층명성',
    }),
    alerts: Object.freeze({
      flywheelOpen: (n) => `오픈 신호 ${n}건 감지 (플라이휠 렌즈 5에서 확인)`,
      approvalWait: (name, floorNo) => `${floorNo} ${name} 사람 승인 대기 중`,
      roomQueue: (floorNo, q) => `${floorNo} 방 좌석 초과 대기열 ${q}명`,
      highContext: (name, pct) => `${name} 컨텍스트 ${pct}% 사용 중 (압축 권장)`,
      fiveStar: (floorNo, label) => `${floorNo} ${label} 5성급 스프린트 달성`,
    }),
  }),
  en: Object.freeze({
    domains: Object.freeze({
      FLYWHEEL: 'FLYWHEEL',
      APPROVAL: 'APPROVAL',
      QUEUE: 'QUEUE',
      CONTEXT: 'CONTEXT',
      PRESTIGE: 'PRESTIGE',
    }),
    alerts: Object.freeze({
      flywheelOpen: (n) => `${n} active Flywheel signal(s) open (Press V for Mode 5)`,
      approvalWait: (name, floorNo) => `${floorNo} ${name} awaiting human approval`,
      roomQueue: (floorNo, q) => `${floorNo} room slot overflow queue: ${q} waiting`,
      highContext: (name, pct) => `${name} at ${pct}% context window load`,
      fiveStar: (floorNo, label) => `${floorNo} ${label} achieved 5-Star prestige`,
    }),
  }),
});

export const simAdvisorText = (lang = 'ko') => SIM_ADVISOR_TEXT[langOf(lang)];

const STYLE_CSS = `
.sim-floor-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
}
.sim-floor-q {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--ask);
  color: var(--ask-ink);
  border: 1px solid var(--ask-line);
}
.sim-floor-p {
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 16%, var(--muted-bg));
  color: var(--fg);
  border: 1px solid var(--accent);
}
`;

export function computeFloorPrestige(floorLike = {}, metricsBySid = new Map()) {
  const agents = [...(floorLike.agents || [])];
  let queueCount = 0;
  if (floorLike.waiting && typeof floorLike.waiting === 'object') {
    for (const arr of Object.values(floorLike.waiting)) {
      if (Array.isArray(arr)) queueCount += arr.filter(Boolean).length;
    }
  }
  const boardItems = Array.isArray(floorLike.board?.items) ? floorLike.board.items : [];
  const doneCount = boardItems.filter((it) => it?.status === 'completed' || it?.done).length;
  const doneRatio = boardItems.length > 0 ? doneCount / boardItems.length : 0.6;

  let errorTotal = 0;
  let turnTotal = 0;
  for (const a of agents) {
    const m = metricsBySid?.get?.(a.id) || {};
    errorTotal += Number(m.toolErrors) || 0;
    turnTotal += Number(m.turns) || 0;
  }

  let rawStars = 3;
  if (agents.length > 0) rawStars += 1;
  if (doneRatio >= 0.75 || turnTotal >= 2) rawStars += 1;
  if (queueCount >= 2) rawStars -= 1;
  if (errorTotal >= 2) rawStars -= 1;

  const stars = clamp(rawStars, 1, 5);
  const starString = `[${'*'.repeat(stars)}${'-'.repeat(5 - stars)}]`;
  return {
    stars,
    starString,
    queueCount,
    doneRatio: Math.round(doneRatio * 100),
    planDone: doneCount,
    planTotal: boardItems.length,
  };
}

export function evaluateAdvisors(officeLike = {}, metricsBySid = new Map(), flywheelModel = null, lang = 'ko') {
  const t = simAdvisorText(lang);
  const alerts = [];

  const openFw = Number(flywheelModel?.stage1?.openCount) || 0;
  if (openFw > 0) {
    alerts.push({
      id: 'fw-open',
      severity: 'fail',
      domain: t.domains.FLYWHEEL,
      text: t.alerts.flywheelOpen(openFw),
      focusFloorIndex: null,
      focusAgentId: null,
      openFlywheelMode: true,
    });
  }

  const floors = Array.isArray(officeLike.floors) ? officeLike.floors : [];
  for (const f of floors) {
    const prestige = computeFloorPrestige(f, metricsBySid);
    for (const a of f.agents || []) {
      if (a.mode === 'ask') {
        alerts.push({
          id: `ask-${a.id}`,
          severity: 'warn',
          domain: t.domains.APPROVAL,
          text: t.alerts.approvalWait(a.name || a.id, f.number || '1F'),
          focusFloorIndex: f.index,
          focusAgentId: a.id,
        });
      }
      const m = metricsBySid?.get?.(a.id) || {};
      const pct = Math.round(((Number(m.contextTokens) || 0) / Math.max(1, Number(m.contextWindow) || 200_000)) * 100);
      if (pct >= 75) {
        alerts.push({
          id: `ctx-${a.id}`,
          severity: 'warn',
          domain: t.domains.CONTEXT,
          text: t.alerts.highContext(a.name || a.id, pct),
          focusFloorIndex: f.index,
          focusAgentId: a.id,
        });
      }
    }
    if (prestige.queueCount > 0) {
      alerts.push({
        id: `q-${f.index}`,
        severity: 'warn',
        domain: t.domains.QUEUE,
        text: t.alerts.roomQueue(f.number || '1F', prestige.queueCount),
        focusFloorIndex: f.index,
        focusAgentId: null,
      });
    } else if (prestige.stars === 5 && (f.agents?.size || 0) > 0) {
      alerts.push({
        id: `star-${f.index}`,
        severity: 'good',
        domain: t.domains.PRESTIGE,
        text: t.alerts.fiveStar(f.number || '1F', f.label || ''),
        focusFloorIndex: f.index,
        focusAgentId: null,
      });
    }
  }

  return alerts;
}

export function installSimAdvisor({
  office,
  hud,
  extras = null,
  doc = globalThis.document,
} = {}) {
  if (doc?.head && !doc.getElementById?.('sim-advisor-style')) {
    const style = doc.createElement('style');
    style.id = 'sim-advisor-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  doc?.getElementById?.('sim-advisor-strip')?.remove?.();

  function decorateFloors() {
    const nav = hud?.el?.floors;
    if (!nav || !office?.floors || !doc) return;
    for (const f of office.floors) {
      const btn = nav.querySelector(`[data-i="${f.index}"]`);
      if (!btn) continue;
      const fnEl = btn.querySelector('.fn');
      if (!fnEl) continue;
      const p = computeFloorPrestige(f, extras?.metricsBySid);
      let meta = btn.querySelector('.sim-floor-meta');
      if (!meta) {
        meta = doc.createElement('span');
        meta.className = 'sim-floor-meta';
        fnEl.after(meta);
      }
      meta.replaceChildren();
      const starsSpan = doc.createElement('span');
      starsSpan.textContent = p.starString;
      meta.appendChild(starsSpan);
      if (p.planTotal > 0) {
        const pSpan = doc.createElement('span');
        pSpan.className = 'sim-floor-p';
        pSpan.textContent = `P:${p.planDone}/${p.planTotal}`;
        meta.appendChild(pSpan);
      }
      if (p.queueCount > 0) {
        const qSpan = doc.createElement('span');
        qSpan.className = 'sim-floor-q';
        qSpan.textContent = `Q:${p.queueCount}`;
        meta.appendChild(qSpan);
      }
    }
  }

  if (hud?.floorStats) {
    const origFloorStats = hud.floorStats.bind(hud);
    hud.floorStats = (off) => {
      origFloorStats(off);
      decorateFloors();
    };
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => {
    decorateFloors();
  });

  decorateFloors();

  return { decorateFloors };
}
