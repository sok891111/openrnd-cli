/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ============================================================================
 *  Oracle SELECT-only 가드레일 (Read-only SQL guard)
 * ============================================================================
 *
 * `oracle_query` 툴이 실행하기 전, 입력 SQL 이 **순수 SELECT 조회**인지 검증한다.
 * 어떤 경우에도 SELECT 외의 문장(INSERT/UPDATE/DELETE/DDL/PLSQL 등)은 통과시키지
 * 않는 것이 목표다. 방어는 다층으로 구성된다:
 *
 *   1) (여기) SQL 텍스트 정적 검증 — 문자열/주석을 제거한 뒤 키워드 스캔.
 *   2) (oracle-query.ts) `SET TRANSACTION READ ONLY` 로 세션을 읽기 전용 트랜잭션
 *      으로 고정하고 절대 commit 하지 않음 → DML 시도 시 Oracle 이 ORA-01456 에러.
 *
 * 이 모듈은 외부 의존성이 없는 순수 함수라 단위 테스트가 쉽다.
 */

export interface SqlGuardResult {
  ok: boolean;
  /** 정제(주석/리터럴 제거)된 SQL. 디버깅/로깅용. */
  scrubbed: string;
  /** 실패 사유 (ok=false 일 때만). */
  reason?: string;
}

/**
 * 절대 허용하지 않는 키워드. 단어 경계(\b)로 매칭한다. 문자열 리터럴/주석은
 * 미리 제거하므로 `WHERE name = 'DELETE'` 같은 값은 오탐하지 않는다.
 *
 * SELECT 조회에는 결코 필요 없는 토큰만 모았다. (예: SELECT 에 INTO 가 붙는 건
 * PL/SQL 이거나 CTAS 변형이므로 차단한다.)
 */
const FORBIDDEN_KEYWORDS = [
  // DML
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'INTO',
  // DDL
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'REPLACE',
  // 권한/감사
  'GRANT',
  'REVOKE',
  'AUDIT',
  'NOAUDIT',
  // 트랜잭션/세션 제어
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'SET',
  'LOCK',
  // 복구/저장공간
  'FLASHBACK',
  'PURGE',
  'ANALYZE',
  'EXPLAIN',
  // PL/SQL / 프로시저 실행
  'BEGIN',
  'DECLARE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'PRAGMA',
] as const;

/**
 * SQL 에서 주석과 리터럴을 공백으로 치환해 키워드 스캔용 텍스트를 만든다.
 * - 블록 주석 (slash-star ... star-slash)
 * - 라인 주석 `-- ...`
 * - 작은따옴표 문자열 `'...'` (`''` 이스케이프 포함)
 * - 큰따옴표 식별자 `"..."`
 * - Oracle q-quote `q'[...]'`, `q'{...}'`, `q'(...)'`, `q'<...>'`, `q'X...X'`
 *
 * 단순 상태 머신으로 처리한다. 정규식만으로는 중첩/이스케이프를 안전하게
 * 다루기 어렵기 때문이다.
 */
export function scrubSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  const matchingClose: Record<string, string> = {
    '[': ']',
    '{': '}',
    '(': ')',
    '<': '>',
  };

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // 라인 주석
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // 블록 주석
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // q-quote: q'X...X'  (X 가 ([{< 면 짝 닫힘 사용)
    if (
      (c === 'q' || c === 'Q') &&
      c2 === "'" &&
      i + 2 < n &&
      // N 접두어(nq'...')도 위 분기 전에 따로 처리되므로 여기선 q' 만.
      true
    ) {
      const opener = sql[i + 2];
      const closer = matchingClose[opener] ?? opener;
      i += 3;
      while (i < n && !(sql[i] === closer && sql[i + 1] === "'")) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // N 접두 문자열/q-quote: n'...' 또는 nq'...'
    if (c === 'n' || c === 'N') {
      if (c2 === "'") {
        // n'...' 로 처리되도록 아래 일반 작은따옴표 분기로 떨어뜨림.
        out += ' ';
        i += 1; // 접두 n 만 소비, 다음 루프에서 '...' 처리.
        continue;
      }
    }

    // 작은따옴표 문자열
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // 이스케이프된 ''
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // 큰따옴표 식별자
    if (c === '"') {
      i += 1;
      while (i < n && sql[i] !== '"') i++;
      i += 1;
      out += ' ';
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * SQL 이 단일 SELECT 조회인지 검증한다.
 *
 * 통과 조건(모두 만족):
 *  - 비어있지 않음
 *  - 정제 후 세미콜론으로 구분된 문장이 1개 이하 (다중 문장 금지)
 *  - SELECT 또는 WITH(=CTE) 로 시작
 *  - 금지 키워드 미포함
 *  - 위험 패키지(DBMS_/UTL_) 호출 미포함
 *  - `FOR UPDATE` (잠금) 미포함
 */
export function validateSelectOnly(rawSql: string): SqlGuardResult {
  if (typeof rawSql !== 'string') {
    return { ok: false, scrubbed: '', reason: 'SQL must be a string.' };
  }

  const trimmedRaw = rawSql.trim();
  if (!trimmedRaw) {
    return { ok: false, scrubbed: '', reason: 'SQL is empty.' };
  }

  // 키워드 스캔용 정제본.
  let scrubbed = scrubSql(rawSql).trim();

  // 끝의 세미콜론 1개는 허용하고 제거.
  scrubbed = scrubbed.replace(/;\s*$/, '').trim();

  if (!scrubbed) {
    return {
      ok: false,
      scrubbed,
      reason: 'SQL has no executable statement after removing comments.',
    };
  }

  // 남은 세미콜론이 있으면 다중 문장 → 거부.
  if (scrubbed.includes(';')) {
    return {
      ok: false,
      scrubbed,
      reason:
        'Multiple statements are not allowed. Provide a single SELECT query.',
    };
  }

  // 반드시 SELECT 또는 WITH(CTE) 로 시작.
  if (!/^\s*(SELECT|WITH)\b/i.test(scrubbed)) {
    return {
      ok: false,
      scrubbed,
      reason:
        'Only SELECT queries are allowed (must start with SELECT or WITH).',
    };
  }

  // 금지 키워드 스캔.
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(scrubbed)) {
      return {
        ok: false,
        scrubbed,
        reason: `Forbidden keyword detected: "${kw}". Only read-only SELECT queries are allowed.`,
      };
    }
  }

  // 위험 패키지(쓰기/시스템 부작용 가능) 차단.
  if (/\b(?:DBMS|UTL)_/i.test(scrubbed)) {
    return {
      ok: false,
      scrubbed,
      reason:
        'Calls to DBMS_*/UTL_* packages are not allowed (potential side effects).',
    };
  }

  // 행 잠금 의도 차단.
  if (/\bFOR\s+UPDATE\b/i.test(scrubbed)) {
    return {
      ok: false,
      scrubbed,
      reason: 'SELECT ... FOR UPDATE (row locking) is not allowed.',
    };
  }

  return { ok: true, scrubbed };
}
