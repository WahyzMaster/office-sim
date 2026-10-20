#!/usr/bin/env node
// /office 스킬 설치 (P4): <skills dir>/office 를 이 저장소의 skills/office 를 가리키는 심볼릭 링크로 만든다.
// 기본 skills dir 은 ~/.claude/skills 이고, 그 안의 office 항목 하나만 만들거나 옮기거나 지운다. 다른 것은 건드리지 않는다.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_NAME = 'office';
export const SOURCE_DIR = fileURLToPath(new URL('../skills/office', import.meta.url));

export const USAGE = `Usage: node scripts/install-skill.mjs [options]   (npm run skill:install / npm run skill:uninstall)

  Links <skills dir>/${SKILL_NAME} to this repo's skills/${SKILL_NAME} so Claude Code finds the /office skill.

  --uninstall          remove <skills dir>/${SKILL_NAME}, only when it is our symlink
  --force              when <skills dir>/${SKILL_NAME} exists and is not our symlink, move it aside to
                       ${SKILL_NAME}.bak-<time> (never deleted) and link ours
  --dry-run            print what would be done, change nothing
  --home <dir>         home directory (default: $HOME); the skills dir is <home>/.claude/skills
  --skills-dir <dir>   skills directory to use instead of <home>/.claude/skills
  -h, --help           show this help
`;

const FLAGS = { '--uninstall': 'uninstall', '--force': 'force', '--dry-run': 'dryRun' };
const VALUES = { '--home': 'home', '--skills-dir': 'skillsDir' };

/** argv -> { uninstall, force, dryRun, home, skillsDir, help }. Throws Error on a bad argument. */
export function parseInstallArgs(argv) {
  const out = { uninstall: false, force: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (FLAGS[a]) out[FLAGS[a]] = true;
    else if (VALUES[a.split('=')[0]]) {
      const eq = a.indexOf('=');
      const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
      if (!v || (eq < 0 && v.startsWith('--'))) throw new Error(`${a.split('=')[0]} needs a directory`);
      out[VALUES[a.split('=')[0]]] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function expandHome(p, home) {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

async function realOrNull(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** What is at `target` now: missing, ours (a symlink to `source`), a foreign symlink, a directory or a file. */
export async function inspectTarget(target, source) {
  let st;
  try {
    st = await fs.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (!st.isSymbolicLink()) return { kind: st.isDirectory() ? 'directory' : 'file' };
  const link = await fs.readlink(target);
  const resolved = path.resolve(path.dirname(target), link);
  // macOS 의 /var -> /private/var 같은 링크 때문에 문자열 비교만으로는 우리 링크를 남의 것으로 볼 수 있다
  const [real, sourceReal] = [await realOrNull(target), await realOrNull(source)];
  const ours = resolved === source || (real !== null && real === sourceReal);
  return { kind: ours ? 'ours' : 'symlink', link };
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261020T113000Z
}

async function freeBackupPath(target, date) {
  const base = `${target}.bak-${stamp(date)}`;
  for (let n = 1; ; n++) {
    const p = n === 1 ? base : `${base}-${n}`;
    try {
      await fs.lstat(p);
    } catch (err) {
      if (err.code === 'ENOENT') return p;
      throw err;
    }
  }
}

const describe = (state) => (state.kind === 'symlink' ? `a symlink to ${state.link}` : `a ${state.kind}`);

/**
 * Run the installer. Returns the exit code: 0 done or nothing to do, 1 refused or failed, 2 usage error.
 * `out` gets one line per thing done (or, with --dry-run, that would be done).
 */
export async function run(argv, {
  env = process.env, out = (line) => process.stdout.write(`${line}\n`), source = SOURCE_DIR, now = () => new Date(),
  platform = process.platform,
} = {}) {
  const say = (line) => out(`install-skill: ${line}`);
  let opts;
  try {
    opts = parseInstallArgs(argv);
  } catch (err) {
    out(`install-skill: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const home = path.resolve(opts.home ? expandHome(opts.home, env.HOME || os.homedir()) : (env.HOME || os.homedir()));
  const skillsDir = path.resolve(opts.skillsDir ? expandHome(opts.skillsDir, home) : path.join(home, '.claude', 'skills'));
  const target = path.join(skillsDir, SKILL_NAME);
  const would = opts.dryRun ? 'would ' : '';
  try {
    const src = await fs.realpath(source).catch(() => null);
    if (!src || !(await fs.stat(path.join(src, 'SKILL.md')).catch(() => null))) {
      say(`skill source not found: ${path.join(source, 'SKILL.md')}`);
      return 1;
    }
    const state = await inspectTarget(target, src);
    // 저장소를 skills/office 에 바로 받았거나 skills 폴더가 저장소 안을 가리키면, 대상 폴더가 스킬 원본이거나 원본을 품은
    // 저장소다. --force 로 옮기면 저장소가 통째로 옮겨지고 끊어진 링크가 남으므로 어느 쪽도 옮기지 않는다
    const targetReal = state.kind === 'directory' ? await realOrNull(target) : null;
    const isSource = targetReal === src;
    const holdsSource = targetReal !== null && src.startsWith(targetReal + path.sep);

    if (opts.uninstall) {
      if (state.kind === 'missing') {
        say(`nothing to remove: ${target} does not exist`);
        return 0;
      }
      if (isSource || holdsSource) {
        say(`left alone: ${target} ${isSource ? 'is the skill source itself' : `contains the skill source ${src}`}, not a symlink`);
        return 1;
      }
      if (state.kind !== 'ours') {
        say(`left alone: ${target} is ${describe(state)}, not our symlink to ${src}`);
        return 1;
      }
      if (!opts.dryRun) await fs.unlink(target);
      say(`${would}remove symlink ${target}`);
      return 0;
    }

    if (state.kind === 'ours') {
      say(`already installed: ${target} -> ${src}`);
      return 0;
    }
    if (isSource) {
      say(`already installed: ${target} is the skill source ${src}`);
      return 0;
    }
    if (holdsSource) {
      say(`refused: ${target} contains this repo's skill source ${src}, so it is never moved. `
        + `Move the office-sim checkout out of ${skillsDir}, then run npm run skill:install there`);
      return 1;
    }
    if (state.kind !== 'missing') {
      if (!opts.force) {
        say(`refused: ${target} is ${describe(state)}; rerun with --force to move it aside (it is never deleted)`);
        return 1;
      }
      const backup = await freeBackupPath(target, now());
      if (!opts.dryRun) await fs.rename(target, backup);
      say(`${would}move ${target} to ${backup}`);
      say(`note: Claude Code reads every folder in ${skillsDir}; remove ${path.basename(backup)} when you no longer need it`);
    }
    const dirExists = await fs.stat(skillsDir).then((s) => s.isDirectory(), () => false);
    if (!dirExists) {
      if (!opts.dryRun) await fs.mkdir(skillsDir, { recursive: true });
      say(`${would}create directory ${skillsDir}`);
    }
    // win32 는 관리자 권한 없이 만들 수 있는 junction 을 쓴다
    if (!opts.dryRun) await fs.symlink(src, target, platform === 'win32' ? 'junction' : 'dir');
    say(`${would}link ${target} -> ${src}`);
    return 0;
  } catch (err) {
    say(`failed: ${err?.code ?? err?.message ?? err}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = await run(process.argv.slice(2));
