/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Debug logging toggle (single source of truth)
// ---------------------------------------------------------------------------
// Disabled by default. Enable via either:
//   - settings.json:  { "general": { "debugLogging": true } }
//   - env override:   OPENWORK_DEBUG=true  (or =false to force-disable)
// The env var, when set, always wins over the settings.json value.
//
// Consumers that want to surface *informational* diagnostics in the terminal
// only while logging is on (LLM connect chatter, corporate-fetch 🐍 Python
// stderr lines, …) should gate on this so a single switch turns them all off.
// Errors/warnings should still emit unconditionally so real failures are never
// hidden.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import { Storage } from '../config/storage.js';

// Resolved once per process (debug logging rarely toggles mid-session, and a
// per-call file read would be wasteful). Changing the setting takes effect on
// the next openwork start.
let cachedDebugEnabled: boolean | undefined;

/** Whether debug logging is enabled (settings.general.debugLogging / OPENWORK_DEBUG). */
export function isDebugLoggingEnabled(): boolean {
  if (cachedDebugEnabled !== undefined) return cachedDebugEnabled;

  // 1) Explicit env override always wins.
  const env = process.env['OPENWORK_DEBUG'];
  if (env !== undefined) {
    cachedDebugEnabled = env === 'true' || env === '1';
    return cachedDebugEnabled;
  }

  // 2) Otherwise read settings.json (general.debugLogging); default OFF.
  try {
    const raw = fs.readFileSync(Storage.getGlobalSettingsPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cachedDebugEnabled =
      typeof parsed === 'object' &&
      parsed !== null &&
      'general' in parsed &&
      typeof parsed.general === 'object' &&
      parsed.general !== null &&
      'debugLogging' in parsed.general &&
      parsed.general.debugLogging === true;
  } catch {
    cachedDebugEnabled = false;
  }
  return cachedDebugEnabled;
}

/** Test-only: reset the cached value so a changed setting/env is re-read. */
export function resetDebugLoggingCache(): void {
  cachedDebugEnabled = undefined;
}
