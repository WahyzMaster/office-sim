// 첫 실행에서 bin 이 내리는 결정 (contract 6, launch readiness D6 의 플래그 쪽과 D7): 브라우저를 열지, 어느 주소를 열지,
// 세션이 없을 때 터미널에 한 줄을 낼지. 모두 순수 함수다: 터미널 여부, 환경 변수, 플랫폼은 받아서 쓴다 (process 를 읽지
// 않는다). 그래서 테스트는 이 컴퓨터의 터미널, CI 변수, 플랫폼과 상관없이 같은 답을 얻는다.

/** The page fragment that puts the page in demo mode (public/js/main.js reads `#demo`). */
export const DEMO_HASH = '#demo';

const isSet = (v) => typeof v === 'string' && v !== '';
// xdg-open 이 여는 프로그램인 플랫폼 (src/open-url.mjs openerCommand 의 "그 밖"): darwin 과 win32 가 아닌 모든 곳
const usesXdgOpen = (platform) => platform !== 'darwin' && platform !== 'win32';

/**
 * True when opening a browser can work here without trying: macOS `open` and Windows `start` are always present;
 * `xdg-open` needs a graphical session (`DISPLAY` or `WAYLAND_DISPLAY`), so a headless or SSH-only Linux box has none.
 */
export function hasOpener(platform, env) {
  if (!usesXdgOpen(platform)) return true;
  return isSet(env?.DISPLAY) || isSet(env?.WAYLAND_DISPLAY);
}

/**
 * Whether the bin opens the browser once it listens (D7).
 * - `open === true` (`--open`): always, as before D7 (also without a terminal, in CI and with `--auth`).
 * - `open === false` (`--no-open`): never.
 * - otherwise: only when stdout is a terminal (`isTTY === true`), the `CI` variable is unset or empty, and the platform
 *   has an opener. With `auth` it does not open where `xdg-open` is the opener: a browser started fresh keeps the token
 *   URL in its arguments, readable by other local users (contract 6), so there the user opens the printed URL by hand.
 * @param {{ open?: boolean, auth?: boolean, isTTY?: boolean, env?: Record<string, string|undefined>, platform?: string }} input
 */
export function shouldOpen({ open, auth = false, isTTY = false, env = {}, platform } = {}) {
  if (open === true) return true;
  if (open === false) return false;
  if (isTTY !== true) return false; // 파이프, 파일, node --test, /office 스킬의 출력 파일
  if (isSet(env?.CI)) return false;
  if (typeof platform !== 'string' || !hasOpener(platform, env)) return false;
  if (auth && usesXdgOpen(platform)) return false;
  return true;
}

/** The URL to open: the printed URL, plus `#demo` with `--demo`. The printed line itself never carries the fragment. */
export function pageUrl(url, demo) {
  return demo ? `${url}${DEMO_HASH}` : url;
}

/** The one stdout line for a first rescan that attached no session. `activeMinutes` is the `--active` window. */
export function noSessionLine(activeMinutes) {
  return `office-sim: no agent session in the last ${activeMinutes} minutes; the page shows a demo until one starts\n`;
}

/**
 * Whether that line may be printed at all (the session count is checked later, after the first rescan). Only for a
 * terminal: a pipe or a file (a script, the /office skill's output file, the tests) keeps the stdout lines it parses.
 * Not in replay mode (the page shows the replayed session) and not with `--demo` (the demo was asked for).
 */
export function noSessionLineWanted({ isTTY = false, replay = false, demo = false } = {}) {
  return isTTY === true && !replay && !demo;
}
