// Tests for src/discover.mjs (contract 3.5). Synthetic fixtures only, built in os.tmpdir().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scan, readSubMeta, readJournalLabels } from '../src/discover.mjs';

const SID1 = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SID3 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const AG1 = 'a0123456789abcdef';
const AG2 = 'afedcba9876543210';
const WF1 = 'a1111111111111111';
const RUN = 'wf_1234abcd-0f1';
const NOW = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60 * 1000;
const LINE = '{"type":"user","uuid":"u-1","message":{"role":"user","content":"invented prompt"}}\n';

let tmp;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-office-'));
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function put(file, content = LINE, mtimeMs = NOW - MIN) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  const t = new Date(mtimeMs);
  await fsp.utimes(file, t, t);
}

async function freshRoot(name) {
  const root = path.join(tmp, name);
  await fsp.mkdir(root, { recursive: true });
  return root;
}

test('scan finds main, sub and wf transcripts and nothing else', async () => {
  const root = await freshRoot('layout');
  const proj = path.join(root, '-home-user-coding-demo');
  const sdir = path.join(proj, SID1);
  const sub = path.join(sdir, 'subagents');
  const run = path.join(sub, 'workflows', RUN);
  await put(path.join(proj, `${SID1}.jsonl`));
  await put(path.join(sub, `agent-${AG1}.jsonl`));
  await put(path.join(sub, `agent-${AG1}.meta.json`), '{"agentType":"Explore"}');
  await put(path.join(sub, `agent-${AG1}.prefix.json`), '{"v":1}');
  await put(path.join(run, `agent-${WF1}.jsonl`));
  await put(path.join(run, `agent-${WF1}.meta.json`), '{"agentType":"worker"}');
  await put(path.join(run, `agent-${WF1}.prefix.json`), '{"v":1}');
  await put(path.join(run, 'journal.jsonl'), '{"type":"launched"}\n');
  // Decoys that must never be reported.
  await put(path.join(sdir, 'workflows', `${RUN}.json`), '{"runId":"x"}');
  await put(path.join(sdir, 'tool-results', 'agent-a9999999999999999.jsonl'));
  await put(path.join(sdir, 'tool-results', `${SID2}.jsonl`));
  await put(path.join(sdir, 'session-memory', 'agent-a8888888888888888.jsonl'));
  await put(path.join(sdir, 'custom-title.json'), '{"customTitle":"invented"}');
  await put(path.join(proj, 'memory', `${SID2}.jsonl`));
  await put(path.join(proj, 'memory', 'notes.md'), '# invented');
  await put(path.join(proj, 'not-a-uuid.jsonl'));
  await put(path.join(proj, 'journal.jsonl'));
  await put(path.join(proj, 'sessions-index.json'), '{"version":1,"entries":[]}');
  await put(path.join(proj, `${SID3}.jsonl.bak`));
  await put(path.join(sub, 'journal.jsonl'));
  await put(path.join(sub, `agent-${AG2}.meta.json`), '{"agentType":"Plan"}'); // meta without jsonl
  await put(path.join(root, 'stray-file.txt'), 'x');
  await put(path.join(root, '.DS_Store'), 'x');

  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  const abs = path.resolve(root);
  const projAbs = path.join(abs, '-home-user-coding-demo');
  assert.deepEqual(refs.map((r) => path.relative(abs, r.path)), [
    path.join('-home-user-coding-demo', `${SID1}.jsonl`),
    path.join('-home-user-coding-demo', SID1, 'subagents', `agent-${AG1}.jsonl`),
    path.join('-home-user-coding-demo', SID1, 'subagents', 'workflows', RUN, `agent-${WF1}.jsonl`),
  ]);
  const [main, sref, wref] = refs;
  const st = await fsp.stat(main.path);
  assert.deepEqual(main, {
    path: path.join(projAbs, `${SID1}.jsonl`), kind: 'main', stem: SID1, sessionId: SID1, agentId: null,
    runId: null, projectDir: projAbs, mtimeMs: st.mtimeMs, size: LINE.length, ino: st.ino,
  });
  assert.equal(sref.kind, 'sub');
  assert.equal(sref.stem, AG1);
  assert.equal(sref.agentId, AG1);
  assert.equal(sref.sessionId, SID1);
  assert.equal(sref.runId, null);
  assert.equal(sref.projectDir, projAbs);
  assert.equal(wref.kind, 'wf');
  assert.equal(wref.agentId, WF1);
  assert.equal(wref.sessionId, SID1);
  assert.equal(wref.runId, RUN);
  assert.equal(typeof wref.ino, 'number');
  assert.equal(wref.size, LINE.length);
});

