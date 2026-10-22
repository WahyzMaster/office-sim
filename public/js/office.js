// 사무실 상태. 모든 입력(데모, SSE)은 onEvent(ev) 한 곳으로 들어온다.
import * as THREE from 'three';
import { Floor, FLOOR_GAP, EXPLODE_GAP } from './floor.js';
import { Agent } from './agent.js';
import { ROOMS, classify, toolLabel } from './rooms.js';
import { Inbox } from './office-inbox.js';
import { floorDetail, labelRootIndex } from './detail.js';
import { waitStart, waitEnd, reconcileWaits, snapshotWaits, liveAskStays, textKey, rememberText, forgetText, forgetTexts } from './approval.js';

export const GLOBAL_FLOOR_KEY = '_global';
export const GLOBAL_FLOOR_LABEL = '전역 · 미지정';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// 이 이벤트가 오면 tool_end 를 못 받은 채 열려 있는 질문은 이미 끝난 것이다(새 요청, 새 메시지, 턴 끝).
const ASK_OVER = new Set(['prompt', 'thinking', 'turn_end']);
// 이 이벤트는 같은 메시지 안의 형제 블록일 수 있어서, 질문보다 확실히 나중(ts 차이)일 때만 닫는다.
const ASK_OVER_LATER = new Set(['say', 'tool_start']);
const ASK_SIBLING_MS = 5_000;

export class Office {
  constructor(stage, hud) {
    this.stage = stage;
    this.hud = hud;
    this.floors = [];
    this.byKey = new Map();
    this.agents = new Map();
    this.focusIndex = 0;
    this.overview = false;
    this.selected = null;
    this.follow = false;
    this.inbox = new Inbox();
    this.toolTexts = new Map(); // sessionId|toolUseId -> 도구 문구, 라이브 승인 대기 질문에 쓴다(approval.js)
    this.raycaster = new THREE.Raycaster();
    this.tmp = new THREE.Vector3();
    stage.setViewFn((aspect) => this.viewHalf(aspect));
    stage.setOnUserPan?.(() => {
      if (this.follow) {
        this.follow = false;
        if (this.selected) this.hud.inspect(this.selected, this);
      }
    });
  }

  // project 는 층을 구분하는 키(서버에서는 저장소 경로), label 은 화면에 보이는 이름.
  // 키가 없으면 층을 만들지 않는다(null). 그런 직원은 project 가 오는 session 을 기다린다.
  floorFor(project, label) {
    if (!project) return null;
    let f = this.byKey.get(project);
    if (!f) {
      f = new Floor(this.stage, project, this.floors.length, label || project.split('/').filter(Boolean).pop() || project);
      this.floors.push(f);
      this.byKey.set(project, f);
      this.layout();
      this.hud.renderFloors(this);
    } else if (label && f.label !== label) {
      f.label = label;
      f.renameTag();
      this.hud.renderFloors(this);
    }
    return f;
  }

