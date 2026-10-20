// 파일 탐색/꼬리 읽기 루프 (contract 6): poll / rescan / idle. 셋은 서로 겹치지 않는다.
// 이전 tick 이 돌고 있으면 이번 tick 은 건너뛴다. 상태는 Store 와 SessionState 에 있고 여기서는 옮기기만 한다.
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { SidecarWatcher } from './core/sidecar.mjs';

function errText(err) {
  return err?.message ?? String(err);
}

// 로그에는 경로가 든 전체 메시지 대신 오류 코드만 (EACCES, EIO ...). 코드가 없으면 메시지.
function errCode(err) {
  return typeof err?.code === 'string' ? err.code : errText(err);
}

const MAX_POLL_BACKOFF_MS = 30_000; // 계속 실패하는 파일도 이 간격으로는 다시 읽어 본다

// 세션 객체가 apply()/idle() 결과에 섞어 낸 내부 힌트 (4.0.1): { hint: 'end', charId }. 이벤트가 아니다.
const isHint = (ev) => !!ev && typeof ev === 'object' && ev.hint !== undefined;

export class Runner {
  constructor({ opts, deps, store, log }) {
    this.opts = opts;
    this.deps = deps;
    this.store = store;
    this.log = log;
    this.tailer = new deps.Tailer();
    this.files = new Map(); // path -> { ref, state, charId, kind, ready, needsAttach, pollErrors, retryAt, lastErr }
    this.attachErrors = new Map(); // path -> 마지막 attach 오류 코드 (같은 오류는 한 번만 로그)
    this.replayUntil = new Map(); // path -> 잘림/교체를 본 순간의 크기: 다시 붙일 때 그 뒤의 줄은 라이브로 낸다
    this.pollBase = Date.now(); // 지난 poll 이 끝난 시각: 다음 poll 은 이 시각 + 간격
    this.running = { poll: false, rescan: false, idle: false };
    this.inflight = new Set();
    this.timers = {};
    this.closed = false;
    this.badLines = 0;
    this.applyErrors = 0;
    this.scanErr = null; // 마지막 scan 실패 코드 (같은 오류는 한 번만 로그)
    // ADAPTERS 3.3 메타 파일과 D1 도구 전용 워크트리 층: 어댑터의 deps 에 훅이 있을 때만 (Claude 는 없다). sidecarWatcher 는
    // check(ref)/forget(path) 를 가진 감시자 그대로 (Codex: 커지는 색인 파일을 이어 읽는다), sidecars 는 파일 목록 훅
    const w = deps.sidecarWatcher;
    if (typeof w?.check === 'function' && typeof w.forget === 'function') this.sidecars = w;
    else this.sidecars = typeof deps.sidecars === 'function' ? new SidecarWatcher(deps.sidecars) : null;
    this.floorRule = typeof deps.worktreeFloor === 'function' && typeof deps.agent === 'string';
    if (this.floorRule) store.setFloorRule?.(deps.agent, (project) => deps.worktreeFloor(project, opts.root));
    this.gate = null; // D1: RunnerGroup 이 거는 약속. 첫 탐색은 다른 어댑터의 첫 붙이기가 끝난 뒤에 층을 고른다
  }

