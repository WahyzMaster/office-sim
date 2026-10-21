---
name: office
description: Starts or reuses the local Office Sim server (office-sim) and opens its 3D office page, where the Claude Code, Codex, Grok and Antigravity sessions on this machine work as office staff. Use when the user types /office (or /office start, stop, status, demo, auth), asks to open or show the office, or wants to see what the agents are doing; also to check or stop the office server.
argument-hint: "[start|stop|status|demo|auth]"
---

# /office

Office Sim is a local Node 24 server with no dependencies. It tails coding-agent session logs and serves a three.js office at `http://127.0.0.1:4317/`. This skill starts or reuses it, opens the page, reports its status, or stops it. Run each command with the Bash tool. Reply in the user's language (Korean when they write Korean).

Rules:
- Never read, print or open session log content (`~/.claude/projects`, `~/.codex`, `~/.grok`, `~/.gemini`). Read only `/healthz` answers and the server's own `office-sim:` lines.
- Open only the URL the server printed (`http://127.0.0.1:<port>/`, with `?t=<token>` under `--auth`), plus `#demo` for demo. Never put a file path in a URL. Never pass `--host`.

## 1. Repo root

The installed skill is a symlink into the office-sim repo. With `<base>` = this skill's base directory (given above as "Base directory for this skill"; normally `~/.claude/skills/office`), run:

```bash
node -p 'const p=require("path"),f=require("fs");const r=p.resolve(f.realpathSync(process.argv[1]),"..","..");f.existsSync(p.join(r,"bin","office-sim.mjs"))?r:"MISSING"' "<base>"
```

If it prints `MISSING` or fails, stop and tell the user to run `npm run skill:install` in an office-sim checkout. Otherwise call the printed path `<root>`.

## 2. Action

Take the first argument, lowercased: none or `start` -> start; `stop`; `status`; `demo` (start, then open `<url>#demo`); `auth` (start with `--auth`). Without an argument, infer it from the user's words (default start). Anything else: list these five and stop.

## 3. Probe (status and start use it)

```bash
node -e 'const t=setTimeout(()=>{console.log("down Timeout");process.exit(0)},1500);fetch("http://127.0.0.1:4317/healthz",{signal:AbortSignal.timeout(1000)}).then(async r=>console.log(r.status,(await r.text()).slice(0,2000))).catch(e=>console.log("down",e.cause?.code||e.name)).finally(()=>clearTimeout(t))'
```

- `200` with JSON that has `"ok":true` and an `agents` array: office-sim, open mode.
- `401 unauthorized: open the URL printed by office-sim`: office-sim started with `--auth`.
- `down ECONNREFUSED`: nothing on port 4317.
- Anything else (`down Timeout`, `down ECONNRESET`, another status or body), or no output at all: port 4317 is held by another program.

## status

Probe and report one of: running (URL `http://127.0.0.1:4317/`, `agents`, `sessions`, `clients`, and the build as `version` and `commit`, where `null` means unknown), running with `--auth` (stats need the browser cookie), not running, or port 4317 used by another program. Start nothing.

