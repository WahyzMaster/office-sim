// P5a adapter registry (contract 4.0.1, decision D3): known ids, labels, the claude-code descriptor and the selection
// of enabled adapters. Roots are temp dirs or injected probes; the real ~/.claude, ~/.codex, ~/.grok, ~/.gemini are
// never opened.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KNOWN_AGENTS, AGENT_LABELS, ADAPTERS, isKnownAgent, checkAgents, probeRoot, selectAdapters,
} from '../src/adapters/index.mjs';
import { claudeCode } from '../src/adapters/claude-code.mjs';
import { agentLabel } from '../public/js/hud.js';
import { SessionState } from '../src/session.mjs';
import { Tailer } from '../src/tailer.mjs';
import { scan, readSubMeta, readJournalLabels } from '../src/discover.mjs';
import { ReplayRunner } from '../src/replay.mjs';

const tmpDirs = [];
after(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sim-adapters-'));
  tmpDirs.push(d);
  return d;
}

test('KNOWN_AGENTS, AGENT_LABELS (same as the page) and ADAPTERS (claude-code, grok since P5c)', () => {
  assert.deepEqual([...KNOWN_AGENTS], ['claude-code', 'codex', 'grok', 'antigravity']);
  assert.deepEqual(Object.keys(AGENT_LABELS), [...KNOWN_AGENTS]);
  for (const id of KNOWN_AGENTS) assert.equal(AGENT_LABELS[id], agentLabel(id), `label of ${id} matches public/js/hud.js`);
  assert.deepEqual(Object.keys(ADAPTERS), ['claude-code', 'grok']);
  assert.equal(ADAPTERS['claude-code'], claudeCode);
  assert.ok(Object.isFrozen(KNOWN_AGENTS) && Object.isFrozen(AGENT_LABELS) && Object.isFrozen(ADAPTERS));
  assert.equal(isKnownAgent('codex'), true);
  assert.equal(isKnownAgent('cursor'), false);
  assert.equal(isKnownAgent('constructor'), false);
});

test('claude-code descriptor: id, default root, deps() bundle from the modules in place, replay runner', async () => {
  assert.equal(claudeCode.id, 'claude-code');
  assert.equal(claudeCode.defaultRoot, '~/.claude/projects');
  const deps = await claudeCode.deps();
  assert.deepEqual(Object.keys(deps).sort(), ['SessionState', 'Tailer', 'agent', 'readJournalLabels', 'readSubMeta', 'scan']);
  assert.equal(deps.agent, 'claude-code');
  assert.equal(deps.SessionState, SessionState);
  assert.equal(deps.Tailer, Tailer);
  assert.deepEqual([deps.scan, deps.readSubMeta, deps.readJournalLabels], [scan, readSubMeta, readJournalLabels]);
  assert.equal(await claudeCode.replayRunner(), ReplayRunner);
});

test('claude-code deps(over): a test override replaces only what it names (agent included)', async () => {
  const fakeScan = async () => [];
  const deps = await claudeCode.deps({ scan: fakeScan });
  assert.equal(deps.scan, fakeScan);
  assert.equal(deps.readSubMeta, readSubMeta);
  assert.equal(deps.agent, 'claude-code');
  assert.equal((await claudeCode.deps({ agent: 'grok' })).agent, 'grok');
  assert.equal((await claudeCode.deps(undefined)).agent, 'claude-code');
});

test('checkAgents: known ids pass deduped in order; anything else is a RangeError', () => {
  assert.deepEqual(checkAgents(['grok', 'claude-code', 'grok']), ['grok', 'claude-code']);
  assert.deepEqual(checkAgents([]), []);
  assert.throws(() => checkAgents(['claude-code', 'cursor']), { name: 'RangeError', message: /unknown agent "cursor" \(known: claude-code, codex, grok, antigravity\)/ });
  assert.throws(() => checkAgents(['Claude-Code']), RangeError);
  assert.throws(() => checkAgents('claude-code'), RangeError);
  assert.throws(() => checkAgents([1]), RangeError);
});

test('probeRoot: null for a readable directory, the error code otherwise', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'a-file');
  await fs.writeFile(file, 'x');
  assert.equal(await probeRoot(dir), null);
  assert.equal(await probeRoot(path.join(dir, 'missing')), 'ENOENT');
  assert.equal(await probeRoot(file), 'ENOTDIR');
  assert.equal(await probeRoot(''), 'EINVAL');
  assert.equal(await probeRoot(undefined), 'EINVAL');
});

