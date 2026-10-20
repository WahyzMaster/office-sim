// bin/office-sim.mjs 의 인자 해석 (contract 6). 순수 함수라 테스트하기 쉽다.
import { expandHome, DEFAULTS, LOOPBACK_HOSTS } from './server.mjs';
import { MIN_INTERVAL, MAX_INTERVAL } from './server-http.mjs';
import { KNOWN_AGENTS, checkAgents } from './adapters/index.mjs';

export const USAGE = `Usage: office-sim [options]

  --port <n>           HTTP port (default ${DEFAULTS.port}, 0 = any free port)
  --host <addr>        loopback address to bind (default ${DEFAULTS.host})
  --interval <ms>      tail poll interval, ${MIN_INTERVAL}..${MAX_INTERVAL} (default ${DEFAULTS.intervalMs})
  --active <min>       attach transcripts modified in the last N minutes (default ${DEFAULTS.activeMinutes})
  --rescan <ms>        rescan for new transcript files every N ms (default ${DEFAULTS.rescanMs})
  --claude-root <dir>  Claude Code transcripts root (default ~/.claude/projects)
  --root <dir>         alias of --claude-root
  --agents <id,id>     run only these adapters (${KNOWN_AGENTS.join(', ')}); default: every implemented
                       adapter whose root exists. Only claude-code is implemented today
  --codex-root <dir>   Codex root (default ~/.codex), for the upcoming Codex adapter
  --grok-root <dir>    Grok root (default ~/.grok), for the upcoming Grok adapter
  --antigravity-root <dir>  Antigravity root (default ~/.gemini), for the upcoming Antigravity adapter
  --auth               require a per-run token: open the printed URL once, the browser then keeps a cookie
  --replay <file>      replay one past session (<uuid>.jsonl plus its subagents) instead of tailing --claude-root
  --speed <x>          replay speed factor, 0.1..1000 (default 1)
  --loop               replay again from the start when it ends
  -h, --help           show this help
`;

const SPEC = {
  port: { key: 'port', kind: 'int', min: 0, max: 65535 },
  host: { key: 'host', kind: 'host' },
  interval: { key: 'intervalMs', kind: 'int', min: MIN_INTERVAL, max: MAX_INTERVAL },
  active: { key: 'activeMinutes', kind: 'num', min: 0.01, max: 60 * 24 * 365 },
  rescan: { key: 'rescanMs', kind: 'int', min: 100, max: 3_600_000 },
  // Claude Code 기록 루트. --root 는 예전 이름이라 같은 옵션(root)으로 남겨 둔다.
  'claude-root': { key: 'root', kind: 'path' },
  root: { key: 'root', kind: 'path' },
  // 어댑터 (contract 4.0.1): --agents 로 좁히고, 다른 도구의 루트는 roots.<agent id> 에 받아 둔다 (P5a 에서는 쓰지 않는다)
  agents: { key: 'agents', kind: 'agents' },
  'codex-root': { key: 'roots', agent: 'codex', kind: 'path' },
  'grok-root': { key: 'roots', agent: 'grok', kind: 'path' },
  'antigravity-root': { key: 'roots', agent: 'antigravity', kind: 'path' },
  auth: { key: 'auth', kind: 'flag' },
  replay: { key: 'replay', kind: 'path' },
  speed: { key: 'speed', kind: 'num', min: 0.1, max: 1000 },
  loop: { key: 'loop', kind: 'flag' },
};

function convert(name, spec, raw) {
  if (spec.kind === 'path') {
    if (!raw) throw new Error(`--${name} needs ${name === 'replay' ? 'a file' : 'a directory'}`);
    return expandHome(raw);
  }
  if (spec.kind === 'agents') {
    const ids = raw.split(',').map((x) => x.trim());
    if (ids.some((x) => x === '')) throw new Error(`--${name} needs agent ids, comma-separated (${KNOWN_AGENTS.join(', ')})`);
    try {
      return checkAgents(ids);
    } catch (err) {
      throw new Error(`--${name}: ${err.message}`);
    }
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
    const value = convert(name, spec, raw);
    if (spec.agent) out[spec.key] = { ...out[spec.key], [spec.agent]: value };
    else out[spec.key] = value;
  }
  if ((out.speed !== undefined || out.loop) && !out.replay) throw new Error('--speed and --loop need --replay <file>');
  return out;
}
