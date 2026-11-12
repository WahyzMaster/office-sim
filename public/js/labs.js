// 관리자용 도구 스위치 (launch readiness D10). 플라이휠 버튼과 패널, RCI·렌즈 알약, tail 간격 입력은 평소에는 보이지 않고,
// 주소에 ?labs=1 을 붙이거나 그렇게 저장해 둔 브라우저에서만 보인다. ?labs=0 은 저장한 것을 지운다.
// 저장 자리는 다른 설정과 같은 localStorage 'office-sim:v1' 의 JSON 안 `labs` 키다 (system-notify.js 의 `notify` 처럼).
import { STORE, loadPrefs } from './hud.js';

/** The class `<body>` carries while labs is on (office.html hides the tail-interval input without it). */
export const LABS_CLASS = 'labs';

const ON = new Set(['1', 'true', 'on']);
const OFF = new Set(['0', 'false', 'off']);

/**
 * What the URL says: `?labs=1` (or true / on) -> true, `?labs=0` (or false / off) -> false, absent or anything else
 * -> null (no say: the saved preference decides).
 * @param {string} [search] `location.search`
 * @returns {boolean|null}
 */
export function parseLabsParam(search = '') {
  let value = null;
  try { value = new URLSearchParams(search || '').get('labs'); } catch { return null; }
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  return ON.has(v) ? true : OFF.has(v) ? false : null;
}

/** The saved preference: only a stored `labs: true` counts. Missing, broken or blocked storage is off. */
export function readLabsPref(storage) {
  try { return JSON.parse(storage.getItem(STORE))?.labs === true; } catch { return false; }
}

// 다른 키는 그대로 두고 labs 만 바꾼다. 끌 때는 false 를 쓰지 않고 키를 지운다. 바뀔 것이 없으면 쓰지 않는다.
// loadPrefs 는 예전 키(claude-office:v1)의 설정을 먼저 옮겨 온다: 여기서 새 키를 먼저 만들어도 예전 설정이 가려지지 않는다.
function writeLabsPref(storage, on) {
  try {
    const prefs = loadPrefs(storage);
    if ((prefs.labs === true) === on) return;
    if (on) prefs.labs = true;
    else delete prefs.labs;
    storage.setItem(STORE, JSON.stringify(prefs));
  } catch { /* 저장소가 막혀 있으면 이번 페이지에서만 따른다 */ }
}

/**
 * Whether labs is on for this page load: an explicit `?labs=` wins and is saved; otherwise the saved preference.
 * @param {{ search?: string, storage?: Storage|null }} [o]
 */
export function resolveLabs({ search = '', storage = null } = {}) {
  const fromUrl = parseLabsParam(search);
  if (fromUrl === null) return storage ? readLabsPref(storage) : false;
  if (storage) writeLabsPref(storage, fromUrl);
  return fromUrl;
}

let labsOn = false;

/** The flag `initLabs` resolved for this page load (false until it ran). */
export const isLabs = () => labsOn;

function pageStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Resolve the flag once at page start and mark `<body>` with it. Call before `new Hud()`: the Hud keeps an in-memory
 * copy of the preferences and saves that copy whole, so a `labs` key written later would be lost at its next save.
 * @param {{ search?: string, storage?: Storage|null, doc?: Document|null }} [o]
 * @returns {boolean}
 */
export function initLabs({ search = globalThis.location?.search, storage = pageStorage(), doc = globalThis.document } = {}) {
  labsOn = resolveLabs({ search, storage });
  doc?.body?.classList?.toggle?.(LABS_CLASS, labsOn);
  return labsOn;
}
