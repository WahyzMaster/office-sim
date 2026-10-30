// 직원 한 명 = 세션 하나(서브에이전트는 작은 직원).
// 이벤트는 바로 실행하지 않고 "할 일(intent)" 대기열에 쌓은 뒤, 방까지 걸어가서 하나씩 처리한다.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { activeThemeOf, ELEVATOR, isLlmVisible, resolveAgentAppearance, tr } from './rooms.js';
import { buildAgentMesh, buildBrandFlair, tintAgent, animateAgentMesh } from './agent-mesh.js';
import { compactQueue, collapse, QUEUE_CAP, softKind } from './agent-queue.js';
import { hueOf, brandHue, familyHue, familyLight, laneOffset, route, wrapAngle, safeSpawnPos, startAgentManeuver, stepAgentPath } from './placement.js';
import { agentBadge } from './hud.js';
import { makeSound } from './sound.js';

export { hueOf };

const WALK = 3.4;
const IDLE_AFTER = 7;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ABANDON = { ok: false, errorKind: 'abandoned' };

const toVec = (pts) => pts.map((p) => new THREE.Vector3(p.x, 0, p.z));

export class Agent {
  constructor(office, info, floor, spawnAt = null) {
    this.office = office;
    this.id = info.sessionId;
    this.floor = floor;
    this.isSub = !!info.isSubagent;
    this.parentId = info.parentSessionId || null;
    this.project = info.project;
    this.branch = info.branch || '';
    this.worktree = info.worktree || null;
    this.agentType = info.agentType || '';
    this.agent = info.agent || ''; // 세션을 만든 에이전트 출처 id ('claude-code', 'codex' ...)
    this.surface = info.surface || '';
    this.charOverride = info.charOverride || 'auto';
    this.postureOverride = info.postureOverride || 'auto';
    this.motionOverride = info.motionOverride || 'auto';
    this.name = info.title || (this.isSub ? this.agentType : tr(`세션 ${this.id.slice(0, 6)}`, `Session ${this.id.slice(0, 6)}`));
    this.childSeq = 0;
    this.paint(this.parentId ? office.agents.get(this.parentId) : null);
    this.queue = [];
    this.current = null;
    this.path = [];
    this.room = 'lounge';
    this.slot = -1;
    this.face = 0;
    this.pending = new Map();
    this.history = [];
    this.mode = 'idle';
    this.activity = tr('출근', 'Arrived');
    this.idleT = this.bubbleT = this.panicT = this.soundT = this.maneuverCd = this.maneuverSeq = this.stallT = 0;
    this.maneuver = null;
    this.vocalText = '';
    this.t = Math.random() * 10;
    // lane 은 층마다 비어 있는 번호를 받아 같은 부모를 둔 형제끼리도 다른 길로 걷는다.
    this.laneIdx = floor.laneIndex();
    this.lane = laneOffset(this.laneIdx);
    buildAgentMesh(this);
    this.buildLabels();
    const p = spawnAt || ELEVATOR;
    const j = spawnAt?.jitter ? this.lane : 0;
    const occ = [...floor.agents].map((o) => o.group.position);
    const sp = safeSpawnPos(p.x + j, p.z + j * 0.5, 0.24, activeThemeOf(), occ);
    this.group.position.set(sp.x, 0, sp.z);
    floor.group.add(this.group);
    floor.agents.add(this);
    if (!spawnAt) floor.openElevator();
    this.goTo('lounge');
  }

  // 서브에이전트는 부모 색 계열 안에서 형제 순번마다 다른 색, 메인은 브랜드 색 계열(같은 층과 겹치면 미세 조정).
  paint(parent) {
    if (parent) {
      const k = parent.childSeq++;
      this.hue = familyHue(parent.hue, k);
      this.light = familyLight(k);
    } else {
      const taken = [...this.floor.agents].filter((a) => a !== this).map((a) => a.hue);
      this.hue = brandHue(this.agent, this.surface, this.id, taken);
      this.light = 0.52;
    }
    this.color = `hsl(${this.hue}, 66%, ${Math.round(this.light * 100)}%)`;
    this.ink = `hsl(${this.hue}, 66%, 32%)`;
  }

