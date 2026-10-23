// Transcript file discovery under ~/.claude/projects (contract 3.5).
//
// Layout (only these shapes are transcripts):
//   main: <root>/<dir>/<uuid>.jsonl
//   sub:  <root>/<dir>/<sid>/subagents/agent-<id>.jsonl
//   wf:   <root>/<dir>/<sid>/subagents/workflows/<runId>/agent-<id>.jsonl
// The walk only descends into uuid-named session dirs, their `subagents/` dir and `subagents/workflows/<runId>/`,
// and only accepts file names matching the patterns above. That keeps journal.jsonl, *.meta.json, *.prefix.json,
// <sid>/workflows/<runId>.json, tool-results/, session-memory/ and memory/ out by construction.
//
// Errors: ENOENT/ENOTDIR (files move live) and EACCES/EPERM (unreadable entry) skip that entry. Any other error
// (EMFILE, EIO, ...) is rethrown so the caller skips the whole rescan instead of acting on a partial list
// (a partial list would look like files leaving the active window).

import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { scanClaudeDesktopCloud } from './desktop-claude.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGENT_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const SKIP_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const KIND_ORDER = { main: 0, sub: 1, wf: 2 };
const MAX_META_BYTES = 1024 * 1024;
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_CACHE = 256;
export const SCAN_LIMITS = Object.freeze({ projects: 10_000, files: 100_000 });
const capped = (what) => Object.assign(new Error(`claude scan cap reached (${what})`), { code: 'SCAN_CAPPED' });

function isSkippable(err) {
  return Boolean(err && SKIP_CODES.has(err.code));
}

