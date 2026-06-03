/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir, GEMINI_DIR } from '../utils/paths.js';

/**
 * ============================================================================
 *  Oracle DB 접속 정보(TNS) 저장소
 * ============================================================================
 *
 * - 저장 위치: ~/.openrnd/oracle-connections.json (chmod 600, git 범위 밖)
 * - 사용자가 TNS 정보를 등록하면 그 정보로 DB 에 접속해 **SELECT 조회만** 수행한다.
 * - 비밀번호(secret)는 절대 로그/화면에 그대로 노출하지 않는다(마스킹).
 *
 * 각 항목은 별칭(alias) → 접속 프로필이다:
 *   {
 *     "prod": {
 *       "user": "scott",
 *       "password": "tiger",
 *       "connectString": "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=...)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=...)))"
 *     }
 *   }
 *
 * connectString 에는 다음 중 무엇이든 넣을 수 있다(node-oracledb 가 그대로 사용):
 *   - tnsnames.ora 의 풀 디스크립터:  (DESCRIPTION=(ADDRESS=...)(CONNECT_DATA=...))
 *   - Easy Connect 문자열:            host:1521/service_name
 *   - TNS_ADMIN 의 net service name:  MYDB  (TNS_ADMIN 환경변수 설정 시)
 */

export interface OracleConnectionProfile {
  /** DB 계정. */
  user: string;
  /** DB 비밀번호 (secret). */
  password: string;
  /** TNS 디스크립터 / Easy Connect / net service name. */
  connectString: string;
}

type ConnectionStore = Record<string, OracleConnectionProfile>;

/** ~/.openrnd/oracle-connections.json 경로. */
export function getOracleConnectionsPath(): string {
  return path.join(homedir(), GEMINI_DIR, 'oracle-connections.json');
}

/** 저장된 접속 프로필 전체를 읽는다(없으면 빈 객체). */
export function readOracleConnections(): ConnectionStore {
  const p = getOracleConnectionsPath();
  if (!fs.existsSync(p)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      const out: ConnectionStore = {};
      for (const [alias, v] of Object.entries(parsed)) {
        if (!v || typeof v !== 'object') {
          continue;
        }
        // 문자열 필드만 추려 담는다(중첩 객체에서 안전 추출).
        const fields: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) {
          if (typeof val === 'string') {
            fields[k] = val;
          }
        }
        if (
          'user' in fields &&
          'password' in fields &&
          'connectString' in fields
        ) {
          out[alias] = {
            user: fields['user'],
            password: fields['password'],
            connectString: fields['connectString'],
          };
        }
      }
      return out;
    }
  } catch {
    // 손상된 파일은 빈 것으로 취급.
  }
  return {};
}

function writeOracleConnections(store: ConnectionStore): void {
  const p = getOracleConnectionsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // 기존 파일이어도 600 보장(Windows 에선 무시됨).
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore (e.g. Windows)
  }
}

/** 접속 프로필을 저장(있으면 덮어쓰기). */
export function setOracleConnection(
  alias: string,
  profile: OracleConnectionProfile,
): void {
  const store = readOracleConnections();
  store[alias] = profile;
  writeOracleConnections(store);
}

/** 접속 프로필을 삭제. 존재하면 true. */
export function removeOracleConnection(alias: string): boolean {
  const store = readOracleConnections();
  if (!(alias in store)) {
    return false;
  }
  delete store[alias];
  writeOracleConnections(store);
  return true;
}

/** 별칭으로 접속 프로필을 가져온다(없으면 undefined). */
export function getOracleConnection(
  alias: string,
): OracleConnectionProfile | undefined {
  return readOracleConnections()[alias];
}

/** 등록된 별칭 목록. */
export function listOracleConnectionAliases(): string[] {
  return Object.keys(readOracleConnections());
}
