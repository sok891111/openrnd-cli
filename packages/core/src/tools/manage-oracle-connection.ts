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
  setOracleConnection,
  removeOracleConnection,
  getOracleConnection,
  readOracleConnections,
  getOracleConnectionsPath,
} from './oracle-connections.js';
import { testConnection } from './oracle-client.js';

export const MANAGE_ORACLE_CONNECTION_TOOL_NAME = 'manage_oracle_connection';
export const MANAGE_ORACLE_CONNECTION_DISPLAY_NAME = 'Manage Oracle Connection';

const DESCRIPTION = `Manage Oracle DB connection profiles (TNS 접속 정보).

사용자가 사내 Oracle DB 의 TNS 접속 정보를 등록/조회/삭제/연결테스트 한다.
등록된 정보는 ~/.openrnd/oracle-connections.json (chmod 600, git 범위 밖)에 저장되며,
비밀번호는 화면에 마스킹되어 표시된다. 실제 조회는 별도의 'oracle_query' 툴이 한다.

각 접속은 별칭(alias)으로 식별한다. connectString 에는 다음 중 무엇이든 가능:
  - tnsnames.ora 의 풀 디스크립터: (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=...)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=...)))
  - Easy Connect 문자열:           host:1521/service_name
  - TNS_ADMIN 설정 시 net service name: MYDB

다음과 같은 요청에 사용:
  - "오라클 prod 접속 등록해줘: user=scott password=tiger tns=(DESCRIPTION=...)"
  - "등록된 오라클 접속 목록 보여줘"
  - "오라클 prod 연결 잘 되는지 테스트해줘"
  - "오라클 dev 접속 삭제해줘"

Actions:
  - "set":    별칭으로 접속 저장. alias, user, password, connect_string 필요.
  - "list":   등록된 별칭/계정/connectString 표시(비밀번호는 마스킹).
  - "remove": 별칭으로 삭제. alias 필요.
  - "test":   실제 접속해 SELECT 1 FROM dual 로 연결 확인. alias 필요.

IMPORTANT:
  - 비밀번호(password)는 절대 사용자에게 다시 출력하지 말 것. 마스킹된 값만 확인.
  - 별칭이 모호하면 먼저 "list" 로 확인.`;

interface ManageOracleConnectionParams {
  action: 'set' | 'list' | 'remove' | 'test';
  alias?: string;
  user?: string;
  password?: string;
  connect_string?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'list', 'remove', 'test'],
      description: '"set" 저장, "list" 목록, "remove" 삭제, "test" 연결 확인.',
    },
    alias: {
      type: 'string',
      description: '접속 별칭 (예: "prod"). set/remove/test 에 필요.',
    },
    user: {
      type: 'string',
      description: 'DB 계정 (set 에 필요).',
    },
    password: {
      type: 'string',
      description:
        'DB 비밀번호 (set 에 필요). secret — 절대 다시 출력하지 말 것.',
    },
    connect_string: {
      type: 'string',
      description:
        'TNS 디스크립터 / Easy Connect / net service name (set 에 필요).',
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

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

class ManageOracleConnectionInvocation extends BaseToolInvocation<
  ManageOracleConnectionParams,
  ToolResult
> {
  constructor(params: ManageOracleConnectionParams, messageBus: MessageBus) {
    super(
      params,
      messageBus,
      MANAGE_ORACLE_CONNECTION_TOOL_NAME,
      MANAGE_ORACLE_CONNECTION_DISPLAY_NAME,
    );
  }

  override getDescription(): string {
    const { action, alias } = this.params;
    if (action === 'set')
      return `Register Oracle connection: ${alias ?? '(?)'}`;
    if (action === 'remove')
      return `Remove Oracle connection: ${alias ?? '(?)'}`;
    if (action === 'test') return `Test Oracle connection: ${alias ?? '(?)'}`;
    return 'List Oracle connections';
  }

  override async execute(_opts: ExecuteOptions): Promise<ToolResult> {
    const { action } = this.params;

    switch (action) {
      case 'list': {
        const store = readOracleConnections();
        const aliases = Object.keys(store);
        const lines: string[] = [];
        if (aliases.length === 0) {
          lines.push('등록된 Oracle 접속이 없습니다. `set` 으로 추가하세요.');
        } else {
          lines.push('**등록된 Oracle 접속:**');
          for (const alias of aliases) {
            const p = store[alias];
            lines.push(
              `- **${alias}** — user: \`${p.user}\` · pw: \`${maskSecret(
                p.password,
              )}\`\n    connectString: \`${truncate(p.connectString)}\``,
            );
          }
        }
        lines.push('');
        lines.push(`저장 위치: ${getOracleConnectionsPath()}`);
        const msg = lines.join('\n');
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'set': {
        const { alias, user, password, connect_string } = this.params;
        const missing = [
          !alias && 'alias',
          !user && 'user',
          !password && 'password',
          !connect_string && 'connect_string',
        ].filter(Boolean);
        if (missing.length > 0) {
          const msg = `Error: missing required field(s) for "set": ${missing.join(
            ', ',
          )}`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
        setOracleConnection(alias!, {
          user: user!,
          password: password!,
          connectString: connect_string!,
        });
        const msg =
          `✅ Oracle 접속 **${alias}** 저장 완료.\n` +
          `- user: \`${user}\` · pw: \`${maskSecret(password!)}\`\n` +
          `- connectString: \`${truncate(connect_string!)}\`\n` +
          `저장 위치: ${getOracleConnectionsPath()}\n` +
          `연결 확인은 \`test\` action 으로 하세요.`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'remove': {
        const { alias } = this.params;
        if (!alias) {
          const msg = 'Error: "alias" is required for action "remove".';
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
        const removed = removeOracleConnection(alias);
        const msg = removed
          ? `✅ Oracle 접속 **${alias}** 삭제 완료.`
          : `**${alias}** 에 해당하는 접속이 없습니다.`;
        return { llmContent: msg, returnDisplay: msg };
      }

      case 'test': {
        const { alias } = this.params;
        if (!alias) {
          const msg = 'Error: "alias" is required for action "test".';
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: msg },
          };
        }
        const profile = getOracleConnection(alias);
        if (!profile) {
          const msg = `**${alias}** 접속을 찾을 수 없습니다. 먼저 \`set\` 으로 등록하세요.`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: `connection not found: ${alias}` },
          };
        }
        try {
          await testConnection(profile);
          const msg = `✅ Oracle 접속 **${alias}** 연결 성공.`;
          return { llmContent: msg, returnDisplay: msg };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const msg = `❌ Oracle 접속 **${alias}** 연결 실패: ${reason}`;
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: { message: reason },
          };
        }
      }

      default: {
        const exhaustive: never = action;
        const msg = `Unknown action: ${String(exhaustive)}`;
        return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
      }
    }
  }
}

export class ManageOracleConnectionTool extends BaseDeclarativeTool<
  ManageOracleConnectionParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      MANAGE_ORACLE_CONNECTION_TOOL_NAME,
      MANAGE_ORACLE_CONNECTION_DISPLAY_NAME,
      DESCRIPTION,
      Kind.Other,
      SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: ManageOracleConnectionParams,
    messageBus: MessageBus,
  ): ToolInvocation<ManageOracleConnectionParams, ToolResult> {
    return new ManageOracleConnectionInvocation(params, messageBus);
  }
}
