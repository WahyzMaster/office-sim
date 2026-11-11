// Interactive timeline scrubber for `--replay` mode (`GET/POST /api/replay`).
// Pure helpers (`formatReplayTime`, `scrubberText`, `mergeReplayBookmarks`, `nearestMarker`) are DOM-free for Node tests.
import { langOf } from './rooms.js';

const PIN_STORE = 'office-sim:replay-pins:v1';
const SPEEDS = [0.5, 1, 2, 4, 8];

const TEXT = {
  ko: {
    play: '재생', pause: '일시정지', restart: '처음부터',
    prev: '이전 마커', next: '다음 마커', pin: '+ 핀', pinned: '핀 저장됨',
    jumpPlaceholder: '마커 이동…', speedLabel: '배속',
    kinds: { prompt: '요청', plan: '계획', subagent: '서브', error: '오류', turn_end: '턴 끝', pin: '북마크' },
  },
  en: {
    play: 'Play', pause: 'Pause', restart: 'Restart',
    prev: 'Prev marker', next: 'Next marker', pin: '+ Pin', pinned: 'Pinned',
    jumpPlaceholder: 'Jump to marker…', speedLabel: 'Speed',
    kinds: { prompt: 'Prompt', plan: 'Plan', subagent: 'Subagent', error: 'Error', turn_end: 'Turn end', pin: 'Pin' },
  },
};

export function scrubberText(lang = 'ko') {
  return TEXT[lang === 'en' ? 'en' : 'ko'];
}

export function formatReplayTime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function mergeReplayBookmarks(serverMarkers = [], userPins = []) {
  const out = [];
  for (const m of Array.isArray(serverMarkers) ? serverMarkers : []) {
    if (!m || typeof m !== 'object') continue;
    out.push({
      cursor: Number.isInteger(m.cursor) ? m.cursor : null,
      progress: Math.min(1, Math.max(0, Number(m.progress) || 0)),
      dueMs: Number(m.dueMs) || 0,
      kind: m.kind || 'prompt',
      label: String(m.label || m.kind || ''),
    });
  }
  for (const p of Array.isArray(userPins) ? userPins : []) {
    if (!p || typeof p !== 'object') continue;
    out.push({
      cursor: Number.isInteger(p.cursor) ? p.cursor : null,
      progress: Math.min(1, Math.max(0, Number(p.progress) || 0)),
      dueMs: Number(p.dueMs) || 0,
      kind: 'pin',
      label: String(p.label || 'Pin'),
    });
  }
  return out.sort((a, b) => a.progress - b.progress || (a.cursor ?? 0) - (b.cursor ?? 0));
}

export function nearestMarker(markers, progress, dir = 1) {
  if (!Array.isArray(markers) || !markers.length) return null;
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  const eps = 0.004;
  if (dir > 0) return markers.find((m) => m.progress > p + eps) ?? markers[markers.length - 1];
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i].progress < p - eps) return markers[i];
  }
  return markers[0];
}

const CSS = `
#replay-scrubber{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:26;
  display:flex;flex-direction:column;gap:6px;width:min(680px,calc(100vw - 32px));padding:8px 12px;border-radius:12px;
  background:color-mix(in srgb,var(--panel,#ffffff) 88%,transparent);backdrop-filter:blur(12px);
  border:1px solid var(--line,rgba(120,135,150,.25));box-shadow:0 8px 24px rgba(0,0,0,.14);color:var(--ink,#1d2733);font:12px/1.3 system-ui,sans-serif}
#replay-scrubber .rs-top,#replay-scrubber .rs-track-wrap{display:flex;align-items:center;gap:6px}
#replay-scrubber .rs-top{flex-wrap:wrap;justify-content:space-between}
#replay-scrubber .rs-grp{display:flex;align-items:center;gap:5px}
#replay-scrubber button,#replay-scrubber select{font:inherit;color:inherit;background:color-mix(in srgb,var(--ink,#1d2733) 7%,transparent);
  border:1px solid var(--line,rgba(120,135,150,.25));border-radius:7px;padding:3px 8px;cursor:pointer}
#replay-scrubber button[aria-pressed="true"]{background:var(--accent,#2563eb);color:#fff;border-color:transparent}
#replay-scrubber .rs-time{font-variant-numeric:tabular-nums;opacity:.85;min-width:108px}
#replay-scrubber .rs-track{position:relative;flex:1;display:flex;align-items:center;height:20px}
#replay-scrubber input[type="range"]{width:100%;margin:0;accent-color:var(--accent,#2563eb);cursor:pointer}
#replay-scrubber .rs-ticks{position:absolute;inset:0 6px;pointer-events:none}
#replay-scrubber .rs-tick{position:absolute;top:2px;width:3px;height:6px;border-radius:2px;transform:translateX(-50%);opacity:.85}
#replay-scrubber .rs-tick[data-kind="prompt"]{background:#2563eb}
#replay-scrubber .rs-tick[data-kind="plan"]{background:#d97706}
#replay-scrubber .rs-tick[data-kind="subagent"]{background:#0d9488}
#replay-scrubber .rs-tick[data-kind="error"]{background:#dc2626;height:8px}
#replay-scrubber .rs-tick[data-kind="turn_end"]{background:#64748b}
#replay-scrubber .rs-tick[data-kind="pin"]{background:#7c3aed;height:8px}
#replay-scrubber select{max-width:190px;text-overflow:ellipsis}
`;

