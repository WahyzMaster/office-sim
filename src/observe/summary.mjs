// 기록 관찰의 집계 (observe-spec "Checklist", "summary" 기록). 관찰 기록(JSONL 의 객체)을 하나씩 더하는 Tally 와,
// 그 위의 summarize(records) / progress(counts, agents). 순수하다: I/O 도 시계도 없고, 기록에 든 숫자와 범주 값만 쓴다.
// Grok 권한 대기 짝짓기: grok-events 덧붙이기 기록의 perm 목록(줄 순서)을 세션마다 FIFO 로 짝짓는다. 요청을 본 덧붙이기의
// t 부터 같은 세션의 결정을 본 덧붙이기의 t 까지가 대기 시간이다 (관찰한 시각끼리의 차이, 100 ms 단위로 거칠다).
// 같은 세션의 updates.jsonl 에서 tool_call 이 든 마지막 덧붙이기부터 요청을 본 때까지도 함께 잰다.

/** Checklist items (ids on the wire; Korean labels live on the page). */
export const CHECKLIST = Object.freeze([
  Object.freeze({ id: 'grok-updates', agent: 'grok', need: 20 }),
  Object.freeze({ id: 'grok-wait', agent: 'grok', need: 1 }),
  Object.freeze({ id: 'grok-active', agent: 'grok', need: 1 }),
  Object.freeze({ id: 'codex-rollout', agent: 'codex', need: 20 }),
]);
/** A permission wait counts for grok-wait when its observed gap is at least this. */
export const WAIT_MIN_MS = 1000;
/** Values kept per distribution at most (the max and the count stay exact past it). */
export const SAMPLE_CAP = 200_000;

const AGENT_KINDS = Object.freeze({ grok: ['grok-updates', 'grok-events'], codex: ['codex-rollout', 'codex-index'] });
const BUCKETS = Object.freeze(['0', '1', '2', '3-5', '6+']);
const bucketOf = (n) => (n <= 2 ? String(n) : n <= 5 ? '3-5' : '6+');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/**
 * The checklist for counts { 'grok-updates', 'grok-wait', 'grok-active', 'codex-rollout' } and agents { grok, codex }.
 * An item of a disabled agent is off (have 0, done false) and does not block ready; ready = at least one item is on
 * and every on item is done. Returns { checklist: [{ id, have, need, done, off }], ready }.
 */
export function progress(counts = {}, agents = {}) {
  const checklist = CHECKLIST.map(({ id, agent, need }) => {
    const off = agents?.[agent] !== true;
    const have = off ? 0 : count(counts?.[id]);
    return { id, have, need, done: !off && have >= need, off };
  });
  const on = checklist.filter((i) => !i.off);
  return { checklist, ready: on.length > 0 && on.every((i) => i.done) };
}

// 분포 하나: 값은 SAMPLE_CAP 개까지, 개수와 최댓값은 끝까지 정확하다
class Samples {
  constructor() {
    this.values = [];
    this.n = 0;
    this.max = null;
  }

  push(v) {
    const x = num(v);
    if (x === null) return;
    this.n += 1;
    if (this.max === null || x > this.max) this.max = x;
    if (this.values.length < SAMPLE_CAP) this.values.push(x);
  }

  /** { n, p50, p90, max } (nearest rank), or null when empty. */
  stats() {
    if (!this.n) return null;
    const s = [...this.values].sort((a, b) => a - b);
    const at = (q) => s[Math.max(0, Math.ceil(q * s.length) - 1)];
    return { n: this.n, p50: at(0.5), p90: at(0.9), max: this.max };
  }
}

function kindStats() {
  return {
    files: 0, appends: 0, bytes: new Samples(), lines: 0, linesPerAppend: Object.fromEntries(BUCKETS.map((b) => [b, 0])),
    partialTail: 0, midLineStart: 0, lagMin: new Samples(), lagMax: new Samples(), resets: 0, gone: 0, bad: 0,
    oversize: 0, values: new Map(),
  };
}

/**
 * Incremental tally of observation records (start, file, append, active, error; summary records are ignored).
 * add(record) never throws on odd input (a record of an unknown file or type is skipped).
 */
