import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideRealRoot } from '../scripts/fake-root-guard.mjs';
import {
  PROTECTED_VERIFICATION_FILES,
  seedLoopContract,
} from '../scripts/flywheel/seed-loop-contract.mjs';
import {
  appendAttemptEntry,
  detectRepeatedFriction,
  parseLoopContractLedgerTable,
} from '../scripts/flywheel/loop-attempt-ledger.mjs';
import {
  assertNoGraderLeak,
  promoteLesson,
  validateComponentCostChoice,
  verifyAnchorFreshness,
} from '../scripts/flywheel/promote-lesson.mjs';
import {
  EVIDENCE_NOTES_REF,
  buildEvidenceEnvelope,
  readEvidenceNote,
  verifyEvidenceNoteEnvelope,
  writeEvidenceNote,
} from '../scripts/flywheel/evidence-notes.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('L3 -> L1 -> L2 Harness2 Loop CLI Tools', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn().catch(() => {});
    }
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-loop-cli-'));
    assert.equal(insideRealRoot(dir, path.join(os.homedir(), '.claude')), false);
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('seeds an L1 Loop Contract with Protected Verification Files and tracks repeated friction (>=2)', async () => {
    const dir = await makeTempDir();
    const contractPath = path.join(dir, '.loop-contract.md');

    const seeded = seedLoopContract({
      issue: 'GLO-501',
      signalKind: 'adapter_conformance',
      primaryKey: 'wire-shape-drift',
      outputPath: contractPath,
      nowIso: '2026-10-29T12:00:00Z',
    });

    assert.equal(seeded.context.primaryCapability, 'adapters');
    assert.deepEqual(seeded.context.protectedFiles, PROTECTED_VERIFICATION_FILES);
    assert.ok(seeded.markdown.includes('Protected Verification Files'));

    // Attempt 1: fail with missing-context
    const a1 = appendAttemptEntry({
      contractPath,
      entry: {
        gate: 'node --test test/adapter-codex-conformance.test.mjs',
        outcome: 'fail',
        frictionClass: 'missing-context',
        notes: 'Missing rollout item shape',
      },
    });
    assert.equal(a1.entries.length, 1);
    assert.equal(a1.frictionReport.requiresL2Promotion, false);

    // Attempt 2: second fail with missing-context triggers requiresL2Promotion=true
    const a2 = appendAttemptEntry({
      contractPath,
      entry: {
        gate: 'node --test test/adapter-codex-conformance.test.mjs',
        outcome: 'fail',
        frictionClass: 'missing-context',
        notes: 'Second failure on rollout item shape',
      },
    });
    assert.equal(a2.entries.length, 2);
    assert.equal(a2.frictionReport.requiresL2Promotion, true);
    assert.equal(a2.frictionReport.repeated[0].frictionClass, 'missing-context');
    assert.equal(a2.frictionReport.repeated[0].count, 2);

    const parsedRows = parseLoopContractLedgerTable(await fsp.readFile(contractPath, 'utf8'));
    assert.equal(parsedRows.length, 2);
    assert.equal(detectRepeatedFriction(parsedRows).requiresL2Promotion, true);
  });

  it('enforces grader-leak rejection, component cost hierarchy, and code-anchor freshness on L2 promotion', async () => {
    const dir = await makeTempDir();
    const lessonPath = path.join(dir, 'lesson-flywheel.md');

    // 1. Grader-leak rejection
    assert.throws(
      () => assertNoGraderLeak({ text: 'assert.deepStrictEqual(actual, expectedFixture)' }),
      /Grader-leak pattern detected/,
    );

    // 2. Cost hierarchy requires rejection reasons for cheaper components when selecting 'gate'
    assert.throws(
      () => validateComponentCostChoice({ chosenComponent: 'gate', cheaperRejectedReasons: {} }),
      /requires rejection reasons for cheaper tiers: skill, script, subagent, hook/,
    );

    // 3. Valid promotion with real code_anchors in office-sim
    const promoted = promoteLesson({
      repoRoot: REPO_ROOT,
      id: 'flywheel-router-dedup',
      dimension: 'DOM',
      component: 'script',
      cheaperRejectedReasons: {
        skill: 'Prose guidance alone cannot enforce deterministic 24-hex SHA-256 deduplication',
      },
      cue: 'When routing L3 runtime signals into Linear or dry-run inbox',
      lesson: 'Always compute 24-hex SHA-256 fingerprints via computeSignalFingerprint before checking active ledger entries.',
      evidence: 'Verified in test/flywheel-router.test.mjs',
      codeAnchors: [
        'src/flywheel/router.mjs#computeSignalFingerprint',
        'src/flywheel/control.mjs#FlywheelControl',
      ],
      outputPath: lessonPath,
    });

    assert.equal(promoted.ok, true);
    assert.ok(promoted.markdown.includes('schema: harness2-v1'));
    assert.ok(promoted.markdown.includes('dimension: DOM'));

    // 4. Verify anchor freshness detects stale symbols if renamed
    const freshCheck = verifyAnchorFreshness({
      repoRoot: REPO_ROOT,
      markdown: promoted.markdown,
    });
    assert.equal(freshCheck.staleCount, 0);

    const staleCheck = verifyAnchorFreshness({
      repoRoot: REPO_ROOT,
      markdown: promoted.markdown.replace('#computeSignalFingerprint', '#nonExistentSymbol999'),
    });
    assert.equal(staleCheck.staleCount, 1);
  });

  it('writes, reads, and validates refs/notes/evidence envelopes via injectable git runner', () => {
    const notesStore = new Map();
    const fakeRunGit = (args) => {
      if (args[0] === 'rev-parse') return 'abc1234def5678';
      if (args[0] === 'notes' && args[2] === 'add') {
        const msgIdx = args.indexOf('-m');
        const sha = args[args.length - 1];
        notesStore.set(sha, args[msgIdx + 1]);
        return '';
      }
      if (args[0] === 'notes' && args[2] === 'show') {
        const sha = args[args.length - 1];
        if (!notesStore.has(sha)) throw new Error('no note');
        return notesStore.get(sha);
      }
      return '';
    };

    const written = writeEvidenceNote({
      commitSha: 'HEAD',
      issue: 'GLO-501',
      signalKind: 'adapter_conformance',
      fingerprint: '0123456789abcdef01234567',
      gates: [
        { name: 'node scripts/verify-dom-invariants.mjs', status: 'pass', durationMs: 45 },
        { name: 'npm test', status: 'pass', durationMs: 1200 },
      ],
      promotedLessons: ['flywheel-router-dedup'],
      runGit: fakeRunGit,
    });

    assert.equal(written.ok, true);
    assert.equal(written.ref, EVIDENCE_NOTES_REF);
    assert.equal(written.commitSha, 'abc1234def5678');

    const readBack = readEvidenceNote({
      commitSha: 'abc1234def5678',
      runGit: fakeRunGit,
    });
    assert.equal(readBack.found, true);
    assert.equal(readBack.verification.valid, true);
    assert.equal(readBack.envelope.verdict, 'pass');

    const failedEnv = buildEvidenceEnvelope({
      commitSha: 'abc1234def5678',
      gates: [{ name: 'npm test', status: 'fail', durationMs: 100 }],
    });
    assert.equal(verifyEvidenceNoteEnvelope(failedEnv).valid, false);
  });
});
