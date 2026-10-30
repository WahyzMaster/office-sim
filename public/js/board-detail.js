// 3D 화이트보드(기획·작전실 계획표) 클릭 상세 서랍 + 방 간판(.sign)·층 배지(.floortag)·말풍선(.bubble) 상호작용.
import { ROOMS, activeLangOf, langOf } from './rooms.js';

export const BOARD_DETAIL_TEXT = Object.freeze({
  ko: Object.freeze({
    boardSuffix: '계획표',
    copyBtn: '마크다운 복사',
    copiedBtn: '복사됨!',
    closeBtn: '닫기',
    doneBadge: '✓ 완료',
    activeBadge: '▶ 진행 중',
    pendingBadge: '○ 대기',
    inProgressMd: '진행 중',
    latestTag: '최신',
    emptyTitle: '이 층에는 아직 작성된 계획표가 없어요.',
    emptySub: '에이전트가 TodoWrite · update_plan 도구를 실행하면 전체 할 일 목록이 여기에 표시됩니다.',
    otherFloorsLabel: '계획표가 있는 다른 층 바로가기:',
    focusAgentBtn: (name) => `직원 선택 · 이동 (${name})`,
    liveHint: '실시간 자동 갱신 · Esc로 닫기',
    progressSummary: (s) =>
      `진행률 ${s.pct}% (완료 ${s.completed} · 진행 중 ${s.inProgress} · 대기 ${s.pending} / 총 ${s.total}개)`,
  }),
  en: Object.freeze({
    boardSuffix: 'Plan Board',
    copyBtn: 'Copy Markdown',
    copiedBtn: 'Copied!',
    closeBtn: 'Close',
    doneBadge: '✓ Done',
    activeBadge: '▶ Active',
    pendingBadge: '○ Pending',
    inProgressMd: 'In Progress',
    latestTag: 'Latest',
    emptyTitle: 'No active plan on this floor yet.',
    emptySub: 'Full task checklists appear here when an agent emits a TodoWrite or update_plan event.',
    otherFloorsLabel: 'Jump to another floor with an active plan:',
    focusAgentBtn: (name) => `Select & Focus (${name})`,
    liveHint: 'Live updates · Esc to close',
    progressSummary: (s) =>
      `Progress ${s.pct}% (Done ${s.completed} · Active ${s.inProgress} · Pending ${s.pending} / Total ${s.total})`,
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
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, inProgress, pending, pct };
}

export function formatPlanMarkdown({ floorLabel = '', title = '', branch = '', items = [], lang = activeLangOf() } = {}) {
  const t = boardDetailText(lang);
  const stats = summarizePlanItems(items);
  const br = branch ? ` (${branch})` : '';
  const head = `## [${floorLabel || '1F'}] ${title || 'Plan'}${br} — ${stats.completed}/${stats.total} (${stats.pct}%)`;
  const lines = (Array.isArray(items) ? items : []).map((it, i) => {
    const done = it?.status === 'completed';
    const active = it?.status === 'in_progress';
    const prefix = active ? `**[${t.inProgressMd}]** ` : '';
    return `- [${done ? 'x' : ' '}] ${i + 1}. ${prefix}${String(it?.content ?? '')}`;
  });
  return [head, ...lines].join('\n');
}

export function findBoardGroup(floor) {
  if (!floor?.archGroup || !floor?.board?.material) return null;
  const targetMat = floor.board.material;
  let planeMesh = null;
  floor.archGroup.traverse?.((o) => {
    if (!planeMesh && o?.isMesh && (o.material === targetMat || o.material?.isBoard)) {
      planeMesh = o;
    }
  });
  if (!planeMesh) return null;
  return planeMesh.parent && planeMesh.parent !== floor.archGroup ? planeMesh.parent : planeMesh;
}

export function collectBoardTargets(office) {
  const meshes = [];
  if (!office?.floors) return meshes;
  for (const f of office.floors) {
    if (f?.group?.visible === false) continue;
    const grp = findBoardGroup(f);
    if (!grp) continue;
    grp.traverse?.((o) => {
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
  if (!office?.raycaster || !office?.stage?.camera || !ndc) return null;
  if (office.hitAgent?.(ndc)) return null;
  const targets = collectBoardTargets(office);
  if (!targets.length) return null;
  office.raycaster.setFromCamera(ndc, office.stage.camera);
  const hit = office.raycaster.intersectObjects(targets, false)[0];
  return hit?.object?.userData?.boardFloor || null;
}

export function pickRoomAgent(floor, roomKey, currentSelected = null) {
  if (!floor?.agents || !roomKey) return null;
  const list = [...floor.agents].filter((a) => a && a.room === roomKey);
  if (!list.length) return null;
  list.sort((a, b) => {
    if (!!a.asking !== !!b.asking) return a.asking ? -1 : 1;
    if ((a.mode === 'work') !== (b.mode === 'work')) return a.mode === 'work' ? -1 : 1;
    if (!!a.isSub !== !!b.isSub) return a.isSub ? 1 : -1;
    return 0;
  });
  const idx = currentSelected ? list.indexOf(currentSelected) : -1;
  return idx >= 0 ? list[(idx + 1) % list.length] : list[0];
}

function injectBoardDetailStyles() {
  if (typeof document === 'undefined' || document.getElementById('board-detail-style')) return;
  const st = document.createElement('style');
  st.id = 'board-detail-style';
  st.textContent = `
    .bubble, .sign, .floortag { pointer-events: auto; cursor: pointer; }
    .sign:hover, .floortag:hover, .bubble:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
    #board-detail {
      grid-column: 2; grid-row: 2 / 4; justify-self: center; align-self: center; z-index: 18;
      width: min(480px, calc(100vw - 32px)); max-height: min(76dvh, 560px);
      display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; box-sizing: border-box;
      background: var(--panel-solid); border: 1px solid var(--accent);
    }
    #board-detail[hidden] { display: none !important; }
    .bd-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .bd-title { display: flex; align-items: center; gap: 8px; min-width: 0; font: 600 14px/1.2 var(--font-ui); }
    .bd-fl { background: var(--fg); color: var(--bg); font: 600 11px/1 var(--font-mono); padding: 4px 7px; border-radius: 4px; flex: none; }
    .bd-actions { display: flex; align-items: center; gap: 6px; flex: none; }
    .bd-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .bd-tab {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 8px;
      border: 1px solid var(--line); background: var(--muted-bg); color: var(--muted);
      font: 500 11.5px/1.2 var(--font-ui); cursor: pointer;
    }
    .bd-tab[aria-selected="true"] { border-color: var(--accent); color: var(--fg); background: color-mix(in srgb, var(--accent) 16%, var(--panel-solid)); font-weight: 600; }
    .bd-tab i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .bd-prog { background: var(--muted-bg); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; display: grid; gap: 6px; }
    .bd-prog-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; font: 500 11px/1.25 var(--font-mono); color: var(--fg); }
    .bd-track { height: 7px; border-radius: 999px; background: var(--line); overflow: hidden; display: flex; }
    .bd-bar-done { background: #2fb36a; height: 100%; transition: width 0.2s ease; }
    .bd-bar-active { background: #e0a32a; height: 100%; transition: width 0.2s ease; }
    .bd-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; overflow-y: auto; max-height: 290px; }
    .bd-item {
      display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: start;
      padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-solid); font-size: 12.5px;
    }
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
  `;
  document.head.appendChild(st);
}

export function installBoardDetail({ office, hud, stage, canvas } = {}) {
  if (typeof document === 'undefined' || !office) return { hitBoard: () => null, openFloorBoard: () => {} };
  injectBoardDetailStyles();
  const hudEl = document.getElementById('hud');
  const sec = document.createElement('section');
  sec.id = 'board-detail';
  sec.className = 'panel';
  sec.hidden = true;
  sec.innerHTML = `
    <header class="bd-head">
      <div class="bd-title"><span class="bd-fl" data-bd="fl"></span><span data-bd="room"></span></div>
      <div class="bd-actions">
        <button type="button" class="ghost" data-bd="copy"></button>
        <button type="button" class="ghost" data-bd="close"></button>
      </div>
    </header>
    <div class="bd-tabs" data-bd="tabs" role="tablist"></div>
    <div class="bd-prog" data-bd="prog">
      <div class="bd-prog-meta"><span data-bd="summary"></span><span data-bd="branch" style="color:var(--accent)"></span></div>
      <div class="bd-track"><div class="bd-bar-done" data-bd="bar-done"></div><div class="bd-bar-active" data-bd="bar-active"></div></div>
    </div>
    <ol class="bd-list" data-bd="list"></ol>
    <div class="bd-empty" data-bd="empty" hidden></div>
    <footer class="bd-foot">
      <button type="button" class="ghost primary" data-bd="focus"></button>
      <span data-bd="hint" style="font-size:11px;color:var(--muted)"></span>
    </footer>
  `;
  hudEl?.appendChild(sec);
  const q = (k) => sec.querySelector(`[data-bd="${k}"]`);

  let activeFloor = null;
  let activeOwner = null;
  let unsubBoard = null;
  let hoveredFloor = null;

  function activeSnapshot(floor) {
    const hist = floor?.board?.history || [];
    if (!hist.length) {
      return floor?.board?.items?.length
        ? { owner: floor.board.owner, title: floor.board.title, items: floor.board.items, ink: floor.board.ink }
        : null;
    }
    return hist.find((h) => h.owner === activeOwner) || hist[0];
  }

  function render() {
    if (sec.hidden || !activeFloor) return;
    const t = boardDetailText();
    const floorLabel = `${activeFloor.number} · ${activeFloor.label}`;
    q('fl').textContent = floorLabel;
    q('room').textContent = `${ROOMS.meeting.label} · ${t.boardSuffix}`;
    q('copy').textContent = t.copyBtn;
    q('close').textContent = t.closeBtn;
    q('hint').textContent = t.liveHint;

    const snap = activeSnapshot(activeFloor);
    const tabsEl = q('tabs');
    tabsEl.replaceChildren();
    const hist = activeFloor.board?.history || [];
    if (hist.length > 1) {
      tabsEl.hidden = false;
      hist.forEach((h, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bd-tab';
        btn.setAttribute('role', 'tab');
        const selected = snap ? h.owner === snap.owner : idx === 0;
        btn.setAttribute('aria-selected', String(selected));
        const dot = document.createElement('i');
        const ag = office.agents.get(h.owner);
        dot.style.background = ag?.color || h.ink || 'var(--accent)';
        const lbl = document.createElement('span');
        lbl.textContent = idx === 0 ? `${h.title} · ${t.latestTag}` : h.title;
        btn.append(dot, lbl);
        btn.addEventListener('click', () => {
          activeOwner = h.owner;
          render();
        });
        tabsEl.appendChild(btn);
      });
    } else {
      tabsEl.hidden = true;
    }

    if (!snap || !snap.items?.length) {
      q('prog').hidden = true;
      q('list').hidden = true;
      q('copy').hidden = true;
      q('focus').hidden = true;
      const emp = q('empty');
      emp.hidden = false;
      emp.replaceChildren();
      const p1 = document.createElement('strong');
      p1.textContent = t.emptyTitle;
      const p2 = document.createElement('span');
      p2.textContent = t.emptySub;
      emp.append(p1, p2);
      const others = office.floors.filter((f) => f !== activeFloor && f.board?.items?.length > 0);
      if (others.length) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.flexWrap = 'wrap';
        row.style.gap = '6px';
        others.forEach((f) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ghost';
          b.textContent = `${f.number} · ${f.label} (${f.board.items.length})`;
          b.addEventListener('click', () => openFloorBoard(f));
          row.appendChild(b);
        });
        emp.appendChild(row);
      }
      return;
    }

    activeOwner = snap.owner;
    q('empty').hidden = true;
    q('prog').hidden = false;
    q('list').hidden = false;
    q('copy').hidden = false;
    const stats = summarizePlanItems(snap.items);
    const ag = office.agents.get(snap.owner);
    q('summary').textContent = t.progressSummary(stats);
    q('branch').textContent = ag?.branch ? `${snap.title} · ${ag.branch}` : snap.title;
    q('bar-done').style.width = `${stats.total ? (stats.completed / stats.total) * 100 : 0}%`;
    q('bar-active').style.width = `${stats.total ? (stats.inProgress / stats.total) * 100 : 0}%`;

    const listEl = q('list');
    listEl.replaceChildren();
    snap.items.forEach((it, idx) => {
      const st = it.status || 'pending';
      const li = document.createElement('li');
      li.className = 'bd-item';
      li.dataset.status = st;
      const num = document.createElement('span');
      num.className = 'bd-num';
      num.textContent = `${idx + 1}.`;
      const txt = document.createElement('span');
      txt.className = 'bd-txt';
      txt.textContent = it.content;
      const pill = document.createElement('span');
      pill.className = `bd-pill ${st}`;
      pill.textContent = st === 'completed' ? t.doneBadge : st === 'in_progress' ? t.activeBadge : t.pendingBadge;
      li.append(num, txt, pill);
      listEl.appendChild(li);
    });

    const focusBtn = q('focus');
    if (ag) {
      focusBtn.hidden = false;
      focusBtn.textContent = t.focusAgentBtn(ag.name || snap.title);
    } else {
      focusBtn.hidden = true;
    }
  }

  function close() {
    sec.hidden = true;
    unsubBoard?.();
    unsubBoard = null;
  }

  function openFloorBoard(floor) {
    const target = floor || office.floors[office.focusIndex] || office.floors[0];
    if (!target) return;
    unsubBoard?.();
    activeFloor = target;
    activeOwner = target.board?.owner || null;
    sec.hidden = false;
    unsubBoard = target.board?.onChange?.(() => render()) || null;
    render();
  }

  q('close').addEventListener('click', close);
  q('focus').addEventListener('click', () => {
    const ag = activeOwner ? office.agents.get(activeOwner) : null;
    if (!ag) return;
    if (ag.floor.index !== office.focusIndex || office.overview) office.focus(ag.floor.index);
    office.select(ag, { focusPan: true });
    close();
  });
  q('copy').addEventListener('click', () => {
    if (!activeFloor) return;
    const snap = activeSnapshot(activeFloor);
    if (!snap) return;
    const ag = office.agents.get(snap.owner);
    const md = formatPlanMarkdown({
      floorLabel: `${activeFloor.number} · ${activeFloor.label}`,
      title: snap.title,
      branch: ag?.branch || '',
      items: snap.items,
    });
    navigator.clipboard?.writeText?.(md).catch(() => {});
    const t = boardDetailText();
    q('copy').textContent = t.copiedBtn;
    setTimeout(() => { if (!sec.hidden) q('copy').textContent = boardDetailText().copyBtn; }, 1200);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sec.hidden) close();
  });

  // 방 간판(.sign) 및 3D 층 배지(.floortag) 클릭 위임
  (stage?.el || document).addEventListener('click', (e) => {
    const signEl = e.target?.closest?.('.sign[data-room]');
    if (signEl) {
      const flIdx = signEl.dataset.floor != null ? Number(signEl.dataset.floor) : office.focusIndex;
      const floor = office.floors[flIdx] || office.floors[office.focusIndex] || office.floors[0];
      const room = signEl.dataset.room;
      if (room === 'meeting') {
        openFloorBoard(floor);
      } else if (floor) {
        const ag = pickRoomAgent(floor, room, office.selected);
        if (ag) {
          if (floor.index !== office.focusIndex || office.overview) office.focus(floor.index);
          office.select(ag, { focusPan: true });
        } else if (office.overview) {
          office.focus(floor.index);
        }
      }
      return;
    }
    const floorTag = e.target?.closest?.('.floortag[data-floor]');
    if (floorTag) {
      const idx = Number(floorTag.dataset.floor);
      if (Number.isFinite(idx)) {
        office.focus(!office.overview && office.focusIndex === idx ? 'all' : idx);
      }
    }
  });

  if (hud?.refreshLanguage) {
    const origLang = hud.refreshLanguage.bind(hud);
    hud.refreshLanguage = (...args) => {
      const res = origLang(...args);
      render();
      return res;
    };
  }

  function setHoveredFloor(f) {
    if (hoveredFloor === f) return;
    if (hoveredFloor?.board?.material?.userData) {
      hoveredFloor.board.material.userData.baseEmissive = 0.3;
      hoveredFloor.board.material.emissiveIntensity = 0.3;
    }
    hoveredFloor = f;
    if (hoveredFloor?.board?.material?.userData) {
      hoveredFloor.board.material.userData.baseEmissive = 0.58;
      hoveredFloor.board.material.emissiveIntensity = 0.58;
    }
  }

  canvas?.addEventListener?.('pointerleave', () => setHoveredFloor(null));

  return {
    hitBoard(ndc) {
      const f = hitFloorBoard(office, ndc);
      setHoveredFloor(f);
      return f;
    },
    openFloorBoard,
    close,
  };
}
