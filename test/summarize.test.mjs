// summarize.mjs unit tests (CONTRACT 3.1, 5). 모든 입력은 지어낸 값이다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, truncate, hostOf } from '../src/summarize.mjs';

const UUID = '3f9c2a71-5b8e-4d10-9a6f-0c1d2e3f4a5b'; // invented connector id
const UUID_TYPO = '3f9c2a71-5b8e-4d10-9a6f-0c1d2e3f4a5bx';
const cps = (s) => Array.from(s).length;
const wellFormed = (s) => {
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
};

describe('ignore list (app plumbing)', () => {
  const ignored = [
    'mcp__ccd_session__mark_chapter', 'mcp__ccd_session__spawn_task', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up',
    'mcp__ccd_pr__set_auto_merge', 'mcp__ccd_session_mgmt__list_sessions', 'mcp__ccd_view__show_pane', 'mcp__ccd_window__close_split',
    'mcp__ccd_host__open_in_editor', 'mcp__ccd_connectors__session_connectors_status', 'mcp__ccd_sidebar__set_pinned',
    'mcp__ccd_settings__get_settings', 'mcp__ccd_directory__change_directory',
    'ToolSearch', 'ListAgents', 'ListMcpResourcesTool', 'mcp__visualize__read_me', 'mcp__serena__initial_instructions',
    'mcp__firebase__firebase_get_environment', 'mcp__computer-use__request_access', 'mcp__computer-use__request_full_control',
    'mcp__computer-use__release_full_control', 'mcp__computer-use__app_release', 'mcp__claude-in-chrome__tabs_context_mcp',
    'mcp__claude-in-chrome__list_connected_browsers', 'mcp__Claude_Browser__tabs_context', 'mcp__Claude_Browser__preview_list',
  ];
  for (const name of ignored) {
    test(`${name} is ignored`, () => {
      const r = summarize(name, { query: 'select:Read', run_in_background: true, title: 'chapter' });
      assert.equal(r.ignore, true);
      assert.equal(typeof r.summary, 'string');
      assert.ok(r.summary.length > 0);
      assert.equal(r.room, undefined);
      assert.equal(r.background, undefined);
    });
  }
  test('neighbouring tools are not ignored', () => {
    const kept = [
      'mcp__visualize__show_widget', 'mcp__serena__find_symbol', 'mcp__firebase__firestore_get_document', 'mcp__computer-use__app_click',
      'mcp__claude-in-chrome__computer', 'mcp__Claude_Browser__preview_start', 'mcp__ccdx__thing', 'ReadMcpResourceTool', 'Read',
    ];
    for (const name of kept) assert.equal(summarize(name, {}).ignore, undefined, name);
  });
});

