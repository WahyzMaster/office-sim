// bin/office-sim.mjs 의 인자 해석 (contract 6). 순수 함수라 테스트하기 쉽다.
import { expandHome, DEFAULTS, LOOPBACK_HOSTS } from './server.mjs';
import { MIN_INTERVAL, MAX_INTERVAL } from './server-http.mjs';
import { KNOWN_AGENTS, checkAgents } from './adapters/index.mjs';
import { KNOWN_PLUGINS, checkPlugins } from './adapters/plugins.mjs';
import { parseNotifyArg } from './system-notify.mjs';

export const USAGE = `Usage: office-sim [options]

  --port <n>           HTTP port (default ${DEFAULTS.port}, 0 = any free port)
  --host <addr>        loopback address to bind (default ${DEFAULTS.host})
  --interval <ms>      tail poll interval, ${MIN_INTERVAL}..${MAX_INTERVAL} (default ${DEFAULTS.intervalMs})
  --active <min>       attach transcripts modified in the last N minutes (default ${DEFAULTS.activeMinutes})
  --rescan <ms>        rescan for new transcript files every N ms (default ${DEFAULTS.rescanMs})
  --claude-root <dir>  Claude Code transcripts root (default ~/.claude/projects)
  --root <dir>         alias of --claude-root
  --agents <id,id>     run only these adapters (${KNOWN_AGENTS.join(', ')}); default: every implemented
                       adapter whose root exists. Implemented today: claude-code, codex, grok, antigravity
  --codex-root <dir>   Codex root: desktop app, CLI and IDE threads (default ~/.codex)
  --grok-root <dir>    Grok (xAI Grok Build) root (default ~/.grok)
  --antigravity-root <dir>  Antigravity root: CLI, legacy IDE and desktop app (default ~/.gemini; only its
                       antigravity-cli/, antigravity-ide/ and antigravity/ folders are read)
  --plugins <id,id>    enable optional plug-in adapters (${KNOWN_PLUGINS.join(', ')})
  --gemini-cli-root <dir>  Gemini CLI session root when --plugins gemini-cli is enabled (default ~/.gemini/tmp)
  --auth               require a per-run token: open the printed URL once, the browser then keeps a cookie
  --cdn                let the page load scripts from https://cdn.jsdelivr.net (only ?renderer=webgpu needs it;
                       by default the page loads everything from this server)
  --open               open the printed URL (with --auth, the token URL) in the default browser once listening.
                       Without --open or --no-open it opens only in a terminal: stdout is a TTY, CI is not set
                       and an opener exists (and not with --auth on Linux, where the token would show in ps)
  --no-open            never open the browser
  --demo               when the browser is opened, open the page in demo mode (the printed URL plus #demo);
                       when it is not, print that URL in one more line (office-sim: demo <url>#demo)
  --notify [cats]      enable native OS notifications (default: ask,error,done; optional: tool_error, all)
  --replay <file>      replay one past session (<uuid>.jsonl plus its subagents) instead of tailing --claude-root
  --speed <x>          replay speed factor, 0.1..1000 (default 1)
  --loop               replay again from the start when it ends
  -h, --help           show this help

Setup commands for Claude Code (they start no server; details: office-sim init --help):
  office-sim init                              install the permission-prompt hooks and copy the /office skill
  office-sim hooks install|uninstall|status    add, remove or check the hooks alone
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
  // 어댑터 (contract 4.0.1): --agents 로 좁히고, 다른 도구의 루트는 roots.<agent id> 에 받는다 (grok 은 P5c, codex 는 P5d,
  // antigravity 는 P5e 부터 쓴다. 주지 않은 루트의 기본값은 bin 이 defaultRoots() 로 채운다)
  agents: { key: 'agents', kind: 'agents' },
  plugins: { key: 'plugins', kind: 'plugins' },
  'codex-root': { key: 'roots', agent: 'codex', kind: 'path' },
  'grok-root': { key: 'roots', agent: 'grok', kind: 'path' },
  'antigravity-root': { key: 'roots', agent: 'antigravity', kind: 'path' },
  'gemini-cli-root': { key: 'roots', agent: 'gemini-cli', kind: 'path' },
  auth: { key: 'auth', kind: 'flag' },
  cdn: { key: 'cdn', kind: 'flag' }, // 페이지 CSP 의 script-src 에 CDN 을 더한다 (start() 의 cdn, contract 6)
  // 아래 셋은 bin 만 쓴다 (start() 로 넘기지 않는다). --open 과 --no-open 은 같은 키 open 의 true / false 이고, 다른
  // 옵션처럼 나중 것이 이긴다. 둘 다 없으면 키가 없다: 그때는 bin 이 터미널인지 보고 정한다 (src/open-policy.mjs, D7)
  open: { key: 'open', kind: 'flag' },
  'no-open': { key: 'open', kind: 'flag', value: false },
  demo: { key: 'demo', kind: 'flag' },
  notify: { key: 'notify', kind: 'notify' },
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
    return ids;
  }
  if (spec.kind === 'plugins') {
    const ids = raw.split(',').map((x) => x.trim());
    if (ids.some((x) => x === '')) throw new Error(`--${name} needs plugin ids, comma-separated (${KNOWN_PLUGINS.join(', ')})`);
    try {
      return checkPlugins(ids);
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
      out[spec.key] = spec.value ?? true;
      continue;
    }
    if (spec.kind === 'notify') {
      let raw = 'default';
      if (eq >= 0) {
        raw = a.slice(eq + 1);
        if (raw === '') throw new Error('--notify needs category names');
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        raw = String(argv[++i]);
      }
      try {
        const parsed = parseNotifyArg(raw);
        out.notify = parsed.enabled;
        out.notifyCategories = parsed.categories;
      } catch (err) {
        throw new Error(`--notify: ${err.message}`);
      }
      continue;
    }
    let raw = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (raw === undefined || (eq < 0 && raw.startsWith('--'))) throw new Error(`--${name} needs a value`);
    raw = String(raw);
    const value = convert(name, spec, raw);
    if (spec.agent) out[spec.key] = { ...out[spec.key], [spec.agent]: value };
    else out[spec.key] = value;
  }
  if (out.agents !== undefined) {
    const allowed = out.plugins?.length ? [...KNOWN_AGENTS, ...out.plugins] : KNOWN_AGENTS;
    try {
      out.agents = checkAgents(out.agents, allowed);
    } catch (err) {
      throw new Error(`--agents: ${err.message}`);
    }
  }
  if (out.roots?.['gemini-cli'] && !out.plugins?.includes('gemini-cli')) {
    out.plugins = [...(out.plugins ?? []), 'gemini-cli'];
  }
  if ((out.speed !== undefined || out.loop) && !out.replay) throw new Error('--speed and --loop need --replay <file>');
  return out;
}
