// 미니 창 (launch readiness W9, contract 9.6, D29~D31): 다른 앱에서 일하는 동안 사무실을 항상 위에 떠 있는 작은 창으로 본다.
// Document Picture-in-Picture 창을 열어 무대(캔버스와 라벨 층)를 그 문서로 옮기고, 탭에는 자리 표시와 되돌리는 버튼을 둔다.
// - frameStep / createFrameLoop: 프레임 루프. 평소에는 탭의 프레임마다, 미니 창이 열려 있는 동안에는 그 창의 프레임으로
//   초당 30번까지 step 을 돌린다. 그래서 무대가 탭의 프레임에 기대지 않는다 (브라우저는 숨은 탭에 프레임을 주지 않는다).
//   루프는 언제나 하나다.
// - floorToShow: 미니 창이 보여 줄 층 (기다리는 캐릭터가 보이는 층에 없으면 그 캐릭터의 층).
// - installPip: 위 막대의 버튼, 창 열기와 닫기, 되돌리기. 서버로 보내는 것도, 저장하는 것도 없다.
// 브라우저에 documentPictureInPicture 가 없으면 (Safari, Firefox, 모바일) 아무것도 만들지 않는다.
import { langOf } from './rooms.js';
import { needsYouText } from './needs-you.js';

/** The size asked for. The browser may give another one, and the person can resize the window. */
export const PIP_SIZE = Object.freeze({ width: 420, height: 300 });
/** While the mini window is open, `step` runs once per this many milliseconds at most (30 a second). */
export const FRAME_CAP_MS = 1000 / 30;
/** A frame this much before its time still runs: frame times wobble around the display's rhythm. */
export const FRAME_SLACK_MS = 2;
/** The longest time step handed to `step`, in seconds (a frame after a pause does not jump). */
export const MAX_DT_S = 0.1;

/** True where the browser can open a Document Picture-in-Picture window (D29). */
export const pipSupported = (win) => typeof win?.documentPictureInPicture?.requestWindow === 'function';

const TEXT = Object.freeze({
  ko: Object.freeze({
    label: '미니 창',
    hint: '미니 창 열기: 다른 앱에서 일하는 동안 사무실을 작은 창으로 맨 위에 띄워 둬요.',
    away: '사무실은 지금 미니 창에 있어요.',
    bring: '여기로 가져오기',
    back: '탭으로 돌아가기',
    backHint: '미니 창을 닫고 사무실을 다시 탭에 보여 줘요.',
  }),
  en: Object.freeze({
    label: 'Mini window',
    hint: 'Open a mini window: the office stays on top in a small window while you work in another app.',
    away: 'The office is in the mini window.',
    bring: 'Bring it back here',
    back: 'Back to tab',
    backHint: 'Close the mini window and show the office in the tab again.',
  }),
});

/** The strings of the control, the placeholder and the mini window for a language. */
export const pipText = (lang) => TEXT[langOf(lang)];

// ---- 프레임 ----

/** The loop state at time `t` (ms): `last` is the frame that last ran step, `due` the time the next one may run. */
export const frameStart = (t) => Object.freeze({ last: t, due: -Infinity });

/**
 * One frame of the loop. Pure. With `minMs` 0 every frame runs. With a limit, a frame runs when it comes no more
 * than FRAME_SLACK_MS before `due`; `due` then moves on by `minMs` from itself or from the frame, whichever is
 * later, so over time there is at most one step per `minMs` and a frame a little early does not wait for the next.
 * @param {{ last: number, due: number }} state
 * @param {number} t frame time, ms, on the clock of `state`
 * @param {number} [minMs] 0: no limit
 * @returns {{ state: object, dt: number|null }} dt: seconds since the frame that ran before (0 to MAX_DT_S), or
 *   null when this frame is skipped (the state is then the same object)
 */
export function frameStep(state, t, minMs = 0) {
  const capped = minMs > 0;
  if (capped && t < state.due - FRAME_SLACK_MS) return { state, dt: null };
  const dt = Math.min(Math.max(0, t - state.last) / 1000, MAX_DT_S);
  return { state: Object.freeze({ last: t, due: capped ? Math.max(t, state.due) + minMs : -Infinity }), dt };
}