function loadPins() {
  try {
    const v = JSON.parse(globalThis.sessionStorage?.getItem(PIN_STORE) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function savePins(pins) {
  try { globalThis.sessionStorage?.setItem(PIN_STORE, JSON.stringify(pins.slice(-24))); } catch { /* ignore */ }
}

export function installReplayScrubber({ office, hud, boardDetail } = {}) {
  if (typeof document === 'undefined') return { applyConfig() {}, applyReplay() {}, onReset() {} };
  if (!document.getElementById('replay-scrubber-css')) {
    document.head.append(Object.assign(document.createElement('style'), { id: 'replay-scrubber-css', textContent: CSS }));
  }
  const bar = Object.assign(document.createElement('section'), {
    id: 'replay-scrubber', hidden: true,
    innerHTML: `<div class="rs-top">
      <div class="rs-grp">
        <button type="button" data-rs="prev"></button>
        <button type="button" data-rs="toggle"></button>
        <button type="button" data-rs="next"></button>
        <span class="rs-time" data-rs="time">0:00 / 0:00 · 0%</span>
      </div>
      <div class="rs-grp">
        <select data-rs="jump"><option value="">—</option></select>
        <button type="button" data-rs="pin"></button>
        <div class="rs-grp" data-rs="speeds"></div>
      </div>
    </div>
    <div class="rs-track-wrap">
      <div class="rs-track"><div class="rs-ticks" data-rs="ticks"></div><input type="range" min="0" max="1000" value="0" data-rs="range"></div>
    </div>`,
  });
  document.body.append(bar);
  const q = (k) => bar.querySelector(`[data-rs="${k}"]`);
  const speedsEl = q('speeds');
  for (const sp of SPEEDS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${sp}×` });
    b.dataset.speed = String(sp);
    speedsEl.append(b);
  }

  let state = { state: 'loading', paused: false, speed: 1, progress: 0, cursor: 0, total: 0, elapsedMs: 0, durationMs: 0, markers: [] };
  let pins = loadPins();
  let dragging = false;
  let hydrated = false;
  let markerKey = '';

  const post = async (body) => {
    try {
      const r = await fetch('/api/replay', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) return null;
      const data = await r.json();
      if (data?.ok) applyReplay(data);
      return data;
    } catch { return null; }
  };

  function render() {
    const t = scrubberText(hud?.lang || langOf());
    const paused = state.paused || state.state === 'paused';
    const done = state.state === 'done';
    q('toggle').textContent = done ? `↺ ${t.restart}` : paused ? `▶ ${t.play}` : `⏸ ${t.pause}`;
    q('prev').textContent = '⏮'; q('prev').title = t.prev;
    q('next').textContent = '⏭'; q('next').title = t.next;
    q('pin').textContent = t.pin;
    const pct = Math.round((state.progress || 0) * 100);
    const elMs = state.durationMs ? (dragging ? (Number(q('range').value) / 1000) * state.durationMs : state.elapsedMs || state.progress * state.durationMs) : 0;
    q('time').textContent = `${formatReplayTime(elMs)} / ${formatReplayTime(state.durationMs)} · ${pct}%`;
    if (!dragging) q('range').value = String(Math.round((state.progress || 0) * 1000));
    for (const b of speedsEl.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === Number(state.speed)));
    }
    const merged = mergeReplayBookmarks(state.markers, pins);
    const nextKey = `${hud?.lang || 'ko'}:${merged.map((m) => `${m.kind}@${m.cursor ?? m.progress}:${m.label}`).join('|')}`;
    if (nextKey !== markerKey) {
      markerKey = nextKey;
      q('ticks').replaceChildren(...merged.map((m) => {
        const s = document.createElement('span');
        s.className = 'rs-tick'; s.dataset.kind = m.kind;
        s.style.left = `${(m.progress * 100).toFixed(1)}%`;
        s.title = `[${t.kinds[m.kind] || m.kind}] ${m.label}`;
        return s;
      }));
      const sel = q('jump');
      sel.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: `${t.jumpPlaceholder} (${merged.length})` }),
        ...merged.map((m, idx) => Object.assign(document.createElement('option'), {
          value: String(idx),
          textContent: `${Math.round(m.progress * 100)}% · [${t.kinds[m.kind] || m.kind}] ${m.label}`,
        })),
      );
    }
  }

  function applyReplay(detail) {
    if (!detail || typeof detail !== 'object') return;
    bar.hidden = false;
    state = { ...state, ...detail, markers: Array.isArray(detail.markers) ? detail.markers : state.markers };
    render();
  }

  function applyConfig(msg) {
    if (!msg?.replay) return;
    bar.hidden = false;
    state = { ...state, ...msg.replay, paused: msg.replay.state === 'paused' };
    if (!hydrated && msg.replay.state !== 'loading' && msg.replay.state !== 'error') {
      hydrated = true;
      fetch('/api/replay').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.ok) applyReplay(d); }).catch(() => {});
    }
    render();
  }

  q('toggle').addEventListener('click', () => {
    if (state.state === 'done') void post({ action: 'seek', cursor: 0, paused: false });
    else void post({ action: 'toggle' });
  });
  q('prev').addEventListener('click', () => {
    const m = nearestMarker(mergeReplayBookmarks(state.markers, pins), state.progress, -1);
    if (m) void post({ action: 'seek', ...(m.cursor != null ? { cursor: m.cursor } : { progress: m.progress }) });
  });
  q('next').addEventListener('click', () => {
    const m = nearestMarker(mergeReplayBookmarks(state.markers, pins), state.progress, 1);
    if (m) void post({ action: 'seek', ...(m.cursor != null ? { cursor: m.cursor } : { progress: m.progress }) });
  });
  q('pin').addEventListener('click', () => {
    const pct = Math.round((state.progress || 0) * 100);
    pins.push({ cursor: state.cursor || null, progress: state.progress || 0, dueMs: state.elapsedMs || 0, label: `@${pct}%` });
    savePins(pins);
    markerKey = '';
    render();
  });
  q('jump').addEventListener('change', (e) => {
    const idx = Number.parseInt(e.target.value, 10);
    e.target.value = '';
    const merged = mergeReplayBookmarks(state.markers, pins);
    const m = merged[idx];
    if (m) void post({ action: 'seek', ...(m.cursor != null ? { cursor: m.cursor } : { progress: m.progress }) });
  });
  speedsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (b) void post({ action: 'speed', speed: Number(b.dataset.speed) });
  });
  q('range').addEventListener('pointerdown', () => { dragging = true; });
  q('range').addEventListener('input', () => { render(); });
  const commitRange = () => {
    const progress = Number(q('range').value) / 1000;
    dragging = false;
    void post({ action: 'seek', progress });
  };
  q('range').addEventListener('change', commitRange);
  window.addEventListener('pointerup', () => { if (dragging) dragging = false; });

  window.addEventListener('keydown', (e) => {
    if (bar.hidden || e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      q('pin').click();
    }
  });

  if (office?.refreshLabels) {
    const orig = office.refreshLabels.bind(office);
    office.refreshLabels = (...args) => { const r = orig(...args); if (!bar.hidden) render(); return r; };
  }

  return {
    applyConfig,
    applyReplay,
    onReset() {
      hud?.renderFloors?.(office);
      boardDetail?.syncAllSigns?.();
    },
  };
}
