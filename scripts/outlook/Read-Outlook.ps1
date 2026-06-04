<#
.SYNOPSIS
  Reads messages from the locally signed-in Outlook desktop client via COM and
  emits them as JSON. No Azure app registration / Graph API required — it uses
  the Outlook profile already logged in on this PC.

.DESCRIPTION
  Intended to be invoked by the openrnd agent (or manually) on a Windows PC that
  has the Outlook desktop client installed and running. Output is a JSON array
  on stdout, UTF-8 encoded (handles Korean subjects/bodies).

  Each message includes a stable EntryId that can be passed to
  Get-OutlookMessage.ps1 (full body) and Invoke-OutlookAction.ps1 (organize).

.PARAMETER Folder
  Folder to read. Either a well-known name (Inbox, SentItems, Drafts,
  DeletedItems, Outbox, Junk) or a path under the default store using '/' as a
  separator, e.g. "Inbox/Projects/2026". Default: Inbox.

.PARAMETER Count
  Maximum number of messages to return (most recent first). Default: 20.

.PARAMETER SinceDays
  Only include messages received within the last N days. 0 = no date filter.

.PARAMETER UnreadOnly
  Only include unread messages.

.PARAMETER Search
  Case-insensitive substring matched against Subject OR SenderName OR SenderEmail.

.PARAMETER BodyPreviewLength
  Number of characters of the plain-text body to include as BodyPreview.
  Default: 600. Use Get-OutlookMessage.ps1 for the full body.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Read-Outlook.ps1 -Count 15 -UnreadOnly

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Read-Outlook.ps1 -Folder "Inbox/Team" -SinceDays 3 -Search "릴리스"
#>
[CmdletBinding()]
param(
  [string]$Folder = 'Inbox',
  [int]$Count = 20,
  [int]$SinceDays = 0,
  [switch]$UnreadOnly,
  [string]$Search = '',
  [int]$BodyPreviewLength = 600
)

$ErrorActionPreference = 'Stop'
# Ensure Korean / non-ASCII survives the pipe back to the agent.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# olFolderInbox = 6, etc. (OlDefaultFolders enum)
$DefaultFolders = @{
  'inbox'        = 6
  'sentitems'    = 5
  'sent'         = 5
  'drafts'       = 16
  'deleteditems' = 3
  'deleted'      = 3
  'outbox'       = 4
  'junk'         = 23
}

function Resolve-Folder {
  param($Namespace, [string]$Spec)

  # @(...) forces an array even when the split yields a single segment;
  # otherwise PowerShell unwraps it to a scalar string and $parts[0] would
  # return the first *character* (a [char], which has no ToLowerInvariant()).
  $parts = @($Spec -split '/' | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { $parts = @('Inbox') }

  $rootKey = ([string]$parts[0]).ToLowerInvariant()
  if ($DefaultFolders.ContainsKey($rootKey)) {
    $current = $Namespace.GetDefaultFolder($DefaultFolders[$rootKey])
  }
  else {
    # Treat the first segment as a top-level folder name under the default store.
    $current = $Namespace.GetDefaultFolder(6).Parent
    $current = $current.Folders.Item($parts[0])
  }

  for ($i = 1; $i -lt $parts.Count; $i++) {
    $current = $current.Folders.Item($parts[$i])
  }
  return $current
}

function Get-SenderEmail {
  param($Item)
  try {
    # Exchange senders expose ExchangeUser with a real SMTP address.
    if ($Item.SenderEmailType -eq 'EX') {
      $exUser = $Item.Sender.GetExchangeUser()
      if ($exUser) { return $exUser.PrimarySmtpAddress }
    }
    return $Item.SenderEmailAddress
  }
  catch { return $Item.SenderEmailAddress }
}

$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')

$target = Resolve-Folder -Namespace $ns -Spec $Folder
$items = $target.Items
$items.Sort('[ReceivedTime]', $true)  # newest first

# Server-side restrict where it is safe/locale-robust.
if ($UnreadOnly) {
  $items = $items.Restrict('[Unread] = true')
  $items.Sort('[ReceivedTime]', $true)
}

$cutoff = if ($SinceDays -gt 0) { (Get-Date).AddDays(-$SinceDays) } else { $null }
$searchLower = ([string]$Search).ToLowerInvariant()

$results = New-Object System.Collections.ArrayList
$item = $items.GetFirst()
while ($null -ne $item) {
  # Skip non-mail items (meeting requests, etc.) defensively.
  $isMail = $true
  try { $null = $item.ReceivedTime } catch { $isMail = $false }

  if ($isMail) {
    $received = $item.ReceivedTime
    $passDate = (-not $cutoff) -or ($received -ge $cutoff)

    if (-not $passDate) {
      # Items are newest-first; once older than cutoff we can stop.
      break
    }

    $senderName = [string]$item.SenderName
    $senderEmail = [string](Get-SenderEmail -Item $item)
    $subject = [string]$item.Subject

    $passSearch = $true
    if ($searchLower -ne '') {
      $hay = ("$subject `n$senderName `n$senderEmail").ToLowerInvariant()
      $passSearch = $hay.Contains($searchLower)
    }

    if ($passSearch) {
      $body = [string]$item.Body
      if ($null -eq $body) { $body = '' }
      $preview = if ($body.Length -gt $BodyPreviewLength) {
        $body.Substring(0, $BodyPreviewLength)
      } else { $body }

      $null = $results.Add([ordered]@{
        EntryId        = $item.EntryID
        Subject        = $subject
        SenderName     = $senderName
        SenderEmail    = $senderEmail
        ReceivedTime   = $received.ToString('yyyy-MM-dd HH:mm:ss')
        To             = [string]$item.To
        Cc             = [string]$item.CC
        Unread         = [bool]$item.UnRead
        Importance     = [int]$item.Importance   # 0 Low, 1 Normal, 2 High
        HasAttachments = ($item.Attachments.Count -gt 0)
        FolderPath     = [string]$target.FolderPath
        BodyPreview    = $preview
      })

      if ($results.Count -ge $Count) { break }
    }
  }

  $item = $items.GetNext()
}

# -Depth keeps ordered hashtables intact; compress for a tight payload.
$results | ConvertTo-Json -Depth 5
