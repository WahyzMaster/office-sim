import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLYWHEEL_KINDS,
  flywheelText,
  flywheelView,
  readFlywheelStatus,
} from '../public/js/flywheel-format.js';
import { installFlywheelPanel } from '../public/js/flywheel-panel.js';

function createFakeDom() {
  const elementsById = new Map();
  const makeNode = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      title: '',
      hidden: false,
      disabled: false,
      dataset: {},
      attributes: new Map(),
      children: [],
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) ?? null; },
      appendChild(child) {
        if (child?.id) elementsById.set(child.id, child);
        this.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const n of nodes) this.appendChild(n);
      },
      replaceChildren(...nodes) {
        this.children = [];
        for (const n of nodes) this.appendChild(n);
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, ev = {}) {
        for (const fn of listeners.get(type) ?? []) fn(ev);
      },
    };
    return node;
  };

  const head = makeNode('head');
  const body = makeNode('body');
  const hudRoot = makeNode('div');
  hudRoot.id = 'hud';
  elementsById.set('hud', hudRoot);
  const controls = makeNode('div');
  controls.className = 'controls';

  const doc = {
    head,
    body,
    createElement(tag) { return makeNode(tag); },
    getElementById(id) { return elementsById.get(id) ?? null; },
    querySelector(sel) {
      if (sel === '.bar .controls') return controls;
      return null;
    },
  };

  const winListeners = new Map();
  const win = {
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener(type, fn) {
      const list = winListeners.get(type) ?? [];
      list.push(fn);
      winListeners.set(type, list);
    },
    dispatch(type, ev = {}) {
      for (const fn of winListeners.get(type) ?? []) fn(ev);
    },
  };

  return { doc, win, controls, hudRoot, elementsById };
}

describe('Flywheel 4-Zone View Model & HUD Panel', () => {
  const sampleStatus = {
    overallStatus: 'warn',
    config: {
      enabled: true,
      intervalMinutes: 30,
      tierAMode: 'dry_run',
      autoCreateLinearTicket: false,
      regressionWindowHours: 72,
      enabledSources: Object.fromEntries(FLYWHEEL_KINDS.map((k) => [k, true])),
    },
    components: {
      runner_health: {
        kind: 'runner_health',
        priorityRank: 2,
        status: 'warn',
        enabled: true,
        activeSignalsCount: 1,
        dedupSuppressedCount: 2,
        linkedLinearCount: 0,
        statusHistory: ['pass', 'warn'],
        summaryText: '어댑터 탐색 지연 1건',
      },
    },
    signals: [
      {
        fingerprint: '0123456789abcdef01234567',
        kind: 'runner_health',
        priorityRank: 2,
        capabilityId: 'adapters',
        primaryKey: 'codex',
        title: 'Adapter codex scan error (SCAN_CAPPED)',
        summary: 'Runner codex reported scanErr=SCAN_CAPPED',
        severity: 'warn',
        track: 'tier_a',
        status: 'open',
        occurrenceCount: 3,
        consecutiveCount: 2,
        debounced: false,
        regression: true,
        seedCommand: 'node scripts/flywheel/seed-loop-contract.mjs --issue GLO-TBD --signal-kind runner_health --primary-key codex',
        recommendedAction: {
          runbookId: 'rescan_adapter_roots',
          title: '어댑터 루트 즉시 재탐색',
          titleEn: 'Rescan Adapter Roots Immediately',
          dryRunPreview: 'Dry-Run: 재탐색 1회 실행',
          dryRunPreviewEn: 'Dry-Run: Single rescan pass',
          status: 'pending_approval',
        },
      },
    ],
    cycleHistory: [
      {
        cycleId: 'fw_1',
        triggerSource: 'on_demand',
        startedAt: '2026-10-29T12:00:00Z',
        durationMs: 18,
        scannedSignalsCount: 1,
        dedupSuppressedCount: 0,
        linearCreatedCount: 0,
        dryRunPendingCount: 1,
        resolvedThisTickCount: 0,
        status: 'warn',
      },
    ],
    summaryCounts: {
      activeCount: 1,
      failCount: 0,
      warnCount: 1,
      debouncingCount: 0,
      dryRunPendingCount: 1,
      linkedLinearCount: 0,
      regressionCount: 1,
    },
  };

  it('builds bilingual (ko/en) 4-Zone view models and filters Zone 3 by selectedKind', () => {
    const parsed = readFlywheelStatus(sampleStatus);
    assert.equal(parsed.overallStatus, 'warn');

    const vmKo = flywheelView(sampleStatus, { lang: 'ko' });
    assert.equal(vmKo.zone2.length, 8);
    assert.equal(vmKo.zone3.activeSignals.length, 1);
    assert.equal(vmKo.zone3.pendingApprovals.length, 1);
    assert.equal(vmKo.zone4.length, 1);
    assert.equal(flywheelText('ko').btnLabel(1, 1), '플라이휠 · 승인 1');

    const vmEn = flywheelView(sampleStatus, { lang: 'en', selectedKind: 'dom_entropy' });
    assert.equal(vmEn.zone3.activeSignals.length, 0);
    assert.equal(flywheelText('en').btnLabel(1, 1), 'Flywheel · 1 Action');
  });

  it('mounts #flywheel-toggle and #flywheel-panel into #hud and toggles on shortcut Y', async () => {
    const { doc, win } = createFakeDom();
    const hud = { lang: 'en' };
    const source = {};
    const posted = [];

    const api = installFlywheelPanel({
      hud,
      source,
      doc,
      win,
      fetchFn: async (url, init) => {
        if (init?.method === 'POST') {
          posted.push(JSON.parse(init.body));
        }
        return {
          ok: true,
          async json() { return sampleStatus; },
        };
      },
    });

    const toggleBtn = doc.getElementById('flywheel-toggle');
    const panel = doc.getElementById('flywheel-panel');
    assert.ok(toggleBtn);
    assert.ok(panel);
    assert.equal(panel.hidden, true);

    // Receive SSE flywheel update via source.onFlywheel
    source.onFlywheel(sampleStatus);
    assert.equal(toggleBtn.textContent, 'Flywheel · 1 Action');

    // Toggle open via keyboard shortcut Y
    win.dispatch('keydown', { key: 'y', preventDefault() {} });
    assert.equal(api.open, true);
    assert.equal(panel.hidden, false);
    assert.ok(panel.children.length >= 6);
  });
});
