# Office Sim

AI 코딩 에이전트의 세션 기록을 0.25초마다 따라 읽어서, 직원들이 3D 사무실을 오가며 일하는 모습으로 보여 주는 로컬 서버입니다. 지금은 Claude Code 세션 기록(`~/.claude/projects/**/*.jsonl`), Grok(xAI Grok Build) 세션 기록(`~/.grok/sessions/<작업 폴더>/<세션>/updates.jsonl`), Codex 세션 기록(`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`), Antigravity CLI(`agy`)와 예전 Antigravity IDE 의 대화 기록(`~/.gemini/antigravity-cli/brain/<대화>/.system_generated/logs/transcript_full.jsonl`, 예전 IDE 는 `~/.gemini/antigravity-ide/` 아래 같은 자리)을 읽습니다.

| 방 | 하는 일 |
|---|---|
| 자료실 | 파일 조회와 검색 (Read, codegraph, `grep`/`cat` 같은 Bash) |
| 개발실 | 코드 수정 (Edit, Write) |
| 서버실 | 명령 실행, git, gh, 터미널 |
| 정보검색실 | 웹 검색, 그 밖의 MCP 도구 |
| 회의실 | 계획을 세우면 화이트보드에 적음 |
| 내 자리 | 물어볼 게 생기면 직원이 찾아와 질문 |

- 프로젝트마다 한 층을 씁니다. 같은 저장소의 워크트리 세션은 같은 층에 모입니다.
- 생각 중에는 구름 말풍선이 뜨고, 도구가 실패하면 식은땀과 빨간 말풍선, 거절되거나 중단되면 회색 말풍선이 뜹니다.
- 서브에이전트는 모자 쓴 작은 직원으로 나타났다가 일을 마치면 엘리베이터로 퇴장합니다.

## 지원하는 에이전트

| 에이전트 | 에이전트 id | 상태 |
|---|---|---|
| Claude Code | `claude-code` | 지원 |
| Grok (xAI Grok Build) | `grok` | 지원 (P5c). 라이브 승인 대기도 보임 (P5g, 권한 창이 열린 뒤 1~4초 늦게, 답하는 쪽은 Grok 의 자동 검토일 수도 있음) |
| Codex (데스크톱 앱, CLI, IDE 확장 모두) | `codex` | 지원 (P5d) |
| Antigravity CLI (`agy`)와 예전 Antigravity IDE | `antigravity` | 지원 (P5e) |
| Antigravity 데스크톱 앱 (Antigravity.app 2.x) | 없음 | 범위 밖(결정 D6). 대화 파일(`~/.gemini/antigravity/conversations/*.pb`)이 암호화된 것으로 보이고 통째로 다시 쓰이며, 대화 폴더에 단계 기록(`logs/`)이 없어 도구 이벤트를 읽을 수 없습니다. 그래서 `~/.gemini/antigravity/` 는 열지 않습니다 |

도구마다 그 도구의 세션 기록을 읽는 어댑터가 있습니다. 어댑터마다 기록을 찾고 읽는 방법은 다르지만, 브라우저로 보내는 이벤트 형식과 개인정보 규칙은 모두 같습니다(`docs/CONTRACT.md` 2절, 4.0절, 5절). Claude Code 어댑터의 규칙은 `docs/CONTRACT.md` 4.1~4.5절에, Grok 은 4.6절에, Codex 는 4.7절에, Antigravity 는 4.8절에 있습니다. 같은 작업 폴더의 Claude Code, Grok, Codex, Antigravity 세션은 모두 같은 층에서 일합니다. 설계와 구현 순서(Grok, Codex, Antigravity CLI)는 `docs/ADAPTERS.md` 에 있고, 2026-10-20 에 승인됐습니다.

서버는 구현된 어댑터 중 기록 폴더가 있는 것을 모두 켜고, 시작할 때 주소 다음 줄에 켜진 에이전트를 출력합니다. 네 기록 폴더(`~/.claude/projects`, `~/.codex`, `~/.grok`, `~/.gemini`)가 모두 있으면 `office-sim: agents claude-code,codex,grok,antigravity`(`~/.gemini` 는 Gemini CLI 도 쓰는 폴더라, Antigravity 를 쓰지 않아도 이 폴더가 있으면 `antigravity` 가 켜지고 빈 목록을 훑습니다), Claude Code 폴더만 있으면 `office-sim: agents claude-code` 처럼 나오고(순서는 늘 `claude-code`, `codex`, `grok`, `antigravity`), 켜진 것이 없으면 `office-sim: agents none` 입니다. 이제 네 id 가 모두 구현되어 있어서, `--agents` 로 고른 id 가 "아직 구현되지 않음"(`office-sim: <id> is not implemented yet`)으로 알려지는 일은 없습니다(앞으로 id 가 늘면 그 규칙이 다시 쓰입니다). 기록 폴더가 없거나 읽을 수 없는 어댑터는 로그 한 줄을 남기고 꺼지며(2초 안에 열리지 않는 폴더도 읽을 수 없는 것으로 봅니다), 서버는 빈 사무실로 계속 돕니다. 꺼진 어댑터의 기록 폴더는 rescan 주기마다 다시 확인해서, 나중에 폴더가 생기거나 읽을 수 있게 되면 `<id>: root found, adapter on` 로그 한 줄과 함께 그때 켭니다(`/healthz` 의 `agents` 에도 그때부터 보입니다. 시작할 때 출력한 `office-sim: agents` 줄은 바뀌지 않습니다).

