# Office Sim (한국어 문서)

[English README](README.md) | **한국어**

AI 코딩 에이전트의 세션 기록을 0.25초마다 따라 읽어서, 에이전트 캐릭터들이 3D 공간을 오가며 일하는 모습으로 보여 주는 로컬 서버입니다. **Claude Code**(`~/.claude/projects/**/*.jsonl`), **Grok (xAI Grok Build)**(`~/.grok/sessions/<작업 폴더>/<세션>/updates.jsonl`), **OpenAI Codex**(`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`), **Google Antigravity**(`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/<대화>/.system_generated/logs/transcript_full.jsonl`) 세션을 외부 의존성 없이 로컬에서 실시간 시각화합니다.

## 빠른 시작

Node.js 22 이상이 필요하며, 설치할 외부 패키지가 없습니다(Zero dependencies).

```bash
# 바로 실행 (기본 포트 4317)
npx office-sim --open

# 또는 저장소를 클론해서 실행
git clone https://github.com/WahyzMaster/office-sim.git
cd office-sim
npm start
```

브라우저에서 `http://127.0.0.1:4317`을 열면 로컬 에이전트 세션이 실시간으로 표시되며, `http://127.0.0.1:4317/#demo`를 열면 서버 없이도 네 종류 에이전트가 협업하는 데모 시나리오를 체험할 수 있습니다.

## 5가지 공간 테마 프리셋과 방 구성

상단 바의 **공간(Theme)** 선택기에서 5가지 테마 프리셋을 즉시 전환할 수 있으며, **KO / EN** 버튼으로 한국어·영어 UI를 바로 바꿀 수 있습니다. 테마를 바꾸면 직사각형을 벗어난 **비정형 3D 건물 구조**(조선 궁궐 장대석 기단·경회루 연못 회랑, 전통 한옥 ㄱ·ㄷ자 마당·돌출 누각, SF 스타십 팔각 선체·워프 코어), **테마별 3D 가구**, **캐릭터 복식·모자**(관복·정자관·흑립 갓·사모 / 한옥 배자·유건·삿갓·전립 / 스타십 우주복·제트팩)가 함께 리모델링됩니다. 또한 각 층마다 사람이 복제되어 앉아 있던 기존 `내 자리` 대신 **3D 리뷰·승인 인터콤 부스**가 놓이며, **범례 안내** 패널에서 회전하는 3D 캐릭터 모형(호버 툴팁 포함)과 상태·색깔 신호 범례를 한눈에 볼 수 있습니다.