  // ---- 이벤트 진입점 ----
  onEvent(ev) {
    let a = this.agents.get(ev.sessionId);
    if (ev.type === 'session') {
      a = this.upsert(ev);
      if (!a) {
        this.inbox.hold(ev); // 아직 놓을 층을 모른다
        return;
      }
    } else if (!a) {
      // 모르는 직원: 유령을 만들지 않고 잠깐 맡아 둔다. session 이 오면 이어서 처리하고, 늦으면 버린다.
      if (ev.type === 'session_end') this.inbox.drop(ev.sessionId);
      else this.inbox.hold(ev);
      return;
    }
    if (!ev.replay) this.closeStaleAsks(a, ev);
    let line = null;
    let kind = '';
    switch (ev.type) {
      case 'session':
        line = a.isSub ? `${a.agentType} 투입 · ${a.name}` : `출근 · ${a.floor.label}`;
        kind = 'session';
        break;
      case 'prompt':
        a.push({ kind: 'note', text: '새 요청 받음' });
        line = `요청 · ${ev.text || ''}`;
        kind = 'prompt';
        break;
      case 'tool_start':
        line = this.toolStart(a, ev);
        kind = 'tool';
        break;
      case 'tool_end':
        a.toolEnd(ev);
        forgetText(this.toolTexts, a.id, ev.toolUseId);
        if (!ev.ok && ev.errorKind !== 'abandoned') {
          const soft = ev.errorKind === 'denied' || ev.errorKind === 'interrupted';
          line = `${{ denied: '거절', interrupted: '중단' }[ev.errorKind] || '실패'} · ${ev.error || ''}`;
          kind = soft ? 'denied' : 'error';
        }
        break;
      case 'tool_wait':
        // 라이브 권한 대기(Grok): 열리면 내 자리에서 승인을 기다리고, 허용되면 도구 방으로 돌아간다. 거절은 tool_end denied 로 온다.
        if (ev.waiting === true) line = waitStart(a, ev, this.toolTexts.get(textKey(a.id, ev.toolUseId)))?.question ?? null;
        else if (ev.waiting === false) waitEnd(a, ev.toolUseId);
        kind = 'tool';
        break;
      case 'thinking':
        a.push({ kind: 'think', text: ev.text || null, ttl: clamp((ev.durationMs || 2000) / 1000, 1.8, 6) });
        line = `생각 · ${ev.text || '요약 없음'}`;
        kind = 'think';
        break;
      case 'say':
        a.push({ kind: 'say', text: ev.text });
        line = `“${ev.text}”`;
        break;
      case 'plan':
        line = this.plan(a, ev.items || []);
        kind = 'plan';
        break;
      case 'turn_end':
        a.push({ kind: 'idle', room: 'lounge', activity: '대기 중' });
        line = '턴 종료';
        kind = 'muted';
        break;
      case 'session_end':
        // 끝난 세션의 열린 도구/질문은 더 이상 답이 오지 않는다. 남겨 두면 질문이 퇴근을 영원히 막는다.
        a.abandonPending();
        forgetTexts(this.toolTexts, a.id);
        a.leave();
        line = a.isSub ? '보고 끝, 복귀' : '퇴근';
        kind = 'muted';
        break;
      case 'system':
        if (ev.kind === 'api_error') {
          a.push({ kind: 'error', text: ev.text || 'API 오류' });
          line = `API 오류 · ${ev.text || ''}`;
          kind = 'error';
        } else if (ev.kind === 'compact') {
          a.push({ kind: 'note', text: '기억 정리 중…' });
          line = '컨텍스트 압축';
          kind = 'muted';
        } else if (ev.kind === 'refusal') {
          a.push({ kind: 'error', text: ev.text || '응답 거절됨', errorKind: 'denied' });
          line = `응답 거절 · ${ev.text || ''}`;
          kind = 'denied';
        }
        break;
      default:
        break;
    }
    if (line) {
      a.note(line, kind);
      if (!ev.replay) this.hud.log(a, line, kind);
      this.hud.ping(a.floor, kind);
      if (this.selected === a) this.hud.inspect(a, this);
    }
    if (ev.type === 'session') {
      for (const held of this.inbox.take(a.id)) if (held.type !== 'session') this.onEvent(held);
      // 이 직원을 부모로 기다리던 서브에이전트도 이제 놓을 수 있다(손주는 재귀로 이어진다).
      for (const id of this.inbox.childrenOf(a.id)) {
        const evs = this.inbox.take(id);
        const s = evs.filter((e) => e.type === 'session').pop();
        if (s) this.onEvent(s);
        for (const e of evs) if (e.type !== 'session') this.onEvent(e);
      }
    }
  }

  // 같은 직원의 새 작업이 왔는데 질문이 아직 열려 있으면 tool_end 를 놓친 것: 질문을 닫고 다음 일로 간다.
  // 라이브 승인 대기(live)는 권한 창이 열린 동안 생각, 말, 형제 도구가 와도 닫지 않는다. 새 요청과 턴 끝만 닫는다.
  closeStaleAsks(a, ev) {
    const always = ASK_OVER.has(ev.type);
    if (!always && !ASK_OVER_LATER.has(ev.type)) return;
    if (ev.type === 'tool_start' && a.pending.has(ev.toolUseId)) return;
    const t = Date.parse(ev.ts ?? '');
    a.releaseAsks((it) => !liveAskStays(it, ev.type) && (always || t - Date.parse(it.ts ?? '') >= ASK_SIBLING_MS));
  }

