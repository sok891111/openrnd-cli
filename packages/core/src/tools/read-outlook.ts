/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  READ_OUTLOOK_TOOL_NAME,
  READ_OUTLOOK_DISPLAY_NAME,
} from './tool-names.js';
import { debugLogger } from '../utils/debugLogger.js';

/** Outlook launch + COM extraction can be slow; allow a generous timeout. */
const OUTLOOK_READ_TIMEOUT_MS = 120_000;

export interface ReadOutlookParams {
  /** Folder to read. Well-known name (Inbox, SentItems, Drafts, DeletedItems,
   *  Outbox, Junk) or a path under the default store using '/' (e.g.
   *  "Inbox/Team"). Default: Inbox. Ignored when entry_id is set. */
  folder?: string;
  /** Max messages to return (newest first). Default 20. Ignored with entry_id. */
  count?: number;
  /** Only messages received within the last N days. 0 = no date filter. */
  since_days?: number;
  /** Only unread messages. */
  unread_only?: boolean;
  /** Case-insensitive substring matched against subject/sender. */
  search?: string;
  /** If set, return the FULL body of this single message (from a prior list's
   *  entry_id) instead of a list. */
  entry_id?: string;
  /** Store that owns `entry_id`. Pass the `StoreId` from the list result so a
   *  message living in an archive .pst (non-default store) can be opened. */
  store_id?: string;
  /** Search across ALL connected stores (primary mailbox + every mounted .pst,
   *  including AutoArchive "Archives") and all their folders, recursively.
   *  Use this for a global / full mailbox search. `folder` is ignored. */
  all_stores?: boolean;
  /** Also match the message body text (not just subject/sender). Recommended
   *  together with `all_stores` for a true full-text search; slower. */
  search_body?: boolean;
}

/**
 * Self-contained PowerShell script (embedded so the tool has no external file
 * dependency and works regardless of the current working directory). Reads the
 * locally signed-in Outlook desktop client via COM. Strictly read-only.
 */
