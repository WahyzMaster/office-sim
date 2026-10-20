// 가짜 비 Claude 어댑터 (P5a 테스트용). 지어낸 한 줄 형식을 읽는 SessionLike 와 설명자를 만든다.
// 실제 Codex/Grok/Antigravity 형식이 아니다: agent id 흐름, 경로를 해석하지 않는 신원, 끝 힌트, RunnerGroup 을
// 시험하려는 최소 모양이다. import 할 때 아무것도 실행하지 않는다 (node --test 가 test/ 아래 파일을 모두 실행한다).
//
// 줄 형식 (지어냄):
//   { k: 'meta', cwd?, title? }          session 이벤트를 다시 낸다
//   { k: 'tool', id, tool, summary }     tool_start
//   { k: 'done', id }                    tool_end (ok)
//   { k: 'sub_end', child, reason? }     부모 파일에 적힌 자식의 끝 -> 내부 힌트 { hint: 'end', charId }
//   { k: 'sub_end_later', child }        다음 idle() 에 같은 힌트를 낸다 (idle 경로 시험)
// replayHints (기본 false): replay 중에도 힌트 항목만 돌려준다 (이벤트는 여전히 내지 않는다). 실제 어댑터처럼 부모 파일을
// 처음 읽을 때 이미 적혀 있던 자식의 끝을 Runner 가 넘기는 경로를 시험한다. 기본값에서는 예전과 똑같다.
import { Tailer } from '../../src/tailer.mjs';
import { buildSessionEvent } from '../../src/session-identity.mjs';

export class FakeAgentSession {
  constructor({ id, kind = 'main', stem = null, parentId = null, agent, replayHints = false } = {}) {
    Object.assign(this, { id, kind, stem, parentId, agent, replayHints });
    this.cwd = null;
    this.titleText = null;
    this.parentProject = null;
    this.open = new Map();
    this.laterHints = [];
    this._ended = false;
    this.lastMs = 0;
  }

  apply(rec, { replay = false } = {}) {
    const ts = new Date().toISOString();
    this.lastMs = Date.now();
    const out = [];
    if (rec.k === 'meta') {
      this.cwd = rec.cwd ?? this.cwd;
      this.titleText = rec.title ?? this.titleText;
      out.push(this.sessionEvent());
    } else if (rec.k === 'tool') {
      const ev = { type: 'tool_start', sessionId: this.id, ts, toolUseId: rec.id, tool: rec.tool, summary: rec.summary };
      this.open.set(rec.id, ev);
      out.push(ev);
    } else if (rec.k === 'done') {
      if (this.open.delete(rec.id)) out.push({ type: 'tool_end', sessionId: this.id, ts, toolUseId: rec.id, ok: true });
    } else if (rec.k === 'sub_end') {
      out.push({ hint: 'end', charId: rec.child, ...(rec.reason ? { reason: rec.reason } : {}) });
    } else if (rec.k === 'sub_end_later') {
      this.laterHints.push({ hint: 'end', charId: rec.child });
    }
    if (!replay) return out;
    return this.replayHints ? out.filter((ev) => ev.hint !== undefined) : []; // SessionLike: replay 는 상태만 만든다
  }

  idle() {
    const out = this.laterHints;
    this.laterHints = [];
    return out;
  }

  setInfo(info = {}) {
    if (info.parentProject !== undefined) this.parentProject = info.parentProject;
    if (info.parentId !== undefined) this.parentId = info.parentId;
    return [];
  }

  sessionEvent() {
    return buildSessionEvent({
      id: this.id, agent: this.agent, kind: this.kind, stem: this.stem, parentId: this.parentId, agentType: null,
      info: { subMeta: this.titleText ? { name: this.titleText } : null, parentProject: this.parentProject },
      meta: { title: this.titleText }, firstPrompt: null, firstCwd: this.cwd, lastCwd: this.cwd, branch: null,
      worktreeState: null, worktreeSticky: null, ts: new Date(this.lastMs || Date.now()).toISOString(),
    });
  }

  snapshotEvents() {
    return this._ended ? [] : [this.sessionEvent(), ...[...this.open.values()].map((ev) => ({ ...ev }))];
  }

  get title() { return this.sessionEvent().title; }
  get firstCwd() { return this.cwd; }
  get lastActivityMs() { return this.lastMs; }
  get ended() { return this._ended; }
}

/** FakeAgentSession that also returns its hint items while replaying (see replayHints above). */
export class ReplayHintSession extends FakeAgentSession {
  constructor(o = {}) { super({ ...o, replayHints: true }); }
}

/**
 * A fake adapter descriptor. `files(root)` returns the refs its scan reports; they carry no `agent`, so the Runner
 * stamps `deps.agent` (= id) on them. `replayHints: true` makes its sessions forward hints read in replay mode.
 */
export function fakeAdapter({ id = 'grok', files, replayHints = false }) {
  const SessionState = replayHints ? ReplayHintSession : FakeAgentSession;
  return {
    id,
    defaultRoot: '/nonexistent-office-sim-fake-root',
    async deps() {
      return { agent: id, SessionState, Tailer, scan: async (root) => files(root) };
    },
  };
}

export const line = (rec) => `${JSON.stringify(rec)}\n`;
