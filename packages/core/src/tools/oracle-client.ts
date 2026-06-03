/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type OracleDbNS from 'oracledb';
import type { OracleConnectionProfile } from './oracle-connections.js';
import { validateSelectOnly } from './oracle-sql-guard.js';

/**
 * ============================================================================
 *  node-oracledb 얇은 래퍼 (read-only)
 * ============================================================================
 *
 * - `oracledb` 는 동적 import 한다. 미설치 시 CLI 전체가 죽지 않고, 이 툴을 쓸
 *   때만 친절한 에러를 낸다.
 * - node-oracledb 6+ 의 **Thin 모드**(기본값)는 Oracle Instant Client 없이
 *   순수 JS 로 동작한다.
 * - 읽기 전용 보장:
 *     1) 호출 전 SQL 가드(validateSelectOnly).
 *     2) 접속 직후 `SET TRANSACTION READ ONLY` → 같은 트랜잭션 내 DML 은 ORA-01456.
 *     3) autoCommit=false, 절대 commit() 호출하지 않음. 종료 시 rollback.
 */

/** 결과 행은 컬럼명 → 값 매핑. */
export type OracleRow = Record<string, unknown>;

export interface OracleQueryResult {
  columns: string[];
  rows: OracleRow[];
  rowCount: number;
  /** maxRows 제한으로 잘렸는지 여부. */
  truncated: boolean;
}

/**
 * oracledb 를 동적 import 한다. 미설치 시 친절한 에러로 변환한다.
 * 타입은 @types/oracledb 로 정적 확보(런타임에는 erase).
 */
async function loadOracleDb(): Promise<typeof OracleDbNS> {
  try {
    const mod = await import('oracledb');
    // CJS/ESM interop: default 또는 네임스페이스.
    return mod.default ?? mod;
  } catch {
    throw new Error(
      "Oracle 드라이버('oracledb')가 설치되어 있지 않습니다. " +
        '`npm install oracledb` 후 다시 시도하세요. (Thin 모드는 Instant Client 불필요)',
    );
  }
}

/**
 * 읽기 전용 SELECT 를 실행한다. SQL 가드를 통과하지 못하면 실행 전에 throw.
 */
export async function runReadOnlyQuery(
  profile: OracleConnectionProfile,
  sql: string,
  maxRows: number,
): Promise<OracleQueryResult> {
  const guard = validateSelectOnly(sql);
  if (!guard.ok) {
    throw new Error(`SQL guard rejected the query: ${guard.reason}`);
  }

  const oracledb = await loadOracleDb();
  const connection = await oracledb.getConnection({
    user: profile.user,
    password: profile.password,
    connectString: profile.connectString,
  });

  try {
    // 트랜잭션을 읽기 전용으로 고정. 이후 어떤 DML 도 ORA-01456 으로 거부됨.
    await connection.execute('SET TRANSACTION READ ONLY');

    // maxRows+1 로 가져와 truncated 여부 판단.
    const result = await connection.execute<OracleRow>(guard.scrubbed, [], {
      maxRows: maxRows + 1,
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    const allRows = result.rows ?? [];
    const truncated = allRows.length > maxRows;
    const rows = truncated ? allRows.slice(0, maxRows) : allRows;
    const columns = (result.metaData ?? []).map((m) => m.name);

    return { columns, rows, rowCount: rows.length, truncated };
  } finally {
    // 절대 commit 하지 않는다. 안전하게 rollback 후 종료.
    try {
      await connection.rollback();
    } catch {
      // ignore
    }
    try {
      await connection.close();
    } catch {
      // ignore
    }
  }
}

/** 접속 가능 여부만 확인한다(SELECT 1 FROM dual). */
export async function testConnection(
  profile: OracleConnectionProfile,
): Promise<void> {
  const oracledb = await loadOracleDb();
  const connection = await oracledb.getConnection({
    user: profile.user,
    password: profile.password,
    connectString: profile.connectString,
  });
  try {
    await connection.execute('SELECT 1 FROM dual');
  } finally {
    try {
      await connection.close();
    } catch {
      // ignore
    }
  }
}
