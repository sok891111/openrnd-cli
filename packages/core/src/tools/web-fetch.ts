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
import { coreEvents, CoreEvent } from '../utils/events.js';
import { retryWithBackoff, getRetryErrorType } from '../utils/retry.js';
import { WEB_FETCH_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { LRUCache } from 'mnemonist';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  tryCorporateFetch,
  matchCorporateSystem,
  getRememberedFallbackChoice,
  rememberFallbackChoice,
  type CorporateFetchContext,
} from './corporate-fetch.js';

const URL_FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 250000;
const MAX_EXPERIMENTAL_FETCH_SIZE = 10 * 1024 * 1024; // 10MB
// Responses at or below this size (bytes) are treated as a likely SSO/login
// stub even on HTTP 200 — corporate IdPs often serve a tiny (~1KB) bootstrap
// page instead of a redirect. Tunable via OPENRND_WEBFETCH_MIN_CONTENT_LENGTH.
const DEFAULT_SSO_STUB_THRESHOLD = 10000;
// How long to wait after navigation before extracting page text, so SPA /
// detail pages have time to render. Tunable via OPENRND_WEBFETCH_BROWSER_WAIT_MS.
const DEFAULT_BROWSER_SETTLE_MS = 5000;

// Shown when the browser fallback can't open / drive the page. The browser
// agent (chrome-devtools-mcp) attaches over Chrome's remote debugging protocol,
// which the user must enable first.
const CHROME_REMOTE_DEBUG_HINT =
  '브라우저가 열리지 않으면 Chrome 원격 디버깅(remote debugging)이 켜져 있어야 합니다.\n' +
  '  1) Chrome 주소창에 chrome://inspect/#remote-debugging 를 열어 원격 디버깅을 활성화하거나\n' +
  '  2) Chrome 을 원격 디버깅 포트로 실행하세요: chrome --remote-debugging-port=9222';
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
 * Strips punctuation that commonly clings to a URL when it is embedded in prose,
 * so the extracted URL doesn't carry junk like a trailing period or wrapping
 * brackets. Examples:
 *   "https://example.com."        -> "https://example.com"
 *   "(https://example.com)"       -> "https://example.com"
 *   "<https://example.com>,"      -> "https://example.com"
 *
 * Trailing closing brackets are only stripped when unbalanced, so URLs that
 * legitimately contain them (e.g. Wikipedia's ".../Foo_(disambiguation)") are
 * left intact.
 */
export function trimUrlPunctuation(token: string): string {
  // Strip leading openers / quotes.
  let s = token.replace(/^[([{<'"`]+/, '');

  // Strip trailing punctuation iteratively so combinations like ")." or ").
  // are fully removed.
  const ALWAYS_TRIM_TRAILING = `.,;:!?'"\`>`;
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    const last = s[s.length - 1];

    if (ALWAYS_TRIM_TRAILING.includes(last)) {
      s = s.slice(0, -1);
      changed = true;
      continue;
    }

    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const opens = s.split(open).length - 1;
      const closes = s.split(last).length - 1;
      // Only an unmatched closer is treated as trailing prose punctuation.
      if (closes > opens) {
        s = s.slice(0, -1);
        changed = true;
      }
    }
  }

  return s;
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

  for (const rawToken of tokens) {
    if (!rawToken) continue;

    // Strip surrounding prose punctuation before validation so that, e.g.,
    // "https://example.com." doesn't end up fetched with a trailing dot.
    const token = trimUrlPunctuation(rawToken);
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
 * Collects URLs from both the explicit `url` parameter and any URLs embedded in
 * the `prompt` string.
 *
 * The non-direct (default) web_fetch schema only declares the `prompt`
 * parameter, but some models emit the URL in a separate `url` field instead of
 * embedding it in the prompt text. When that happens the prompt contains no
 * URL and parsing it alone yields "must contain at least one valid URL", even
 * though a perfectly valid URL was provided. Considering both sources makes the
 * tool robust to either calling convention.
 */
export function collectUrlsFromParams(params: WebFetchToolParams): {
  validUrls: string[];
  errors: string[];
} {
  const validUrls: string[] = [];
  const errors: string[] = [];

  if (params.url) {
    const cleanedUrl = trimUrlPunctuation(params.url.trim());
    try {
      const url = new URL(cleanedUrl);
      if (['http:', 'https:'].includes(url.protocol)) {
        validUrls.push(url.href);
      } else {
        errors.push(
          `Unsupported protocol in URL: "${cleanedUrl}". Only http and https are supported.`,
        );
      }
    } catch {
      errors.push(`Malformed URL detected: "${cleanedUrl}".`);
    }
  }

  if (params.prompt) {
    const parsed = parsePrompt(params.prompt);
    validUrls.push(...parsed.validUrls);
    errors.push(...parsed.errors);
  }

  return { validUrls: [...new Set(validUrls)], errors };
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
    debugLogger.debug(
      `[WebFetchTool] Opening signed-in browser session (sessionMode=existing) for: ${urlStr}`,
    );
    try {
      await manager.callTool('new_page', { url: urlStr }, signal, true);

      // Give SPA / detail pages time to render before reading their text.
      const settleMs = this.getBrowserSettleMs();
      if (settleMs > 0) {
        debugLogger.debug(
          `[WebFetchTool] Waiting ${settleMs}ms for page render before extracting text: ${urlStr}`,
        );
        await this.waitForPageSettle(signal);
      }

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
      debugLogger.debug(
        `[WebFetchTool] Read ${text.length} chars via browser: ${urlStr}`,
      );
      return text;
    } catch (err) {
      // Surface the real reason directly in the terminal, and always append the
      // remote-debugging hint: the most common cause of "the browser won't open"
      // is that Chrome remote debugging isn't enabled.
      coreEvents.emitFeedback(
        'error',
        `❌ [web_fetch] 브라우저 폴백 실패 (${urlStr}):\n${getErrorMessage(err)}\n\n💡 ${CHROME_REMOTE_DEBUG_HINT}`,
      );
      throw new Error(`${getErrorMessage(err)}\n\n${CHROME_REMOTE_DEBUG_HINT}`);
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

  /**
   * Milliseconds to wait after navigation before reading page text, giving
   * SPA / detail pages time to render. Tunable via
   * OPENRND_WEBFETCH_BROWSER_WAIT_MS; 0 disables the wait.
   */
  private getBrowserSettleMs(): number {
    const raw = process.env['OPENRND_WEBFETCH_BROWSER_WAIT_MS'];
    if (raw !== undefined) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) {
        return n;
      }
    }
    return DEFAULT_BROWSER_SETTLE_MS;
  }

  /** Abortable sleep used to let the page settle after navigation. */
  private async waitForPageSettle(signal: AbortSignal): Promise<void> {
    const ms = this.getBrowserSettleMs();
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Operation cancelled'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Operation cancelled'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
   * Builds the context passed to corporate (사내) fetch handlers.
   *
   * `emitInfo` carries the handlers' Python `print(..., file=sys.stderr)`
   * lines (🐍 …) plus per-handler trace messages. These are *informational*
   * developer logs, so they go to the debug logger (visible in the debug
   * drawer / debug.log only when debug logging is enabled) and never clutter
   * the chat. Real failures still surface via the error feedback emitted
   * directly by the callers below.
   */
  private makeCorporateFetchContext(
    signal: AbortSignal,
  ): CorporateFetchContext {
    return {
      signal,
      emitInfo: (message: string) => debugLogger.debug(message),
    };
  }

  /** Whether the interactive SSO fallback prompt is disabled (keep auto-browser). */
  private isBrowserPromptDisabled(): boolean {
    const raw = (
      process.env['OPENRND_WEBFETCH_BROWSER_PROMPT'] ?? ''
    ).toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off';
  }

  /**
   * When a direct fetch is blocked by SSO and no API key (corporate credential)
   * produced content, decide how to proceed:
   *   • true   → open the URL via the signed-in browser session
   *   • false  → stop and use an API key instead (register via manage_credential)
   *
   * Two rules govern whether (and how) we ask:
   *
   *   1) Only prompt for URLs that an API key could actually help with — i.e.
   *      URLs a corporate fetch handler claims (matchCorporateSystem != null).
   *      If no handler matches, there is no API to register, so we skip the
   *      question and go straight to the browser.
   *
   *   2) Once the user has chosen, remember that choice and reuse it as the
   *      default WITHOUT re-prompting, until a credential is (re)registered via
   *      manage_credential (which clears the remembered choice).
   *
   * Also auto-returns true when prompting is disabled or there is no interactive
   * UI listening.
   */
  private async confirmBrowserFallback(
    url: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    // (1) Only URLs a corporate handler claims are "API-requiring". For anything
    // else, registering an API key is meaningless — open the browser directly.
    const system = await matchCorporateSystem(url, signal).catch(() => null);
    if (!system) {
      return true;
    }

    // (2) Reuse the previously chosen route without asking again.
    const remembered = getRememberedFallbackChoice();
    if (remembered === 'browser') {
      return true;
    }
    if (remembered === 'apikey') {
      return false;
    }

    if (this.isBrowserPromptDisabled()) {
      return true;
    }
    // Non-interactive run (no dialog UI): keep the existing auto-browser path.
    if (coreEvents.listenerCount(CoreEvent.ConsentRequest) === 0) {
      return true;
    }

    const systemLabel = system.name
      ? `${system.name} (${system.id})`
      : system.id;
    const prompt =
      `🔐 SSO 인증 벽으로 직접 가져오기가 막혔습니다:\n${url}\n\n` +
      `이 URL 은 사내 시스템 '${systemLabel}' 핸들러가 처리하며, 등록된 API 키` +
      `(자격증명)가 없어 서버에서 바로 가져올 수 없습니다. 어떻게 진행할까요?\n\n` +
      '  • 예  → 로그인된 브라우저 세션으로 열어서 내용을 가져옵니다\n' +
      `  • 아니오 → 중단합니다. API 키를 쓰려면 manage_credential 툴로 '${system.id}' ` +
      '키를 등록한 뒤 다시 시도하세요\n\n' +
      '(선택한 답은 키를 등록하기 전까지 기억되어 다시 묻지 않습니다.)';

    const confirmed = await new Promise<boolean>((resolve) => {
      coreEvents.emitConsentRequest({
        prompt,
        onConfirm: (c: boolean) => resolve(c),
      });
    });
    rememberFallbackChoice(confirmed ? 'browser' : 'apikey');
    return confirmed;
  }

  /** Guidance returned when the user chooses the API-key route over the browser. */
  private apiKeyGuidance(url: string): string {
    return (
      'SSO 로 직접 가져오기가 막혔고, 브라우저 열기 대신 API 키 사용을 선택했습니다.\n' +
      'manage_credential 툴로 해당 시스템의 API 키(자격증명)를 등록한 뒤 web_fetch 를 ' +
      '다시 실행하세요. 등록되면 사내 fetch 핸들러가 그 키로 자동 인증해 가져옵니다.\n' +
      `URL: ${url}`
    );
  }

  /**
   * Fallback step between the direct fetch and the browser session: try the
   * corporate per-URL fetch handlers defined in corporate-fetch.ts; if none
   * match or all fail, ask the user (browser vs API key) and act on the choice.
   * Returns page text. Throws {@link apiKeyGuidance} if the API-key route is chosen.
   */
  private async corporateThenBrowser(
    url: string,
    signal: AbortSignal,
  ): Promise<string> {
    const corp = await tryCorporateFetch(
      url,
      this.makeCorporateFetchContext(signal),
    );
    if (corp) {
      debugLogger.debug(
        `[WebFetchTool] Read ${corp.text.length} chars via corporate fetch handler (${corp.handlerName}): ${url}`,
      );
      return corp.text;
    }
    if (!(await this.confirmBrowserFallback(url, signal))) {
      throw new Error(this.apiKeyGuidance(url));
    }
    return this.fetchViaBrowser(url, signal);
  }

  /**
   * ToolResult-returning variant of {@link corporateThenBrowser} for the
   * experimental direct-fetch path.
   */
  private async corporateOrBrowserResult(
    url: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const corp = await tryCorporateFetch(
      url,
      this.makeCorporateFetchContext(signal),
    );
    if (corp) {
      debugLogger.debug(
        `[WebFetchTool] Read ${corp.text.length} chars via corporate fetch handler (${corp.handlerName}): ${url}`,
      );
      return {
        llmContent: this.applyFallbackTruncation(corp.text),
        returnDisplay: `Fetched content from ${url} via corporate fetch handler (${corp.handlerName}).`,
      };
    }
    if (!(await this.confirmBrowserFallback(url, signal))) {
      const msg = this.apiKeyGuidance(url);
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: {
          message: 'User chose the API-key route over the browser fallback.',
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
      };
    }
    return this.browserFetchResult(url, signal);
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
    // back to the corporate handlers / signed-in browser session. The fallback
    // (corporateThenBrowser) is invoked exactly ONCE — its own errors (e.g. the
    // user choosing the API-key route, or the browser failing to attach) must
    // propagate to the caller, not get caught here and retried.
    if (this.shouldUseBrowserFetch()) {
      try {
        const { response, text, byteLength } = await this.nodeFetchText(
          url,
          signal,
        );
        const reason = this.browserFallbackReason(url, response, byteLength);
        if (!reason) {
          return this.applyFallbackTruncation(text);
        }
        debugLogger.warn(
          `[WebFetchTool] ${reason} for ${url}. Falling back to corporate/browser fetch.`,
        );
      } catch (error) {
        debugLogger.warn(
          `[WebFetchTool] Direct fetch failed for ${url} ` +
            `(${getErrorMessage(error)}). Falling back to corporate/browser fetch.`,
        );
      }
      return this.corporateThenBrowser(url, signal);
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
    const { validUrls } = collectUrlsFromParams(this.params);
    let urls: string[] = validUrls;
    const prompt =
      this.params.prompt || (this.params.url ? `Fetch ${this.params.url}` : '');

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
        debugLogger.warn(
          `[WebFetchTool] Auth/SSO wall detected for ${url} ` +
            `(status ${status}). Using corporate/browser fetch.`,
        );
        return await this.corporateOrBrowserResult(url, signal);
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
        debugLogger.warn(
          `[WebFetchTool] Suspected SSO stub — response size ${size}B <= ${this.getSsoStubThreshold()}B (status ${status}) for ${url}. Falling back to corporate/browser fetch.`,
        );
        return await this.corporateOrBrowserResult(url, signal);
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
        debugLogger.warn(
          `[WebFetchTool] Experimental fetch failed for ${url} ` +
            `(${getErrorMessage(e)}). Falling back to corporate/browser fetch.`,
        );
        try {
          return await this.corporateOrBrowserResult(url, signal);
        } catch (browserError) {
          const errorMessage =
            `Error during experimental fetch for ${url}: ${getErrorMessage(e)}; ` +
            `corporate/browser fallback also failed: ${getErrorMessage(browserError)}`;
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
    const { validUrls } = collectUrlsFromParams(this.params);
    const userPrompt =
      this.params.prompt ?? (this.params.url ? `Fetch ${this.params.url}` : '');

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

    // When the browser fallback is enabled (default), fetch the URL(s) directly
    // over HTTP instead of via the Gemini "web-fetch" grounded model.
    //
    // Why: that grounded model needs Google's backend/auth (removed in openrnd)
    // and does NOT actually fetch URLs under a local LLM — it returns a normal
    // completion with no error. So the old browser logic, which only ran when
    // the primary path *failed*, was never reached for intranet URLs. Routing
    // through the direct path makes the SSO/stub detection (incl. body-length)
    // trigger the browser purely from the HTTP response, regardless of error.
    if (this.shouldUseBrowserFetch()) {
      return this.executeFallback(toFetch, signal);
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

    const hasPrompt = !!params.prompt && params.prompt.trim() !== '';
    const hasUrl = !!params.url;
    if (!hasPrompt && !hasUrl) {
      return "The 'prompt' parameter cannot be empty and must contain URL(s) and instructions.";
    }

    const { validUrls, errors } = collectUrlsFromParams(params);

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

    // Non-direct (default) mode: the canonical contract is a single `prompt`
    // string with the URL(s) embedded. However, some models emit the URL in a
    // separate `url` field instead, which previously failed schema validation
    // ("must have required property 'prompt'") or the URL parse ("must contain
    // at least one valid URL"). Advertise `url` as an optional alternative and
    // relax the hard `prompt` requirement; validateToolParamValues still
    // guarantees at least one valid URL is supplied via either field.
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null;
    const baseParams = isRecord(schema.parametersJsonSchema)
      ? schema.parametersJsonSchema
      : {};
    const baseProps = isRecord(baseParams['properties'])
      ? baseParams['properties']
      : {};
    return {
      ...schema,
      parametersJsonSchema: {
        type: 'object',
        ...baseParams,
        properties: {
          ...baseProps,
          url: {
            type: 'string',
            description:
              'Optional single URL to fetch, as an alternative to embedding the URL in the prompt. Must be a valid http or https URL.',
          },
        },
        required: [],
      },
    };
  }
}