모든 직원(캐릭터)은 어느 도구의 세션인지 나타내는 에이전트 id를 가집니다. 서버가 보내는 `session` 이벤트의 `agent` 필드이고, `claude-code`, `codex`, `grok`, `antigravity` 중 하나입니다(Codex 직원의 id 는 `codex-`, Grok 직원의 id 는 `grok-`, Antigravity 직원의 id 는 `antigravity-` 로 시작합니다). 화면에는 `Claude Code`, `Codex`, `Grok`, `Antigravity` 로 보이고, 모르는 id는 그대로 보입니다.

에이전트마다 기록이 남는 방식이 달라서 직원이 보이는 모습도 조금씩 다릅니다. Claude Code 직원은 도구 호출과 서브에이전트(모자 쓴 작은 직원)가 가장 자세히 보입니다. Grok 직원은 서브에이전트도 따로 보이고, 턴은 Grok 이 적는 턴 끝 기록으로 끝납니다. 또 Grok 은 권한 창이 열릴 때 기록(`events.jsonl`)을 남기므로, 권한 창이 1초 넘게 열려 있으면 라이브에서도 직원이 '내 자리'로 와서 `승인 대기` 말풍선을 띄웁니다. 창이 열린 뒤 1~4초 늦게 보이고(rescan 간격), 허용되면 3초 안에 도구 방으로 돌아가며, 거절되면 `거절됨` 을 보입니다. 이 표시는 권한 창이 열려 있다는 뜻일 뿐이고, 답하는 쪽은 사람일 수도 Grok 의 자동 검토일 수도 있습니다. Codex 직원은 데스크톱 앱, CLI, IDE 확장 어느 쪽에서 시작했든 같은 모습이고, 자동 승인 검토(guardian) 스레드는 보이지 않으며, code-mode 스크립트 하나 안의 명령, 파일 수정, MCP 호출은 끝날 때마다 그 방에 잠깐 들르는 모습으로 보입니다. Antigravity 직원은 한 단계가 끝나야 기록 줄이 쓰이므로 반응이 한 박자(모델이 생각하는 6~35초) 늦고, 서브에이전트 없이 모두 메인 직원이며, 도구 없이 답만 한 뒤 20초 동안 조용하면(요약 파일의 상태가 쉬는 중으로 바뀌면 그때 바로) 턴이 끝난 것으로 봅니다. 예전 IDE 대화는 `task.md` 체크리스트가 있으면 회의실 화이트보드에 보입니다.

## 실행

Node 24 이상이 필요하고(`.nvmrc`), 설치할 의존성은 없습니다. CI 는 Node 22 와 24 에서 테스트합니다.

```bash
npm start
# 옵션을 줄 때는 직접 실행합니다(--root 는 --claude-root 의 별칭)
node bin/office-sim.mjs --claude-root ~/.claude/projects --active 60
```

