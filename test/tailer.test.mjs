// Tests for src/tailer.mjs (contract 3.6, R6). Synthetic fixtures only, built in os.tmpdir().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Tailer, splitChunk } from '../src/tailer.mjs';

let tmp;
let seq = 0;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-office-'));
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function file(content = '') {
  seq += 1;
  const p = path.join(tmp, `f${seq}.jsonl`);
  await fsp.writeFile(p, content);
  return { path: p };
}

function collector() {
  const lines = [];
  const onLine = (l) => { lines.push(l); };
  return { lines, onLine };
}

const rec = (i, text = 'invented text') => JSON.stringify({ type: 'user', uuid: `u-${i}`, message: { content: text } });

test('constructor defaults and validation', () => {
  assert.ok(new Tailer() instanceof Tailer);
  assert.throws(() => new Tailer({ chunkBytes: 0 }), RangeError);
  assert.throws(() => new Tailer({ maxLineBytes: -1 }), RangeError);
});

test('splitChunk carries a partial line and multi-byte characters across chunks', () => {
  const carry = { parts: [], partLen: 0, skipping: false };
  const bytes = Buffer.from('가나다\n라마\n바');
  const out = [];
  for (let i = 0; i < bytes.length; i += 2) out.push(...splitChunk(carry, bytes.subarray(i, i + 2), 1024).lines);
  assert.deepEqual(out, ['가나다', '라마']);
  assert.equal(carry.partLen, Buffer.byteLength('바'));
});

test('readAll with 7-byte chunks: lines straddle chunks, UTF-8 intact, offset = size', async () => {
  const lines = [];
  for (let i = 0; i < 60; i += 1) lines.push(rec(i, `한글 설명 ${i} with ✓ and 🙂 invented`));
  lines.push(''); // a blank line is a complete line too; the caller skips it
  lines.push(rec(99));
  const content = lines.join('\n') + '\n';
  const ref = await file(content);
  const t = new Tailer({ chunkBytes: 7 });
  const c = collector();
  const res = await t.readAll(ref, c.onLine);
  assert.deepEqual(c.lines, lines);
  assert.equal(res.offset, Buffer.byteLength(content));
  assert.equal(t.offsetOf(ref.path), Buffer.byteLength(content));
  assert.equal(t.pendingBytes(ref.path), 0);
});

test('readAll yields to the event loop between chunks', async () => {
  const ref = await file(Array.from({ length: 50 }, (_, i) => rec(i)).join('\n') + '\n');
  const t = new Tailer({ chunkBytes: 64 });
  let immediates = 0;
  let maxSeenDuringRead = 0;
  let reading = true;
  const tick = () => { immediates += 1; if (reading) setImmediate(tick); };
  setImmediate(tick);
  await t.readAll(ref, () => { maxSeenDuringRead = immediates; });
  reading = false;
  assert.ok(maxSeenDuringRead > 10, `expected interleaved immediates, saw ${maxSeenDuringRead}`);
});

test('readAll keeps a trailing partial line and poll completes it', async () => {
  const ref = await file(`${rec(1)}\n{"type":"user","uu`);
  const t = new Tailer({ chunkBytes: 5 });
  const c = collector();
  const res = await t.readAll(ref, c.onLine);
  assert.deepEqual(c.lines, [rec(1)]);
  assert.equal(res.offset, (await fsp.stat(ref.path)).size);
  assert.equal(t.pendingBytes(ref.path), Buffer.byteLength('{"type":"user","uu'));
  await fsp.appendFile(ref.path, 'id":"u-2"}\n');
  const r = await t.poll(ref, c.onLine);
  assert.equal(r.bytes, Buffer.byteLength('id":"u-2"}\n'));
  assert.deepEqual(c.lines, [rec(1), '{"type":"user","uuid":"u-2"}']);
});

