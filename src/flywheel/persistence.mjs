// State persistence (O_NOFOLLOW), status snapshot aggregation, and config validation for FlywheelControl.
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_FLYWHEEL_CONFIG,
  FLYWHEEL_SIGNAL_KINDS,
  VALID_INTERVAL_MINUTES,
} from './types.mjs';

const WRITE_FLAGS = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (FS.O_NOFOLLOW ?? 0);
const READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0);

export async function loadFlywheelState(dir, fsImpl, currentState) {
  if (!dir) return null;
  try {
    const st = await fsImpl.lstat(dir);
    if (!st.isDirectory()) return null;
    const fh = await fsImpl.open(join(dir, 'flywheel-state.json'), READ_FLAGS);
    try {
      const raw = await fh.readFile({ encoding: 'utf8' });
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.config && parsed.components) {
        return {
          ...currentState,
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
      }
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    // Missing or unreadable state file is non-fatal.
  }
  return null;
}

export async function saveFlywheelState(dir, fsImpl, state) {
  if (!dir) return false;
  try {
    const st = await fsImpl.lstat(dir);
    if (!st.isDirectory()) return false;
    const fh = await fsImpl.open(join(dir, 'flywheel-state.json'), WRITE_FLAGS, 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      return true;
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

export function buildFlywheelStatus(state) {
  const signalsList = Object.values(state.signals).sort((a, b) => {
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
    schemaVersion: state.schemaVersion,
    overallStatus,
    config: structuredClone(state.config),
    components: structuredClone(state.components),
    signals: structuredClone(signalsList),
    cycleHistory: structuredClone(state.cycleHistory),
    summaryCounts: {
      activeCount,
      failCount,
      warnCount,
      debouncingCount,
      dryRunPendingCount,
      linkedLinearCount,
      regressionCount,
    },
    lastScanAt: state.lastScanAt,
    nextScheduledAt: state.nextScheduledAt,
    updatedAt: state.updatedAt,
  };
}

export function applyFlywheelConfigPatch(state, patch, nowMs) {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'INVALID_PATCH' };
  }
  const next = { ...state.config };
  let timerChanged = false;

  if (typeof patch.enabled === 'boolean') {
    if (next.enabled !== patch.enabled) timerChanged = true;
    next.enabled = patch.enabled;
  }
  if (patch.intervalMinutes !== undefined) {
    const mins = Number(patch.intervalMinutes);
    if (!VALID_INTERVAL_MINUTES.includes(mins)) {
      return { ok: false, error: 'INVALID_INTERVAL' };
    }
    if (next.intervalMinutes !== mins) timerChanged = true;
    next.intervalMinutes = mins;
  }
  if (patch.tierAMode !== undefined) {
    if (patch.tierAMode !== 'dry_run' && patch.tierAMode !== 'auto_execute') {
      return { ok: false, error: 'INVALID_TIER_A_MODE' };
    }
    next.tierAMode = patch.tierAMode;
  }
  if (typeof patch.autoCreateLinearTicket === 'boolean') {
    next.autoCreateLinearTicket = patch.autoCreateLinearTicket;
  }
  if (patch.regressionWindowHours !== undefined) {
    const hrs = Number(patch.regressionWindowHours);
    if (!Number.isFinite(hrs) || hrs < 1 || hrs > 720) {
      return { ok: false, error: 'INVALID_REGRESSION_WINDOW' };
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

  const nowIso = new Date(nowMs).toISOString();
  next.updatedAt = nowIso;
  state.config = next;
  state.updatedAt = nowIso;
  state.nextScheduledAt = new Date(nowMs + next.intervalMinutes * 60_000).toISOString();

  for (const kind of FLYWHEEL_SIGNAL_KINDS) {
    if (state.components[kind]) {
      state.components[kind].enabled = Boolean(next.enabledSources[kind]);
    }
  }
  return { ok: true, timerChanged };
}
