// 기록 관찰("기록 관찰"): 상단 바의 버튼과 그 아래 패널. 서버의 POST /observe 와 SSE observe 메시지를 쓴다.
// 위쪽은 DOM 없이 node 테스트에서 부르는 순수 도우미(이름표, 시간 형식, 상태 읽기, 화면 모델, 요청)이고
// 맨 아래 ObservePanel 만 문서를 만진다. 서버가 보내는 것은 개수와 결과 파일 이름뿐이고, 여기서도 그것만 보여 준다.
// 데모·아티팩트·벤치에서는 observe 메시지가 오지 않으므로 버튼도 패널도 숨은 채로 있다.

// 체크리스트 id(전선 위 이름) -> 화면 이름. 모르는 id 는 그대로 보여 준다.
export const CHECK_LABELS = {
  'grok-updates': 'Grok 작업 기록(updates) 덧붙음',
  'grok-wait': 'Grok 권한 창 1초 넘게 기다림',
  'grok-active': 'Grok 실행 중 세션 목록 읽기',
  'codex-rollout': 'Codex 작업 기록(rollout) 덧붙음',
};
const AGENT_NAMES = { grok: 'Grok', codex: 'Codex' };

export const TEXT = {
  button: '기록 관찰',
  ready: '충분히 모였어요',
  unavailable: 'Grok 이나 Codex 기록 폴더를 찾지 못해 관찰할 수 없어요.',
  waitHint: '권한 창이 뜨면 1초 넘게 기다렸다가 답해 주세요. Grok 이 권한을 묻는 모드일 때만 창이 떠요.',
  claude: "Claude 에게 '관찰 결과 반영해 줘' 라고 하면 이 파일을 읽어 문서에 반영해요",
  disconnected: '서버와 연결이 끊겼어요. 다시 연결되면 상태를 새로 받아요.',
  cutOff: '앞의 관찰은 서버가 꺼지면서 끝났어요. 결과 파일에 요약이 없을 수 있어요.',
};

// 패널이 닫혀 있을 때 패널 밖의 알림 자리(#observe-announce, aria-live)에 쓰는 말: 시작, 다 모임, 끝.
const ANNOUNCE = {
  running: '기록 관찰을 시작했어요.',
  ready: `${TEXT.ready}. 패널의 '관찰 끝내기' 로 끝낼 수 있어요.`,
  idle: '기록 관찰을 끝냈어요.',
};

// 패널 안에서 ObservePanel 이 data-ob 로 찾는 자리(office.html 과 맞는지 테스트가 본다).
export const PANEL_PARTS = [
  'clock', 'state', 'list', 'hint', 'action', 'note', 'error', 'last', 'fileline', 'file', 'counts', 'claude',
];

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
// 결과 파일은 이름만 온다(서버 계약). 경로처럼 보이면 보여 주지 않는다.
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ITEMS = 16;
const COOLDOWN_MS = 800; // 요청이 끝난 뒤 버튼이 다시 받기까지

export const checkLabel = (id) => (Object.hasOwn(CHECK_LABELS, id) ? CHECK_LABELS[id] : id);

// 0 이상의 정수만 받는다. 그 밖(문자열, 음수, NaN)은 0.
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
// ISO 시각만 받는다(Date.parse 는 'BAIT 2020' 같은 글도 받아 준다).
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$/;
const isoOrNull = (v) => (typeof v === 'string' && ISO.test(v) ? v : null);

// 경과 시간: 12:03 (한 시간이 넘으면 1:02:03).
export function clock(ms) {
  const s = Math.floor(count(ms) / 1000);
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

function readChecklist(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && SAFE_ID.test(c.id))
    .slice(0, MAX_ITEMS)
    .map((c) => ({ id: c.id, have: count(c.have), need: count(c.need), done: c.done === true, off: c.off === true }));
}
const readTotals = (t) => ({ files: count(t?.files), appends: count(t?.appends) });

