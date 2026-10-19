// Section 5 text scrub regressions (review 2026-10-19, findings 0, 2, 3). 모든 값은 지어낸 것이다.
// cleanText 하나가 모든 이벤트 텍스트를 지운다: 경로 -> basename, URL -> host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/summarize.mjs';
import { SessionState } from '../src/session.mjs';
import { createRecordBuilder } from './fixtures/records.mjs';

const ct = (s) => cleanText(s, 400);
const noLeak = (out, markers) => {
  for (const m of markers) assert.equal(out.includes(m), false, `leaked ${m}: ${out}`);
};

test('finding 0: absolute paths after any delimiter reduce to the basename', () => {
  const cases = [
    ['see @/Users/victim/XPDIRat/f.txt ok', 'see @f.txt ok'],
    ['see **/Users/victim/XPDIRbold/f.txt** ok', 'see **f.txt** ok'],
    ['see _/Users/victim/XPDIRus/f.txt_ ok', 'see _f.txt_ ok'],
    ['log 2>/Users/victim/XPDIRgt/err.log', 'log 2>err.log'],
    ['cell |/Users/victim/XPDIRpipe/f.txt| end', 'cell |f.txt| end'],
    ['tag #/Users/victim/XPDIRhash/f.txt', 'tag #f.txt'],
    ['a;/Users/victim/XPDIRsemi/f.txt', 'a;f.txt'],
    ['파일\u2014/Users/victim/XPDIRdash/f.txt', '파일\u2014f.txt'],
    ['경로\uFF1A/Users/victim/XPDIRfw/f.txt', '경로\uFF1Af.txt'],
    ['경로는/Users/victim/XPDIRko/f.txt 입니다', '경로는f.txt 입니다'],
    ['홈~/XPDIRtilde/notes.md', '홈notes.md'],
    ['\u201C/Users/victim/XPDIRq/f.txt\u201D', '\u201Cf.txt\u201D'],
    ['\u300C/Users/victim/XPDIRbr/f.txt\u300D', '\u300Cf.txt\u300D'],
    ['open @C:\\Users\\victim\\XPDIRwin\\f.txt now', 'open @f.txt now'],
    ['open C:/Users/victim/XPDIRwin2/f.txt now', 'open f.txt now'],
  ];
  for (const [input, want] of cases) {
    const out = ct(input);
    noLeak(out, ['XPDIR', 'victim', '/Users']);
    assert.equal(out, want, input);
  }
});

test('finding 0: prose, git refs, relative paths and Korean slash words stay unchanged', () => {
  const same = [
    'edit src/summarize.mjs and docs/CONTRACT.md',
    'TCP/IP and/or I/O',
    'ratio 3.14/2 on 2026/10/19',
    'feature/foo/bar and release/2026.10',
    '예/아니오, 읽기/쓰기, 읽기/쓰기/실행, 추가/수정/삭제',
    'glob src/**/*.ts',
    'node.js and see github.com.',
    'is it summarize.mjs?',
  ];
  for (const s of same) assert.equal(ct(s), s);
});

test('finding 2: absolute paths that contain spaces reduce to the basename', () => {
  const cases = [
    ['open /Users/victim/Library/Application Support/XPDIRsp/notes.txt now', 'open notes.txt now'],
    ['in /Users/victim/My Docs/XPDIRsp/f.txt', 'in f.txt'],
    ['see ~/Library/Mobile Documents/com~apple~CloudDocs/XPDIRsp/plan.md', 'see plan.md'],
    ['at /Users/victim/Google Drive/My Drive/XPDIRsp/budget.xlsx.', 'at budget.xlsx.'],
    ['escaped /Users/victim/Application\\ Support/XPDIRsp/f.txt', 'escaped f.txt'],
    ['quoted "/Users/victim/Application Support/XPDIRsp/f.txt"', 'quoted "f.txt"'],
    ['dropbox /Users/victim/Dropbox (Personal)/XPDIRsp X/f.txt', 'dropbox f.txt'],
    ['win C:\\Users\\victim\\My Documents\\XPDIRsp\\f.txt', 'win f.txt'],
    ['name /Users/victim/Application Support/My Notes.txt', 'name My Notes.txt'],
  ];
  for (const [input, want] of cases) {
    const out = ct(input);
    noLeak(out, ['XPDIRsp', 'victim', 'Application Support/', 'My Drive/']);
    assert.equal(out, want, input);
  }
  // 줄바꿈은 경로를 잇지 않는다; 공백 뒤 새 절대 경로는 따로 지운다
  assert.equal(ct('/tmp/a.txt /tmp/b.txt'), 'a.txt b.txt');
  assert.equal(ct('edit /tmp/a.txt then src/b.mjs'), 'edit a.txt then src/b.mjs');
});

