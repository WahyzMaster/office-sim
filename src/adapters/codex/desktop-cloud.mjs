// Lightweight passive watcher for ChatGPT Desktop (com.openai.codex) cloud chats
// and ChatGPT Classic (com.openai.chat) .data conversation files on macOS.
// Zero LLM token usage: only stats files and tails plain-text desktop logs.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Tailer } from '../../tailer.mjs';

export const CODEX_AGENT = 'codex';
export const CHATGPT_DESKTOP_CWD = '/ChatGPT Desktop';
export const CHATGPT_DESKTOP_TITLE = 'ChatGPT Desktop Chat';
export const CHATGPT_CLASSIC_CWD = '/ChatGPT Classic';
export const CHATGPT_CLASSIC_TITLE = 'ChatGPT Classic Chat';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLASSIC_DATA_RE = new RegExp(`^(${UUID})\\.data$`, 'i');
const DESKTOP_LOG_RE = /^codex-desktop-.*-t0-.*\.log$/;
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
const CLOUD_EVENT_PATTERNS = [
  { kind: 'start', re: new RegExp(`chatgpt_conversation_refetch_started\\s+conversationId=(${UUID})`, 'i') },
  { kind: 'sync', re: new RegExp(`chatgpt_conversation_refetch_completed\\s+.*?conversationId=(${UUID})`, 'i') },
  { kind: 'route', re: new RegExp(`IAB_LIFECYCLE\\s+(?:captured|prepared local Work) session route conversationId=local-chatgpt:(${UUID})`, 'i') },
  { kind: 'complete', re: new RegExp(`\\[desktop-notifications\\]\\s+received turn-complete conversationId=(${UUID})`, 'i') },
];
const DEAD_CONV_RE = new RegExp(
  `(?:conversation_deleted|conversation_inaccessible|status=404\\s+url=/(?:conversations|tbo/by-thread)/).*?(${UUID})`,
  'i',
);

const SKIP_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const MAX_LOG_TAIL_BYTES = 512 * 1024;
const DAY_MS = 86_400_000;

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

const pad = (n) => String(n).padStart(2, '0');
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function recentDayKeys(nowMs, activeMs) {
  const span = Number.isFinite(activeMs) ? Math.min(activeMs + DAY_MS, 7 * DAY_MS) : 2 * DAY_MS;
  const out = new Set();
  for (let t = nowMs - span; t <= nowMs + DAY_MS / 2; t += DAY_MS / 2) out.add(dayKey(t));
  out.add(dayKey(nowMs));
  return [...out].sort();
}

export function defaultCodexDesktopDirs(homedir = os.homedir()) {
  return {
    codexRoot: path.join(homedir, '.codex'),
    logsRoot: path.join(homedir, 'Library', 'Logs', 'com.openai.codex'),
    classicRoot: path.join(homedir, 'Library', 'Application Support', 'com.openai.chat'),
  };
}

export function parseCodexDesktopCloudLine(line) {
  if (typeof line !== 'string' || !line.includes('conversationId=')) return null;
  for (const { kind, re } of CLOUD_EVENT_PATTERNS) {
    const m = re.exec(line);
    if (m) {
      const uuid = m[1].toLowerCase();
      const tsMatch = LOG_TS_RE.exec(line.trim());
      const ts = tsMatch ? tsMatch[1] : null;
      const ms = ts ? Date.parse(ts) : NaN;
      return { kind, uuid, ts, ms: Number.isFinite(ms) ? ms : null };
    }
  }
  return null;
}

