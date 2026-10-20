// Grok events.jsonl reader (P5g, CONTRACT 4.6): the pure reducer (adjacency, ordinal e, turn boundaries, decisions)
// and EventsTail (lstat + O_NOFOLLOW + inode check, appended bytes only, partial lines, 64 KB line cap, per-check cap,
// reset on a new inode or a shrink, facts only when caught up, seenAt at the bounding stat). Temp files and invented
// lines only; nothing here reads a real ~/.grok.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EventsTail, EventsReducer, eventOf, wantedLine, eventsPathOf, EVENTS_FILE, EVENT_TYPES, EVENTS_LINE_BYTES,
} from '../src/adapters/grok/events.mjs';
import { toolNameOf } from '../src/adapters/grok/records.mjs';
import { createGrokEventsBuilder, EVENTS_BAIT } from './fixtures/grok.mjs';
import { writeSession, eventsJsonl, gid, groupOf } from './fixtures/grok-tree.mjs';

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'office-sim-grok-events-') {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
async function eventsFile(lines, prefix) {
  const file = path.join(await tmp(prefix), EVENTS_FILE);
  await fsp.writeFile(file, eventsJsonl(lines));
  return file;
}
const append = (file, lines) => fsp.appendFile(file, eventsJsonl(lines));
const ev = (o = {}) => createGrokEventsBuilder({ startMs: T0, ...o });
const states = (r) => r.facts.map((f) => `${f.e}:${f.name}:${f.state}`);
const OPEN_KEYS = ['e', 'name', 'reqMs', 'startMs', 'state'];
const CLOSED_KEYS = ['e', 'name', 'reqMs', 'resMs', 'startMs', 'state'];

test('eventsPathOf: only <session dir>/updates.jsonl maps to its events.jsonl; check refuses any other name without a stat', async () => {
  assert.equal(eventsPathOf('/r/sessions/g/s/updates.jsonl'), '/r/sessions/g/s/events.jsonl');
  for (const bad of ['/r/sessions/g/s/summary.json', '/r/sessions/g/s/events.jsonl', '', null, 7]) assert.equal(eventsPathOf(bad), null);
  const dir = await tmp();
  const other = path.join(dir, 'chat_history.jsonl');
  await fsp.writeFile(other, eventsJsonl(ev().prompt('read_file', { decision: null })));
  const orig = fsp.lstat;
  let stats = 0;
  fsp.lstat = async function counted(...a) {
    stats += 1;
    return orig.apply(this, a);
  };
  try {
    assert.equal(await new EventsTail().check(other), null);
    assert.equal(await new EventsTail().check(null), null);
  } finally {
    fsp.lstat = orig;
  }
  assert.equal(stats, 0, 'a file not named events.jsonl is never stat-ed');
});

test('wantedLine: "phase_changed" lines and lines without a quoted kept type are dropped; escaped quotes never match', () => {
  const b = ev();
  for (const keep of [b.started(), b.requested(), b.resolved(), b.turnStarted(), b.turnEnded({ outcome: 'cancelled' })]) {
    const s = JSON.stringify(keep);
    assert.equal(wantedLine(s), true, keep.type);
    assert.equal(wantedLine(Buffer.from(s)), true, `${keep.type} (bytes)`);
  }
  for (const drop of [b.phase(), b.phase('tool_execution'), b.yoloToggled(), b.toolCompleted(), b.mcpFailed(), b.mcpStarting(),
    { type: 'loop_started' }, { type: 'mcp_tool_call_started', tool_name: 'x' }]) {
    assert.equal(wantedLine(JSON.stringify(drop)), false, drop.type);
  }
  assert.ok(JSON.stringify(b.mcpFailed()).includes('\\"tool_started\\"'), 'the bait really holds the escaped type names');
  assert.equal(wantedLine('{"type":"phase_changed","note":"tool_started","x":"permission_requested"}'), false);
  assert.deepEqual(EVENT_TYPES, ['tool_started', 'permission_requested', 'permission_resolved', 'turn_started', 'turn_ended']);
});

test('eventOf: reads only type, ts, tool_name and decision (a Proxy records every key read)', () => {
  const b = ev();
  const reads = (rec) => {
    const seen = new Set();
    const got = eventOf(new Proxy(rec, { get(t, k) { seen.add(k); return t[k]; } }));
    return { got, seen: [...seen].sort() };
  };
  assert.deepEqual(reads(b.started('grep')).seen, ['tool_name', 'ts', 'type']);
  assert.deepEqual(reads(b.requested('grep')).seen, ['tool_name', 'ts', 'type']);
  assert.deepEqual(reads(b.resolved('grep', { decision: 'deny', waitMs: 9 })).seen, ['decision', 'tool_name', 'ts', 'type']);
  assert.deepEqual(reads(b.turnStarted()).seen, ['ts', 'type']);
  assert.deepEqual(reads(b.turnEnded({ outcome: 'cancelled' })).seen, ['ts', 'type']);
  for (const other of [b.mcpFailed(), b.mcpStarting(), b.toolCompleted(), b.phase(), b.yoloToggled()]) {
    assert.deepEqual(reads(other), { got: null, seen: ['type'] }, other.type);
  }
  const r = eventOf(b.resolved('grep', { decision: 'deny', ms: T0 + 5 }));
  assert.deepEqual(r, { type: 'permission_resolved', ms: T0 + 5, name: 'grep', decision: 'deny' });
  assert.equal(eventOf({ type: 'permission_resolved', tool_name: 'grep', decision: 'ALLOW' }).decision, null, 'unknown decision');
  assert.equal(eventOf({ type: 'tool_started', ts: 'not a time', tool_name: 'grep' }).ms, null);
  for (const bad of [null, [], 'tool_started', { type: 7 }, { type: 'tool_completed' }]) assert.equal(eventOf(bad), null);
  // tool_name: the TOOL_NAME_RE rule of records.mjs (same trim and check as the x.ai/tool name of a call)
  for (const n of [' run_terminal_command ', 'mcp:server.tool', 'a'.repeat(64), 'a'.repeat(65), 'bad name', '', 'BAIT_EVENTS']) {
    assert.equal(eventOf({ type: 'tool_started', tool_name: n }).name, toolNameOf({ _meta: { 'x.ai/tool': { name: n } } }), n);
  }
});

test('EventsReducer: the strict sequence opens e, a yolo toggle anywhere pairs the same way, resolutions close it', () => {
  const b = ev();
  const red = new EventsReducer();
  const feed = (lines) => lines.flatMap((l) => red.apply(l));
  assert.deepEqual(feed([b.turnStarted(), b.started('read_file', { ms: T0 + 100 }), b.phase(), b.requested('read_file', { ms: T0 + 101 })]), []);
  assert.deepEqual([...red.open.values()], [{ e: 1, name: 'read_file', startMs: T0 + 100, reqMs: T0 + 101 }]);
  assert.deepEqual(feed([b.yoloToggled(true), b.resolved('read_file', { ms: T0 + 2000 }), b.phase('tool_execution')]),
    [{ e: 1, name: 'read_file', startMs: T0 + 100, reqMs: T0 + 101, state: 'allow', resMs: T0 + 2000 }]);
  // yolo_toggled between the start and the request (9 real cases) pairs with the same start
  assert.deepEqual(feed([b.started('grep'), b.yoloToggled(false), b.phase(), b.requested('grep')]), []);
  assert.deepEqual([...red.open.keys()], [2]);
  assert.deepEqual(feed([b.resolved('grep', { decision: 'deny' })]).map((r) => [r.e, r.state]), [[2, 'deny']]);
  // unknown or missing decision clears the wait the same way as allow
  feed([b.started('write'), b.requested('write')]);
  assert.deepEqual(feed([{ type: 'permission_resolved', tool_name: 'write', decision: 'later' }]).map((r) => [r.e, r.state]), [[3, 'allow']]);
  feed([b.started('write'), b.requested('write')]);
  assert.deepEqual(feed([{ type: 'permission_resolved', tool_name: 'write' }]).map((r) => [r.e, r.state]), [[4, 'allow']]);
  assert.equal(red.e, 4);
  assert.equal(red.open.size, 0);
});

test('EventsReducer: a request without a same-name tool_started right before it is unpaired (never a fact)', () => {
  const b = ev();
  const red = new EventsReducer();
  red.apply({ type: 'permission_requested', tool_name: 'BAIT_EVENTS' }); // the conformance bait shape
  red.apply(b.started('grep'));
  red.apply(b.requested('read_file')); // another name
  red.apply(b.started('grep'));
  red.apply(b.turnStarted());
  red.apply(b.requested('grep')); // a turn boundary in between
  red.apply(b.started('grep'));
  red.apply(b.requested('grep'));
  red.apply(b.requested('grep')); // a second request for the same start
  red.apply(b.started('grep'));
  red.broken(); // an over-cap or unparsable line in between: fail closed
  red.apply(b.requested('grep'));
  red.apply(b.started('bad name!'));
  red.apply(b.requested('bad name!')); // an invalid name counts as an ordinal but never pairs
  assert.deepEqual([...red.open.keys()], [3]);
  assert.equal(red.e, 5);
  assert.deepEqual(red.stats, { started: 5, requests: 7, unpaired: 6, resolved: 0, unmatched: 0, gone: 0 });
  assert.deepEqual(red.apply(b.resolved('read_file')), [], 'no open request of that name');
  assert.equal(red.stats.unmatched, 1);
});

test('EventsReducer: several open requests coexist, same-name resolutions go FIFO, a turn boundary closes all as gone', () => {
  const b = ev();
  const red = new EventsReducer();
  for (const n of ['grep', 'grep', 'write']) {
    red.apply(b.started(n));
    red.apply(b.requested(n));
  }
  assert.deepEqual([...red.open.keys()], [1, 2, 3]);
  assert.deepEqual(red.apply(b.resolved('write')).map((r) => r.e), [3]);
  assert.deepEqual(red.apply(b.resolved('grep')).map((r) => r.e), [1], 'the oldest of the same name');
  red.apply(b.started('read_file'));
  red.apply(b.requested('read_file'));
  const end = b.turnEnded({ outcome: 'cancelled', ms: T0 + 9000 });
  assert.deepEqual(red.apply(end).map((r) => [r.e, r.state, r.resMs]), [[2, 'gone', T0 + 9000], [4, 'gone', T0 + 9000]]);
  red.apply(b.started('grep'));
  red.apply(b.requested('grep'));
  assert.deepEqual(red.apply(b.turnStarted()).map((r) => [r.e, r.state]), [[5, 'gone']]);
  // the open table is capped: the oldest is dropped as gone (resMs null)
  const small = new EventsReducer({ maxOpen: 2 });
  const out = [];
  for (const n of ['a', 'b', 'c']) {
    small.apply(b.started(n));
    out.push(...small.apply(b.requested(n)));
  }
  assert.deepEqual(out.map((r) => [r.e, r.state, r.resMs]), [[1, 'gone', null]]);
  assert.deepEqual([...small.open.keys()], [2, 3]);
});

test('EventsTail: an open request is reported on every caught-up check; its closing once; one read never reports it open', async () => {
  const b = ev();
  const file = await eventsFile([b.turnStarted(), b.started('run_terminal_command', { ms: T0 + 10 }), b.phase(),
    b.requested('run_terminal_command', { ms: T0 + 11 })]);
  const tail = new EventsTail();
  const r1 = await tail.check(file, () => T0 + 3000);
  assert.deepEqual(r1, { caughtUp: true, reset: false, seenAt: T0 + 3000,
    facts: [{ e: 1, name: 'run_terminal_command', startMs: T0 + 10, reqMs: T0 + 11, state: 'open' }] });
  assert.deepEqual(Object.keys(r1.facts[0]).sort(), OPEN_KEYS);
  assert.deepEqual(states(await tail.check(file)), ['1:run_terminal_command:open'], 'again, nothing appended');
  await append(file, [b.yoloToggled(true), b.resolved('run_terminal_command', { ms: T0 + 4000, waitMs: 3989 }), b.phase('tool_execution')]);
  const r3 = await tail.check(file);
  assert.deepEqual(r3.facts, [{ e: 1, name: 'run_terminal_command', startMs: T0 + 10, reqMs: T0 + 11, state: 'allow', resMs: T0 + 4000 }]);
  assert.deepEqual(Object.keys(r3.facts[0]).sort(), CLOSED_KEYS);
  assert.deepEqual((await tail.check(file)).facts, [], 'the closing is reported once');
  // a request and its resolution inside one read: never reported open, so no closing either
  await append(file, b.prompt('grep', { waitMs: 5000 }));
  assert.deepEqual((await tail.check(file)).facts, []);
  await append(file, [...b.prompt('write', { decision: null }), b.turnEnded({ outcome: 'cancelled' })]);
  assert.deepEqual((await tail.check(file)).facts, [], 'opened and cancelled between two checks: nothing');
  assert.equal(tail.stats.started, 3);
});

test('EventsTail: deny, an unknown decision and a cancelled turn close a reported request; the bait shape never reports', async () => {
  const b = ev();
  const file = await eventsFile([{ type: 'permission_requested', tool_name: 'BAIT_EVENTS' }, ...b.prompt('grep', { decision: null })]);
  const tail = new EventsTail();
  assert.deepEqual(states(await tail.check(file)), ['1:grep:open']);
  assert.equal(tail.stats.unpaired, 1);
  await append(file, [b.resolved('grep', { decision: 'deny', waitMs: 21000 }), ...b.prompt('write', { decision: null })]);
  assert.deepEqual(states(await tail.check(file)), ['1:grep:deny', '2:write:open']);
  await append(file, [b.resolved('write', { decision: 'ask_later' }), ...b.prompt('run_terminal_command', { decision: null })]);
  assert.deepEqual(states(await tail.check(file)), ['2:write:allow', '3:run_terminal_command:open']);
  const end = b.turnEnded({ outcome: 'cancelled', category: 'mid_turn_abort', ms: T0 + 60_000 });
  await append(file, [b.mcpFailed(), end]);
  const r = await tail.check(file);
  assert.deepEqual(r.facts.map((f) => [f.e, f.state, f.resMs]), [[3, 'gone', T0 + 60_000]]);
  assert.ok(!JSON.stringify(r).includes('BAIT'), 'no bait text in any result');
});

test('EventsTail: phase_changed, yolo, tool_completed and mcp_* lines are never JSON.parsed; no bait reaches a fact', async () => {
  const b = ev();
  const lines = [b.mcpStarting(), b.mcpFailed(), b.turnStarted(), b.phase('streaming_reasoning'), b.phase('streaming_text'),
    b.started('use_tool'), b.phase(), b.requested('use_tool'), b.mcpFailed(), b.yoloToggled(false),
    b.phase('waiting_for_model'), b.toolCompleted('grep'), { ts: new Date(T0).toISOString(), type: 'loop_started' }];
  const file = await eventsFile(lines);
  const tail = new EventsTail();
  const r = await tail.check(file);
  assert.deepEqual(states(r), ['1:use_tool:open']);
  assert.equal(tail.stats.lines, lines.length);
  assert.equal(tail.stats.parsed, 3, 'turn_started, tool_started, permission_requested only');
  const text = JSON.stringify(r);
  for (const bait of Object.values(EVENTS_BAIT)) assert.ok(!text.includes(bait), bait);
  assert.ok(!text.includes('BAIT_'));
});

test('EventsTail: a partial last line waits for its newline; a garbage line or an over-cap line breaks adjacency', async () => {
  const b = ev();
  const req = `${JSON.stringify(b.requested('grep'))}\n`;
  const file = await eventsFile(`${eventsJsonl([b.started('grep'), b.phase()])}${req.slice(0, 25)}`);
  const tail = new EventsTail();
  assert.deepEqual(await tail.check(file, () => 1), { caughtUp: true, facts: [], seenAt: 1, reset: false }, 'half a request');
  await fsp.appendFile(file, req.slice(25));
  assert.deepEqual(states(await tail.check(file)), ['1:grep:open']);
  // a line without a quoted type is dropped before parsing and changes nothing; a garbage line with one is broken
  await append(file, [b.resolved('grep'), b.started('write'), 'not json at all', b.requested('write')]);
  assert.deepEqual(states(await tail.check(file)), ['1:grep:allow', '2:write:open']);
  await append(file, [b.resolved('write'), b.started('read_file'), '{"type":"permission_requested", oops', b.requested('read_file')]);
  assert.deepEqual(states(await tail.check(file)), ['2:write:allow']);
  assert.equal(tail.stats.bad, 1);
  // a line over 64 KB is skipped whole (no ordinal) and the request after it stays unpaired
  const huge = JSON.stringify({ type: 'tool_started', tool_name: 'grep', pad: 'x'.repeat(EVENTS_LINE_BYTES) });
  await append(file, [b.started('grep'), huge, b.requested('grep'), ...b.prompt('list_dir', { decision: null })]);
  assert.deepEqual(states(await tail.check(file)), ['5:list_dir:open']);
  assert.deepEqual([tail.stats.long, tail.stats.unpaired], [1, 2]);
});

test('EventsTail: lines split across small chunks are rebuilt (the carry is copied), over-cap lines across chunks too', async () => {
  const b = ev();
  const lines = [];
  for (let i = 0; i < 30; i += 1) lines.push(...b.prompt(i % 2 ? 'grep' : 'read_file', { waitMs: 3 }), b.phase('streaming_text'));
  lines.push(JSON.stringify({ type: 'turn_started', pad: 'y'.repeat(700) }), ...b.prompt('write', { decision: null }));
  const file = await eventsFile(lines);
  const tail = new EventsTail({ chunk: 37, maxLine: 512 });
  const r = await tail.check(file);
  assert.equal(r.caughtUp, true);
  assert.deepEqual(states(r), ['31:write:open']);
  assert.deepEqual([tail.stats.long, tail.stats.bad, tail.stats.resolved, tail.stats.unpaired], [1, 0, 30, 0]);
});

test('EventsTail: past the per-check cap the result is not caught up and carries no facts until the end is reached', async () => {
  const b = ev();
  const lines = [...b.prompt('grep', { decision: null })];
  for (let i = 0; i < 60; i += 1) lines.push(b.phase('streaming_text'));
  lines.push(...b.prompt('write', { decision: null }));
  const file = await eventsFile(lines);
  const size = (await fsp.stat(file)).size;
  const tail = new EventsTail({ maxCheck: 1024, chunk: 256 });
  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    const r = await tail.check(file, () => i);
    seen.push(r);
    if (r.caughtUp) break;
  }
  const last = seen.at(-1);
  assert.ok(seen.length >= Math.ceil(size / 1024), `${seen.length} checks`);
  for (const r of seen.slice(0, -1)) assert.deepEqual(r, { caughtUp: false, facts: [], seenAt: r.seenAt, reset: false });
  assert.deepEqual(states(last), ['1:grep:open', '2:write:open'], 'only once caught up');
});

