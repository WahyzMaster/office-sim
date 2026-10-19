// Bash/Monitor command -> { program, sub } (pure). Helper for summarize.mjs (CONTRACT 3.1).
// 프로그램 이름과 (허용 목록에 있는 CLI 의) 하위 명령만 돌려준다. 인자, 경로, 값, 원문은 절대 돌려주지 않는다.

const MAX_SCAN = 8192; // 거대한 heredoc 명령도 앞부분만 본다
const MAX_SEGMENTS = 32;

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const PROGRAM_RE = /^[A-Za-z_][A-Za-z0-9._+-]{0,63}$/;
const SUB_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,29}$/;
const WRAPPER_ARG_RE = /^\d+(?:\.\d+)?[smhd]?$/;

// 앞에 붙는 실행 래퍼: 건너뛰고 실제 프로그램을 찾는다
const WRAPPERS = new Set(['env', 'sudo', 'time', 'nohup', 'command', 'exec', 'nice', 'timeout', 'caffeinate', 'builtin']);
// 값을 받는 래퍼 옵션 (sudo -u USER, env -C DIR, timeout -s SIG): 옵션 값이 프로그램 자리에 오지 않도록 값까지 건너뛴다
const WRAPPER_VALUE_OPTS = new Map([
  ['sudo', { short: 'ugCDhprtTU', long: new Set(['user', 'group', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout', 'close-from']) }],
  ['env', { short: 'uCSPa', long: new Set(['unset', 'chdir', 'split-string', 'argv0']) }],
  ['timeout', { short: 'sk', long: new Set(['signal', 'kill-after']) }],
  ['time', { short: 'fo', long: new Set(['format', 'output']) }],
  ['exec', { short: 'a', long: new Set() }],
  ['nice', { short: 'n', long: new Set(['adjustment']) }],
  ['caffeinate', { short: 'tw', long: new Set() }],
]);
// 셸 키워드: 키워드만 버리고 같은 세그먼트의 다음 토큰을 본다
const KEYWORD_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
// 이 키워드로 시작하는 세그먼트는 통째로 건너뛴다
const KEYWORD_SKIP = new Set(['for', 'case', 'select', 'function', 'fi', 'done', 'esac', 'in', '}', ')']);
// 의미 없는 준비 명령: 다음 세그먼트를 본다 (전부 이것뿐이면 첫 번째를 쓴다)
const SETUP_PROGRAMS = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', 'ulimit', 'umask', 'alias', 'shopt', 'trap',
  'local', 'declare', 'readonly', 'typeset', 'true', 'false', 'exit', 'return',
]);
// 하위 명령을 함께 보여줄 CLI (그 밖의 프로그램은 인자를 전혀 보여주지 않는다: echo/cat/grep 의 인자 유출 방지)
const SUB_PROGRAMS = new Set([
  'git', 'gh', 'glab', 'hub', 'jj', 'hg', 'svn', 'git-lfs',
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'deno', 'corepack', 'volta', 'nvm', 'mise', 'asdf',
  'flutter', 'dart', 'melos', 'fvm', 'pod', 'fastlane', 'xcrun', 'swift', 'gradle', 'gradlew', 'mvn',
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'pulumi',
  'cargo', 'rustup', 'go', 'pip', 'pip3', 'uv', 'poetry', 'pipenv', 'conda', 'mamba',
  'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'port',
  'firebase', 'gcloud', 'gsutil', 'aws', 'az', 'vercel', 'netlify', 'wrangler', 'supabase', 'heroku', 'fly', 'flyctl',
  'make', 'just', 'turbo', 'nx', 'lerna', 'bundle', 'rails', 'rake', 'composer', 'dotnet',
  'systemctl', 'launchctl', 'tmux', 'codegraph', 'claude', 'codex', 'gemini', 'playwright', 'vitest',
]);

/** `<<[-]WORD` at j (just past '<<') -> { delim, strip, end }. WORD may be quoted ('EOF', "EOF", \EOF, E"O"F). */
function readHeredoc(cmd, j) {
  let strip = false;
  if (cmd[j] === '-') {
    strip = true;
    j++;
  }
  while (cmd[j] === ' ' || cmd[j] === '\t') j++;
  let delim = '';
  while (j < cmd.length && !/[\s;&|<>()]/.test(cmd[j])) {
    const ch = cmd[j];
    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, j + 1);
      const stop = close < 0 ? cmd.length : close;
      delim += cmd.slice(j + 1, stop);
      j = stop + 1;
    } else if (ch === '\\' && j + 1 < cmd.length) {
      delim += cmd[j + 1];
      j += 2;
    } else {
      delim += ch;
      j++;
    }
  }
  return { delim, strip, end: Math.min(j, cmd.length) };
}

