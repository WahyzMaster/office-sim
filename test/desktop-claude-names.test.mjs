// Launch readiness D20 (contract 5.1): what the Claude Desktop mcp.log reader may pass on. A tool name comes only from
// a JSON-parsed client request whose method is exactly tools/call (params.name), and it and the server name must match
// [A-Za-z0-9_.:-]{1,64}; anything else is a generic label. Nothing of params.arguments is ever read.
// Every case writes BAIT text where the old pattern match found a name, runs the real scan + Runner + Store over a temp
// folder, and looks for the bait in everything a page can get (live events and the snapshot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/server-runner.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { scan } from '../src/discover.mjs';
import { parseMcpLogLine, ClaudeDesktopTailer, MCP_NAME_RE, GENERIC_SERVER, GENERIC_TOOL } from '../src/desktop-claude.mjs';

const T = '2026-10-23T05:01:00.000Z';
const clientLine = (server, rest, ts = T) => `${ts} [info] [${server}] Message from client: ${rest}`;
const serverLine = (server, rest, ts = T) => `${ts} [info] [${server}] Message from server: ${rest}`;
const callJson = (name, id = 1, args = {}) => JSON.stringify({ method: 'tools/call', params: { name, arguments: args }, jsonrpc: '2.0', id });

/** A temp Claude desktop tree with an attached character; `append(lines)` adds to mcp.log and polls once. */
async function withDesktop(fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-mcpnames-'));
  try {
    const projectsRoot = path.join(tmp, 'projects');
    const appSupportDir = path.join(tmp, 'ClaudeSupport');
    const logsDir = path.join(tmp, 'ClaudeLogs');
    for (const d of [projectsRoot, appSupportDir, logsDir]) await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(logsDir, 'main.log'), `${T} [info] main ready\n`);
    const mcpPath = path.join(logsDir, 'mcp.log');
    await fsp.writeFile(mcpPath, `${clientLine('Figma', 'method="initialize" id=0 params')}\n`);
    const store = new Store();
    const live = [];
    store.subscribe((msg) => { live.push(msg); });
    const deps = await claudeCode.deps();
    const runner = new Runner({
      opts: { root: projectsRoot, activeMinutes: 30, intervalMs: 250, rescanMs: 3000, idleMs: 1000 },
      deps: { ...deps, scan: (root, opts) => scan(root, { ...opts, appSupportDir, logsDir }) },
      store,
      log: () => {},
    });
    await runner.rescanOnce();
    const append = async (lines) => {
      await fsp.appendFile(mcpPath, `${lines.join('\n')}\n`);
      await runner.pollAll();
    };
    const events = () => live.map((m) => m.event).filter((e) => e && e.sessionId === 'claude-desktop-cloud');
    const page = () => JSON.stringify(live) + JSON.stringify(store.snapshot());
    return await fn({ append, events, page, tmp });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
const noBait = (page, baits) => {
  for (const bait of baits) assert.equal(page.includes(bait), false, `${bait} reached the page`);
};

test('D20 the name rule: letters, digits and _ . : - only, 1 to 64 characters', () => {
  for (const ok of ['read_file', 'browser.navigate', 'ns:tool-name', 'A', 'x'.repeat(64), '0']) assert.equal(MCP_NAME_RE.test(ok), true, ok);
  for (const bad of ['', 'x'.repeat(65), 'read file', 'a/b', 'bob@example.com', 'a\nb', 'tool()', '이름', 'a b', '$(x)']) {
    assert.equal(MCP_NAME_RE.test(bad), false, JSON.stringify(bad));
  }
  assert.equal(MCP_NAME_RE.test(GENERIC_SERVER) && MCP_NAME_RE.test(GENERIC_TOOL), true);
});

test('D20 parseMcpLogLine: a call is a JSON request whose method is exactly tools/call; the name is params.name', () => {
  const call = (rest, server = 'Filesystem') => parseMcpLogLine(clientLine(server, rest));
  assert.deepEqual(call(callJson('read_file', 7)), { kind: 'call', ts: T, server: 'Filesystem', reqId: '7', toolName: 'mcp__Filesystem__read_file' });
  // key order does not matter, and a string id is an id
  assert.deepEqual(call('{"id":"req-9","jsonrpc":"2.0","params":{"arguments":{"name":"BAIT"},"name":"list.dir"},"method":"tools/call"}'),
    { kind: 'call', ts: T, server: 'Filesystem', reqId: 'req-9', toolName: 'mcp__Filesystem__list_dir' });
  // text after the complete JSON message is ignored, whatever it is
  assert.equal(call(`${callJson('read_file', 3)} { metadata: undefined }`)?.toolName, 'mcp__Filesystem__read_file');
  assert.equal(call(`${callJson('read_file', 3)} "name":"BAIT_AFTER"`)?.toolName, 'mcp__Filesystem__read_file');
  // no usable name: the generic label, never another string of the line
  for (const params of [{}, { arguments: { name: 'BAIT' } }, { name: 7 }, { name: null }, { name: ['BAIT'] }, { name: { name: 'BAIT' } }, { name: '' },
    { name: 'x'.repeat(65) }, { name: 'read file' }, { name: '/Users/bob/BAIT' }, { name: 'bob@example.com' }]) {
    const got = call(JSON.stringify({ method: 'tools/call', params, id: 1 }));
    assert.equal(got?.toolName, `mcp__Filesystem__${GENERIC_TOOL}`, JSON.stringify(params));
  }
  assert.equal(call('{"method":"tools/call","id":1}')?.toolName, `mcp__Filesystem__${GENERIC_TOOL}`, 'no params');
  assert.equal(call('{"method":"tools/call","params":"BAIT","id":1}')?.toolName, `mcp__Filesystem__${GENERIC_TOOL}`);
  assert.equal(call('{"method":"tools/call","params":{"name":"t"}}')?.reqId, '0', 'no id');
  // the summary form the log also has: a call without a name
  assert.deepEqual(call('method="tools/call" id=12 params', 'Context7'), { kind: 'call', ts: T, server: 'Context7', reqId: '12', toolName: `mcp__Context7__${GENERIC_TOOL}` });
  assert.equal(call('method="tools/call" id=12 params "name":"BAIT_SUMMARY"')?.toolName, `mcp__Filesystem__${GENERIC_TOOL}`);

  // not a call: another method, tools/call only as text, JSON that does not parse, a JSON value that is not an object
  for (const rest of [
    '{"method":"notifications/message","params":{"name":"BAIT","data":"see tools/call"},"jsonrpc":"2.0"}',
    '{"method":"tools/list","params":{"name":"BAIT","cursor":"tools/call"},"id":3}',
    '{"method":"tools/call/x","params":{"name":"BAIT"},"id":3}',
    '{"method":" tools/call","params":{"name":"BAIT"},"id":3}',
    '{"method":["tools/call"],"params":{"name":"BAIT"},"id":3}',
    '{"params":{"method":"tools/call","name":"BAIT"},"id":3}',
    '{"result":{"method":"tools/call","name":"BAIT"},"id":3}',
    '{"method":"tools/call","params":{"name":"BAIT"',
    '{"method":"tools/call","params":{"name":"BAIT"},"id":3',
    '{method:"tools/call","params":{"name":"BAIT"}}',
    '["tools/call",{"name":"BAIT"}]',
    '"tools/call"',
    'calling tools/call with "name":"BAIT"',
    'note="tools/call" "name":"BAIT"',
    'method="tools/callx" id=1',
    'method="resources/read" uri="tools/call" id=1',
    ' tools/call',
    '',
  ]) assert.equal(call(rest), null, rest);
});

test('D20 parseMcpLogLine: the server name follows the same rule, in the tool name and in the returned label', () => {
  const email = 'bob@example.com /Users/bob/BAIT_SERVER_DIR/srv';
  const got = parseMcpLogLine(clientLine(email, callJson('read_file', 4)));
  assert.deepEqual(got, { kind: 'call', ts: T, server: GENERIC_SERVER, reqId: '4', toolName: `mcp__${GENERIC_SERVER}__read_file` });
  assert.equal(parseMcpLogLine(clientLine('S'.repeat(65), callJson('t')))?.server, GENERIC_SERVER);
  assert.equal(parseMcpLogLine(clientLine('Claude in Chrome', callJson('t')))?.server, GENERIC_SERVER);
  assert.equal(parseMcpLogLine(clientLine('mcp-registry', callJson('t')))?.toolName, 'mcp__mcp_registry__t');
  assert.deepEqual(parseMcpLogLine(serverLine(email, '{"jsonrpc":"2.0","id":4,"result":{"content":[]}}')),
    { kind: 'result', ts: T, server: GENERIC_SERVER, reqId: '4', isError: false });
  assert.equal(JSON.stringify(got).includes('bob'), false);
});

test('D20 parseMcpLogLine: a server answer is a JSON message with an id and a result or an error, or the summary form', () => {
  const res = (rest) => parseMcpLogLine(serverLine('Filesystem', rest));
  assert.deepEqual(res('{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"an error happened"}]}}'),
    { kind: 'result', ts: T, server: 'Filesystem', reqId: '9', isError: false });
  assert.deepEqual(res('{"jsonrpc":"2.0","id":"req-9","error":{"code":-32000,"message":"result missing"}} { metadata: undefined }'),
    { kind: 'result', ts: T, server: 'Filesystem', reqId: 'req-9', isError: true });
  assert.deepEqual(res('id=7 result'), { kind: 'result', ts: T, server: 'Filesystem', reqId: '7', isError: false });
  assert.equal(res('id=7 error')?.isError, true);
  // a request or a notification from the server is not an answer, whatever words it holds
  for (const rest of [
    '{"jsonrpc":"2.0","id":3,"method":"sampling/createMessage","params":{"note":"result error"}}',
    '{"jsonrpc":"2.0","method":"notifications/progress","params":{"id":9,"result":"x"}}',
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32700}}',
    '{"jsonrpc":"2.0","id":9,"result":{"content":[',
    '[{"jsonrpc":"2.0","id":9,"result":{}}]',
  ]) assert.equal(res(rest), null, rest);
});

