// HTTP 라우팅 + SSE 허브 (contract 6). 상태는 Store 에만 있고 여기서는 읽기/전달만 한다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cspCache, crossSiteFetch, createAuth } from './server-guard.mjs';

const HEAD = '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  + '<style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>';
const TAIL = '</body></html>';
const JS_RE = /^\/js\/([a-z0-9_-]+)\.js$/;
const MAX_BODY = 4096;
const DRAIN_LIMIT = 1024 * 1024; // 413 뒤에 버리며 읽는 상한: 넘게 보내면 연결을 끊는다
const DATA_ROUTES = new Set(['/events', '/state', '/config']); // Sec-Fetch-Site 로 교차 사이트 요청을 거른다
const MAX_BUFFERED = 8 * 1024 * 1024; // 느린 클라이언트는 끊고 Last-Event-ID 로 다시 붙게 한다
export const MIN_INTERVAL = 50;
export const MAX_INTERVAL = 5000;

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, 'content-length': buf.length, ...extra });
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
}

function sseFrame(seq, msg) {
  return `id: ${seq}\ndata: ${JSON.stringify(msg)}\n\n`;
}

export function validInterval(v) {
  return Number.isInteger(v) && v >= MIN_INTERVAL && v <= MAX_INTERVAL;
}

// 너무 큰 본문: 413 을 먼저 보내고 나머지는 버리며 읽는다. 바로 끊으면 읽지 않은 데이터 때문에 커널이 RST 를 보내
// 클라이언트가 413 을 받지 못한다. 끝없이 보내는 클라이언트는 DRAIN_LIMIT 에서 끊는다.
function discardRest(req, already = 0) {
  let drained = already;
  req.on('data', (c) => {
    drained += c.length;
    if (drained > DRAIN_LIMIT) req.destroy();
  });
  req.resume();
}

const tooLarge = () => Object.assign(new Error('body too large'), { status: 413 });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData); // 더 모으지 않는다 (늦은 'end' 의 resolve 는 이미 끝난 promise 라 무해하다)
        discardRest(req, size);
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ store, publicDir: string, pingMs: number, getPort: () => number,
 *           getConfig: () => object, setConfig: (patch) => object, stats: () => object, log: Function }} o
 */
