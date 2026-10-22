#!/usr/bin/env node
// office-sim: AI 코딩 에이전트 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다 (지금은 Claude Code, Codex, Grok, Antigravity CLI 기록을 읽는다).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { start } from '../src/server.mjs';
import { COMMIT_RE } from '../src/server-health.mjs';
import { defaultRoots } from '../src/adapters/index.mjs';
import { openUrl } from '../src/open-url.mjs';

// 기록 관찰 결과 폴더 (<repo>/.observe, .gitignore 에 있다). 관찰을 시작할 때 처음 만든다 (0700).
// 재생 모드는 Claude Code 만 돌아 볼 Grok·Codex 기록이 없으므로 기록 관찰을 켜지 않는다 (버튼도 나오지 않는다).
const OBSERVE_DIR = fileURLToPath(new URL('../.observe', import.meta.url));

// /healthz 의 commit: 이 실행 파일이 있는 체크아웃의 짧은 sha (12자). 시작할 때 한 번만 구한다. git 이 없거나, 저장소가
// 아니거나, 2초 안에 답하지 않으면 null. git 의 출력과 오류는 받기만 하고 내보내지 않는다 (stdout 의 office-sim: 줄은 그대로).
// 저장소 루트 자신이 체크아웃일 때만 (<root>/.git, worktree 와 submodule 은 파일) 묻고, git 이 위 폴더로 올라가거나 물려받은
// GIT_DIR 같은 GIT_* 변수를 따르지 않게 한다: 다른 저장소 안에 풀어 둔 사본이나 남의 hook 에서 띄운 서버가 그 저장소의 sha 를 내지 않게.
function readHeadSha(root) {
  try {
    const dotGit = path.join(root, '.git');
    const st = fs.lstatSync(dotGit);
    let gitDir = dotGit;
    let commonDir = dotGit;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
      const commonFile = path.join(gitDir, 'commondir');
      if (fs.existsSync(commonFile)) {
        commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim());
      } else {
        commonDir = gitDir;
      }
    } else if (!st.isDirectory()) {
      return null;
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head.slice(0, 12).toLowerCase();
    if (!head.startsWith('ref:')) return null;
    const ref = head.slice(4).trim();
    if (!ref.startsWith('refs/') || ref.includes('..')) return null;
    for (const base of [gitDir, commonDir]) {
      const refPath = path.join(base, ref);
      if (fs.existsSync(refPath)) {
        const sha = fs.readFileSync(refPath, 'utf8').trim();
        if (/^[0-9a-f]{40,64}$/i.test(sha)) return sha.slice(0, 12).toLowerCase();
      }
    }
    const packedPath = path.join(commonDir, 'packed-refs');
    if (fs.existsSync(packedPath)) {
      for (const line of fs.readFileSync(packedPath, 'utf8').split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const sp = line.indexOf(' ');
        if (sp > 0 && line.slice(sp + 1).trim() === ref) {
          const sha = line.slice(0, sp).trim();
          if (/^[0-9a-f]{40,64}$/i.test(sha)) return sha.slice(0, 12).toLowerCase();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function gitCommit() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const direct = readHeadSha(root);
  if (direct && COMMIT_RE.test(direct)) return direct;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  try {
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root, env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(root) },
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return COMMIT_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`office-sim: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
delete args.help;
const open = args.open === true; // --open 은 bin 의 일이다: start() 옵션에 섞지 않는다
delete args.open;

const log = (msg) => process.stderr.write(`[office-sim] ${msg}\n`);

let app;
try {
  // 다른 어댑터의 기본 루트(~/.codex, ~/.grok, ~/.gemini)는 여기서 채운다: start() 는 받은 루트만 쓴다. --<id>-root 가 이긴다
  app = await start({
    ...args, roots: { ...defaultRoots(), ...args.roots }, observeDir: args.replay ? null : OBSERVE_DIR, build: { commit: gitCommit() }, log,
  });
} catch (err) {
  const hint = err?.code === 'EADDRINUSE' ? ' (port in use: try --port 0 or another port)' : '';
  process.stderr.write(`office-sim: ${err?.message ?? err}${hint}\n`);
  process.exit(1);
}

process.stdout.write(`office-sim: ${app.url}\n`);
// 켜진 어댑터 (contract 4.0.1, D3). --agents 로 요청했지만 아직 없는 어댑터는 한 줄씩 알린다.
process.stdout.write(`office-sim: agents ${app.agents.length ? app.agents.join(',') : 'none'}\n`);
for (const id of app.notImplemented) process.stdout.write(`office-sim: ${id} is not implemented yet\n`);
if (args.replay) process.stdout.write(`office-sim: replay ${args.speed ?? 1}x${args.loop ? ', loop' : ''}\n`);
// 출력한 주소 그대로 연다 (--auth 면 토큰 주소). 실패는 로그 한 줄로 끝나고 서버는 계속 돈다
if (open) openUrl(app.url, { log });

// `npm start` 의 Ctrl-C 는 신호가 두 번 온다 (터미널이 프로세스 묶음에 보내고 npm 이 자식에게 한 번 더, 1~2 ms 사이).
// 그래서 첫 신호에서 REPEAT_MS 안에 온 같은 신호는 같은 키 입력으로 보고 넘긴다 (관찰 요약을 쓰는 중에 끊지 않게).
// 그 뒤의 두 번째 Ctrl-C 는 바로 끝낸다. 3초 강제 종료는 그대로다.
const REPEAT_MS = 500;
let stoppingAt = null;
async function stop() {
  if (stoppingAt !== null) {
    if (Date.now() - stoppingAt < REPEAT_MS) return;
    process.exit(130);
  }
  stoppingAt = Date.now();
  process.stdout.write('office-sim: stopping\n');
  const force = setTimeout(() => process.exit(1), 3000);
  force.unref();
  try {
    await app.close();
  } catch (err) {
    log(`close failed: ${err?.message ?? err}`);
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