/**
 * Skip heredoc bodies that start after the newline at `nl`, in order. Returns the index of the newline that ends
 * the last terminator line, or cmd.length when a terminator never comes (the rest is dropped: fail closed).
 */
function skipHeredocBodies(cmd, nl, pending) {
  let pos = nl + 1;
  for (const h of pending) {
    for (;;) {
      if (pos >= cmd.length) return cmd.length;
      let end = cmd.indexOf('\n', pos);
      if (end < 0) end = cmd.length;
      let line = cmd.slice(pos, end).replace(/\r$/, '');
      if (h.strip) line = line.replace(/^\t+/, '');
      pos = end + 1;
      if (line === h.delim) break;
    }
  }
  return pos - 1;
}

/**
 * Quote-aware split into simple commands (on && || | & ; newline), each a list of unquoted tokens.
 * 따옴표 안의 구분자는 무시한다. $( ... ) 와 `...` 안은 통째로 현재 토큰에 남고(구분자로 나누지 않는다),
 * heredoc 본문 줄은 버린다. 정확한 셸 파서가 아니라 첫 프로그램 이름을 찾기 위한 근사치.
 */
function lex(cmd) {
  const segments = [];
  let tokens = [];
  let tok = '';
  let inTok = false;
  let quote = null;
  let depth = 0; // $( 괄호 깊이
  const arith = []; // 열린 $(( 의 바깥 깊이: 그 안의 '<<' 는 heredoc 이 아니라 비트 이동이다
  let tick = false; // `...` 안
  let pending = []; // 다음 줄바꿈 뒤에 건너뛸 heredoc
  const pushTok = () => {
    if (inTok) tokens.push(tok);
    tok = '';
    inTok = false;
  };
  const pushSeg = () => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  const add = (s) => {
    tok += s;
    inTok = true;
  };
  for (let i = 0; i < cmd.length && segments.length < MAX_SEGMENTS; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) tok += cmd[++i];
      else tok += c;
      continue;
    }
    const nested = depth > 0 || tick;
    if (c === "'" || c === '"') {
      quote = c;
      inTok = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      const n = cmd[++i];
      if (n !== '\n') add(n);
    } else if (c === '#' && !inTok && !nested) {
      // 단어 처음의 '#' 은 주석: 줄 끝까지 버린다 (주석 안의 짝 없는 $( 나 ` 가 다음 줄을 삼키지 않게). 줄바꿈은 남긴다.
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
    } else if (c === '$' && cmd[i + 1] === '(') {
      if (cmd[i + 2] === '(') arith.push(depth);
      add('$(');
      i++;
      depth++;
    } else if (c === '`') {
      add(c);
      tick = !tick;
    } else if (c === '<' && cmd[i + 1] === '<') {
      if (cmd[i + 2] === '<') {
        add('<<<'); // here-string, not a heredoc
        i += 2;
      } else if (arith.length || /[0-9=]/.test(cmd[i + 2] ?? '')) {
        add('<<'); // $((1<<3)), x<<=2: 산술 비트 이동
        i++;
      } else {
        if (!nested) pushTok();
        const h = readHeredoc(cmd, i + 2);
        if (h.delim) pending.push(h);
        i = h.end - 1;
      }
    } else if (c === '\n') {
      if (nested) add(' ');
      else pushSeg();
      if (pending.length) {
        i = skipHeredocBodies(cmd, i, pending);
        pending = [];
      }
    } else if (nested) {
      if (c === '(' && depth > 0) depth++;
      else if (c === ')' && depth > 0) depth--;
      while (arith.length && depth <= arith[arith.length - 1]) arith.pop();
      add(c);
    } else if (c === ' ' || c === '\t' || c === '\r') {
      pushTok();
    } else if (c === ';' || c === '&' || c === '|') {
      pushSeg();
    } else {
      add(c);
    }
  }
  pushSeg();
  return segments;
}

