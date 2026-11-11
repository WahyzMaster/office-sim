// Launch readiness D11 (honest numbers): no cost or USD figure anywhere, and the context and token figures that stay are
// labelled as estimates in Korean and English wherever a label is rendered (inspector rows, tooltips, recap Markdown).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRecapTracker } from '../src/session-recap.mjs';
import {
  EXTRAS_TEXT,
  applyEventToMetrics,
  createAgentMetricsState,
  formatMetricsSummary,
  installAgentExtras,
} from '../public/js/agent-extras.js';
import { SIM_OVERLAYS_TEXT } from '../public/js/sim-overlays.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const COST_WORDS = /\$|usd|cost|spend|비용|달러/i;
const ESTIMATE = { ko: /추정/, en: /\best\.|\bestimate/i };
// The recap Markdown groups digits with the locale of the process (toLocaleString), so the expected text does too.
const n = (v) => v.toLocaleString();

/** Every string a language table can show: plain values, and function values called with sample arguments. */
function shownStrings(table) {
  return Object.entries(table).map(([key, v]) => [key, typeof v === 'function' ? v('12.3k', '4.5k', 6, 7) : v]);
}

test('D11 text: no cost wording in either language, and the context and token labels say they are estimates', () => {
  assert.deepEqual(Object.keys(EXTRAS_TEXT.ko).sort(), Object.keys(EXTRAS_TEXT.en).sort(), 'ko / en key parity');
  for (const lang of ['ko', 'en']) {
    const t = EXTRAS_TEXT[lang];
    for (const [key, text] of shownStrings(t)) {
      assert.equal(typeof text, 'string', `${lang}.${key}`);
      assert.equal(COST_WORDS.test(text), false, `${lang}.${key} mentions a cost: ${text}`);
    }
    for (const key of ['contextRow', 'tokenRow', 'estimateTitle', 'recapTitle']) {
      assert.match(t[key], ESTIMATE[lang], `${lang}.${key} is not labelled an estimate: ${t[key]}`);
    }
    assert.equal('costRow' in t, false);
  }
  // The token row value is language aware too (the numbers are passed in, already formatted).
  assert.equal(EXTRAS_TEXT.en.tokenValue('12.3k', '4.5k', 6, 7), '~12.3k in / 4.5k out (6 tools · 7 turns)');
  assert.equal(EXTRAS_TEXT.ko.tokenValue('12.3k', '4.5k', 6, 7), '~입력 12.3k / 출력 4.5k (도구 6 · 턴 7)');
});

test('D11 page metrics: no cost field, and the summary keeps the token and context figures marked as estimates', () => {
  const m = createAgentMetricsState();
  for (const ev of [
    { type: 'prompt' }, { type: 'thinking' }, { type: 'say', text: 'x'.repeat(200) },
    { type: 'tool_start', tool: 'Edit', summary: 'a.mjs' }, { type: 'turn_end' },
  ]) applyEventToMetrics(m, ev);
  assert.deepEqual(Object.keys(m).filter((k) => /cost|usd|spend/i.test(k)), []);
  assert.equal(m.inputTokens, 650 + 900);
  assert.equal(m.outputTokens, 450 + 300);
  assert.equal(m.contextTokens, 650 + 450 + 300 + 900);

  const s = formatMetricsSummary(m, 'Claude', 'office-sim');
  assert.deepEqual(Object.keys(s).filter((k) => /cost|usd|spend/i.test(k)), []);
  assert.equal(s.inputTokens, 1550);
  assert.equal(s.outputTokens, 750);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.turns, 1);
  assert.equal(s.pct, 1);
  assert.match(s.contextLabel, /^~1% \(2k \/ 200k · C:0\)$/);
  assert.equal(COST_WORDS.test(s.markdown), false, s.markdown);
  const lines = s.markdown.split('\n');
  assert.ok(lines.includes(`- **Context Fuel (est.)**: 1% (${n(2300)} / ${n(200_000)} tokens)`), s.markdown);
  assert.ok(lines.includes(`- **Tokens (est.)**: ${n(1550)} in / ${n(750)} out`), s.markdown);
});

