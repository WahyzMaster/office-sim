// 3D 화이트보드(기획·작전실 계획표) 클릭 상세 서랍 + 방 간판(.sign)·층 배지(.floortag)·말풍선(.bubble) 상호작용.
import { ROOMS, activeLangOf, langOf } from './rooms.js';

export const BOARD_DETAIL_TEXT = Object.freeze({
  ko: Object.freeze({
    boardSuffix: '계획표', planBtn: '계획표 (B)', planBtnTitle: '이 층의 화이트보드 계획표 열기 (단축키 B)',
    copyBtn: '마크다운 복사', copiedBtn: '복사됨!', closeBtn: '닫기',
    doneBadge: '✓ 완료', activeBadge: '▶ 진행 중', pendingBadge: '○ 대기', inProgressMd: '진행 중', latestTag: '최신',
    emptyTitle: '이 층에는 아직 작성된 계획표가 없어요.',
    emptySub: '에이전트가 TodoWrite · update_plan 도구를 실행하면 전체 할 일 목록이 여기에 표시됩니다.',
    otherFloorsLabel: '계획표가 있는 다른 층 바로가기:',
    focusAgentBtn: (name) => `직원 선택 · 이동 (${name})`,
    liveHint: '실시간 자동 갱신 · 단축키 B · Esc로 닫기',
    progressSummary: (s) => `진행률 ${s.pct}% (완료 ${s.completed} · 진행 중 ${s.inProgress} · 대기 ${s.pending} / 총 ${s.total}개)`,
    signMeetingTip: (d, n) => `클릭하여 전체 계획표 보기 (${d}/${n} 완료)`,
    signMeetingEmptyTip: '클릭하여 이 층의 계획표 서랍 열기',
    signAskTip: (l, n) => `${l} · ${n}명 승인/응답 대기 중 (클릭하여 선택)`,
    signRoomTip: (l, n) => `${l} · 작업 중 ${n}명 (클릭하여 직원 선택)`,
    signEmptyTip: (l) => `${l} · 현재 대기 중`,
  }),
  en: Object.freeze({
    boardSuffix: 'Plan Board', planBtn: 'Plan (B)', planBtnTitle: 'Open floor Plan Board drawer (Shortcut B)',
    copyBtn: 'Copy Markdown', copiedBtn: 'Copied!', closeBtn: 'Close',
    doneBadge: '✓ Done', activeBadge: '▶ Active', pendingBadge: '○ Pending', inProgressMd: 'In Progress', latestTag: 'Latest',
    emptyTitle: 'No active plan on this floor yet.',
    emptySub: 'Full task checklists appear here when an agent emits a TodoWrite or update_plan event.',
    otherFloorsLabel: 'Jump to another floor with an active plan:',
    focusAgentBtn: (name) => `Select & Focus (${name})`,
    liveHint: 'Live updates · Key B · Esc to close',
    progressSummary: (s) => `Progress ${s.pct}% (Done ${s.completed} · Active ${s.inProgress} · Pending ${s.pending} / Total ${s.total})`,
    signMeetingTip: (d, n) => `Click to inspect full Plan Board (${d}/${n} done)`,
    signMeetingEmptyTip: 'Click to open floor Plan Board drawer',
    signAskTip: (l, n) => `${l} · ${n} awaiting approval/input (Click to select)`,
    signRoomTip: (l, n) => `${l} · ${n} active agent(s) (Click to cycle)`,
    signEmptyTip: (l) => `${l} · Currently idle`,
  }),
});

export const boardDetailText = (lang = activeLangOf()) => BOARD_DETAIL_TEXT[langOf(lang)];

