# Outlook mail integration (Windows desktop, local automation) — READ-ONLY

Read and summarize your **already-signed-in Outlook desktop** mail from openwork
— no Azure AD app registration, no Graph API, no extra login. The scripts drive
the Outlook desktop client through COM, reusing the profile you're already
logged into on this PC.

**This integration is strictly read-only.** It never sends, replies, forwards,
moves, deletes, marks, or modifies mail in any way — it only reads.

> Requirements: Windows + Outlook desktop client installed and running (or
> launchable) under the same user. PowerShell (built in).

## Scripts

| Script                   | Purpose                               | Mutates? |
| ------------------------ | ------------------------------------- | -------- |
| `Read-Outlook.ps1`       | List / search messages → JSON         | No       |
| `Get-OutlookMessage.ps1` | Full body of one message by `EntryId` | No       |

Both scripts print UTF-8 JSON to stdout (Korean-safe).

## Quick start

```powershell
# 15 most recent unread in the Inbox
powershell -NoProfile -ExecutionPolicy Bypass -File Read-Outlook.ps1 -Count 15 -UnreadOnly

# last 3 days, subject/sender contains a keyword
powershell -NoProfile -ExecutionPolicy Bypass -File Read-Outlook.ps1 -SinceDays 3 -Search "릴리스"

# a subfolder
powershell -NoProfile -ExecutionPolicy Bypass -File Read-Outlook.ps1 -Folder "Inbox/Team" -Count 10

# full body of one message
powershell -NoProfile -ExecutionPolicy Bypass -File Get-OutlookMessage.ps1 -EntryId "00000000ABCD..."
```

## Using it from openwork

Run the `/outlook` slash command with what you want, e.g.:

- `/outlook 오늘 안 읽은 메일 요약해줘`
- `/outlook 지난 3일간 김부장님 메일 요약해줘`

The command tells the agent to call these scripts, parse the JSON, and summarize
in Korean. It will not modify your mailbox.

## Notes

- **Privacy**: message content is sent to the model for summarization. Be
  mindful with sensitive corporate mail.
- **Security policy**: some corporate Outlook installs block programmatic/COM
  access (GPO "Programmatic Access" = Disabled, or antivirus guard). If you see
  a COM denial, automation is blocked by policy and a Graph-API route would be
  needed instead.
- The scripts read the **default store**. Shared mailboxes / additional accounts
  would need a small tweak (resolve the store first) — ask if you need that.
