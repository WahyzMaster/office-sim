// Codex 스레드 제목 (ADAPTERS 3.3, 5.1, 6.1): <root>/session_index.jsonl 의 thread_name. 줄 모양은
// { id, thread_name, updated_at } 이고 덧붙이기만 하는 색인이라 같은 id 는 마지막 줄이 이긴다. 커질 수 있으므로 통째로 다시
// 읽지 않는다: 읽은 위치(offset)를 기억하고 새로 붙은 바이트만, 한 번에 상한(1 MB)까지 읽는다. 파일이 바뀌면 (inode 가
// 다르거나 짧아졌으면) 처음부터 다시 읽는다. 링크는 따라가지 않는다 (lstat + O_NOFOLLOW + 같은 inode 확인, sidecar.mjs 와 같다).
// id 와 thread_name 말고는 아무것도 남기지 않는다. CodexTitles 는 Runner 의 메타 파일 감시자 자리 (deps.sidecarWatcher:
// check(ref), forget(path)) 에 들어가 세션마다 바뀐 제목만 setInfo({ title }) 로 넘긴다. 제목이 없으면 세션이 첫 사람 입력을 쓴다.
import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from './line0.mjs';

export const INDEX_FILE = 'session_index.jsonl';
/** Bytes read from the index per refresh at most (the rest waits for the next refresh). */
export const INDEX_READ_BYTES = 1024 * 1024;
/** A longer index line is skipped whole. */
export const INDEX_LINE_BYTES = 64 * 1024;
/** Titles kept at most (the oldest updated id is dropped first). */
export const INDEX_MAX_IDS = 100_000;
/** Checks closer together than this share one refresh (one read per rescan, not one per session). */
export const TITLE_REFRESH_MS = 250;
const MAX_NAME = 1000; // 이보다 긴 thread_name 은 제목이 아니다 (조사: 10-78자)
const NL = 0x0a;

/** One parsed index line -> [uuid (lowercase), thread_name] or null. Pure. */
export function indexEntry(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !isUuid(obj.id)) return null;
  const name = obj.thread_name;
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME) return null;
  return [obj.id.toLowerCase(), name];
}

/** Incremental reader of one session_index.jsonl. */
export class SessionIndex {
  constructor(file, { maxRead = INDEX_READ_BYTES, maxLine = INDEX_LINE_BYTES, maxIds = INDEX_MAX_IDS } = {}) {
    this.file = file;
    this.maxRead = maxRead;
    this.maxLine = maxLine;
    this.maxIds = maxIds;
    this.titles = new Map(); // uuid -> thread_name (마지막 줄이 이긴다)
    this.reset(null);
    this.lastAt = -Infinity;
    this.inflight = null;
    this.reads = 0; // 실제로 읽은 횟수 (테스트용)
  }

  reset(st) {
    this.ino = st?.ino ?? null;
    this.dev = st?.dev ?? null;
    this.offset = 0;
    this.carry = []; // 아직 줄바꿈이 오지 않은 마지막 줄 조각
    this.carryLen = 0;
    this.skipping = false; // 상한을 넘은 줄: 다음 줄바꿈까지 버린다
    this.titles.clear();
  }

  get(uuid) {
    return typeof uuid === 'string' ? (this.titles.get(uuid.toLowerCase()) ?? null) : null;
  }

  /** Refresh unless one ran within `gapMs` (a running one is awaited). Never throws. */
  refreshSoon(gapMs = TITLE_REFRESH_MS, now = Date.now()) {
    if (this.inflight) return this.inflight;
    if (now - this.lastAt < gapMs) return Promise.resolve(false);
    this.inflight = this.refresh().catch(() => false).finally(() => {
      this.lastAt = Date.now();
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Read what was appended since the last refresh (up to maxRead bytes). Returns true when bytes were read. */
  async refresh() {
    let st;
    try {
      st = await fsp.lstat(this.file);
    } catch {
      return false; // 없다: 이미 아는 제목은 그대로 둔다
    }
    if (!st.isFile()) return false;
    if (st.ino !== this.ino || st.dev !== this.dev || st.size < this.offset) this.reset(st); // 다시 쓴 파일: 처음부터
    if (st.size === this.offset) return false;
    let fh = null;
    try {
      fh = await fsp.open(this.file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
      const now = await fh.stat();
      if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return false;
      const len = Math.min(now.size, this.offset + this.maxRead) - this.offset;
      if (len <= 0) return false;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.offset);
      this.reads += 1;
      this.consume(buf.subarray(0, bytesRead));
      this.offset += bytesRead;
      return bytesRead > 0;
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  consume(buf) {
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NL, start);
      const piece = buf.subarray(start, nl < 0 ? buf.length : nl);
      if (!this.skipping) {
        if (this.carryLen + piece.length > this.maxLine) {
          this.skipping = true;
          this.carry = [];
          this.carryLen = 0;
        } else if (piece.length) {
          this.carry.push(piece);
          this.carryLen += piece.length;
        }
      }
      if (nl < 0) return;
      if (!this.skipping && this.carryLen) this.line(Buffer.concat(this.carry, this.carryLen));
      this.carry = [];
      this.carryLen = 0;
      this.skipping = false;
      start = nl + 1;
    }
  }

  line(bytes) {
    let entry = null;
    try {
      entry = indexEntry(JSON.parse(bytes.toString('utf8')));
    } catch {
      entry = null;
    }
    if (!entry) return;
    const [id, name] = entry;
    this.titles.delete(id); // 다시 넣어 가장 새 것으로 (상한을 넘으면 가장 오래된 것부터 버린다)
    if (this.titles.size >= this.maxIds) this.titles.delete(this.titles.keys().next().value);
    this.titles.set(id, name);
  }
}

// <root>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl -> <root>/session_index.jsonl (탐색이 받는 배치만), 아니면 null
export function indexPathOf(transcript) {
  if (typeof transcript !== 'string' || transcript === '') return null;
  const sessions = path.resolve(path.dirname(transcript), '..', '..', '..');
  return path.basename(sessions) === 'sessions' ? path.join(path.dirname(sessions), INDEX_FILE) : null;
}

/**
 * The Runner's metadata watcher for Codex (check(ref) / forget(path), like SidecarWatcher): the title of each session
 * from its root's session_index.jsonl, handed over only when it changed for that transcript.
 */
export class CodexTitles {
  constructor({ refreshMs = TITLE_REFRESH_MS, ...indexOpts } = {}) {
    this.refreshMs = refreshMs;
    this.indexOpts = indexOpts;
    this.indexes = new Map(); // index path -> SessionIndex (루트마다 하나)
    this.given = new Map(); // transcript path -> 넘긴 제목
  }

  indexFor(ref) {
    const file = indexPathOf(ref?.path);
    if (!file) return null;
    let idx = this.indexes.get(file);
    if (!idx) this.indexes.set(file, (idx = new SessionIndex(file, this.indexOpts)));
    return idx;
  }

  /** { title } when the session's thread_name is new or changed for this transcript, else null. Never throws. */
  async check(ref) {
    const uuid = typeof ref?.sessionId === 'string' && isUuid(ref.sessionId) ? ref.sessionId.toLowerCase() : null;
    const idx = uuid ? this.indexFor(ref) : null;
    if (!idx) return null;
    await idx.refreshSoon(this.refreshMs);
    const title = idx.get(uuid);
    if (!title || this.given.get(ref.path) === title) return null;
    this.given.set(ref.path, title);
    return { title };
  }

  /** Forget what was handed to a transcript (detached, moved or attached again). */
  forget(key) {
    this.given.delete(key);
  }
}