/**
 * The frame loop: `step(dt)` once per animation frame of one window at a time.
 * A window's frame times count from the start of its own document, so they are moved onto one clock (`clock`) with
 * the offset seen at the first frame of that window: dt is real time, also across a change of window.
 * @param {(dt: number) => void} step
 * @param {{ win?: Window, clock?: () => number }} [o] win: the window used until `use()` names another one
 * @returns {{ start: () => void, use: (win?: Window|null, minMs?: number, each?: (() => void)|null) => void, source: Window }}
 */
export function createFrameLoop(step, { win = globalThis.window, clock = () => globalThis.performance.now() } = {}) {
  let src = win;
  let minMs = 0;
  let each = null;
  let state = null; // null: 아직 시작하지 않았다
  let offset = null; // 이 창의 프레임 시각을 clock 시각으로 옮기는 값. 창을 바꾸면 첫 프레임에서 다시 잰다
  let turn = 0; // 요청마다 하나 올린다: 예전 요청의 콜백은 아무 일도 하지 않고 다음 프레임도 청하지 않는다
  let handle = null;

  function request() {
    turn += 1;
    const mine = turn;
    handle = src.requestAnimationFrame((now) => {
      if (mine !== turn) return;
      if (offset === null) offset = clock() - now;
      const r = frameStep(state, now + offset, minMs);
      state = r.state;
      if (r.dt !== null) {
        step(r.dt);
        each?.();
      }
      if (mine === turn) request(); // step 이 창을 바꿨다면 use() 가 이미 새 창에 청했다
    });
  }

  return {
    /** The window whose animation frames run the loop now. */
    get source() { return src; },
    /** Start the loop. A second call does nothing. */
    start() {
      if (state) return;
      state = frameStart(clock());
      request();
    },
    /**
     * Run the loop on another window from now on: the pending frame of the old one is cancelled, and the first frame
     * of the new one runs at once. `minMs` limits how often step runs (0: every frame); `each` is called after every
     * frame that ran step. Without arguments: the first window, every frame.
     */
    use(next = null, nextMinMs = 0, nextEach = null) {
      if (handle !== null) {
        try { src.cancelAnimationFrame?.(handle); } catch { /* 닫힌 창 */ }
        handle = null;
      }
      turn += 1;
      src = next ?? win;
      minMs = nextMinMs > 0 ? nextMinMs : 0;
      each = typeof nextEach === 'function' ? nextEach : null;
      offset = null;
      if (!state) return;
      state = frameStart(state.last);
      request();
    },
  };
}

// ---- 한 층 (D31) ----

/**
 * The floor the mini window should move to, or null to stay: the floor of the first waiting character, unless a
 * waiting character is on the shown floor already (or nobody waits).
 * @param {object[]|null} waiting the needs-you list (ordered by floor, then arrival); `floor.index` is read
 * @param {number} shownIndex the focused floor
 */
export function floorToShow(waiting, shownIndex) {
  if (!waiting?.length || waiting.some((a) => a?.floor?.index === shownIndex)) return null;
  const index = waiting[0]?.floor?.index;
  return Number.isInteger(index) ? index : null;
}

// ---- 문서 ----

const STYLE_SELECTOR = 'style, link[rel="stylesheet"]';
const ROOT_ATTRS = Object.freeze(['lang', 'data-theme']);

// 탭: 위 막대의 버튼과, 무대가 비어 있는 동안 그 자리 가운데에 놓는 안내. 안내는 #stage 밖에 둔다: #stage 는 role="img" 라
// 그 안의 버튼은 보조 기술에 보이지 않는다. #hud (z-index 2) 아래, 무대 위다.
const TAB_CSS = `
#pip-open { font: inherit; font-size: 12px; font-weight: 500; color: inherit; cursor: pointer; }
#pip-placeholder {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1; box-sizing: border-box;
  display: grid; gap: 10px; justify-items: center; margin: 0; padding: 14px 18px;
  max-width: min(340px, calc(100vw - 32px)); font-size: 12.5px; line-height: 1.45; text-align: center; text-wrap: pretty;
}
#pip-placeholder p { margin: 0; }
`;

