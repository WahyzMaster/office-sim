// 파일 탐색/꼬리 읽기 루프 (contract 6): poll / rescan / idle. 셋은 서로 겹치지 않는다.
// 이전 tick 이 돌고 있으면 이번 tick 은 건너뛴다. 상태는 Store 와 SessionState 에 있고 여기서는 옮기기만 한다.
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

function errText(err) {
  return err?.message ?? String(err);
}

// 로그에는 경로가 든 전체 메시지 대신 오류 코드만 (EACCES, EIO ...). 코드가 없으면 메시지.
function errCode(err) {
  return typeof err?.code === 'string' ? err.code : errText(err);
}

const MAX_POLL_BACKOFF_MS = 30_000; // 계속 실패하는 파일도 이 간격으로는 다시 읽어 본다

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
    if (!replay && Array.isArray(evs) && evs.length) this.store.ingest(f.ref.path, evs);
    try {
      this.store.observe(f.ref.path, rec);
      // R36: 서브의 TaskCreate/TaskUpdate 는 메인과 같은 작업 목록이다 (replay 에서도 상태로 넘긴다)
      const deltas = f.kind === 'main' ? null : f.state.takeTaskDeltas?.();
      if (deltas?.length) this.store.taskDeltas(f.ref.path, deltas);
    } catch (err) {
      this.log(`link failed in ${path.basename(f.ref.path)}: ${errText(err)}`);
    }
  }

  async rescanOnce() {
    const { scan } = this.deps;
    const nowMs = Date.now();
    let refs;
    try {
      refs = await scan(this.opts.root, { activeMs: this.opts.activeMinutes * 60_000, nowMs });
    } catch (err) {
      this.log(`scan failed: ${errText(err)}`); // 부분 목록으로 분리(detach)하지 않도록 이번 tick 은 통째로 건너뛴다
      return;
    }
    if (this.closed) return;
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
    f.ref = ref;
    if (f.state && 'file' in f.state) f.state.file = ref.path;
    this.files.set(ref.path, f);
    this.attachErrors.delete(from);
    return true;
  }

  // meta 는 jsonl 보다 늦게 생길 수 있고, wf 의 journal label 도 늦을 수 있다 (4.5)
  async retryMeta() {
    for (const p of this.store.pendingMeta()) {
      if (this.closed) return;
      const meta = await this.deps.readSubMeta(p).catch(() => null);
      if (meta) this.store.setMeta(p, meta);
    }
    const byRun = new Map();
    for (const item of this.store.pendingLabels()) {
      if (!item.runDir) continue;
      if (!byRun.has(item.runDir)) byRun.set(item.runDir, []);
      byRun.get(item.runDir).push(item);
    }
    for (const [runDir, items] of byRun) {
      if (this.closed) return;
      const labels = await this.deps.readJournalLabels(runDir).catch(() => null);
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
    const id = this.store.identity(ref);
    this.tailer.forget(ref.path);
    let meta = null;
    let label = null;
    if (id.kind !== 'main') meta = await readSubMeta(ref.path).catch(() => null);
    if (id.kind === 'wf' && id.runDir && !meta?.name && !meta?.description) {
      label = (await readJournalLabels(id.runDir).catch(() => null))?.get?.(id.charId) ?? null;
    }
    if (this.closed) return null;
    let state;
    try {
      state = new SessionState({
        id: id.charId, file: ref.path, kind: id.kind, stem: ref.stem ?? id.sid,
        parentId: this.store.parentFor(ref, meta), agentType: meta?.agentType ?? null,
        subMeta: meta, journalLabel: label,
      });
    } catch (err) {
      this.log(`session init failed for ${path.basename(ref.path)}: ${errText(err)}`);
      return null;
    }
    const f = { ref, state, charId: id.charId, kind: id.kind, ready: false, needsAttach: false, pollErrors: 0, retryAt: 0, lastErr: null };
    this.files.set(ref.path, f);
    let res;
    try {
      this.store.attachFile(ref, state, { meta, label });
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
    return f;
  }

  // 반쯤 붙은 파일을 되돌린다. 같은 오류는 경로마다 한 번만 로그한다 (읽을 수 없는 파일이 rescan 마다 로그를 채우지 않게).
  attachFailed(ref, err, f = this.files.get(ref.path)) {
    const code = errCode(err);
    if (this.attachErrors.get(ref.path) !== code) this.log(`attach failed for ${path.basename(ref.path)}: ${code}`);
    this.attachErrors.set(ref.path, code);
    if (f && !f.ready && this.files.get(ref.path) === f) this.files.delete(ref.path);
    this.tailer.forget(ref.path);
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
      f.state.idle(Date.now());
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
      if (Array.isArray(evs) && evs.length) this.store.ingest(f.ref.path, evs);
    }
  }

  async close() {
    this.closed = true;
    for (const t of Object.values(this.timers)) clearInterval(t);
    for (const p of this.files.keys()) this.tailer.forget(p);
    await Promise.allSettled([...this.inflight]);
  }
}
