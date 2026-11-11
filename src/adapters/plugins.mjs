// Optional plug-in adapter registry (`docs/SOFTWARE_DEVELOPMENT_REPORT.md` §6.3 #3).
// Keeps the 4 default built-in adapters (`KNOWN_AGENTS`, `ADAPTERS`) untouched unless `--plugins <id,id>`
// or `start({ plugins })` / `resolvePluginAdapters(...)` opts into plug-in descriptors.
import { ADAPTERS, KNOWN_AGENTS } from './index.mjs';
import { publicSessionId } from '../session-identity.mjs';
import { geminiCli } from './gemini-cli/index.mjs';

export const KNOWN_PLUGINS = Object.freeze(['gemini-cli']);

export const PLUGIN_LABELS = Object.freeze({
  'gemini-cli': 'Gemini CLI',
});

export const PLUGIN_ADAPTERS = Object.freeze({
  'gemini-cli': geminiCli,
});

export function isKnownPlugin(id) {
  return typeof id === 'string' && KNOWN_PLUGINS.includes(id);
}

/**
 * Validate a plug-in adapter descriptor (`{ id, defaultRoot, deps }`).
 * Ensures valid `SESSION_ID_RE` agent id, non-empty `defaultRoot`, and async `deps()` factory,
 * and forbids shadowing the core `claude-code` adapter.
 */
export function validatePluginDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('plugin descriptor must be an object');
  }
  const { id, defaultRoot, deps } = descriptor;
  if (publicSessionId(id) === null) {
    throw new RangeError(`invalid plugin adapter id "${String(id ?? '').slice(0, 40)}"`);
  }
  if (KNOWN_AGENTS.includes(id)) {
    throw new RangeError(`plugin adapter "${id}" cannot shadow built-in adapter "${id}"`);
  }
  if (typeof defaultRoot !== 'string' || defaultRoot.trim() === '') {
    throw new TypeError(`plugin adapter "${id}" requires a non-empty defaultRoot string`);
  }
  if (typeof deps !== 'function') {
    throw new TypeError(`plugin adapter "${id}" requires a deps() function`);
  }
  return descriptor;
}

/** Validate an array of built-in plug-in IDs (`--plugins <id,id>`). */
export function checkPlugins(ids) {
  if (!Array.isArray(ids)) throw new RangeError('plugins must be an array of plugin ids');
  const out = [];
  for (const id of ids) {
    if (!isKnownPlugin(id)) {
      throw new RangeError(`unknown plugin "${String(id).slice(0, 40)}" (known: ${KNOWN_PLUGINS.join(', ')})`);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Merge enabled plug-ins (either known plug-in ID strings or custom descriptor objects) onto `base` (`ADAPTERS`).
 */
export function resolvePluginAdapters(plugins = null, base = ADAPTERS) {
  if (plugins == null) return base;
  if (!Array.isArray(plugins)) throw new RangeError('plugins must be an array of plugin ids or descriptors');
  if (plugins.length === 0) return base;
  const merged = { ...base };
  for (const entry of plugins) {
    if (typeof entry === 'string') {
      if (!isKnownPlugin(entry)) {
        throw new RangeError(`unknown plugin "${entry.slice(0, 40)}" (known: ${KNOWN_PLUGINS.join(', ')})`);
      }
      merged[entry] = PLUGIN_ADAPTERS[entry];
    } else {
      const d = validatePluginDescriptor(entry);
      merged[d.id] = d;
    }
  }
  return Object.freeze(merged);
}

/** Default roots (`~` unexpanded) for enabled plug-ins — used by `bin/office-sim.mjs`, never by `start()` directly. */
export function pluginDefaultRoots(plugins = null) {
  if (!Array.isArray(plugins) || !plugins.length) return {};
  const out = {};
  for (const entry of plugins) {
    const d = typeof entry === 'string' ? (isKnownPlugin(entry) ? PLUGIN_ADAPTERS[entry] : null) : validatePluginDescriptor(entry);
    if (d && typeof d.defaultRoot === 'string' && d.defaultRoot !== '') out[d.id] = d.defaultRoot;
  }
  return out;
}