test('D11 server recap: no cost field or constant, the Markdown marks the estimates', () => {
  const tracker = new SessionRecapTracker();
  for (const ev of [
    { type: 'session', sessionId: 's-honest', agent: 'claude-code', title: 'Honest', projectLabel: 'office-sim' },
    { type: 'prompt', sessionId: 's-honest', text: 'hello' },
    { type: 'tool_start', sessionId: 's-honest', tool: 'Edit', summary: 'a.mjs' },
    { type: 'turn_end', sessionId: 's-honest' },
  ]) tracker.observeEvent(ev);
  const recap = tracker.getRecap('s-honest');
  assert.deepEqual(Object.keys(recap).filter((k) => /cost|usd|spend|cache/i.test(k)), []);
  assert.equal(recap.estimatedInputTokens, 650 + 900);
  assert.equal(recap.estimatedOutputTokens, 0);
  assert.equal(recap.contextTokens, 1550);
  assert.equal(recap.contextWindow, 200_000);
  assert.equal(COST_WORDS.test(recap.markdown), false, recap.markdown);
  const lines = recap.markdown.split('\n');
  assert.ok(lines.includes(`- **Context Fuel (est.)**: 1% (${n(1550)} / ${n(200_000)} tokens) · **Compactions**: 0`), recap.markdown);
  assert.ok(lines.includes(`- **Tokens (est.)**: ${n(1550)} in / 0 out`), recap.markdown);
  // The record the tracker keeps has no cost or cache-read counter either (the latter fed only the cost).
  assert.deepEqual(Object.keys(tracker.sessions.get('s-honest')).filter((k) => /cost|usd|cache/i.test(k)), []);
});

// ---- the inspector rows, through a minimal fake DOM (no browser) ---------------------------------------------------
function fakeEl(tag) {
  return {
    tag, dataset: {}, textContent: '', title: '', children: [], parent: null, hidden: false,
    setAttribute() {}, addEventListener() {},
    append(...els) { for (const el of els) { el.parent = this; this.children.push(el); } },
    appendChild(el) { this.append(el); return el; },
    get previousElementSibling() {
      const i = this.parent ? this.parent.children.indexOf(this) : -1;
      return i > 0 ? this.parent.children[i - 1] : null;
    },
    querySelector(sel) {
      const m = /^dd\[data-row="([^"]+)"\]$/.exec(sel);
      return m ? (this.children.find((c) => c.tag === 'dd' && c.dataset.row === m[1]) ?? null) : null;
    },
  };
}

test('D11 inspector: an estimated context row and an estimated token row, no cost row, in Korean and English', () => {
  const dl = fakeEl('dl');
  const insp = { querySelector: (sel) => (sel === 'dl' ? dl : null), appendChild() {} };
  const doc = { getElementById: () => null, createElement: fakeEl, head: { appendChild() {} } };
  const office = { onEvent() {}, update() {}, select() {}, agents: new Map(), selected: null };
  const hud = { lang: 'en', el: { insp } };
  const extras = installAgentExtras({ office, hud, doc, win: { addEventListener() {} }, fetchFn: () => null });
  for (const ev of [
    { type: 'prompt', sessionId: 's1' },
    { type: 'tool_start', sessionId: 's1', tool: 'Edit', summary: 'a.mjs' },
    { type: 'turn_end', sessionId: 's1' },
  ]) office.onEvent(ev);
  const agent = { id: 's1', name: 'Claude' };
  const rows = () => {
    const out = {};
    for (const dd of dl.children.filter((c) => c.tag === 'dd')) {
      out[dd.dataset.row] = { label: dd.previousElementSibling.textContent, value: dd.textContent, title: dd.title, labelTitle: dd.previousElementSibling.title };
    }
    return out;
  };

  extras.renderInspectorExtras(agent);
  const en = rows();
  assert.deepEqual(Object.keys(en).sort(), ['contextFuel', 'estTokens']);
  assert.equal(en.contextFuel.label, 'Context Fuel (est.)');
  assert.equal(en.contextFuel.value, '~1% (2k / 200k · C:0)');
  assert.equal(en.estTokens.label, 'Tokens (est.)');
  assert.equal(en.estTokens.value, '~1.6k in / 0 out (1 tools · 1 turns)');
  for (const row of Object.values(en)) {
    assert.equal(row.title, EXTRAS_TEXT.en.estimateTitle);
    assert.equal(row.labelTitle, EXTRAS_TEXT.en.estimateTitle);
    assert.equal(COST_WORDS.test(`${row.label} ${row.value} ${row.title}`), false);
  }

  hud.lang = 'ko';
  extras.renderInspectorExtras(agent);
  const ko = rows();
  assert.deepEqual(Object.keys(ko).sort(), ['contextFuel', 'estTokens'], 'the same two rows are updated in place');
  assert.equal(ko.contextFuel.label, '컨텍스트 연료 (추정)');
  assert.equal(ko.estTokens.label, '토큰 (추정)');
  assert.equal(ko.estTokens.value, '~입력 1.6k / 출력 0 (도구 1 · 턴 1)');
  for (const row of Object.values(ko)) {
    assert.equal(row.title, EXTRAS_TEXT.ko.estimateTitle);
    assert.equal(COST_WORDS.test(`${row.label} ${row.value} ${row.title}`), false);
  }
});

