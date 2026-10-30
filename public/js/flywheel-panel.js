// 4-Zone Improvement & Revision Flywheel HUD Panel (#flywheel-toggle + #flywheel-panel, shortcut Y).
// Dynamically mounted into #hud (matching system-notify.js & agent-extras.js) so office.html stays under 500 lines.

import {
  flywheelText,
  flywheelView,
  readFlywheelStatus,
} from './flywheel-format.js';

const STYLE_CSS = `
#flywheel-panel {
  position: fixed;
  top: 56px;
  right: 16px;
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  z-index: 40;
  pointer-events: auto;
  background: var(--panel);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 14px 16px;
  color: var(--fg);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
#flywheel-panel[hidden] { display: none !important; }
.fw-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.fw-title { font-weight: 800; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.fw-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.fw-badge { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; font-weight: 700; font-size: 11px; border: 1px solid var(--line); }
.fw-badge.pass { background: color-mix(in srgb, #22c55e 20%, var(--panel-solid)); color: var(--fg); }
.fw-badge.warn { background: var(--ask); color: var(--ask-ink); border-color: var(--ask-line); }
.fw-badge.fail { background: color-mix(in srgb, var(--danger) 20%, var(--panel-solid)); color: var(--fg); }
.fw-badge.info { background: color-mix(in srgb, var(--accent) 20%, var(--panel-solid)); color: var(--fg); }
.fw-btn { border: 1px solid var(--line); background: var(--panel-solid); color: var(--fg); border-radius: 8px; padding: 4px 9px; font-size: 11px; font-weight: 600; cursor: pointer; }
.fw-btn:hover { border-color: var(--accent); background: var(--muted-bg); }
.fw-btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.fw-section-title { font-weight: 700; font-size: 12px; color: var(--muted); margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
.fw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.fw-card { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--panel-solid); cursor: pointer; display: flex; flex-direction: column; gap: 5px; }
.fw-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent); }
.fw-card-top { display: flex; justify-content: space-between; align-items: center; gap: 4px; font-weight: 700; }
.fw-strip { display: flex; gap: 2px; height: 7px; align-items: center; }
.fw-tick { width: 5px; height: 7px; border-radius: 2px; background: var(--line); }
.fw-tick.pass { background: #22c55e; }
.fw-tick.warn { background: #f59e0b; }
.fw-tick.fail { background: #ef4444; }
.fw-signals { display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow-y: auto; }
.fw-sig { border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; background: var(--panel-solid); display: flex; flex-direction: column; gap: 5px; }
.fw-sig-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-weight: 700; }
.fw-dryrun { background: var(--ask); color: var(--ask-ink); border: 1px solid var(--ask-line); border-radius: 8px; padding: 6px 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.fw-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.fw-table th, .fw-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); }
`;

