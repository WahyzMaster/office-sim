<div align="center">
<h1>Office Sim (한국어 문서)</h1>
<p><strong>Claude Code, OpenAI Codex, xAI Grok, Google Antigravity 세션을 실시간으로 시각화하는 무의존성 3D 멀티 에이전트 오피스</strong></p>

[![CI](https://github.com/WahyzMaster/office-sim/actions/workflows/test.yml/badge.svg)](https://github.com/WahyzMaster/office-sim/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/office-sim?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/office-sim)
[![Live 3D Demo](https://img.shields.io/badge/Live_3D_Demo-GitHub_Pages-38bdf8?style=flat-square&logo=three.js&logoColor=white)](https://wahyzmaster.github.io/office-sim/?lang=ko#demo)
[![Node >=22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-10b981?style=flat-square)](#빠른-시작)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub_Sponsors-ea4aaa?style=flat-square&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/WahyzMaster)
[![Polar.sh](https://img.shields.io/badge/Sponsor-Polar.sh-0062ff?style=flat-square)](https://polar.sh/WahyzMaster)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-wahyzdad-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/wahyzdad)

[English README](README.md) | **한국어** | [실시간 3D 웹 데모 열기](https://wahyzmaster.github.io/office-sim/?lang=ko#demo) | [고화질 데모 영상 (MP4)](docs/assets/ko/demo-hero.mp4)

<a href="https://wahyzmaster.github.io/office-sim/?lang=ko#demo">
  <img src="docs/assets/ko/demo-hero.gif" alt="Office Sim 3D 멀티 에이전트 시각화 데모" width="100%" />
</a>

*위 프리뷰를 클릭하면 설치 없이 브라우저에서 [실시간 인터랙티브 3D 데모](https://wahyzmaster.github.io/office-sim/?lang=ko#demo)를 바로 체험할 수 있으며, [720p H.264 데모 영상 (`docs/assets/ko/demo-hero.mp4`)](docs/assets/ko/demo-hero.mp4)도 직접 확인할 수 있습니다.*

</div>

---

**Office Sim**은 AI 코딩 에이전트의 세션 기록을 0.25초마다 따라 읽어서, 에이전트 캐릭터들이 3D 공간을 오가며 협업하는 모습을 실시간으로 보여 주는 로컬 서버입니다. **Claude Code**(`~/.claude/projects/**/*.jsonl`), **Grok (xAI Grok Build)**(`~/.grok/sessions/<작업 폴더>/<세션>/updates.jsonl`), **OpenAI Codex**(`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`), **Google Antigravity**(`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/<대화>/.system_generated/logs/transcript_full.jsonl`) 세션을 외부 패키지 의존성 없이 로컬에서 즉시 시각화합니다.

## 빠른 시작

**Node.js 22 이상**이 필요하며, 설치할 외부 런타임 패키지가 전혀 없습니다(Zero dependencies).

```bash
# 바로 실행 (기본 포트 4317)
npx office-sim --open

# 또는 저장소를 클론해서 실행
git clone https://github.com/WahyzMaster/office-sim.git
cd office-sim
npm start
```

- **실시간 로컬 세션 감시**: 브라우저에서 `http://127.0.0.1:4317`을 열면 현재 실행 중인 로컬 에이전트 세션이 실시간으로 표시됩니다.
- **무설치 데모 모드**: `http://127.0.0.1:4317/?lang=ko#demo` 또는 [GitHub Pages 라이브 데모](https://wahyzmaster.github.io/office-sim/?lang=ko#demo)를 열면 로컬 세션 없이도 네 종류 에이전트가 여러 층에서 협업하는 데모 시나리오를 체험할 수 있습니다.

## 테마 및 화면 갤러리

| 퍼피 파크 (`dogs`) | 캣 타워 살롱 (`cats`) |
| :---: | :---: |
| <img src="docs/assets/ko/theme-dogs.png" alt="퍼피 파크 테마와 8종 3D 강아지 캐릭터" width="100%" /> | <img src="docs/assets/ko/theme-cats.png" alt="캣 타워 살롱 테마와 6종 3D 고양이 캐릭터" width="100%" /> |
| **뼈다귀 모양 잔디 마당, 발바닥 분수대, 어질리티 링과 8종 3D 강아지 품종** (골든·래브라도 리트리버, 진돗개 백구·흑구·네눈박이, 보더 콜리, 웰시 코기, 시바견) | **고양이 귀 썬룸, 3단 캣타워, 벨벳 라운지와 6종 3D 고양이 품종** (사바나·아세라, 벵갈, 브리티시·러시안 블루, 샤미즈, 랙돌, 스코티시 폴드) |
| **조선 궁궐 (`palace` - 밤 조명 모드)** | **다층 프로젝트 오버뷰 (`starship` & `hanok`)** |
| <img src="docs/assets/ko/theme-palace-night.png" alt="조선 궁궐 테마 밤 조명 모드" width="100%" /> | <img src="docs/assets/ko/theme-hanok-starship.png" alt="SF 스타십과 전통 한옥 다층 오버뷰" width="100%" /> |
| **장대석 흰 돌 기단, 경회루 연못 회랑과 은은한 청사초롱 야간 조명** (`밤` 조명 모드) | **프로젝트별 다층 구조** (2층 SF 스타십 팔각 선체·워프 코어 & 1층 전통 한옥 ㄱ·ㄷ자 마당) |
| **AI 스튜디오 (`studio`)** | **19종 3D 캐릭터 도감 및 LLM별 맞춤 배정** |
| <img src="docs/assets/ko/theme-studio.png" alt="AI 스튜디오 테마와 실시간 말풍선" width="100%" /> | <img src="docs/assets/ko/legend-catalog.png" alt="스크롤 가능한 19종 3D 캐릭터 범례와 에이전트 상세 창" width="100%" /> |
| **실시간 도구 말풍선, 3D 화이트보드 체크리스트, 리뷰·승인 인터콤 부스**가 갖춰진 모던 AI 스튜디오 | **전체 19종 3D 캐릭터·반려동물 모형과 6종 LLM별 배정 현황**을 스크롤하며 볼 수 있는 범례 패널 |

## 핵심 기능 및 7축 독립 커스터마이징

상단 컨트롤 바에서 **공간·캐릭터·LLM별 캐릭터 배정·자세·음성·조명·카메라 조작**을 서로 독립적으로 조합할 수 있으며, 모든 설정은 브라우저(`localStorage`)에 자동 저장됩니다.

- **공간 (`7`가지 3D 건축 테마)**: `AI 스튜디오`, `테크 오피스`, `조선 궁궐`, `전통 한옥`, `SF 스타십`, `퍼피 파크`, `캣 타워 살롱` 중 원하는 3D 건물 구조와 방 가구를 즉시 전환합니다.
- **캐릭터 (`8`가지 프리셋 + `개별 설정`)**: 건물 공간과 캐릭터 외형을 분리하여, 예컨대 조선 궁궐이나 SF 스타십 안에서 강아지·고양이·한옥 선비 캐릭터가 일하도록 자유롭게 조합할 수 있습니다.
- **LLM별 캐릭터 개별 매핑 (`19`종 3D 모형)**: 캐릭터 선택기 옆의 설정(기어) 버튼을 눌러 **Claude Code**, **OpenAI Codex**, **Grok**, **Antigravity (CLI)**, **Antigravity (App)**, **서브에이전트** 각각에 19종(인간 의상 5종 + 강아지 8종 + 고양이 6종) 중 원하는 캐릭터를 개별 배정할 수 있습니다.
- **자세 (`자동` / `앉기` / `서기`)**: 책상 앞에서 자동으로 착석하거나 항상 서 있기·앉아 있기를 선택할 수 있습니다.
- **음성 (`끄기` / `자동` / `동물` / `사람`)**: Web Audio 합성 사운드로 사람 음성 차임벨, 강아지 짖는 소리, 고양이 울음소리를 재생합니다.
- **조명 (`낮` / `밤` / `자동`)**: 밝은 주간 조명, 아늑한 야간 무드 조명, 또는 현재 시각 연동 자동 모드를 지원합니다.
- **3D 가구 충돌 회피 및 비겹침 좌석 배정**: 각 방의 책상·서버 랙·원탁·캣타워·연못마다 2D 충돌 박스가 등록되어 있어, 캐릭터가 이동할 때 가구와 겹치지 않고 자연스럽게 우회하며 빈 좌석에 나누어 앉습니다.
- **스크롤 가능한 19종 3D 캐릭터 도감 범례**: 우측 하단 **범례 안내** 패널에서 회전하는 19종 전체 3D 모형과 현재 LLM별 캐릭터 배정 카드, 방·상태 색깔 신호를 스크롤하며 한눈에 확인할 수 있습니다.
- **스트리머·OBS 투명 오버레이 모드 & 5초 클립 캡처**:
  - `?overlay=1`(또는 `#overlay`, 단축키 `O`)로 열면 상·하단 UI 패널을 숨기고 3D 캔버스 배경을 투명하게(또는 `?chroma=green` / `?chroma=blue` 크로마키 배경으로) 전환해 OBS 브라우저 소스나 코딩 방송 오버레이로 바로 쓸 수 있습니다.
  - 상단 바의 **5초 클립**(`#capture-clip`) 버튼을 누르면 5초 분량의 WebM 영상을 즉시 녹화·저장하며, `Shift+클릭`하면 고해상도 PNG 스크린샷을 저장합니다.

## 7가지 공간 테마와 방 구성

| 역할 (`key`) | AI 스튜디오 (`studio`, 기본) | 테크 오피스 (`office`) | 조선 궁궐 (`palace`) | 전통 한옥 (`hanok`) | SF 스타십 (`starship`) | 퍼피 파크 (`dogs`) | 캣 타워 살롱 (`cats`) | 주요 도구·역할 |
|---|---|---|---|---|---|---|---|---|
| `archive` | **코드 탐색실** | 라이브러리 | **규장각** | **장판각** | 데이터 볼트 | **노즈워크 숲** | **창가 캣타워** | `Read`, `Grep`, `Glob`, `codegraph` |
| `dev` | **코딩 스튜디오** | 개발존 | **집현전** | **글방** | 포지 베이 | **어질리티 훈련장** | **스크래처 공방** | `Edit`, `Write`, `NotebookEdit`, `apply_patch` |
| `server` | **터미널·빌드실** | 서버룸 | **군기시** | **대장간** | 엔진 코어 | **우다다 트랙** | **레이저 사냥터** | `Bash`, `git`, `gh`, 테스트·빌드 |
| `research` | **웹·MCP 허브** | 리서치랩 | **관상감** | **누각** | 센서 어레이 | **전망 언덕** | **캣닢 온실** | `WebSearch`, `WebFetch`, 외부 MCP |
| `meeting` | **기획·작전실** | 보드룸 | **빈청** | **대청마루** | 택티컬 브리지 | **독 파크 모임터** | **벨벳 라운지** | 계획 수립 · 할 일 화이트보드 기록 |
| `desk` | **리뷰·승인 부스** | 핫라인 부스 | **승정원** | **사랑채** | 홀로그램 통신실 | **간식·칭찬 부스** | **츄르·집사 호출석** | 사용자 질문(`AskUserQuestion`) · 권한/계획 승인 |
| `lounge` | **라운지** | 라운지 | **후원** | **안마당** | 크루 라운지 | **잔디 마당** | **햇살 해먹** | 대기 · 출퇴근 엘리베이터 |

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
| **피그마** | 시점 회전 | `Space`+드래그 또는 휠클릭: 이동 | 상하좌우 패닝 (`Ctrl`/`Cmd`+휠: 줌, `Shift+0/1/2`: 시점·포커스) |
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

## 후원하기 (Support & Sponsorship)

**Office Sim**이 AI 코딩 작업에 즐거움이나 도움이 되었다면 아래 채널을 통해 개발을 후원하실 수 있습니다:

<a href="https://github.com/sponsors/WahyzMaster" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/GitHub_Sponsors-WahyzMaster-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="GitHub Sponsors - WahyzMaster" />
</a>
<a href="https://polar.sh/WahyzMaster" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/Polar.sh-WahyzMaster-0062ff?style=for-the-badge" alt="Polar.sh - WahyzMaster" />
</a>
<a href="https://www.buymeacoffee.com/wahyzdad" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-Support_wahyzdad-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee - wahyzdad" />
</a>

- **GitHub Sponsors** (플랫폼 수수료 0%, 기업 GitHub 빌링 연동): [https://github.com/sponsors/WahyzMaster](https://github.com/sponsors/WahyzMaster)
- **Polar.sh** (기업 세금계산서·인보이스 및 팀 스폰서 티어 지원): [https://polar.sh/WahyzMaster](https://polar.sh/WahyzMaster)
- **Buy Me a Coffee** (간편 일회성 커피 후원): [https://www.buymeacoffee.com/wahyzdad](https://www.buymeacoffee.com/wahyzdad)

## 라이선스

[MIT](LICENSE)