브라우저에서 `http://127.0.0.1:4317`을 엽니다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--port` | 4317 | HTTP 포트(0이면 빈 포트) |
| `--host` | 127.0.0.1 | 루프백 주소만 허용 |
| `--interval` | 250 | tail 간격(ms, 50~5000). 화면 위쪽 입력칸에서도 바꿀 수 있습니다 |
| `--active` | 30 | 최근 N분 안에 수정된 세션만 따라감 |
| `--rescan` | 3000 | 새 세션 파일을 찾는 간격(ms) |
| `--claude-root` | `~/.claude/projects` | Claude Code 세션 기록 위치. `--root` 는 같은 옵션의 별칭입니다 |
| `--agents` | 구현된 어댑터 중 기록 폴더가 있는 것 모두 | 켤 에이전트 id 를 쉼표로 고릅니다(예: `--agents claude-code`, `--agents codex,grok,antigravity`). `claude-code`, `codex`, `grok`, `antigravity` 만 받고(네 개 모두 구현됨), 그 밖의 id 는 오류(종료 코드 2)입니다 |
| `--codex-root` | `~/.codex` | Codex 기록 위치(데스크톱 앱, CLI, IDE 확장 모두). 그 아래 `sessions/<YYYY>/<MM>/<DD>/` 의 `rollout-*.jsonl`(되돌리기 뒤의 이어쓰기 조각 포함)과 제목 색인 `session_index.jsonl`(스레드 id 와 이름만)만 읽습니다. 자동 승인 검토(guardian) 스레드는 숨깁니다. 옵션을 주지 않으면 실행 파일(`bin/office-sim.mjs`)이 기본값을 채웁니다(서버의 `start()` 는 받은 루트만 씁니다) |
| `--grok-root` | `~/.grok` | Grok(xAI Grok Build) 기록 위치. 그 아래 `sessions/<작업 폴더>/<세션>/` 의 `updates.jsonl`, `summary.json`(제목, 작업 폴더, branch, 서브에이전트 종류)과 승인 대기를 위한 `events.jsonl`(종류, 시각, 도구 이름, 허용/거절 네 필드만)만 읽고, 서브에이전트는 `subagents/` 아래 폴더 이름으로만 연결합니다. 옵션을 주지 않으면 실행 파일(`bin/office-sim.mjs`)이 기본값을 채웁니다(서버의 `start()` 는 받은 루트만 씁니다) |
| `--antigravity-root` | `~/.gemini` | Antigravity CLI(`agy`)와 예전 IDE 의 기록 위치. 그 아래 `antigravity-cli/` 와 `antigravity-ide/` 두 폴더에만 들어가서, `brain/<대화>/.system_generated/logs/` 의 `transcript_full.jsonl`(없거나 더 짧으면 `transcript.jsonl`)과 메타 파일 셋(요약 protobuf 의 제목, 작업 폴더, branch, `annotations/<대화>.pbtxt` 의 제목, `brain/<대화>/task.md` 체크리스트)만 읽습니다. 데스크톱 앱 폴더 `antigravity/` 는 열지 않습니다. 옵션을 주지 않으면 실행 파일(`bin/office-sim.mjs`)이 기본값을 채웁니다(서버의 `start()` 는 받은 루트만 씁니다) |
| `--replay` | 없음 | 지난 세션 하나(`<uuid>.jsonl` 과 그 서브에이전트 파일)를 기록된 시간 간격대로 다시 보여 줍니다. 이때 `--claude-root`(`--root`), `--active`, `--rescan` 은 쓰지 않습니다. 재생은 Claude Code 세션만 됩니다 |
| `--speed` | 1 | 재생 배속(0.1~1000). 줄 사이 공백은 배속으로 나누고, 한 공백은 최대 5초로 줄입니다 |
| `--loop` | 꺼짐 | 재생이 끝나면 모두 퇴근시킨 뒤 처음부터 다시 합니다 |
| `--auth` | 꺼짐 | 실행마다 새 토큰을 만들고 `http://127.0.0.1:<port>/?t=<토큰>` 주소를 출력합니다. 그 주소를 한 번 열면 브라우저가 쿠키를 받고, 쿠키 없는 요청은 모두 401로 거절합니다(값을 받지 않는 스위치) |
| `--open` | 꺼짐 | 서버가 뜨면 출력한 주소를 기본 브라우저로 엽니다(`--auth` 와 같이 쓰면 토큰 주소). macOS 는 `open`, Windows 는 `cmd /c start ""`, 그 밖은 `xdg-open` 을 쓰고, 열지 못하면 로그 한 줄만 남기고 서버는 계속 돕니다(값을 받지 않는 스위치). `--auth` 와 같이 쓰면 토큰 주소가 여는 명령과 그 명령이 띄운 브라우저의 프로세스 인자에 들어갑니다. Linux 에서 브라우저가 아직 떠 있지 않았다면 새로 뜬 브라우저가 끝날 때까지 그 인자에 남아, 같은 컴퓨터의 다른 사용자가 `ps` 로 토큰을 볼 수 있습니다(macOS 의 `open` 은 주소를 브라우저 인자로 넘기지 않습니다) |

## /office 스킬

Claude Code 에서 `/office` 한 번으로 서버를 띄우고 사무실 화면을 엽니다. 스킬은 이 저장소의 `skills/office/SKILL.md` 이고, 설치는 `~/.claude/skills/office` 를 그 폴더로 가리키는 심볼릭 링크 하나를 만드는 것입니다(Windows 는 junction).

```bash
npm run skill:install                  # ~/.claude/skills/office -> <저장소>/skills/office
npm run skill:install -- --dry-run     # 무엇을 할지만 출력
npm run skill:uninstall                # 우리 링크일 때만 지움
```

