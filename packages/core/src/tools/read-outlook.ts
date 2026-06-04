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
  [string]$EntryId = ''
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
  $item = $ns.GetItemFromID($EntryId)
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
$target = Resolve-Folder -Namespace $ns -Spec $Folder
$items = $target.Items
$items.Sort('[ReceivedTime]', $true)
if ($UnreadOnly) {
  $items = $items.Restrict('[Unread] = true')
  $items.Sort('[ReceivedTime]', $true)
}

$cutoff = if ($SinceDays -gt 0) { (Get-Date).AddDays(-$SinceDays) } else { $null }
$searchLower = ([string]$Search).ToLowerInvariant()

$results = New-Object System.Collections.ArrayList
$item = $items.GetFirst()
while ($null -ne $item) {
  $isMail = $true
  try { $null = $item.ReceivedTime } catch { $isMail = $false }
  if ($isMail) {
    $received = $item.ReceivedTime
    $passDate = (-not $cutoff) -or ($received -ge $cutoff)
    if (-not $passDate) { break }

    $senderName = [string]$item.SenderName
    $senderEmail = [string](Get-SenderEmail -Item $item)
    $subject = [string]$item.Subject

    $passSearch = $true
    if ($searchLower -ne '') {
      $hay = ("$subject $senderName $senderEmail").ToLowerInvariant()
      $passSearch = $hay.Contains($searchLower)
    }

    if ($passSearch) {
      $body = [string]$item.Body
      if ($null -eq $body) { $body = '' }
      $preview = if ($body.Length -gt $BodyPreviewLength) { $body.Substring(0, $BodyPreviewLength) } else { $body }
      $null = $results.Add([ordered]@{
        EntryId        = $item.EntryID
        Subject        = $subject
        SenderName     = $senderName
        SenderEmail    = $senderEmail
        ReceivedTime   = $received.ToString('yyyy-MM-dd HH:mm:ss')
        To             = [string]$item.To
        Cc             = [string]$item.CC
        Unread         = [bool]$item.UnRead
        Importance     = [int]$item.Importance
        HasAttachments = ($item.Attachments.Count -gt 0)
        FolderPath     = [string]$target.FolderPath
        BodyPreview    = $preview
      })
      if ($results.Count -ge $Count) { break }
    }
  }
  $item = $items.GetNext()
}
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
    bits.push(this.params.folder ? `folder "${this.params.folder}"` : 'Inbox');
    if (this.params.unread_only) bits.push('unread only');
    if (this.params.since_days) bits.push(`last ${this.params.since_days}d`);
    if (this.params.search) bits.push(`search "${this.params.search}"`);
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
      return args;
    }
    args.push('-Folder', p.folder && p.folder.trim() ? p.folder : 'Inbox');
    args.push('-Count', String(p.count && p.count > 0 ? p.count : 20));
    if (p.since_days && p.since_days > 0) {
      args.push('-SinceDays', String(p.since_days));
    }
    if (p.search) args.push('-Search', p.search);
    if (p.unread_only) args.push('-UnreadOnly');
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
        'It is strictly read-only and never sends, replies, moves, or modifies mail.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description:
              'Folder to read: a well-known name (Inbox, SentItems, Drafts, DeletedItems, Outbox, Junk) or a path under the default store using "/" (e.g. "Inbox/Team"). Default: Inbox. Ignored when entry_id is set.',
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