  // session 이벤트 -> 직원 생성/갱신. 놓을 층을 모르면(project 없음, 부모도 모름) 메인 세션은 공통 '전역 · 미지정' 층에 둔다.
  upsert(info) {
    const existing = this.agents.get(info.sessionId);
    const parent = info.parentSessionId ? this.agents.get(info.parentSessionId) : null;
    const isSub = 'isSubagent' in info ? !!info.isSubagent : !!existing?.isSub;
    const proj = info.project || (!isSub && !info.parentSessionId && info.agent ? GLOBAL_FLOOR_KEY : '');
    const projLabel = info.project ? info.projectLabel : (proj ? GLOBAL_FLOOR_LABEL : '');
    const floor = parent && parent !== existing ? parent.floor : this.floorFor(proj, projLabel);
    if (existing) {
      existing.cancelLeave();
      const flip = 'isSubagent' in info && !!info.isSubagent !== existing.isSub;
      if ((floor && floor !== existing.floor) || flip) return this.rehome(existing, info, floor || existing.floor);
      existing.rename(info);
      return existing;
    }
    if (!floor) return null;
    const spawn = parent ? { x: parent.group.position.x + 0.6, z: parent.group.position.z + 0.4, jitter: true } : null;
    const a = new Agent(this, { ...info, project: floor.key }, floor, spawn);
    this.agents.set(a.id, a);
    this.dress(a);
    this.hud.renderFloors(this);
    return a;
  }

  // 층(project)이나 서브에이전트 여부가 바뀐 직원: 새로 만들고 할 일, 열린 도구, 기록을 넘긴다.
  // 그 직원을 따라 같은 층에 있던 서브에이전트도 함께 옮긴다.
  rehome(old, info, floor) {
    const from = old.floor;
    const has = (k) => k in info;
    const merged = {
      sessionId: old.id,
      project: floor.key,
      title: info.title || old.name,
      branch: info.branch || old.branch,
      worktree: has('worktree') ? info.worktree : old.worktree,
      isSubagent: has('isSubagent') ? !!info.isSubagent : old.isSub,
      parentSessionId: has('parentSessionId') ? info.parentSessionId : old.parentId,
      agentType: info.agentType || old.agentType,
      agent: info.agent || old.agent,
      surface: info.surface || old.surface || '',
    };
    const carry = old.current && old.current.kind !== 'leave' ? [old.current] : [];
    for (const it of carry) {
      it.arrived = false;
      it.t = 0;
    }
    const spawn = floor === from ? { x: old.group.position.x, z: old.group.position.z } : null;
    old.dispose();
    this.agents.delete(old.id);
    const a = new Agent(this, merged, floor, spawn);
    a.queue = [...carry, ...old.queue];
    a.pending = old.pending;
    a.history = old.history;
    a.childSeq = old.childSeq; // 이미 있는 형제와 색이 겹치지 않게 순번을 이어 간다
    this.agents.set(a.id, a);
    this.dress(a);
    if (this.selected === old) this.select(a);
    if (floor !== from) {
      for (const kid of [...this.agents.values()]) if (kid.parentId === a.id && kid.floor === from) this.rehome(kid, {}, floor);
      this.pruneEmptyFloors();
    }
    this.hud.renderFloors(this);
    return a;
  }

  toolStart(a, ev) {
    const room = ev.room || classify(ev.tool);
    // 재연결 스냅샷이 아직 진행 중인 도구를 다시 보내도 한 번만 처리한다.
    if (room === 'ignore' || a.pending.has(ev.toolUseId)) return null;
    const label = toolLabel(ev.tool);
    const summary = ev.summary || '';
    // awaitsApproval: 사람이 권한 창에 답할 때까지 기다린 호출 (재생 모드만 미리 안다, CONTRACT 7). 내 자리에서 기다린다.
    const approval = !!ev.awaitsApproval && room !== 'desk';
    if (room === 'desk' || approval) {
      const question = approval ? `승인 대기 · ${`${label} ${summary}`.trim()}` : ev.question || ev.summary || '확인이 필요해요';
      const it = {
        kind: 'ask', approval, room: 'desk', prefer: 0, question, options: approval ? ['허용', '거절'] : ev.options || [],
        ids: [ev.toolUseId], open: 1, ts: ev.ts, activity: approval ? '승인 받으러 가는 중' : '질문하러 가는 중',
      };
      a.pending.set(ev.toolUseId, it);
      a.push(it);
      return approval ? question : `질문 · ${question}`;
    }
    const it = { kind: 'tool', room, ids: [ev.toolUseId], open: 1, activity: `${label} ${summary}`.trim() };
    a.pending.set(ev.toolUseId, it);
    rememberText(this.toolTexts, a.id, ev.toolUseId, it.activity);
    a.push(it);
    const where = room === 'here' ? '' : ` -> ${ROOMS[room].label}`;
    return `${label} ${summary}${where}`;
  }

