// 기록 관찰 패널의 글 만들기 (observe-panel.js 가 쓴다): 시간과 크기 형식, 서버가 보낸 상한(limits) 읽기, 상한 한 줄,
// 끝난 까닭(reason)의 이름, 자동 종료까지 남은 시간. 문서를 만지지 않는 순수 도우미라 node 테스트에서 그대로 부른다.
// 숫자는 늘 서버의 limits 에서 온다 (여기에 10분, 4시간, 50 MB, 20개를 적지 않는다).

// 0 이상의 정수만 받는다. 그 밖(문자열, 음수, NaN)은 0.
export const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const one = (x) => String(Math.round(x * 10) / 10); // 소수 한 자리, 끝의 .0 은 뺀다

// 경과 시간: 12:03 (한 시간이 넘으면 1:02:03).
export function clock(ms) {
  const s = Math.floor(count(ms) / 1000);
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

// 바이트: 512 B, 3.4 KB, 1.2 MB (1024 단위).
export function sizeText(bytes) {
  const b = count(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${one(b / 1024)} KB`;
  return `${one(b / (1024 * 1024))} MB`;
}

// 기간: 10분, 4시간, 1시간 30분, 45초 (1초보다 짧으면 '1초 미만').
export function spanText(ms) {
  const s = Math.round(count(ms) / 1000);
  const parts = [[Math.floor(s / 3600), '시간'], [Math.floor((s % 3600) / 60), '분'], [s % 60, '초']]
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n}${unit}`);
  return parts.length ? parts.join(' ') : '1초 미만';
}

// 상태의 limits: 네 값이 모두 양수일 때만 (아니면 null, 그 줄을 숨긴다). 숫자만 옮긴다.
export function readLimits(l) {
  if (!l || typeof l !== 'object') return null;
  const out = {};
  for (const k of ['readyGraceMs', 'maxMs', 'maxBytes', 'keep']) {
    if (!(Number.isFinite(l[k]) && l[k] > 0)) return null;
    out[k] = l[k];
  }
  return out;
}

// 패널에 늘 보이는 상한 한 줄.
export const limitsText = (L) => `다 모인 뒤 ${spanText(L.readyGraceMs)}, 최대 ${spanText(L.maxMs)}, ${sizeText(L.maxBytes)} 에서 `
  + `자동으로 끝나요. 결과 파일은 최근 ${count(L.keep)}개만 남겨요.`;

// 끝난 까닭: 서버가 보내는 다섯 값만 받는다 (그 밖은 null, 화면에 보이지 않는다).
const REASONS = new Set(['user', 'ready', 'duration', 'bytes', 'close']);
export const readReason = (v) => (typeof v === 'string' && REASONS.has(v) ? v : null);

// 자동 종료의 짧은 이름 ('다 모인 뒤 10분', '최대 4시간', '최대 50 MB'). 자동 종료가 아니면 null.
export function autoWhy(reason, L) {
  if (reason === 'ready') return `다 모인 뒤 ${L ? spanText(L.readyGraceMs) : '정한 시간'}`;
  if (reason === 'duration') return `최대 ${L ? spanText(L.maxMs) : '시간'}`;
  if (reason === 'bytes') return `최대 ${L ? sizeText(L.maxBytes) : '크기'}`;
  return null;
}

// 지난 결과 줄의 끝난 까닭. 모르면 null.
export function reasonText(reason, L) {
  if (reason === 'user') return '직접 끝냄';
  if (reason === 'close') return '서버가 꺼지면서 끝남';
  const why = autoWhy(reason, L);
  return why ? `자동으로 끝남 (${why})` : null;
}

// 자동 종료까지 남은 시간(ms): endsAt - startedAt - 흐른 시간. 서버 시각끼리의 차이라 페이지의 시계와 어긋나지 않고,
// 연결이 끊겨 흐른 시간이 멈추면 함께 멈춘다. 알 수 없으면 null.
export function remainingMs(s, elapsedMs) {
  if (!s.running || !s.endsAt || !s.startedAt) return null;
  return Math.max(0, Date.parse(s.endsAt) - Date.parse(s.startedAt) - count(elapsedMs));
}