function baseName(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Does a short option cluster ('-Eu', '-n') end in an option whose value is the next token? ('-uroot' has it attached) */
function shortTakesValue(arg, short) {
  const letters = arg.slice(1);
  for (let k = 0; k < letters.length; k++) {
    if (short.includes(letters[k])) return k === letters.length - 1;
  }
  return false;
}

/** Index of the first token after a wrapper's own options, VAR=val and numeric arguments. */
function skipWrapperArgs(tokens, i, wrapper) {
  const opts = WRAPPER_VALUE_OPTS.get(wrapper);
  while (i < tokens.length) {
    const a = tokens[i];
    if (a === '--') return i + 1;
    if (a.startsWith('--')) {
      i += opts && !a.includes('=') && opts.long.has(a.slice(2)) ? 2 : 1;
    } else if (a.startsWith('-')) {
      i += opts && shortTakesValue(a, opts.short) ? 2 : 1;
    } else if (ASSIGN_RE.test(a) || WRAPPER_ARG_RE.test(a)) {
      i++; // VAR=val, 숫자 인자 (timeout 30s, caffeinate 60)
    } else break;
  }
  return i;
}

/** One simple command -> { program, sub } | { setup: program } | null (no usable program). */
function parseSegment(tokens) {
  let i = 0;
  const at = () => (i < tokens.length ? tokens[i].replace(/^[({]+/, '') : null);
  for (;;) {
    const t = at();
    if (t === null) return null;
    if (t === '') i++;
    else if (ASSIGN_RE.test(t)) i++;
    else if (KEYWORD_PREFIX.has(t)) i++;
    else if (KEYWORD_SKIP.has(t)) return null;
    else if (WRAPPERS.has(t)) i = skipWrapperArgs(tokens, i + 1, t);
    else break;
  }
  let program = at();
  // 경로로 실행한 프로그램은 basename 만 쓴다 (./gradlew, /usr/bin/git, ./scripts/x.sh)
  if (/[\\/]/.test(program)) program = baseName(program);
  if (!PROGRAM_RE.test(program)) return null;
  if (SETUP_PROGRAMS.has(program)) return { setup: program };
  let sub = '';
  if (SUB_PROGRAMS.has(program.toLowerCase())) {
    // '/', '\', '=' 가 들어간 토큰은 버린 뒤 첫 번째 비플래그 토큰만 하위 명령 후보로 본다
    const rest = tokens.slice(i + 1).filter((t) => !/[\\/=]/.test(t));
    const cand = rest.find((t) => !t.startsWith('-'));
    if (cand !== undefined && SUB_RE.test(cand)) sub = cand;
  }
  return { program, sub };
}

/**
 * Program name (+ subcommand for known CLIs) of the first meaningful simple command.
 * @param {unknown} command raw Bash/Monitor command (never returned or echoed)
 * @returns {{ program: string, sub: string } | null}
 */
export function programOf(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  let firstSetup = null;
  for (const tokens of lex(command.slice(0, MAX_SCAN))) {
    const r = parseSegment(tokens);
    if (!r) continue;
    if (r.setup) {
      if (!firstSetup) firstSetup = r.setup;
      continue;
    }
    return r;
  }
  return firstSetup ? { program: firstSetup, sub: '' } : null;
}