  plan(a, items) {
    const done = items.filter((i) => i.status === 'completed').length;
    const board = a.floor.board;
    if (board.sameContent(a.id, items)) {
      board.set(a.id, a.name, items, a.ink);
      a.bubble('info', `계획 ${done}/${items.length}`, 2);
    } else {
      a.push({ kind: 'plan', room: 'meeting', prefer: 0, items, activity: '화이트보드에 계획 쓰는 중' });
    }
    return `계획 ${done}/${items.length}`;
  }

  writePlan(a, items) { a.floor.board.set(a.id, a.name, items, a.ink); }

  // 서버 스냅샷: 그대로 재생한 뒤, 스냅샷이 말하는 "지금 열린 도구"와 맞춘다.
  // - 스냅샷에 있는 직원: 스냅샷에 없는 열린 도구/질문은 끊긴 사이에 끝난 것이라 닫는다.
  // - 스냅샷에 없는 직원: 열린 것을 모두 닫고 퇴근. 단 서버가 아직 파일을 붙이는 중(partial)이면 그대로 둔다.
  // - 라이브 승인 대기: 도구는 열려 있는데 tool_wait 가 없으면 끊긴 사이에 허용된 것이라 도구 방으로 돌려보낸다.
  applySnapshot(events, meta = {}) {
    const live = new Set();
    const open = new Map();
    for (const e of events) {
      if (e.type === 'session') live.add(e.sessionId);
      else if (e.type === 'tool_start') {
        if (!open.has(e.sessionId)) open.set(e.sessionId, new Set());
        open.get(e.sessionId).add(e.toolUseId);
      }
    }
    const waits = snapshotWaits(events);
    for (const ev of events) this.onEvent({ ...ev, replay: true });
    for (const a of [...this.agents.values()]) {
      if (live.has(a.id)) {
        const ids = open.get(a.id) || new Set();
        reconcileWaits(a, ids, waits.get(a.id) || new Set());
        a.abandonPending(ids);
        forgetTexts(this.toolTexts, a.id, ids);
      } else if (!meta.partial) {
        a.abandonPending();
        forgetTexts(this.toolTexts, a.id);
        a.leave();
      }
    }
  }

  // 탭이 다시 보이면: 숨어 있는 동안 쌓인 일을 건너뛰고 지금 상태로 따라잡는다.
  catchUp() {
    for (const a of this.agents.values()) a.catchUp();
  }

  onAsk() { this.hud.renderFloors(this); }

  onError(a) { this.hud.ping(a.floor, 'error'); }

  removeAgent(a) {
    a.dispose();
    this.agents.delete(a.id);
    if (this.selected === a) this.select(null);
    this.pruneEmptyFloors();
    this.hud.renderFloors(this);
  }

  pruneEmptyFloors() {
    if (this.floors.length <= 1) return;
    let removed = false;
    for (let i = this.floors.length - 1; i >= 0 && this.floors.length > 1; i--) {
      const f = this.floors[i];
      if (f.agents.size > 0) continue;
      this.floors.splice(i, 1);
      this.byKey.delete(f.key);
      this.hud.clearPing(f);
      f.dispose(this.stage);
      if (this.focusIndex > i) this.focusIndex -= 1;
      removed = true;
    }
    if (!removed) return;
    this.floors.forEach((f, idx) => {
      f.index = idx;
      f.renameTag();
    });
    this.focusIndex = clamp(this.focusIndex, 0, Math.max(0, this.floors.length - 1));
    this.layout();
  }

