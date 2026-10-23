// Lightweight passive watcher for Grok Bot desktop app (/Applications/Grok Bot.app, ~/.grokbot,
// ~/Library/Application Support/Grok Bot) and Grok CLI unified log (~/.grok/logs/unified.jsonl).
// Zero LLM token usage: only stats files and tails local state/log files.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const GROK_AGENT = 'grok';
export const GROK_BOT_CWD = '/Grok Bot';
export const GROK_BOT_TITLE = 'Grok Bot';
export const GROK_CLI_CWD = '/Grok CLI';
export const GROK_CLI_TITLE = 'Grok Build CLI';
export const DEFAULT_GROK_BOT_UUID = '00000000-0000-4000-8000-0000000009b0';
export const DEFAULT_GROK_CLI_UUID = '00000000-0000-4000-8000-0000000009c1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const MAX_TAIL_BYTES = 256 * 1024;
const GROKBOT_FILES = [
  'local-exec-daemon.log',
  'local-exec-supervisor.json',
  'local-exec-daemon.json',
  'local-exec-daemon-connection.json',
  'settings.json',
];
const APP_SUPPORT_FILES = [
  'window-state.json',
  'gateway-descriptor.json',
  'sand-statsig-bootstrap.json',
  'Cookies',
  'Preferences',
  'DIPS-wal',
  'DIPS',
  'Network Persistent State',
  'sentry/scope_v3.json',
];
const UNIFIED_DONE_MSGS = new Set([
  'turn.complete',
  'shell.handle_prompt.done',
  'agent response complete',
  'pager quit',
  'session_end.worker_join',
]);

function isSkippable(err) {
  return Boolean(err && SKIP_CODES.has(err.code));
}

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

