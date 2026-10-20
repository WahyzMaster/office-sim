// The schema-less protobuf reader of the Antigravity adapter (src/adapters/antigravity/proto.mjs, ADAPTERS 5.3) and the
// summaries parser on top of it (meta.mjs parseSummaries, inferred field numbers). Fuzz cases: truncation at every byte,
// random bytes, deep nesting, huge and unsafe lengths, groups and bad field numbers. The reader must never throw and
// never hand back a byte range outside its input. Invented bytes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readVarint, readFields, bytesAt, firstField, allFields, textOf, smallIntOf, WIRE, PROTO_LIMITS,
} from '../src/adapters/antigravity/proto.mjs';
import { parseSummaries, workspacePath } from '../src/adapters/antigravity/meta.mjs';
import { aid, varint, tag, lenField, intField, msg, summariesProto } from './fixtures/antigravity-tree.mjs';

// a deterministic PRNG (mulberry32) so a failing fuzz case can be replayed
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// every Buffer value must be a view inside `parent` (same memory, within its bounds)
function assertInside(fields, parent) {
  for (const f of fields) {
    if (!Buffer.isBuffer(f.value)) continue;
    assert.equal(f.value.buffer, parent.buffer, 'a view, not a copy');
    assert.ok(f.value.byteOffset >= parent.byteOffset, 'starts inside the input');
    assert.ok(f.value.byteOffset + f.value.length <= parent.byteOffset + parent.length, 'ends inside the input');
  }
}

test('readVarint: small, multi-byte, max safe, unsafe (consumed, null value), cut off, over 10 bytes', () => {
  assert.deepEqual(readVarint(Buffer.from([0x05]), 0), { value: 5, next: 1 });
  assert.deepEqual(readVarint(Buffer.from([0xac, 0x02]), 0), { value: 300, next: 2 });
  assert.deepEqual(readVarint(varint(Number.MAX_SAFE_INTEGER), 0), { value: Number.MAX_SAFE_INTEGER, next: 8 });
  assert.deepEqual(readVarint(varint(2n ** 62n), 0), { value: null, next: 9 });
  assert.deepEqual(readVarint(varint(2n ** 64n - 1n), 0), { value: null, next: 10 });
  assert.equal(readVarint(Buffer.from([0x80, 0x80]), 0), null, 'cut off');
  assert.equal(readVarint(Buffer.from(Array(11).fill(0xff).concat([0x01])), 0), null, 'more than 10 bytes');
  assert.equal(readVarint(Buffer.alloc(0), 0), null);
  assert.equal(readVarint('nope', 0), null);
  assert.equal(readVarint(Buffer.from([1]), -1), null);
});

test('readFields: every wire type, nested bytes stay raw views, complete flag', () => {
  const inner = msg(lenField(1, 'deep'), intField(2, 7));
  const buf = msg(intField(1, 150), lenField(2, inner), tag(3, 1), Buffer.alloc(8, 1), tag(4, 5), Buffer.alloc(4, 2), lenField(2, 'again'));
  const { fields, complete } = readFields(buf);
  assert.equal(complete, true);
  assert.deepEqual(fields.map((f) => [f.no, f.wire]), [[1, 0], [2, 2], [3, 1], [4, 5], [2, 2]]);
  assert.equal(fields[0].value, 150);
  assert.ok(fields[1].value.equals(inner));
  assert.equal(fields[2].value.length, 8);
  assert.equal(fields[3].value.length, 4);
  assertInside(fields, buf);
  assert.equal(firstField(fields, 2, WIRE.LEN).value.toString(), inner.toString());
  assert.deepEqual(allFields(fields, 2, WIRE.LEN).map((f) => f.value.length), [inner.length, 5]);
  assert.equal(firstField(fields, 2, WIRE.VARINT), null, 'wire type must match');
  assert.ok(bytesAt(buf, [2]).equals(inner));
  assert.equal(textOf(bytesAt(buf, [2, 1])), 'deep');
  assert.equal(bytesAt(buf, [2, 9]), null);
  assert.equal(smallIntOf(fields[0]), 150);
  assert.equal(smallIntOf(fields[1]), null);
});

