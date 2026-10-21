// 기록 관찰의 집계와 체크리스트 (src/observe/summary.mjs, observe-spec "Checklist", "Tests: Summary/checklist"). 순수 함수만
// 본다: 지어낸 관찰 기록 객체를 넣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST, Tally, WAIT_MIN_MS, progress, summarize } from '../src/observe/summary.mjs';

const start = (agents = { grok: true, codex: true }) => ({ type: 'start', v: 1, startedAt: '2026-10-21T00:00:00.000Z', intervalMs: 100, rescanMs: 2000, platform: 'darwin', agents });
const file = (f, s, kind, event = 'watch') => ({ type: 'file', t: 0, file: f, session: s, agent: kind.split('-')[0], kind, event });
const append = (f, t, extra = {}) => ({
  type: 'append', t, file: f, bytes: 100, lines: 1, partialTail: false, midLineStart: false, maxLineBytes: 99, kinds: {},
  lagMs: null, bad: 0, oversize: 0, ...extra,
});
const req = (lagMs = 5) => ({ ev: 'req', lagMs });
const res = (lagMs = 5) => ({ ev: 'res', lagMs });
const item = (s, id) => s.checklist.find((i) => i.id === id);

test('progress: items of a disabled agent are off and do not block ready', () => {
  assert.deepEqual(CHECKLIST.map((i) => [i.id, i.need]), [['grok-updates', 20], ['grok-wait', 1], ['grok-active', 1], ['codex-rollout', 20]]);
  const counts = { 'grok-updates': 25, 'grok-wait': 1, 'grok-active': 3, 'codex-rollout': 0 };
  let p = progress(counts, { grok: true, codex: false });
  assert.equal(p.ready, true);
  assert.deepEqual(p.checklist.find((i) => i.id === 'codex-rollout'), { id: 'codex-rollout', have: 0, need: 20, done: false, off: true });
  assert.deepEqual(p.checklist.find((i) => i.id === 'grok-updates'), { id: 'grok-updates', have: 25, need: 20, done: true, off: false });
  p = progress(counts, { grok: true, codex: true });
  assert.equal(p.ready, false, 'codex is on and not done');
  p = progress({ 'codex-rollout': 20 }, { grok: false, codex: true });
  assert.equal(p.ready, true);
  assert.ok(p.checklist.filter((i) => i.id.startsWith('grok')).every((i) => i.off && i.have === 0 && !i.done));
  assert.equal(progress(counts, { grok: false, codex: false }).ready, false, 'nothing on is never ready');
  assert.equal(progress({ 'grok-updates': -3, 'grok-wait': 'x' }, { grok: true }).checklist[0].have, 0);
});

test('grok-wait: a resolved-minus-requested observation gap of 1000 ms or more counts, less does not', () => {
  const recs = [start({ grok: true, codex: false }), file('f1', 's1', 'grok-events'),
    append('f1', 1000, { perm: [req()] }), append('f1', 1999, { perm: [res()] }),
    append('f1', 3000, { perm: [req()] }), append('f1', 4000, { perm: [res()] })];
  const t = new Tally();
  for (const r of recs.slice(0, 4)) t.add(r);
  assert.equal(t.counts['grok-wait'], 0, '999 ms does not count');
  for (const r of recs.slice(4)) t.add(r);
  assert.equal(t.counts['grok-wait'], 1, 'exactly WAIT_MIN_MS counts');
  assert.equal(WAIT_MIN_MS, 1000);
  const s = summarize(recs);
  assert.equal(item(s, 'grok-wait').done, true);
  assert.deepEqual(s.grokPermission.waits, { n: 2, p50: 999, p90: 1000, max: 1000 });
  assert.equal(s.grokPermission.longWaits, 1);
});

test('permission pairing is FIFO per session, keeps line order inside one append, and a reset drops the open ones', () => {
  const recs = [start(), file('f1', 's1', 'grok-events'), file('f2', 's2', 'grok-events'), file('f3', 's1', 'grok-updates'),
    append('f3', 50, { kinds: { 'sessionUpdate:tool_call': 1 } }),
    append('f1', 120, { perm: [req(7)] }), // s1 #1, 70 ms after the tool_call append
    append('f2', 100, { perm: [req()] }), // s2 #1 (no tool_call in s2)
    append('f1', 200, { perm: [req()] }), // s1 #2
    append('f2', 1500, { perm: [res()] }), // s2 #1: 1400
    append('f1', 1700, { perm: [res(), req()] }), // s1 #1: 1580, then s1 #3 opens
    append('f1', 3000, { perm: [res(), res(), res()] }), // s1 #2: 2800, s1 #3: 1300, then one unmatched
    append('f2', 3100, { perm: [req()] }), file('f2', 's2', 'grok-events', 'reset'), append('f2', 5000, { perm: [res()] })];
  const s = summarize(recs, { t: 6000, endedAt: '2026-10-21T00:00:06.000Z' });
  const P = s.grokPermission;
  assert.deepEqual([P.requested, P.resolved, P.unmatched, P.unresolved, P.dropped], [5, 6, 2, 0, 1]);
  assert.deepEqual(P.waits, { n: 4, p50: 1400, p90: 2800, max: 2800 });
  assert.equal(P.longWaits, 4);
  assert.deepEqual(P.sinceToolCall, { n: 3, p50: 150, p90: 1650, max: 1650 }, 's1 requests after the tool_call append at 50');
  assert.equal(P.lagRequested.max, 7);
  assert.deepEqual([s.t, s.endedAt, s.type], [6000, '2026-10-21T00:00:06.000Z', 'summary']);
  assert.equal(s.kinds['grok-events'].resets, 1);
});

