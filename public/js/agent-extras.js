// P2, P3, P4 (Frontend):
// - P2: Click 3D character -> Focus native terminal tab (POST /api/focus-terminal, shortcut T)
// - P3: 3D Context Window Fuel Ring under each character + Context Compaction particle burst + Token/USD meter
// - P4: Unreviewed "Done (✓)" badge on floating tag + 1-click Sprint Recap card & Markdown copy (shortcut M)
import { langOf } from './rooms.js';

export const DEFAULT_CONTEXT_LIMIT = 200_000;

export const EXTRAS_TEXT = Object.freeze({
  ko: Object.freeze({
    focusBtn: '터미널 열기 (T)',
    focusTitle: '이 에이전트가 실행 중인 터미널/IDE 탭으로 바로 이동 (단축키 T)',
    focusedMsg: (target) => `${target || '터미널'} 포커스 완료`,
    focusFailMsg: '로컬 터미널을 찾지 못했어요',
    recapBtn: '스프린트 요약 (M)',
    recapTitle: '턴·도구·컨텍스트·토큰 비용 요약 카드 보기 및 마크다운 복사 (단축키 M)',
    copyBtn: '마크다운 복사',
    copiedBtn: '복사됨!',
    contextRow: '컨텍스트 연료',
    costRow: '추정 토큰·비용',
    doneBadge: '✓ 완료',
    compactToast: '기억 압축 완료 (컨텍스트 65% 확보)',
  }),
  en: Object.freeze({
    focusBtn: 'Focus TTY (T)',
    focusTitle: 'Bring the native terminal or IDE tab for this agent to front (Shortcut T)',
    focusedMsg: (target) => `Focused ${target || 'Terminal'}`,
    focusFailMsg: 'Local terminal tab not found',
    recapBtn: 'Sprint Recap (M)',
    recapTitle: 'View turn, tool, context & token cost recap and copy Markdown (Shortcut M)',
    copyBtn: 'Copy Markdown',
    copiedBtn: 'Copied!',
    contextRow: 'Context Fuel',
    costRow: 'Est. Spend',
    doneBadge: '✓ Done',
    compactToast: 'Context compacted (65% freed)',
  }),
});

export const extrasText = (lang = 'ko') => EXTRAS_TEXT[langOf(lang)];

export function computeContextFuelColor(pct) {
  const n = Number(pct) || 0;
  const p = n > 0 && n <= 1 ? n * 100 : n;
  if (p >= 80) return '#f0554a'; // Red warning
  if (p >= 60) return '#e0a32a'; // Amber caution
  return '#2fb36a'; // Healthy green
}

export function createAgentMetricsState() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    contextWindow: DEFAULT_CONTEXT_LIMIT,
    contextPct: 0,
    estimatedCostUsd: 0,
    compactions: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCounts: {},
    filesTouched: [],
    unreviewedDone: false,
    startedAt: Date.now(),
  };
}

