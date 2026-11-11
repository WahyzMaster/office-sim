// Allowlist-only discovery and dual-format tailer (`.jsonl` + rewritten `ConversationRecord` `.json`)
// for the optional `gemini-cli` plug-in adapter (`<root>/<projectDir>/chats/session-*.json[l]`).
// Never opens `oauth_creds.json`, `google_accounts.json`, `settings.json`, `logs.json`, `antigravity*`, symlinks, or FIFOs.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Tailer } from '../../tailer.mjs';

export const GEMINI_CLI_AGENT = 'gemini-cli';
export const SCAN_LIMITS = Object.freeze({ projects: 10_000, sessions: 50_000, maxJsonBytes: 16 * 1024 * 1024 });

const SKIP_ERRS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const GONE_ERRS = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EMLINK']);
const SKIP_DIRS = new Set([
  'antigravity', 'antigravity-cli', 'antigravity-ide', 'bin', 'cache', 'config',
  'extensions', 'history', 'memory', 'policies', 'sandbox', 'skills',
]);
const SESSION_FILE_RE = /^session-([A-Za-z0-9_.:-]+)\.(jsonl|json)$/;
const SAFE_ID_CHAR_RE = /[^A-Za-z0-9_-]/g;
const TERMINAL_TOOL_STATUS = new Set(['success', 'ok', 'completed', 'error', 'failed', 'cancelled', 'denied', 'interrupted']);
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);

const capped = (what) => Object.assign(new Error(`gemini-cli scan cap reached (${what})`), { code: 'SCAN_CAPPED' });

export function sanitizeSessionSuffix(raw) {
  const cleaned = String(raw || '').replace(SAFE_ID_CHAR_RE, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return cleaned || 'session';
}

export const charIdOf = (rawId) => `${GEMINI_CLI_AGENT}-${sanitizeSessionSuffix(rawId)}`;

async function lstatIf(p, kind) {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return null;
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
  } catch (err) {
    if (SKIP_ERRS.has(err?.code)) return null;
    throw err;
  }
}