const OUTLOOK_PS_SCRIPT = String.raw`
[CmdletBinding()]
param(
  [string]$Folder = 'Inbox',
  [int]$Count = 20,
  [int]$SinceDays = 0,
  [switch]$UnreadOnly,
  [string]$Search = '',
  [int]$BodyPreviewLength = 600,
  [string]$EntryId = '',
  [string]$StoreId = '',
  [switch]$AllStores,
  [switch]$SearchBody
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$DefaultFolders = @{
  'inbox' = 6; 'sentitems' = 5; 'sent' = 5; 'drafts' = 16
  'deleteditems' = 3; 'deleted' = 3; 'outbox' = 4; 'junk' = 23
}

function Resolve-Folder {
  param($Namespace, [string]$Spec)
  $parts = @($Spec -split '/' | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { $parts = @('Inbox') }
  $rootKey = ([string]$parts[0]).ToLowerInvariant()
  if ($DefaultFolders.ContainsKey($rootKey)) {
    $current = $Namespace.GetDefaultFolder($DefaultFolders[$rootKey])
  }
  else {
    $current = $Namespace.GetDefaultFolder(6).Parent.Folders.Item($parts[0])
  }
  for ($i = 1; $i -lt $parts.Count; $i++) {
    $current = $current.Folders.Item($parts[$i])
  }
  return $current
}

function Get-SenderEmail {
  param($Item)
  try {
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

# Single-message mode: full body by EntryId.
if ($EntryId -ne '') {
  # A StoreId is required to resolve items that live in a non-default store
  # (e.g. an archive .pst). Without it GetItemFromID only looks in the default
  # store and would fail for archived mail.
  if ($StoreId -ne '') {
    $item = $ns.GetItemFromID($EntryId, $StoreId)
  }
  else {
    $item = $ns.GetItemFromID($EntryId)
  }
  $body = [string]$item.Body
  if ($null -eq $body) { $body = '' }
  $attachments = @()
  foreach ($att in $item.Attachments) {
    $attachments += [ordered]@{ FileName = [string]$att.FileName; Size = [int]$att.Size }
  }
  [ordered]@{
    EntryId      = $item.EntryID
    Subject      = [string]$item.Subject
    SenderName   = [string]$item.SenderName
    SenderEmail  = [string](Get-SenderEmail -Item $item)
    ReceivedTime = $item.ReceivedTime.ToString('yyyy-MM-dd HH:mm:ss')
    To           = [string]$item.To
    Cc           = [string]$item.CC
    Unread       = [bool]$item.UnRead
    Importance   = [int]$item.Importance
    Attachments  = $attachments
    Body         = $body
  } | ConvertTo-Json -Depth 5
  return
}

# List mode.
$cutoff = if ($SinceDays -gt 0) { (Get-Date).AddDays(-$SinceDays) } else { $null }
$searchLower = ([string]$Search).ToLowerInvariant()
$results = New-Object System.Collections.ArrayList
# Hard safety cap on total collected matches so a body-text sweep over a huge
# mailbox can't blow up memory. The 120s process timeout is the other guard.
$MaxCollect = 5000

function Add-MailMatch {
  param($Item, $Folder, $Received, [string]$Subject, [string]$SenderName, [string]$SenderEmail, [string]$Body)
  $preview = if ($Body.Length -gt $BodyPreviewLength) { $Body.Substring(0, $BodyPreviewLength) } else { $Body }
  $storeName = ''
  $storeId = ''
  try { $storeName = [string]$Folder.Store.DisplayName } catch { }
  try { $storeId = [string]$Folder.StoreID } catch { }
  $null = $results.Add([ordered]@{
    EntryId        = $Item.EntryID
    StoreId        = $storeId
    Subject        = $Subject
    SenderName     = $SenderName
    SenderEmail    = $SenderEmail
    ReceivedTime   = $Received.ToString('yyyy-MM-dd HH:mm:ss')
    To             = [string]$Item.To
    Cc             = [string]$Item.CC
    Unread         = [bool]$Item.UnRead
    Importance     = [int]$Item.Importance
    HasAttachments = ($Item.Attachments.Count -gt 0)
    StoreName      = $storeName
    FolderPath     = [string]$Folder.FolderPath
    BodyPreview    = $preview
  })
}

# Scan one folder's mail items (newest first). Matches subject/sender, and the
# body too when -SearchBody is set. $StopAtCount > 0 stops once that many
# matches are collected (single-folder mode); 0 means collect all (all-stores).
function Search-FolderItems {
  param($Folder, [int]$StopAtCount = 0)
  $items = $Folder.Items
  try { $items.Sort('[ReceivedTime]', $true) } catch { }
  $it = $items.GetFirst()
  while ($null -ne $it) {
    if ($results.Count -ge $MaxCollect) { break }
    $isMail = $true
    try { $null = $it.ReceivedTime } catch { $isMail = $false }
    if ($isMail) {
      $received = $it.ReceivedTime
      # Items are sorted newest-first, so once we pass the cutoff we can stop.
      if ($cutoff -and ($received -lt $cutoff)) { break }
      $passUnread = (-not $UnreadOnly) -or ([bool]$it.UnRead)
      if ($passUnread) {
        $subject = [string]$it.Subject
        $senderName = [string]$it.SenderName
        $senderEmail = [string](Get-SenderEmail -Item $it)
        $body = $null
        $pass = $true
        if ($searchLower -ne '') {
          $hay = ("$subject $senderName $senderEmail").ToLowerInvariant()
          $pass = $hay.Contains($searchLower)
          if ((-not $pass) -and $SearchBody) {
            try { $body = [string]$it.Body } catch { $body = '' }
            if ($null -eq $body) { $body = '' }
            $pass = $body.ToLowerInvariant().Contains($searchLower)
          }
        }
        if ($pass) {
          if ($null -eq $body) { try { $body = [string]$it.Body } catch { $body = '' } }
          if ($null -eq $body) { $body = '' }
          Add-MailMatch -Item $it -Folder $Folder -Received $received -Subject $subject -SenderName $senderName -SenderEmail $senderEmail -Body $body
          if (($StopAtCount -gt 0) -and ($results.Count -ge $StopAtCount)) { break }
        }
      }
    }
    $it = $items.GetNext()
  }
}

# Recurse a store: scan the folder and every subfolder.
function Walk-StoreTree {
  param($Folder)
  if ($results.Count -ge $MaxCollect) { return }
  try { Search-FolderItems -Folder $Folder } catch { }
  $subs = $null
  try { $subs = $Folder.Folders } catch { }
  if ($null -ne $subs) {
    foreach ($sub in $subs) {
      if ($results.Count -ge $MaxCollect) { break }
      try { Walk-StoreTree -Folder $sub } catch { }
    }
  }
}

if ($AllStores) {
  # Search every store connected to the Outlook profile — the primary mailbox
  # plus any mounted .pst (incl. AutoArchive "Archives") — recursively.
  foreach ($store in $ns.Stores) {
    if ($results.Count -ge $MaxCollect) { break }
    try {
      # Skip org-wide Public Folders (olExchangePublicFolder = 2): scanning them
      # is enormous and is not the user's own mail/archive.
      $stype = $null
      try { $stype = $store.ExchangeStoreType } catch { }
      if ($stype -eq 2) { continue }
      $root = $store.GetRootFolder()
      Walk-StoreTree -Folder $root
    }
    catch { }
  }
  # Merge results from all stores and return the newest $Count overall.
  # ReceivedTime is a zero-padded 'yyyy-MM-dd HH:mm:ss' string, so a lexical
  # descending sort is also chronological.
  $sorted = @($results | Sort-Object -Property ReceivedTime -Descending | Select-Object -First $Count)
  ConvertTo-Json -Depth 5 -InputObject @($sorted)
  return
}

# Single-folder mode (default).
$target = Resolve-Folder -Namespace $ns -Spec $Folder
Search-FolderItems -Folder $target -StopAtCount $Count
# Wrap so a single result still serializes as a JSON array.
ConvertTo-Json -Depth 5 -InputObject @($results)
`;