describe('Bash', () => {
  test('description wins and is capped at 60 code points', () => {
    assert.deepEqual(summarize('Bash', { command: 'rm -rf /Users/alice/build', description: 'Clean build output' }), {
      summary: 'Clean build output',
      room: 'server',
    });
    const long = 'Run the complete integration suite against the local emulator with coverage enabled';
    const r = summarize('Bash', { command: 'npm test', description: long });
    assert.equal(cps(r.summary), 60);
    assert.ok(r.summary.endsWith('\u2026'));
  });
  test('blank or non-string description falls back to the program name', () => {
    assert.equal(summarize('Bash', { command: 'git status', description: '   ' }).summary, 'git status');
    assert.equal(summarize('Bash', { command: 'git status', description: 42 }).summary, 'git status');
  });
  test('room is decided by the program even when a description is shown', () => {
    assert.deepEqual(summarize('Bash', { command: 'grep -rn needle .', description: 'Search for usages' }), {
      summary: 'Search for usages',
      room: 'archive',
    });
  });
  const table = [
    ['cd /Users/alice/proj && git status', 'git status', 'server'],
    ['cd /Users/alice/proj&&git status --short', 'git status', 'server'],
    ['FOO=1 BAR="a b" npm test -- --watch', 'npm test', 'server'],
    ['cd "/Users/alice/my proj" && NODE_ENV=test flutter test --coverage', 'flutter test', 'server'],
    ['env TMPDIR=/tmp/scratch flutter test test/widget_test.dart', 'flutter test', 'server'],
    ['sudo npm install', 'npm install', 'server'],
    ['export PATH=/opt/tools/bin:$PATH && make build', 'make build', 'server'],
    ['set -e; source .venv/bin/activate && pytest -q', 'pytest', 'server'],
    ['cd /Users/alice/proj || exit 1; dart analyze lib', 'dart analyze', 'server'],
    ['git -C /Users/alice/repo log --oneline', 'git log', 'server'],
    ['git -c user.name=alice commit -m "invented secret message"', 'git commit', 'server'],
    ['git "status"', 'git status', 'server'],
    ['git /Users/alice/repo', 'git', 'server'],
    ['git', 'git', 'server'],
    ['./scripts/deploy.sh --prod', 'deploy.sh', 'server'],
    ['/usr/bin/git status', 'git status', 'server'],
    ['./gradlew bundleRelease', 'gradlew bundleRelease', 'server'],
    ['timeout 30s npx jest --ci', 'npx jest', 'server'],
    ['nice -n 10 cargo build --release', 'cargo build', 'server'],
    ['# warm up\nnpm run lint', 'npm run', 'server'],
    ['echo invented-secret-value', 'echo', 'server'],
    ['python3 /Users/alice/tools/scrape.py --key=abc', 'python3', 'server'],
    ['cd /Users/alice/proj', 'cd', 'server'],
    ['cat /Users/alice/.ssh/id_invented', 'cat', 'archive'],
    ['grep -rn password /Users/alice/proj', 'grep', 'archive'],
    ['rg TODO src', 'rg', 'archive'],
    ['ls -la ~/Documents', 'ls', 'archive'],
    ['find . -name "*.ts" | xargs wc -l', 'find', 'archive'],
    ['for f in *.md; do wc -l "$f"; done', 'wc', 'archive'],
    ['jq .version package.json', 'jq', 'archive'],
    ['tree -L 2', 'tree', 'archive'],
    ['curl -s "https://api.example.test/v1?token=tok_invented"', 'curl', 'research'],
    ['wget http://example.test/file.zip', 'wget', 'research'],
    ['http GET example.test', 'http', 'research'],
  ];
  for (const [command, summary, room] of table) {
    test(`fallback: ${JSON.stringify(command)} -> ${summary}`, () => {
      assert.deepEqual(summarize('Bash', { command }), { summary, room });
    });
  }
  test('missing, blank or non-string command -> tool name, room server', () => {
    for (const input of [{}, { command: '' }, { command: '   ' }, { command: ['ls'] }, { command: 'VAR=1' }]) {
      assert.deepEqual(summarize('Bash', input), { summary: 'Bash', room: 'server' }, JSON.stringify(input));
    }
  });
  test('run_in_background accepts true and the string "true" only', () => {
    assert.equal(summarize('Bash', { command: 'npm run dev', run_in_background: true }).background, true);
    assert.equal(summarize('Bash', { command: 'npm run dev', run_in_background: 'true' }).background, true);
    assert.equal(summarize('Bash', { command: 'npm run dev', run_in_background: ' TRUE ' }).background, true);
    for (const v of [false, 'false', 1, 'yes', null, undefined]) {
      assert.equal(summarize('Bash', { command: 'npm run dev', run_in_background: v }).background, undefined, String(v));
    }
  });
});

describe('Monitor', () => {
  test('description, else program; same rooms as Bash; persistent is not background', () => {
    assert.deepEqual(summarize('Monitor', { description: 'Wait for the dev server', command: 'tail -f /Users/alice/x.log' }), {
      summary: 'Wait for the dev server',
      room: 'archive',
    });
    assert.deepEqual(summarize('Monitor', { command: 'cd /Users/alice && npm run watch', persistent: 'true' }), {
      summary: 'npm run',
      room: 'server',
    });
    assert.deepEqual(summarize('Monitor', { command: 'curl -sf localhost:3000/healthz' }), { summary: 'curl', room: 'research' });
  });
});