// 미니 창: 페이지의 스타일을 복사한 뒤에 붙인다. 무대 칸은 그 문서에서도 id 가 stage 라 캔버스 규칙(#stage canvas)이 그대로
// 맞고, 여기서 자리만 바꾼다 (탭에서는 position: fixed; inset: 0). 그 아래에 한 줄.
const MINI_CSS = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; overflow: hidden; background: var(--scene-bg); }
#stage { position: relative; inset: auto; flex: 1 1 0; min-height: 0; overflow: hidden; }
#pip-bar {
  flex: none; box-sizing: border-box; height: 32px; display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 0 8px; background: var(--panel-solid); border-top: 1px solid var(--line);
  font-size: 12px; white-space: nowrap;
}
#pip-count { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: var(--accent); }
#pip-count[hidden] { display: none; }
#pip-back { flex: none; padding: 2px 9px; }
.sign { display: none; }
`;

function make(doc, tag, props = {}, attrs = {}) {
  const el = Object.assign(doc.createElement(tag), props);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const copyAttr = (from, to, name) => {
  const v = from?.getAttribute?.(name) ?? null;
  if (v === null) to.removeAttribute(name);
  else to.setAttribute(name, v);
};

// 페이지의 <style> 과 스타일시트 <link> 를 순서대로 새 문서에 다시 만든다 (라벨이 같은 모양이 되게). 연 시점의 것만 복사한다.
// 이 모듈이 탭에 넣은 것(TAB_CSS)은 빼고, 끝에 미니 창의 것을 붙인다.
function copyStyles(from, to) {
  for (const src of from.querySelectorAll?.(STYLE_SELECTOR) ?? []) {
    if (src.id === 'pip-style') continue;
    const link = src.tagName === 'LINK';
    const el = link
      ? make(to, 'link', {}, { rel: 'stylesheet', href: src.href || src.getAttribute('href') || '' })
      : make(to, 'style', { textContent: src.textContent });
    copyAttr(src, el, 'media');
    to.head.appendChild(el);
  }
  to.head.appendChild(make(to, 'style', { id: 'pip-style', textContent: MINI_CSS }));
}

/**
 * The mini window (contract 9.6). Where the browser has no Document Picture-in-Picture this returns null and adds
 * nothing to the page. Otherwise it puts one button into the top bar. A click opens the window and moves the
 * stage's canvas and labels element into it; closing it (its button, the placeholder's button, or the window's own
 * close button) moves them back and restores the frame source, the size and the view.
 * Call after `installNeedsYou` and `hud.bind()`: the button goes after the needs-you chip, and `hud.lang` is
 * already the new language when the language button's click reaches this module.
 * @param {{ stage: object, office: object, hud?: object, host: Element, loop: object, needsYou?: object|null,
 *   doc?: Document, win?: Window }} o
 *   stage: `renderer.domElement`, `labels.domElement`, `setSizeSource`, `resize`, `render` (scene.js). office:
 *   `overview`, `focusIndex`, `floors`, `focus`, `labelRoot`. host: the element that holds the canvas and the labels (`#stage`).
 *   loop: `createFrameLoop(step)`. needsYou: what `installNeedsYou` returned (`waiting` is read).
 * @returns {{ open: boolean, close: () => void }|null}
 */
