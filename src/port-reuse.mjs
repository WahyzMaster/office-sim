// 기본 포트가 이미 쓰이고 있을 때 (contract 6, D2): 그 자리에 있는 것이 office-sim 인지 GET /healthz 로 한 번 묻는다.
// 묻기만 한다: 다른 포트를 대신 열지 않는다 (기본 포트는 hook 주소와 /office 스킬에 적혀 있다).
import http from 'node:http';

/** 물음 하나의 전체 제한 시간 (연결, 헤더, 본문을 합쳐서). */
export const PROBE_TIMEOUT_MS = 1000;
/** 읽는 본문의 상한. /healthz 본문은 2 KB 를 넘지 않는다 (contract 6); 넘으면 office-sim 이 아닌 것으로 본다. */
export const MAX_PROBE_BODY = 64 * 1024;

/** `http://<host>:<port>/`, the URL start() prints without --auth (an IPv6 host in brackets). */
export function baseUrl(host, port) {
  const urlHost = String(host).includes(':') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/`;
}

/** The /office skill's test (skills/office/SKILL.md, 3. Probe): 200 with JSON that has `ok: true` and an `agents` array. */
export function isOfficeSimHealth(status, body) {
  if (status !== 200 || typeof body !== 'string') return false;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return parsed !== null && typeof parsed === 'object' && parsed.ok === true && Array.isArray(parsed.agents);
}

/**
 * One `GET http://<host>:<port>/healthz`. Resolves `{ status, body }`, or null when nothing answers in `timeoutMs`,
 * the connection fails, or the body is larger than MAX_PROBE_BODY. Never rejects.
 */
export function probeHealthz({ host, port, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(value);
    };
    // 소켓이 조용한 시간이 아니라 전체 시간을 잰다: 한 바이트씩 흘리는 상대에게 붙들리지 않는다
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      req = http.request({ host, port, path: '/healthz', method: 'GET', agent: false, headers: { connection: 'close' } }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_PROBE_BODY) finish(null);
          else chunks.push(chunk);
        });
        res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * A failed listen. Only when the error is EADDRINUSE and the user did not pass --port (`portArg` undefined, so `port`
 * is the default port): if the listener answers /healthz like an office-sim, write `office-sim: already running at
 * <url>` and, with `open`, open that URL. Any other case writes nothing, and the caller reports the failure as before.
 * @param {unknown} err the error start() rejected with
 * @param {{ portArg: number|undefined, host: string, port: number, open?: boolean, write: (line: string) => void,
 *   openUrl: (url: string) => void, timeoutMs?: number }} options
 * @returns {Promise<string|null>} the running server's URL when it is reused, else null
 */
export async function reuseRunning(err, { portArg, host, port, open = false, write, openUrl, timeoutMs } = {}) {
  if (err?.code !== 'EADDRINUSE' || portArg !== undefined) return null;
  const answer = await probeHealthz({ host, port, timeoutMs });
  if (!answer || !isOfficeSimHealth(answer.status, answer.body)) return null;
  const url = baseUrl(host, port);
  write(`office-sim: already running at ${url}\n`);
  if (open) openUrl(url);
  return url;
}
