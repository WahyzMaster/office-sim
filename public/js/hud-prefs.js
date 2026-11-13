// HUD labels, storage prefs, replay formatting, and panel DOM rendering helpers.
import { CHARACTER_CATALOG, isLlmVisible, uiText } from './rooms.js';

export const STORE = 'office-sim:v1';
export const LEGACY_STORE = 'claude-office:v1';

const AGENT_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI' };
const AGENT_BADGE = { 'claude-code': 'Claude', codex: 'Codex', grok: 'Grok', antigravity: 'AGY', 'gemini-cli': 'Gemini' };
const SURFACE_LABEL = {
  'claude-code:app': 'Claude/Claude Code·App', 'claude-code:cli': 'Claude Code·CLI', 'claude-code:ide': 'Claude Code·IDE',
  'codex:app': 'ChatGPT/Codex·App', 'codex:cli': 'Codex·CLI', 'codex:ide': 'Codex·IDE',
  'grok:app': 'Grok Bot·App', 'grok:cli': 'Grok Build·CLI', 'gemini-cli:cli': 'Gemini·CLI',
  'antigravity:cli': 'Antigravity·CLI', 'antigravity:app': 'Antigravity·App', 'antigravity:ide': 'Antigravity·IDE',
};
const SURFACE_BADGE = {
  'claude-code:app': 'Claude·App', 'claude-code:cli': 'Claude·CLI', 'claude-code:ide': 'Claude·IDE',
  'codex:app': 'ChatGPT·App', 'codex:cli': 'Codex·CLI', 'codex:ide': 'Codex·IDE',
  'grok:app': 'Grok·App', 'grok:cli': 'Grok·CLI', 'gemini-cli:cli': 'Gemini·CLI',
  'antigravity:cli': 'AGY·CLI', 'antigravity:app': 'AGY·App', 'antigravity:ide': 'AGY·IDE',
};

export const agentLabel = (id, surface = '') => (
  surface && Object.hasOwn(SURFACE_LABEL, `${id}:${surface}`) ? SURFACE_LABEL[`${id}:${surface}`] : Object.hasOwn(AGENT_LABEL, id) ? AGENT_LABEL[id] : id
);
export const agentBadge = (id, surface = '') => (
  surface && Object.hasOwn(SURFACE_BADGE, `${id}:${surface}`) ? SURFACE_BADGE[`${id}:${surface}`] : id && Object.hasOwn(AGENT_BADGE, id) ? AGENT_BADGE[id] : id || ''
);

export const DEFAULT_CONTROL_PRESET = 'map';
export const CONTROL_PRESETS = uiText('ko').controls;
export const controlPresetOf = (k) => (Object.hasOwn(CONTROL_PRESETS, k) ? k : DEFAULT_CONTROL_PRESET);

export function replayText(r, lang = 'ko') {
  const x = `${r.speed}×`, pct = `${Math.floor((r.progress || 0) * 100)}%`, en = lang === 'en';
  if (r.state === 'playing') return `${en ? 'Replay' : '재생'} · ${x} · ${pct}${r.loop && r.round > 1 ? ` · ${en ? `#${r.round}` : `${r.round}회째`}` : ''}`;
  if (r.state === 'paused') return `${en ? 'Paused' : '일시정지'} · ${x} · ${pct}`;
  if (r.state === 'done') return r.loop ? (en ? 'Done · restarting' : '재생 끝 · 곧 다시') : `${en ? 'Done' : '재생 끝'} · ${x}`;
  if (r.state === 'restart') return en ? 'Replay · restarting' : '재생 · 처음부터 다시';
  if (r.state === 'error') return en ? 'Replay · load failed' : '재생 · 기록을 읽지 못함';
  return en ? 'Replay · loading' : '재생 · 준비 중';
}

const timeStr = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
const storeOf = (storage) => storage ?? globalThis.localStorage;

export function migratePrefs(storage) {
  try {
    const s = storeOf(storage);
    const old = s.getItem(STORE) == null ? s.getItem(LEGACY_STORE) : null;
    if (old == null) return false;
    s.setItem(STORE, old);
    return true;
  } catch { return false; }
}

