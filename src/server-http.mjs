// HTTP 라우팅 + SSE 허브 (contract 6). 상태는 Store 에만 있고 여기서는 읽기/전달만 한다.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cspCache, crossSiteFetch, createAuth } from './server-guard.mjs';
import { HooksBridge } from './hooks-bridge.mjs';
import { SessionRecapTracker } from './session-recap.mjs';
import { SystemNotifier } from './system-notify.mjs';
import { FlywheelControl } from './flywheel/control.mjs';
import { pageHead, PAGE_TAIL } from './page-shell.mjs';
import { MIN_INTERVAL, MAX_INTERVAL, validInterval, createJsonBody, handleApiRoute } from './server-routes.mjs';

export { MIN_INTERVAL, MAX_INTERVAL, validInterval };

const HEAD = pageHead({ lang: 'en' }); // public/office.html 앞뒤를 감싸는 문서 껍데기 (호스팅 데모 빌드와 같이 쓴다). 페이지가 고른 언어로 lang 을 바꾼다 (D8)
const JS_RE = /^\/js\/([a-z0-9_-]+)\.js$/;
// public/vendor (벤더링한 three.js, contract 6): 폴더 없는 이름, 글자·숫자로 시작하고 . 과 - 는 하나씩만, 확장자는 .js 와 .txt 뿐
const VENDOR_RE = /^\/vendor\/([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*\.(js|txt))$/;
const JS_TYPE = 'text/javascript; charset=utf-8';
const VENDOR_TYPES = Object.freeze({ js: JS_TYPE, txt: 'text/plain; charset=utf-8' });
const FAVICON_TYPES = Object.freeze({
  '/favicon.svg': 'image/svg+xml; charset=utf-8',
  '/favicon.png': 'image/png',
  '/favicon.ico': 'image/x-icon',
});
const DATA_ROUTES = new Set(['/events', '/state', '/config', '/api/replay', '/api/hooks/claude', '/api/focus-terminal', '/api/recap', '/api/recap/review', '/api/notify', '/api/flywheel']); // Sec-Fetch-Site 로 교차 사이트 요청을 거른다
const OBSERVE_ROUTES = new Set([...DATA_ROUTES, '/observe']); // 기록 관찰이 켜졌을 때만
const MAX_BUFFERED = 8 * 1024 * 1024; // 느린 클라이언트는 끊고 Last-Event-ID 로 다시 붙게 한다

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

/**
 * @param {{ store, publicDir: string, pingMs: number, getPort: () => number,
 *           getConfig: () => object, setConfig: (patch) => object, health: (clients: number) => object, log: Function,
 *           observe?: { status(): object, start(): Promise<object>, stop(): Promise<object> } | null }} o
 *   observe: the live log observation control (ObserveControl). null = feature off: no /observe route, no observe frame.
 */
export function createHttp({ store, publicDir, pingMs, getPort, getConfig, setConfig, health, authToken = null, cdn = false, observe = null, replayRunner = null, focusOpts = null, notifyOpts = null, flywheelOpts = null, claudeRoot = null, log = () => {} }) {
  const clients = new Set();
  const auth = createAuth(authToken, getPort);
  const csp = cspCache({ cdn }); // cdn (--cdn): 페이지 CSP 의 script-src 에 CDN 을 더한다. 기본은 루프백만
  const dataRoutes = observe ? OBSERVE_ROUTES : DATA_ROUTES;
  const hooks = new HooksBridge({ store, claudeRoot, log }); // Claude Code 훅 -> tool_wait (contract 7.2)
  const recapTracker = new SessionRecapTracker();
  const notifier = new SystemNotifier(notifyOpts ?? {});
  let crossSiteBlocks = 0;
  let droppedClients = 0;
  for (const ev of store.snapshot().events) {
    recapTracker.observeEvent(ev);
    notifier.observeEvent(ev, { live: false });
    hooks.observeEvent(ev);
  }
  const origPush = store.push.bind(store);
  store.push = (ev) => {
    const res = origPush(ev);
    recapTracker.observeEvent(ev);
    notifier.observeEvent(ev);
    hooks.observeEvent(ev); // 마지막에: 들고 있던 승인 대기를 이 tool_start 바로 뒤에 push 한다
    return res;
  };
  const currentConfig = () => {
    const base = getConfig();
    return notifier.enabled ? { ...base, notify: notifier.status() } : base;
  };

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
    const page = HEAD + html + PAGE_TAIL;
    send(res, 200, page, 'text/html; charset=utf-8', {
      'cache-control': 'no-cache', 'content-security-policy': csp(page), 'x-frame-options': 'DENY',
    });
  }

  // public/js 와 public/vendor 의 파일 하나. 이름은 route() 의 정규식(JS_RE, VENDOR_RE)이 이미 걸렀다
  async function serveAsset(res, dir, file, type) {
    let buf;
    try {
      buf = await fsp.readFile(path.join(publicDir, dir, file));
    } catch {
      return send(res, 404, 'not found');
    }
    send(res, 200, buf, type, { 'cache-control': 'no-cache' });
  }

  async function serveFavicon(res, rawPath) {
    let buf;
    try {
      buf = await fsp.readFile(path.join(publicDir, rawPath.slice(1)));
    } catch {
      return send(res, 404, 'not found');
    }
    send(res, 200, buf, FAVICON_TYPES[rawPath], { 'cache-control': 'public, max-age=86400' });
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
      if (res.writableLength > MAX_BUFFERED) {
        droppedClients += 1;
        drop();
      }
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
      write(sseFrame(snap.seq, { type: 'snapshot', events: hooks.decorate(snap.events) }));
    }
    write(sseFrame(store.seq, { type: 'config', ...currentConfig() }));
    if (observe) write(sseFrame(store.seq, { type: 'observe', ...observe.status() }));
    if (client.closed) return;
    store.subscribe(listener);
    clients.add(client);
    client.timer = setInterval(() => write(': ping\n\n'), pingMs);
    client.timer.unref?.();
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  // 제어 메시지 (config, observe): Store 와 링에 넣지 않고 지금 붙어 있는 페이지에만 보낸다
  function broadcast(msg) {
    const frame = sseFrame(store.seq, msg);
    for (const c of [...clients]) {
      if (c.closed) continue;
      c.res.write(frame);
      if (c.res.writableLength > MAX_BUFFERED) {
        droppedClients += 1;
        c.drop();
      }
    }
  }

  const broadcastConfig = () => broadcast({ type: 'config', ...currentConfig() });
  const broadcastReplay = (detail = replayRunner?.replayDetail()) => { if (detail) broadcast({ type: 'replay', ...detail }); };
  const broadcastSnapshot = (meta = {}) => { const snap = store.snapshot(); broadcast({ type: 'snapshot', ...meta, events: hooks.decorate(snap.events) }); };

  function broadcastObserve(status = observe?.status()) {
    if (observe && status) broadcast({ type: 'observe', ...status });
  }

  const flywheel = new FlywheelControl({
    getHealth: () => (typeof health === 'function' ? health(clients.size) : null),
    getObserveSummary: () => {
      const st = observe?.status?.();
      return st?.summary ?? st ?? null;
    },
    getRecaps: () => recapTracker.summaryList(),
    getSseMetrics: () => ({ crossSiteBlocks, droppedClients }),
    ...(flywheelOpts ?? {}),
    onChange: (snap) => {
      flywheelOpts?.onChange?.(snap);
      broadcast({ type: 'flywheel', ...snap });
    },
  });

  const jsonBody = createJsonBody({
    sendJson,
    onCrossSiteBlock: () => { crossSiteBlocks += 1; },
  });
  const apiCtx = {
    send, sendJson, jsonBody, store, observe, replayRunner, focusOpts,
    hooks, recapTracker, notifier, flywheel, setConfig, currentConfig, broadcastConfig, broadcastReplay,
  };

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
        return send(res, 401, 'unauthorized: open the URL printed by office-sim\n', undefined, { 'cache-control': 'no-store' });
      }
    }
    if (dataRoutes.has(rawPath) && crossSiteFetch(req)) {
      crossSiteBlocks += 1;
      return send(res, 403, 'cross-site request');
    }
    const handled = await handleApiRoute(req, res, { rawPath, raw, q, m, isGet }, apiCtx);
    if (handled !== false) return handled;
    if (!isGet) return send(res, 405, 'method not allowed', undefined, { allow: 'GET, HEAD' });
    if (rawPath === '/' || rawPath === '/index.html') return serveIndex(res);
    if (rawPath === '/events') {
      if (m !== 'GET') return send(res, 405, 'method not allowed', undefined, { allow: 'GET' });
      return openEvents(req, res);
    }
    if (rawPath === '/state') {
      const snap = store.snapshot();
      return sendJson(res, 200, { type: 'snapshot', seq: snap.seq, events: hooks.decorate(snap.events) });
    }
    if (rawPath === '/healthz') return sendJson(res, 200, health(clients.size)); // 본문은 server-health.mjs (처음 다섯 키는 예전 그대로)
    if (FAVICON_TYPES[rawPath]) return serveFavicon(res, rawPath);
    const js = JS_RE.exec(rawPath);
    if (js) return serveAsset(res, 'js', `${js[1]}.js`, JS_TYPE);
    const vendor = VENDOR_RE.exec(rawPath);
    if (vendor) return serveAsset(res, 'vendor', vendor[1], VENDOR_TYPES[vendor[2]]);
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
    store.push = origPush;
    void flywheel.close();
    for (const c of [...clients]) {
      c.closed = true;
      clearInterval(c.timer);
      store.unsubscribe(c.listener);
      c.res.end();
    }
    clients.clear();
  }

  return { handler, clients, broadcastConfig, broadcastReplay, broadcastSnapshot, broadcastObserve, recapTracker, notifier, flywheel, hooks, closeAll };
}
