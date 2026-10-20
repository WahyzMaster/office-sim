// SidecarWatcher (ADAPTERS 3.3): 통째로 다시 쓰이는 작은 메타 파일(Grok summary.json 등)을 rescan 때마다 stat 하고,
// mtime / 크기 / inode 가 바뀐 것만 다시 읽어 세션의 setInfo() 에 넘길 정보로 바꾼다. 기록(JSONL)은 Tailer 가 읽고,
// 이것은 어댑터가 선언한 파일만 본다. 1 MB 를 넘는 파일, 읽을 수 없는 파일, 해석 오류는 조용히 건너뛴다. 링크는 따라가지
// 않는다 (허용 목록 밖의 파일을 메타 파일인 척 읽지 않게): O_NOFOLLOW 로 열고 lstat 한 그 파일(inode, 장치)인지 다시 본다.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';

/** Size cap of one sidecar file: a larger file is not opened. */
export const SIDECAR_MAX_BYTES = 1024 * 1024;

// 일반 파일의 stat (lstat: 링크는 따라가지 않는다). 없거나 일반 파일이 아니거나 읽을 수 없으면 null.
async function fileStat(p) {
  try {
    const st = await fsp.lstat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// 최대 max 바이트까지 읽는다. 그보다 길면 (stat 뒤에 자랐으면), 또는 lstat 한 파일이 아니면 null.
async function readCapped(p, max, st) {
  let fh = null;
  try {
    fh = await fsp.open(p, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
    const now = await fh.stat();
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    while (n <= max) {
      const { bytesRead } = await fh.read(buf, n, max + 1 - n, n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    return n > max ? null : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export class SidecarWatcher {
  /**
   * @param {(ref: object) => Array<{ path: string, parse: (buf: Buffer) => object|null }>} list  the adapter hook
   *   (descriptor `sidecars(ref)`): the metadata files of one transcript and how to turn each into setInfo() fields.
   * @param {{ maxBytes?: number }} [o]
   */
  constructor(list, { maxBytes = SIDECAR_MAX_BYTES } = {}) {
    this.list = list;
    this.maxBytes = maxBytes;
    this.seen = new Map(); // transcript path -> Map(sidecar path -> 'ino:size:mtimeMs')
  }

  /**
   * Stat the sidecars of `ref`; re-read only the ones whose inode, size or mtime changed since the last check (the
   * first check reads every one that exists). Returns the merged fields of the files read now, or null when nothing
   * changed or nothing usable was read. Never throws.
   */
  async check(ref) {
    let specs;
    try {
      specs = this.list(ref);
    } catch {
      return null;
    }
    if (!Array.isArray(specs) || !specs.length || typeof ref?.path !== 'string') return null;
    let sigs = this.seen.get(ref.path);
    if (!sigs) this.seen.set(ref.path, (sigs = new Map()));
    let info = null;
    for (const spec of specs) {
      if (!spec || typeof spec.path !== 'string' || typeof spec.parse !== 'function') continue;
      const st = await fileStat(spec.path);
      const sig = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null;
      if (sig === (sigs.get(spec.path) ?? null)) continue; // 그대로다: 다시 읽지 않는다
      if (sig === null) {
        sigs.delete(spec.path); // 사라졌다: 다시 생기면 그때 읽는다 (이미 넘긴 정보는 그대로 둔다)
        continue;
      }
      sigs.set(spec.path, sig); // 해석에 실패해도 기록한다: 바뀔 때까지 다시 읽지 않는다
      if (st.size > this.maxBytes) continue;
      const buf = await readCapped(spec.path, this.maxBytes, st);
      if (!buf) continue;
      let got = null;
      try {
        got = spec.parse(buf);
      } catch {
        got = null;
      }
      if (got && typeof got === 'object' && !Array.isArray(got)) info = { ...info, ...got };
    }
    return info;
  }

  /** Drop what was remembered for a transcript (detached or moved). */
  forget(key) {
    this.seen.delete(key);
  }
}
