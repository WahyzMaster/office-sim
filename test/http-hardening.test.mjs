// HTTP hardening (2026-10-19 findings 5/32 and 6): oversized POST /config gets a clean 413; CSP, frame and
// resource-policy headers; Sec-Fetch-Site guard on the data routes. Fake deps only, no transcript is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { request, sse } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const DEPS = { Tailer: NullTailer, scan: async () => [], readSubMeta: async () => null, readJournalLabels: async () => new Map() };

async function withApp(fn, over = {}) {
  const app = await start({ port: 0, root: '/nonexistent-office-sim-root', publicDir: PUBLIC, deps: DEPS, ...over });
  try {
    await app.ready;
    await fn(app);
  } finally {
    await app.close();
  }
}
const json = { 'content-type': 'application/json' };
const padded = (n) => {
  const base = JSON.stringify({ intervalMs: 300, pad: '' });
  return base.replace('"pad":""', `"pad":"${'x'.repeat(n - base.length)}"`);
};

// Raw socket: what a client that ignores early responses sees (status line, or a reset).
function rawPost(port, body) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('error', (err) => resolve({ data, err: err.code }));
    sock.on('close', () => resolve({ data, err: null }));
    sock.write(`POST /config HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    sock.end(body);
  });
}

// ---- 5 / 32: 413 instead of a connection reset ------------------------------------------------------------

test('POST /config over 4096 bytes answers 413 {error:"body too large"} (chunked, content-length, raw socket)', async () => {
  await withApp(async ({ port }) => {
    const post = (body, headers = {}) => request(port, { method: 'POST', path: '/config', headers: { ...json, ...headers }, body });
    const ok = await post(padded(4000));
    assert.equal(ok.status, 200, 'a 4000-byte body is accepted');
    for (const n of [4097, 5000, 100_000]) {
      const body = padded(n);
      const chunked = await post(body); // no content-length: the overflow is found while reading
      assert.equal(chunked.status, 413, `chunked ${n}`);
      assert.deepEqual(JSON.parse(chunked.body), { error: 'body too large' });
      const sized = await post(body, { 'content-length': String(Buffer.byteLength(body)) }); // rejected before reading
      assert.equal(sized.status, 413, `content-length ${n}`);
      assert.deepEqual(JSON.parse(sized.body), { error: 'body too large' });
    }
    const raw = await rawPost(port, padded(5000));
    assert.match(raw.data, /^HTTP\/1\.1 413 /, `raw socket: ${raw.err ?? raw.data.slice(0, 40)}`);
    assert.equal(JSON.parse((await request(port, { path: '/config' })).body).intervalMs, 300, 'oversized posts change nothing');
    assert.equal((await post(JSON.stringify({ intervalMs: 400 }))).status, 200, 'the server still answers afterwards');
  });
});

// ---- 6: CSP, frame-ancestors, CORP and the Sec-Fetch-Site guard ------------------------------------------

const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const inlineScripts = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);
const directives = (csp) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...vals] = d.split(/\s+/);
  return [name, vals];
}));

// The fixed part of the page CSP: everything but script-src, which also carries one hash per inline script.
const FIXED_CSP = Object.freeze({
  'default-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'none'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
});
const CDN = 'https://cdn.jsdelivr.net';

test('GET / sends a CSP that allows exactly its inline scripts and same-origin loads: no CDN, no font host; no framing', async () => {
  await withApp(async ({ port }) => {
    const r = await request(port);
    assert.equal(r.status, 200);
    const header = r.headers['content-security-policy'] ?? '';
    const csp = directives(header);
    const scripts = inlineScripts(r.body);
    assert.ok(scripts.length >= 2, 'the importmap and the boot-timeout script are inline');
    // exact: 'self' and the hashes, nothing else (no CDN host, no 'unsafe-inline')
    assert.deepEqual(csp.get('script-src'), ["'self'", ...scripts.map(sha)]);
    for (const [name, want] of Object.entries(FIXED_CSP)) assert.deepEqual(csp.get(name), want, name);
    assert.deepEqual([...csp.keys()].sort(), ['script-src', ...Object.keys(FIXED_CSP)].sort(), 'no other directive');
    // the default page may contact loopback only: no host of any kind is named
    assert.doesNotMatch(header, /https?:|jsdelivr|googleapis|gstatic/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });
});

test('cdn: true (--cdn) adds the pinned CDN to script-src and changes nothing else', async () => {
  await withApp(async ({ port }) => {
    const r = await request(port);
    assert.equal(r.status, 200);
    const csp = directives(r.headers['content-security-policy'] ?? '');
    assert.deepEqual(csp.get('script-src'), ["'self'", CDN, ...inlineScripts(r.body).map(sha)]);
    for (const [name, want] of Object.entries(FIXED_CSP)) assert.deepEqual(csp.get(name), want, name);
    assert.deepEqual([...csp.keys()].sort(), ['script-src', ...Object.keys(FIXED_CSP)].sort(), 'no other directive');
    // script-src only: styles, fonts and connects stay on loopback
    assert.equal((r.headers['content-security-policy'].match(/https?:/g) ?? []).length, 1);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  }, { cdn: true });
  await assert.rejects(start({ port: 0, root: '/nonexistent-office-sim-root', publicDir: PUBLIC, deps: DEPS, cdn: 'yes' }), /cdn must be a boolean/);
});

// ---- GET /vendor/<name>: the vendored three.js files (D4), flat names, .js and .txt only -------------------

test('GET /vendor/<name> serves the vendored files with the /js/ policy (type, no-cache, base headers)', async () => {
  await withApp(async ({ port }) => {
    for (const [name, type] of [
      ['three.module.min.js', 'text/javascript; charset=utf-8'], ['OrbitControls.js', 'text/javascript; charset=utf-8'],
      ['CSS2DRenderer.js', 'text/javascript; charset=utf-8'], ['LICENSE-three.txt', 'text/plain; charset=utf-8'],
    ]) {
      const r = await request(port, { path: `/vendor/${name}` });
      const file = fs.readFileSync(path.join(PUBLIC, 'vendor', name));
      assert.equal(r.status, 200, name);
      assert.equal(r.headers['content-type'], type, name);
      assert.equal(r.headers['content-length'], String(file.length), name);
      assert.ok(Buffer.from(r.body, 'utf8').equals(file), `${name}: the bytes on disk`);
    }
    const js = await request(port, { path: '/js/main.js' });
    const vendored = await request(port, { path: '/vendor/OrbitControls.js', headers: { 'sec-fetch-site': 'same-origin' } });
    for (const h of ['cache-control', 'x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'content-type']) {
      assert.equal(vendored.headers[h], js.headers[h], `${h} as for /js/`);
    }
    assert.equal(vendored.headers['cache-control'], 'no-cache');
    assert.equal(vendored.headers['content-security-policy'], undefined, 'the CSP belongs to the page');
    const head = await request(port, { method: 'HEAD', path: '/vendor/OrbitControls.js' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], vendored.headers['content-length']);
    const post = await request(port, { method: 'POST', path: '/vendor/OrbitControls.js' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal((await request(port, { path: '/vendor/OrbitControls.js', headers: { host: 'evil.example' } })).status, 403);
  });
  // --auth covers the route like every other one
  await withApp(async ({ port, token }) => {
    assert.equal((await request(port, { path: '/vendor/OrbitControls.js' })).status, 401);
    const ok = await request(port, { path: '/vendor/OrbitControls.js', headers: { cookie: `osim_${port}=${token}` } });
    assert.equal(ok.status, 200);
  }, { auth: true });
});

test('GET /vendor/ is an allowlist: traversal is 400, other extensions, nested or hidden names and misses are 404', async () => {
  // a synthetic public dir whose vendor/ holds files the route must not serve even though they exist
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-vendor-'));
  try {
    fs.mkdirSync(path.join(dir, 'vendor', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'office.html'), '<title>Fake</title>\n');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside vendor\n');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), 'export const x = 1;\n');
    for (const rel of ['ok.module.min.js', 'Notes-1.txt', 'page.html', 'data.json', 'style.css', 'map.js.map', '.hidden.js',
      'noext', 'two..dots.js', '-dash.js', 'under_score.js', 'sp ace.js', 'sub/inner.js']) {
      fs.writeFileSync(path.join(dir, 'vendor', rel), `// ${rel}\n`);
    }
    await withApp(async ({ port }) => {
      const status = async (p) => (await request(port, { path: p })).status;
      assert.equal(await status('/vendor/ok.module.min.js'), 200);
      assert.equal(await status('/vendor/Notes-1.txt'), 200);
      assert.equal(await status('/vendor/ok.module.min.js?v=1'), 200, 'a query does not change the file');
      for (const p of ['/vendor/../secret.txt', '/vendor/../office.html', '/vendor/..%2fsecret.txt', '/vendor/%2e%2e/secret.txt',
        '/vendor/sub/../ok.module.min.js', '/vendor/sub%2finner.js', '/vendor/sub\\inner.js', '/vendor/two..dots.js']) {
        assert.equal(await status(p), 400, `${p} is a bad path`);
      }
      for (const p of ['/vendor/page.html', '/vendor/data.json', '/vendor/style.css', '/vendor/map.js.map', '/vendor/.hidden.js',
        '/vendor/noext', '/vendor/-dash.js', '/vendor/under_score.js', '/vendor/sp%20ace.js', '/vendor/sub/inner.js',
        '/vendor/sub', '/vendor/', '/vendor', '/vendor/missing.js', '/vendor/ok.module.min.js/', '/vendor//ok.module.min.js',
        '/vendor/ok.module.min.js%00', '/vendor/OK.MODULE.MIN.JS.TXT.exe', '/vendorx/ok.module.min.js', '/js/vendor/ok.module.min.js']) {
        assert.equal(await status(p), 404, `${p} is not served`);
      }
    }, { publicDir: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every response carries nosniff, no-referrer and same-origin CORP (pages, data, errors, SSE)', async () => {
  await withApp(async ({ port }) => {
    const responses = [
      await request(port), await request(port, { path: '/js/main.js' }), await request(port, { path: '/state' }),
      await request(port, { path: '/config' }), await request(port, { path: '/healthz' }), await request(port, { path: '/nope' }),
      await request(port, { headers: { host: 'evil.example' } }), await request(port, { method: 'PUT' }),
      await request(port, { method: 'POST', path: '/config', headers: json, body: padded(5000) }),
    ];
    const es = await sse(port);
    responses.push({ status: es.res.statusCode, headers: es.res.headers });
    es.close();
    for (const r of responses) {
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `status ${r.status}`);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', `status ${r.status}`);
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', `status ${r.status}`);
    }
  });
});

test('/events, /state and /config reject Sec-Fetch-Site cross-site and same-site; same-origin, none and absent pass', async () => {
  await withApp(async ({ port }) => {
    const hit = async (route, site) => {
      const headers = site ? { 'sec-fetch-site': site } : {};
      if (route === 'POST /config') {
        return (await request(port, { method: 'POST', path: '/config', headers: { ...json, ...headers }, body: JSON.stringify({ intervalMs: 300 }) })).status;
      }
      if (route === '/events') {
        const es = await sse(port, headers);
        const st = es.res.statusCode;
        es.close();
        return st;
      }
      return (await request(port, { path: route, headers })).status;
    };
    for (const route of ['/events', '/state', '/config', 'POST /config']) {
      for (const site of ['cross-site', 'same-site']) assert.equal(await hit(route, site), 403, `${route} ${site}`);
      for (const site of ['same-origin', 'none', null]) assert.equal(await hit(route, site), 200, `${route} ${site ?? 'absent'}`);
    }
    assert.equal((await request(port, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'a top-level navigation to / still loads');
  });
});
