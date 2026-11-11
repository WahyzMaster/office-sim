// --cdn (launch readiness D4): the switch, its USAGE line, the bin passing it on to the page CSP, and the reason the
// page shows when the opt-in WebGPU renderer cannot be loaded without it. The bin runs on port 0 with a temp HOME and
// a temp --claude-root; nothing outside os.tmpdir() is read or written and no browser is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { pageCsp, cspCache } from '../src/server-guard.mjs';
import { initOptionalWebGPU, rendererBadgeLabel } from '../public/js/webgpu-stage.js';
import { request } from './fixtures/sse.mjs';

const BIN = fileURLToPath(new URL('../bin/office-sim.mjs', import.meta.url));
const CDN = 'https://cdn.jsdelivr.net';
const HANGUL = /[가-힣]/;

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

test('parseArgs --cdn is a switch: no value, no key without the flag; USAGE lists it', () => {
  assert.deepEqual(parseArgs(['--cdn']), { cdn: true });
  assert.deepEqual(parseArgs(['--cdn', '--port', '0']), { cdn: true, port: 0 });
  assert.deepEqual(parseArgs(['--port', '0']), { port: 0 });
  assert.throws(() => parseArgs(['--cdn=1']), /--cdn takes no value/);
  assert.throws(() => parseArgs(['--cdn', 'yes']), /unexpected argument: yes/);
  assert.match(USAGE, /\n {2}--cdn {16}\S/, 'USAGE: --cdn in the option column');
  const line = USAGE.split('\n').find((l) => l.startsWith('  --cdn '));
  assert.match(line, /cdn\.jsdelivr\.net/);
  assert.match(line, /renderer=webgpu/);
  const auth = USAGE.indexOf('  --auth ');
  const cdn = USAGE.indexOf('  --cdn ');
  const open = USAGE.indexOf('  --open ');
  assert.ok(auth >= 0 && cdn > auth && open > cdn, 'USAGE: --cdn sits with the page switches, after --auth');
});

test('pageCsp: the CDN is in script-src only when asked for, and the cache keeps the choice', () => {
  const html = '<script type="importmap">{}</script><script>var a = 1;</script>';
  const scriptSrc = (csp) => csp.split('; ').find((d) => d.startsWith('script-src ')).split(' ').slice(1);
  assert.equal(pageCsp(html).includes('https:'), false);
  assert.equal(pageCsp(html, { cdn: false }), pageCsp(html));
  assert.equal(scriptSrc(pageCsp(html)).length, 3, "'self' and two hashes");
  assert.deepEqual(scriptSrc(pageCsp(html, { cdn: true })).slice(0, 2), ["'self'", CDN]);
  assert.equal(pageCsp(html, { cdn: true }).replace(` ${CDN}`, ''), pageCsp(html), 'nothing else differs');
  const plain = cspCache();
  const withCdn = cspCache({ cdn: true });
  assert.equal(plain(html), pageCsp(html));
  assert.equal(withCdn(html), pageCsp(html, { cdn: true }));
  assert.equal(withCdn(`${html}<script>var b = 2;</script>`).includes(CDN), true, 'still on after the page text changes');
});

// node start + server start is real, slow work on a loaded runner: generous bounds, as in test/open-url.test.mjs
const READY_MS = 15000;
const STOP_MS = 10000;
function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// the bin on a free port with every root inside a temp home; resolves with the port once the agents line is out
async function runBin(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-cdn-'));
  tmpDirs.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CI: '1' };
  const child = spawn(process.execPath, [BIN, '--port', '0', '--claude-root', home, '--agents', 'claude-code', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  let err = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('office-sim: agents')) resolve();
    });
    exited.then((code) => reject(new Error(`office-sim exited (${code}) before the agents line`)));
    child.on('error', reject);
  });
  child.stderr.on('data', (c) => { err += c; });
  const killAndThrow = async (e) => {
    child.kill('SIGKILL');
    await within(exited, STOP_MS, 'office-sim exit after SIGKILL').catch(() => {});
    throw new Error(`${e.message}\nstderr: ${err}`);
  };
  await within(ready, READY_MS, 'office-sim agents line').catch(killAndThrow);
  const port = Number(new URL(out.split('\n')[0].replace(/^office-sim: /, '')).port);
  const stop = async () => {
    child.kill('SIGTERM');
    const code = await within(exited, STOP_MS, 'office-sim exit after SIGTERM').catch(killAndThrow);
    assert.equal(code, 0, err);
  };
  return { port, stop, killAndThrow };
}

