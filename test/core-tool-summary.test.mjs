// src/core/tool-summary.mjs unit tests (ADAPTERS 3.2, 6.2, 7; CONTRACT 3.1, 5). 모든 입력은 지어낸 값이다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary, patchFiles, shellProgram, mcpToolName, TOOL_KINDS } from '../src/core/tool-summary.mjs';
import { ZERO_UUID } from '../src/summarize.mjs';

const UUID = '3f9c2a71-5b8e-4d10-9a6f-0c1d2e3f4a5b'; // invented connector id
const cps = (s) => Array.from(s).length;
const KEYS = new Set(['tool', 'summary', 'room', 'background']);

/** Every result has only the four public fields, a non-empty string summary and a string tool. */
function shape(r) {
  for (const k of Object.keys(r)) assert.ok(KEYS.has(k), `unexpected field ${k}`);
  assert.equal(typeof r.tool, 'string');
  assert.ok(r.tool.length > 0);
  assert.equal(typeof r.summary, 'string');
  assert.ok(r.summary.length > 0);
  assert.ok(cps(r.summary) <= 80);
  return r;
}
const ts = (d) => shape(toolSummary(d));

describe('output shape', () => {
  test('only tool, summary, room?, background? (safe to spread into a tool_start event)', () => {
    for (const kind of TOOL_KINDS) {
      ts({ tool: 'x', kind, path: '/a/b.txt', command: 'ls', url: 'https://h.example/p', query: 'q', description: 'd', background: true });
    }
  });
  test('malformed descriptors never throw and fall back to a label', () => {
    for (const d of [null, undefined, 'read_file', 42, [], { kind: 'weird' }, { tool: {}, kind: 'shell', argv: [null, {}, 3] },
      { tool: 'x', kind: 'edit', patch: 42, paths: 'nope' }, { tool: 'x', kind: 'web', url: {} }, { tool: 'x', mcpServer: 7 }]) {
      const r = ts(d);
      assert.ok(r.summary);
    }
    assert.deepEqual(toolSummary(null), { tool: 'tool', summary: 'tool', room: 'here' });
  });
  test('unknown kind counts as other', () => {
    assert.deepEqual(ts({ tool: 'mystery', kind: 'teleport' }), { tool: 'mystery', summary: 'mystery', room: 'here' });
  });
});

describe('room hint by kind (D4)', () => {
  const cases = [
    ['read', 'archive'], ['search', 'archive'], ['edit', 'dev'], ['web', 'research'], ['ask', 'desk'],
    ['agent', 'here'], ['other', 'here'], ['plan', 'meeting'],
  ];
  for (const [kind, room] of cases) {
    test(`${kind} -> ${room}`, () => assert.equal(ts({ tool: 't', kind }).room, room));
  }
  test('shell follows the Claude Bash program-name rule', () => {
    assert.equal(ts({ tool: 'sh', kind: 'shell', command: 'grep -rn foo src' }).room, 'archive');
    assert.equal(ts({ tool: 'sh', kind: 'shell', command: 'cat a.txt | head' }).room, 'archive');
    assert.equal(ts({ tool: 'sh', kind: 'shell', command: 'curl -s https://h.example/x' }).room, 'research');
    assert.equal(ts({ tool: 'sh', kind: 'shell', argv: ['wget', 'https://h.example/x'] }).room, 'research');
    assert.equal(ts({ tool: 'sh', kind: 'shell', command: 'npm test' }).room, 'server');
    assert.equal(ts({ tool: 'sh', kind: 'shell' }).room, 'server');
  });
  test('shell room uses the unwrapped bash -lc program', () => {
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['bash', '-lc', 'rg TODO src'] }).room, 'archive');
    assert.equal(ts({ tool: 'shell', kind: 'shell', command: 'bash -lc "curl -s https://h.example"' }).room, 'research');
  });
  test('mcp calls carry no room hint (the page classifies mcp__<server>__<tool>, ADAPTERS 6.2)', () => {
    const r = ts({ tool: 'call_mcp_tool', kind: 'search', mcpServer: 'codegraph', mcpTool: 'codegraph_search', query: 'Foo' });
    assert.equal(r.tool, 'mcp__codegraph__codegraph_search');
    assert.equal(r.room, undefined);
    assert.equal(ts({ tool: 'mcp__github__get_issue', kind: 'other' }).room, undefined);
  });
});

