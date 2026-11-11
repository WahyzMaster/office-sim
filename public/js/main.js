// 진입점: 무대, 사무실, HUD, 이벤트 공급원을 연결하고 루프를 돌린다.
import * as THREE from 'three';
import { createStage } from './scene.js';
import { Office } from './office.js';
import { Hud } from './hud.js';
import { MockSource, LiveSource } from './sources.js';
import { scrollScreens } from './furniture.js';
import { installShareControls } from './share.js';
import { installAgentExtras } from './agent-extras.js';
import { installSystemNotifications } from './system-notify.js';
import { installFlywheelPanel } from './flywheel-panel.js';
import { installSimMotives } from './sim-motives.js';
import { installSimOverlays } from './sim-overlays.js';
import { installSimFlywheelViz } from './sim-flywheel-viz.js';
import { installSimAdvisor } from './sim-advisor.js';
import { installBoardDetail } from './board-detail.js';
import { initOptionalWebGPU, parseBenchConfig, rendererBadgeLabel } from './webgpu-stage.js';
import { installReplayScrubber } from './replay-scrubber.js';
import { initLabs } from './labs.js';
import { createFirstRun } from './empty-state.js';
import { installStaticText } from './static-text.js';

const cfg = { speed: 1, intervalMs: 250 };
const labs = initLabs(); // 관리자용 도구(D10). Hud 가 설정을 읽기 전에: ?labs=1 을 같은 설정에 저장한다
const stage = createStage(document.getElementById('stage'));
const rendererInfo = await initOptionalWebGPU(stage);
const hud = new Hud();
if (rendererInfo.requested === 'webgpu') hud.rendererNote = (lang) => rendererBadgeLabel(rendererInfo, lang);
const office = new Office(stage, hud);
stage.applyTheme();

const emit = (ev) => office.onEvent(ev);
let source = null;
let scrubber = null;
let firstRun = null; // 라이브 모드의 첫 실행 조종기 (empty-state.js): 세션이 없으면 라이브 연결 위에 데모를 겹쳐 보여 준다

function startDemo(state = 'demo') {
  if (source instanceof MockSource) return;
  source?.stop?.();
  firstRun = null;
  source = new MockSource(emit);
  source.onBatch = (n) => hud.flashTail(n);
  hud.setLive(false);
  hud.setSource(state);
}

