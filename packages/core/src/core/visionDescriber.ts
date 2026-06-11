/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vision pre-processing for text-only primary models.
 *
 * Some in-house deployments split the LLM into a high-performance *text-only*
 * model and a lower-cost *vision* model. The primary (text) model cannot read
 * images at all, so any `inlineData` image parts in a request would be silently
 * dropped (the OpenAI-compatible converter only serializes text + tool calls).
 *
 * This module detects image parts, sends them to a separately-configured vision
 * model (an OpenAI-compatible /chat/completions endpoint that accepts
 * `image_url` content), and rewrites the image parts into a plain-text
 * description. The transformed, image-free contents are then forwarded to the
 * primary text model as usual.
 *
 * Connection info comes from settings.json (`llm.vision.*`), which the CLI
 * propagates into the env vars read here. When no vision model is configured,
 * `getVisionConfigFromEnv()` returns undefined and the caller leaves the
 * request untouched (preserving the previous drop-the-image behavior).
 */

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */

import { createHash } from 'node:crypto';
import type { Content, Part } from '@google/genai';
import { fetch } from 'undici';
import { coreEvents } from '../utils/events.js';
import { debugLogger } from '../utils/debugLogger.js';

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Per-request timeout for a single vision call. Without this, a hung or
 * unresponsive vision endpoint makes the caller wait forever — and the Office
 * reader describes images sequentially, so one stuck image freezes the whole
 * read with no further output. On timeout the request aborts and the caller's
 * per-image catch leaves a placeholder note so the read still completes.
 */
const VISION_REQUEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Description cache
// ---------------------------------------------------------------------------
// Conversation history is replayed verbatim every turn, so the same image (and
// its surrounding text) would otherwise be re-sent to the vision model on each
// turn. Cache successful descriptions keyed by a hash of (model + context text +
// image bytes) so a repeated image is described exactly once. In-memory only —
// the goal is to dedupe within a running session, not across restarts.

const MAX_CACHE_ENTRIES = 100;
const descriptionCache = new Map<string, string>();

function buildCacheKey(
  config: VisionConfig,
  imageParts: Part[],
  contextText: string,
): string {
  const hash = createHash('sha256');
  hash.update(config.model);
  hash.update('\0');
  hash.update(contextText);
  for (const part of imageParts) {
    hash.update('\0');
    hash.update(part.inlineData?.mimeType ?? '');
    hash.update('\0');
    hash.update(part.inlineData?.data ?? '');
  }
  return hash.digest('hex');
}

