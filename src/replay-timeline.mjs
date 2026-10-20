// 재생 모드(P3) 시간표. 세션 파일들의 줄을 기록 시각 순서로 합치고, 배속과 긴 공백 상한으로 언제 낼지 정한다.
// 순수 함수만 둔다 (IO 없음). 파일 안의 줄 순서는 그대로 둔다 (R12: 시각이 거꾸로 가도 파일 순서가 기준이다).

export const MAX_LINE_CHARS = 8 * 1024 * 1024; // tailer 의 maxLineBytes 와 같은 상한: 넘는 줄은 건너뛴다
export const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']); // 원래 '내 자리' 질문이라 승인 표시를 붙이지 않는다

const REJECTED_PREFIX = "The user doesn't want to proceed";

function parse(line) {
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * 파일 텍스트 -> { entries: [{ line, t }], skipped, sessionId }.
 * t 는 그 줄까지 나온 가장 늦은 기록 시각이라 뒤로 가지 않는다. 시각이 나오기 전의 줄(사이드카)은 첫 시각을 쓴다.
 * onRecord(rec) 는 파싱된 레코드마다 한 번 불린다 (승인 표시 수집용). 빈 줄과 너무 긴 줄은 넣지 않는다.
 */
export function fileEntries(text, onRecord = null) {
  const entries = [];
  let skipped = 0;
  let max = null;
  let sessionId = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    if (line.length > MAX_LINE_CHARS) {
      skipped += 1;
      continue;
    }
    const rec = parse(line);
    const t = rec && typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
    if (rec) {
      if (sessionId === null && typeof rec.sessionId === 'string' && rec.sessionId) sessionId = rec.sessionId;
      onRecord?.(rec);
    }
    entries.push({ line, t: max });
  }
  const first = entries.find((e) => e.t !== null)?.t ?? 0;
  for (const e of entries) {
    if (e.t !== null) break;
    e.t = first;
  }
  return { entries, skipped, sessionId };
}

/**
 * 사람이 권한 창에 답한 도구 호출 id (재생에서는 결과 줄을 미리 읽을 수 있어서 안다).
 * - permissionDecision.source 'user_temporary': 이번 한 번 허용을 눌렀다.
 * - 사용자 거절: toolDenialKind 'user-rejected' 이거나 본문이 "The user doesn't want to proceed" 로 시작한다.
 * 'user_permanent' 는 예전에 저장한 허용 규칙으로 바로 통과한 것이라 기다림이 없다 (말뭉치에서 Read p50 0.3 s).
 */
export function approvalIdsOf(rec) {
  if (!rec || rec.type !== 'user' || !Array.isArray(rec.message?.content)) return [];
  const pd = rec.permissionDecision;
  const accepted = pd && typeof pd === 'object' && pd.source === 'user_temporary';
  const ids = [];
  for (const b of rec.message.content) {
    if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    if (accepted || rec.toolDenialKind === 'user-rejected' || resultText(b).startsWith(REJECTED_PREFIX)) ids.push(b.tool_use_id);
  }
  return ids;
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  const first = block.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
  return first ? first.text : '';
}

/**
 * 파일별 entries (각각 t 가 줄지 않는다, 우선순위 순: 메인 먼저) -> 시각 순서로 합친 [{ fi, line, t }].
 * 같은 시각이면 앞 파일이 먼저, 파일 안에서는 줄 순서를 지킨다.
 */
export function mergeTimeline(files) {
  const pos = files.map(() => 0);
  const total = files.reduce((n, f) => n + f.length, 0);
  const out = [];
  while (out.length < total) {
    let best = -1;
    for (let fi = 0; fi < files.length; fi++) {
      if (pos[fi] >= files[fi].length) continue;
      if (best < 0 || files[fi][pos[fi]].t < files[best][pos[best]].t) best = fi;
    }
    const e = files[best][pos[best]++];
    out.push({ fi: best, line: e.line, t: e.t });
  }
  return out;
}

/**
 * 합친 줄마다 재생을 시작하고 몇 ms 뒤에 낼지 (`due`) 를 적는다. 줄 사이 공백은 배속으로 나누고,
 * maxGapMs 보다 길면 maxGapMs 로 자른다 (사람이 자리를 비운 한 시간을 4배속으로 15분 기다리지 않게).
 * 돌려주는 값은 마지막 줄의 due (전체 재생 길이).
 */
export function schedule(merged, { speed = 1, maxGapMs = 5000 } = {}) {
  const k = speed > 0 ? speed : 1;
  let acc = 0;
  for (let i = 0; i < merged.length; i++) {
    if (i > 0) acc += Math.min(Math.max(0, merged[i].t - merged[i - 1].t) / k, maxGapMs);
    merged[i].due = acc;
  }
  return acc;
}
