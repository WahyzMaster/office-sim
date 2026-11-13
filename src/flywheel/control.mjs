// FlywheelControl: stateful L3 -> Dedup -> Tier A/B/C controller for Office Sim.
// Manages the 8-source matrix, 24-tick sparkline history, 20-cycle audit log,
// safe dry-run approval inbox, and optional O_NOFOLLOW state persistence.

import * as fsp from 'node:fs/promises';
import {
  FINGERPRINT_RE,
  FLYWHEEL_SIGNAL_KINDS,
} from './types.mjs';
import {
  buildSeedContractCommand,
  formatLinearTicketDraft,
  priorityRankForKind,
  routeFlywheelSignals,
} from './router.mjs';
import {
  buildInitialFlywheelState,
  collectRuntimeSignals,
} from './collectors.mjs';
import {
  applyFlywheelConfigPatch,
  buildFlywheelStatus,
  loadFlywheelState,
  saveFlywheelState,
} from './persistence.mjs';

const MAX_HISTORY_TICKS = 24;
const MAX_CYCLE_HISTORY = 20;
const MAX_SIGNALS_LEDGER = 120;

export class FlywheelControl {
  constructor({
    getHealth = () => null,
    getObserveSummary = () => null,
    getRecaps = () => [],
    getSseMetrics = () => null,
    getDomAudit = () => null,
    runTierAAction = null,
    linearClient = null,
    dir = null,
    now = () => Date.now(),
    timers = { setInterval, clearInterval },
    fsImpl = fsp,
    onChange = null,
    autoStartTimer = false,
  } = {}) {
    this.getHealth = getHealth;
    this.getObserveSummary = getObserveSummary;
    this.getRecaps = getRecaps;
    this.getSseMetrics = getSseMetrics;
    this.getDomAudit = getDomAudit;
    this.runTierAAction = runTierAAction;
    this.linearClient = linearClient;
    this.dir = dir;
    this.now = now;
    this.timers = timers;
    this.fs = fsImpl;
    this.onChange = onChange;
    this._timer = null;
    this._scanInFlight = null;

    const nowIso = new Date(this.now()).toISOString();
    this._state = buildInitialFlywheelState(nowIso);

    if (autoStartTimer) {
      this.startTimer();
    }
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  startTimer() {
    this._clearTimer();
    if (!this._state.config.enabled) return;
    const intervalMs = (this._state.config.intervalMinutes || 30) * 60_000;
    this._timer = this.timers.setInterval(() => {
      void this.scan({ triggerSource: 'scheduled' }).catch(() => {});
    }, intervalMs);
    this._timer?.unref?.();
  }

  _clearTimer() {
    if (this._timer !== null) {
      this.timers.clearInterval(this._timer);
      this._timer = null;
    }
  }

  async loadPersistedState() {
    const next = await loadFlywheelState(this.dir, this.fs, this._state);
    if (!next) return false;
    this._state = next;
    return true;
  }

  async _persistState() {
    return saveFlywheelState(this.dir, this.fs, this._state);
  }

  status() {
    return buildFlywheelStatus(this._state);
  }

  async scan({ triggerSource = 'on_demand', extraCandidates = [] } = {}) {
    if (this._scanInFlight) return this._scanInFlight;
    this._scanInFlight = this._runScan({ triggerSource, extraCandidates });
    try {
      return await this._scanInFlight;
    } finally {
      this._scanInFlight = null;
    }
  }

  async _runScan({ triggerSource, extraCandidates }) {
    const startedMs = this.now();
    const nowIso = new Date(startedMs).toISOString();

    const healthSnapshot = await Promise.resolve(this.getHealth?.()).catch(() => null);
    const observeSummary = await Promise.resolve(this.getObserveSummary?.()).catch(() => null);
    const recapSummaries = await Promise.resolve(this.getRecaps?.()).catch(() => []);
    const sseMetrics = await Promise.resolve(this.getSseMetrics?.()).catch(() => null);
    const domAudit = await Promise.resolve(this.getDomAudit?.()).catch(() => null);

    const { candidates, componentSummaries } = collectRuntimeSignals({
      healthSnapshot,
      observeSummary,
      recapSummaries,
      sseMetrics,
      domAudit,
      extraCandidates,
    });

    const routeResult = await routeFlywheelSignals({
      rawSignals: candidates,
      existingLedger: this._state.signals,
      config: this._state.config,
      nowIso,
      linearClient: this.linearClient,
    });

    // If tierAMode is auto_execute, run any newly auto-executed Tier A runbooks
    if (this._state.config.tierAMode === 'auto_execute' && this.runTierAAction) {
      for (const sig of routeResult.routedSignals) {
        if (sig.recommendedAction?.status === 'auto_executed' && !sig.recommendedAction.approvedAt) {
          const execRes = await Promise.resolve(
            this.runTierAAction(sig.recommendedAction.runbookId, sig),
          ).catch(() => 'Auto-execution failed');
          sig.recommendedAction.approvedBy = 'policy:auto_execute';
          sig.recommendedAction.approvedAt = nowIso;
          sig.recommendedAction.executionResult = String(execRes || 'Executed');
          routeResult.updatedLedger[sig.fingerprint] = sig;
        }
      }
    }

    // Cap ledger size by pruning oldest resolved entries first
    const ledgerEntries = Object.entries(routeResult.updatedLedger);
    if (ledgerEntries.length > MAX_SIGNALS_LEDGER) {
      ledgerEntries.sort(([, a], [, b]) => {
        const resA = a.status === 'resolved' ? 0 : 1;
        const resB = b.status === 'resolved' ? 0 : 1;
        if (resA !== resB) return resA - resB;
        return String(a.lastSeenAt ?? '').localeCompare(String(b.lastSeenAt ?? ''));
      });
      while (ledgerEntries.length > MAX_SIGNALS_LEDGER) {
        ledgerEntries.shift();
      }
    }
    this._state.signals = Object.fromEntries(ledgerEntries);

    // Update 8-component summaries & 24-tick statusHistory
    for (const kind of FLYWHEEL_SIGNAL_KINDS) {
      const prevComp = this._state.components[kind] ?? {
        kind,
        priorityRank: priorityRankForKind(kind),
        statusHistory: [],
      };
      const compSummary = componentSummaries[kind] ?? {
        status: 'pass',
        summaryText: '정상',
        metrics: {},
      };
      const enabled = Boolean(this._state.config.enabledSources[kind]);
      const kindSignals = Object.values(this._state.signals).filter((s) => s.kind === kind);
      const activeKindSignals = kindSignals.filter((s) => s.status !== 'resolved');
      const status = enabled ? compSummary.status : 'pass';
      const history = [...(prevComp.statusHistory ?? []), status].slice(-MAX_HISTORY_TICKS);

      this._state.components[kind] = {
        kind,
        priorityRank: priorityRankForKind(kind),
        status,
        enabled,
        activeSignalsCount: activeKindSignals.length,
        dedupSuppressedCount: activeKindSignals.reduce(
          (acc, s) => acc + Math.max(0, (s.occurrenceCount || 1) - 1),
          0,
        ),
        linkedLinearCount: kindSignals.filter((s) => Boolean(s.linearIssueIdentifier)).length,
        statusHistory: history,
        summaryText: enabled ? compSummary.summaryText : '비활성화됨 (수집 제외)',
        metrics: compSummary.metrics ?? {},
        checkedAt: nowIso,
      };
    }

    const durationMs = Math.max(0, this.now() - startedMs);
    const cycleStatus = Object.values(this._state.components).some((c) => c.status === 'fail')
      ? 'fail'
      : Object.values(this._state.components).some((c) => c.status === 'warn')
        ? 'warn'
        : 'pass';

    const cycleEntry = {
      cycleId: `fw_${startedMs}`,
      triggerSource: ['scheduled', 'on_demand', 'ci_gate'].includes(triggerSource)
        ? triggerSource
        : 'on_demand',
      startedAt: nowIso,
      completedAt: new Date(this.now()).toISOString(),
      durationMs,
      scannedSignalsCount: routeResult.scannedSignalsCount,
      dedupSuppressedCount: routeResult.dedupSuppressedCount,
      linearCreatedCount: routeResult.linearCreatedCount,
      dryRunPendingCount: routeResult.dryRunPendingCount,
      resolvedThisTickCount: routeResult.resolvedThisTickCount,
      status: cycleStatus,
    };

    this._state.cycleHistory = [
      cycleEntry,
      ...(this._state.cycleHistory ?? []),
    ].slice(0, MAX_CYCLE_HISTORY);
    this._state.lastScanAt = nowIso;
    this._state.nextScheduledAt = new Date(
      startedMs + (this._state.config.intervalMinutes || 30) * 60_000,
    ).toISOString();
    this._state.updatedAt = nowIso;

    await this._persistState();
    const snap = this.status();
    this.onChange?.(snap);
    return snap;
  }

  async updateConfig(patch = {}) {
    const res = applyFlywheelConfigPatch(this._state, patch, this.now());
    if (!res.ok) return { ok: false, error: res.error, status: this.status() };
    if (res.timerChanged && this._timer !== null) {
      this.startTimer();
    }
    await this._persistState();
    const snap = this.status();
    this.onChange?.(snap);
    return { ok: true, status: snap };
  }

  async approveDryRun(fingerprint, { approvedBy = 'operator' } = {}) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
      return { ok: false, error: 'INVALID_FINGERPRINT' };
    }
    const sig = this._state.signals[fingerprint];
    if (!sig) {
      return { ok: false, error: 'SIGNAL_NOT_FOUND' };
    }
    if (!sig.recommendedAction) {
      return { ok: false, error: 'NO_DRY_RUN_ACTION' };
    }

