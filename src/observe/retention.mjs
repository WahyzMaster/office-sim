// 기록 관찰 결과 폴더의 보관 규칙 (CONTRACT 6.2 "Retention"). 새 관찰 파일을 만든 뒤 가장 새 keep 개만 남긴다 (새 파일 포함).
// 지울 수 있는 것은 출력 폴더 바로 안의, 이름이 FILE_RE 모양이고 lstat 으로 보통 파일인 것뿐이다: 링크, 폴더, 다른 이름,
// 하위 폴더 안의 것, 지금 쓰는 파일은 건드리지 않는다 (링크는 따라가지 않고 세지도 않는다). 순서는 이름의 시각, 그다음
// -n 꼬리 (없으면 1). 오류는 파일마다 세고 넘어간다: 던지지 않고, 경로를 남기지 않는다. signal 이 그만두라고 하면
// 그 뒤로는 아무것도 지우지 않는다 (기다림을 넘긴 단계의 늦은 목록에는 다음 관찰의 파일이 있을 수 있다).
import path from 'node:path';

/** Observation output file names this rule may delete: observe-<YYYYMMDD>-<HHMMSS>[-<n>].jsonl. */
export const FILE_RE = /^observe-(\d{8})-(\d{6})(?:-(\d{1,2}))?\.jsonl$/;

/** { stamp: 'YYYYMMDDHHMMSS', n } of an output file name, or null when the name is not one. */
export function fileKey(name) {
  const m = typeof name === 'string' ? FILE_RE.exec(name) : null;
  return m ? { stamp: m[1] + m[2], n: m[3] === undefined ? 1 : Number(m[3]) } : null;
}

// 새 것이 먼저 (시각, 꼬리, 그다음 이름: 같은 꼬리 값의 '-02' 와 '-2' 도 늘 같은 차례)
function newestFirst(a, b) {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? 1 : -1;
  if (a.n !== b.n) return b.n - a.n;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/**
 * Keep the `keep` newest observation files of `dir`, counting `current` (the running file, never deleted).
 * fsImpl: node:fs/promises or a stand-in (readdir, lstat, unlink). signal: an AbortSignal; once it is aborted the pass
 * stops before its next lstat or unlink and deletes nothing more. Never throws.
 * Returns { removed, failed }: files deleted and per-file errors (readdir, lstat or unlink) skipped.
 */
export async function pruneOutputs({ dir, current, keep, fsImpl, signal = null }) {
  const out = { removed: 0, failed: 0 };
  let names;
  try {
    names = await fsImpl.readdir(dir);
  } catch {
    out.failed += 1;
    return out;
  }
  const found = [];
  for (const name of Array.isArray(names) ? names : []) {
    const key = name === current ? null : fileKey(name);
    if (!key) continue;
    if (signal?.aborted) return out;
    try {
      const st = await fsImpl.lstat(path.join(dir, name));
      if (st.isFile()) found.push({ name, ...key });
    } catch {
      out.failed += 1;
    }
  }
  found.sort(newestFirst);
  for (const { name } of found.slice(Math.max(0, keep - 1))) {
    if (signal?.aborted) return out;
    try {
      await fsImpl.unlink(path.join(dir, name)); // unlink 은 링크를 따라가지 않고, 폴더는 지우지 못한다
      out.removed += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