describe('mcp tool name normalization', () => {
  test('server + tool -> mcp__<server>__<tool>', () => {
    assert.equal(ts({ tool: 'use_tool', kind: 'other', mcpServer: 'github', mcpTool: 'get_issue' }).tool, 'mcp__github__get_issue');
  });
  test('uuid-looking server -> ZERO_UUID, the uuid appears nowhere', () => {
    const r = ts({ tool: 'call_mcp_tool', kind: 'other', mcpServer: UUID, mcpTool: 'get_issue', query: UUID, description: UUID });
    assert.equal(r.tool, `mcp__${ZERO_UUID}__get_issue`);
    assert.equal(r.summary, 'get issue');
    assert.ok(!JSON.stringify(r).includes(UUID));
  });
  test('raw mcp__<uuid>__x names are masked too (also one-char typos and bare mcp__<uuid>)', () => {
    assert.equal(ts({ tool: `mcp__${UUID}__list_issues`, kind: 'other' }).tool, `mcp__${ZERO_UUID}__list_issues`);
    assert.equal(ts({ tool: `mcp__${UUID}x__list_issues`, kind: 'other' }).tool, `mcp__${ZERO_UUID}__list_issues`);
    assert.equal(ts({ tool: `mcp__${UUID}`, kind: 'other' }).tool, `mcp__${ZERO_UUID}`);
  });
  test('a uuid token inside a server name is masked; human server names are kept', () => {
    assert.equal(mcpToolName(`conn_${UUID}`, 'x'), `mcp__conn_${ZERO_UUID}__x`);
    assert.equal(mcpToolName('claude.ai Linear', 'list issues'), 'mcp__claude_ai_Linear__list_issues');
    assert.equal(mcpToolName('plugin_firebase_firebase', 'firestore_get'), 'mcp__plugin_firebase_firebase__firestore_get');
  });
  test('missing server -> mcp, missing both -> not an mcp name', () => {
    assert.equal(mcpToolName(undefined, 'search'), 'mcp__mcp__search');
    assert.equal(mcpToolName('', ''), '');
    assert.equal(ts({ tool: 'use_tool', kind: 'other', mcpServer: '', mcpTool: '' }).tool, 'use_tool');
  });
  test('mcp summary prefers a short field, then the tool suffix with _ -> space', () => {
    assert.equal(ts({ tool: 'x', kind: 'other', mcpServer: 'context7', mcpTool: 'get_library_docs', query: 'react hooks' }).summary, 'react hooks');
    assert.equal(ts({ tool: 'x', kind: 'other', mcpServer: 'context7', mcpTool: 'get_library_docs' }).summary, 'get library docs');
    assert.equal(ts({ tool: 'x', kind: 'web', mcpServer: 'browser', mcpTool: 'navigate', url: 'https://a.example/p?q=1' }).summary, 'a.example');
  });
});

describe('read / edit: basename only', () => {
  test('path -> basename', () => {
    assert.equal(ts({ tool: 'read_file', kind: 'read', path: '/Users/alice/proj/src/a.mjs' }).summary, 'a.mjs');
    assert.equal(ts({ tool: 'view_file', kind: 'read', path: 'C:\\Users\\alice\\proj\\b.ts' }).summary, 'b.ts');
    assert.equal(ts({ tool: 'write', kind: 'edit', path: 'file:///Users/alice/c.md' }).summary, 'c.md');
  });
  test('paths -> first basename + (+N), deduped', () => {
    assert.equal(ts({ tool: 'r', kind: 'read', paths: ['/Users/alice/a.mjs', '/Users/alice/b.mjs', '/tmp/a.mjs'] }).summary, 'a.mjs (+1)');
  });
  test('path wins over patch', () => {
    assert.equal(ts({ tool: 'e', kind: 'edit', path: '/x/one.txt', patch: '*** Update File: two.txt\n' }).summary, 'one.txt');
  });
  test('no file -> description, then tool name', () => {
    assert.equal(ts({ tool: 'write_file', kind: 'edit', description: 'Write the notes' }).summary, 'Write the notes');
    assert.equal(ts({ tool: 'write_file', kind: 'edit' }).summary, 'write_file');
  });
});

