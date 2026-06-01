/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ToolConfirmationOutcome,
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolCallConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
  type PolicyUpdateOptions,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import { getResponseText } from '../utils/partUtils.js';
import { fetchWithTimeout, isPrivateIp } from '../utils/fetch.js';
import { truncateString } from '../utils/textUtils.js';
import { convert } from 'html-to-text';
import {
  logWebFetchFallbackAttempt,
  WebFetchFallbackAttemptEvent,
  logNetworkRetryAttempt,
  NetworkRetryAttemptEvent,
} from '../telemetry/index.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { WEB_FETCH_TOOL_NAME, WEB_FETCH_DISPLAY_NAME } from './tool-names.js';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';
import { retryWithBackoff, getRetryErrorType } from '../utils/retry.js';
import { WEB_FETCH_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { LRUCache } from 'mnemonist';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

const URL_FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 250000;
const MAX_EXPERIMENTAL_FETCH_SIZE = 10 * 1024 * 1024; // 10MB
// Responses at or below this size (bytes) are treated as a likely SSO/login
// stub even on HTTP 200 — corporate IdPs often serve a tiny (~1KB) bootstrap
// page instead of a redirect. Tunable via OPENRND_WEBFETCH_MIN_CONTENT_LENGTH.
const DEFAULT_SSO_STUB_THRESHOLD = 1500;
const USER_AGENT =
  'Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli)';
const TRUNCATION_WARNING = '\n\n... [Content truncated due to size limit] ...';

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;
const hostRequestHistory = new LRUCache<string, number[]>(1000);

function checkRateLimit(url: string): {
  allowed: boolean;
  waitTimeMs?: number;
} {
  try {
    const hostname = new URL(url).hostname;
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    let history = hostRequestHistory.get(hostname) || [];
    // Clean up old timestamps
    history = history.filter((timestamp) => timestamp > windowStart);

    if (history.length >= MAX_REQUESTS_PER_WINDOW) {
      // Calculate wait time based on the oldest timestamp in the current window
      const oldestTimestamp = history[0];
      const waitTimeMs = oldestTimestamp + RATE_LIMIT_WINDOW_MS - now;
      hostRequestHistory.set(hostname, history); // Update cleaned history
      return { allowed: false, waitTimeMs: Math.max(0, waitTimeMs) };
    }

    history.push(now);
    hostRequestHistory.set(hostname, history);
    return { allowed: true };
  } catch {
    // If URL parsing fails, we fallback to allowed (should be caught by parsePrompt anyway)
    return { allowed: true };
  }
}

/**
 * Normalizes a URL by converting hostname to lowercase, removing trailing slashes,
 * and removing default ports.
 */
export function normalizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    url.hostname = url.hostname.toLowerCase();
    // Remove trailing slash if present in pathname (except for root '/')
    if (url.pathname.endsWith('/') && url.pathname.length > 1) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // Remove default ports
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = '';
    }
    return url.href;
  } catch {
    return urlStr;
  }
}

/**
 * Parses a prompt to extract valid URLs and identify malformed ones.
 */
export function parsePrompt(text: string): {
  validUrls: string[];
  errors: string[];
} {
  const tokens = text.split(/\s+/);
  const validUrls: string[] = [];
  const errors: string[] = [];

  for (const token of tokens) {
    if (!token) continue;

    // Heuristic to check if the url appears to contain URL-like chars.
    if (token.includes('://')) {
      try {
        // Validate with new URL()
        const url = new URL(token);

        // Allowlist protocols
        if (['http:', 'https:'].includes(url.protocol)) {
          validUrls.push(url.href);
        } else {
          errors.push(
            `Unsupported protocol in URL: "${token}". Only http and https are supported.`,
          );
        }
      } catch {
        // new URL() threw, so it's malformed according to WHATWG standard
        errors.push(`Malformed URL detected: "${token}".`);
      }
    }
  }

  return { validUrls, errors };
}

/**
 * Safely converts a GitHub blob URL to a raw content URL.
 */
export function convertGithubUrlToRaw(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    if (url.hostname === 'github.com' && url.pathname.includes('/blob/')) {
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = url.pathname.replace(/^\/([^/]+\/[^/]+)\/blob\//, '/$1/');
      return url.href;
    }
  } catch {
    // Ignore invalid URLs
  }
  return urlStr;
}

// Interfaces for grounding metadata (similar to web-search.ts)
interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingChunkItem {
  web?: GroundingChunkWeb;
}

function isGroundingChunkItem(item: unknown): item is GroundingChunkItem {
  return typeof item === 'object' && item !== null;
}

interface GroundingSupportSegment {
  startIndex: number;
  endIndex: number;
  text?: string;
}

