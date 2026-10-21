// 기록 관찰의 Codex 날짜 폴더 훑기 (observe-spec "What is watched"). observer.mjs 가 rescan 마다 부른다.
// - 시작 훑기: 모든 날 폴더의 rollout 을 lstat 해서, 시작 10분 전부터 바뀐 것이 있는 날을 기억한다 (hot).
// - 그 뒤의 rescan: 오늘, 어제, hot 날 폴더만 목록을 읽는다.
// - 30초마다 (Codex 어댑터의 FULL_WALK_MS 와 같다) 모든 날 폴더를 다시 훑는다. 오래된 스레드를 이어 쓰거나 .zst 에서
//   다시 푼 rollout 처럼 시작 뒤에 바뀐 파일이 있는 날을 hot 에 더한다. 그 파일은 그때 크기부터 본다 (late: 시작 뒤에
//   생긴 파일이라도 0 부터 읽지 않는다. 오래된 기록 전체가 한 번의 덧붙이기로 세지지 않게).
// 폴더는 Dirent 로 진짜 폴더만 따라간다 (링크는 따라가지 않는다). 경로는 found 에만 담고 기록에 쓰지 않는다.
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { FULL_WALK_MS } from '../adapters/codex/discover.mjs';
import { TWO_RE, YEAR_RE, nearDays } from './days.mjs';

export { FULL_WALK_MS };
export const INDEX = 'session_index.jsonl';
export const QUIET = new Set(['ENOENT', 'ENOTDIR']); // 없는 것은 오류가 아니다
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

/**
 * Adds the Codex files to look at to `found` (path -> { kind, agent, sessionKey, st?, late? }). `o` is the Observer
 * (its codex root, startMs, recentMs, codexDays, fullWalkAt, fs, now, cancelled, _dir, _isDir, _error).
 */
export async function walkCodex(o, found, initial) {
  found.set(path.join(o.codex, INDEX), { kind: 'codex-index', agent: 'codex', sessionKey: null });
  const sessions = path.join(o.codex, 'sessions');
  if (!(await o._isDir(sessions, 'codex-scan'))) return;
  const near = new Set(nearDays(o.now()));
  if (initial || o.now() - o.fullWalkAt >= FULL_WALK_MS) {
    o.fullWalkAt = o.now();
    const list = (dir) => o._dir(dir, 'codex-scan');
    for (const y of await list(sessions)) {
      if (!y.isDirectory() || !YEAR_RE.test(y.name)) continue;
      for (const m of await list(path.join(sessions, y.name))) {
        if (!m.isDirectory() || !TWO_RE.test(m.name)) continue;
        for (const d of await list(path.join(sessions, y.name, m.name))) {
          if (o.cancelled) return;
          if (d.isDirectory() && TWO_RE.test(d.name)) await codexDay(o, found, `${y.name}/${m.name}/${d.name}`, near, initial);
        }
        await yieldToLoop();
      }
    }
    return;
  }
  for (const key of new Set([...near, ...o.codexDays])) {
    if (o.cancelled) return;
    const [y, m, d] = key.split('/');
    let ok = true;
    for (const dir of [path.join(sessions, y), path.join(sessions, y, m), path.join(sessions, y, m, d)]) {
      if (ok) ok = await o._isDir(dir, 'codex-scan');
    }
    if (ok) await codexDay(o, found, key, near, null);
  }
}

// initial: true = 시작 훑기, false = 30초마다의 전체 훑기, null = 오늘/어제/hot 날만 보는 rescan
async function codexDay(o, found, key, near, initial) {
  const dir = path.join(o.codex, 'sessions', ...key.split('/'));
  const files = [];
  for (const e of await o._dir(dir, 'codex-scan')) {
    if (e.isFile() && ROLLOUT_RE.test(e.name)) files.push(path.join(dir, e.name));
  }
  const hot = near.has(key) || o.codexDays.has(key);
  if (initial === null || (initial === false && hot)) {
    for (const p of files) found.set(p, { kind: 'codex-rollout', agent: 'codex', sessionKey: p });
    return;
  }
  // 시작 훑기는 시작 10분 전부터, 전체 훑기는 시작 뒤에 바뀐 파일이 있으면 그 날을 hot 에 더한다
  const since = initial ? o.startMs - o.recentMs : o.startMs;
  const seen = [];
  let recent = false;
  for (const p of files) {
    try {
      const st = await o.fs.lstat(p);
      seen.push([p, st]);
      if (st.mtimeMs >= since) recent = true;
    } catch (err) {
      if (!QUIET.has(err?.code)) o._error(p, 'codex-rollout', null, err);
    }
  }
  if (recent) o.codexDays.add(key);
  if (!recent && !hot) return;
  for (const [p, st] of seen) found.set(p, { kind: 'codex-rollout', agent: 'codex', sessionKey: p, st, late: initial === false });
}