test('finding 3: scheme-less URLs reduce to the host', () => {
  const cases = [
    ['see github.com/org/XUPATHns?k=1 ok', 'see github.com ok'],
    ['www.example.com/XUPATHns?token=XUQns', 'www.example.com'],
    ['dev at localhost:3000/XUPATHns?x=XUQns.', 'dev at localhost:3000.'],
    ['api 10.0.0.5:8080/XUPATHns?q=XUQns', 'api 10.0.0.5:8080'],
    ['(docs.invented.example/XUPATHns#frag)', '(docs.invented.example)'],
    ['clone git@github.com:org/XUPATHns.git', 'clone github.com'],
    ['cdn //cdn.example.com/XUPATHns/app.js', 'cdn cdn.example.com'],
    ['prefix_https://x.example/XUPATHns', 'prefix_x.example'],
    ['branch victim@corp.example/XUPATHns', 'branch (email)'], // userinfo@host/x is an email: no domain either
    ['링크github.com/XUPATHns 참고', '링크github.com 참고'],
  ];
  for (const [input, want] of cases) {
    const out = ct(input);
    noLeak(out, ['XUPATHns', 'XUQns']);
    assert.equal(out, want, input);
  }
  // a scheme-less URL then a spaced path on the same line: both are reduced, nothing is merged across
  assert.equal(ct('see github.com/org/XUPATHns then /tmp/a b/c.txt'), 'see github.com then c.txt');
});

test('findings 0, 2, 3: every SessionState text channel uses the same scrub', () => {
  const sid = '7a7a7a7a-1111-4222-8333-444455556666';
  const b = createRecordBuilder({ sessionId: sid, cwd: '/work/demo' });
  const st = new SessionState({ id: sid, kind: 'main', stem: sid, now: () => Date.parse('2026-01-01T00:10:00Z') });
  const text = 'look @/Users/victim/XPDIRat/f.txt, /Users/victim/Application Support/XPDIRsp/n.txt and github.com/org/XUPATHns';
  const events = [];
  for (const r of [
    b.humanPrompt({ text }),
    b.assistantThinking({ msgId: 'm1', text: `${text}.` }),
    b.assistantText({ msgId: 'm1', text }),
    b.askUse({ msgId: 'm2', id: 'toolu_q', questions: [{ question: text, header: 'H', options: [{ label: '@/Users/victim/XPDIRat/o' }] }] }),
    b.bashUse({ msgId: 'm3', id: 'toolu_b', command: 'true', description: text }),
    b.toolResult({ toolUseId: 'toolu_b', isError: true, content: text }),
  ]) events.push(...st.apply(r));
  const blob = JSON.stringify(events.map((e) => ({ ...e, project: undefined })));
  noLeak(blob, ['XPDIR', 'XUPATHns', 'victim']);
  assert.ok(events.some((e) => e.type === 'prompt'), 'prompt event emitted');
  assert.equal(st.title.includes('XPDIR'), false);
});

