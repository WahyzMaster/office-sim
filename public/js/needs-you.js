// "나를 기다리는 캐릭터" 수 (launch readiness W7, contract 9.5): 사람의 답을 기다리는 캐릭터를 세어 탭 제목에
// "(N) Office Sim" 으로 보이고, 위 막대에 칩 하나를 넣어 누를 때마다 그 캐릭터들을 차례로 선택한다.
// 세는 근거는 직원의 pending (toolUseId -> intent, agent.js) 이다: 아직 답을 못 받은 질문(kind 'ask')이 하나라도 있으면
// 기다리는 중이다. AskUserQuestion 과 계획 승인(office.js toolStart), 재생 모드의 승인 대기(awaitsApproval),
// 라이브 권한 대기(tool_wait, approval.js waitStart)가 모두 그 모양이다. 자리에 도착했는지(mode)는 보지 않는다:
// 걷는 데는 프레임이 필요한데, 숨은 탭에는 프레임이 없고 제목은 바로 그때 필요하다.
// 첫 실행 데모의 캐릭터(이벤트에 demo 표시, empty-state.js)는 세지 않는다: 그 질문은 누구도 기다리지 않는다.
import { isLlmVisible, langOf } from './rooms.js';

/** The tab title without a count. office.html starts with it. */
export const BASE_TITLE = 'Office Sim';

/** `(N) Office Sim` for a positive whole count, the plain title otherwise. Not translated. */
export const needsYouTitle = (n) => (Number.isInteger(n) && n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE);

const TEXT = Object.freeze({
  ko: Object.freeze({
    chip: (n) => `확인 필요 ${n}`,
    hint: (n) => `캐릭터 ${n}명이 내 답을 기다리고 있어요. 누르면 차례로 보여 줘요.`,
  }),
  en: Object.freeze({
    chip: (n) => `Needs you ${n}`,
    hint: (n) => `${n} ${n === 1 ? 'character is' : 'characters are'} waiting for your answer. Click to go through them.`,
  }),
});

/** The chip's strings for a language: `chip(n)` (the visible label) and `hint(n)` (tooltip and aria-label). */
export const needsYouText = (lang) => TEXT[langOf(lang)];

/** True when the character has an ask nobody answered yet: an open question, a plan approval, or a permission wait. */
export function waitsOnHuman(agent) {
  const pending = agent?.pending;
  if (!(pending instanceof Map)) return false;
  for (const it of pending.values()) if (it?.kind === 'ask' && !it.answered) return true;
  return false;
}

/**
 * The characters that wait on the human now. Pure: it reads `id`, `floor.index` and `pending` and changes nothing.
 * @param {Iterable<object>} agents e.g. `office.agents.values()`
 * @param {{ demoIds?: Set<string>|null, visible?: ((agent: object) => boolean)|null }} [o] demoIds: characters of
 *   the first-run demo (never counted). visible: the LLM filter; a character it hides is not counted.
 * @returns {object[]} ordered by floor, then by arrival (the order of `agents`)
 */
export function waitingAgents(agents, { demoIds = null, visible = null } = {}) {
  const out = [];
  for (const a of agents ?? []) {
    if (!a || demoIds?.has(a.id) || (visible && !visible(a))) continue;
    if (waitsOnHuman(a)) out.push(a);
  }
  return out.sort((x, y) => (x.floor?.index ?? 0) - (y.floor?.index ?? 0)); // stable: arrival order inside a floor
}

/**
 * Keep the set of demo character ids current, by the rule of agent-extras.js: an event marked `demo` makes its
 * session a demo character, and a `session` event without the mark makes that id a real session again.
 */
export function trackDemo(demoIds, ev) {
  if (!ev?.sessionId) return;
  if (ev.demo) demoIds.add(ev.sessionId);
  else if (ev.type === 'session') demoIds.delete(ev.sessionId);
}

/** The character to select next: the one after `selected` in `list`, around the end; the first when `selected` is not in it. */
export function nextWaiting(list, selected) {
  if (!list?.length) return null;
  return list[(list.indexOf(selected) + 1) % list.length];
}

