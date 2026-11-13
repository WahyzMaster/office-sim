import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideRealRoot } from '../scripts/fake-root-guard.mjs';
import { auditDomHealth } from '../src/flywheel/dom-audit.mjs';
import { evaluateRsiSnapshot, verifyRsiRatchet } from '../scripts/flywheel/rsi-eval.mjs';
import { PROTECTED_VERIFICATION_FILES, CAPABILITY_VERIFY_COMMANDS } from '../scripts/flywheel/seed-loop-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Meta-RSI auditDomHealth, rsi-eval ratchet, and contract targets', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()().catch(() => {});
    }
  });

  async function makeFakeRepo() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-rsi-'));
    assert.equal(insideRealRoot(dir, path.join(os.homedir(), '.claude')), false);
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'docs/lessons'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake', dependencies: {} }));
    await fsp.writeFile(path.join(dir, 'src/ok.mjs'), 'export function liveSymbol() { return 1; }\n');
    return dir;
  }

  it('detects near-cap files, >500-line violations, and stale lesson code_anchors', async () => {
    const dir = await makeFakeRepo();
    await fsp.writeFile(path.join(dir, 'src/near.mjs'), `${'const x = 1;\n'.repeat(492)}`);
    await fsp.writeFile(path.join(dir, 'src/over.mjs'), `${'const y = 2;\n'.repeat(502)}`);
    await fsp.writeFile(
      path.join(dir, 'docs/lessons/L-001.md'),
      [
        '---',
        'schema: harness2-v1',
        'code_anchors:',
        '  - src/ok.mjs#liveSymbol',
        '  - src/ok.mjs#missingSymbol',
        '  - src/missing.mjs#ghost',
        '---',
        'Lesson body.',
      ].join('\n'),
    );

    const audit = auditDomHealth(dir);
    assert.equal(audit.ok, false);
    assert.equal(audit.violationsCount, 1);
    assert.equal(audit.nearCapFilesCount, 2);
    assert.equal(audit.criticalCapFilesCount, 2);
    assert.equal(audit.staleAnchorsCount, 2);
    assert.deepEqual(
      audit.staleAnchors.map((s) => s.reason).sort(),
      ['missing_file', 'missing_symbol'],
    );
  });

  it('rejects ratchet regression and protected verification file tampering', () => {
    const before = {
      dom: { violationsCount: 0, nearCapFilesCount: 5, criticalCapFilesCount: 4, staleAnchorsCount: 0 },
      protectedHashes: { 'scripts/verify-dom-invariants.mjs': 'abc' },
      skillParityOk: true,
    };
    const good = {
      dom: { violationsCount: 0, nearCapFilesCount: 0, criticalCapFilesCount: 0, staleAnchorsCount: 0 },
      protectedHashes: { 'scripts/verify-dom-invariants.mjs': 'abc' },
      skillParityOk: true,
    };
    assert.equal(verifyRsiRatchet(before, good).ok, true);

    const tampered = {
      ...good,
      protectedHashes: { 'scripts/verify-dom-invariants.mjs': 'def' },
    };
    const res = verifyRsiRatchet(before, tampered);
    assert.equal(res.ok, false);
    assert.match(res.failures[0], /protected verification file modified/);

    const regressed = {
      ...good,
      dom: { ...good.dom, nearCapFilesCount: 6 },
    };
    assert.equal(verifyRsiRatchet(before, regressed).ok, false);
  });

  it('keeps all PROTECTED_VERIFICATION_FILES and CAPABILITY_VERIFY_COMMANDS test paths non-phantom', async () => {
    for (const rel of PROTECTED_VERIFICATION_FILES) {
      await fsp.access(path.join(REPO_ROOT, rel));
    }
    for (const cmds of Object.values(CAPABILITY_VERIFY_COMMANDS)) {
      for (const cmd of cmds) {
        const tokens = cmd.split(/\s+/).filter((t) => t.endsWith('.mjs'));
        for (const rel of tokens) {
          await fsp.access(path.join(REPO_ROOT, rel));
        }
      }
    }
    const snap = evaluateRsiSnapshot(REPO_ROOT);
    assert.equal(snap.dom.violationsCount, 0);
    assert.equal(snap.dom.staleAnchorsCount, 0);
    assert.equal(snap.skillParityOk, true);
  });
});
