// 화면 가장자리 패널: 엘리베이터(층 선택), 활동 기록, 범례, 직원 상세, 기록 관찰(observe-panel.js).
import { ROOMS } from './rooms.js';
import { ObservePanel } from './observe-panel.js';

export const STORE = 'office-sim:v1';
export const LEGACY_STORE = 'claude-office:v1'; // 이름을 바꾸기 전(claude-office) 키. 한 번만 옮겨 오고 지우지 않는다.
const MODE = { idle: '대기', work: '작업 중', think: '생각 중', write: '계획 작성', ask: '질문 중', panic: '식은땀' };
const SOURCE = {
  demo: '데모 데이터',
  live: '라이브 · 연결됨',
  retry: '라이브 · 재연결 중',
  down: '서버 없음 · 데모 재생',
};
// session 이벤트의 agent(출처 id) -> 화면 이름. 모르는 id 는 그대로 보여 준다.
const AGENT_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity' };
const AGENT_BADGE = { 'claude-code': 'Claude', codex: 'Codex', grok: 'Grok', antigravity: 'AGY' };
const AGY_SURFACE_LABEL = { cli: 'CLI', app: 'App', ide: 'IDE' };
export const agentLabel = (id, surface = '') => {
  if (!Object.hasOwn(AGENT_LABEL, id)) return id;
  const base = AGENT_LABEL[id];
  const sub = id === 'antigravity' && surface && Object.hasOwn(AGY_SURFACE_LABEL, surface) ? AGY_SURFACE_LABEL[surface] : '';
  return sub ? `${base} (${sub})` : base;
};
export const agentBadge = (id, surface = '') => {
  if (!id) return '';
  if (!Object.hasOwn(AGENT_BADGE, id)) return id;
  const base = AGENT_BADGE[id];
  const sub = id === 'antigravity' && surface && Object.hasOwn(AGY_SURFACE_LABEL, surface) ? AGY_SURFACE_LABEL[surface] : '';
  return sub ? `${base}·${sub}` : base;
};

export const DEFAULT_CONTROL_PRESET = 'map';
export const CONTROL_PRESETS = Object.freeze({
  map: Object.freeze({
    label: '구글 맵',
    hint: '구글 맵: 좌클릭 드래그 이동 · 우클릭/Ctrl+드래그 회전·기울기 · 휠 확대 · WASD/방향키 이동 · Shift+방향키 회전·기울기 · R 초기화 · F/더블클릭 따라가기 · 1-9/[/]/0 층 이동',
  }),
  figma: Object.freeze({
    label: '피그마',
    hint: '피그마: 휠/두손가락 이동 · Ctrl/핀치+휠 확대 · Space+드래그/휠클릭 이동 · 드래그 회전 · Shift+0/1/2 시점·맞춤·포커스 · R 초기화 · 1-9/[/]/0 층 이동',
  }),
  orbit: Object.freeze({
    label: '3D 오빗',
    hint: '3D 오빗: 좌클릭 드래그 회전 · 우클릭/Shift/Space+드래그 이동 · 휠 확대 · WASD/방향키 이동 · Q/E 회전 · R 초기화 · F/더블클릭 따라가기 · 1-9/[/]/0 층 이동',
  }),
  blender: Object.freeze({
    label: '블렌더',
    hint: '블렌더: 휠클릭/Alt+드래그 회전 · Shift+휠클릭/좌·우클릭 이동 · 휠 확대 · WASD/방향키 이동 · ./F 선택 포커스 · Home/R 초기화 · 1-9/[/]/0 층 이동',
  }),
});
export const controlPresetOf = (k) => (Object.hasOwn(CONTROL_PRESETS, k) ? k : DEFAULT_CONTROL_PRESET);