export function applyEventToMetrics(state, ev) {
  const m = state || createAgentMetricsState();
  if (!ev || typeof ev !== 'object') return m;
  const recordFile = (summary) => {
    if (typeof summary !== 'string' || !summary.trim()) return;
    const candidate = summary.trim().split(/\s+/)[0].split('/').pop();
    if (candidate && /\.[a-z0-9]{1,8}$/i.test(candidate) && !m.filesTouched.includes(candidate) && m.filesTouched.length < 25) {
      m.filesTouched.push(candidate);
    }
  };
  switch (ev.type) {
    case 'user':
    case 'prompt':
      m.unreviewedDone = false;
      m.inputTokens += 650;
      m.contextTokens = Math.min(m.contextWindow, m.contextTokens + 650);
      break;
    case 'assistant': {
      const inTok = Number(ev.usage?.input_tokens ?? ev.usage?.inputTokens) || 450;
      const outTok = Number(ev.usage?.output_tokens ?? ev.usage?.outputTokens) || 250;
      m.inputTokens += inTok;
      m.outputTokens += outTok;
      m.contextTokens = Math.min(m.contextWindow, inTok + outTok);
      break;
    }
    case 'thinking':
      m.outputTokens += 450;
      m.contextTokens = Math.min(m.contextWindow, m.contextTokens + 450);
      break;
    case 'say': {
      const toks = Math.max(80, Math.round(String(ev.text || '').length * 1.5));
      m.outputTokens += toks;
      m.contextTokens = Math.min(m.contextWindow, m.contextTokens + toks);
      break;
    }
    case 'tool_use': {
      const tools = Array.isArray(ev.tools) ? ev.tools : [];
      for (const t of tools) {
        m.toolCalls += 1;
        const name = String(t?.name || 'tool');
        m.toolCounts[name] = (m.toolCounts[name] || 0) + 1;
        recordFile(t?.summary);
      }
      m.inputTokens += Math.max(1, tools.length) * 900;
      m.contextTokens = Math.min(m.contextWindow, m.contextTokens + Math.max(1, tools.length) * 900);
      break;
    }
    case 'tool_start': {
      m.toolCalls += 1;
      const tool = String(ev.tool || 'tool');
      m.toolCounts[tool] = (m.toolCounts[tool] || 0) + 1;
      m.inputTokens += 900;
      m.contextTokens = Math.min(m.contextWindow, m.contextTokens + 900);
      recordFile(ev.summary);
      break;
    }
    case 'tool_result':
      if (Number(ev.errors) > 0) m.toolErrors += Number(ev.errors);
      break;
    case 'tool_end':
      if (ev.ok === false && ev.errorKind !== 'abandoned') m.toolErrors += 1;
      break;
    case 'turn_end':
      m.turns += 1;
      m.unreviewedDone = true;
      break;
    case 'session_end':
      m.unreviewedDone = true;
      break;
    case 'system':
      if (ev.kind === 'compact') {
        m.compactions += 1;
        m.contextTokens = Math.round(m.contextTokens * 0.35);
      }
      break;
    default:
      break;
  }
  m.contextPct = Math.min(1, m.contextTokens / (m.contextWindow || DEFAULT_CONTEXT_LIMIT));
  m.estimatedCostUsd = Number((((m.inputTokens || 0) / 1e6) * 3.0 + ((m.outputTokens || 0) / 1e6) * 15.0).toFixed(4));
  return m;
}

