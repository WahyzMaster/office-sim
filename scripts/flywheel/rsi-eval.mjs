#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditDomHealth } from '../../src/flywheel/dom-audit.mjs';
import { PROTECTED_VERIFICATION_FILES } from './seed-loop-contract.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256File(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function checkSkillParity(repoRoot) {
  const a = path.join(repoRoot, 'skills', 'office', 'SKILL.md');
  const b = path.join(repoRoot, 'plugin', 'skills', 'office', 'SKILL.md');
  if (!fs.existsSync(a) && !fs.existsSync(b)) return true;
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

export function evaluateRsiSnapshot(repoRoot = DEFAULT_ROOT) {
  const root = path.resolve(repoRoot);
  const audit = auditDomHealth(root);
  const protectedHashes = {};
  for (const rel of PROTECTED_VERIFICATION_FILES) {
    protectedHashes[rel] = sha256File(path.join(root, rel));
  }
  return {
    schema: 'rsi-eval-v1',
    dom: {
      ok: audit.ok,
      violationsCount: audit.violationsCount,
      nearCapFilesCount: audit.nearCapFilesCount,
      criticalCapFilesCount: audit.criticalCapFilesCount,
      staleAnchorsCount: audit.staleAnchorsCount,
      totalFiles: audit.totalFiles,
      maxLinesFile: audit.maxLinesFile,
      nearCapFiles: audit.nearCapFiles,
    },
    protectedHashes,
    skillParityOk: checkSkillParity(root),
  };
}

export function verifyRsiRatchet(before, after, opts = {}) {
  const failures = [];
  const bDom = before?.dom ?? {};
  const aDom = after?.dom ?? {};

  if ((aDom.violationsCount ?? 0) > (bDom.violationsCount ?? 0)) {
    failures.push(`dom.violationsCount regressed: ${bDom.violationsCount} -> ${aDom.violationsCount}`);
  }
  if (opts.requireZeroViolations !== false && (aDom.violationsCount ?? 0) > 0) {
    failures.push(`dom.violationsCount must be 0 (got ${aDom.violationsCount})`);
  }
  if ((aDom.staleAnchorsCount ?? 0) > (bDom.staleAnchorsCount ?? 0)) {
    failures.push(`dom.staleAnchorsCount regressed: ${bDom.staleAnchorsCount} -> ${aDom.staleAnchorsCount}`);
  }
  if ((aDom.staleAnchorsCount ?? 0) > 0) {
    failures.push(`dom.staleAnchorsCount must be 0 (got ${aDom.staleAnchorsCount})`);
  }
  if ((aDom.criticalCapFilesCount ?? 0) > (bDom.criticalCapFilesCount ?? 0)) {
    failures.push(`dom.criticalCapFilesCount regressed: ${bDom.criticalCapFilesCount} -> ${aDom.criticalCapFilesCount}`);
  }
  if ((aDom.nearCapFilesCount ?? 0) > (bDom.nearCapFilesCount ?? 0)) {
    failures.push(`dom.nearCapFilesCount regressed: ${bDom.nearCapFilesCount} -> ${aDom.nearCapFilesCount}`);
  }
  if (after?.skillParityOk === false) {
    failures.push('skills/office/SKILL.md and plugin/skills/office/SKILL.md diverged');
  }

  const beforeHashes = before?.protectedHashes ?? {};
  const afterHashes = after?.protectedHashes ?? {};
  for (const [rel, prevHash] of Object.entries(beforeHashes)) {
    const nextHash = afterHashes[rel] ?? null;
    if (prevHash !== nextHash) {
      failures.push(`protected verification file modified after baseline freeze: ${rel}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    delta: {
      violationsCount: (aDom.violationsCount ?? 0) - (bDom.violationsCount ?? 0),
      nearCapFilesCount: (aDom.nearCapFilesCount ?? 0) - (bDom.nearCapFilesCount ?? 0),
      criticalCapFilesCount: (aDom.criticalCapFilesCount ?? 0) - (bDom.criticalCapFilesCount ?? 0),
      staleAnchorsCount: (aDom.staleAnchorsCount ?? 0) - (bDom.staleAnchorsCount ?? 0),
    },
  };
}

function parseCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--verify-ratchet') {
      args.verifyRatchet = true;
    } else if (tok.startsWith('--') && i + 1 < argv.length) {
      args[tok.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseCli(process.argv.slice(2));
  if (args.verifyRatchet) {
    if (!args.before || !args.after) {
      console.error('Usage: rsi-eval.mjs --verify-ratchet --before <file> --after <file>');
      process.exit(2);
    }
    const before = JSON.parse(fs.readFileSync(args.before, 'utf8'));
    const after = JSON.parse(fs.readFileSync(args.after, 'utf8'));
    const result = verifyRsiRatchet(before, after);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const snap = evaluateRsiSnapshot(args.root ?? DEFAULT_ROOT);
  const json = `${JSON.stringify(snap, null, 2)}\n`;
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}
