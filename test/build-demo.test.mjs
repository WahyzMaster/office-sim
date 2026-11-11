// 호스팅 데모 빌드 (scripts/build-demo.mjs): 결과물은 os.tmpdir() 아래에만 쓴다. 서버도 브라우저도 띄우지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDemo, demoHeadTags, parseBuildArgs, DEMO_URL } from '../scripts/build-demo.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here('..');
const SCRIPT = here('../scripts/build-demo.mjs');
const SITE = 'https://wahyzmaster.github.io/office-sim/';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sim-demo-'));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const runScript = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 속성 하나짜리 태그를 찾는다: <meta name|property="key" content="..."> 의 content
function metaContent(html, attr, key) {
  const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html);
  return m ? m[1] : null;
}

// 합성 저장소 뿌리: public/, docs/assets/theme-studio.png, package.json 만 있다.
// 임시 폴더 한 단계 아래에 둔다 (뿌리의 부모를 out 으로 주는 거절 테스트가 os.tmpdir() 자체를 건드리지 않게).
function fakeRoot({ description = 'Synthetic "office" <demo> & more' } = {}) {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'office.html'), '<title>Fake</title>\n<div id="stage"></div>\n');
  fs.writeFileSync(path.join(root, 'public', 'js', 'main.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'public', '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(root, 'docs', 'assets', 'theme-studio.png'), Buffer.concat([PNG_MAGIC, Buffer.from('fake')]));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake', description }));
  return root;
}

