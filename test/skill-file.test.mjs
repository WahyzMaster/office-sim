// P4 skills/office/SKILL.md: frontmatter (name office, a description that triggers on /office), a body that covers
// every step and argument, nothing user-specific (no absolute home paths, no emoticons), and names that match the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { USAGE } from '../src/cli-args.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const SKILL = read('skills/office/SKILL.md');

/** Split `---\n<yaml>\n---\n<body>`; the YAML here is flat `key: value` lines (a value may be double-quoted). */
function parseSkill(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    assert.ok(kv, `frontmatter line is key: value: ${line}`);
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

test('frontmatter: name office (the folder name), a non-empty description that triggers on /office and the office', () => {
  const { meta } = parseSkill(SKILL);
  assert.equal(meta.name, 'office');
  assert.match(meta.name, /^[a-z0-9-]{1,64}$/);
  assert.equal(typeof meta.description, 'string');
  assert.ok(meta.description.length > 40 && meta.description.length <= 1024, `description length ${meta.description.length}`);
  for (const re of [/\/office\b/, /open or show the office/, /what the agents are doing/, /stop/, /status/, /demo/, /auth/]) {
    assert.match(meta.description, re);
  }
  assert.equal(meta['argument-hint'], '[start|stop|status|demo|auth]');
  assert.deepEqual(Object.keys(meta).sort(), ['argument-hint', 'description', 'name']);
});

test('body covers the steps: repo root by realpath, args, healthz probe, background start, open, stop by bin path', () => {
  const { body } = parseSkill(SKILL);
  for (const heading of ['## 1. Repo root', '## 2. Action', '## 3. Probe', '## status', '## start, demo, auth', '## stop']) {
    assert.ok(body.split('\n').some((l) => l === heading || l.startsWith(`${heading} (`)), heading);
  }
  for (const arg of ['start', 'stop', 'status', 'demo', 'auth']) assert.ok(body.includes(`\`${arg}\``), `argument ${arg}`);
  const must = [
    'realpathSync', '"..",".."', 'bin","office-sim.mjs', 'MISSING', 'npm run skill:install', // (a)
    'http://127.0.0.1:4317/healthz', 'AbortSignal.timeout(1000)', '`agents`, `sessions`, `clients`', // (c)
    'run_in_background: true', '--port <port>', '`<port>` = 0', 'mktemp', 'at most 10 s', 'do not wait across turns', // (d)
    'mcp__Claude_Browser__preview_start', '--open', '`<url>#demo`', 'open "<page>"', 'xdg-open "<page>"', 'cmd /c start "" "<page>"', // (e)
    '<root>/bin/office-sim.mjs', 'SIGTERM', 'Never kill anything else', 'Get-CimInstance Win32_Process', // (f)
    'Never read, print or open session log content', 'Never put a file path in a URL', '/office stop', // (g)
  ];
  for (const s of must) assert.ok(body.includes(s), s);
});

test('nothing user-specific: no absolute home or temp paths, no emails, no emoticons; short', () => {
  for (const re of [/\/Users\//, /\/home\/[a-z]/, /[A-Za-z]:\\Users/i, /\/private\//, /\/var\/folders/, /scratchpad/i, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i]) {
    assert.doesNotMatch(SKILL, re);
  }
  assert.doesNotMatch(SKILL, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(SKILL, /(^|\s)[:;]-?[)(DPp](\s|$)/m, 'no ASCII emoticons');
  assert.ok(SKILL.split('\n').length < 150, 'kept short');
});

test('names in the skill match the code: the 401 body, healthz keys, CLI flags, npm scripts', () => {
  const body401 = 'unauthorized: open the URL printed by office-sim';
  assert.ok(SKILL.includes(`\`401 ${body401}\``));
  assert.ok(read('src/server-http.mjs').includes(`'${body401}\\n'`));
  assert.match(read('src/server-http.mjs'), /'\/healthz'\) return sendJson\(res, 200, \{ ok: true, \.\.\.stats\(\), clients: clients\.size \}\)/);
  assert.match(read('src/server.mjs'), /stats: \(\) => \(\{ files: group\.fileCount, sessions: store\.sessionCount, agents: group\.ids \}\)/);
  for (const flag of ['--port <n>', '--auth ', '--open ']) assert.ok(USAGE.includes(flag), flag);
  const { scripts } = JSON.parse(read('package.json'));
  assert.equal(scripts['skill:install'], 'node scripts/install-skill.mjs');
  assert.equal(scripts['skill:uninstall'], 'node scripts/install-skill.mjs --uninstall');
  assert.ok(fs.existsSync(new URL('../bin/office-sim.mjs', import.meta.url)));
});

// ---- review fixes (P4 findings 1-4, 6-9): the wording the agent acts on -------------------------------------

const section = (start, end) => SKILL.slice(SKILL.indexOf(start), end ? SKILL.indexOf(end) : undefined);

test('the skill never passes --open; it runs the opener itself and says "open by hand" when that failed (findings 1, 7)', () => {
  const startCmd = SKILL.split('\n').find((l) => l.includes('--port <port> <flags>'));
  assert.ok(startCmd && !startCmd.includes('--open'), startCmd);
  assert.ok(SKILL.includes('`<flags>` is `--auth` for `auth`, else empty. Do not pass `--open`'));
  assert.doesNotMatch(SKILL, /unless `--open` already did it|skip step 4/);
  const step4 = section('4. Open `<page>`', '5. Tell the user');
  for (const s of ['opener still running', '`opened` and `opener still running`', '`open failed ...` means it did not', 'Windows `start` reports success']) {
    assert.ok(step4.includes(s), s);
  }
  assert.ok(section('5. Tell the user', '## stop').includes('give the URL to open by hand'));
});

test('a reused server gets an ownership check and a matching "how to stop" line (finding 2)', () => {
  const step1 = section('1. Probe.', '2. Make a private');
  for (const s of ['with ` 4317` added after its last argument', '`ours pid <n>`', '`not ours`', 'a non-empty `$m` means ours']) {
    assert.ok(step1.includes(s), s);
  }
  const step5 = section('5. Tell the user', '## stop');
  for (const s of ['the step 1 check printed `ours pid`', 'Otherwise (`not ours`)', 'Ctrl-C', '`/office stop` leaves it running']) {
    assert.ok(step5.includes(s), s);
  }
});

test('probe: a fallback timer guarantees one line, and no output at all counts as another program (finding 3)', () => {
  assert.ok(SKILL.includes('const t=setTimeout(()=>{console.log("down Timeout");process.exit(0)},1500)'));
  assert.ok(SKILL.includes('.finally(()=>clearTimeout(t))'));
  assert.ok(SKILL.includes('or no output at all: port 4317 is held by another program'));
});

test('wait: complete lines only, ends on any non-URL line, and EADDRINUSE leads to one more probe (finding 4)', () => {
  assert.ok(SKILL.includes('t.slice(0, t.lastIndexOf("\\n") + 1)'));
  assert.ok(SKILL.includes('!lines().some((l) => !l.startsWith("office-sim: http://"))'));
  assert.ok(SKILL.includes('contains `EADDRINUSE` (another start took 4317 first), probe once more and act as in step 1'));
});

test('stop: each pid is tried on its own and failures are reported (finding 6)', () => {
  assert.ok(SKILL.includes('try { process.kill(Number(m[1]), "SIGTERM"); done.push(m[1]); } catch (e)'));
  assert.ok(SKILL.includes('console.log("could not stop pid " + failed.join(", "))'));
  assert.ok(SKILL.includes('"could not stop pid $p"'));
  assert.ok(SKILL.includes('any `could not stop pid` line'));
});

// The PowerShell filter, rebuilt in JS from the text of SKILL.md ([regex]::Escape plus the same pattern; .NET -match is
// case-insensitive). It must apply the POSIX rule: node(.exe), then exactly <root>\bin\office-sim.mjs as the next token.
function windowsMatcher(root) {
  const ps = /```powershell\n([\s\S]*?)```/.exec(SKILL)[1];
  assert.doesNotMatch(ps, /-like/);
  const suffix = /\$b = \[regex\]::Escape\('<root>'\) \+ '([^']*)'/.exec(ps)[1];
  const [, pre, post] = /-match \('([^']*)' \+ \$b \+ '([^']*)'\)/.exec(ps);
  return new RegExp(pre + root.replace(/[.*+?^${}()|[\]\\#\s]/g, '\\$&') + suffix + post, 'i');
}

test('Windows stop matches the bin path as the first argument after node.exe, not as a substring (finding 8)', () => {
  const root = 'D:\\src\\office-sim [v2]';
  const m = windowsMatcher(root);
  const bin = `${root}\\bin\\office-sim.mjs`;
  for (const cmd of [`node "${bin}" --port 4317`, `"C:\\Program Files\\nodejs\\node.exe" "${bin}" --port 0 --auth`,
    `C:\\nodejs\\node.exe "${root}/bin/office-sim.mjs"`, `NODE.EXE "${bin.toLowerCase()}"`, `node "${bin}"`]) {
    assert.ok(m.test(cmd), `match: ${cmd}`);
  }
  for (const cmd of [`node --inspect "${bin}"`, `node "${bin}.bak"`, `node -e "x" "${bin}"`, `node lint.js "${bin}"`,
    'node "D:\\src\\office-sim 2\\bin\\office-sim.mjs"', `cmd /c node "${bin}"`, `nodemon "${bin}"`]) {
    assert.ok(!m.test(cmd), `no match: ${cmd}`);
  }
  const plain = windowsMatcher('C:\\r');
  assert.ok(plain.test('node C:\\r\\bin\\office-sim.mjs --port 4317'));
  assert.ok(!plain.test('node C:\\r\\bin\\office-sim.mjs.bak'));
  assert.ok(SKILL.includes("(double any `'` in it)"));
});

test('Linux auth: no opener with the token URL; the user pastes it (finding 9)', () => {
  assert.ok(section('4. Open `<page>`', '5. Tell the user').includes('Linux with `auth`: do not run an opener'));
});
