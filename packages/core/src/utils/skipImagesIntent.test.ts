/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { userRequestSkipsImages } from './skipImagesIntent.js';

describe('userRequestSkipsImages', () => {
  it.each([
    '이 PPT 이미지 빼고 텍스트만 요약해줘',
    '이미지는 분석하지마',
    '이미지 제외하고 파일 읽어줘',
    'read this deck text only',
    'summarize without images',
    "don't analyze images",
  ])('detects explicit skip-image intent: %s', (input) => {
    expect(userRequestSkipsImages(input)).toBe(true);
  });

  it.each([
    '이미지도 포함해서 분석해줘',
    '이미지 빼지 말고 전체 요약해줘',
    'analyze images in this deck',
    'summarize this file',
  ])('does not skip images for non-skip or opposite intent: %s', (input) => {
    expect(userRequestSkipsImages(input)).toBe(false);
  });
});