- 이미 맞는 링크가 있으면 아무것도 하지 않습니다. 저장소를 `~/.claude/skills/office` 에 바로 받았다면 `--force` 를 주어도 저장소를 옮기지 않고 멈추니, 다른 곳으로 옮긴 뒤 거기서 설치하세요. 같은 이름의 폴더, 파일, 다른 곳을 가리키는 링크가 있으면 손대지 않고 멈춥니다. `--force` 를 주면 그것을 지우지 않고 옆의 `office.bak-<시각>` 으로 옮긴 뒤 링크를 만듭니다(Claude Code 는 `skills/` 아래 폴더를 모두 읽으므로, 필요 없어지면 백업 폴더를 지우세요).
- `~/.claude` 안에서는 `skills/office` 하나만 만들고 옮기고 지웁니다(`skills/` 폴더가 없으면 만듭니다). `--skills-dir <dir>` 이나 `--home <dir>` 로 다른 곳에 설치할 수 있습니다.
- 저장소를 옮기면 링크가 끊어집니다. 새 자리에서 `npm run skill:install -- --force` 를 다시 실행하세요.

새 Claude Code 세션에서:

| 입력 | 하는 일 |
|---|---|
| `/office` (또는 `/office start`) | 4317 포트에 office-sim 이 떠 있으면 그대로 쓰고, 없으면 백그라운드로 띄운 뒤 화면을 엽니다. 4317 을 다른 프로그램이 쓰고 있으면 빈 포트에 띄웁니다 |
| `/office demo` | 같은 방식으로 띄우고 데모 화면(`#demo`)을 엽니다 |
| `/office auth` | `--auth` 로 띄우고 토큰 주소를 엽니다. Linux 에서 앱 안의 브라우저가 없으면 토큰이 브라우저 프로세스 인자에 남지 않도록 열지 않고 주소만 알려 줍니다 |
| `/office status` | `/healthz` 로 실행 여부, 켜진 에이전트, 세션 수, 접속 수, 서버의 버전과 커밋을 알려 줍니다. 오류 카운터나 탐색 오류가 있을 때만 "기록을 읽다 문제가 생겼어요" 와 함께 에이전트별 숫자를 덧붙입니다 |
| `/office stop` | 이 저장소의 `bin/office-sim.mjs` 를 절대 경로로 실행한 서버만 멈춥니다(`npm start` 로 터미널에서 띄운 서버는 그대로 둡니다) |

"사무실 열어 줘", "에이전트들 뭐 하는지 보여 줘" 처럼 말로 해도 됩니다. 앱 안의 브라우저가 있으면 그곳에서, 없으면 OS 의 여는 명령(`open`, `xdg-open`, `cmd /c start`)을 직접 실행해 기본 브라우저로 열고, 열지 못하면 그렇다고 말하고 직접 열 주소를 알려 줍니다. 이미 4317 에 떠 있던 서버를 다시 쓸 때는 그 서버가 이 저장소에서 `/office` 로 띄운 것인지 확인해, 아니면(`npm start` 로 터미널에서 띄운 서버, 다른 체크아웃) 띄운 곳에서 Ctrl-C 로 멈추라고 알려 줍니다. 스킬은 `/healthz` 응답과 서버가 출력한 `office-sim:` 줄만 읽고, 세션 기록은 열지 않습니다.

`/healthz` 는 사무실이 조용한 것(에이전트가 쉬는 중)과 기록을 읽지 못하는 것(형식이 바뀌었거나 탐색이 막힘)을 가르는 숫자도 줍니다. `version` 과 `commit` 은 지금 떠 있는 서버가 어느 빌드인지(`git pull` 뒤에도 예전 서버가 계속 돌 수 있습니다, `commit` 은 git 으로 알 수 없거나, 이 폴더가 git 체크아웃이 아니면(내려받아 푼 사본, 다른 저장소 안에 넣어 둔 사본) `null`), `badLines` 는 JSON 이 아닌 줄, `skippedLines` 는 너무 길어 건너뛴 줄, `applyErrors` 는 세션 해석이 실패한 줄, `loopErrors` 는 탐색/읽기 루프가 실패한 횟수, `linkErrors` 는 직원 연결이 실패한 줄, `rejectedRefs` 는 규칙에 맞지 않아 거절한 기록 파일 수입니다. `runners` 에는 에이전트별로 같은 숫자와 마지막 탐색에 걸린 시간(`lastScanMs`), 그 시각(`lastScanAt`), 탐색 오류 코드(`scanErr`, 예: 읽을 권한이 없는 `EACCES`, 기록 폴더가 너무 많아 탐색을 멈춘 `SCAN_CAPPED`)가 있습니다. 숫자, 시각, 오류 코드만 들어가고 경로, 파일 이름, 세션 id, 오류 문구는 없습니다(`docs/CONTRACT.md` 6절).

