// 재생 모드 (P3): 지난 세션 하나(서브에이전트 파일 포함)를 기록된 시각 간격대로(배속 적용) 같은 SSE 스트림에 흘려보낸다.
// tail 루프 대신 이 Runner 가 poll 마다 '때가 된' 줄을 시각 순서로 SessionState 에 넣는다. Store, HTTP, 화면은 라이브와 같다.
// 시계: 언제 줄을 낼지만 기록 시각으로 정한다. 시간 규칙(R25/R27/R29/R30)의 대기는 라이브처럼 실제 시계로 잰다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Runner } from './server-runner.mjs';
import { sessionRefs } from './discover.mjs';
import {
  fileEntries, mergeTimeline, schedule, approvalIdsOf, extractReplayMarkers, ASK_TOOLS,
} from './replay-timeline.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REPLAY_TIMING = Object.freeze({
  maxGapMs: 5000, // 줄 사이 공백의 상한 (실제 시간)
  holdMs: 3000, // --loop: 마지막 장면을 보여 주는 시간
  restartMs: 2000, // --loop: 모두 퇴근한 뒤 다시 시작하기까지
  statusMs: 1000, // 진행률을 다시 알리는 최소 간격
});

// 줄은 ReplayRunner 가 시각에 맞춰 직접 넣는다. Runner 의 attach(prepare)와 poll 이 부르는 자리만 채운다.
class IdleTailer {
  constructor() { this.skippedLines = 0; }
  async readAll() { return { bytes: 0 }; }
  async poll() { return { bytes: 0 }; }
  forget() {}
  rename() { return false; }
  isBusy() { return false; }
}

// 재생에서만 아는 사실(사람이 권한 창에 답한 호출)을 tool_start 에 붙인다: awaitsApproval: true.
function markApprovals(events, approvals) {
  if (!Array.isArray(events) || !approvals.size) return events;
  return events.map((ev) => (ev?.type === 'tool_start' && approvals.has(ev.toolUseId) && !ASK_TOOLS.has(ev.tool)
    ? { ...ev, awaitsApproval: true } : ev));
}

function withApprovals(Base, approvals) {
  return class ReplaySessionState extends Base {
    apply(rec, o) { return markApprovals(super.apply(rec, o), approvals); }
    snapshotEvents() { return markApprovals(super.snapshotEvents(), approvals); }
  };
}

export class ReplayRunner extends Runner {
  constructor({ opts, deps, store, log, onStatus = () => {}, onSeek = () => {} }) {
    super({ opts, deps: { ...deps, Tailer: IdleTailer }, store, log });
    this.approvals = new Set();
    this.deps = { ...this.deps, SessionState: withApprovals(deps.SessionState, this.approvals) };
    this.timing = { ...REPLAY_TIMING, ...(opts.replayTiming ?? {}) };
    this.speed = opts.speed ?? 1;
    this.loop = !!opts.loop;
    this.onStatus = onStatus;
    this.onSeek = onSeek;
    this.timeline = []; // [{ fi, line, t, due }] 시각 순서
    this.markers = []; // [{ cursor, progress, dueMs, kind, label }]
    this.durationMs = 0;
    this.refs = []; // fi -> FileRef
    this.failed = new Set(); // 붙지 못한 파일: 이번 회차에는 다시 시도하지 않는다
    this.cursor = 0;
    this.round = 1;
    this.startWall = 0;
    this.pausedElapsedMs = 0;
    this.pausedAt = 0;
    this.phase = 'loading'; // loading -> playing | paused -> done | (hold -> restart -> playing ...) | error
    this.phaseAt = Date.now();
    this.sent = { key: '', at: 0 };
    this._seeking = false;
    this._seekEpoch = 0;
    this._seekQueue = Promise.resolve();
  }

  // 첫 rescan 이 파일을 읽어 시간표를 만든다. 그 뒤의 rescan 은 늦은 meta.json / journal 라벨만 다시 본다.
  async rescanOnce() {
    if (this.phase === 'loading') await this.load();
    else await this.retryMeta();
  }

