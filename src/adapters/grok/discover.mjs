// Grok (xAI Grok Build) 기록 탐색 (ADAPTERS 3.1, 3.4, 5.2, 7.1). 허용 목록 방식이다:
//   <root>/sessions/<cwd 그룹>/<세션 uuid>/updates.jsonl            기록 (이것만 FileRef 로 낸다)
//   <root>/sessions/<cwd 그룹>/<부모 uuid>/subagents/<자식 uuid>/    서브에이전트 연결 (디렉터리 이름만 본다)
// 그 밖의 파일(prompt_history.jsonl, chat_history.jsonl, events.jsonl, plan.*, meta.json, summary.json, 인증/설정 파일)은
// 탐색이 열지도 stat 하지도 않는다. 붙은 뒤에 GrokMeta (meta.mjs) 가 summary.json 을 (SidecarWatcher, src/core/sidecar.mjs)
// 읽고, 승인 대기(P5g)를 위해 같은 폴더의 events.jsonl 하나를 이어 읽는다 (events.mjs). 다른 파일은 붙은 뒤에도 열지 않는다.
// 자식의 기록에는 부모가 없으므로 (61/62) 모든 cwd 그룹을 먼저 다 모은 뒤에 종류를 정한다 (자식 15/62 가 다른 그룹에 있다).
import fsp from 'node:fs/promises';
import path from 'node:path';

export const GROK_AGENT = 'grok';
export const TRANSCRIPT = 'updates.jsonl';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 건너뛰는 오류: 파일이 움직이는 중이거나 (ENOENT, ENOTDIR), 그 폴더 하나만 읽을 수 없다 (EACCES, EPERM)
const SKIP = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);

/**
 * Work caps per rescan: cwd groups, session folders visited, children per parent, parent chain depth. A walk that would
 * pass the first three throws SCAN_CAPPED instead of returning a cut list (a cut by name order would drop the newest
 * UUIDv7 folders and leave children without their parent): the Runner logs the code once and skips that rescan without
 * detaching anything. A full walk of 5000 folders takes about 0.15 s.
 */
export const SCAN_LIMITS = Object.freeze({ groups: 10_000, sessions: 50_000, children: 5_000, depth: 16 });

const capped = (what) => Object.assign(new Error(`grok scan cap reached (${what})`), { code: 'SCAN_CAPPED' });
/**
 * A session folder that shows up after the first scan with no parent naming it waits this long before it is reported
 * as a main (heuristic): its parent may write `subagents/<id>/` a moment later, and a main is never turned into a sub
 * once attached. Folders that exist at the first scan are classified at once.
 */
export const LINK_GRACE_MS = 1000;

export const isSessionId = (name) => typeof name === 'string' && UUID_RE.test(name);
// cwd 그룹 이름은 URL 인코딩한 cwd (긴 이름은 slug + hash). 숨김 이름만 뺀다
const isGroupName = (name) => typeof name === 'string' && name !== '' && !name.startsWith('.');
export const charIdOf = (uuid) => `${GROK_AGENT}-${uuid}`;

// 이름이 맞는 하위 디렉터리 (Dirent 종류로 판단하므로 파일과 심볼릭 링크는 stat 하지 않고 뺀다). strict: 루트의
// sessions 폴더 자체를 읽을 수 없으면 (ENOENT 말고) 던진다: Runner 가 scan 실패로 그 rescan 을 건너뛴다.
async function subdirs(dir, accept, strict = false) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || (!strict && SKIP.has(err?.code))) return [];
    throw err;
  }
  return entries.filter((d) => d.isDirectory() && accept(d.name)).map((d) => d.name).sort();
}

// lstat (링크는 따라가지 않는다): 기대한 종류(일반 파일, 진짜 디렉터리)일 때만 stat, 아니면 null. 없으면 null.
async function lstatIf(p, kind) {
  try {
    const st = await fsp.lstat(p);
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
  } catch (err) {
    if (SKIP.has(err?.code)) return null;
    throw err;
  }
}

// 같은 uuid 가 두 그룹에 있으면: 기록이 있는 쪽, 더 새 mtime, 더 큰 크기 (Claude 탐색과 같은 생각)
function better(st, prev) {
  if (!prev) return !!st;
  if (!st) return false;
  return st.mtimeMs > prev.mtimeMs || (st.mtimeMs === prev.mtimeMs && st.size > prev.size);
}

/**
 * Walk every cwd group once: session folders (uuid names) with their transcript stat, and the parent of every child
 * named in some `subagents/` folder (first claim wins, in sorted order; a symlinked `subagents` is not a folder).
 * Throws SCAN_CAPPED when a SCAN_LIMITS cap would cut the walk.
 * @returns {Promise<{ sessions: Map<string, { id, file, st }>, parentOf: Map<string, string> }>}
 */
