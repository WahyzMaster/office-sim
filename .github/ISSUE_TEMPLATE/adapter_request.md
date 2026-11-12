---
name: New agent adapter request
about: Ask for support for another coding agent, or report a session log format that changed
title: 'Adapter: '
labels: enhancement
---

**Agent**
Name, version, and whether it is a CLI, an IDE extension or a desktop app.

**Where it keeps its session logs**
The folder and the file name pattern (for example `~/.agent/sessions/<id>.jsonl`). Replace user names and project names with placeholders.

**What the log records**
Which of these can be seen in the log, as far as you know: a prompt, a tool call and its result, a question to the user, a plan approval, a permission prompt, the end of a turn.

**Format sample**
Field names and value types only, for example `{ "type": "tool_call", "name": string, "ts": number }`. Do not paste real log lines: they can contain file contents, commands and secrets.

**Anything else**
Links to format documentation, and whether you would like to write the adapter yourself (`CONTRIBUTING.md` and `docs/ADAPTERS.md` say how).
