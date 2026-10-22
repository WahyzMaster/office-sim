# Office Sim

A zero-dependency local 3D office visualizer that tails your AI coding agent session logs every 250ms and renders **Claude Code**, **OpenAI Codex**, **Grok (xAI Grok Build)**, and **Google Antigravity** (`agy` CLI & Desktop App) agents collaborating across project floors in real time.

**English** | [한국어 문서 (Korean README)](README.ko.md)

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

Open `http://127.0.0.1:4317` in your browser to watch your live local sessions, or open `http://127.0.0.1:4317/#demo` to watch a self-contained multi-agent demo without any active sessions.

## Features

- **Multi-Agent Support Out of the Box**: Automatically discovers and tails local session logs from Claude Code (`~/.claude/projects`), OpenAI Codex (`~/.codex`), Grok (`~/.grok`), and Google Antigravity (`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}`).
- **Project Floors & Brand-Distinct 3D Characters**:
  - Each repository/workspace gets its own floor (`1F`, `2F`, ...); git worktrees of the same repo share a floor, and workspace-less sessions gather on the `Global · Unassigned` (`전역 · 미지정`) floor.
  - Agents wear distinct brand colors and 3D accessories: **Claude Code** (terracotta beret & starburst), **Codex** (emerald visor & hex crystal), **Grok** (violet sunglasses & orbital ring), and **Antigravity** (cyan/cobalt anti-gravity ring & prism, with CLI cap or App headset). Subagents appear as smaller characters with propeller hats.
- **5 Switchable 3D Architectural Themes, Costumes & Bilingual UI (`KO / EN`)**:
  - Switch themes anytime from the top bar (`AI Studio`, `Tech Office`, `Joseon Palace`, `Traditional Hanok`, `Sci-Fi Starship`) and toggle between **Korean (`KO`)** and **English (`EN`)**.
  - Each theme remodels the **3D floor structure** (e.g., stepped white stone base + central lotus pond for `Joseon Palace`, L/U-shaped timber courtyard + elevated pavilion for `Traditional Hanok`, octagonal hull + central warp core for `Sci-Fi Starship`), **room furniture**, and **character costumes & headgear** (Joseon royal court robes & crowns, Hanok scholar vests & bamboo hats, Starship pressure suits & jetpacks).
  - Instead of cloning a human avatar on every floor, the `desk` room features a **3D Review & Approval Intercom Booth** where agents walk to ask questions or await permission approval.
  - The **Visual Legend** panel renders interactive **3D character models** (with hover animations and tooltips), room color swatches, and status/bubble color signal guides.
- **4 Camera Control Presets**: Choose between **Google Maps**, **Figma**, **3D Orbit (Three.js)**, and **Blender** mouse/trackpad/keyboard controls in the top bar (persisted in `localStorage`).
- **Privacy by Default**: Loopback-only (`127.0.0.1`), strict `Host`/`Origin`/`Sec-Fetch-Site` guards, optional `--auth` cookie token, and strict scrubbing (only tool categories, file basenames, and URL hostnames are sent to the browser — never file contents, raw commands, or credentials).

## Room Themes & Tool Mapping

| Room Key | AI Studio (`studio`, Default) | Tech Office (`office`) | Joseon Palace (`palace`) | Traditional Hanok (`hanok`) | Sci-Fi Starship (`starship`) | Agent Activity & Tools |
|---|---|---|---|---|---|---|
| `archive` | **Codebase Lab** (`코드 탐색실`) | Library (`라이브러리`) | **Gyujanggak Archives** (`규장각`) | **Jangpangak Library** (`장판각`) | Data Vault (`데이터 볼트`) | `Read`, `Grep`, `Glob`, `codegraph` |
| `dev` | **Coding Studio** (`코딩 스튜디오`) | Dev Zone (`개발존`) | **Jiphyeonjeon Hall** (`집현전`) | **Geulbang Study** (`글방`) | Forge Bay (`포지 베이`) | `Edit`, `Write`, `NotebookEdit`, `apply_patch` |
| `server` | **Terminal & Ops** (`터미널·빌드실`) | Server Room (`서버룸`) | **Gungisi Arsenal** (`군기시`) | **Daejanggan Forge** (`대장간`) | Engine Core (`엔진 코어`) | `Bash`, `git`, `gh`, test & build runs |
| `research` | **Web & MCP Hub** (`웹·MCP 허브`) | Research Lab (`리서치랩`) | **Gwansanggam Observatory** (`관상감`) | **Nugak Pavilion** (`누각`) | Sensor Array (`센서 어레이`) | `WebSearch`, `WebFetch`, external MCP tools |
| `meeting` | **Strategy Room** (`기획·작전실`) | Boardroom (`보드룸`) | **Bincheong Council** (`빈청`) | **Daecheong Main Hall** (`대청마루`) | Tactical Bridge (`택티컬 브리지`) | Task planning & live 3D whiteboard |
| `desk` | **Review Booth** (`리뷰·승인 부스`) | Hotline Booth (`핫라인 부스`) | **Seungjeongwon Secretariat** (`승정원`) | **Sarangchae Reception** (`사랑채`) | Holo-Comms Pod (`홀로그램 통신실`) | `AskUserQuestion`, plan & tool approvals |
| `lounge` | **Lounge** (`라운지`) | Lounge (`라운지`) | **Huwon Garden** (`후원`) | **Anmadang Courtyard** (`안마당`) | Crew Lounge (`크루 라운지`) | Idle standby & arrival/departure elevator |

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

## License

[MIT](LICENSE)