export function loadPrefs(storage) {
  migratePrefs(storage);
  try { const v = JSON.parse(storeOf(storage).getItem(STORE)); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export const savePrefs = (p) => { try { storeOf().setItem(STORE, JSON.stringify(p)); } catch { /* ignore */ } };

export function renderFloorNav(hud, office) {
  const nav = hud.el.floors;
  const focused = document.activeElement?.closest?.('#floors button')?.dataset.i;
  const t = uiText(hud.lang);
  nav.replaceChildren();
  const make = (i, no, name) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'fl', innerHTML: '<span class="no"></span><span class="nm"><b class="fn"></b><small class="ag" hidden></small></span><span class="ct"></span>' });
    b.dataset.i = String(i);
    b.querySelector('.no').textContent = no;
    b.querySelector('.fn').textContent = name;
    nav.append(b);
    return b;
  };
  const all = make('all', t.allNo, t.allName);
  all.setAttribute('aria-pressed', String(office.overview));
  all.classList.add('all');
  for (const f of [...office.floors].reverse()) {
    const b = make(f.index, f.number, f.label);
    b.title = f.key === '_global' ? t.globalTitle : f.key;
    b.setAttribute('aria-pressed', String(!office.overview && f.index === office.focusIndex));
  }
  renderFloorStats(hud, office);
  if (focused != null) nav.querySelector(`[data-i="${focused}"]`)?.focus();
}

export function renderFloorStats(hud, office) {
  const t = uiText(hud.lang);
  for (const f of office.floors) {
    const b = hud.el.floors.querySelector(`[data-i="${f.index}"]`);
    if (!b) continue;
    const agents = [...f.agents].filter((a) => isLlmVisible(a));
    const asking = agents.filter((a) => a.mode === 'ask').length;
    const approving = agents.filter((a) => a.mode === 'ask' && a.current?.approval).length;
    const counts = new Map();
    for (const a of agents) { const tag = agentBadge(a.agent, a.surface); if (tag) counts.set(tag, (counts.get(tag) || 0) + 1); }
    const agEl = b.querySelector('.ag');
    if (agEl) {
      const summary = [...counts].map(([k, n]) => (n > 1 ? `${k} ${n}` : k)).join(' · ');
      agEl.textContent = summary;
      agEl.hidden = !summary;
    }
    b.querySelector('.ct').textContent = asking ? t.askBadge(approving, asking) : String(agents.length);
    b.classList.toggle('asking', asking > 0);
    const ping = hud.pings.get(f);
    b.classList.toggle('ping', ping === 'activity');
    b.classList.toggle('alert', ping === 'error');
    b.setAttribute('aria-label', `${f.number} ${f.label}, ${agents.length}${asking ? `, ${t.askBadge(approving, asking)}` : ''}`);
  }
}

export function renderLogEntry(hud, agent, text, kind) {
  const li = Object.assign(document.createElement('li'), { hidden: !isLlmVisible(agent), innerHTML: '<time></time><i></i><b></b><span></span>' });
  li.dataset.kind = kind || '';
  li.dataset.sid = agent.id;
  li.querySelector('time').textContent = timeStr(new Date());
  li.querySelector('i').style.background = agent.color;
  const badge = agent.agent ? ` · ${agentBadge(agent.agent, agent.surface)}` : '';
  li.querySelector('b').textContent = `${agent.floor.number}${badge} ${agent.name}`;
  li.querySelector('span').textContent = text;
  hud.el.list.prepend(li);
  while (hud.el.list.children.length > 80) hud.el.list.lastElementChild.remove();
}

