// 기본 포트가 이미 쓰이고 있을 때 (contract 6, D2): 그 자리에 있는 것이 office-sim 인지 GET /healthz 로 한 번 묻는다.
// 묻기만 한다: 다른 포트를 대신 열지 않는다 (기본 포트는 hook 주소와 /office 스킬에 적혀 있다).
// 그 office-sim 을 다시 쓰는 것은 이번 실행이 "무엇을 열지" 만 말할 때뿐이다 (D18): 다른 옵션은 돌고 있는 서버에 닿지 않으므로
// 조용히 버리지 않고 실패로 남기되, 돌고 있는 주소와 --port 를 알려 준다.
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

/** The only options a run may carry and still reuse a running office-sim (D18): they say what to open, nothing else. */
export const REUSE_FLAGS = Object.freeze(['--open', '--no-open', '--demo']);

/**
 * D18: true when `argv` (without node and script) holds nothing but `--open`, `--no-open` and `--demo`, an empty
 * argv included. Any other element (`--port`, `--replay`, `--auth`, `--agents`, a root, `--notify`, `--cdn`, a value,
 * an `=` form) makes it false: those options would not reach the running server.
 */
export function reuseAllowed(argv) {
  return Array.isArray(argv) && argv.every((a) => REUSE_FLAGS.includes(a));
}

/**
 * The office-sim holding the conflicted port. When `err` is EADDRINUSE and the resolved port (`portArg ?? port`) is a
 * valid TCP port (1..65535), sends one `GET /healthz` to that port and returns its URL when the listener answers like
 * an office-sim; otherwise sends nothing and returns null.
 */
export async function findRunning(err, { portArg, host, port, timeoutMs } = {}) {
  if (err?.code !== 'EADDRINUSE') return null;
  const targetPort = portArg !== undefined ? portArg : port;
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return null;
  const answer = await probeHealthz({ host, port: targetPort, timeoutMs });
  if (!answer || !isOfficeSimHealth(answer.status, answer.body)) return null;
  return baseUrl(host, targetPort);
}

/**
 * A failed listen. When `findRunning` finds an office-sim on the default port: write `office-sim: already running at
 * <url>` and, with `open`, open that URL. Explicit `--port` never reuses. Any other case writes nothing, and the caller
 * reports the failure as before.
 * @param {unknown} err the error start() rejected with
 * @param {{ portArg: number|undefined, host: string, port: number, open?: boolean, write: (line: string) => void,
 *   openUrl: (url: string) => void, timeoutMs?: number }} options
 * @returns {Promise<string|null>} the running server's URL when it is reused, else null
 */
export async function reuseRunning(err, { portArg, host, port, open = false, write, openUrl, timeoutMs } = {}) {
  if (err?.code !== 'EADDRINUSE' || portArg !== undefined) return null;
  const url = await findRunning(err, { portArg, host, port, timeoutMs });
  if (!url) return null;
  write(`office-sim: already running at ${url}\n`);
  if (open) openUrl(url);
  return url;
}

/**
 * What follows the error message of a failed listen, on the same line. Empty unless the error is EADDRINUSE. With
 * `runningUrl` (an office-sim holds the port and this run may not reuse it, D18) it names that URL and --port.
 */
export function listenFailureHint(err, runningUrl = null) {
  if (err?.code !== 'EADDRINUSE') return '';
  if (!runningUrl) return ' (port in use: try --port 0 or another port)';
  return ` (port in use by the office-sim running at ${runningUrl}; only a run with no option other than `
    + `${REUSE_FLAGS.join(', ')} reuses it: stop it, or try --port 0 or another port)`;
}

/**
 * The whole decision for a failed listen (D2, D18). A run whose argv passes `reuseAllowed` reuses a running
 * office-sim on the default port (`reuseRunning`). Any other run never reuses: its failure stays a failure, and the
 * hint names the running office-sim when one holds the resolved port (`portArg ?? port`).
 * @param {unknown} err the error start() rejected with
 * @param {{ argv: string[], portArg: number|undefined, host: string, port: number, open?: boolean,
 *   write: (line: string) => void, openUrl: (url: string) => void, timeoutMs?: number }} options
 * @returns {Promise<{ reused: string|null, hint: string }>} `reused`: the URL to exit 0 on; else `hint` for the error line
 */
export async function onListenFailure(err, { argv, portArg, host, port, open = false, write, openUrl, timeoutMs } = {}) {
  if (reuseAllowed(argv)) {
    const reused = await reuseRunning(err, { portArg, host, port, open, write, openUrl, timeoutMs });
    return { reused, hint: reused ? '' : listenFailureHint(err) };
  }
  return { reused: null, hint: listenFailureHint(err, await findRunning(err, { portArg, host, port, timeoutMs })) };
}