test('D20 bait: arguments written before the name, and a name only inside the arguments', async () => {
  await withDesktop(async ({ append, events, page }) => {
    await append([
      clientLine('Filesystem', '{"method":"tools/call","params":{"arguments":{"name":"BAIT_ARG_NAME","path":"/Users/someone/BAIT_ARG_PATH.txt"},"name":"read_file"},"jsonrpc":"2.0","id":1}'),
      clientLine('Filesystem', '{"jsonrpc":"2.0","id":2,"params":{"arguments":{"name":"BAIT_ONLY_ARG","id":"BAIT_ARG_ID"}},"method":"tools/call"}'),
    ]);
    assert.deepEqual(events().filter((e) => e.type === 'tool_start').map((e) => e.tool), ['mcp__Filesystem__read_file', `mcp__Filesystem__${GENERIC_TOOL}`]);
    noBait(page(), ['BAIT', 'someone']);
  });
});

test('D20 bait: a line that merely contains the text tools/call opens no call', async () => {
  await withDesktop(async ({ append, events, page }) => {
    await append([
      clientLine('Filesystem', '{"method":"notifications/message","params":{"name":"BAIT_NOT_A_CALL","data":"about tools/call"},"jsonrpc":"2.0"}'),
      clientLine('Filesystem', '{"method":"tools/list","params":{"name":"BAIT_LIST","cursor":"tools/call"},"jsonrpc":"2.0","id":5}'),
      clientLine('Filesystem', '{"method":"tools/call","params":{"name":"BAIT_TRUNCATED","arguments":{"q":"cut'),
      clientLine('Filesystem', 'forwarding tools/call "name":"BAIT_FREE_TEXT" id=6'),
      serverLine('Filesystem', '{"method":"tools/call","params":{"name":"BAIT_FROM_SERVER"},"jsonrpc":"2.0","id":7}'),
    ]);
    assert.deepEqual(events().filter((e) => e.type === 'tool_start' || e.type === 'tool_end'), []);
    noBait(page(), ['BAIT']);
  });
});

