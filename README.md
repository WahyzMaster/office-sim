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
| Grok (xAI Grok Build) | `grok` | 지원 (P5c) |
| Codex (데스크톱 앱, CLI, IDE 확장 모두) | `codex` | 지원 (P5d) |
| Antigravity CLI (`agy`)와 예전 Antigravity IDE | `antigravity` | 지원 (P5e) |
| Antigravity 데스크톱 앱 (Antigravity.app 2.x) | 없음 | 범위 밖(결정 D6). 대화 파일(`~/.gemini/antigravity/conversations/*.pb`)이 암호화된 것으로 보이고 통째로 다시 쓰이며, 대화 폴더에 단계 기록(`logs/`)이 없어 도구 이벤트를 읽을 수 없습니다. 그래서 `~/.gemini/antigravity/` 는 열지 않습니다 |

도구마다 그 도구의 세션 기록을 읽는 어댑터가 있습니다. 어댑터마다 기록을 찾고 읽는 방법은 다르지만, 브라우저로 보내는 이벤트 형식과 개인정보 규칙은 모두 같습니다(`docs/CONTRACT.md` 2절, 4.0절, 5절). Claude Code 어댑터의 규칙은 `docs/CONTRACT.md` 4.1~4.5절에, Grok 은 4.6절에, Codex 는 4.7절에, Antigravity 는 4.8절에 있습니다. 같은 작업 폴더의 Claude Code, Grok, Codex, Antigravity 세션은 모두 같은 층에서 일합니다. 설계와 구현 순서(Grok, Codex, Antigravity CLI)는 `docs/ADAPTERS.md` 에 있고, 2026-10-20 에 승인됐습니다.

서버는 구현된 어댑터 중 기록 폴더가 있는 것을 모두 켜고, 시작할 때 주소 다음 줄에 켜진 에이전트를 출력합니다. 네 기록 폴더(`~/.claude/projects`, `~/.codex`, `~/.grok`, `~/.gemini`)가 모두 있으면 `office-sim: agents claude-code,codex,grok,antigravity`(`~/.gemini` 는 Gemini CLI 도 쓰는 폴더라, Antigravity 를 쓰지 않아도 이 폴더가 있으면 `antigravity` 가 켜지고 빈 목록을 훑습니다), Claude Code 폴더만 있으면 `office-sim: agents claude-code` 처럼 나오고(순서는 늘 `claude-code`, `codex`, `grok`, `antigravity`), 켜진 것이 없으면 `office-sim: agents none` 입니다. 이제 네 id 가 모두 구현되어 있어서, `--agents` 로 고른 id 가 "아직 구현되지 않음"(`office-sim: <id> is not implemented yet`)으로 알려지는 일은 없습니다(앞으로 id 가 늘면 그 규칙이 다시 쓰입니다). 기록 폴더가 없거나 읽을 수 없는 어댑터는 로그 한 줄을 남기고 꺼지며(2초 안에 열리지 않는 폴더도 읽을 수 없는 것으로 봅니다), 서버는 빈 사무실로 계속 돕니다. 꺼진 어댑터의 기록 폴더는 rescan 주기마다 다시 확인해서, 나중에 폴더가 생기거나 읽을 수 있게 되면 `<id>: root found, adapter on` 로그 한 줄과 함께 그때 켭니다(`/healthz` 의 `agents` 에도 그때부터 보입니다. 시작할 때 출력한 `office-sim: agents` 줄은 바뀌지 않습니다).

모든 직원(캐릭터)은 어느 도구의 세션인지 나타내는 에이전트 id를 가집니다. 서버가 보내는 `session` 이벤트의 `agent` 필드이고, `claude-code`, `codex`, `grok`, `antigravity` 중 하나입니다(Codex 직원의 id 는 `codex-`, Grok 직원의 id 는 `grok-`, Antigravity 직원의 id 는 `antigravity-` 로 시작합니다). 화면에는 `Claude Code`, `Codex`, `Grok`, `Antigravity` 로 보이고, 모르는 id는 그대로 보입니다.

