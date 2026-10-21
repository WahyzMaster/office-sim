// 기록 관찰 ("기록 관찰", observe-spec): 줄 하나에서 남겨도 되는 것만 꺼내는 순수 함수와 줄 나누기 상태 기계.
// 남기는 문자열은 허용한 필드의 범주 값뿐이고, 모두 VALUE_RE 로 검사한다 (맞지 않으면 "?"). VALUE_RE 에 맞더라도 UUID
// 모양이나 긴 16진 문자열은 "?" 다 (세션 id 가 범주 값 자리에 들어와도 남지 않게, 명세보다 엄격하다). Grok 의 method 는
// '/' 가 들어 있어 VALUE_RE 에 맞지 않으므로, 알려진 두 값만 이 파일의 상수로 그대로 남긴다 (그 밖은 "?").
// 경로, 파일 이름, 세션 id, 제목, 입력, 명령, 도구 이름과 인자, 모델 id, 오류 문구 같은 값은 읽지도 남기지도 않는다.
// I/O 도, 시계도 없다.

/** Every categorical value written must match this (else "?"). */
export const VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Lines longer than this are counted as oversize and never buffered whole. */
export const OBSERVE_LINE_BYTES = 4 * 1024 * 1024;
/** The Grok `method` values written as they are (constants of this file, not file content). */
export const KNOWN_METHODS = Object.freeze(['session/update', '_x.ai/session/update']);
/** The four watched file kinds. */
export const KINDS = Object.freeze(['grok-updates', 'grok-events', 'codex-rollout', 'codex-index']);

const UUID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const HEX_RUN_RE = /[0-9a-f]{16,}/i;
const ERROR_CODE_RE = /^E[A-Z0-9_]{1,31}$/;
const METHODS = new Set(KNOWN_METHODS);
const MAX_TS = 64;
const NL = 0x0a;

/** A categorical value: the string when it passes VALUE_RE and is not id-like, else "?". */
export function catValue(v) {
  if (typeof v !== 'string' || !VALUE_RE.test(v) || UUID_RE.test(v) || HEX_RUN_RE.test(v)) return '?';
  return v;
}

/** An fs error code for an `error` record ("?" when it is not a plain E... code). */
export function errorCode(err) {
  const c = err?.code;
  return typeof c === 'string' && ERROR_CODE_RE.test(c) ? c : '?';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.hasOwn(o, k) && o[k] !== undefined && o[k] !== null;

/**
 * Kind keys of one parsed line ("<field>:<value>"), only from the allowlisted fields; a missing field adds nothing.
 * - grok-updates: method (KNOWN_METHODS else "?"), sessionUpdate (params.update.sessionUpdate)
 * - grok-events: type; phase (phase_changed only); decision (permission_resolved only)
 * - codex-rollout: type, payload.type
 * - codex-index: nothing (its lines are never parsed)
 */
export function lineKinds(kind, rec) {
  if (!isObj(rec)) return [];
  const out = [];
  if (kind === 'grok-updates') {
    if (has(rec, 'method')) out.push(`method:${METHODS.has(rec.method) ? rec.method : '?'}`);
    const u = isObj(rec.params) && isObj(rec.params.update) ? rec.params.update : null;
    if (has(u, 'sessionUpdate')) out.push(`sessionUpdate:${catValue(u.sessionUpdate)}`);
  } else if (kind === 'grok-events') {
    if (has(rec, 'type')) out.push(`type:${catValue(rec.type)}`);
    if (rec.type === 'phase_changed' && has(rec, 'phase')) out.push(`phase:${catValue(rec.phase)}`);
    if (rec.type === 'permission_resolved' && has(rec, 'decision')) out.push(`decision:${catValue(rec.decision)}`);
  } else if (kind === 'codex-rollout') {
    if (has(rec, 'type')) out.push(`type:${catValue(rec.type)}`);
    if (isObj(rec.payload) && has(rec.payload, 'type')) out.push(`payload.type:${catValue(rec.payload.type)}`);
  }
  return out;
}

// ISO 시각 문자열 -> ms, 아니면 null
function isoMs(v) {
  if (typeof v !== 'string' || v === '' || v.length > MAX_TS) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The record time of one parsed line (epoch ms) or null. Grok updates: the top-level `timestamp` (the write time, unix
 * seconds; ms tolerated, like src/adapters/grok/records.mjs), else params._meta.agentTimestampMs (the agent's own clock:
 * ADAPTERS 5.2 found the first tool_call_update after a permission prompt stamped a median 18.8 s before the decision,
 * its `timestamp` at or after it); Grok events: `ts`; Codex rollout: `timestamp` (ISO). A whole-second `timestamp`
 * makes a lag read 0..999 ms long.
 */
export function recordMs(kind, rec) {
  if (!isObj(rec)) return null;
  if (kind === 'grok-updates') {
    const t = rec.timestamp;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
      if (t < 1e11) return Math.round(t * 1000);
      if (t < 1e14) return Math.round(t);
    }
    const a = isObj(rec.params) && isObj(rec.params._meta) ? rec.params._meta.agentTimestampMs : null;
    return typeof a === 'number' && Number.isFinite(a) && a > 1e11 && a < 1e14 ? Math.round(a) : null;
  }
  if (kind === 'grok-events') return isoMs(rec.ts);
  if (kind === 'codex-rollout') return isoMs(rec.timestamp);
  return null;
}

/** Grok events permission marker of one parsed line: 'req' | 'res' | null. */
export function permEvent(rec) {
  if (!isObj(rec)) return null;
  if (rec.type === 'permission_requested') return 'req';
  if (rec.type === 'permission_resolved') return 'res';
  return null;
}

/** The JSON type name of a value. */
export function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'other';
}

