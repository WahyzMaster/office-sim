// 스트리머·OBS 투명 오버레이 모드(?overlay=1, #overlay, ?chroma=green) 및 5초 WebM 클립/PNG 스냅샷 캡처.
import { langOf } from './rooms.js';

export const CHROMA_PRESETS = Object.freeze({
  green: '#00ff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
});

export const SHARE_TEXT = Object.freeze({
  ko: Object.freeze({
    overlayBtn: '오버레이',
    overlayExit: 'Office Sim · 오버레이 끄기 (O)',
    overlayTitle: 'OBS·스트리머용 투명 배경 오버레이 모드 전환 (단축키 O)',
    clipBtn: '5초 클립',
    clipRec: (s) => `녹화 ${s}s…`,
    clipTitle: '5초 WebM 영상 클립 저장 (Shift+클릭: PNG 스크린샷)',
  }),
  en: Object.freeze({
    overlayBtn: 'Overlay',
    overlayExit: 'Office Sim · Exit Overlay (O)',
    overlayTitle: 'Toggle transparent OBS/Streamer overlay mode (Shortcut O)',
    clipBtn: '5s Clip',
    clipRec: (s) => `REC ${s}s…`,
    clipTitle: 'Record 5s WebM clip (Shift+Click: PNG snapshot)',
  }),
});

export const shareText = (lang = 'ko') => SHARE_TEXT[langOf(lang)];

export function normalizeChroma(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (Object.hasOwn(CHROMA_PRESETS, v)) return CHROMA_PRESETS[v];
  const hex = v.startsWith('#') ? v.slice(1) : v;
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

export function parseOverlayMode(search = '', hash = '') {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const chroma = normalizeChroma(params.get('chroma'));
  const rawOv = params.get('overlay');
  const hashOv = String(hash || '').toLowerCase() === '#overlay';
  let overlay = false;
  if (rawOv !== null) {
    const v = rawOv.trim().toLowerCase();
    overlay = v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } else if (hashOv || chroma !== null) {
    overlay = true;
  }
  return { overlay, chroma };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function clipFilename(ext = 'webm', now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const cleanExt = String(ext || 'webm').replace(/^\.+/, '') || 'webm';
  return `office-sim-${stamp}.${cleanExt}`;
}

export function pickRecorderMime(isTypeSupported = (m) => globalThis.MediaRecorder?.isTypeSupported?.(m)) {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of candidates) {
    try { if (isTypeSupported?.(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

function triggerDownload(doc, href, filename) {
  const a = doc.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

export function installShareControls({ stage, hud, doc = globalThis.document, win = globalThis.window } = {}) {
  if (!doc || !win) return null;
  const overlayBtn = doc.getElementById('toggle-overlay');
  const exitBtn = doc.getElementById('exit-overlay');
  const clipBtn = doc.getElementById('capture-clip');
  const state = parseOverlayMode(win.location?.search, win.location?.hash);
  let recording = false;
  let recRemain = 5;

  const syncLabels = () => {
    const t = shareText(hud?.lang);
    if (overlayBtn) {
      overlayBtn.textContent = t.overlayBtn;
      overlayBtn.title = t.overlayTitle;
      overlayBtn.setAttribute('aria-pressed', String(state.overlay));
    }
    if (exitBtn) exitBtn.textContent = t.overlayExit;
    if (clipBtn) {
      clipBtn.textContent = recording ? t.clipRec(recRemain) : t.clipBtn;
      clipBtn.title = t.clipTitle;
      clipBtn.disabled = recording;
    }
  };

  const applyOverlay = (on) => {
    state.overlay = !!on;
    doc.body.classList.toggle('overlay', state.overlay);
    if (exitBtn) exitBtn.hidden = !state.overlay;
    stage?.setOverlayBg?.(state.overlay ? (state.chroma || 'transparent') : null);
    syncLabels();
  };

  const capturePng = () => {
    const canvas = stage?.renderer?.domElement;
    if (!canvas?.toDataURL) return;
    stage?.render?.(hud?.office?.labelRoot?.());
    triggerDownload(doc, canvas.toDataURL('image/png'), clipFilename('png'));
  };

  const recordClip = (durationSec = 5) => {
    if (recording) return;
    const canvas = stage?.renderer?.domElement;
    if (typeof win.MediaRecorder !== 'function' || typeof canvas?.captureStream !== 'function') {
      capturePng();
      return;
    }
    let stream;
    try { stream = canvas.captureStream(30); } catch { capturePng(); return; }
    const mimeType = pickRecorderMime((m) => win.MediaRecorder.isTypeSupported?.(m));
    let rec;
    try { rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); } catch { capturePng(); return; }
    const chunks = [];
    recording = true;
    recRemain = durationSec;
    syncLabels();
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const timer = win.setInterval(() => {
      recRemain = Math.max(1, recRemain - 1);
      syncLabels();
    }, 1000);
    rec.onstop = () => {
      win.clearInterval(timer);
      recording = false;
      syncLabels();
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      triggerDownload(doc, url, clipFilename('webm'));
      win.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    rec.start();
    win.setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, durationSec * 1000);
  };

  overlayBtn?.addEventListener('click', () => applyOverlay(!state.overlay));
  exitBtn?.addEventListener('click', () => applyOverlay(false));
  clipBtn?.addEventListener('click', (e) => {
    if (e.shiftKey) capturePng();
    else recordClip(5);
  });
  hud?.el?.langBtn?.addEventListener('click', () => syncLabels());
  win.addEventListener('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'o') { e.preventDefault(); applyOverlay(!state.overlay); }
    else if (e.key === 'Escape' && state.overlay) applyOverlay(false);
  });

  applyOverlay(state.overlay);
  return { state, applyOverlay, capturePng, recordClip, syncLabels };
}