describe('patch: file names from headers, body discarded', () => {
  const APPLY = [
    '*** Begin Patch',
    '*** Update File: /Users/alice/proj/src/x.mjs',
    '@@ function secretFn()',
    '-const SECRET_OLD = "hunter2";',
    '+++ b/leaked-from-body',
    '+const SECRET_NEW = "correct horse";',
    '*** Add File: docs/y.md',
    '+hello body',
    '*** Delete File: old.txt',
    '*** Update File: a.mjs',
    '*** Move to: b.mjs',
    '*** End Patch',
  ].join('\n');
  test('apply_patch headers (Update, Add, Delete, Move to)', () => {
    assert.deepEqual(patchFiles(APPLY), ['x.mjs', 'y.md', 'old.txt', 'a.mjs', 'b.mjs']);
    const r = ts({ tool: 'apply_patch', kind: 'edit', patch: APPLY });
    assert.equal(r.summary, 'x.mjs (+4)');
    for (const bait of ['hunter2', 'SECRET', 'correct horse', 'leaked-from-body', 'hello body', 'secretFn', '/Users/alice']) {
      assert.ok(!JSON.stringify(r).includes(bait), bait);
    }
  });
  const GIT = [
    'diff --git a/src/a.mjs b/src/a.mjs',
    'index 111..222 100644',
    '--- a/src/a.mjs',
    '+++ b/src/a.mjs',
    '@@ -1,3 +1,4 @@',
    ' context',
    '--- removed-line-body',
    '+++ b/leaked-from-body',
    '+added secret body',
    ' tail',
    'diff --git a/lib/b.mjs b/lib/b.mjs',
    'deleted file mode 100644',
    '--- a/lib/b.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  test('unified diff: diff --git and --- / +++ pairs; hunk bodies are skipped by their line counts', () => {
    assert.deepEqual(patchFiles(GIT), ['a.mjs', 'b.mjs']);
    const r = ts({ tool: 'edit', kind: 'edit', patch: GIT });
    assert.equal(r.summary, 'a.mjs (+1)');
    for (const bait of ['leaked-from-body', 'removed-line-body', 'added secret', 'bye']) assert.ok(!JSON.stringify(r).includes(bait), bait);
  });
  test('plain unified diff without a git header, timestamps stripped', () => {
    assert.deepEqual(patchFiles('--- /Users/alice/old/c.txt\t2026-01-01\n+++ /Users/alice/new/c.txt\t2026-01-02\n@@ -1 +1 @@\n-a\n+b\n'), ['c.txt']);
  });
  test('non-patch text yields no names', () => {
    assert.deepEqual(patchFiles('just some text\n+++ not a header'), []);
    assert.deepEqual(patchFiles(''), []);
    assert.deepEqual(patchFiles(null), []);
  });
  test('a 1 MB patch is read only up to its cap and returns quickly', () => {
    const big = '*** Begin Patch\n*** Update File: a.mjs\n' + '+x secret\n'.repeat(120000) + '*** Add File: late.mjs\n';
    const t0 = Date.now();
    assert.deepEqual(patchFiles(big), ['a.mjs']);
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe('shell: program name (+ allowed subcommand), never arguments', () => {
  test('command string -> programOf', () => {
    assert.equal(ts({ tool: 'exec_command', kind: 'shell', command: 'git commit -m "secret message"' }).summary, 'git commit');
    assert.equal(ts({ tool: 'exec_command', kind: 'shell', command: 'cd /Users/alice/p && npm run build' }).summary, 'npm run');
    assert.equal(ts({ tool: 'exec_command', kind: 'shell', command: 'rm -rf /Users/alice/x' }).summary, 'rm');
  });
  test('argv -> argv[0] basename, wrappers and allowed subcommands like programOf', () => {
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['/usr/bin/git', 'push', 'origin', 'main'] }).summary, 'git push');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['sudo', '-u', 'root', 'rm', '-rf', '/'] }).summary, 'rm');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['./scripts/deploy.sh', '--token=abc'] }).summary, 'deploy.sh');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['cat', "it's /Users/alice/.ssh/id_rsa"] }).summary, 'cat');
  });
  test('bash|sh|zsh -lc "<string>" is unwrapped (argv and command string)', () => {
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['bash', '-lc', 'cd /Users/alice/r && git status'] }).summary, 'git status');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['/bin/zsh', '-c', 'flutter test'] }).summary, 'flutter test');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['sh', '-e', '-c', 'make build'] }).summary, 'make build');
    assert.equal(ts({ tool: 'shell', kind: 'shell', command: 'bash -lc "rm -rf /Users/alice/x"' }).summary, 'rm');
    assert.equal(ts({ tool: 'shell', kind: 'shell', command: "zsh -c 'bash -c \"gh pr view\"'" }).summary, 'gh pr');
  });
  test('a shell that is not the program is not unwrapped', () => {
    assert.equal(ts({ tool: 'shell', kind: 'shell', command: 'echo hi; bash -c "rm -rf /"' }).summary, 'echo');
    assert.equal(ts({ tool: 'shell', kind: 'shell', argv: ['bash', 'script.sh'] }).summary, 'bash');
  });
  test('description (<= 60) wins over the program', () => {
    const r = ts({ tool: 'run_terminal_command', kind: 'shell', command: 'rm -rf /Users/alice', description: 'Clean build output' });
    assert.equal(r.summary, 'Clean build output');
    assert.equal(r.room, 'server');
    const long = ts({ tool: 't', kind: 'shell', command: 'ls', description: 'x'.repeat(200) });
    assert.equal(cps(long.summary), 60);
  });
  test('no usable program -> tool name', () => {
    assert.equal(ts({ tool: 'exec_command', kind: 'shell', command: '   ' }).summary, 'exec_command');
    assert.equal(ts({ tool: 'exec_command', kind: 'shell', argv: [] }).summary, 'exec_command');
  });
  test('shellProgram is exported and never throws', () => {
    assert.deepEqual(shellProgram({ argv: ['git', 'status'] }), { program: 'git', sub: 'status' });
    assert.equal(shellProgram(null), null);
    assert.equal(shellProgram({ command: 'x'.repeat(2_000_000) }), null);
  });
});