test('a tool_call append after the request (later t) is not counted as before it', () => {
  const recs = [start(), file('f1', 's1', 'grok-events'), file('f2', 's1', 'grok-updates'),
    append('f1', 100, { perm: [req()] }), append('f2', 150, { kinds: { 'sessionUpdate:tool_call': 1 } })];
  assert.equal(summarize(recs).grokPermission.sinceToolCall, null);
});

test('summary per kind: appends, bytes, lines-per-append buckets, flags, lag, values, resets, gone, errors, active shapes', () => {
  const recs = [start({ grok: true, codex: true }), file('f1', 's1', 'codex-rollout'), file('f2', null, 'codex-index'),
    append('f1', 10, { bytes: 10, lines: 0, partialTail: true, lagMs: null }),
    append('f1', 20, { bytes: 20, lines: 1, midLineStart: true, lagMs: { min: 3, max: 3 }, kinds: { 'type:response_item': 1, 'payload.type:message': 1 } }),
    append('f1', 30, { bytes: 30, lines: 2, lagMs: { min: -4, max: 9 }, kinds: { 'type:response_item': 2 }, bad: 1 }),
    append('f1', 40, { bytes: 40, lines: 4, oversize: 1 }), append('f1', 50, { bytes: 50, lines: 9 }),
    append('f2', 60, { bytes: 5, lines: 1 }), file('f1', 's1', 'codex-rollout', 'gone'),
    { type: 'error', t: 70, kind: 'codex-scan', file: null, code: 'EACCES' }, { type: 'error', t: 80, kind: 'codex-index', file: 'f2', code: 'EIO' },
    { type: 'active', t: 0, shape: 'array', rows: 0, keys: {} },
    { type: 'active', t: 5, shape: 'array', rows: 2, keys: { pid: 'number' } }, { type: 'active', t: 9, shape: 'array', rows: 1, keys: { pid: 'number' } },
    append('f9', 99), { type: 'mystery' }, null];
  const s = summarize(recs);
  const k = s.kinds['codex-rollout'];
  assert.deepEqual([k.files, k.appends, k.lines, k.partialTail, k.midLineStart, k.bad, k.oversize, k.gone, k.resets], [1, 5, 16, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(k.bytes, { n: 5, p50: 30, p90: 50, max: 50 });
  assert.deepEqual(k.linesPerAppend, { 0: 1, 1: 1, 2: 1, '3-5': 1, '6+': 1 });
  assert.deepEqual(k.lagMin, { n: 2, p50: -4, p90: 3, max: 3 });
  assert.deepEqual(k.lagMax, { n: 2, p50: 3, p90: 9, max: 9 });
  assert.deepEqual(k.values, { 'payload.type:message': 1, 'type:response_item': 3 });
  assert.deepEqual(Object.keys(s.kinds), ['codex-index', 'codex-rollout', 'grok-events', 'grok-updates']);
  assert.equal(s.kinds['grok-updates'].appends, 0);
  assert.deepEqual(s.errors, { 'codex-index': { EIO: 1 }, 'codex-scan': { EACCES: 1 } });
  assert.deepEqual(s.totals, { files: 2, appends: 6, bytes: 155, lines: 17 });
  assert.deepEqual(s.active, { reads: 3, withRows: 2, shapes: [
    { shape: 'array', keys: {}, reads: 1, maxRows: 0 }, { shape: 'array', keys: { pid: 'number' }, reads: 2, maxRows: 2 }] });
  assert.equal(item(s, 'grok-active').have, 2);
  assert.equal(item(s, 'codex-rollout').have, 5);
  assert.equal(s.ready, false);
});

test('the incremental tally and summarize(records) agree; status totals count files and appends', () => {
  const recs = [start({ grok: true, codex: false }), file('f1', 's1', 'grok-updates')];
  for (let i = 0; i < 20; i++) recs.push(append('f1', i * 100));
  recs.push({ type: 'active', t: 1, shape: 'array', rows: 1, keys: {} }, file('f2', 's1', 'grok-events'),
    append('f2', 3000, { perm: [req()] }), append('f2', 4500, { perm: [res()] }));
  const t = new Tally();
  for (const r of recs) t.add(r);
  assert.deepEqual(t.totals(), { files: 2, appends: 22 });
  assert.deepEqual(t.progress(), { checklist: summarize(recs).checklist, ready: true });
  assert.deepEqual(t.summary({ t: 1 }), summarize(recs, { t: 1 }));
  assert.equal(summarize([]).ready, false);
});