async function readSafeSmallText(filePath, expectedStat, maxBytes = 1024) {
  let fh = null;
  try {
    fh = await fsp.open(filePath, OPEN_FLAGS);
    const now = await fh.stat();
    if (!now.isFile() || now.ino !== expectedStat.ino || now.dev !== expectedStat.dev || now.size > maxBytes) return null;
    const buf = Buffer.alloc(now.size);
    const { bytesRead } = await fh.read(buf, 0, now.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8').trim() || null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function resolveScanBase(root) {
  const rootSt = await lstatIf(root, 'dir');
  if (!rootSt) return null;
  if (path.basename(root) !== 'tmp') {
    const tmpSub = path.join(root, 'tmp');
    if (await lstatIf(tmpSub, 'dir')) return tmpSub;
  }
  return root;
}

export function createGeminiCliScanner({ limits = SCAN_LIMITS } = {}) {
  const projectCwds = new Map();
  return async function scan(root, { activeMs, nowMs } = {}) {
    const base = await resolveScanBase(root);
    if (!base) return [];
    const windowed = Number.isFinite(activeMs) && Number.isFinite(nowMs);
    const entries = await fsp.readdir(base, { withFileTypes: true });
    let projBudget = limits.projects;
    let sessBudget = limits.sessions;
    const byStem = new Map();

    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      if (projBudget-- <= 0) throw capped('projects');
      const projDir = path.join(base, d.name);
      if (!(await lstatIf(projDir, 'dir'))) continue;
      const chatsDir = path.join(projDir, 'chats');
      if (!(await lstatIf(chatsDir, 'dir'))) continue;

      let cwd = projectCwds.get(projDir) ?? null;
      if (cwd === null) {
        const markerPath = path.join(projDir, '.project_root');
        const markerSt = await lstatIf(markerPath, 'file');
        if (markerSt) {
          cwd = await readSafeSmallText(markerPath, markerSt, 1024);
          if (cwd) projectCwds.set(projDir, cwd);
        }
      }

      const chatFiles = await fsp.readdir(chatsDir, { withFileTypes: true });
      for (const cf of chatFiles) {
        if (!cf.isFile()) continue;
        const m = SESSION_FILE_RE.exec(cf.name);
        if (!m) continue;
        if (sessBudget-- <= 0) throw capped('sessions');
        const [, rawStem, ext] = m;
        const fullPath = path.join(chatsDir, cf.name);
        const st = await lstatIf(fullPath, 'file');
        if (!st) continue;
        if (windowed && st.mtimeMs < nowMs - activeMs) continue;
        const key = `${d.name}/${rawStem}`;
        const prev = byStem.get(key);
        // Prefer append-only `.jsonl` when both `.jsonl` and `.json` exist for the same session stem.
        if (prev && (prev.ext === 'jsonl' && ext !== 'jsonl')) continue;
        byStem.set(key, { rawStem, ext, fullPath, st, cwd, projectHash: d.name });
      }
    }

    const refs = [];
    for (const key of [...byStem.keys()].sort()) {
      const item = byStem.get(key);
      const charId = charIdOf(item.rawStem);
      refs.push({
        path: item.fullPath,
        agent: GEMINI_CLI_AGENT,
        kind: 'main',
        charId,
        stem: charId,
        sessionId: sanitizeSessionSuffix(item.rawStem),
        sid: charId,
        mtimeMs: item.st.mtimeMs,
        size: item.st.size,
        ino: item.st.ino,
        facts: { format: item.ext, cwd: item.cwd, projectHash: item.projectHash },
      });
    }
    return refs;
  };
}

export async function scanGeminiCli(root, opts = {}) {
  return createGeminiCliScanner(opts)(root, opts);
}

/**
 * Dual-mode tailer:
 * - `.jsonl` files use the shared `Tailer` with `noFollow: true`.
 * - `.json` (`ConversationRecord`) files read via `O_NOFOLLOW` + inode verification and emit incremental step lines.
 */
export class GeminiCliTailer {
  constructor(opts = {}) {
    this.jsonl = new Tailer({ ...opts, noFollow: true });
    this.maxJsonBytes = opts.maxJsonBytes ?? SCAN_LIMITS.maxJsonBytes;
    this.jsonMemo = new Map(); // path -> { ino, dev, msgCount, tools: Map<id, boolean>, metaSent: boolean }
    this.busy = new Set();
  }

  get skippedLines() { return this.jsonl.skippedLines; }

  isBusy(p) { return this.busy.has(p) || this.jsonl.isBusy(p); }

  forget(p) {
    this.jsonMemo.delete(p);
    this.jsonl.forget(p);
  }

  rename(from, to, meta) {
    if (this.jsonMemo.has(from)) {
      const v = this.jsonMemo.get(from);
      this.jsonMemo.delete(from);
      this.jsonMemo.set(to, v);
      return true;
    }
    return this.jsonl.rename(from, to, meta);
  }

  async readAll(ref, onLine, opts) {
    if (!ref.path.endsWith('.json')) return this.jsonl.readAll(ref, onLine, opts);
    this.jsonMemo.delete(ref.path);
    return this._readJson(ref, onLine, true);
  }

  async poll(ref, onLine) {
    if (!ref.path.endsWith('.json')) return this.jsonl.poll(ref, onLine);
    return this._readJson(ref, onLine, false);
  }

  async _readJson(ref, onLine, initial) {
    this.busy.add(ref.path);
    let fh = null;
    try {
      fh = await fsp.open(ref.path, OPEN_FLAGS);
      const st = await fh.stat();
      if (!st.isFile()) return { bytes: 0, gone: true };
      let memo = this.jsonMemo.get(ref.path);
      if (initial) {
        if (ref.ino !== undefined && st.ino !== ref.ino) return { bytes: 0, gone: true };
      } else {
        if (!memo && ref.ino !== undefined && st.ino !== ref.ino) {
          return { bytes: 0, reset: true };
        }
        if (
          memo && st.ino === memo.ino && st.dev === memo.dev
          && st.size === memo.size && st.mtimeMs === memo.mtimeMs && st.ctimeMs === memo.ctimeMs
          && Date.now() - st.mtimeMs > 1000
        ) {
          return { bytes: 0 };
        }
      }
      if (st.size > this.maxJsonBytes) return { bytes: 0 };
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      const raw = buf.subarray(0, bytesRead).toString('utf8');
      if (!raw.trim()) return { bytes: 0 };
      let doc;
      try {
        doc = JSON.parse(raw);
      } catch {
        // Rewritten JSON caught mid-write: wait for the next poll without resetting session state.
        return { bytes: 0 };
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { bytes: 0 };
      const messages = Array.isArray(doc.messages) ? doc.messages : [];
      const docSid = typeof doc.sessionId === 'string' && doc.sessionId ? doc.sessionId : null;
      if (!memo) {
        memo = { ino: st.ino, dev: st.dev, docSid, size: 0, mtimeMs: 0, ctimeMs: 0, msgCount: 0, tools: new Map(), metaSent: false };
        this.jsonMemo.set(ref.path, memo);
      } else if (!initial && (messages.length < memo.msgCount || (memo.docSid && docSid && docSid !== memo.docSid))) {
        this.jsonMemo.delete(ref.path);
        return { bytes: 0, reset: true };
      }
      if (!memo.metaSent && (doc.cwd || doc.branch || doc.title || doc.summary)) {
        memo.metaSent = true;
        onLine(JSON.stringify({
          type: 'session_metadata',
          cwd: doc.cwd ?? null,
          branch: doc.branch ?? null,
          title: doc.title ?? doc.summary ?? null,
          timestamp: doc.startTime ?? doc.lastUpdated ?? null,
        }));
      }
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        if (i >= memo.msgCount) {
          onLine(JSON.stringify(msg));
          if (Array.isArray(msg.toolCalls)) {
            for (const tc of msg.toolCalls) {
              if (tc?.id) memo.tools.set(tc.id, TERMINAL_TOOL_STATUS.has(String(tc.status || '').toLowerCase()));
            }
          }
        } else if (Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            if (!tc?.id) continue;
            const term = TERMINAL_TOOL_STATUS.has(String(tc.status || '').toLowerCase());
            const wasTerm = memo.tools.get(tc.id);
            if (wasTerm === undefined) {
              memo.tools.set(tc.id, term);
              onLine(JSON.stringify({ type: 'gemini', timestamp: msg.timestamp, toolCalls: [tc] }));
            } else if (!wasTerm && term) {
              memo.tools.set(tc.id, true);
              onLine(JSON.stringify({
                type: 'tool_result', id: tc.id, status: tc.status, timestamp: tc.timestamp ?? doc.lastUpdated ?? msg.timestamp,
                error: tc.error ?? (String(tc.status).toLowerCase() === 'error' ? tc.resultDisplay : undefined),
              }));
            }
          }
        }
      }
      memo.ino = st.ino;
      memo.dev = st.dev;
      if (docSid) memo.docSid = docSid;
      memo.size = st.size;
      memo.mtimeMs = st.mtimeMs;
      memo.ctimeMs = st.ctimeMs;
      memo.msgCount = messages.length;
      if (ref.ino !== undefined) ref.ino = st.ino;
      return { bytes: bytesRead };
    } catch (err) {
      if (GONE_ERRS.has(err?.code)) return { bytes: 0, gone: true };
      throw err;
    } finally {
      this.busy.delete(ref.path);
      await fh?.close().catch(() => {});
    }
  }
}
