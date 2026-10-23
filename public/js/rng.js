// 절차적 소품(서가 책, 모니터 화면)을 층·테마를 다시 지어도 같은 모양으로 만드는 시드 난수. three.js 에 의존하지 않는다.

// mulberry32: 32비트 시드 하나로 [0, 1) 난수열을 만든다.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 문자열 -> 32비트 시드 (FNV-1a).
export function seedOf(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
