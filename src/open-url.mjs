// --open (contract 6): 출력한 주소를 기본 브라우저로 연다. spawn 을 주입할 수 있어서 테스트가 진짜 브라우저를 열지 않는다.
import { spawn as nodeSpawn } from 'node:child_process';

// 루프백 http 주소만 연다. 글자를 좁혀 두면 win32 의 `cmd /c start` 가 & | ^ 같은 문자를 명령으로 읽을 일이 없다.
const SAFE_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/[A-Za-z0-9/?=#_.-]*$/;

/** True when `url` is a loopback http URL that office-sim prints (`http://127.0.0.1:<port>/`, optional `?t=` and `#`). */
export function isOpenableUrl(url) {
  return typeof url === 'string' && SAFE_URL.test(url);
}

/** Platform opener: `{ cmd, args, options }`. The URL is always one argv element. */
export function openerCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [url], options: {} };
  // start 의 첫 따옴표 인자는 창 제목이다. 따옴표를 그대로 넘기려고 verbatim 으로 띄운다 (주소 글자는 위에서 좁혔다)
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } };
  return { cmd: 'xdg-open', args: [url], options: {} };
}

/**
 * Open `url` in the default browser: detached, stdio ignored, never awaited. Every failure (refused URL, spawn throw,
 * async 'error', non-zero exit) becomes exactly one log line, without the URL (it can carry the --auth token).
 * Returns true when the opener was spawned.
 */
export function openUrl(url, { platform = process.platform, spawn = nodeSpawn, log = () => {} } = {}) {
  let logged = false;
  const fail = (why) => {
    if (logged) return;
    logged = true;
    log(`open failed: ${why}`);
  };
  if (!isOpenableUrl(url)) {
    fail('not a loopback http URL');
    return false;
  }
  const { cmd, args, options } = openerCommand(url, platform);
  let child;
  try {
    child = spawn(cmd, args, { ...options, detached: true, stdio: 'ignore' });
  } catch (err) {
    fail(`${cmd}: ${err?.code ?? err?.message ?? err}`);
    return false;
  }
  child.on('error', (err) => fail(`${cmd}: ${err?.code ?? err?.message ?? err}`));
  child.on('exit', (code) => {
    if (typeof code === 'number' && code !== 0) fail(`${cmd} exited ${code}`);
  });
  child.unref?.();
  return true;
}