async function listDir(fsApi, dir) {
  try {
    return await fsApi.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

async function statOrNull(fsApi, p) {
  try {
    return await fsApi.stat(p);
  } catch (err) {
    if (isSkippable(err)) return null;
    throw err;
  }
}

// Directory test for a dirent; symlinks are resolved with stat (Node already resolves unknown d_type itself).
async function isDirEntry(fsApi, full, d) {
  if (d.isDirectory()) return true;
  if (typeof d.isSymbolicLink === 'function' && d.isSymbolicLink()) {
    const st = await statOrNull(fsApi, full);
    return Boolean(st && st.isDirectory());
  }
  return false;
}

function makeRef(full, kind, fields, st) {
  return {
    path: full,
    kind,
    stem: fields.stem,
    sessionId: fields.sessionId,
    agentId: fields.agentId ?? null,
    runId: fields.runId ?? null,
    projectDir: fields.projectDir,
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
  };
}

// agent-<id>.jsonl files in one directory -> refs (kind 'sub' or 'wf').
async function scanAgentFiles(fsApi, dir, entries, kind, base) {
  const jobs = [];
  for (const d of entries) {
    const m = AGENT_RE.exec(d.name);
    if (!m || d.isDirectory()) continue;
    const full = path.join(dir, d.name);
    jobs.push((async () => {
      const st = await statOrNull(fsApi, full);
      if (!st || !st.isFile()) return null;
      return makeRef(full, kind, { ...base, stem: m[1], agentId: m[1] }, st);
    })());
  }
  return (await Promise.all(jobs)).filter(Boolean);
}

async function scanSessionDir(fsApi, projectDir, sid) {
  const subDir = path.join(projectDir, sid, 'subagents');
  const entries = await listDir(fsApi, subDir);
  if (!entries) return [];
  const base = { sessionId: sid, projectDir };
  const out = await scanAgentFiles(fsApi, subDir, entries, 'sub', base);
  const wfEntry = entries.find((d) => d.name === 'workflows');
  if (!wfEntry) return out;
  const wfDir = path.join(subDir, 'workflows');
  const runs = await listDir(fsApi, wfDir);
  if (!runs) return out;
  for (const r of runs) {
    if (r.name.startsWith('.')) continue;
    const runDir = path.join(wfDir, r.name);
    if (!(await isDirEntry(fsApi, runDir, r))) continue;
    const files = await listDir(fsApi, runDir);
    if (!files) continue;
    out.push(...await scanAgentFiles(fsApi, runDir, files, 'wf', { ...base, runId: r.name }));
  }
  return out;
}

async function scanProjectDir(fsApi, projectDir) {
  const entries = await listDir(fsApi, projectDir);
  if (!entries) return { mains: [], subs: [] };
  const sessionDirs = new Set();
  const mainJobs = [];
  for (const d of entries) {
    const full = path.join(projectDir, d.name);
    const m = MAIN_RE.exec(d.name);
    if (m) {
      mainJobs.push((async () => {
        const st = await statOrNull(fsApi, full);
        if (!st || !st.isFile()) return null;
        return makeRef(full, 'main', { stem: m[1], sessionId: m[1], projectDir }, st);
      })());
    } else if (UUID_RE.test(d.name) && (await isDirEntry(fsApi, full, d))) {
      sessionDirs.add(d.name);
    }
  }
  const mains = (await Promise.all(mainJobs)).filter(Boolean)
    .map((ref) => ({ ref, hasSubdir: sessionDirs.has(ref.stem) }));
  const subs = [];
  for (const sid of [...sessionDirs].sort()) subs.push(...await scanSessionDir(fsApi, projectDir, sid));
  return { mains, subs };
}

// Contract 3.5: prefer the copy with a <stem>/ subdir, then newest mtime, then largest size (then path for
// determinism).
function compareMain(a, b) {
  if (a.hasSubdir !== b.hasSubdir) return a.hasSubdir ? -1 : 1;
  return compareRefs(a.ref, b.ref);
}

// Newest mtime, then largest size, then path.
function compareRefs(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.size !== b.size) return b.size - a.size;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function pickMains(candidates) {
  const byStem = new Map();
  for (const c of candidates) {
    const key = c.ref.stem.toLowerCase();
    const prev = byStem.get(key);
    if (!prev || compareMain(c, prev) < 0) byStem.set(key, c);
  }
  return [...byStem.values()].map((c) => c.ref);
}

// The same agent file can exist in two project dirs after an old-style copy relocation. Keep one per
// (sessionId, kind, agentId): prefer the copy next to the chosen main file, then newest mtime, then largest size.
function pickSubs(subs, mainDirBySid) {
  const byKey = new Map();
  for (const ref of subs) {
    const key = `${ref.kind}:${ref.sessionId.toLowerCase()}:${ref.agentId}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, ref); continue; }
    const home = mainDirBySid.get(ref.sessionId.toLowerCase());
    const aHome = ref.projectDir === home;
    const bHome = prev.projectDir === home;
    if (aHome !== bHome) { if (aHome) byKey.set(key, ref); continue; }
    if (compareRefs(ref, prev) < 0) byKey.set(key, ref);
  }
  return [...byKey.values()];
}

/**
 * Find transcript files.
 * @param {string} root projects root (the caller owns the default, e.g. ~/.claude/projects)
 * @param {{ activeMs?: number, nowMs?: number, fs?: { readdir: Function, stat: Function } }} [opts]
 *   activeMs missing or not finite -> no mtime filter. `fs` is a test hook (node:fs/promises shape).
 * @returns {Promise<Array<object>>} FileRef[] ordered main, sub, wf, then by path. A main file outside the window is
 *   still returned while a sub/wf file of the same session is inside it (mtimeMs stays the real file mtime).
 */
export async function scan(root, {
  activeMs = Infinity, nowMs = Date.now(), fs: fsApi = fsp, limits = SCAN_LIMITS, appSupportDir, logsDir,
} = {}) {
  const absRoot = path.resolve(root);
  let projects = [];
  try {
    projects = await fsApi.readdir(absRoot, { withFileTypes: true });
  } catch (err) {
    if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) throw err;
  }
  const maxProjects = limits?.projects ?? SCAN_LIMITS.projects;
  const maxFiles = limits?.files ?? SCAN_LIMITS.files;
  let projBudget = maxProjects;
  const mainCandidates = [];
  const subs = [];
  for (const d of projects) {
    if (d.name.startsWith('.')) continue;
    if (projBudget-- <= 0) throw capped('projects');
    const projectDir = path.join(absRoot, d.name);
    if (!(await isDirEntry(fsApi, projectDir, d))) continue;
    const found = await scanProjectDir(fsApi, projectDir);
    if (mainCandidates.length + subs.length + found.mains.length + found.subs.length > maxFiles) {
      throw capped('files');
    }
    mainCandidates.push(...found.mains);
    subs.push(...found.subs);
  }
  const mains = pickMains(mainCandidates);
  const mainDirBySid = new Map(mains.map((r) => [r.stem.toLowerCase(), r.projectDir]));
  const agents = pickSubs(subs, mainDirBySid);
  const minMtime = Number.isFinite(activeMs) ? nowMs - activeMs : -Infinity;
  // A main stays inside the window while any sub/wf file of its session is: it is the parent of live children
  // (4.4 floor inheritance, 4.5 parentSessionId), even when it writes nothing while it waits for them.
  const liveSids = new Set(agents.filter((r) => r.mtimeMs >= minMtime).map((r) => r.sessionId.toLowerCase()));
  const cloudRefs = await scanClaudeDesktopCloud(absRoot, { activeMs, nowMs, fs: fsApi, appSupportDir, logsDir });
  return [...mains, ...cloudRefs, ...agents]
    .filter((r) => r.mtimeMs >= minMtime || (r.kind === 'main' && liveSids.has(r.stem.toLowerCase())))
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One main transcript and its subagent files (replay mode, P3): FileRef[] ordered main, sub, wf, then by path.
 * The sub/wf files live in `<dir>/<stem>/subagents/` next to the main file; a lone file is fine.
 * Throws when the main file is missing or not a regular file.
 */
export async function sessionRefs(mainPath, { fs: fsApi = fsp } = {}) {
  const full = path.resolve(mainPath);
  const st = await fsApi.stat(full);
  if (!st.isFile()) throw Object.assign(new Error('replay target is not a file'), { code: 'EISDIR' });
  const projectDir = path.dirname(full);
  const stem = path.basename(full, '.jsonl');
  const main = makeRef(full, 'main', { stem, sessionId: stem, projectDir }, st);
  const agents = await scanSessionDir(fsApi, projectDir, stem);
  return [main, ...agents.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.path < b.path ? -1 : 1))];
}

/**
 * agent-<id>.jsonl -> sibling agent-<id>.meta.json parsed as a plain object.
 * Missing (normal: the meta can appear seconds after the jsonl), partial, invalid or non-object -> null.
 */
export async function readSubMeta(jsonlPath) {
  if (typeof jsonlPath !== 'string' || !jsonlPath.endsWith('.jsonl')) return null;
  const metaPath = jsonlPath.slice(0, -'.jsonl'.length) + '.meta.json';
  let text;
  try {
    const st = await fsp.stat(metaPath);
    if (!st.isFile() || st.size > MAX_META_BYTES) return null;
    text = await fsp.readFile(metaPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

const journalCache = new Map();

function applyStartedLine(line, labels) {
  // 'result' lines carry whole agent results and can be large; only parse lines that can be 'started'.
  if (!line.includes('"started"')) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!rec || rec.type !== 'started' || typeof rec.agentId !== 'string' || !rec.agentId) return;
  const label = [rec.label, rec.phase].find((v) => typeof v === 'string' && v.trim() !== '');
  if (label !== undefined) labels.set(rec.agentId, label.trim());
}

/**
 * <runDir>/journal.jsonl 'started' lines -> Map(agentId -> label ?? phase). Latest non-empty label wins.
 * Missing file, partial trailing line and invalid lines are tolerated (empty Map at worst).
 * Bounded by MAX_JOURNAL_BYTES, opened with O_NONBLOCK, and incrementally cached per runDir.
 */
export async function readJournalLabels(runDir) {
  if (typeof runDir !== 'string' || runDir === '') return new Map();
  const file = path.join(runDir, 'journal.jsonl');
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    journalCache.delete(file);
    return new Map();
  }
  if (!st.isFile() || st.size > MAX_JOURNAL_BYTES) return new Map();
  let slot = journalCache.get(file);
  if (slot && slot.ino === st.ino && slot.dev === st.dev && slot.size === st.size && slot.mtimeMs === st.mtimeMs) {
    return new Map(slot.result);
  }
  if (!slot || slot.ino !== st.ino || slot.dev !== st.dev || st.size < slot.offset) {
    slot = { ino: st.ino, dev: st.dev, size: 0, mtimeMs: 0, offset: 0, committed: new Map(), result: new Map() };
  }
  let fh = null;
  try {
    fh = await fsp.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
    const now = await fh.stat();
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev || now.size > MAX_JOURNAL_BYTES) return new Map();
    const len = now.size - slot.offset;
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, slot.offset);
      const chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        const doneText = chunk.subarray(0, lastNl).toString('utf8');
        for (const line of doneText.split('\n')) applyStartedLine(line, slot.committed);
        slot.offset += lastNl + 1;
      }
      const out = new Map(slot.committed);
      const tail = lastNl + 1 < bytesRead ? chunk.subarray(lastNl + 1).toString('utf8') : '';
      if (tail) applyStartedLine(tail, out);
      slot.result = out;
    }
    slot.size = now.size;
    slot.mtimeMs = now.mtimeMs;
    journalCache.delete(file);
    if (journalCache.size >= MAX_JOURNAL_CACHE) journalCache.delete(journalCache.keys().next().value);
    journalCache.set(file, slot);
    return new Map(slot.result);
  } catch {
    return new Map();
  } finally {
    await fh?.close().catch(() => {});
  }
}
