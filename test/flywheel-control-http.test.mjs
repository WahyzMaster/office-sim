import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { insideRealRoot } from '../scripts/fake-root-guard.mjs';
import { FlywheelControl } from '../src/flywheel/control.mjs';
import { start } from '../src/server.mjs';

describe('FlywheelControl & /api/flywheel HTTP/SSE Integration', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn().catch(() => {});
    }
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-flywheel-'));
    assert.equal(insideRealRoot(dir, path.join(os.homedir(), '.claude')), false);
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('maintains 24-tick statusHistory, 20-cycle history, and persists state via O_NOFOLLOW', async () => {
    const dir = await makeTempDir();
    let tickClock = 1_700_000_000_000;
    const executedRunbooks = [];

    const ctl = new FlywheelControl({
      dir,
      now: () => {
        tickClock += 60_000;
        return tickClock;
      },
      getHealth: () => ({
        rejectedRefs: 0,
        badLines: 0,
        skippedLines: 0,
        runners: {
          codex: { files: 2, scanErr: 'EACCES', loopErrors: 0, applyErrors: 0, linkErrors: 0, lastScanMs: 12 },
        },
      }),
      runTierAAction: async (runbookId) => {
        executedRunbooks.push(runbookId);
        return `Ran ${runbookId}`;
      },
    });
    cleanups.push(() => ctl.close());

    for (let i = 0; i < 26; i += 1) {
      await ctl.scan({ triggerSource: 'scheduled' });
    }

    const st = ctl.status();
    assert.equal(st.components.runner_health.statusHistory.length, 24);
    assert.equal(st.cycleHistory.length, 20);
    assert.equal(st.summaryCounts.activeCount, 1);
    assert.equal(st.summaryCounts.dryRunPendingCount, 1);

    const fp = st.signals[0].fingerprint;
    const approval = await ctl.approveDryRun(fp, { approvedBy: 'test-operator' });
    assert.equal(approval.ok, true);
    assert.deepEqual(executedRunbooks, ['rescan_adapter_roots']);
    assert.equal(approval.recommendedAction.status, 'executed');

    const reloaded = new FlywheelControl({ dir });
    const loadedOk = await reloaded.loadPersistedState();
    assert.equal(loadedOk, true);
    assert.equal(reloaded.status().signals[0].recommendedAction.status, 'executed');
  });

  it('serves GET/POST /api/flywheel over loopback and blocks cross-site requests', async () => {
    const dir = await makeTempDir();
    const srv = await start({
      port: 0,
      host: '127.0.0.1',
      root: dir,
      agents: [],
    });
    cleanups.push(() => srv.close());
    await srv.ready;

    const baseUrl = `http://127.0.0.1:${srv.port}`;

    // 1. Cross-site Sec-Fetch-Site is rejected with 403 and increments crossSiteBlocks
    const blockedRes = await fetch(`${baseUrl}/api/flywheel`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(blockedRes.status, 403);

    // 2. On-demand scan via POST /api/flywheel surfaces the P1 privacy_guard signal from the blocked request
    const scanRes = await fetch(`${baseUrl}/api/flywheel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
      },
      body: JSON.stringify({
        action: 'scan',
        triggerSource: 'on_demand',
        extraCandidates: [
          {
            kind: 'runner_health',
            capabilityId: 'adapters',
            primaryKey: 'claude-code',
            title: 'Adapter claude-code transient scan lag',
            summary: 'Synthetic test candidate',
            severity: 'warn',
          },
        ],
      }),
    });
    assert.equal(scanRes.status, 200);
    const scanBody = await scanRes.json();
    assert.equal(scanBody.ok, true);
    assert.equal(scanBody.type, 'flywheel');
    assert.ok(scanBody.signals.some((s) => s.kind === 'privacy_guard'));
    const runnerSig = scanBody.signals.find((s) => s.kind === 'runner_health');
    assert.ok(runnerSig);

    // 3. Approve Tier A dry-run via POST /api/flywheel
    const approveRes = await fetch(`${baseUrl}/api/flywheel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
      },
      body: JSON.stringify({
        action: 'approve',
        fingerprint: runnerSig.fingerprint,
      }),
    });
    assert.equal(approveRes.status, 200);
    const approveBody = await approveRes.json();
    assert.equal(approveBody.ok, true);
    assert.equal(approveBody.recommendedAction.status, 'executed');

    // 4. Update config via POST /api/flywheel
    const cfgRes = await fetch(`${baseUrl}/api/flywheel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
      },
      body: JSON.stringify({
        action: 'config',
        config: { intervalMinutes: 15, tierAMode: 'auto_execute' },
      }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgBody = await cfgRes.json();
    assert.equal(cfgBody.config.intervalMinutes, 15);
    assert.equal(cfgBody.config.tierAMode, 'auto_execute');
  });
});