| 역할 (`key`) | AI 스튜디오 (`studio`, 기본) | 테크 오피스 (`office`) | 조선 궁궐 (`palace`) | 전통 한옥 (`hanok`) | SF 스타십 (`starship`) | 주요 도구·역할 |
|---|---|---|---|---|---|---|
| `archive` | **코드 탐색실** (Codebase Lab) | 라이브러리 (Library) | **규장각** (Royal Archives) | **장판각** (Woodblock Library) | 데이터 볼트 (Data Vault) | `Read`, `Grep`, `Glob`, `codegraph` |
| `dev` | **코딩 스튜디오** (Coding Studio) | 개발존 (Dev Zone) | **집현전** (Hall of Worthies) | **글방** (Scholar's Study) | 포지 베이 (Forge Bay) | `Edit`, `Write`, `NotebookEdit`, `apply_patch` |
| `server` | **터미널·빌드실** (Terminal & Ops) | 서버룸 (Server Room) | **군기시** (Royal Arsenal) | **대장간** (Blacksmith Forge) | 엔진 코어 (Engine Core) | `Bash`, `git`, `gh`, 테스트·빌드 |
| `research` | **웹·MCP 허브** (Web & MCP Hub) | 리서치랩 (Research Lab) | **관상감** (Royal Observatory) | **누각** (Lookout Pavilion) | 센서 어레이 (Sensor Array) | `WebSearch`, `WebFetch`, 외부 MCP |
| `meeting` | **기획·작전실** (Strategy Room) | 보드룸 (Boardroom) | **빈청** (State Council) | **대청마루** (Main Hall) | 택티컬 브리지 (Tactical Bridge) | 계획 수립 · 할 일 화이트보드 기록 |
| `desk` | **리뷰·승인 부스** (Review Booth) | 핫라인 부스 (Hotline Booth) | **승정원** (Royal Secretariat) | **사랑채** (Master's Reception) | 홀로그램 통신실 (Holo-Comms Pod) | 사용자 질문(`AskUserQuestion`) · 권한/계획 승인 |
| `lounge` | **라운지** (Lounge) | 라운지 (Lounge) | **후원** (Royal Courtyard) | **안마당** (Inner Courtyard) | 크루 라운지 (Crew Lounge) | 대기 · 출퇴근 엘리베이터 |

- 프로젝트(작업 폴더)마다 한 층을 씁니다. 같은 저장소의 워크트리 세션은 같은 층에 모이고, 작업 폴더가 정해지지 않은 세션은 `전역 · 미지정`(`Global · Unassigned`) 층에 모이며, 직원이 모두 퇴근한 빈 층은 자동으로 정리됩니다.
- 캐릭터마다 에이전트 브랜드 색상과 전용 3D 소품(Claude Code 베레모·스타버스트, Codex 바이저·육각 크리스탈, Grok 선글라스·토성 궤도 링, Antigravity 부유 링·프리즘과 CLI 캡/App 헤드셋)을 갖추고, 서브에이전트는 프로펠러 모자를 쓴 작은 캐릭터로 나타납니다.

## 지원하는 에이전트

| 에이전트 | 에이전트 id | 상태 |
|---|---|---|
| Claude Code | `claude-code` | 지원 (`~/.claude/projects/**/*.jsonl`) |
| Grok (xAI Grok Build) | `grok` | 지원 (P5c). 라이브 승인 대기도 보임 (P5g, 권한 창이 열린 뒤 1~4초 늦게, 답하는 쪽은 Grok 의 자동 검토일 수도 있음) |
| Codex (데스크톱 앱, CLI, IDE 확장 모두) | `codex` | 지원 (P5d, `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`) |
| Antigravity CLI (`agy`)와 예전 Antigravity IDE | `antigravity` (`surface: 'cli'`) | 지원 (P5e). 화면에는 `Antigravity (CLI)` · 배지 `AGY·CLI` 로 표시 |
| Antigravity 데스크톱 앱 (Antigravity.app 2.x) | `antigravity` (`surface: 'app'`) | 지원. `~/.gemini/antigravity/brain/<대화>/.system_generated/logs/` 의 단계 기록과 아티팩트(`task.md`, `implementation_plan.md`)를 읽고, 암호화된 `conversations/*.pb` 는 열지 않습니다. 화면에는 `Antigravity (App)` · 배지 `AGY·App` 로 표시 |

## 카메라 조작 프리셋

상단 바의 **조작(Controls)** 선택기(`구글 맵`, `피그마`, `3D 오빗`, `블렌더`)에서 손에 익은 마우스·트랙패드 조작 방식을 고를 수 있으며, 브라우저(`localStorage`)에 자동 저장됩니다.

| 프리셋 | 좌클릭 드래그 | 우클릭 / 보조 드래그 | 휠 / 트랙패드 스크롤 |
|---|---|---|---|
| **구글 맵** (기본) | 바닥 수평 이동 (패닝) | 우클릭 또는 `Ctrl`+좌클릭: 시점 회전·기울기 | 줌 인 / 줌 아웃 (`Shift`+방향키: 회전·기울기) |
| **피그마** | 시점 회전 | `Space`+드래그 또는 휠클릭: 이동 | 상하좌우 패닝 (`Ctrl`/`⌘`+휠: 줌, `Shift+0/1/2`: 시점·포커스) |
| **3D 오빗** | 시점 회전 (오빗) | 우클릭 또는 `Shift`/`Space`+드래그: 이동 | 줌 인 / 줌 아웃 |
| **블렌더** | 바닥 수평 이동 | 휠클릭 또는 `Alt`+드래그: 회전 | 줌 인 / 줌 아웃 (`.`/`F`: 선택 포커스, `Home`/`R`: 초기화) |

## CLI 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--port` | `4317` | HTTP 포트(`0`이면 빈 포트 자동 할당) |
| `--host` | `127.0.0.1` | 루프백 주소만 허용 (`127.0.0.1`, `localhost`, `::1`) |
| `--interval` | `250` | tail 간격(ms, 50~5000) |
| `--active` | `30` | 최근 N분 안에 수정된 세션만 따라감 |
| `--rescan` | `3000` | 새 세션 파일을 찾는 간격(ms) |
| `--agents` | 기록 폴더가 있는 에이전트 모두 | 켤 에이전트 id 를 쉼표로 선택 (`claude-code,codex,grok,antigravity`) |
| `--claude-root` | `~/.claude/projects` | Claude Code 세션 기록 위치 (`--root` 별칭 지원) |
| `--codex-root` | `~/.codex` | Codex 기록 위치 |
| `--grok-root` | `~/.grok` | Grok 기록 위치 |
| `--antigravity-root` | `~/.gemini` | Antigravity 데스크톱 앱·CLI·IDE 기록 위치 |
| `--replay <file.jsonl>` | 없음 | 지난 Claude Code 세션 하나를 기록된 시간 간격대로 재생 |
| `--speed <n>` | `1` | 재생 배속 (`0.1`~`1000`) |
| `--loop` | 꺼짐 | 재생이 끝나면 처음부터 반복 |
| `--auth` | 꺼짐 | 일회용 토큰(`http://127.0.0.1:<port>/?t=<token>`)으로 쿠키 인증 강제 |
| `--open` | 꺼짐 | 서버 시작 시 기본 브라우저로 화면 열기 |

## `/office` 스킬 설치

```bash
npm run skill:install                  # ~/.claude/skills/office -> <저장소>/skills/office
npm run skill:install -- --skills-dir ~/.agents/skills
npm run skill:uninstall
```

## 개인정보 보호 및 아키텍처 상세

- 서버는 루프백(`127.0.0.1`)에만 열리며, 파일 내용·명령 원문·전체 경로·전체 URL·이메일·인증 파일은 절대 읽거나 브라우저로 보내지 않습니다.
- 상세 계약과 어댑터 명세는 [`docs/CONTRACT.md`](docs/CONTRACT.md), [`docs/ADAPTERS.md`](docs/ADAPTERS.md), [`docs/HISTORY.md`](docs/HISTORY.md)를 참고하세요.
- 어댑터 개발용 실시간 기록 관찰 패널은 `http://127.0.0.1:4317/?observe=1` (또는 `#observe`)로 열었을 때만 상단 바에 나타납니다.
