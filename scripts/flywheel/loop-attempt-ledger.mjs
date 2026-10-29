#!/usr/bin/env node
// L1 -> L2 Loop Attempt Ledger & Repeated Friction Detector for Office Sim.
// Ported from wahyz_omni tools/ci/loop_attempt_ledger.mjs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HARNESS_COMPONENT_COST_ORDER = Object.freeze([
  'skill',
  'script',
  'subagent',
  'hook',
  'gate',
  'memory',
  'always-on',
]);

export const VALID_FRICTION_CLASSES = Object.freeze([
  'none',
  'missing-context',
  'wrong-modality',
  'stale-memory',
  'flaky-gate',
  'invariant-violation',
  'over-budget-file',
  'other',
]);

function sanitizeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '/')
    .replace(/\r?\n/g, ' ')
    .trim();
}

export function parseLoopContractLedgerTable(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const entries = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|\s*Attempt\s*\|\s*Timestamp\s*\|/i.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\|[\s:-]+\|/.test(trimmed)) continue;
    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    entries.push({
      attempt: Number(cells[0]) || entries.length + 1,
      timestamp: cells[1],
      gate: cells[2],
      outcome: cells[3],
      frictionClass: cells[4],
      notes: cells[5],
    });
  }
  return entries;
}

export function appendAttemptToContractMarkdown(markdown, entry = {}) {
  const existing = parseLoopContractLedgerTable(markdown);
  const attempt = Number(entry.attempt) || existing.length + 1;
  const timestamp = sanitizeCell(entry.timestamp || new Date().toISOString());
  const gate = sanitizeCell(entry.gate || 'npm test');
  const outcome = sanitizeCell(entry.outcome === 'fail' ? 'fail' : 'pass');
  const frictionClass = VALID_FRICTION_CLASSES.includes(entry.frictionClass)
    ? entry.frictionClass
    : sanitizeCell(entry.frictionClass || 'none');
  const notes = sanitizeCell(entry.notes || '');

  const row = `| ${attempt} | ${timestamp} | ${gate} | ${outcome} | ${frictionClass} | ${notes} |`;
  const lines = String(markdown ?? '').split(/\r?\n/);
  let dividerIdx = -1;
  let lastRowIdx = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\|\s*Attempt\s*\|\s*Timestamp\s*\|/i.test(trimmed) && i + 1 < lines.length) {
      dividerIdx = i + 1;
      lastRowIdx = dividerIdx;
      for (let j = dividerIdx + 1; j < lines.length; j += 1) {
        if (lines[j].trim().startsWith('|')) lastRowIdx = j;
        else break;
      }
      break;
    }
  }

  if (lastRowIdx >= 0) {
    lines.splice(lastRowIdx + 1, 0, row);
    return `${lines.join('\n').replace(/\n+$/, '')}\n`;
  }

  return [
    String(markdown ?? '').replace(/\n+$/, ''),
    '',
    '## 6. Attempt & Friction Ledger (L1 -> L2)',
    '| Attempt | Timestamp | Gate | Outcome | Friction Class | Notes |',
    '|---|---|---|---|---|---|',
    row,
    '',
  ].join('\n');
}

export function detectRepeatedFriction(entries = [], threshold = 2) {
  const counts = new Map();
  for (const e of entries) {
    const fc = String(e?.frictionClass ?? 'none').trim();
    if (!fc || fc === 'none') continue;
    counts.set(fc, (counts.get(fc) ?? 0) + 1);
  }
  const repeated = [];
  for (const [frictionClass, count] of counts.entries()) {
    if (count >= threshold) {
      repeated.push({
        frictionClass,
        count,
        recommendedCostLadder: [...HARNESS_COMPONENT_COST_ORDER],
      });
    }
  }
  return {
    requiresL2Promotion: repeated.length > 0,
    repeated,
  };
}

export function appendAttemptEntry({ contractPath, entry }) {
  const resolved = path.resolve(contractPath);
  const current = fs.readFileSync(resolved, 'utf8');
  const updated = appendAttemptToContractMarkdown(current, entry);
  fs.writeFileSync(resolved, updated, 'utf8');
  const entries = parseLoopContractLedgerTable(updated);
  const frictionReport = detectRepeatedFriction(entries);
  return { contractPath: resolved, entries, frictionReport };
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--contract') out.contractPath = argv[++i];
    else if (a === '--attempt') out.attempt = Number(argv[++i]);
    else if (a === '--gate') out.gate = argv[++i];
    else if (a === '--outcome') out.outcome = argv[++i];
    else if (a === '--friction-class') out.frictionClass = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--verify-repeated') out.verifyRepeated = true;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.contractPath) {
    process.stderr.write('Usage: loop-attempt-ledger.mjs --contract <path> [--gate <g> --outcome <pass|fail> --friction-class <fc> --notes <n>]\n');
    process.exit(1);
  }
  if (args.verifyRepeated && !args.gate) {
    const md = fs.readFileSync(path.resolve(args.contractPath), 'utf8');
    const entries = parseLoopContractLedgerTable(md);
    const report = detectRepeatedFriction(entries);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const res = appendAttemptEntry({
      contractPath: args.contractPath,
      entry: {
        attempt: args.attempt,
        gate: args.gate,
        outcome: args.outcome,
        frictionClass: args.frictionClass,
        notes: args.notes,
      },
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  }
}