export function installPip({ stage, office, hud = null, host, loop, needsYou = null, doc = globalThis.document, win = globalThis.window } = {}) {
  if (!pipSupported(win) || !doc?.createElement || !stage || !office || !host || !loop) return null;
  let s = null; // 열려 있는 동안의 것: 창, 그 문서의 요소, 옮긴 노드, 기억한 보기, 되돌릴 때 떼어 낼 것
  let opening = false;

  if (doc.head && !doc.getElementById?.('pip-style')) doc.head.appendChild(make(doc, 'style', { id: 'pip-style', textContent: TAB_CSS }));
  const label = doc.createElement('span');
  const control = make(doc, 'button', { id: 'pip-open', className: 'chip' }, { type: 'button' });
  control.append(label);
  const anchor = doc.getElementById?.('needs-you') ?? doc.getElementById?.('source');
  if (anchor?.insertAdjacentElement) anchor.insertAdjacentElement('afterend', control);
  else (doc.querySelector?.('.bar .controls') ?? doc.getElementById?.('hud') ?? doc.body)?.appendChild?.(control);

  const note = make(doc, 'p', {}, { role: 'status' });
  const bring = make(doc, 'button', { className: 'ghost' }, { type: 'button' });
  const placeholder = make(doc, 'div', { id: 'pip-placeholder', className: 'panel' });
  placeholder.append(note, bring);

  // 루트의 lang 과 data-theme, 무대의 설명을 미니 창 문서에 맞춘다. "시스템" 조명은 data-theme 을 지운다: 지워진 것도 옮긴다
  function copyRoot() {
    if (!s) return;
    for (const name of ROOT_ATTRS) copyAttr(doc.documentElement, s.pdoc.documentElement, name);
    copyAttr(host, s.holder, 'aria-label');
  }

  // 미니 창의 한 줄과 제목, 그리고 따라갈 층. 미니 창에서 step 을 돌린 프레임마다 부른다.
  // 층은 기다리는 캐릭터의 목록이 바뀐 때에만 옮긴다: 그 뒤에 사람이 손으로 고른 층은 그대로 둔다.
  function sync() {
    if (!s) return;
    if (s.pdoc.title !== doc.title) s.pdoc.title = doc.title;
    const list = needsYou?.waiting ?? [];
    const shown = `${list.length}|${hud?.lang ?? ''}`;
    if (shown !== s.shown) {
      s.shown = shown;
      const t = needsYouText(hud?.lang);
      s.count.hidden = list.length === 0;
      s.count.textContent = t.chip(list.length); // 칩의 툴팁은 가져오지 않는다: 그 문장은 클릭을 약속하는데 이 글자는 눌리지 않는다
    }
    const key = list.map((a) => a?.id).join('\n');
    if (key === s.key) return;
    s.key = key;
    const index = floorToShow(list, office.focusIndex);
    if (index !== null) office.focus(index);
  }

  function relabel() {
    const t = pipText(hud?.lang);
    label.textContent = t.label;
    control.title = t.hint;
    control.setAttribute('aria-label', t.hint);
    note.textContent = t.away;
    bring.textContent = t.bring;
    if (!s) return;
    s.back.textContent = t.back;
    s.back.title = t.backHint;
    copyRoot();
    sync();
  }

  // 열기 전의 보기로: 기억한 층(그사이 번호가 바뀌었으면 새 번호, 없어졌으면 옛 번호)과 전체 보기 여부.
  // 달라진 것이 없으면 focus 를 부르지 않는다: focus 는 따라가기를 끄고 화면을 가운데로 되돌린다.
  function restoreView(view) {
    const at = Array.isArray(office.floors) ? office.floors.indexOf(view.floor) : -1;
    const index = at >= 0 ? at : view.index;
    if (office.focusIndex !== index || (office.overview && !view.overview)) office.focus(index);
    if (view.overview && !office.overview) office.focus('all');
  }

  // 무대를 지금 있는 자리의 크기에 맞추고 바로 한 번 그린다. 크기를 바꾸면 캔버스가 비는데, 미니 창에서는 다음 step 까지
  // 여러 프레임이 걸릴 수 있어서 (초당 30번) 창을 끌어 늘리는 동안 깜박인다.
  function fit() {
    stage.resize();
    stage.render?.(office.labelRoot?.());
  }

  /** Put the stage back into the tab. Every way of closing ends here; a second call does nothing. */
  function restore() {
    if (!s) return;
    const cur = s;
    s = null;
    for (const off of cur.off) off();
    host.insertBefore(cur.labels, cur.after?.parentNode === host ? cur.after : null);
    host.insertBefore(cur.canvas, cur.labels);
    // main.js 는 탭 창의 pointerup 에서 캔버스의 dragging 표시(잡는 손 커서)를 지운다. 미니 창 안에서 뗀 pointerup 은
    // 탭 창에 닿지 않아 표시가 남는다: 탭으로 가져오지 않는다. (미니 창 안에서는 남는다. 입력 처리는 더하지 않는다.)
    cur.canvas.classList?.remove('dragging');
    placeholder.remove();
    stage.setSizeSource(null);
    loop.use(); // 탭의 프레임으로, 다시 모든 프레임
    restoreView(cur.view);
    fit();
  }

  /** Close the mini window, if one is open, and put the stage back. */
  function close() {
    const mini = s?.pipWin;
    restore();
    try { mini?.close?.(); } catch { /* 이미 닫힌 창 */ }
  }

  function mount(pipWin) {
    const pdoc = pipWin.document;
    copyStyles(doc, pdoc);
    const holder = make(pdoc, 'div', { id: 'stage' }, { role: 'img' });
    const count = make(pdoc, 'span', { id: 'pip-count', hidden: true }, { role: 'status' });
    const back = make(pdoc, 'button', { id: 'pip-back', className: 'ghost' }, { type: 'button' });
    const bar = make(pdoc, 'div', { id: 'pip-bar' });
    bar.append(count, back);
    pdoc.body.append(holder, bar);

    const canvas = stage.renderer.domElement;
    const labels = stage.labels.domElement;
    const listen = (target, type, fn) => {
      target.addEventListener(type, fn);
      return () => target.removeEventListener(type, fn);
    };
    s = {
      pipWin, pdoc, holder, count, back, canvas, labels,
      after: labels.nextSibling ?? null, // 되돌릴 때 이 앞에 넣는다: 무대 칸에 다른 노드가 있어도 순서가 그대로다
      view: { overview: !!office.overview, index: office.focusIndex, floor: office.floors?.[office.focusIndex] ?? null },
      shown: null, key: null, off: [],
    };
    // 노드를 옮긴다 (다시 만들지 않는다): 렌더러와 WebGL 컨텍스트, 캔버스에 붙은 입력 처리가 그대로 따라간다
    holder.append(canvas, labels);
    host.insertAdjacentElement('afterend', placeholder);
    stage.setSizeSource(() => ({ width: holder.clientWidth || pipWin.innerWidth, height: holder.clientHeight || pipWin.innerHeight }));
    s.off.push(
      listen(pipWin, 'resize', fit),
      listen(pipWin, 'pagehide', restore), // 창의 닫기 버튼, 브라우저의 "탭으로 돌아가기"
      // main.js 는 탭 창의 pointerup 에서 끌기 커서를 끝낸다. 미니 창 안의 pointerup 은 거기에 닿지 않으므로 여기서 끝낸다.
      listen(pipWin, 'pointerup', () => canvas.classList?.remove('dragging')),
      listen(back, 'click', () => {
        close();
        try { win.focus?.(); } catch { /* 탭을 앞으로 가져오지 못해도 무대는 돌아와 있다 */ }
      }),
    );
    if (typeof win.MutationObserver === 'function' && doc.documentElement) {
      const observer = new win.MutationObserver(copyRoot);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: [...ROOT_ATTRS] });
      s.off.push(() => observer.disconnect());
    }
    loop.use(pipWin, FRAME_CAP_MS, sync);
    relabel(); // 글자와 한 줄, 그리고 기다리는 캐릭터가 다른 층에 있으면 그 층
    if (office.overview) office.focus(office.focusIndex); // 한 층만 보인다 (D31)
    fit(); // 한 줄에 글자가 든 뒤에 잰다: 그 줄의 높이만큼 무대 칸이 줄어 있다
  }

  // 클릭 안에서 바로 requestWindow 를 부른다 (브라우저가 사용자 동작을 요구한다). 거절되거나 던지면 아무것도 바꾸지 않는다.
  async function open() {
    if (s || opening) return false;
    opening = true;
    let pipWin = null;
    try {
      pipWin = await win.documentPictureInPicture.requestWindow({ ...PIP_SIZE });
    } catch {
      pipWin = null; // 사용자 동작이 아니었거나, 정책이 막았거나, 창을 만들지 못했다
    } finally {
      opening = false;
    }
    if (!pipWin?.document?.body) return false;
    try {
      mount(pipWin);
    } catch (err) {
      restore();
      try { pipWin.close?.(); } catch { /* 닫을 수 없는 창 */ }
      globalThis.console?.warn?.('office-sim: the mini window could not be set up', err);
      return false;
    }
    return true;
  }

  control.addEventListener('click', () => { open(); });
  bring.addEventListener('click', close);
  doc.getElementById?.('lang-toggle')?.addEventListener?.('click', relabel);
  relabel();

  return {
    /** True while the stage is in the mini window. */
    get open() { return s !== null; },
    close,
  };
}
