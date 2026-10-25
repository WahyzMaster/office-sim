// Native OS system notifications (macOS osascript + Windows PowerShell WinRT Toast / NotifyIcon fallback)
// and event classification with anti-noise guards for office-sim. Zero runtime dependencies.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { publicSessionId } from './session-identity.mjs';

export const NOTIFY_CATEGORIES = Object.freeze(['ask', 'error', 'done', 'tool_error']);
export const DEFAULT_NOTIFY_CATEGORIES = Object.freeze(['ask', 'error', 'done']);

export const ASK_TOOLS = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ask_user_question',
  'exit_plan_mode',
  'request_user_input',
  'ask_question',
]);

export const DONE_REASONS = new Set(['end_turn', 'wrap_up', 'stop_hook']);

export const DEFAULT_COOLDOWN_MS = 4000;
export const API_ERROR_COALESCE_MS = 15_000;

export const APPLESCRIPT_NOTIFY = `
on run argv
  set bodyText to item 1 of argv
  set titleText to item 2 of argv
  set subText to item 3 of argv
  set soundName to item 4 of argv
  if soundName is not "" then
    display notification bodyText with title titleText subtitle subText sound name soundName
  else
    display notification bodyText with title titleText subtitle subText
  end if
  return "ok:osascript"
end run
`.trim();

