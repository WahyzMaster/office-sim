// P2: Click 3D character -> Focus native terminal tab (iTerm2, Terminal.app, Kitty, Ghostty, WezTerm, IDE).
// Zero shell interpolation: uses execFile with positional arguments and strict TTY format validation.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { publicSessionId } from './session-identity.mjs';

const VALID_TTY_RE = /^\/dev\/ttys?\d{1,5}$/;
const SHORT_TTY_RE = /^ttys?\d{1,5}$/;

export function normalizeTtyDevice(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (VALID_TTY_RE.test(trimmed)) return trimmed;
  if (SHORT_TTY_RE.test(trimmed)) return `/dev/${trimmed}`;
  return null;
}

const JXA_ITERM2_TTY_SCRIPT = `
function run(argv) {
  var ttyTarget = argv[0];
  var app = Application('iTerm2');
  if (!app.running()) return 'not-running';
  var windows = app.windows();
  for (var wi = 0; wi < windows.length; wi++) {
    var win = windows[wi];
    var tabs = win.tabs();
    for (var ti = 0; ti < tabs.length; ti++) {
      var tab = tabs[ti];
      var sessions = tab.sessions();
      for (var si = 0; si < sessions.length; si++) {
        if (sessions[si].tty() === ttyTarget) {
          tab.select();
          app.activate();
          win.index = 1;
          return 'matched:iTerm2';
        }
      }
    }
  }
  return 'none';
}
`.trim();

const JXA_TERMINAL_TTY_SCRIPT = `
function run(argv) {
  var ttyTarget = argv[0];
  var app = Application('Terminal');
  if (!app.running()) return 'not-running';
  var windows = app.windows();
  for (var wi = 0; wi < windows.length; wi++) {
    var win = windows[wi];
    var tabs = win.tabs();
    for (var ti = 0; ti < tabs.length; ti++) {
      var tab = tabs[ti];
      if (tab.tty() === ttyTarget) {
        win.selectedTab = tab;
        app.activate();
        win.index = 1;
        return 'matched:Terminal';
      }
    }
  }
  return 'none';
}
`.trim();

const APPLESCRIPT_WINDOW_PROJECT = `
on run argv
  set targetProject to item 1 of argv
  set candidateApps to {"Cursor", "Antigravity", "Visual Studio Code", "Code", "Ghostty", "WezTerm", "Warp", "iTerm2", "Terminal"}
  tell application "System Events"
    if targetProject is not "" then
      repeat with appName in candidateApps
        set appStr to contents of appName
        if exists (processes whose name is appStr) then
          tell process appStr
            repeat with w in windows
              try
                if (name of w) contains targetProject then
                  perform action "AXRaise" of w
                  set frontmost to true
                  return "matched:" & appStr
                end if
              end try
            end repeat
          end tell
        end if
      end repeat
    end if
  end tell
  return "none"
end run
`.trim();

function execPromise(execFileFn, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFileFn(cmd, args, { timeout: 2500, windowsHide: true, ...opts }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, stdout: '' });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

/**
 * Resolve TTY device (/dev/ttysNNN) for a session from its transcript file or sessionId via lsof / ps.
 */
export async function resolveSessionTty({ sessionId, filePath, execFileFn = execFile } = {}) {
  if (typeof filePath === 'string' && filePath.startsWith('/')) {
    const lsofRes = await execPromise(execFileFn, 'lsof', ['-t', '--', filePath]);
    if (lsofRes.ok && lsofRes.stdout) {
      const pid = lsofRes.stdout.split(/\s+/).find((tok) => /^\d+$/.test(tok));
      if (pid) {
        const psRes = await execPromise(execFileFn, 'ps', ['-o', 'tty=', '-p', pid]);
        const tty = normalizeTtyDevice(psRes.stdout);
        if (tty) return { pid: Number(pid), tty };
      }
    }
  }

  const safeSid = publicSessionId(sessionId);
  if (safeSid) {
    const psAll = await execPromise(execFileFn, 'ps', ['-eo', 'pid,tty,command']);
    if (psAll.ok && psAll.stdout) {
      for (const line of psAll.stdout.split('\n')) {
        if (!line.includes(safeSid)) continue;
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const tty = normalizeTtyDevice(m[2]);
        if (tty) return { pid: Number(m[1]), tty };
      }
    }
  }
  return null;
}

/**
 * Focus the native terminal tab or IDE window owning a session.
 */
export async function focusTerminalForSession(sessionId, {
  store = null,
  platform = process.platform,
  execFileFn = execFile,
  ttyHint = null,
} = {}) {
  const safeSid = publicSessionId(sessionId);
  if (!safeSid) return { ok: false, error: 'invalid_session_id' };

  const entry = store?.byChar?.get?.(safeSid) ?? null;
  const filePath = entry?.path ?? null;
  const projectLabel = entry?.lastSession?.projectLabel
    || (entry?.lastSession?.project ? path.basename(entry.lastSession.project) : '')
    || '';
  const safeProject = projectLabel.replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 64).trim();

  if (platform !== 'darwin') {
    return { ok: false, error: 'unsupported_platform', sessionId: safeSid };
  }

  const resolved = normalizeTtyDevice(ttyHint)
    ? { tty: normalizeTtyDevice(ttyHint), pid: null }
    : await resolveSessionTty({ sessionId: safeSid, filePath, execFileFn });

  if (resolved?.tty) {
    for (const script of [JXA_ITERM2_TTY_SCRIPT, JXA_TERMINAL_TTY_SCRIPT]) {
      const res = await execPromise(execFileFn, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, '--', resolved.tty]);
      if (res.ok && res.stdout.startsWith('matched:')) {
        return { ok: true, method: 'tty', target: res.stdout.slice(8), tty: resolved.tty, sessionId: safeSid };
      }
    }
  }

  if (safeProject) {
    const winRes = await execPromise(execFileFn, '/usr/bin/osascript', ['-e', APPLESCRIPT_WINDOW_PROJECT, '--', safeProject]);
    if (winRes.ok && winRes.stdout.startsWith('matched:')) {
      return { ok: true, method: 'window-title', target: winRes.stdout.slice(8), projectLabel: safeProject, sessionId: safeSid };
    }
  }

  return { ok: false, error: 'terminal_not_found', sessionId: safeSid, tty: resolved?.tty ?? null };
}
