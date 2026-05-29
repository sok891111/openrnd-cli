/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { Storage } from '../config/storage.js';

export const MANAGE_MCP_TOOL_NAME = 'manage_mcp';
export const MANAGE_MCP_DISPLAY_NAME = 'Manage MCP';

const MANAGE_MCP_DESCRIPTION = `Manage MCP (Model Context Protocol) servers — add, remove, or list configured servers.
The configuration is written to the user-level settings file (~/.openrnd/settings.json).

Use this tool when the user says things like:
- "MCP 서버 추가해줘"
- "Add this MCP server: ..."
- "xxx MCP를 연결해줘"
- "MCP 목록 보여줘"
- "xxx MCP 서버 삭제해줘"

After adding or removing a server, tell the user to restart openrnd (or type /mcp refresh in interactive mode) to apply the change.

Transport types:
- "stdio": Runs a local command (e.g. npx, uvx, python). Requires "command" and optionally "args".
- "http": HTTP/SSE endpoint. Requires "url".
- "sse": SSE endpoint. Requires "url".`;

interface ManageMcpParams {
  action: 'add' | 'remove' | 'list';
  name?: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  description?: string;
  trust?: boolean;
  scope?: 'user' | 'workspace';
}

const MANAGE_MCP_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'remove', 'list'],
      description:
        '"add" to register a new server, "remove" to delete one, "list" to show all configured servers.',
    },
    name: {
      type: 'string',
      description: 'Server identifier (required for add/remove).',
    },
    transport: {
      type: 'string',
      enum: ['stdio', 'http', 'sse'],
      description:
        'Transport type. Use "stdio" for local commands, "http" or "sse" for remote URLs. Defaults to "stdio" when command is given, "http" when url is given.',
    },
    command: {
      type: 'string',
      description:
        'Executable to run (stdio transport). Example: "npx", "uvx", "python".',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments to pass to the command.',
    },
    url: {
      type: 'string',
      description: 'Server URL (http or sse transport).',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'Environment variables to set for the server process (stdio only).',
    },
    description: {
      type: 'string',
      description: 'Human-readable description for this server.',
    },
    trust: {
      type: 'boolean',
      description:
        'If true, tool calls from this server auto-approve without confirmation prompts.',
    },
    scope: {
      type: 'string',
      enum: ['user', 'workspace'],
      description:
        'Where to save the config. "user" = ~/.openrnd/settings.json (default), "workspace" = .openrnd/settings.json in current directory.',
    },
  },
  required: ['action'],
};

// ---------------------------------------------------------------------------
// Settings file helpers (minimal, no dependency on CLI package)
// ---------------------------------------------------------------------------

function getSettingsPath(scope: 'user' | 'workspace'): string {
  if (scope === 'workspace') {
    return path.join(process.cwd(), '.openrnd', 'settings.json');
  }
  return Storage.getGlobalSettingsPath();
}

function readSettingsJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettingsJson(
  filePath: string,
  data: Record<string, unknown>,
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class ManageMcpInvocation extends BaseToolInvocation<
  ManageMcpParams,
  ToolResult
> {
  constructor(params: ManageMcpParams, messageBus: MessageBus) {
    super(params, messageBus, MANAGE_MCP_TOOL_NAME, MANAGE_MCP_DISPLAY_NAME);
  }

  override getDescription(): string {
    const { action, name } = this.params;
    if (action === 'add') return `Add MCP server: ${name ?? '(unnamed)'}`;
    if (action === 'remove') return `Remove MCP server: ${name ?? '(unnamed)'}`;
    return 'List MCP servers';
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const { action, name, scope = 'user' } = this.params;
    const settingsPath = getSettingsPath(scope);

    switch (action) {
      case 'list': {
        const settings = readSettingsJson(settingsPath);
        const servers = (settings['mcpServers'] ?? {}) as Record<
          string,
          unknown
        >;
        const entries = Object.entries(servers);
        if (entries.length === 0) {
          const msg = `No MCP servers configured (${scope} scope: ${settingsPath})`;
          return { llmContent: msg, returnDisplay: msg };
        }
        const lines = entries.map(([n, cfg]) => {
          const c = cfg as Record<string, unknown>;
          const detail = c['command']
            ? `stdio: ${String(c['command'])} ${((c['args'] as string[]) ?? []).join(' ')}`
            : `url: ${String(c['url'] ?? c['httpUrl'] ?? '')}`;
          return `- **${n}**: ${detail}${c['description'] ? ` — ${String(c['description'])}` : ''}`;
        });
        const msg = `**Configured MCP servers (${scope}):**\n${lines.join('\n')}`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'add': {
        if (!name) {
          return {
            llmContent: 'Error: "name" is required for action "add".',
            returnDisplay: 'Error: name required',
            error: { message: 'name required' },
          };
        }

        const { transport, command, args, url, env, description, trust } =
          this.params;

        // Auto-detect transport
        const resolvedTransport = transport ?? (url ? 'http' : 'stdio');

        let serverConfig: Record<string, unknown> = {};
        if (resolvedTransport === 'stdio') {
          if (!command) {
            return {
              llmContent: 'Error: "command" is required for stdio transport.',
              returnDisplay: 'Error: command required for stdio',
              error: { message: 'command required for stdio' },
            };
          }
          serverConfig = { command, args, env };
        } else {
          if (!url) {
            return {
              llmContent: 'Error: "url" is required for http/sse transport.',
              returnDisplay: 'Error: url required',
              error: { message: 'url required for http/sse' },
            };
          }
          serverConfig = { url, type: resolvedTransport };
        }

        if (description) serverConfig['description'] = description;
        if (trust !== undefined) serverConfig['trust'] = trust;
        // Strip undefined values
        Object.keys(serverConfig).forEach((k) => {
          if (serverConfig[k] === undefined) delete serverConfig[k];
        });

        const settings = readSettingsJson(settingsPath);
        const servers = (settings['mcpServers'] ?? {}) as Record<
          string,
          unknown
        >;
        const isUpdate = !!servers[name];
        servers[name] = serverConfig;
        settings['mcpServers'] = servers;
        writeSettingsJson(settingsPath, settings);

        const msg = isUpdate
          ? `✅ MCP server **${name}** updated in ${scope} settings (${settingsPath}).\n\nRestart openrnd to apply the change.`
          : `✅ MCP server **${name}** added to ${scope} settings (${settingsPath}).\n\nRestart openrnd to apply the change.`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'remove': {
        if (!name) {
          return {
            llmContent: 'Error: "name" is required for action "remove".',
            returnDisplay: 'Error: name required',
            error: { message: 'name required' },
          };
        }
        const settings = readSettingsJson(settingsPath);
        const servers = (settings['mcpServers'] ?? {}) as Record<
          string,
          unknown
        >;
        if (!servers[name]) {
          const msg = `MCP server "${name}" not found in ${scope} settings.`;
          return { llmContent: msg, returnDisplay: msg };
        }
        delete servers[name];
        settings['mcpServers'] = servers;
        writeSettingsJson(settingsPath, settings);
        const msg = `✅ MCP server **${name}** removed from ${scope} settings.\n\nRestart openrnd to apply the change.`;
        return { llmContent: msg, returnDisplay: msg };
      }
      default: {
        const exhaustive: never = action;
        return {
          llmContent: `Unknown action: ${String(exhaustive)}`,
          returnDisplay: `Unknown action: ${String(exhaustive)}`,
          error: { message: `Unknown action: ${String(exhaustive)}` },
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class ManageMcpTool extends BaseDeclarativeTool<
  ManageMcpParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      MANAGE_MCP_TOOL_NAME,
      MANAGE_MCP_DISPLAY_NAME,
      MANAGE_MCP_DESCRIPTION,
      Kind.Other,
      MANAGE_MCP_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ManageMcpParams,
    messageBus: MessageBus,
  ): ToolInvocation<ManageMcpParams, ToolResult> {
    return new ManageMcpInvocation(params, messageBus);
  }
}
