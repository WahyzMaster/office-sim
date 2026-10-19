// Tiny HTTP + SSE client helpers for server tests. Side-effect free at import (node --test runs every file
// under test/ as a test file, so this module must not start anything by itself).
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function parseFrame(raw) {
  const fr = { raw, comment: null, id: null, data: null, retry: null };
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) fr.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) fr.id = line.slice(4);
    else if (line.startsWith('data: ')) fr.data = JSON.parse(line.slice(6));
    else if (line.startsWith('retry: ')) fr.retry = Number(line.slice(7));
  }
  return fr;
}

/**
 * Open GET /events. Returns { frames, next(pred, ms), nextData(ms), close() }.
 * next() walks frames in arrival order from an internal cursor; nextData() returns the next frame that
 * carries a data payload (skipping the retry line and ping comments) without skipping any other data frame.
 */
export function sse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers }, (res) => {
      const c = { res, frames: [], cursor: 0, buf: '', waiters: new Set(), close: () => req.destroy() };
      const check = () => { for (const w of [...c.waiters]) w(); };
      c.next = (pred = () => true, ms = 3000) => new Promise((ok, fail) => {
        const timer = setTimeout(() => { c.waiters.delete(w); fail(new Error('timed out waiting for SSE frame')); }, ms);
        const w = () => {
          while (c.cursor < c.frames.length) {
            const fr = c.frames[c.cursor++];
            if (pred(fr)) { clearTimeout(timer); c.waiters.delete(w); ok(fr); return; }
          }
        };
        c.waiters.add(w);
        w();
      });
      c.nextData = (ms = 3000) => c.next((fr) => fr.data !== null, ms);
      // Data frames that arrived but were not consumed yet.
      c.pending = () => c.frames.slice(c.cursor).filter((fr) => fr.data !== null);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        c.buf += chunk;
        let i;
        while ((i = c.buf.indexOf('\n\n')) >= 0) {
          c.frames.push(parseFrame(c.buf.slice(0, i)));
          c.buf = c.buf.slice(i + 2);
        }
        check();
      });
      resolve(c);
    });
    req.on('error', reject);
  });
}

export async function until(fn, ms = 3000, step = 20) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(step);
  }
}
