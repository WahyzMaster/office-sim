// Codex (OpenAI Codex: 데스크톱 앱, CLI, IDE 확장 모두) 기록 탐색 (ADAPTERS 3.1, 3.4, 5.1, 7.1, 8.1 #17). 허용 목록 방식이다:
//   <root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl           스레드 하나의 기록
//   <root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>_<uuid2>.jsonl   되돌리기 뒤의 이어쓰기 조각 (같은 스레드)
// 이 이름만 lstat 하고, 그중 필요한 파일의 첫 줄(session_meta)만 상한 안에서 읽는다 (line0.mjs). .zst, archived_sessions/,
// history.jsonl, session_index.jsonl (제목은 titles.mjs), 인증/설정/sqlite/로그 파일, worktrees/ 는 열지도 stat 하지도 않는다.
// 날짜 폴더는 로컬 날짜(스레드를 만든 날)라서, rescan 마다 보는 것은 활동 창이 닿는 최근 날짜 폴더뿐이고 나머지(이어 쓰려고
// 다시 풀린 옛 파일)는 FULL_WALK_MS(30초)마다 한 번 훑는다. 그 이름 목록으로 창 밖의 부모도 uuid 로 찾는다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Line0Cache, LINE0_MAX_BYTES } from './line0.mjs';
import { scanCodexDesktopCloud } from './desktop-cloud.mjs';