export async function collectSessions(root, limits = SCAN_LIMITS) {
  const base = path.join(root, 'sessions');
  const sessions = new Map();
  const parentOf = new Map();
  let budget = limits.sessions;
  const groups = await subdirs(base, isGroupName, true);
  if (groups.length > limits.groups) throw capped('groups');
  for (const group of groups) {
    for (const id of await subdirs(path.join(base, group), isSessionId)) {
      if (budget-- <= 0) throw capped('sessions');
      const dir = path.join(base, group, id);
      const file = path.join(dir, TRANSCRIPT);
      const st = await lstatIf(file, 'file');
      if (!sessions.has(id) || better(st, sessions.get(id).st)) sessions.set(id, { id, file, st });
      // subagents/ 는 진짜 디렉터리일 때만 연다 (심볼릭 링크면 readdir 이 따라가므로 lstat 으로 먼저 본다)
      const sub = path.join(dir, 'subagents');
      const children = (await lstatIf(sub, 'dir')) ? await subdirs(sub, isSessionId) : [];
      if (children.length > limits.children) throw capped('children');
      for (const child of children) if (child !== id && !parentOf.has(child)) parentOf.set(child, id);
    }
  }
  return { sessions, parentOf };
}

// 부모 사슬 [바로 위 부모, ..., 최상위 메인]. 메인이면 []. 순환이거나 너무 깊으면 null (연결을 믿지 않고 메인으로 본다).
export function ancestorsOf(id, parentOf, depth = SCAN_LIMITS.depth) {
  const chain = [];
  const seen = new Set([id]);
  let cur = parentOf.get(id);
  while (cur !== undefined) {
    if (seen.has(cur) || chain.length >= depth) return null;
    seen.add(cur);
    chain.push(cur);
    cur = parentOf.get(cur);
  }
  return chain;
}

function refOf(s, ancestors) {
  const sub = ancestors.length > 0;
  const charId = charIdOf(s.id);
  const ref = {
    path: s.file, agent: GROK_AGENT, kind: sub ? 'sub' : 'main', charId, stem: charId, sessionId: s.id,
    sid: sub ? charIdOf(ancestors[ancestors.length - 1]) : charId, // sid: 최상위 메인 (층 상속, Runner 의 묶음)
    mtimeMs: s.st.mtimeMs, size: s.st.size, ino: s.st.ino,
  };
  if (sub) ref.parentId = charIdOf(ancestors[0]);
  return ref;
}

/**
 * Pure classification of one walk (exported for tests). A session is reported when its transcript is inside the
 * active window, or when a reported descendant needs it (a parent waiting on its subagent writes nothing). A sub is
 * reported only when every ancestor has a transcript (otherwise it waits, CONTRACT 4.0.1 announce order); a folder no
 * parent names is a main unless `hold(id)` says to wait (LINK_GRACE_MS). Order: mains first, then subs by depth.
 */
export function classify({ sessions, parentOf }, { activeMs, nowMs, hold = () => false, depth = SCAN_LIMITS.depth } = {}) {
  const windowed = Number.isFinite(activeMs) && Number.isFinite(nowMs);
  const active = (s) => !!s?.st && (!windowed || s.st.mtimeMs >= nowMs - activeMs);
  const picked = new Map(); // id -> ancestors
  for (const s of sessions.values()) {
    if (!active(s)) continue;
    const chain = ancestorsOf(s.id, parentOf, depth);
    if (chain === null || chain.length === 0) {
      if (!hold(s.id)) picked.set(s.id, []);
      continue;
    }
    if (!chain.every((a) => sessions.get(a)?.st)) continue; // 부모 기록이 아직 없다: 기다린다
    picked.set(s.id, chain);
    chain.forEach((a, i) => picked.set(a, chain.slice(i + 1))); // 일하는 자식의 조상은 창 밖이어도 붙인다
  }
  return [...picked.entries()]
    .sort((a, b) => a[1].length - b[1].length || (a[0] < b[0] ? -1 : 1))
    .map(([id, chain]) => refOf(sessions.get(id), chain));
}

/** One stateless scan (no link grace): FileRef[] for the Runner. */
export async function scanGrok(root, { activeMs, nowMs, limits = SCAN_LIMITS } = {}) {
  return classify(await collectSessions(root, limits), { activeMs, nowMs, depth: limits.depth });
}

/**
 * The Runner's scan for one Grok root: like scanGrok, plus the link grace for folders that appear after its first
 * scan (they wait `linkGraceMs` from when this scanner first saw them unless a parent names them meanwhile).
 */
export function createGrokScanner({ linkGraceMs = LINK_GRACE_MS, limits = SCAN_LIMITS } = {}) {
  const firstSeen = new Map(); // uuid -> 처음 본 시각 (첫 scan 에서 본 것은 0: 기다리지 않는다)
  let scans = 0;
  return async function scan(root, { activeMs, nowMs } = {}) {
    const walk = await collectSessions(root, limits);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const first = scans++ === 0;
    for (const id of walk.sessions.keys()) if (!firstSeen.has(id)) firstSeen.set(id, first ? 0 : now);
    for (const id of [...firstSeen.keys()]) if (!walk.sessions.has(id)) firstSeen.delete(id);
    const hold = (id) => {
      const t = firstSeen.get(id) ?? 0;
      return t > 0 && now - t < linkGraceMs;
    };
    return classify(walk, { activeMs, nowMs, hold, depth: limits.depth });
  };
}
