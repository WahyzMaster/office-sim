// D1: the default port is 4747, in one move. It is written into hook URLs, the /office skill and the documents, so
// every place that defines or documents the default has to agree, and the old default (4317, the OTLP gRPC port) must
// not linger in a live file. docs/HISTORY.md, docs/review/ and the dated plans keep their old numbers on purpose.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/server.mjs';
import { USAGE, parseArgs } from '../src/cli-args.mjs';
import { installClaudeHooks } from '../src/hooks-receiver.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const PORT = 4747;

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test('the server default, the usage text and an argv without --port agree on 4747', () => {
  assert.equal(DEFAULTS.port, PORT);
  assert.match(USAGE, new RegExp(`\\n  --port <n>\\s+HTTP port \\(default ${PORT},`));
  assert.equal('port' in parseArgs([]), false, 'no --port: start() falls back to DEFAULTS.port');
});

// only the address is checked, not the shape of the hook entry (that belongs to the hook tests)
test('the hook installer posts to the default port unless one is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-port-'));
  tmpDirs.push(dir);
  const settingsPath = path.join(dir, 'settings.json');
  installClaudeHooks({ settingsPath });
  const written = fs.readFileSync(settingsPath, 'utf8');
  assert.ok(written.includes(`http://127.0.0.1:${PORT}/api/hooks/claude`), written);
  const other = path.join(dir, 'other.json');
  installClaudeHooks({ settingsPath: other, port: 4242 });
  const given = fs.readFileSync(other, 'utf8');
  assert.ok(given.includes('http://127.0.0.1:4242/api/hooks/claude') && !given.includes(String(PORT)), given);
});

test('.claude/launch.json previews on 4747 (live) and 4748 (replay), flag and port in step', () => {
  const { configurations } = JSON.parse(read('.claude/launch.json'));
  assert.deepEqual(configurations.map((c) => [c.name, c.port]), [['office-sim', PORT], ['office-sim-replay', PORT + 1]]);
  for (const c of configurations) {
    const i = c.runtimeArgs.indexOf('--port');
    assert.equal(c.runtimeArgs[i + 1], String(c.port), c.name);
    // a preview server is shown in the preview pane: it must not also open the default browser (D7 opens in a terminal)
    assert.ok(c.runtimeArgs.includes('--no-open'), `${c.name} passes --no-open`);
    assert.equal(c.runtimeArgs.includes('--open'), false, c.name);
    assert.doesNotThrow(() => parseArgs(c.runtimeArgs.slice(1)), `${c.name}: the bin accepts these arguments`);
    assert.equal(parseArgs(c.runtimeArgs.slice(1)).open, false, c.name);
  }
});

test('the skill and the documents name 4747', () => {
  // loose on purpose: these texts are reworded by other work, the number is what has to hold
  assert.ok(read('skills/office/SKILL.md').includes(`http://127.0.0.1:${PORT}/`));
  for (const rel of ['README.md', 'README.ko.md']) assert.ok(read(rel).includes(`\`${PORT}\``), rel);
  assert.ok(read('docs/CONTRACT.md').includes(`\`--port ${PORT} `));
  assert.ok(read('docs/CONTRACT.md').includes(`The default port is ${PORT} and there is no fallback port`));
});

// every code file under these folders, plus the documents a reader follows today
function liveFiles() {
  const out = ['README.md', 'README.ko.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'package.json', '.claude/launch.json',
    'skills/office/SKILL.md', 'docs/CONTRACT.md', 'docs/ADAPTERS.md', 'docs/SOFTWARE_DEVELOPMENT_REPORT.md', 'public/office.html'];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && /\.(mjs|js|json|html|yml|md)$/.test(e.name)) out.push(child);
    }
  };
  for (const dir of ['bin', 'src', 'scripts', 'public/js', '.github']) walk(dir);
  return out;
}

test('no live file still names the old default port 4317 (or its replay neighbour 4318)', () => {
  const files = liveFiles();
  assert.ok(files.includes('src/server.mjs') && files.includes('bin/office-sim.mjs') && files.includes('.github/workflows/test.yml'));
  // a port, not the tail of a longer number or of a decimal fraction
  const stale = files.filter((rel) => /(?<![0-9.])431[78](?![0-9])/.test(read(rel)));
  assert.deepEqual(stale, []);
});