export const WIN_TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$title = [string]$env:OFFICE_SIM_NOTIFY_TITLE
$sub = [string]$env:OFFICE_SIM_NOTIFY_SUB
$body = [string]$env:OFFICE_SIM_NOTIFY_BODY
$fullSub = if ($sub) { "$sub - $body" } else { $body }
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1"></text><text id="2"></text></binding></visual></toast>')
  $texts = $xml.GetElementsByTagName('text')
  [void]$texts.Item(0).AppendChild($xml.CreateTextNode($title))
  [void]$texts.Item(1).AppendChild($xml.CreateTextNode($fullSub))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show($toast)
  Write-Output 'ok:winrt'
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Visible = $true
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $fullSub
  $n.ShowBalloonTip(4000)
  Start-Sleep -Milliseconds 250
  $n.Dispose()
  Write-Output 'ok:balloon'
}
`.trim();

export function sanitizeNotifyText(raw, maxLen = 140) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function parseNotifyArg(raw) {
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false, categories: [...DEFAULT_NOTIFY_CATEGORIES] };
  }
  if (raw === true) {
    return { enabled: true, categories: [...DEFAULT_NOTIFY_CATEGORIES] };
  }
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      const c = String(item ?? '').trim().toLowerCase();
      if (!NOTIFY_CATEGORIES.includes(c)) {
        throw new RangeError(`unknown notify category: "${c}" (expected ${NOTIFY_CATEGORIES.join(', ')})`);
      }
      if (!out.includes(c)) out.push(c);
    }
    return { enabled: out.length > 0, categories: out.length ? out : [...DEFAULT_NOTIFY_CATEGORIES] };
  }
  if (typeof raw !== 'string') {
    throw new RangeError('notify option must be a boolean or comma-separated category list');
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'true' || trimmed === '1' || trimmed === 'on' || trimmed === 'default') {
    return { enabled: true, categories: [...DEFAULT_NOTIFY_CATEGORIES] };
  }
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'off' || trimmed === 'none') {
    return { enabled: false, categories: [...DEFAULT_NOTIFY_CATEGORIES] };
  }
  if (trimmed === 'all') {
    return { enabled: true, categories: [...NOTIFY_CATEGORIES] };
  }
  const parts = trimmed.split(',').map((s) => s.trim());
  if (parts.some((p) => p === '')) {
    throw new RangeError(`--notify needs category names (${NOTIFY_CATEGORIES.join(', ')})`);
  }
  const categories = [];
  for (const p of parts) {
    if (!NOTIFY_CATEGORIES.includes(p)) {
      throw new RangeError(`unknown notify category: "${p}" (expected ${NOTIFY_CATEGORIES.join(', ')})`);
    }
    if (!categories.includes(p)) categories.push(p);
  }
  return { enabled: true, categories };
}

export function isBlockingAskToolStart(ev) {
  if (!ev || ev.type !== 'tool_start') return false;
  if (ev.tool === 'request_user_input_async') return false;
  return Boolean(ev.room === 'desk' || ev.question || (typeof ev.tool === 'string' && ASK_TOOLS.has(ev.tool)));
}

export function dispatchNativeNotification(payload, {
  platform = process.platform,
  execFileFn = execFile,
} = {}) {
  const title = sanitizeNotifyText(payload?.title || 'Office Sim', 64) || 'Office Sim';
  const subtitle = sanitizeNotifyText(payload?.subtitle || '', 64);
  const body = sanitizeNotifyText(payload?.body || '', 140) || title;
  const sound = sanitizeNotifyText(payload?.sound || '', 32);

  return new Promise((resolve) => {
    if (platform === 'darwin') {
      execFileFn(
        '/usr/bin/osascript',
        ['-e', APPLESCRIPT_NOTIFY, '--', body, title, subtitle, sound],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false, platform, error: err.code || err.message || 'osascript_failed' });
            return;
          }
          resolve({ ok: true, platform, method: String(stdout || 'ok:osascript').trim() });
        },
      );
      return;
    }

    if (platform === 'win32') {
      execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', WIN_TOAST_SCRIPT],
        {
          timeout: 4500,
          windowsHide: true,
          env: {
            ...process.env,
            OFFICE_SIM_NOTIFY_TITLE: title,
            OFFICE_SIM_NOTIFY_SUB: subtitle,
            OFFICE_SIM_NOTIFY_BODY: body,
          },
        },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false, platform, error: err.code || err.message || 'powershell_failed' });
            return;
          }
          resolve({ ok: true, platform, method: String(stdout || 'ok:winrt').trim() });
        },
      );
      return;
    }

    resolve({ ok: false, platform, error: 'unsupported_platform' });
  });
}

function scrubProjectLabel(ev) {
  if (typeof ev?.projectLabel === 'string' && ev.projectLabel.trim()) {
    return sanitizeNotifyText(path.basename(ev.projectLabel.trim()), 48);
  }
  if (typeof ev?.project === 'string' && ev.project.trim()) {
    return sanitizeNotifyText(path.basename(ev.project.trim()), 48);
  }
  return 'Office';
}

export class SystemNotifier {
  constructor({
    enabled = false,
    categories = DEFAULT_NOTIFY_CATEGORIES,
    platform = process.platform,
    execFileFn = execFile,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    apiErrorCoalesceMs = API_ERROR_COALESCE_MS,
    now = () => Date.now(),
    ready = true,
    onNotify = null,
  } = {}) {
    const parsed = parseNotifyArg(enabled ? categories : false);
    this.enabled = Boolean(enabled);
    this.categories = new Set(parsed.categories.length ? parsed.categories : DEFAULT_NOTIFY_CATEGORIES);
    this.platform = platform;
    this.execFileFn = execFileFn;
    this.cooldownMs = cooldownMs;
    this.apiErrorCoalesceMs = apiErrorCoalesceMs;
    this.now = now;
    this.ready = Boolean(ready);
    this.onNotify = typeof onNotify === 'function' ? onNotify : null;
    this.sessions = new Map(); // sessionId -> { name, projectLabel, agent, isSubagent, turnNotified, lastByCat, lastApiErrorAt }
    this.openTools = new Map(); // `${sessionId}|${toolUseId}` -> { tool, summary }
    this.sentCount = 0;
  }

  status() {
    return {
      enabled: this.enabled,
      categories: [...this.categories],
      platform: this.platform,
      supported: this.platform === 'darwin' || this.platform === 'win32',
      sentCount: this.sentCount,
    };
  }

  configure(patch = {}) {
    if (patch.categories !== undefined) {
      const parsed = parseNotifyArg(patch.categories);
      this.categories = new Set(parsed.categories);
    }
    if (typeof patch.enabled === 'boolean') {
      this.enabled = patch.enabled;
      if (this.enabled && this.categories.size === 0) {
        for (const c of DEFAULT_NOTIFY_CATEGORIES) this.categories.add(c);
      }
    }
    return this.status();
  }

  setReady(ready = true) {
    this.ready = Boolean(ready);
  }

  _ensureSession(sid) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = {
        name: sid.slice(0, 8),
        projectLabel: 'Office',
        agent: 'claude-code',
        isSubagent: false,
        turnNotified: false,
        lastByCat: new Map(),
        lastApiErrorAt: -Infinity,
      };
      this.sessions.set(sid, s);
    }
    return s;
  }

  observeEvent(ev, { live = this.ready } = {}) {
    if (!ev || typeof ev !== 'object') return null;
    const sid = publicSessionId(ev.sessionId);
    if (!sid) return null;
    const s = this._ensureSession(sid);

    if (ev.type === 'session') {
      if (typeof ev.title === 'string' && ev.title.trim()) s.name = sanitizeNotifyText(ev.title, 40);
      else if (typeof ev.agent === 'string' && ev.agent.trim()) s.name = sanitizeNotifyText(ev.agent, 40);
      if (typeof ev.agent === 'string' && ev.agent.trim()) s.agent = ev.agent.trim();
      const proj = scrubProjectLabel(ev);
      if (proj) s.projectLabel = proj;
      if (ev.isSubagent !== undefined || ev.parentSessionId !== undefined) {
        s.isSubagent = Boolean(ev.isSubagent || ev.parentSessionId);
      }
      return null;
    }

    if (ev.type === 'user' || ev.type === 'prompt' || ev.type === 'thinking' || ev.type === 'say') {
      s.turnNotified = false;
      return null;
    }

    if (ev.type === 'session_end') {
      for (const k of [...this.openTools.keys()]) {
        if (k.startsWith(`${sid}|`)) this.openTools.delete(k);
      }
      return null;
    }

    let candidate = null;
    const subtitle = s.projectLabel ? `${s.name} · ${s.projectLabel}` : s.name;

    if (ev.type === 'tool_start') {
      s.turnNotified = false;
      if (typeof ev.toolUseId === 'string' && ev.toolUseId) {
        this.openTools.set(`${sid}|${ev.toolUseId}`, {
          tool: sanitizeNotifyText(ev.tool || 'tool', 40),
          summary: sanitizeNotifyText(ev.summary || '', 120),
        });
      }
      if (isBlockingAskToolStart(ev)) {
        const detail = sanitizeNotifyText(ev.question || ev.summary || ev.tool || 'Waiting for your input', 140);
        candidate = {
          category: 'ask',
          sessionId: sid,
          title: 'Office Sim · Input Needed',
          subtitle,
          body: detail,
          sound: 'Submarine',
        };
      }
    } else if (ev.type === 'tool_wait') {
      if (ev.waiting === false) return null;
      const cached = typeof ev.toolUseId === 'string' ? this.openTools.get(`${sid}|${ev.toolUseId}`) : null;
      const detail = sanitizeNotifyText(
        ev.question || ev.summary || cached?.summary || cached?.tool || ev.tool || 'Command awaiting approval',
        140,
      );
      candidate = {
        category: 'ask',
        sessionId: sid,
        title: 'Office Sim · Waiting for Approval',
        subtitle,
        body: detail,
        sound: 'Submarine',
      };
    } else if (ev.type === 'approval_request') {
      const detail = sanitizeNotifyText(ev.question || ev.summary || ev.tool || 'Approval requested', 140);
      candidate = {
        category: 'ask',
        sessionId: sid,
        title: 'Office Sim · Approval Needed',
        subtitle,
        body: detail,
        sound: 'Submarine',
      };
    } else if (ev.type === 'tool_end') {
      const cached = typeof ev.toolUseId === 'string' ? this.openTools.get(`${sid}|${ev.toolUseId}`) : null;
      if (typeof ev.toolUseId === 'string') this.openTools.delete(`${sid}|${ev.toolUseId}`);
      if (ev.ok === false) {
        const label = ev.errorKind === 'denied' ? 'Tool Denied' : 'Tool Failed';
        const detail = sanitizeNotifyText(
          ev.summary || cached?.summary || ev.tool || cached?.tool || label,
          140,
        );
        candidate = {
          category: 'tool_error',
          sessionId: sid,
          title: `Office Sim · ${label}`,
          subtitle,
          body: detail,
          sound: 'Basso',
        };
      }
    } else if (ev.type === 'system') {
      if (ev.kind === 'api_error' || ev.kind === 'refusal') {
        const nowMs = this.now();
        if (nowMs - s.lastApiErrorAt < this.apiErrorCoalesceMs) return null;
        s.lastApiErrorAt = nowMs;
        const detail = sanitizeNotifyText(
          ev.text || (ev.kind === 'refusal' ? 'Model refused request' : 'API error encountered'),
          140,
        );
        candidate = {
          category: 'error',
          sessionId: sid,
          title: 'Office Sim · Agent Error',
          subtitle,
          body: detail,
          sound: 'Basso',
        };
      }
    } else if (ev.type === 'turn_end') {
      if (ev.reason === 'api_error') {
        const nowMs = this.now();
        if (nowMs - s.lastApiErrorAt < this.apiErrorCoalesceMs) return null;
        s.lastApiErrorAt = nowMs;
        const detail = sanitizeNotifyText(ev.text || 'Turn halted due to API error', 140);
        candidate = {
          category: 'error',
          sessionId: sid,
          title: 'Office Sim · Turn Halted',
          subtitle,
          body: detail,
          sound: 'Basso',
        };
      } else if (!s.isSubagent && !ev.isSubagent) {
        const reasonOk = ev.reason === undefined || DONE_REASONS.has(ev.reason);
        if (!reasonOk || s.turnNotified) return null;
        s.turnNotified = true;
        const detail = sanitizeNotifyText(ev.text || 'Agent finished its turn', 140);
        candidate = {
          category: 'done',
          sessionId: sid,
          title: 'Office Sim · Turn Complete',
          subtitle,
          body: detail,
          sound: 'Glass',
        };
      }
    }

    if (!candidate || !live) return null;
    if (!this.enabled || !this.categories.has(candidate.category)) return null;

    const nowMs = this.now();
    const lastAt = s.lastByCat.get(candidate.category) ?? -Infinity;
    if (nowMs - lastAt < this.cooldownMs) return null;
    s.lastByCat.set(candidate.category, nowMs);
    this.sentCount += 1;

    this.onNotify?.(candidate);
    void dispatchNativeNotification(candidate, {
      platform: this.platform,
      execFileFn: this.execFileFn,
    });
    return candidate;
  }

  async sendTestNotification() {
    const sample = {
      category: 'ask',
      sessionId: 'test',
      title: 'Office Sim · Notifications Active',
      subtitle: 'System Notification Test',
      body: 'Alerts for input needed, errors, and completed turns are enabled.',
      sound: 'Glass',
    };
    this.onNotify?.(sample);
    return dispatchNativeNotification(sample, {
      platform: this.platform,
      execFileFn: this.execFileFn,
    });
  }
}
