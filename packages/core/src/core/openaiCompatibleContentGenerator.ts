/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */

import type {
  CountTokensResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Part,
  Content,
} from '@google/genai';
// Imported as a *value* (not just a type): we must construct real
// GenerateContentResponse instances so that accessor getters like
// `.functionCalls` / `.text` work. Plain object literals don't have those
// getters, which silently dropped tool calls (the model would announce a
// tool call but it was never executed, ending the turn).
import { FinishReason, GenerateContentResponse } from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { fetch } from 'undici';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { coreEvents } from '../utils/events.js';
import { isDebugLoggingEnabled } from '../utils/debugLogging.js';

// ---------------------------------------------------------------------------
// Debug logger
// ---------------------------------------------------------------------------
// Disabled by default. Enable via either:
//   - settings.json:  { "general": { "debugLogging": true } }
//   - env override:   OPENRND_DEBUG=true  (or =false to force-disable)
// The env var, when set, always wins over the settings.json value.
// Writes to ~/.openrnd/debug.log and stderr simultaneously.
// ---------------------------------------------------------------------------

function getLogPath(): string {
  return path.join(os.homedir(), '.openrnd', 'debug.log');
}

// Single source of truth for the debug-logging toggle lives in
// ../utils/debugLogging.ts so the corporate-fetch path and others share it.
const isDebugEnabled = isDebugLoggingEnabled;

// Surface an informational diagnostic in the terminal/chat window, but ONLY
// when debug logging is enabled. Errors/warnings still emit unconditionally so
// real failures are never hidden — this just silences the per-message
// "[LLM] Connecting/Connected/..." chatter during normal conversation.
function debugFeedback(message: string): void {
  if (!isDebugEnabled()) return;
  coreEvents.emitFeedback('info', message);
}

function debugLog(
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  ...args: unknown[]
): void {
  if (!isDebugEnabled()) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [openai-compat]`;

  const parts = args.map((a) =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a),
  );
  const line = `${prefix} ${parts.join(' ')}\n`;

  process.stderr.write(line);

  const logPath = getLogPath();
  try {
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (e) {
    process.stderr.write(
      `[openrnd] Failed to write log to ${logPath}: ${String(e)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// OpenAI API types (subset we need)
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIFunction {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: string;
  stream?: boolean;
  // Ask the server to emit a final usage chunk while streaming. Without this,
  // OpenAI-compatible servers omit token counts from the stream entirely.
  stream_options?: { include_usage: boolean };
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  // Sent as the final stream chunk when stream_options.include_usage is set.
  // This chunk typically has an empty `choices` array.
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Conversion helpers: Gemini <-> OpenAI
// ---------------------------------------------------------------------------

function geminiRoleToOpenAI(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'model') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

// Map an OpenAI-style finish_reason (lowercase, e.g. "stop") to the Gemini
// FinishReason enum value (uppercase, e.g. "STOP"). The downstream stream
// validator in geminiChat throws NO_FINISH_REASON (a *retryable* error) when a
// turn without tool calls has no finish reason — which makes the whole answer
// repeat on every retry. So we must always surface a valid finish reason.
function mapFinishReason(
  reason: string | null | undefined,
): FinishReason | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case 'stop':
    case 'tool_calls':
    case 'function_call':
    default:
      return FinishReason.STOP;
  }
}

// Build a *real* GenerateContentResponse instance from a plain shape. This is
// required so the SDK's computed getters (`functionCalls`, `text`, ...) work —
// downstream consumers (turn.ts, geminiChat) read `response.functionCalls` to
// decide whether to execute a tool and continue the turn. A plain object
// literal returns `undefined` there, so tool calls were silently dropped.
function makeGenerateContentResponse(
  shape: Partial<GenerateContentResponse>,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  Object.assign(response, shape);
  return response;
}

function partsToText(parts: Part[]): string {
  return parts
    .filter((p) => p.text !== undefined)
    .map((p) => p.text ?? '')
    .join('');
}

function geminiContentsToOpenAIMessages(
  contents: Content[],
  systemInstruction?: Content,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (systemInstruction) {
    const sysText = partsToText(systemInstruction.parts ?? []);
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const content of contents) {
    const role = geminiRoleToOpenAI(content.role ?? 'user');
    const parts = content.parts ?? [];

    // Check for function calls (assistant tool use)
    const functionCallParts = parts.filter((p) => p.functionCall !== undefined);
    const textParts = parts.filter((p) => p.text !== undefined);
    // Check for function responses (tool results)
    const functionResponseParts = parts.filter(
      (p) => p.functionResponse !== undefined,
    );

    if (functionResponseParts.length > 0) {
      // Each function response becomes a separate tool message
      for (const p of functionResponseParts) {
        if (p.functionResponse) {
          messages.push({
            role: 'tool',
            tool_call_id:
              p.functionResponse.id ?? p.functionResponse.name ?? 'unknown',
            content: JSON.stringify(p.functionResponse.response),
          });
        }
      }
    } else if (functionCallParts.length > 0) {
      const toolCalls: OpenAIToolCall[] = functionCallParts.map((p, i) => ({
        id: p.functionCall?.id ?? `call_${i}`,
        type: 'function' as const,
        function: {
          name: p.functionCall?.name ?? '',
          arguments: JSON.stringify(p.functionCall?.args ?? {}),
        },
      }));
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? partsToText(textParts) : null,
        tool_calls: toolCalls,
      });
    } else {
      const text = partsToText(parts);
      messages.push({ role, content: text });
    }
  }

  return messages;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function geminiToolsToOpenAI(tools: any[]): OpenAITool[] {
  const openAITools: OpenAITool[] = [];
  for (const tool of tools) {
    const declarations = tool.functionDeclarations ?? [];
    for (const decl of declarations) {
      openAITools.push({
        type: 'function',
        function: {
          name: decl.name,
          description: decl.description,
          parameters: decl.parametersJsonSchema ?? decl.parameters,
        },
      });
    }
  }
  return openAITools;
}

