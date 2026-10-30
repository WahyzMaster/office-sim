import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentMotiveState,
  applyEventToMotives,
  computeAgentMotives,
  buildActionQueue,
  deriveMoodlets,
  classifyToolYield,
} from '../public/js/sim-motives.js';
import {
  OVERLAY_MODES,
  classifyEventRci,
  computeRciBalance,
  computeRoomOverlayState,
  installSimOverlays,
} from '../public/js/sim-overlays.js';
import {
  COLLECTOR_ROOM_MAP,
  buildFlywheelPipelineModel,
  installSimFlywheelViz,
} from '../public/js/sim-flywheel-viz.js';
import {
  computeFloorPrestige,
  evaluateAdvisors,
  installSimAdvisor,
} from '../public/js/sim-advisor.js';

function createFakeDom() {
  const elementsById = new Map();
  const makeNode = (tag) => {
    const listeners = new Map();
    const classes = new Set();
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      title: '',
      hidden: false,
      dataset: {},
      style: {},
      attributes: new Map(),
      children: [],
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, force) {
          const next = force === undefined ? !classes.has(c) : Boolean(force);
          if (next) classes.add(c);
          else classes.delete(c);
          return next;
        },
        contains(c) { return classes.has(c); },
      },
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

describe('Phase 1: Sims Motives, Action Queue & Moodlets (sim-motives.js)', () => {
  it('computes 4 agent motives and derives moodlets & tool yields across ko/en', () => {
    const ms = createAgentMotiveState();
    applyEventToMotives(ms, { type: 'tool_start', tool: 'Edit', parentSessionId: 'lead-1' }, 1000);
    applyEventToMotives(ms, { type: 'tool_end', ok: true }, 1200);
    applyEventToMotives(ms, { type: 'tool_start', tool: 'Bash' }, 1300);
    applyEventToMotives(ms, { type: 'tool_end', ok: true }, 1500);
    applyEventToMotives(ms, { type: 'tool_start', tool: 'Read' }, 1600);
    applyEventToMotives(ms, { type: 'tool_end', ok: true }, 1800);

    assert.equal(ms.consecutiveOkTools, 3);
    assert.equal(ms.parentSessionId, 'lead-1');

    const motives = computeAgentMotives(
      ms,
      { contextTokens: 50_000, contextWindow: 200_000, compactions: 1, toolErrors: 0 },
      { mode: 'work', room: 'dev' },
      2000,
    );
    assert.ok(motives.freshness >= 80);
    assert.ok(motives.momentum >= 75);
    assert.ok(motives.alignment >= 85);
    assert.ok(motives.verification >= 85);

    const moodletsEn = deriveMoodlets(ms, { compactions: 1 }, { isSub: true }, 'en');
    const ids = moodletsEn.map((m) => m.id);
    assert.ok(ids.includes('on_a_roll'));
    assert.ok(ids.includes('compacted'));
    assert.ok(ids.includes('sub_linked'));

    const qKo = buildActionQueue({ room: 'dev', activity: 'Edit main.js' }, ms, 'ko');
    assert.equal(qKo.length, 3);
    assert.equal(qKo[0].status, 'now');
    assert.equal(qKo[1].room, 'server');

    assert.equal(classifyToolYield('Edit', true, 'en').label, '+Patch');
    assert.equal(classifyToolYield('Bash', true, 'en').label, '+Pass');
    assert.equal(classifyToolYield('Bash', false, 'en').label, '!Retry');
  });
});

describe('Phase 2: Impeccable Floating SimHUD Pill & 5-Mode Overlays (sim-overlays.js)', () => {
  it('classifies RCI workload and cycles through all 5 overlay modes including flywheel', () => {
    assert.deepEqual(OVERLAY_MODES, ['normal', 'heatmap', 'desire', 'friction', 'flywheel']);
    assert.equal(classifyEventRci({ tool: 'codegraph_search' }), 'r');
    assert.equal(classifyEventRci({ tool: 'Edit' }), 'c');
    assert.equal(classifyEventRci({ tool: 'Bash' }), 'i');

    const rci = computeRciBalance({ r: 3, c: 5, i: 2 });
    assert.equal(rci.rPct, 30);
    assert.equal(rci.cPct, 50);
    assert.equal(rci.iPct, 20);
    assert.equal(rci.dominant, 'c');

    const roomStates = computeRoomOverlayState(
      { agents: new Set([{ id: 'a1', room: 'server', mode: 'ask' }]), waiting: { server: ['a2'] } },
      new Map([['a1', { contextTokens: 160_000, contextWindow: 200_000, toolErrors: 1 }]]),
      'friction',
    );
    assert.equal(roomStates.server.colorHex, 0xef4444);

    const { doc, win, controls, elementsById } = createFakeDom();
    const office = { floors: [], agents: new Map(), onEvent() {} };
    const hud = { lang: 'en' };
    const ctrl = installSimOverlays({ office, hud, doc, win });
    assert.ok(elementsById.has('sim-hud-pill'));
    assert.ok(elementsById.has('sim-lens-select'));
    assert.ok(elementsById.has('sim-more-toggle'));
    assert.equal(controls.dataset.more, 'collapsed');
    elementsById.get('sim-more-toggle').dispatch('click');
    assert.equal(controls.dataset.more, 'open');
    assert.equal(controls.children.includes(elementsById.get('sim-hud-pill')), true);
    assert.equal(ctrl.mode, 'normal');

    const selectBefore = elementsById.get('sim-lens-select');
    office.onEvent({ sessionId: 'a1', type: 'tool_start', tool: 'Edit' });
    office.onEvent({ sessionId: 'a1', type: 'tool_start', tool: 'Bash' });
    const selectAfter = elementsById.get('sim-lens-select');
    assert.equal(selectBefore, selectAfter, '#sim-lens-select DOM node must persist across live events so open dropdown never closes');

    win.dispatch('keydown', { key: 'v', preventDefault() {} });
    assert.equal(ctrl.mode, 'heatmap');
    assert.equal(elementsById.get('sim-lens-select').value, 'heatmap');
    ctrl.setMode('flywheel');
    assert.equal(ctrl.mode, 'flywheel');
    assert.equal(elementsById.get('sim-lens-select').value, 'flywheel');
    win.dispatch('keydown', { key: 'Escape', preventDefault() {} });
    assert.equal(ctrl.mode, 'normal');
  });
});

