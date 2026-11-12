#!/usr/bin/env node
// 호스팅 데모(GitHub Pages) 빌드: public/ 을 그대로 복사하고, index.html 은 로컬 서버와 같은 문서 껍데기
// (src/page-shell.mjs)로 public/office.html 을 감싼 완전한 문서로 쓴다. 호스팅 페이지에만 필요한 것
// (lang="en", description, canonical, Open Graph, Twitter card)은 <head> 에 넣고 office.html 은 바꾸지 않는다.
// 의존성 없음 (node:* 만). 네트워크를 쓰지 않고, out 폴더 밖에는 아무것도 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageHead, PAGE_TAIL } from '../src/page-shell.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEMO_URL = 'https://wahyzmaster.github.io/office-sim/';
export const OG_IMAGE_NAME = 'og.png';
export const OG_IMAGE_SOURCE = 'docs/assets/theme-studio.png';
export const DEFAULT_OUT = '_site';
const TITLE = 'Office Sim: a 3D office for your AI coding agents';

export const USAGE = `Usage: node scripts/build-demo.mjs [options]

  Builds the static demo site that GitHub Pages serves at ${DEMO_URL}

  --out <dir>   output directory (default: ${DEFAULT_OUT}); created when missing, existing files are overwritten
  -h, --help    show this help
`;

/** argv -> { out } or { help: true }. Throws Error on a bad argument. */
export function parseBuildArgs(argv) {
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    let value;
    if (arg === '--out') {
      i += 1;
      value = argv[i];
    } else if (arg.startsWith('--out=')) {
      value = arg.slice('--out='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--out needs a directory');
    if (out !== null) throw new Error('--out given twice');
    out = value;
  }
  return { out: out ?? DEFAULT_OUT };
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The tags only the hosted page needs. Every value is escaped here. */
export function demoHeadTags({ description }) {
  const meta = (attr, key, content) => `<meta ${attr}="${key}" content="${escapeAttr(content)}">`;
  return meta('name', 'description', description)
    + `<link rel="canonical" href="${escapeAttr(DEMO_URL)}">`
    + meta('property', 'og:title', TITLE)
    + meta('property', 'og:description', description)
    + meta('property', 'og:type', 'website')
    + meta('property', 'og:url', DEMO_URL)
    + meta('property', 'og:image', DEMO_URL + OG_IMAGE_NAME)
    + meta('name', 'twitter:card', 'summary_large_image');
}

// a 가 b 와 같거나 b 안에 있는가 (둘 다 절대 경로)
function within(a, b) {
  const rel = path.relative(b, a);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); // '..site' 는 안쪽 이름이다
}

// 실제 위치: 이미 있는 데까지는 심볼릭 링크를 풀고 디스크에 적힌 철자로 바꾼다 (대소문자를 가리지 않는 파일 시스템에서
// PUBLIC 과 public 은 같은 폴더다; .native 만 철자를 바로잡는다). 아직 없는 꼬리는 그대로 붙인다.
// 깨진 링크는 "없는 폴더"가 아니다: 어디로 쓰게 될지 알 수 없으므로 거절한다.
function realLocation(abs) {
  const missing = [];
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync.native(cur), ...missing);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    let entry; // 풀리지는 않는데 이름은 있다 = 깨진 링크. ENOTDIR 은 조상이 파일이라는 뜻이고, 그 이름은 없는 것이다
    try {
      entry = fs.lstatSync(cur, { throwIfNoEntry: false });
    } catch (err) {
      if (err?.code !== 'ENOTDIR') throw err;
    }
    if (entry) throw new Error(`out dir goes through a broken link: ${cur}`);
    if (path.dirname(cur) === cur) return path.join(cur, ...missing);
    missing.unshift(path.basename(cur));
  }
}

/**
 * Writes the site into outDir and returns { outDir, indexBytes }. The out dir check and the input checks (package
 * description, office.html, the og image) all run before the first write, so a refused build leaves the out dir as
 * it was (not even created). A failure during the copy itself can still leave a partial site.
 * @param {{ outDir: string, root?: string }} o  root: the repository root to read from (tests pass a synthetic one).
 */
export function buildDemo({ outDir, root = REPO_ROOT }) {
  const src = path.resolve(root);
  const out = path.resolve(outDir);
  const publicDir = path.join(src, 'public');
  // 복사할 원본 위에 쓰지 않는다: 저장소 뿌리(와 그 위)와 public/ 안은 거절한다. 글자가 아니라 실제 위치로 비교하고,
  // 비교한 바로 그 위치(dest)에 쓴다. 돌려주는 outDir 은 받은 경로 그대로다.
  const dest = realLocation(out);
  if (within(realLocation(src), dest) || within(dest, realLocation(publicDir))) {
    throw new Error(`out dir must not be the repository root, a parent of it, or inside public/: ${out}`);
  }
  const description = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).description;
  if (typeof description !== 'string' || description.trim() === '') throw new Error('package.json has no description');
  const fragment = fs.readFileSync(path.join(publicDir, 'office.html'), 'utf8');
  const ogSource = path.join(src, OG_IMAGE_SOURCE);
  if (!fs.statSync(ogSource, { throwIfNoEntry: false })?.isFile()) throw new Error(`${OG_IMAGE_SOURCE} is missing or not a file`);
  const index = pageHead({ lang: 'en', extraHead: demoHeadTags({ description }) }) + fragment + PAGE_TAIL;

  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(publicDir, dest, { recursive: true, filter: (from) => path.basename(from) !== '.DS_Store' });
  fs.writeFileSync(path.join(dest, 'index.html'), index);
  fs.copyFileSync(ogSource, path.join(dest, OG_IMAGE_NAME));
  fs.writeFileSync(path.join(dest, '.nojekyll'), ''); // Pages 가 Jekyll 을 돌리지 않게 (밑줄로 시작하는 파일도 그대로 낸다)
  return { outDir: out, indexBytes: Buffer.byteLength(index) };
}

/** CLI. Returns the exit code: 0 done, 1 build failed, 2 bad arguments. */
export function run(argv, { say = console.log, warn = console.error } = {}) {
  let opts;
  try {
    opts = parseBuildArgs(argv);
  } catch (err) {
    warn(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }
  try {
    const res = buildDemo({ outDir: opts.out });
    say(`demo site written to ${res.outDir} (index.html ${res.indexBytes} bytes, ${OG_IMAGE_NAME}, .nojekyll, public/)`);
    return 0;
  } catch (err) {
    warn(`build failed: ${err?.message ?? err}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