// 서버 상태(SSE observe 메시지나 /observe 응답)에서 아는 칸만 골라 정해진 모양으로 옮긴다. 상태가 아니면 null.
// 모르는 칸은 버리므로 화면에는 개수, 체크리스트 id, 결과 파일 이름 말고는 아무것도 가지 않는다.
export function readStatus(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.available !== 'boolean') return null;
  const l = msg.last && typeof msg.last === 'object' ? msg.last : null;
  const running = msg.available && msg.running === true;
  return {
    available: msg.available,
    agents: { grok: msg.agents?.grok === true, codex: msg.agents?.codex === true },
    running,
    startedAt: isoOrNull(msg.startedAt),
    elapsedMs: count(msg.elapsedMs),
    checklist: readChecklist(msg.checklist),
    ready: running && msg.ready === true,
    totals: readTotals(msg.totals),
    last: l && {
      file: typeof l.file === 'string' && SAFE_FILE.test(l.file) ? l.file : null,
      endedAt: isoOrNull(l.endedAt),
      checklist: readChecklist(l.checklist),
      totals: readTotals(l.totals),
    },
  };
}

// 관찰 중이 아니면 모은 수가 없으므로 목표만 보인다(지난 결과는 last 줄에 따로 나온다).
function itemView(c, running) {
  const name = AGENT_NAMES[c.id.split('-')[0]];
  const done = running && c.done;
  let progress = `목표 ${c.need}`;
  if (c.off) progress = '건너뜀';
  else if (running) progress = done ? `${c.have}/${c.need} · 다 모임` : `${c.have}/${c.need}`;
  return {
    id: c.id,
    label: checkLabel(c.id),
    have: c.have,
    need: c.need,
    done,
    off: c.off,
    ratio: !running || c.off ? 0 : done ? 1 : c.need > 0 ? Math.min(1, c.have / c.need) : 0,
    progress,
    note: c.off ? `${name ?? '이 에이전트'} 기록을 읽지 않아 건너뛰어요` : null,
  };
}

// 끝낸 관찰 한 줄 요약: 개수만.
function lastCounts(last) {
  const on = last.checklist.filter((c) => !c.off);
  const parts = [`파일 ${last.totals.files}개`, `덧붙음 ${last.totals.appends}번`];
  if (on.length) parts.push(`체크리스트 ${on.filter((c) => c.done).length}/${on.length} 채움`);
  return parts.join(' · ');
}

// stale: 서버와의 연결이 끊겨 상태가 낡았다(다시 받을 때까지 누르지 않는다).
function actionView(s, busy, stale) {
  if (!s.available) return { kind: 'start', label: '관찰 시작', primary: false, disabled: true };
  if (!s.running) return { kind: 'start', label: busy === 'start' ? '시작하는 중…' : '관찰 시작', primary: true, disabled: !!busy || stale };
  return {
    kind: 'stop',
    label: busy === 'stop' ? '끝내는 중…' : s.ready ? '관찰 끝내기' : '지금 끝내기',
    primary: s.ready,
    disabled: !!busy || stale,
  };
}

// label: 접근성 이름(aria-label). 늘 '기록 관찰' 로 시작하고 1초마다 바뀌는 시계는 넣지 않는다.
// 이 버튼은 패널을 열고 닫기만 한다: 끝내기는 패널 안의 버튼이다.
function buttonView(s, time, stale) {
  if (!s.available) return { state: 'off', text: TEXT.button, label: TEXT.button, title: TEXT.unavailable };
  if (s.ready) {
    const title = stale ? TEXT.disconnected : `${TEXT.ready}. 패널의 '관찰 끝내기' 를 눌러 끝내세요.`;
    return { state: 'ready', text: TEXT.ready, label: `${TEXT.button}, ${TEXT.ready}`, title };
  }
  if (s.running) {
    const title = stale ? TEXT.disconnected : '기록 관찰 중이에요. 눌러서 패널을 열고 닫아요.';
    return { state: 'running', text: `관찰 중 · ${time}`, label: `${TEXT.button}, 관찰 중`, title };
  }
  return { state: 'idle', text: TEXT.button, label: TEXT.button, title: '평소 쓰는 Grok·Codex 기록이 덧붙는 모양을 셉니다.' };
}

