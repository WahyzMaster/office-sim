// Per-file byte-offset tailer with a partial-line buffer (contract 3.6, rules R6/R7).
//
// - Splits on the '\n' byte and decodes whole lines, so multi-byte UTF-8 characters can straddle chunks.
// - A trailing partial line is carried across chunks and polls until its newline arrives.
// - Lines longer than maxLineBytes are skipped and counted once (when the limit is crossed), never buffered whole.
// - State is committed per chunk: if onLine throws, the error propagates and the next read restarts at the last
//   committed chunk (the caller dedupes by uuid, so re-delivered lines are harmless).
// - One read per path at a time: poll() during a running read returns { bytes: 0, busy: true } instead of
//   waiting; readAll() waits for a running read; forget() stops a running read at the next chunk boundary.
// - noFollow (opt-in, the Antigravity deps; off by default, so Claude, Codex and Grok read as before): readAll() opens
//   with O_NOFOLLOW and attaches only the regular file the scan lstat-ed (ref.ino when the ref has one); a link or
//   another file at the path is `gone`. poll() needs no change: it only reads the inode readAll() attached.
// - Both opens add O_NONBLOCK: a FIFO put at the path (before an attach, or between poll's stat and open) would block
//   open(2) with no writer and hang the read. Regular-file reads do not change; a FIFO opens at once and reads
//   nothing (size 0, another inode: reset; noFollow: not a regular file, gone).

import { constants as FS } from 'node:fs';
import fsp from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

const NL = 0x0a;
const READ = FS.O_RDONLY | (FS.O_NONBLOCK ?? 0);

function isThenable(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

function pathOf(ref) {
  return typeof ref === 'string' ? ref : ref?.path;
}

/**
 * Split one chunk into complete lines, carrying the partial line in `carry` ({ parts, partLen, skipping }).
 * Mutates `carry`; returns { lines: string[], skipped: number }.
 */
export function splitChunk(carry, buf, maxLineBytes) {
  const lines = [];
  let skipped = 0;
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(NL, start);
    if (nl === -1) break;
    const seg = buf.subarray(start, nl);
    if (carry.skipping) {
      carry.skipping = false;
    } else if (carry.partLen + seg.length > maxLineBytes) {
      skipped += 1;
    } else if (carry.partLen === 0) {
      lines.push(seg.toString('utf8'));
    } else {
      carry.parts.push(seg);
      lines.push(Buffer.concat(carry.parts, carry.partLen + seg.length).toString('utf8'));
    }
    carry.parts = [];
    carry.partLen = 0;
    start = nl + 1;
  }
  if (start < buf.length && !carry.skipping) {
    const rest = buf.subarray(start);
    if (carry.partLen + rest.length > maxLineBytes) {
      carry.skipping = true;
      carry.parts = [];
      carry.partLen = 0;
      skipped += 1;
    } else {
      carry.parts.push(Buffer.from(rest)); // copy: do not pin the whole read buffer
      carry.partLen += rest.length;
    }
  }
  return { lines, skipped };
}

export class Tailer {
  #maxLineBytes;
  #chunkBytes;
  #noFollow;
  #files = new Map(); // path -> { offset, ino, parts, partLen, skipping, skipped }
  #busy = new Map(); // path -> Promise of the running read
  #custom = new Map(); // path -> custom tailer hooks on ref.facts

  /** Total lines skipped for exceeding maxLineBytes, across all files. */
  skippedLines = 0;

  constructor({ maxLineBytes = 8 * 1024 * 1024, chunkBytes = 4 * 1024 * 1024, noFollow = false } = {}) {
    if (!(Number.isInteger(maxLineBytes) && maxLineBytes > 0)) throw new RangeError('maxLineBytes must be a positive integer');
    if (!(Number.isInteger(chunkBytes) && chunkBytes > 0)) throw new RangeError('chunkBytes must be a positive integer');
    this.#maxLineBytes = maxLineBytes;
    this.#chunkBytes = chunkBytes;
    this.#noFollow = noFollow === true;
  }