에이전트마다 기록이 남는 방식이 달라서 직원이 보이는 모습도 조금씩 다릅니다. Claude Code 직원은 도구 호출과 서브에이전트(모자 쓴 작은 직원)가 가장 자세히 보입니다. Grok 직원은 서브에이전트도 따로 보이고, 턴은 Grok 이 적는 턴 끝 기록으로 끝납니다. Codex 직원은 데스크톱 앱, CLI, IDE 확장 어느 쪽에서 시작했든 같은 모습이고, 자동 승인 검토(guardian) 스레드는 보이지 않으며, code-mode 스크립트 하나 안의 명령, 파일 수정, MCP 호출은 끝날 때마다 그 방에 잠깐 들르는 모습으로 보입니다. Antigravity 직원은 한 단계가 끝나야 기록 줄이 쓰이므로 반응이 한 박자(모델이 생각하는 6~35초) 늦고, 서브에이전트 없이 모두 메인 직원이며, 도구 없이 답만 한 뒤 20초 동안 조용하면(요약 파일의 상태가 쉬는 중으로 바뀌면 그때 바로) 턴이 끝난 것으로 봅니다. 예전 IDE 대화는 `task.md` 체크리스트가 있으면 회의실 화이트보드에 보입니다.

## 실행

Node 20 이상이 필요하고, 설치할 의존성은 없습니다.

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
| `--grok-root` | `~/.grok` | Grok(xAI Grok Build) 기록 위치. 그 아래 `sessions/<작업 폴더>/<세션>/` 의 `updates.jsonl` 과 `summary.json`(제목, 작업 폴더, branch, 서브에이전트 종류)만 읽고, 서브에이전트는 `subagents/` 아래 폴더 이름으로만 연결합니다. 옵션을 주지 않으면 실행 파일(`bin/office-sim.mjs`)이 기본값을 채웁니다(서버의 `start()` 는 받은 루트만 씁니다) |
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
| `/office status` | `/healthz` 로 실행 여부, 켜진 에이전트, 세션 수, 접속 수를 알려 줍니다 |
| `/office stop` | 이 저장소의 `bin/office-sim.mjs` 를 절대 경로로 실행한 서버만 멈춥니다(`npm start` 로 터미널에서 띄운 서버는 그대로 둡니다) |

"사무실 열어 줘", "에이전트들 뭐 하는지 보여 줘" 처럼 말로 해도 됩니다. 앱 안의 브라우저가 있으면 그곳에서, 없으면 OS 의 여는 명령(`open`, `xdg-open`, `cmd /c start`)을 직접 실행해 기본 브라우저로 열고, 열지 못하면 그렇다고 말하고 직접 열 주소를 알려 줍니다. 이미 4317 에 떠 있던 서버를 다시 쓸 때는 그 서버가 이 저장소에서 `/office` 로 띄운 것인지 확인해, 아니면(`npm start` 로 터미널에서 띄운 서버, 다른 체크아웃) 띄운 곳에서 Ctrl-C 로 멈추라고 알려 줍니다. 스킬은 `/healthz` 응답과 서버가 출력한 `office-sim:` 줄만 읽고, 세션 기록은 열지 않습니다.

## 재생 모드

```bash
node bin/office-sim.mjs --replay test/fixtures/replay/7e7e7e7e-1111-4222-8333-444455556666.jsonl --speed 4 --loop
```

화면 위쪽 칩에 `재생 · 4× · 37%` 가 보입니다. 재생에서는 결과 줄을 미리 읽을 수 있어서, 사람이 권한 창에서 허용하거나 거절한 도구 호출은 직원이 '내 자리'로 와서 `승인 대기` 말풍선을 띄웁니다. 라이브 모드는 승인 창이 열려 있는 동안 기록에 아무것도 쓰이지 않아 이 표시를 하지 않습니다(`docs/CONTRACT.md` 7절).

## 성능 측정

`http://127.0.0.1:4317/#bench` 를 열면 층 10개, 직원 60명의 합성 부하가 돕니다. 콘솔에서 `__officeBench.burn({ frames: 300, focus: 9 })` 나 `await __officeBench.measure({ seconds: 5, focus: 'all' })` 로 프레임 시간, 그리기 호출, 라벨 수, 힙을 잽니다. 초점이 아닌 층은 그림자와 라벨을 끄고, 숨은 위층은 행렬 갱신과 애니메이션도 건너뜁니다.

## 구조