## 재생 모드

```bash
node bin/office-sim.mjs --replay test/fixtures/replay/7e7e7e7e-1111-4222-8333-444455556666.jsonl --speed 4 --loop
```

화면 위쪽 칩에 `재생 · 4× · 37%` 가 보입니다. 재생에서는 결과 줄을 미리 읽을 수 있어서, 사람이 권한 창에서 허용하거나 거절한 도구 호출은 직원이 '내 자리'로 와서 `승인 대기` 말풍선을 띄웁니다. Claude Code 라이브 모드는 승인 창이 열려 있는 동안 기록에 아무것도 쓰이지 않아 이 표시를 하지 않습니다(Codex, Antigravity 도 같습니다). Grok 은 권한 창이 열릴 때 `events.jsonl` 에 기록이 남아 라이브에서도 같은 말풍선을 보입니다(`docs/CONTRACT.md` 7절).

## 기록 관찰

평소처럼 Grok Build 와 Codex 를 쓰는 동안 기록 파일이 어떤 단위로 덧붙는지 세는 기능입니다. 실행 중인 세션이 기록을 덧붙이는 단위, Grok 권한 창이 열려 있는 동안 `events.jsonl` 이 언제 써지는지, `~/.grok/active_sessions.json` 의 행 모양처럼 아직 실제 세션으로 확인하지 못한 것(`docs/ADAPTERS.md` 5.1, 5.2절)을 평소 쓰는 모습 그대로 확인하려고 만들었습니다. 모델을 따로 부르지 않으므로 사용량이 더 들지 않고, 기록의 내용은 남기지 않고 개수와 모양만 셉니다.

시작부터 끝까지 사무실 화면에서 합니다.

1. `npm start` 로 띄운 라이브 화면의 위쪽 바에서 `기록 관찰` 버튼을 눌러 패널을 엽니다. 데모 화면(`#demo`, 아티팩트)과 재생 모드에는 이 버튼이 없습니다. Grok 이나 Codex 기록 폴더가 켜져 있어야 시작할 수 있고, 둘 다 꺼져 있으면 패널이 그 이유를 알려 줍니다.
2. `관찰 시작` 을 누르고 평소처럼 Grok, Codex 로 일합니다. 버튼에 `관찰 중 · 12:03` 처럼 걸린 시간이 보이고, 패널의 체크리스트가 차오릅니다.

   | 항목 | 목표 |
   |---|---|
   | Grok 작업 기록(updates) 덧붙음 | 20번 |
   | Grok 권한 창 1초 넘게 기다림 | 1번. 권한 창이 뜨면 1초 넘게 기다렸다가 답해 주세요(Grok 이 권한을 묻는 모드일 때만 창이 뜹니다) |
   | Grok 실행 중 세션 목록 읽기 | 1번(`active_sessions.json` 에 행이 하나 이상 있을 때) |
   | Codex 작업 기록(rollout) 덧붙음 | 20번 |

   켜지지 않은 에이전트의 항목은 `건너뜀` 으로 보이고 끝내는 데 걸리지 않습니다.
3. 다 모이면 위쪽 버튼이 `충분히 모였어요` 로 바뀌고 패널의 `관찰 끝내기` 버튼이 강조됩니다. 그 버튼을 누르면 끝납니다. 다 모이기 전에도 `지금 끝내기` 로 끝낼 수 있고, 그때까지 모인 만큼 저장됩니다. 채팅으로 "관찰 끝" 이라고 말할 필요는 없습니다.
4. 누르지 않아도 저절로 끝납니다: 다 모인 뒤 10분, 시작하고 4시간, 결과 파일이 50 MB 가 되는 때 중 먼저 오는 때입니다(요약 한 줄은 그 뒤에 붙으므로 파일은 50 MB 를 조금 넘을 수 있습니다). 패널에는 이 상한이 늘 한 줄로 보이고, 관찰하는 동안 지금까지 쓴 크기(`1.2 MB 기록됨`)가, 다 모인 뒤에는 남은 시간(`09:59 뒤 자동으로 끝나요`)이 보입니다.
5. 끝나면 패널에 저장한 파일 이름, 끝난 까닭(`직접 끝냄`, `자동으로 끝남 (다 모인 뒤 10분)`, `자동으로 끝남 (최대 4시간)`, `자동으로 끝남 (최대 50 MB)`, `서버가 꺼지면서 끝남`)과 개수 요약(파일 수, 덧붙음 횟수, 채운 체크리스트 항목 수)이 보입니다. 결과 파일의 요약 줄에도 끝난 까닭(`reason`)이 남습니다.

