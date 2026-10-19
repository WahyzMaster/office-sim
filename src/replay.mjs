// 재생 모드 (P3): 지난 세션 하나(서브에이전트 파일 포함)를 기록된 시각 간격대로(배속 적용) 같은 SSE 스트림에 흘려보낸다.
// tail 루프 대신 이 Runner 가 poll 마다 '때가 된' 줄을 시각 순서로 SessionState 에 넣는다. Store, HTTP, 화면은 라이브와 같다.
// 시계: 언제 줄을 낼지만 기록 시각으로 정한다. 시간 규칙(R25/R27/R29/R30)의 대기는 라이브처럼 실제 시계로 잰다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Runner } from './server-runner.mjs';
import { sessionRefs } from './discover.mjs';
import { fileEntries, mergeTimeline, schedule, approvalIdsOf, ASK_TOOLS } from './replay-timeline.mjs';

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
  constructor({ opts, deps, store, log, onStatus = () => {} }) {
    super({ opts, deps: { ...deps, Tailer: IdleTailer }, store, log });
    this.approvals = new Set();
    this.deps = { ...this.deps, SessionState: withApprovals(deps.SessionState, this.approvals) };
    this.timing = { ...REPLAY_TIMING, ...(opts.replayTiming ?? {}) };
    this.speed = opts.speed ?? 1;
    this.loop = !!opts.loop;
    this.onStatus = onStatus;
    this.timeline = []; // [{ fi, line, t, due }] 시각 순서
    this.refs = []; // fi -> FileRef
    this.failed = new Set(); // 붙지 못한 파일: 이번 회차에는 다시 시도하지 않는다
    this.cursor = 0;
    this.round = 1;
    this.startWall = 0;
    this.phase = 'loading'; // loading -> playing -> done | (hold -> restart -> playing ...) | error
    this.phaseAt = Date.now();
    this.sent = { key: '', at: 0 };
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
    schedule(this.timeline, { speed: this.speed, maxGapMs: this.timing.maxGapMs });
    this.begin();
  }

  begin() {
    this.cursor = 0;
    this.failed.clear();
    this.startWall = Date.now();
    this.enter(this.timeline.length ? 'playing' : 'done');
  }

  enter(phase) {
    this.phase = phase;
    this.phaseAt = Date.now();
    this.status(true);
  }

  // poll 회차마다: 때가 된 줄을 시각 순서로 낸다. 파일은 그 파일의 첫 줄이 나올 때 붙인다(출근).
  async pollAll() {
    const now = Date.now();
    if (this.phase === 'playing') {
      const elapsed = now - this.startWall;
      let released = 0;
      while (this.cursor < this.timeline.length && this.timeline[this.cursor].due <= elapsed) {
        if (this.closed) return;
        if ((++released & 255) === 0) await yieldToLoop(); // 밀린 줄이 많아도 SSE 쓰기와 다른 루프를 막지 않는다
        const e = this.timeline[this.cursor++];
        const f = this.files.get(this.refs[e.fi].path) ?? await this.attachNow(this.refs[e.fi]);
        if (f) this.onLine(f, e.line, false);
      }
      if (this.cursor >= this.timeline.length) this.enter(this.loop ? 'hold' : 'done');
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

  async attachNow(ref) {
    if (this.failed.has(ref.path)) return null;
    let f = null;
    try {
      f = await this.prepare(ref);
    } catch (err) {
      this.attachFailed(ref, err);
    }
    if (f) this.publish(f);
    if (!f?.ready) {
      this.failed.add(ref.path);
      return null;
    }
    return f;
  }

  replayStatus() {
    const total = this.timeline.length;
    const state = this.phase === 'hold' ? 'done' : this.phase;
    return {
      state, speed: this.speed, loop: this.loop, round: this.round,
      progress: total ? Math.round((this.cursor / total) * 1000) / 1000 : 0,
    };
  }

  // 상태가 바뀌면 바로, 진행률은 statusMs 마다 한 번만 알린다 (config 메시지로 실린다).
  status(force) {
    const s = this.replayStatus();
    const key = `${s.state}|${s.round}|${Math.floor(s.progress * 100)}`;
    if (key === this.sent.key) return;
    const now = Date.now();
    const sameState = this.sent.key.startsWith(`${s.state}|${s.round}|`);
    if (!force && sameState && now - this.sent.at < this.timing.statusMs) return;
    this.sent = { key, at: now };
    try {
      this.onStatus(s);
    } catch (err) {
      this.log(`replay status failed: ${err?.message ?? err}`);
    }
  }
}
