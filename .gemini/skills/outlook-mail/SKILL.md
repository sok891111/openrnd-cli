---
name: outlook-mail
description: Read and summarize the user's LOCAL Outlook desktop mail on Windows (read-only, via PowerShell COM). Use this WHENEVER the user asks to read, check, look at, summarize, triage, or organize their email / mail / Outlook / inbox / 메일 / 이메일 / 받은편지함 / 아웃룩. This is the built-in way openrnd reads mail on this PC — do NOT look for, require, or tell the user to configure an email MCP server. There is no MCP needed.
---

# Outlook mail (Windows desktop, READ-ONLY)

This skill reads the user's **already-signed-in Outlook desktop client** through
PowerShell COM. No Microsoft Graph, no Azure app registration, no MCP server, no
extra login — it reuses the Outlook profile already logged in on this PC.

**Critical:** When the user asks anything about reading/checking/summarizing
their mail, use the scripts below immediately. Never respond that you need an
email MCP, an integration, or additional configuration — you already have this
capability.

This skill is strictly **read-only**: it never sends, replies, forwards, moves,
deletes, marks, or otherwise modifies mail.

## Scripts

Located in the openrnd repo under `scripts/outlook/` (resolve relative to the
project root; use the absolute repo path if the current directory is elsewhere):

- `Read-Outlook.ps1` — list/search messages → UTF-8 JSON (read-only)
- `Get-OutlookMessage.ps1` — full body of one message by `EntryId` (read-only)

## How to run

Use the shell tool with PowerShell:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/outlook/Read-Outlook.ps1 <params>
```

Useful parameters for `Read-Outlook.ps1`:
- `-Count <n>` — max messages (default 20, newest first)
- `-UnreadOnly` — only unread
- `-SinceDays <n>` — only the last N days
- `-Search "<text>"` — substring match on subject/sender
- `-Folder "Inbox/Subfolder"` — a specific folder (default Inbox)

Examples:
- Today's unread: `... Read-Outlook.ps1 -Count 20 -UnreadOnly`
- Keyword in last 3 days: `... Read-Outlook.ps1 -SinceDays 3 -Search "릴리스"`
- Full body: `... Get-OutlookMessage.ps1 -EntryId "<EntryId from list>"`

Parse the JSON from stdout. Each message has a stable `EntryId`; use it with
`Get-OutlookMessage.ps1` to read the complete body when a summary needs detail.

## What to produce

1. Pick sensible parameters from the user's request and run `Read-Outlook.ps1`.
2. Summarize in Korean, grouped by sender or topic: who, subject, the key ask,
   and any deadline/action item. Flag urgent items (Importance=2, or unread from
   key senders).
3. If the user asks to *organize/move/delete/mark* mail, explain that this
   integration is read-only and cannot modify the mailbox — do not attempt a
   workaround.

## Troubleshooting

- If a script errors with a COM / "programmatic access" denial, the PC's Outlook
  security policy (GPO) blocks automation — report that plainly; a Graph-API
  route would be required instead. Do not silently fall back to "needs MCP".
- Privacy: message content is sent to the model for summarization. Keep that in
  mind for sensitive corporate mail.
