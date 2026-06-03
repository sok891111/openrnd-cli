/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolConfirmationOutcome,
  type ToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolExecuteConfirmationDetails,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { getOracleConnection } from './oracle-connections.js';
import { validateSelectOnly } from './oracle-sql-guard.js';
import { runReadOnlyQuery, type OracleQueryResult } from './oracle-client.js';

export const ORACLE_QUERY_TOOL_NAME = 'oracle_query';
export const ORACLE_QUERY_DISPLAY_NAME = 'Oracle Query (SELECT-only)';

const DEFAULT_MAX_ROWS = 100;
const HARD_MAX_ROWS = 1000;

const DESCRIPTION = `Run a **read-only SELECT** query against a registered Oracle DB connection.

접속 정보는 'manage_oracle_connection' 툴로 미리 등록한 별칭(alias)을 사용한다.
어떤 경우에도 SELECT 조회만 가능하다. INSERT/UPDATE/DELETE 같은 DML 과
DROP/TRUNCATE/ALTER/CREATE 같은 DDL, PL/SQL 블록, 다중 문장, DBMS_*/UTL_* 호출,
SELECT ... FOR UPDATE 는 실행 전에 거부된다(다층 가드레일).

추가로 접속 후 'SET TRANSACTION READ ONLY' 로 트랜잭션을 읽기 전용으로 고정하고
절대 commit 하지 않으므로, 만약 가드를 우회하는 변형이 있더라도 DB 레벨에서
쓰기가 차단된다.

사용 예:
  - "오라클 prod 에서 사용자 테이블 상위 10건 조회해줘"
  - "prod 접속으로 SELECT count(*) FROM orders 실행"

파라미터:
  - connection: manage_oracle_connection 에 등록한 별칭.
  - sql: 실행할 SELECT 문 (단일 문장).
  - max_rows: 최대 반환 행 수 (기본 ${DEFAULT_MAX_ROWS}, 최대 ${HARD_MAX_ROWS}).`;

interface OracleQueryParams {
  connection: string;
  sql: string;
  max_rows?: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    connection: {
      type: 'string',
      description: 'manage_oracle_connection 에 등록한 접속 별칭(alias).',
    },
    sql: {
      type: 'string',
      description:
        '실행할 단일 SELECT 문. SELECT/WITH 로 시작해야 하며 DML/DDL/PLSQL 불가.',
    },
    max_rows: {
      type: 'number',
      description: `최대 반환 행 수 (기본 ${DEFAULT_MAX_ROWS}, 최대 ${HARD_MAX_ROWS}).`,
    },
  },
  required: ['connection', 'sql'],
};

/** 결과를 사람이 보기 좋은 마크다운 표로 렌더링(긴 값은 잘라서). */
function renderTable(result: OracleQueryResult, maxColWidth = 40): string {
  const { columns, rows } = result;
  if (columns.length === 0) {
    return '(no columns)';
  }
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '(null)';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    s = s.replace(/\r?\n/g, ' ');
    if (s.length > maxColWidth) s = `${s.slice(0, maxColWidth)}…`;
    return s.replace(/\|/g, '\\|');
  };

  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((row) => `| ${columns.map((c) => cell(row[c])).join(' | ')} |`)
    .join('\n');
  return [header, sep, body].filter(Boolean).join('\n');
}

class OracleQueryInvocation extends BaseToolInvocation<
  OracleQueryParams,
  ToolResult
> {
  constructor(params: OracleQueryParams, messageBus: MessageBus) {
    super(
      params,
      messageBus,
      ORACLE_QUERY_TOOL_NAME,
      ORACLE_QUERY_DISPLAY_NAME,
    );
  }

  override getDescription(): string {
    const sql = this.params.sql.trim().replace(/\s+/g, ' ');
    const preview = sql.length > 120 ? `${sql.slice(0, 120)}…` : sql;
    return `[${this.params.connection}] ${preview}`;
  }

  override getDisplayTitle(): string {
    return `oracle_query: ${this.params.connection}`;
  }

  override async shouldConfirmExecute(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    void abortSignal;
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Run SELECT on Oracle [${this.params.connection}]`,
      command: this.params.sql.slice(0, 500),
      rootCommand: 'oracle_query',
      rootCommands: ['oracle_query'],
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        await this.publishPolicyUpdate(outcome);
      },
    };
    return details;
  }

  override async execute(_opts: ExecuteOptions): Promise<ToolResult> {
    const { connection, sql } = this.params;
    const maxRows = Math.min(
      Math.max(1, this.params.max_rows ?? DEFAULT_MAX_ROWS),
      HARD_MAX_ROWS,
    );

    // 1차 가드: 실행 전 정적 검증(친절한 에러용). 클라이언트가 한 번 더 검증한다.
    const guard = validateSelectOnly(sql);
    if (!guard.ok) {
      const msg = `❌ 거부됨 (SELECT 전용 가드레일): ${guard.reason}`;
      return { llmContent: msg, returnDisplay: msg, error: { message: msg } };
    }

    const profile = getOracleConnection(connection);
    if (!profile) {
      const msg = `❌ 접속 별칭 **${connection}** 을(를) 찾을 수 없습니다. manage_oracle_connection 으로 먼저 등록하세요.`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: `connection not found: ${connection}` },
      };
    }

    try {
      const result = await runReadOnlyQuery(profile, sql, maxRows);
      const table = renderTable(result);
      const note = result.truncated
        ? `\n\n_(상위 ${maxRows}행만 표시 — 더 있을 수 있음. max_rows 로 조정)_`
        : '';
      const summary = `✅ ${result.rowCount}행 반환 (connection: ${connection})`;
      const display = `${summary}\n\n${table}${note}`;
      // LLM 에는 구조화 데이터도 함께 제공.
      const llmContent = JSON.stringify(
        {
          connection,
          rowCount: result.rowCount,
          truncated: result.truncated,
          columns: result.columns,
          rows: result.rows,
        },
        null,
        2,
      );
      return { llmContent, returnDisplay: display };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `❌ 조회 실패 (${connection}): ${reason}`;
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: { message: reason },
      };
    }
  }
}

export class OracleQueryTool extends BaseDeclarativeTool<
  OracleQueryParams,
  ToolResult
> {
  constructor(messageBus: MessageBus) {
    super(
      ORACLE_QUERY_TOOL_NAME,
      ORACLE_QUERY_DISPLAY_NAME,
      DESCRIPTION,
      Kind.Read,
      SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected createInvocation(
    params: OracleQueryParams,
    messageBus: MessageBus,
  ): ToolInvocation<OracleQueryParams, ToolResult> {
    return new OracleQueryInvocation(params, messageBus);
  }
}