// 재생 모드(--replay): 서버가 config 메시지에 싣는 replay { state, speed, loop, round, progress } 를 칩 문구로.
function replayText(r) {
  const x = `${r.speed}×`;
  switch (r.state) {
    case 'playing': return `재생 · ${x} · ${Math.floor((r.progress || 0) * 100)}%${r.loop && r.round > 1 ? ` · ${r.round}회째` : ''}`;
    case 'done': return r.loop ? `재생 끝 · 곧 다시` : `재생 끝 · ${x}`;
    case 'restart': return '재생 · 처음부터 다시';
    case 'error': return '재생 · 기록을 읽지 못함';
    default: return '재생 · 준비 중';
  }
}

// 21:04:10 처럼 짧게(ko-KR 은 "21시 4분 10초"로 길어진다)
const time = (d) => d.toLocaleTimeString('en-GB', { hour12: false });

// localStorage 는 꺼내는 순간에도 던질 수 있다(샌드박스 iframe, 차단된 사이트 데이터). storage 를 넘기면 그것을 쓴다(테스트용).
const storeOf = (storage) => storage ?? globalThis.localStorage;

// 새 키가 비어 있고 옛 키(claude-office:v1)가 있으면 옛 설정을 한 번 복사한다. 복사했으면 true.
// 복사 뒤에는 새 키가 있으므로 다시 불러도 아무것도 하지 않는다. 옛 키는 그대로 둔다.
export function migratePrefs(storage) {
  try {
    const s = storeOf(storage);
    if (s.getItem(STORE) != null) return false;
    const old = s.getItem(LEGACY_STORE);
    if (old == null) return false;
    s.setItem(STORE, old);
    return true;
  } catch { return false; }
}
export function loadPrefs(storage) {
  migratePrefs(storage);
  try {
    const v = JSON.parse(storeOf(storage).getItem(STORE));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function savePrefs(p) {
  try { storeOf().setItem(STORE, JSON.stringify(p)); } catch { /* 저장 불가 환경 */ }
}

export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      source: $('source'), sub: $('sub'), speed: $('speed'), interval: $('interval'), preset: $('control-preset'), tail: $('tail'),
      logBtn: $('toggle-log'), legendBtn: $('toggle-legend'), floors: $('floors'),
      log: $('log'), list: $('log-list'), legend: $('legend'), legendControls: $('legend-controls'), insp: $('inspector'),
    };
    this.prefs = loadPrefs();
    this.controlPreset = controlPresetOf(this.prefs.controlPreset);
    this.pings = new Map();
    this.keys = new Set();
    this.statT = 0;
    this.buildLegend();
    // 라이브 서버가 observe 메시지를 보내기 전에는 숨어 있다(데모·벤치에서는 끝까지 숨는다).
    this.observe = new ObservePanel($('toggle-observe'), $('observe'), { announce: $('observe-announce') });
  }

  bind(office, cfg, getSource) {
    this.office = office;
    const { el, prefs } = this;
    cfg.speed = prefs.speed || 1;
    cfg.intervalMs = prefs.intervalMs || 250;

    const setSpeed = (s) => {
      cfg.speed = s;
      for (const b of el.speed.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s));
    };
    setSpeed(cfg.speed);
    el.speed.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setSpeed(Number(b.dataset.speed));
      prefs.speed = cfg.speed;
      savePrefs(prefs);
    });

    const setInterval = (ms) => {
      cfg.intervalMs = Math.min(5000, Math.max(50, Math.round(ms / 50) * 50 || 250));
      el.interval.value = String(cfg.intervalMs);
      el.sub.textContent = `세션 기록을 ${cfg.intervalMs}ms마다 따라 읽어요`;
    };
    setInterval(cfg.intervalMs);
    el.interval.addEventListener('change', () => {
      setInterval(Number(el.interval.value));
      getSource()?.setInterval?.(cfg.intervalMs);
      prefs.intervalMs = cfg.intervalMs;
      savePrefs(prefs);
    });

    const applyPreset = (id) => {
      this.controlPreset = controlPresetOf(id);
      const spec = CONTROL_PRESETS[this.controlPreset];
      if (el.preset) {
        el.preset.value = this.controlPreset;
        el.preset.title = spec.hint;
      }
      if (el.legendControls) el.legendControls.textContent = spec.hint;
      office.stage.setControlPreset?.(this.controlPreset);
    };
    applyPreset(this.controlPreset);
    el.preset?.addEventListener('change', () => {
      applyPreset(el.preset.value);
      prefs.controlPreset = this.controlPreset;
      savePrefs(prefs);
    });

    const narrow = window.matchMedia('(max-width: 720px)').matches;
    const toggle = (btn, panel, key, fallback) => {
      const apply = (open) => {
        btn.setAttribute('aria-pressed', String(open));
        panel.hidden = !open;
      };
      apply(prefs[key] ?? fallback);
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-pressed') !== 'true';
        apply(open);
        prefs[key] = open;
        savePrefs(prefs);
      });
    };
    toggle(el.logBtn, el.log, 'log', !narrow);
    toggle(el.legendBtn, el.legend, 'legend', false);

    el.floors.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      office.focus(b.dataset.i === 'all' ? 'all' : Number(b.dataset.i));
    });
    el.list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      const a = li && office.agents.get(li.dataset.sid);
      if (!a) return;
      if (a.floor.index !== office.focusIndex || office.overview) office.focus(a.floor.index);
      office.select(a);
    });
    el.insp.querySelector('[data-act="follow"]').addEventListener('click', () => {
      office.follow = !office.follow;
      if (!office.follow) office.layout({ snapPan: true });
      this.inspect(office.selected, office);
    });
    el.insp.querySelector('[data-act="close"]').addEventListener('click', () => office.select(null));

    const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    const resetCamera = () => {
      office.follow = false;
      office.layout({ snapPan: true });
      office.stage.resetView?.();
      if (office.selected) this.inspect(office.selected, office);
    };
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        e.preventDefault();
        office.stage.zoomBy?.(e.key === '-' || e.key === '_' ? 1 / 1.2 : 1.2);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        office.stage.setSpaceDown?.(true);
        return;
      }
      const k = e.key.toLowerCase();
      if (e.shiftKey && this.controlPreset === 'map' && k.startsWith('arrow')) {
        e.preventDefault();
        if (k === 'arrowleft') office.stage.rotateBy?.(-0.28, 0);
        else if (k === 'arrowright') office.stage.rotateBy?.(0.28, 0);
        else if (k === 'arrowup') office.stage.rotateBy?.(0, -0.14);
        else if (k === 'arrowdown') office.stage.rotateBy?.(0, 0.14);
        return;
      }
      if (e.shiftKey && this.controlPreset === 'figma' && (e.code === 'Digit0' || e.code === 'Digit1' || e.code === 'Digit2')) {
        e.preventDefault();
        if (e.code === 'Digit2' && office.selected) {
          office.select(office.selected, { focusPan: true });
          office.stage.zoomTo?.(1.6);
        } else resetCamera();
        return;
      }
      if (MOVE_KEYS.has(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
        return;
      }
      if (e.key === 'Escape') office.select(null);
      else if (e.key === '0') office.focus('all');
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= office.floors.length) office.focus(Number(e.key) - 1);
      else if ((e.key === '[' || e.key === 'PageDown') && office.floors.length) {
        e.preventDefault();
        office.focus(office.overview ? 0 : Math.max(0, office.focusIndex - 1));
      } else if ((e.key === ']' || e.key === 'PageUp') && office.floors.length) {
        e.preventDefault();
        office.focus(office.overview ? office.floors.length - 1 : Math.min(office.floors.length - 1, office.focusIndex + 1));
      } else if (k === 'q') office.stage.rotateBy?.(-0.35);
      else if (k === 'e') office.stage.rotateBy?.(0.35);
      else if (e.key === '+' || e.key === '=') office.stage.zoomBy?.(1.2);
      else if (e.key === '-' || e.key === '_') office.stage.zoomBy?.(1 / 1.2);
      else if (k === 'r' || e.key === 'Home') resetCamera();
      else if ((k === 'f' || e.key === '.') && office.selected) {
        if (e.key === '.') office.select(office.selected, { focusPan: true });
        else {
          office.follow = !office.follow;
          if (!office.follow) office.layout({ snapPan: true });
          this.inspect(office.selected, office);
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') office.stage.setSpaceDown?.(false);
      this.keys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => {
      office.stage.setSpaceDown?.(false);
      this.keys.clear();
    });
  }

  setLive(live) {
    this.el.speed.hidden = live;
    this.observe.setLive(live);
  }

  // 서버가 알려 준 tail 간격을 입력칸과 부제에 반영한다(저장된 개인 설정보다 서버 값이 우선).
  applyConfig(cfg, msg) {
    if (Number.isFinite(msg?.intervalMs)) {
      cfg.intervalMs = msg.intervalMs;
      this.el.interval.value = String(msg.intervalMs);
      this.el.sub.textContent = `세션 기록을 ${msg.intervalMs}ms마다 따라 읽어요`;
    }
    if (msg?.replay) this.setReplay(msg.replay);
  }

  // 재생 모드는 tail 간격이 의미 없으니 입력칸을 숨기고, 다시 연결돼도 '라이브'로 바뀌지 않게 기억해 둔다.
  setReplay(r) {
    this.replay = r;
    this.el.interval.closest('label').hidden = true;
    this.el.sub.textContent = `지난 세션 기록을 ${r.speed}배속으로 다시 보여 줘요`;
    if (this.el.source.dataset.state !== 'retry') this.setSource('replay');
  }

  setSource(state) {
    if (state === 'live' && this.replay) state = 'replay';
    this.observe.setConnected(state !== 'retry'); // 기록 관찰: 끊긴 동안 받은 상태는 낡았다(시계와 버튼을 세운다)
    this.el.source.dataset.state = state;
    this.el.source.querySelector('span').textContent = state === 'replay' ? replayText(this.replay) : SOURCE[state] || state;
    this.el.source.title = state === 'demo' || state === 'down'
      ? '예시 세션을 재생하고 있어요. 로컬 서버를 실행하면 실제 에이전트 세션이 보여요.'
      : state === 'replay' ? '지난 세션 기록을 기록된 시간 간격대로 재생하고 있어요.'
        : '로컬 서버의 /events 스트림을 받고 있어요.';
  }

  flashTail(n) {
    const t = this.el.tail;
    t.textContent = `+${n}`;
    t.classList.remove('on');
    void t.offsetWidth;
    t.classList.add('on');
  }

  buildLegend() {
    const ul = this.el.legend.querySelector('ul');
    for (const r of Object.values(ROOMS)) {
      const li = document.createElement('li');
      li.innerHTML = '<i></i><b></b><span></span>';
      li.querySelector('i').style.background = `var(${r.token})`;
      li.querySelector('b').textContent = r.label;
      li.querySelector('span').textContent = r.hint;
      ul.append(li);
    }
  }

  renderFloors(office) {
    const nav = this.el.floors;
    const focused = document.activeElement?.closest?.('#floors button')?.dataset.i;
    nav.replaceChildren();
    const make = (i, no, name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fl';
      b.dataset.i = String(i);
      b.innerHTML = '<span class="no"></span><span class="nm"><b class="fn"></b><small class="ag" hidden></small></span><span class="ct"></span>';
      b.querySelector('.no').textContent = no;
      b.querySelector('.fn').textContent = name;
      nav.append(b);
      return b;
    };
    const all = make('all', '전체', '모든 프로젝트 층 보기');
    all.setAttribute('aria-pressed', String(office.overview));
    all.classList.add('all');
    for (const f of [...office.floors].reverse()) {
      const b = make(f.index, f.number, f.label);
      b.title = f.key === '_global' ? '워크스페이스 경로가 지정되지 않은 전역 세션' : f.key;
      b.setAttribute('aria-pressed', String(!office.overview && f.index === office.focusIndex));
    }
    this.floorStats(office);
    if (focused != null) nav.querySelector(`[data-i="${focused}"]`)?.focus();
  }

  floorStats(office) {
    for (const f of office.floors) {
      const b = this.el.floors.querySelector(`[data-i="${f.index}"]`);
      if (!b) continue;
      const agents = [...f.agents];
      const asking = agents.filter((a) => a.mode === 'ask').length;
      const approving = agents.filter((a) => a.mode === 'ask' && a.current?.approval).length;
      const counts = new Map();
      for (const a of agents) {
        const tag = agentBadge(a.agent, a.surface);
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
      const agEl = b.querySelector('.ag');
      if (agEl) {
        const summary = [...counts].map(([k, n]) => (n > 1 ? `${k} ${n}` : k)).join(' · ');
        agEl.textContent = summary;
        agEl.hidden = !summary;
      }
      b.querySelector('.ct').textContent = asking ? `${approving === asking ? '승인' : '질문'} ${asking}` : String(agents.length);
      b.classList.toggle('asking', asking > 0);
      const ping = this.pings.get(f);
      b.classList.toggle('ping', ping === 'activity');
      b.classList.toggle('alert', ping === 'error');
      b.setAttribute('aria-label', `${f.number} ${f.label}, 직원 ${agents.length}명${asking ? `, 질문 ${asking}건` : ''}`);
    }
  }

  ping(floor, kind) {
    if (!this.office || this.office.overview || floor.index === this.office.focusIndex) return;
    const prev = this.pings.get(floor);
    this.pings.set(floor, kind === 'error' || prev === 'error' ? 'error' : 'activity');
  }

  clearPing(floor) { if (floor) this.pings.delete(floor); }

  log(agent, text, kind) {
    const li = document.createElement('li');
    li.dataset.kind = kind || '';
    li.dataset.sid = agent.id;
    li.innerHTML = '<time></time><i></i><b></b><span></span>';
    li.querySelector('time').textContent = time(new Date());
    li.querySelector('i').style.background = agent.color;
    const badge = agent.agent ? ` · ${agentBadge(agent.agent, agent.surface)}` : '';
    li.querySelector('b').textContent = `${agent.floor.number}${badge} ${agent.name}`;
    li.querySelector('span').textContent = text;
    this.el.list.prepend(li);
    while (this.el.list.children.length > 80) this.el.list.lastElementChild.remove();
  }

  inspect(a, office) {
    const box = this.el.insp;
    if (!a) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.querySelector('.dot').style.background = a.color;
    box.querySelector('h2').textContent = a.name;
    const mode = a.path.length ? '이동 중' : a.mode === 'ask' && a.current?.approval ? '승인 대기'
      : MODE[a.panicT > 0 ? 'panic' : a.mode] || a.mode;
    const agentText = a.agent ? agentLabel(a.agent, a.surface) : '-';
    const rows = [
      ['프로젝트', `${a.floor.number} · ${a.floor.label}`],
      ['에이전트', a.isSub ? `${agentText} · 서브 (${a.agentType || '보조'})` : agentText],
      ['브랜치', a.worktree ? `${a.branch || '-'} (워크트리 ${a.worktree})` : a.branch || '-'],
      ['상태', mode],
      ['하는 일', a.activity],
      ['남은 일', `${a.queue.length}건`],
    ];
    const dl = box.querySelector('dl');
    dl.replaceChildren(...rows.flatMap(([k, val]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = val;
      return [dt, dd];
    }));
    const ol = box.querySelector('ol');
    ol.replaceChildren(...a.history.slice(0, 7).map((h) => {
      const li = document.createElement('li');
      li.dataset.kind = h.kind;
      li.innerHTML = '<time></time><span></span>';
      li.querySelector('time').textContent = time(h.at);
      li.querySelector('span').textContent = h.text;
      return li;
    }));
    box.querySelector('[data-act="follow"]').setAttribute('aria-pressed', String(office.follow));
  }

  tick(realDt, office) {
    if (this.keys.size && office?.stage?.panBy) {
      const rx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      const fz = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
      if (rx || fz) office.stage.panBy(rx * 11 * realDt, fz * 11 * realDt);
    }
    this.statT -= realDt;
    if (this.statT > 0) return;
    this.statT = 0.5;
    this.observe.tick();
    this.floorStats(office);
    if (office.selected) this.inspect(office.selected, office);
  }
}
