// Antigravity (CLI `agy` 와 예전 IDE) 기록 탐색 (ADAPTERS 3.1, 5.3, 7.1, 결정 D6). 허용 목록 방식이다:
//   <root>/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl   (값이 잘리지 않은 기록, 먼저 고른다)
//   <root>/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl        (없거나 더 짧으면 이것)
//   <root>/antigravity-ide/brain/... 도 같은 모양 (예전 IDE)
// <root> 자체는 나열하지 않는다. <root>/antigravity/ (데스크톱 앱, D6), conversations/ (*.db, *.pb), messages/, steps/,
// tasks/, chunks/, history(파일과 폴더), oauth_creds.json, google_accounts.json, settings*.json, state.json,
// trustedFolders.json, projects.json, cache/, sandbox/, tmp/, config/ 는 열지도 stat 하지도 않는다. 심볼릭 링크는 따라가지
// 않는다: 하위 루트, brain/, 대화 폴더, .system_generated/, logs/ 는 lstat 이 진짜 폴더일 때만, 기록은 일반 파일일 때만 쓴다.
// 메타 파일(요약 proto, annotations, task.md)은 붙은 뒤에 meta.mjs 의 감시자가 읽는다. 대화는 모두 메인이다 (조사에서
// 서브에이전트 연결을 찾지 못했다, ADAPTERS 3.4).
//
// 두 기록 중 고르기: "더 짧다" 는 줄 수로 본다 (ADAPTERS 8.1 #14; 바이트는 양쪽으로 틀린다: full 은 값이 잘리지 않았지만
// transcript.jsonl 은 인자 값마다 JSON 문자열로 따옴표가 붙는다). 줄 수는 경로마다 덧붙은 부분만 세어 기억한다. 두 파일은
// 단계마다 따로 덧붙여지므로 잠깐 몇 줄 어긋날 수 있다: 한 번 full 을 고른 대화는 transcript.jsonl 이 FULL_SLACK_LINES 줄을
// 넘게 앞설 때만 바꾸고, 그 밖에는 full 이 따라잡았을 때 (줄 수가 같거나 많을 때) full 로 간다. 고른 파일이 바뀌면 Runner 가
// 같은 직원을 새 경로로 옮긴다 (다른 inode 라 처음부터 다시 읽는다, Codex 이어쓰기 조각과 같은 장치).
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const ANTIGRAVITY_AGENT = 'antigravity';
/** The sub-roots under the Antigravity root that hold readable transcripts (D6: never `antigravity/`). */
export const BASES = Object.freeze(['antigravity-cli', 'antigravity-ide']);
export const FULL = 'transcript_full.jsonl';
export const PLAIN = 'transcript.jsonl';
/**
 * A conversation on transcript_full.jsonl moves to transcript.jsonl only when that one has more than this many lines
 * more (a heuristic: the two files are appended one after the other, a few lines apart; the real "full is shorter"
 * case was a 74-line gap, a full file created late).
 */
export const FULL_SLACK_LINES = 16;
/**
 * Work caps per rescan: conversation folders (both sub-roots together; a walk that would pass it throws SCAN_CAPPED and
 * the Runner skips that rescan, as for Grok and Codex) and the bytes read to count transcript lines (the rest is counted
 * at the next rescans; meanwhile a conversation keeps its previous file).
 */
export const SCAN_LIMITS = Object.freeze({ conversations: 50_000, countBytes: 64 * 1024 * 1024 });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 건너뛰는 오류: 움직이는 중 (ENOENT, ENOTDIR), 그 항목만 읽을 수 없다 (EACCES, EPERM), 링크 고리, 긴 이름
const SKIP = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);
const COUNT_CHUNK = 1024 * 1024;

export const isConversationId = (name) => typeof name === 'string' && UUID_RE.test(name);
export const charIdOf = (uuid) => `${ANTIGRAVITY_AGENT}-${uuid}`;
const capped = (what) => Object.assign(new Error(`antigravity scan cap reached (${what})`), { code: 'SCAN_CAPPED' });