// .chip 은 display 를 정하므로 hidden 속성만으로는 숨지 않는다. 버튼이라 글꼴과 색을 막대에서 물려받게 한다.
const STYLE_CSS = `
#needs-you { font: inherit; font-size: 12px; font-weight: 600; color: inherit; cursor: pointer; border-color: var(--accent); }
#needs-you i { background: var(--accent); }
#needs-you[hidden] { display: none; }
`;

/**
 * Count the waiting characters, show the count in `document.title` and in one chip of the top bar, and cycle the
 * selection through them when the chip is clicked. The chip is made here (office.html has no markup for it) and is
 * hidden at zero. Call after `hud.bind()`, so `hud.lang` is already the new language when the language button's
 * click reaches this module.
 * The count is refreshed after every office event and every snapshot (in a microtask, once per burst), which works
 * in a hidden tab too, and once a second for what changes without an event (the LLM filter).
 * @param {{ office: object, hud?: object, doc?: Document|null, win?: Window|null, visible?: (agent: object) => boolean }} o
 * @returns {{ count: number, waiting: object[], refresh: () => number, cycle: () => object|null }|null}
 */
export function installNeedsYou({ office, hud = null, doc = globalThis.document, win = globalThis.window, visible = isLlmVisible } = {}) {
  if (!office || !doc?.createElement) return null;
  const demoIds = new Set();
  let list = [];
  let shown = null; // "<count>|<lang>" the chip shows now
  let queued = false;

  if (doc.head && !doc.getElementById?.('needs-you-style')) {
    const style = doc.createElement('style');
    style.id = 'needs-you-style';
    style.textContent = STYLE_CSS;
    doc.head.appendChild(style);
  }
  const chip = doc.createElement('button');
  chip.id = 'needs-you';
  chip.className = 'chip';
  chip.setAttribute('type', 'button');
  chip.hidden = true;
  const label = doc.createElement('span');
  chip.append(doc.createElement('i'), label);
  const source = doc.getElementById?.('source');
  if (source?.insertAdjacentElement) source.insertAdjacentElement('afterend', chip);
  else (doc.querySelector?.('.bar .controls') ?? doc.getElementById?.('hud') ?? doc.body)?.appendChild?.(chip);

  function refresh() {
    list = waitingAgents(office.agents?.values?.(), { demoIds, visible });
    const n = list.length;
    const title = needsYouTitle(n);
    if (doc.title !== title) doc.title = title;
    const key = `${n}|${hud?.lang ?? ''}`;
    if (key !== shown) {
      shown = key;
      const t = needsYouText(hud?.lang);
      chip.hidden = n === 0;
      label.textContent = t.chip(n);
      chip.title = t.hint(n);
      chip.setAttribute('aria-label', t.hint(n));
    }
    return n;
  }
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      refresh();
    });
  }

  // 다른 층에 있으면 그 층으로 간다(알림을 눌렀을 때와 같다, system-notify.js). silent: select 의 쓰다듬기(pet)는
  // 말풍선을 바꿔 쓰므로 열려 있는 질문 말풍선을 지운다.
  function cycle() {
    refresh();
    const next = nextWaiting(list, office.selected);
    if (!next) return null;
    if (next.floor && (next.floor.index !== office.focusIndex || office.overview)) office.focus?.(next.floor.index);
    office.select?.(next, { focusPan: true, silent: true });
    return next;
  }

  if (typeof office.onEvent === 'function') {
    const onEvent = office.onEvent.bind(office);
    office.onEvent = (ev) => {
      onEvent(ev);
      trackDemo(demoIds, ev);
      schedule();
    };
  }
  // 스냅샷 대조는 이벤트 없이 질문을 닫는다 (office.js applySnapshot 의 abandonPending)
  if (typeof office.applySnapshot === 'function') {
    const applySnapshot = office.applySnapshot.bind(office);
    office.applySnapshot = (events, meta) => {
      applySnapshot(events, meta);
      schedule();
    };
  }
  chip.addEventListener('click', cycle);
  doc.getElementById?.('lang-toggle')?.addEventListener?.('click', refresh);
  win?.setInterval?.(refresh, 1000);
  refresh();

  return {
    /** How many characters wait now (as of the last refresh). */
    get count() { return list.length; },
    get waiting() { return [...list]; },
    refresh,
    cycle,
  };
}