  buildLabels() {
    const el = document.createElement('div');
    el.className = 'anchor';
    el.innerHTML = '<div class="stack"><div class="bubble" hidden></div><button class="tag" type="button"><i></i><em class="ab" hidden></em><b></b><span></span></button></div>';
    this.tagEl = el.querySelector('.tag');
    this.bubbleEl = el.querySelector('.bubble');
    this.tagEl.style.setProperty('--c', this.color);
    this.tagEl.classList.toggle('sub', this.isSub);
    for (const b of [this.tagEl, this.bubbleEl]) b.addEventListener('click', () => this.office.select(this));
    this.label = new CSS2DObject(el);
    this.label.position.set(0, 2.08, 0);
    this.group.add(this.label);

    const sw = document.createElement('div');
    sw.className = 'anchor';
    sw.innerHTML = '<div class="sweat" hidden><i></i><i></i><i></i></div>';
    this.sweatEl = sw.firstChild;
    this.sweat = new CSS2DObject(sw);
    this.sweat.position.set(0, 1.55, 0);
    this.group.add(this.sweat);
    this.refreshTag();
  }

  setLabelsVisible(vis) {
    const show = vis && isLlmVisible(this);
    this.group.visible = isLlmVisible(this);
    this.label.visible = show;
    this.sweat.visible = show;
    if (!show) this.label.element.style.display = this.sweat.element.style.display = 'none';
  }

  refreshCharacter() {
    buildBrandFlair(this);
    if (!this.floor.shadows && this.floor.setShadows) this.floor.setShadows(false, this.group);
  }

  rename(info) {
    if (info.title) this.name = info.title;
    if (info.branch) this.branch = info.branch;
    if ('worktree' in info) this.worktree = info.worktree || null;
    if (typeof info.agentType === 'string' && info.agentType) this.agentType = info.agentType;
    const prevBrand = `${this.agent}|${this.surface}`;
    if (typeof info.agent === 'string' && info.agent) this.agent = info.agent;
    if (typeof info.surface === 'string' && info.surface) this.surface = info.surface;
    const parentChanged = 'parentSessionId' in info && (info.parentSessionId || null) !== this.parentId;
    if (parentChanged) this.parentId = info.parentSessionId || null;
    if (parentChanged || `${this.agent}|${this.surface}` !== prevBrand) {
      const parent = this.parentId ? this.office.agents.get(this.parentId) : null;
      this.paint(parent);
      tintAgent(this);
      buildBrandFlair(this);
      this.tagEl.style.setProperty('--c', this.color);
    }
    this.refreshTag();
  }

  refreshTheme() {
    this.refreshCharacter();
    if (this.current?.kind === 'leave') {
      this.walkTo('lounge', ELEVATOR.x, ELEVATOR.z, -Math.PI / 2);
      return;
    }
    if (typeof this.floor?.slotPos !== 'function') return;
    const [tx, tz, face] = this.floor.slotPos(this.room, this.slot, this);
    if (this.path.length) this.walkTo(this.room, tx, tz, face);
    else if (this.group?.position) {
      this.group.position.set(tx, 0, tz);
      this.face = face;
    }
  }

  refreshTag() {
    const ab = this.tagEl.querySelector('.ab');
    const badge = agentBadge(this.agent, this.surface);
    if (ab) {
      ab.textContent = badge;
      ab.hidden = !badge;
    }
    const cue = this.maneuver ? tr(this.maneuver.ko, this.maneuver.en) : (this.soundT > 0 ? this.vocalText : '');
    const act = cue ? `${cue} · ${this.activity}` : this.activity;
    this.tagEl.dataset.agent = this.agent || '';
    this.tagEl.querySelector('b').textContent = this.name;
    this.tagEl.querySelector('span').textContent = act;
    this.tagEl.dataset.mode = this.panicT > 0 ? 'panic' : this.mode;
    this.tagEl.setAttribute('aria-label', `${badge ? `[${badge}] ` : ''}${this.name}: ${act}`);
  }

  makeSound(trigger = 'click', opts = {}) {
    const res = makeSound(this, trigger, opts);
    if (res) this.refreshTag();
    return res;
  }

  pet(kind = '') {
    const trig = startAgentManeuver(this, 1, kind, true);
    const res = this.makeSound('pet', { force: true }) || this.makeSound(trig, { force: true });
    const text = res?.text || (this.maneuver ? tr(this.maneuver.ko, this.maneuver.en) : '');
    if (text) this.bubble('say', text, 2.2);
    this.refreshTag();
    return res;
  }