test('scrub stays fast on adversarial 1 KB input', () => {
  const t0 = Date.now();
  for (const seed of ['a.', '/a', 'a/', '( ', '\\ ', 'a@b.', '경/', 'mcp__a-', '.a/']) cleanText(seed.repeat(600), 400);
  cleanText(`/x${' a'.repeat(500)}`, 400);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('integrator: leading // paths, UNC, glob-cut directories, file:// with spaces and email/path never leak', () => {
  const cases = [
    ['see //server/share/XSECRETdbl/f.txt now', 'see f.txt now'],
    ['"//Users/victim/XSECRETdbl/f.txt"', '"f.txt"'],
    ['x = ///Users/victim/XSECRETdbl/f.txt', 'x = f.txt'],
    ['Error: cannot open //server/share/XSECRETunc/f.txt', 'Error: cannot open f.txt'],
    ['open \\\\server\\share\\XSECRETunc\\x.txt', 'open x.txt'],
    ['/Users/victim/XCLIENTglob/*.pdf', '*.pdf'],
    ['Glob /Users/victim/XCLIENTglob/**/*.ts', 'Glob **/*.ts'],
    ['~/XCLIENTglob/*.md', '*.md'],
    ['C:\\Users\\victim\\XCLIENTglob\\*.docx', '*.docx'],
    ['/Users/victim/XCLIENTglob/<name>.txt', '<name>.txt'],
    ['open file:///Users/victim/Application Support/XFILEsp/y.txt now', 'open y.txt now'],
    ['file://localhost/Users/victim/XFILEsp/z.txt', 'z.txt'],
    ['mail user@example.com/XMAILpath', 'mail (email)'],
    ['victim.person@corp.example/XMAILbranch.', '(email).'],
  ];
  for (const [input, want] of cases) {
    const out = ct(input);
    noLeak(out, ['XSECRET', 'XCLIENT', 'XFILE', 'XMAIL', 'victim', 'example.com', 'corp.example']);
    assert.equal(out, want, input);
  }
  // unchanged: comment slashes, doubled slashes inside words, relative globs keep their shape
  for (const s of ['a // b comment', 'foo//bar', '//', 'see github.com.', 'TCP/IP and/or I/O']) assert.equal(ct(s), s);
  assert.equal(ct('**/foo/*.mjs'), '**/*.mjs');
  // git's scp form keeps its host (a login, not a personal address)
  assert.equal(ct('git@github.com:org/x.git'), 'github.com');
});

test('finding 2: ExitPlanMode plan items scrub spaced paths, live and in snapshotEvents()', () => {
  const sid = '7a7a7a7a-1111-4222-8333-444455556666';
  const b = createRecordBuilder({ sessionId: sid, cwd: '/work/demo' });
  const st = new SessionState({ id: sid, kind: 'main', stem: sid, now: () => Date.parse('2026-01-01T00:10:00Z') });
  const plan = [
    '# Plan',
    '## Edit open /Users/victim/Library/Application Support/XMKF2APPSUP/notes.txt now',
    '## Edit open ~/Google Drive/My Drive/XMKF2MYDRIVE/budget.xlsx',
    '## Edit open /Users/victim/Application\\ Support/XMKF2ESCAPED/f.txt',
  ].join('\n');
  const events = [];
  for (const r of [b.humanPrompt({ text: 'plan it' }), b.exitPlanUse({ msgId: 'm1', id: 'toolu_p', plan })]) events.push(...st.apply(r));
  const live = events.filter((e) => e.type === 'plan');
  assert.equal(live.length, 1);
  const snap = st.snapshotEvents().filter((e) => e.type === 'plan');
  for (const ev of [...live, ...snap]) {
    assert.deepEqual(ev.items.map((i) => i.content), ['Plan', 'Edit open notes.txt now', 'Edit open budget.xlsx', 'Edit open f.txt']);
    noLeak(JSON.stringify(ev), ['XMKF2', 'Support', 'Drive', 'victim']);
  }
});

test('integrator (corpus replay): env-var rooted paths and paths hidden behind control chars reduce to the basename', () => {
  const cases = [
    ['PreToolUse:Bash hook error: [$CLAUDE_PROJECT_DIR/.claude/hooks/XVARhook.sh]: blocked', 'PreToolUse:Bash hook error: [XVARhook.sh]: blocked'],
    ['cd $HOME/XVARdir/sub && ls', 'cd sub && ls'],
    ['${HOME}/XVARbr/x.txt', 'x.txt'],
    ['see \u001b[1m/Users/victim/XCTLansi/f.txt\u001b[0m now', 'see f.txt now'],
    ['한\u200b/Users/victim/XCTLzw/f.txt', '한f.txt'],
    ['ls\u001b[1m/Users/victim/XCTLglued/f.txt\u001b[0m', 'lsf.txt'], // a colour code ends in a letter: still a boundary
    ['링크\u001b[4mhttps://x.example.com/XCTLurl?k=1', '링크x.example.com'],
    ['x\u0007/Users/victim/XCTLbel/f.txt', 'xf.txt'],
  ];
  for (const [input, want] of cases) {
    const out = ct(input);
    noLeak(out, ['XVARdir', 'XVARbr', 'XCTL', 'victim', '.claude', 'CLAUDE_PROJECT_DIR']);
    assert.equal(out, want, input);
  }
  // a directory path with a trailing separator glued to Hangul is still a path; Korean slash words are not
  assert.equal(ct('설정/.claude/` 폴더'), '설정.claude` 폴더');
  for (const s of ['예/아니오/', '읽기/쓰기/실행']) assert.equal(ct(s), s);
  // not paths: prices, '$/month', a bare variable
  for (const s of ['$5/month', 'price $1/2', 'echo $PATH']) assert.equal(ct(s), s);
});