test('bin --cdn reaches the page CSP; without the flag the page names no other host', async () => {
  for (const [args, wantCdn] of [[['--cdn'], true], [[], false]]) {
    const run = await runBin(args);
    try {
      const r = await within(request(run.port), STOP_MS, 'GET /');
      assert.equal(r.status, 200);
      const csp = r.headers['content-security-policy'];
      const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src ')).split(' ');
      assert.equal(scriptSrc.includes(CDN), wantCdn, `script-src with ${args.join(' ') || 'no flag'}`);
      assert.equal((csp.match(/https?:/g) ?? []).length, wantCdn ? 1 : 0, csp);
    } catch (e) {
      await run.killAndThrow(e);
    }
    await run.stop();
  }
});

// ---- the page side: why ?renderer=webgpu fell back -------------------------------------------------------------

const gpuNav = { gpu: { requestAdapter: async () => ({}) } };
function makeStage() {
  const seen = { info: null, swapped: null };
  return { seen, setRendererInfo(info) { seen.info = info; }, swapRenderer(r, info) { seen.swapped = { r, info }; } };
}

test('a WebGPU renderer that cannot be loaded settles to WebGL2 with a short reason naming --cdn, in Korean and English', async () => {
  const blockedByCsp = async () => {
    throw new TypeError('Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/renderers/webgpu/WebGPURenderer.js');
  };
  const cases = [
    ['the import is refused (the default CSP)', { loadWebGPU: blockedByCsp }],
    ['the loader throws at once', { loadWebGPU: () => { throw new Error('boom'); } }],
    ['the import never answers', { loadWebGPU: () => new Promise(() => {}), timeoutMs: 25 }],
  ];
  // the module's own import(): in Node nothing maps three/addons/ (no importmap, zero dependencies), so it fails as it
  // does behind the default CSP. Skipped only if some node_modules above the checkout happens to hold three.
  let resolvable = true;
  try {
    import.meta.resolve('three/addons/renderers/webgpu/WebGPURenderer.js');
  } catch {
    resolvable = false;
  }
  if (!resolvable) cases.push(['the real import() with nothing to resolve three/addons/', {}]);
  for (const [what, opts] of cases) {
    const stage = makeStage();
    const info = await initOptionalWebGPU(stage, { search: '?renderer=webgpu', hash: '', nav: gpuNav, ...opts });
    assert.equal(info.requested, 'webgpu', what);
    assert.equal(info.active, 'webgl2', what);
    assert.match(info.fallbackReason, /--cdn/, what);
    assert.doesNotMatch(info.fallbackReason, /https?:|jsdelivr|Failed to fetch|boom/, `${what}: no URL or raw error text`);
    assert.ok(info.fallbackReason.length <= 80, `${what}: short`);
    assert.equal(stage.seen.swapped, null, what);
    assert.equal(stage.seen.info, info, `${what}: the stage gets the same info`);
    const en = rendererBadgeLabel(info, 'en');
    const ko = rendererBadgeLabel(info, 'ko');
    assert.match(en, /^WebGL2 fallback \(.*--cdn.*\)$/, what);
    assert.doesNotMatch(en, HANGUL, `${what}: the English label has no Korean`);
    assert.match(ko, /^WebGL2 대체 \(.*--cdn.*\)$/, what);
    assert.match(ko.replace('WebGL2 대체', ''), HANGUL, `${what}: the Korean reason is in Korean`);
  }
});

test('other WebGPU outcomes keep their own reason and never name --cdn', async () => {
  class FailingRenderer {
    constructor() { this.domElement = { tagName: 'CANVAS' }; }
    async init() { throw new Error('device lost during init'); }
  }
  const failed = await initOptionalWebGPU(makeStage(), { search: '?renderer=webgpu', nav: gpuNav, loadWebGPU: async () => ({ default: FailingRenderer }) });
  assert.deepEqual(failed, { requested: 'webgpu', active: 'webgl2', fallbackReason: 'device lost during init' });
  assert.equal(rendererBadgeLabel(failed, 'en'), 'WebGL2 fallback (device lost during init)');
  const noCtor = await initOptionalWebGPU(makeStage(), { search: '?renderer=webgpu', nav: gpuNav, loadWebGPU: async () => ({ default: 42 }) });
  assert.deepEqual(noCtor, { requested: 'webgpu', active: 'webgl2', fallbackReason: 'WebGPURenderer constructor unavailable' });
  const noGpu = await initOptionalWebGPU(makeStage(), { search: '?renderer=webgpu', nav: {} });
  assert.doesNotMatch(noGpu.fallbackReason, /--cdn/);
  assert.doesNotMatch(rendererBadgeLabel(noGpu, 'ko'), /--cdn/);
  assert.deepEqual(await initOptionalWebGPU(makeStage(), { search: '', hash: '', nav: null }), { requested: 'webgl2', active: 'webgl2', fallbackReason: null });
});
