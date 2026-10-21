// The GET /healthz shape (contract 6) for server tests: the first five keys keep their old order and values, the
// keys after them are checked for presence and type only. Side-effect free at import (node --test runs test files only).
import assert from 'node:assert/strict';
import fs from 'node:fs';

export const OLD_KEYS = Object.freeze(['ok', 'files', 'sessions', 'agents', 'clients']);
export const NEW_KEYS = Object.freeze(['version', 'commit', 'startedAt', 'uptimeMs', 'badLines', 'skippedLines',
  'applyErrors', 'loopErrors', 'linkErrors', 'rejectedRefs', 'runners']);
export const RUNNER_KEYS = Object.freeze(['files', 'lastScanMs', 'lastScanAt', 'scanErr', 'badLines', 'skippedLines',
  'applyErrors', 'loopErrors', 'linkErrors']);
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** The old five keys only, for a deepEqual against what the test asserted before the new keys existed. */
export function oldHealth(h) {
  return Object.fromEntries(OLD_KEYS.map((k) => [k, h[k]]));
}

/** Key order and types of the whole body, and one runner entry per agent, in agents order. */
export function assertHealthShape(h) {
  assert.deepEqual(Object.keys(h), [...OLD_KEYS, ...NEW_KEYS]);
  assert.equal(h.version, PACKAGE_VERSION);
  assert.ok(h.commit === null || /^[0-9a-f]{7,40}$/.test(h.commit), `commit ${h.commit}`);
  assert.match(h.startedAt, ISO_RE);
  assert.ok(isCount(h.uptimeMs), `uptimeMs ${h.uptimeMs}`);
  for (const k of ['badLines', 'skippedLines', 'applyErrors', 'loopErrors', 'linkErrors', 'rejectedRefs']) assert.ok(isCount(h[k]), `${k} ${h[k]}`);
  assert.deepEqual(Object.keys(h.runners), h.agents);
  for (const [id, r] of Object.entries(h.runners)) {
    assert.deepEqual(Object.keys(r), RUNNER_KEYS, id);
    assert.ok(r.lastScanMs === null || isCount(r.lastScanMs), `${id} lastScanMs ${r.lastScanMs}`);
    assert.ok(r.lastScanAt === null || ISO_RE.test(r.lastScanAt), `${id} lastScanAt ${r.lastScanAt}`);
    assert.ok(r.scanErr === null || /^[A-Z][A-Z0-9_]{1,31}$/.test(r.scanErr), `${id} scanErr ${r.scanErr}`);
    for (const k of RUNNER_KEYS.slice(4)) assert.ok(isCount(r[k]), `${id} ${k} ${r[k]}`);
  }
  for (const k of ['files', ...RUNNER_KEYS.slice(4)]) {
    assert.equal(h[k], Object.values(h.runners).reduce((n, r) => n + r[k], 0), `${k} is the sum over the runners`);
  }
}
