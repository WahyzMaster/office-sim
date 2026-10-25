// HUD notification toggle (#notify-toggle, shortcut N), server /api/notify sync,
// and Web Notification API fallback when native OS notifications are unavailable.
import { langOf } from './rooms.js';

const STORAGE_KEY = 'office-sim:v1';
const ASK_TOOLS = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ask_user_question',
  'exit_plan_mode',
  'request_user_input',
  'ask_question',
]);
const DONE_REASONS = new Set(['end_turn', 'wrap_up', 'stop_hook']);

export const NOTIFY_TEXT = Object.freeze({
  ko: Object.freeze({
    btnOn: '알림 켜짐',
    btnOff: '알림 꺼짐',
    btnTitle: 'macOS · Windows 시스템 알림 및 브라우저 알림 전환 (단축키 N)',
    askTitle: (name, floor) => `${name} (${floor}) · 응답 대기`,
    errTitle: (name, floor) => `${name} (${floor}) · 오류 발생`,
    doneTitle: (name, floor) => `${name} (${floor}) · 작업 완료`,
    askFallback: '사용자 입력 또는 승인을 기다리고 있어요',
    errFallback: '에이전트 오류가 발생했어요',
    doneFallback: '턴 작업을 마쳤어요',
  }),
  en: Object.freeze({
    btnOn: 'Notify On',
    btnOff: 'Notify Off',
    btnTitle: 'Toggle macOS / Windows native & browser notifications (Shortcut N)',
    askTitle: (name, floor) => `${name} (${floor}) · Input Needed`,
    errTitle: (name, floor) => `${name} (${floor}) · Error`,
    doneTitle: (name, floor) => `${name} (${floor}) · Turn Complete`,
    askFallback: 'Waiting for your input or approval',
    errFallback: 'Agent encountered an error',
    doneFallback: 'Agent finished its turn',
  }),
});

export const notifyText = (lang = 'ko') => NOTIFY_TEXT[langOf(lang)];

export function shouldDispatchBrowserNotification({
  enabled = false,
  permission = 'default',
  docHidden = false,
  serverNativeSupported = false,
  serverNativeEnabled = false,
} = {}) {
  if (!enabled || permission !== 'granted') return false;
  if (serverNativeSupported && serverNativeEnabled) return false;
  return Boolean(docHidden);
}

export function classifyBrowserNotifyEvent(ev, agent, lang = 'ko') {
  if (!ev || typeof ev !== 'object' || ev.replay) return null;
  const t = notifyText(lang);
  const name = agent?.name || ev.sessionId || 'Agent';
  const floor = agent?.floor?.label || ev.projectLabel || 'Office';

  if (ev.type === 'tool_start') {
    if (ev.tool === 'request_user_input_async') return null;
    const isAsk = Boolean(ev.room === 'desk' || ev.question || (typeof ev.tool === 'string' && ASK_TOOLS.has(ev.tool)));
    if (!isAsk) return null;
    return {
      category: 'ask',
      title: t.askTitle(name, floor),
      body: String(ev.question || ev.summary || ev.tool || t.askFallback).slice(0, 140),
    };
  }

  if (ev.type === 'tool_wait') {
    if (ev.waiting === false) return null;
    return {
      category: 'ask',
      title: t.askTitle(name, floor),
      body: String(ev.question || ev.summary || ev.tool || t.askFallback).slice(0, 140),
    };
  }

  if (ev.type === 'system' && (ev.kind === 'api_error' || ev.kind === 'refusal')) {
    return {
      category: 'error',
      title: t.errTitle(name, floor),
      body: String(ev.text || t.errFallback).slice(0, 140),
    };
  }

  if (ev.type === 'turn_end') {
    if (ev.reason === 'api_error') {
      return {
        category: 'error',
        title: t.errTitle(name, floor),
        body: String(ev.text || t.errFallback).slice(0, 140),
      };
    }
    if (agent?.isSub || ev.isSubagent) return null;
    const reasonOk = ev.reason === undefined || DONE_REASONS.has(ev.reason);
    if (!reasonOk) return null;
    return {
      category: 'done',
      title: t.doneTitle(name, floor),
      body: String(ev.text || t.doneFallback).slice(0, 140),
    };
  }

  return null;
}

function readStoredNotify(storage) {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.notify === true;
  } catch {
    return false;
  }
}

