#!/usr/bin/env node
// Deterministic DOM invariant checker for office-sim:
// 1. Zero runtime dependencies in package.json.
// 2. Source files in bin/, src/, public/js/, and scripts/ stay <= 500 lines. Third-party files vendored under
//    public/vendor/ are not project source and are exempt (docs/CONTRACT.md section 0).
// 3. Always-on DOM markdown files (CLAUDE.md, AGENTS.md, GEMINI.md) contain no emoticons.
// 4. code_anchors in docs/lessons/*.md exist and resolve to live symbols.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDomHealth } from '../src/flywheel/dom-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audit = auditDomHealth(ROOT);

const violations = [
  ...audit.violations,
  ...audit.staleAnchors.map((s) => `${s.lesson} has stale code_anchor "${s.anchor}" (${s.reason})`),
];

if (violations.length > 0) {
  console.error(`[office-sim DOM invariants: FAIL] (${violations.length} violation(s))`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('[office-sim DOM invariants: PASS] (0 runtime dependencies, all code files <= 500 lines, no emoticons)');