test('readFields: malformed input stops early and keeps what was read before (groups, field 0, huge lengths)', () => {
  const good = intField(1, 1);
  const cases = {
    group: msg(good, tag(2, 3), intField(3, 1)),
    'end group': msg(good, tag(2, 4)),
    'wire 6': msg(good, tag(2, 6)),
    'wire 7': msg(good, tag(2, 7)),
    'field number 0': msg(good, Buffer.from([0x00, 0x01])),
    'length past the end': msg(good, tag(2, 2), varint(1000), Buffer.from('short')),
    'length near 2^62': msg(good, tag(2, 2), varint(2n ** 62n), Buffer.from('x')),
    'length 2^40 (safe, too big)': msg(good, tag(2, 2), varint(2 ** 40), Buffer.from('x')),
    'cut fixed64': msg(good, tag(2, 1), Buffer.alloc(3)),
    'cut fixed32': msg(good, tag(2, 5), Buffer.alloc(2)),
    'cut varint value': msg(good, tag(2, 0), Buffer.from([0xff])),
    'unsafe tag': msg(good, varint(2n ** 60n)),
  };
  for (const [name, buf] of Object.entries(cases)) {
    let r;
    assert.doesNotThrow(() => { r = readFields(buf); }, name);
    assert.equal(r.complete, false, name);
    assert.deepEqual(r.fields.map((f) => [f.no, f.value]), [[1, 1]], `${name}: only the field before the bad spot`);
  }
  assert.deepEqual(readFields(null), { fields: [], complete: false });
  assert.deepEqual(readFields('text'), { fields: [], complete: false });
  assert.deepEqual(readFields(Buffer.alloc(0)), { fields: [], complete: true });
});

test('readFields: field-count and input-size caps; bytesAt refuses paths deeper than the depth cap', () => {
  const many = Buffer.concat(Array.from({ length: 50 }, () => intField(1, 1)));
  const capped = readFields(many, { maxFields: 10 });
  assert.equal(capped.fields.length, 10);
  assert.equal(capped.complete, false);
  assert.deepEqual(readFields(many, { maxBytes: 10 }), { fields: [], complete: false });
  // 10,000 nested wrappers: the reader is flat, bytesAt stops at the depth cap without walking
  let deep = lenField(1, 'core');
  for (let i = 0; i < 10_000; i++) deep = lenField(1, deep);
  assert.equal(readFields(deep).fields.length, 1);
  assert.equal(bytesAt(deep, Array(PROTO_LIMITS.maxDepth + 1).fill(1)), null);
  assert.ok(Buffer.isBuffer(bytesAt(deep, Array(PROTO_LIMITS.maxDepth).fill(1))));
  assert.equal(bytesAt(deep, [1, 0]), null);
  assert.equal(bytesAt(deep, 'x'), null);
  assert.doesNotThrow(() => parseSummaries(deep));
  assert.equal(parseSummaries(deep).size, 0);
});

test('fuzz: a valid file truncated at every byte gives a prefix of the full decode and never throws', () => {
  const full = summariesProto([
    { id: aid(1), title: 'First invented title', status: 1, cwd: '/work/one', branch: 'main', remote: 'owner/repo' },
    { id: aid(2), title: '두 번째 제목', status: 2, cwd: '/work/공간 two' },
    { id: aid(3), status: 1 },
  ]);
  const whole = [...parseSummaries(full)];
  assert.equal(whole.length, 3);
  for (let n = 0; n <= full.length; n++) {
    const cut = full.subarray(0, n);
    const top = readFields(cut);
    assertInside(top.fields, cut);
    let got;
    assert.doesNotThrow(() => { got = [...parseSummaries(cut)]; }, `cut at ${n}`);
    assert.deepEqual(got, whole.slice(0, got.length), `cut at ${n}: a prefix of the full decode, nothing invented`);
  }
});

test('fuzz: random bytes, flipped bytes and spliced garbage never throw and stay inside the input', () => {
  const next = rng(0x5eed);
  const base = summariesProto([{ id: aid(4), title: 'Fuzz base', status: 1, cwd: '/work/fuzz', branch: 'dev' }]);
  for (let i = 0; i < 3000; i++) {
    let buf;
    if (i % 3 === 0) {
      buf = Buffer.from(Array.from({ length: Math.floor(next() * 300) }, () => Math.floor(next() * 256)));
    } else if (i % 3 === 1) {
      buf = Buffer.from(base);
      for (let k = 0; k < 1 + Math.floor(next() * 4); k++) buf[Math.floor(next() * buf.length)] = Math.floor(next() * 256);
    } else {
      const at = Math.floor(next() * base.length);
      buf = Buffer.concat([base.subarray(0, at), Buffer.from(Array.from({ length: 8 }, () => Math.floor(next() * 256))), base.subarray(at)]);
    }
    // a parent buffer with sentinels around the input: no returned view may reach them
    const padded = Buffer.concat([Buffer.from([0xee, 0xee]), buf, Buffer.from([0xee, 0xee])]);
    const input = padded.subarray(2, 2 + buf.length);
    let r;
    assert.doesNotThrow(() => { r = readFields(input); }, `case ${i}`);
    assertInside(r.fields, input);
    for (const f of r.fields) if (f.wire === WIRE.LEN) assertInside(readFields(f.value).fields, input);
    assert.doesNotThrow(() => parseSummaries(input), `parse case ${i}`);
    assert.doesNotThrow(() => bytesAt(input, [1, 2, 9, 1]), `path case ${i}`);
  }
});

