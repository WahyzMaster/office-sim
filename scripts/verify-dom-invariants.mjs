#!/usr/bin/env node
// Deterministic DOM invariant checker for office-sim:
// 1. Zero runtime dependencies in package.json.
// 2. Source files in bin/, src/, public/js/, and scripts/ stay <= 500 lines.
// 3. Always-on DOM markdown files (CLAUDE.md, AGENTS.md, GEMINI.md) contain no emoticons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 500;
const CODE_DIRS = ['bin', 'src', 'public/js', 'scripts'];
const MD_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONTRIBUTING.md'];
const EMOTICON_RE = /\p{Extended_Pictographic}/u;

const violations = [];

// 1. Zero runtime dependencies check
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const depKeys = Object.keys(pkg.dependencies ?? {});
if (depKeys.length > 0) {
  violations.push(`package.json must have zero runtime dependencies (found: ${depKeys.join(', ')})`);
}

// 2. <= 500 lines per code file
function walkCode(dirRel) {
  const absDir = path.join(ROOT, dirRel);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = path.posix.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      walkCode(rel);
    } else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const lines = text.split('\n').length;
      if (lines > MAX_LINES) {
        violations.push(`${rel} has ${lines} lines (cap: ${MAX_LINES})`);
      }
    }
  }
}
for (const dir of CODE_DIRS) walkCode(dir);

// 3. No emoticons in DOM governance markdown files
for (const mdRel of MD_FILES) {
  const mdPath = path.join(ROOT, mdRel);
  if (!fs.existsSync(mdPath)) continue;
  const text = fs.readFileSync(mdPath, 'utf8');
  if (EMOTICON_RE.test(text)) {
    violations.push(`${mdRel} contains emoticons (disallowed by CONTRIBUTING.md and GEMINI.md)`);
  }
}

if (violations.length > 0) {
  console.error(`[office-sim DOM invariants: FAIL] (${violations.length} violation(s))`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('[office-sim DOM invariants: PASS] (0 runtime dependencies, all code files <= 500 lines, no emoticons)');