describe('Read / Edit / Write / NotebookEdit', () => {
  const path = '/Users/alice/proj/src/index.ts';
  test('Read basename, with L<offset>-<offset+limit> only when both are numeric', () => {
    assert.deepEqual(summarize('Read', { file_path: path }), { summary: 'index.ts' });
    assert.equal(summarize('Read', { file_path: path, offset: 10, limit: 20 }).summary, 'index.ts L10-30');
    assert.equal(summarize('Read', { file_path: path, offset: '5', limit: '10' }).summary, 'index.ts L5-15');
    assert.equal(summarize('Read', { file_path: path, offset: 10 }).summary, 'index.ts');
    assert.equal(summarize('Read', { file_path: path, limit: 10 }).summary, 'index.ts');
    assert.equal(summarize('Read', { file_path: path, offset: [1, 2], limit: 5 }).summary, 'index.ts');
    assert.equal(summarize('Read', { file_path: path, offset: 'ten', limit: 5 }).summary, 'index.ts');
  });
  test('Edit / Write show the basename only, never content', () => {
    const e = summarize('Edit', { file_path: path, old_string: 'OLD_MARKER', new_string: 'NEW_MARKER', replace_all: false });
    assert.deepEqual(e, { summary: 'index.ts' });
    const w = summarize('Write', { file_path: '/Users/alice/proj/README.md', content: 'CONTENT_MARKER' });
    assert.deepEqual(w, { summary: 'README.md' });
  });
  test('NotebookEdit uses notebook_path or file_path; Windows and trailing separators', () => {
    assert.equal(summarize('NotebookEdit', { notebook_path: '/Users/alice/nb/analysis.ipynb' }).summary, 'analysis.ipynb');
    assert.equal(summarize('NotebookEdit', { file_path: '/Users/alice/nb/other.ipynb' }).summary, 'other.ipynb');
    assert.equal(summarize('Read', { file_path: 'C:\\Users\\alice\\notes.txt' }).summary, 'notes.txt');
    assert.equal(summarize('Read', { file_path: '/Users/alice/proj/' }).summary, 'proj');
  });
  test('missing file_path -> tool name; long Korean basename cut by code point', () => {
    assert.equal(summarize('Read', {}).summary, 'Read');
    assert.equal(summarize('Write', { file_path: '/' }).summary, 'Write');
    const r = summarize('Write', { file_path: `/Users/alice/${'가'.repeat(70)}.md` });
    assert.equal(cps(r.summary), 60);
    assert.ok(wellFormed(r.summary));
  });
});

describe('Grep / Glob', () => {
  test('Grep: pattern (<= 40) + basename(path)', () => {
    assert.equal(summarize('Grep', { pattern: 'useState', path: '/Users/alice/proj/components' }).summary, 'useState \u00B7 components');
    assert.equal(summarize('Grep', { pattern: 'useState' }).summary, 'useState');
    assert.equal(summarize('Grep', {}).summary, 'Grep');
    const r = summarize('Grep', { pattern: 'x'.repeat(80), path: '/Users/alice/proj/src' });
    assert.equal(r.summary, `${'x'.repeat(39)}\u2026 \u00B7 src`);
  });
  test('Glob: pattern; absolute patterns lose their leading directories', () => {
    assert.equal(summarize('Glob', { pattern: 'src/**/*.ts' }).summary, 'src/**/*.ts');
    assert.equal(summarize('Glob', { pattern: '/Users/alice/proj/**/*.md', path: '/Users/alice' }).summary, '**/*.md');
    assert.equal(summarize('Glob', { pattern: '~/proj/docs/*.md' }).summary, '*.md');
    assert.equal(summarize('Glob', {}).summary, 'Glob');
  });
});

