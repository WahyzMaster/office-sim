#!/usr/bin/env node
// L1 -> L2 Harness2 Lesson Promoter & Code-Anchor Freshness Verifier for Office Sim.
// Ported from wahyz_omni tools/ci/promote_lesson.mjs & memory_anchors.mjs.
//
// Enforces:
// 1. Grader-leak rejection (prevents copying protected test expectations into harness lessons)
// 2. Cost-ordered component hierarchy (skill -> script -> subagent -> hook -> gate -> memory -> always-on)
// 3. Code-anchor existence & symbol verification (path/to/file.mjs#Symbol)
// 4. schema: harness2-v1 frontmatter (dimension: INV|DOM, component, cue, lesson, evidence, confidence, verdict)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_COMPONENT_COST_ORDER } from './loop-attempt-ledger.mjs';

export const CODE_ANCHOR_REGEX = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:#([A-Za-z0-9_$]+))?$/;

export const PROTECTED_GRADER_PATTERNS = Object.freeze([
  /assert\.deepStrictEqual\s*\(/i,
  /assert\.strictEqual\s*\([^)]*expectedFixture/i,
  /FAKE_ROOT_GUARD_BYPASS/i,
  /skip-dom-invariants/i,
]);

export function assertNoGraderLeak({ text = '', extraPatterns = [] } = {}) {
  const combined = [...PROTECTED_GRADER_PATTERNS, ...extraPatterns];
  for (const re of combined) {
    if (re.test(text)) {
      throw new Error(`Grader-leak pattern detected in lesson payload: ${re}`);
    }
  }
  return true;
}

export function validateComponentCostChoice({
  chosenComponent,
  cheaperRejectedReasons = {},
} = {}) {
  const idx = HARNESS_COMPONENT_COST_ORDER.indexOf(chosenComponent);
  if (idx < 0) {
    throw new Error(
      `Unknown harness component "${chosenComponent}". Must be one of: ${HARNESS_COMPONENT_COST_ORDER.join(', ')}`,
    );
  }
  const cheaper = HARNESS_COMPONENT_COST_ORDER.slice(0, idx);
  const missing = cheaper.filter(
    (c) => typeof cheaperRejectedReasons?.[c] !== 'string' || !cheaperRejectedReasons[c].trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Component "${chosenComponent}" requires rejection reasons for cheaper tiers: ${missing.join(', ')}`,
    );
  }
  return { valid: true, chosenComponent, cheaperTiersChecked: cheaper };
}

export function validateLessonAnchors({
  repoRoot = process.cwd(),
  codeAnchors = [],
} = {}) {
  if (!Array.isArray(codeAnchors) || codeAnchors.length === 0) {
    throw new Error('At least one code_anchor (path/to/file.mjs#Symbol) is required');
  }
  const results = [];
  for (const rawAnchor of codeAnchors) {
    const m = CODE_ANCHOR_REGEX.exec(String(rawAnchor).trim());
    if (!m) {
      throw new Error(`Invalid code_anchor format: "${rawAnchor}" (expected path/to/file.mjs#Symbol)`);
    }
    const [, relFile, symbol] = m;
    const absFile = path.resolve(repoRoot, relFile);
    if (!fs.existsSync(absFile)) {
      throw new Error(`Anchor file does not exist: ${relFile}`);
    }
    const content = fs.readFileSync(absFile, 'utf8');
    if (symbol && !content.includes(symbol)) {
      throw new Error(`Anchor symbol "${symbol}" not found in ${relFile}`);
    }
    results.push({ anchor: rawAnchor, file: relFile, symbol: symbol ?? null, valid: true });
  }
  return results;
}

export function renderAnchoredMemoryMarkdown({
  id = 'lesson-unnamed',
  dimension = 'DOM',
  component = 'skill',
  cue = '',
  lesson = '',
  evidence = '',
  confidence = 0.9,
  verdict = 'promote',
  codeAnchors = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const resolvedDim = dimension === 'INV' ? 'INV' : 'DOM';
  assertNoGraderLeak({ text: `${cue}\n${lesson}\n${evidence}` });

  const anchorsYaml = codeAnchors.map((a) => `  - "${a}"`).join('\n');
  return [
    '---',
    'schema: harness2-v1',
    `id: "${id}"`,
    `dimension: ${resolvedDim}`,
    `component: ${component}`,
    `cue: "${String(cue).replace(/"/g, '\\"')}"`,
    `confidence: ${Number(confidence).toFixed(2)}`,
    `verdict: ${verdict}`,
    `created_at: "${createdAt}"`,
    'code_anchors:',
    anchorsYaml,
    '---',
    '',
    `# Lesson: ${id} (${resolvedDim} / ${component})`,
    '',
    '## Cue',
    cue,
    '',
    '## Lesson',
    lesson,
    '',
    '## Evidence',
    evidence,
    '',
    '## Code Anchors',
    ...codeAnchors.map((a) => `- \`${a}\``),
    '',
  ].join('\n');
}

export function promoteLesson({
  repoRoot = process.cwd(),
  id,
  dimension = 'DOM',
  component = 'skill',
  cheaperRejectedReasons = {},
  cue,
  lesson,
  evidence,
  confidence = 0.9,
  verdict = 'promote',
  codeAnchors = [],
  outputPath = null,
  nowIso = new Date().toISOString(),
} = {}) {
  assertNoGraderLeak({ text: `${cue}\n${lesson}\n${evidence}` });
  const costCheck = validateComponentCostChoice({
    chosenComponent: component,
    cheaperRejectedReasons,
  });
  const anchorCheck = validateLessonAnchors({ repoRoot, codeAnchors });
  const markdown = renderAnchoredMemoryMarkdown({
    id,
    dimension,
    component,
    cue,
    lesson,
    evidence,
    confidence,
    verdict,
    codeAnchors,
    createdAt: nowIso,
  });

  if (outputPath) {
    const resolvedOut = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, markdown, 'utf8');
  }

  return {
    ok: true,
    costCheck,
    anchorCheck,
    markdown,
    outputPath: outputPath ? path.resolve(outputPath) : null,
  };
}

export function verifyAnchorFreshness({ repoRoot = process.cwd(), markdown = '' } = {}) {
  const anchors = [];
  const lines = String(markdown).split(/\r?\n/);
  let inAnchors = false;
  for (const line of lines) {
    if (/^code_anchors:\s*$/.test(line.trim())) {
      inAnchors = true;
      continue;
    }
    if (inAnchors) {
      if (line.trim() === '---' || /^[a-z_]+:/i.test(line.trim())) {
        inAnchors = false;
        continue;
      }
      const m = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line);
      if (m) anchors.push(m[1].trim());
    }
  }
  const stale = [];
  for (const a of anchors) {
    try {
      validateLessonAnchors({ repoRoot, codeAnchors: [a] });
    } catch (err) {
      stale.push({ anchor: a, reason: err.message });
    }
  }
  return { total: anchors.length, staleCount: stale.length, stale };
}

function parseCliArgs(argv) {
  const out = { codeAnchors: [], cheaperRejectedReasons: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--id') out.id = argv[++i];
    else if (a === '--dimension') out.dimension = argv[++i];
    else if (a === '--component') out.component = argv[++i];
    else if (a === '--cue') out.cue = argv[++i];
    else if (a === '--lesson') out.lesson = argv[++i];
    else if (a === '--evidence') out.evidence = argv[++i];
    else if (a === '--anchor') out.codeAnchors.push(argv[++i]);
    else if (a === '--reject-reason') {
      const pair = String(argv[++i] ?? '');
      const eq = pair.indexOf('=');
      if (eq > 0) out.cheaperRejectedReasons[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (a === '--out') out.outputPath = argv[++i];
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  const res = promoteLesson(args);
  process.stdout.write(res.markdown);
}