class ReadOutlookInvocation extends BaseToolInvocation<
  ReadOutlookParams,
  ToolResult
> {
  constructor(
    params: ReadOutlookParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    if (this.params.entry_id) {
      return `Read full Outlook message ${this.params.entry_id}`;
    }
    const bits: string[] = [];
    if (this.params.all_stores) {
      bits.push('all stores + archives');
    } else {
      bits.push(
        this.params.folder ? `folder "${this.params.folder}"` : 'Inbox',
      );
    }
    if (this.params.unread_only) bits.push('unread only');
    if (this.params.since_days) bits.push(`last ${this.params.since_days}d`);
    if (this.params.search) {
      bits.push(
        `search "${this.params.search}"${this.params.search_body ? ' (incl. body)' : ''}`,
      );
    }
    return `Read Outlook mail (${bits.join(', ')})`;
  }

  private buildArgs(scriptPath: string): string[] {
    const p = this.params;
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ];
    if (p.entry_id) {
      args.push('-EntryId', p.entry_id);
      if (p.store_id) args.push('-StoreId', p.store_id);
      return args;
    }
    args.push('-Count', String(p.count && p.count > 0 ? p.count : 20));
    if (p.since_days && p.since_days > 0) {
      args.push('-SinceDays', String(p.since_days));
    }
    if (p.search) args.push('-Search', p.search);
    if (p.unread_only) args.push('-UnreadOnly');
    if (p.all_stores) {
      // In all-stores mode the folder is ignored (every store is walked).
      args.push('-AllStores');
    } else {
      args.push('-Folder', p.folder && p.folder.trim() ? p.folder : 'Inbox');
    }
    if (p.search_body) args.push('-SearchBody');
    return args;
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    if (os.platform() !== 'win32') {
      const msg =
        'Reading Outlook is only available on Windows (uses the Outlook desktop client via COM).';
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const scriptPath = path.join(
      os.tmpdir(),
      `openrnd-outlook-${crypto.randomBytes(6).toString('hex')}.ps1`,
    );

    try {
      await fs.writeFile(scriptPath, OUTLOOK_PS_SCRIPT, 'utf8');
      const args = this.buildArgs(scriptPath);
      const { stdout, stderr, code } = await this.runPowerShell(
        args,
        abortSignal,
      );

      if (code !== 0) {
        const detail = (stderr || stdout || '').trim();
        const isComDenied =
          /programmatic access|0x80080005|denied|0x800A/i.test(detail);
        const hint = isComDenied
          ? ' (Outlook programmatic/COM access appears to be blocked by policy — a Graph-API route would be required instead.)'
          : '';
        const msg = `PowerShell exited with code ${code}: ${detail}${hint}`;
        debugLogger.warn(`[read_outlook] ${msg}`);
        return {
          llmContent: `Error reading Outlook: ${msg}`,
          returnDisplay: `Error reading Outlook (code ${code})`,
          error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const text = stdout.trim();
      // Validate it is JSON; if not, surface the raw output for debugging.
      try {
        JSON.parse(text || (this.params.entry_id ? '{}' : '[]'));
      } catch {
        debugLogger.warn(
          `[read_outlook] Non-JSON output: ${text.slice(0, 200)}`,
        );
      }

      const payload = text || (this.params.entry_id ? '{}' : '[]');
      const display = this.params.entry_id
        ? `Read Outlook message ${this.params.entry_id}`
        : `Read Outlook mail from ${this.params.folder || 'Inbox'}`;
      return {
        llmContent: payload,
        returnDisplay: display,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error reading Outlook: ${msg}`,
        returnDisplay: `Error reading Outlook: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    } finally {
      await fs.rm(scriptPath, { force: true }).catch(() => {});
    }
  }

  private runPowerShell(
    args: string[],
    abortSignal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, {
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(
            new Error(
              `Outlook read timed out after ${OUTLOOK_READ_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, OUTLOOK_READ_TIMEOUT_MS);

      const onAbort = () => {
        if (!settled) {
          settled = true;
          child.kill();
          clearTimeout(timer);
          reject(new Error('Outlook read aborted'));
        }
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', onAbort);
          resolve({ stdout, stderr, code: code ?? 0 });
        }
      });
    });
  }
}

/**
 * Built-in, read-only tool for reading the locally signed-in Outlook desktop
 * client (Windows, via PowerShell COM). Registered unconditionally so it is
 * available regardless of the working directory — no skill / MCP required.
 */
export class ReadOutlookTool extends BaseDeclarativeTool<
  ReadOutlookParams,
  ToolResult
> {
  static readonly Name = READ_OUTLOOK_TOOL_NAME;

  constructor(_config: Config, messageBus: MessageBus) {
    super(
      ReadOutlookTool.Name,
      READ_OUTLOOK_DISPLAY_NAME,
      "Read the user's local Outlook desktop mail on Windows (read-only). Use this " +
        'whenever the user asks to read, check, summarize, triage, or organize their ' +
        'email / mail / Outlook / inbox (메일 / 이메일 / 받은편지함 / 아웃룩). It uses the ' +
        'already-signed-in Outlook desktop client via COM — do NOT look for or require an ' +
        'email MCP server; none is needed. Returns JSON: a list of recent/matching messages ' +
        '(each with a stable entry_id, sender, subject, received time, unread flag, importance, ' +
        'and a body preview), or — when entry_id is provided — the full body of one message. ' +
        'For a global / full mailbox search — especially when the user wants to search ' +
        'EVERYTHING including archived mail — set all_stores=true to search the primary ' +
        'mailbox plus every connected .pst archive (e.g. AutoArchive "Archives"/보관 파일) ' +
        'across all folders, and set search_body=true to also match the message body text. ' +
        'Each list result includes a StoreId; pass it back as store_id (with entry_id) to open ' +
        'the full body of a message that lives in an archive store. ' +
        'It is strictly read-only and never sends, replies, moves, or modifies mail.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description:
              'Folder to read: a well-known name (Inbox, SentItems, Drafts, DeletedItems, Outbox, Junk) or a path under the default store using "/" (e.g. "Inbox/Team"). Default: Inbox. Ignored when entry_id or all_stores is set.',
          },
          all_stores: {
            type: 'boolean',
            description:
              'If true, search across ALL connected stores (primary mailbox + every mounted .pst archive, including AutoArchive "Archives"/보관 파일) and all their folders recursively. Use for a global/full mailbox search that must include archived mail. Ignores "folder". Can be slow on large mailboxes — combine with "search" and/or "since_days" to narrow.',
          },
          search_body: {
            type: 'boolean',
            description:
              'If true, also match the message body text, not just subject/sender. Recommended together with all_stores for a true full-text search. Slower because each message body is scanned.',
          },
          count: {
            type: 'number',
            description: 'Max messages to return, newest first. Default 20.',
          },
          since_days: {
            type: 'number',
            description:
              'Only include messages received within the last N days. Omit or 0 for no date filter.',
          },
          unread_only: {
            type: 'boolean',
            description: 'If true, only return unread messages.',
          },
          search: {
            type: 'string',
            description:
              'Case-insensitive substring matched against subject and sender.',
          },
          entry_id: {
            type: 'string',
            description:
              'If set, return the FULL body of this single message (use an entry_id from a previous list result) instead of a list.',
          },
          store_id: {
            type: 'string',
            description:
              'StoreId of the message identified by entry_id. Pass the StoreId from the list result so messages in an archive .pst (non-default store) can be opened. Only used with entry_id.',
          },
        },
        required: [],
      },
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ReadOutlookParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<ReadOutlookParams, ToolResult> {
    return new ReadOutlookInvocation(
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
