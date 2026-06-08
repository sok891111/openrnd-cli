/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { fetch } from 'undici';
import { OpenAICompatibleContentGenerator } from './openaiCompatibleContentGenerator.js';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

const mockedFetch = vi.mocked(fetch);

/** Builds a Response-like object whose body streams the given SSE lines. */
function sseResponse(lines: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: stream,
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

async function collect(
  gen: AsyncGenerator<GenerateContentResponse>,
): Promise<GenerateContentResponse[]> {
  const out: GenerateContentResponse[] = [];
  for await (const r of gen) {
    out.push(r);
  }
  return out;
}

describe('OpenAICompatibleContentGenerator streaming usage', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('requests usage in the stream and surfaces token counts', async () => {
    mockedFetch.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        // Final usage-only chunk: empty choices, real token counts.
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n',
        'data: [DONE]\n',
      ]),
    );

    const gen = new OpenAICompatibleContentGenerator(
      'http://localhost/v1',
      'key',
      'in-house-model',
    );
    const responses = await collect(
      await gen.generateContentStream(
        { model: 'in-house-model', contents: [] },
        'prompt-1',
        'model' as never,
      ),
    );

    // The request body must opt into usage reporting.
    const body = JSON.parse(
      mockedFetch.mock.calls[0][1]!.body as string,
    ) as Record<string, unknown>;
    expect(body['stream_options']).toEqual({ include_usage: true });

    // A response carrying the parsed usage must be yielded.
    const withUsage = responses.find(
      (r) => r.usageMetadata?.totalTokenCount === 16,
    );
    expect(withUsage).toBeDefined();
    expect(withUsage!.usageMetadata?.promptTokenCount).toBe(12);
    expect(withUsage!.usageMetadata?.candidatesTokenCount).toBe(4);
  });
});