결과는 `<저장소>/.observe/observe-<YYYYMMDD-HHMMSS>.jsonl` 에 저장됩니다(같은 초에 두 번 시작하면 이름 끝에 `-2` 가 붙습니다). 폴더는 0700, 파일은 0600 으로 만들고, `.observe/` 는 `.gitignore` 에 있어 커밋되지 않습니다. `.observe/` 에는 결과 파일을 최근 20개만 남깁니다: 새 관찰을 시작해 새 파일을 만든 직후, 그 파일을 포함해 이름의 시각이 가장 새로운 20개를 남기고 더 오래된 결과 파일은 지웁니다. 지우는 것은 `.observe/` 바로 안의, 이름이 `observe-<날짜>-<시각>.jsonl` 이나 `observe-<날짜>-<시각>-<번호>.jsonl`(같은 초의 `-2` 등) 모양인 보통 파일뿐이고 다른 이름, 폴더, 심볼릭 링크, 하위 폴더 안의 것은 건드리지 않습니다. 남겨 두고 싶은 결과는 다른 곳에 복사해 두세요. 관찰하는 동안 기록이 생기는 대로 덧붙이고(쓰다가 실패하면 다음 차례에 못 쓴 곳부터 이어 씁니다), 끝낼 때 요약 한 줄을 마지막에 붙입니다. 관찰 중에 서버를 끄면(Ctrl-C) 요약을 쓰고 닫습니다. `npm start` 에서는 Ctrl-C 한 번이 신호 두 번으로 오므로 0.5초 안에 온 같은 신호는 한 번으로 칩니다(그 뒤에 한 번 더 누르면 바로 끝납니다). 기록 폴더가 응답하지 않는 마운트에 있어도 끝내기는 1.5초까지만 기다리고 요약을 씁니다(그동안 자동 종료도 제때 시작합니다). 결과 폴더(`.observe/`)가 응답하지 않으면 요약 쓰기도 1.5초까지만 기다리고 끝내며, 그 요약은 폴더가 다시 응답할 때 들어갑니다. 터미널 창을 닫는 것처럼 서버가 갑자기 꺼지면 그 파일에는 요약이 없을 수 있고, 패널은 연결이 끊긴 동안 시계와 버튼을 멈추고 그렇다고 알립니다.

끝낸 뒤 Claude Code 에게 "관찰 결과 반영해 줘" 라고 하면, Claude 가 `.observe/` 의 가장 새 파일을 읽어 `docs/ADAPTERS.md` 5.1, 5.2절과 `docs/CONTRACT.md` 에 반영합니다. 패널의 마지막 줄도 이것을 알려 줍니다.

- 남기는 것: 파일마다 덧붙은 크기(바이트), 끝난 줄 수, 덧붙음이 줄 중간에서 시작하거나 끝났는지, 가장 긴 줄의 길이, 기록 시각과 서버가 본 시각의 차이(ms), 해석하지 못한 줄 수, 정해진 필드의 종류 값(Grok 의 `method` 와 `sessionUpdate`, Grok 이벤트의 `type`, `phase`, `decision`, Codex 의 `type` 과 `payload.type`), `active_sessions.json` 행의 키 이름과 값의 타입, 파일 오류 코드. 파일과 세션은 관찰마다 `f1`, `s1` 같은 번호로만 적습니다.
- 남기지 않는 것: 경로, 파일과 폴더 이름, 세션 id, 작업 폴더, 제목, 프롬프트, 메시지, 명령, 도구 이름과 인자, MCP 서버 이름, 모델 id, 오류 문구, 그 밖의 모든 글. 종류 값도 정해진 모양(`/^[A-Za-z0-9_.:-]{1,64}$/`)이 아니거나 id 처럼 보이면 `?` 로 적습니다. `session_index.jsonl` 은 줄 수와 길이만 셉니다.
- 보는 파일은 Grok 의 `sessions/<작업 폴더>/<세션>/updates.jsonl` 과 `events.jsonl`, `active_sessions.json`, Codex 의 `rollout-*.jsonl`(오늘과 어제, 시작할 때 10분 안에 바뀐 파일이 있던 날짜 폴더, 그리고 30초마다 모든 날짜 폴더를 다시 훑어 찾은, 관찰 중에 이어 쓴 오래된 스레드)과 `session_index.jsonl` 뿐이고, 읽기만 합니다. 심볼릭 링크는 따라가지 않고, 인증과 설정 파일, 원문 입력 기록, SQLite, `summary.json` 은 열지 않습니다. 시작할 때 이미 있던 파일은 그때 크기부터, 새로 덧붙는 것만 셉니다.