async function readTailText(filePath, size, maxBytes = MAX_TAIL_BYTES) {
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) return '';
  let fh;
  try {
    fh = await fsp.open(filePath, OPEN_FLAGS);
    const fst = await fh.stat();
    if (!fst.isFile()) return '';
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

export function defaultGrokDesktopDirs(homedir = os.homedir()) {
  return {
    grokRoot: path.join(homedir, '.grok'),
    grokBotRoot: path.join(homedir, '.grokbot'),
    appSupportRoot: path.join(homedir, 'Library', 'Application Support', 'Grok Bot'),
  };
}

function cleanBotTitle(rawName, rawTitle) {
  const t = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '';
  const n = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : '';
  const pick = t || n;
  if (!pick || pick.toLowerCase() === 'grok bot') return GROK_BOT_TITLE;
  return `${GROK_BOT_TITLE} · ${pick.slice(0, 48)}`;
}

function maxTimestampOfRow(row) {
  let max = -Infinity;
  for (const k of ['lastActivityAt', 'lastViewedAt', 'updatedAt', 'createdAt']) {
    const v = row?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

async function scanGrokBotApp(grokBotRoot, appSupportRoot, { minMtime, seenUuids }) {
  let bestSt = null;
  let bestPath = null;
  const consider = (p, st) => {
    if (!st || !st.isFile()) return;
    if (!bestSt || st.mtimeMs > bestSt.mtimeMs) {
      bestSt = st;
      bestPath = p;
    }
  };

  if (typeof grokBotRoot === 'string' && grokBotRoot !== '') {
    for (const name of GROKBOT_FILES) {
      const p = path.join(grokBotRoot, name);
      consider(p, await lstatOrNull(p));
    }
  }
  if (typeof appSupportRoot === 'string' && appSupportRoot !== '') {
    for (const name of APP_SUPPORT_FILES) {
      const p = path.join(appSupportRoot, name);
      consider(p, await lstatOrNull(p));
    }
  }

  let daemonCompleted = false;
  if (typeof grokBotRoot === 'string' && grokBotRoot !== '') {
    const logPath = path.join(grokBotRoot, 'local-exec-daemon.log');
    const logSt = await lstatOrNull(logPath);
    if (logSt && logSt.isFile()) {
      const text = await readTailText(logPath, logSt.size, 64 * 1024);
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const last = lines.at(-1) ?? '';
      if (/shutting down/i.test(last)) daemonCompleted = true;
    }
  }

  const rows = [];
  let fallbackAgentId = null;
  if (typeof appSupportRoot === 'string' && appSupportRoot !== '') {
    const persistDir = path.join(appSupportRoot, 'sand-client-persistence');
    const entries = await listDir(persistDir);
    if (entries) {
      for (const d of entries) {
        if (!d.isFile() || !d.name.endsWith('.blob')) continue;
        const blobPath = path.join(persistDir, d.name);
        const st = await lstatOrNull(blobPath);
        if (!st || !st.isFile() || st.size > MAX_TAIL_BYTES) continue;
        consider(blobPath, st);
        const raw = await readTailText(blobPath, st.size, MAX_TAIL_BYTES);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const val = parsed?.value;
          if (Array.isArray(val?.rows)) {
            for (const r of val.rows) {
              if (r && typeof r.id === 'string' && UUID_RE.test(r.id)) {
                rows.push({ ...r, id: r.id.toLowerCase(), blobPath, blobSt: st });
              }
            }
          } else if (typeof val?.agentId === 'string' && UUID_RE.test(val.agentId)) {
            fallbackAgentId = val.agentId.toLowerCase();
          }
        } catch {
          // ignore malformed blob
        }
      }
    }
  }

  if (!bestSt) return [];
  const out = [];
  const pushBotRef = (uuid, title, eventMs, watchPath, watchSt, completed) => {
    if (eventMs < minMtime || seenUuids.has(uuid)) return;
    seenUuids.add(uuid);
    const charId = `${GROK_AGENT}-${uuid}`;
    out.push({
      path: path.join(path.dirname(watchPath), `grok-bot-${uuid}.jsonl`),
      agent: GROK_AGENT,
      kind: 'main',
      charId,
      stem: charId,
      sessionId: uuid,
      sid: charId,
      mtimeMs: eventMs,
      size: watchSt.size,
      ino: watchSt.ino,
      facts: {
        desktopKind: 'grok-bot',
        surface: 'app',
        threadId: uuid,
        watchPath,
        cwd: GROK_BOT_CWD,
        title,
        completed: Boolean(completed),
      },
    });
  };

  for (const row of rows) {
    const eventMs = Math.max(maxTimestampOfRow(row), row.blobSt.mtimeMs, bestSt.mtimeMs);
    const title = cleanBotTitle(row.name, row.title);
    const completed = daemonCompleted && !row.awaitingUserResponse;
    pushBotRef(row.id, title, eventMs, row.blobPath, row.blobSt, completed);
  }

  if (out.length === 0 && bestSt.mtimeMs >= minMtime) {
    const uuid = fallbackAgentId ?? DEFAULT_GROK_BOT_UUID;
    pushBotRef(uuid, GROK_BOT_TITLE, bestSt.mtimeMs, bestPath, bestSt, daemonCompleted);
  }
  return out;
}

export function parseGrokUnifiedLogLine(line) {
  if (typeof line !== 'string' || !line.startsWith('{')) return null;
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    const ms = typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
    const sid = typeof obj.sid === 'string' && UUID_RE.test(obj.sid) ? obj.sid.toLowerCase() : null;
    const msg = typeof obj.msg === 'string' ? obj.msg : '';
    const promptId = typeof obj.ctx?.prompt_id === 'string' ? obj.ctx.prompt_id : null;
    return {
      sid,
      msg,
      promptId,
      ms: Number.isFinite(ms) ? ms : null,
      completed: UNIFIED_DONE_MSGS.has(msg),
    };
  } catch {
    return null;
  }
}

async function scanGrokUnifiedLog(unifiedLogPath, { minMtime, seenUuids, hasLocalRefs }) {
  if (typeof unifiedLogPath !== 'string' || unifiedLogPath === '') return [];
  const st = await lstatOrNull(unifiedLogPath);
  if (!st || !st.isFile() || st.mtimeMs < minMtime) return [];
  const text = await readTailText(unifiedLogPath, st.size, MAX_TAIL_BYTES);
  if (!text) return [];

  const bySid = new Map(); // sid -> { sid, eventMs, completed }
  let latestAnyMs = st.mtimeMs;
  let latestAnyCompleted = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ev = parseGrokUnifiedLogLine(trimmed);
    if (!ev) continue;
    const eventMs = ev.ms ?? st.mtimeMs;
    if (eventMs >= latestAnyMs) {
      latestAnyMs = eventMs;
      latestAnyCompleted = ev.completed;
    }
    if (!ev.sid || seenUuids.has(ev.sid)) continue;
    const prev = bySid.get(ev.sid);
    if (!prev || eventMs >= prev.eventMs) {
      bySid.set(ev.sid, { sid: ev.sid, eventMs, completed: ev.completed });
    }
  }

  const out = [];
  const pushUnifiedRef = (uuid, eventMs, completed) => {
    if (eventMs < minMtime || seenUuids.has(uuid)) return;
    seenUuids.add(uuid);
    const charId = `${GROK_AGENT}-${uuid}`;
    out.push({
      path: path.join(path.dirname(unifiedLogPath), `unified-${uuid}.jsonl`),
      agent: GROK_AGENT,
      kind: 'main',
      charId,
      stem: charId,
      sessionId: uuid,
      sid: charId,
      mtimeMs: eventMs,
      size: st.size,
      ino: st.ino,
      facts: {
        desktopKind: 'grok-unified-log',
        surface: 'cli',
        threadId: uuid,
        watchPath: unifiedLogPath,
        cwd: GROK_BOT_CWD,
        title: GROK_BOT_TITLE,
        completed: Boolean(completed),
      },
    });
  };

  for (const item of bySid.values()) {
    pushUnifiedRef(item.sid, item.eventMs, item.completed);
  }
  if (out.length === 0 && !hasLocalRefs && latestAnyMs >= minMtime) {
    pushUnifiedRef(DEFAULT_GROK_CLI_UUID, latestAnyMs, latestAnyCompleted);
  }
  return out;
}