  note(text, kind = '') {
    this.history.unshift({ at: new Date(), text, kind });
    if (this.history.length > 12) this.history.length = 12;
  }

  // ---- 대기열 ----
  push(intent) {
    this.queue.push(intent);
    this.idleT = 0;
    this.compact();
  }

  compact() { this.queue = compactQueue(this.queue, this.pending); }

  // 탭을 다시 볼 때: 밀린 일을 지금 상태(질문, 열린 도구, 계획, 퇴근 + 마지막 일)로 줄인다.
  catchUp() { this.queue = collapse(this.queue, this.pending, 1); }

  leave() {
    if (this.current?.kind === 'leave' || this.queue.some((i) => i.kind === 'leave')) return;
    this.push({ kind: 'leave', room: 'lounge', activity: tr('퇴근', 'Leaving') });
  }

  // 퇴근하려던 직원에게 다시 session 이 오면(서버가 되살림, 재시작 뒤 재공지) 퇴근을 취소한다.
  cancelLeave() {
    const walking = this.current?.kind === 'leave';
    if (!walking && !this.queue.some((i) => i.kind === 'leave')) return false;
    this.queue = this.queue.filter((i) => i.kind !== 'leave' && i.kind !== 'idle');
    if (walking) {
      // walkTo('lounge') 는 예전 slot 번호를 남겨 둔다. -1 로 비워야 다음 일이 진짜 자리로 걸어간다.
      this.current = null;
      this.path = [];
      this.floor.release(this.room, this);
      this.slot = -1;
      this.mode = 'idle';
      this.activity = tr('대기 중', 'Idle');
      if (!this.queue.length) this.queue.push({ kind: 'idle', room: 'lounge', activity: tr('대기 중', 'Idle') });
    }
    this.refreshTag();
    return true;
  }

  // keep 에 없는 열린 도구/질문을 모두 끝난 것으로 처리한다(session_end, 스냅샷 대조).
  abandonPending(keep = null) {
    for (const id of [...this.pending.keys()]) {
      if (!keep || !keep.has(id)) this.toolEnd({ toolUseId: id, ...ABANDON });
    }
  }

  // 답(tool_end)을 못 받은 채 열려 있는 질문 중 pred 에 맞는 것을 닫는다. 닫은 개수를 돌려준다.
  releaseAsks(pred) {
    let n = 0;
    for (const [id, it] of [...this.pending]) {
      if (it.kind !== 'ask' || !pred(it)) continue;
      this.toolEnd({ toolUseId: id, ...ABANDON });
      n += 1;
    }
    if (n) this.note(tr('질문 닫힘 · 다음 일 시작', 'Question closed · continuing'), 'muted');
    return n;
  }

  start(it) {
    this.current = it;
    it.t = 0;
    it.arrived = false;
    if (it.activity) this.activity = it.activity;
    this.refreshTag();
    const room = it.room;
    if (!room || room === 'here' || (it.kind !== 'leave' && room === this.room && this.slot !== -1 && !(it.prefer >= 0 && it.prefer !== this.slot))) {
      it.arrived = true;
      this.onArrive(it);
    } else if (it.kind === 'leave') this.walkTo('lounge', ELEVATOR.x, ELEVATOR.z, -Math.PI / 2);
    else this.goTo(room, it.prefer ?? -1);
  }

  goTo(room, prefer = -1) {
    this.floor.release(this.room, this);
    const slot = this.floor.claim(room, this, prefer);
    const [tx, tz, face] = this.floor.slotPos(room, slot, this);
    this.slot = slot;
    this.walkTo(room, tx, tz, face);
  }

  walkTo(room, tx, tz, face) {
    if (room !== this.room) this.floor.release(this.room, this);
    this.room = room;
    this.face = face;
    this.path = toVec(route(this.group.position, room, tx, tz, this.lane));
  }

  arrived() {
    const it = this.current;
    if (it && !it.arrived) {
      it.arrived = true;
      this.onArrive(it);
    } else if (!it) {
      this.mode = 'idle';
    }
  }