test('scan applies the mtime window to every kind', async () => {
  const root = await freshRoot('window');
  const proj = path.join(root, '-p');
  await put(path.join(proj, `${SID1}.jsonl`), LINE, NOW - 5 * MIN);
  await put(path.join(proj, `${SID2}.jsonl`), LINE, NOW - 40 * MIN);
  await put(path.join(proj, SID2, 'subagents', `agent-${AG1}.jsonl`), LINE, NOW - 2 * MIN);
  await put(path.join(proj, SID2, 'subagents', `agent-${AG2}.jsonl`), LINE, NOW - 31 * MIN);
  await put(path.join(proj, SID2, 'subagents', 'workflows', RUN, `agent-${WF1}.jsonl`), LINE, NOW - 30 * MIN);

  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.deepEqual(refs.map((r) => [r.kind, r.stem]), [
    ['main', SID1],
    ['main', SID2], // 40 min old, but AG1 of its session is inside the window: the parent stays attached
    ['sub', AG1],
    ['wf', WF1], // exactly on the boundary: mtime >= now - active
  ]);
  assert.equal(refs[2].sessionId, SID2);
  assert.equal(refs[1].mtimeMs, NOW - 40 * MIN, 'mtimeMs stays the real file mtime');

  const all = await scan(root, {});
  assert.equal(all.length, 5, 'no activeMs -> no mtime filter');
});

test('scan drops a stale main whose subagent files are all stale too', async () => {
  const root = await freshRoot('window-stale-children');
  const proj = path.join(root, '-p');
  await put(path.join(proj, `${SID2}.jsonl`), LINE, NOW - 40 * MIN);
  await put(path.join(proj, SID2, 'subagents', `agent-${AG2}.jsonl`), LINE, NOW - 31 * MIN);
  await put(path.join(proj, SID2, 'subagents', 'workflows', RUN, `agent-${WF1}.jsonl`), LINE, NOW - 35 * MIN);
  assert.deepEqual(await scan(root, { activeMs: 30 * MIN, nowMs: NOW }), []);
});

test('scan keeps a stale main while one of its workflow agents is live (session ids match case-insensitively)', async () => {
  const root = await freshRoot('window-live-wf');
  const proj = path.join(root, '-p');
  await put(path.join(proj, `${SID2.toUpperCase()}.jsonl`), LINE, NOW - 50 * MIN);
  await put(path.join(proj, SID2, 'subagents', 'workflows', RUN, `agent-${WF1}.jsonl`), LINE, NOW - 1 * MIN);
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.deepEqual(refs.map((r) => r.kind), ['main', 'wf']);
});

test('duplicate main stem: the copy with a <stem>/ subdir wins over a newer, larger copy', async () => {
  const root = await freshRoot('dup-subdir');
  const stale = path.join(root, '-old-dir', `${SID1}.jsonl`);
  const live = path.join(root, '-new-dir', `${SID1}.jsonl`);
  await put(stale, LINE + LINE, NOW - 1 * MIN);
  await put(live, LINE, NOW - 10 * MIN);
  await fsp.mkdir(path.join(root, '-new-dir', SID1, 'session-memory'), { recursive: true });

  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, path.resolve(live));
  assert.equal(refs[0].projectDir, path.resolve(root, '-new-dir'));
});

test('duplicate main stem without subdirs: newest mtime, then largest size', async () => {
  const root = await freshRoot('dup-mtime');
  await put(path.join(root, '-a', `${SID1}.jsonl`), LINE + LINE, NOW - 9 * MIN);
  await put(path.join(root, '-b', `${SID1}.jsonl`), LINE, NOW - 2 * MIN);
  await put(path.join(root, '-a', `${SID2}.jsonl`), LINE, NOW - 3 * MIN);
  await put(path.join(root, '-b', `${SID2}.jsonl`), LINE + LINE + LINE, NOW - 3 * MIN);

  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  const byStem = Object.fromEntries(refs.map((r) => [r.stem, path.basename(r.projectDir)]));
  assert.deepEqual(byStem, { [SID1]: '-b', [SID2]: '-b' });
});

