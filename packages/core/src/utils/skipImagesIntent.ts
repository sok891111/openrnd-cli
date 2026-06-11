/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detects explicit user intent to avoid image reading / vision analysis.
 *
 * This is intentionally conservative: it only matches direct "skip images" or
 * "text only" phrasing, and a small set of negated forms wins over positives.
 */
export function userRequestSkipsImages(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const negativePatterns = [
    /이미지(?:를|는)?\s*빼지\s*말/,
    /이미지(?:를|는)?\s*제외하지\s*말/,
    /이미지(?:도|까지)?\s*포함/,
    /\binclude\s+images?\b/,
  ];
  if (negativePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const positivePatterns = [
    /이미지(?:를|는)?\s*빼고/,
    /이미지(?:를|는)?\s*제외/,
    /이미지\s*없이/,
    /이미지(?:는|를)?\s*분석하지\s*(?:마|말|말고|않)/,
    /이미지(?:는|를)?\s*보지\s*(?:마|말|말고|않)/,
    /그림(?:을|은)?\s*빼고/,
    /그림(?:을|은)?\s*제외/,
    /사진(?:을|은)?\s*빼고/,
    /사진(?:을|은)?\s*제외/,
    /텍스트만/,
    /\btext\s*only\b/,
    /\bwithout\s+images?\b/,
    /\bexclude\s+images?\b/,
    /\bskip\s+images?\b/,
    /\bdo\s+not\s+analy[sz]e\s+images?\b/,
    /\bdon'?t\s+analy[sz]e\s+images?\b/,
    /\bno\s+image\s+analysis\b/,
  ];

  return positivePatterns.some((pattern) => pattern.test(normalized));
}
