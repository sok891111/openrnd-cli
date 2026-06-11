/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents, type FeedbackSeverity } from './events.js';

export interface DelayedFeedbackHandle {
  cancel: () => void;
}

/**
 * Emits user-facing feedback only if the work is still running after `delayMs`.
 * Use this for operations that are usually fast but can occasionally look
 * frozen, such as vision analysis over embedded images.
 */
export function emitFeedbackAfterDelay(
  severity: FeedbackSeverity,
  message: string,
  delayMs: number,
): DelayedFeedbackHandle {
  const timer = setTimeout(() => {
    coreEvents.emitFeedback(severity, message);
  }, delayMs);
  timer.unref?.();

  return {
    cancel: () => clearTimeout(timer),
  };
}