test('duplicate main stem: dedupe happens before the window filter', async () => {
  const root = await freshRoot('dup-window');
  // The preferred copy (has a subdir) is outside the window: the stem is reported by neither copy.
  await put(path.join(root, '-a', `${SID1}.jsonl`), LINE, NOW - 60 * MIN);
  await fsp.mkdir(path.join(root, '-a', SID1), { recursive: true });
  await put(path.join(root, '-b', `${SID1}.jsonl`), LINE, NOW - 1 * MIN);
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.deepEqual(refs, []);
});

test('duplicate subagent file across dirs: the copy next to the chosen main wins', async () => {
  const root = await freshRoot('dup-sub');
  await put(path.join(root, '-a', `${SID1}.jsonl`), LINE, NOW - 1 * MIN);
  await put(path.join(root, '-a', SID1, 'subagents', `agent-${AG1}.jsonl`), LINE, NOW - 5 * MIN);
  await put(path.join(root, '-b', SID1, 'subagents', `agent-${AG1}.jsonl`), LINE + LINE, NOW - 1 * MIN);
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.deepEqual(refs.map((r) => [r.kind, path.basename(r.projectDir)]), [['main', '-a'], ['sub', '-a']]);
});

test('scan of a missing root returns []', async () => {
  assert.deepEqual(await scan(path.join(tmp, 'does-not-exist'), { activeMs: MIN, nowMs: NOW }), []);
});

// fs hook: runs `beforeX(path)` before delegating, so a test can delete things between readdir and stat.
function hookedFs({ beforeReaddir = async () => {}, beforeStat = async () => {} } = {}) {
  return {
    async readdir(p, opts) { await beforeReaddir(p); return fsp.readdir(p, opts); },
    async stat(p, opts) { await beforeStat(p); return fsp.stat(p, opts); },
  };
}

test('ENOENT between readdir and stat is tolerated at every level', async () => {
  const root = await freshRoot('race');
  const abs = path.resolve(root);
  const proj = path.join(abs, '-p');
  const gone = path.join(proj, `${SID1}.jsonl`);
  const keep = path.join(proj, `${SID2}.jsonl`);
  const goneSub = path.join(proj, SID2, 'subagents', `agent-${AG1}.jsonl`);
  const keepSub = path.join(proj, SID2, 'subagents', `agent-${AG2}.jsonl`);
  const goneRun = path.join(proj, SID2, 'subagents', 'workflows', RUN);
  const goneSessionDir = path.join(proj, SID3);
  const goneProject = path.join(abs, '-vanishing-project');
  await put(gone);
  await put(keep);
  await put(goneSub);
  await put(keepSub);
  await put(path.join(goneRun, `agent-${WF1}.jsonl`));
  await put(path.join(goneSessionDir, 'subagents', `agent-${WF1}.jsonl`));
  await put(path.join(goneProject, `${SID3}.jsonl`));

  const fsApi = hookedFs({
    beforeStat: async (p) => {
      if (p === gone || p === goneSub) await fsp.rm(p, { force: true });
    },
    beforeReaddir: async (p) => {
      if (p === goneRun || p === goneProject || p === path.join(goneSessionDir, 'subagents')) {
        await fsp.rm(p, { recursive: true, force: true });
      }
    },
  });
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW, fs: fsApi });
  assert.deepEqual(refs.map((r) => r.path), [keep, keepSub]);
});

test('ENOENT from a phantom readdir entry is tolerated', async () => {
  const root = await freshRoot('phantom');
  const abs = path.resolve(root);
  await put(path.join(abs, '-p', `${SID1}.jsonl`));
  const phantom = (name, dir) => ({
    name, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false,
  });
  const fsApi = {
    async readdir(p, opts) {
      const real = await fsp.readdir(p, opts);
      if (p === abs) return [...real, phantom('-ghost-project', true)];
      if (p === path.join(abs, '-p')) return [...real, phantom(`${SID2}.jsonl`, false), phantom(SID3, true)];
      return real;
    },
    stat: (p, o) => fsp.stat(p, o),
  };
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW, fs: fsApi });
  assert.deepEqual(refs.map((r) => r.stem), [SID1]);
});