interface GroundingSupportItem {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
}

function isGroundingSupportItem(item: unknown): item is GroundingSupportItem {
  return typeof item === 'object' && item !== null;
}

/**
 * Sanitizes text for safe embedding in XML tags.
 */
function sanitizeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parameters for the WebFetch tool
 */
export interface WebFetchToolParams {
  /**
   * The prompt containing URL(s) (up to 20) and instructions for processing their content.
   */
  prompt?: string;
  /**
   * Direct URL to fetch (experimental mode).
   */
  url?: string;
}

interface ErrorWithStatus extends Error {
  status?: number;
}

class WebFetchToolInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  constructor(
    private readonly context: AgentLoopContext,
    params: WebFetchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
      undefined,
      undefined,
      true,
      () => this.context.config.getApprovalMode(),
    );
  }

  private handleRetry(attempt: number, error: unknown, delayMs: number): void {
    const maxAttempts = this.context.config.getMaxAttempts();
    const modelName = 'Web Fetch';
    const errorType = getRetryErrorType(error);

    coreEvents.emitRetryAttempt({
      attempt,
      maxAttempts,
      delayMs,
      error: errorType,
      model: modelName,
    });

    logNetworkRetryAttempt(
      this.context.config,
      new NetworkRetryAttemptEvent(
        attempt,
        maxAttempts,
        errorType,
        delayMs,
        modelName,
      ),
    );
  }

  private isBlockedHost(urlStr: string): boolean {
    try {
      const url = new URL(urlStr);
      const hostname = url.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return true;
      }
      return isPrivateIp(urlStr);
    } catch {
      return true;
    }
  }

  /**
   * Whether to fall back to the user's signed-in browser session when a direct
   * fetch hits an SSO/auth wall or fails. Enabled by default — corporate
   * intranet URLs are usually behind SSO that a server-side fetch cannot pass.
   * Disable with OPENRND_WEBFETCH_BROWSER_FALLBACK=0 (or false/off).
   */
  private shouldUseBrowserFetch(): boolean {
    const v = (
      process.env['OPENRND_WEBFETCH_BROWSER_FALLBACK'] ?? ''
    ).toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
  }

  /** HTTP statuses that indicate the request was blocked by an auth gate. */
  private isAuthStatus(status: number): boolean {
    // 401 Unauthorized, 403 Forbidden, 407 Proxy Auth, 511 Network Auth Required
    return status === 401 || status === 403 || status === 407 || status === 511;
  }

  /** Approximate registrable domain (last two labels). */
  private registrableDomain(hostname: string): string {
    return hostname.toLowerCase().split('.').slice(-2).join('.');
  }

  /**
   * Heuristic: did the direct fetch get bounced to an SSO/login flow?
   * Triggers on auth statuses, cross-site redirects (typical of an IdP), or a
   * redirect whose final URL looks like a login/SSO endpoint.
   */
  private looksLikeAuthRedirect(
    originalUrl: string,
    response: Response,
  ): boolean {
    if (this.isAuthStatus(response.status)) {
      return true;
    }
    if (!response.redirected) {
      return false;
    }
    let finalUrl: URL;
    let orig: URL;
    try {
      finalUrl = new URL(response.url);
      orig = new URL(originalUrl);
    } catch {
      return false;
    }
    // Redirected to a different registrable domain (e.g. corp.com ->
    // login.microsoftonline.com / okta.com) — almost always an IdP.
    if (
      this.registrableDomain(finalUrl.hostname) !==
      this.registrableDomain(orig.hostname)
    ) {
      return true;
    }
    // Same domain, but the landing page looks like an auth endpoint
    // (e.g. adfs.corp.com/adfs/ls, intranet.corp.com/login).
    const authMarker =
      /(^|[/.])(login|signin|sign-in|sso|saml|adfs|oauth|openid|idp|auth|account|session)([/.?]|$)/i;
    return (
      authMarker.test(finalUrl.pathname) || authMarker.test(finalUrl.hostname)
    );
  }

  /**
   * Size (bytes) at/under which a 200 response is treated as an SSO stub.
   * Tunable via OPENRND_WEBFETCH_MIN_CONTENT_LENGTH; set to 0 to disable.
   */
  private getSsoStubThreshold(): number {
    const raw = process.env['OPENRND_WEBFETCH_MIN_CONTENT_LENGTH'];
    if (raw !== undefined) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) {
        return n;
      }
    }
    return DEFAULT_SSO_STUB_THRESHOLD;
  }

  /**
   * Effective body size: prefers the Content-Length header, falls back to the
   * actual number of bytes read. Returns undefined when neither is known.
   */
  private responseSize(
    response: Response,
    bodyByteLength?: number,
  ): number | undefined {
    const declared = Number.parseInt(
      response.headers.get('content-length') ?? '',
      10,
    );
    if (Number.isFinite(declared)) {
      return declared;
    }
    return bodyByteLength;
  }

  /**
   * Heuristic for SSO that returns HTTP 200 with a tiny login/bootstrap page.
   */
  private looksLikeSsoStub(
    response: Response,
    bodyByteLength?: number,
  ): boolean {
    const threshold = this.getSsoStubThreshold();
    if (threshold <= 0 || !response.ok) {
      return false;
    }
    // SSO bootstrap pages are HTML (or send no content-type). A small JSON /
    // plain-text / image response is legitimate, so don't treat it as a stub.
    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    if (!(contentType.includes('text/html') || contentType === '')) {
      return false;
    }
    const size = this.responseSize(response, bodyByteLength);
    return size !== undefined && size <= threshold;
  }

  /**
   * Returns a human-readable reason to fall back to the browser, or null if the
   * direct fetch looks like a genuine, complete response.
   */
  private browserFallbackReason(
    url: string,
    response: Response,
    bodyByteLength?: number,
  ): string | null {
    if (this.looksLikeAuthRedirect(url, response)) {
      return `SSO/인증 벽 감지 (status ${response.status}, 최종 URL ${response.url})`;
    }
    if (this.looksLikeSsoStub(response, bodyByteLength)) {
      const size = this.responseSize(response, bodyByteLength);
      return `SSO 의심 — 응답 크기 ${size}B ≤ ${this.getSsoStubThreshold()}B (status ${response.status})`;
    }
    return null;
  }

  /**
   * Fetches a URL through the user's signed-in browser session, reusing the
   * existing BrowserManager (chrome-devtools-mcp). Because the browser carries
   * the user's SSO cookies, this bypasses intranet auth walls that a
   * server-side fetch cannot. Opens a NEW tab so the user's current page is
   * left untouched, then closes that tab.
   */
  private async fetchViaBrowser(
    urlStr: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { BrowserManager } = await import(
      '../agents/browser/browserManager.js'
    );
    const manager = BrowserManager.getInstance(this.context.config);
    manager.acquire();
    let pageIdToClose: number | undefined;
    coreEvents.emitFeedback(
      'info',
      `🌐 [web_fetch] 로그인된 브라우저 세션(sessionMode=existing)으로 여는 중: ${urlStr}`,
    );
    try {
      await manager.callTool('new_page', { url: urlStr }, signal, true);

      // Identify the tab we just opened (the selected page) so we can close it.
      // Page lines look like: "<id>: <url> [selected]".
      try {
        const pages = await manager.callTool('list_pages', {}, signal, true);
        pageIdToClose = this.extractSelectedPageId(
          this.joinText(pages.content),
        );
      } catch {
        // Non-fatal: we just won't be able to auto-close the tab.
      }

      // Extract ONLY the page text via innerText. evaluate_script returns a
      // JSON-serialized value, so no image/binary data can ever reach the
      // (non-multimodal) local LLM. We never call take_screenshot.
      let text = '';
      const evalResult = await manager.callTool(
        'evaluate_script',
        {
          function: `() => {
            const el = document.body || document.documentElement;
            const body = el && el.innerText ? el.innerText : '';
            const title = document.title || '';
            return title ? title + '\\n\\n' + body : body;
          }`,
        },
        signal,
        true,
      );
      if (!evalResult.isError) {
        text = this.parseScriptResult(this.joinText(evalResult.content)).trim();
      }

      // Fallback to the accessibility-tree snapshot (also text-only, never an
      // image) if the page exposed no innerText (e.g. canvas/PDF-style apps).
      if (!text) {
        const snapshot = await manager.callTool(
          'take_snapshot',
          {},
          signal,
          true,
        );
        if (!snapshot.isError) {
          text = this.joinText(snapshot.content).trim();
        }
      }

      if (!text) {
        throw new Error('Browser returned empty page content.');
      }
      coreEvents.emitFeedback(
        'info',
        `✅ [web_fetch] 브라우저로 ${text.length}자 읽음: ${urlStr}`,
      );
      return text;
    } catch (err) {
      // Surface the real reason directly in the terminal so the user can tell
      // whether Chrome remote debugging is disabled or it's a different cause.
      coreEvents.emitFeedback(
        'error',
        `❌ [web_fetch] 브라우저 폴백 실패 (${urlStr}):\n${getErrorMessage(err)}`,
      );
      throw err;
    } finally {
      if (pageIdToClose !== undefined) {
        // Best-effort: close the tab we opened so we don't litter the browser.
        try {
          await manager.callTool(
            'close_page',
            { pageId: pageIdToClose },
            signal,
            true,
          );
        } catch {
          // ignore close failures
        }
      }
      manager.release();
    }
  }

  /** Joins the text parts of an MCP tool result, ignoring any non-text items. */
  private joinText(
    content?: Array<{ type: 'text' | 'image'; text?: string }>,
  ): string {
    return (content ?? [])
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text ?? '')
      .join('\n');
  }

  /**
   * Parses the value returned by chrome-devtools-mcp's evaluate_script, which
   * wraps the JSON-serialized return value in a ```json fenced block. Returns
   * the decoded string (with real newlines) so the LLM sees clean text.
   */
  private parseScriptResult(raw: string): string {
    const match = raw.match(/```json\s*\n([\s\S]*?)\n```/);
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[1]);
        if (typeof parsed === 'string') {
          return parsed;
        }
        if (parsed != null) {
          return String(parsed);
        }
      } catch {
        // Fall through to returning the raw text.
      }
    }
    return raw;
  }

  /** Extracts the "[selected]" page id from a list_pages/snapshot listing. */
  private extractSelectedPageId(listing: string): number | undefined {
    const match = listing.match(/^\s*(\d+):\s+\S.*\[selected\]/m);
    return match ? Number(match[1]) : undefined;
  }

  /** Wraps a browser fetch into a ToolResult for the experimental path. */
  private async browserFetchResult(
    url: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const text = await this.fetchViaBrowser(url, signal);
    return {
      llmContent: this.applyFallbackTruncation(text),
      returnDisplay: `Fetched content from ${url} via your browser session.`,
    };
  }

  /** Applies the content size limit when context management is off. */
  private applyFallbackTruncation(text: string): string {
    if (!this.context.config.isContextManagementEnabled()) {
      return truncateString(text, MAX_CONTENT_LENGTH, TRUNCATION_WARNING);
    }
    return text;
  }

  /**
   * Server-side fetch of a URL, returning both the response (for auth-wall
   * detection) and the converted text. Throws on non-auth error statuses
   * (preserving the original behavior); auth statuses are returned so the
   * caller can decide to fall back to the browser.
   */
  private async nodeFetchText(
    url: string,
    signal: AbortSignal,
  ): Promise<{ response: Response; text: string; byteLength: number }> {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetchWithTimeout(url, URL_FETCH_TIMEOUT_MS, {
          signal,
          headers: {
            'User-Agent': USER_AGENT,
          },
        });
        if (!res.ok && !this.isAuthStatus(res.status)) {
          const error = new Error(
            `Request failed with status code ${res.status} ${res.statusText}`,
          );
          (error as ErrorWithStatus).status = res.status;
          throw error;
        }
        return res;
      },
      {
        retryFetchErrors: this.context.config.getRetryFetchErrors(),
        onRetry: (attempt, error, delayMs) =>
          this.handleRetry(attempt, error, delayMs),
        signal,
      },
    );

    const bodyBuffer = await this.readResponseWithLimit(
      response,
      MAX_EXPERIMENTAL_FETCH_SIZE,
    );
    const rawContent = bodyBuffer.toString('utf8');
    const contentType = response.headers.get('content-type') || '';
    let textContent: string;

    // Only use html-to-text if content type is HTML, or if no content type is provided (assume HTML)
    if (contentType.toLowerCase().includes('text/html') || contentType === '') {
      textContent = convert(rawContent, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
        ],
      });
    } else {
      // For other content types (text/plain, application/json, etc.), use raw text
      textContent = rawContent;
    }

    return { response, text: textContent, byteLength: bodyBuffer.length };
  }

  private async executeFallbackForUrl(
    urlStr: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = convertGithubUrlToRaw(urlStr);
    if (this.isBlockedHost(url)) {
      debugLogger.warn(`[WebFetchTool] Blocked access to host: ${url}`);
      throw new Error(
        `Access to blocked or private host ${url} is not allowed.`,
      );
    }

    // Try a fast server-side fetch first; on SSO/auth walls or failure, fall
    // back to the user's signed-in browser session.
    if (this.shouldUseBrowserFetch()) {
      try {
        const { response, text, byteLength } = await this.nodeFetchText(
          url,
          signal,
        );
        const reason = this.browserFallbackReason(url, response, byteLength);
        if (reason) {
          coreEvents.emitFeedback(
            'info',
            `🔐 [web_fetch] ${reason} → 브라우저 세션으로 폴백: ${url}`,
          );
          debugLogger.warn(
            `[WebFetchTool] ${reason} for ${url}. Falling back to browser session.`,
          );
          return await this.fetchViaBrowser(url, signal);
        }
        return this.applyFallbackTruncation(text);
      } catch (error) {
        coreEvents.emitFeedback(
          'info',
          `⚠️ [web_fetch] 직접 fetch 실패 (${getErrorMessage(error)}) → 브라우저 세션으로 폴백: ${url}`,
        );
        debugLogger.warn(
          `[WebFetchTool] Direct fetch failed for ${url} ` +
            `(${getErrorMessage(error)}). Falling back to browser session.`,
        );
        return this.fetchViaBrowser(url, signal);
      }
    }

    const { text } = await this.nodeFetchText(url, signal);
    return this.applyFallbackTruncation(text);
  }

  private filterAndValidateUrls(urls: string[]): {
    toFetch: string[];
    skipped: string[];
  } {
    const uniqueUrls = [...new Set(urls.map(normalizeUrl))];
    const toFetch: string[] = [];
    const skipped: string[] = [];

    for (const url of uniqueUrls) {
      if (this.isBlockedHost(url)) {
        debugLogger.warn(
          `[WebFetchTool] Skipped private or local host: ${url}`,
        );
        logWebFetchFallbackAttempt(
          this.context.config,
          new WebFetchFallbackAttemptEvent('private_ip_skipped'),
        );
        skipped.push(`[Blocked Host] ${url}`);
        continue;
      }
      if (!checkRateLimit(url).allowed) {
        debugLogger.warn(`[WebFetchTool] Rate limit exceeded for host: ${url}`);
        skipped.push(`[Rate limit exceeded] ${url}`);
        continue;
      }
      toFetch.push(url);
    }
    return { toFetch, skipped };
  }

  private async executeFallback(
    urls: string[],
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const uniqueUrls = [...new Set(urls)];
    const successes: Array<{ url: string; content: string }> = [];
    const errors: Array<{ url: string; message: string }> = [];

    for (const url of uniqueUrls) {
      try {
        const content = await this.executeFallbackForUrl(url, signal);
        successes.push({ url, content });
      } catch (e) {
        errors.push({ url, message: getErrorMessage(e) });
      }
    }

    // Change 2: Short-circuit on total failure
    if (successes.length === 0) {
      const errorMessage = `All fallback fetch attempts failed: ${errors
        .map((e) => `${e.url}: ${e.message}`)
        .join(', ')}`;
      debugLogger.error(`[WebFetchTool] ${errorMessage}`);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }

    const finalContentsByUrl = new Map<string, string>();
    if (this.context.config.isContextManagementEnabled()) {
      successes.forEach((success) =>
        finalContentsByUrl.set(success.url, success.content),
      );
    } else {
      // Smart Budget Allocation (Water-filling algorithm) for successes
      const sortedSuccesses = [...successes].sort(
        (a, b) => a.content.length - b.content.length,
      );
      let remainingBudget = MAX_CONTENT_LENGTH;
      let remainingUrls = sortedSuccesses.length;
      for (const success of sortedSuccesses) {
        const fairShare = Math.floor(remainingBudget / remainingUrls);
        const allocated = Math.min(success.content.length, fairShare);

        const truncated = truncateString(
          success.content,
          allocated,
          TRUNCATION_WARNING,
        );

        finalContentsByUrl.set(success.url, truncated);
        remainingBudget -= truncated.length;
        remainingUrls--;
      }
    }

    const aggregatedContent = uniqueUrls
      .map((url) => {
        const content = finalContentsByUrl.get(url);
        if (content !== undefined) {
          return `<source url="${sanitizeXml(url)}">\n${sanitizeXml(content)}\n</source>`;
        }
        const error = errors.find((e) => e.url === url);
        return `<source url="${sanitizeXml(url)}">\nError: ${sanitizeXml(error?.message || 'Unknown error')}\n</source>`;
      })
      .join('\n');

    try {
      const geminiClient = this.context.geminiClient;
      const fallbackPrompt = `Follow the user's instructions below using the provided webpage content.

<user_instructions>
${sanitizeXml(this.params.prompt ?? '')}
</user_instructions>

I was unable to access the URL(s) directly using the primary fetch tool. Instead, I have fetched the raw content of the page(s). Please use the following content to answer the request. Do not attempt to access the URL(s) again.

<content>
${aggregatedContent}
</content>
`;
      const result = await geminiClient.generateContent(
        { model: 'web-fetch-fallback' },
        [{ role: 'user', parts: [{ text: fallbackPrompt }] }],
        signal,
        LlmRole.UTILITY_TOOL,
      );

      debugLogger.debug(
        `[WebFetchTool] Fallback response for prompt "${this.params.prompt?.substring(
          0,
          50,
        )}...":`,
        JSON.stringify(result, null, 2),
      );

      const resultText = getResponseText(result) || '';

      debugLogger.debug(
        `[WebFetchTool] Formatted fallback tool response for prompt "${this.params.prompt}":\n\n`,
        resultText,
      );

      return {
        llmContent: resultText,
        returnDisplay: `Content for ${urls.length} URL(s) processed using fallback fetch.`,
      };
    } catch (e) {
      const errorMessage = `Error during fallback processing: ${getErrorMessage(e)}`;
      debugLogger.error(`[WebFetchTool] Fallback failed: ${errorMessage}`);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  getDescription(): string {
    if (this.params.url) {
      return `Fetching content from: ${this.params.url}`;
    }
    const prompt = this.params.prompt || '';
    const displayPrompt =
      prompt.length > 100 ? prompt.substring(0, 97) + '...' : prompt;
    return `Processing URLs and instructions from prompt: "${displayPrompt}"`;
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return {};
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    let urls: string[] = [];
    let prompt = this.params.prompt || '';

    if (this.params.url) {
      urls = [this.params.url];
      prompt = `Fetch ${this.params.url}`;
    } else if (this.params.prompt) {
      const { validUrls } = parsePrompt(this.params.prompt);
      urls = validUrls;
    }

    // Perform GitHub URL conversion here
    urls = urls.map((url) => convertGithubUrlToRaw(url));

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Confirm Web Fetch`,
      prompt,
      urls,
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // Mode transitions (e.g. AUTO_EDIT) and policy updates are now
        // handled centrally by the scheduler.
      },
    };
    return confirmationDetails;
  }

  private async readResponseWithLimit(
    response: Response,
    limit: number,
  ): Promise<Buffer> {
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > limit) {
      throw new Error(`Content exceeds size limit of ${limit} bytes`);
    }

    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalLength += value.length;
        if (totalLength > limit) {
          // Attempt to cancel the reader to stop the stream
          await reader.cancel().catch(() => {});
          throw new Error(`Content exceeds size limit of ${limit} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  private async executeExperimental(signal: AbortSignal): Promise<ToolResult> {
    if (!this.params.url) {
      return {
        llmContent: 'Error: No URL provided.',
        returnDisplay: 'Error: No URL provided.',
        error: {
          message: 'No URL provided.',
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    let url: string;
    try {
      url = new URL(this.params.url).href;
    } catch {
      return {
        llmContent: `Error: Invalid URL "${this.params.url}"`,
        returnDisplay: `Error: Invalid URL "${this.params.url}"`,
        error: {
          message: `Invalid URL "${this.params.url}"`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    // Convert GitHub blob URL to raw URL
    url = convertGithubUrlToRaw(url);

    if (this.isBlockedHost(url)) {
      const errorMessage = `Access to blocked or private host ${url} is not allowed.`;
      debugLogger.warn(
        `[WebFetchTool] Blocked experimental fetch to host: ${url}`,
      );
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
      };
    }

    try {
      const response = await retryWithBackoff(
        async () => {
          const res = await fetchWithTimeout(url, URL_FETCH_TIMEOUT_MS, {
            signal,
            headers: {
              Accept:
                'text/markdown, text/plain;q=0.9, application/json;q=0.9, text/html;q=0.8, application/pdf;q=0.7, video/*;q=0.7, */*;q=0.5',
              'User-Agent': USER_AGENT,
            },
          });
          return res;
        },
        {
          retryFetchErrors: this.context.config.getRetryFetchErrors(),
          onRetry: (attempt, error, delayMs) =>
            this.handleRetry(attempt, error, delayMs),
          signal,
        },
      );

      const contentType = response.headers.get('content-type') || '';
      const status = response.status;

      // Bounced to an SSO/login flow? Read it through the signed-in browser.
      if (
        this.shouldUseBrowserFetch() &&
        this.looksLikeAuthRedirect(url, response)
      ) {
        coreEvents.emitFeedback(
          'info',
          `🔐 [web_fetch] SSO/인증 벽 감지 (status ${status}, 최종 URL ${response.url}) → 브라우저 세션으로 폴백: ${url}`,
        );
        debugLogger.warn(
          `[WebFetchTool] Auth/SSO wall detected for ${url} ` +
            `(status ${status}). Using browser session.`,
        );
        return await this.browserFetchResult(url, signal);
      }

      const bodyBuffer = await this.readResponseWithLimit(
        response,
        MAX_EXPERIMENTAL_FETCH_SIZE,
      );

      if (status >= 400) {
        let rawResponseText = bodyBuffer.toString('utf8');
        if (!this.context.config.isContextManagementEnabled()) {
          rawResponseText = truncateString(
            rawResponseText,
            10000,
            '\n\n... [Error response truncated] ...',
          );
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const errorContent = `Request failed with status ${status}
Headers: ${JSON.stringify(headers, null, 2)}
Response: ${rawResponseText}`;
        debugLogger.error(
          `[WebFetchTool] Experimental fetch failed with status ${status} for ${url}`,
        );
        return {
          llmContent: errorContent,
          returnDisplay: `Failed to fetch ${url} (Status: ${status})`,
        };
      }

      // HTTP 200 but a suspiciously small body — likely an SSO/login stub.
      if (
        this.shouldUseBrowserFetch() &&
        this.looksLikeSsoStub(response, bodyBuffer.length)
      ) {
        const size = this.responseSize(response, bodyBuffer.length);
        coreEvents.emitFeedback(
          'info',
          `🔐 [web_fetch] SSO 의심 — 응답 크기 ${size}B ≤ ${this.getSsoStubThreshold()}B (status ${status}) → 브라우저 세션으로 폴백: ${url}`,
        );
        return await this.browserFetchResult(url, signal);
      }

      const lowContentType = contentType.toLowerCase();
      if (
        lowContentType.includes('text/markdown') ||
        lowContentType.includes('text/plain') ||
        lowContentType.includes('application/json')
      ) {
        let text = bodyBuffer.toString('utf8');
        if (!this.context.config.isContextManagementEnabled()) {
          text = truncateString(text, MAX_CONTENT_LENGTH, TRUNCATION_WARNING);
        }
        return {
          llmContent: text,
          returnDisplay: `Fetched ${contentType} content from ${url}`,
        };
      }

      if (lowContentType.includes('text/html')) {
        const html = bodyBuffer.toString('utf8');
        let textContent = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: false, baseUrl: url } },
          ],
        });
        if (!this.context.config.isContextManagementEnabled()) {
          textContent = truncateString(
            textContent,
            MAX_CONTENT_LENGTH,
            TRUNCATION_WARNING,
          );
        }
        return {
          llmContent: textContent,
          returnDisplay: `Fetched and converted HTML content from ${url}`,
        };
      }

      if (
        lowContentType.startsWith('image/') ||
        lowContentType.startsWith('video/') ||
        lowContentType === 'application/pdf'
      ) {
        const base64Data = bodyBuffer.toString('base64');
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: contentType.split(';')[0],
            },
          },
          returnDisplay: `Fetched ${contentType} from ${url}`,
        };
      }

      // Fallback for unknown types - try as text
      let text = bodyBuffer.toString('utf8');
      if (!this.context.config.isContextManagementEnabled()) {
        text = truncateString(text, MAX_CONTENT_LENGTH, TRUNCATION_WARNING);
      }
      return {
        llmContent: text,
        returnDisplay: `Fetched ${contentType || 'unknown'} content from ${url}`,
      };
    } catch (e) {
      // Network failure on the direct fetch — try the signed-in browser.
      if (this.shouldUseBrowserFetch()) {
        coreEvents.emitFeedback(
          'info',
          `⚠️ [web_fetch] 직접 fetch 실패 (${getErrorMessage(e)}) → 브라우저 세션으로 폴백: ${url}`,
        );
        debugLogger.warn(
          `[WebFetchTool] Experimental fetch failed for ${url} ` +
            `(${getErrorMessage(e)}). Falling back to browser session.`,
        );
        try {
          return await this.browserFetchResult(url, signal);
        } catch (browserError) {
          const errorMessage =
            `Error during experimental fetch for ${url}: ${getErrorMessage(e)}; ` +
            `browser fallback also failed: ${getErrorMessage(browserError)}`;
          debugLogger.error(`[WebFetchTool] ${errorMessage}`);
          return {
            llmContent: `Error: ${errorMessage}`,
            returnDisplay: `Error: ${errorMessage}`,
            error: {
              message: errorMessage,
              type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
            },
          };
        }
      }

      const errorMessage = `Error during experimental fetch for ${url}: ${getErrorMessage(e)}`;
      debugLogger.error(
        `[WebFetchTool] Experimental fetch error: ${errorMessage}`,
      );
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  async execute({ abortSignal: signal }: ExecuteOptions): Promise<ToolResult> {
    if (this.context.config.getDirectWebFetch()) {
      return this.executeExperimental(signal);
    }
    const userPrompt = this.params.prompt!;
    const { validUrls } = parsePrompt(userPrompt);

    const { toFetch, skipped } = this.filterAndValidateUrls(validUrls);

    // If everything was skipped, fail early
    if (toFetch.length === 0 && skipped.length > 0) {
      const errorMessage = `All requested URLs were skipped: ${skipped.join(', ')}`;
      debugLogger.error(`[WebFetchTool] ${errorMessage}`);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
      };
    }

    try {
      const geminiClient = this.context.geminiClient;
      const sanitizedPrompt = `Follow the user's instructions to process the authorized URLs.

<user_instructions>
${sanitizeXml(userPrompt)}
</user_instructions>

<authorized_urls>
${toFetch.join('\n')}
</authorized_urls>
`;
      const response = await geminiClient.generateContent(
        { model: 'web-fetch' },
        [{ role: 'user', parts: [{ text: sanitizedPrompt }] }],
        signal,
        LlmRole.UTILITY_TOOL,
      );

      debugLogger.debug(
        `[WebFetchTool] Full response for prompt "${userPrompt.substring(
          0,
          50,
        )}...":`,
        JSON.stringify(response, null, 2),
      );

      let responseText = getResponseText(response) || '';
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;

      // Simple primary success check: we need some text or grounding data
      if (!responseText.trim() && !groundingMetadata?.groundingChunks?.length) {
        throw new Error('Primary fetch returned no content');
      }

      // 1. Apply Grounding Supports (Citations)
      const groundingSupports = groundingMetadata?.groundingSupports?.filter(
        isGroundingSupportItem,
      );
      if (groundingSupports && groundingSupports.length > 0) {
        const insertions: Array<{ index: number; marker: string }> = [];
        groundingSupports.forEach((support) => {
          if (support.segment && support.groundingChunkIndices) {
            const citationMarker = support.groundingChunkIndices
              .map((chunkIndex: number) => `[${chunkIndex + 1}]`)
              .join('');
            insertions.push({
              index: support.segment.endIndex,
              marker: citationMarker,
            });
          }
        });

        insertions.sort((a, b) => b.index - a.index);
        const responseChars = responseText.split('');
        insertions.forEach((insertion) => {
          responseChars.splice(insertion.index, 0, insertion.marker);
        });
        responseText = responseChars.join('');
      }

      // 2. Append Source List
      const sources =
        groundingMetadata?.groundingChunks?.filter(isGroundingChunkItem);
      if (sources && sources.length > 0) {
        const sourceListFormatted: string[] = [];
        sources.forEach((source, index) => {
          const title = source.web?.title || 'Untitled';
          const uri = source.web?.uri || 'Unknown URI';
          sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
        });
        responseText += `\n\nSources:\n${sourceListFormatted.join('\n')}`;
      }

      // 3. Prepend Warnings for skipped URLs
      if (skipped.length > 0) {
        responseText = `[Warning] The following URLs were skipped:\n${skipped.join('\n')}\n\n${responseText}`;
      }

      debugLogger.debug(
        `[WebFetchTool] Formatted tool response for prompt "${userPrompt}":\n\n`,
        responseText,
      );

      return {
        llmContent: responseText,
        returnDisplay: `Content processed from prompt.`,
      };
    } catch (error: unknown) {
      debugLogger.warn(
        `[WebFetchTool] Primary fetch failed, falling back: ${getErrorMessage(error)}`,
      );
      logWebFetchFallbackAttempt(
        this.context.config,
        new WebFetchFallbackAttemptEvent('primary_failed'),
      );
      // Simple All-or-Nothing Fallback
      return this.executeFallback(toFetch, signal);
    }
  }
}

/**
 * Implementation of the WebFetch tool logic
 */
export class WebFetchTool extends BaseDeclarativeTool<
  WebFetchToolParams,
  ToolResult
> {
  static readonly Name = WEB_FETCH_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super(
      WebFetchTool.Name,
      WEB_FETCH_DISPLAY_NAME,
      WEB_FETCH_DEFINITION.base.description!,
      Kind.Fetch,
      WEB_FETCH_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: WebFetchToolParams,
  ): string | null {
    if (this.context.config.getDirectWebFetch()) {
      if (!params.url) {
        return "The 'url' parameter is required.";
      }
      try {
        new URL(params.url);
      } catch {
        return `Invalid URL: "${params.url}"`;
      }
      return null;
    }

    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty and must contain URL(s) and instructions.";
    }

    const { validUrls, errors } = parsePrompt(params.prompt);

    if (errors.length > 0) {
      return `Error(s) in prompt URLs:\n- ${errors.join('\n- ')}`;
    }

    if (validUrls.length === 0) {
      return "The 'prompt' must contain at least one valid URL (starting with http:// or https://).";
    }

    return null;
  }

  protected createInvocation(
    params: WebFetchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    return new WebFetchToolInvocation(
      this.context,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    const schema = resolveToolDeclaration(WEB_FETCH_DEFINITION, modelId);
    if (this.context.config.getDirectWebFetch()) {
      return {
        ...schema,
        description:
          'Fetch content from a URL directly. Send multiple requests for this tool if multiple URL fetches are needed.',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description:
                'The URL to fetch. Must be a valid http or https URL.',
            },
          },
          required: ['url'],
        },
      };
    }
    return schema;
  }
}