export const CODEX_AGENT = 'codex';
export const charIdOf = (uuid) => `${CODEX_AGENT}-${uuid}`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_RE = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`, 'i');
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^(0[1-9]|1[0-2])$/;
const DAY_RE = /^(0[1-9]|[12]\d|3[01])$/;
// 건너뛰는 오류: 폴더나 파일이 움직이는 중이거나 (ENOENT, ENOTDIR), 그 항목 하나만 읽을 수 없다 (EACCES, EPERM ...)
const SKIP = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;

/**
 * Work caps per scan: date folders, accepted rollout names in one walk, parent chain depth, line-0 bytes. A walk that
 * would pass the first two throws SCAN_CAPPED instead of returning a cut list (the Runner logs the code once and keeps
 * every attached session).
 */
export const SCAN_LIMITS = Object.freeze({ days: 20_000, files: 200_000, depth: 16, metaBytes: LINE0_MAX_BYTES });
/** Every date folder is listed at the first scan and then at most this often (resumed old threads, parents by uuid). */
export const FULL_WALK_MS = 30_000;
/** Date folders this close to now are listed on every scan even before a full walk has seen them (new threads). */
export const RECENT_MS = 2 * DAY_MS;

const capped = (what) => Object.assign(new Error(`codex scan cap reached (${what})`), { code: 'SCAN_CAPPED' });

/** `rollout-<ts>-<uuid>[_<uuid2>].jsonl` -> { uuid, piece } (lowercase; piece = uuid2 or null), else null. */
export function parseRolloutName(name) {
  const m = typeof name === 'string' ? ROLLOUT_RE.exec(name) : null;
  return m ? { uuid: m[1].toLowerCase(), piece: m[2] ? m[2].toLowerCase() : null } : null;
}

const pad = (n) => String(n).padStart(2, '0');
/** The local date folder key 'YYYY/MM/DD' of a time (folder dates are local time, research "locations"). */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// [from, to] 의 로컬 날짜 키 (12시간 간격: 23시간짜리 날도 건너뛰지 않는다)
function keysBetween(from, to) {
  const out = new Set();
  for (let t = from; t < to; t += HALF_DAY_MS) out.add(dayKey(t));
  out.add(dayKey(to));
  return out;
}

/**
 * Date folders a scan lists every time: those that can hold a file created inside the active window (one day of margin
 * on both sides for time zones and clock skew) and that the last full walk saw, plus the recent ones (RECENT_MS) that
 * may not exist yet at that walk. Never more than the window needs.
 */
export function hotKeys(nowMs, activeMs, known = new Set()) {
  const recent = keysBetween(nowMs - RECENT_MS, nowMs + DAY_MS);
  const range = keysBetween(nowMs - activeMs - DAY_MS, nowMs + DAY_MS);
  return [...range].filter((k) => recent.has(k) || known.has(k)).sort();
}

// <root>/sessions: 실제 폴더일 때만 그 경로. 없거나 심볼릭 링크면 null (따라가지 않는다: 아무것도 없는 것과 같다).
// 있지만 폴더가 아니거나 lstat 할 수 없으면 던진다 (그 rescan 은 건너뛴다)
async function sessionsDir(root) {
  const base = path.join(root, 'sessions');
  let st;
  try {
    st = await fsp.lstat(base);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) return null;
  if (!st.isDirectory()) throw Object.assign(new Error('codex sessions is not a folder'), { code: 'ENOTDIR' });
  return base;
}

/**
 * A per-scan check that every folder of a date key's path (sessions, YYYY, MM, DD) is a real folder, by lstat (a
 * symlink is not): the hot folders, which no full walk may have seen yet, and the cold folders, which may have changed
 * since, are listed or re-stat-ed only through it, so they follow the same rule as the full walk (Dirent types).
 */
function realFolders(root) {
  const memo = new Map();
  const real = (p) => {
    if (!memo.has(p)) {
      memo.set(p, fsp.lstat(p).then((st) => st.isDirectory(), (err) => {
        if (SKIP.has(err?.code)) return false;
        throw err;
      }));
    }
    return memo.get(p);
  };
  return async (key) => {
    let p = path.join(root, 'sessions');
    if (!(await real(p))) return false;
    for (const part of key.split('/')) {
      p = path.join(p, part);
      if (!(await real(p))) return false;
    }
    return true;
  };
}

// 이름이 맞는 하위 디렉터리 (Dirent 종류로: 심볼릭 링크는 따라가지 않는다). strict: sessions 폴더 자체를 읽을 수 없으면 던진다
async function subdirs(dir, re, strict = false) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || (!strict && SKIP.has(err?.code))) return [];
    throw err;
  }
  return entries.filter((d) => d.isDirectory() && re.test(d.name)).map((d) => d.name).sort();
}

/** Every date folder key under `<root>/sessions` (names only). Throws SCAN_CAPPED past limits.days. */
export async function walkDays(root, limits = SCAN_LIMITS) {
  const base = await sessionsDir(root);
  if (!base) return [];
  const out = [];
  for (const y of await subdirs(base, YEAR_RE, true)) {
    for (const m of await subdirs(path.join(base, y), MONTH_RE)) {
      for (const d of await subdirs(path.join(base, y, m), DAY_RE)) {
        out.push(`${y}/${m}/${d}`);
        if (out.length > limits.days) throw capped('days');
      }
    }
  }
  return out;
}

async function lstatFile(p) {
  try {
    const st = await fsp.lstat(p);
    return st.isFile() ? st : null;
  } catch (err) {
    if (SKIP.has(err?.code)) return null;
    throw err;
  }
}

// 날짜 폴더 하나의 rollout 조각: 이름이 맞는 일반 파일만 lstat 한다 (.zst 와 다른 파일은 이름만 보고 지나간다)
async function listDay(root, key, budget) {
  const dir = path.join(root, 'sessions', ...key.split('/'));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (SKIP.has(err?.code)) return [];
    throw err;
  }
  const out = [];
  for (const d of entries) {
    const name = d.isFile() ? parseRolloutName(d.name) : null;
    if (!name) continue;
    if (--budget.files < 0) throw capped('files');
    const file = path.join(dir, d.name);
    const st = await lstatFile(file);
    if (st) out.push({ path: file, uuid: name.uuid, piece: name.piece, key, st });
  }
  return out;
}

// 같은 스레드의 조각 순서: 가장 새 mtime, 같으면 첫 줄 ordinal 이 큰 것, 이어쓰기 조각, 이름 (뒤의 것)
function pieceOrder(a, b) {
  return b.st.mtimeMs - a.st.mtimeMs || (b.ordinal ?? -1) - (a.ordinal ?? -1) || (!!b.piece - !!a.piece) || (a.path < b.path ? 1 : -1);
}

// Codex 가 만든 워크트리 (<root>/worktrees/...) 에서 일하는 스레드: 같은 scan 의 보통 메인보다 뒤에 붙인다 (D1: 그 층을 찾게)
const inCodexWorktree = (win, root) => typeof root === 'string' && root !== '' && typeof win?.facts?.cwd === 'string'
  && win.facts.cwd.startsWith(`${path.join(root, 'worktrees')}/`);

function refOf(uuid, win, chain) {
  const sub = chain.length > 0;
  const charId = charIdOf(uuid);
  const f = win.facts;
  const ref = {
    path: win.entry.path, agent: CODEX_AGENT, kind: sub ? 'sub' : 'main', charId, stem: charId, sessionId: uuid,
    sid: sub ? charIdOf(chain[chain.length - 1]) : charId, // sid: 부모를 거슬러 올라간 최상위 메인 (층 상속, Runner 의 묶음)
    mtimeMs: win.entry.st.mtimeMs, size: win.entry.st.size, ino: win.entry.st.ino,
    // 첫 줄 사실 (CONTRACT 4.0.2: 탐색 때 정한다). Runner 가 세션 생성자에 `facts` 로 넘긴다. 계정 id 같은 다른 필드는 없다
    facts: { cwd: f.cwd, branch: f.branch, cliVersion: f.cliVersion, historyStart: f.historyStart, agentType: sub ? f.agentType : null },
  };
  if (sub) ref.parentId = charIdOf(chain[0]);
  return ref;
}

/**
 * Classify one walk (entries: every accepted rollout piece seen, with its lstat). A thread is reported when its winning
 * piece is inside the active window; every ancestor of a reported sub is reported too, even outside the window (a
 * parent waiting on its subagent writes nothing). Guardian threads (D10a) and their descendants are never reported. The
 * parent chain stops at a parent that has no plain rollout (compressed, archived), whose line 0 is unusable, or past a
 * cycle / limits.depth: the thread at that level is a main. A thread whose own line 0, or an ancestor's, is not complete
 * yet waits. Order: by chain length (mains first, then subs by depth); among equals, a thread working in a Codex-managed
 * worktree (cwd under `<root>/worktrees/`, given `root`) after the others, so a worktree main is attached after the plain
 * mains of the same scan whose floor it may join (D1); then by uuid. Returns { refs, missing: parent uuids with no
 * plain rollout }.
 */
export async function classify(entries, { activeMs, nowMs, cache, depth = SCAN_LIMITS.depth, root = null } = {}) {
  const windowed = Number.isFinite(activeMs) && Number.isFinite(nowMs);
  const threads = new Map(); // uuid -> pieces
  for (const e of entries) {
    if (!threads.has(e.uuid)) threads.set(e.uuid, []);
    threads.get(e.uuid).push(e);
  }
  const memo = new Map(); // uuid -> { entry, facts } | 'pending' | null (unusable)
  const winner = async (uuid) => {
    if (memo.has(uuid)) return memo.get(uuid);
    let out = null;
    const pieces = threads.get(uuid);
    if (pieces.length > 1) {
      for (const p of pieces) p.ordinal = (await cache.get(p.path, p.st, uuid))?.ordinal ?? null;
      pieces.sort(pieceOrder);
    }
    for (const p of pieces) {
      const facts = await cache.get(p.path, p.st, uuid);
      if (facts === undefined) out ??= 'pending'; // 첫 줄이 아직 덜 쓰였다: 더 오래된 조각이 있으면 그것으로
      else if (facts) {
        out = { entry: p, facts };
        break;
      }
    }
    memo.set(uuid, out);
    return out;
  };
  const missing = new Set();
  // 부모 사슬 [바로 위 부모, ..., 최상위 메인]. hidden: guardian 의 자손. pending: 조상의 첫 줄이 아직 덜 쓰였다
  const chainOf = async (uuid, facts) => {
    const chain = [];
    const seen = new Set([uuid]);
    let cur = facts.parent;
    while (cur) {
      if (seen.has(cur) || chain.length >= depth) return { chain: [] }; // 순환, 너무 깊다: 연결을 믿지 않는다
      if (!threads.has(cur)) {
        missing.add(cur);
        break;
      }
      const w = await winner(cur);
      if (w === 'pending') return { pending: true };
      if (!w) break;
      if (w.facts.guardian) return { hidden: true };
      seen.add(cur);
      chain.push(cur);
      cur = w.facts.parent;
    }
    return { chain };
  };
  const picked = new Map(); // uuid -> { win, chain }
  for (const uuid of threads.keys()) {
    const pieces = threads.get(uuid);
    if (windowed && !pieces.some((p) => p.st.mtimeMs >= nowMs - activeMs)) continue;
    const win = await winner(uuid);
    if (!win || win === 'pending' || win.facts.guardian) continue;
    const res = await chainOf(uuid, win.facts);
    if (res.hidden || res.pending) continue;
    picked.set(uuid, { win, chain: res.chain });
    for (let i = 0; i < res.chain.length; i++) {
      const a = res.chain[i];
      if (!picked.has(a)) picked.set(a, { win: await winner(a), chain: res.chain.slice(i + 1) });
    }
  }
  const wt = (x) => (inCodexWorktree(x[1].win, root) ? 1 : 0);
  const refs = [...picked.entries()]
    .sort((a, b) => a[1].chain.length - b[1].chain.length || wt(a) - wt(b) || (a[0] < b[0] ? -1 : 1))
    .map(([uuid, { win, chain }]) => refOf(uuid, win, chain));
  return { refs, missing: [...missing] };
}

/**
 * The Runner's scan for one Codex root (stateful: one per Runner). Lists the hot date folders (hotKeys) on every call
 * and every date folder at the first call and then every `fullWalkMs` (also once more, early, when a needed parent is
 * not in the last walk). Files of the other folders keep their last lstat, except the ones inside the window, which
 * are lstat-ed again on every call. Without a window (no activeMs) every call is a full walk and every thread counts.
 */
export function createCodexScanner({ limits = SCAN_LIMITS, fullWalkMs = FULL_WALK_MS, cache = null } = {}) {
  const line0 = cache ?? new Line0Cache({ maxBytes: limits.metaBytes });
  let rootSeen = null;
  let known = new Set(); // 지난 전체 훑기의 날짜 폴더
  let cold = new Map(); // path -> entry: 지난 전체 훑기에서 본, 매번 보지 않는 폴더의 조각
  let hotPrev = new Set(); // 지난 scan 의 매번 보는 폴더 (빠진 폴더는 바로 cold 로 옮긴다)
  let lastFull = null;
  let missingSeen = new Set(); // 전체 훑기 뒤에도 없던 부모 uuid (그 때문에 다시 훑지 않는다)

  async function walk(root, nowMs, activeMs, full) {
    const windowed = Number.isFinite(activeMs);
    const isReal = realFolders(root);
    if (full) {
      known = new Set(await walkDays(root, limits));
      lastFull = nowMs;
    }
    // 매번 보는 폴더도 전체 훑기와 같은 규칙: 경로의 모든 폴더가 실제 폴더일 때만 (링크를 따라 root 밖을 읽지 않는다)
    const hot = [];
    for (const key of windowed ? hotKeys(nowMs, activeMs, known) : [...known]) {
      if (full ? known.has(key) : await isReal(key)) hot.push(key);
    }
    const hotSet = new Set(hot);
    const budget = { files: limits.files };
    const entries = [];
    for (const key of hot) entries.push(...await listDay(root, key, budget));
    if (full) {
      cold = new Map();
      for (const key of known) if (!hotSet.has(key)) for (const e of await listDay(root, key, budget)) cold.set(e.path, e);
      line0.prune(new Set([...entries.map((e) => e.path), ...cold.keys()]));
    } else {
      // 시간이 지나 매번 보는 범위에서 빠진 폴더: 다음 전체 훑기까지 기다리지 않고 지금 cold 로 (긴 스레드가 끊기지 않게)
      for (const key of hotPrev) {
        if (!hotSet.has(key) && await isReal(key)) for (const e of await listDay(root, key, budget)) cold.set(e.path, e);
      }
      for (const [p, e] of [...cold]) {
        if (hotSet.has(e.key)) cold.delete(p); // 이제 매번 보는 폴더에 있다
        else if (!windowed || e.st.mtimeMs >= nowMs - activeMs) { // 창 안에 있던 파일: 매번 다시 lstat
          const st = await isReal(e.key) ? await lstatFile(p) : null; // 그 사이 링크로 바뀐 폴더는 따라가지 않는다
          if (st) e.st = st;
          else cold.delete(p);
        }
      }
    }
    hotPrev = hotSet;
    return [...entries, ...cold.values()];
  }

  return async function scan(root, { activeMs, nowMs, logsRoot, classicRoot } = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const windowed = Number.isFinite(activeMs);
    if (root !== rootSeen || (lastFull !== null && now < lastFull)) {
      rootSeen = root;
      known = new Set();
      cold = new Map();
      hotPrev = new Set();
      lastFull = null;
      missingSeen = new Set();
    }
    let full = !windowed || lastFull === null || now - lastFull >= fullWalkMs;
    const opts = { activeMs: windowed ? activeMs : undefined, nowMs: now, cache: line0, depth: limits.depth, root };
    let res = await classify(await walk(root, now, activeMs, full), opts);
    // 필요한 부모가 지난 전체 훑기에 없었다 (다시 풀린 옛 스레드가 방금 자식을 낳았을 수 있다): 한 번 더 일찍 훑는다
    if (!full && res.missing.some((u) => !missingSeen.has(u))) {
      full = true;
      res = await classify(await walk(root, now, activeMs, true), opts);
    }
    if (full) missingSeen = new Set(res.missing);
    const cloudRefs = await scanCodexDesktopCloud(root, {
      activeMs: windowed ? activeMs : Infinity, nowMs: now, localRefs: res.refs, logsRoot, classicRoot,
    });
    return cloudRefs.length ? [...res.refs, ...cloudRefs] : res.refs;
  };
}

/** One stateless scan (a full walk): FileRef[] for tests and one-off use. */
export async function scanCodex(root, { activeMs, nowMs, limits = SCAN_LIMITS, logsRoot, classicRoot } = {}) {
  return createCodexScanner({ limits })(root, { activeMs, nowMs, logsRoot, classicRoot });
}