describe('WebFetch, *navigate, preview_start and hostOf', () => {
  test('WebFetch shows the host only', () => {
    const r = summarize('WebFetch', { url: 'https://docs.example.test/guide/intro?session=tok_invented#part', prompt: 'PROMPT_MARKER' });
    assert.deepEqual(r, { summary: 'docs.example.test' });
    assert.equal(summarize('WebFetch', { url: 'http://localhost:3000/api/items?token=tok_invented' }).summary, 'localhost:3000');
    assert.equal(summarize('WebFetch', { url: 'localhost:3000/api' }).summary, 'localhost:3000');
    assert.equal(summarize('WebFetch', { url: 'https://user:pw_invented@example.test/x' }).summary, 'example.test');
    assert.equal(summarize('WebFetch', { url: 'not a url' }).summary, 'WebFetch');
    assert.equal(summarize('WebFetch', {}).summary, 'WebFetch');
  });
  test('hostOf', () => {
    const cases = [
      ['https://Example.TEST/Path?q=1', 'example.test'],
      ['http://localhost:3000/x?token=abc', 'localhost:3000'],
      ['localhost:3000', 'localhost:3000'],
      ['example.test', 'example.test'],
      ['example.test/a/b?c=d', 'example.test'],
      ['//cdn.example.test/lib.js', 'cdn.example.test'],
      ['http://[::1]:8080/x', '[::1]:8080'],
      ['http://127.0.0.1:4317/events', '127.0.0.1:4317'],
      ['https://user:pass@example.test/', 'example.test'],
      ['/Users/alice/secret', ''],
      ['file:///Users/alice/secret.txt', ''],
      ['mailto:alice@example.test', ''],
      ['javascript:alert(1)', ''],
      ['not a url', ''],
      ['http://', ''],
      ['', ''],
      [null, ''],
      [42, ''],
      [{ href: 'https://example.test' }, ''],
    ];
    for (const [input, want] of cases) assert.equal(hostOf(input), want, JSON.stringify(input));
  });
  test('*navigate tools and preview_start use the host', () => {
    assert.equal(summarize('mcp__Claude_Browser__navigate', { url: 'https://app.example.test/a?b=c', tabId: 't1' }).summary, 'app.example.test');
    assert.equal(summarize('mcp__claude-in-chrome__navigate', { url: 'http://localhost:5173/' }).summary, 'localhost:5173');
    assert.equal(summarize('mcp__playwright__browser_navigate', { url: 'https://example.test/login' }).summary, 'example.test');
    assert.equal(summarize('mcp__playwright__browser_navigate_back', {}).summary, 'browser navigate back');
    assert.equal(summarize('mcp__Claude_Browser__preview_start', { url: 'http://localhost:8080/app' }).summary, 'localhost:8080');
    assert.equal(summarize('mcp__Claude_Browser__preview_start', { name: 'web-dev' }).summary, 'preview start');
  });
});

describe('WebSearch / tavily_search', () => {
  test('query truncated to 60 code points (Korean safe)', () => {
    assert.deepEqual(summarize('WebSearch', { query: 'node test runner', allowed_domains: ['example.test'] }), {
      summary: 'node test runner',
    });
    const ko = '서울 날씨 '.repeat(15);
    const r = summarize('WebSearch', { query: ko });
    assert.equal(cps(r.summary), 60);
    assert.ok(r.summary.endsWith('\u2026'));
    assert.ok(wellFormed(r.summary));
    assert.equal(summarize(`mcp__${UUID}__tavily_search`, { query: 'three.js fog' }).summary, 'three.js fog');
    assert.equal(summarize('WebSearch', {}).summary, 'WebSearch');
  });
});

describe('Agent / Workflow', () => {
  test('Agent: description + built-in subagent_type only', () => {
    for (const type of ['general-purpose', 'Explore', 'Plan']) {
      assert.equal(summarize('Agent', { description: 'Map the router', subagent_type: type, prompt: 'P' }).summary, `Map the router \u00B7 ${type}`);
    }
    assert.equal(summarize('Agent', { description: 'Review diff', subagent_type: 'code-reviewer' }).summary, 'Review diff');
    assert.equal(summarize('Agent', { subagent_type: 'Explore' }).summary, 'Explore');
    assert.equal(summarize('Agent', { subagent_type: 'code-reviewer' }).summary, 'Agent');
    const bg = summarize('Agent', { description: 'Long job', prompt: 'PROMPT_MARKER', run_in_background: true });
    assert.deepEqual(bg, { summary: 'Long job', background: true });
  });
  test('Workflow: description ?? basename(scriptPath) ?? inline workflow', () => {
    assert.equal(summarize('Workflow', { description: 'Parallel review', script: 'SCRIPT_MARKER' }).summary, 'Parallel review');
    assert.equal(summarize('Workflow', { scriptPath: '/Users/alice/.claude/workflows/review.mjs', args: { k: 'ARGS_MARKER' } }).summary, 'review.mjs');
    assert.equal(summarize('Workflow', { script: 'SCRIPT_MARKER', description: '' }).summary, 'inline workflow');
    assert.deepEqual(summarize('Workflow', { script: 'x', run_in_background: 'true' }), { summary: 'inline workflow', background: true });
  });
});