async function readTailText(filePath, size, maxBytes = MAX_LOG_TAIL_BYTES) {
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) return '';
  let fh;
  try {
    fh = await fsp.open(filePath, FS.O_RDONLY | (FS.O_NONBLOCK ?? 0));
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function scanDesktopLogs(logsRoot, { minMtime, nowMs, activeMs, seenUuids }) {
  if (typeof logsRoot !== 'string' || logsRoot === '') return [];
  const rootStat = await lstatOrNull(logsRoot);
  if (!rootStat || !rootStat.isDirectory()) return [];

  const keys = recentDayKeys(nowMs, activeMs);
  const byUuid = new Map(); // uuid -> { uuid, logPath, st, eventMs, count, lastKind }
  const deadUuids = new Set();
  for (const key of keys) {
    const dayDir = path.join(logsRoot, ...key.split('/'));
    const entries = await listDir(dayDir);
    if (!entries) continue;
    for (const d of entries) {
      if (!d.isFile() || !DESKTOP_LOG_RE.test(d.name)) continue;
      const logPath = path.join(dayDir, d.name);
      const st = await lstatOrNull(logPath);
      if (!st || !st.isFile() || st.mtimeMs < minMtime) continue;
      const text = await readTailText(logPath, st.size);
      if (!text) continue;
      for (const line of text.split('\n')) {
        const deadMatch = DEAD_CONV_RE.exec(line);
        if (deadMatch) {
          const deadId = deadMatch[1].toLowerCase();
          byUuid.delete(deadId);
          deadUuids.add(deadId);
          continue;
        }
        const ev = parseCodexDesktopCloudLine(line);
        if (!ev || seenUuids.has(ev.uuid) || deadUuids.has(ev.uuid)) continue;
        const eventMs = ev.ms ?? st.mtimeMs;
        const prev = byUuid.get(ev.uuid);
        if (!prev || eventMs >= prev.eventMs) {
          byUuid.set(ev.uuid, {
            uuid: ev.uuid,
            logPath,
            st,
            eventMs,
            count: (prev?.count ?? 0) + 1,
            lastKind: ev.kind,
          });
        }
      }
    }
  }

  const out = [];
  for (const item of byUuid.values()) {
    if (item.eventMs < minMtime) continue;
    seenUuids.add(item.uuid);
    const charId = `${CODEX_AGENT}-${item.uuid}`;
    out.push({
      path: path.join(path.dirname(item.logPath), `cloud-${item.uuid}.jsonl`),
      agent: CODEX_AGENT,
      kind: 'main',
      charId,
      stem: charId,
      sessionId: item.uuid,
      sid: charId,
      mtimeMs: item.eventMs,
      size: item.st.size,
      ino: item.st.ino,
      facts: {
        desktopKind: 'codex-cloud-log',
        surface: 'app',
        threadId: item.uuid,
        logPath: item.logPath,
        cwd: CHATGPT_DESKTOP_CWD,
        branch: null,
        cliVersion: null,
        historyStart: null,
        agentType: null,
      },
    });
  }
  return out;
}

async function scanClassicData(classicRoot, { minMtime, seenUuids }) {
  if (typeof classicRoot !== 'string' || classicRoot === '') return [];
  const entries = await listDir(classicRoot);
  if (!entries) return [];
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || !d.name.startsWith('conversations-v3-')) continue;
    const convDir = path.join(classicRoot, d.name);
    const files = await listDir(convDir);
    if (!files) continue;
    for (const f of files) {
      if (!f.isFile()) continue;
      const m = CLASSIC_DATA_RE.exec(f.name);
      if (!m) continue;
      const uuid = m[1].toLowerCase();
      if (seenUuids.has(uuid)) continue;
      const dataPath = path.join(convDir, f.name);
      const st = await lstatOrNull(dataPath);
      if (!st || !st.isFile() || st.mtimeMs < minMtime) continue;
      seenUuids.add(uuid);
      const charId = `${CODEX_AGENT}-${uuid}`;
      out.push({
        path: dataPath,
        agent: CODEX_AGENT,
        kind: 'main',
        charId,
        stem: charId,
        sessionId: uuid,
        sid: charId,
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        facts: {
          desktopKind: 'chatgpt-classic-data',
          surface: 'app',
          threadId: uuid,
          dataPath,
          cwd: CHATGPT_CLASSIC_CWD,
          branch: null,
          cliVersion: null,
          historyStart: null,
          agentType: null,
        },
      });
    }
  }
  return out;
}

/**
 * Scan ChatGPT Desktop cloud logs and ChatGPT Classic .data files for active conversations not in `localRefs`.
 * Only runs when `root` matches `~/.codex` or when `logsRoot` / `classicRoot` is explicitly passed.
 */
export async function scanCodexDesktopCloud(root, {
  activeMs = Infinity, nowMs = Date.now(), localRefs = [], logsRoot, classicRoot,
} = {}) {
  const defs = defaultCodexDesktopDirs();
  const explicit = logsRoot !== undefined || classicRoot !== undefined;
  if (!explicit && path.resolve(root) !== path.resolve(defs.codexRoot)) return [];
  const lRoot = logsRoot !== undefined ? logsRoot : defs.logsRoot;
  const cRoot = classicRoot !== undefined ? classicRoot : defs.classicRoot;
  const minMtime = Number.isFinite(activeMs) ? nowMs - activeMs : -Infinity;
  const seenUuids = new Set(localRefs.map((r) => String(r.sessionId || '').toLowerCase()).filter(Boolean));

  const desktopRefs = await scanDesktopLogs(lRoot, { minMtime, nowMs, activeMs, seenUuids });
  const classicRefs = await scanClassicData(cRoot, { minMtime, seenUuids });
  const all = [...desktopRefs, ...classicRefs];
  for (const ref of all) {
    Object.defineProperties(ref.facts, {
      readAll: { value: (r, onLine, o) => defaultCodexTailer.readAll(r, onLine, o) },
      poll: { value: (r, onLine) => defaultCodexTailer.poll(r, onLine) },
      forget: { value: (p) => defaultCodexTailer.forget(p) },
    });
  }
  return all;
}

export class CodexDesktopTailer {
  #inner;
  #cloud = new Map(); // ref.path -> { kind, threadId, filePath, offset, carry, mtimeMs, size, ord, turnSeq }

  constructor(opts = {}) {
    this.#inner = new Tailer(opts);
  }

  get skippedLines() {
    return this.#inner.skippedLines;
  }

