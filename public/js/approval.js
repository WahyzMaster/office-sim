// 라이브 권한 대기(P5g, tool_wait)를 직원 할 일(intent)로 바꾸는 규칙. three.js 를 쓰지 않는 순수 함수라 node 에서 바로 돌려 볼 수 있다.
// 질문 모양은 재생 모드 awaitsApproval(office.js toolStart)과 같고, live 와 돌아갈 방(resume)만 더 들고 있다.

// 라이브 질문을 닫는 이벤트는 새 요청과 턴 끝뿐이다. 권한 창이 열린 동안 오는 생각, 말, 형제 도구는 질문을 닫지 않는다.
const LIVE_ASK_OVER = new Set(['prompt', 'turn_end']);

export const liveAskStays = (it, type) => !!it.live && !LIVE_ASK_OVER.has(type);

// 도구 문구 기억(sessionId|toolUseId -> { text }). 합쳐진 intent 는 첫 문구만 남기므로(agent-queue.js absorb) 도구마다 따로 둔다.
// 페이지에는 빗장이 없다: true 는 서버 코어마다 id 당 한 번이라, 허용 뒤의 true 는 새 코어(재시작)가 아직 열린 창을 본 것이다.
export const textKey = (sessionId, id) => `${sessionId}|${id}`;

export function rememberText(texts, sessionId, id, text) {
  texts.set(textKey(sessionId, id), { text });
}

export function forgetText(texts, sessionId, id) {
  texts.delete(textKey(sessionId, id));
}

// 한 직원의 문구를 지운다. keep 에 있는 toolUseId 는 남긴다(스냅샷이 아직 열려 있다고 말한 도구).
export function forgetTexts(texts, sessionId, keep = null) {
  const pre = `${sessionId}|`;
  for (const k of [...texts.keys()]) {
    if (k.startsWith(pre) && !keep?.has(k.slice(pre.length))) texts.delete(k);
  }
}

// waiting:true. 열린 도구 intent 에서 이 id 만 떼어 내 내 자리 승인 질문으로 바꾼다. 만든 질문을 돌려준다(아니면 null).
// 혼자인 도구가 아직 줄에 서 있으면 그 자리를 질문이 차지하고, 이미 하는 중이거나 합쳐진 도구면 질문을 뒤에 넣는다.
// 합쳐진 intent 의 error 는 실패한 형제의 것이라(실패한 도구는 pending 에서 이미 빠졌다) 이 도구를 막지 않는다.
export function waitStart(a, ev, entry) {
  const id = ev.toolUseId;
  const orig = a.pending.get(id);
  if (!orig || orig.kind === 'ask' || orig.open <= 0) return null;
  orig.open -= 1;
  const text = entry?.text ?? orig.label ?? orig.activity ?? '';
  const question = `승인 대기 · ${text}`;
  const ask = {
    kind: 'ask', approval: true, room: 'desk', prefer: 0, question, options: ['허용', '거절'],
    ids: [id], open: 1, ts: ev.ts, activity: '승인 받으러 가는 중',
    live: true, resume: { room: orig.room, text },
  };
  const q = orig.ids.length === 1 ? a.queue.indexOf(orig) : -1;
  a.pending.set(id, ask);
  if (q >= 0) a.queue.splice(q, 1, ask);
  else a.push(ask);
  return ask;
}

// waiting:false(허용). 아직 줄에 선 질문이면 그 자리에 도구 일을 넣어 곧장 일하러 간다.
// 이미 자리에 있으면 지금부터 1.2 s 승인됨을 보이고(agent.js showAllowed), 가는 중이면 도착해서 보인 뒤(onArrive) 도구 방으로
// 돌아가 tool_end 까지 일한다.
// 거절은 waiting:false 없이 tool_end denied 로 오고, 기존 질문 처리(agent.js toolEnd)가 거절됨을 보인다.
export function waitEnd(a, id) {
  const ask = a.pending.get(id);
  if (!ask || ask.kind !== 'ask' || !ask.live || ask.answered) return null;
  const tool = { kind: 'tool', room: ask.resume.room, ids: [id], open: 1, activity: ask.resume.text };
  a.pending.set(id, tool);
  const q = a.queue.indexOf(ask);
  if (q >= 0) a.queue.splice(q, 1, tool);
  else {
    ask.answered = true;
    ask.open -= 1;
    a.showAllowed?.(ask);
    a.push(tool);
  }
  return tool;
}

// 스냅샷 안의 승인 대기: sessionId -> 아직 기다리는 toolUseId 집합.
export function snapshotWaits(events) {
  const waits = new Map();
  for (const e of events) {
    if (e.type !== 'tool_wait' || e.waiting !== true) continue;
    if (!waits.has(e.sessionId)) waits.set(e.sessionId, new Set());
    waits.get(e.sessionId).add(e.toolUseId);
  }
  return waits;
}

// 스냅샷 대조: tool_start 는 있는데 tool_wait 가 없는 라이브 질문은 끊긴 사이에 허용된 것이라 도구 방으로 돌려보낸다.
// 재생 모드 질문(live 없음)과 이미 답을 받은 질문은 건드리지 않는다.
export function reconcileWaits(a, openIds, waitIds) {
  let n = 0;
  for (const [id, it] of [...a.pending]) {
    if (it.kind !== 'ask' || !it.live || it.answered || !openIds.has(id) || waitIds.has(id)) continue;
    if (waitEnd(a, id)) n += 1;
  }
  return n;
}
