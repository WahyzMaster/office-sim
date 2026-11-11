// 첫 실행의 데모를 치우는 길 (launch readiness D6) 을 진짜 Office 로 따라간다: reset 스냅샷 뒤에 남는 빈 데모 층까지 없어져야
// 라이브의 첫 세션이 1층에서 시작한다. three.js 는 page-approval-office.test.mjs 처럼 아무 속성이나 받는 가짜 모듈로 바꾸고,
// 층과 직원은 Office 가 실제로 부르는 메서드만 가진 가짜다. 조종기는 public/js/empty-state.js 의 진짜 createFirstRun 이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRACE_S, createFirstRun } from '../public/js/empty-state.js';

const PAGE = fileURLToPath(new URL('../public/js/', import.meta.url));
const names = new Set();
for (const f of readdirSync(PAGE).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(PAGE + f, 'utf8');
  for (const m of src.matchAll(/THREE\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'three[^']*'/g)) for (const n of m[1].split(',')) names.add(n.trim());
}
const STUB = `const H = { get(t, k) { if (k === Symbol.toPrimitive) return () => 0; if (k === Symbol.iterator) return function* () {};
  if (k === 'then') return undefined; if (!(k in t.s)) t.s[k] = mk(); return t.s[k]; },
  set(t, k, v) { t.s[k] = v; return true; }, apply() { return mk(); }, construct() { return mk(); } };
function mk() { const f = function () {}; f.s = {}; return new Proxy(f, H); }
export const ${[...names].map((n) => `${n} = mk()`).join(', ')};`;
const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === 'three' || s.startsWith('three/')) return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true };
  return next(s, c);
}`)}`);
globalThis.window ??= { matchMedia: () => ({ matches: false }) };
globalThis.document ??= { body: { classList: { toggle() {} } } };
const { Office } = await import('../public/js/office.js');

function fakeFloor(key, index) {
  return {
    key, index, label: key, number: `${index + 1}F`, agents: new Set(), group: {}, disposed: false,
    board: { clear() { this.cleared = true; } },
    dispose() { this.disposed = true; }, renameTag() {}, setShadows() {}, setLabelsVisible() {},
  };
}
function fakeAgent(id, floor) {
  const a = { id, floor, disposed: false, dispose() { this.disposed = true; floor.agents.delete(a); }, setLabelsVisible() {} };
  floor.agents.add(a);
  return a;
}
function setup() {
  const rendered = [];
  const hud = {
    lang: 'en', pings: new Map(), renderFloors: (o) => rendered.push(o.floors.length), log() {}, ping() {}, inspect() {},
    clearPing() {}, setSource() {},
  };
  const stage = { setViewFn() {}, setGoal() {}, setLampY() {}, resize() {} };
  const office = new Office(stage, hud);
  const put = (key) => {
    const f = fakeFloor(key, office.floors.length);
    office.floors.push(f);
    office.byKey.set(key, f);
    return f;
  };
  const hire = (id, floor) => { const a = fakeAgent(id, floor); office.agents.set(id, a); return a; };
  return { office, hud, rendered, put, hire };
}

test('Office.pruneEmptyFloors: keeps one empty floor by default and none with keep 0', () => {
  const s = setup();
  const [a, b] = [s.put('web-app'), s.put('api-server')];
  s.office.focusIndex = 1;
  s.office.pruneEmptyFloors();
  assert.deepEqual(s.office.floors.map((f) => f.key), ['web-app'], 'the last empty floor stays so the stage is never bare');
  assert.equal(b.disposed, true);
  assert.equal(a.disposed, false);
  assert.equal(s.office.focusIndex, 0);
  s.office.pruneEmptyFloors(0);
  assert.deepEqual(s.office.floors, []);
  assert.equal(a.disposed, true);
  assert.equal(s.office.byKey.size, 0);
  assert.equal(s.office.focusIndex, 0);
  assert.doesNotThrow(() => s.office.pruneEmptyFloors(0), 'nothing left to prune');
});

test('Office.pruneEmptyFloors(0): a floor with staff is never removed and is renumbered from the ground up', () => {
  const s = setup();
  s.put('demo-floor');
  const real = s.put('/repo/app');
  s.hire('real-1', real);
  s.office.focusIndex = 1;
  s.office.pruneEmptyFloors(0);
  assert.deepEqual(s.office.floors.map((f) => f.key), ['/repo/app']);
  assert.equal(real.index, 0);
  assert.equal(real.disposed, false);
  assert.equal(s.office.focusIndex, 0);
});

test('first-run switch on the real Office: the demo staff, their floors and held events are gone before the real session is shown', () => {
  const s = setup();
  const seen = [];
  // 진짜 직원과 층은 three.js 와 DOM 이 필요하다: 사무실이 받은 이벤트만 적어 둔다 (지우는 쪽은 진짜 메서드가 돈다)
  s.office.onEvent = (ev) => seen.push([ev.type, s.office.floors.length, s.office.agents.size]);
  const ctl = createFirstRun({ office: s.office, hud: s.hud, makeDemo: () => ({ tick() {} }), doc: null });
  ctl.onStatus('live');
  ctl.onSnapshot([], {});
  ctl.onConfig({ type: 'config', intervalMs: 250, activeMinutes: 30 });
  for (let t = 0; t < GRACE_S + 0.2; t += 0.1) ctl.tick(0.1, 0.1, 250);
  assert.equal(ctl.demoing, true);
  // 데모가 만들어 둔 것: 세 층, 직원 넷, 맡아 둔 이벤트와 도구 문구
  const floors = ['web-app', 'api-server', 'docs-site'].map((k) => s.put(k));
  const staff = [s.hire('demo-auth', floors[0]), s.hire('grok-demo-rules', floors[0]), s.hire('demo-score', floors[1]), s.hire('demo-hero', floors[2])];
  s.office.inbox.hold({ type: 'tool_start', sessionId: 'unknown-demo-sub', toolUseId: 'x' });
  s.office.toolTexts.set('demo-auth|t1', 'Read a.ts');
  s.office.selected = staff[0];
  s.office.overview = true;

  ctl.onEvent({ type: 'session', sessionId: 'real-1', agent: 'claude-code', project: '/repo/app' });

  assert.deepEqual(seen, [['session', 0, 0]], 'the real session arrives in an empty building: no demo floor below it');
  assert.ok(staff.every((a) => a.disposed), 'every demo character is disposed');
  assert.ok(floors.every((f) => f.disposed), 'every demo floor is disposed, including the last one');
  assert.equal(s.office.agents.size, 0);
  assert.equal(s.office.byKey.size, 0);
  assert.equal(s.office.toolTexts.size, 0);
  assert.equal(s.office.inbox.take('unknown-demo-sub').length, 0, 'held demo events are dropped');
  assert.equal(s.office.selected, null);
  assert.equal(s.rendered.at(-1), 0, 'the floor buttons are redrawn for the empty building');
  assert.equal(ctl.demoing, false);
});