  async load() {
    let refs;
    try {
      refs = await sessionRefs(this.opts.replay);
    } catch (err) {
      this.log(`replay: cannot open the transcript (${err?.code ?? err?.message ?? err})`);
      this.enter('error');
      return;
    }
    const files = [];
    for (const ref of refs) {
      let text;
      try {
        text = await fsp.readFile(ref.path, 'utf8');
      } catch (err) {
        this.log(`replay: skipped ${path.basename(ref.path)} (${err?.code ?? err?.message ?? err})`);
        continue;
      }
      if (this.closed) return;
      const { entries, skipped, sessionId } = fileEntries(text, (rec) => {
        for (const id of approvalIdsOf(rec)) this.approvals.add(id);
      });
      this.tailer.skippedLines += skipped;
      // 이름을 바꾼 메인 파일: stem 이 기록의 sessionId 와 달라 R10 이 모든 줄을 fork 로 보지 않게 한다
      if (ref.kind === 'main' && !UUID_RE.test(ref.stem) && sessionId) ref.stem = sessionId;
      files.push({ ref, entries });
      await yieldToLoop();
    }
    if (!files.length || files[0].ref.kind !== 'main') {
      this.log('replay: the main transcript could not be read');
      this.enter('error');
      return;
    }
    this.refs = files.map((f) => f.ref);
    this.timeline = mergeTimeline(files.map((f) => f.entries));
    this.durationMs = schedule(this.timeline, { speed: this.speed, maxGapMs: this.timing.maxGapMs });
    this.markers = extractReplayMarkers(this.timeline, { mainStem: this.refs[0]?.stem ?? null });
    this.begin();
  }

  begin() {
    this.cursor = 0;
    this.pausedElapsedMs = 0;
    this.failed.clear();
    this.startWall = Date.now();
    this.enter(this.timeline.length ? 'playing' : 'done');
  }

  enter(phase) {
    this.phase = phase;
    this.phaseAt = Date.now();
    this.status(true);
  }

  idleAll() {
    if (this.phase === 'paused' || this._seeking) return;
    super.idleAll();
  }

  // poll 회차마다: 때가 된 줄을 시각 순서로 낸다. 파일은 그 파일의 첫 줄이 나올 때 붙인다(출근).
  async pollAll() {
    if (this._seeking || this.phase === 'paused') return;
    const epoch = this._seekEpoch;
    const now = Date.now();
    if (this.phase === 'playing') {
      const elapsed = now - this.startWall;
      let released = 0;
      while (this.cursor < this.timeline.length && this.timeline[this.cursor].due <= elapsed) {
        if (this.closed || this._seeking || this._seekEpoch !== epoch || this.phase !== 'playing') return;
        if ((++released & 255) === 0) {
          await yieldToLoop(); // 밀린 줄이 많아도 SSE 쓰기와 다른 루프를 막지 않는다
          if (this.closed || this._seeking || this._seekEpoch !== epoch || this.phase !== 'playing') return;
        }
        const e = this.timeline[this.cursor++];
        const f = this.files.get(this.refs[e.fi].path) ?? await this.attachNow(this.refs[e.fi], epoch);
        if (this.closed || this._seeking || this._seekEpoch !== epoch || this.phase !== 'playing') return;
        if (f) this.onLine(f, e.line, false);
      }
      if (this.cursor >= this.timeline.length && this.phase === 'playing' && this._seekEpoch === epoch) {
        this.enter(this.loop ? 'hold' : 'done');
      }
    } else if (this.phase === 'hold' && now - this.phaseAt >= this.timing.holdMs) {
      // 다시 처음부터: 모두 퇴근시키고 등록을 비운다. 같은 SessionState 로는 uuid 중복 제거(R9)가 두 번째 회차를 삼킨다.
      for (const p of [...this.files.keys()].reverse()) this.detach(p, 'done');
      this.enter('restart');
    } else if (this.phase === 'restart' && now - this.phaseAt >= this.timing.restartMs) {
      this.round += 1;
      this.begin();
    }
    this.status(false);
  }