  /**
   * Attach: stream the file from byte 0 up to its size at open time, calling onLine(line) per complete line and
   * yielding to the event loop between chunks. Replaces any previous state for the path.
   * `end` stops the replay earlier (e.g. at the size seen when a truncation was detected): the rest is left for poll(),
   * so lines appended after that point are delivered live. A line cut by `end` is completed by the next poll.
   * With noFollow, a path that is a link (ELOOP / EMLINK), not a regular file, or not the inode `ref.ino` is `gone`.
   * @returns {Promise<{ offset: number, skipped: number, gone?: true, forgotten?: true }>}
   */
  async readAll(ref, onLine, { end = Infinity } = {}) {
    const p = pathOf(ref);
    if (typeof ref?.facts?.readAll === 'function') {
      this.#custom.set(p, ref.facts);
      return ref.facts.readAll(ref, onLine, { end });
    }
    while (this.#busy.has(p)) await this.#busy.get(p).catch(() => {});
    return this.#exclusive(p, async () => {
      this.#files.delete(p);
      let fh;
      try {
        fh = await fsp.open(p, this.#noFollow ? READ | (FS.O_NOFOLLOW ?? 0) : READ);
      } catch (err) {
        if (err && err.code === 'ENOENT') return { offset: 0, skipped: 0, gone: true };
        if (this.#noFollow && (err?.code === 'ELOOP' || err?.code === 'EMLINK')) return { offset: 0, skipped: 0, gone: true };
        throw err;
      }
      try {
        const st = await fh.stat();
        if (this.#noFollow && (!st.isFile() || (Number.isSafeInteger(ref?.ino) && st.ino !== ref.ino))) {
          return { offset: 0, skipped: 0, gone: true }; // 탐색이 lstat 한 그 파일이 아니다 (사이에 바뀌었다)
        }
        const state = { offset: 0, ino: st.ino, parts: [], partLen: 0, skipping: false, skipped: 0 };
        this.#files.set(p, state);
        const stop = Number.isFinite(end) && end >= 0 ? Math.min(st.size, end) : st.size;
        const res = await this.#readRange(p, state, fh, stop, onLine);
        return { offset: state.offset, skipped: state.skipped, ...(res.forgotten ? { forgotten: true } : {}) };
      } finally {
        await fh.close().catch(() => {});
      }
    });
  }

  /**
   * Read bytes appended since the last read.
   * @returns {Promise<{ bytes: number, skipped?: number, busy?: true } | { reset: true, size?: number } | { gone: true }>}
   *   reset: not attached, size < offset or inode changed (state dropped; caller re-attaches with readAll).
   *     `size` is the file size seen at that moment (a replay boundary: bytes after it were written later).
   *   gone: the path does not exist right now (state kept; caller decides when to forget).
   */
  async poll(ref, onLine) {
    const p = pathOf(ref);
    if (typeof ref?.facts?.poll === 'function') {
      return ref.facts.poll(ref, onLine);
    }
    if (this.#busy.has(p)) return { bytes: 0, busy: true };
    const state = this.#files.get(p);
    if (!state) return { reset: true };
    return this.#exclusive(p, async () => {
      let st;
      try {
        st = await fsp.stat(p);
      } catch (err) {
        if (err && err.code === 'ENOENT') return { gone: true };
        throw err;
      }
      if (this.#files.get(p) !== state) return { bytes: 0 }; // forgotten meanwhile
      if (st.ino !== state.ino || st.size < state.offset) {
        this.#files.delete(p);
        return { reset: true, size: st.size };
      }
      if (st.size === state.offset) return { bytes: 0 };
      let fh;
      try {
        fh = await fsp.open(p, READ);
      } catch (err) {
        if (err && err.code === 'ENOENT') return { gone: true };
        throw err;
      }
      try {
        const fst = await fh.stat(); // the fd is authoritative: the path may have been replaced since stat()
        if (fst.ino !== state.ino || fst.size < state.offset) {
          if (this.#files.get(p) === state) this.#files.delete(p);
          return { reset: true, size: fst.size };
        }
        const before = state.offset;
        const skippedBefore = state.skipped;
        await this.#readRange(p, state, fh, fst.size, onLine);
        return { bytes: state.offset - before, skipped: state.skipped - skippedBefore };
      } finally {
        await fh.close().catch(() => {});
      }
    });
  }

  /**
   * The file moved (same inode): carry its state (offset, partial line) over to the new path so the next poll
   * continues where the old path stopped. Refused (false) while a read runs on either path, when the new path is
   * already attached, when the inode differs, or when the new file is shorter than the committed offset.
   */
  rename(from, to, { ino, size } = {}) {
    if (this.#custom.has(from)) return false;
    const state = this.#files.get(from);
    if (!state || from === to || this.#files.has(to) || this.#busy.has(from) || this.#busy.has(to)) return false;
    if (state.ino !== ino || !(Number.isFinite(size) && size >= state.offset)) return false;
    this.#files.delete(from);
    this.#files.set(to, state);
    return true;
  }

  /** True while a read runs on the path. */
  isBusy(path) {
    return this.#busy.has(path);
  }

  /** Drop all state for a path (a running read stops at its next chunk boundary). */
  forget(path) {
    const c = this.#custom.get(path);
    if (c) {
      this.#custom.delete(path);
      c.forget?.(path);
    }
    this.#files.delete(path);
  }

  /** Current committed offset for a path, or null when not attached. */
  offsetOf(path) {
    const s = this.#files.get(path);
    return s ? s.offset : null;
  }

  /** Bytes buffered as a partial (unterminated) line for a path, or null when not attached. */
  pendingBytes(path) {
    const s = this.#files.get(path);
    return s ? s.partLen : null;
  }

  /** Lines skipped for exceeding maxLineBytes in one file, or null when not attached. */
  skippedOf(path) {
    const s = this.#files.get(path);
    return s ? s.skipped : null;
  }

  async #exclusive(p, fn) {
    const run = fn();
    this.#busy.set(p, run);
    try {
      return await run;
    } finally {
      if (this.#busy.get(p) === run) this.#busy.delete(p);
    }
  }

  // Read [state.offset, end) in chunks; commit offset + carry after each chunk's lines were delivered.
  async #readRange(p, state, fh, end, onLine) {
    let first = true;
    while (state.offset < end) {
      if (!first) await yieldToLoop();
      first = false;
      if (this.#files.get(p) !== state) return { forgotten: true };
      const len = Math.min(this.#chunkBytes, end - state.offset);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, state.offset);
      if (bytesRead === 0) break; // truncated under us; the next poll sees size < offset
      if (this.#files.get(p) !== state) return { forgotten: true };
      const carry = { parts: state.parts.slice(), partLen: state.partLen, skipping: state.skipping };
      const { lines, skipped } = splitChunk(carry, buf.subarray(0, bytesRead), this.#maxLineBytes);
      for (const line of lines) {
        const r = onLine(line);
        if (isThenable(r)) await r;
      }
      state.parts = carry.parts;
      state.partLen = carry.partLen;
      state.skipping = carry.skipping;
      state.offset += bytesRead;
      state.skipped += skipped;
      this.skippedLines += skipped;
    }
    return {};
  }
}
