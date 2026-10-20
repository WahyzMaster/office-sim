// Bash/Monitor subcommand after a bare option (CONTRACT 3.1, 4.0.2, 5). 모든 명령은 지어낸 것이다.
// description 이 없을 때 요약은 '프로그램 + 하위 명령' 이다. 값 없는 옵션('-n', '--project', '-C') 뒤의 토큰은 그 옵션의
// 값(프로젝트, 계정, 네임스페이스, 경로)일 수 있으므로 하위 명령으로 보여 주지 않는다. Claude 경로와 공통 코어가 같은 규칙을 쓴다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summarize.mjs';
import { programOf } from '../src/summarize-shell.mjs';
import { shellProgram } from '../src/core/tool-summary.mjs';

const BAIT = ['BAITPROJ', 'BAITPROF', 'BAITNS', 'BAITCTX', 'BAITREPO', 'BAITHOST', 'BAITDIR', 'BAITORG', 'BAITUSER'];

// [command, summary without description]
const DROPPED = [
  ['gcloud --project BAITPROJ run deploy', 'gcloud'],
  ['gcloud --account BAITUSER auth list', 'gcloud'],
  ['aws --profile BAITPROF s3 ls', 'aws'],
  ['kubectl -n BAITNS get pods', 'kubectl'],
  ['kubectl --context BAITCTX get pods', 'kubectl'],
  ['kubectl -nBAITNS get pods', 'kubectl'],
  ['git -C BAITREPO status', 'git'],
  ['git -C /Users/alice/BAITREPO log --oneline', 'git'],
  ['git -c user.name=BAITUSER commit -m "x"', 'git'],
  ['docker -H BAITHOST ps', 'docker'],
  ['docker --context BAITCTX compose up', 'docker'],
  ['npm --prefix BAITDIR install', 'npm'],
  ['npm --prefix ./BAITDIR run build', 'npm'],
  ['gh --repo BAITORG pr view', 'gh'],
  ['helm -n BAITNS list', 'helm'],
  ['git --no-pager log', 'git'],
  ['cd /Users/alice/proj && gcloud --project BAITPROJ run deploy', 'gcloud'],
  ['FOO=1 kubectl -n BAITNS get pods', 'kubectl'],
  ['sudo -u root kubectl -n BAITNS get pods', 'kubectl'],
  ['timeout 30s aws --profile BAITPROF s3 ls', 'aws'],
  ['git -C BAITREPO status && npm test', 'git'],
];

const KEPT = [
  ['git status', 'git status'],
  ['git push origin main', 'git push'],
  ['npm run dev', 'npm run'],
  ['kubectl get pods -n BAITNS', 'kubectl get'],
  ['gcloud run deploy --project BAITPROJ', 'gcloud run'],
  ['kubectl --context=BAITCTX get pods', 'kubectl get'],
  ['terraform -chdir=BAITDIR plan', 'terraform plan'],
  ['nice -n 10 cargo build --release', 'cargo build'],
  ['sudo -u root git status', 'git status'],
  ['env -C /Users/alice/BAITDIR make build', 'make build'],
  ['./gradlew build', 'gradlew build'],
];

describe('a subcommand after a bare option is never shown (it may be the option value)', () => {
  for (const tool of ['Bash', 'Monitor']) {
    test(`${tool}: option values are dropped, the program stays`, () => {
      for (const [command, want] of DROPPED) {
        const r = summarize(tool, { command });
        assert.equal(r.summary, want, command);
        assert.equal(r.room, 'server', command);
        const json = JSON.stringify(r);
        for (const bait of BAIT) assert.ok(!json.includes(bait), `${bait} leaked in ${json}`);
      }
    });
  }

  test('subcommands without a bare option before them are kept', () => {
    for (const [command, want] of KEPT) {
      const r = summarize('Bash', { command });
      assert.equal(r.summary, want, command);
      const json = JSON.stringify(r);
      for (const bait of BAIT) assert.ok(!json.includes(bait), `${bait} leaked in ${json}`);
    }
  });

  test('a description still wins, and the room still comes from the program', () => {
    assert.deepEqual(summarize('Bash', { command: 'kubectl -n BAITNS get pods', description: 'List pods' }), {
      summary: 'List pods',
      room: 'server',
    });
    assert.deepEqual(summarize('Bash', { command: 'grep -e BAITNS -r .' }), { summary: 'grep', room: 'archive' });
  });

  test('programOf returns the program without the subcommand', () => {
    assert.deepEqual(programOf('gcloud --project BAITPROJ run deploy'), { program: 'gcloud', sub: '' });
    assert.deepEqual(programOf('kubectl get pods -n BAITNS'), { program: 'kubectl', sub: 'get' });
  });

  test('one rule: Claude programOf and the core shellProgram agree on every case', () => {
    for (const [command] of [...DROPPED, ...KEPT]) {
      assert.deepEqual(shellProgram({ command }), programOf(command), command);
    }
  });
});