function writeStoredNotify(storage, enabled) {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    const next = { ...(prev && typeof prev === 'object' ? prev : {}), notify: Boolean(enabled) };
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function installSystemNotifications({
  office,
  hud,
  doc = globalThis.document,
  win = globalThis.window,
  fetchFn = globalThis.fetch,
} = {}) {
  const storage = win?.localStorage ?? null;
  let enabled = readStoredNotify(storage);
  let serverSupported = false;
  let serverEnabled = false;
  const turnNotifiedBySid = new Set();
  const lastNotifyAt = new Map();

  let btn = doc?.getElementById?.('notify-toggle') ?? null;
  if (!btn && doc) {
    const controls = doc.querySelector?.('.bar .controls');
    if (controls) {
      btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = 'notify-toggle';
      btn.className = 'ghost';
      const soundBtn = doc.getElementById?.('sound-toggle');
      if (soundBtn?.nextSibling) controls.insertBefore(btn, soundBtn.nextSibling);
      else controls.appendChild(btn);
    }
  }

  function renderButton() {
    if (!btn) return;
    const t = notifyText(hud?.lang);
    btn.textContent = enabled ? t.btnOn : t.btnOff;
    btn.title = t.btnTitle;
    btn.setAttribute('aria-pressed', String(enabled));
    btn.setAttribute('aria-label', t.btnTitle);
  }

  async function syncToServer({ test = false } = {}) {
    if (typeof fetchFn !== 'function') return;
    try {
      const res = await fetchFn('/api/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, categories: ['ask', 'error', 'done'], test }),
      });
      if (res?.ok) {
        const data = await res.json();
        serverSupported = Boolean(data?.supported);
        serverEnabled = Boolean(data?.enabled);
      }
    } catch {
      // Offline or demo mode
    }
  }

  async function initFromServer() {
    if (typeof fetchFn !== 'function') return;
    try {
      const res = await fetchFn('/api/notify');
      if (!res?.ok) return;
      const data = await res.json();
      serverSupported = Boolean(data?.supported);
      serverEnabled = Boolean(data?.enabled);
      if (serverEnabled && !enabled) {
        enabled = true;
        writeStoredNotify(storage, true);
        renderButton();
      } else if (enabled && !serverEnabled) {
        await syncToServer({ test: false });
      }
    } catch {
      // Demo mode or offline
    }
  }

  function toggleNotify() {
    enabled = !enabled;
    writeStoredNotify(storage, enabled);
    renderButton();
    if (enabled && win?.Notification && win.Notification.permission === 'default') {
      try {
        win.Notification.requestPermission()?.catch?.(() => {});
      } catch {
        // Ignore older callback-based Notification implementations
      }
    }
    void syncToServer({ test: enabled });
    return enabled;
  }

  btn?.addEventListener?.('click', () => { toggleNotify(); });

  const langBtn = doc?.getElementById?.('lang-toggle');
  langBtn?.addEventListener?.('click', () => { renderButton(); });

  win?.addEventListener?.('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      toggleNotify();
    }
  });

  if (office && typeof office.onEvent === 'function') {
    const origOnEvent = office.onEvent.bind(office);
    office.onEvent = (ev) => {
      origOnEvent(ev);
      if (!ev || ev.replay) return;
      const sid = ev.sessionId;
      if (ev.type === 'user' || ev.type === 'prompt' || ev.type === 'thinking' || ev.type === 'say' || ev.type === 'tool_start') {
        if (sid) turnNotifiedBySid.delete(sid);
      }
      const permission = win?.Notification?.permission ?? 'default';
      if (!shouldDispatchBrowserNotification({
        enabled,
        permission,
        docHidden: Boolean(doc?.hidden),
        serverNativeSupported: serverSupported,
        serverNativeEnabled: serverEnabled,
      })) {
        return;
      }
      const agent = sid ? office.agents?.get?.(sid) : null;
      const item = classifyBrowserNotifyEvent(ev, agent, hud?.lang);
      if (!item) return;
      if (item.category === 'done' && sid) {
        if (turnNotifiedBySid.has(sid)) return;
        turnNotifiedBySid.add(sid);
      }
      const key = `${sid || 'global'}:${item.category}`;
      const now = Date.now();
      if (now - (lastNotifyAt.get(key) ?? -Infinity) < 4000) return;
      lastNotifyAt.set(key, now);

      try {
        const n = new win.Notification(item.title, {
          body: item.body,
          tag: `office-sim-${sid || 'agent'}-${item.category}`,
        });
        n.onclick = () => {
          win?.focus?.();
          if (agent) {
            if (agent.floor?.index !== office.focusIndex || office.overview) office.focus?.(agent.floor.index);
            office.select?.(agent, { focusPan: true });
          }
          if (sid && typeof fetchFn === 'function') {
            fetchFn('/api/focus-terminal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: sid }),
            })?.catch?.(() => {});
          }
        };
      } catch {
        // Ignore browser notification errors
      }
    };
  }

  renderButton();
  void initFromServer();

  return {
    get enabled() { return enabled; },
    toggleNotify,
    renderButton,
    syncToServer,
  };
}