기록 형식, 요약의 모양, 서버 규칙(`GET`/`POST /observe`, SSE 의 `observe` 메시지)은 `docs/CONTRACT.md` 6.2절에 있습니다.

## 성능 측정

`http://127.0.0.1:4317/#bench` 를 열면 층 10개, 직원 60명의 합성 부하가 돕니다. 콘솔에서 `__officeBench.burn({ frames: 300, focus: 9 })` 나 `await __officeBench.measure({ seconds: 5, focus: 'all' })` 로 프레임 시간, 그리기 호출, 라벨 수, 힙을 잽니다. 초점이 아닌 층은 그림자와 라벨을 끄고, 숨은 위층은 행렬 갱신과 애니메이션도 건너뜁니다.

## 구조

- `src/`: 탐색(discover), tail(tailer), 레코드 분류(records), 세션 상태(session), 계획 복원(plan), 요약(summarize), 저장소와 SSE 서버(store, server), `/healthz` 본문(server-health), 재생 모드(replay, replay-timeline)
- `src/store-claude.mjs`: Claude Code 서브에이전트 연결(저장소에서 Claude 전용 부분을 떼어 낸 것)
- `src/adapters/`: 어댑터 등록표(`index.mjs`)와 Claude Code 설명자(`claude-code.mjs`). Claude 모듈은 제자리에 두고 설명자가 가리킵니다
- `src/adapters/grok/`: Grok 어댑터(탐색, 레코드 정규화, 설명자 `index.mjs`)
- `src/adapters/codex/`: Codex 어댑터(날짜 폴더 탐색과 첫 줄 사실, 제목 색인 읽기, 레코드 정규화와 code-mode `exec` 방문, 설명자 `index.mjs`)
- `src/adapters/antigravity/`: Antigravity 어댑터(두 앱 폴더의 허용 목록 탐색과 파일 고르기, 요약 protobuf 해석기 `proto.mjs`, 메타 파일, 단계 정규화와 위치 짝짓기, 설명자 `index.mjs`)
- `src/core/`: 새 어댑터가 같이 쓰는 부품. 세션 코어(`session-core.mjs`, `session-items.mjs`), 도구 요약(`tool-summary.mjs`), 바뀔 때만 다시 읽는 메타 파일 감시(`sidecar.mjs`)
- `src/observe/`: 기록 관찰(파일 감시 `observer.mjs`, 범주 값 추출 `records.mjs`, 집계와 체크리스트 `summary.mjs`, 시작과 끝, 자동 종료 `control.mjs`, 결과 파일 보관 `retention.mjs`). 화면 쪽은 `public/js/observe-panel.js` 와 글 형식 `public/js/observe-format.js`
- `skills/office/`: `/office` Claude Code 스킬. `scripts/install-skill.mjs` 가 설치하고, `src/open-url.mjs` 는 `--open` 의 브라우저 열기입니다
- `public/`: three.js 사무실 화면. localhost에서 열면 라이브, 그 밖에서는 데모 데이터로 동작합니다(`#demo`로 강제 가능).
- `docs/CONTRACT.md`: 모듈 경계, 이벤트 형식, 파싱 규칙
- `docs/ADAPTERS.md`: 멀티 에이전트 어댑터 설계(승인됨)와 단계별 구현 순서
- `docs/research/jsonl-format.json`: Claude Code 세션 기록 형식 조사 결과(구조만, 실제 내용 없음). Grok 은 `grok-format.json`, Codex 는 `codex-format.json`, Antigravity 는 `antigravity-format.json`
- 방 배정 규칙은 `public/js/rooms.js`의 `ROOM_RULES` 한 곳에서 바꿉니다.

## 개인정보

