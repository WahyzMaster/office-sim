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
