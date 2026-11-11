// W7 (launch readiness): the Claude Code plugin files. The marketplace file sits at the repository root, the plugin in
// its own small folder (`plugin/`), because the plugin cache copies only the plugin folder. These tests read the files
// and compare them with the code they must agree with: the default port, the hook route and events, the package
// version and the /office skill. Nothing is installed and no Claude Code runs; the one server is on port 0 with a
// temporary Claude root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, start } from '../src/server.mjs';
import { HOOK_EVENTS, HOOK_MARKER, buildHookUrl, installClaudeHooks } from '../src/hooks-receiver.mjs';
import { request } from './fixtures/sse.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const abs = (rel) => path.join(REPO, rel);
const text = (rel) => fs.readFileSync(abs(rel), 'utf8');
const json = (rel) => JSON.parse(text(rel));
const pkg = json('package.json');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-plugin-'));
  tmpDirs.push(d);
  return d;
}

test('marketplace.json at the repository root: name, owner and one plugin whose source is ./plugin', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'office-sim');
  assert.equal(m.owner?.name, 'WahyzMaster');
  assert.ok(Array.isArray(m.plugins));
  assert.equal(m.plugins.length, 1);
  const [entry] = m.plugins;
  assert.equal(entry.name, 'office-sim');
  assert.equal(entry.source, './plugin');
  assert.ok(typeof entry.description === 'string' && entry.description.length > 20, 'the entry has a description');
  // the source is a folder of this repository that holds a plugin manifest
  assert.ok(fs.statSync(abs('plugin')).isDirectory());
  assert.ok(fs.statSync(abs('plugin/.claude-plugin/plugin.json')).isFile());
});

test('plugin.json: the manifest keys, and the version of package.json', () => {
  const p = json('plugin/.claude-plugin/plugin.json');
  assert.equal(p.name, 'office-sim');
  assert.equal(p.name, json('.claude-plugin/marketplace.json').plugins[0].name, 'the marketplace entry names this plugin');
  assert.equal(p.version, pkg.version, 'plugin/.claude-plugin/plugin.json must carry the version of package.json: change both in the same commit');
  assert.ok(typeof p.description === 'string' && p.description.length > 20);
  assert.equal(p.author?.name, 'WahyzMaster');
  assert.equal(p.homepage, 'https://github.com/WahyzMaster/office-sim');
  assert.equal(new URL(p.homepage).href, 'https://github.com/WahyzMaster/office-sim', 'homepage parses as a URL');
  assert.equal(new URL(p.repository).href, 'https://github.com/WahyzMaster/office-sim', 'repository parses as a URL');
  assert.ok(pkg.repository.url.includes('github.com/WahyzMaster/office-sim'), 'the same repository as package.json');
  assert.equal(p.license, 'MIT');
  assert.equal(p.license, pkg.license);
  assert.ok(Array.isArray(p.keywords) && p.keywords.length > 0 && p.keywords.every((k) => typeof k === 'string' && k));
  assert.ok(p.keywords.includes('claude-code'));
  for (const file of ['.claude-plugin/marketplace.json', 'plugin/.claude-plugin/plugin.json', 'plugin/hooks/hooks.json']) {
    assert.doesNotMatch(text(file), /\p{Extended_Pictographic}/u, `${file}: no emoticons`);
    assert.ok(text(file).endsWith('}\n'), `${file} ends with one newline`);
  }
});

test('hooks.json: the events of HOOK_EVENTS as http hooks on the default port and the hook route', () => {
  const h = json('plugin/hooks/hooks.json');
  assert.deepEqual(Object.keys(h), ['hooks'], 'one top-level key wraps the event map');
  assert.deepEqual(Object.keys(h.hooks), [...HOOK_EVENTS], 'the same events, in the same order, as the settings.json installer');
  const url = `http://127.0.0.1:${DEFAULTS.port}/api/hooks/claude`;
  const handler = { type: 'http', url, timeout: 2 };
  assert.deepEqual(h, {
    hooks: {
      PermissionRequest: [{ hooks: [handler] }],
      Notification: [{ matcher: 'permission_prompt', hooks: [handler] }],
    },
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1', 'loopback only');
  assert.equal(Number(parsed.port), DEFAULTS.port, 'the default port constant of src/server.mjs');
  assert.equal(parsed.pathname, new URL(buildHookUrl()).pathname, 'the path the installer writes');
  assert.equal(parsed.search, '', 'no marker: a plugin hook is not in settings.json, so nothing has to find it there');
});

test('hooks.json equals what the settings.json installer writes, without the marker query', () => {
  const settingsPath = path.join(tmp(), 'settings.json');
  installClaudeHooks({ settingsPath });
  const written = fs.readFileSync(settingsPath, 'utf8');
  assert.ok(written.includes(`?source=${HOOK_MARKER}`));
  const unmarked = JSON.parse(written.split(`?source=${HOOK_MARKER}`).join(''));
  assert.deepEqual(json('plugin/hooks/hooks.json'), unmarked);
});

test('the URL of hooks.json is a route of the server: a fixture PermissionRequest gets 200 {}', async () => {
  const root = tmp();
  const app = await start({ port: 0, root, agents: ['claude-code'], rescanMs: 60_000 });
  try {
    await app.ready;
    const [group] = json('plugin/hooks/hooks.json').hooks.PermissionRequest;
    const res = await request(app.port, {
      method: 'POST', path: new URL(group.hooks[0].url).pathname, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: '7c7c7c7c-1111-4222-8333-444455556666', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
  } finally {
    await app.close();
  }
});

test('the plugin skill is a byte-identical copy of skills/office/SKILL.md, and a regular file', () => {
  const copy = abs('plugin/skills/office/SKILL.md');
  assert.ok(fs.lstatSync(copy).isFile(), 'a real file, not a link: the plugin cache copies the plugin folder only');
  assert.ok(fs.lstatSync(abs('plugin/skills/office')).isDirectory());
  assert.ok(
    fs.readFileSync(copy).equals(fs.readFileSync(abs('skills/office/SKILL.md'))),
    'plugin/skills/office/SKILL.md differs from skills/office/SKILL.md: copy the file again (cp skills/office/SKILL.md plugin/skills/office/SKILL.md)',
  );
  assert.deepEqual(fs.readdirSync(abs('plugin/skills/office')), fs.readdirSync(abs('skills/office')), 'the same file names');
});

test('the plugin folder holds only the manifest, the hooks and the skill', () => {
  const seen = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(abs(rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, e.name);
      assert.equal(e.isSymbolicLink(), false, `${child} is not a link`);
      if (e.isDirectory()) walk(child);
      else seen.push(child);
    }
  };
  walk('plugin');
  assert.deepEqual(seen.sort(), ['plugin/.claude-plugin/plugin.json', 'plugin/hooks/hooks.json', 'plugin/skills/office/SKILL.md']);
});

// Decision (W7): the npm package ships skills/ (office-sim init copies it) and not the plugin files. Claude Code
// fetches a plugin from the GitHub repository named in `/plugin marketplace add`, never from the npm tarball.
test('package.json files: skills/ ships, the plugin folder and the marketplace file do not', () => {
  assert.ok(pkg.files.includes('skills/'), 'skills/ is in the npm package');
  for (const entry of pkg.files) {
    assert.doesNotMatch(entry, /^\.?\/?(plugin|\.claude-plugin)(\/|$)/, `${entry}: plugin files are not shipped to npm`);
  }
});
