// bin/claude-office.mjs 의 인자 해석 (contract 6). 순수 함수라 테스트하기 쉽다.
import { expandHome, DEFAULTS, LOOPBACK_HOSTS } from './server.mjs';
import { MIN_INTERVAL, MAX_INTERVAL } from './server-http.mjs';

export const USAGE = `Usage: claude-office [options]

  --port <n>       HTTP port (default ${DEFAULTS.port}, 0 = any free port)
  --host <addr>    loopback address to bind (default ${DEFAULTS.host})
  --interval <ms>  tail poll interval, ${MIN_INTERVAL}..${MAX_INTERVAL} (default ${DEFAULTS.intervalMs})
  --active <min>   attach transcripts modified in the last N minutes (default ${DEFAULTS.activeMinutes})
  --rescan <ms>    rescan for new transcript files every N ms (default ${DEFAULTS.rescanMs})
  --root <dir>     projects root (default ~/.claude/projects)
  --auth           require a per-run token: open the printed URL once, the browser then keeps a cookie
  -h, --help       show this help
`;

const SPEC = {
  port: { key: 'port', kind: 'int', min: 0, max: 65535 },
  host: { key: 'host', kind: 'host' },
  interval: { key: 'intervalMs', kind: 'int', min: MIN_INTERVAL, max: MAX_INTERVAL },
  active: { key: 'activeMinutes', kind: 'num', min: 0.01, max: 60 * 24 * 365 },
  rescan: { key: 'rescanMs', kind: 'int', min: 100, max: 3_600_000 },
  root: { key: 'root', kind: 'path' },
  auth: { key: 'auth', kind: 'flag' },
};

function convert(name, spec, raw) {
  if (spec.kind === 'path') {
    if (!raw) throw new Error(`--${name} needs a directory`);
    return expandHome(raw);
  }
  if (spec.kind === 'host') {
    if (!LOOPBACK_HOSTS.has(raw)) throw new Error(`--host must be a loopback address (${[...LOOPBACK_HOSTS].join(', ')})`);
    return raw;
  }
  const n = Number(raw);
  const okType = spec.kind === 'int' ? Number.isInteger(n) : Number.isFinite(n);
  if (raw.trim() === '' || !okType || n < spec.min || n > spec.max) {
    throw new Error(`--${name} must be ${spec.kind === 'int' ? 'an integer' : 'a number'} in ${spec.min}..${spec.max}`);
  }
  return n;
}

/** argv (without node and script) -> start() options plus { help }. Throws Error with a readable message. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const spec = SPEC[name];
    if (!spec) throw new Error(`unknown option: --${name}`);
    if (spec.kind === 'flag') { // 값 없는 스위치: 다음 인자를 먹지 않는다
      if (eq >= 0) throw new Error(`--${name} takes no value`);
      out[spec.key] = true;
      continue;
    }
    let raw = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (raw === undefined || (eq < 0 && raw.startsWith('--'))) throw new Error(`--${name} needs a value`);
    raw = String(raw);
    out[spec.key] = convert(name, spec, raw);
  }
  return out;
}