test('EventsTail: a new inode or a shrink starts over with reset and ordinals counted again from 1; so does a new path', async () => {
  const b = ev();
  const file = await eventsFile([...b.prompt('grep', { waitMs: 1 }), ...b.prompt('write', { decision: null })]);
  const tail = new EventsTail();
  assert.deepEqual(states(await tail.check(file)), ['2:write:open']);
  const next = path.join(path.dirname(file), 'next.tmp');
  await fsp.writeFile(next, eventsJsonl([...b.prompt('read_file', { decision: null })]));
  await fsp.rename(next, file);
  const r = await tail.check(file);
  assert.equal(r.reset, true);
  assert.deepEqual(states(r), ['1:read_file:open'], 'the old open request is void, not closed');
  assert.equal((await tail.check(file)).reset, false, 'reported once');
  await append(file, [b.resolved('read_file'), ...b.prompt('grep', { decision: null }), b.phase('streaming_text')]);
  assert.deepEqual(states(await tail.check(file)), ['1:read_file:allow', '2:grep:open']);
  const ino = (await fsp.stat(file)).ino;
  await fsp.writeFile(file, eventsJsonl([...b.prompt('list_dir', { decision: null })])); // same inode, shorter
  assert.equal((await fsp.stat(file)).ino, ino);
  const s = await tail.check(file);
  assert.equal(s.reset, true);
  assert.deepEqual(states(s), ['1:list_dir:open']);
  const other = await eventsFile([...b.prompt('grep', { decision: null })]);
  const o = await tail.check(other);
  assert.equal(o.reset, true, 'another path');
  assert.deepEqual(states(o), ['1:grep:open']);
});