export class Tally {
  constructor() {
    this.agents = { grok: false, codex: false };
    this.files = new Map(); // f# -> { kind, session }
    this.kinds = new Map(); // kind -> kindStats()
    this.errors = new Map(); // kind -> Map(code -> n)
    this.appends = 0;
    this.bytes = 0;
    this.lines = 0;
    this.perm = {
      requested: 0, resolved: 0, unmatched: 0, dropped: 0, longWaits: 0,
      waits: new Samples(), sinceToolCall: new Samples(), lagRequested: new Samples(), lagResolved: new Samples(),
    };
    this.queues = new Map(); // session -> [요청을 본 t, ...] (FIFO)
    this.lastToolCall = new Map(); // session -> tool_call 이 든 마지막 updates 덧붙이기의 t
    this.active = { reads: 0, withRows: 0, shapes: new Map() };
  }

  _kind(kind) {
    let k = this.kinds.get(kind);
    if (!k) this.kinds.set(kind, (k = kindStats()));
    return k;
  }

  add(rec) {
    if (rec === null || typeof rec !== 'object') return;
    if (rec.type === 'start') {
      this.agents = { grok: rec.agents?.grok === true, codex: rec.agents?.codex === true };
    } else if (rec.type === 'file') this._file(rec);
    else if (rec.type === 'append') this._append(rec);
    else if (rec.type === 'active') this._active(rec);
    else if (rec.type === 'error') this._error(rec);
  }

  _file(rec) {
    if (typeof rec.file !== 'string' || typeof rec.kind !== 'string') return;
    if (!this.files.has(rec.file)) {
      this.files.set(rec.file, { kind: rec.kind, session: rec.session ?? null });
      this._kind(rec.kind).files += 1;
    }
    const k = this._kind(rec.kind);
    if (rec.event === 'reset') {
      k.resets += 1;
      if (rec.kind === 'grok-events') this._dropQueue(rec.session);
    } else if (rec.event === 'gone') k.gone += 1;
  }

  // 같은 세션의 events.jsonl 이 바뀌었다: 기다리던 요청은 짝을 잃는다
  _dropQueue(session) {
    const q = this.queues.get(session);
    if (q?.length) this.perm.dropped += q.length;
    this.queues.delete(session);
  }

  _append(rec) {
    const f = this.files.get(rec.file);
    if (!f) return;
    const k = this._kind(f.kind);
    const t = num(rec.t) ?? 0;
    const lines = count(rec.lines);
    this.appends += 1;
    this.bytes += count(rec.bytes);
    this.lines += lines;
    k.appends += 1;
    k.bytes.push(count(rec.bytes));
    k.lines += lines;
    k.linesPerAppend[bucketOf(lines)] += 1;
    if (rec.partialTail === true) k.partialTail += 1;
    if (rec.midLineStart === true) k.midLineStart += 1;
    if (rec.lagMs && typeof rec.lagMs === 'object') {
      k.lagMin.push(rec.lagMs.min);
      k.lagMax.push(rec.lagMs.max);
    }
    k.bad += count(rec.bad);
    k.oversize += count(rec.oversize);
    if (rec.kinds && typeof rec.kinds === 'object') {
      for (const [key, n] of Object.entries(rec.kinds)) k.values.set(key, (k.values.get(key) ?? 0) + count(n));
    }
    if (f.kind === 'grok-updates' && count(rec.kinds?.['sessionUpdate:tool_call']) > 0) this.lastToolCall.set(f.session, t);
    if (f.kind === 'grok-events' && Array.isArray(rec.perm)) for (const p of rec.perm) this._perm(f.session, t, p);
  }

  _perm(session, t, p) {
    const P = this.perm;
    if (p?.ev === 'req') {
      P.requested += 1;
      P.lagRequested.push(p.lagMs);
      let q = this.queues.get(session);
      if (!q) this.queues.set(session, (q = []));
      q.push(t);
      const tc = this.lastToolCall.get(session);
      if (tc !== undefined && tc <= t) P.sinceToolCall.push(t - tc);
    } else if (p?.ev === 'res') {
      P.resolved += 1;
      P.lagResolved.push(p.lagMs);
      const q = this.queues.get(session);
      if (!q?.length) {
        P.unmatched += 1;
        return;
      }
      const wait = t - q.shift();
      P.waits.push(wait);
      if (wait >= WAIT_MIN_MS) P.longWaits += 1;
    }
  }