describe('web: host only; search: query <= 60', () => {
  test('url -> host, never path, query or userinfo', () => {
    const r = ts({ tool: 'web_fetch', kind: 'web', url: 'https://user:pw@docs.example.com/private/path?token=abc#frag' });
    assert.equal(r.summary, 'docs.example.com');
    for (const bait of ['token=abc', 'private', 'pw', 'user']) assert.ok(!JSON.stringify(r).includes(bait), bait);
  });
  test('unparsable url never shows the url', () => {
    const r = ts({ tool: 'web_fetch', kind: 'web', url: '/Users/alice/notes?token=1' });
    assert.equal(r.summary, 'web_fetch');
  });
  test('web search query is scrubbed and capped at 60', () => {
    assert.equal(ts({ tool: 'search_web', kind: 'web', query: 'mail me@corp.example about /Users/alice/x' }).summary, 'mail (email) about x');
    assert.equal(cps(ts({ tool: 'search_web', kind: 'web', query: 'q'.repeat(300) }).summary), 60);
  });
  test('search: query (<= 40) · basename(path), like Claude Grep', () => {
    assert.equal(ts({ tool: 'grep', kind: 'search', query: 'TODO', path: '/Users/alice/proj/src' }).summary, 'TODO \u00B7 src');
    assert.equal(cps(ts({ tool: 'grep', kind: 'search', query: 'p'.repeat(100), path: '/a/b' }).summary.split(' \u00B7 ')[0]), 40);
    assert.equal(ts({ tool: 'find_by_name', kind: 'search', query: '*.mjs' }).summary, '*.mjs');
    assert.equal(ts({ tool: 'list_dir', kind: 'search', path: '/Users/alice/proj/lib' }).summary, 'lib');
  });
});

