/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';
import { fetch } from 'undici';
import {
  clearVisionDescriptionCache,
  contentsHaveImages,
  describeImagesInContents,
  getVisionConfigFromEnv,
  type VisionConfig,
} from './visionDescriber.js';
import { coreEvents } from '../utils/events.js';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

const mockedFetch = vi.mocked(fetch);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const IMAGE_PART = {
  inlineData: { mimeType: 'image/png', data: 'AAAA' },
};

describe('getVisionConfigFromEnv', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('returns undefined when baseUrl or model is missing', () => {
    delete process.env['OPENWORK_VISION_BASE_URL'];
    delete process.env['OPENWORK_VISION_MODEL'];
    expect(getVisionConfigFromEnv()).toBeUndefined();

    process.env['OPENWORK_VISION_BASE_URL'] = 'http://v/v1';
    expect(getVisionConfigFromEnv()).toBeUndefined();
  });

  it('reads config and falls back to the primary key', () => {
    process.env['OPENWORK_VISION_BASE_URL'] = 'http://v/v1';
    process.env['OPENWORK_VISION_MODEL'] = 'llava';
    delete process.env['OPENWORK_VISION_API_KEY'];
    process.env['OPENWORK_API_KEY'] = 'primary-key';

    expect(getVisionConfigFromEnv()).toEqual({
      baseUrl: 'http://v/v1',
      model: 'llava',
      apiKey: 'primary-key',
    });
  });
});

describe('contentsHaveImages', () => {
  it('detects image inlineData parts only', () => {
    expect(
      contentsHaveImages([{ role: 'user', parts: [{ text: 'hi' }] }]),
    ).toBe(false);
    expect(contentsHaveImages([{ role: 'user', parts: [IMAGE_PART] }])).toBe(
      true,
    );
    // non-image inlineData (e.g. audio) is ignored
    expect(
      contentsHaveImages([
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'audio/mp3', data: 'x' } }],
        },
      ]),
    ).toBe(false);
  });
});

