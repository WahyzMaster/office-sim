// 기록 관찰 패널의 DOM 쪽 (public/js/observe-panel.js 의 ObservePanel). test/page-observe.test.mjs 에서 나눴다: 저쪽은 순수
// 도우미와 office.html, 이쪽은 작은 가짜 DOM 위의 ObservePanel 이다. 서버 상태는 손으로 만든 합성 값이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT, PANEL_PARTS, ObservePanel } from '../public/js/observe-panel.js';
import { IDS, checklist, status, ALL_DONE, LAST } from './fixtures/observe-status.mjs';

// ---- ObservePanel 과 작은 가짜 DOM ----

class El {
  constructor(tag) {
    this.tag = tag;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.dataset = {};
    this.attrs = {};
    this.children = [];
    this.parts = {};
    this.listeners = {};
    const props = {};
    this.style = { props, setProperty: (k, v) => { props[k] = v; } };
    const cls = new Set();
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) };
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
  click() { for (const f of this.listeners.click ?? []) f(); }
  querySelector(sel) {
    const m = /^\[data-ob="([a-z]+)"\]$/.exec(sel);
    return m ? this.parts[m[1]] ?? null : null;
  }

  replaceChildren(...c) { this.children = c; }
  append(...c) { this.children.push(...c); }
}

function mount(opt = {}) {
  const btn = new El('button');
  btn.hidden = true;
  const panel = new El('section');
  panel.hidden = true;
  for (const k of PANEL_PARTS) panel.parts[k] = new El(k);
  const posts = [];
  const post = opt.post ?? (async (action) => {
    posts.push(action);
    return { status: status({ running: action === 'start', elapsedMs: 0, last: action === 'stop' ? LAST : null }) };
  });
  const p = new ObservePanel(btn, panel, { doc: { createElement: (t) => new El(t) }, post, now: opt.now ?? (() => 0), announce: opt.announce });
  return { p, btn, panel, posts, part: (k) => panel.parts[k] };
}

test('ObservePanel: hidden in demo and until a live observe status arrives', () => {
  const { p, btn, panel } = mount();
  assert.equal(btn.hidden, true);
  assert.equal(panel.hidden, true);
  p.apply(status());
  assert.equal(btn.hidden, true, 'not live (demo): statuses are ignored');
  p.setLive(true);
  assert.equal(btn.hidden, true, 'live, but no status yet');
  p.apply({ type: 'observe' });
  assert.equal(btn.hidden, true, 'not a status');
  p.apply(status());
  assert.equal(btn.hidden, false);
  assert.equal(panel.hidden, true, 'the panel stays closed until the button is pressed');
  assert.equal(btn.textContent, '기록 관찰');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  btn.click();
  assert.equal(panel.hidden, false);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  p.setLive(false); // 서버가 내려가 데모로 바뀜
  assert.equal(btn.hidden, true);
  assert.equal(panel.hidden, true);
  assert.equal(p.model.status, null);
  p.setLive(true);
  assert.equal(btn.hidden, true, 'the old status is gone');
});

test('ObservePanel: renders the checklist, starts, ticks the clock, shows ready and the saved result', async () => {
  let t = 0;
  const { p, btn, posts, part } = mount({ now: () => t });
  p.setLive(true);
  p.apply(status());
  btn.click();
  const items = part('list').children;
  assert.equal(items.length, 4);
  assert.deepEqual(items[0].children.map((c) => c.textContent).slice(0, 2), ['Grok 작업 기록(updates) 덧붙음', '목표 20']);
  assert.equal(items[0].children[2].style.props['--p'], '0');
  assert.equal(part('hint').hidden, false);
  assert.equal(part('action').textContent, '관찰 시작');
  assert.equal(part('action').classList.contains('primary'), true);
  assert.equal(part('last').hidden, true);

  await p.act();
  assert.deepEqual(posts, ['start']);
  assert.equal(btn.dataset.state, 'running');
  assert.equal(btn.textContent, '관찰 중 · 00:00');
  assert.equal(part('action').textContent, '지금 끝내기');
  assert.equal(part('note').hidden, false);
  t = 65000;
  p.tick();
  assert.equal(btn.textContent, '관찰 중 · 01:05');
  assert.equal(part('clock').textContent, '01:05');

  p.apply(status({ running: true, ready: true, elapsedMs: 70000, checklist: checklist(ALL_DONE) }));
  assert.equal(btn.dataset.state, 'ready');
  assert.equal(btn.textContent, '충분히 모였어요');
  assert.equal(part('action').textContent, '관찰 끝내기');
  assert.equal(part('hint').hidden, true);
  assert.equal(part('list').children[3].children[1].textContent, '20/20 · 다 모임');

  await p.act();
  assert.deepEqual(posts, ['start', 'stop']);
  assert.equal(btn.dataset.state, 'idle');
  assert.equal(part('action').textContent, '관찰 시작');
  t += 300;
  await p.act(); // 더블클릭의 두 번째 클릭
  assert.deepEqual(posts, ['start', 'stop'], 'a click right after the end does not start a new observation');
  assert.equal(part('last').hidden, false);
  assert.equal(part('fileline').hidden, false);
  assert.equal(part('file').textContent, 'observe-20261021-153000.jsonl');
  assert.equal(part('counts').textContent, '파일 3개 · 덧붙음 57번 · 체크리스트 4/4 채움');
  assert.equal(part('claude').textContent, TEXT.claude);
});