function stateText(s, stale, notice) {
  if (stale) return TEXT.disconnected;
  if (!s.available) return TEXT.unavailable;
  if (s.ready) return `${TEXT.ready}. 끝내면 요약을 덧붙여 저장을 마쳐요.`;
  if (s.running) return '관찰 중이에요. 체크리스트가 다 차면 알려 드려요.';
  if (notice) return notice;
  return s.last ? '관찰을 끝냈어요. 다시 시작하면 새 파일에 모아요.' : '관찰하지 않고 있어요.';
}

// 화면 모델. status 는 readStatus 결과(없으면 숨김). opt: elapsedMs(지금까지 흐른 시간), busy('start'|'stop'), error,
// stale(연결이 끊겨 상태가 낡음), notice(멈춘 상태에서 보일 한 줄).
export function observeView(status, opt = {}) {
  if (!status) return { visible: false };
  const s = status;
  const stale = opt.stale === true;
  const time = clock(opt.elapsedMs ?? s.elapsedMs);
  const wait = s.checklist.find((c) => c.id === 'grok-wait');
  return {
    visible: true,
    available: s.available,
    running: s.running,
    ready: s.ready,
    button: buttonView(s, time, stale),
    clock: s.running ? time : '',
    stateText: stateText(s, stale, opt.notice ?? null),
    items: s.available ? s.checklist.map((c) => itemView(c, s.running)) : [],
    hint: s.available && wait && !wait.off && !(s.running && wait.done) ? TEXT.waitHint : null,
    action: actionView(s, opt.busy ?? null, stale),
    note: !s.running || stale ? null : s.ready ? null : '아직 다 모이지 않았어요. 지금 끝내도 모인 만큼 저장돼요.',
    error: opt.error ?? null,
    last: s.running || !s.last ? null : {
      file: s.last.file,
      counts: lastCounts(s.last),
      claude: s.last.file ? TEXT.claude : null,
    },
  };
}

const HTTP_REASONS = {
  401: '인증이 풀렸어요. office-sim 이 알려 준 주소로 다시 열어 주세요.',
  403: '서버가 이 요청을 막았어요.',
  404: '이 서버는 기록 관찰을 켜지 않았어요.',
};

// 500: 서버는 오류 코드만 보낸다({ error, code }). 시작이면 결과 파일(<저장소>/.observe/)을 만들지 못한 것이다.
const ERROR_CODE = /^E[A-Z0-9_]{1,31}$/;
async function serverError(res, action) {
  let code = null;
  try {
    const b = await res.json();
    if (typeof b?.code === 'string' && ERROR_CODE.test(b.code)) code = b.code;
  } catch { /* 코드 없이 */ }
  const tail = code ? ` (${code})` : '';
  return action === 'start'
    ? `결과 파일을 만들지 못했어요${tail}. .observe 폴더를 쓸 수 있는지 확인해 주세요.`
    : `서버에서 오류가 났어요${tail}.`;
}