function el(doc, tag, className = '', text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

export function installFlywheelPanel({
  hud,
  source = null,
  doc = globalThis.document,
  win = globalThis.window,
  fetchFn = globalThis.fetch,
} = {}) {
  let latestRaw = null;
  let selectedKind = null;
  let open = false;
  let scanning = false;
  let copiedFp = null;

  if (doc?.head && !doc.getElementById?.('flywheel-style')) {
    const style = doc.createElement('style');
    style.id = 'flywheel-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }

  let toggleBtn = doc?.getElementById?.('flywheel-toggle') ?? null;
  if (!toggleBtn && doc) {
    const controls = doc.querySelector?.('.bar .controls');
    if (controls) {
      toggleBtn = el(doc, 'button', 'ghost');
      toggleBtn.type = 'button';
      toggleBtn.id = 'flywheel-toggle';
      controls.appendChild(toggleBtn);
    }
  }

  let panel = doc?.getElementById?.('flywheel-panel') ?? null;
  if (!panel && doc) {
    const hudRoot = doc.getElementById?.('hud') ?? doc.body;
    if (hudRoot) {
      panel = el(doc, 'aside');
      panel.id = 'flywheel-panel';
      panel.hidden = true;
      panel.setAttribute('aria-label', 'Improvement Flywheel Panel');
      hudRoot.appendChild(panel);
    }
  }

  async function postAction(payload) {
    if (typeof fetchFn !== 'function') return null;
    try {
      const res = await fetchFn('/api/flywheel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res?.ok) return null;
      const data = await res.json();
      if (data?.status && typeof data.status === 'object') {
        latestRaw = data.status;
      } else if (data?.components) {
        latestRaw = data;
      }
      render();
      return data;
    } catch {
      return null;
    }
  }

  async function triggerScan() {
    if (scanning) return;
    scanning = true;
    render();
    try {
      await postAction({ action: 'scan', triggerSource: 'on_demand' });
    } finally {
      scanning = false;
      render();
    }
  }

  function render() {
    const lang = hud?.lang ?? 'ko';
    const t = flywheelText(lang);
    const vm = flywheelView(latestRaw, { lang, selectedKind });

    if (toggleBtn) {
      toggleBtn.textContent = t.btnLabel(vm.zone1.activeCount, vm.zone1.dryRunPendingCount);
      toggleBtn.title = t.btnTitle;
      toggleBtn.setAttribute('aria-pressed', String(open));
      toggleBtn.dataset.status = vm.zone1.overallStatus;
    }

    if (!panel || panel.hidden) return;
    panel.replaceChildren();

    // Zone 1: Flywheel Pulse Hero & Policy Controls
    const head = el(doc, 'div', 'fw-head');
    const titleWrap = el(doc, 'div', 'fw-title');
    titleWrap.append(
      el(doc, 'span', `fw-badge ${vm.zone1.overallStatus}`, vm.zone1.statusLabel),
      el(doc, 'span', '', t.panelTitle),
    );
    const closeBtn = el(doc, 'button', 'fw-btn', t.closeBtn);
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => setOpen(false));
    head.append(titleWrap, closeBtn);
    panel.appendChild(head);

    const ctrlRow = el(doc, 'div', 'fw-controls');
    const scanBtn = el(doc, 'button', 'fw-btn primary', scanning ? t.scanning : t.scanNow);
    scanBtn.type = 'button';
    scanBtn.disabled = scanning;
    scanBtn.addEventListener('click', () => { void triggerScan(); });

    const enableBtn = el(doc, 'button', 'fw-btn', vm.zone1.enabled ? t.enabledToggle : t.disabledToggle);
    enableBtn.type = 'button';
    enableBtn.addEventListener('click', () => {
      void postAction({ action: 'config', config: { enabled: !vm.zone1.enabled } });
    });

    const tierABtn = el(
      doc,
      'button',
      'fw-btn',
      vm.zone1.tierAMode === 'auto_execute' ? t.tierAAuto : t.tierADryRun,
    );
    tierABtn.type = 'button';
    tierABtn.addEventListener('click', () => {
      const nextMode = vm.zone1.tierAMode === 'auto_execute' ? 'dry_run' : 'auto_execute';
      void postAction({ action: 'config', config: { tierAMode: nextMode } });
    });

    const linearBtn = el(
      doc,
      'button',
      'fw-btn',
      vm.zone1.autoCreateLinearTicket ? t.linearAutoOn : t.linearAutoOff,
    );
    linearBtn.type = 'button';
    linearBtn.addEventListener('click', () => {
      void postAction({
        action: 'config',
        config: { autoCreateLinearTicket: !vm.zone1.autoCreateLinearTicket },
      });
    });

    ctrlRow.append(scanBtn, enableBtn, tierABtn, linearBtn);
    if (selectedKind) {
      const clearFilterBtn = el(doc, 'button', 'fw-btn', t.filterAll);
      clearFilterBtn.type = 'button';
      clearFilterBtn.addEventListener('click', () => {
        selectedKind = null;
        render();
      });
      ctrlRow.appendChild(clearFilterBtn);
    }
    panel.appendChild(ctrlRow);

    // Zone 2: 8-Source Signal Matrix
    panel.appendChild(el(doc, 'div', 'fw-section-title', t.zone2Title));
    const grid = el(doc, 'div', 'fw-grid');
    for (const card of vm.zone2) {
      const cardNode = el(doc, 'div', `fw-card${card.selected ? ' selected' : ''}`);
      cardNode.dataset.kind = card.kind;
      const top = el(doc, 'div', 'fw-card-top');
      top.append(
        el(doc, 'span', '', `${card.priorityLabel} · ${card.title}`),
        el(doc, 'span', `fw-badge ${card.status}`, card.statusLabel),
      );
      const strip = el(doc, 'div', 'fw-strip');
      for (const st of card.statusHistory) {
        strip.appendChild(el(doc, 'span', `fw-tick ${st}`));
      }
      const summary = el(doc, 'div', '', card.summaryText);
      cardNode.append(top, strip, summary);
      cardNode.addEventListener('click', () => {
        selectedKind = selectedKind === card.kind ? null : card.kind;
        render();
      });
      grid.appendChild(cardNode);
    }
    panel.appendChild(grid);

    // Zone 3: Signal Queue + Safe Dry-Run Approval Inbox
    panel.appendChild(el(doc, 'div', 'fw-section-title', t.zone3Title));
    const sigContainer = el(doc, 'div', 'fw-signals');
    if (vm.zone3.activeSignals.length === 0) {
      sigContainer.appendChild(el(doc, 'div', '', t.emptySignals));
    } else {
      for (const sig of vm.zone3.activeSignals) {
        const sigNode = el(doc, 'div', 'fw-sig');
        const sigHead = el(doc, 'div', 'fw-sig-head');
        sigHead.append(
          el(doc, 'span', `fw-badge ${sig.severity}`, `${sig.priorityLabel} · ${sig.severityLabel}`),
          el(doc, 'span', 'fw-badge info', sig.trackLabel),
          el(doc, 'span', '', `${sig.title} (x${sig.occurrenceCount})`),
        );
        if (sig.debounced) sigHead.appendChild(el(doc, 'span', 'fw-badge warn', t.debouncingBadge));
        if (sig.regression) sigHead.appendChild(el(doc, 'span', 'fw-badge fail', t.regressionBadge));
        sigNode.appendChild(sigHead);
        sigNode.appendChild(el(doc, 'div', '', sig.summary));

        if (sig.recommendedAction) {
          const dryRow = el(doc, 'div', 'fw-dryrun');
          dryRow.appendChild(el(doc, 'span', '', sig.recommendedAction.dryRunPreview));
          if (sig.recommendedAction.status === 'pending_approval') {
            const approveBtn = el(doc, 'button', 'fw-btn primary', t.approveBtn);
            approveBtn.type = 'button';
            approveBtn.addEventListener('click', () => {
              void postAction({ action: 'approve', fingerprint: sig.fingerprint });
            });
            dryRow.appendChild(approveBtn);
          } else {
            dryRow.appendChild(el(doc, 'span', 'fw-badge pass', t.approvedBadge));
          }
          sigNode.appendChild(dryRow);
        }

        const actionRow = el(doc, 'div', 'fw-controls');
        const copyBtn = el(
          doc,
          'button',
          'fw-btn',
          copiedFp === sig.fingerprint ? t.copiedSeedBadge : t.copySeedBtn,
        );
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', () => {
          copiedFp = sig.fingerprint;
          win?.navigator?.clipboard?.writeText?.(sig.seedCommand)?.catch?.(() => {});
          void postAction({ action: 'seed', fingerprint: sig.fingerprint });
          render();
        });
        actionRow.appendChild(copyBtn);
        sigNode.appendChild(actionRow);
        sigContainer.appendChild(sigNode);
      }
    }
    panel.appendChild(sigContainer);

    // Zone 4: Cycle Execution History Table
    panel.appendChild(el(doc, 'div', 'fw-section-title', t.zone4Title));
    const table = el(doc, 'table', 'fw-table');
    const tbody = el(doc, 'tbody');
    for (const c of vm.zone4.slice(0, 6)) {
      const tr = el(doc, 'tr');
      tr.append(
        el(doc, 'td', '', c.triggerLabel),
        el(doc, 'td', '', c.durationText),
        el(doc, 'td', '', `Signals: ${c.scannedSignalsCount} / Dedup: ${c.dedupSuppressedCount}`),
        el(doc, 'td', '', `Dry-Run: ${c.dryRunPendingCount} / Resolved: ${c.resolvedThisTickCount}`),
        el(doc, 'td', '', c.statusLabel),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  function setOpen(next) {
    open = Boolean(next);
    if (panel) panel.hidden = !open;
    if (open && !latestRaw) {
      void triggerScan();
    } else {
      render();
    }
  }

  function update(msg) {
    const parsed = readFlywheelStatus(msg);
    if (!parsed) return;
    latestRaw = msg;
    render();
  }

  toggleBtn?.addEventListener?.('click', () => setOpen(!open));
  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', () => render());

  win?.addEventListener?.('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 'y') {
      e.preventDefault();
      setOpen(!open);
    } else if (e.key === 'Escape' && open) {
      setOpen(false);
    }
  });

  if (source && typeof source === 'object') {
    source.onFlywheel = (msg) => update(msg);
  }

  if (typeof fetchFn === 'function') {
    fetchFn('/api/flywheel?scan=1')
      ?.then((r) => (r?.ok ? r.json() : null))
      ?.then((data) => { if (data) update(data); })
      ?.catch?.(() => {});
  }

  render();

  return {
    get open() { return open; },
    setOpen,
    update,
    triggerScan,
    render,
  };
}