test('poll reads only appended bytes and carries half a line across polls', async () => {
  const ref = await file(`${rec(1)}\n`);
  const t = new Tailer({ chunkBytes: 7 });
  const c = collector();
  await t.readAll(ref, c.onLine);
  assert.deepEqual(await t.poll(ref, c.onLine), { bytes: 0 }, 'no growth -> cheap path');

  const line = rec(2, '반쪽 줄 invented');
  const buf = Buffer.from(`${line}\n`);
  const half = Math.floor(buf.length / 2);
  await fsp.appendFile(ref.path, buf.subarray(0, half));
  const r1 = await t.poll(ref, c.onLine);
  assert.equal(r1.bytes, half);
  assert.deepEqual(c.lines, [rec(1)], 'half a line is not delivered');
  assert.equal(t.pendingBytes(ref.path), half);

  await fsp.appendFile(ref.path, buf.subarray(half));
  const r2 = await t.poll(ref, c.onLine);
  assert.equal(r2.bytes, buf.length - half);
  assert.deepEqual(c.lines, [rec(1), line], 'onLine fired exactly once for the completed line');

  await fsp.appendFile(ref.path, `${rec(3)}\n${rec(4)}\n`);
  const r3 = await t.poll(ref, c.onLine);
  assert.equal(r3.bytes, Buffer.byteLength(`${rec(3)}\n${rec(4)}\n`));
  assert.deepEqual(c.lines.slice(2), [rec(3), rec(4)]);
  assert.equal(t.offsetOf(ref.path), (await fsp.stat(ref.path)).size);
});

test('poll returns reset when the file is replaced by rename (inode change)', async () => {
  const ref = await file(`${rec(1)}\n${rec(2)}\n`);
  const t = new Tailer();
  const c = collector();
  await t.readAll(ref, c.onLine);
  const replacement = path.join(tmp, 'replacement.tmp');
  // Larger than the old offset so only the inode check can catch it.
  await fsp.writeFile(replacement, `${rec(7)}\n${rec(8)}\n${rec(9)}\n`);
  await fsp.rename(replacement, ref.path);
  assert.deepEqual(await t.poll(ref, c.onLine), { reset: true, size: (await fsp.stat(ref.path)).size }, 'size = replay boundary');
  assert.deepEqual(await t.poll(ref, c.onLine), { reset: true }, 'state was dropped');
  assert.equal(t.offsetOf(ref.path), null);
  const c2 = collector();
  await t.readAll(ref, c2.onLine);
  assert.deepEqual(c2.lines, [rec(7), rec(8), rec(9)]);
  assert.deepEqual(c.lines, [rec(1), rec(2)], 'nothing from the new file reached the old reader');
});

test('poll returns reset when the file shrinks below the offset', async () => {
  const ref = await file(`${rec(1)}\n${rec(2)}\n`);
  const t = new Tailer();
  await t.readAll(ref, () => {});
  await fsp.truncate(ref.path, 5);
  assert.deepEqual(await t.poll(ref, () => {}), { reset: true, size: 5 });
});

test('readAll with end replays only up to it; poll delivers the rest (a cut line included)', async () => {
  const ref = await file(`${rec(1)}\n${rec(2)}\n${rec(3)}\n`);
  const t = new Tailer();
  const c = collector();
  const end = `${rec(1)}\n${rec(2)}`.length - 3; // inside the second line
  assert.equal((await t.readAll(ref, c.onLine, { end })).offset, end);
  assert.deepEqual(c.lines, [rec(1)]);
  const live = collector();
  await t.poll(ref, live.onLine);
  assert.deepEqual(live.lines, [rec(2), rec(3)]);
});