  async attachNow(ref, epoch = this._seekEpoch) {
    if (this.failed.has(ref.path) || this._seeking || this._seekEpoch !== epoch) return null;
    let f = null;
    try {
      f = await this.prepare(ref);
    } catch (err) {
      if (!this._seeking && this._seekEpoch === epoch) this.attachFailed(ref, err);
    }
    if (this.closed || this._seeking || this._seekEpoch !== epoch) {
      if (f && this.files.get(ref.path) === f) this.detach(ref.path, 'done');
      return null;
    }
    if (f) this.publish(f);
    if (!f?.ready) {
      this.failed.add(ref.path);
      return null;
    }
    return f;
  }

  pause() {
    if (this.phase === 'loading' || this.phase === 'error' || this.phase === 'paused') return this.replayDetail();
    const now = Date.now();
    this.pausedElapsedMs = this.phase === 'playing'
      ? Math.min(this.durationMs, Math.max(0, now - this.startWall))
      : this.durationMs;
    this.pausedAt = now;
    this.enter('paused');
    return this.replayDetail();
  }

  async resume() {
    if (this.phase === 'loading' || this.phase === 'error') return this.replayDetail();
    if (this.cursor >= this.timeline.length) return this.seek({ cursor: 0, paused: false });
    if (this.phase !== 'paused') return this.replayDetail();
    const now = Date.now();
    const shift = Math.max(0, now - (this.pausedAt || now));
    for (const f of this.files.values()) {
      if (f.state && '_lastGrowthMs' in f.state && f.state._lastGrowthMs > 0) f.state._lastGrowthMs += shift;
    }
    this.startWall = now - this.pausedElapsedMs;
    this.enter('playing');
    return this.replayDetail();
  }

  async togglePause() {
    return this.phase === 'paused' ? this.resume() : this.pause();
  }

  setSpeed(nextSpeed) {
    if (!(Number.isFinite(nextSpeed) && nextSpeed >= 0.1 && nextSpeed <= 1000)) {
      throw new RangeError('speed must be 0.1..1000');
    }
    this.speed = nextSpeed;
    this.durationMs = schedule(this.timeline, { speed: nextSpeed, maxGapMs: this.timing.maxGapMs });
    for (const m of this.markers) {
      const e = this.timeline[m.cursor - 1];
      if (e) m.dueMs = Math.round(e.due ?? 0);
    }
    const curDue = this.cursor <= 0 ? 0
      : this.cursor >= this.timeline.length ? this.durationMs
      : this.timeline[this.cursor - 1].due;
    this.pausedElapsedMs = curDue;
    this.startWall = Date.now() - curDue;
    this.status(true);
    return this.replayDetail();
  }

  seek(opts = {}) {
    const run = async () => this._seekImpl(opts);
    this._seekQueue = this._seekQueue.then(run, run);
    return this._seekQueue;
  }

