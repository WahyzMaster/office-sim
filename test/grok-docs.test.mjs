// Docs and metadata that describe the shipped Grok adapter (P5c review findings 3 and 10, plus the doc rows of 1, 2, 7).
// These checks pin the specific stale sentences that once contradicted the code: the CONTRACT 4.6 record rows must state
// the turn rules that src/adapters/grok/session.mjs implements, and package.json must name both supported agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
// One row of the CONTRACT 4.6 record table, by the first cell's leading text.
function row(start) {
  const sec = read('docs/CONTRACT.md').split('### 4.6 Grok adapter')[1].split('\n## 5.')[0];
  const line = sec.split('\n').find((l) => l.startsWith(`| ${start}`));
  assert.ok(line, `CONTRACT 4.6 row ${start}`);
  return line;
}

test('package.json description names both supported agents, like README (finding 10)', () => {
  const { description } = JSON.parse(read('package.json'));
  assert.match(description, /Claude Code/);
  assert.match(description, /Grok/);
  assert.match(read('README.md').split('\n')[2], /Grok/);
});

test('CONTRACT 4.6 user_message_chunk, hook_execution and late-records rows describe the shipped turn rules (finding 3)', () => {
  const user = row('`user_message_chunk`');
  assert.doesNotMatch(user, /Opens a new turn at once/);
  for (const re of [/no work yet/, /user_prompt_submit/, /hook first/i, /message first/i, /promptIndex/, /interjection/]) assert.match(user, re);
  assert.match(row('`hook_execution`'), /`turn_start \{ id \}`/);
  assert.match(row('a message, thought or `tool_call` record of a turn that already ended'), /adopts the previous turn's id/);
});

test('CONTRACT 4.6 chunk rows: one record is one item, no join, no idle fallback (findings 1, 2, 7)', () => {
  const say = row('`agent_message_chunk`');
  assert.doesNotMatch(say, /only the turn's last text arms|the same holds for thoughts|joined as one stream/);
  assert.match(say, /never `final`/);
  assert.match(row('`agent_thought_chunk`'), /its own `thinking \{ text/);
});

// ---- P5g live approval wait: the doc rows that describe the shipped wire and reader (spec step 10) -----------------

const section = (doc, start, end) => {
  const rest = read(doc).split(start)[1];
  assert.ok(rest !== undefined, `${doc}: ${start}`);
  return rest.split(end)[0];
};

test('CONTRACT 2: a tool_wait row with exactly its two fields; awaitsApproval stays replay-only; the snapshot order note', () => {
  const s2 = section('docs/CONTRACT.md', '## 2. Event schema', '\n## 3.');
  const wait = s2.split('\n').find((l) => l.startsWith('| `tool_wait` |'));
  assert.ok(wait, 'tool_wait row');
  assert.match(wait, /`toolUseId`, `waiting` \(bool\), exactly these two/);
  assert.match(wait, /A deny sends no `false`/);
  const start = s2.split('\n').find((l) => l.startsWith('| `tool_start` |'));
  assert.match(start, /`awaitsApproval` \(`true` only in replay mode/);
  assert.match(s2, /right after that tool's `tool_start`, as a JSON-identical copy/);
});

test('CONTRACT 4.0.2: the tool_wait item and the snapshot description', () => {
  const s = section('docs/CONTRACT.md', '### 4.0.2 SessionCore', '\n### 4.1');
  assert.match(s, /\{ k: 'tool_wait', id, waiting \/\* boolean \*\/ \}/);
  assert.match(s, /open tool_starts, each waiting one followed by its tool_wait/);
  assert.match(s, /`waitFields` \(P5g\)/);
});

test('CONTRACT 4.6: events.jsonl moved to the read list with exactly four fields, plus the Approval wait block', () => {
  const s = section('docs/CONTRACT.md', '### 4.6 Grok adapter', '\n## 5.');
  const read46 = s.split('\n- Read, and nothing else:')[1].split('\n- Names:')[0];
  const [readPart, neverPart] = read46.split('Never opened:');
  assert.match(readPart, /`events.jsonl` \(`GrokMeta`, P5g/);
  assert.match(readPart, /exactly four fields: `type`, `ts`, `tool_name` and `decision`/);
  assert.doesNotMatch(neverPart, /events\.jsonl/, 'events.jsonl is no longer in the never-opened list');
  const block = s.split('\nApproval wait (P5g')[1].split('\nDescriptor and session end:')[0];
  assert.match(block, /Fields read, exactly four: `type`, `ts`, `tool_name` [^;]*? and `decision` \(`permission_resolved` only\)/);
  for (const re of [/APPROVAL_SHOW_MS/, /PAIR_MS/, /O_NOFOLLOW/, /the decider may be Grok's automatic review/, /Subagent sessions are treated exactly like mains/]) {
    assert.match(block, re);
  }
  assert.match(s, /sidecarWatcher: a fresh GrokMeta\(sidecars\)/);
});

test('CONTRACT 7: Claude live still shows nothing; the Grok live subsection with neutral decider wording', () => {
  const s7 = read('docs/CONTRACT.md').split('\n## 7. Permission-approval wait')[1];
  assert.ok(s7, 'section 7');
  assert.match(s7, /no certain signal exists, so live Claude mode shows nothing/);
  const g = s7.split('### 7.1 Grok live (P5g)')[1];
  assert.ok(g, '7.1 Grok live');
  assert.match(g, /the decider may be Grok's automatic review rather than a person/);
  assert.match(g, /`awaitsApproval` stays replay-only/);
  assert.match(read('docs/CONTRACT.md').split('\n')[0], /P5g/);
});

test('ADAPTERS, README and the research note describe P5g as shipped, with the write-clock correction', () => {
  const adapters = read('docs/ADAPTERS.md');
  assert.match(adapters, /\| \(선택\) P5g Grok 승인 대기 \(완료, 2026-10-21\) \|/);
  assert.match(adapters.split('\n').find((l) => l.startsWith('| D7 |')), /결과\(P5g/);
  assert.match(adapters, /쓰는 시각 정정/);
  const readme = read('README.md');
  assert.match(readme.split('\n').find((l) => l.startsWith('| Grok (xAI Grok Build) |')), /라이브 승인 대기/);
  assert.doesNotMatch(readme, /런타임 이벤트\(`events\.jsonl`\)/, 'README no longer says events.jsonl is never opened');
  const note = read('docs/research/grok-format.json');
  JSON.parse(note);
  assert.doesNotMatch(note, /first update BEFORE the human answers \(for waits/);
  assert.match(note, /So the lead is an agent-clock stamp, not write order/);
});

test('P5g review: one long-wait band (5-30 s) in CONTRACT 7.1 and ADAPTERS; neutral research note; per-announce latch', () => {
  const g = read('docs/CONTRACT.md').split('### 7.1 Grok live (P5g)')[1];
  assert.match(g, /most long waits last\s+5-30 s/);
  assert.doesNotMatch(g, /4-30 s/);
  assert.match(read('docs/ADAPTERS.md'), /5~30초 구간/);
  const note = read('docs/research/grok-format.json');
  assert.doesNotMatch(note, /waiting on a human/);
  assert.match(note, /a permission prompt is open \(the decider may be a person or Grok's automatic review; no field names it\)/);
  const s2 = section('docs/CONTRACT.md', '## 2. Event schema', '\n## 3.');
  const wait = s2.split('\n').find((l) => l.startsWith('| `tool_wait` |'));
  assert.match(wait, /At most one `true` per `toolUseId` per announce/);
  assert.match(wait, /a caught-up read no longer lists a prompt that was shown/);
});