test('the script builds a complete static site into --out: index.html, og.png, .nojekyll and public/', () => {
  const out = path.join(tmp(), 'site');
  const r = runScript(['--out', out], tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /index\.html/);

  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const fragment = fs.readFileSync(path.join(ROOT, 'public', 'office.html'), 'utf8');
  assert.ok(index.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">'), index.slice(0, 80));
  assert.ok(index.includes(VIEWPORT), 'viewport meta');
  assert.ok(index.endsWith(`</head><body>${fragment}</body></html>`), 'office.html is embedded whole, as the body');

  const head = index.slice(0, index.indexOf('</head>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(metaContent(head, 'name', 'description'), esc(pkg.description));
  assert.ok(head.includes(`<link rel="canonical" href="${SITE}">`), 'canonical');
  assert.ok(metaContent(head, 'property', 'og:title')?.includes('Office Sim'), 'og:title');
  assert.equal(metaContent(head, 'property', 'og:description'), esc(pkg.description));
  assert.equal(metaContent(head, 'property', 'og:type'), 'website');
  assert.equal(metaContent(head, 'property', 'og:url'), SITE);
  assert.equal(metaContent(head, 'property', 'og:image'), `${SITE}og.png`);
  assert.equal(metaContent(head, 'name', 'twitter:card'), 'summary_large_image');
  assert.equal(DEMO_URL, SITE);

  const og = fs.readFileSync(path.join(out, 'og.png'));
  assert.ok(og.subarray(0, 8).equals(PNG_MAGIC), 'og.png is a PNG');
  assert.ok(og.equals(fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'theme-studio.png'))), 'og.png is the studio screenshot');
  assert.equal(fs.readFileSync(path.join(out, '.nojekyll'), 'utf8'), '');

  // public/ 은 그대로 복사된다 (office.html 조각도 예전처럼 남는다)
  assert.equal(fs.readFileSync(path.join(out, 'office.html'), 'utf8'), fragment);
  for (const rel of ['favicon.svg', 'favicon.png', 'favicon.ico', 'js/main.js', 'js/sources.js']) {
    assert.ok(fs.readFileSync(path.join(out, rel)).equals(fs.readFileSync(path.join(ROOT, 'public', rel))), rel);
  }
  // 빌드는 .DS_Store 를 복사하지 않는다 (맥의 Finder 가 public/js 에 만들어 두어도 이 비교는 그대로다)
  const sourceJs = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((name) => name !== '.DS_Store');
  assert.deepEqual(fs.readdirSync(path.join(out, 'js')).sort(), sourceJs.sort());

  // 벤더링한 three.js 도 같이 간다: 호스팅 데모의 importmap 은 ./vendor/ 를 가리키므로 이 파일들이 없으면 페이지가 뜨지 않는다
  const vendorNames = ['three.module.min.js', 'OrbitControls.js', 'CSS2DRenderer.js', 'LICENSE-three.txt'];
  for (const name of vendorNames) {
    assert.ok(fs.readFileSync(path.join(out, 'vendor', name)).equals(fs.readFileSync(path.join(ROOT, 'public', 'vendor', name))), `vendor/${name}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(out, 'vendor')).sort(), [...vendorNames].sort());
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(index)[1]).imports;
  assert.equal(map.three, './vendor/three.module.min.js', 'index.html loads three.js from the site itself');
  for (const target of Object.values(map).filter((t) => t.startsWith('./'))) {
    assert.ok(fs.statSync(path.join(out, target)).isFile(), `${target} exists next to index.html`);
  }
});

test('--out defaults to _site under the working directory, and --out=<dir> works', () => {
  assert.deepEqual(parseBuildArgs([]), { out: '_site' });
  assert.deepEqual(parseBuildArgs(['--out', 'x/y']), { out: 'x/y' });
  assert.deepEqual(parseBuildArgs(['--out=z']), { out: 'z' });
  assert.deepEqual(parseBuildArgs(['-h']), { help: true });
  assert.deepEqual(parseBuildArgs(['--help']), { help: true });
  for (const bad of [['--out'], ['--out='], ['--out', '--help'], ['--nope'], ['stray'], ['--out', 'a', '--out', 'b']]) {
    assert.throws(() => parseBuildArgs(bad), Error, bad.join(' '));
  }

  const cwd = tmp();
  const r = runScript([], cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, '_site', 'index.html')));
  assert.ok(fs.existsSync(path.join(cwd, '_site', 'og.png')));
  assert.ok(fs.existsSync(path.join(cwd, '_site', '.nojekyll')));
});

test('a bad argument exits 2 with the usage and writes nothing; --help exits 0', () => {
  const cwd = tmp();
  const bad = runScript(['--nope'], cwd);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage: node scripts\/build-demo\.mjs/);
  assert.deepEqual(fs.readdirSync(cwd), []);
  const help = runScript(['--help'], cwd);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--out <dir>/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('buildDemo escapes the description, skips .DS_Store and reports what it wrote', () => {
  const root = fakeRoot();
  const out = path.join(tmp(), 'nested', 'site');
  const res = buildDemo({ root, outDir: out });
  assert.equal(res.outDir, out);
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.equal(res.indexBytes, Buffer.byteLength(index));
  const want = 'Synthetic &quot;office&quot; &lt;demo&gt; &amp; more';
  assert.equal(metaContent(index, 'name', 'description'), want);
  assert.equal(metaContent(index, 'property', 'og:description'), want);
  assert.ok(index.endsWith('</head><body><title>Fake</title>\n<div id="stage"></div>\n</body></html>'));
  assert.deepEqual(fs.readdirSync(out).sort(), ['.nojekyll', 'index.html', 'js', 'office.html', 'og.png']);
  assert.equal(demoHeadTags({ description: 'a "b"' }).includes('content="a &quot;b&quot;"'), true);
});

test('buildDemo refuses an out dir that would write into the source tree it copies', () => {
  const root = fakeRoot();
  const before = fs.readdirSync(root).sort();
  // '..site' 는 '..' 로 시작하는 이름일 뿐, public/ 밖이 아니다
  const inPublic = [path.join(root, 'public'), path.join(root, 'public', 'site'), path.join(root, 'public', '..site')];
  for (const outDir of [root, ...inPublic, path.dirname(root)]) {
    assert.throws(() => buildDemo({ root, outDir }), /out dir/, outDir);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), before, 'nothing was written');
  assert.deepEqual(fs.readdirSync(path.join(root, 'public')).sort(), ['.DS_Store', 'js', 'office.html']);
  // 저장소 안의 다른 폴더(_site)는 된다
  buildDemo({ root, outDir: path.join(root, '_site') });
  assert.ok(fs.existsSync(path.join(root, '_site', 'index.html')));
});

// public/ 안에 남은 것 (거절된 빌드는 빈 폴더 하나도 만들지 않는다)
const PUBLIC_AS_MADE = ['.DS_Store', 'js', 'office.html'];

test('the out dir check follows links: a link to public/ or to the repository, and a repository reached through a link', () => {
  const root = fakeRoot();
  const links = tmp();
  const toPublic = path.join(links, 'to-public');
  const toRoot = path.join(links, 'to-root');
  fs.symlinkSync(path.join(root, 'public'), toPublic);
  fs.symlinkSync(root, toRoot);
  const refused = [
    toPublic, // public/ 자체
    path.join(toPublic, 'site'), // 아직 없는 폴더: 가장 가까운 있는 조상(링크)을 풀어서 본다
    path.join(toPublic, 'a', 'b'),
    toRoot, // 저장소 뿌리
    path.join(toRoot, 'public', 'site'),
  ];
  for (const outDir of refused) assert.throws(() => buildDemo({ root, outDir }), /out dir/, outDir);
  // 뿌리를 링크로 주고 out 은 진짜 경로로 주어도 같다
  assert.throws(() => buildDemo({ root: toRoot, outDir: path.join(root, 'public', 'site') }), /out dir/);
  assert.throws(() => buildDemo({ root: toRoot, outDir: root }), /out dir/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'public')).sort(), PUBLIC_AS_MADE, 'nothing was created inside public/');
  assert.deepEqual(fs.readdirSync(root).sort(), ['docs', 'package.json', 'public']);
  assert.deepEqual(fs.readdirSync(links).sort(), ['to-public', 'to-root']);

  // 링크를 지나도 public/ 밖이면 된다. 돌려주는 경로는 받은 그대로다 (풀어 쓴 경로가 아니다)
  const elsewhere = tmp();
  const toElsewhere = path.join(links, 'to-elsewhere');
  fs.symlinkSync(elsewhere, toElsewhere);
  const res = buildDemo({ root, outDir: path.join(toElsewhere, 'site') });
  assert.equal(res.outDir, path.join(toElsewhere, 'site'));
  assert.ok(fs.existsSync(path.join(elsewhere, 'site', 'index.html')));
  // out 이 폴더로 가는 링크 그 자체여도 그 폴더에 쓴다 (링크는 링크로 남는다)
  assert.equal(buildDemo({ root, outDir: toElsewhere }).outDir, toElsewhere);
  assert.deepEqual(fs.readdirSync(elsewhere).sort(), ['.nojekyll', 'index.html', 'js', 'office.html', 'og.png', 'site']);
  assert.ok(fs.lstatSync(toElsewhere).isSymbolicLink());
});

test('an out dir below a regular file fails without writing', () => {
  const root = fakeRoot();
  const file = path.join(tmp(), 'a-file');
  fs.writeFileSync(file, 'keep');
  for (const outDir of [file, path.join(file, 'site')]) assert.throws(() => buildDemo({ root, outDir }), /EEXIST|ENOTDIR/, outDir);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('a broken link on the way to the out dir is refused, not written through', () => {
  const root = fakeRoot();
  const links = tmp();
  const dangling = path.join(links, 'dangling');
  fs.symlinkSync(path.join(root, 'public', 'not-there'), dangling);
  for (const outDir of [dangling, path.join(dangling, 'site')]) {
    assert.throws(() => buildDemo({ root, outDir }), /out dir.*broken link/, outDir);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'public')).sort(), PUBLIC_AS_MADE);
});

test('on a file system that ignores case, a differently cased path to public/ is refused too', (t) => {
  const root = fakeRoot();
  // 대소문자를 가리는 파일 시스템(리눅스 CI)에서는 PUBLIC 이 정말로 다른 폴더라서 거절할 이유가 없다
  if (!fs.existsSync(path.join(root, 'PUBLIC'))) return t.skip('this file system is case-sensitive');
  for (const outDir of [path.join(root, 'PUBLIC'), path.join(root, 'PUBLIC', 'site'), path.join(root, 'Public', 'JS', 'x')]) {
    assert.throws(() => buildDemo({ root, outDir }), /out dir/, outDir);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'public')).sort(), PUBLIC_AS_MADE, 'no empty site folder was left in public/');
  assert.deepEqual(fs.readdirSync(path.join(root, 'public', 'js')), ['main.js']);
});

test('a missing package description fails instead of publishing an empty preview text', () => {
  const root = fakeRoot({ description: '' });
  const out = path.join(tmp(), 'site');
  assert.throws(() => buildDemo({ root, outDir: out }), /description/);
  assert.equal(fs.existsSync(out), false, 'nothing was written');
});

test('every input is checked before anything is written: a missing og image leaves no partial site', () => {
  const root = fakeRoot();
  fs.rmSync(path.join(root, 'docs', 'assets', 'theme-studio.png'));
  const out = path.join(tmp(), 'site');
  assert.throws(() => buildDemo({ root, outDir: out }), /docs\/assets\/theme-studio\.png/);
  assert.equal(fs.existsSync(out), false, 'the out dir was not created');
  // 폴더가 그 이름으로 있어도 같다 (파일이 아니다)
  fs.mkdirSync(path.join(root, 'docs', 'assets', 'theme-studio.png'));
  assert.throws(() => buildDemo({ root, outDir: out }), /docs\/assets\/theme-studio\.png/);
  assert.equal(fs.existsSync(out), false);

  // office.html 이 없을 때도 같다
  const noPage = fakeRoot();
  fs.rmSync(path.join(noPage, 'public', 'office.html'));
  assert.throws(() => buildDemo({ root: noPage, outDir: out }), /office\.html/);
  assert.equal(fs.existsSync(out), false);
});
