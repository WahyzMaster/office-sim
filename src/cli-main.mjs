// office-sim 의 실행 본문: AI 코딩 에이전트 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다 (지금은 Claude Code, Codex, Grok, Antigravity CLI 기록을 읽는다).
// bin/office-sim.mjs 는 Node 지원 하한 경고만 내는 짧은 stub 이고 (contract 0, 6), 이 모듈의 main() 을 부른다.
// 경로의 기준은 이 파일이 아니라 stub 의 위치다 (main 의 binUrl): 실행 파일을 다른 곳에 복사하고 src 를 링크로 둔 경우에도
// .observe 폴더와 커밋 sha 를 읽을 저장소 루트가 예전과 같은 곳을 가리킨다 (Node 는 링크를 풀어서 이 모듈의 주소를 정한다).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './cli-args.mjs';
import { start, DEFAULTS } from './server.mjs';
import { COMMIT_RE } from './server-health.mjs';
import { defaultRoots } from './adapters/index.mjs';
import { pluginDefaultRoots } from './adapters/plugins.mjs';
import { openUrl } from './open-url.mjs';
import { shouldOpen, pageUrl, noSessionLine, noSessionLineWanted } from './open-policy.mjs';
import { reuseRunning } from './port-reuse.mjs';

// /healthz 의 commit: 실행 파일이 있는 체크아웃의 짧은 sha (12자). 시작할 때 한 번만 구한다. git 이 없거나, 저장소가
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

function gitCommit(root) {
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

/**
 * Run the CLI: parse process.argv, start the server, print the `office-sim:` lines, stop on SIGINT / SIGTERM.
 * @param {string} binUrl the module URL of bin/office-sim.mjs (the stub passes its own). The folder above it is the
 *   root whose commit /healthz shows and that holds `.observe`.
 */
export async function main(binUrl) {
  // 저장소 루트: 실행 파일의 한 단계 위. 그 .git 으로 commit 을 구한다
  const root = fileURLToPath(new URL('..', binUrl));
  // 기록 관찰 결과 폴더 (<repo>/.observe, .gitignore 에 있다). 관찰을 시작할 때 처음 만든다 (0700).
  // 재생 모드는 Claude Code 만 돌아 볼 Grok·Codex 기록이 없으므로 기록 관찰을 켜지 않는다 (버튼도 나오지 않는다).
  const observeDir = fileURLToPath(new URL('../.observe', binUrl));

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
  // --open / --no-open / --demo 는 여기의 일이다: start() 옵션에 섞지 않는다. 열지 말지는 listen 전에 정한다 (D7): 아래의
  // 기본 포트 재사용 (D2) 도 같은 답을 쓴다. 플래그가 없으면 stdout 이 터미널이고 CI 가 없을 때만 연다 (src/open-policy.mjs)
  const isTTY = process.stdout.isTTY === true;
  const open = shouldOpen({ open: args.open, auth: args.auth === true, isTTY, env: process.env, platform: process.platform });
  const demo = args.demo === true; // 여는 주소에만 #demo 를 붙인다. 출력하는 주소 줄은 그대로다
  delete args.open;
  delete args.demo;

  const log = (msg) => process.stderr.write(`[office-sim] ${msg}\n`);

  let app;
  try {
    // 다른 어댑터의 기본 루트(~/.codex, ~/.grok, ~/.gemini)는 여기서 채운다: start() 는 받은 루트만 쓴다. --<id>-root 가 이긴다
    app = await start({
      ...args,
      roots: { ...defaultRoots(), ...pluginDefaultRoots(args.plugins), ...args.roots },
      observeDir: args.replay ? null : observeDir,
      build: { commit: gitCommit(root) },
      log,
    });
  } catch (err) {
    // 기본 포트가 쓰이고 있고 --port 를 주지 않았으면 (D2): 그 자리의 office-sim 을 알려 주고 0 으로 끝난다. 다른 포트는 열지 않는다
    const running = await reuseRunning(err, {
      portArg: args.port, host: args.host ?? DEFAULTS.host, port: DEFAULTS.port, open,
      write: (line) => process.stdout.write(line), openUrl: (url) => openUrl(pageUrl(url, demo), { log }),
    });
    if (running) {
      await new Promise((resolve) => setImmediate(resolve)); // 여는 프로그램이 없을 때의 `open failed` 한 줄이 나갈 틈
      process.exit(0);
    }
    const hint = err?.code === 'EADDRINUSE' ? ' (port in use: try --port 0 or another port)' : '';
    process.stderr.write(`office-sim: ${err?.message ?? err}${hint}\n`);
    process.exit(1);
  }

  process.stdout.write(`office-sim: ${app.url}\n`);
  // 켜진 어댑터 (contract 4.0.1, D3). --agents 로 요청했지만 아직 없는 어댑터는 한 줄씩 알린다.
  process.stdout.write(`office-sim: agents ${app.agents.length ? app.agents.join(',') : 'none'}\n`);
  for (const id of app.notImplemented) process.stdout.write(`office-sim: ${id} is not implemented yet\n`);
  if (args.replay) process.stdout.write(`office-sim: replay ${args.speed ?? 1}x${args.loop ? ', loop' : ''}\n`);
  // 출력한 주소를 연다 (--auth 면 토큰 주소, --demo 면 그 뒤에 #demo). 실패는 로그 한 줄로 끝나고 서버는 계속 돈다
  if (open) openUrl(pageUrl(app.url, demo), { log });

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

  // 첫 탐색(app.ready)이 끝났는데 붙은 세션이 없으면 (/healthz 의 sessions 와 같은 수) 터미널에 한 줄로 알린다: 페이지는
  // 그동안 데모를 보여 준다 (D6). 기다리지 않는다: 신호 처리기는 위에서 이미 달았고, 약속은 프로세스를 붙잡지 않으며,
  // 다시 묻는 타이머도 없다 (한 번뿐이다). 멈추기 시작했으면 내지 않는다.
  if (noSessionLineWanted({ isTTY, replay: Boolean(args.replay), demo })) {
    const minutes = args.activeMinutes ?? DEFAULTS.activeMinutes;
    app.ready.then(() => {
      if (stoppingAt === null && app.store.sessionCount === 0) process.stdout.write(noSessionLine(minutes));
    }, () => {});
  }
}
