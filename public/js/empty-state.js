// 첫 실행의 빈 사무실 (launch readiness D6): 라이브 모드의 첫 온전한 스냅샷에 세션이 없으면, 라이브 연결은 그대로 둔 채
// 배너 아래에서 데모 시나리오를 보여 주고, 진짜 세션이 처음 나타나면 데모를 치우고 라이브로 넘어간다.
// - firstRunStep: 언제 데모를 시작하고 끝낼지 정하는 순수 함수 (DOM 도 시계도 없다. 테스트가 그대로 부른다).
// - createFirstRun: 그 결정을 office, hud, 데모 공급원(MockSource)에 옮기는 조종기. main.js 가 라이브 모드에서만 만든다.
import { langOf } from './rooms.js';

/** Seconds to wait after the empty first snapshot before the demo starts (the server's first rescan may still run). */
export const GRACE_S = 1.5;

// 문장은 시간 창을 말하지 않는다 (D21): 페이지가 아는 것은 "지금 붙은 세션이 없다" 뿐이고, --active 창은 서버의 탐색 기준이다.
const EMPTY_TEXT = Object.freeze({
  ko: '지금 실행 중인 에이전트 세션이 없어요. Claude Code, Codex, Grok, Antigravity 중 하나를 시작하면 여기에 나타나요. 지금 보이는 것은 데모예요.',
  en: 'No agent session is running right now. Start Claude Code, Codex, Grok or Antigravity and it appears here. This is a demo.',
});

/** The banner sentence (D21). It names no time window: a second argument (once the `--active` minutes) is ignored. */
export const emptyBannerText = (lang) => EMPTY_TEXT[langOf(lang)];

/** True when a snapshot's event list carries at least one `session` event. */
export const hasSession = (events) => Array.isArray(events) && events.some((e) => e?.type === 'session');

// phase: wait (온전한 스냅샷을 아직 못 받음) -> armed (빈 스냅샷을 받음, config 를 기다림) -> grace (재생 모드가 아님, 잠깐 기다림)
//        -> demo (데모 재생 중) -> live (끝: 다시는 데모로 돌아가지 않는다)
// mode: 마지막 config 가 말한 서버 모드 (null = 아직 모름). 재생 모드(--replay)는 빈 스냅샷으로 시작하므로 데모를 띄우지 않는다.
export const FIRST_RUN_START = Object.freeze({ phase: 'wait', mode: null, t: 0 });
const to = (state, patch) => Object.freeze({ ...state, ...patch });

/**
 * One step of the first-run decision. Pure: returns a new state and what the caller must do.
 * Inputs and their actions:
 * - `{ type: 'snapshot', hasSession, partial }` -> 'apply' (hand it to the office), 'ignore' (the demo is on and the
 *   snapshot is empty: it would send the demo staff home) or 'switch' (clear the demo, then apply).
 * - `{ type: 'event', eventType }` (a live event) -> 'apply' or, for the first real `session` during the demo, 'switch'.
 * - `{ type: 'config', replay }` -> null. Replay mode ends the decision; a live config after an empty snapshot arms the grace.
 * - `{ type: 'tick', dt }` (seconds) -> 'start' once, when the grace time is over; otherwise null.
 * @param {{ phase: string, mode: string|null, t: number }} state
 * @param {object} input
 * @param {number} [graceS]
 * @returns {{ state: object, action: 'apply'|'ignore'|'switch'|'start'|null }}
 */
export function firstRunStep(state, input, graceS = GRACE_S) {
  const { phase } = state;
  switch (input?.type) {
    case 'snapshot':
      if (phase === 'live') return { state, action: 'apply' };
      if (input.hasSession) return { state: to(state, { phase: 'live' }), action: phase === 'demo' ? 'switch' : 'apply' };
      if (phase === 'demo') return { state, action: 'ignore' };
      if (phase === 'wait' && !input.partial) {
        return { state: to(state, { phase: state.mode === 'live' ? 'grace' : 'armed', t: 0 }), action: 'apply' };
      }
      return { state, action: 'apply' };
    case 'event':
      if (input.eventType !== 'session' || phase === 'live') return { state, action: 'apply' };
      return { state: to(state, { phase: 'live' }), action: phase === 'demo' ? 'switch' : 'apply' };
    case 'config':
      if (phase === 'live') return { state, action: null };
      // 데모 중에 재생 모드로 바뀌는 서버는 없다 (모드는 실행마다 정해진다): 데모 중의 config 는 모드만 적어 둔다
      if (input.replay) return { state: phase === 'demo' ? state : to(state, { phase: 'live', mode: 'replay' }), action: null };
      return { state: to(state, phase === 'armed' ? { phase: 'grace', mode: 'live', t: 0 } : { mode: 'live' }), action: null };
    case 'tick': {
      if (phase !== 'grace' || !(input.dt > 0)) return { state, action: null };
      const t = state.t + input.dt;
      return t >= graceS ? { state: to(state, { phase: 'demo', t: 0 }), action: 'start' } : { state: to(state, { t }), action: null };
    }
    default:
      return { state, action: null };
  }
}

