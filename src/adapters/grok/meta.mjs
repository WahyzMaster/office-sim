// GrokMeta: Grok 의 메타 감시자 (Runner 의 deps.sidecarWatcher, ADAPTERS 3.3, CONTRACT 4.6, P5g). SidecarWatcher 그대로
// summary.json 을 보고, 같은 check(ref) 에서 세션 폴더의 events.jsonl 을 이어 읽어 (events.mjs 의 EventsTail, 기록 하나에
// 하나) 승인 대기 사실을 붙인다. 붙은 뒤 한 번, 그다음 rescan 마다 불린다 (server-runner.mjs syncSidecars). 여는 파일은
// eventsPathOf(ref.path) 하나뿐이고 (lstat 한 일반 파일, O_NOFOLLOW, 같은 inode/장치), 던지지도 로그하지도 않는다.
// 결과는 { ...summary 정보, approval: { facts, seenAt, reset, caughtUp } } 이고, 알릴 사실이 없고 reset 도 아니고 그 꼬리의
// 첫 따라잡은 읽기도 아니면 approval 은 없다 (그래서 아무 것도 바뀌지 않았으면 null: Runner 가 setInfo 를 부르지 않는다). 열린
// 요청은 따라잡은 읽기마다 다시 알린다. 새 꼬리(붙음, 같은 inode 옮김 뒤의 forget, 교체된 파일의 reset)의 첫 따라잡은 읽기는
// 사실이 없어도 알린다: 그 꼬리가 열린 채로 알린 적 없는 요청의 닫힘은 오지 않으므로, 세션이 그 목록에 없는 보인 대기를 닫는다.
import { SidecarWatcher } from '../../core/sidecar.mjs';
import { EventsTail, eventsPathOf } from './events.mjs';

export class GrokMeta extends SidecarWatcher {
  /**
   * @param {(ref: object) => Array<{ path: string, parse: Function }>} list  the summary.json hook (grokSidecars)
   * @param {{ maxBytes?: number, events?: object }} [o]  events: EventsTail options (tests: now, maxCheck, chunk ...)
   */
  constructor(list, { maxBytes, events = {} } = {}) {
    super(list, maxBytes === undefined ? {} : { maxBytes });
    this.eventsOpts = events;
    this.tails = new Map(); // transcript path -> EventsTail
    this.synced = new WeakSet(); // 붙은 뒤(또는 마지막 reset 뒤) 따라잡은 읽기를 한 번 알린 꼬리
  }

  /**
   * summary.json fields (changed ones) plus `approval` when events.jsonl has facts, was reset, or this is the first
   * caught-up read of its tail; null when none of these.
   */
  async check(ref) {
    if (ref?.facts?.desktopKind) return null;
    // 꼬리는 먼저 (동기로) 잡는다: 이 check 가 도는 사이에 forget 되면 그 결과는 버린다
    const file = eventsPathOf(ref?.path);
    let tail = null;
    if (file !== null) {
      tail = this.tails.get(ref.path);
      if (!tail) this.tails.set(ref.path, (tail = new EventsTail(this.eventsOpts)));
    }
    const info = await super.check(ref);
    const approval = tail ? await this._approval(ref.path, tail, file) : null;
    if (!approval) return info;
    return { ...info, approval };
  }

  async _approval(key, tail, file) {
    try {
      const res = await tail.check(file);
      if (!res || this.tails.get(key) !== tail) return null; // 정보 없음, 또는 읽는 사이에 forget
      if (res.reset) this.synced.delete(tail);
      const first = res.caughtUp && !this.synced.has(tail);
      if (res.caughtUp) this.synced.add(tail);
      if (!res.reset && !res.facts.length && !first) return null;
      return { facts: res.facts, seenAt: res.seenAt, reset: res.reset, caughtUp: res.caughtUp };
    } catch {
      return null;
    }
  }

  /** Drop what was remembered for a transcript (detached, moved or re-attached): the events tail starts at byte 0. */
  forget(key) {
    super.forget(key);
    this.tails.get(key)?.forget();
    this.tails.delete(key);
  }
}
