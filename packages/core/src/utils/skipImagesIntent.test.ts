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
    '이미지 분석 건너뛰고 읽어줘',
    '이미지는 스킵하고 텍스트만',
    '그림 무시하고 요약해줘',
    '사진 생략하고 읽어줘',
    'vision 끄고 읽어줘',
    '이미지 보지 말고 텍스트만 정리해줘',
    'read this deck text only',
    'summarize without images',
    "don't analyze images",
    'skip the images',
    'skip vision',
    'ignore images in this file',
  ])('detects explicit skip-image intent: %s', (input) => {
    expect(userRequestSkipsImages(input)).toBe(true);
  });

  it.each([
    '이미지도 포함해서 분석해줘',
    '이미지 빼지 말고 전체 요약해줘',
    '이미지 무시하지 말고 분석해줘',
    'analyze images in this deck',
    'analyze this deck with images',
    'summarize this file',
  ])('does not skip images for non-skip or opposite intent: %s', (input) => {
    expect(userRequestSkipsImages(input)).toBe(false);
  });
});
