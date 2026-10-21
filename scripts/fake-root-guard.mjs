// Dev helper module (not a script to run): what the fake-*-append scripts share. The real-root guard: a --root inside
// the agent's real root (~/.codex, ~/.gemini, ~/.grok) is refused, also through a link, a path under a link, a path that
// does not exist yet, another letter case where the file system ignores it, a real root that is a dangling link and an
// alias of the same folder (a macOS firmlink): the plain paths, the real paths and the folders' identities are compared.
// The folders a run writes in a temp --root are checked the same way (a link planted in it). And the signal stop: on
// Ctrl+C or SIGTERM the writes under way finish before the temp root a run made is removed.
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// the letter case folded where the file system usually ignores it (APFS, NTFS)
const fold = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);

// p through its links: the real path of its nearest existing folder and the names still missing under it (null when
// nothing resolves). A link whose target does not exist yet (a dotfiles link to a folder not made yet) is followed too,
// its target taken from the link's real folder, instead of being kept as its own name.
function resolveLinks(p) {
  const rest = [];
  let cur = p;
  for (let hops = 0; ;) {
    try {
      return { base: realpathSync.native(cur), rest };
    } catch {
      let target = null;
      try {
        if (hops < 32 && lstatSync(cur).isSymbolicLink()) target = path.resolve(realpathSync.native(path.dirname(cur)), readlinkSync(cur));
      } catch {
        target = null;
      }
      if (target) {
        hops += 1;
        cur = target;
        continue;
      }
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

// The real path of p, through its nearest existing folder (a root that does not exist yet keeps its last parts), with
// the letter case folded where the file system usually ignores it (APFS, NTFS): a link to ~/.grok or ~/.GROK is ~/.grok.
export function realOf(p) {
  const r = resolveLinks(p);
  return r ? fold(path.join(r.base, ...r.rest)) : p;
}

// a folder's identity (device and inode), null when it cannot be read or the file system gives no inode
function idOf(p) {
  try {
    const s = statSync(p);
    return s.ino ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

// candidate is the real root or under it by folder identity: an alias that realpath keeps (a macOS firmlink such as
// /System/Volumes/Data/Users/<me>, a bind mount) is the same folder under another path. A real root not made yet is
// matched by its nearest existing folder and the names still missing under it (letter case folded as above).
function sameFolderInside(candidate, realRoot) {
  const r = resolveLinks(realRoot);
  const c = resolveLinks(candidate);
  const anchor = r && idOf(r.base);
  if (!anchor || !c) return false;
  let names = c.rest;
  for (let cur = c.base; ;) {
    if (idOf(cur) === anchor && r.rest.every((n, i) => i < names.length && fold(names[i]) === fold(n))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    names = [path.basename(cur), ...names];
    cur = up;
  }
}

// p is base or under it, by whole path parts (~/.codex-old is not inside ~/.codex)
const within = (p, base) => p === base || p.startsWith(`${base}${path.sep}`);

// candidate (an absolute path) is the real root or under it: as written, once both are real paths, or by identity
export const insideRealRoot = (candidate, realRoot) =>
  within(candidate, realRoot) || within(realOf(candidate), realOf(realRoot)) || sameFolderInside(candidate, realRoot);

// Exits 2 with the refusal line when a given --root is inside the real root (label: how the line names it, '~/.codex').
export function refuseRealRoot(root, realRoot, label) {
  if (!root || !insideRealRoot(root, realRoot)) return;
  console.error(`refusing to write into the real ${label}: pass a temp folder (or no --root)`);
  process.exit(2);
}

// Exits 2 when a folder or file the run writes in its root leads into the real root: a link planted in a temp --root
// (a root that mixes in the real data). The deepest path is given, so a link at any existing level above it is found.
export function refuseWrites(paths, realRoot, label) {
  const bad = paths.find((p) => insideRealRoot(p, realRoot));
  if (!bad) return;
  console.error(`refusing to write into the real ${label}: ${bad} leads into it (a link in --root); pass a temp folder (or no --root)`);
  process.exit(2);
}

// Ctrl+C or SIGTERM (a test runner, a supervisor): no new write starts, the writes under way finish, then the temp root
// this run made goes away (a given --root stays) and the process exits 0; a temp root that could not be removed is named
// (exit 1). A second signal while stopping does nothing more. Returns io(write): every write of the run goes through it
// (write() starts one fs call or one unit such as write-aside-then-rename, never another io); once stopping, io starts
// nothing and never settles, so the run waits there for the exit.
export function stopOnSignals(root, created) {
  let stopping = false;
  const busy = new Set();
  async function stop() {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([...busy]);
    if (created) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    if (created && existsSync(root)) {
      console.error(`\nstopped; the temp root could not be removed: ${root}`);
      process.exit(1);
    }
    console.log(created ? '\nstopped; the temp root was removed' : '\nstopped');
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return (write) => {
    if (stopping) return new Promise(() => {});
    const p = write();
    busy.add(p);
    const done = () => busy.delete(p);
    p.then(done, done);
    return p;
  };
}