    const nowIso = this._nowIso();
    let execResult = 'Approved and executed non-destructive runbook';
    if (this.runTierAAction) {
      try {
        const res = await this.runTierAAction(sig.recommendedAction.runbookId, sig);
        if (typeof res === 'string' && res.trim()) {
          execResult = res.trim().slice(0, 200);
        }
      } catch {
        execResult = 'Runbook execution reported an error';
      }
    }

    sig.recommendedAction = {
      ...sig.recommendedAction,
      status: 'executed',
      approvedBy: String(approvedBy || 'operator').slice(0, 64),
      approvedAt: nowIso,
      executionResult: execResult,
    };
    if (sig.status === 'open') {
      sig.status = 'triaged';
    }
    sig.lastSeenAt = nowIso;
    this._state.updatedAt = nowIso;

    await this._persistState();
    const snap = this.status();
    this.onChange?.(snap);
    return {
      ok: true,
      fingerprint,
      recommendedAction: structuredClone(sig.recommendedAction),
      status: snap,
    };
  }

  async seedContract(fingerprint, { linearIssueIdentifier = null } = {}) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
      return { ok: false, error: 'INVALID_FINGERPRINT' };
    }
    const sig = this._state.signals[fingerprint];
    if (!sig) {
      return { ok: false, error: 'SIGNAL_NOT_FOUND' };
    }
    const nowIso = this._nowIso();
    if (linearIssueIdentifier && typeof linearIssueIdentifier === 'string') {
      sig.linearIssueIdentifier = linearIssueIdentifier.trim().slice(0, 32);
    }
    sig.seedCommand = buildSeedContractCommand(sig);
    if (sig.status === 'open') {
      sig.status = 'triaged';
    }
    this._state.updatedAt = nowIso;
    await this._persistState();
    const snap = this.status();
    this.onChange?.(snap);
    return {
      ok: true,
      fingerprint,
      seedCommand: sig.seedCommand,
      linearDraft: formatLinearTicketDraft(sig),
      status: snap,
    };
  }

  async close() {
    this._clearTimer();
    if (this._scanInFlight) {
      await this._scanInFlight.catch(() => {});
    }
  }
}
