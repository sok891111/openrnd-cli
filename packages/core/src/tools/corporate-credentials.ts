/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir, GEMINI_DIR } from '../utils/paths.js';

/**
 * 사내 fetch 핸들러용 API 키(자격증명) 저장소.
 *
 * - 저장 위치: ~/.openrnd/credentials.json (chmod 600, git 범위 밖)
 * - 형식: { "<시스템id>": "<api key>" }  예: { "jira": "abc123" }
 * - Python 핸들러에는 환경변수 `OPENRND_CRED_<시스템id>` 로 주입됩니다.
 *   (corporate-fetch.ts 가 디스패처를 spawn 할 때 주입)
 *
 * 키는 manage_credential 툴(프롬프트)로 등록/삭제합니다. 이 파일은 값(시크릿)을
 * 절대 로그로 남기지 않습니다.
 */

/** ~/.openrnd/credentials.json 경로. */
export function getCredentialsPath(): string {
  return path.join(homedir(), GEMINI_DIR, 'credentials.json');
}

/**
 * 시스템 id → 환경변수명. 핸들러가 읽을 변수명과 동일한 규칙이어야 한다.
 * 예: "jira" -> "OPENRND_CRED_JIRA", "wiki-corp" -> "OPENRND_CRED_WIKI_CORP".
 */
export function credentialEnvVar(systemId: string): string {
  const sanitized = systemId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `OPENRND_CRED_${sanitized}`;
}

/** 저장된 자격증명 전체를 읽는다(없으면 빈 객체). */
export function readCredentials(): Record<string, string> {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') {
          out[k] = v;
        }
      }
      return out;
    }
  } catch {
    // 손상된 파일은 빈 것으로 취급.
  }
  return {};
}

function writeCredentials(creds: Record<string, string>): void {
  const p = getCredentialsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // 기존 파일의 권한도 강제(최초 생성이 아니어도 600 보장). Windows 에선 무시됨.
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore (e.g. Windows)
  }
}

/** 시스템 키를 저장(있으면 덮어쓰기). */
export function setCredential(systemId: string, value: string): void {
  const creds = readCredentials();
  creds[systemId] = value;
  writeCredentials(creds);
}

/** 시스템 키를 삭제. 존재하면 true. */
export function removeCredential(systemId: string): boolean {
  const creds = readCredentials();
  if (!(systemId in creds)) {
    return false;
  }
  delete creds[systemId];
  writeCredentials(creds);
  return true;
}

/** 등록된 시스템 id 목록(값 제외). */
export function listCredentialIds(): string[] {
  return Object.keys(readCredentials());
}

/**
 * Python 디스패처에 주입할 환경변수 맵: `OPENRND_CRED_<ID>` = value.
 * corporate-fetch.ts 의 spawn env 에 합쳐집니다.
 */
export function getCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [id, value] of Object.entries(readCredentials())) {
    env[credentialEnvVar(id)] = value;
  }
  return env;
}