export function formatMetricsSummary(m, agentName = 'Agent', projectLabel = 'Project') {
  const pct = Math.min(100, Math.round(((m?.contextTokens || 0) / (m?.contextWindow || DEFAULT_CONTEXT_LIMIT)) * 100));
  const costUsd = Number((((m?.inputTokens || 0) / 1e6) * 3.0 + ((m?.outputTokens || 0) / 1e6) * 15.0).toFixed(4));
  const durationSec = Math.max(1, Math.round((Date.now() - (m?.startedAt || Date.now())) / 1000));
  const topTools = Object.entries(m?.toolCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}(${v})`)
    .join(', ');
  const markdown = [
    `## Sprint Session Recap — ${agentName} (${projectLabel})`,
    `- **Duration**: ${durationSec}s · **Turns**: ${m?.turns || 0} · **Compactions**: ${m?.compactions || 0}`,
    `- **Context Fuel**: ${pct}% (${(m?.contextTokens || 0).toLocaleString()} / ${(m?.contextWindow || DEFAULT_CONTEXT_LIMIT).toLocaleString()} tokens)`,
    `- **Est. Token Spend**: ~$${costUsd.toFixed(4)} (${(m?.inputTokens || 0).toLocaleString()} in / ${(m?.outputTokens || 0).toLocaleString()} out)`,
    `- **Tool Calls**: ${m?.toolCalls || 0} (${m?.toolErrors || 0} failed)${topTools ? ` — ${topTools}` : ''}`,
    `- **Files Touched**: ${m?.filesTouched?.length ? m.filesTouched.map((f) => `\`${f}\``).join(', ') : '(none)'}`,
  ].join('\n');

  return {
    pct,
    costUsd,
    durationSec,
    contextLabel: `${pct}% (${Math.round((m?.contextTokens || 0) / 1000)}k / ${Math.round((m?.contextWindow || DEFAULT_CONTEXT_LIMIT) / 1000)}k · C:${m?.compactions || 0})`,
    costLabel: `~$${costUsd.toFixed(4)} (${m?.toolCalls || 0} tools · ${m?.turns || 0} turns)`,
    markdown,
  };
}

function injectExtrasStyles(doc) {
  if (!doc || doc.getElementById('office-sim-extras-css')) return;
  const style = doc.createElement('style');
  style.id = 'office-sim-extras-css';
  style.textContent = `
    .tag .done-pill {
      font: 600 9.5px/1.1 var(--font-ui); padding: 1px 5px; border-radius: 999px;
      background: #2fb36a; color: #ffffff; flex: none;
    }
    .recap-box {
      margin-top: 8px; padding: 8px 10px; border-radius: 8px;
      background: var(--muted-bg); border: 1px solid var(--line);
      font: 400 11px/1.45 var(--font-mono); white-space: pre-wrap; position: relative;
    }
    .recap-box button {
      margin-top: 6px; font-size: 11px; padding: 2px 8px;
    }
  `;
  doc.head?.appendChild(style);
}

function attach3DContextRing(agent, THREE) {
  if (!THREE || !agent?.group || agent._contextRing) return;
  const geo = new THREE.RingGeometry(0.28, 0.35, 28);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x2fb36a,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.015;
  agent.group.add(mesh);
  agent._contextRing = mesh;
}

function triggerCompactionBurst(agent, THREE) {
  if (!THREE || !agent?.group) return;
  const burstGroup = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.06, 0.06, 0.02);
  const mat = new THREE.MeshBasicMaterial({ color: 0x43c3b6, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Mesh(geo, mat);
    const angle = (i / 8) * Math.PI * 2;
    p.position.set(Math.cos(angle) * 0.25, 0.4 + (i % 3) * 0.15, Math.sin(angle) * 0.25);
    burstGroup.add(p);
  }
  agent.group.add(burstGroup);
  agent._compactionBurst = { group: burstGroup, t: 1.6 };
}

export function installAgentExtras({
  office,
  hud,
  THREE = null,
  doc = globalThis.document,
  win = globalThis.window,
  fetchFn = globalThis.fetch,
} = {}) {
  if (!office || !hud || !doc) return null;
  injectExtrasStyles(doc);

  const metricsBySid = new Map();
  let recapVisible = false;

  const ensureMetrics = (sid) => {
    if (!metricsBySid.has(sid)) metricsBySid.set(sid, createAgentMetricsState());
    return metricsBySid.get(sid);
  };

  const syncAgentVisuals = (agent) => {
    if (!agent) return;
    attach3DContextRing(agent, THREE);
    const m = ensureMetrics(agent.id);
    const summary = formatMetricsSummary(m, agent.name, agent.floor?.label || 'Global');
    if (agent._contextRing) {
      agent._contextRing.material.color.set(computeContextFuelColor(summary.pct));
      agent._contextRing.material.opacity = summary.pct >= 80 ? 0.85 : 0.48;
    }
    if (agent.tagEl) {
      let pill = agent.tagEl.querySelector('.done-pill');
      if (m.unreviewedDone) {
        if (!pill) {
          pill = doc.createElement('em');
          pill.className = 'done-pill';
          agent.tagEl.insertBefore(pill, agent.tagEl.querySelector('b'));
        }
        pill.textContent = extrasText(hud.lang).doneBadge;
        pill.hidden = false;
      } else if (pill) {
        pill.hidden = true;
      }
    }
  };

  // Wrap office.onEvent to track context fuel, compaction bursts, and unreviewed done badges
  const origOnEvent = office.onEvent.bind(office);
  office.onEvent = (ev) => {
    origOnEvent(ev);
    if (!ev?.sessionId) return;
    const m = ensureMetrics(ev.sessionId);
    applyEventToMetrics(m, ev);
    const a = office.agents.get(ev.sessionId);
    if (a) {
      if (office.selected === a && m.unreviewedDone) m.unreviewedDone = false;
      if (ev.type === 'system' && ev.kind === 'compact' && !ev.replay) {
        triggerCompactionBurst(a, THREE);
        a.bubble?.('info', extrasText(hud.lang).compactToast, 3.0);
      }
      syncAgentVisuals(a);
      if (office.selected === a) renderInspectorExtras(a);
    }
  };

  // Wrap office.update to animate compaction bursts and pulsing context rings
  const origUpdate = office.update.bind(office);
  office.update = (dt, realDt) => {
    origUpdate(dt, realDt);
    for (const a of office.agents.values()) {
      if (a._compactionBurst) {
        a._compactionBurst.t -= dt;
        a._compactionBurst.group.position.y += dt * 0.7;
        a._compactionBurst.group.rotation.y += dt * 3.5;
        if (a._compactionBurst.t <= 0) {
          a.group.remove(a._compactionBurst.group);
          a._compactionBurst = null;
        }
      }
    }
  };

  // Wrap office.select to clear unreviewed badge on review
  const origSelect = office.select.bind(office);
  office.select = (a, opts) => {
    if (a) {
      const m = ensureMetrics(a.id);
      if (m.unreviewedDone) {
        m.unreviewedDone = false;
        syncAgentVisuals(a);
        try {
          fetchFn?.('/api/recap/review', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: a.id }),
          })?.catch?.(() => {});
        } catch { /* ignore */ }
      }
    }
    origSelect(a, opts);
    if (a) renderInspectorExtras(a);
  };

  async function requestTerminalFocus(agent) {
    if (!agent) return { ok: false };
    const t = extrasText(hud.lang);
    try {
      const res = await fetchFn?.('/api/focus-terminal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.id }),
      });
      const data = res ? await res.json() : { ok: false };
      if (data?.ok) {
        agent.bubble?.('info', t.focusedMsg(data.target), 2.4);
        return data;
      }
    } catch { /* ignore */ }
    agent.bubble?.('denied', t.focusFailMsg, 2.4);
    return { ok: false };
  }

  function renderInspectorExtras(agent) {
    const insp = hud.el?.insp;
    if (!insp || !agent) return;
    const t = extrasText(hud.lang);
    const header = insp.querySelector('header');
    if (header) {
      let focusBtn = header.querySelector('[data-act="focus-tty"]');
      if (!focusBtn) {
        focusBtn = doc.createElement('button');
        focusBtn.type = 'button';
        focusBtn.className = 'ghost';
        focusBtn.dataset.act = 'focus-tty';
        focusBtn.addEventListener('click', () => { if (office.selected) void requestTerminalFocus(office.selected); });
        header.insertBefore(focusBtn, header.querySelector('[data-act="close"]'));
      }
      focusBtn.textContent = t.focusBtn;
      focusBtn.title = t.focusTitle;

      let recapBtn = header.querySelector('[data-act="recap"]');
      if (!recapBtn) {
        recapBtn = doc.createElement('button');
        recapBtn.type = 'button';
        recapBtn.className = 'ghost';
        recapBtn.dataset.act = 'recap';
        recapBtn.addEventListener('click', () => {
          recapVisible = !recapVisible;
          if (office.selected) renderInspectorExtras(office.selected);
        });
        header.insertBefore(recapBtn, header.querySelector('[data-act="close"]'));
      }
      recapBtn.textContent = t.recapBtn;
      recapBtn.title = t.recapTitle;
      recapBtn.setAttribute('aria-pressed', String(recapVisible));
    }

    const m = ensureMetrics(agent.id);
    const summary = formatMetricsSummary(m, agent.name, agent.floor?.label || 'Global');
    const dl = insp.querySelector('dl');
    if (dl) {
      const upsertRow = (key, label, value) => {
        let dd = dl.querySelector(`dd[data-row="${key}"]`);
        let dt = dd?.previousElementSibling;
        if (!dd) {
          dt = doc.createElement('dt');
          dd = doc.createElement('dd');
          dd.dataset.row = key;
          dl.append(dt, dd);
        }
        if (dt) dt.textContent = label;
        dd.textContent = value;
      };
      upsertRow('contextFuel', t.contextRow, summary.contextLabel);
      upsertRow('estCost', t.costRow, summary.costLabel);
    }

    let box = insp.querySelector('.recap-box');
    if (recapVisible) {
      if (!box) {
        box = doc.createElement('div');
        box.className = 'recap-box';
        insp.appendChild(box);
      }
      if (!box._refs || !box.children?.length) {
        box.replaceChildren();
        const pre = doc.createElement('div');
        const copyBtn = doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ghost primary';
        copyBtn.addEventListener('click', () => {
          const textToCopy = box._refs?.latestMarkdown || '';
          win?.navigator?.clipboard?.writeText?.(textToCopy)?.catch?.(() => {});
          copyBtn.textContent = extrasText(hud.lang).copiedBtn;
          copyBtn.dataset.copied = 'true';
        });
        box.append(pre, copyBtn);
        box._refs = { pre, copyBtn, latestMarkdown: '' };
      }
      box._refs.latestMarkdown = summary.markdown;
      if (box._refs.pre.textContent !== summary.markdown) {
        box._refs.pre.textContent = summary.markdown;
      }
      if (box._refs.copyBtn.dataset.copied !== 'true') {
        box._refs.copyBtn.textContent = t.copyBtn;
      }
      box.hidden = false;
    } else if (box) {
      box.hidden = true;
      if (box._refs?.copyBtn) delete box._refs.copyBtn.dataset.copied;
    }
  }

  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => {
    if (office.selected) renderInspectorExtras(office.selected);
  });

  win?.addEventListener?.('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't' && office.selected) {
      e.preventDefault();
      void requestTerminalFocus(office.selected);
    } else if (k === 'm' && office.selected) {
      e.preventDefault();
      recapVisible = !recapVisible;
      renderInspectorExtras(office.selected);
    }
  });

  return { metricsBySid, requestTerminalFocus, renderInspectorExtras, syncAgentVisuals };
}
