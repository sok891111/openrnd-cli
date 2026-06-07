/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCredentialEnv } from './corporate-credentials.js';

/**
 * ============================================================================
 *  사내 URL별 Fetch (Corporate per-URL fetch) — Python 기반
 * ============================================================================
 *
 * web_fetch 의 fallback 순서:
 *
 *   1) 일반 web fetch (서버사이드 HTTP fetch)
 *   2) 사내 URL별 fetch  ← ★ Python 으로 구현합니다 ★
 *   3) 로그인된 브라우저 세션으로 열기
 *
 * 이 TS 파일은 **얇은 브리지**입니다. 실제 사내 fetch 로직은 전부 Python 으로
 * 작성하며, 아래 디렉터리에서 git 으로 관리됩니다:
 *
 *   packages/core/src/tools/corporate_fetchers/
 *   ├── dispatch.py            ← 디스패처(거의 손댈 일 없음)
 *   └── handlers/
 *       ├── sample_naver_market.py
 *       └── <도메인>.py        ← ★ 여기에 URL별 핸들러를 하나씩 추가 ★
 *
 * URL별로 파일이 분리되어 있어 여러 명이 각자 핸들러 파일만 추가/수정하면 되고,
 * 중앙 파일을 함께 고칠 일이 없어 머지 충돌이 나지 않습니다.
 *
 * 동작: 1) web fetch 가 실패/SSO 벽에 막히면 web-fetch.ts 가 이 브리지를
 * 호출 → 이 브리지가 dispatch.py 를 실행(URL 을 stdin 으로 전달) → dispatch.py
 * 가 handlers/ 의 핸들러 중 매칭되는 것을 찾아 본문을 stdout 으로 출력 → 그
 * 본문이 비어있지 않으면 성공(브라우저 폴백 생략), 비어있으면 3) 브라우저.
 *
 * (참고) 이 파일의 `CorporateFetchHandler` 인터페이스는 그대로 두므로, 필요하면
 * Python 대신 TS 핸들러를 `corporateFetchHandlers` 배열에 추가할 수도 있습니다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 디스패처 timeout. 사내 시스템 응답이 느리면 늘리세요. */
const DISPATCH_TIMEOUT_MS = 30000;

/**
 * 핸들러 실행 시 넘겨주는 컨텍스트.
 * - `signal`  : 취소(Abort) 신호.
 * - `emitInfo`: 대화 터미널에 한 줄 로그를 출력.
 */
export interface CorporateFetchContext {
  signal: AbortSignal;
  emitInfo(message: string): void;
}

/**
 * (선택) TS 로 직접 핸들러를 작성하고 싶을 때 쓰는 인터페이스.
 * 기본 워크플로는 Python 이며, 이 인터페이스는 호환용으로 유지됩니다.
 */
export interface CorporateFetchHandler {
  name: string;
  canHandle(url: URL): boolean;
  fetch(url: string, ctx: CorporateFetchContext): Promise<string>;
}

/** 어떤 핸들러가 성공했는지와 가져온 본문. */
export interface CorporateFetchSuccess {
  handlerName: string;
  text: string;
}

/** OS 별 Python 실행 파일 (python-exec 와 동일 규칙). */
function detectPythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

let cachedDispatcherPath: string | null | undefined;

/**
 * dispatch.py 의 실제 위치를 찾는다.
 * - 번들 실행: `bundle/corporate_fetchers/dispatch.py` (__dirname === bundle/)
 * - dev(tsc): `packages/core/src/tools/corporate_fetchers/dispatch.py`
 * - 테스트(소스): 위와 동일 경로
 * 못 찾으면 null → 브리지는 동작하지 않고 곧장 브라우저 폴백으로 넘어감.
 */
function resolveDispatcherPath(): string | null {
  if (cachedDispatcherPath !== undefined) {
    return cachedDispatcherPath;
  }
  const candidates = [
    // 번들: corporate-fetch 가 bundle/gemini.js 로 합쳐져 __dirname === bundle/
    path.resolve(__dirname, 'corporate_fetchers', 'dispatch.py'),
    // dev: __dirname === packages/core/dist/src/tools → 소스 트리로 거슬러 올라감
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'tools',
      'corporate_fetchers',
      'dispatch.py',
    ),
  ];
  cachedDispatcherPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  return cachedDispatcherPath;
}