/**
 * Scan Grok Bot desktop state (~/.grokbot, ~/Library/Application Support/Grok Bot) and
 * Grok CLI unified.jsonl (~/.grok/logs/unified.jsonl) for active sessions not in `localRefs`.
 * Only runs when `root` matches `~/.grok` or when `grokBotRoot`/`appSupportRoot`/`unifiedLogPath` is explicitly passed.
 */
export async function scanGrokDesktopBot(root, {
  activeMs = Infinity, nowMs = Date.now(), localRefs = [], grokBotRoot, appSupportRoot, unifiedLogPath,
} = {}) {
  const defs = defaultGrokDesktopDirs();
  const explicit = grokBotRoot !== undefined || appSupportRoot !== undefined || unifiedLogPath !== undefined;
  const isDefaultRoot = typeof root === 'string' && root !== '' && path.resolve(root) === path.resolve(defs.grokRoot);
  if (!explicit && !isDefaultRoot) return [];

  const bRoot = grokBotRoot !== undefined ? grokBotRoot : (isDefaultRoot ? defs.grokBotRoot : '');
  const aRoot = appSupportRoot !== undefined ? appSupportRoot : (isDefaultRoot ? defs.appSupportRoot : '');
  const uPath = unifiedLogPath !== undefined
    ? unifiedLogPath
    : (isDefaultRoot ? path.join(defs.grokRoot, 'logs', 'unified.jsonl') : '');
  const minMtime = Number.isFinite(activeMs) ? nowMs - activeMs : -Infinity;
  const seenUuids = new Set(localRefs.map((r) => String(r.sessionId || '').toLowerCase()).filter(Boolean));

  const botRefs = await scanGrokBotApp(bRoot, aRoot, { minMtime, seenUuids });
  const unifiedRefs = await scanGrokUnifiedLog(uPath, {
    minMtime, seenUuids, hasLocalRefs: localRefs.length > 0 || botRefs.length > 0,
  });
  const all = [...botRefs, ...unifiedRefs];
  for (const ref of all) {
    Object.defineProperties(ref.facts, {
      readAll: { value: (r, onLine) => defaultGrokTailer.readAll(r, onLine) },
      poll: { value: (r, onLine) => defaultGrokTailer.poll(r, onLine) },
      forget: { value: (p) => defaultGrokTailer.forget(p) },
    });
  }
  return all;
}

export class GrokDesktopTailer {
  #bots = new Map(); // ref.path -> { threadId, watchPath, title, mtimeMs, size, turnSeq }

  async #emitTurn(state, tsMs, complete, onLine) {
    const promptId = `grok-bot-turn-${++state.turnSeq}`;
    const timestamp = tsMs / 1000;
    const baseMeta = { agentTimestampMs: tsMs, promptId };
    await onLine(JSON.stringify({
      method: 'session/update',
      params: {
        sessionId: state.threadId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: state.title } },
        _meta: baseMeta,
      },
      timestamp,
    }));
    await onLine(JSON.stringify({
      method: 'session/update',
      params: {
        sessionId: state.threadId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Active in ${state.title}` } },
        _meta: baseMeta,
      },
      timestamp,
    }));
    if (complete) {
      await onLine(JSON.stringify({
        method: 'session/update',
        params: {
          sessionId: state.threadId,
          update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' },
          _meta: baseMeta,
        },
        timestamp,
      }));
    }
  }

  async readAll(ref, onLine) {
    const watchPath = ref?.facts?.watchPath;
    const st = watchPath ? await lstatOrNull(watchPath) : null;
    if (!st || !st.isFile()) return { offset: 0, skipped: 0, gone: true };
    const tsMs = Math.round(ref.mtimeMs || st.mtimeMs);
    const state = {
      threadId: ref.facts.threadId ?? ref.sessionId,
      watchPath,
      title: ref.facts.title ?? GROK_BOT_TITLE,
      mtimeMs: st.mtimeMs,
      size: st.size,
      turnSeq: 0,
    };
    this.#bots.set(ref.path, state);
    await this.#emitTurn(state, tsMs, Boolean(ref.facts.completed), onLine);
    return { offset: st.size, skipped: 0 };
  }

  async poll(ref, onLine) {
    const state = this.#bots.get(ref.path);
    if (!state) return { reset: true };
    const st = await lstatOrNull(state.watchPath);
    if (!st || !st.isFile()) return { gone: true };
    if (st.mtimeMs === state.mtimeMs && st.size === state.size) return { bytes: 0, skipped: 0 };
    state.mtimeMs = st.mtimeMs;
    state.size = st.size;
    await this.#emitTurn(state, Math.round(st.mtimeMs), false, onLine);
    return { bytes: 1, skipped: 0 };
  }

  forget(p) {
    this.#bots.delete(p);
  }
}

const defaultGrokTailer = new GrokDesktopTailer();