// 로컬 서버(localhost)에서 열리면 라이브, 그 밖(아티팩트 등)에서는 데모. #demo 로 강제할 수 있다.
// #bench / #bench-20x6 / ?bench=1&floors=20&mains=4&subs=2: 성능 측정용 합성 부하. bench.js 는 이때만 불러온다.
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
const benchCfg = parseBenchConfig(window.location.search, window.location.hash);
const benchMode = benchCfg.enabled;
if (benchMode) {
  const { BenchSource } = await import('./bench.js');
  source = new BenchSource(emit, { floors: benchCfg.floors, mains: benchCfg.mains, subs: benchCfg.subs });
  hud.setLive(true);
  hud.setSource('demo');
  source.start();
} else if (local && window.location.hash !== '#demo') {
  // 겹쳐 보여 주는 데모(D6): source 는 끝까지 LiveSource 이고, 데모 공급원은 조종기가 만들고 돌리고 버린다.
  // 데모 이벤트에는 demo 표시를 단다: 알림(system-notify.js)이 진짜 질문으로 알리지 않게.
  const makeDemo = () => {
    const demo = new MockSource((ev) => emit({ ...ev, demo: true }));
    demo.onBatch = (n) => hud.flashTail(n);
    return demo;
  };
  firstRun = createFirstRun({ office, hud, makeDemo });
  source = new LiveSource((ev) => firstRun.onEvent(ev), (state) => (state === 'down' ? startDemo('down') : firstRun.onStatus(state)));
  // partial: 서버가 아직 파일을 붙이는 중이라 빠진 세션이 있을 수 있다는 표시(있으면 퇴근시키지 않는다).
  // 데모가 도는 동안의 빈 스냅샷은 조종기가 사무실에 넘기지 않는다 (false).
  source.onSnapshot = (events, msg) => {
    if (firstRun.onSnapshot(events, msg) && msg?.reset) scrubber?.onReset?.();
  };
  source.onConfig = (msg) => { hud.applyConfig(cfg, msg); firstRun.onConfig(msg); scrubber?.applyConfig?.(msg); };
  source.onReplay = (msg) => { hud.setReplay(msg); scrubber?.applyReplay?.(msg); };
  const wantObserve = new URLSearchParams(window.location.search).has('observe') || window.location.hash === '#observe';
  source.onObserve = (msg) => { if (wantObserve || msg?.running) hud.observe.apply(msg); }; // 기록 관찰 상태(?observe=1 또는 실행 중일 때만 표시)
  source.onBatch = (n) => hud.flashTail(n);
  hud.setLive(true);
  hud.setSource('retry');
  source.start();
} else {
  startDemo();
}
// hud 가 부르는 공급원 조작: tail 간격은 라이브 서버로, 언어는 데모 공급원(단독 데모든 겹친 데모든)으로 간다
const sourceControls = {
  setInterval: (ms) => source?.setInterval?.(ms),
  setLang: (lang) => { source?.setLang?.(lang); firstRun?.setLang(lang); },
};
hud.bind(office, cfg, () => sourceControls);
installStaticText({ hud });
// 데모 모드(호스팅 페이지, #demo, 서버 없음)에서는 /api/notify 와 /api/flywheel 을 부르지 않는다: 부를 서버가 없다
const isLive = () => source instanceof LiveSource;
installShareControls({ stage, hud });
const extras = installAgentExtras({ stage, office, hud, THREE });
installSystemNotifications({ office, hud, isLive });
installFlywheelPanel({ hud, source, isLive, labs });
installSimMotives({ office, hud, extras, THREE });
const overlays = installSimOverlays({ office, hud, extras, THREE, labs });
const flywheelViz = installSimFlywheelViz({ office, hud, source, overlays, THREE, isLive, labs });
installSimAdvisor({ office, hud, extras, overlays, flywheelViz });

let down = null;
const canvas = stage.renderer.domElement;
const boardDetail = installBoardDetail({ office, hud, stage, canvas });
scrubber = installReplayScrubber({ office, hud, boardDetail });
const ndcOf = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
};
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
});
window.addEventListener('pointerup', () => canvas.classList.remove('dragging'));
canvas.addEventListener('pointermove', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  const ndc = ndcOf(e);
  canvas.classList.toggle('hovering', !!(office.hitAgent(ndc) || boardDetail.hitBoard(ndc)));
});
canvas.addEventListener('pointerup', (e) => {
  const d = down;
  down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
  const ndc = ndcOf(e);
  const hitA = office.hitAgent(ndc);
  if (hitA) {
    office.select(hitA);
    return;
  }
  const hitB = boardDetail.hitBoard(ndc);
  if (hitB) {
    boardDetail.openFloorBoard(hitB);
    return;
  }
  office.select(null);
});
canvas.addEventListener('dblclick', (e) => {
  const ndc = ndcOf(e);
  const hit = office.hitAgent(ndc);
  if (hit) {
    if (hit.floor.index !== office.focusIndex || office.overview) office.focus(hit.floor.index);
    office.select(hit, { focusPan: true });
    return;
  }
  const hitB = boardDetail.hitBoard(ndc);
  if (hitB) {
    if (hitB.index !== office.focusIndex || office.overview) office.focus(hitB.index);
    boardDetail.openFloorBoard(hitB);
  } else {
    office.follow = false;
    office.layout({ snapPan: true });
    stage.resetView();
    if (office.selected) hud.inspect(office.selected, office);
  }
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
  firstRun?.tick(dt, realDt, cfg.intervalMs);
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
// 디버깅용: 콘솔에서 officeSim.emit({...}) 로 이벤트를 직접 넣어 볼 수 있다.
window.officeSim = { office, emit, cfg, stage, rendererInfo };