test('EventsTail: a symlinked events.jsonl and a swap between lstat and open are never read; EACCES gives null', async () => {
  const dir = await tmp();
  const outside = await tmp('office-sim-grok-events-outside-');
  const secret = path.join(outside, EVENTS_FILE);
  await fsp.writeFile(secret, eventsJsonl(ev().prompt('BAIT_LINK', { decision: null })));
  const file = path.join(dir, EVENTS_FILE);
  await fsp.symlink(secret, file);
  const tail = new EventsTail();
  assert.equal(await tail.check(file), null, 'a link is not a regular file');
  assert.equal(tail.stats.lines, 0);
  const orig = fsp.lstat;
  fsp.lstat = async function raced(q, ...rest) {
    return q === file ? fsp.stat(q) : orig.call(this, q, ...rest); // the race: lstat saw a regular file
  };
  try {
    assert.equal(await tail.check(file), null, 'O_NOFOLLOW: the link is not opened');
  } finally {
    fsp.lstat = orig;
  }
  assert.equal(tail.stats.lines, 0);
  await fsp.rm(file);
  await fsp.writeFile(file, eventsJsonl(ev().prompt('grep', { decision: null })));
  fsp.lstat = async function swapped(q, ...rest) {
    const st = await orig.call(this, q, ...rest);
    if (q === file) st.ino += 1;
    return st;
  };
  try {
    assert.equal(await tail.check(file), null, 'another inode than the one lstat-ed: not read');
  } finally {
    fsp.lstat = orig;
  }
  assert.equal(tail.stats.lines, 0);
  assert.deepEqual(states(await tail.check(file)), ['1:grep:open'], 'no race: read');
  if (process.getuid?.() !== 0) {
    await fsp.chmod(file, 0o000);
    try {
      assert.equal(await new EventsTail().check(file), null, 'EACCES');
    } finally {
      await fsp.chmod(file, 0o644);
    }
  }
  assert.equal(await new EventsTail().check(path.join(dir, 'missing', EVENTS_FILE)), null, 'missing');
  await fsp.mkdir(path.join(dir, 'sub', EVENTS_FILE), { recursive: true });
  assert.equal(await new EventsTail().check(path.join(dir, 'sub', EVENTS_FILE)), null, 'a directory');
});