// lstat (링크는 따라가지 않는다): 기대한 종류(진짜 폴더, 일반 파일)일 때만 stat, 아니면 null. 건너뛰는 오류도 null.
async function lstatIf(p, kind) {
  try {
    const st = await fsp.lstat(p);
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
  } catch (err) {
    if (SKIP.has(err?.code)) return null;
    throw err;
  }
}

// <base>/brain 의 대화 폴더 이름 (uuid, Dirent 종류로 진짜 폴더만). brain 이 없거나 링크면 []. brain 이 폴더가 아니거나
// 읽을 수 없으면 던진다: Runner 가 그 rescan 을 건너뛴다 (붙은 세션을 떼지 않는다, Codex 의 sessions/ 와 같다).
async function brainEntries(baseDir) {
  const brain = path.join(baseDir, 'brain');
  let st;
  try {
    st = await fsp.lstat(brain);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  if (st.isSymbolicLink()) return [];
  if (!st.isDirectory()) throw Object.assign(new Error('antigravity brain is not a folder'), { code: 'ENOTDIR' });
  const entries = await fsp.readdir(brain, { withFileTypes: true });
  return entries.filter((d) => d.isDirectory() && isConversationId(d.name)).map((d) => d.name).sort();
}

// 같은 uuid 가 두 하위 루트에 있으면: 기록이 있는 쪽, 더 새 mtime, 더 큰 크기, 그다음 BASES 순서 (cli)
function newest(c) {
  return Math.max(c.full?.mtimeMs ?? -Infinity, c.plain?.mtimeMs ?? -Infinity);
}
function better(c, prev) {
  if (!prev) return true;
  const a = newest(c);
  const b = newest(prev);
  if (a !== b) return a > b;
  return (c.full?.size ?? 0) + (c.plain?.size ?? 0) > (prev.full?.size ?? 0) + (prev.plain?.size ?? 0);
}

/**
 * Walk both sub-roots once: Map(uuid -> { id, base, logs, full: stat|null, plain: stat|null }) for every conversation
 * folder that has at least one transcript. Throws SCAN_CAPPED when the folder cap would cut the walk.
 */
export async function collectConversations(root, limits = SCAN_LIMITS) {
  const out = new Map();
  let budget = limits.conversations;
  for (const base of BASES) {
    const baseDir = path.join(root, base);
    if (!(await lstatIf(baseDir, 'dir'))) continue; // 없음, 링크, 파일: 이 하위 루트에는 대화가 없다
    for (const id of await brainEntries(baseDir)) {
      if (budget-- <= 0) throw capped('conversations');
      const gen = path.join(baseDir, 'brain', id, '.system_generated');
      if (!(await lstatIf(gen, 'dir'))) continue;
      const logs = path.join(gen, 'logs');
      if (!(await lstatIf(logs, 'dir'))) continue;
      const full = await lstatIf(path.join(logs, FULL), 'file');
      const plain = await lstatIf(path.join(logs, PLAIN), 'file');
      if (!full && !plain) continue;
      const c = { id, base, logs, full, plain };
      if (better(c, out.get(id))) out.set(id, c);
    }
  }
  return out;
}

/**
 * Incremental line counter: per path it remembers { ino, dev, offset, lines } and reads only the bytes appended since
 * (from 0 again after an inode change or a shrink). A file is opened with O_NOFOLLOW and read only when the opened file
 * is the lstat-ed regular file. `count(p, st, budget)` -> { lines, used } with `lines` null when the budget ran out
 * before the end (the progress is kept) or the file could not be read.
 */
export function createLineCounter() {
  const memo = new Map();
  async function count(p, st, budget) {
    let m = memo.get(p);
    if (!m || m.ino !== st.ino || m.dev !== st.dev || st.size < m.offset) m = { ino: st.ino, dev: st.dev, offset: 0, lines: 0 };
    memo.set(p, m);
    if (m.offset === st.size) return { lines: m.lines, used: 0 };
    let fh = null;
    let used = 0;
    try {
      fh = await fsp.open(p, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
      const now = await fh.stat();
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return { lines: null, used };
      const buf = Buffer.alloc(Math.min(COUNT_CHUNK, Math.max(1, budget)));
      while (m.offset < st.size) {
        const want = Math.min(buf.length, st.size - m.offset, budget - used);
        if (want <= 0) return { lines: null, used };
        const { bytesRead } = await fh.read(buf, 0, want, m.offset);
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) m.lines += 1;
        m.offset += bytesRead;
        used += bytesRead;
      }
      return { lines: m.lines, used };
    } catch {
      return { lines: null, used };
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  return {
    count,
    /** Forget every path not in `keep` (a Set). */
    prune(keep) {
      for (const p of [...memo.keys()]) if (!keep.has(p)) memo.delete(p);
    },
    get size() { return memo.size; },
  };
}

/**
 * Which file a conversation reads: 'full' | 'plain'. Only one present -> that one. Both: with a previous choice of
 * 'full', stay unless transcript.jsonl has more than `slack` lines more; otherwise 'full' once it has at least as many
 * lines. Unknown counts (budget) keep the previous choice, else 'full'.
 */
export function chooseTranscript({ full, plain, fullLines = null, plainLines = null, prev = null, slack = FULL_SLACK_LINES }) {
  if (!full) return plain ? 'plain' : null;
  if (!plain) return 'full';
  if (fullLines === null || plainLines === null) return prev ?? 'full';
  if (prev === 'full') return plainLines > fullLines + slack ? 'plain' : 'full';
  return fullLines >= plainLines ? 'full' : 'plain';
}

function refOf(c, which) {
  const st = which === 'full' ? c.full : c.plain;
  const charId = charIdOf(c.id);
  return {
    path: path.join(c.logs, which === 'full' ? FULL : PLAIN), agent: ANTIGRAVITY_AGENT, kind: 'main',
    charId, stem: charId, sessionId: c.id, sid: charId,
    mtimeMs: st.mtimeMs, size: st.size, ino: st.ino,
    // 세션에 넘기는 탐색 사실: transcript.jsonl 은 인자 값이 JSON 문자열이고 긴 값이 잘려 있다
    facts: { full: which === 'full', base: c.base },
  };
}

/**
 * The Runner's scan for one Antigravity root (stateful: line counts and the file each conversation reads). Returns a
 * FileRef per conversation whose newest transcript mtime is inside the active window, every one a main, sorted by
 * uuid. Ids are D2 (`antigravity-<uuid>`).
 */
export function createAntigravityScanner({ limits = SCAN_LIMITS, slackLines = FULL_SLACK_LINES } = {}) {
  const counter = createLineCounter();
  const choice = new Map(); // uuid -> 'full' | 'plain' (마지막에 고른 파일)
  return async function scan(root, { activeMs, nowMs } = {}) {
    const convs = await collectConversations(root, limits);
    const windowed = Number.isFinite(activeMs) && Number.isFinite(nowMs);
    const keepPaths = new Set();
    const refs = [];
    let budget = limits.countBytes;
    for (const id of [...convs.keys()].sort()) {
      const c = convs.get(id);
      if (windowed && newest(c) < nowMs - activeMs) continue;
      let fullLines = null;
      let plainLines = null;
      if (c.full && c.plain) {
        for (const [name, st] of [[FULL, c.full], [PLAIN, c.plain]]) {
          const p = path.join(c.logs, name);
          keepPaths.add(p);
          const r = await counter.count(p, st, Math.max(0, budget));
          budget -= r.used;
          if (name === FULL) fullLines = r.lines;
          else plainLines = r.lines;
        }
      }
      const which = chooseTranscript({ full: c.full, plain: c.plain, fullLines, plainLines, prev: choice.get(id) ?? null, slack: slackLines });
      if (!which) continue;
      choice.set(id, which);
      refs.push(refOf(c, which));
    }
    for (const id of [...choice.keys()]) if (!convs.has(id)) choice.delete(id);
    counter.prune(keepPaths);
    return refs;
  };
}

/** One stateless scan (a fresh scanner): FileRef[] for tests and one-off use. */
export async function scanAntigravity(root, opts = {}) {
  return createAntigravityScanner(opts)(root, opts);
}
