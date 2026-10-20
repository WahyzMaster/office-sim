// 진입점: 무대, 사무실, HUD, 이벤트 공급원을 연결하고 루프를 돌린다.
import { createStage } from './scene.js';
import { Office } from './office.js';
import { Hud } from './hud.js';
import { MockSource, LiveSource } from './sources.js';
import { scrollScreens } from './furniture.js';

const cfg = { speed: 1, intervalMs: 250 };
const stage = createStage(document.getElementById('stage'));
const hud = new Hud();
const office = new Office(stage, hud);
stage.applyTheme();

const emit = (ev) => office.onEvent(ev);
let source = null;

function startDemo(state = 'demo') {
  if (source instanceof MockSource) return;
  source?.stop?.();
  source = new MockSource(emit);
  source.onBatch = (n) => hud.flashTail(n);
  hud.setLive(false);
  hud.setSource(state);
}

// 로컬 서버(localhost)에서 열리면 라이브, 그 밖(아티팩트 등)에서는 데모. #demo 로 강제할 수 있다.
// #bench: 성능 측정용 합성 부하(층 10개, 직원 60명). bench.js 는 이때만 불러온다.
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
const benchMode = window.location.hash === '#bench';
if (benchMode) {
  const { BenchSource } = await import('./bench.js');
  source = new BenchSource(emit);
  hud.setLive(true);
  hud.setSource('demo');
  source.start();
} else if (local && window.location.hash !== '#demo') {
  source = new LiveSource(emit, (state) => (state === 'down' ? startDemo('down') : hud.setSource(state)));
  // partial: 서버가 아직 파일을 붙이는 중이라 빠진 세션이 있을 수 있다는 표시(있으면 퇴근시키지 않는다).
  source.onSnapshot = (events, msg) => office.applySnapshot(events, { partial: !!msg?.partial });
  source.onConfig = (msg) => hud.applyConfig(cfg, msg);
  source.onBatch = (n) => hud.flashTail(n);
  hud.setLive(true);
  hud.setSource('retry');
  source.start();
} else {
  startDemo();
}
hud.bind(office, cfg, () => source);

let down = null;
const canvas = stage.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  const r = canvas.getBoundingClientRect();
  office.pick({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 });
});

// 숨어 있던 탭은 프레임이 멈춘 채 이벤트만 쌓인다. 다시 보이면 밀린 일을 건너뛰고 지금 상태로 따라잡는다.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) office.catchUp();
});

const retheme = () => stage.applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const redrawBoards = () => office.floors.forEach((f) => f.board.draw());
document.fonts?.load('48px "Nanum Pen Script"').then(redrawBoards).catch(() => {});
document.fonts?.ready.then(redrawBoards);

function step(realDt) {
  const dt = realDt * (source instanceof MockSource ? cfg.speed : 1);
  source?.tick?.(dt, realDt, cfg.intervalMs);
  office.update(dt, realDt);
  scrollScreens(dt);
  stage.render(office.labelRoot());
  hud.tick(realDt, office);
}

let last = performance.now();
function frame(now) {
  step(Math.min((now - last) / 1000, 0.1));
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (benchMode) (await import('./bench.js')).installBench({ office, stage, frame: step });

window.__officeReady = true;
document.getElementById('boot').hidden = true;
// 디버깅용: 콘솔에서 claudeOffice.emit({...}) 로 이벤트를 직접 넣어 볼 수 있다.
window.claudeOffice = { office, emit, cfg };