- `src/`: 탐색(discover), tail(tailer), 레코드 분류(records), 세션 상태(session), 계획 복원(plan), 요약(summarize), 저장소와 SSE 서버(store, server), 재생 모드(replay, replay-timeline)
- `src/store-claude.mjs`: Claude Code 서브에이전트 연결(저장소에서 Claude 전용 부분을 떼어 낸 것)
- `src/adapters/`: 어댑터 등록표(`index.mjs`)와 Claude Code 설명자(`claude-code.mjs`). Claude 모듈은 제자리에 두고 설명자가 가리킵니다
- `src/adapters/grok/`: Grok 어댑터(탐색, 레코드 정규화, 설명자 `index.mjs`)
- `src/adapters/codex/`: Codex 어댑터(날짜 폴더 탐색과 첫 줄 사실, 제목 색인 읽기, 레코드 정규화와 code-mode `exec` 방문, 설명자 `index.mjs`)
- `src/adapters/antigravity/`: Antigravity 어댑터(두 앱 폴더의 허용 목록 탐색과 파일 고르기, 요약 protobuf 해석기 `proto.mjs`, 메타 파일, 단계 정규화와 위치 짝짓기, 설명자 `index.mjs`)
- `src/core/`: 새 어댑터가 같이 쓰는 부품. 세션 코어(`session-core.mjs`, `session-items.mjs`), 도구 요약(`tool-summary.mjs`), 바뀔 때만 다시 읽는 메타 파일 감시(`sidecar.mjs`)
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
- Grok 기록 폴더에서는 정해진 파일(`updates.jsonl`, `summary.json`)만 엽니다. 원문 프롬프트 기록(`prompt_history.jsonl`, `chat_history.jsonl`), 런타임 이벤트(`events.jsonl`), 계획 파일, 인증과 설정 파일은 열지 않습니다(`docs/CONTRACT.md` 4.6절).
- Codex 기록 폴더에서는 정해진 파일(`sessions/` 아래 날짜 폴더의 `rollout-*.jsonl`, `session_index.jsonl`)만 엽니다. 압축된 기록(`.jsonl.zst`), `archived_sessions/`, 원문 프롬프트 기록(`history.jsonl`), 인증과 설정 파일, SQLite 파일, 로그, `worktrees/` 안은 열지 않고, 심볼릭 링크인 폴더는 따라가지 않습니다. 세션 첫 줄의 계정 id 는 보내지 않고, 데스크톱 앱과 IDE 확장이 요청 앞에 붙이는 문맥(열린 파일, 탭, 언급한 파일)은 프롬프트로 보내지 않으며, code-mode 스크립트는 처음 부르는 `tools.<이름>` 의 이름만 봅니다(문자열, 정규식, 주석 안은 읽지 않음, `docs/CONTRACT.md` 4.7절).
- Antigravity 기록 폴더(`~/.gemini`)는 Gemini CLI 와 같이 쓰는 폴더라 인증 파일과 원문 입력 기록이 함께 있습니다. 그래서 `antigravity-cli/` 와 `antigravity-ide/` 아래의 정해진 파일(대화 기록 `transcript_full.jsonl` / `transcript.jsonl`, 요약 protobuf, `annotations/<대화>.pbtxt`, `task.md`)만 열고, 인증과 설정 파일(`oauth_creds.json`, `google_accounts.json`, `settings*.json` 등), 원문 입력 기록(`history.jsonl`, `history`), SQLite 대화 저장소, 암호화된 `.pb`, 백그라운드 알림(`messages/`), 도구 출력 파일, 데스크톱 앱 폴더 `antigravity/` 는 열지 않으며, 심볼릭 링크는 따라가지 않습니다. 모델이 도구 호출마다 붙이는 짧은 설명(`toolAction`, `toolSummary`)과 프롬프트 앞뒤의 환경 정보 블록(`ADDITIONAL_METADATA` 등)은 그 안에 적힌 내용까지 보내지 않고, 요약 protobuf 의 저장소 주소도 읽지 않습니다(`docs/CONTRACT.md` 4.8절).

## 테스트

```bash
npm test
```

모든 테스트는 임시 폴더의 합성 데이터만 사용하고, 실제 `~/.claude`는 읽지 않습니다. 스킬 설치 테스트는 임시 HOME 에만 링크를 만들고, `--open` 테스트는 `PATH` 에 가짜 `open`/`xdg-open` 만 두어 진짜 브라우저를 열지 않습니다. `test/skill-commands.test.mjs` 는 `SKILL.md` 의 명령을 적힌 그대로(자리표시자만 바꿔) 실행해 봅니다. 다른 어댑터의 기록 폴더(`~/.grok`, `~/.codex`, `~/.gemini`)도 마찬가지입니다. 실행 파일을 띄우는 테스트는 기본 루트 `~/.grok`, `~/.codex`, `~/.gemini` 가 실제 폴더에 닿지 않도록 `HOME` 을 임시 폴더로 바꿉니다.
