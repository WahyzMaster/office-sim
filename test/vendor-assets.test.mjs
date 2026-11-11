// Loopback-only assets (launch readiness D4, D5): three@0.160.0 is vendored under public/vendor/ and pinned by
// sha256 here, the page's importmap points every statically imported module at ./vendor/, and the page names no
// font host. Reads repository files only: no server, no browser, nothing written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const VENDOR = path.join(PUBLIC, 'vendor');
const JS = path.join(PUBLIC, 'js');
const CDN_ADDONS = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';

// sha256 of the files as they are in the npm tarball three-0.160.0.tgz (registry integrity
// sha512-DLU8lc0zNIPkM7rH5/e1Ks1Z8tWCGRq6g8mPowdDJpw1CFBJMU7UoJjC6PefXW7z//SSl0b2+GCw14LB+uDhng==):
// package/build/three.module.min.js, package/examples/jsm/controls/OrbitControls.js,
// package/examples/jsm/renderers/CSS2DRenderer.js and package/LICENSE (stored as LICENSE-three.txt).
const PINS = Object.freeze({
  'three.module.min.js': '3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6',
  'OrbitControls.js': '5a44a9e86a2a0fb11933eed69bc2cd33c76a496854c1aed6ed776efa87d7b064',
  'CSS2DRenderer.js': 'a4f0f79184c043f6b9d2654d8ba051e49a7d631d34e8f437c1804798a68c379f',
  'LICENSE-three.txt': '852e0e8699169bf9f6fdc6bda3e682d078dcbc738b5d33e74df594721bff271d',
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const page = () => fs.readFileSync(path.join(PUBLIC, 'office.html'), 'utf8');

function importmap(html) {
  const maps = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
  assert.equal(maps.length, 1, 'office.html has exactly one importmap');
  return JSON.parse(maps[0][1]).imports;
}

// every module specifier a file names: `from '<spec>'`, a bare `import '<spec>'`, and `import('<spec>')`
function specifiers(text) {
  const fixed = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\1/g)].map((m) => m[2]);
  const dynamic = [...text.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map((m) => m[2]);
  return { fixed, dynamic };
}

test('public/vendor holds exactly the pinned three@0.160.0 files, byte for byte', () => {
  const names = fs.readdirSync(VENDOR).filter((n) => n !== '.DS_Store').sort();
  assert.deepEqual(names, Object.keys(PINS).sort(), 'no unpinned file ships in public/vendor');
  for (const [name, want] of Object.entries(PINS)) {
    assert.ok(fs.lstatSync(path.join(VENDOR, name)).isFile(), `${name} is a regular file, not a link`);
    assert.equal(sha256(path.join(VENDOR, name)), want, `${name} differs from the three@0.160.0 tarball`);
  }
  const license = fs.readFileSync(path.join(VENDOR, 'LICENSE-three.txt'), 'utf8');
  assert.match(license, /^The MIT License\n/);
  assert.match(license, /three\.js authors/);
  assert.match(fs.readFileSync(path.join(VENDOR, 'three.module.min.js'), 'utf8').slice(0, 200), /SPDX-License-Identifier: MIT/);
});

test('.gitattributes: no line-ending conversion ever touches the pinned vendor bytes', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const rules = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(rules.includes('public/vendor/* -text'), `.gitattributes has "public/vendor/* -text": ${rules.join(' | ')}`);
  // no later rule turns conversion back on for those files (the last matching line wins in .gitattributes)
  const after = rules.slice(rules.lastIndexOf('public/vendor/* -text') + 1);
  assert.deepEqual(after.filter((l) => /(^|\s)(text|eol)\b/.test(l.replace(/^\S+\s+/, ''))), [], 'no text or eol rule after it');
  // the pinned files are flat in public/vendor (the pattern has no /**), and none holds a CR today
  for (const name of Object.keys(PINS)) assert.equal(fs.readFileSync(path.join(VENDOR, name)).includes(13), false, `${name} has no CR byte`);
});