function openAIResponseToGemini(
  response: OpenAIChatResponse,
  modelUsed: string,
): GenerateContentResponse {
  const choice = response.choices[0];
  if (!choice) {
    return makeGenerateContentResponse({
      candidates: [],
      usageMetadata: {},
    });
  }

  const parts: Part[] = [];

  if (choice.message.content) {
    parts.push({ text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<
          string,
          unknown
        >;
      } catch {
        // ignore parse errors
      }
      parts.push({
        functionCall: {
          id: toolCall.id,
          name: toolCall.function.name,
          args,
        },
      });
    }
  }

  return makeGenerateContentResponse({
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason:
          mapFinishReason(choice.finish_reason) ?? FinishReason.STOP,
        index: choice.index,
      },
    ],
    usageMetadata: response.usage
      ? {
          promptTokenCount: response.usage.prompt_tokens,
          candidatesTokenCount: response.usage.completion_tokens,
          totalTokenCount: response.usage.total_tokens,
        }
      : {},
    modelVersion: modelUsed,
  });
}

// ---------------------------------------------------------------------------
// OpenAICompatibleContentGenerator
// ---------------------------------------------------------------------------

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseUrl?: string, apiKey?: string, model?: string) {
    this.baseUrl =
      baseUrl ?? process.env['OPENRND_BASE_URL'] ?? 'http://localhost:11434/v1';
    this.apiKey = apiKey ?? process.env['OPENRND_API_KEY'] ?? 'ollama';
    this.model = model ?? process.env['OPENRND_MODEL'] ?? 'llama3.2';

    debugLog('INFO', 'OpenAICompatibleContentGenerator initialized', {
      baseUrl: this.baseUrl,
      model: this.model,
      apiKeySet: this.apiKey !== 'ollama' ? '(custom)' : '(default: ollama)',
      debugLogPath: process.env['OPENRND_DEBUG'] ? getLogPath() : '(disabled)',
    });
  }

  private buildRequest(
    request: GenerateContentParameters,
    stream: boolean,
  ): OpenAIChatRequest {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = request.config as any;
    const contents = (request.contents ?? []) as Content[];
    const systemInstruction = config?.systemInstruction as Content | undefined;

    const messages = geminiContentsToOpenAIMessages(
      contents,
      systemInstruction,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawTools = (config?.tools ?? []) as any[];
    const tools =
      rawTools.length > 0 ? geminiToolsToOpenAI(rawTools) : undefined;

    const req: OpenAIChatRequest = {
      model: this.model,
      messages,
      stream,
    };

    // While streaming, ask the server to include a final usage chunk so we can
    // record token usage (otherwise streamed responses report 0 tokens).
    if (stream) {
      req.stream_options = { include_usage: true };
    }

    if (tools && tools.length > 0) {
      req.tools = tools;
    }

    if (config?.temperature !== undefined) {
      req.temperature = config.temperature as number;
    }
    if (config?.maxOutputTokens !== undefined) {
      req.max_tokens = config.maxOutputTokens as number;
    }

    return req;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const body = this.buildRequest(request, false);
    const url = `${this.baseUrl}/chat/completions`;

    debugLog('DEBUG', 'generateContent → request', {
      url,
      model: body.model,
      messageCount: body.messages.length,
      toolCount: body.tools?.length ?? 0,
      messages: body.messages.map((m) => ({
        role: m.role,
        contentLength: typeof m.content === 'string' ? m.content.length : 0,
      })),
    });
    debugFeedback(`[LLM] Connecting → ${url} (model: ${body.model})`);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      debugLog(
        'ERROR',
        'generateContent → fetch failed (network/connection error)',
        {
          url,
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      );
      coreEvents.emitFeedback(
        'error',
        `[LLM] Connection failed → ${url}: ${String(err)}`,
      );
      throw err;
    }

    debugLog('DEBUG', 'generateContent → response received', {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (!response.ok) {
      const errorText = await response.text();
      debugLog('ERROR', 'generateContent → HTTP error', {
        status: response.status,
        body: errorText,
      });
      coreEvents.emitFeedback(
        'error',
        `[LLM] HTTP ${response.status} from ${url}: ${errorText}`,
      );
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorText}`,
      );
    }

    debugFeedback(
      `[LLM] Connected (HTTP ${response.status}), reading response...`,
    );
    const data = (await response.json()) as OpenAIChatResponse;
    debugLog('DEBUG', 'generateContent → success', {
      id: data.id,
      model: data.model,
      finishReason: data.choices[0]?.finish_reason,
      usage: data.usage,
      contentLength: data.choices[0]?.message?.content?.length ?? 0,
    });
    return openAIResponseToGemini(data, this.model);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const body = this.buildRequest(request, true);
    const url = `${this.baseUrl}/chat/completions`;

    debugLog('DEBUG', 'generateContentStream → request', {
      url,
      model: body.model,
      messageCount: body.messages.length,
      toolCount: body.tools?.length ?? 0,
      messages: body.messages.map((m) => ({
        role: m.role,
        contentLength: typeof m.content === 'string' ? m.content.length : 0,
      })),
    });
    debugFeedback(`[LLM] Connecting → ${url} (model: ${body.model}, stream)`);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      debugLog(
        'ERROR',
        'generateContentStream → fetch failed (network/connection error)',
        {
          url,
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      );
      coreEvents.emitFeedback(
        'error',
        `[LLM] Connection failed → ${url}: ${String(err)}`,
      );
      throw err;
    }

    debugLog('DEBUG', 'generateContentStream → response received', {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (!response.ok) {
      const errorText = await response.text();
      debugLog('ERROR', 'generateContentStream → HTTP error', {
        status: response.status,
        body: errorText,
      });
      coreEvents.emitFeedback(
        'error',
        `[LLM] HTTP ${response.status} from ${url}: ${errorText}`,
      );
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorText}`,
      );
    }
    debugFeedback(`[LLM] Connected (HTTP ${response.status}), streaming...`);

    const model = this.model;

    async function* streamGenerator(): AsyncGenerator<GenerateContentResponse> {
      const reader = response.body?.getReader();
      if (!reader) {
        debugLog(
          'ERROR',
          'generateContentStream → response.body reader is null',
        );
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let chunkCount = 0;
      let totalContentLength = 0;
      let rawChunkCount = 0;
      let rawPreviewEmitted = false;

      // Accumulate tool call deltas
      const toolCallAccumulator: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};

      debugLog('DEBUG', 'generateContentStream → stream reading started');

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            debugLog('DEBUG', 'generateContentStream → stream done', {
              totalChunks: chunkCount,
              totalContentLength,
              rawNetworkChunks: rawChunkCount,
            });
            if (totalContentLength === 0) {
              coreEvents.emitFeedback(
                'warning',
                `[LLM] Stream ended with 0 parsed content (raw network chunks: ${rawChunkCount}). The server's response format may not match SSE parsing — check ~/.openrnd/debug.log for the RAW lines.`,
              );
            }
            break;
          }

          const decoded = decoder.decode(value, { stream: true });
          rawChunkCount++;

          // Dump the raw bytes from the server so we can see its exact wire
          // format when parsing yields nothing.
          debugLog('DEBUG', 'generateContentStream → RAW network chunk', {
            chunkIndex: rawChunkCount,
            length: decoded.length,
            raw: decoded,
          });
          // Surface the very first raw chunk in the chat window too, so the
          // user can see the server's format without opening the log file.
          if (!rawPreviewEmitted) {
            rawPreviewEmitted = true;
            const preview = decoded.slice(0, 300).replace(/\n/g, '\\n');
            debugFeedback(`[LLM] First raw response chunk: ${preview}`);
          }

          buffer += decoded;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Tolerate both "data: " and "data:" (some servers omit the space).
            // Lines that aren't SSE "data:" events (e.g. ": comment", "event:")
            // are skipped.
            if (!trimmed.startsWith('data:')) {
              debugLog('DEBUG', 'generateContentStream → non-data SSE line', {
                line: trimmed,
              });
              continue;
            }
            const data = trimmed.slice(5).trimStart();
            if (data === '[DONE]') return;

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(data) as OpenAIStreamChunk;
            } catch (parseErr) {
              debugLog(
                'WARN',
                'generateContentStream → failed to parse SSE chunk',
                {
                  raw: data,
                  error: String(parseErr),
                },
              );
              continue;
            }

            // The final usage chunk (from stream_options.include_usage) carries
            // token counts and usually has an empty `choices` array, so capture
            // it before the no-choice skip below. Emitted as a usage-only
            // response that downstream consumers record but render no content.
            if (chunk.usage) {
              yield makeGenerateContentResponse({
                candidates: [],
                usageMetadata: {
                  promptTokenCount: chunk.usage.prompt_tokens,
                  candidatesTokenCount: chunk.usage.completion_tokens,
                  totalTokenCount: chunk.usage.total_tokens,
                },
                modelVersion: model,
              });
            }

            const choice = chunk.choices[0];
            if (!choice) {
              debugLog(
                'DEBUG',
                'generateContentStream → parsed chunk has no choices[0]',
                { parsed: chunk },
              );
              continue;
            }

            const delta = choice.delta;
            // Log the parsed delta shape so we can spot content in an
            // unexpected field (e.g. message vs delta, reasoning_content, etc.)
            debugLog('DEBUG', 'generateContentStream → parsed delta', {
              delta,
              finish_reason: choice.finish_reason,
              choiceKeys: Object.keys(choice),
            });
            const parts: Part[] = [];

            // Accumulate tool calls across chunks
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAccumulator[idx]) {
                  // Initialize name/arguments empty; they are accumulated via
                  // `+=` below. Seeding name with tc.function.name here AND
                  // appending it would double it (e.g. "manage_skill" became
                  // "manage_skillmanage_skill"), so the tool lookup failed and
                  // the model retried in a loop.
                  toolCallAccumulator[idx] = {
                    id: tc.id ?? `call_${idx}`,
                    name: '',
                    arguments: '',
                  };
                }
                if (tc.id) toolCallAccumulator[idx].id = tc.id;
                if (tc.function?.name)
                  toolCallAccumulator[idx].name += tc.function.name;
                if (tc.function?.arguments)
                  toolCallAccumulator[idx].arguments += tc.function.arguments;
              }
            }

            if (delta.content) {
              parts.push({ text: delta.content });
              chunkCount++;
              totalContentLength += delta.content.length;
            }

            // A non-null finish_reason marks the final chunk of the turn.
            // Many OpenAI-compatible servers (e.g. mlx_lm.server) send this
            // final chunk with empty content, so we must NOT gate emission on
            // parts being present — otherwise the finish reason is dropped and
            // the consumer retries the whole stream.
            const isFinished = choice.finish_reason != null;

            // On finish, emit accumulated tool calls
            if (isFinished) {
              for (const [, tc] of Object.entries(toolCallAccumulator)) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.arguments) as Record<string, unknown>;
                } catch {
                  // ignore
                }
                parts.push({
                  functionCall: {
                    id: tc.id,
                    name: tc.name,
                    args,
                  },
                });
              }
            }

            if (parts.length > 0 || isFinished) {
              yield makeGenerateContentResponse({
                candidates: [
                  {
                    content: { role: 'model', parts },
                    finishReason: isFinished
                      ? mapFinishReason(choice.finish_reason)
                      : undefined,
                    index: choice.index,
                  },
                ],
                usageMetadata: {},
                modelVersion: model,
              });
            }
          }
        }
      } catch (streamErr) {
        debugLog(
          'ERROR',
          'generateContentStream → error while reading stream',
          {
            error: String(streamErr),
            stack: streamErr instanceof Error ? streamErr.stack : undefined,
            chunksReceivedBeforeError: chunkCount,
          },
        );
        coreEvents.emitFeedback(
          'error',
          `[LLM] Stream error after ${chunkCount} chunks: ${String(streamErr)}`,
        );
        throw streamErr;
      } finally {
        reader.releaseLock();
      }
    }

    return streamGenerator();
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Most local models don't have a token count endpoint; return a rough estimate
    return {
      totalTokens: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'embedContent is not supported by OpenAI-compatible provider',
    );
  }
}
