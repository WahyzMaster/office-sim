// 기록 관찰이 보는 Codex 날짜 폴더의 이름 (observe-spec "What is watched"): <codex>/sessions/<YYYY>/<MM>/<DD>.
// 오늘과 어제는 지역 시각으로 센다. I/O 는 없다.

export const YEAR_RE = /^\d{4}$/;
export const TWO_RE = /^\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;

/** Local 'YYYY/MM/DD' keys of today and yesterday at ms (yesterday from local noon: 23 and 25 hour days are fine). */
export function nearDays(ms) {
  const d = new Date(ms);
  return [dayKey(d), dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12))];
}