test('textOf: strict UTF-8, no control characters, length caps; smallIntOf bounds', () => {
  assert.equal(textOf(Buffer.from('제목 title\twith tab')), '제목 title\twith tab');
  assert.equal(textOf(Buffer.from([0xc3, 0x28])), null, 'invalid UTF-8');
  assert.equal(textOf(Buffer.from('a\u0000b')), null);
  assert.equal(textOf(Buffer.from('a\u001bb')), null);
  assert.equal(textOf(Buffer.alloc(0)), null);
  assert.equal(textOf(Buffer.from('x'.repeat(11)), 10), null);
  assert.equal(textOf(null), null);
  assert.equal(smallIntOf({ wire: 0, value: 2 ** 31 }), null);
  assert.equal(smallIntOf({ wire: 0, value: null }), null);
  assert.equal(smallIntOf({ wire: 0, value: -1 }), null);
});

test('parseSummaries: only 1.2.1 title, 1.2.5 status, 1.2.9.1 workspace and 1.2.9.4 branch; keys are uuids; last entry wins', () => {
  const buf = Buffer.concat([
    summariesProto([
      { id: aid(1), title: 'Old title', status: 2, cwd: '/work/old' },
      { id: aid(2), title: 'Plain', status: 9, uri: 'https://example.com/not-a-file?q=BAIT' },
      { id: 'not-a-uuid', title: 'BAIT_KEY', status: 1, cwd: '/work/bait' },
    ]),
    summariesProto([{ id: aid(1).toUpperCase(), title: 'New title', status: 1, cwd: '/work/new/', branch: 'feature/x', remote: 'owner/secret-repo' }]),
    lenField(1, msg(lenField(1, aid(5)))), // an entry without a value
    lenField(1, msg(intField(1, 3), lenField(2, msg(lenField(1, 'BAIT_INT_KEY'))))), // key is not text
  ]);
  const map = parseSummaries(buf);
  assert.deepEqual([...map.keys()], [aid(1), aid(2)]);
  assert.deepEqual(map.get(aid(1)), { title: 'New title', status: 'idle', cwd: '/work/new', branch: 'feature/x' });
  assert.deepEqual(map.get(aid(2)), { title: 'Plain' }, 'status 9 unknown, a non-file URI is no cwd');
  assert.ok(!JSON.stringify([...map]).includes('BAIT'), 'never reads 9.2, 9.3, 15, 17 or a non-uuid key');
  // a title that is itself message-shaped bytes is still read as text (no guessing)
  const shapedTitle = `"!${'a'.repeat(33)}`; // 0x22 0x21 ...: field 4, 33 bytes, a valid message in printable text
  assert.equal(readFields(Buffer.from(shapedTitle)).complete, true);
  assert.equal(parseSummaries(summariesProto([{ id: aid(6), title: shapedTitle }])).get(aid(6)).title, shapedTitle);
  assert.equal(parseSummaries(Buffer.from('not protobuf at all')).size, 0);
  assert.equal(parseSummaries(null).size, 0);
});

test('workspacePath: file URIs to absolute paths only', () => {
  assert.equal(workspacePath('file:///Users/x/My%20Project'), '/Users/x/My Project');
  assert.equal(workspacePath('file://localhost/work/a/'), '/work/a');
  assert.equal(workspacePath('file:///work/%ED%95%9C%EA%B8%80'), '/work/한글');
  assert.equal(workspacePath('file:///'), '/');
  for (const bad of ['file://otherhost/x', 'https://example.com/x', '/plain/path', 'file:///a%2Fb', 'file:///a%00b', '', null, 'file:'.padEnd(5000, 'x')]) {
    assert.equal(workspacePath(bad), null, String(bad).slice(0, 40));
  }
});