describe('Phase 3: 5-Stage Flywheel Process Visualization (sim-flywheel-viz.js)', () => {
  it('maps P1..P8 collectors to physical rooms and builds the 5-stage pipeline model', () => {
    assert.equal(Object.keys(COLLECTOR_ROOM_MAP).length, 8);
    assert.equal(COLLECTOR_ROOM_MAP.privacy_guard, 'desk');
    assert.equal(COLLECTOR_ROOM_MAP.sse_backpressure, 'server');
    assert.equal(COLLECTOR_ROOM_MAP.dom_entropy, 'dev');

    const sample = {
      overallStatus: 'warn',
      components: {
        permission_wait: { kind: 'permission_wait', priorityRank: 4, status: 'warn', enabled: true },
      },
      signals: [
        {
          fingerprint: 'a9f3bc0123456789abcdef01',
          kind: 'permission_wait',
          priorityRank: 4,
          capabilityId: 'permission-wait',
          primaryKey: 'grok',
          title: 'Grok waiting 18s',
          summary: 'Waiting for human approval',
          severity: 'warn',
          status: 'open',
          occurrenceCount: 2,
          recommendedAction: {
            actionId: 'start_diagnostic_observe',
            dryRunPreview: 'Start 60s observe',
            status: 'pending_approval',
          },
        },
      ],
      cycles: [{ triggerSource: 'interval', durationMs: 8, scannedSignalsCount: 1, dedupSuppressedCount: 3 }],
    };

    const model = buildFlywheelPipelineModel(sample, 'en');
    assert.equal(model.overallStatus, 'warn');
    assert.equal(model.stage1.openCount, 1);
    assert.equal(model.stage2.dedupSuppressed, 3);
    assert.equal(model.stage3.tierACount, 1);
    assert.equal(model.stage4.requiresL2Promotion, true);
    assert.equal(model.stage5.targetRung, 'gate');

    const { doc, win, elementsById } = createFakeDom();
    const office = { floors: [], agents: new Map(), onEvent() {}, update() {} };
    const hud = { lang: 'en' };
    const overlays = installSimOverlays({ office, hud, doc, win });
    const viz = installSimFlywheelViz({ office, hud, overlays, doc, fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
    viz.updateStatus(sample);

    const conveyor = elementsById.get('sim-flywheel-conveyor');
    assert.ok(conveyor);
    assert.equal(conveyor.hidden, true);
    overlays.setMode('flywheel');
    assert.equal(conveyor.hidden, false);
    assert.equal(conveyor.children.length, 2);
  });
});

describe('Phase 4: Auto-Collapsing Advisor Strip & SimTower Prestige (sim-advisor.js)', () => {
  it('computes 1..5 star floor prestige and evaluates advisor alerts', () => {
    const floor = {
      index: 0,
      number: '1F',
      label: 'office-sim',
      agents: new Set([{ id: 's1', name: 'Claude', mode: 'ask' }]),
      waiting: { server: ['s2'] },
      board: { items: [{ status: 'completed' }, { status: 'completed' }] },
    };
    const prestige = computeFloorPrestige(floor, new Map([['s1', { turns: 3, toolErrors: 0 }]]));
    assert.equal(prestige.stars, 5);
    assert.equal(prestige.starString, '[*****]');
    assert.equal(prestige.queueCount, 1);

    const alerts = evaluateAdvisors(
      { floors: [floor] },
      new Map([['s1', { contextTokens: 170_000, contextWindow: 200_000 }]]),
      { stage1: { openCount: 1 } },
      'en',
    );
    assert.ok(alerts.length >= 3);
    assert.equal(alerts[0].id, 'fw-open');

    const { doc, elementsById } = createFakeDom();
    const office = { floors: [floor], agents: new Map(), select() {}, focus() {} };
    const hud = { lang: 'en', el: { floors: null, insp: null }, floorStats() {} };
    installSimAdvisor({ office, hud, doc });
    assert.equal(elementsById.has('sim-advisor-strip'), false);
  });
});
