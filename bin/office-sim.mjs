#!/usr/bin/env node
// office-sim: AI 코딩 에이전트 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다 (지금은 Claude Code 와 Grok 기록을 읽는다).
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { start } from '../src/server.mjs';
import { defaultRoots } from '../src/adapters/index.mjs';

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

const log = (msg) => process.stderr.write(`[office-sim] ${msg}\n`);

let app;
try {
  // 다른 어댑터의 기본 루트(~/.grok ...)는 여기서 채운다: start() 는 받은 루트만 쓴다. --<id>-root 가 이긴다
  app = await start({ ...args, roots: { ...defaultRoots(), ...args.roots }, log });
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

let stopping = false;
async function stop() {
  if (stopping) process.exit(130); // 두 번째 Ctrl-C 는 바로 끝낸다
  stopping = true;
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
