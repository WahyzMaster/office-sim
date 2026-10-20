// 어댑터 등록표 (contract 4.0.1, ADAPTERS.md 3.1/3.5, 결정 D3). 어떤 어댑터를 켤지 고른다.
// 루트 확인은 주입할 수 있는 probe 로 한다 (테스트는 임시 폴더나 가짜 probe 만 쓴다).
import fsp from 'node:fs/promises';
import { claudeCode } from './claude-code.mjs';
import { grok } from './grok/index.mjs';

/** Every adapter id the CLI accepts; the `agent` of a `session` event is one of these. */
export const KNOWN_AGENTS = Object.freeze(['claude-code', 'codex', 'grok', 'antigravity']);

/** Display labels, the same table as AGENT_LABEL in public/js/hud.js. */
export const AGENT_LABELS = Object.freeze({
  'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity',
});

/** Implemented adapters by id: claude-code (P5a) and grok (P5c). Codex and Antigravity come in P5d-P5e (D11). */
export const ADAPTERS = Object.freeze({ 'claude-code': claudeCode, grok });

const CLAUDE = 'claude-code';

/**
 * The default root of every implemented adapter except claude-code (whose root is the start() `root` option), as the
 * descriptors give it (`~` not expanded): what the bin passes as `roots` under the --<id>-root flags. start() itself
 * never falls back to these, so a caller (a test) that gives no root for an adapter never reads its real folder.
 */
export function defaultRoots(adapters = ADAPTERS) {
  const out = {};
  for (const [id, a] of Object.entries(adapters)) {
    if (id !== CLAUDE && typeof a?.defaultRoot === 'string' && a.defaultRoot !== '') out[id] = a.defaultRoot;
  }
  return out;
}

export function isKnownAgent(id) {
  return typeof id === 'string' && KNOWN_AGENTS.includes(id);
}

/** Validate a requested agent list: an id outside KNOWN_AGENTS is a RangeError. Returns the ids, deduped, in order. */
export function checkAgents(ids) {
  if (!Array.isArray(ids)) throw new RangeError('agents must be an array of agent ids');
  const out = [];
  for (const id of ids) {
    if (!isKnownAgent(id)) {
      throw new RangeError(`unknown agent "${String(id).slice(0, 40)}" (known: ${KNOWN_AGENTS.join(', ')})`);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** D3 root check: null when `root` is a directory we can open, else the error code (ENOENT, EACCES, ENOTDIR ...). */
export async function probeRoot(root) {
  if (typeof root !== 'string' || root === '') return 'EINVAL';
  try {
    const dir = await fsp.opendir(root);
    await dir.close();
    return null;
  } catch (err) {
    return typeof err?.code === 'string' ? err.code : 'EUNKNOWN';
  }
}

/** How long a root check may take before the adapter counts as unreadable (code ETIMEDOUT). */
export const PROBE_TIMEOUT_MS = 2000;

/** A usable probe time limit: `ms` when it is a positive number, else PROBE_TIMEOUT_MS. */
export function probeLimit(ms) {
  return Number.isFinite(ms) && ms > 0 ? ms : PROBE_TIMEOUT_MS;
}

/**
 * One root check with a time limit: resolves to the probe's answer (null = usable, else an error code), or
 * 'ETIMEDOUT' when it has not answered within `ms`. `onSettle` runs when the probe itself finishes (also after a
 * timeout), so a caller can avoid stacking checks on a stalled mount. `unref`: the timer does not hold the process.
 */
// 시작할 때의 확인은 서버가 듣기 전에 돈다. 멈춘 네트워크/FUSE 마운트의 opendir 은 끝나지 않을 수 있으므로 제한 시간을 둔다.
// 그때 타이머는 unref 하지 않는다: 확인이 끝나면 바로 지우고, 끝나지 않을 때는 이 타이머가 시작을 마저 진행시킨다.
export function probeWithin(probe, root, id, ms, { unref = false, onSettle = null } = {}) {
  let timer;
  const raw = Promise.resolve().then(() => probe(root, id));
  if (typeof onSettle === 'function') raw.then(onSettle, onSettle);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('ETIMEDOUT'), probeLimit(ms));
    if (unref) timer.unref?.();
  });
  return Promise.race([raw, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Which adapters run (D3): every implemented adapter whose root can be opened. `agents` (when given) narrows the set;
 * a requested id that is known but not implemented is reported in `notImplemented` and skipped; an unknown id throws.
 * An implemented adapter other than claude-code with no root in `roots` is skipped too (not probed, not reported):
 * default roots are the caller's choice (defaultRoots(), the bin), never this function's.
 * @param {{ agents?: string[]|null, roots?: Record<string, string>, adapters?: object,
 *           probe?: (root: string, id: string) => (string|null|Promise<string|null>), probeTimeoutMs?: number }} o
 *   roots: the resolved root per adapter id (the caller expands ~). probe: null = usable, else an error code.
 *   probeTimeoutMs: a probe that has not answered by then counts as 'ETIMEDOUT' (default PROBE_TIMEOUT_MS).
 * @returns {Promise<{ enabled: { id, adapter, root }[], off: { id, code }[], notImplemented: string[] }>}
 *   Every list follows KNOWN_AGENTS order.
 */
export async function selectAdapters({
  agents = null, roots = {}, adapters = ADAPTERS, probe = probeRoot, probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const limit = probeLimit(probeTimeoutMs);
  const wanted = agents == null ? null : checkAgents(agents);
  const out = { enabled: [], off: [], notImplemented: [] };
  for (const id of KNOWN_AGENTS) {
    if (wanted && !wanted.includes(id)) continue;
    const adapter = Object.hasOwn(adapters, id) ? adapters[id] : null;
    if (!adapter) {
      if (wanted) out.notImplemented.push(id); // 기본값(모두)일 때는 아직 없는 어댑터를 알리지 않는다
      continue;
    }
    const root = roots?.[id];
    if (id !== CLAUDE && (typeof root !== 'string' || root === '')) continue; // 루트를 받지 않은 어댑터: 기본 루트를 읽지 않는다
    const code = await probeWithin(probe, root, id, limit);
    if (code) out.off.push({ id, code });
    else out.enabled.push({ id, adapter, root });
  }
  return out;
}