test('D20 bait: a server name with an email address and a path, and a 300-character name', async () => {
  await withDesktop(async ({ append, events, page }) => {
    const server = 'bob@example.com /Users/bob/BAIT_SERVER_DIR/srv';
    const longName = `BAIT_LONG_NAME_${'n'.repeat(285)}`;
    const longServer = `BAIT_LONG_SERVER_${'s'.repeat(283)}`;
    assert.equal(longName.length, 300);
    await append([
      clientLine(server, callJson('read_file', 1)),
      clientLine('Filesystem', callJson(longName, 2)),
      clientLine(longServer, callJson('read_file', 3)),
      clientLine('Filesystem', callJson('rm -rf /Users/bob/BAIT_NAME_PATH; echo bob@example.com', 4)),
    ]);
    assert.deepEqual(events().filter((e) => e.type === 'tool_start').map((e) => e.tool), [
      `mcp__${GENERIC_SERVER}__read_file`, `mcp__Filesystem__${GENERIC_TOOL}`, `mcp__${GENERIC_SERVER}__read_file`, `mcp__Filesystem__${GENERIC_TOOL}`,
    ]);
    await append([
      serverLine(server, '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"BAIT_RESULT_BODY"}]}}'),
      serverLine(longServer, '{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"BAIT_ERROR_BODY"}}'),
    ]);
    assert.deepEqual(events().filter((e) => e.type === 'say').map((e) => e.text), [`Completed ${GENERIC_SERVER}`, `Completed ${GENERIC_SERVER}`]);
    noBait(page(), ['BAIT', 'bob', 'example.com', 'nnnnnnnn', 'ssssssss', 'rm -rf']);
  });
});

