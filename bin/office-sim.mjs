#!/usr/bin/env node
// office-sim: AI 코딩 에이전트 세션 기록을 3D 사무실로 보여 주는 로컬 서버를 띄운다. 본문은 src/cli-main.mjs 에 있다.
// 이 파일은 프로젝트 모듈을 정적으로 불러오지 않는다: 지원 하한(Node 22, contract 0)보다 낮은 Node 에서도 아래 경고 한 줄이
// 다른 모듈을 읽기 전에 먼저 나가야 한다. 경고만 하고 그대로 이어서 실행한다 (막지 않는다).
// 본문에는 이 파일의 주소를 넘긴다: .observe 폴더와 커밋 sha 를 읽을 저장소 루트는 이 파일의 위치가 기준이다.
const FLOOR = 22;
const version = process.versions.node;
if (Number(version.split('.')[0]) < FLOOR) {
  process.stderr.write(`office-sim: Node ${version} is older than the supported floor (${FLOOR}); continuing\n`);
}
const { main } = await import('../src/cli-main.mjs');
await main(import.meta.url);