  onArrive(it) {
    switch (it.kind) {
      case 'tool':
        this.mode = 'work';
        if (it.error) this.panic(it.error, it.errorKind);
        else if (resolveAgentAppearance(this).family === 'cats') this.makeSound('work');
        break;
      case 'think':
        this.mode = 'think';
        this.bubble('think', it.text || tr('생각 중…', 'Thinking…'), it.ttl);
        break;
      case 'say':
        this.mode = 'idle';
        this.bubble('say', it.text, 4.5);
        break;
      case 'plan':
        this.mode = 'write';
        break;
      case 'ask':
        if (it.closed) {
          this.mode = 'idle';
          break;
        }
        if (it.live && it.answered) { // 라이브 승인 대기: 걸어오는 사이에 답이 왔다. 열린 질문(칩) 대신 결과만 보인다
          this.mode = 'idle';
          if (!it.denied && !it.error) this.bubble('info', tr('승인됨', 'Approved'), 1.8);
          break;
        }
        this.mode = 'ask';
        this.bubble('ask', it, Infinity);
        this.makeSound('ask');
        this.office.onAsk(this, true);
        break;
      case 'error':
        this.panic(it.text, it.errorKind);
        break;
      case 'note':
        this.bubble('info', it.text, 3);
        break;
      case 'leave':
        this.floor.openElevator?.();
        this.office.removeAgent(this);
        return;
      default:
        this.mode = 'idle';
        this.activity = tr('대기 중', 'Idle');
    }
    this.refreshTag();
  }

  isDone(it) {
    const more = this.queue.length > 0;
    switch (it.kind) {
      case 'tool': return it.t >= (more ? 0.7 : 1.1) && (it.open <= 0 || more);
      case 'think': return it.t >= (more ? 0.6 : Math.min(it.ttl, 2.2));
      case 'say': return it.t >= 0.8;
      case 'plan':
        if (!it.written && it.t >= 1.3) {
          it.written = true;
          this.office.writePlan(this, it.items);
        }
        return it.t >= 2.0;
      case 'ask': return it.answered && it.t >= (it.closed ? 0.3 : 1.2);
      case 'error': return it.t >= 1.6;
      default: return true;
    }
  }

  // 라이브 승인 대기가 허용됐다(approval.js waitEnd): 자리에 있으면 지금부터 1.2 s 승인됨을 보인 뒤 도구 방으로 간다.
  // 아직 걸어오는 중이면 도착할 때 보인다(onArrive).
  showAllowed(it) {
    it.t = 0;
    if (it !== this.current || !it.arrived) return;
    this.mode = 'idle';
    this.bubble('info', tr('승인됨', 'Approved'), 1.8);
    this.office.onAsk(this, false);
    this.refreshTag();
  }

  finish(it) {
    if (it.kind === 'ask') {
      if (it.error) this.panic(it.error, 'failed'); // 승인된 뒤 실행이 실패했다
      else this.bubble(it.denied ? 'denied' : 'info', it.denied ? tr('거절됨', 'Denied') : it.closed ? tr('질문 닫힘', 'Closed') : it.approval ? tr('승인됨', 'Approved') : tr('답변 받음', 'Answered'), 1.8);
      this.office.onAsk(this, false);
    }
    if (this.mode !== 'idle') this.mode = 'idle';
    this.current = null;
    this.refreshTag();
  }

  // ---- 이벤트 반응 ----
  toolEnd(ev) {
    const it = this.pending.get(ev.toolUseId);
    if (!it) return;
    this.pending.delete(ev.toolUseId);
    it.open -= 1;
    if (it.kind === 'ask') {
      it.answered = true;
      it.closed = ev.errorKind === 'abandoned';
      it.denied = !ev.ok && !it.closed && !(it.approval && ev.errorKind === 'failed');
      if (it.approval && ev.errorKind === 'failed') it.error = ev.error || tr('도구 실행 실패', 'Tool failed');
      // 아직 줄에 서 있는 닫힌 질문은 보여 줄 필요가 없다.
      const q = it.closed ? this.queue.indexOf(it) : -1;
      if (q >= 0) this.queue.splice(q, 1);
      return;
    }
    if (ev.ok || ev.errorKind === 'abandoned') { if (ev.ok) this.joyBurstT = (this.t || 0) + 0.42; return; }
    const err = ev.error || (ev.errorKind === 'interrupted' ? tr('사용자가 중단함', 'Interrupted by user') : tr('도구 실행 실패', 'Tool failed'));
    if (!it.error || (softKind(it.errorKind) && !softKind(ev.errorKind))) {
      it.error = err;
      it.errorKind = ev.errorKind;
    }
    const queued = this.queue.includes(it);
    const walking = it === this.current && !it.arrived;
    if (!queued && !walking) this.panic(err, ev.errorKind);
  }

