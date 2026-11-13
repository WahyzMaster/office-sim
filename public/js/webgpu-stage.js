// Optional WebGPU renderer progressive enhancement & high-concurrency benchmark parsing.
// Pure helpers (`resolveRendererRequest`, `probeWebGPU`, `requestWebGPUAdapter`, `parseBenchConfig`,
// `rendererBadgeLabel`) run without a browser DOM so Node tests can verify every fallback path directly.

export const RENDERER_BACKENDS = Object.freeze(['webgl2', 'webgpu']);

// The WebGPU renderer is the one part of three.js that is not vendored under public/vendor/: the importmap leaves it on
// the CDN, and the local server's CSP allows that host only when it was started with --cdn. So "the import was refused
// or failed" is its own, expected outcome with its own text (ko/en) instead of the browser's raw import error.
// An import that only fails to answer in time is not that outcome: it is a timeout like the others and names no flag.
const LOAD_FAILED = Object.freeze({
  en: 'WebGPU files did not load; the local page needs office-sim --cdn',
  ko: 'WebGPU 파일을 불러오지 못했어요. 로컬 페이지는 office-sim --cdn 이 필요해요',
});

export const TIMEOUT_FAILED = Object.freeze({
  en: 'WebGPU initialization timed out (3000ms)',
  ko: 'WebGPU 초기화 시간 초과 (3000ms)',
});

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hashTokens(hash = '') {
  const clean = String(hash || '').replace(/^#/, '').trim();
  if (!clean) return [];
  return clean.split(/[&,;/]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Determine whether the caller opted into the progressive WebGPU backend (`?renderer=webgpu` or `#webgpu`).
 * Defaults to `'webgl2'` so existing sessions keep deterministic WebGL2 rendering unless opted in.
 */
export function resolveRendererRequest(search = '', hash = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const q = (params.get('renderer') || '').trim().toLowerCase();
  if (q === 'webgpu' || q === 'gpu') return 'webgpu';
  if (q === 'webgl' || q === 'webgl2') return 'webgl2';
  const tokens = hashTokens(hash);
  if (tokens.some((t) => t === 'webgpu' || t === 'renderer=webgpu' || t.startsWith('webgpu-'))) return 'webgpu';
  return 'webgl2';
}

/** Synchronous capability check for `navigator.gpu.requestAdapter`. */
export function probeWebGPU(nav = globalThis.navigator) {
  return Boolean(nav && typeof nav === 'object' && nav.gpu && typeof nav.gpu.requestAdapter === 'function');
}

/** Async adapter probe returning `{ ok, adapter, reason }` without throwing. */
export async function requestWebGPUAdapter(nav = globalThis.navigator) {
  if (!probeWebGPU(nav)) return { ok: false, adapter: null, reason: 'navigator.gpu unavailable' };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { ok: false, adapter: null, reason: 'no WebGPU adapter available' };
    return { ok: true, adapter, reason: null };
  } catch (err) {
    return { ok: false, adapter: null, reason: String(err?.message || 'WebGPU adapter error').slice(0, 120) };
  }
}

/**
 * Parse `#bench`, `#bench-20x6`, or `?bench=1&floors=20&mains=4&subs=2` for high-concurrency stress runs
 * (`100+` concurrent agents across `20+` project floors).
 */
export function parseBenchConfig(search = '', hash = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const tokens = hashTokens(hash);
  const benchTok = tokens.find((t) => t === 'bench' || t.startsWith('bench-'));
  const qBench = params.get('bench');
  const enabled = Boolean(benchTok || qBench === '1' || qBench === 'true');
  let floors = 10;
  let mains = 4;
  let subs = 2;
  const shorthand = benchTok ? /^bench-(\d+)x(\d+)$/.exec(benchTok) : null;
  if (shorthand) {
    floors = clampInt(shorthand[1], 10, 1, 32);
    const perFloor = clampInt(shorthand[2], 6, 1, 24);
    subs = Math.floor(perFloor / 3);
    mains = Math.max(1, perFloor - subs);
  }
  if (params.has('floors')) floors = clampInt(params.get('floors'), floors, 1, 32);
  if (params.has('mains')) mains = clampInt(params.get('mains'), mains, 1, 12);
  if (params.has('subs')) subs = clampInt(params.get('subs'), subs, 0, 12);
  return { enabled, floors, mains, subs, totalAgents: floors * (mains + subs) };
}

/** Short human-readable badge/tooltip string for the renderer backend. */
export function rendererBadgeLabel(info, lang = 'ko') {
  const active = info?.active === 'webgpu' ? 'WebGPU' : 'WebGL2';
  if (info?.requested !== 'webgpu') return active;
  if (info.active === 'webgpu') return lang === 'en' ? 'WebGPU active' : 'WebGPU 활성';
  const reason = info.fallbackCode === 'load'
    ? LOAD_FAILED[lang === 'en' ? 'en' : 'ko']
    : info.fallbackCode === 'timeout'
      ? TIMEOUT_FAILED[lang === 'en' ? 'en' : 'ko']
      : info.fallbackReason;
  const why = reason ? ` (${reason})` : '';
  return lang === 'en' ? `WebGL2 fallback${why}` : `WebGL2 대체${why}`;
}

class InitTimeout extends Error {} // what withTimeout rejects with: told apart from a loader's own error by its class

async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new InitTimeout('WebGPU init timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Progressive WebGPU upgrade for `stage`. When `?renderer=webgpu` or `#webgpu` is active and `navigator.gpu`
 * succeeds, dynamically loads Three.js `WebGPURenderer`, awaits `.init()`, and swaps the stage renderer.
 * Any missing capability, module error, or timeout leaves the existing `THREE.WebGLRenderer` (`webgl2`) running.
 * When the import of the renderer module is refused or fails (the CSP without --cdn, offline, any import error) the
 * info also carries `fallbackCode: 'load'`, which `rendererBadgeLabel` turns into the ko/en hint naming --cdn. An
 * import that does not answer within the time limit has no `fallbackCode`: its reason is the timeout text.
 */
export async function initOptionalWebGPU(stage, opts = {}) {
  const search = opts.search ?? globalThis.location?.search ?? '';
  const hash = opts.hash ?? globalThis.location?.hash ?? '';
  const requested = resolveRendererRequest(search, hash);
  const settle = (info) => {
    stage?.setRendererInfo?.(info);
    return info;
  };
  if (requested !== 'webgpu') {
    return settle({ requested: 'webgl2', active: 'webgl2', fallbackReason: null });
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 2500;
  let probe;
  try {
    probe = await withTimeout(requestWebGPUAdapter(opts.nav ?? globalThis.navigator), timeoutMs);
  } catch (err) {
    return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: String(err?.message || 'WebGPU adapter timeout').slice(0, 120) });
  }
  if (!probe.ok) {
    return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: probe.reason });
  }
  const loadWebGPU = opts.loadWebGPU ?? (() => import('three/addons/renderers/webgpu/WebGPURenderer.js'));
  let mod;
  try {
    mod = await withTimeout(Promise.resolve().then(loadWebGPU), timeoutMs);
  } catch (err) {
    if (err instanceof InitTimeout) return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: err.message });
    return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: LOAD_FAILED.en, fallbackCode: 'load' });
  }
  let gpuRenderer = null;
  try {
    const Ctor = mod?.default ?? mod?.WebGPURenderer ?? mod;
    if (typeof Ctor !== 'function') throw new Error('WebGPURenderer constructor unavailable');
    gpuRenderer = new Ctor({ antialias: true, alpha: true });
    const dpr = opts.pixelRatio ?? Math.min(globalThis.window?.devicePixelRatio || 1, 2);
    gpuRenderer.setPixelRatio?.(dpr);
    if (gpuRenderer.shadowMap) gpuRenderer.shadowMap.enabled = true;
    const initTimeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 3000;
    if (typeof gpuRenderer.init === 'function') await withTimeout(gpuRenderer.init(), initTimeoutMs);
    if (!gpuRenderer.domElement) throw new Error('WebGPURenderer missing domElement');
    const info = { requested: 'webgpu', active: 'webgpu', fallbackReason: null };
    stage?.swapRenderer?.(gpuRenderer, info);
    return settle(info);
  } catch (err) {
    try { gpuRenderer?.dispose?.(); } catch { /* ignore */ }
    if (err instanceof InitTimeout) {
      return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: TIMEOUT_FAILED.en, fallbackCode: 'timeout' });
    }
    const reason = String(err?.message || 'WebGPU initialization failed').slice(0, 120);
    return settle({ requested: 'webgpu', active: 'webgl2', fallbackReason: reason });
  }
}