When running, also check the counters `badLines`, `skippedLines`, `applyErrors`, `loopErrors`, `linkErrors`, `rejectedRefs` and each `runners.<agent>.scanErr`. Only if one is non-zero or set, add one line "기록을 읽다 문제가 생겼어요" (in the user's language) with the non-zero counters and `scanErr` of each agent from `runners` (`rejectedRefs` has no agent). All zero and null: say nothing about them.

## start, demo, auth

1. Probe.
   - office-sim, open mode, action is not `auth`: reuse it. `<url>` = `http://127.0.0.1:4317/`, agents = the `agents` array. Check who started it: run the stop command (below) with ` 4317` added after its last argument; it then kills nothing and prints `ours pid <n>` (started from this repo, so `/office stop` stops it) or `not ours`. On Windows run only the first two PowerShell lines: a non-empty `$m` means ours. Go to step 4.
   - office-sim, open mode, action is `auth`: say an open server is already running; offer `/office stop` then `/office auth`. Stop.
   - office-sim with `--auth`: reuse it only if you started it earlier in this conversation and still have its printed URL (go to step 4). Otherwise say its token URL is in the output of whoever started it and offer `/office stop` then `/office auth`. Stop.
   - nothing there: `<port>` = 4317. Port held by another program: `<port>` = 0 (any free port).
2. Make a private output file (mode 600) and call the printed path `<out>`:
   ```bash
   mktemp "${TMPDIR:-/tmp}/office-sim.XXXXXX"
   ```
   Then start the server as a background process (Bash with `run_in_background: true`). `<flags>` is `--auth` for `auth`, else empty. Do not pass `--open`: step 4 opens the page so you see whether that worked.
   ```bash
   node "<root>/bin/office-sim.mjs" --port <port> <flags> > "<out>" 2>&1
   ```
3. Wait for it in one foreground command (at most 10 s, less when the server prints its agents line or an error; do not wait across turns):
   ```bash
   node --input-type=module -e '
   import fs from "node:fs";
   const lines = () => { try { const t = fs.readFileSync(process.argv[1], "utf8"); return t.slice(0, t.lastIndexOf("\n") + 1).split("\n").filter((l) => l.startsWith("office-sim: ")); } catch { return []; } };
   for (let i = 0; i < 40 && !lines().some((l) => !l.startsWith("office-sim: http://")); i++) await new Promise((r) => setTimeout(r, 250));
   const out = lines(); console.log(out.join("\n") || "office-sim: no output after 10 s");
   const url = out.map((l) => l.slice(12)).find((u) => u.startsWith("http://"));
   const keep = setTimeout(() => {}, 1500);
   if (url) console.log("healthz", await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(1000) }).then((r) => r.status, (e) => "down " + (e.cause?.code || e.name)));
   clearTimeout(keep);
   ' "<out>"
   ```
   `<url>` is the `office-sim: http://...` line (it carries `?t=<token>` under `--auth`); the agents are the `office-sim: agents ...` line. `healthz 200` (or `401` with `--auth`) means ready. If an `office-sim:` line contains `EADDRINUSE` (another start took 4317 first), probe once more and act as in step 1 on the result (reuse, or start again with `<port>` = 0). Otherwise, if there is no URL line or healthz is down, show the printed `office-sim:` lines and stop.
4. Open `<page>` = `<url>`, or `<url>#demo` for demo:
   - If `mcp__Claude_Browser__preview_start` is available, call it with `{"url": "<page>"}`; that counts as opened.
   - Linux with `auth`: do not run an opener (a browser it starts keeps the token URL in its process arguments, readable by other local users); give the URL to paste instead.
   - Otherwise run the OS opener (macOS `open "<page>"`, Linux `xdg-open "<page>"`, Windows `cmd /c start "" "<page>"`) with this command, which waits at most 3 s and prints one line:
     ```bash
     node -e '
     const [cmd, ...args] = { darwin: ["open"], win32: ["cmd", "/c", "start", "\"\""] }[process.platform] || ["xdg-open"];
     const done = (s) => { console.log(s); process.exit(0); };
     setTimeout(() => done("opener still running"), 3000);
     const c = require("child_process").spawn(cmd, [...args, process.argv[1]], { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
     c.on("error", (e) => done("open failed " + cmd + " " + e.code));
     c.on("exit", (code) => done(code === 0 ? "opened" : "open failed " + cmd + " exit " + code));
     ' "<page>"
     ```
     `opened` and `opener still running` (it started a browser and waits for it) mean opened; `open failed ...` means it did not. On Windows `start` reports success even when nothing opens, so say you asked Windows to open it.
5. Tell the user:
   - The URL, and whether it opened. If it did not open, say no browser could be opened and give the URL to open by hand (for Linux `auth`, say you did not open it on purpose).
   - The enabled agents (`none` means no session log folder was found).
   - How to stop it. If you started it in this conversation, or the step 1 check printed `ours pid`: it keeps running in the background while this Claude Code session is open, and `/office stop` stops it. Otherwise (`not ours`): it was already running, started outside `/office` (for example `npm start` in a terminal, or another checkout); stop it there with Ctrl-C, as `/office stop` leaves it running.
   - With `--auth`: the URL holds a per-run token; open it once and the browser keeps a cookie. With `<port>` 0: `/office status` only probes 4317 (`/office stop` still finds it).

## stop

Stop only office-sim servers started from this repo: processes whose command is `node <root>/bin/office-sim.mjs ...`. Never kill anything else.

macOS and Linux:
```bash
node -e '
const [bin, port] = process.argv.slice(1);
const rows = require("child_process").execFileSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 64e6 }).split("\n");
const ms = rows.map((l) => l.trim().match(/^(\d+)\s+((?:\S*\/)?node)\s+(.*)$/)).filter((m) => m && (m[3] === bin || m[3].startsWith(bin + " ")) && Number(m[1]) !== process.pid);
if (port) { const o = ms.filter((m) => (m[3].match(/ --port[= ](\d+)/)?.[1] ?? "4317") === port); console.log(o.length ? "ours pid " + o.map((m) => m[1]).join(", ") : "not ours"); process.exit(0); }
const done = [], failed = [];
for (const m of ms) { try { process.kill(Number(m[1]), "SIGTERM"); done.push(m[1]); } catch (e) { failed.push(m[1] + " (" + e.code + ")"); } }
if (done.length) console.log("stopped pid " + done.join(", "));
if (failed.length) console.log("could not stop pid " + failed.join(", "));
if (!ms.length) console.log("no office-sim from this repo is running");
' "<root>/bin/office-sim.mjs"
```

Windows (PowerShell), with `<root>` in Windows form (double any `'` in it):
```powershell
$b = [regex]::Escape('<root>') + '[\\/]bin[\\/]office-sim\.mjs'
$m = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match ('^(?:"[^"]*[\\/]|[^"\s]*[\\/])?node(?:\.exe)?"?\s+"?' + $b + '"?(?:\s|$)') })
foreach ($p in $m.ProcessId) { try { Stop-Process -Id $p -ErrorAction Stop; "stopped pid $p" } catch { "could not stop pid $p" } }
if (-not $m) { "no office-sim from this repo is running" }
```

The server exits within 3 s of SIGTERM. Probe again (once more if it still answers) and report what was stopped, and any `could not stop pid` line (another user's process, or one that already exited). If port 4317 still answers as office-sim, say it was started another way (for example `npm start` in a terminal) and leave it running.
