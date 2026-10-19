// 아직 session 이벤트가 오지 않은(또는 놓을 층을 모르는) sessionId 의 이벤트를 잠깐 맡아 둔다.
// 이렇게 해야 '알 수 없는 프로젝트' 층에 유령 직원이 생기지 않는다. 시간이 지나면 버린다.

export const INBOX_TTL_MS = 10_000;

export class Inbox {
  constructor({ ttlMs = INBOX_TTL_MS, perId = 24, maxIds = 64, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.perId = perId;
    this.maxIds = maxIds;
    this.now = now;
    this.boxes = new Map(); // sessionId -> [{ at, ev }]
  }

  hold(ev) {
    this.prune();
    let box = this.boxes.get(ev.sessionId);
    if (!box) {
      if (this.boxes.size >= this.maxIds) this.boxes.delete(this.boxes.keys().next().value);
      box = [];
      this.boxes.set(ev.sessionId, box);
    }
    box.push({ at: this.now(), ev });
    if (box.length > this.perId) box.shift();
  }

  // 맡아 둔 이벤트를 순서대로 꺼낸다(오래된 것은 이미 버려짐).
  take(id) {
    this.prune();
    const box = this.boxes.get(id);
    this.boxes.delete(id);
    return box ? box.map((x) => x.ev) : [];
  }

  drop(id) { this.boxes.delete(id); }

  // parentId 아래로 들어갈 session 이벤트를 맡아 둔 sessionId 들(부모가 도착하면 다시 시도한다).
  childrenOf(parentId) {
    this.prune();
    const ids = [];
    for (const [id, box] of this.boxes) {
      if (box.some((x) => x.ev.type === 'session' && x.ev.parentSessionId === parentId)) ids.push(id);
    }
    return ids;
  }

  get size() { return this.boxes.size; }

  prune() {
    const cut = this.now() - this.ttlMs;
    for (const [id, box] of this.boxes) {
      while (box.length && box[0].at < cut) box.shift();
      if (!box.length) this.boxes.delete(id);
    }
  }
}
