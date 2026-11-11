// WebGPU progressive enhancement, WebGL2 fallback, and high-concurrency LOD/bench tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDERER_BACKENDS, resolveRendererRequest, probeWebGPU, requestWebGPUAdapter,
  parseBenchConfig, rendererBadgeLabel, initOptionalWebGPU,
} from '../public/js/webgpu-stage.js';
import { floorDetail, crowdStride, lodTier } from '../public/js/detail.js';

test('resolveRendererRequest: defaults to webgl2 and opts into webgpu via query or hash', () => {
  assert.deepEqual([...RENDERER_BACKENDS], ['webgl2', 'webgpu']);
  assert.equal(resolveRendererRequest('', ''), 'webgl2');
  assert.equal(resolveRendererRequest('?renderer=webgpu', ''), 'webgpu');
  assert.equal(resolveRendererRequest('?renderer=gpu', ''), 'webgpu');
  assert.equal(resolveRendererRequest('?renderer=webgl2', '#webgpu'), 'webgl2');
  assert.equal(resolveRendererRequest('', '#webgpu'), 'webgpu');
  assert.equal(resolveRendererRequest('', '#bench,webgpu'), 'webgpu');
});

test('probeWebGPU and requestWebGPUAdapter: safely detect or report unavailable navigator.gpu', async () => {
  assert.equal(probeWebGPU(null), false);
  assert.equal(probeWebGPU({}), false);
  assert.equal(probeWebGPU({ gpu: {} }), false);
  assert.equal(probeWebGPU({ gpu: { requestAdapter: async () => ({}) } }), true);

  const missing = await requestWebGPUAdapter({});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /navigator\.gpu/);

  const nullAdapter = await requestWebGPUAdapter({ gpu: { requestAdapter: async () => null } });
  assert.equal(nullAdapter.ok, false);
  assert.match(nullAdapter.reason, /no WebGPU adapter/);

  const rejected = await requestWebGPUAdapter({
    gpu: { requestAdapter: async () => { throw new Error('adapter blocked'); } },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /adapter blocked/);

  const ok = await requestWebGPUAdapter({ gpu: { requestAdapter: async () => ({ name: 'mock-gpu' }) } });
  assert.equal(ok.ok, true);
  assert.equal(ok.adapter.name, 'mock-gpu');
});

