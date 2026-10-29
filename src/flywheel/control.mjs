// FlywheelControl: stateful L3 -> Dedup -> Tier A/B/C controller for Office Sim.
// Manages the 8-source matrix, 24-tick sparkline history, 20-cycle audit log,
// safe dry-run approval inbox, and optional O_NOFOLLOW state persistence.

import * as fsp from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_FLYWHEEL_CONFIG,
  FINGERPRINT_RE,
  FLYWHEEL_SIGNAL_KINDS,
  VALID_INTERVAL_MINUTES,
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

const MAX_HISTORY_TICKS = 24;
const MAX_CYCLE_HISTORY = 20;
const MAX_SIGNALS_LEDGER = 120;
const WRITE_FLAGS =
  FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (FS.O_NOFOLLOW ?? 0);
const READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0);

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
    if (!this.dir) return false;
    try {
      const st = await this.fs.lstat(this.dir);
      if (!st.isDirectory()) return false;
      const fh = await this.fs.open(join(this.dir, 'flywheel-state.json'), READ_FLAGS);
      try {
        const raw = await fh.readFile({ encoding: 'utf8' });
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.config && parsed.components) {
          this._state = {
            ...this._state,
            ...parsed,
            config: {
              ...DEFAULT_FLYWHEEL_CONFIG,
              ...parsed.config,
              enabledSources: {
                ...DEFAULT_FLYWHEEL_CONFIG.enabledSources,
                ...(parsed.config.enabledSources ?? {}),
              },
            },
          };
          return true;
        }
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      // Missing or unreadable state file is non-fatal.
    }
    return false;
  }

  async _persistState() {
    if (!this.dir) return false;
    try {
      const st = await this.fs.lstat(this.dir);
      if (!st.isDirectory()) return false;
      const fh = await this.fs.open(
        join(this.dir, 'flywheel-state.json'),
        WRITE_FLAGS,
        0o600,
      );
      try {
        await fh.writeFile(`${JSON.stringify(this._state, null, 2)}\n`);
        return true;
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  status() {
    const signalsList = Object.values(this._state.signals).sort((a, b) => {
      const activeA = a.status !== 'resolved' ? 0 : 1;
      const activeB = b.status !== 'resolved' ? 0 : 1;
      if (activeA !== activeB) return activeA - activeB;
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      return String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? ''));
    });

    let activeCount = 0;
    let failCount = 0;
    let warnCount = 0;
    let debouncingCount = 0;
    let dryRunPendingCount = 0;
    let linkedLinearCount = 0;
    let regressionCount = 0;

    for (const s of signalsList) {
      if (s.status !== 'resolved') {
        activeCount += 1;
        if (s.severity === 'fail') failCount += 1;
        else warnCount += 1;
        if (s.status === 'debouncing') debouncingCount += 1;
        if (s.recommendedAction?.status === 'pending_approval') dryRunPendingCount += 1;
        if (s.regression) regressionCount += 1;
      }
      if (s.linearIssueIdentifier) linkedLinearCount += 1;
    }

    let overallStatus = 'pass';
    if (failCount > 0) overallStatus = 'fail';
    else if (warnCount > 0) overallStatus = 'warn';

    return {
      schemaVersion: this._state.schemaVersion,
      overallStatus,
      config: structuredClone(this._state.config),
      components: structuredClone(this._state.components),
      signals: structuredClone(signalsList),
      cycleHistory: structuredClone(this._state.cycleHistory),
      summaryCounts: {
        activeCount,
        failCount,
        warnCount,
        debouncingCount,
        dryRunPendingCount,
        linkedLinearCount,
        regressionCount,
      },
      lastScanAt: this._state.lastScanAt,
      nextScheduledAt: this._state.nextScheduledAt,
      updatedAt: this._state.updatedAt,
    };
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
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: 'INVALID_PATCH', status: this.status() };
    }
    const next = { ...this._state.config };
    let timerChanged = false;

    if (typeof patch.enabled === 'boolean') {
      if (next.enabled !== patch.enabled) timerChanged = true;
      next.enabled = patch.enabled;
    }
    if (patch.intervalMinutes !== undefined) {
      const mins = Number(patch.intervalMinutes);
      if (!VALID_INTERVAL_MINUTES.includes(mins)) {
        return { ok: false, error: 'INVALID_INTERVAL', status: this.status() };
      }
      if (next.intervalMinutes !== mins) timerChanged = true;
      next.intervalMinutes = mins;
    }
    if (patch.tierAMode !== undefined) {
      if (patch.tierAMode !== 'dry_run' && patch.tierAMode !== 'auto_execute') {
        return { ok: false, error: 'INVALID_TIER_A_MODE', status: this.status() };
      }
      next.tierAMode = patch.tierAMode;
    }
    if (typeof patch.autoCreateLinearTicket === 'boolean') {
      next.autoCreateLinearTicket = patch.autoCreateLinearTicket;
    }
    if (patch.regressionWindowHours !== undefined) {
      const hrs = Number(patch.regressionWindowHours);
      if (!Number.isFinite(hrs) || hrs < 1 || hrs > 720) {
        return { ok: false, error: 'INVALID_REGRESSION_WINDOW', status: this.status() };
      }
      next.regressionWindowHours = Math.floor(hrs);
    }
    if (patch.enabledSources && typeof patch.enabledSources === 'object') {
      const nextSources = { ...next.enabledSources };
      for (const kind of FLYWHEEL_SIGNAL_KINDS) {
        if (typeof patch.enabledSources[kind] === 'boolean') {
          nextSources[kind] = patch.enabledSources[kind];
        }
      }
      next.enabledSources = nextSources;
    }

    const nowIso = this._nowIso();
    next.updatedAt = nowIso;
    this._state.config = next;
    this._state.updatedAt = nowIso;
    this._state.nextScheduledAt = new Date(
      this.now() + next.intervalMinutes * 60_000,
    ).toISOString();

    for (const kind of FLYWHEEL_SIGNAL_KINDS) {
      if (this._state.components[kind]) {
        this._state.components[kind].enabled = Boolean(next.enabledSources[kind]);
      }
    }

    if (timerChanged && this._timer !== null) {
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