/**
 * dispatch.py 를 실행하고 stdout(본문)을 반환한다.
 * - URL 은 **stdin** 으로 전달 (argv 인젝션 방지).
 * - Python 의 **stderr 한 줄** 은 터미널 로그로 그대로 전달 → 핸들러에서
 *   `print(..., file=sys.stderr)` 로 자유롭게 로깅 가능.
 * - 매칭 핸들러가 없으면 dispatch.py 가 빈 stdout 을 반환 → 빈 문자열.
 */
function runPythonDispatcher(
  urlStr: string,
  ctx: CorporateFetchContext,
): Promise<string> {
  const dispatcher = resolveDispatcherPath();
  if (!dispatcher) {
    return Promise.resolve('');
  }
  const python = detectPythonExecutable();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(python, [dispatcher], {
      // 등록된 사내 API 키를 OPENRND_CRED_<ID> 환경변수로 주입.
      // PYTHONUTF8/PYTHONIOENCODING: Windows 레거시 코드페이지(CP949) 대신
      // UTF-8 로 stdout·파일 입출력을 통일해 한글 본문이 깨지거나
      // UnicodeEncodeError 가 나지 않도록 한다. shell 은 쓰지 않는다 — cmd.exe
      // 를 거치면 명령줄이 코드페이지로 재인코딩되어 비ASCII 가 깨진다.
      env: {
        ...process.env,
        ...getCredentialEnv(),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderrBuf = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new Error(
            `corporate_fetch dispatcher timed out after ${
              DISPATCH_TIMEOUT_MS / 1000
            }s`,
          ),
        ),
      );
    }, DISPATCH_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
      finish(() => reject(ctx.signal.reason ?? new Error('aborted')));
    };
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      stdout += stdoutDecoder.write(d);
    });

    // stderr 는 줄 단위로 잘라 터미널 로그로 전달.
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += stderrDecoder.write(d);
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trimEnd();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) {
          ctx.emitInfo(`🐍 ${line}`);
        }
      }
    });

    child.on('error', (err) => {
      if (err.message.includes('ENOENT')) {
        finish(() =>
          reject(
            new Error(
              `Python 실행 파일 '${python}' 을(를) 찾을 수 없습니다. ` +
                `Python 3 설치 후 PATH 에 포함시키세요.`,
            ),
          ),
        );
      } else {
        finish(() => reject(err));
      }
    });

    child.on('close', () => {
      stdout += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      const tail = stderrBuf.trim();
      if (tail) {
        ctx.emitInfo(`🐍 ${tail}`);
      }
      finish(() => resolve(stdout));
    });

    // URL 을 stdin 으로 전달 (UTF-8).
    child.stdin.write(urlStr, 'utf-8');
    child.stdin.end();
  });
}

/**
 * 등록된 핸들러 목록.
 *
 * 기본값은 Python 디스패처 브리지 하나뿐이며, 실제 사내 fetch 로직은
 * corporate_fetchers/handlers/*.py 에서 관리합니다. (TS 핸들러가 필요하면
 * 여기에 {@link CorporateFetchHandler} 객체를 추가할 수 있습니다.)
 */
export const corporateFetchHandlers: CorporateFetchHandler[] = [
  {
    name: 'python-dispatch',
    // dispatch.py 가 존재할 때만 활성. URL 매칭 판단은 Python 핸들러가 담당.
    canHandle: () => resolveDispatcherPath() !== null,
    fetch: (url, ctx) => runPythonDispatcher(url, ctx),
  },
];

/** 사내 시스템(핸들러) 메타데이터 — dispatch.py --list-systems 결과. */
export interface CorporateSystemInfo {
  /** 시스템 id (자격증명 키, 예: "jira"). */
  id: string;
  /** 사람이 읽는 이름. */
  name?: string;
  /** 시스템 설명(어떤 키가 필요한지 등). */
  description?: string;
  /** 핸들러 모듈 파일명. */
  module: string;
  /** 이 핸들러가 읽는 환경변수명 (예: "OPENRND_CRED_JIRA"). */
  env: string;
}

/**
 * dispatch.py 를 `--list-systems` 모드로 실행해, handlers/ 가 선언한 SYSTEM
 * 메타데이터 목록을 가져온다. manage_credential 툴이 "어떤 시스템에 키가
 * 필요한지" 안내하는 데 사용한다. Python 미설치/디스패처 없음 → 빈 배열.
 */
