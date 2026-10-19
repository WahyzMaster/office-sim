// Bash/Monitor program-name fallback regressions (review 2026-10-19, finding 8). 모든 명령은 지어낸 것이다.
// description 이 없을 때 요약은 프로그램 이름뿐: 래퍼 옵션 값이나 heredoc 본문 토큰이 그 자리에 오면 안 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summarize.mjs';

const prog = (command) => summarize('Bash', { command }).summary;

test('finding 8: wrapper option values never become the program', () => {
  const cases = [
    ['sudo -u XUSERval whoami', 'whoami'],
    ['sudo -g XGROUPval -u XUSERval node app.js', 'node'],
    ['sudo --user XUSERval ls -la', 'ls'],
    ['sudo -Eu XUSERval npm install', 'npm install'],
    ['sudo -uXUSERval whoami', 'whoami'],
    ['sudo --user=XUSERval whoami', 'whoami'],
    ['env -u XVARval node script.js', 'node'],
    ['env -C /Users/victim/XDIRval make build', 'make build'],
    ['env --chdir XDIRval -u XVARval FOO=1 cargo test', 'cargo test'],
    ['timeout --signal XSIGval 30 node server.js', 'node'],
    ['timeout -s XSIGval -k 5 30s pytest', 'pytest'],
    ['time -f XFMTval -o XOUTval make', 'make'],
    ['exec -a XNAMEval node index.js', 'node'],
    ['nice -n 10 sudo -u XUSERval git status', 'git status'],
    ['sudo -- whoami', 'whoami'],
  ];
  for (const [command, want] of cases) {
    const got = prog(command);
    assert.ok(!/X[A-Z]+val|victim/.test(got), `${command} -> ${got}`);
    assert.equal(got, want, command);
  }
});

test('finding 8: heredoc bodies and command substitutions never become the program', () => {
  const cases = [
    ["export TOKEN=$(cat <<'EOF'\nXSECRETbody line\nEOF\n)", 'export'],
    ['export TOKEN=$(cat <<EOF\nXSECRETbody line\nEOF\n)\nnpm test', 'npm test'],
    ['true <<EOF\nXSECRETbody --flag\nEOF', 'true'],
    ['cd /x\ncat > f.txt <<-"EOF"\n\tXSECRETbody\n\tEOF\nnode f.txt', 'cat'],
    ['set -e\n: <<\\END\nXSECRETbody\nEND\ngit push', 'git push'],
    ['export A=1 <<EOF\nXSECRETbody\nEOF\nmake', 'make'],
    ['export A=1 <<EOF\nXSECRETbody\nnever closed', 'export'],
    ['export K=$(printf %s\nXSECRETbody\n)', 'export'],
    ['export K=`printf\nXSECRETbody`', 'export'],
    ['cd /x && python3 - <<PY\nimport os\nprint(1)\nPY', 'python3'],
    ['cat <<< "XSECRETbody"', 'cat'],
    ['A=$(git rev-parse HEAD); echo "$A"', 'echo'],
  ];
  for (const [command, want] of cases) {
    const got = prog(command);
    assert.ok(!got.includes('XSECRET'), `${JSON.stringify(command)} -> ${got}`);
    assert.equal(got, want, JSON.stringify(command));
  }
});

test('finding 8: giant heredoc and substitution inputs stay fast', () => {
  const huge = 'a'.repeat(200_000);
  const t0 = Date.now();
  prog(`cd /x && ${huge} <<EOF\n${huge}\nEOF`);
  prog(`export X=$(${'$('.repeat(5000)}`);
  prog(`true ${'<<E '.repeat(3000)}\n${'x\n'.repeat(3000)}`);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('integrator: arithmetic shifts and comments never swallow the next command (finding 8 regressions)', () => {
  const cases = [
    ['X=$((1<<3))\nnode build.js', 'node'],
    ['Y=$(( (a << 2) | 1 ))\nnpm test', 'npm test'],
    ['((n<<=1))\nnode x.js', 'node'],
    ['cd /x # see $(foo\nnode y.js', 'node'],
    ['cd /x # see `foo\nnode y.js', 'node'],
    ['# just a note $(\ngit status', 'git status'],
    // unchanged: heredocs, inside $( too, and a '#' inside a word is not a comment
    ["export TOKEN=$(cat <<'EOF'\nXHEREDOCbody\nEOF\n)\nnode run.js", 'node'],
    ['cd /x && python3 - <<PY\nXHEREDOCpy\nPY', 'python3'],
    ['cat <<EOF\nXHEREDOCcat\nEOF', 'cat'],
    ['git log --format=a#b', 'git log'],
  ];
  for (const [command, want] of cases) {
    const got = prog(command);
    assert.equal(got.includes('XHEREDOC'), false, `${command} -> ${got}`);
    assert.equal(got, want, command);
  }
});