  panic(text, kind) {
    if (kind === 'denied' || kind === 'interrupted') {
      this.bubble('denied', `${kind === 'denied' ? tr('거절됨', 'Denied') : tr('중단됨', 'Interrupted')} · ${text}`, 3.6);
      return;
    }
    this.panicT = 2.8;
    this.bubble('error', text, 4.6);
    this.makeSound('error');
    this.sweatEl.hidden = false;
    this.office.onError(this, text);
    this.refreshTag();
  }

  bubble(kind, payload, ttl) {
    const b = this.bubbleEl;
    b.className = `bubble ${kind}`;
    b.replaceChildren();
    if (kind === 'ask') {
      const q = document.createElement('p');
      q.textContent = payload.question;
      b.append(q);
      if (payload.options?.length) {
        const row = document.createElement('div');
        row.className = 'opts';
        for (const o of payload.options) {
          const chip = document.createElement('span');
          chip.textContent = o;
          row.append(chip);
        }
        b.append(row);
      }
    } else {
      b.textContent = payload;
    }
    b.hidden = false;
    this.bubbleT = ttl;
  }

  // ---- 매 프레임 ----
  update(dt) {
    this.t += dt;
    // 밀린 일이 많을수록 빨리 걷는다(상한 QUEUE_CAP 까지). 그래야 화면이 실시간을 따라잡는다.
    const speed = WALK * (1 + Math.min(this.queue.length, QUEUE_CAP) * 0.35) * (REDUCED ? 3 : 1);
    const hadManeuver = !!this.maneuver;
    const nav = stepAgentPath(this, dt, speed, activeThemeOf());
    if (nav.moving) {
      const pos = this.group.position; // 퇴근 길에 엘리베이터 가까이 오면 문을 연다
      if (this.current?.kind === 'leave' && Math.hypot(pos.x - ELEVATOR.x, pos.z - ELEVATOR.z) < 2.5) this.floor.openElevator?.();
      if (nav.soundTrigger && !this.makeSound(nav.soundTrigger)) this.refreshTag();
      else if (hadManeuver && !this.maneuver) this.refreshTag();
      if (nav.heading !== null) this.turnTo(nav.heading, dt);
      if (nav.arrived) this.arrived();
    } else {
      if (hadManeuver && !this.maneuver) this.refreshTag();
      this.turnTo(this.face, dt);
    }

    const it = this.current;
    if (it && it.arrived) {
      it.t += dt;
      if (this.isDone(it)) this.finish(it);
    } else if (!it && !this.path.length) {
      if (this.queue.length) this.start(this.queue.shift());
      else {
        this.idleT += dt;
        if (this.idleT > IDLE_AFTER && this.room !== 'lounge') this.push({ kind: 'idle', room: 'lounge', activity: tr('대기 중', 'Idle') });
      }
    }

    if (this.bubbleT !== Infinity && this.bubbleT > 0 && (this.bubbleT -= dt) <= 0) this.bubbleEl.hidden = true;
    if (this.panicT > 0 && (this.panicT -= dt) <= 0) {
      this.sweatEl.hidden = true;
      this.refreshTag();
    }
    if (this.soundT > 0 && (this.soundT -= dt) <= 0) {
      this.vocalText = '';
      this.refreshTag();
    }
    if (this.floor.animate) this.animate(); // 숨은 층(detail.js)은 몸짓을 건너뛴다
  }

  turnTo(angle, dt) {
    this.group.rotation.y += wrapAngle(angle - this.group.rotation.y) * Math.min(1, dt * 10);
  }

  animate() { animateAgentMesh(this, REDUCED); }

  dispose() {
    this.floor.release(this.room, this);
    this.floor.agents.delete(this);
    this.label.element.remove();
    this.sweat.element.remove();
    this.floor.group.remove(this.group);
  }
}