// 행 하나의 키 이름 -> 값의 JSON 타입 (여러 행에서 타입이 다르면 정렬해 '|' 로 잇는다). 값은 남기지 않는다.
function addRowKeys(keys, row) {
  for (const [k, v] of Object.entries(row)) {
    const name = catValue(k);
    const type = jsonType(v);
    const prev = keys.get(name);
    if (!prev) keys.set(name, new Set([type]));
    else prev.add(type);
  }
}

/**
 * The shape of active_sessions.json text: { shape: 'array' | 'object' | 'other', rows, keys: { name: type } }.
 * array: rows = elements, keys = the union of the object elements' keys. object: rows = entries, keys = the union of
 * the object values' keys (the top-level keys may be session ids and are never written). Unparsable or anything else:
 * 'other' with rows 0. Never a value.
 */
export function activeShape(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { shape: 'other', rows: 0, keys: {} };
  }
  const keys = new Map();
  let shape = 'other';
  let rows = 0;
  if (Array.isArray(v)) {
    shape = 'array';
    rows = v.length;
    for (const row of v) if (isObj(row)) addRowKeys(keys, row);
  } else if (isObj(v)) {
    shape = 'object';
    const vals = Object.values(v);
    rows = vals.length;
    for (const row of vals) if (isObj(row)) addRowKeys(keys, row);
  }
  const out = {};
  for (const name of [...keys.keys()].sort()) out[name] = [...keys.get(name)].sort().join('|');
  return { shape, rows, keys: out };
}

/**
 * Line framing of one watched file (pure state machine over Buffers). The state lives across appends:
 * - lastNL: the last observed byte was '\n' (a file watched from 0 starts true).
 * - a line longer than maxLine is counted once as oversize when it crosses the limit and never buffered whole.
 * - headless: the line in progress began before the file was watched (its head was never seen): counted when it ends,
 *   never parsed.
 * - buffer false (codex-index): lines are counted and measured only, never buffered.
 * push(buf, onLine) calls onLine(bytes | null) per line completed in buf (null: not parsable here: oversize, headless
 * or unbuffered) and returns { lines, maxLineBytes, oversize } for this buf. maxLineBytes leaves headless lines out.
 */
export class LineFrame {
  constructor({ maxLine = OBSERVE_LINE_BYTES, buffer = true, lastNL = true } = {}) {
    this.maxLine = maxLine;
    this.buffer = buffer;
    this.lastNL = lastNL;
    this.headless = !lastNL;
    this.lineLen = 0; // 지금 줄에서 본 바이트 (버퍼에 담지 않은 것 포함)
    this.parts = [];
    this.partLen = 0;
    this.over = false;
  }

  /** Back to an empty file (a reset): the next byte starts a line. */
  restart() {
    this.lastNL = true;
    this.headless = false;
    this.lineLen = 0;
    this.parts = [];
    this.partLen = 0;
    this.over = false;
  }

  push(buf, onLine) {
    let lines = 0;
    let maxLineBytes = 0;
    let oversize = 0;
    let start = 0;
    while (start <= buf.length) {
      const nl = buf.indexOf(NL, start);
      const end = nl < 0 ? buf.length : nl;
      const len = end - start;
      if (len > 0) {
        if (!this.over && this.lineLen + len > this.maxLine) {
          this.over = true;
          oversize += 1;
          this.parts = [];
          this.partLen = 0;
        }
        if (!this.over && !this.headless && this.buffer) {
          this.parts.push(nl < 0 ? Buffer.from(buf.subarray(start, end)) : buf.subarray(start, end));
          this.partLen += len;
        }
        this.lineLen += len;
      }
      if (nl < 0) {
        if (buf.length > 0) this.lastNL = buf[buf.length - 1] === NL;
        break;
      }
      lines += 1;
      if (!this.headless && this.lineLen > maxLineBytes) maxLineBytes = this.lineLen;
      const parsable = !this.over && !this.headless && this.buffer;
      onLine(parsable ? (this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partLen)) : null);
      this.parts = [];
      this.partLen = 0;
      this.lineLen = 0;
      this.over = false;
      this.headless = false;
      this.lastNL = true;
      start = nl + 1;
    }
    return { lines, maxLineBytes, oversize };
  }
}
