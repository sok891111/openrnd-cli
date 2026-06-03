/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ============================================================================
 *  사내 URL별 Fetch 구현 영역 (Corporate per-URL fetch handlers)
 * ============================================================================
 *
 * web_fetch 의 fallback 순서는 다음과 같습니다:
 *
 *   1) 일반 web fetch (서버사이드 HTTP fetch)
 *   2) 사내 URL별 fetch  ← ★ 이 파일에서 당신이 직접 구현합니다 ★
 *   3) 로그인된 브라우저 세션으로 열기
 *
 * 1) 이 실패하거나 SSO/인증 벽에 막히면, web-fetch.ts 가 이 파일의
 * `tryCorporateFetch()` 를 호출합니다. 여기 등록된 핸들러 중 URL 에
 * 매칭되는 것이 있으면 그 핸들러로 본문을 가져오고, 없거나 모두 실패하면
 * 3) 브라우저 폴백으로 넘어갑니다.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  당신이 수정할 곳은 아래 `corporateFetchHandlers` 배열 하나뿐입니다.   │
 * │  나머지(인터페이스/실행 로직)는 그대로 두세요. web-fetch.ts 도         │
 * │  건드릴 필요 없습니다.                                                 │
 * └──────────────────────────────────────────────────────────────────────┘
 */

/**
 * 핸들러 실행 시 web_fetch 가 넘겨주는 컨텍스트.
 * - `signal`  : 취소(Abort) 신호. 직접 fetch 할 때 그대로 넘기세요.
 * - `emitInfo`: 터미널에 진행 상황 한 줄을 표시합니다(선택).
 */
export interface CorporateFetchContext {
  signal: AbortSignal;
  emitInfo(message: string): void;
}

/**
 * 사내 URL별 fetch 방법 하나를 나타내는 핸들러.
 *
 * - `name`     : 로그/표시에 쓰이는 짧은 이름.
 * - `canHandle`: 이 핸들러가 처리할 URL인지 판단. true 면 `fetch` 가 호출됩니다.
 * - `fetch`    : 실제 본문을 가져와 **plain text(또는 markdown)** 문자열로 반환.
 *
 *   ┌─ 반환값에 따른 동작 ──────────────────────────────────────────────┐
 *   │ • 공백이 아닌 문자열 반환 (text.trim() 이 비어있지 않음)          │
 *   │     → "이 핸들러 성공"으로 간주. web fetch 성공과 동일하게 그      │
 *   │       내용을 LLM 에 전달하고, ★브라우저 폴백은 실행하지 않음★.   │
 *   │ • 빈 문자열('') 또는 공백만('  ', '\n') 반환                       │
 *   │     → "이 핸들러 실패"로 간주. 다음 핸들러(없으면 브라우저)로 진행.│
 *   │ • throw                                                            │
 *   │     → "이 핸들러 실패"로 간주(에러 메시지 로깅). 다음 단계로 진행. │
 *   └───────────────────────────────────────────────────────────────────┘
 */
export interface CorporateFetchHandler {
  name: string;
  canHandle(url: URL): boolean;
  fetch(url: string, ctx: CorporateFetchContext): Promise<string>;
}

/**
 * ★★★ 여기에 사내 URL별 fetch 방법을 추가하세요 ★★★
 *
 * 배열에 등록한 순서대로 `canHandle` 이 검사되고, 처음 매칭된 핸들러부터
 * 시도합니다. 아래는 예시이며, 실제 구현으로 교체/추가하면 됩니다.
 *
 * 예시 1) 사내 위키(Confluence)를 REST API 토큰으로 읽기:
 *
 *   {
 *     name: 'confluence',
 *     canHandle: (url) => url.hostname === 'wiki.corp.example.com',
 *     fetch: async (url, ctx) => {
 *       const pageId = new URL(url).searchParams.get('pageId');
 *       const res = await fetch(
 *         `https://wiki.corp.example.com/rest/api/content/${pageId}?expand=body.storage`,
 *         {
 *           signal: ctx.signal,
 *           headers: {
 *             Authorization: `Bearer ${process.env['CONFLUENCE_TOKEN'] ?? ''}`,
 *           },
 *         },
 *       );
 *       if (!res.ok) throw new Error(`Confluence ${res.status}`);
 *       const json = await res.json();
 *       return json?.body?.storage?.value ?? '';
 *     },
 *   },
 *
 * 예시 2) 사내 프록시/게이트웨이를 거쳐서 가져오기:
 *
 *   {
 *     name: 'corp-proxy',
 *     canHandle: (url) => url.hostname.endsWith('.intra.example.com'),
 *     fetch: async (url, ctx) => {
 *       ctx.emitInfo(`사내 프록시 경유: ${url}`);
 *       const res = await fetch('https://proxy.corp.example.com/fetch', {
 *         method: 'POST',
 *         signal: ctx.signal,
 *         headers: { 'Content-Type': 'application/json' },
 *         body: JSON.stringify({ target: url }),
 *       });
 *       if (!res.ok) throw new Error(`proxy ${res.status}`);
 *       return await res.text();
 *     },
 *   },
 */
