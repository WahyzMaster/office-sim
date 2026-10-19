// HTTP hardening (2026-10-19 findings 5/32 and 6): oversized POST /config gets a clean 413; CSP, frame and
// resource-policy headers; Sec-Fetch-Site guard on the data routes. Fake deps only, no transcript is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';
import { request, sse } from './fixtures/sse.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
class NullTailer { async readAll() { return { offset: 0 }; } async poll() { return { bytes: 0 }; } forget() {} }
const DEPS = { Tailer: NullTailer, scan: async () => [], readSubMeta: async () => null, readJournalLabels: async () => new Map() };

async function withApp(fn, over = {}) {
  const app = await start({ port: 0, root: '/nonexistent-claude-office-root', publicDir: PUBLIC, deps: DEPS, ...over });
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

test('GET / sends a CSP that allows exactly its inline scripts, the CDN, fonts and same-origin connects; no framing', async () => {
  await withApp(async ({ port }) => {
    const r = await request(port);
    assert.equal(r.status, 200);
    const csp = directives(r.headers['content-security-policy'] ?? '');
    const scripts = inlineScripts(r.body);
    assert.ok(scripts.length >= 2, 'the importmap and the boot-timeout script are inline');
    assert.deepEqual(csp.get('default-src'), ["'self'"]);
    const scriptSrc = csp.get('script-src') ?? [];
    for (const v of ["'self'", 'https://cdn.jsdelivr.net', ...scripts.map(sha)]) assert.ok(scriptSrc.includes(v), `script-src has ${v}`);
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
    assert.deepEqual(csp.get('style-src'), ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
    assert.deepEqual(csp.get('font-src'), ['https://fonts.gstatic.com']);
    assert.deepEqual(csp.get('img-src'), ["'self'", 'data:', 'blob:']);
    assert.deepEqual(csp.get('connect-src'), ["'self'"]);
    assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
    assert.deepEqual(csp.get('base-uri'), ["'none'"]);
    assert.deepEqual(csp.get('form-action'), ["'none'"]);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });
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