test('EventsTail: seenAt is read right before the bounding stat, so a byte on disk at seenAt is always consumed', async () => {
  const b = ev();
  const file = await eventsFile(b.prompt('grep', { decision: null }));
  const tail = new EventsTail();
  let n = 0;
  let armed = false;
  // couples to the reader's two clock reads: before the lstat, then (when bytes are appended) before the fstat
  const now = () => {
    n += 1;
    if (armed && n === 2) fs.appendFileSync(file, eventsJsonl([b.resolved('grep')]));
    return 5000 + n;
  };
  const r1 = await tail.check(file, now);
  assert.deepEqual([r1.seenAt, states(r1)], [5002, ['1:grep:open']], 'read: the clock before the fstat');
  n = 0;
  const r2 = await tail.check(file, now);
  assert.deepEqual([r2.seenAt, states(r2)], [5001, ['1:grep:open']], 'nothing appended: the clock before the lstat');
  await append(file, [b.yoloToggled(true)]);
  n = 0;
  armed = true;
  const r3 = await tail.check(file, now);
  assert.deepEqual([r3.seenAt, states(r3)], [5002, ['1:grep:allow']], 'written at the clock read: consumed, not open');
});

test('EventsTail: checks are serialized (a closing is delivered once); forget() mid-check gives null and starts over', async () => {
  const b = ev();
  const file = await eventsFile(b.prompt('grep', { decision: null }));
  const tail = new EventsTail();
  assert.deepEqual(states(await tail.check(file)), ['1:grep:open']);
  await append(file, [b.resolved('grep'), ...b.prompt('write', { decision: null })]);
  const [x, y] = await Promise.all([tail.check(file), tail.check(file)]);
  assert.deepEqual([states(x), states(y)], [['1:grep:allow', '2:write:open'], ['2:write:open']]);
  const gone = await tail.check(file, () => {
    tail.forget();
    return 1;
  });
  assert.equal(gone, null, 'forgotten while reading');
  assert.equal(tail.stats, null);
  const again = await tail.check(file);
  assert.deepEqual([again.reset, states(again)], [false, ['2:write:open']], 'from byte 0, not a reset');
  assert.equal(tail.stats.started, 2);
});

test('fixtures: writeSession writes events.jsonl next to updates.jsonl only when given; eventsPathOf finds it', async () => {
  const root = await tmp();
  const b = ev();
  const with_ = await writeSession(root, { group: groupOf('/w/p'), id: gid(1), events: b.prompt('grep', { decision: null }) });
  const without = await writeSession(root, { group: groupOf('/w/p'), id: gid(2) });
  assert.deepEqual(states(await new EventsTail().check(eventsPathOf(with_))), ['1:grep:open']);
  await assert.rejects(fsp.access(eventsPathOf(without)), 'no events.jsonl unless asked');
  assert.equal(await new EventsTail().check(eventsPathOf(without)), null);
});