describe('Skill / SendMessage / TaskCreate / TaskUpdate / AskUserQuestion / ExitPlanMode', () => {
  test('Skill name only', () => {
    assert.equal(summarize('Skill', { skill: 'frontend-design', args: 'ARGS_MARKER' }).summary, 'frontend-design');
    assert.equal(summarize('Skill', { skill: 'apps/web:deploy' }).summary, 'web:deploy');
    assert.equal(summarize('Skill', {}).summary, 'Skill');
  });
  test('SendMessage: to <name> from to|recipient', () => {
    assert.equal(summarize('SendMessage', { to: 'reviewer', message: 'MESSAGE_MARKER' }).summary, 'to reviewer');
    assert.equal(summarize('SendMessage', { recipient: 'helper', content: 'MESSAGE_MARKER' }).summary, 'to helper');
    assert.equal(summarize('SendMessage', { message: 'MESSAGE_MARKER' }).summary, 'SendMessage');
  });
  test('TaskCreate subject', () => {
    assert.equal(summarize('TaskCreate', { subject: 'Write tests', description: 'D', activeForm: 'Writing tests' }).summary, 'Write tests');
    assert.equal(summarize('TaskCreate', {}).summary, 'TaskCreate');
  });
  test('TaskUpdate: #<id> -> <status> with taskId|id|task_id', () => {
    assert.equal(summarize('TaskUpdate', { taskId: '3', status: 'completed' }).summary, '#3 -> completed');
    assert.equal(summarize('TaskUpdate', { id: 4, status: 'in_progress', activeForm: 'Doing it' }).summary, '#4 -> in_progress');
    assert.equal(summarize('TaskUpdate', { task_id: '#5', status: 'deleted' }).summary, '#5 -> deleted');
    assert.equal(summarize('TaskUpdate', { taskId: '7' }).summary, '#7');
    assert.equal(summarize('TaskUpdate', { status: 'completed' }).summary, 'task -> completed');
    assert.equal(summarize('TaskUpdate', {}).summary, 'TaskUpdate');
  });
  test('AskUserQuestion: headers joined, never question or option text', () => {
    const input = {
      questions: [
        { question: 'QUESTION_MARKER?', header: 'Storage', multiSelect: false, options: [{ label: 'OPTION_MARKER', description: 'D' }] },
        { question: 'Q2', header: 'Auth' },
        { question: 'Q3' },
      ],
    };
    const r = summarize('AskUserQuestion', input);
    assert.deepEqual(r, { summary: 'Storage \u00B7 Auth' });
    assert.equal(summarize('AskUserQuestion', { questions: 'bad' }).summary, 'AskUserQuestion');
  });
  test('ExitPlanMode: plan ready', () => {
    const r = summarize('ExitPlanMode', { plan: '# PLAN_MARKER', planFilePath: '/Users/alice/plans/p.md' });
    assert.deepEqual(r, { summary: 'plan ready' });
  });
});