test('rename carries offset and partial line to a moved path (same inode only)', async () => {
  const ref = await file(`${rec(1)}\n${rec(2).slice(0, 4)}`);
  const t = new Tailer();
  await t.readAll(ref, () => {});
  const moved = path.join(tmp, 'moved.jsonl');
  await fsp.rename(ref.path, moved);
  await fsp.appendFile(moved, `${rec(2).slice(4)}\n${rec(3)}\n`);
  const st = await fsp.stat(moved);
  assert.equal(t.rename(ref.path, moved, { ino: st.ino + 1, size: st.size }), false, 'other inode');
  assert.equal(t.rename(ref.path, moved, { ino: st.ino, size: 1 }), false, 'shorter than the offset');
  assert.equal(t.rename(ref.path, moved, { ino: st.ino, size: st.size }), true);
  assert.equal(t.offsetOf(ref.path), null);
  const c = collector();
  await t.poll({ path: moved }, c.onLine);
  assert.deepEqual(c.lines, [rec(2), rec(3)]);
  assert.equal(t.rename(ref.path, moved, { ino: st.ino, size: st.size }), false, 'nothing left at the old path');
});

test('poll on a vanished file returns gone and keeps state until forget', async () => {
  const ref = await file(`${rec(1)}\n`);
  const t = new Tailer();
  await t.readAll(ref, () => {});
  const offset = t.offsetOf(ref.path);
  await fsp.unlink(ref.path);
  assert.deepEqual(await t.poll(ref, () => {}), { gone: true });
  assert.equal(t.offsetOf(ref.path), offset);
  t.forget(ref.path);
  assert.equal(t.offsetOf(ref.path), null);
  assert.deepEqual(await t.poll(ref, () => {}), { reset: true }, 'not attached -> reset');
});

test('readAll on a missing file returns gone without registering state', async () => {
  const t = new Tailer();
  const p = path.join(tmp, 'missing.jsonl');
  assert.deepEqual(await t.readAll({ path: p }, () => {}), { offset: 0, skipped: 0, gone: true });
  assert.equal(t.offsetOf(p), null);
});

test('lines over maxLineBytes are skipped and counted; exactly max is delivered', async () => {
  const max = 20;
  const exact = 'x'.repeat(max);
  const over = 'y'.repeat(max + 1);
  const ref = await file(`short\n${exact}\n${over}\nafter\n${'z'.repeat(100)}\nend\n`);
  const t = new Tailer({ maxLineBytes: max, chunkBytes: 7 });
  const c = collector();
  const res = await t.readAll(ref, c.onLine);
  assert.deepEqual(c.lines, ['short', exact, 'after', 'end']);
  assert.equal(res.skipped, 2);
  assert.equal(t.skippedOf(ref.path), 2);
  assert.equal(t.skippedLines, 2);
});

test('an oversized line spanning polls is skipped once and the next line survives', async () => {
  const ref = await file('first\n');
  const t = new Tailer({ maxLineBytes: 16, chunkBytes: 8 });
  const c = collector();
  await t.readAll(ref, c.onLine);
  await fsp.appendFile(ref.path, 'q'.repeat(40));
  const r1 = await t.poll(ref, c.onLine);
  assert.equal(r1.bytes, 40);
  assert.equal(r1.skipped, 1, 'counted when the limit is crossed');
  assert.equal(t.pendingBytes(ref.path), 0, 'oversized bytes are not buffered');
  await fsp.appendFile(ref.path, 'q'.repeat(30) + '\nnext\n');
  const r2 = await t.poll(ref, c.onLine);
  assert.equal(r2.skipped, 0, 'the same line is not counted twice');
  assert.deepEqual(c.lines, ['first', 'next']);
  assert.equal(t.skippedLines, 1);
});

test('a 3 MB line is delivered intact with 64 KB chunks', async () => {
  const big = JSON.stringify({ type: 'user', uuid: 'u-big', message: { content: 'ab가'.repeat(700_000) } });
  assert.ok(Buffer.byteLength(big) > 3 * 1024 * 1024);
  const ref = await file(`${rec(1)}\n${big}\n${rec(2)}\n`);
  const t = new Tailer({ chunkBytes: 64 * 1024 });
  const c = collector();
  await t.readAll(ref, c.onLine);
  assert.equal(c.lines.length, 3);
  assert.equal(c.lines[1], big);
  assert.equal(JSON.parse(c.lines[1]).uuid, 'u-big');
  // A multi-MB append is read through poll in chunks as well.
  await fsp.appendFile(ref.path, `${big}\n`);
  const r = await t.poll(ref, c.onLine);
  assert.equal(r.bytes, Buffer.byteLength(big) + 1);
  assert.equal(c.lines[3], big);
});

