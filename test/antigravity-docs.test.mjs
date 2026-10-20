// Docs that describe the shipped Antigravity adapter (P5e review findings 2, 1 and 3). The governing contract
// (CONTRACT 4.8) and the design tables (ADAPTERS 5.3, 6.1, 6.2) must name every tool the name table maps (finding 2:
// edit_file, found by the integration's real-data count) and the arguments it never reads, state that CHECKPOINT does
// not close waiting calls (finding 1) and that only a top-level USER_REQUEST block is the prompt (finding 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOLS } from '../src/adapters/antigravity/tools.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const between = (text, from, to) => {
  const i = text.indexOf(from);
  assert.ok(i >= 0, from);
  const j = text.indexOf(to, i + from.length);
  return text.slice(i, j < 0 ? undefined : j);
};
const contract = () => between(read('docs/CONTRACT.md'), '### 4.8 Antigravity adapter', '\n## 5.');
const adapters62 = () => between(read('docs/ADAPTERS.md'), '### 6.2 도구 -> 방', '### 6.3');
const rowsOf = (sec) => sec.split('\n').filter((l) => l.startsWith('| '));
const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
const names = (text) => new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));

test('finding 2: CONTRACT 4.8 tool table names every tool of the name table, with edit_file reading Path', () => {
  const sec = contract();
  const table = between(sec, '| tool (`name`) | descriptor | room |', '\n\n');
  const listed = new Set(rowsOf(table).flatMap((r) => [...names(cells(r)[0])]));
  for (const name of Object.keys(TOOLS)) assert.ok(listed.has(name), `CONTRACT 4.8 tool table: ${name}`);
  const edit = rowsOf(table).find((r) => cells(r)[0].includes('`edit_file`'));
  assert.match(edit, /`path: Path`/);
  assert.match(cells(edit)[2], /dev/);
});

test('finding 2: CONTRACT 4.8 never-read list and the tools.mjs header name Target and Replacement', () => {
  const never = between(contract(), 'Never read:', 'every other argument');
  for (const arg of ['Target', 'Replacement', 'ArtifactMetadata', 'TargetContent', 'ReplacementContent']) {
    assert.ok(never.includes(`\`${arg}\``), `CONTRACT 4.8 never-read: ${arg}`);
  }
  const header = read('src/adapters/antigravity/tools.mjs').split('\nimport ')[0];
  assert.match(header, /\bTarget\b/);
  assert.match(header, /\bReplacement\b/);
  assert.match(header, /\bedit_file\b/);
});

test('finding 2: ADAPTERS 6.2 Antigravity column names every tool; 5.3 notes edit_file and where it was found', () => {
  const rows = rowsOf(adapters62()).filter((r) => cells(r)[0] !== '방'); // not the header row
  const listed = new Set(rows.flatMap((r) => [...names(cells(r).at(-1))]));
  for (const name of Object.keys(TOOLS)) assert.ok(listed.has(name), `ADAPTERS 6.2 Antigravity column: ${name}`);
  const dev = rows.find((r) => cells(r)[0] === '개발실');
  assert.match(cells(dev).at(-1), /`edit_file`/);
  const s53 = between(read('docs/ADAPTERS.md'), '### 5.3 Antigravity', '## 6.');
  assert.match(s53, /`edit_file`/);
  assert.match(s53, /`Target`/);
});

test('finding 1: CHECKPOINT closes nothing in CONTRACT 4.8 and ADAPTERS 5.3 / 6.1', () => {
  const sec = contract();
  const row = rowsOf(sec).find((r) => r.startsWith('| `CHECKPOINT`'));
  assert.doesNotMatch(row, /end `abandoned`/);
  assert.match(row, /keep waiting/);
  assert.doesNotMatch(sec, /`USER_INPUT`, `CHECKPOINT` or `ERROR_MESSAGE` line/);
  const doc = read('docs/ADAPTERS.md');
  assert.doesNotMatch(doc, /`PLANNER_RESPONSE`\/`USER_INPUT`\/`CHECKPOINT`\/`ERROR_MESSAGE` 가 오면/);
  const abandoned = rowsOf(between(doc, '### 6.1 신호 -> 이벤트', '### 6.2')).find((r) => r.startsWith('| `abandoned`'));
  assert.doesNotMatch(cells(abandoned).at(-1), /체크포인트/);
});

test('finding 3: CONTRACT 4.8 USER_INPUT row: only a top-level USER_REQUEST block, never one inside another block', () => {
  const row = rowsOf(contract()).find((r) => r.startsWith('| `USER_INPUT`'));
  assert.match(row, /top-level/);
  assert.match(row, /inside another block/);
});