  // ---- 시점 ----
  refreshLabels(globalLabel = GLOBAL_FLOOR_LABEL, theme = null) {
    const gf = this.byKey.get(GLOBAL_FLOOR_KEY);
    if (gf) gf.label = globalLabel;
    const themeChanged = theme && this.theme !== theme;
    if (theme) this.theme = theme;
    for (const f of this.floors) {
      if (themeChanged) f.rebuildTheme?.(theme);
      else f.refreshSigns?.();
    }
    if (themeChanged) {
      for (const a of this.agents.values()) a.refreshTheme?.(theme);
    }
  }

  labelsVisible(floor) { return this.overview || floor.index === this.focusIndex; }

  // 새 직원도 자기 층의 자세히 그리기 수준(라벨, 그림자)을 따른다.
  dress(a) {
    a.setLabelsVisible(this.labelsVisible(a.floor));
    if (!a.floor.shadows) a.floor.setShadows(false, a.group);
  }

  // CSS 라벨을 계산할 묶음: 전체 보기면 장면 전체, 아니면 초점 층만 (detail.js).
  labelRoot() {
    const i = labelRootIndex(this.focusIndex, this.overview, this.floors.length);
    return i < 0 ? this.stage.scene : this.floors[i].group;
  }

  focus(index) {
    if (index === 'all') {
      this.overview = true;
      this.hud.pings.clear();
    } else {
      this.overview = false;
      this.focusIndex = clamp(index, 0, Math.max(0, this.floors.length - 1));
      this.hud.clearPing(this.floors[this.focusIndex]);
    }
    this.follow = false;
    this.layout({ snapPan: true });
    this.hud.renderFloors(this);
  }

  layout(opts = {}) {
    document.body.classList.toggle('overview', this.overview);
    this.stage.setOverview?.(this.overview);
    for (const f of this.floors) {
      f.goalY = f.index * (this.overview ? EXPLODE_GAP : FLOOR_GAP);
      const d = floorDetail(f.index, this.focusIndex, this.overview);
      f.group.visible = d.visible;
      f.group.matrixWorldAutoUpdate = d.visible; // 숨은 층은 행렬 갱신도 건너뛴다
      f.animate = d.animate;
      if (f.shadows !== d.shadows) f.setShadows(d.shadows);
      f.setLabelsVisible(d.labels);
      for (const a of f.agents) a.setLabelsVisible(d.labels);
    }
    const n = this.floors.length;
    const y = this.overview ? ((n - 1) * EXPLODE_GAP) / 2 : this.focusIndex * FLOOR_GAP;
    this.stage.setGoal(new THREE.Vector3(0, y + 0.6, 0), opts);
    this.stage.setLampY(this.overview ? -100 : this.focusIndex * FLOOR_GAP);
    this.stage.resize();
  }

  viewHalf(aspect) {
    const base = Math.max(9.8, 14.5 / aspect);
    if (!this.overview) return base;
    return base + (Math.max(1, this.floors.length) - 1) * EXPLODE_GAP * 0.42;
  }

  select(a, { focusPan = false } = {}) {
    this.selected = a;
    this.follow = !!a && (this.follow || focusPan);
    if (focusPan && a) {
      a.group.getWorldPosition(this.tmp);
      this.tmp.y += 0.6;
      this.stage.setGoal(this.tmp, { snapPan: true });
    }
    this.hud.inspect(a, this);
  }

  hitAgent(ndc) {
    const meshes = [];
    for (const a of this.agents.values()) if (a.floor.group.visible) meshes.push(...a.pickMeshes);
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.agent : null;
  }

  pick(ndc) {
    this.select(this.hitAgent(ndc));
  }

  update(dt, realDt) {
    for (const f of this.floors) {
      f.busy = {};
      for (const a of f.agents) if (a.mode === 'work' && !a.path.length) f.busy[a.room] = true;
      f.update(dt, realDt);
    }
    for (const a of [...this.agents.values()]) a.update(dt);
    if (this.follow && this.selected) {
      this.selected.group.getWorldPosition(this.tmp);
      this.tmp.y += 0.6;
      this.stage.setGoal(this.tmp, { snapPan: true });
    }
    this.stage.update(realDt);
  }
}