export function summarizePlanItems(items = []) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  let completed = 0;
  let inProgress = 0;
  for (const it of list) {
    if (it?.status === 'completed') completed += 1;
    else if (it?.status === 'in_progress') inProgress += 1;
  }
  const pending = Math.max(0, total - completed - inProgress);
  return { total, completed, inProgress, pending, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

export function formatPlanMarkdown({ floorLabel = '', title = '', branch = '', items = [], lang = activeLangOf() } = {}) {
  const t = boardDetailText(lang);
  const stats = summarizePlanItems(items);
  const head = `## [${floorLabel || '1F'}] ${title || 'Plan'}${branch ? ` (${branch})` : ''} — ${stats.completed}/${stats.total} (${stats.pct}%)`;
  const lines = (Array.isArray(items) ? items : []).map((it, i) => {
    const prefix = it?.status === 'in_progress' ? `**[${t.inProgressMd}]** ` : '';
    return `- [${it?.status === 'completed' ? 'x' : ' '}] ${i + 1}. ${prefix}${String(it?.content ?? '')}`;
  });
  return [head, ...lines].join('\n');
}

export function findBoardGroup(floor) {
  if (!floor?.archGroup || !floor?.board?.material) return null;
  const targetMat = floor.board.material;
  let planeMesh = null;
  floor.archGroup.traverse?.((o) => {
    if (!planeMesh && o?.isMesh && (o.material === targetMat || o.material?.isBoard)) planeMesh = o;
  });
  if (!planeMesh) return null;
  return planeMesh.parent && planeMesh.parent !== floor.archGroup ? planeMesh.parent : planeMesh;
}

export function collectBoardTargets(office) {
  const meshes = [];
  for (const f of office?.floors || []) {
    if (f?.group?.visible === false) continue;
    findBoardGroup(f)?.traverse?.((o) => {
      if (o?.isMesh) {
        o.userData = o.userData || {};
        o.userData.boardFloor = f;
        meshes.push(o);
      }
    });
  }
  return meshes;
}

export function hitFloorBoard(office, ndc) {
  if (!office?.raycaster || !office?.stage?.camera || !ndc || office.hitAgent?.(ndc)) return null;
  const targets = collectBoardTargets(office);
  if (!targets.length) return null;
  office.raycaster.setFromCamera(ndc, office.stage.camera);
  return office.raycaster.intersectObjects(targets, false)[0]?.object?.userData?.boardFloor || null;
}

export function pickRoomAgent(floor, roomKey, currentSelected = null) {
  if (!floor?.agents || !roomKey) return null;
  const list = [...floor.agents].filter((a) => a && a.room === roomKey);
  if (!list.length) return null;
  list.sort((a, b) => (!!a.asking !== !!b.asking ? (a.asking ? -1 : 1)
    : (a.mode === 'work') !== (b.mode === 'work') ? (a.mode === 'work' ? -1 : 1)
      : !!a.isSub !== !!b.isSub ? (a.isSub ? 1 : -1) : 0));
  const idx = currentSelected ? list.indexOf(currentSelected) : -1;
  return idx >= 0 ? list[(idx + 1) % list.length] : list[0];
}

export function computeRoomSignState(floor, roomKey, lang = activeLangOf()) {
  const t = boardDetailText(lang);
  const baseLabel = ROOMS[roomKey]?.label || roomKey;
  const occupants = [...(floor?.agents || [])].filter((a) => a && a.room === roomKey);
  const asking = occupants.some((a) => a.asking || a.mode === 'ask');
  if (roomKey === 'meeting') {
    const items = Array.isArray(floor?.board?.items) ? floor.board.items : [];
    if (items.length > 0) {
      const done = items.filter((it) => it?.status === 'completed').length;
      return { text: `${baseLabel} · ${done}/${items.length}`, hasPlan: true, occupants: occupants.length, asking, tooltip: t.signMeetingTip(done, items.length) };
    }
    return { text: baseLabel, hasPlan: false, occupants: occupants.length, asking, tooltip: t.signMeetingEmptyTip };
  }
  const tooltip = asking ? t.signAskTip(baseLabel, occupants.length) : occupants.length > 0 ? t.signRoomTip(baseLabel, occupants.length) : t.signEmptyTip(baseLabel);
  return { text: baseLabel, hasPlan: false, occupants: occupants.length, asking, tooltip };
}

const STYLE_CSS = `
.bubble, .sign, .floortag { pointer-events: auto; cursor: pointer; }
.sign:hover, .floortag:hover, .bubble:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
.sign[data-asking="true"] { border-bottom-color: var(--ask-line); box-shadow: 0 0 0 2px var(--ask-line), var(--shadow); }
#board-detail { grid-column: 2; grid-row: 2 / 4; justify-self: center; align-self: center; z-index: 18; width: min(480px, calc(100vw - 32px)); max-height: min(76dvh, 560px); display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; box-sizing: border-box; background: var(--panel-solid); border: 1px solid var(--accent); }
#board-detail[hidden] { display: none !important; }
.bd-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.bd-title { display: flex; align-items: center; gap: 8px; min-width: 0; font: 600 14px/1.2 var(--font-ui); }
.bd-fl { background: var(--fg); color: var(--bg); font: 600 11px/1 var(--font-mono); padding: 4px 7px; border-radius: 4px; flex: none; }
.bd-actions, .bd-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bd-tab { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--muted-bg); color: var(--muted); font: 500 11.5px/1.2 var(--font-ui); cursor: pointer; }
.bd-tab[aria-selected="true"] { border-color: var(--accent); color: var(--fg); background: color-mix(in srgb, var(--accent) 16%, var(--panel-solid)); font-weight: 600; }
.bd-tab i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.bd-prog { background: var(--muted-bg); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; display: grid; gap: 6px; }
.bd-prog-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; font: 500 11px/1.25 var(--font-mono); color: var(--fg); }
.bd-track { height: 7px; border-radius: 999px; background: var(--line); overflow: hidden; display: flex; }
.bd-bar-done { background: #2fb36a; height: 100%; transition: width 0.2s ease; }
.bd-bar-active { background: #e0a32a; height: 100%; transition: width 0.2s ease; }
.bd-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; overflow-y: auto; max-height: 290px; }
.bd-item { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-solid); font-size: 12.5px; }
.bd-item[data-status="in_progress"] { border-color: #e0a32a; background: color-mix(in srgb, #e0a32a 12%, var(--panel-solid)); font-weight: 500; }
.bd-item[data-status="completed"] .bd-txt { text-decoration: line-through; color: var(--muted); }
.bd-num { font: 500 11px/1.4 var(--font-mono); color: var(--muted); }
.bd-txt { overflow-wrap: anywhere; line-height: 1.4; }
.bd-pill { font: 600 10px/1.2 var(--font-mono); padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.bd-pill.completed { background: color-mix(in srgb, #2fb36a 18%, transparent); color: #2fb36a; }
.bd-pill.in_progress { background: color-mix(in srgb, #e0a32a 20%, transparent); color: #d99b1e; }
.bd-pill.pending { background: var(--muted-bg); color: var(--muted); }
.bd-empty { padding: 14px 12px; border-radius: 9px; background: var(--muted-bg); color: var(--muted); font-size: 12px; display: grid; gap: 8px; }
.bd-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; border-top: 1px solid var(--line); }
@media (max-width: 720px) { #board-detail { grid-column: 1; grid-row: 3 / 8; width: calc(100vw - 20px); max-height: 68dvh; } }
`;

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

export function installBoardDetail({ office, hud, stage, canvas } = {}) {
  if (typeof document === 'undefined' || !office) return { hitBoard: () => null, openFloorBoard: () => {} };
  if (!document.getElementById('board-detail-style')) {
    document.head.appendChild(Object.assign(document.createElement('style'), { id: 'board-detail-style', textContent: STYLE_CSS }));
  }
  const sec = Object.assign(el('section', 'panel'), { id: 'board-detail', hidden: true });
  sec.innerHTML = `
    <header class="bd-head"><div class="bd-title"><span class="bd-fl" data-bd="fl"></span><span data-bd="room"></span></div>
      <div class="bd-actions"><button type="button" class="ghost" data-bd="copy"></button><button type="button" class="ghost" data-bd="close"></button></div></header>
    <div class="bd-tabs" data-bd="tabs" role="tablist"></div>
    <div class="bd-prog" data-bd="prog"><div class="bd-prog-meta"><span data-bd="summary"></span><span data-bd="branch" style="color:var(--accent)"></span></div>
      <div class="bd-track"><div class="bd-bar-done" data-bd="bar-done"></div><div class="bd-bar-active" data-bd="bar-active"></div></div></div>
    <ol class="bd-list" data-bd="list"></ol><div class="bd-empty" data-bd="empty" hidden></div>
    <footer class="bd-foot"><button type="button" class="ghost primary" data-bd="focus"></button><span data-bd="hint" style="font-size:11px;color:var(--muted)"></span></footer>`;
  document.getElementById('hud')?.appendChild(sec);
  const q = (k) => sec.querySelector(`[data-bd="${k}"]`);

  let inspBoardBtn = hud?.el?.insp?.querySelector?.('[data-act="board"]') || null;
  if (!inspBoardBtn && hud?.el?.insp) {
    const followBtn = hud.el.insp.querySelector('[data-act="follow"]');
    if (followBtn?.parentElement) {
      inspBoardBtn = Object.assign(el('button', 'ghost'), { type: 'button' });
      inspBoardBtn.dataset.act = 'board';
      followBtn.before(inspBoardBtn);
    }
  }

  let activeFloor = null;
  let activeOwner = null;
  let unsubBoard = null;
  let hoveredFloor = null;

  function syncAllSigns() {
    const t = boardDetailText();
    if (inspBoardBtn) { inspBoardBtn.textContent = t.planBtn; inspBoardBtn.title = t.planBtnTitle; }
    for (const f of office.floors || []) {
      for (const lbl of f.labels || []) {
        const node = lbl?.element;
        const room = node?.dataset?.room;
        if (!room) continue;
        const st = computeRoomSignState(f, room);
        if (node.textContent !== st.text) node.textContent = st.text;
        node.title = st.tooltip;
        node.dataset.asking = String(st.asking);
        node.dataset.active = String(st.occupants > 0 || st.hasPlan);
      }
    }
  }

  const activeSnapshot = (floor) => {
    const hist = floor?.board?.history || [];
    if (!hist.length) return floor?.board?.items?.length ? { owner: floor.board.owner, title: floor.board.title, items: floor.board.items, ink: floor.board.ink } : null;
    return hist.find((h) => h.owner === activeOwner) || hist[0];
  };

  function render() {
    syncAllSigns();
    if (sec.hidden || !activeFloor) return;
    const t = boardDetailText();
    q('fl').textContent = `${activeFloor.number} · ${activeFloor.label}`;
    q('room').textContent = `${ROOMS.meeting.label} · ${t.boardSuffix}`;
    q('copy').textContent = t.copyBtn;
    q('close').textContent = t.closeBtn;
    q('hint').textContent = t.liveHint;

    const snap = activeSnapshot(activeFloor);
    const tabsEl = q('tabs');
    tabsEl.replaceChildren();
    const hist = activeFloor.board?.history || [];
    tabsEl.hidden = hist.length <= 1;
    if (hist.length > 1) {
      hist.forEach((h, idx) => {
        const btn = Object.assign(el('button', 'bd-tab'), { type: 'button' });
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(snap ? h.owner === snap.owner : idx === 0));
        const dot = el('i');
        dot.style.background = office.agents.get(h.owner)?.color || h.ink || 'var(--accent)';
        btn.append(dot, el('span', '', idx === 0 ? `${h.title} · ${t.latestTag}` : h.title));
        btn.addEventListener('click', () => { activeOwner = h.owner; render(); });
        tabsEl.appendChild(btn);
      });
    }

    if (!snap || !snap.items?.length) {
      q('prog').hidden = q('list').hidden = q('copy').hidden = q('focus').hidden = true;
      const emp = q('empty');
      emp.hidden = false;
      emp.replaceChildren(el('strong', '', t.emptyTitle), el('span', '', t.emptySub));
      const others = office.floors.filter((f) => f !== activeFloor && f.board?.items?.length > 0);
      if (others.length) {
        const row = el('div', 'bd-tabs');
        others.forEach((f) => {
          const b = Object.assign(el('button', 'ghost', `${f.number} · ${f.label} (${f.board.items.length})`), { type: 'button' });
          b.addEventListener('click', () => openFloorBoard(f));
          row.appendChild(b);
        });
        emp.appendChild(row);
      }
      return;
    }

    activeOwner = snap.owner;
    q('empty').hidden = true;
    q('prog').hidden = q('list').hidden = q('copy').hidden = false;
    const stats = summarizePlanItems(snap.items);
    const ag = office.agents.get(snap.owner);
    q('summary').textContent = t.progressSummary(stats);
    q('branch').textContent = ag?.branch ? `${snap.title} · ${ag.branch}` : snap.title;
    q('bar-done').style.width = `${stats.total ? (stats.completed / stats.total) * 100 : 0}%`;
    q('bar-active').style.width = `${stats.total ? (stats.inProgress / stats.total) * 100 : 0}%`;

    const listEl = q('list');
    const prevScroll = listEl.scrollTop;
    listEl.replaceChildren(...snap.items.map((it, idx) => {
      const st = it.status || 'pending';
      const li = el('li', 'bd-item');
      li.dataset.status = st;
      const badge = st === 'completed' ? t.doneBadge : st === 'in_progress' ? t.activeBadge : t.pendingBadge;
      li.append(el('span', 'bd-num', `${idx + 1}.`), el('span', 'bd-txt', it.content), el('span', `bd-pill ${st}`, badge));
      return li;
    }));
    listEl.scrollTop = prevScroll;

    const focusBtn = q('focus');
    focusBtn.hidden = !ag;
    if (ag) focusBtn.textContent = t.focusAgentBtn(ag.name || snap.title);
  }

  function close() { sec.hidden = true; unsubBoard?.(); unsubBoard = null; }

  function openFloorBoard(floor, ownerId = null) {
    const target = floor || office.floors[office.focusIndex] || office.floors[0];
    if (!target) return;
    if (hud?.el?.legend && !hud.el.legend.hidden) hud.el.legendBtn?.click?.();
    unsubBoard?.();
    activeFloor = target;
    activeOwner = ownerId || target.board?.owner || null;
    sec.hidden = false;
    unsubBoard = target.board?.onChange?.(() => render()) || null;
    render();
  }

  q('close').addEventListener('click', close);
  inspBoardBtn?.addEventListener('click', () => openFloorBoard(office.selected?.floor || office.floors[office.focusIndex], office.selected?.id || null));
  hud?.el?.legendBtn?.addEventListener?.('click', () => { if (!sec.hidden) close(); });
  hud?.el?.list?.addEventListener?.('click', (e) => {
    const li = e.target?.closest?.('li[data-kind="plan"]');
    const ag = li && office.agents.get(li.dataset.sid);
    if (ag) openFloorBoard(ag.floor, ag.id);
  });
  q('focus').addEventListener('click', () => {
    const ag = activeOwner ? office.agents.get(activeOwner) : null;
    if (!ag) return;
    if (ag.floor.index !== office.focusIndex || office.overview) office.focus(ag.floor.index);
    office.select(ag, { focusPan: true });
    close();
  });
  q('copy').addEventListener('click', () => {
    const snap = activeFloor && activeSnapshot(activeFloor);
    if (!snap) return;
    const md = formatPlanMarkdown({ floorLabel: `${activeFloor.number} · ${activeFloor.label}`, title: snap.title, branch: office.agents.get(snap.owner)?.branch || '', items: snap.items });
    navigator.clipboard?.writeText?.(md).catch(() => {});
    q('copy').textContent = boardDetailText().copiedBtn;
    setTimeout(() => { if (!sec.hidden) q('copy').textContent = boardDetailText().copyBtn; }, 1200);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape' && !sec.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      if (!sec.hidden) close();
      else openFloorBoard(office.selected?.floor || office.floors[office.focusIndex], office.selected?.id || null);
    }
  }, { capture: true });

  (stage?.el || document).addEventListener('click', (e) => {
    const signEl = e.target?.closest?.('.sign[data-room]');
    if (signEl) {
      const flIdx = signEl.dataset.floor != null ? Number(signEl.dataset.floor) : office.focusIndex;
      const floor = office.floors[flIdx] || office.floors[office.focusIndex] || office.floors[0];
      const room = signEl.dataset.room;
      if (room === 'meeting') openFloorBoard(floor);
      else if (floor) {
        const ag = pickRoomAgent(floor, room, office.selected);
        if (ag) {
          if (floor.index !== office.focusIndex || office.overview) office.focus(floor.index);
          office.select(ag, { focusPan: true });
        } else if (office.overview) office.focus(floor.index);
      }
      return;
    }
    const floorTag = e.target?.closest?.('.floortag[data-floor]');
    if (floorTag) {
      const idx = Number(floorTag.dataset.floor);
      if (Number.isFinite(idx)) office.focus(!office.overview && office.focusIndex === idx ? 'all' : idx);
    }
  });

  if (office.refreshLabels) {
    const orig = office.refreshLabels.bind(office);
    office.refreshLabels = (...args) => { const r = orig(...args); render(); return r; };
  }
  if (hud?.floorStats) {
    const orig = hud.floorStats.bind(hud);
    hud.floorStats = (...args) => { const r = orig(...args); syncAllSigns(); return r; };
  }
  syncAllSigns();

  function setHoveredFloor(f) {
    if (hoveredFloor === f) return;
    if (hoveredFloor?.board?.material?.userData) hoveredFloor.board.material.emissiveIntensity = hoveredFloor.board.material.userData.baseEmissive = 0.3;
    hoveredFloor = f;
    if (hoveredFloor?.board?.material?.userData) hoveredFloor.board.material.emissiveIntensity = hoveredFloor.board.material.userData.baseEmissive = 0.58;
  }
  canvas?.addEventListener?.('pointerleave', () => setHoveredFloor(null));

  return { hitBoard(ndc) { const f = hitFloorBoard(office, ndc); setHoveredFloor(f); return f; }, openFloorBoard, close, syncAllSigns };
}