// 배너는 #hud 격자의 가운데 칸 위쪽에 놓는다 (층 버튼과 활동 기록 사이, 720px 아래에서는 빈 무대 줄). #hud 안이라
// 오버레이 모드(body.overlay)에서는 다른 패널과 함께 사라진다. 클릭은 통과시켜 무대 조작을 막지 않는다.
const STYLE_CSS = `
#hud > #empty-banner {
  grid-column: 2; grid-row: 2; justify-self: center; align-self: start; box-sizing: border-box;
  margin: 0; padding: 8px 14px; max-width: min(560px, 100%); border-color: var(--accent);
  font-size: 12.5px; line-height: 1.45; text-align: center; text-wrap: pretty; pointer-events: none;
}
@media (max-width: 720px) { #hud > #empty-banner { grid-column: 1; grid-row: 3; } }
`;

/**
 * The first-run controller of live mode. The LiveSource stays connected the whole time; the demo source is only an
 * overlay that this controller creates (`makeDemo()`), ticks and drops.
 * @param {{ office: object, hud: object, makeDemo: () => { tick: Function, setLang?: Function }, closeBoard?: () => void,
 *   doc?: Document, graceS?: number }} o
 *   office: `applySnapshot`, `onEvent`, `pruneEmptyFloors`. hud: `lang`, `setSource`, `renderFloors`, `observe`, and
 *   `demoNote` (set here while the demo plays: the chip tooltip `setSource('demo')` shows). closeBoard: closes the plan
 *   drawer (board-detail.js); called once when the demo ends, because a drawer open then shows a demo floor.
 */
export function createFirstRun({ office, hud, makeDemo, closeBoard = null, doc = globalThis.document, graceS = GRACE_S } = {}) {
  let state = FIRST_RUN_START;
  let demo = null;
  let conn = 'live'; // LiveSource 가 마지막으로 알린 연결 상태: 데모가 끝나면 칩을 이 값으로 돌린다
  let banner = null;

  const step = (input) => {
    const r = firstRunStep(state, input, graceS);
    state = r.state;
    return r.action;
  };

  const text = (lang = hud?.lang) => emptyBannerText(lang);
  function render() {
    if (demo && banner) banner.textContent = text();
  }

  function showBanner() {
    if (!banner && doc?.createElement) {
      if (doc.head && !doc.getElementById?.('empty-state-style')) {
        const style = doc.createElement('style');
        style.id = 'empty-state-style';
        style.textContent = STYLE_CSS;
        doc.head.appendChild(style);
      }
      banner = doc.createElement('p');
      banner.id = 'empty-banner';
      banner.className = 'panel';
      banner.setAttribute('role', 'status');
      (doc.getElementById?.('hud') ?? doc.body)?.appendChild(banner);
    }
    if (banner) banner.hidden = false;
  }

  // hud.demoNote: 출처 칩의 데모 툴팁을 배너 문장으로 바꾼다 (기본 툴팁은 "로컬 서버를 실행하면" 이라, 서버가 도는 지금은 맞지 않는다)
  function startDemo() {
    demo = makeDemo();
    hud.demoNote = text;
    showBanner();
    render();
    hud.setSource('demo');
  }

  // 데모를 치운다: 열린 계획 서랍을 먼저 닫고 (데모 중의 층은 모두 데모 층이다), 기존 reset 경로로 직원, 화이트보드, 맡아 둔
  // 이벤트를 비우고, 남은 데모 층과 활동 기록의 데모 줄도 지운다.
  function endDemo() {
    demo = null;
    hud.demoNote = null;
    if (banner) banner.hidden = true;
    closeBoard?.();
    office.applySnapshot([], { reset: true });
    office.pruneEmptyFloors?.(0);
    hud.renderFloors?.(office);
    doc?.getElementById?.('log-list')?.replaceChildren?.();
    hud.setSource(conn);
  }

  return {
    /** True while the demo overlay plays. */
    get demoing() { return demo !== null; },
    get phase() { return state.phase; },

    /** A live `snapshot` message. Returns false when it was kept from the office (an empty one during the demo). */
    onSnapshot(events, msg) {
      const action = step({ type: 'snapshot', hasSession: hasSession(events), partial: !!msg?.partial });
      if (action === 'ignore') return false;
      if (action === 'switch') endDemo();
      office.applySnapshot(events, { partial: !!msg?.partial, reset: !!msg?.reset });
      return true;
    },

    /** A live event. The first real `session` during the demo clears the demo before it is shown. */
    onEvent(ev) {
      if (step({ type: 'event', eventType: ev?.type }) === 'switch') endDemo();
      office.onEvent(ev);
    },

    /** The server's `config` message: replay or live. (Its `activeMinutes` is not used: the banner names no window, D21.) */
    onConfig(msg) {
      step({ type: 'config', replay: !!msg?.replay });
    },

    /** The LiveSource connection state ('live' | 'retry'). During the demo the chip keeps saying demo. */
    onStatus(next) {
      conn = next;
      hud.setSource(demo ? 'demo' : next);
      if (demo && next === 'retry') hud.observe?.setConnected?.(false); // 칩은 데모지만 기록 관찰 패널은 끊긴 것을 알아야 한다
    },

    /** Once per frame, with the same time step the office gets. */
    tick(dt, realDt, intervalMs) {
      if (step({ type: 'tick', dt: realDt }) === 'start') startDemo();
      demo?.tick(dt, realDt, intervalMs);
    },

    /** The UI language changed: re-label the demo sessions and the banner. */
    setLang(lang) {
      demo?.setLang?.(lang);
      render();
    },
  };
}