// ---- nothing left behind in the source, and the documents say the same thing --------------------------------------
function sourceFiles(dir, exts, out = []) {
  for (const d of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) { if (rel !== path.join('public', 'vendor')) sourceFiles(rel, exts, out); } else if (exts.some((e) => d.name.endsWith(e))) out.push(rel);
  }
  return out;
}

test('D24 the compaction toast states no percentage, in Korean and English', () => {
  // the page knows that a compaction happened, not how much context it freed
  assert.equal(EXTRAS_TEXT.en.compactToast, 'Context compacted');
  assert.equal(EXTRAS_TEXT.ko.compactToast, '기억 압축 완료');
  for (const lang of ['ko', 'en']) assert.doesNotMatch(EXTRAS_TEXT[lang].compactToast, /\d|%|percent|퍼센트|확보|freed/i, lang);
  assert.doesNotMatch(read('public/js/agent-extras.js'), /65\s*%/);
});

test('D24 lens labels: no cost wording in either language (the heatmap shows context fill and crowding)', () => {
  assert.deepEqual(Object.keys(SIM_OVERLAYS_TEXT.ko).sort(), Object.keys(SIM_OVERLAYS_TEXT.en).sort(), 'ko / en key parity');
  assert.deepEqual(Object.keys(SIM_OVERLAYS_TEXT.ko.modes), Object.keys(SIM_OVERLAYS_TEXT.en.modes));
  for (const lang of ['ko', 'en']) {
    const shown = [...Object.values(SIM_OVERLAYS_TEXT[lang].modes), ...Object.values(SIM_OVERLAYS_TEXT[lang]).filter((v) => typeof v === 'string')];
    for (const text of shown) assert.equal(COST_WORDS.test(text), false, `${lang}: ${text}`);
  }
  assert.equal(SIM_OVERLAYS_TEXT.ko.modes.heatmap, '2: 열지도');
  assert.equal(SIM_OVERLAYS_TEXT.en.modes.heatmap, '2: Heatmap');
});

test('D11 source: no cost constant, field or label is left in src/, bin/ or public/', () => {
  const stale = /estimatedCostUsd|costUsd|costLabel|costRow|estCost|COST_PER_|cacheReadTokens/;
  const hits = [...sourceFiles('src', ['.mjs']), ...sourceFiles('bin', ['.mjs']), ...sourceFiles('public', ['.js', '.html'])]
    .filter((rel) => stale.test(read(rel)));
  assert.deepEqual(hits, []);
});

test('D11 documents: no USD or spend claim; the context ring is described as an estimate', () => {
  const claims = /cost estimator|spend in USD|estimated (session )?spend|USD|비용\(USD\)|추정 비용|토큰·비용/i;
  for (const rel of ['README.md', 'README.ko.md']) {
    const lines = read(rel).split('\n');
    assert.deepEqual(lines.filter((l) => claims.test(l)).map((l) => l.slice(0, 80)), [], `${rel} still claims a cost figure`);
  }
  const ring = (rel, name, word) => read(rel).split('\n').filter((l) => name.test(l)).some((l) => word.test(l));
  assert.ok(ring('README.md', /context (window fuel |fuel )?ring/i, /estimate/i), 'README.md: ring not called an estimate');
  assert.ok(ring('README.ko.md', /컨텍스트 (연료 )?링/, /추정/), 'README.ko.md: ring not called an estimate');
  // The specification names the figures and says they are estimates without a cost.
  const contract = read('docs/CONTRACT.md');
  const s10 = contract.split('\n## 10. Estimated context and token figures')[1];
  assert.ok(s10, 'CONTRACT section 10');
  for (const re of [/No cost\./, /estimates, not readings/, /`prompt` 650 tokens/, /`tool_start` 900/, /200,000 tokens/, /`estTokens`/]) {
    assert.match(s10, re);
  }
  assert.equal(/estimatedCostUsd/.test(contract.replace(/no `estimatedCostUsd`/g, '')), false);
});
