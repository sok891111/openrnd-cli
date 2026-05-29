/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */

import type {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  Part,
  Content,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { fetch } from 'undici';

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
}

// ---------------------------------------------------------------------------
// Conversion helpers: Gemini <-> OpenAI
// ---------------------------------------------------------------------------

function geminiRoleToOpenAI(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'model') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
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
    return {
      candidates: [],
      usageMetadata: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
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

  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: choice.finish_reason as string,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorText}`,
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    return openAIResponseToGemini(data, this.model);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const body = this.buildRequest(request, true);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorText}`,
      );
    }

    const model = this.model;

    async function* streamGenerator(): AsyncGenerator<GenerateContentResponse> {
      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      // Accumulate tool call deltas
      const toolCallAccumulator: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') return;

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(data) as OpenAIStreamChunk;
            } catch {
              continue;
            }

            const choice = chunk.choices[0];
            if (!choice) continue;

            const delta = choice.delta;
            const parts: Part[] = [];

            // Accumulate tool calls across chunks
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallAccumulator[idx]) {
                  toolCallAccumulator[idx] = {
                    id: tc.id ?? `call_${idx}`,
                    name: tc.function?.name ?? '',
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
            }

            // On finish, emit accumulated tool calls
            if (
              choice.finish_reason === 'tool_calls' ||
              choice.finish_reason === 'stop'
            ) {
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

            if (parts.length > 0) {
              yield {
                candidates: [
                  {
                    content: { role: 'model', parts },
                    finishReason: choice.finish_reason ?? undefined,
                    index: choice.index,
                  },
                ],
                usageMetadata: {},
                modelVersion: model,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any;
            }
          }
        }
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