describe('mcp tools', () => {
  test('a uuid server segment is never shown', () => {
    const calls = [
      [`mcp__${UUID}__get_issue`, { id: 'ABC-12', includeRelations: true }, 'get issue'],
      [`mcp__${UUID}__query-docs`, { libraryId: '/vercel/next.js', query: 'app router' }, 'app router'],
      [`mcp__${UUID}__resolve-library-id`, { libraryName: 'react' }, 'react'],
      [`mcp__${UUID}__save_issue`, { title: 'Fix login', description: 'DESC_MARKER' }, 'Fix login'],
      [`mcp__${UUID}__outlook_send_mail`, { to: 'alice@example.test', body: 'BODY_MARKER' }, 'outlook send mail'],
      [`mcp__${UUID_TYPO}__notion-search`, { query: 'roadmap' }, 'roadmap'],
      [`mcp__${UUID}`, {}, 'mcp tool'],
      [`mcp__${UUID}__`, {}, 'mcp tool'],
    ];
    for (const [name, input, want] of calls) {
      const r = summarize(name, input);
      assert.equal(r.summary, want, name);
      assert.ok(!JSON.stringify(r).includes('3f9c2a71'), name);
    }
  });
  test('human server names: descriptive key, else suffix with _ -> space', () => {
    const calls = [
      ['mcp__codegraph__codegraph_search', { query: 'SessionState', projectPath: '/Users/alice/proj' }, 'SessionState'],
      ['mcp__github__create_issue', { title: 'Broken build', body: 'BODY_MARKER' }, 'Broken build'],
      ['mcp__playwright__browser_snapshot', {}, 'browser snapshot'],
      ['mcp__playwright__browser_type', { element: 'Search box', text: 'TYPED_MARKER' }, 'Search box'],
      ['mcp__Claude_Browser__computer', { action: 'left_click', text: 'TYPED_MARKER' }, 'left_click'],
      ['mcp__claude-in-chrome__computer', { action: 'screenshot', action_summary: 'Capture the page' }, 'Capture the page'],
      ['mcp__claude-in-chrome__javascript_tool', { action: 'javascript_exec', text: 'JS_MARKER' }, 'javascript_exec'],
      ['mcp__firebase__firestore_query_collection', { collection_path: 'users/u_invented/orders', filters: [{ v: 'F' }] }, 'orders'],
      ['mcp__firebase__firestore_list_documents', { collectionId: 'notices', pageToken: 'TOKEN_MARKER' }, 'notices'],
      ['mcp__firebase__firestore_get_document', { name: 'projects/p/databases/d/documents/users/u1' }, 'firestore get document'],
      ['mcp__terminal__run_in_terminal', { command: 'CMD_MARKER', title: 'dev server', cwd: '/Users/alice' }, 'dev server'],
      ['mcp__computer-use__app_batch', { app: 'Notes', actions: [] }, 'app batch'],
      ['mcp__Context7__resolve-library-id', { libraryName: 'three' }, 'three'],
      ['mcp__visualize__show_widget', { title: 'Plan diagram', widget_code: '<svg/>' }, 'Plan diagram'],
      ['mcp__x__y', { title: 'T', query: 'Q' }, 'Q'],
      ['mcp__github', {}, 'mcp__github'],
    ];
    for (const [name, input, want] of calls) assert.equal(summarize(name, input).summary, want, name);
  });
});

describe('__unparsedToolInput', () => {
  test('<tool> (unparsed input), raw never shown, uuid never shown', () => {
    const raw = { __unparsedToolInput: { raw: '{"secret": "RAW_MARKER', len: 900 } };
    assert.deepEqual(summarize('StructuredOutput', raw), { summary: 'StructuredOutput (unparsed input)', room: 'here' });
    assert.deepEqual(summarize('Read', raw), { summary: 'Read (unparsed input)' });
    assert.equal(summarize('AskUserQuestion', raw).summary, 'AskUserQuestion (unparsed input)');
    const m = summarize(`mcp__${UUID}__save_issue`, raw);
    assert.equal(m.summary, 'save issue (unparsed input)');
    assert.ok(!JSON.stringify(m).includes('RAW_MARKER'));
  });
});

