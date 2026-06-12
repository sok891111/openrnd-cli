/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Korean object words for image, plus an optional josa (을/를/은/는/도) and an
// optional "분석/처리/..." word so "이미지 분석 건너뛰고" matches too.
const IMAGE_NOUN =
  '(?:이미지|그림|사진|vision|비전)(?:을|를|은|는|도)?(?:\\s*(?:분석|처리|해석|판독|인식|로딩|읽기)(?:은|는|을|를|도)?)?';

// Verbs whose plain stem already means "leave it out": 빼다/제외/건너뛰다/스킵/
// 무시/생략/끄다/패스/넘기다. For these, a trailing "지 마/말/않" flips the meaning
// to "don't skip" (= include), so it is handled as a negation below.
const SKIP_STEM =
  '(?:빼|제외|건너\\s*뛰|스킵|스킾|무시|생략|끄|꺼|패스|넘기|넘어가)';

// Verbs that mean "process the image"; here the negation form ("분석하지 마")
// is itself the skip request.
const PROCESS_NEG =
  '(?:분석|해석|읽|보|처리|판독|인식)(?:하)?지\\s*(?:마|말|않)';

// "지 마/말/않/말고" negation suffix.
const NEG_SUFFIX = '지\\s*(?:마|말|않)';

/**
 * Detects explicit user intent to avoid image reading / vision analysis.
 *
 * Conservative by design: it matches direct "skip images" / "text only"
 * phrasing across common Korean and English wordings, and negated forms
 * ("이미지 빼지 마", "include images") win over positives.
 */
export function userRequestSkipsImages(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const negativePatterns = [
    // "이미지 빼지 마 / 끄지 말고 / 무시하지 마" — don't skip the images.
    new RegExp(`${IMAGE_NOUN}\\s*${SKIP_STEM}(?:하)?${NEG_SUFFIX}`),
    new RegExp(`${IMAGE_NOUN}\\s*포함`),
    /\binclude\s+images?\b/,
    /\bwith\s+images?\b/,
  ];
  if (negativePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const positivePatterns = [
    new RegExp(`${IMAGE_NOUN}\\s*${SKIP_STEM}`),
    new RegExp(`${IMAGE_NOUN}\\s*${PROCESS_NEG}`),
    /(?:이미지|그림|사진)\s*없이/,
    /텍스트만/,
    /글자만/,
    /\btext\s*only\b/,
    /\bwithout\s+images?\b/,
    /\bexclude\s+images?\b/,
    /\bskip(?:ping)?\s+(?:the\s+)?images?\b/,
    /\bskip\s+vision\b/,
    /\bno\s+vision\b/,
    /\bdo\s+not\s+(?:analy[sz]e|read|process)\s+images?\b/,
    /\bdon'?t\s+(?:analy[sz]e|read|process)\s+images?\b/,
    /\bno\s+image\s+(?:analysis|reading)\b/,
    /\bignore\s+(?:the\s+)?images?\b/,
  ];

  return positivePatterns.some((pattern) => pattern.test(normalized));
}
