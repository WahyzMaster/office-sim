// 스키마 없는 protobuf wire format 읽기 (Antigravity 요약 파일, ADAPTERS 5.3, docs/research/antigravity-format.json).
// 필드 번호의 뜻은 이 파일이 모른다: 호출하는 쪽(meta.mjs)이 정해진 경로(1 -> 2 -> 9 -> 1 같은)로만 내려간다. 바이트 덩어리를
// "메시지처럼 풀리면 메시지" 로 추측하지 않는다 (제목 글자가 우연히 메시지 모양이어도 잘못 풀지 않게).
//
// 안전 규칙: 절대 던지지 않는다. 입력 밖을 읽지 않는다 (길이 필드는 남은 바이트와 비교하고, 복사 대신 subarray 로 입력 안의
// 범위만 돌려준다. 길이 값으로 메모리를 잡지 않는다). varint 는 10 바이트까지, 필드 수와 깊이와 입력 크기에 상한이 있다.
// 잘못된 곳을 만나면 그 앞까지 읽은 필드만 돌려준다 (complete: false). 잘린 입력의 결과는 온전한 입력 결과의 앞부분이다.
//
// Wire types: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. 3/4 (groups, deprecated) and 6/7 stop the read.

/** Bounds of one read: input size, fields per message, path depth. */
export const PROTO_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxFields: 100_000, maxDepth: 16 });

export const WIRE = Object.freeze({ VARINT: 0, I64: 1, LEN: 2, I32: 5 });

const MAX_VARINT_BYTES = 10;

const isBuf = (b) => b instanceof Uint8Array;

/**
 * One varint at `pos`: { value, next }. `value` is a Number, or null when it does not fit a safe integer (the bytes are
 * still consumed). Returns null when the varint is cut off by the end of `buf` or runs past 10 bytes.
 */
export function readVarint(buf, pos) {
  if (!isBuf(buf) || !Number.isInteger(pos) || pos < 0) return null;
  let value = 0;
  let scale = 1;
  let safe = true;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    if (safe) {
      value += (b & 0x7f) * scale;
      if (value > Number.MAX_SAFE_INTEGER) safe = false;
      scale *= 128;
    }
    if ((b & 0x80) === 0) return { value: safe ? value : null, next: pos + i + 1 };
  }
  return null;
}

/**
 * The fields of one message, flat (nested messages are not decoded here):
 * { fields: [{ no, wire, value }], complete }. `value` is a Number|null for a varint and a Buffer view into `buf` for the
 * other wire types (never a copy, never past the end). `complete` is false when the read stopped early: a cut-off or
 * oversized field, a field number 0, a group or unknown wire type, more than `maxFields` fields, or an input over
 * `maxBytes` (then nothing is read). Never throws.
 */
export function readFields(buf, { maxFields = PROTO_LIMITS.maxFields, maxBytes = PROTO_LIMITS.maxBytes } = {}) {
  const fields = [];
  if (!isBuf(buf)) return { fields, complete: false };
  if (buf.length > maxBytes) return { fields, complete: false };
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  let pos = 0;
  while (pos < view.length) {
    if (fields.length >= maxFields) return { fields, complete: false };
    const tag = readVarint(view, pos);
    if (!tag || tag.value === null) return { fields, complete: false };
    const no = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (no < 1) return { fields, complete: false };
    pos = tag.next;
    if (wire === WIRE.VARINT) {
      const v = readVarint(view, pos);
      if (!v) return { fields, complete: false };
      fields.push({ no, wire, value: v.value });
      pos = v.next;
    } else if (wire === WIRE.LEN) {
      const len = readVarint(view, pos);
      if (!len || len.value === null || len.value > view.length - len.next) return { fields, complete: false };
      fields.push({ no, wire, value: view.subarray(len.next, len.next + len.value) });
      pos = len.next + len.value;
    } else if (wire === WIRE.I64 || wire === WIRE.I32) {
      const size = wire === WIRE.I64 ? 8 : 4;
      if (size > view.length - pos) return { fields, complete: false };
      fields.push({ no, wire, value: view.subarray(pos, pos + size) });
      pos += size;
    } else {
      return { fields, complete: false }; // 3/4 group, 6/7: not read
    }
  }
  return { fields, complete: true };
}

/** The first field `no` of a field list with that wire type, or null. */
export function firstField(fields, no, wire) {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) if (f && f.no === no && f.wire === wire) return f;
  return null;
}

/** Every field `no` with that wire type, in order. */
export function allFields(fields, no, wire) {
  return Array.isArray(fields) ? fields.filter((f) => f && f.no === no && f.wire === wire) : [];
}

/**
 * Walk a fixed path of length-delimited field numbers from `buf` (the first match at each level) and return the bytes
 * there, or null. A path longer than `maxDepth` is refused (null), so a deeply nested input costs nothing.
 */
export function bytesAt(buf, path, { maxDepth = PROTO_LIMITS.maxDepth, maxFields = PROTO_LIMITS.maxFields } = {}) {
  if (!isBuf(buf) || !Array.isArray(path) || path.length > maxDepth) return null;
  let cur = buf;
  for (const no of path) {
    if (!Number.isInteger(no) || no < 1) return null;
    const f = firstField(readFields(cur, { maxFields }).fields, no, WIRE.LEN);
    if (!f) return null;
    cur = f.value;
  }
  return cur;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
// C0 제어 문자 (탭, 줄바꿈 말고)와 DEL: 글자 필드가 아니라 다른 바이트로 본다
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * A length-delimited value read as text: valid UTF-8 (strict), non-empty, at most `maxChars` code units, without control
 * characters other than tab and line breaks. Anything else -> null.
 */
export function textOf(bytes, maxChars = 4096) {
  if (!isBuf(bytes) || bytes.length === 0 || bytes.length > maxChars * 4) return null;
  let s;
  try {
    s = UTF8.decode(bytes);
  } catch {
    return null;
  }
  if (s.length > maxChars || CONTROL_RE.test(s)) return null;
  return s;
}

/** A varint field value as a small non-negative integer (<= 2^31), else null. */
export function smallIntOf(field) {
  const v = field?.wire === WIRE.VARINT ? field.value : null;
  return Number.isInteger(v) && v >= 0 && v <= 0x7fffffff ? v : null;
}