  #isCloud(ref) {
    const k = ref?.facts?.desktopKind;
    return k === 'codex-cloud-log' || k === 'chatgpt-classic-data';
  }

  async #emitMeta(state, ts, cwd, onLine) {
    const rec = {
      timestamp: ts,
      ordinal: state.ord++,
      type: 'session_meta',
      payload: {
        id: state.threadId,
        cwd,
        originator: 'Codex Desktop',
      },
    };
    await onLine(JSON.stringify(rec));
  }

  async #emitTurn(state, ts, title, complete, onLine) {
    const turnId = `cloud-turn-${++state.turnSeq}`;
    await onLine(JSON.stringify({
      timestamp: ts,
      ordinal: state.ord++,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId },
    }));
    await onLine(JSON.stringify({
      timestamp: ts,
      ordinal: state.ord++,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text: title }] },
      },
    }));
    await onLine(JSON.stringify({
      timestamp: ts,
      ordinal: state.ord++,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: `Active in ${title}` }],
      },
    }));
    if (complete) {
      await onLine(JSON.stringify({
        timestamp: ts,
        ordinal: state.ord++,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId },
      }));
    }
  }

  async readAll(ref, onLine, opts) {
    if (!this.#isCloud(ref)) return this.#inner.readAll(ref, onLine, opts);
    const kind = ref.facts.desktopKind;
    const filePath = kind === 'codex-cloud-log' ? ref.facts.logPath : ref.facts.dataPath;
    const st = await lstatOrNull(filePath);
    if (!st || !st.isFile()) return { offset: 0, skipped: 0, gone: true };
    const ts = new Date(ref.mtimeMs || st.mtimeMs).toISOString();
    const state = {
      kind,
      threadId: ref.facts.threadId ?? ref.sessionId,
      filePath,
      offset: st.size,
      carry: '',
      mtimeMs: st.mtimeMs,
      size: st.size,
      ord: 0,
      turnSeq: 0,
    };
    this.#cloud.set(ref.path, state);
    const isClassic = kind === 'chatgpt-classic-data';
    const cwd = isClassic ? CHATGPT_CLASSIC_CWD : CHATGPT_DESKTOP_CWD;
    const title = isClassic ? CHATGPT_CLASSIC_TITLE : CHATGPT_DESKTOP_TITLE;
    await this.#emitMeta(state, ts, cwd, onLine);
    await this.#emitTurn(state, ts, title, false, onLine);
    return { offset: st.size, skipped: 0 };
  }

  async poll(ref, onLine) {
    if (!this.#isCloud(ref)) return this.#inner.poll(ref, onLine);
    const state = this.#cloud.get(ref.path);
    if (!state) return { reset: true };
    const st = await lstatOrNull(state.filePath);
    if (!st || !st.isFile()) return { gone: true };

    if (state.kind === 'chatgpt-classic-data') {
      if (st.mtimeMs === state.mtimeMs && st.size === state.size) return { bytes: 0, skipped: 0 };
      state.mtimeMs = st.mtimeMs;
      state.size = st.size;
      const ts = new Date(st.mtimeMs).toISOString();
      await this.#emitTurn(state, ts, CHATGPT_CLASSIC_TITLE, false, onLine);
      return { bytes: 1, skipped: 0 };
    }

    // codex-cloud-log: read appended bytes from the desktop log and filter for this conversation's uuid.
    if (st.size < state.offset) {
      state.offset = Math.max(0, st.size - MAX_LOG_TAIL_BYTES);
      state.carry = '';
    }
    if (st.size === state.offset) return { bytes: 0, skipped: 0 };
    const start = Math.max(state.offset, st.size - MAX_LOG_TAIL_BYTES);
    const len = st.size - start;
    let fh;
    try {
      fh = await fsp.open(state.filePath, FS.O_RDONLY | (FS.O_NONBLOCK ?? 0));
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      state.offset = start + bytesRead;
      const chunk = state.carry + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      state.carry = lines.pop() ?? '';
      let matched = false;
      let completed = false;
      let latestTs = new Date(st.mtimeMs).toISOString();
      for (const line of lines) {
        const ev = parseCodexDesktopCloudLine(line);
        if (!ev || ev.uuid !== state.threadId) continue;
        matched = true;
        if (ev.ts) latestTs = ev.ts;
        if (ev.kind === 'complete') completed = true;
      }
      if (matched) {
        await this.#emitTurn(state, latestTs, CHATGPT_DESKTOP_TITLE, completed, onLine);
        return { bytes: 1, skipped: 0 };
      }
      return { bytes: 0, skipped: 0 };
    } catch {
      return { bytes: 0, skipped: 0 };
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  rename(from, to, meta) {
    if (this.#cloud.has(from)) return false;
    return this.#inner.rename(from, to, meta);
  }

  isBusy(p) {
    return this.#inner.isBusy(p);
  }

  forget(p) {
    this.#cloud.delete(p);
    this.#inner.forget(p);
  }

  offsetOf(p) {
    return this.#inner.offsetOf(p);
  }

  pendingBytes(p) {
    return this.#inner.pendingBytes(p);
  }

  skippedOf(p) {
    return this.#inner.skippedOf(p);
  }
}

const defaultCodexTailer = new CodexDesktopTailer();
