// 직원 할 일(intent) 대기열 정리 규칙. three.js 를 쓰지 않는 순수 함수라 node 에서 바로 돌려 볼 수 있다.
// pending(toolUseId -> intent) 은 도구가 합쳐질 때 새 intent 를 가리키도록 같이 고친다.

export const QUEUE_CAP = 12; // 이보다 길어지면 오래된 일을 요약 하나로 접는다
const MERGE_AT = 6; // 이보다 길면 이웃한 같은 방 도구를 합친다
const KEEP_RECENT = 4; // 접을 때도 최근 일 몇 개는 그대로 보여 준다

// it 을 into 에 합친다. 활동 문구는 가장 최근 도구 이름 + 나머지 건수.
// 거절/중단은 "부드러운" 오류. 합칠 때는 진짜 실패(식은땀)가 부드러운 오류를 이긴다.
export const softKind = (k) => k === 'denied' || k === 'interrupted';

function absorb(into, it, pending, newest) {
  into.label = into.label || into.activity;
  into.count = (into.count || 1) + (it.count || 1);
  into.open += it.open;
  if (it.error && (!into.error || (softKind(into.errorKind) && !softKind(it.errorKind)))) {
    into.error = it.error;
    into.errorKind = it.errorKind;
  }
  for (const id of it.ids) {
    into.ids.push(id);
    if (pending.get(id) === it) pending.set(id, into);
  }
  into.activity = `${newest.label || newest.activity} 외 ${into.count - 1}건`;
}

function lastPlanOnly(queue) {
  const plans = queue.filter((i) => i.kind === 'plan');
  if (plans.length < 2) return queue;
  const last = plans[plans.length - 1];
  return queue.filter((i) => i.kind !== 'plan' || i === last);
}

// 오래된 부분을 접는다. 지키는 것: 답을 기다리는 질문(맨 앞으로), 아직 열린 도구, 마지막 계획, 마지막 오류, 퇴근.
// 끝난 도구는 요약 하나로 합치고, 지나간 생각/말/메모/대기는 건너뛴다.
export function collapse(queue, pending, keepRecent = KEEP_RECENT) {
  const cut = Math.max(0, queue.length - keepRecent);
  if (cut === 0) return queue;
  const old = queue.slice(0, cut);
  const recent = queue.slice(cut);
  const asks = [];
  const open = [];
  const closed = [];
  const leaves = [];
  let plan = null;
  let error = null;
  for (const it of old) {
    if (it.kind === 'ask') asks.push(it);
    else if (it.kind === 'tool') (it.open > 0 ? open : closed).push(it);
    else if (it.kind === 'plan') plan = it;
    else if (it.kind === 'error') error = it;
    else if (it.kind === 'leave') leaves.push(it);
  }
  let summary = null;
  if (closed.length) {
    summary = closed[closed.length - 1];
    for (const it of closed.slice(0, -1)) absorb(summary, it, pending, summary);
  }
  const head = [...asks, ...(summary ? [summary] : []), ...open, ...(plan ? [plan] : []), ...(error ? [error] : [])];
  const tail = recent.filter((i) => i.kind !== 'leave');
  return [...head, ...tail, ...leaves, ...recent.filter((i) => i.kind === 'leave')];
}

// push 할 때마다 부른다. 계획은 마지막 것만, 길어지면 같은 방 도구를 합치고, 상한을 넘으면 접는다.
export function compactQueue(queue, pending, cap = QUEUE_CAP) {
  let q = lastPlanOnly(queue);
  if (q.length <= MERGE_AT) return q;
  const out = [];
  for (const it of q) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'tool' && it.kind === 'tool' && prev.room === it.room) {
      absorb(prev, it, pending, it);
      continue;
    }
    if (it.kind === 'think' && q.length > 10) continue;
    out.push(it);
  }
  q = out;
  return q.length > cap ? collapse(q, pending) : q;
}