  // 겹침 방지 + close 가 기다릴 수 있게 진행 중인 tick 을 기록한다.
  tick(name, fn) {
    if (this.closed || this.running[name]) return Promise.resolve(false);
    this.running[name] = true;
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        this.log(`${name} loop failed: ${errText(err)}`);
      } finally {
        this.running[name] = false;
      }
      return true;
    })();
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }

  startLoops() {
    const every = (name, ms, fn) => {
      this.timers[name] = setInterval(() => this.tick(name, fn), ms);
      this.timers[name].unref?.();
    };
    every('rescan', this.opts.rescanMs, () => this.rescanOnce());
    every('idle', this.opts.idleMs, () => this.idleAll());
    this.pollBase = Date.now();
    this.schedulePoll(this.opts.intervalMs);
  }

  // poll 은 setTimeout 사슬이다: 다음 poll 은 지난 poll 이 끝난 시각 + 그때의 간격. 간격 변경은 기다리는 poll 을
  // 앞당기기만 하고 절대 뒤로 미루지 않으므로, POST /config 가 잇달아 와도 (같은 값, 늘어나는 값 모두) poll 이 굶지 않는다.
  schedulePoll(delay) {
    clearTimeout(this.timers.poll);
    this.timers.poll = null;
    if (this.closed) return;
    const wait = Math.max(0, delay);
    this.pollDue = Date.now() + wait;
    this.timers.poll = setTimeout(() => {
      this.timers.poll = null;
      this.tick('poll', () => this.pollAll()).finally(() => {
        this.pollBase = Date.now();
        this.schedulePoll(this.opts.intervalMs);
      });
    }, wait);
    this.timers.poll.unref?.();
  }

  setInterval(ms) {
    if (ms === this.opts.intervalMs) return; // 같은 값: 아무것도 다시 잡지 않는다
    this.opts.intervalMs = ms;
    // 짧아졌으면 기다리는 poll 을 지난 poll + 새 간격으로 앞당긴다. 길어졌으면 그대로 두고, 그 poll 뒤부터 새 간격을 쓴다.
    const due = this.pollBase + ms;
    if (this.timers.poll && !this.closed && due < this.pollDue) this.schedulePoll(due - Date.now());
  }

  rescan() { return this.tick('rescan', () => this.rescanOnce()); }

  onLine(f, line, replay) {
    if (!line || !line.trim()) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      this.badLines += 1; // R6: 세고 넘어간다
      return;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
    let evs = null;
    try {
      evs = f.state.apply(rec, { replay });
    } catch (err) {
      if (this.applyErrors++ < 20) this.log(`apply failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
    }
    this.deliver(f, evs, !replay);
    try {
      this.store.observe(f.ref.path, rec);
      // R36: 서브의 TaskCreate/TaskUpdate 는 메인과 같은 작업 목록이다 (replay 에서도 상태로 넘긴다)
      const deltas = f.kind === 'main' ? null : f.state.takeTaskDeltas?.();
      if (deltas?.length) this.store.taskDeltas(f.ref.path, deltas);
    } catch (err) {
      this.log(`link failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
    }
  }

  // 세션 객체가 낸 배열을 나눈다: 이벤트는 (live 일 때) Store 로, 힌트는 빼서 Store 의 공통 끝 규칙으로 (4.0.1).
  // 힌트는 replay 중에도 넘긴다 (다른 직원에 대한 사실이라 observe 와 같다). 힌트가 없으면 예전과 똑같이 ingest 한다.
  deliver(f, evs, live) {
    if (!Array.isArray(evs) || !evs.length) return;
    if (!evs.some(isHint)) {
      if (live) this.store.ingest(f.ref.path, evs);
      return;
    }
    let batch = [];
    for (const ev of evs) {
      if (!isHint(ev)) {
        batch.push(ev);
        continue;
      }
      if (live && batch.length) this.store.ingest(f.ref.path, batch); // 배열 순서를 지킨다: 앞선 이벤트 먼저
      batch = [];
      if (ev.hint === 'end') this.store.endCharacter(ev.charId, ev.reason, this.deps.agent); // F3: 이 어댑터의 직원만
    }
    if (live && batch.length) this.store.ingest(f.ref.path, batch);
  }

  // FileRef.agent (4.0.1): 탐색이 채우지 않았으면 이 Runner 의 어댑터 id 를 적는다.
  stamp(ref) {
    if (ref && (typeof ref.agent !== 'string' || ref.agent === '') && typeof this.deps.agent === 'string') ref.agent = this.deps.agent;
    return ref;
  }

  // G3: deps.agent 가 있는 Runner 는 모든 ref 에 그 id 를 적고, 다른 어댑터 id 를 단 ref 는 그 어댑터로 해석하지 않고
  // 거절한다 (Store 의 거절 경로: 경로마다 한 줄, 경로 없이, 로그 앞머리는 이 Runner 의 id). deps.agent 가 없으면 예전 그대로.
  admit(ref) {
    this.stamp(ref);
    const own = this.deps.agent;
    if (typeof own !== 'string' || own === '' || ref?.agent === own) return true;
    return this.store.rejectRef(ref, own, 'foreign agent');
  }

  async rescanOnce() {
    if (this.gate) {
      await this.gate;
      this.gate = null;
    }
    if (this.closed) return;
    const { scan } = this.deps;
    const nowMs = Date.now();
    let refs;
    try {
      refs = await scan(this.opts.root, { activeMs: this.opts.activeMinutes * 60_000, nowMs });
    } catch (err) {
      // 부분 목록으로 분리(detach)하지 않도록 이번 tick 은 통째로 건너뛴다. 로그는 poll 처럼 코드만, 코드가 바뀔 때만
      // (루트 경로가 든 메시지를 rescan 마다 남기지 않는다).
      const code = errCode(err);
      if (code !== this.scanErr) this.log(`scan failed: ${code}`);
      this.scanErr = code;
      return;
    }
    if (this.scanErr) {
      this.log('scan recovered');
      this.scanErr = null;
    }
    if (this.closed) return;
    refs = refs.filter((ref) => this.admit(ref)); // G3: 다른 어댑터를 내세운 ref 는 신원도 해석하지 않는다
    const incoming = new Map();
    const pathByChar = new Map(); // 같은 캐릭터가 두 경로에 있으면 처음 것만
    for (const ref of refs) {
      incoming.set(ref.path, ref);
      const { charId } = this.store.identity(ref);
      if (!pathByChar.has(charId)) pathByChar.set(charId, ref.path);
    }
    for (const m of [this.attachErrors, this.replayUntil]) for (const p of [...m.keys()]) if (!incoming.has(p)) m.delete(p);
    const deferred = new Set(); // 이번 tick 에는 옮기지 못한 캐릭터 (읽는 중): 옛 경로를 그대로 두고 다음 rescan 에 다시
    for (const [p, f] of [...this.files]) {
      if (incoming.has(p)) continue;
      const to = pathByChar.get(f.charId); // relocated: 같은 inode 면 그대로 옮기고, 아니면 새 경로에서 다시 붙인다
      const carried = to ? this.carryOver(f, p, incoming.get(to)) : false;
      if (carried === 'defer') deferred.add(f.charId);
      else if (!carried) this.detach(p, to ? null : 'idle');
    }
    // 같은 세션(sid)의 새 파일은 모두 replay 한 뒤에 알린다: 중첩 서브의 부모 파일이 경로 순서로 뒤에 있어도
    // 부모 쪽 사실(tool_use 주인, 완료 꼬리표)이 먼저 색인되어, 끝난 자식을 알렸다가 바로 끝내지 않는다.
    const groups = new Map();
    for (const ref of refs) {
      const f = this.files.get(ref.path);
      if (f && !f.needsAttach) continue;
      const id = this.store.identity(ref);
      if (pathByChar.get(id.charId) !== ref.path || deferred.has(id.charId)) continue;
      if (!groups.has(id.sid)) groups.set(id.sid, []);
      groups.get(id.sid).push(ref); // scan 순서(main, sub, wf)를 유지한다
    }
    for (const group of groups.values()) {
      const prepared = [];
      for (const ref of group) {
        if (this.closed) return;
        let f = null;
        try {
          f = await this.prepare(ref);
        } catch (err) {
          this.attachFailed(ref, err); // 한 파일의 실패가 이번 rescan 의 나머지(다른 파일, retryMeta)를 막지 않는다
        }
        if (f) prepared.push(f);
        await yieldToLoop();
      }
      for (const f of this.publishOrder(prepared)) this.publish(f);
    }
    await this.retryMeta();
    if (this.sidecars) for (const f of [...this.files.values()]) if (f.ready && !f.needsAttach) await this.syncSidecars(f, true);
  }

  // 3.3 메타 파일 (어댑터의 sidecars 훅): 바뀐 것만 다시 읽어 setInfo 로 넘기고, live 면 바뀐 session 이벤트를 낸다.
  // Store 에서 이미 끝난 직원은 상태만 바꾼다: 메타 파일이 다시 쓰였다고 끝난 서브를 되살리지 않는다.
  async syncSidecars(f, live) {
    if (!this.sidecars || this.closed || typeof f.state?.setInfo !== 'function') return;
    const info = await this.sidecars.check(f.ref);
    if (!info || this.closed || this.files.get(f.ref.path) !== f) return;
    let evs = null;
    try {
      evs = f.state.setInfo(info);
    } catch (err) {
      if (this.applyErrors++ < 20) this.log(`setInfo failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
    }
    this.deliver(f, evs, live && !this.store.entry(f.ref.path)?.ended);
  }

  // main 먼저, 그다음 부모가 이미 나온 서브부터 (snapshot() 과 같은 순서), wf 는 마지막.
  publishOrder(list) {
    const rank = { main: 0, sub: 1, wf: 2 };
    const rest = [...list].sort((a, b) => rank[a.kind] - rank[b.kind]);
    const waiting = new Set(rest.map((f) => f.charId));
    const out = [];
    while (rest.length) {
      let i = rest.findIndex((f) => {
        const parent = f.kind === 'sub' ? this.store.entry(f.ref.path)?.parent : null;
        return !parent || parent === f.charId || !waiting.has(parent);
      });
      if (i < 0) i = 0; // 순환이면 그대로
      const [f] = rest.splice(i, 1);
      waiting.delete(f.charId);
      out.push(f);
    }
    return out;
  }

  // 같은 inode 로 옮겨 간 파일은 상태를 그대로 새 경로로 옮긴다: 옮기는 동안 쓰인 줄도 다음 poll 이 라이브로 읽고,
  // 다시 replay 하거나 열린 페이지에 다시 알리지 않는다. 다른 inode(복사, 다른 장치)면 false: 처음부터 다시 붙인다.
  carryOver(f, from, ref) {
    if (!ref || !f.ready || f.needsAttach || this.files.has(ref.path)) return false;
    const e = this.store.entry(from);
    const id = this.store.identity(ref);
    if (!e || id.kind !== f.kind || id.sid !== e.sid) return false;
    if (this.tailer.isBusy?.(from)) return 'defer';
    if (typeof this.tailer.rename !== 'function' || !this.tailer.rename(from, ref.path, { ino: ref.ino, size: ref.size })) return false;
    if (!this.store.rekey(from, ref)) {
      this.tailer.forget(ref.path);
      return false;
    }
    this.files.delete(from);
    this.sidecars?.forget(from);
    f.ref = ref;
    if (f.state && 'file' in f.state) f.state.file = ref.path;
    this.files.set(ref.path, f);
    this.attachErrors.delete(from);
    return true;
  }

  // meta 는 jsonl 보다 늦게 생길 수 있고, wf 의 journal label 도 늦을 수 있다 (4.5). 읽는 함수는 Claude 어댑터의
  // deps 에만 있고, Store 의 pendingMeta/pendingLabels 도 Claude 파일만 돌려준다.
  async retryMeta() {
    const { readSubMeta, readJournalLabels } = this.deps;
    for (const p of typeof readSubMeta === 'function' ? this.store.pendingMeta() : []) {
      if (this.closed) return;
      const meta = await readSubMeta(p).catch(() => null);
      if (meta) this.store.setMeta(p, meta);
    }
    const byRun = new Map();
    for (const item of typeof readJournalLabels === 'function' ? this.store.pendingLabels() : []) {
      if (!item.runDir) continue;
      if (!byRun.has(item.runDir)) byRun.set(item.runDir, []);
      byRun.get(item.runDir).push(item);
    }
    for (const [runDir, items] of byRun) {
      if (this.closed) return;
      const labels = await readJournalLabels(runDir).catch(() => null);
      for (const item of items) {
        const label = labels?.get?.(item.charId);
        if (label) this.store.setLabel(item.path, label);
      }
    }
    this.store.relinkAll();
  }

  // attach 1단계: 등록 + replay. 알리는 것(publish)은 같은 세션의 다른 새 파일 replay 가 끝난 뒤에 한다.
  // f.ready 는 publish 전까지 false: poll/idle 루프가 반쯤 만든 상태를 먼저 알리지 않게 한다.
  async prepare(ref) {
    const { SessionState, readSubMeta, readJournalLabels } = this.deps;
    // G3 다른 어댑터를 내세운 ref, D2 (F2/G2) id 규칙을 어긴 ref: 세션 객체도 만들지 않는다. 로그와 카운터는 Store 가
    if (!this.admit(ref) || !this.store.acceptsRef(ref)) return null;
    const id = this.store.identity(ref);
    this.tailer.forget(ref.path);
    this.sidecars?.forget(ref.path); // 새 세션 객체: 메타 파일도 처음부터 다시 읽는다 (잘림 뒤 다시 붙일 때도)
    let meta = null;
    let label = null;
    // 서브 meta.json 과 workflow journal label 은 Claude 어댑터만 읽는다 (deps 에 읽는 함수가 있을 때만)
    if (id.kind !== 'main' && typeof readSubMeta === 'function') meta = await readSubMeta(ref.path).catch(() => null);
    if (id.kind === 'wf' && id.runDir && !meta?.name && !meta?.description && typeof readJournalLabels === 'function') {
      label = (await readJournalLabels(id.runDir).catch(() => null))?.get?.(id.charId) ?? null;
    }
    if (this.closed) return null;
    let state;
    try {
      state = new SessionState({
        id: id.charId, file: ref.path, kind: id.kind, stem: ref.stem ?? id.sid,
        parentId: this.store.parentFor(ref, meta), agentType: meta?.agentType ?? null,
        subMeta: meta, journalLabel: label, agent: ref.agent, facts: ref.facts ?? null, // facts: 탐색 때 정한 사실 (Codex)
      });
    } catch (err) {
      this.log(`session init failed for ${path.basename(ref.path)}: ${errText(err)}`);
      return null;
    }
    const f = { ref, state, charId: id.charId, kind: id.kind, ready: false, needsAttach: false, pollErrors: 0, retryAt: 0, lastErr: null };
    this.files.set(ref.path, f);
    let res;
    try {
      if (!this.store.attachFile(ref, state, { meta, label })) { // 거절: 등록 없이 읽으면 이벤트가 주인 없이 나간다
        this.files.delete(ref.path);
        return null;
      }
      // R7: 파일 전체를 replay 모드로 한 번 읽어 상태와 seen-uuid 를 만든다. 잘린 뒤 다시 붙이는 파일은 잘림을 본 순간의
      // 크기까지만 replay 하고, 그 뒤에 덧붙은 줄은 다음 poll 이 라이브로 낸다.
      const end = this.replayUntil.get(ref.path);
      res = await this.tailer.readAll(ref, (line) => this.onLine(f, line, true), end === undefined ? undefined : { end });
    } catch (err) {
      this.attachFailed(ref, err, f); // 되돌린다: files 에서 빠지므로 다음 rescan 이 다시 붙인다 (좀비 방지)
      return null;
    }
    if (this.closed || this.files.get(ref.path) !== f) return null;
    if (res?.gone || res?.forgotten) {
      this.files.delete(ref.path);
      this.store.detachFile(ref.path);
      return null;
    }
    this.attachErrors.delete(ref.path);
    this.replayUntil.delete(ref.path);
    await this.syncSidecars(f, false); // 첫 읽기는 알리기 전에: 첫 session 이벤트에 제목과 cwd 가 있게 (3.3)
    if (this.closed || this.files.get(ref.path) !== f) return null;
    return f;
  }

  // 반쯤 붙은 파일을 되돌린다. 같은 오류는 경로마다 한 번만 로그한다 (읽을 수 없는 파일이 rescan 마다 로그를 채우지 않게).
  attachFailed(ref, err, f = this.files.get(ref.path)) {
    const code = errCode(err);
    if (this.attachErrors.get(ref.path) !== code) this.log(`attach failed for ${path.basename(ref.path)}: ${code}`);
    this.attachErrors.set(ref.path, code);
    if (f && !f.ready && this.files.get(ref.path) === f) this.files.delete(ref.path);
    this.tailer.forget(ref.path);
    this.sidecars?.forget(ref.path);
    try {
      this.store.detachFile(ref.path);
    } catch (e) {
      this.log(`detach failed for ${path.basename(ref.path)}: ${errText(e)}`);
    }
  }

  // attach 2단계: 오래된 파일은 replay 상태에 시간 규칙(R25/R29/R30)을 먼저 적용한다. 그 이벤트는 버린다
  // (아직 알리지 않은 파일이라 상태만 맞추면 된다). 이미 끝난 에이전트는 announce 가 알리지 않는다.
  publish(f) {
    if (this.closed || this.files.get(f.ref.path) !== f) return;
    try {
      this.deliver(f, f.state.idle(Date.now()), false); // 이 파일의 이벤트는 버리고, 다른 직원에 대한 힌트만 넘긴다
    } catch (err) {
      if (this.applyErrors++ < 20) this.log(`idle failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
    }
    f.ready = true;
    try {
      this.store.announce(f.ref.path); // 열린 페이지에 새 직원: session + snapshotEvents
    } catch (err) {
      this.log(`announce failed for ${path.basename(f.ref.path)}: ${errText(err)}`);
      f.ready = false;
      f.needsAttach = true; // 다음 rescan 이 처음부터 다시 붙여 알린다
    }
  }

  detach(p, reason) {
    const f = this.files.get(p);
    if (!f) return;
    this.files.delete(p);
    this.tailer.forget(p);
    this.sidecars?.forget(p);
    if (reason && this.store.has(p)) {
      this.store.ingest(p, [{ type: 'session_end', sessionId: f.charId, ts: new Date().toISOString(), reason }]);
    }
    this.store.detachFile(p, { moved: reason === null }); // 이동: 다시 붙을 때 열린 페이지에 끝을 알릴 수 있게
  }

  async pollAll() {
    // 서브를 먼저 읽는다: 서브의 마지막 줄이 같은 tick 의 부모 완료 알림보다 앞서도록
    const now = Date.now();
    const list = [...this.files.values()]
      .filter((f) => f.ready && !f.needsAttach && !(f.retryAt > now)) // 실패한 파일은 물러난 시각까지 건너뛴다
      .sort((a, b) => (a.kind === 'main') - (b.kind === 'main'));
    let resets = 0;
    for (const f of list) {
      if (this.closed) return;
      if (this.files.get(f.ref.path) !== f) continue;
      let res;
      try {
        res = await this.tailer.poll(f.ref, (line) => this.onLine(f, line, false));
      } catch (err) {
        this.pollFailed(f, err);
        continue;
      }
      if (f.pollErrors) {
        this.log(`poll recovered for ${path.basename(f.ref.path)}`);
        f.pollErrors = 0;
        f.retryAt = 0;
        f.lastErr = null;
      }
      if (res?.reset) {
        // 잘리거나 바뀐 파일: 처음부터 다시 붙인다. 지금 크기까지만 replay 하므로 그 뒤에 덧붙는 줄은 라이브로 나간다.
        f.needsAttach = true;
        this.tailer.forget(f.ref.path);
        if (Number.isFinite(res.size)) this.replayUntil.set(f.ref.path, res.size);
        resets += 1;
      }
      // gone: 다음 rescan 이 이동인지 사라짐인지 판단한다
    }
    if (resets && !this.closed) void this.rescan(); // rescanMs 를 기다리지 않고 바로 다시 붙인다 (돌고 있으면 건너뛴다)
  }

  // EACCES/EIO 처럼 계속 실패하는 파일: 상태가 바뀔 때만 로그하고, 간격을 두 배씩 늘려 (상한 30 s) 다시 읽어 본다.
  // needsAttach 로 보내지 않는다: tailer 상태는 그대로라 읽을 수 있게 되면 이어서 읽는다.
  pollFailed(f, err) {
    const code = errCode(err);
    if (!f.pollErrors || code !== f.lastErr) this.log(`poll failed for ${path.basename(f.ref.path)}: ${code}`);
    f.pollErrors += 1;
    f.lastErr = code;
    f.retryAt = Date.now() + Math.min(this.opts.intervalMs * 2 ** f.pollErrors, MAX_POLL_BACKOFF_MS);
  }

  idleAll() {
    const now = Date.now();
    for (const f of [...this.files.values()]) {
      if (!f.ready || this.closed) continue;
      let evs = null;
      try {
        evs = f.state.idle(now);
      } catch (err) {
        if (this.applyErrors++ < 20) this.log(`idle failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
      }
      this.deliver(f, evs, true);
    }
  }

  async close() {
    this.closed = true;
    for (const t of Object.values(this.timers)) clearInterval(t);
    for (const p of this.files.keys()) this.tailer.forget(p);
    await Promise.allSettled([...this.inflight]);
  }
}
