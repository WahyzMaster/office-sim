#!/usr/bin/env node
// Git refs/notes/evidence Envelope Manager for Office Sim (ported from wahyz_omni tools/ci/evidence_notes.mjs).
// Attaches structured verification envelopes to git commits via refs/notes/evidence without polluting commit bodies.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EVIDENCE_NOTES_REF = 'refs/notes/evidence';
export const EVIDENCE_SCHEMA_VERSION = '1.0.0';

function defaultRunGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function buildEvidenceEnvelope({
  commitSha,
  issue = 'GLO-TBD',
  signalKind = 'dom_entropy',
  fingerprint = null,
  gates = [],
  promotedLessons = [],
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedGates = (gates ?? []).map((g) => ({
    name: String(g?.name ?? 'npm test').trim(),
    status: g?.status === 'fail' ? 'fail' : 'pass',
    durationMs: Number.isFinite(g?.durationMs) ? Math.max(0, Math.floor(g.durationMs)) : 0,
  }));
  const allPassed =
    normalizedGates.length > 0 && normalizedGates.every((g) => g.status === 'pass');

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    commitSha: String(commitSha ?? 'HEAD').trim(),
    issue: String(issue || 'GLO-TBD').trim(),
    signalKind: String(signalKind || 'dom_entropy').trim(),
    fingerprint: fingerprint ? String(fingerprint).trim() : null,
    verdict: allPassed ? 'pass' : 'fail',
    gates: normalizedGates,
    promotedLessons: [...(promotedLessons ?? [])],
    recordedAt: nowIso,
  };
}

export function verifyEvidenceNoteEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, errors: ['Envelope must be a JSON object'] };
  }
  if (envelope.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${envelope.schemaVersion}`);
  }
  if (typeof envelope.commitSha !== 'string' || !envelope.commitSha.trim()) {
    errors.push('commitSha is required');
  }
  if (!Array.isArray(envelope.gates) || envelope.gates.length === 0) {
    errors.push('At least one verification gate entry is required');
  } else if (envelope.gates.some((g) => g?.status !== 'pass')) {
    errors.push('All verification gates must have status="pass"');
  }
  if (envelope.verdict !== 'pass') {
    errors.push(`Envelope verdict must be "pass" (received "${envelope.verdict}")`);
  }
  return { valid: errors.length === 0, errors };
}

export function writeEvidenceNote({
  commitSha = 'HEAD',
  issue = 'GLO-TBD',
  signalKind = 'dom_entropy',
  fingerprint = null,
  gates = [],
  promotedLessons = [],
  nowIso = new Date().toISOString(),
  cwd = process.cwd(),
  runGit = defaultRunGit,
} = {}) {
  const resolvedSha = commitSha === 'HEAD'
    ? runGit(['rev-parse', 'HEAD'], cwd)
    : commitSha;
  const envelope = buildEvidenceEnvelope({
    commitSha: resolvedSha,
    issue,
    signalKind,
    fingerprint,
    gates,
    promotedLessons,
    nowIso,
  });
  const payload = JSON.stringify(envelope, null, 2);
  runGit(
    ['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'add', '-f', '-m', payload, resolvedSha],
    cwd,
  );
  return { ok: true, commitSha: resolvedSha, ref: EVIDENCE_NOTES_REF, envelope };
}

export function readEvidenceNote({
  commitSha = 'HEAD',
  cwd = process.cwd(),
  runGit = defaultRunGit,
} = {}) {
  try {
    const raw = runGit(['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'show', commitSha], cwd);
    const parsed = JSON.parse(raw);
    const verification = verifyEvidenceNoteEnvelope(parsed);
    return { found: true, envelope: parsed, verification };
  } catch {
    return { found: false, envelope: null, verification: { valid: false, errors: ['No evidence note found'] } };
  }
}

export function listEvidenceNotes({
  cwd = process.cwd(),
  runGit = defaultRunGit,
} = {}) {
  try {
    const out = runGit(['notes', `--ref=${EVIDENCE_NOTES_REF}`, 'list'], cwd);
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [noteSha, targetSha] = line.trim().split(/\s+/);
        return { noteSha, targetSha };
      });
  } catch {
    return [];
  }
}

function parseCliArgs(argv) {
  const out = { gates: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'write' || a === 'read' || a === 'list') out.command = a;
    else if (a === '--commit') out.commitSha = argv[++i];
    else if (a === '--issue') out.issue = argv[++i];
    else if (a === '--signal-kind') out.signalKind = argv[++i];
    else if (a === '--fingerprint') out.fingerprint = argv[++i];
    else if (a === '--gate') {
      const [name, status = 'pass', dur = '0'] = String(argv[++i] ?? '').split(':');
      out.gates.push({ name, status, durationMs: Number(dur) || 0 });
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === 'write') {
    const res = writeEvidenceNote(args);
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else if (args.command === 'read') {
    const res = readEvidenceNote(args);
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    const res = listEvidenceNotes(args);
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  }
}