test('selectAdapters: an implemented adapter whose root exists is on; a missing root turns it off', async () => {
  const dir = await tmp();
  const on = await selectAdapters({ roots: { 'claude-code': dir } });
  assert.deepEqual(on.enabled.map((x) => [x.id, x.root, x.adapter]), [['claude-code', dir, claudeCode]]);
  assert.deepEqual([on.off, on.notImplemented], [[], []], 'by default the unimplemented ids are not reported');
  const missing = await selectAdapters({ roots: { 'claude-code': path.join(dir, 'missing') } });
  assert.deepEqual([missing.enabled, missing.off, missing.notImplemented], [[], [{ id: 'claude-code', code: 'ENOENT' }], []]);
  const noRoot = await selectAdapters({});
  assert.deepEqual(noRoot.off, [{ id: 'claude-code', code: 'EINVAL' }], 'no root given: nothing default is probed');
});

test('selectAdapters: agents narrows the set; requested unimplemented ids are reported; unknown ids throw', async () => {
  const probe = async () => null; // every root "exists"
  const roots = { 'claude-code': '/tmp-fake/claude' };
  const only = await selectAdapters({ agents: ['claude-code'], roots, probe });
  assert.deepEqual(only.enabled.map((x) => x.id), ['claude-code']);
  const codex = await selectAdapters({ agents: ['codex'], roots, probe });
  assert.deepEqual([codex.enabled, codex.notImplemented], [[], ['codex']]);
  const mixed = await selectAdapters({ agents: ['antigravity', 'claude-code', 'codex', 'antigravity'], roots, probe });
  assert.deepEqual(mixed.enabled.map((x) => x.id), ['claude-code']);
  assert.deepEqual(mixed.notImplemented, ['codex', 'antigravity'], 'KNOWN_AGENTS order, deduped');
  const none = await selectAdapters({ agents: [], roots, probe });
  assert.deepEqual([none.enabled, none.off, none.notImplemented], [[], [], []]);
  await assert.rejects(selectAdapters({ agents: ['claude-code', 'copilot'], roots, probe }), { name: 'RangeError', message: /copilot/ });
});

test('selectAdapters: with more implemented adapters (registry override) each is probed at its own root, in KNOWN order', async () => {
  const probed = [];
  const probe = async (root, id) => { probed.push(`${id}@${root}`); return id === 'codex' ? 'EACCES' : null; };
  const fake = (id) => ({ id, defaultRoot: `/default/${id}`, deps: async () => ({}) });
  const adapters = { grok: fake('grok'), 'claude-code': claudeCode, codex: fake('codex') };
  const roots = { 'claude-code': '/r/claude', codex: '/r/codex', grok: '/r/grok' };
  const all = await selectAdapters({ roots, probe, adapters });
  assert.deepEqual(all.enabled.map((x) => `${x.id}@${x.root}`), ['claude-code@/r/claude', 'grok@/r/grok']);
  assert.deepEqual(all.off, [{ id: 'codex', code: 'EACCES' }]);
  assert.deepEqual(probed, ['claude-code@/r/claude', 'codex@/r/codex', 'grok@/r/grok']);
  const narrowed = await selectAdapters({ agents: ['grok', 'antigravity'], roots, probe, adapters });
  assert.deepEqual([narrowed.enabled.map((x) => x.id), narrowed.notImplemented], [['grok'], ['antigravity']]);
});

test('selectAdapters: a probe that does not answer in time turns the adapter off with ETIMEDOUT', async () => {
  const roots = { 'claude-code': '/tmp-fake/claude' };
  const hung = await selectAdapters({ roots, probe: () => new Promise(() => {}), probeTimeoutMs: 20 });
  assert.deepEqual([hung.enabled, hung.off], [[], [{ id: 'claude-code', code: 'ETIMEDOUT' }]]);
  const slowOk = await selectAdapters({ roots, probe: () => new Promise((r) => setTimeout(() => r(null), 5)), probeTimeoutMs: 1000 });
  assert.deepEqual(slowOk.enabled.map((x) => x.id), ['claude-code'], 'a probe that answers in time is used as is');
});