  async _seekImpl({ cursor, progress, paused } = {}) {
    if (this.phase === 'loading' || this.phase === 'error') return this.replayDetail();
    const total = this.timeline.length;
    let target;
    if (Number.isInteger(cursor)) {
      target = Math.min(total, Math.max(0, cursor));
    } else if (Number.isFinite(progress)) {
      target = Math.round(Math.min(1, Math.max(0, progress)) * total);
    } else {
      throw new RangeError('seek requires integer cursor or numeric progress 0..1');
    }
    const explicitPaused = typeof paused === 'boolean' ? paused : null;
    const wasPaused = this.phase === 'paused';
    this._seekEpoch += 1;
    this._seeking = true;
    try {
      if (this.inflight.size) await Promise.allSettled([...this.inflight]);
      for (const p of [...this.files.keys()].reverse()) this.detach(p, 'done');
      this.failed.clear();
      if (target > 0) {
        const neededFi = [];
        for (let i = 0; i < target; i++) {
          const fi = this.timeline[i].fi;
          if (!neededFi.includes(fi)) neededFi.push(fi);
        }
        const prepared = [];
        for (const fi of neededFi) {
          let f = null;
          try {
            f = await this.prepare(this.refs[fi]);
          } catch (err) {
            this.attachFailed(this.refs[fi], err);
          }
          if (f) prepared.push(f);
          else this.failed.add(this.refs[fi].path);
        }
        for (let i = 0; i < target; i++) {
          if (this.closed) return this.replayDetail();
          if ((i & 255) === 255) await yieldToLoop();
          const e = this.timeline[i];
          const f = this.files.get(this.refs[e.fi].path);
          if (f) this.onLine(f, e.line, true);
        }
        await this.retryMeta();
        const now = Date.now();
        for (const f of this.publishOrder(prepared)) {
          if (this.closed || this.files.get(f.ref.path) !== f) continue;
          if (f.state && '_lastGrowthMs' in f.state && f.state._lastGrowthMs > 0) f.state._lastGrowthMs = now;
          f.ready = true;
          try {
            this.store.announce(f.ref.path);
          } catch (err) {
            this.log(`announce failed for ${path.basename(f.ref.path)}: ${err?.message ?? err}`);
          }
        }
      }
      const now = Date.now();
      const curDue = target <= 0 ? 0 : target >= total ? this.durationMs : this.timeline[target - 1].due;
      this.cursor = target;
      this.pausedElapsedMs = curDue;
      this.pausedAt = now;
      this.startWall = now - curDue;
      const wantPaused = explicitPaused !== null ? explicitPaused : (wasPaused || this.phase === 'paused');
      const nextPhase = wantPaused ? 'paused' : target >= total ? (this.loop ? 'hold' : 'done') : 'playing';
      this.enter(nextPhase);
    } finally {
      this._seeking = false;
    }
    try { this.onSeek(this.replayDetail()); } catch { /* ignore */ }
    return this.replayDetail();
  }

  replayStatus() {
    const total = this.timeline.length;
    const state = this.phase === 'hold' ? 'done' : this.phase;
    return {
      state, speed: this.speed, loop: this.loop, round: this.round,
      progress: total ? Math.round((this.cursor / total) * 1000) / 1000 : 0,
    };
  }

  replayDetail() {
    const base = this.replayStatus();
    const total = this.timeline.length;
    const curDue = this.cursor <= 0 ? 0 : this.cursor >= total ? this.durationMs : this.timeline[this.cursor - 1].due;
    const liveElapsed = this.phase === 'playing' ? Math.min(this.durationMs, Math.max(curDue, Date.now() - this.startWall))
      : this.phase === 'paused' ? this.pausedElapsedMs
      : base.state === 'done' ? this.durationMs : 0;
    return {
      ...base,
      paused: this.phase === 'paused',
      cursor: this.cursor,
      total,
      elapsedMs: Math.round(liveElapsed),
      durationMs: Math.round(this.durationMs),
      markers: this.markers,
    };
  }

  // 상태가 바뀌면 바로, 진행률은 statusMs 마다 한 번만 알린다 (config 메시지로 실린다).
  status(force) {
    const s = this.replayStatus();
    const key = `${s.state}|${s.speed}|${s.round}|${Math.floor(s.progress * 100)}`;
    if (!force && key === this.sent.key) return;
    const now = Date.now();
    const sameState = this.sent.key.startsWith(`${s.state}|${s.speed}|${s.round}|`);
    if (!force && sameState && now - this.sent.at < this.timing.statusMs) return;
    this.sent = { key, at: now };
    try {
      this.onStatus(s);
    } catch (err) {
      this.log(`replay status failed: ${err?.message ?? err}`);
    }
  }
}