  _active(rec) {
    const A = this.active;
    const rows = count(rec.rows);
    A.reads += 1;
    if (rows >= 1) A.withRows += 1;
    const keys = rec.keys && typeof rec.keys === 'object' ? rec.keys : {};
    const sig = `${rec.shape}|${JSON.stringify(keys)}`;
    const s = A.shapes.get(sig);
    if (s) {
      s.reads += 1;
      s.maxRows = Math.max(s.maxRows, rows);
    } else A.shapes.set(sig, { shape: String(rec.shape), keys: { ...keys }, reads: 1, maxRows: rows });
  }

  _error(rec) {
    const kind = typeof rec.kind === 'string' ? rec.kind : '?';
    const code = typeof rec.code === 'string' ? rec.code : '?';
    let m = this.errors.get(kind);
    if (!m) this.errors.set(kind, (m = new Map()));
    m.set(code, (m.get(code) ?? 0) + 1);
  }

  /** Counts per checklist id. */
  get counts() {
    return {
      'grok-updates': this.kinds.get('grok-updates')?.appends ?? 0,
      'grok-wait': this.perm.longWaits,
      'grok-active': this.active.withRows,
      'codex-rollout': this.kinds.get('codex-rollout')?.appends ?? 0,
    };
  }

  /** { checklist, ready } for the agents of the start record. */
  progress() {
    return progress(this.counts, this.agents);
  }

  /** { files, appends } (the status totals). */
  totals() {
    return { files: this.files.size, appends: this.appends };
  }

  /** The summary record body: { type: 'summary', t, endedAt, ... } (t and endedAt as given, else null). */
  summary({ t = null, endedAt = null } = {}) {
    const kinds = {};
    const names = new Set(Object.entries(AGENT_KINDS).flatMap(([a, ks]) => (this.agents[a] ? ks : [])));
    for (const k of this.kinds.keys()) names.add(k);
    for (const name of [...names].sort()) {
      const k = this.kinds.get(name) ?? kindStats();
      kinds[name] = {
        files: k.files, appends: k.appends, lines: k.lines, bytes: k.bytes.stats(), linesPerAppend: { ...k.linesPerAppend },
        partialTail: k.partialTail, midLineStart: k.midLineStart, lagMin: k.lagMin.stats(), lagMax: k.lagMax.stats(),
        resets: k.resets, gone: k.gone, bad: k.bad, oversize: k.oversize,
        values: Object.fromEntries([...k.values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      };
    }
    const errors = {};
    for (const [kind, m] of [...this.errors.entries()].sort()) errors[kind] = Object.fromEntries([...m.entries()].sort());
    const P = this.perm;
    let unresolved = 0;
    for (const q of this.queues.values()) unresolved += q.length;
    const { checklist, ready } = this.progress();
    return {
      type: 'summary', t, endedAt,
      agents: { ...this.agents },
      totals: { files: this.files.size, appends: this.appends, bytes: this.bytes, lines: this.lines },
      kinds,
      errors,
      grokPermission: {
        requested: P.requested, resolved: P.resolved, unmatched: P.unmatched, unresolved, dropped: P.dropped,
        waits: P.waits.stats(), waitsAtLeastMs: WAIT_MIN_MS, longWaits: P.longWaits, sinceToolCall: P.sinceToolCall.stats(),
        lagRequested: P.lagRequested.stats(), lagResolved: P.lagResolved.stats(),
      },
      active: { reads: this.active.reads, withRows: this.active.withRows, shapes: [...this.active.shapes.values()] },
      checklist,
      ready,
    };
  }
}

/** The summary of a whole record list (pure): new Tally, add each, summary(extra). */
export function summarize(records, extra = {}) {
  const tally = new Tally();
  for (const r of records ?? []) tally.add(r);
  return tally.summary(extra);
}