// POST /observe {action}. LiveSource.setInterval 의 POST /config 와 같은 모양(같은 출처라 --auth 쿠키도 실린다).
// 결과: { status } (서버가 돌려준 상태 그대로) 또는 { error } (패널에 보일 짧은 문장). 던지지 않는다.
export async function postObserve(action, fetchFn = globalThis.fetch) {
  const fail = (why) => ({ error: `관찰을 ${action === 'start' ? '시작하지' : '끝내지'} 못했어요. ${why}` });
  let res;
  try {
    res = await fetchFn('/observe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  } catch {
    return fail('서버에 연결하지 못했어요.');
  }
  if (res?.status === 500) return fail(await serverError(res, action));
  if (!res?.ok) return fail(HTTP_REASONS[res?.status] ?? `서버가 거절했어요 (${res?.status ?? '?'}).`);
  let body = null;
  try { body = await res.json(); } catch { /* 아래에서 읽지 못함으로 */ }
  return readStatus(body) ? { status: body } : fail('서버 응답을 읽지 못했어요.');
}

// 상태 + 요청 중 표시 + 오류. 문서를 만지지 않아 node 에서 그대로 시험한다. now: 밀리초 시계(테스트용).
export class ObserveModel {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.status = null;
    this.at = 0; // status 를 받은 시각
    this.seq = 0; // 받은 상태 수: 요청 사이에 더 새 상태가 왔는지 본다
    this.busy = null;
    this.error = null;
    this.stale = false; // 서버와의 연결이 끊겨 받은 상태가 낡았다(새 상태가 오면 풀린다)
    this.staleAt = 0;
    this.notice = null;
  }

  // 서버와의 연결(LiveSource 의 상태). 끊기면 시계를 세우고 버튼을 막는다. 다시 붙어도 새 상태가 올 때까지는 그대로다.
  setConnected(on) {
    if (on || !this.status || this.stale) return;
    this.stale = true;
    this.staleAt = this.now();
  }

  // 상태가 아니면 무시하고 false. 관찰이 시작되거나 끝나면 지난 오류는 지운다.
  apply(msg) {
    const s = readStatus(msg);
    if (!s) return false;
    const prev = this.status;
    if (prev && prev.running !== s.running) {
      this.error = null;
      this.notice = null;
    }
    // 끊기기 전에는 관찰 중이었는데 다시 붙은 서버에 관찰도 지난 결과도 없다: 관찰이 서버와 함께 끝났다(요약이 없을 수 있다)
    if (this.stale && prev?.running && !s.running && !s.last) this.notice = TEXT.cutOff;
    this.stale = false;
    this.status = s;
    this.at = this.now();
    this.seq += 1;
    return true;
  }

  // 서버는 바뀐 것이 있을 때만 상태를 보내므로, 관찰 중에는 받은 뒤 흐른 시간을 여기서 더한다.
  elapsed() {
    const s = this.status;
    if (!s) return 0;
    if (!s.running) return s.elapsedMs;
    return s.elapsedMs + Math.max(0, (this.stale ? this.staleAt : this.now()) - this.at);
  }

  view() {
    return observeView(this.status, {
      elapsedMs: this.elapsed(), busy: this.busy, error: this.error, stale: this.stale, notice: this.notice,
    });
  }

  // action 을 보낸다. busy 는 await 전에 바로 켜진다(누른 즉시 버튼이 잠긴다). 보냈으면 true.
  async send(action, post) {
    if (this.busy || this.stale || !this.status?.available) return false;
    if (action !== (this.status.running ? 'stop' : 'start')) return false;
    this.busy = action;
    this.error = null;
    const seq = this.seq;
    let r;
    try { r = await post(action); } catch { r = { error: '관찰 요청을 보내지 못했어요.' }; }
    this.busy = null;
    if (r?.error) {
      this.error = r.error;
      return false;
    }
    // 기다리는 사이 SSE 로 더 새 상태가 왔으면 그것을 둔다(응답이 늦게 와서 되돌리지 않게).
    if (this.seq === seq) this.apply(r?.status);
    return true;
  }
}

// 상단 바 버튼 + 패널. button/panel 은 office.html 의 #toggle-observe, #observe. 패널은 열고 닫을 때만 바뀌고
// 저장하지 않는다(데모에서 미리 열린 채로 보이지 않게). opt: post(action), now, doc(테스트용 가짜 문서),
// announce(패널 밖의 aria-live 자리 #observe-announce: 닫힌 패널 안의 글은 화면 읽기 프로그램이 읽지 않는다).
export class ObservePanel {
  constructor(button, panel, opt = {}) {
    this.btn = button;
    this.panel = panel;
    this.announceEl = opt.announce ?? null;
    this.phase = null; // 마지막으로 그린 단계: off | idle | running | ready
    this.post = opt.post ?? ((action) => postObserve(action));
    this.doc = opt.doc ?? globalThis.document;
    this.now = opt.now ?? (() => Date.now());
    this.model = new ObserveModel(this.now);
    this.coolUntil = 0;
    this.live = false;
    this.open = false;
    this.view = { visible: false };
    this.el = Object.fromEntries(PANEL_PARTS.map((k) => [k, panel.querySelector(`[data-ob="${k}"]`)]));
    button.addEventListener('click', () => {
      this.open = !this.open;
      this.render();
    });
    this.el.action.addEventListener('click', () => this.act());
    this.render();
  }

  // 라이브가 아니면(데모로 바뀜) 받은 상태를 버리고 숨긴다.
  setLive(live) {
    this.live = !!live;
    if (!this.live) {
      this.model.reset();
      this.open = false;
    }
    this.render();
  }

