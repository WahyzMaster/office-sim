// HTTP 방어 도우미 (server-http.mjs 용): 페이지 CSP, Sec-Fetch-Site 검사, 선택적인 실행별 토큰(--auth).
// 순수 함수와 작은 상태만 있다. 토큰은 프로세스 안에서 만들고 argv/env 로 넘기지 않는다 (ps 로 보인다).
import crypto from 'node:crypto';

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** 'sha256-…' sources for every inline <script> (no src attribute) of a page, in document order. */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of String(html).matchAll(INLINE_SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return out;
}

// three.js 는 jsDelivr, 글꼴은 Google Fonts. 인라인 스크립트(importmap, 부트 타임아웃)는 해시로만 허용한다.
// style-src 에 해시를 넣지 않는다: 해시가 있으면 'unsafe-inline' 이 꺼져 HEAD 의 <style> 과 style 속성이 막힌다.
export function pageCsp(html) {
  return [
    "default-src 'self'",
    ["script-src 'self' https://cdn.jsdelivr.net", ...inlineScriptHashes(html)].join(' '),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Page CSP cached by page text: hashed once per office.html content, and still right after the file changes. */
export function cspCache() {
  let html = null;
  let value = null;
  return (page) => {
    if (page !== html) {
      html = page;
      value = pageCsp(page);
    }
    return value;
  };
}

// 브라우저가 보낸 Sec-Fetch-Site 가 다른 사이트(또는 같은 사이트의 다른 출처)면 거절한다. 헤더가 없으면(로컬 도구) 통과.
export function crossSiteFetch(req) {
  const site = req.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A fresh per-run token: 32 random bytes, base64url. */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Cookie auth for one run, or null when `token` is empty (no --auth: behaviour unchanged).
 * The cookie name carries the port: cookies are not port-scoped, so two servers on one host do not clash.
 */
export function createAuth(token, getPort) {
  if (!token) return null;
  const want = Buffer.from(token, 'utf8');
  const matches = (given) => {
    if (typeof given !== 'string') return false;
    const got = Buffer.from(given, 'utf8');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const name = () => `co_${getPort()}`;
  return {
    matches,
    setCookie: () => `${name()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    allowed: (req) => matches(readCookie(req.headers.cookie, name())),
  };
}