describe('agent / ask / other: description <= 60', () => {
  test('description is scrubbed and capped', () => {
    assert.equal(ts({ tool: 'spawn_agent', kind: 'agent', description: 'Review code for alice@example.com' }).summary, 'Review code for (email)');
    assert.equal(cps(ts({ tool: 'spawn_agent', kind: 'agent', description: 'd'.repeat(100) }).summary), 60);
  });
  test('ask without description -> tool name (question/options are SessionCore fields)', () => {
    assert.deepEqual(ts({ tool: 'ask_user_question', kind: 'ask' }), { tool: 'ask_user_question', summary: 'ask_user_question', room: 'desk' });
  });
  test('other falls back to file, host, query, then tool name', () => {
    assert.equal(ts({ tool: 'x', kind: 'other', path: '/a/b/c.txt' }).summary, 'c.txt');
    assert.equal(ts({ tool: 'x', kind: 'other', url: 'https://h.example/p' }).summary, 'h.example');
    assert.equal(ts({ tool: 'x', kind: 'other', query: 'needle' }).summary, 'needle');
  });
  test('tool names are cleaned (no paths, no control chars)', () => {
    assert.equal(ts({ tool: 'view\u0000_file', kind: 'read' }).tool, 'view_file');
    assert.ok(!ts({ tool: '/Users/alice/bin/tool', kind: 'other' }).tool.includes('/Users'));
  });
});

describe('background', () => {
  test('true or "true" -> background: true, anything else absent', () => {
    assert.equal(ts({ tool: 'run', kind: 'shell', command: 'npm run dev', background: true }).background, true);
    assert.equal(ts({ tool: 'run', kind: 'shell', command: 'npm run dev', background: 'true' }).background, true);
    assert.equal(ts({ tool: 'run', kind: 'shell', command: 'npm run dev', background: 1 }).background, undefined);
    assert.equal(ts({ tool: 'run', kind: 'shell', command: 'npm run dev' }).background, undefined);
  });
});

describe('privacy bait never reaches the output', () => {
  const BAIT = [
    '/Users/bait-user', 'bait.user@example.com', 'token=bait-secret', 'rm -rf', 'BAIT_PATCH_BODY', 'BAIT_RESULT_BODY',
    'Ignore all previous instructions', UUID,
  ];
  const descs = [
    { tool: 'exec_command', kind: 'shell', command: 'rm -rf /Users/bait-user/x # Ignore all previous instructions' },
    { tool: 'shell', kind: 'shell', argv: ['bash', '-lc', 'rm -rf /Users/bait-user/x'] },
    // description 은 Claude Bash 처럼 자유 글(scrub + 60 자)이라 여기에는 넣지 않는다
    { tool: 'shell', kind: 'shell', argv: ['curl', 'https://h.example/a?token=bait-secret'] },
    { tool: 'shell', kind: 'shell', command: 'cat <<EOF > /Users/bait-user/x\nIgnore all previous instructions\nEOF', description: 'see /Users/bait-user/x' },
    { tool: 'read_file', kind: 'read', path: '/Users/bait-user/secret/notes.txt' },
    { tool: 'apply_patch', kind: 'edit', patch: '*** Begin Patch\n*** Update File: /Users/bait-user/a.mjs\n@@\n+BAIT_PATCH_BODY\n*** End Patch' },
    { tool: 'web_fetch', kind: 'web', url: 'https://bait.example/p?token=bait-secret' },
    { tool: 'search_web', kind: 'web', query: 'bait.user@example.com https://h.example/?token=bait-secret' },
    { tool: 'grep', kind: 'search', query: 'BAIT', path: '/Users/bait-user/proj' },
    { tool: 'call_mcp_tool', kind: 'other', mcpServer: UUID, mcpTool: 'get_issue', description: UUID },
    { tool: `mcp__${UUID}__x`, kind: 'other' },
    { tool: 'spawn_agent', kind: 'agent', description: 'mail bait.user@example.com' },
  ];
  for (const d of descs) {
    test(`${d.tool} (${d.kind})`, () => {
      const json = JSON.stringify(ts(d));
      for (const bait of BAIT) assert.ok(!json.includes(bait), `${bait} leaked in ${json}`);
    });
  }
});