- 서버는 127.0.0.1에만 열리고, 다른 Host 헤더로 온 요청과 다른 사이트에서 온 요청(Origin, Sec-Fetch-Site)은 거절합니다.
- 루프백 주소는 사용자별로 나뉘지 않습니다. 같은 컴퓨터의 다른 OS 사용자나 웹 페이지까지 막으려면 `--auth`를 켜세요. 같은 사용자의 프로세스는 세션 기록 파일을 직접 읽을 수 있으므로 토큰으로 막는 대상이 아닙니다. 다른 사용자의 프로세스 인자가 보이는 공유 Linux 컴퓨터에서는 `--auth --open` 이 이 보호를 약하게 합니다(토큰 주소가 새로 뜬 브라우저의 인자에 남음). 그런 곳에서는 `--open` 없이 출력된 주소를 이미 떠 있는 브라우저에 직접 붙여 넣으세요.
- 브라우저로는 요약만 보냅니다. 명령 원문, 파일 내용, 수정 내용, 전체 경로(파일 이름만), 전체 URL(호스트만), 이메일, 커넥터 계정 uuid는 보내지 않습니다. 층 구분 키(`project`)만 작업 폴더 경로 전체를 담습니다.
- Grok 기록 폴더에서는 정해진 파일(`updates.jsonl`, `summary.json`, 승인 대기를 위한 `events.jsonl`)만 엽니다. `events.jsonl` 에서는 네 필드(기록 종류, 시각, 같은지 비교에만 쓰는 도구 이름, 허용/거절)만 읽고, MCP 오류 문구, 모델 id, 취소 사유 같은 나머지 필드는 읽지도 보내지도 않습니다. 원문 프롬프트 기록(`prompt_history.jsonl`, `chat_history.jsonl`), 계획 파일, 인증과 설정 파일은 열지 않습니다(`docs/CONTRACT.md` 4.6절).
- Codex 기록 폴더에서는 정해진 파일(`sessions/` 아래 날짜 폴더의 `rollout-*.jsonl`, `session_index.jsonl`)만 엽니다. 압축된 기록(`.jsonl.zst`), `archived_sessions/`, 원문 프롬프트 기록(`history.jsonl`), 인증과 설정 파일, SQLite 파일, 로그, `worktrees/` 안은 열지 않고, 심볼릭 링크인 폴더는 따라가지 않습니다. 세션 첫 줄의 계정 id 는 보내지 않고, 데스크톱 앱과 IDE 확장이 요청 앞에 붙이는 문맥(열린 파일, 탭, 언급한 파일)은 프롬프트로 보내지 않으며, code-mode 스크립트는 처음 부르는 `tools.<이름>` 의 이름만 봅니다(문자열, 정규식, 주석 안은 읽지 않음, `docs/CONTRACT.md` 4.7절).
- Antigravity 기록 폴더(`~/.gemini`)는 Gemini CLI 와 같이 쓰는 폴더라 인증 파일과 원문 입력 기록이 함께 있습니다. 그래서 `antigravity-cli/` 와 `antigravity-ide/` 아래의 정해진 파일(대화 기록 `transcript_full.jsonl` / `transcript.jsonl`, 요약 protobuf, `annotations/<대화>.pbtxt`, `task.md`)만 열고, 인증과 설정 파일(`oauth_creds.json`, `google_accounts.json`, `settings*.json` 등), 원문 입력 기록(`history.jsonl`, `history`), SQLite 대화 저장소, 암호화된 `.pb`, 백그라운드 알림(`messages/`), 도구 출력 파일, 데스크톱 앱 폴더 `antigravity/` 는 열지 않으며, 심볼릭 링크는 따라가지 않습니다. 모델이 도구 호출마다 붙이는 짧은 설명(`toolAction`, `toolSummary`)과 프롬프트 앞뒤의 환경 정보 블록(`ADDITIONAL_METADATA` 등)은 그 안에 적힌 내용까지 보내지 않고, 요약 protobuf 의 저장소 주소도 읽지 않습니다(`docs/CONTRACT.md` 4.8절).
- 기록 관찰(앞의 `기록 관찰` 절)의 결과 파일, 상태, SSE 메시지에는 개수, 번호, 정해진 종류 값, 오류 코드, 결과 파일 이름만 들어갑니다. 경로, 세션 id, 내용은 남기지 않습니다(`docs/CONTRACT.md` 5절, 6.2절). 관찰하는 동안에만 Grok 의 `active_sessions.json` 도 열어 행의 키 이름과 값의 타입만 셉니다(값은 읽어도 남기지 않습니다).

## 테스트

```bash
npm test
```

모든 테스트는 임시 폴더의 합성 데이터만 사용하고, 실제 `~/.claude`는 읽지 않습니다. 스킬 설치 테스트는 임시 HOME 에만 링크를 만들고, `--open` 테스트는 `PATH` 에 가짜 `open`/`xdg-open` 만 두어 진짜 브라우저를 열지 않습니다. `test/skill-commands.test.mjs` 는 `SKILL.md` 의 명령을 적힌 그대로(자리표시자만 바꿔) 실행해 봅니다. 다른 어댑터의 기록 폴더(`~/.grok`, `~/.codex`, `~/.gemini`)도 마찬가지입니다. 실행 파일을 띄우는 테스트는 기본 루트 `~/.grok`, `~/.codex`, `~/.gemini` 가 실제 폴더에 닿지 않도록 `HOME` 을 임시 폴더로 바꿉니다.
