<div align="center">
<h1>Office Sim</h1>
<p><strong>Real-time 3D multi-agent office visualizer for Claude Code, OpenAI Codex, xAI Grok, and Google Antigravity</strong></p>

[![CI](https://github.com/WahyzMaster/office-sim/actions/workflows/test.yml/badge.svg)](https://github.com/WahyzMaster/office-sim/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/office-sim?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/office-sim)
[![Live 3D Demo](https://img.shields.io/badge/Live_3D_Demo-GitHub_Pages-38bdf8?style=flat-square&logo=three.js&logoColor=white)](https://wahyzmaster.github.io/office-sim/?lang=en#demo)
[![Node >=22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-10b981?style=flat-square)](#quick-start)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub_Sponsors-ea4aaa?style=flat-square&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/WahyzMaster)
[![Polar.sh](https://img.shields.io/badge/Sponsor-Polar.sh-0062ff?style=flat-square)](https://polar.sh/WahyzMaster)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-wahyzdad-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/wahyzdad)

**English** | [한국어 문서 (Korean README)](README.ko.md) | [Live Interactive Demo](https://wahyzmaster.github.io/office-sim/?lang=en#demo) | [HD Demo Video (MP4)](docs/assets/demo-hero.mp4)

<a href="https://wahyzmaster.github.io/office-sim/?lang=en#demo">
  <img src="docs/assets/demo-hero.gif" alt="Office Sim 3D Multi-Agent Visualizer Demo" width="100%" />
</a>

*Click the preview above to launch the [Live Interactive 3D Demo](https://wahyzmaster.github.io/office-sim/?lang=en#demo) in your browser, or view the [720p H.264 Demo Video (`docs/assets/demo-hero.mp4`)](docs/assets/demo-hero.mp4).*

</div>

---

**Office Sim** is a zero-dependency local 3D office visualizer that tails your AI coding agent session logs every 250ms and renders **Claude Code**, **OpenAI Codex**, **Grok (xAI Grok Build)**, and **Google Antigravity** (`agy` CLI & Desktop App) agents collaborating across project floors in real time.

## Quick Start

Requires **Node.js 22+** and has **zero runtime dependencies**.

```bash
# Run directly with npx
npx office-sim --open

# Or clone and start locally
git clone https://github.com/WahyzMaster/office-sim.git
cd office-sim
npm start
```

- **Live Local Sessions**: Open `http://127.0.0.1:4317` in your browser to watch your active local agent sessions.
- **Self-Contained Demo Mode**: Open `http://127.0.0.1:4317/?lang=en#demo` (or try the hosted [GitHub Pages Demo](https://wahyzmaster.github.io/office-sim/?lang=en#demo)) to watch a multi-agent simulation across multiple floors with zero setup.

## Visual Showcase

| Puppy Park (`dogs`) | Luxury Cat Salon (`cats`) |
| :---: | :---: |
| <img src="docs/assets/theme-dogs.png" alt="Puppy Park Theme with 8 3D Dog Breeds" width="100%" /> | <img src="docs/assets/theme-cats.png" alt="Luxury Cat Salon Theme with 6 3D Cat Breeds" width="100%" /> |
| **Bone-shaped lawn, paw fountain, agility hoops & 8 3D dog breeds** (Golden/Labrador Retriever, White/Black/Four-Eyed Jindo, Border Collie, Welsh Corgi, Shiba Inu) | **Cat-ear velvet sunroom, 3-tier cat tower & 6 luxury 3D cat breeds** (Savannah/Ashera, Bengal, British/Russian Blue, Siamese, Ragdoll, Scottish Fold) |
| **Joseon Palace (`palace` - Night Lighting)** | **Multi-Floor Overview (`starship` & `hanok`)** |
| <img src="docs/assets/theme-palace-night.png" alt="Joseon Palace Theme in Night Mode" width="100%" /> | <img src="docs/assets/theme-hanok-starship.png" alt="Multi-Floor Sci-Fi Starship and Traditional Hanok Overview" width="100%" /> |
| **Stepped white stone base (`Jangdaeseok`), Gyeonghoeru lotus pond & warm lantern glow** under Night lighting mode | **Stacked project floors** with octagonal Sci-Fi Starship warp core (`2F`) and L/U-shaped Traditional Hanok courtyard (`1F`) |
| **AI Studio (`studio`)** | **19-Character Catalog & Custom LLM Mapping** |
| <img src="docs/assets/theme-studio.png" alt="AI Studio Theme with Live Agent Speech Bubbles" width="100%" /> | <img src="docs/assets/legend-catalog.png" alt="Scrollable 19-Character Legend and Agent Inspector" width="100%" /> |
| **Modern glass AI studio** with real-time tool speech bubbles, 3D whiteboard checklist, and Review & Approval Intercom Booth | **Scrollable Visual Legend** displaying all 19 rotating 3D character/pet models and per-LLM custom character assignments |

## Features

- **Multi-Agent Support Out of the Box**: Automatically discovers and tails local session logs from Claude Code (`~/.claude/projects`), OpenAI Codex (`~/.codex`), Grok (`~/.grok`), and Google Antigravity (`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}`).
- **7-Axis Independent Customization**:
  - **Place (`7` Architectural Themes)**: Switch the 3D floor structure and room furniture between `AI Studio`, `Tech Office`, `Joseon Palace`, `Traditional Hanok`, `Sci-Fi Starship`, `Puppy Park`, and `Luxury Cat Salon`.
  - **Character (`8` Presets + `Custom` Mode)**: Decouple character costumes/species from the building architecture (`Match Place`, `Modern Crew`, `Office Casual`, `Joseon Court`, `Hanok Scholars`, `Starfleet Crew`, `8 Dog Breeds`, `6 Cat Breeds`, or `Custom`).
  - **Per-LLM Character Mapping (`19` 3D Models)**: Assign any of the 19 3D human costumes, dog breeds, or cat breeds individually to **Claude Code**, **OpenAI Codex**, **Grok**, **Antigravity (CLI)**, **Antigravity (App)**, and **Sub-agents** via the Custom Mapping modal (gear button), with persistent storage in `localStorage`.
  - **Posture (`Auto` / `Sit` / `Stand`)**: Let characters sit at desks automatically or force standing/sitting poses across the floor.
  - **Voice (`Off` / `Auto` / `Animal` / `Human`)**: Synthesized Web Audio sound effects tailored to human speech chimes, dog barks, or cat meows.
  - **Lighting (`Day` / `Night` / `Auto`)**: Switch between bright daylight, warm night-time architectural lighting, or local-clock automatic cycling.
  - **Controls (`4` Camera Presets) & Bilingual UI (`KO / EN`)**: Instant toggle between Korean and English UI labels.
- **3D Obstacle & Furniture Collision Avoidance**:
  - Every room desk, server rack, conference table, cat tower, and courtyard pond registers a 2D AABB collider per floor.
  - Agents smoothly steer around furniture obstacles and doorway thresholds while walking between rooms and settling into non-overlapping seats.
- **Scrollable Visual Legend & Interactive 3D Catalog**:
  - Inspect all **19 rotating 3D models** (5 human themes + 8 dog breeds + 6 cat breeds) alongside the **6 live LLM assignment cards**, room color swatches, and speech bubble signal meanings.
- **Project Floors & Review Intercom Booth**:
  - Each repository/workspace gets its own floor (`1F`, `2F`, ...); git worktrees of the same repo share a floor, and workspace-less sessions gather on the `Global · Unassigned` (`전역 · 미지정`) floor.
  - The `desk` room features a **3D Review & Approval Intercom Booth** where agents walk to ask questions or await permission approval.
- **Privacy by Default**: Loopback-only (`127.0.0.1`), strict `Host`/`Origin`/`Sec-Fetch-Site` guards, optional `--auth` cookie token, and strict scrubbing (only tool categories, file basenames, and URL hostnames are sent to the browser — never file contents, raw commands, or credentials).
- **Streamer / OBS Overlay Mode & 1-Click 5s Clip Capture**:
  - Open `?overlay=1` (or `#overlay`, or press `O`) to hide HUD panels and switch the 3D WebGL canvas to a transparent background (or chroma-key via `?chroma=green` / `?chroma=blue` / `?chroma=ff00ff`) for OBS Browser Sources and Picture-in-Picture streams.
  - Click **5s Clip** (`#capture-clip`) in the top bar to record a 5-second WebM clip (`Shift+Click` for an instant PNG snapshot).

## Room Themes & Tool Mapping

| Room Key | AI Studio (`studio`) | Tech Office (`office`) | Joseon Palace (`palace`) | Traditional Hanok (`hanok`) | Sci-Fi Starship (`starship`) | Puppy Park (`dogs`) | Luxury Cat Salon (`cats`) | Agent Activity & Tools |
|---|---|---|---|---|---|---|---|---|
| `archive` | **Codebase Lab** (`코드 탐색실`) | Library (`라이브러리`) | **Gyujanggak Archives** (`규장각`) | **Jangpangak Library** (`장판각`) | Data Vault (`데이터 볼트`) | **Scent Trail Woods** (`노즈워크 숲`) | **Window Perch** (`창가 캣타워`) | `Read`, `Grep`, `Glob`, `codegraph` |
| `dev` | **Coding Studio** (`코딩 스튜디오`) | Dev Zone (`개발존`) | **Jiphyeonjeon Hall** (`집현전`) | **Geulbang Study** (`글방`) | Forge Bay (`포지 베이`) | **Agility Arena** (`어질리티 훈련장`) | **Scratcher Studio** (`스크래처 공방`) | `Edit`, `Write`, `NotebookEdit`, `apply_patch` |
| `server` | **Terminal & Ops** (`터미널·빌드실`) | Server Room (`서버룸`) | **Gungisi Arsenal** (`군기시`) | **Daejanggan Forge** (`대장간`) | Engine Core (`엔진 코어`) | **Zoomies Track** (`우다다 트랙`) | **Laser Chase Dome** (`레이저 사냥터`) | `Bash`, `git`, `gh`, test & build runs |
| `research` | **Web & MCP Hub** (`웹·MCP 허브`) | Research Lab (`리서치랩`) | **Gwansanggam Observatory** (`관상감`) | **Nugak Pavilion** (`누각`) | Sensor Array (`센서 어레이`) | **Lookout Mound** (`전망 언덕`) | **Catnip Conservatory** (`캣닢 온실`) | `WebSearch`, `WebFetch`, external MCP tools |
| `meeting` | **Strategy Room** (`기획·작전실`) | Boardroom (`보드룸`) | **Bincheong Council** (`빈청`) | **Daecheong Main Hall** (`대청마루`) | Tactical Bridge (`택티컬 브리지`) | **Bark Council** (`독 파크 모임터`) | **Velvet Cushion Hall** (`벨벳 라운지`) | Task planning & live 3D whiteboard |
| `desk` | **Review Booth** (`리뷰·승인 부스`) | Hotline Booth (`핫라인 부스`) | **Seungjeongwon Secretariat** (`승정원`) | **Sarangchae Reception** (`사랑채`) | Holo-Comms Pod (`홀로그램 통신실`) | **Treat & Belly-Rub Booth** (`간식·칭찬 부스`) | **Churu Butler Bell** (`츄르·집사 호출석`) | `AskUserQuestion`, plan & tool approvals |
| `lounge` | **Lounge** (`라운지`) | Lounge (`라운지`) | **Huwon Garden** (`후원`) | **Anmadang Courtyard** (`안마당`) | Crew Lounge (`크루 라운지`) | **Sunny Lawn** (`잔디 마당`) | **Sunbeam Hammock** (`햇살 해먹`) | Idle standby & arrival/departure elevator |

## Supported Agents

| Agent | Agent ID | Status & Notes |
|---|---|---|
| Claude Code | `claude-code` | Supported (`~/.claude/projects/**/*.jsonl`, including subagents and `--replay`) |
| Grok (xAI Grok Build) | `grok` | Supported (P5c). Live permission approval wait supported (P5g, 라이브 승인 대기 표시: reads only 4 fields from `events.jsonl`) |
| OpenAI Codex (App, CLI, IDE) | `codex` | Supported (P5d, `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` & `session_index.jsonl`) |
| Antigravity CLI (`agy`) & Legacy IDE | `antigravity` (`surface: 'cli'`) | Supported (P5e, `~/.gemini/{antigravity-cli,antigravity-ide}/brain/<id>/.system_generated/logs/`) |
| Antigravity Desktop App (2.x) | `antigravity` (`surface: 'app'`) | Supported (`~/.gemini/antigravity/brain/<id>/.system_generated/logs/`, plus `task.md` / `implementation_plan.md` checklists; never opens encrypted `conversations/*.pb`) |

## Camera Control Presets

| Preset | Left-Drag | Right / Modifier Drag | Wheel / Trackpad Scroll |
|---|---|---|---|
| **Google Maps** (Default) | Pan across floor | Right-drag or `Ctrl`+Left-drag: Orbit & tilt | Zoom in / out (`Shift`+Arrows: Orbit & tilt) |
| **Figma** | Orbit camera | `Space`+drag or Middle-drag: Pan | 2D pan (`Ctrl`/`Cmd`+Wheel: Zoom, `Shift+0/1/2`: Reset/Focus) |
| **3D Orbit** | Orbit camera | Right-drag or `Shift`/`Space`+drag: Pan | Zoom in / out (`Q`/`E`: Rotate) |
| **Blender** | Pan across floor | Middle-drag or `Alt`+Left-drag: Orbit | Zoom in / out (`.`/`F`: Focus selected, `Home`/`R`: Reset) |

Common shortcuts: `WASD` / Arrow keys (pan), `Q` / `E` (rotate), `+` / `-` (zoom), `1`-`9` (select floor), `0` (overview all floors), `F` or double-click character (follow agent), `R` or `Home` (reset camera), `Esc` (deselect).

## CLI Options

```bash
node bin/office-sim.mjs [options]
```

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `4317` | HTTP port (`0` for a random free port) |
| `--host <addr>` | `127.0.0.1` | Loopback address (`127.0.0.1`, `localhost`, `::1` only) |
| `--interval <ms>` | `250` | Tail poll interval in ms (`50`..`5000`) |
| `--active <min>` | `30` | Only attach sessions modified within the last N minutes |
| `--rescan <ms>` | `3000` | Directory rescan interval for new sessions in ms |
| `--agents <list>` | all available | Comma-separated agent IDs (`claude-code,codex,grok,antigravity`) |
| `--claude-root <dir>` | `~/.claude/projects` | Claude Code sessions directory (`--root` alias supported) |
| `--codex-root <dir>` | `~/.codex` | OpenAI Codex home directory |
| `--grok-root <dir>` | `~/.grok` | xAI Grok Build home directory |
| `--antigravity-root <dir>` | `~/.gemini` | Google Antigravity home directory |
| `--replay <file.jsonl>` | off | Replay a recorded Claude Code session file with original timing |
| `--speed <n>` | `1` | Replay speed multiplier (`0.1`..`1000`) |
| `--loop` | off | Loop replay continuously |
| `--auth` | off | Require a per-run token (`http://127.0.0.1:<port>/?t=<token>`) and set an `HttpOnly` cookie |
| `--open` | off | Open the URL in your default browser on startup |

## `/office` Skill Integration

Install the bundled `/office` skill (`skills/office/SKILL.md`) to start, check, or stop `office-sim` directly from Claude Code or compatible agent skill directories:

```bash
npm run skill:install                  # Symlinks ~/.claude/skills/office -> <repo>/skills/office
npm run skill:install -- --skills-dir ~/.agents/skills
npm run skill:uninstall                # Removes symlink if it points to this repo
```

Once installed, invoke `/office`, `/office demo`, `/office auth`, `/office status`, or `/office stop`.

## Privacy & Security Architecture

- **Loopback-Only & Cross-Site Guards**: Rejects non-loopback `Host` headers, foreign `Origin` headers, and `Sec-Fetch-Site: cross-site` requests.
- **Strict Scrubbing**: Only tool names, file basenames (never directory paths), URL hostnames (never query strings or paths), and short status summaries reach the browser. Credentials (`oauth_creds.json`, `.env`, SQLite DBs, raw prompt history files, encrypted `.pb` files) are never opened.
- **Architecture & Specifications**:
  - [`docs/CONTRACT.md`](docs/CONTRACT.md) — Event schema, adapter rules, privacy scrubbing contract, and `/healthz` specification.
  - [`docs/ADAPTERS.md`](docs/ADAPTERS.md) — Multi-agent adapter design and mapping tables.
  - [`docs/HISTORY.md`](docs/HISTORY.md) — Implementation history and engineering notes.
  - [Contributing Guide](CONTRIBUTING.md) — How to run tests (`npm test`) and contribute adapters or themes.

## Support & Sponsorship

If you find **Office Sim** useful or enjoyable in your daily AI coding workflow, you can support its continued development through any of the channels below:

<a href="https://github.com/sponsors/WahyzMaster" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/GitHub_Sponsors-WahyzMaster-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="GitHub Sponsors - WahyzMaster" />
</a>
<a href="https://polar.sh/WahyzMaster" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/Polar.sh-WahyzMaster-0062ff?style=for-the-badge" alt="Polar.sh - WahyzMaster" />
</a>
<a href="https://www.buymeacoffee.com/wahyzdad" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-Support_wahyzdad-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee - wahyzdad" />
</a>

- **GitHub Sponsors** (zero platform fees, corporate GitHub billing): [https://github.com/sponsors/WahyzMaster](https://github.com/sponsors/WahyzMaster)
- **Polar.sh** (VAT/tax invoices & team sponsor tiers): [https://polar.sh/WahyzMaster](https://polar.sh/WahyzMaster)
- **Buy Me a Coffee** (quick one-time coffee): [https://www.buymeacoffee.com/wahyzdad](https://www.buymeacoffee.com/wahyzdad)

## License

[MIT](LICENSE)
