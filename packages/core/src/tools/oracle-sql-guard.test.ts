/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { validateSelectOnly, scrubSql } from './oracle-sql-guard.js';

describe('oracle-sql-guard: validateSelectOnly', () => {
  describe('allows read-only SELECT queries', () => {
    const allowed = [
      'SELECT * FROM users',
      'select id, name from emp where dept = 10',
      '  SELECT   sysdate FROM dual  ',
      'SELECT count(*) FROM orders;', // 끝 세미콜론 1개 허용
      'WITH t AS (SELECT 1 AS n FROM dual) SELECT n FROM t',
      "SELECT name FROM emp WHERE comment_text = 'please DELETE this row'", // 리터럴 내 키워드 무시
      "SELECT * FROM t WHERE note = 'a; DROP TABLE x'", // 리터럴 내 세미콜론/키워드 무시
      'SELECT /* inline comment with DROP */ id FROM t', // 주석 내 키워드 무시
      'SELECT id FROM t -- trailing DELETE comment',
      "SELECT q'[has ; and DROP inside]' AS v FROM dual", // q-quote
    ];
    for (const sql of allowed) {
      it(`allows: ${sql.slice(0, 50)}`, () => {
        const r = validateSelectOnly(sql);
        expect(r.ok).toBe(true);
      });
    }
  });

  describe('rejects non-SELECT and dangerous statements', () => {
    const rejected: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'whitespace'],
      ['INSERT INTO t VALUES (1)', 'insert'],
      ['UPDATE t SET a = 1', 'update'],
      ['DELETE FROM t', 'delete'],
      ['DELETE FROM t WHERE id = 1', 'delete where'],
      ['DROP TABLE t', 'drop'],
      ['TRUNCATE TABLE t', 'truncate'],
      ['ALTER TABLE t ADD c INT', 'alter'],
      ['CREATE TABLE t (a INT)', 'create'],
      ['CREATE TABLE t AS SELECT * FROM x', 'ctas'],
      ['GRANT SELECT ON t TO u', 'grant'],
      ['MERGE INTO t USING s ON (1=1)', 'merge'],
      ['BEGIN NULL; END;', 'plsql block'],
      ['DECLARE x INT; BEGIN NULL; END;', 'plsql declare'],
      ['SELECT * FROM t; DROP TABLE t', 'multi-statement'],
      ['SELECT * FROM t; SELECT * FROM y', 'multi select'],
      ['SELECT * FROM t FOR UPDATE', 'for update lock'],
      ["SELECT UTL_HTTP.request('http://x') FROM dual", 'utl package'],
      ['SELECT DBMS_RANDOM.value FROM dual', 'dbms package'],
      [
        'UPDATE t SET a=1 WHERE id IN (SELECT id FROM s)',
        'update w/ subselect',
      ],
      ['COMMIT', 'commit'],
      ['SET TRANSACTION READ WRITE', 'set'],
      ['EXEC some_proc', 'exec'],
      ['CALL some_proc()', 'call'],
      ['explain plan for select * from t', 'explain'],
      ['SELECT * INTO new_t FROM t', 'select into'],
    ];
    for (const [sql, label] of rejected) {
      it(`rejects: ${label}`, () => {
        const r = validateSelectOnly(sql);
        expect(r.ok).toBe(false);
        expect(r.reason).toBeTruthy();
      });
    }
  });

  it('non-string input is rejected', () => {
    // @ts-expect-error testing runtime guard
    expect(validateSelectOnly(null).ok).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(validateSelectOnly(undefined).ok).toBe(false);
  });
});

describe('oracle-sql-guard: scrubSql', () => {
  it('removes line comments', () => {
    expect(scrubSql('SELECT 1 -- DROP TABLE x\nFROM dual')).not.toMatch(/DROP/);
  });
  it('removes block comments', () => {
    expect(scrubSql('SELECT /* DELETE */ 1 FROM dual')).not.toMatch(/DELETE/);
  });
  it('removes single-quoted literals', () => {
    expect(scrubSql("SELECT 'DROP TABLE x' FROM dual")).not.toMatch(/DROP/);
  });
  it('handles escaped quotes in literals', () => {
    const out = scrubSql("SELECT 'it''s DROP fine' AS v FROM dual");
    expect(out).not.toMatch(/DROP/);
    expect(out).toMatch(/SELECT/);
    expect(out).toMatch(/FROM dual/);
  });
  it('removes double-quoted identifiers', () => {
    expect(scrubSql('SELECT "DROP" FROM t')).not.toMatch(/DROP/);
  });
});