export function createHttp({ store, publicDir, pingMs, getPort, getConfig, setConfig, stats, authToken = null, log = () => {} }) {
  const clients = new Set();
  const auth = createAuth(authToken, getPort);
  const csp = cspCache();

  function hostAllowed(req) {
    const port = getPort();
    const host = String(req.headers.host ?? '').toLowerCase();
    const ok = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    if (!ok.includes(host)) return false;
    // DNS rebinding 외에 교차 출처 요청도 거른다: Origin 이 있으면 같은 출처여야 한다
    const origin = req.headers.origin;
    if (origin !== undefined && !ok.some((h) => origin.toLowerCase() === `http://${h}`)) return false;
    return true;
  }

  async function serveIndex(res) {
    let html;
    try {
      html = await fsp.readFile(path.join(publicDir, 'office.html'), 'utf8');
    } catch {
      return send(res, 500, 'office.html missing');
    }
    const page = HEAD + html + TAIL;
    send(res, 200, page, 'text/html; charset=utf-8', {
      'cache-control': 'no-cache', 'content-security-policy': csp(page), 'x-frame-options': 'DENY',
    });
  }

  async function serveJs(res, name) {
    let buf;
    try {
      buf = await fsp.readFile(path.join(publicDir, 'js', `${name}.js`));
    } catch {
      return send(res, 404, 'not found');
    }
    send(res, 200, buf, 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache' });
  }

  function openEvents(req, res) {
    req.socket.setNoDelay?.(true); // 작은 이벤트를 모아 보내지 않는다
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const client = { res, timer: null, closed: false };
    const write = (chunk) => {
      if (client.closed) return;
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED) drop();
    };
    const listener = (item) => write(sseFrame(item.seq, item.event));
    const drop = () => {
      if (client.closed) return;
      client.closed = true;
      clearInterval(client.timer);
      store.unsubscribe(listener);
      clients.delete(client);
      res.destroy();
    };
    client.drop = drop;
    client.listener = listener;
    write('retry: 2000\n\n');
    // since/snapshot 과 subscribe 는 같은 동기 구간이라 그 사이에 이벤트를 놓치지 않는다
    const lastId = req.headers['last-event-id'];
    const missed = typeof lastId === 'string' && lastId.trim() !== '' ? store.since(lastId.trim()) : null;
    if (missed) {
      for (const item of missed) write(sseFrame(item.seq, item.event));
    } else {
      const snap = store.snapshot();
      write(sseFrame(snap.seq, { type: 'snapshot', events: snap.events }));
    }
    write(sseFrame(store.seq, { type: 'config', ...getConfig() }));
    if (client.closed) return;
    store.subscribe(listener);
    clients.add(client);
    client.timer = setInterval(() => write(': ping\n\n'), pingMs);
    client.timer.unref?.();
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  function broadcastConfig() {
    const frame = sseFrame(store.seq, { type: 'config', ...getConfig() });
    for (const c of [...clients]) {
      if (c.closed) continue;
      c.res.write(frame);
      if (c.res.writableLength > MAX_BUFFERED) c.drop();
    }
  }

  // 설정 변경은 같은 출처에서만: Origin 이 있으면 Host 헤더와 같은 출처(http://<Host>)여야 한다.
  // 루프백 목록 안의 다른 이름(localhost 와 127.0.0.1)이나 'null' 출처도 교차 출처로 본다.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // 브라우저가 아닌 로컬 도구
    return String(origin).toLowerCase() === `http://${String(req.headers.host ?? '').toLowerCase()}`;
  }

  async function postConfig(req, res) {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request' });
    const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!ctype.startsWith('application/json')) return sendJson(res, 415, { error: 'content-type must be application/json' });
    if (Number(req.headers['content-length']) > MAX_BODY) { // 읽기 전에 거절한다
      discardRest(req);
      return sendJson(res, 413, { error: 'body too large' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_BODY));
    } catch (err) {
      return sendJson(res, err?.status ?? 400, { error: err?.status === 413 ? 'body too large' : 'invalid json' });
    }
    const v = body?.intervalMs;
    if (!validInterval(v)) {
      return sendJson(res, 400, { error: `intervalMs must be an integer ${MIN_INTERVAL}..${MAX_INTERVAL}` });
    }
    const cfg = setConfig({ intervalMs: v });
    broadcastConfig();
    sendJson(res, 200, { type: 'config', ...cfg });
  }

  async function route(req, res) {
    if (!hostAllowed(req)) return send(res, 403, 'forbidden');
    const raw = String(req.url ?? '/');
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    // 정규화 전에 원래 경로로 검사한다 (.. 와 인코딩된 점은 무조건 거절)
    if (rawPath.includes('..') || /%2e|%2f|%5c|\\/i.test(rawPath)) return send(res, 400, 'bad path');
    const m = req.method;
    const isGet = m === 'GET' || m === 'HEAD';
    if (auth) {
      // --auth: 출력된 URL(/?t=<token>)로 한 번 열면 쿠키를 주고 주소창에서 토큰을 지운다. 나머지는 쿠키가 있어야 한다.
      const t = isGet && rawPath === '/' && q >= 0 ? new URLSearchParams(raw.slice(q + 1)).get('t') : null;
      if (t !== null && auth.matches(t)) {
        return send(res, 302, '', undefined, { location: '/', 'set-cookie': auth.setCookie(), 'cache-control': 'no-store' });
      }
      if (!auth.allowed(req)) {
        return send(res, 401, 'unauthorized: open the URL printed by claude-office\n', undefined, { 'cache-control': 'no-store' });
      }
    }
    if (DATA_ROUTES.has(rawPath) && crossSiteFetch(req)) return send(res, 403, 'cross-site request');
    if (rawPath === '/config') {
      if (m === 'POST') return postConfig(req, res);
      if (isGet) return sendJson(res, 200, { type: 'config', ...getConfig() });
      return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD, POST' });
    }
    if (!isGet) return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD' });
    if (rawPath === '/' || rawPath === '/index.html') return serveIndex(res);
    if (rawPath === '/events') {
      if (m !== 'GET') return send(res, 405, 'method not allowed', undefined, { allow: 'GET' });
      return openEvents(req, res);
    }
    if (rawPath === '/state') {
      const snap = store.snapshot();
      return sendJson(res, 200, { type: 'snapshot', seq: snap.seq, events: snap.events });
    }
    if (rawPath === '/healthz') return sendJson(res, 200, { ok: true, ...stats(), clients: clients.size });
    const js = JS_RE.exec(rawPath);
    if (js) return serveJs(res, js[1]);
    return send(res, 404, 'not found');
  }

  function handler(req, res) {
    route(req, res).catch((err) => {
      // 경로만 남긴다: 쿼리에는 --auth 토큰(?t=)이 있을 수 있다
      log(`http ${req.method} ${String(req.url ?? '').split('?')[0]}: ${err?.message ?? err}`);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
    });
  }

  function closeAll() {
    for (const c of [...clients]) {
      c.closed = true;
      clearInterval(c.timer);
      store.unsubscribe(c.listener);
      c.res.end();
    }
    clients.clear();
  }

  return { handler, clients, broadcastConfig, closeAll };
}