  apply(msg) {
    if (this.live && this.model.apply(msg)) this.render();
  }

  // 서버와의 연결이 끊기거나 다시 붙었다(hud.setSource 가 부른다).
  setConnected(on) {
    this.model.setConnected(on);
    if (this.live) this.render();
  }

  // 끝내기와 시작이 같은 자리의 같은 버튼이라, 끝낸 직후의 두 번째 클릭(더블클릭)이 새 관찰을 시작하지 않게 잠깐 쉰다.
  async act() {
    const a = this.view.action;
    if (!a || a.disabled || this.now() < this.coolUntil) return;
    const sent = this.model.send(a.kind, this.post);
    this.render();
    await sent;
    this.coolUntil = this.now() + COOLDOWN_MS;
    this.render();
  }

  // 프레임 루프(hud.tick)에서 부른다. 시계 글자만 바꾼다(목록을 다시 만들지 않는다).
  tick() {
    if (!this.view.visible || !this.view.running) return;
    const v = this.model.view();
    if (v.clock === this.view.clock) return;
    this.view = v;
    this.btn.textContent = v.button.text;
    this.el.clock.textContent = v.clock;
  }

  render() {
    const v = this.live ? this.model.view() : { visible: false };
    this.view = v;
    const { btn, panel, el } = this;
    btn.hidden = !v.visible;
    if (!v.visible) {
      this.open = false;
      this.phase = null;
      btn.setAttribute('aria-pressed', 'false');
      panel.hidden = true;
      return;
    }
    btn.dataset.state = v.button.state;
    btn.textContent = v.button.text;
    btn.title = v.button.title;
    btn.setAttribute('aria-label', v.button.label);
    btn.setAttribute('aria-pressed', String(this.open));
    panel.hidden = !this.open;
    panel.dataset.state = v.button.state;
    el.clock.textContent = v.clock;
    el.state.textContent = v.stateText;
    this.renderList(v.items);
    show(el.hint, v.hint);
    el.action.textContent = v.action.label;
    // 요청 중이나 연결이 끊긴 동안은 aria-disabled 로만 막는다(disabled 로 바꾸면 그 버튼의 키보드 초점이 사라진다).
    // 누름은 act() 와 ObserveModel.send 가 거른다. 진짜 disabled 는 기능을 쓸 수 없을 때만.
    el.action.disabled = !v.available;
    el.action.setAttribute('aria-disabled', String(v.action.disabled));
    el.action.classList.toggle('primary', v.action.primary);
    el.action.setAttribute('aria-busy', String(!!this.model.busy));
    show(el.note, v.note);
    show(el.error, v.error);
    el.last.hidden = !v.last;
    if (v.last) {
      el.fileline.hidden = !v.last.file;
      el.file.textContent = v.last.file ?? '';
      el.counts.textContent = v.last.counts;
      show(el.claude, v.last.claude);
    }
    this.announce(v);
  }

  // 시작, 다 모임, 끝처럼 단계가 바뀔 때만 알린다(진행 숫자는 알리지 않는다). 열린 패널은 안의 상태 줄이 말한다.
  announce(v) {
    const phase = !v.available ? 'off' : v.ready ? 'ready' : v.running ? 'running' : 'idle';
    const prev = this.phase;
    this.phase = phase;
    if (!prev || prev === phase || phase === 'off' || prev === 'off' || this.open || !this.announceEl) return;
    this.announceEl.textContent = phase === 'idle' && this.model.notice ? this.model.notice : ANNOUNCE[phase];
  }

  renderList(items) {
    const make = (tag, text) => {
      const n = this.doc.createElement(tag);
      if (text != null) n.textContent = text;
      return n;
    };
    this.el.list.replaceChildren(...items.map((it) => {
      const li = make('li');
      li.dataset.done = String(it.done);
      li.dataset.off = String(it.off);
      const bar = make('i');
      bar.setAttribute('aria-hidden', 'true');
      bar.style.setProperty('--p', String(it.ratio));
      li.append(make('b', it.label), make('span', it.progress), bar);
      if (it.note) li.append(make('small', it.note));
      return li;
    }));
  }
}

function show(node, text) {
  node.hidden = !text;
  node.textContent = text ?? '';
}