test('non-ENOENT errors are rethrown so the caller skips the rescan', async () => {
  const root = await freshRoot('emfile');
  await put(path.join(root, '-p', `${SID1}.jsonl`));
  const fsApi = {
    readdir: (p, o) => fsp.readdir(p, o),
    async stat() { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; },
  };
  await assert.rejects(scan(root, { activeMs: 30 * MIN, nowMs: NOW, fs: fsApi }), { code: 'EMFILE' });
});

test('symlinked project dir is followed', async () => {
  const root = await freshRoot('symlink');
  const real = path.join(tmp, 'symlink-target');
  await put(path.join(real, `${SID1}.jsonl`));
  await fsp.symlink(real, path.join(root, '-linked'));
  const refs = await scan(root, { activeMs: 30 * MIN, nowMs: NOW });
  assert.deepEqual(refs.map((r) => [r.kind, r.stem]), [['main', SID1]]);
});

test('readSubMeta: valid, missing, partial and invalid meta files', async () => {
  const dir = path.join(tmp, 'meta');
  const jsonl = (id) => path.join(dir, `agent-${id}.jsonl`);
  const meta = (id) => path.join(dir, `agent-${id}.meta.json`);
  await put(jsonl('aok'));
  await put(meta('aok'), JSON.stringify({ agentType: 'Explore', description: 'invented task', toolUseId: 'toolu_x', spawnDepth: 1 }));
  await put(jsonl('apartial'));
  await put(meta('apartial'), '{"agentType":"general-purp');
  await put(meta('aarray'), '[1,2]');
  await put(meta('anull'), 'null');
  await put(meta('anum'), '42');
  await put(meta('aempty'), '');
  await fsp.mkdir(meta('adir'), { recursive: true });

  assert.deepEqual(await readSubMeta(jsonl('aok')), {
    agentType: 'Explore', description: 'invented task', toolUseId: 'toolu_x', spawnDepth: 1,
  });
  assert.equal(await readSubMeta(jsonl('amissing')), null);
  assert.equal(await readSubMeta(jsonl('apartial')), null);
  assert.equal(await readSubMeta(jsonl('aarray')), null);
  assert.equal(await readSubMeta(jsonl('anull')), null);
  assert.equal(await readSubMeta(jsonl('anum')), null);
  assert.equal(await readSubMeta(jsonl('aempty')), null);
  assert.equal(await readSubMeta(jsonl('adir')), null);
  assert.equal(await readSubMeta(path.join(dir, 'agent-aok.txt')), null);
  assert.equal(await readSubMeta(undefined), null);
});

test('readJournalLabels: started label/phase, latest wins, partial and invalid lines tolerated', async () => {
  const runDir = path.join(tmp, 'journal', RUN);
  const lines = [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'a1', label: 'invented label one', phase: 'Build' },
    { type: 'started', key: 'k2', agentId: 'a2', phase: 'Verify' },
    { type: 'started', key: 'k3', agentId: 'a3' },
    { type: 'started', key: 'k4', label: 'no agent id' },
    { type: 'started', key: 'k5', agentId: 'a5', label: '   ', phase: 'Fallback phase' },
    { type: 'result', key: 'k1', agentId: 'a1', result: { text: 'started invented result' } },
    { type: 'failed', key: 'k2', agentId: 'a2' },
    { type: 'started', key: 'k6', agentId: 'a1', label: 'invented label retry' },
  ].map((o) => JSON.stringify(o));
  const text = [...lines, 'not json "started"', '{"type":"started","agentId":"a9","label":"cut'].join('\n');
  await put(path.join(runDir, 'journal.jsonl'), text);

  const labels = await readJournalLabels(runDir);
  assert.ok(labels instanceof Map);
  assert.deepEqual([...labels.entries()].sort(), [
    ['a1', 'invented label retry'],
    ['a2', 'Verify'],
    ['a5', 'Fallback phase'],
  ]);
  const missing = await readJournalLabels(path.join(tmp, 'journal', 'nope'));
  assert.ok(missing instanceof Map);
  assert.equal(missing.size, 0);
});