test('the vendored files load nothing but each other: the addons import only "three", the build imports nothing', () => {
  for (const name of ['OrbitControls.js', 'CSS2DRenderer.js']) {
    const { fixed, dynamic } = specifiers(fs.readFileSync(path.join(VENDOR, name), 'utf8'));
    assert.deepEqual(fixed, ['three'], `${name} static imports`);
    assert.deepEqual(dynamic, [], `${name} dynamic imports`);
  }
  const build = fs.readFileSync(path.join(VENDOR, 'three.module.min.js'), 'utf8');
  assert.doesNotMatch(build, /(^|[;}\n])\s*import\s*[\w{*"']/, 'the build has no import statement');
  assert.doesNotMatch(build, /\bimport\s*\(/, 'the build has no dynamic import');
});

test('office.html names no font host and loads no stylesheet or script from another origin', () => {
  const html = page();
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i, 'no <link> to another origin');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i, 'no <script src> to another origin');
  assert.doesNotMatch(html, /@import\b/, 'no CSS @import');
  assert.doesNotMatch(html, /@font-face\b/, 'no web font: text uses the system stacks');
  assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i, 'no CSS url() to another origin');
  // the stacks the page already listed still end in a generic family, so nothing falls to the serif default
  for (const [name, generic] of [['ui', 'sans-serif'], ['mono', 'monospace'], ['sign', 'sans-serif'], ['pen', 'cursive']]) {
    assert.match(html, new RegExp(`--font-${name}:[^;]*,\\s*${generic};`), `--font-${name} ends in ${generic}`);
  }
});

test('importmap: every non-prefix entry is a vendored file; only the three/addons/ prefix names the CDN', () => {
  const imports = importmap(page());
  const exact = Object.entries(imports).filter(([key]) => !key.endsWith('/'));
  const prefixes = Object.entries(imports).filter(([key]) => key.endsWith('/'));
  assert.deepEqual(Object.fromEntries(exact), {
    three: './vendor/three.module.min.js',
    'three/addons/controls/OrbitControls.js': './vendor/OrbitControls.js',
    'three/addons/renderers/CSS2DRenderer.js': './vendor/CSS2DRenderer.js',
  });
  for (const [key, target] of exact) {
    const m = /^\.\/vendor\/([A-Za-z0-9][A-Za-z0-9._-]*\.js)$/.exec(target);
    assert.ok(m, `${key} -> ${target} points at ./vendor/`);
    assert.ok(Object.hasOwn(PINS, m[1]), `${key} -> ${m[1]} is a pinned file`);
  }
  // the opt-in WebGPU renderer is the only thing left on the CDN (blocked by the default CSP, allowed by --cdn)
  assert.deepEqual(prefixes, [['three/addons/', CDN_ADDONS]]);
});

test('every module the page imports statically resolves to loopback: no static import falls to the CDN prefix', () => {
  const imports = importmap(page());
  const files = fs.readdirSync(JS).filter((n) => n.endsWith('.js')).sort();
  assert.ok(files.includes('scene.js') && files.includes('webgpu-stage.js'));
  const dynamicAddons = [];
  let staticAddons = 0;
  for (const name of files) {
    const { fixed, dynamic } = specifiers(fs.readFileSync(path.join(JS, name), 'utf8'));
    for (const spec of fixed) {
      if (spec.startsWith('./')) continue; // a sibling module, served by GET /js/<name>.js
      assert.ok(Object.hasOwn(imports, spec) && !spec.endsWith('/'), `${name}: "${spec}" has its own importmap entry`);
      assert.ok(imports[spec].startsWith('./vendor/'), `${name}: "${spec}" is vendored`);
      if (spec.startsWith('three/addons/')) staticAddons += 1;
    }
    for (const spec of dynamic) {
      if (spec.startsWith('./')) continue;
      dynamicAddons.push(`${name}: ${spec}`);
    }
  }
  assert.ok(staticAddons >= 3, 'scene.js, floor.js and agent.js import the two vendored addons');
  // the one module that may come from the CDN, and only when the user asks for it (?renderer=webgpu)
  assert.deepEqual(dynamicAddons, ['webgpu-stage.js: three/addons/renderers/webgpu/WebGPURenderer.js']);
});

test('the 500-line cap does not apply to public/vendor: the invariant gate never names a vendored file', () => {
  const lines = fs.readFileSync(path.join(VENDOR, 'OrbitControls.js'), 'utf8').split('\n').length;
  assert.ok(lines > 500, `OrbitControls.js has ${lines} lines`);
  const script = fileURLToPath(new URL('../scripts/verify-dom-invariants.mjs', import.meta.url));
  assert.match(fs.readFileSync(script, 'utf8'), /THIRD_PARTY_DIRS = \['public\/vendor'\]/, 'the exemption is explicit');
  // only the vendor exemption is checked here: a cap breach in a project file is that file's failure, not this test's
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
  assert.match(`${r.stdout}${r.stderr}`, /DOM invariants: (PASS|FAIL)/, 'the gate ran');
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /public\/vendor/);
});

test('the package ships public/vendor (package.json files lists public/)', () => {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.ok(pkg.files.includes('public/'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'vendoring adds no npm dependency');
});
