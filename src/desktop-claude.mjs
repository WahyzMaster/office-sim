// Lightweight passive watcher for Claude Desktop (macOS /Applications/Claude.app) Cloud Chat & Cowork tabs.
// Zero LLM token usage: only stats IndexedDB (https_claude.ai_0) + tails ~/Library/Logs/Claude/mcp.log.
import crypto from 'node:crypto';
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_CLOUD_SESSION_ID = 'claude-desktop-cloud';
export const CLAUDE_CLOUD_CWD = '/Claude Desktop';
export const CLAUDE_CLOUD_TITLE = 'Claude Desktop Chat';

const SKIP_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);
const MAX_MCP_READ_BYTES = 128 * 1024;
const MAX_OPEN_TOOLS = 1024;
const MCP_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[info\]\s+\[([^\]]+)\]\s+Message from (client|server):\s+(.*)$/;
// The two non-JSON summary forms the log also has (test/desktop-cloud-chats.test.mjs): a client line that is exactly
// `method="tools/call" [id=<n>] ...` and a server line `id=<n> result|error`. Neither carries a name.
const SUMMARY_CALL_RE = /^method="tools\/call"(?:\s+id=(\d{1,20}|"[^"]{1,64}"))?(?:\s|$)/;
const SUMMARY_ID_RE = /\bid=(\d{1,20}|"[^"]{1,64}")/;
/** The only shape of an MCP server or tool name that may leave this module (launch readiness D20). */
export const MCP_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** What stands in for a server or tool name that does not have that shape, or that the line does not give. */
export const GENERIC_SERVER = 'mcp';
export const GENERIC_TOOL = 'call';

function isSkippable(err) {
  return Boolean(err && SKIP_CODES.has(err.code));
}

async function statOrNull(fsApi, p) {
  try {
    return await (fsApi.lstat ?? fsApi.stat).call(fsApi, p);
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

async function listDir(fsApi, dir) {
  try {
    return await fsApi.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

export function defaultClaudeDesktopDirs(homedir = os.homedir()) {
  return {
    projectsRoot: path.join(homedir, '.claude', 'projects'),
    appSupportDir: path.join(homedir, 'Library', 'Application Support', 'Claude'),
    logsDir: path.join(homedir, 'Library', 'Logs', 'Claude'),
  };
}

// Compute the latest activity timestamp and signature across Claude.ai IndexedDB leveldb/blob and mcp.log.
export async function computeClaudeCloudActivity(fsApi, { appSupportDir, logsDir }) {
  let maxMtime = 0;
  let totalSize = 0;
  let count = 0;
  let newestPath = null;
  let newestStat = null;

  const recordStat = (p, st) => {
    if (!st || !st.isFile()) return;
    count += 1;
    totalSize += st.size;
    if (st.mtimeMs >= maxMtime) {
      maxMtime = st.mtimeMs;
      newestPath = p;
      newestStat = st;
    }
  };

  if (typeof appSupportDir === 'string' && appSupportDir !== '') {
    const idbLevelDir = path.join(appSupportDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
    const idbEntries = await listDir(fsApi, idbLevelDir);
    if (idbEntries) {
      for (const d of idbEntries) {
        if (!d.isDirectory() && (d.name.endsWith('.log') || d.name.endsWith('.ldb') || d.name.startsWith('MANIFEST'))) {
          const full = path.join(idbLevelDir, d.name);
          recordStat(full, await statOrNull(fsApi, full));
        }
      }
    }
    for (const sub of ['1', '3']) {
      const blobBase = path.join(appSupportDir, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob', sub);
      const folders = await listDir(fsApi, blobBase);
      if (!folders) continue;
      for (const f of folders) {
        if (!f.isDirectory() || f.name.startsWith('.')) continue;
        const folderPath = path.join(blobBase, f.name);
        const blobs = await listDir(fsApi, folderPath);
        if (!blobs) continue;
        for (const b of blobs) {
          if (b.isDirectory() || b.name.startsWith('.')) continue;
          const full = path.join(folderPath, b.name);
          recordStat(full, await statOrNull(fsApi, full));
        }
      }
    }
  }

  let mcpStat = null;
  let mainStat = null;
  if (typeof logsDir === 'string' && logsDir !== '') {
    const mcpPath = path.join(logsDir, 'mcp.log');
    mcpStat = await statOrNull(fsApi, mcpPath);
    recordStat(mcpPath, mcpStat);
    mainStat = await statOrNull(fsApi, path.join(logsDir, 'main.log'));
  }

  if (count === 0 || maxMtime <= 0) return null;
  const anchorPath = mainStat?.isFile()
    ? path.join(logsDir, 'main.log')
    : mcpStat?.isFile()
      ? path.join(logsDir, 'mcp.log')
      : newestPath;
  const anchorStat = mainStat?.isFile() ? mainStat : (mcpStat?.isFile() ? mcpStat : newestStat);
  return {
    anchorPath,
    anchorIno: anchorStat?.ino ?? 0,
    mtimeMs: maxMtime,
    size: totalSize,
    mcpSize: mcpStat?.size ?? 0,
    sig: `${count}:${totalSize}:${Math.floor(maxMtime)}`,
  };
}

/**
 * Return a synthetic FileRef for Claude Desktop Cloud Chat if active within `activeMs`.
 * Only runs when `root` matches `~/.claude/projects` or when `appSupportDir`/`logsDir` is explicitly provided.
 */
export async function scanClaudeDesktopCloud(root, { activeMs = Infinity, nowMs = Date.now(), fs: fsApi = fsp, appSupportDir, logsDir } = {}) {
  const defs = defaultClaudeDesktopDirs();
  const explicit = appSupportDir !== undefined || logsDir !== undefined;
  if (!explicit && path.resolve(root) !== path.resolve(defs.projectsRoot)) return [];
  const support = appSupportDir !== undefined ? appSupportDir : defs.appSupportDir;
  const logs = logsDir !== undefined ? logsDir : defs.logsDir;
  const act = await computeClaudeCloudActivity(fsApi, { appSupportDir: support, logsDir: logs });
  if (!act) return [];
  const minMtime = Number.isFinite(activeMs) ? nowMs - activeMs : -Infinity;
  if (act.mtimeMs < minMtime) return [];
  const facts = {
    desktopKind: 'claude-cloud',
    appSupportDir: support,
    logsDir: logs,
    sig: act.sig,
  };
  Object.defineProperties(facts, {
    readAll: { value: (r, onLine, o) => defaultClaudeTailer.readAll(r, onLine, o) },
    poll: { value: (r, onLine) => defaultClaudeTailer.poll(r, onLine) },
    forget: { value: (p) => defaultClaudeTailer.forget(p) },
  });
  return [{
    path: act.anchorPath,
    kind: 'main',
    stem: CLAUDE_CLOUD_SESSION_ID,
    sessionId: CLAUDE_CLOUD_SESSION_ID,
    agentId: null,
    runId: null,
    projectDir: support || logs,
    mtimeMs: act.mtimeMs,
    size: act.size,
    ino: act.anchorIno,
    facts,
  }];
}

// One part of `mcp__<server>__<tool>`: a name of the allowed shape with every run of other characters as `_`, else the label.
function idPart(name, generic) {
  if (typeof name !== 'string' || !MCP_NAME_RE.test(name)) return generic;
  return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || generic;
}

// The JSON-RPC message at the start of `rest`: the whole text, or its first complete `{...}` when the app wrote more
// after it. Null when `rest` does not start with `{`, is cut off, or does not parse as an object.
function leadingJsonObject(rest) {
  if (rest[0] !== '{') return null;
  const parse = (text) => {
    try {
      const v = JSON.parse(text);
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  let depth = 0;
  let inString = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if ((c === '}' || c === ']') && --depth === 0) return parse(rest.slice(0, i + 1));
  }
  return null;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// A JSON-RPC id as text: a string or a finite number, else null.
const idText = (id) => (typeof id === 'string' ? id : typeof id === 'number' && Number.isFinite(id) ? String(id) : null);
const unquote = (s) => s.replace(/^"|"$/g, '');
// The in-memory name of an open call. A server name or id of the allowed shape is used as it is; any other text is
// kept only as a digest, so two servers that share the generic label never close each other's calls and no free
// text of the log stays in memory.
const keyPart = (text) => (MCP_NAME_RE.test(text) ? text : `#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`);

// parseMcpLogLine plus `key` (the open-call key). D20: a tool name comes only from `params.name` of a JSON-parsed
// client request whose method is exactly tools/call; `params.arguments` is never read; names that do not match
// MCP_NAME_RE, server names included, become the generic label.
function parseMcpLine(line) {
  const m = typeof line === 'string' ? MCP_LINE_RE.exec(line.trim()) : null;
  if (!m) return null;
  const [, ts, rawServer, role, rest] = m;
  const server = MCP_NAME_RE.test(rawServer) ? rawServer : GENERIC_SERVER;
  // reqId leaves this function in the same form as in the key: an id of the allowed shape, else its digest
  const out = (fields, reqId) => ({ ...fields, reqId: keyPart(reqId), key: `${keyPart(rawServer)}:${keyPart(reqId)}` });
  const msg = leadingJsonObject(rest);
  if (role === 'client') {
    let reqId;
    let tool = GENERIC_TOOL;
    if (msg) {
      if (msg.method !== 'tools/call') return null;
      reqId = idText(msg.id) ?? '0';
      const params = msg.params;
      if (params !== null && typeof params === 'object' && !Array.isArray(params) && own(params, 'name')) tool = params.name;
    } else {
      const summary = rest[0] === '{' ? null : SUMMARY_CALL_RE.exec(rest);
      if (!summary) return null;
      reqId = summary[1] ? unquote(summary[1]) : '0';
    }
    const toolName = `mcp__${idPart(server, GENERIC_SERVER)}__${idPart(tool, GENERIC_TOOL)}`;
    return out({ kind: 'call', ts, server, reqId, toolName }, reqId);
  }
  if (msg) {
    const reqId = own(msg, 'method') ? null : idText(msg.id);
    if (reqId === null || !(own(msg, 'result') || own(msg, 'error'))) return null;
    return out({ kind: 'result', ts, server, reqId, isError: !own(msg, 'result') }, reqId);
  }
  if (rest[0] === '{') return null;
  const idMatch = SUMMARY_ID_RE.exec(rest);
  if (!idMatch || !(rest.includes('result') || rest.includes('error'))) return null;
  const reqId = unquote(idMatch[1]);
  return out({ kind: 'result', ts, server, reqId, isError: rest.includes('error') && !rest.includes('result') }, reqId);
}

/**
 * One mcp.log line -> `{ kind: 'call', ts, server, reqId, toolName }`, `{ kind: 'result', ts, server, reqId, isError }`
 * or null. `server` and `toolName` hold only names of the MCP_NAME_RE shape or the generic labels (D20); `reqId` is
 * the JSON-RPC id when it has that shape, else `#` and 16 hex digits of its digest (no free text of the log).
 */
export function parseMcpLogLine(line) {
  const parsed = parseMcpLine(line);
  if (!parsed) return null;
  const { key: _key, ...pub } = parsed;
  return pub;
}

export class ClaudeDesktopTailer {
  #cloud = new Map(); // path -> { sig, mcpOffset, mcpCarry, seq, openTools: Map<parseMcpLine key, toolUseId> }

  async #emitTurn(state, ts, text, onLine) {
    const seq = ++state.seq;
    const promptRec = {
      type: 'user',
      uuid: `claude-cloud-u-${seq}`,
      promptId: `claude-cloud-p-${seq}`,
      sessionId: CLAUDE_CLOUD_SESSION_ID,
      entrypoint: 'claude-desktop',
      cwd: CLAUDE_CLOUD_CWD,
      timestamp: ts,
      origin: { kind: 'human' },
      message: { role: 'user', content: text },
    };
    const asstRec = {
      type: 'assistant',
      uuid: `claude-cloud-a-${seq}`,
      sessionId: CLAUDE_CLOUD_SESSION_ID,
      entrypoint: 'claude-desktop',
      cwd: CLAUDE_CLOUD_CWD,
      timestamp: ts,
      message: {
        id: `claude-cloud-m-${seq}`,
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Active in Claude Desktop' }],
      },
    };
    await onLine(JSON.stringify(promptRec));
    await onLine(JSON.stringify(asstRec));
  }

  async #readMcpDelta(mcpPath, state, onLine) {
    if (!mcpPath) return 0;
    const st = await statOrNull(fsp, mcpPath);
    if (!st || !st.isFile()) return 0;
    if (st.size < state.mcpOffset) {
      state.mcpOffset = Math.max(0, st.size - MAX_MCP_READ_BYTES);
      state.mcpCarry = '';
    }
    if (st.size === state.mcpOffset) return 0;
    const start = Math.max(state.mcpOffset, st.size - MAX_MCP_READ_BYTES);
    const len = st.size - start;
    let fh;
    try {
      fh = await fsp.open(mcpPath, OPEN_FLAGS);
      const fst = await fh.stat();
      if (!fst.isFile() || fst.ino !== st.ino) return 0;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      state.mcpOffset = start + bytesRead;
      const chunk = state.mcpCarry + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      state.mcpCarry = lines.pop() ?? '';
      let emitted = 0;
      for (const line of lines) {
        const parsed = parseMcpLine(line);
        if (!parsed) continue;
        const { key } = parsed;
        if (parsed.kind === 'call') {
          const seq = ++state.seq;
          const toolUseId = `claude-cloud-tu-${seq}`;
          if (!state.openTools.has(key) && state.openTools.size >= MAX_OPEN_TOOLS) {
            state.openTools.delete(state.openTools.keys().next().value);
          }
          state.openTools.set(key, toolUseId);
          await onLine(JSON.stringify({
            type: 'assistant',
            uuid: `claude-cloud-tc-${seq}`,
            sessionId: CLAUDE_CLOUD_SESSION_ID,
            entrypoint: 'claude-desktop',
            cwd: CLAUDE_CLOUD_CWD,
            timestamp: parsed.ts,
            message: {
              id: `claude-cloud-tm-${seq}`,
              role: 'assistant',
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: toolUseId, name: parsed.toolName, input: {} }],
            },
          }));
          emitted += 1;
        } else if (parsed.kind === 'result') {
          const toolUseId = state.openTools.get(key);
          if (!toolUseId) continue;
          state.openTools.delete(key);
          const seq = ++state.seq;
          await onLine(JSON.stringify({
            type: 'user',
            uuid: `claude-cloud-tr-${seq}`,
            sessionId: CLAUDE_CLOUD_SESSION_ID,
            entrypoint: 'claude-desktop',
            cwd: CLAUDE_CLOUD_CWD,
            timestamp: parsed.ts,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: parsed.isError, content: 'ok' }],
            },
          }));
          await onLine(JSON.stringify({
            type: 'assistant',
            uuid: `claude-cloud-te-${seq}`,
            sessionId: CLAUDE_CLOUD_SESSION_ID,
            entrypoint: 'claude-desktop',
            cwd: CLAUDE_CLOUD_CWD,
            timestamp: parsed.ts,
            message: {
              id: `claude-cloud-tem-${seq}`,
              role: 'assistant',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: `Completed ${parsed.server}` }],
            },
          }));
          emitted += 1;
        }
      }
      return emitted;
    } catch {
      return 0;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  async readAll(ref, onLine) {
    const act = await computeClaudeCloudActivity(fsp, ref.facts ?? {});
    if (!act) return { offset: 0, skipped: 0, gone: true };
    const ts = new Date(act.mtimeMs).toISOString();
    const state = {
      sig: act.sig,
      mcpOffset: act.mcpSize,
      mcpCarry: '',
      seq: 0,
      openTools: new Map(),
    };
    this.#cloud.set(ref.path, state);
    await onLine(JSON.stringify({
      type: 'custom-title',
      customTitle: CLAUDE_CLOUD_TITLE,
      sessionId: CLAUDE_CLOUD_SESSION_ID,
      entrypoint: 'claude-desktop',
    }));
    await this.#emitTurn(state, ts, CLAUDE_CLOUD_TITLE, onLine);
    return { offset: act.size, skipped: 0 };
  }

  async poll(ref, onLine) {
    const state = this.#cloud.get(ref.path);
    if (!state) return { reset: true };
    const mcpPath = ref.facts?.logsDir ? path.join(ref.facts.logsDir, 'mcp.log') : null;
    const mcpEvents = await this.#readMcpDelta(mcpPath, state, onLine);
    const act = await computeClaudeCloudActivity(fsp, ref.facts ?? {});
    if (!act) return { gone: true };
    if (act.sig !== state.sig) {
      state.sig = act.sig;
      if (mcpEvents === 0) {
        const ts = new Date(act.mtimeMs).toISOString();
        await this.#emitTurn(state, ts, CLAUDE_CLOUD_TITLE, onLine);
      }
      return { bytes: 1, skipped: 0 };
    }
    return { bytes: mcpEvents > 0 ? 1 : 0, skipped: 0 };
  }

  forget(p) {
    this.#cloud.delete(p);
  }
}

const defaultClaudeTailer = new ClaudeDesktopTailer();