describe('unknown tools, odd inputs, rooms', () => {
  test('unknown tools render as the tool name', () => {
    assert.deepEqual(summarize('bash', { command: 'ls', description: 'D' }), { summary: 'bash' });
    assert.deepEqual(summarize('BashOutput', { bash_id: 'x' }), { summary: 'BashOutput' });
    assert.deepEqual(summarize('BrandNewTool', { secret: 'SECRET_MARKER' }), { summary: 'BrandNewTool' });
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.deepEqual(summarize(name, {}), { summary: name });
  });
  test('non-string tool names and garbage inputs never throw', () => {
    for (const tool of [undefined, null, 42, {}, []]) assert.deepEqual(summarize(tool, {}), { summary: 'tool' });
    for (const input of [null, undefined, 'str', 42, [], [{ command: 'x' }], { command: { nested: true } }]) {
      for (const tool of ['Bash', 'Read', 'Agent', 'AskUserQuestion', `mcp__${UUID}__get_issue`, 'TaskUpdate']) {
        const r = summarize(tool, input);
        assert.equal(typeof r.summary, 'string');
        assert.ok(r.summary.length > 0);
      }
    }
  });
  test('room hints', () => {
    assert.equal(summarize('TaskOutput', { task_id: 'b1', block: 'true' }).room, 'server');
    assert.equal(summarize('TaskStop', { task_id: 'b1' }).room, 'server');
    assert.equal(summarize('StructuredOutput', { summary: 'S', findings: [] }).room, 'here');
    assert.equal(summarize('SubagentHandback', { message: 'HANDBACK_MARKER' }).room, 'here');
    assert.equal(summarize('ScheduleWakeup', { delaySeconds: 60, prompt: 'P' }).room, 'lounge');
    for (const name of ['Read', 'Edit', 'WebFetch', 'Agent', 'Workflow', 'Grep', `mcp__${UUID}__get_issue`]) {
      assert.equal(summarize(name, {}).room, undefined, name);
    }
  });
});

describe('truncate', () => {
  test('length and ellipsis', () => {
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('exact', 5), 'exact');
    assert.equal(truncate('abcdefghij', 5), 'abcd\u2026');
    assert.equal(truncate('abc def', 5), 'abc\u2026');
    assert.equal(truncate('abcdef', 1), '\u2026');
    assert.equal(truncate('abcdef', 0), '');
    assert.equal(truncate('  keep   all  ', undefined), 'keep all');
  });
  test('Korean and emoji are cut by code point, never leaving broken surrogates', () => {
    assert.equal(truncate('가나다라마바사', 4), '가나다\u2026');
    const e = truncate('😀😀😀😀', 3);
    assert.equal(e, '😀😀\u2026');
    assert.equal(cps(e), 3);
    assert.ok(wellFormed(e));
    assert.equal(truncate('a\uD800b\uDC00c', 10), 'abc');
    for (let n = 1; n <= 8; n++) assert.ok(wellFormed(truncate('한😀글🎉자'.repeat(3), n)), String(n));
  });
  test('control characters stripped, whitespace collapsed', () => {
    assert.equal(truncate('a\u0000b\u0007c\u007fd\u009be', 20), 'abcde');
    assert.equal(truncate('\u001b[31mred\u001b[0m text', 20), 'red text');
    assert.equal(truncate('\u202Eevil\u2066x\u2069', 20), 'evilx');
    assert.equal(truncate('  a \n\t b \r\n c  ', 20), 'a b c');
    assert.equal(truncate('a\u200Bb', 20), 'ab');
  });
  test('non-string input', () => {
    assert.equal(truncate(null, 5), '');
    assert.equal(truncate(undefined, 5), '');
    assert.equal(truncate({}, 5), '');
    assert.equal(truncate(['a'], 5), '');
    assert.equal(truncate(12345678, 4), '123\u2026');
    assert.equal(truncate(true, 10), 'true');
  });
  test('summaries never carry control characters', () => {
    const r = summarize('Bash', { command: 'x', description: 'Build\u0000 the\napp\u001b[0m' });
    assert.equal(r.summary, 'Build the app');
  });
});

