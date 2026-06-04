<#
.SYNOPSIS
  Returns the full content of a single Outlook message by EntryId as JSON.

.DESCRIPTION
  Use the EntryId from Read-Outlook.ps1 to fetch the complete body and the
  attachment list for one message. Read-only.

.PARAMETER EntryId
  The EntryID of the message (from Read-Outlook.ps1 output).

.PARAMETER MaxBodyLength
  Truncate the body to this many characters (0 = no limit). Default: 0.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Get-OutlookMessage.ps1 -EntryId "00000000ABCD..."
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EntryId,
  [int]$MaxBodyLength = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')

$item = $ns.GetItemFromID($EntryId)

$body = [string]$item.Body
if ($null -eq $body) { $body = '' }
if ($MaxBodyLength -gt 0 -and $body.Length -gt $MaxBodyLength) {
  $body = $body.Substring(0, $MaxBodyLength)
}

$attachments = @()
foreach ($att in $item.Attachments) {
  $attachments += [ordered]@{
    FileName = [string]$att.FileName
    Size     = [int]$att.Size
  }
}

[ordered]@{
  EntryId       = $item.EntryID
  Subject       = [string]$item.Subject
  SenderName    = [string]$item.SenderName
  SenderEmail   = [string]$item.SenderEmailAddress
  ReceivedTime  = $item.ReceivedTime.ToString('yyyy-MM-dd HH:mm:ss')
  To            = [string]$item.To
  Cc            = [string]$item.CC
  Unread        = [bool]$item.UnRead
  Importance    = [int]$item.Importance
  Attachments   = $attachments
  Body          = $body
} | ConvertTo-Json -Depth 5