test('poll during a running readAll reports busy instead of double-reading', async () => {
  const ref = await file(Array.from({ length: 200 }, (_, i) => rec(i)).join('\n') + '\n');
  const t = new Tailer({ chunkBytes: 256 });
  const c = collector();
  const reading = t.readAll(ref, c.onLine);
  const during = await t.poll(ref, c.onLine);
  await reading;
  assert.deepEqual(during, { bytes: 0, busy: true });
  assert.equal(c.lines.length, 200);
  assert.equal(new Set(c.lines).size, 200);
});

test('forget during readAll stops delivering lines', async () => {
  const ref = await file(Array.from({ length: 200 }, (_, i) => rec(i)).join('\n') + '\n');
  const t = new Tailer({ chunkBytes: 128 });
  const c = collector();
  const res = await t.readAll(ref, (l) => { c.onLine(l); if (c.lines.length === 3) t.forget(ref.path); });
  assert.equal(res.forgotten, true);
  assert.ok(c.lines.length < 200);
  assert.equal(t.offsetOf(ref.path), null);
});

test('a throwing onLine leaves the chunk uncommitted so the next poll re-delivers it', async () => {
  const ref = await file(`${rec(1)}\n`);
  const t = new Tailer();
  await t.readAll(ref, () => {});
  const offset = t.offsetOf(ref.path);
  await fsp.appendFile(ref.path, `${rec(2)}\n${rec(3)}\n`);
  await assert.rejects(t.poll(ref, (l) => { if (l === rec(3)) throw new Error('boom'); }), /boom/);
  assert.equal(t.offsetOf(ref.path), offset);
  const c = collector();
  await t.poll(ref, c.onLine);
  assert.deepEqual(c.lines, [rec(2), rec(3)]);
});

test('an async onLine is awaited in order', async () => {
  const ref = await file(`${rec(1)}\n${rec(2)}\n${rec(3)}\n`);
  const t = new Tailer({ chunkBytes: 9 });
  const order = [];
  await t.readAll(ref, async (l) => {
    await new Promise((r) => setTimeout(r, 2));
    order.push(JSON.parse(l).uuid);
  });
  assert.deepEqual(order, ['u-1', 'u-2', 'u-3']);
});

test('readAll on a 20 MB file does not starve a concurrent setInterval', async (t) => {
  const p = path.join(tmp, 'big20.jsonl');
  const filler = 'invented filler text '.repeat(70); // about 1.5 KB per line
  const parts = [];
  let size = 0;
  for (let i = 0; size < 20 * 1024 * 1024; i += 1) {
    const l = `${rec(i, `${filler}${i}`)}\n`;
    parts.push(l);
    size += Buffer.byteLength(l);
  }
  await fsp.writeFile(p, parts.join(''));
  parts.length = 0;

  const tailer = new Tailer({ chunkBytes: 64 * 1024 });
  let count = 0;
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  let res;
  try {
    last = performance.now();
    // Simulate a caller that parses and applies each record (~20 us of CPU per line), so the whole read takes
    // far longer than 100 ms and only chunked reading with yields keeps the interval running.
    res = await tailer.readAll({ path: p }, (l) => {
      if (JSON.parse(l)) count += 1;
      const until = performance.now() + 0.02;
      while (performance.now() < until);
    });
  } finally {
    clearInterval(timer);
  }
  const elapsed = performance.now() - started;
  t.diagnostic(`20 MB readAll: ${elapsed.toFixed(0)} ms, ${count} lines, max interval gap ${maxGap.toFixed(1)} ms`);
  assert.equal(res.offset, size);
  assert.ok(count > 10_000);
  assert.ok(elapsed > 150, `read must outlast the gap bound to prove anything (took ${elapsed.toFixed(0)} ms)`);
  assert.ok(maxGap < 100, `event loop starved for ${maxGap.toFixed(1)} ms`);
});