test('initOptionalWebGPU: keeps webgl2 by default, upgrades when supported, and falls back cleanly on error', async () => {
  let infoState = null;
  let swapped = null;
  const makeStage = () => ({
    setRendererInfo(info) { infoState = info; },
    swapRenderer(r, info) { swapped = { r, info }; },
  });

  // 1) Default (not requested) -> instant WebGL2 without touching navigator.gpu
  const def = await initOptionalWebGPU(makeStage(), { search: '', hash: '', nav: null });
  assert.deepEqual(def, { requested: 'webgl2', active: 'webgl2', fallbackReason: null });
  assert.equal(swapped, null);

  // 2) Requested, no navigator.gpu -> clean fallback to WebGL2
  const noGpu = await initOptionalWebGPU(makeStage(), { search: '?renderer=webgpu', nav: {} });
  assert.equal(noGpu.requested, 'webgpu');
  assert.equal(noGpu.active, 'webgl2');
  assert.match(noGpu.fallbackReason, /navigator\.gpu/);
  assert.equal(swapped, null);

  // 2b) Requested, navigator.gpu.requestAdapter hangs -> bounded by timeoutMs and falls back to WebGL2
  const hungAdapter = await initOptionalWebGPU(makeStage(), {
    search: '?renderer=webgpu',
    timeoutMs: 25,
    nav: { gpu: { requestAdapter: () => new Promise(() => {}) } },
  });
  assert.equal(hungAdapter.active, 'webgl2');
  assert.match(hungAdapter.fallbackReason, /timed out/i);
  assert.equal(swapped, null);

  // 3) Requested, WebGPU init throws -> disposes candidate renderer and keeps WebGL2
  let disposed = false;
  class FailingWebGPURenderer {
    constructor() { this.domElement = { tagName: 'CANVAS' }; }
    async init() { throw new Error('device lost during init'); }
    dispose() { disposed = true; }
  }
  const failed = await initOptionalWebGPU(makeStage(), {
    search: '?renderer=webgpu',
    nav: { gpu: { requestAdapter: async () => ({}) } },
    loadWebGPU: async () => ({ default: FailingWebGPURenderer }),
  });
  assert.equal(failed.active, 'webgl2');
  assert.match(failed.fallbackReason, /device lost/);
  assert.equal(disposed, true);
  assert.equal(swapped, null);

  // 4) Requested, WebGPU succeeds -> swaps stage renderer and reports active: webgpu
  let inited = false;
  class MockWebGPURenderer {
    constructor(opts) {
      this.opts = opts;
      this.domElement = { tagName: 'CANVAS' };
      this.shadowMap = { enabled: false };
    }
    setPixelRatio(r) { this.pixelRatio = r; }
    async init() { inited = true; }
  }
  const upgraded = await initOptionalWebGPU(makeStage(), {
    hash: '#webgpu',
    pixelRatio: 1.5,
    nav: { gpu: { requestAdapter: async () => ({}) } },
    loadWebGPU: async () => ({ WebGPURenderer: MockWebGPURenderer }),
  });
  assert.deepEqual(upgraded, { requested: 'webgpu', active: 'webgpu', fallbackReason: null });
  assert.equal(inited, true);
  assert.equal(swapped.r.pixelRatio, 1.5);
  assert.equal(swapped.r.shadowMap.enabled, true);
  assert.deepEqual(infoState, upgraded);
  assert.equal(rendererBadgeLabel(upgraded, 'en'), 'WebGPU active');
  assert.match(rendererBadgeLabel(failed, 'ko'), /WebGL2 대체/);
});

test('parseBenchConfig and high-concurrency LOD: scales to 20+ floors and 100+ concurrent subagents', () => {
  assert.deepEqual(parseBenchConfig('', ''), { enabled: false, floors: 10, mains: 4, subs: 2, totalAgents: 60 });
  assert.deepEqual(parseBenchConfig('', '#bench'), { enabled: true, floors: 10, mains: 4, subs: 2, totalAgents: 60 });
  assert.deepEqual(
    parseBenchConfig('?floors=22&mains=4&subs=2', '#bench'),
    { enabled: true, floors: 22, mains: 4, subs: 2, totalAgents: 132 },
  );
  assert.deepEqual(
    parseBenchConfig('', '#bench-20x6'),
    { enabled: true, floors: 20, mains: 4, subs: 2, totalAgents: 120 },
  );

  // High-concurrency load ratchets (22 floors, 132 concurrent agents)
  const highLoad = { agentCount: 132, floorCount: 22 };
  assert.deepEqual(
    floorDetail(10, 10, true, highLoad),
    { visible: true, labels: false, shadows: false, animate: true },
    'overview disables shadows and CSS label flood at 100+ agents / 20+ floors',
  );
  assert.deepEqual(
    floorDetail(10, 10, false, highLoad),
    { visible: true, labels: true, shadows: true, animate: true },
    'focused floor preserves full detail at 132 agents',
  );
  assert.deepEqual(
    floorDetail(9, 10, false, highLoad),
    { visible: true, labels: false, shadows: false, animate: false },
    'immediately adjacent lower floor stays visible without skeletal animation under heavy load',
  );
  assert.deepEqual(
    floorDetail(2, 10, false, highLoad),
    { visible: false, labels: false, shadows: false, animate: false },
    'deeply buried floors (>4 below focus) cull geometry at 100+ agents / 20+ floors',
  );

  assert.equal(crowdStride(24, false), 1);
  assert.equal(crowdStride(80, true), 1);
  assert.equal(crowdStride(80, false), 2);
  assert.equal(crowdStride(132, true), 2);
  assert.equal(crowdStride(132, false), 4);
  assert.deepEqual([0, 63, 64, 99, 100, 159, 160].map(lodTier), [0, 0, 1, 1, 2, 2, 3]);
});