export function listCorporateSystems(
  signal?: AbortSignal,
): Promise<CorporateSystemInfo[]> {
  const dispatcher = resolveDispatcherPath();
  if (!dispatcher) {
    return Promise.resolve([]);
  }
  const python = detectPythonExecutable();
  return new Promise<CorporateSystemInfo[]>((resolve) => {
    const child = spawn(python, [dispatcher, '--list-systems'], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const stdoutDecoder = new StringDecoder('utf8');
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += stdoutDecoder.write(d);
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      stdout += stdoutDecoder.end();
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
          resolve(parsed as CorporateSystemInfo[]);
          return;
        }
      } catch {
        // ignore malformed output
      }
      resolve([]);
    });
    if (signal) {
      signal.addEventListener('abort', () => child.kill(), { once: true });
    }
  });
}

/**
 * stdin 의 URL 을 처리할 수 있는 사내 핸들러가 있는지 확인하고, 있으면 그
 * 시스템 메타데이터를 반환한다(없으면 null). dispatch.py 를 `--match` 모드로
 * 실행하며, 핸들러의 fetch 는 호출하지 않고 can_handle 만 확인하므로 가볍다.
 *
 * web_fetch 가 "이 URL 은 API 키(자격증명)로 우회 가능한 사내 URL 인가?" 를
 * 판단해, API 로 우회 가능한 URL 에서만 (브라우저 vs API) 선택을 묻는 데 사용한다.
 */
export function matchCorporateSystem(
  urlStr: string,
  signal?: AbortSignal,
): Promise<CorporateSystemInfo | null> {
  const dispatcher = resolveDispatcherPath();
  if (!dispatcher) {
    return Promise.resolve(null);
  }
  const python = detectPythonExecutable();
  return new Promise<CorporateSystemInfo | null>((resolve) => {
    const child = spawn(python, [dispatcher, '--match'], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const stdoutDecoder = new StringDecoder('utf8');
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += stdoutDecoder.write(d);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      stdout += stdoutDecoder.end();
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          resolve(parsed as CorporateSystemInfo);
          return;
        }
      } catch {
        // ignore malformed output
      }
      resolve(null);
    });
    if (signal) {
      signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.stdin.write(urlStr, 'utf-8');
    child.stdin.end();
  });
}

/**
 * SSO 폴백 시 사용자가 고른 경로("browser" = 브라우저로 열기 / "apikey" = API
 * 키 등록 경로)를 프로세스 동안 기억해, 같은 선택을 매번 다시 묻지 않도록 한다.
 *
 * - manage_credential 로 키를 등록(set)하면 {@link clearRememberedFallbackChoice}
 *   로 초기화 → 다음 web_fetch 때 (필요하면) 다시 묻거나 등록된 키로 곧장 가져온다.
 */
export type WebFetchFallbackChoice = 'browser' | 'apikey';

let rememberedFallbackChoice: WebFetchFallbackChoice | null = null;

export function getRememberedFallbackChoice(): WebFetchFallbackChoice | null {
  return rememberedFallbackChoice;
}

export function rememberFallbackChoice(choice: WebFetchFallbackChoice): void {
  rememberedFallbackChoice = choice;
}

export function clearRememberedFallbackChoice(): void {
  rememberedFallbackChoice = null;
}

/**
 * 등록된 핸들러들을 순서대로 시도한다.
 *
 * - 매칭되는 핸들러가 없으면 `null` 반환 → 브라우저 폴백.
 * - 핸들러가 throw 하거나 빈 본문을 주면, 다음 핸들러를 계속 시도. 끝까지
 *   실패하면 `null` 반환 → 브라우저 폴백.
 *
 * 이 함수는 web-fetch.ts 에서만 호출합니다.
 */
export async function tryCorporateFetch(
  urlStr: string,
  ctx: CorporateFetchContext,
): Promise<CorporateFetchSuccess | null> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return null;
  }

  for (const handler of corporateFetchHandlers) {
    let matches = false;
    try {
      matches = handler.canHandle(parsed);
    } catch {
      matches = false;
    }
    if (!matches) {
      continue;
    }

    try {
      const text = await handler.fetch(urlStr, ctx);
      if (text && text.trim()) {
        return { handlerName: handler.name, text };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emitInfo(
        `⚠️ [web_fetch] 사내 fetch 핸들러(${handler.name}) 실패(${message}) → 다음 단계로`,
      );
    }
  }

  return null;
}