test('D20 a call of a server with an unsafe name still gets its own result (calls pair on the real name, in memory only)', async () => {
  // At the tailer, below the Store: a session keeps one turn at a time, so it could not show two calls open at once.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'office-sim-mcppair-'));
  try {
    const logsDir = path.join(tmp, 'ClaudeLogs');
    await fsp.mkdir(logsDir, { recursive: true });
    const mcpPath = path.join(logsDir, 'mcp.log');
    await fsp.writeFile(mcpPath, '');
    const ref = { path: mcpPath, facts: { appSupportDir: '', logsDir } };
    const tailer = new ClaudeDesktopTailer();
    const records = [];
    const onLine = (line) => { records.push(JSON.parse(line)); };
    await tailer.readAll(ref, onLine);
    const parts = (type) => records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : [])).filter((c) => c.type === type);
    const longId = `BAIT_ID_${'i'.repeat(300)}`;
    await fsp.appendFile(mcpPath, [
      clientLine('Server One', callJson('alpha', 5)),
      clientLine('Server Two', callJson('beta', 5)),
      clientLine('Server Two', callJson('gamma', longId)),
    ].join('\n') + '\n');
    await tailer.poll(ref, onLine);
    const uses = parts('tool_use');
    assert.deepEqual(uses.map((u) => u.name), [`mcp__${GENERIC_SERVER}__alpha`, `mcp__${GENERIC_SERVER}__beta`, `mcp__${GENERIC_SERVER}__gamma`]);
    assert.deepEqual(uses.map((u) => u.input), [{}, {}, {}], 'no argument is ever passed on');
    await fsp.appendFile(mcpPath, `${serverLine('Server Two', '{"jsonrpc":"2.0","id":5,"result":{}}')}\n`);
    await tailer.poll(ref, onLine);
    assert.deepEqual(parts('tool_result').map((r) => r.tool_use_id), [uses[1].id], 'the answer of Server Two closes the call of Server Two');
    await fsp.appendFile(mcpPath, [
      serverLine('Server One', '{"jsonrpc":"2.0","id":5,"error":{"code":-1}}'),
      serverLine('Server Two', JSON.stringify({ jsonrpc: '2.0', id: longId, result: {} })),
      serverLine('Server Three', '{"jsonrpc":"2.0","id":5,"result":{}}'),
    ].join('\n') + '\n');
    await tailer.poll(ref, onLine);
    assert.deepEqual(parts('tool_result').map((r) => [r.tool_use_id, r.is_error]), [[uses[1].id, false], [uses[0].id, true], [uses[2].id, false]]);
    const sent = JSON.stringify(records);
    noBait(sent, ['BAIT', 'Server One', 'Server Two', 'iiiiiiii']);
    tailer.forget(ref.path);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