test('ObservePanel: a failed POST shows a short message in the panel and keeps the button usable', async () => {
  const { p, part } = mount({ post: async () => ({ error: '관찰을 시작하지 못했어요. 서버가 거절했어요 (500).' }) });
  p.setLive(true);
  p.apply(status());
  assert.equal(part('error').hidden, true);
  await p.act();
  assert.equal(part('error').hidden, false);
  assert.equal(part('error').textContent, '관찰을 시작하지 못했어요. 서버가 거절했어요 (500).');
  assert.equal(part('action').disabled, false);
  assert.equal(part('action').getAttribute('aria-busy'), 'false');
});

test('ObservePanel: available:false keeps the button so the panel can explain, with start disabled', async () => {
  const { p, btn, part } = mount({ post: () => assert.fail('must not post') });
  p.setLive(true);
  p.apply(status({ available: false, agents: { grok: false, codex: false }, checklist: checklist({}, IDS) }));
  assert.equal(btn.hidden, false);
  assert.equal(btn.dataset.state, 'off');
  assert.equal(part('state').textContent, TEXT.unavailable);
  assert.equal(part('action').disabled, true);
  assert.equal(part('list').children.length, 0);
  await p.act();
});

// ---- 리뷰 수정: 초점, 연결 끊김, 알림 ----

test('ObservePanel: the busy button stays focusable (aria-disabled, not disabled) and ignores clicks while busy', async () => {
  let resolve;
  const posts = [];
  const { p, part } = mount({ post: (action) => { posts.push(action); return new Promise((r) => { resolve = r; }); } });
  p.setLive(true);
  p.apply(status());
  const sent = p.act();
  assert.equal(part('action').textContent, '시작하는 중…');
  assert.equal(part('action').disabled, false, 'a disabled button would drop the keyboard focus');
  assert.equal(part('action').getAttribute('aria-disabled'), 'true');
  await p.act();
  assert.deepEqual(posts, ['start'], 'a second press while busy does nothing');
  resolve({ status: status({ running: true }) });
  await sent;
  assert.equal(part('action').getAttribute('aria-disabled'), 'false');
  assert.equal(part('action').textContent, '지금 끝내기');
});

test('ObservePanel: a lost connection freezes the clock and blocks the end button until a new status comes', async () => {
  let t = 0;
  const { p, btn, part, posts } = mount({ now: () => t });
  p.setLive(true);
  p.apply(status({ running: true, elapsedMs: 0 }));
  t = 5000;
  p.setConnected(false);
  t = 20000;
  p.tick();
  assert.equal(btn.textContent, '관찰 중 · 00:05');
  assert.equal(part('state').textContent, TEXT.disconnected);
  assert.equal(part('action').getAttribute('aria-disabled'), 'true');
  await p.act();
  assert.deepEqual(posts, []);
  p.setConnected(true);
  p.apply(status({ running: false, last: null }));
  assert.equal(part('state').textContent, TEXT.cutOff);
  assert.equal(part('action').textContent, '관찰 시작');
  assert.equal(part('action').getAttribute('aria-disabled'), 'false');
});

test('ObservePanel: the button name stays "기록 관찰"; start, ready and stop are announced outside a closed panel', () => {
  const announce = new El('p');
  const { p, btn } = mount({ announce });
  p.setLive(true);
  p.apply(status());
  assert.equal(btn.getAttribute('aria-label'), '기록 관찰');
  assert.equal(announce.textContent, '', 'the first status is not news');
  p.apply(status({ running: true }));
  assert.equal(announce.textContent, '기록 관찰을 시작했어요.');
  assert.equal(btn.getAttribute('aria-label'), '기록 관찰, 관찰 중');
  announce.textContent = '';
  p.apply(status({ running: true, elapsedMs: 3000, checklist: checklist({ 'grok-updates': 4 }) }));
  assert.equal(announce.textContent, '', 'ordinary progress is not announced');
  p.apply(status({ running: true, ready: true, checklist: checklist(ALL_DONE) }));
  assert.equal(announce.textContent, "충분히 모였어요. 패널의 '관찰 끝내기' 로 끝낼 수 있어요.");
  assert.equal(btn.getAttribute('aria-label'), '기록 관찰, 충분히 모였어요');
  btn.click(); // 패널을 열면 패널 안의 상태 줄(aria-live)이 말한다: 밖에서 또 알리지 않는다
  announce.textContent = '';
  p.apply(status({ running: false, last: LAST }));
  assert.equal(announce.textContent, '');
  btn.click();
  p.apply(status({ running: true }));
  assert.equal(announce.textContent, '기록 관찰을 시작했어요.');
  p.apply(status({ running: false, last: LAST }));
  assert.equal(announce.textContent, '기록 관찰을 끝냈어요.');
});
