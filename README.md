# Office Sim

AI 코딩 에이전트의 세션 기록을 0.25초마다 따라 읽어서, 직원들이 3D 사무실을 오가며 일하는 모습으로 보여 주는 로컬 서버입니다. 지금은 Claude Code 세션 기록(`~/.claude/projects/**/*.jsonl`)을 읽습니다.

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
| Grok (xAI Grok Build) | `grok` | 예정 (첫 번째) |
| Codex | `codex` | 예정 (두 번째) |
| Antigravity CLI (`agy`, 예전 IDE 포함) | `antigravity` | 예정 (세 번째) |
| Antigravity 데스크톱 앱 | 없음 | 범위 밖. 대화 파일이 암호화된 것으로 보여 도구 이벤트를 읽을 수 없습니다 |

예정인 도구는 각 도구의 세션 기록을 읽는 어댑터로 추가합니다. 어댑터마다 기록을 찾고 읽는 방법은 다르지만, 브라우저로 보내는 이벤트 형식과 개인정보 규칙은 모두 같습니다(`docs/CONTRACT.md` 2절, 4.0절, 5절). 설계와 구현 순서(Grok, Codex, Antigravity CLI)는 `docs/ADAPTERS.md` 에 있고, 2026-10-20 에 승인됐습니다.

서버는 구현된 어댑터 중 기록 폴더가 있는 것을 모두 켜고, 시작할 때 주소 다음 줄에 `office-sim: agents claude-code` 처럼 켜진 에이전트를 출력합니다(켜진 것이 없으면 `office-sim: agents none`). `--agents` 로 고른 id 중 아직 구현되지 않은 것은 `office-sim: codex is not implemented yet` 처럼 한 줄씩 알리고 건너뜁니다. 기록 폴더가 없거나 읽을 수 없는 어댑터는 로그 한 줄을 남기고 꺼지며(2초 안에 열리지 않는 폴더도 읽을 수 없는 것으로 봅니다), 서버는 빈 사무실로 계속 돕니다. 꺼진 어댑터의 기록 폴더는 rescan 주기마다 다시 확인해서, 나중에 폴더가 생기거나 읽을 수 있게 되면 `<id>: root found, adapter on` 로그 한 줄과 함께 그때 켭니다(`/healthz` 의 `agents` 에도 그때부터 보입니다. 시작할 때 출력한 `office-sim: agents` 줄은 바뀌지 않습니다).

모든 직원(캐릭터)은 어느 도구의 세션인지 나타내는 에이전트 id를 가집니다. 서버가 보내는 `session` 이벤트의 `agent` 필드이고, 지금은 항상 `claude-code` 입니다. 화면에는 `Claude Code`, `Codex`, `Grok`, `Antigravity` 로 보이고, 모르는 id는 그대로 보입니다.

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
| `--agents` | 구현된 어댑터 중 기록 폴더가 있는 것 모두 | 켤 에이전트 id 를 쉼표로 고릅니다(예: `--agents claude-code`). `claude-code`, `codex`, `grok`, `antigravity` 만 받고, 그 밖의 id 는 오류(종료 코드 2)입니다. 아직 구현되지 않은 id 는 알리고 건너뜁니다 |
| `--codex-root` | `~/.codex` | 예약: 다음 Codex 어댑터의 기록 위치. 지금은 받기만 하고 쓰지 않습니다 |
| `--grok-root` | `~/.grok` | 예약: 다음 Grok 어댑터의 기록 위치. 지금은 받기만 하고 쓰지 않습니다 |
| `--antigravity-root` | `~/.gemini` | 예약: 다음 Antigravity CLI 어댑터의 기록 위치. 지금은 받기만 하고 쓰지 않습니다 |
| `--replay` | 없음 | 지난 세션 하나(`<uuid>.jsonl` 과 그 서브에이전트 파일)를 기록된 시간 간격대로 다시 보여 줍니다. 이때 `--claude-root`(`--root`), `--active`, `--rescan` 은 쓰지 않습니다. 재생은 Claude Code 세션만 됩니다 |
| `--speed` | 1 | 재생 배속(0.1~1000). 줄 사이 공백은 배속으로 나누고, 한 공백은 최대 5초로 줄입니다 |
| `--loop` | 꺼짐 | 재생이 끝나면 모두 퇴근시킨 뒤 처음부터 다시 합니다 |
| `--auth` | 꺼짐 | 실행마다 새 토큰을 만들고 `http://127.0.0.1:<port>/?t=<토큰>` 주소를 출력합니다. 그 주소를 한 번 열면 브라우저가 쿠키를 받고, 쿠키 없는 요청은 모두 401로 거절합니다(값을 받지 않는 스위치) |

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
- `public/`: three.js 사무실 화면. localhost에서 열면 라이브, 그 밖에서는 데모 데이터로 동작합니다(`#demo`로 강제 가능).
- `docs/CONTRACT.md`: 모듈 경계, 이벤트 형식, 파싱 규칙
- `docs/ADAPTERS.md`: 멀티 에이전트 어댑터 설계(승인됨)와 단계별 구현 순서
- `docs/research/jsonl-format.json`: Claude Code 세션 기록 형식 조사 결과(구조만, 실제 내용 없음)
- 방 배정 규칙은 `public/js/rooms.js`의 `ROOM_RULES` 한 곳에서 바꿉니다.

## 개인정보

- 서버는 127.0.0.1에만 열리고, 다른 Host 헤더로 온 요청과 다른 사이트에서 온 요청(Origin, Sec-Fetch-Site)은 거절합니다.
- 루프백 주소는 사용자별로 나뉘지 않습니다. 같은 컴퓨터의 다른 OS 사용자나 웹 페이지까지 막으려면 `--auth`를 켜세요. 같은 사용자의 프로세스는 세션 기록 파일을 직접 읽을 수 있으므로 토큰으로 막는 대상이 아닙니다.
- 브라우저로는 요약만 보냅니다. 명령 원문, 파일 내용, 수정 내용, 전체 경로(파일 이름만), 전체 URL(호스트만), 이메일, 커넥터 계정 uuid는 보내지 않습니다. 층 구분 키(`project`)만 작업 폴더 경로 전체를 담습니다.

## 테스트

```bash
npm test
```

모든 테스트는 임시 폴더의 합성 데이터만 사용하고, 실제 `~/.claude`는 읽지 않습니다. 예정된 어댑터의 기록 폴더(`~/.codex`, `~/.grok`, `~/.gemini`)도 마찬가지입니다.