export const corporateFetchHandlers: CorporateFetchHandler[] = [
  // ──────────────────────────────────────────────────────────────────────
  // [샘플] 터미널 로깅 핸들러
  //   URL 이 market.naver.com 이면, openrnd 대화 터미널에 URL 을 바로 출력.
  //   `ctx.emitInfo(...)` 가 터미널 출력 함수입니다(원하는 만큼 호출 가능).
  //
  //   이 샘플은 "로그만 찍고" 빈 문자열('')을 반환하므로, 실제 본문은
  //   가져오지 않고 다음 단계(브라우저 폴백)로 그대로 넘어갑니다.
  //   → 실제 사내 fetch 를 구현할 때는 빈 문자열 대신 본문 텍스트를 반환하세요.
  // ──────────────────────────────────────────────────────────────────────
  {
    name: 'sample-naver-market-logger',
    canHandle: (url) => url.hostname === 'market.naver.com',
    fetch: async (url, ctx) => {
      // 터미널에 바로 출력되는 한 줄 로그.
      ctx.emitInfo(`📝 [사내 샘플 로거] 요청된 URL: ${url}`);
      // 로깅만 하고 본문은 가져오지 않음 → 빈 문자열('')을 반환하므로
      // 다음 단계(브라우저 폴백)로 넘어갑니다.
      //
      // ★ 실제 fetch 를 구현해 "성공"으로 처리하고 브라우저를 막으려면,
      //   여기서 공백이 아닌 본문 문자열을 반환하세요. 예:
      //     const res = await fetch(url, { signal: ctx.signal });
      //     return await res.text();   // ← 비어있지 않으면 web fetch 성공으로 간주
      return '';
    },
  },

  // TODO(사내): 여기에 위 예시 형태로 실제 핸들러를 추가하세요.
];

/**
 * 결과: 어떤 핸들러가 성공했는지(`handlerName`)와 가져온 본문(`text`).
 */
export interface CorporateFetchSuccess {
  handlerName: string;
  text: string;
}

/**
 * 등록된 핸들러들을 순서대로 시도한다.
 *
 * - URL 에 매칭되는 핸들러가 하나도 없으면 `null` 반환 → 브라우저 폴백.
 * - 매칭된 핸들러가 throw 하거나 빈 본문을 주면, 다음 매칭 핸들러를 계속 시도.
 *   끝까지 실패하면 `null` 반환 → 브라우저 폴백.
 *
 * 이 함수는 web-fetch.ts 에서만 호출합니다. 사내에서는 건드릴 필요 없습니다.
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

    ctx.emitInfo(
      `🏢 [web_fetch] 사내 fetch 핸들러(${handler.name}) 시도 중: ${urlStr}`,
    );
    try {
      const text = await handler.fetch(urlStr, ctx);
      if (text && text.trim()) {
        return { handlerName: handler.name, text };
      }
      ctx.emitInfo(
        `⚠️ [web_fetch] 사내 fetch 핸들러(${handler.name})가 빈 본문 반환 → 다음 단계로`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.emitInfo(
        `⚠️ [web_fetch] 사내 fetch 핸들러(${handler.name}) 실패(${message}) → 다음 단계로`,
      );
    }
  }

  return null;
}