export function renderInspector(hud, a, office) {
  const box = hud.el.insp;
  if (!a) { box.hidden = true; delete box.dataset.sid; return; }
  const t = uiText(hud.lang);
  box.hidden = false;
  box.querySelector('.dot').style.background = a.color;
  box.querySelector('h2').textContent = a.name;
  const mode = a.path.length ? t.mode.moving : a.mode === 'ask' && a.current?.approval ? t.mode.approval
    : t.mode[a.panicT > 0 ? 'panic' : a.mode] || a.mode;
  const agentText = a.agent ? agentLabel(a.agent, a.surface || (a.agent === 'grok' ? 'cli' : '')) : '-';
  const rows = [
    ['project', t.rows.project, `${a.floor.number} · ${a.floor.label}`],
    ['agent', t.rows.agent, a.isSub ? `${agentText} · ${t.subBadge(a.agentType)}` : agentText],
    ['branch', t.rows.branch, a.worktree ? `${a.branch || '-'} (${t.worktreeBadge(a.worktree)})` : a.branch || '-'],
    ['status', t.rows.status, mode],
    ['activity', t.rows.activity, a.activity],
    ['queue', t.rows.queue, t.queueCount(a.queue.length)],
  ];
  const dl = box.querySelector('dl');
  const motionSel = box.querySelector('[data-act="motion"]');
  if (box.dataset.sid !== a.id || box.dataset.lang !== hud.lang) {
    box.dataset.sid = a.id; box.dataset.lang = hud.lang; delete box.dataset.histKey;
    dl.replaceChildren(...rows.flatMap(([key, label, val]) => {
      const dd = Object.assign(document.createElement('dd'), { textContent: val }); dd.dataset.row = key;
      return [Object.assign(document.createElement('dt'), { textContent: label }), dd];
    }));
    const addSelectRow = (key, label, opts, value, onChange) => {
      const dd = document.createElement('dd');
      const sel = Object.assign(document.createElement('select'), { value: value || 'auto' }); sel.dataset.sel = key;
      sel.replaceChildren(...opts.map(([k, text]) => Object.assign(document.createElement('option'), { value: k, textContent: text })));
      sel.value = value || 'auto';
      sel.addEventListener('change', () => onChange(sel.value));
      dd.append(sel); dl.append(Object.assign(document.createElement('dt'), { textContent: label }), dd);
    };
    addSelectRow('charOverride', t.rows.charOverride, Object.entries(CHARACTER_CATALOG).map(([k, v]) => [k, v[hud.lang] || v.ko]), a.charOverride, (v) => { a.charOverride = v; a.refreshCharacter?.(); });
    addSelectRow('postureOverride', t.rows.postureOverride, Object.entries(t.postures), a.postureOverride, (v) => { a.postureOverride = v; a.refreshCharacter?.(); });
    addSelectRow('motionOverride', t.rows.motionOverride, Object.entries(t.motions), a.motionOverride, (v) => { a.motionOverride = v; a.pet?.(v === 'auto' ? '' : v); hud.inspect(a, office); });
    if (motionSel) for (const o of motionSel.options) o.textContent = t.motions[o.value] || o.textContent;
  } else {
    for (const [key, , val] of rows) { const dd = dl.querySelector(`dd[data-row="${key}"]`); if (dd && dd.textContent !== val) dd.textContent = val; }
  }
  const syncSel = (sel, val) => { if (sel && globalThis.document?.activeElement !== sel && sel.value !== val) sel.value = val; };
  for (const [k, v] of [['charOverride', a.charOverride], ['postureOverride', a.postureOverride], ['motionOverride', a.motionOverride]]) syncSel(dl.querySelector(`select[data-sel="${k}"]`), v || 'auto');
  syncSel(motionSel, a.motionOverride || 'auto');
  const histKey = `${a.history.length}:${a.history[0]?.at?.getTime?.() || 0}`;
  if (box.dataset.histKey !== histKey) {
    box.dataset.histKey = histKey;
    box.querySelector('ol').replaceChildren(...a.history.slice(0, 7).map((h) => {
      const li = Object.assign(document.createElement('li'), { innerHTML: '<time></time><span></span>' });
      li.dataset.kind = h.kind; li.querySelector('time').textContent = timeStr(h.at); li.querySelector('span').textContent = h.text;
      return li;
    }));
  }
  box.querySelector('[data-act="follow"]').setAttribute('aria-pressed', String(office.follow));
}