describe('describeImagesInContents', () => {
  const config: VisionConfig = {
    baseUrl: 'http://vision/v1',
    apiKey: 'k',
    model: 'llava',
  };

  beforeEach(() => {
    mockedFetch.mockReset();
    clearVisionDescriptionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replaces image parts with the vision model description', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'A red square chart.' } }],
      }),
    );

    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'analyze this' }, IMAGE_PART] },
    ];
    const out = await describeImagesInContents(contents, config);

    // The image is gone; the original text and the description text remain.
    const parts = out[0].parts ?? [];
    expect(parts.some((p) => p.inlineData)).toBe(false);
    const text = parts.map((p) => p.text ?? '').join('');
    expect(text).toContain('analyze this');
    expect(text).toContain('A red square chart.');

    // Vision endpoint was called with OpenAI image_url content.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('http://vision/v1/chat/completions');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('llava');
    const userContent = body.messages[0].content;
    expect(
      userContent.some((c: { type: string }) => c.type === 'image_url'),
    ).toBe(true);
  });

  it('emits progress feedback only after vision analysis takes long enough', async () => {
    vi.useFakeTimers();
    const feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
    let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
    const fetchPromise = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );
    mockedFetch.mockReturnValue(fetchPromise);

    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'analyze this' }, IMAGE_PART, IMAGE_PART, IMAGE_PART],
      },
    ];
    const resultPromise = describeImagesInContents(contents, config);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(feedbackSpy).not.toHaveBeenCalledWith(
      'info',
      expect.stringContaining('이미지 3개를 분석 중입니다'),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(feedbackSpy).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('이미지 3개를 분석 중입니다'),
    );

    resolveFetch(
      jsonResponse({
        choices: [{ message: { content: 'delayed description' } }],
      }),
    );
    await resultPromise;
  });

  it('cancels progress feedback when vision analysis finishes quickly', async () => {
    vi.useFakeTimers();
    const feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
    mockedFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'quick description' } }],
      }),
    );

    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'analyze this' }, IMAGE_PART, IMAGE_PART, IMAGE_PART],
      },
    ];
    await describeImagesInContents(contents, config);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(feedbackSpy).not.toHaveBeenCalledWith(
      'info',
      expect.stringContaining('이미지 3개를 분석 중입니다'),
    );
  });

  it('never emits progress feedback for 2 or fewer images', async () => {
    vi.useFakeTimers();
    const feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
    let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
    const fetchPromise = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => {
        resolveFetch = resolve;
      },
    );
    mockedFetch.mockReturnValue(fetchPromise);

    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'analyze this' }, IMAGE_PART, IMAGE_PART],
      },
    ];
    const resultPromise = describeImagesInContents(contents, config);

    // Even after the progress delay elapses, no feedback should appear because
    // 2 or fewer images are processed quickly by the in-house vision model.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(feedbackSpy).not.toHaveBeenCalledWith(
      'info',
      expect.stringContaining('분석 중입니다'),
    );

    resolveFetch(
      jsonResponse({
        choices: [{ message: { content: 'desc' } }],
      }),
    );
    await resultPromise;
  });

  it('sends one request per image and never batches multiple images', async () => {
    // The vision gateway rejects more than one image per request, so each image
    // in a single Content block must be sent in its own call.
    mockedFetch.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'desc' } }] }),
    );

    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'two images' },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
        ],
      },
    ];
    const out = await describeImagesInContents(contents, config);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    for (const call of mockedFetch.mock.calls) {
      const body = JSON.parse((call[1] as { body: string }).body);
      const imageParts = body.messages[0].content.filter(
        (c: { type: string }) => c.type === 'image_url',
      );
      expect(imageParts).toHaveLength(1);
    }

    // Both descriptions are folded into the single text part, labeled per image.
    const text = (out[0].parts ?? []).map((p) => p.text ?? '').join('');
    expect(text).toContain('Image 1/2:');
    expect(text).toContain('Image 2/2:');
  });

  it('leaves image-free contents untouched and makes no call', async () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'plain text' }] },
    ];
    const out = await describeImagesInContents(contents, config);
    expect(out).toEqual(contents);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('caches the description and does not re-call for the same image', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'cached desc' } }],
      }),
    );

    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'analyze' }, IMAGE_PART] },
    ];

    const first = await describeImagesInContents(contents, config);
    const second = await describeImagesInContents(contents, config);

    // Only one network call despite two passes over the same image+context.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstText = (first[0].parts ?? []).map((p) => p.text ?? '').join('');
    const secondText = (second[0].parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(firstText).toContain('cached desc');
    expect(secondText).toContain('cached desc');
  });

  it('re-calls when the image bytes change', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'desc' } }] }),
    );

    await describeImagesInContents(
      [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        },
      ],
      config,
    );
    await describeImagesInContents(
      [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }],
        },
      ],
      config,
    );

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures (retries next turn)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse('boom', false, 500));
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: 'recovered' } }] }),
    );

    const contents: Content[] = [{ role: 'user', parts: [IMAGE_PART] }];
    const first = await describeImagesInContents(contents, config);
    const second = await describeImagesInContents(contents, config);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect((first[0].parts ?? []).map((p) => p.text ?? '').join('')).toContain(
      'Image analysis unavailable',
    );
    expect((second[0].parts ?? []).map((p) => p.text ?? '').join('')).toContain(
      'recovered',
    );
  });

  it('inserts a placeholder note when the vision model fails', async () => {
    const feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
    mockedFetch.mockResolvedValue(jsonResponse('boom', false, 500));

    const contents: Content[] = [{ role: 'user', parts: [IMAGE_PART] }];
    const out = await describeImagesInContents(contents, config);
    const text = (out[0].parts ?? []).map((p) => p.text ?? '').join('');
    expect(text).toContain('Image analysis unavailable');
    expect((out[0].parts ?? []).some((p) => p.inlineData)).toBe(false);
    expect(feedbackSpy).not.toHaveBeenCalledWith('error', expect.any(String));
  });
});
