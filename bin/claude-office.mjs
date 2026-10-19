#!/usr/bin/env node
// claude-office: Claude Code 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다.
import { parseArgs, USAGE } from '../src/cli-args.mjs';
import { start } from '../src/server.mjs';

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`claude-office: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
delete args.help;

const log = (msg) => process.stderr.write(`[claude-office] ${msg}\n`);

let app;
try {
  app = await start({ ...args, log });
} catch (err) {
  const hint = err?.code === 'EADDRINUSE' ? ' (port in use: try --port 0 or another port)' : '';
  process.stderr.write(`claude-office: ${err?.message ?? err}${hint}\n`);
  process.exit(1);
}

process.stdout.write(`claude-office: ${app.url}\n`);

let stopping = false;
async function stop() {
  if (stopping) process.exit(130); // 두 번째 Ctrl-C 는 바로 끝낸다
  stopping = true;
  process.stdout.write('claude-office: stopping\n');
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
