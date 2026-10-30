// Phase 4 (Auto-Collapsing SimCity Advisor Toast Strip & SimTower Floor Prestige):
// - Auto-collapsing floating Advisor & Flywheel Toast Strip (#sim-advisor-strip) docked above #inspector
// - SimTower 1..5 Star Floor Prestige Rating & Room Slot Queue Badges ([Q:n]) in #floors
import { langOf } from './rooms.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const SIM_ADVISOR_TEXT = Object.freeze({
  ko: Object.freeze({
    quietLabel: '[자문위원] P1..P8 정상 · 대기 병목 없음',
    focusBtn: '이동',
    collapseBtn: '접기 _',
    expandBtn: '자문 ^',
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
    quietLabel: '[ADVISOR] P1..P8 Nominal · 0 Bottlenecks',
    focusBtn: 'Focus',
    collapseBtn: 'Quiet _',
    expandBtn: 'Advisor ^',
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
#sim-advisor-strip {
  position: fixed;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 24;
  pointer-events: auto;
  max-width: min(680px, calc(100vw - 32px));
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(252, 249, 242, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(58, 42, 29, 0.22);
  box-shadow: 0 8px 22px rgba(28, 20, 14, 0.14);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #2b2118;
  transform-origin: bottom center;
  transition: bottom 180ms cubic-bezier(0.22, 1, 0.36, 1), transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
#sim-advisor-strip.above-insp {
  bottom: 224px;
}
#sim-advisor-strip.collapsed {
  opacity: 0.85;
  padding: 3px 9px;
}
.sim-adv-badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 10px;
}
.sim-adv-badge.fail { background: #fee2e2; color: #991b1b; }
.sim-adv-badge.warn { background: #fef3c7; color: #92400e; }
.sim-adv-badge.good { background: #dcfce7; color: #166534; }
.sim-adv-badge.info { background: #e0e7ff; color: #1e40af; }
.sim-adv-btn {
  border: 1px solid rgba(58, 42, 29, 0.2);
  background: #fff;
  color: #2b2118;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.sim-floor-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  font-size: 9.5px;
  font-weight: 700;
  color: #854d0e;
}
.sim-floor-q {
  padding: 0 4px;
  border-radius: 4px;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid rgba(146, 64, 14, 0.28);
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
  return { stars, starString, queueCount, doneRatio: Math.round(doneRatio * 100) };
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
  overlays = null,
  flywheelViz = null,
  doc = globalThis.document,
} = {}) {
  let collapsed = false;

  if (doc?.head && !doc.getElementById?.('sim-advisor-style')) {
    const style = doc.createElement('style');
    style.id = 'sim-advisor-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  let strip = doc?.getElementById?.('sim-advisor-strip') ?? null;
  if (!strip && doc) {
    const hudRoot = doc.getElementById?.('hud') ?? doc.body;
    if (hudRoot) {
      strip = doc.createElement('div');
      strip.id = 'sim-advisor-strip';
      strip.setAttribute('role', 'status');
      hudRoot.appendChild(strip);
    }
  }

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
      if (p.queueCount > 0) {
        const qSpan = doc.createElement('span');
        qSpan.className = 'sim-floor-q';
        qSpan.textContent = `Q:${p.queueCount}`;
        meta.appendChild(qSpan);
      }
    }
  }

  function renderStrip() {
    if (!strip || !doc) return;
    const lang = hud?.lang || 'ko';
    const t = simAdvisorText(lang);
    const inspOpen = Boolean(office?.selected && hud?.el?.insp && !hud.el.insp.hidden);
    strip.classList.toggle('above-insp', inspOpen);
    strip.classList.toggle('collapsed', collapsed);
    strip.replaceChildren();

    const fwModel = flywheelViz?.getModel?.() || null;
    const alerts = evaluateAdvisors(office, extras?.metricsBySid, fwModel, lang);
    const top = alerts[0] || null;

    if (collapsed || !top) {
      const badge = doc.createElement('span');
      badge.className = `sim-adv-badge ${top ? top.severity : 'good'}`;
      badge.textContent = top ? `${top.domain} (${alerts.length})` : t.quietLabel;
      strip.appendChild(badge);
      if (top) {
        const expBtn = doc.createElement('button');
        expBtn.type = 'button';
        expBtn.className = 'sim-adv-btn';
        expBtn.textContent = t.expandBtn;
        expBtn.addEventListener('click', () => { collapsed = false; renderStrip(); });
        strip.appendChild(expBtn);
      }
      return;
    }

    const badge = doc.createElement('span');
    badge.className = `sim-adv-badge ${top.severity}`;
    badge.textContent = top.domain;
    const msg = doc.createElement('span');
    msg.textContent = top.text;
    strip.append(badge, msg);

    if (top.openFlywheelMode || top.focusAgentId || top.focusFloorIndex !== null) {
      const focusBtn = doc.createElement('button');
      focusBtn.type = 'button';
      focusBtn.className = 'sim-adv-btn';
      focusBtn.textContent = t.focusBtn;
      focusBtn.addEventListener('click', () => {
        if (top.openFlywheelMode) overlays?.setMode?.('flywheel');
        if (top.focusFloorIndex !== null) office?.focus?.(top.focusFloorIndex);
        if (top.focusAgentId) {
          const ag = office?.agents?.get?.(top.focusAgentId);
          if (ag) office?.select?.(ag, { focusPan: true });
        }
      });
      strip.appendChild(focusBtn);
    }

    const colBtn = doc.createElement('button');
    colBtn.type = 'button';
    colBtn.className = 'sim-adv-btn';
    colBtn.textContent = t.collapseBtn;
    colBtn.addEventListener('click', () => { collapsed = true; renderStrip(); });
    strip.appendChild(colBtn);
  }

  if (hud?.floorStats) {
    const origFloorStats = hud.floorStats.bind(hud);
    hud.floorStats = (off) => {
      origFloorStats(off);
      decorateFloors();
      renderStrip();
    };
  }

  if (office?.select) {
    const origSelect = office.select.bind(office);
    office.select = (a, opts) => {
      origSelect(a, opts);
      renderStrip();
    };
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => {
    decorateFloors();
    renderStrip();
  });

  decorateFloors();
  renderStrip();

  return { renderStrip, decorateFloors };
}
