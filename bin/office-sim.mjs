#!/usr/bin/env node
// office-sim: AI 코딩 에이전트 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다 (지금은 Claude Code, Codex, Grok, Antigravity CLI 기록을 읽는다).
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { start } from '../src/server.mjs';
import { defaultRoots } from '../src/adapters/index.mjs';
import { openUrl } from '../src/open-url.mjs';

// 기록 관찰 결과 폴더 (<repo>/.observe, .gitignore 에 있다). 관찰을 시작할 때 처음 만든다 (0700).
// 재생 모드는 Claude Code 만 돌아 볼 Grok·Codex 기록이 없으므로 기록 관찰을 켜지 않는다 (버튼도 나오지 않는다).
const OBSERVE_DIR = fileURLToPath(new URL('../.observe', import.meta.url));

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
  app = await start({ ...args, roots: { ...defaultRoots(), ...args.roots }, observeDir: args.replay ? null : OBSERVE_DIR, log });
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
