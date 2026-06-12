/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  setCredential,
  removeCredential,
  listCredentialIds,
  credentialEnvVar,
  getCredentialsPath,
} from './corporate-credentials.js';
import { listCorporateSystems } from './corporate-fetch.js';

export const MANAGE_CREDENTIAL_TOOL_NAME = 'manage_credential';
export const MANAGE_CREDENTIAL_DISPLAY_NAME = 'Manage Credential';

const MANAGE_CREDENTIAL_DESCRIPTION = `Manage API keys / credentials for corporate (사내) web fetch handlers.

Keys are stored locally in ~/.openwork/credentials.json (chmod 600, never committed to git)
and injected into the Python fetch handlers at runtime as environment variables
(OPENWORK_CRED_<SYSTEM>). The actual fetch logic lives in
packages/core/src/tools/corporate_fetchers/handlers/*.py.

Use this tool when the user says things like:
- "jira 키 등록해줘: abc123"
- "사내 위키 토큰 이걸로 설정해줘 ..."
- "등록된 키 목록 보여줘" / "어떤 시스템에 키가 필요해?"
- "jira 키 삭제해줘"

Actions:
- "list": Show known corporate systems (from the handlers) with their description and
  whether a key is already registered. NEVER reveals the secret value. Call this first
  when the user is unsure which system id to use.
- "set": Store a key for a system id. Requires "system" and "value".
- "remove": Delete a stored key. Requires "system".

IMPORTANT:
- Never print the secret "value" back to the user. Confirm with a masked value only.
- Match the user's wording (e.g. "지라"/"Jira") to the closest system id from "list".
- If the user gives a key but no clear system, run "list" and ask which system it is for.`;

interface ManageCredentialParams {
  action: 'set' | 'list' | 'remove';
  system?: string;
  value?: string;
}

const MANAGE_CREDENTIAL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'list', 'remove'],
      description:
        '"set" to store a key, "list" to show systems and registration status, "remove" to delete a key.',
    },
    system: {
      type: 'string',
      description:
        'System id (e.g. "jira"). Required for set/remove. Match it to an id from "list".',
    },
    value: {
      type: 'string',
      description:
        'The API key / token to store (required for "set"). This is secret — never echo it back.',
    },
  },
  required: ['action'],
};

function maskSecret(value: string): string {
  if (value.length <= 4) {
    return '*'.repeat(value.length);
  }
  return `${'*'.repeat(Math.min(value.length - 2, 8))}${value.slice(-2)}`;
}

class ManageCredentialInvocation extends BaseToolInvocation<
  ManageCredentialParams,
  ToolResult
> {
  constructor(params: ManageCredentialParams, messageBus: MessageBus) {
    super(
      params,
      messageBus,
      MANAGE_CREDENTIAL_TOOL_NAME,
      MANAGE_CREDENTIAL_DISPLAY_NAME,
    );
  }

  override getDescription(): string {
    const { action, system } = this.params;
    if (action === 'set') return `Register API key for: ${system ?? '(?)'}`;
    if (action === 'remove') return `Remove API key for: ${system ?? '(?)'}`;
    return 'List corporate systems and registered keys';
  }

  override async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const { action } = this.params;

    switch (action) {
      case 'list': {
        const [systems, registered] = await Promise.all([
          listCorporateSystems(abortSignal),
          Promise.resolve(listCredentialIds()),
        ]);
        const registeredSet = new Set(registered);

        const lines: string[] = [];
        if (systems.length === 0) {
          lines.push(
            '핸들러에서 선언된 시스템이 없습니다 (handlers/*.py 에 SYSTEM 메타데이터를 추가하면 여기에 표시됩니다).',
          );
        } else {
          lines.push('**사내 시스템 (handlers 기준):**');
          for (const s of systems) {
            const has = registeredSet.has(s.id);
            const mark = has ? '✅ 등록됨' : '⬜ 미등록';
            const name = s.name ? ` (${s.name})` : '';
            const desc = s.description ? `\n    ${s.description}` : '';
            lines.push(
              `- **${s.id}**${name} — ${mark} · env: \`${s.env}\`${desc}`,
            );
          }
        }

        // 핸들러는 없지만 키만 등록된 경우(고아 키)도 표시.
        const orphans = registered.filter(
          (id) => !systems.some((s) => s.id === id),
        );
        if (orphans.length > 0) {
          lines.push('');
          lines.push('**매칭 핸들러 없이 등록된 키:**');
          for (const id of orphans) {
            lines.push(
              `- **${id}** — ✅ 등록됨 · env: \`${credentialEnvVar(id)}\``,
            );
          }
        }

        lines.push('');
        lines.push(`저장 위치: ${getCredentialsPath()}`);
        const msg = lines.join('\n');
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'set': {
        const { system, value } = this.params;
        if (!system) {
          return {
            llmContent: 'Error: "system" is required for action "set".',
            returnDisplay: 'Error: system required',
            error: { message: 'system required' },
          };
        }
        if (!value) {
          return {
            llmContent: 'Error: "value" is required for action "set".',
            returnDisplay: 'Error: value required',
            error: { message: 'value required' },
          };
        }
        setCredential(system, value);
        const msg =
          `✅ **${system}** 키를 저장했습니다 (${maskSecret(value)}).\n` +
          `핸들러에는 환경변수 \`${credentialEnvVar(system)}\` 로 주입됩니다.\n` +
          `저장 위치: ${getCredentialsPath()}`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'remove': {
        const { system } = this.params;
        if (!system) {
          return {
            llmContent: 'Error: "system" is required for action "remove".',
            returnDisplay: 'Error: system required',
            error: { message: 'system required' },
          };
        }
        const removed = removeCredential(system);
        const msg = removed
          ? `✅ **${system}** 키를 삭제했습니다.`
          : `**${system}** 에 등록된 키가 없습니다.`;
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

export class ManageCredentialTool extends BaseDeclarativeTool<
  ManageCredentialParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      MANAGE_CREDENTIAL_TOOL_NAME,
      MANAGE_CREDENTIAL_DISPLAY_NAME,
      MANAGE_CREDENTIAL_DESCRIPTION,
      Kind.Other,
      MANAGE_CREDENTIAL_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ManageCredentialParams,
    messageBus: MessageBus,
  ): ToolInvocation<ManageCredentialParams, ToolResult> {
    return new ManageCredentialInvocation(params, messageBus);
  }
}
