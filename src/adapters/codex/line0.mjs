// Codex rollout 의 첫 줄 (session_meta) 만 읽어 탐색에 필요한 사실을 꺼낸다 (ADAPTERS 3.4, 5.1, 7.1, CONTRACT 4.0.2).
// 첫 줄은 크기 상한(기본 256 KB) 안에서만 읽고, 그 뒤의 바이트는 읽지 않는다. 꺼내는 것은 스레드 id, 종류(메인, 서브,
// guardian), 바로 위 부모, cwd, git branch, cli_version, subagent_history_start_ordinal, 서브의 역할 이름뿐이다.
// 계정 id (creator_user_id, creator_account_id), session_id, originator, base_instructions 같은 다른 필드는 남기지 않는다.
// rollout 은 덧붙이기만 하는 파일이라 같은 inode 이고 크기가 첫 줄 끝보다 작지 않으면 첫 줄은 그대로다: 경로 + inode +
// 첫 줄 길이로 캐시한다.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';

/** Size cap of line 0 (session_meta): a longer first line is not parsed and the file is not reported. */
export const LINE0_MAX_BYTES = 256 * 1024;
const CHUNK = 64 * 1024;
const NL = 0x0a;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 4096) => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);
const uuidOf = (v) => (isUuid(v) ? v.toLowerCase() : null);

/**
 * Read line 0 of a regular file within `max` bytes. The file is opened with O_NOFOLLOW and must be the file that was
 * lstat-ed (`st`: same inode and device). Returns { line: Buffer, end } (end = bytes of line 0 with its newline),
 * { pending: true } when the first line is not complete yet (no newline and the file is shorter than the cap),
 * { over: true } when line 0 is longer than the cap, or null when the file cannot be read (gone, swapped, not regular).
 */
export async function readLine0(file, st, max = LINE0_MAX_BYTES) {
  let fh = null;
  try {
    fh = await fsp.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
    const now = await fh.stat();
    if (!now.isFile() || (st && (now.ino !== st.ino || now.dev !== st.dev))) return null;
    const parts = [];
    let n = 0;
    while (n < max) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, max - n));
      const { bytesRead } = await fh.read(buf, 0, buf.length, n);
      if (!bytesRead) return { pending: true }; // 첫 줄이 아직 다 쓰이지 않았다 (다음 rescan 에 다시)
      const nl = buf.subarray(0, bytesRead).indexOf(NL);
      if (nl >= 0) {
        parts.push(buf.subarray(0, nl));
        return { line: Buffer.concat(parts), end: n + nl + 1 };
      }
      parts.push(buf.subarray(0, bytesRead));
      n += bytesRead;
    }
    return { over: true };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * session_meta line -> the scan facts, or null when the line is not a session_meta of the thread `uuid` (the
 * filename's first uuid). Pure (exported for tests).
 * @returns {{ id: string, guardian: boolean, review: boolean, parent: string|null, cwd: string|null,
 *   branch: string|null, cliVersion: string|null, historyStart: number|null, agentType: string|null, ordinal: number|null }|null}
 */
export function factsOf(rec, uuid) {
  if (!isObj(rec) || rec.type !== 'session_meta' || !isObj(rec.payload)) return null;
  const p = rec.payload;
  const id = uuidOf(p.id);
  if (!id || (uuid && id !== String(uuid).toLowerCase())) return null; // 파일 이름의 스레드와 다르다: 믿지 않는다
  const sub = isObj(p.source) ? p.source.subagent : undefined;
  const spawn = isObj(sub) && isObj(sub.thread_spawn) ? sub.thread_spawn : null;
  // D10(a): 자동 승인 검토기. thread_source 가 아니라 source.subagent.other 로 가린다 (research: 2171 files)
  const guardian = isObj(sub) && sub.other === 'guardian';
  const review = sub === 'review'; // D10(d): /review 스레드는 보통 서브에이전트
  // 바로 위 부모: thread_spawn.parent_thread_id, 없으면 payload.parent_thread_id (같은 값, 951/951). 서브 출처가 아니면 메인
  const parent = sub === undefined || sub === null ? null : (uuidOf(spawn?.parent_thread_id) ?? uuidOf(p.parent_thread_id));
  const hs = p.subagent_history_start_ordinal;
  const cwd = str(p.cwd);
  return {
    id, guardian, review,
    parent: parent && parent !== id ? parent : null,
    cwd: cwd && (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)) ? cwd : null,
    branch: isObj(p.git) ? str(p.git.branch, 256) : null,
    cliVersion: str(p.cli_version, 64),
    historyStart: Number.isSafeInteger(hs) && hs >= 0 ? hs : null,
    agentType: str(spawn?.agent_role, 128) ?? str(p.agent_role, 128),
    ordinal: Number.isSafeInteger(rec.ordinal) && rec.ordinal >= 0 ? rec.ordinal : null,
  };
}

/**
 * Line-0 facts per file, read once: keyed by path, valid while the inode is the same and the file is not shorter than
 * line 0 (append-only). `get` returns the facts, null (not a usable rollout: unreadable, over the cap, not a
 * session_meta of that thread) or undefined (line 0 not complete yet: ask again on a later rescan).
 */
export class Line0Cache {
  constructor({ maxBytes = LINE0_MAX_BYTES, maxEntries = 100_000, read = readLine0 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.read = read;
    this.map = new Map(); // path -> { ino, end, facts }
    this.reads = 0; // 실제로 연 횟수 (테스트용)
    this.over = 0; // 상한을 넘은 첫 줄
  }

  async get(file, st, uuid) {
    const hit = this.map.get(file);
    if (hit && hit.ino === st.ino && st.size >= hit.end) return hit.facts;
    this.reads += 1;
    const res = await this.read(file, st, this.maxBytes);
    if (res?.pending) return undefined;
    let facts = null;
    if (res?.line) {
      try {
        facts = factsOf(JSON.parse(res.line.toString('utf8')), uuid);
      } catch {
        facts = null;
      }
    } else if (res?.over) {
      this.over += 1;
    }
    if (!res) return null; // 열 수 없었다 (사라짐, 바뀜): 기억하지 않는다
    this.map.delete(file);
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value);
    this.map.set(file, { ino: st.ino, end: res.end ?? this.maxBytes, facts });
    return facts;
  }

  /** Forget every path not in `keep` (a Set of paths seen by the last full walk). */
  prune(keep) {
    for (const p of [...this.map.keys()]) if (!keep.has(p)) this.map.delete(p);
  }
}
