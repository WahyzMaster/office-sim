// Launch readiness W8: the structure a first-time visitor reads, checked cheaply as text. The wording is free; what is
// pinned is where things are (the first screen), that both READMEs carry the same tables and commands, and that the
// documents added with them exist. Facts that other tests already pin (the port, the Node floor, the desktop paths,
// the estimate wording) are not repeated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BASES } from '../src/adapters/antigravity/discover.mjs';
import { USAGE } from '../src/cli-args.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const lines = (rel) => read(rel).split('\n');
const READMES = ['README.md', 'README.ko.md'];
const TOP = 40; // "the first screen"
const HANGUL = /[ㄱ-ㆎ가-힣]/;

test('first screen: the npx line is in the first 40 lines, and no internal code, DOM id or endpoint path is', () => {
  for (const rel of READMES) {
    const top = lines(rel).slice(0, TOP);
    assert.ok(top.includes('npx office-sim'), `${rel}: a line that is exactly "npx office-sim" (it opens the browser itself, D7)`);
    for (const re of [/P5/, /#notify-toggle/, /\/api\//]) assert.doesNotMatch(top.join('\n'), re, rel);
    // what it is, not how it is built
    assert.doesNotMatch(top.join('\n'), /\btail|JSONL|\bSSE\b|250 ?ms|0\.25초/i, `${rel}: implementation words on the first screen`);
    // the detection is partial (the coverage table says where), so the first screen makes no such claim
    assert.doesNotMatch(top.join('\n'), /needs you|which agent is waiting|productiv|생산성/i, rel);
  }
  // three behaviour bullets, before the quick start
  const en = lines('README.md');
  const quick = en.findIndex((l) => /^## Quick start/i.test(l));
  assert.ok(quick > 0 && quick < TOP, 'README.md: the quick start heading is on the first screen');
  assert.equal(en.slice(0, quick).filter((l) => l.startsWith('- ')).length, 3, 'README.md: three bullets above the quick start');
  const ko = lines('README.ko.md');
  const quickKo = ko.findIndex((l) => /^## 빠른 시작/.test(l));
  assert.ok(quickKo > 0 && quickKo < TOP, 'README.ko.md: the quick start heading is on the first screen');
  assert.equal(ko.slice(0, quickKo).filter((l) => l.startsWith('- ')).length, 3, 'README.ko.md: three bullets above the quick start');
});

test('the whole READMEs: no phase code, no DOM id, no hook speed claim, the old quick start is gone', () => {
  for (const rel of READMES) {
    const text = read(rel);
    for (const re of [/\bP5[a-z]?\b/, /#notify-toggle/, /#capture-clip/, /sub-10 ?ms|10 ?ms 미만/, /npx office-sim --open/]) {
      assert.doesNotMatch(text, re, rel);
    }
    assert.equal(text.split('buymeacoffee.com').length - 1, 1, `${rel}: one sponsorship mention`);
  }
});

test('the detection coverage table is in both READMEs, with the same five rows', () => {
  const en = lines('README.md');
  const head = en.indexOf('| Agent | Question to the user | Plan approval | Permission prompt | Turn finished |');
  assert.ok(head > 0, 'README.md: the coverage table header');
  const ko = lines('README.ko.md');
  const headKo = ko.indexOf('| 에이전트 | 사용자에게 하는 질문 | 계획 승인 | 권한 요청 | 턴 종료 |');
  assert.ok(headKo > 0, 'README.ko.md: the coverage table header');
  const rows = ['Claude Code', 'Codex', 'Grok Build', 'Antigravity', 'Gemini CLI'];
  for (const [rel, all, at] of [['README.md', en, head], ['README.ko.md', ko, headKo]]) {
    const body = all.slice(at + 2, at + 2 + rows.length);
    rows.forEach((name, i) => {
      assert.ok(body[i].startsWith(`| ${name}`), `${rel}: row ${i + 1} is ${name}`);
      assert.equal(body[i].split('|').length - 2, 5, `${rel}: ${name} has five cells`);
      for (const cell of body[i].split('|').slice(1, -1)) assert.notEqual(cell.trim(), '', `${rel}: ${name} has an empty cell`);
    });
    // a Claude Code permission prompt needs the plugin or the hooks; the three agents without a signal say so
    assert.match(body[0].split('|')[4], /plugin|플러그인/, `${rel}: the Claude Code permission cell names the plugin`);
    for (const i of [1, 3, 4]) assert.match(body[i].split('|')[4], /Not detected|감지하지 못/, `${rel}: ${rows[i]} permission cell`);
    // plan approval is a wait for Claude Code and Grok only
    for (const i of [1, 3, 4]) assert.match(body[i].split('|')[3], /Not detected|감지하지 못/, `${rel}: ${rows[i]} plan cell`);
    for (const i of [0, 2]) assert.match(body[i].split('|')[3], /^ (Yes|예) /, `${rel}: ${rows[i]} plan cell`);
  }
  // the two lines under the table: the known limit, and how far the hook path is tested
  const under = (all, at) => all.slice(at + 2 + rows.length, at + 2 + rows.length + 6);
  assert.ok(under(en, head).some((l) => /^Known limit: /.test(l) && /waiting/.test(l)), 'README.md: the known-limit line');
  assert.ok(under(ko, headKo).some((l) => /^알려진 한계: /.test(l) && /대기 중/.test(l)), 'README.ko.md: the known-limit line');
  assert.ok(under(en, head).some((l) => /hook path/.test(l) && /fixture payloads/.test(l) && l.includes('/issues)')), 'README.md: the hook-testing line');
  assert.ok(under(ko, headKo).some((l) => /훅 경로/.test(l) && /예시 요청/.test(l) && l.includes('/issues)')), 'README.ko.md: the hook-testing line');
});

test('feature bullets name no endpoint path', () => {
  for (const [rel, heading] of [['README.md', '## Features'], ['README.ko.md', '## 기능']]) {
    const all = lines(rel);
    const from = all.indexOf(heading);
    assert.ok(from > 0, `${rel}: ${heading}`);
    const to = all.findIndex((l, i) => i > from && l.startsWith('## '));
    const bullets = all.slice(from + 1, to).filter((l) => l.startsWith('- '));
    assert.ok(bullets.length >= 8, `${rel}: feature bullets`);
    for (const b of bullets) assert.doesNotMatch(b, /\/api\/|`\/(state|events|healthz|observe)\b/, `${rel}: ${b.slice(0, 50)}`);
  }
});

test('what reaches the page: both lists name the pieces of a tool call that are sent, not only the excerpts', () => {
  // src/summarize.mjs puts a Grep pattern, a web or MCP query, the description of a command or subagent task and the
  // option labels of a question into tool_start (CONTRACT 3.1). The FAQ answer and the privacy bullet must say so.
  const pick = (rel, faq, bullet) => {
    const all = lines(rel);
    const q = all.indexOf(faq);
    assert.ok(q > 0, `${rel}: ${faq}`);
    const b = all.find((l) => l.startsWith(bullet));
    assert.ok(b, `${rel}: ${bullet}`);
    return [all[q + 1], b];
  };
  for (const text of pick('README.md', '**Does it read my code?**', '- **What reaches the page**')) {
    for (const re of [/search pattern/, /quer(y|ies)/, /description/, /option labels/, /CONTRACT\.md/]) assert.match(text, re, text.slice(0, 40));
  }
  for (const text of pick('README.ko.md', '**내 코드를 읽나요?**', '- **페이지로 가는 것**')) {
    for (const re of [/검색 패턴/, /검색어/, /설명/, /선택지/, /CONTRACT\.md/]) assert.match(text, re, text.slice(0, 40));
  }
});

test('Antigravity: the specification, the help text and both READMEs name every folder the adapter enters', () => {
  const contract = read('docs/CONTRACT.md');
  const s48 = contract.slice(contract.indexOf('### 4.8 Antigravity adapter'), contract.indexOf('\n## 5. '));
  const help = USAGE.slice(USAGE.indexOf('--antigravity-root'), USAGE.indexOf('--plugins'));
  assert.deepEqual([...BASES], ['antigravity-cli', 'antigravity-ide', 'antigravity']);
  // the discovery rule itself: the sentence that says which folders are entered
  const entered = s48.slice(s48.indexOf('app folders under it are entered'), s48.indexOf('the only transcript paths accepted'));
  assert.ok(entered.length > 0, 'CONTRACT 4.8: the discovery sentence');
  for (const base of BASES) {
    assert.ok(entered.includes(`\`<root>/${base}/\``), `CONTRACT 4.8 discovery names <root>/${base}/`);
    assert.match(help, new RegExp(`(^|[^-\\w])${base}/`), `--help names ${base}/`);
    for (const rel of READMES) assert.ok(read(rel).includes(`~/.gemini/${base}/`), `${rel} names ~/.gemini/${base}/`);
  }
  // the desktop app folder is read since 0.2.0 (BASES), so no document may still say that it is not
  assert.doesNotMatch(help, /never the desktop/);
  assert.doesNotMatch(contract, /nothing under `<root>\/antigravity\/` is listed/);
  assert.doesNotMatch(contract, /whole desktop-app folder `antigravity\/` (is|are) never opened/);
  assert.doesNotMatch(contract, /the desktop app is out of scope/);
  for (const rel of READMES) assert.doesNotMatch(read(rel), /help line is out of date|도움말이 뒤처진/, rel);
  // what stays closed there
  assert.match(s48, /`conversations\/`/);
});

test('the plugin install commands are the ones the marketplace file gives, and init is the alternative', () => {
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  const install = `/plugin install ${market.plugins[0].name}@${market.name}`;
  assert.equal(install, '/plugin install office-sim@office-sim');
  for (const rel of READMES) {
    const all = lines(rel);
    assert.ok(all.includes('/plugin marketplace add WahyzMaster/office-sim'), rel);
    assert.ok(all.includes(install), rel);
    assert.ok(all.includes('npx office-sim init'), rel);
  }
});

test('the short sections exist in both languages', () => {
  const heads = (rel) => lines(rel).filter((l) => l.startsWith('## '));
  for (const re of [/^## Why/, /^## What it detects/, /^## FAQ/, /^## Troubleshooting/, /^## Contributing/, /^## Claude Code plugin/]) {
    assert.ok(heads('README.md').some((h) => re.test(h)), `README.md: ${re}`);
  }
  for (const re of [/^## 왜 /, /^## 무엇을 감지하나/, /^## 자주 묻는 질문/, /^## 문제 해결/, /^## 기여하기/, /^## Claude Code 플러그인/]) {
    assert.ok(heads('README.ko.md').some((h) => re.test(h)), `README.ko.md: ${re}`);
  }
  assert.match(read('README.md'), /\(CONTRIBUTING\.md\)/);
  assert.match(read('README.ko.md'), /\(CONTRIBUTING\.md\)/);
  assert.match(read('README.md'), /\(CHANGELOG\.md\)/);
  assert.match(read('README.ko.md'), /\(CHANGELOG\.md\)/);
});

test('README.md tables are in English', () => {
  // One row is left out: test/grok-docs.test.mjs (P5g) pins a Korean phrase in the Grok row of the supported-agents
  // table. Every other table row of the English file has no Korean text.
  const rows = lines('README.md').filter((l) => l.startsWith('|') && !l.startsWith('| Grok (xAI Grok Build) |'));
  assert.ok(rows.length > 30);
  assert.deepEqual(rows.filter((l) => HANGUL.test(l)).map((l) => l.slice(0, 60)), []);
});

test('CHANGELOG.md has a 0.12.0 entry grouped for users', () => {
  const text = read('CHANGELOG.md');
  const at = text.search(/^## \[?0\.12\.0\]?/m);
  assert.ok(at >= 0, 'a 0.12.0 heading');
  const entry = text.slice(at).split(/\n## /)[0];
  for (const group of ['### Changed', '### Added', '### Removed', '### Fixed']) assert.ok(entry.includes(`\n${group}\n`), group);
  // the breaking points a user has to know
  for (const re of [/4747/, /--no-open/, /English/, /[Ss]ound/, /USD/, /PermissionRequest/, /manual/i]) assert.match(entry, re);
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
});

test('issue templates: three short forms, and blank issues stay enabled', () => {
  const dir = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
  const names = fs.readdirSync(dir).sort();
  // a bug report, a new agent adapter request, a theme or character idea
  for (const name of ['adapter_request.md', 'bug_report.md', 'config.yml', 'theme_idea.md']) assert.ok(names.includes(name), name);
  assert.match(read('.github/ISSUE_TEMPLATE/config.yml'), /^blank_issues_enabled: true$/m);
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    const text = read(`.github/ISSUE_TEMPLATE/${name}`);
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${name}: front matter`);
    assert.match(front[1], /^name: .+$/m, name);
    assert.match(front[1], /^about: .+$/m, name);
    assert.ok(text.split('\n').length <= 40, `${name} is short`);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, name);
  }
});

test('always-on and contributor documents name the 0.12.0 layout', () => {
  const claude = read('CLAUDE.md');
  assert.ok(Buffer.byteLength(claude) < 16000 && claude.split('\n').length < 220, 'CLAUDE.md stays inside its budget');
  for (const needle of ['src/cli-main.mjs', 'src/cli-init.mjs', 'src/hooks-bridge.mjs', 'public/vendor/', '4747']) {
    assert.ok(claude.includes(needle), `CLAUDE.md names ${needle}`);
  }
  const contributing = read('CONTRIBUTING.md');
  for (const needle of ['public/vendor/', 'node --test test/', 'public/js/rooms.js', 'src/adapters/']) {
    assert.ok(contributing.includes(needle), `CONTRIBUTING.md names ${needle}`);
  }
  // the scrub has no secret detector (src/summarize.mjs cleanText), so no document may say that tokens are stripped
  assert.doesNotMatch(contributing, /emails, tokens/);
  assert.doesNotMatch(read('docs/SOFTWARE_DEVELOPMENT_REPORT.md'), /bearer tokens|`implementation_plan\.md`/);
  // the npm listing: no "zero dependencies" claim (the page ships a vendored three.js), and the changelog is packed
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(pkg.description, /zero[- ]dependenc/i);
  assert.ok(pkg.files.includes('CHANGELOG.md'), 'package.json files: CHANGELOG.md');
  // every repo path these files put in backticks exists
  for (const rel of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONTRIBUTING.md']) {
    for (const m of read(rel).matchAll(/`((?:bin|src|public|scripts|skills|plugin|docs|test|\.github|\.claude-plugin|\.claude|\.apm)\/[A-Za-z0-9_./-]+)`/g)) {
      const p = m[1].replace(/\/$/, '');
      assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${rel}: ${p} does not exist`);
    }
  }
});
