// 화면 가장자리 패널: 엘리베이터(층 선택), 활동 기록, 범례, 직원 상세, 기록 관찰(observe-panel.js).
import {
  ROOM_THEMES, DEFAULT_ROOM_THEME, roomThemeOf, CHAR_THEMES, charThemeOf, setCharTheme,
  CHARACTER_CATALOG, activeLlmCharMapOf, setLlmCharMap, resetLlmCharMap,
  VOICE_MODES, voiceModeOf, setVoiceMode, COLOR_THEMES, colorThemeOf, setColorTheme,
  llmFilterOf, setLlmFilter, isLlmVisible, langOf, detectLang, applyRoomTheme, uiText, renderLegend,
  postureModeOf, setPostureMode, motionModeOf, setMotionMode,
} from './rooms.js';
import { ObservePanel } from './observe-panel.js';
import { setSoundEnabled } from './sound.js';

export { ROOM_THEMES, DEFAULT_ROOM_THEME, roomThemeOf, langOf };
export const STORE = 'office-sim:v1';
export const LEGACY_STORE = 'claude-office:v1'; // 이름을 바꾸기 전(claude-office) 키. 한 번만 옮겨 오고 지우지 않는다.
// session 이벤트의 agent(출처 id) -> 화면 이름. 모르는 id 는 그대로 보여 준다.
const AGENT_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity' };
const AGENT_BADGE = { 'claude-code': 'Claude', codex: 'Codex', grok: 'Grok', antigravity: 'AGY' };
const SURFACE_LABEL = {
  'claude-code:app': 'Claude/Claude Code·App', 'claude-code:cli': 'Claude Code·CLI', 'claude-code:ide': 'Claude Code·IDE',
  'codex:app': 'ChatGPT/Codex·App', 'codex:cli': 'Codex·CLI', 'codex:ide': 'Codex·IDE', 'grok:cli': 'Grok Build·CLI',
  'antigravity:cli': 'Antigravity·CLI', 'antigravity:app': 'Antigravity·App', 'antigravity:ide': 'Antigravity·IDE',
};
const SURFACE_BADGE = {
  'claude-code:app': 'Claude·App', 'claude-code:cli': 'Claude·CLI', 'claude-code:ide': 'Claude·IDE',
  'codex:app': 'ChatGPT·App', 'codex:cli': 'Codex·CLI', 'codex:ide': 'Codex·IDE', 'grok:cli': 'Grok·CLI',
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

const time = (d) => d.toLocaleTimeString('en-GB', { hour12: false });
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
const savePrefs = (p) => { try { storeOf().setItem(STORE, JSON.stringify(p)); } catch { /* ignore */ } };

export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      source: $('source'), sub: $('sub'), speed: $('speed'), interval: $('interval'),
      roomTheme: $('room-theme'), themeLabel: $('theme-label'), charTheme: $('char-theme'), charLabel: $('char-label'),
      posture: $('posture-mode'), postureLabel: $('posture-label'), motion: $('motion-mode'), motionLabel: $('motion-label'),
      voice: $('voice-mode'), voiceLabel: $('voice-label'), llmFilter: $('llm-filter'), colorBtn: $('color-theme'), resetCastBtn: $('reset-llm-map'),
      preset: $('control-preset'), controlLabel: $('control-label'), soundBtn: $('sound-toggle'), langBtn: $('lang-toggle'), tail: $('tail'),
      logBtn: $('toggle-log'), legendBtn: $('toggle-legend'), floors: $('floors'),
      log: $('log'), list: $('log-list'), legend: $('legend'), legendControls: $('legend-controls'), insp: $('inspector'),
    };
    const p = (this.prefs = loadPrefs());
    this.roomTheme = roomThemeOf(p.roomTheme);
    this.charTheme = setCharTheme(p.charTheme ?? this.roomTheme);
    this.llmCharMap = setLlmCharMap(p.llmCharMap);
    this.postureMode = setPostureMode(p.postureMode);
    this.motionMode = setMotionMode(p.motionMode);
    this.voiceMode = setVoiceMode(p.voiceMode);
    this.colorTheme = setColorTheme(p.colorTheme);
    this.llmFilter = setLlmFilter(p.llmFilter);
    this.soundOn = setSoundEnabled(p.soundOn !== false && this.voiceMode !== 'mute');
    const urlLang = new URLSearchParams(globalThis.location?.search || '').get('lang');
    this.lang = langOf(urlLang ?? p.lang ?? detectLang());
    this.controlPreset = controlPresetOf(p.controlPreset);
    this.pings = new Map();
    this.keys = new Set();
    this.statT = 0;
    applyRoomTheme(this.roomTheme, this.lang);
    this.applyColorScheme(this.colorTheme);
    this.populateCharSelect(this.el.charTheme);
    this.buildLegend();
    this.observe = new ObservePanel($('toggle-observe'), $('observe'), { announce: $('observe-announce') });
  }

  populateCharSelect(sel) {
    if (!sel) return;
    sel.replaceChildren(...Object.entries(CHAR_THEMES).map(([k, v]) => Object.assign(document.createElement('option'), { value: k, textContent: v[this.lang] || v.ko })));
    sel.value = this.charTheme;
  }

  applyColorScheme(mode) {
    this.colorTheme = setColorTheme(colorThemeOf(mode));
    if (this.colorTheme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = this.colorTheme;
    if (this.el.colorBtn) this.el.colorBtn.textContent = uiText(this.lang).colorLabel[this.colorTheme];
  }

  bind(office, cfg, getSource) {
    this.office = office;
    this.cfg = cfg;
    const { el, prefs } = this;
    const save = () => savePrefs(prefs);
    cfg.speed = prefs.speed || 1;
    cfg.intervalMs = prefs.intervalMs || 250;

    const setSpeed = (s) => {
      cfg.speed = s;
      for (const b of el.speed.querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s));
    };
    setSpeed(cfg.speed);
    el.speed.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) { setSpeed(Number(b.dataset.speed)); prefs.speed = cfg.speed; save(); }
    });

    const setInterval = (ms) => {
      cfg.intervalMs = Math.min(5000, Math.max(50, Math.round(ms / 50) * 50 || 250));
      el.interval.value = String(cfg.intervalMs);
      if (!this.replay) el.sub.textContent = uiText(this.lang).subInterval(cfg.intervalMs);
    };
    setInterval(cfg.intervalMs);
    el.interval.addEventListener('change', () => { setInterval(Number(el.interval.value)); getSource()?.setInterval?.(cfg.intervalMs); prefs.intervalMs = cfg.intervalMs; save(); });

    const applyPreset = (id) => {
      this.controlPreset = controlPresetOf(id);
      const spec = uiText(this.lang).controls[this.controlPreset];
      if (el.preset) { el.preset.value = this.controlPreset; el.preset.title = spec.hint; }
      if (el.legendControls) el.legendControls.textContent = spec.hint;
      office.stage.setControlPreset?.(this.controlPreset);
    };
    const syncSoundBtn = () => {
      if (!el.soundBtn) return;
      el.soundBtn.setAttribute('aria-pressed', String(this.soundOn));
      el.soundBtn.textContent = uiText(this.lang).soundLabel[this.soundOn ? 'on' : 'off'];
    };
    const syncLlmFilter = (f) => {
      this.llmFilter = setLlmFilter(llmFilterOf(f));
      if (el.llmFilter) {
        const allBtn = el.llmFilter.querySelector('[data-llm="all"]');
        if (allBtn) allBtn.textContent = uiText(this.lang).llmAll;
        for (const b of el.llmFilter.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.llm === this.llmFilter));
      }
      if (el.list) for (const li of el.list.children) { const a = office.agents.get(li.dataset.sid); if (a) li.hidden = !isLlmVisible(a); }
      office.refreshVisibility?.();
    };
    const fillSelect = (sel, map, val) => {
      if (!sel) return;
      for (const opt of sel.options) opt.textContent = map(opt.value) || opt.textContent;
      if (val !== undefined) sel.value = val;
    };
    const applyThemeAndLang = (themeId, langId, postureChanged = false) => {
      this.roomTheme = roomThemeOf(themeId);
      this.lang = langOf(langId);
      applyRoomTheme(this.roomTheme, this.lang);
      const t = uiText(this.lang);
      if (el.langBtn) el.langBtn.textContent = this.lang.toUpperCase();
      if (el.themeLabel) el.themeLabel.textContent = t.themeLabel;
      if (el.charLabel) el.charLabel.textContent = t.charLabel;
      if (el.postureLabel) el.postureLabel.textContent = t.postureLabel;
      if (el.motionLabel) el.motionLabel.textContent = t.motionLabel;
      if (el.voiceLabel) el.voiceLabel.textContent = t.voiceLabel;
      if (el.controlLabel) el.controlLabel.textContent = t.controlLabel;
      fillSelect(el.roomTheme, (v) => ROOM_THEMES[v]?.name?.[this.lang], this.roomTheme);
      this.populateCharSelect(el.charTheme);
      fillSelect(el.posture, (v) => t.postures[v], this.postureMode);
      fillSelect(el.motion, (v) => t.motions[v], this.motionMode);
      fillSelect(el.voice, (v) => t.voices[v], this.voiceMode);
      fillSelect(el.preset, (v) => t.controls[v]?.label);
      this.applyColorScheme(this.colorTheme);
      syncSoundBtn();
      syncLlmFilter(this.llmFilter);
      el.legendBtn.textContent = t.legendBtn;
      el.logBtn.textContent = t.logBtn;
      el.log.querySelector('h2').textContent = t.logTitle;
      const petBtn = el.insp.querySelector('[data-act="pet"]');
      if (petBtn) petBtn.textContent = t.petBtn;
      fillSelect(el.insp.querySelector('[data-act="motion"]'), (v) => t.motions[v], office.selected?.motionOverride || 'auto');
      el.insp.querySelector('[data-act="follow"]').textContent = t.follow;
      el.insp.querySelector('[data-act="close"]').textContent = t.close;
      this.buildLegend();
      applyPreset(this.controlPreset);
      el.sub.textContent = this.replay ? t.subReplay(this.replay.speed) : t.subInterval(cfg.intervalMs);
      this.setSource(el.source.dataset.state || 'demo');
      office.refreshLabels?.(t.globalFloor, this.roomTheme, postureChanged);
      this.renderFloors(office);
      if (office.selected) this.inspect(office.selected, office);
    };
    applyThemeAndLang(this.roomTheme, this.lang);
    const refreshCast = () => { office.refreshCharacters?.(); this.buildLegend(); if (office.selected) this.inspect(office.selected, office); save(); };
    el.roomTheme?.addEventListener('change', () => { applyThemeAndLang(el.roomTheme.value, this.lang); prefs.roomTheme = this.roomTheme; save(); });
    el.charTheme?.addEventListener('change', () => { this.charTheme = setCharTheme(charThemeOf(el.charTheme.value)); prefs.charTheme = this.charTheme; refreshCast(); });
    el.posture?.addEventListener('change', () => { this.postureMode = setPostureMode(postureModeOf(el.posture.value)); prefs.postureMode = this.postureMode; refreshCast(); });
    el.motion?.addEventListener('change', () => {
      this.motionMode = setMotionMode(motionModeOf(el.motion.value));
      prefs.motionMode = this.motionMode;
      office.selected?.pet?.(this.motionMode === 'auto' ? '' : this.motionMode);
      if (office.selected) this.inspect(office.selected, office);
      save();
    });
    el.voice?.addEventListener('change', () => {
      this.voiceMode = setVoiceMode(voiceModeOf(el.voice.value));
      this.soundOn = setSoundEnabled(this.voiceMode !== 'mute');
      syncSoundBtn();
      prefs.voiceMode = this.voiceMode;
      prefs.soundOn = this.soundOn;
      save();
    });
    el.llmFilter?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { syncLlmFilter(b.dataset.llm); prefs.llmFilter = this.llmFilter; save(); } });
    el.colorBtn?.addEventListener('click', () => { this.applyColorScheme(COLOR_THEMES[(COLOR_THEMES.indexOf(this.colorTheme) + 1) % COLOR_THEMES.length]); prefs.colorTheme = this.colorTheme; save(); });
    el.resetCastBtn?.addEventListener('click', () => { this.llmCharMap = resetLlmCharMap(); prefs.llmCharMap = this.llmCharMap; refreshCast(); });
    el.soundBtn?.addEventListener('click', () => { this.soundOn = setSoundEnabled(!this.soundOn); syncSoundBtn(); prefs.soundOn = this.soundOn; save(); });
    el.langBtn?.addEventListener('click', () => { applyThemeAndLang(this.roomTheme, this.lang === 'ko' ? 'en' : 'ko'); getSource()?.setLang?.(this.lang); prefs.lang = this.lang; save(); });
    el.preset?.addEventListener('change', () => { applyPreset(el.preset.value); prefs.controlPreset = this.controlPreset; save(); });

    const narrow = window.matchMedia('(max-width: 720px)').matches;
    const toggle = (btn, panel, key, fallback) => {
      const apply = (open) => { btn.setAttribute('aria-pressed', String(open)); panel.hidden = !open; };
      apply(prefs[key] ?? fallback);
      btn.addEventListener('click', () => { const open = btn.getAttribute('aria-pressed') !== 'true'; apply(open); prefs[key] = open; save(); });
    };
    toggle(el.logBtn, el.log, 'log', !narrow);
    toggle(el.legendBtn, el.legend, 'legend', false);
    el.legend?.querySelector('#close-legend')?.addEventListener('click', () => el.legendBtn?.click());

    el.floors.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) office.focus(b.dataset.i === 'all' ? 'all' : Number(b.dataset.i)); });
    el.list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      const a = li && office.agents.get(li.dataset.sid);
      if (!a) return;
      if (a.floor.index !== office.focusIndex || office.overview) office.focus(a.floor.index);
      office.select(a);
    });
    el.insp.querySelector('[data-act="motion"]')?.addEventListener('change', (e) => {
      const a = office.selected;
      if (!a) return;
      a.motionOverride = motionModeOf(e.target.value);
      a.pet?.(a.motionOverride === 'auto' ? '' : a.motionOverride);
      this.inspect(a, office);
    });
    el.insp.querySelector('[data-act="pet"]')?.addEventListener('click', () => { office.selected?.pet?.(); if (office.selected) this.inspect(office.selected, office); });
    el.insp.querySelector('[data-act="follow"]').addEventListener('click', () => { office.follow = !office.follow; if (!office.follow) office.layout({ snapPan: true }); this.inspect(office.selected, office); });
    el.insp.querySelector('[data-act="close"]').addEventListener('click', () => office.select(null));

    const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    const resetCamera = () => { office.follow = false; office.layout({ snapPan: true }); office.stage.resetView?.(); if (office.selected) this.inspect(office.selected, office); };
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.metaKey || e.ctrlKey) && ['+', '=', '-', '_'].includes(e.key)) { e.preventDefault(); office.stage.zoomBy?.(e.key === '-' || e.key === '_' ? 1 / 1.2 : 1.2); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); office.stage.setSpaceDown?.(true); return; }
      const k = e.key.toLowerCase();
      if (e.shiftKey && this.controlPreset === 'map' && k.startsWith('arrow')) {
        e.preventDefault();
        const rot = { arrowleft: [-0.28, 0], arrowright: [0.28, 0], arrowup: [0, -0.14], arrowdown: [0, 0.14] }[k];
        if (rot) office.stage.rotateBy?.(...rot);
        return;
      }
      if (e.shiftKey && this.controlPreset === 'figma' && ['Digit0', 'Digit1', 'Digit2'].includes(e.code)) {
        e.preventDefault();
        if (e.code === 'Digit2' && office.selected) { office.select(office.selected, { focusPan: true, silent: true }); office.stage.zoomTo?.(1.6); }
        else resetCamera();
        return;
      }
      if (MOVE_KEYS.has(k)) { this.keys.add(k); if (k.startsWith('arrow')) e.preventDefault(); return; }
      if (e.key === 'Escape') office.select(null);
      else if (e.key === '0') office.focus('all');
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= office.floors.length) office.focus(Number(e.key) - 1);
      else if ((e.key === '[' || e.key === 'PageDown') && office.floors.length) { e.preventDefault(); office.focus(office.overview ? 0 : Math.max(0, office.focusIndex - 1)); }
      else if ((e.key === ']' || e.key === 'PageUp') && office.floors.length) { e.preventDefault(); office.focus(office.overview ? office.floors.length - 1 : Math.min(office.floors.length - 1, office.focusIndex + 1)); }
      else if (k === 'q') office.stage.rotateBy?.(-0.35);
      else if (k === 'e') office.stage.rotateBy?.(0.35);
      else if (e.key === '+' || e.key === '=') office.stage.zoomBy?.(1.2);
      else if (e.key === '-' || e.key === '_') office.stage.zoomBy?.(1 / 1.2);
      else if (k === 'r' || e.key === 'Home') resetCamera();
      else if ((k === 'f' || e.key === '.') && office.selected) {
        if (e.key === '.') office.select(office.selected, { focusPan: true, silent: true });
        else { office.follow = !office.follow; if (!office.follow) office.layout({ snapPan: true }); this.inspect(office.selected, office); }
      }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') office.stage.setSpaceDown?.(false); this.keys.delete(e.key.toLowerCase()); });
    window.addEventListener('blur', () => { office.stage.setSpaceDown?.(false); this.keys.clear(); });
  }

  setLive(live) { this.el.speed.hidden = live; this.observe.setLive(live); }

  applyConfig(cfg, msg) {
    if (Number.isFinite(msg?.intervalMs)) {
      cfg.intervalMs = msg.intervalMs;
      this.el.interval.value = String(msg.intervalMs);
      this.el.sub.textContent = uiText(this.lang).subInterval(msg.intervalMs);
    }
    if (msg?.replay) this.setReplay(msg.replay);
  }

  setReplay(r) {
    this.replay = r;
    this.el.interval.closest('label').hidden = true;
    this.el.sub.textContent = uiText(this.lang).subReplay(r.speed);
    if (this.el.source.dataset.state !== 'retry') this.setSource('replay');
  }

  setSource(state) {
    if (state === 'live' && this.replay) state = 'replay';
    this.observe.setConnected(state !== 'retry');
    const t = uiText(this.lang);
    this.el.source.dataset.state = state;
    this.el.source.querySelector('span').textContent = state === 'replay' ? replayText(this.replay) : t.source[state] || state;
    this.el.source.title = state === 'demo' || state === 'down' ? t.sourceTitle.demo : state === 'replay' ? t.sourceTitle.replay : t.sourceTitle.live;
  }

  flashTail(n) {
    const t = this.el.tail;
    t.textContent = `+${n}`;
    t.classList.remove('on');
    void t.offsetWidth;
    t.classList.add('on');
  }

  buildLegend() {
    const closeBtn = this.el.legend?.querySelector?.('#close-legend');
    if (closeBtn) closeBtn.textContent = uiText(this.lang).close;
    renderLegend(this.el.legend, this.roomTheme, this.lang, (slotOrKind, val) => {
      if (slotOrKind === 'charTheme') {
        this.charTheme = setCharTheme(val);
        this.prefs.charTheme = this.charTheme;
        if (this.el.charTheme) this.el.charTheme.value = this.charTheme;
      } else {
        this.llmCharMap = activeLlmCharMapOf();
        this.prefs.llmCharMap = this.llmCharMap;
      }
      savePrefs(this.prefs);
      this.office?.refreshCharacters?.();
      this.buildLegend();
      if (this.office?.selected) this.inspect(this.office.selected, this.office);
    });
  }

  renderFloors(office) {
    const nav = this.el.floors;
    const focused = document.activeElement?.closest?.('#floors button')?.dataset.i;
    const t = uiText(this.lang);
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
    this.floorStats(office);
    if (focused != null) nav.querySelector(`[data-i="${focused}"]`)?.focus();
  }

  floorStats(office) {
    const t = uiText(this.lang);
    for (const f of office.floors) {
      const b = this.el.floors.querySelector(`[data-i="${f.index}"]`);
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
      const ping = this.pings.get(f);
      b.classList.toggle('ping', ping === 'activity');
      b.classList.toggle('alert', ping === 'error');
      b.setAttribute('aria-label', `${f.number} ${f.label}, ${agents.length}${asking ? `, ${t.askBadge(approving, asking)}` : ''}`);
    }
  }

  ping(floor, kind) {
    if (!this.office || this.office.overview || floor.index === this.office.focusIndex) return;
    const prev = this.pings.get(floor);
    this.pings.set(floor, kind === 'error' || prev === 'error' ? 'error' : 'activity');
  }

  clearPing(floor) { if (floor) this.pings.delete(floor); }

  log(agent, text, kind) {
    const li = Object.assign(document.createElement('li'), { hidden: !isLlmVisible(agent), innerHTML: '<time></time><i></i><b></b><span></span>' });
    li.dataset.kind = kind || '';
    li.dataset.sid = agent.id;
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
    if (!a) { box.hidden = true; delete box.dataset.sid; return; }
    const t = uiText(this.lang);
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
    if (box.dataset.sid !== a.id || box.dataset.lang !== this.lang) {
      box.dataset.sid = a.id; box.dataset.lang = this.lang; delete box.dataset.histKey;
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
      addSelectRow('charOverride', t.rows.charOverride, Object.entries(CHARACTER_CATALOG).map(([k, v]) => [k, v[this.lang] || v.ko]), a.charOverride, (v) => { a.charOverride = v; a.refreshCharacter?.(); });
      addSelectRow('postureOverride', t.rows.postureOverride, Object.entries(t.postures), a.postureOverride, (v) => { a.postureOverride = v; a.refreshCharacter?.(); });
      addSelectRow('motionOverride', t.rows.motionOverride, Object.entries(t.motions), a.motionOverride, (v) => { a.motionOverride = v; a.pet?.(v === 'auto' ? '' : v); this.inspect(a, office); });
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
        li.dataset.kind = h.kind; li.querySelector('time').textContent = time(h.at); li.querySelector('span').textContent = h.text;
        return li;
      }));
    }
    box.querySelector('[data-act="follow"]').setAttribute('aria-pressed', String(office.follow));
  }

  tick(realDt, office) {
    if (this.keys.size && office?.stage?.panBy) {
      const rx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      const fz = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
      if (rx || fz) office.stage.panBy(rx * 11 * realDt, fz * 11 * realDt);
    }
    if ((this.statT -= realDt) > 0) return;
    this.statT = 0.5;
    this.observe.tick();
    this.floorStats(office);
    if (office.selected && !(globalThis.document?.activeElement?.tagName === 'SELECT' && this.el.insp?.contains?.(globalThis.document.activeElement))) this.inspect(office.selected, office);
  }
}