function cacheGet(key: string): string | undefined {
  const value = descriptionCache.get(key);
  if (value !== undefined) {
    // Refresh recency for simple LRU eviction.
    descriptionCache.delete(key);
    descriptionCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string): void {
  descriptionCache.set(key, value);
  if (descriptionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = descriptionCache.keys().next().value;
    if (oldest !== undefined) descriptionCache.delete(oldest);
  }
}

/** Clears the in-memory description cache. Primarily for tests. */
export function clearVisionDescriptionCache(): void {
  descriptionCache.clear();
}

/**
 * Default instruction handed to the vision model. The description is consumed by
 * a downstream *text-only* model, so we ask for an exhaustive, self-contained
 * transcription rather than a short caption.
 */
const DEFAULT_VISION_PROMPT =
  'You are an image analysis assistant feeding a downstream text-only model ' +
  'that cannot see this image. Describe the image as completely and ' +
  'objectively as possible so the text model can reason about it: transcribe ' +
  'all visible text verbatim (OCR), describe charts/tables/diagrams with their ' +
  'data and labels, layout, UI elements, colors, and any other relevant ' +
  'detail. Do not add interpretation beyond what is visible.';

/**
 * Read vision-model connection info from the environment. The CLI copies
 * `settings.json` (`llm.vision.*`) into these vars before the core boots, and
 * env vars may also be set directly. Returns undefined when not configured.
 */
export function getVisionConfigFromEnv(): VisionConfig | undefined {
  const baseUrl = process.env['OPENRND_VISION_BASE_URL']?.trim();
  const model = process.env['OPENRND_VISION_MODEL']?.trim();
  // Both endpoint and model are required; without either there is no vision
  // model to call.
  if (!baseUrl || !model) return undefined;
  const apiKey =
    process.env['OPENRND_VISION_API_KEY']?.trim() ||
    // Fall back to the primary key so a single-credential gateway just works.
    process.env['OPENRND_API_KEY']?.trim() ||
    'vision';
  return { baseUrl, apiKey, model };
}

function isImagePart(part: Part): boolean {
  const mime = part.inlineData?.mimeType ?? '';
  return Boolean(part.inlineData?.data) && mime.startsWith('image/');
}

/**
 * True when any content carries an image `inlineData` part. Cheap pre-check so
 * we skip the whole vision path (and its env lookup) for ordinary text turns.
 */
export function contentsHaveImages(contents: Content[]): boolean {
  return contents.some((c) => (c.parts ?? []).some(isImagePart));
}

interface OpenAIVisionContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface VisionChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Call the vision model once with a single image plus the surrounding text (as
 * context) and return its textual description.
 *
 * IMPORTANT: one image per request. Some vision gateways reject requests that
 * carry more than one image ("At most 1 image(s) may be provided in one
 * request"), so callers with multiple images must loop via `describeImages`
 * rather than batching them into a single call.
 */
async function describeOneImage(
  config: VisionConfig,
  imagePart: Part,
  contextText: string,
): Promise<string> {
  const userContent: OpenAIVisionContent[] = [
    {
      type: 'text',
      text: contextText
        ? `${DEFAULT_VISION_PROMPT}\n\nSurrounding request text for context:\n${contextText}`
        : DEFAULT_VISION_PROMPT,
    },
  ];

  const mime = imagePart.inlineData?.mimeType ?? 'image/png';
  const imageData = imagePart.inlineData?.data ?? '';
  userContent.push({
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${imageData}` },
  });

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: userContent }],
        stream: false,
      }),
      signal: AbortSignal.timeout(VISION_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Vision model at ${url} did not respond within ${
          VISION_REQUEST_TIMEOUT_MS / 1000
        }s.`,
      );
    }
    throw new Error(`Vision model request to ${url} failed: ${String(err)}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Vision model error ${response.status} from ${url}: ${errorText}`,
    );
  }

  const data = (await response.json()) as VisionChatResponse;
  const content = data.choices?.[0]?.message?.content;
  const description = typeof content === 'string' ? content.trim() : '';
  if (!description) {
    throw new Error('Vision model returned an empty description.');
  }
  return description;
}

/**
 * Describe one or more images, sending exactly one image per request (see
 * `describeOneImage`) and concatenating the results. A single image returns its
 * description verbatim; multiple images are labeled "Image N/total:" so the
 * downstream text model can tell them apart.
 */
async function describeImages(
  config: VisionConfig,
  imageParts: Part[],
  contextText: string,
): Promise<string> {
  if (imageParts.length === 1) {
    return describeOneImage(config, imageParts[0], contextText);
  }

  const descriptions: string[] = [];
  for (let i = 0; i < imageParts.length; i++) {
    const description = await describeOneImage(
      config,
      imageParts[i],
      contextText,
    );
    descriptions.push(`Image ${i + 1}/${imageParts.length}:\n${description}`);
  }
  return descriptions.join('\n\n');
}

/**
 * Describe raw image data (e.g. pictures exported from an Office document) with
 * the vision model and return the plain-text description. Throws on failure so
 * the caller can decide how to degrade. Used by the win32com Office reader to
 * turn embedded pictures into text for the downstream text-only model.
 */
export async function describeImageData(
  config: VisionConfig,
  images: Array<{ data: string; mimeType: string }>,
  contextText: string,
): Promise<string> {
  const parts: Part[] = images.map((img) => ({
    inlineData: { data: img.data, mimeType: img.mimeType },
  }));
  return describeImages(config, parts, contextText);
}

function formatDescriptionPart(
  config: VisionConfig,
  imageCount: number,
  description: string,
): Part {
  return {
    text: `\n\n[Image analysis by vision model "${config.model}" (${imageCount} image(s))]\n${description}`,
  };
}

/**
 * Replace every image part in `contents` with a text description produced by
 * the vision model. Non-image parts (text, tool calls/results) are preserved in
 * order. Successful descriptions are cached so a repeated image (replayed in
 * history each turn) is analyzed only once. On a per-block failure the images
 * are dropped with a placeholder note so the turn still proceeds instead of
 * hard-failing.
 */
export async function describeImagesInContents(
  contents: Content[],
  config: VisionConfig,
): Promise<Content[]> {
  const result: Content[] = [];

  for (const content of contents) {
    const parts = content.parts ?? [];
    const imageParts = parts.filter(isImagePart);

    if (imageParts.length === 0) {
      result.push(content);
      continue;
    }

    const contextText = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join('');

    const nonImageParts = parts.filter((p) => !isImagePart(p));
    const cacheKey = buildCacheKey(config, imageParts, contextText);

    let descriptionPart: Part;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      descriptionPart = formatDescriptionPart(
        config,
        imageParts.length,
        cached,
      );
    } else {
      try {
        debugLogger.debug(
          `[Vision] Analyzing ${imageParts.length} image(s) with ${config.model}...`,
        );
        const description = await describeImages(
          config,
          imageParts,
          contextText,
        );
        cacheSet(cacheKey, description);
        descriptionPart = formatDescriptionPart(
          config,
          imageParts.length,
          description,
        );
      } catch (err) {
        coreEvents.emitFeedback(
          'error',
          `[Vision] Image analysis failed: ${String(err)}`,
        );
        // Don't cache failures — a transient error should be retried next turn.
        descriptionPart = {
          text: `\n\n[Image analysis unavailable: the vision model could not process ${imageParts.length} attached image(s). Error: ${String(err)}]`,
        };
      }
    }

    result.push({
      ...content,
      parts: [...nonImageParts, descriptionPart],
    });
  }

  return result;
}