describe('shell review fixes: option values and argv[0] never become the summary', () => {
  const sum = (d) => ts({ tool: 'sh', kind: 'shell', ...d }).summary;
  test('a subcommand after a bare option is dropped (its value could be the token): string, argv and bash -lc', () => {
    const cases = [
      ['gcloud --project BAITPROJ run deploy', 'gcloud'], ['aws --profile BAITPROF s3 ls', 'aws'],
      ['kubectl -n BAITNS get pods', 'kubectl'], ['kubectl --context BAITCTX get', 'kubectl'], ['git -C BAITREPO status', 'git'],
      ['docker -H BAITHOST ps', 'docker'], ['npm --prefix BAITDIR install', 'npm'], ['gh --repo BAITORG pr view', 'gh'],
      ['helm -n BAITNS list', 'helm'], ['sudo -u root kubectl -n BAITNS get pods', 'kubectl'],
    ];
    for (const [command, want] of cases) {
      assert.equal(sum({ command }), want, command);
      assert.equal(sum({ argv: command.split(' ') }), want, `argv ${command}`);
      assert.equal(sum({ argv: ['bash', '-lc', command] }), want, `bash -lc ${command}`);
      assert.equal(sum({ command: `cd /w && bash -lc "${command}"` }), want, `nested ${command}`);
    }
  });
  test('subcommands without an option before them are kept (same as Claude Bash)', () => {
    const cases = [
      ['git status', 'git status'], ['npm run dev', 'npm run'], ['./gradlew build', 'gradlew build'], ['git push origin main', 'git push'],
      ['kubectl --context=prod get pods', 'kubectl get'], ['sudo -u root git status', 'git status'], ['cd /w && make build', 'make build'],
    ];
    for (const [command, want] of cases) assert.equal(sum({ command }), want, command);
  });
  test('an empty, non-string, assignment or keyword argv[0] has no program: tool label (or description)', () => {
    for (const argv of [['', 'BAIT_ARG'], [null, 'BAIT_ARG'], [{ x: 1 }, 'BAIT_ARG'], ['(', 'BAIT_ARG'], ['  ', 'BAIT_ARG'],
      ['FOO=1', 'BAIT_ARG'], ['!', 'BAIT_ARG'], ['if', 'BAIT_ARG'], ['rm -rf /Users/me/BAIT_ARG', 'x']]) {
      assert.equal(sum({ argv }), 'sh', JSON.stringify(argv));
      assert.equal(sum({ command: argv }), 'sh', `command array ${JSON.stringify(argv)}`);
      assert.equal(sum({ argv, description: 'Run the tests' }), 'Run the tests');
    }
  });
  test('a one-element argv holding a whole command line is read as a command string', () => {
    assert.equal(sum({ argv: ['cat ~/.ssh/BAIT_KEY'] }), 'cat');
    assert.equal(sum({ command: ['git push https://github.com/org/BAIT_REPO'] }), 'git push');
  });
});