describe('privacy sweep', () => {
  const DIRS = ['Users', 'alice-secret', 'private-dir', 'node_modules'];
  const FILE = '/Users/alice-secret/private-dir/notes.md';
  const pathCalls = [
    ['Read', { file_path: FILE, offset: 1, limit: 2 }],
    ['Edit', { file_path: FILE, old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: FILE, content: 'c' }],
    ['NotebookEdit', { notebook_path: '/Users/alice-secret/private-dir/n.ipynb' }],
    ['Grep', { pattern: 'needle', path: '/Users/alice-secret/private-dir/src' }],
    ['Workflow', { scriptPath: '/Users/alice-secret/private-dir/wf.mjs' }],
    ['Bash', { command: `cd /Users/alice-secret/private-dir && FOO=/Users/alice-secret/x cat ${FILE}` }],
    ['Bash', { command: '/Users/alice-secret/private-dir/node_modules/.bin/jest --config=/Users/alice-secret/j.json' }],
    ['Bash', { command: 'git -C /Users/alice-secret/private-dir status' }],
    ['Bash', { command: `python3 ${FILE}` }],
    ['Bash', { command: 'ls', description: `Show ${FILE} and ~/private-dir/x` }],
    ['Monitor', { command: `tail -f /Users/alice-secret/private-dir/server.log` }],
    ['Glob', { pattern: '/Users/alice-secret/private-dir/**/*.md' }],
    ['ExitPlanMode', { plan: 'p', planFilePath: FILE }],
  ];
  test('no summary contains a "/" path segment from file_path or the raw command', () => {
    for (const [tool, input] of pathCalls) {
      const r = summarize(tool, input);
      if (tool !== 'Glob') assert.ok(!r.summary.includes('/'), `${tool}: ${r.summary}`);
      for (const d of DIRS) assert.ok(!r.summary.includes(d), `${tool} leaked ${d}: ${r.summary}`);
    }
  });
  const MARKERS = ['MARKER', 'tok_invented', 'pw_invented', 'alice@example.test'];
  const contentCalls = [
    ['Bash', { command: 'curl -H "Authorization: Bearer tok_invented" https://x.test/?k=tok_invented' }],
    ['Bash', { command: 'echo MARKER', description: 'Mail alice@example.test via https://x.test/a?token=tok_invented' }],
    ['Write', { file_path: '/tmp/a.txt', content: 'MARKER' }],
    ['Edit', { file_path: '/tmp/a.txt', old_string: 'MARKER', new_string: 'MARKER' }],
    ['Agent', { description: 'd', prompt: 'MARKER' }],
    ['Workflow', { script: 'MARKER', args: { a: 'MARKER' } }],
    ['SendMessage', { to: 'x', message: 'MARKER', content: 'MARKER' }],
    ['WebFetch', { url: 'https://user:pw_invented@x.test/p?token=tok_invented', prompt: 'MARKER' }],
    ['ExitPlanMode', { plan: '## MARKER' }],
    ['StructuredOutput', { summary: 'MARKER', findings: [{ claim: 'MARKER' }] }],
    ['SubagentHandback', { message: 'MARKER' }],
    ['AskUserQuestion', { questions: [{ question: 'MARKER', header: 'H', options: [{ label: 'MARKER' }] }] }],
    ['Read', { __unparsedToolInput: { raw: 'MARKER', len: 6 } }],
    ['mcp__Claude_Browser__javascript_tool', { action: 'javascript_exec', text: 'MARKER' }],
    ['mcp__playwright__fill_form', { fields: [{ value: 'MARKER' }] }],
    ['mcp__firebase__firestore_update_document', { document: { name: 'projects/p/x', fields: { a: 'MARKER' } } }],
    [`mcp__${UUID}__outlook_email_search`, { query: 'from:alice@example.test', mailboxOwnerEmail: 'alice@example.test' }],
    ['mcp__ccd_pr__bind_pr', { url: 'https://github.test/org/repo/pull/1?MARKER' }],
  ];
  test('content, secrets, emails and full URLs never reach the result', () => {
    for (const [tool, input] of contentCalls) {
      const json = JSON.stringify(summarize(tool, input));
      for (const m of MARKERS) assert.ok(!json.includes(m), `${tool} leaked ${m}: ${json}`);
    }
  });
  test('giant inputs stay fast and a token cut at the scrub limit is dropped', () => {
    const t0 = Date.now();
    const huge = 'a'.repeat(200_000);
    summarize('Bash', { command: `cd /x && ${huge} <<EOF\n${huge}\nEOF`, description: huge });
    summarize('WebSearch', { query: `${huge}@${huge}` });
    summarize('WebFetch', { url: `https://${huge}.test/${huge}` });
    summarize('Grep', { pattern: `/${huge}`, path: huge });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    // 공백이 접히면 잘린 'alice@exa' 가 앞으로 오지만, 잘린 마지막 토큰은 버려진다
    const cut = summarize('WebSearch', { query: `${' '.repeat(1015)}alice@example.test` });
    assert.ok(!cut.summary.includes('alice'), cut.summary);
  });
});
