/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Token usage accumulated for a single model.
 */
export interface PersistedModelUsage {
  requests: number;
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

/**
 * On-disk schema for cross-session token usage tracking.
 *
 * Usage is bucketed by local calendar day so that it can later be aggregated
 * over arbitrary windows (e.g. last 7 / 30 days, all-time).
 */
export interface UsageStatsFile {
  version: 1;
  // YYYY-MM-DD -> model name -> usage
  days: Record<string, Record<string, PersistedModelUsage>>;
}

const FILE_VERSION = 1;
const USAGE_STATS_FILENAME = 'usage_stats.json';
const FLUSH_DEBOUNCE_MS = 2000;

function createEmptyModelUsage(): PersistedModelUsage {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
    total: 0,
  };
}

/**
 * Returns the local-time calendar day key (YYYY-MM-DD) for the given date.
 */
export function getDayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Singleton store that records token usage per model per day and persists it to
 * a JSON file under the global config directory so totals survive across
 * sessions. Used by the `/usage` command.
 */
export class UsageStatsStore {
  #data: UsageStatsFile | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  #exitHandlerRegistered = false;
  #filePath: string | undefined;

  /** Allows overriding the storage location (primarily for tests). */
  setFilePathForTesting(filePath: string | undefined): void {
    this.#filePath = filePath;
    this.#data = null;
  }

  private getFilePath(): string {
    if (this.#filePath) {
      return this.#filePath;
    }
    this.#filePath = path.join(
      Storage.getGlobalGeminiDir(),
      USAGE_STATS_FILENAME,
    );
    return this.#filePath;
  }

  private ensureLoaded(): UsageStatsFile {
    if (this.#data) {
      return this.#data;
    }
    this.#data = this.load();
    return this.#data;
  }

  private load(): UsageStatsFile {
    try {
      const content = fs.readFileSync(this.getFilePath(), 'utf8');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = JSON.parse(content) as Partial<UsageStatsFile>;
      if (parsed && typeof parsed === 'object' && parsed.days) {
        return { version: FILE_VERSION, days: parsed.days };
      }
    } catch (e) {
      if (
        !(
          e instanceof Error &&
          'code' in e &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          (e as NodeJS.ErrnoException).code === 'ENOENT'
        )
      ) {
        debugLogger.warn('Failed to read usage stats file: ' + e);
      }
    }
    return { version: FILE_VERSION, days: {} };
  }

  /**
   * Records token usage for a single API response. Updates are accumulated in
   * memory and flushed to disk on a short debounce (and on process exit).
   */
  record(
    model: string,
    usage: {
      input: number;
      output: number;
      cached: number;
      thoughts: number;
      tool: number;
      total: number;
    },
    date: Date = new Date(),
  ): void {
    if (!model) {
      return;
    }
    const data = this.ensureLoaded();
    const dayKey = getDayKey(date);
    const day = (data.days[dayKey] ??= {});
    const entry = (day[model] ??= createEmptyModelUsage());

    entry.requests += 1;
    entry.input += usage.input;
    entry.output += usage.output;
    entry.cached += usage.cached;
    entry.thoughts += usage.thoughts;
    entry.tool += usage.tool;
    entry.total += usage.total;

    this.scheduleFlush();
  }

  /**
   * Aggregates per-model usage over a trailing window.
   *
   * @param periodDays Number of days to include (inclusive of today). When
   *   undefined, aggregates over all recorded history.
   */
  getAggregated(periodDays?: number): Record<string, PersistedModelUsage> {
    const data = this.ensureLoaded();
    const result: Record<string, PersistedModelUsage> = {};

    let cutoffKey: string | undefined;
    if (periodDays !== undefined && periodDays > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (periodDays - 1));
      cutoffKey = getDayKey(cutoff);
    }

    for (const [dayKey, models] of Object.entries(data.days)) {
      if (cutoffKey && dayKey < cutoffKey) {
        continue;
      }
      for (const [model, usage] of Object.entries(models)) {
        const target = (result[model] ??= createEmptyModelUsage());
        target.requests += usage.requests;
        target.input += usage.input;
        target.output += usage.output;
        target.cached += usage.cached;
        target.thoughts += usage.thoughts;
        target.tool += usage.tool;
        target.total += usage.total;
      }
    }

    return result;
  }

  /** Returns the earliest recorded day key, or undefined if no data. */
  getEarliestDay(): string | undefined {
    const data = this.ensureLoaded();
    const keys = Object.keys(data.days);
    if (keys.length === 0) {
      return undefined;
    }
    return keys.sort()[0];
  }

  private scheduleFlush(): void {
    this.registerExitHandler();
    if (this.#flushTimer) {
      return;
    }
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Don't keep the event loop alive solely for a pending flush.
    this.#flushTimer.unref?.();
  }

  private registerExitHandler(): void {
    if (this.#exitHandlerRegistered) {
      return;
    }
    this.#exitHandlerRegistered = true;
    process.once('exit', () => {
      if (this.#flushTimer) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }
      this.flush();
    });
  }

  /** Writes the in-memory data to disk atomically. Never throws. */
  flush(): void {
    if (!this.#data) {
      return;
    }
    const filePath = this.getFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.#data), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      debugLogger.warn('Failed to write usage stats file: ' + e);
    }
  }

  /** Clears all in-memory and on-disk usage data. */
  clear(): void {
    this.#data = { version: FILE_VERSION, days: {} };
    this.flush();
  }
}

export const usageStatsStore = new UsageStatsStore();

/**
 * Records token usage for a single API response into the persistent store.
 * Safe to call frequently; failures are swallowed so telemetry never disrupts
 * the main flow.
 */
export function recordPersistentUsage(
  model: string,
  usage: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
    total: number;
  },
): void {
  try {
    usageStatsStore.record(model, usage);
  } catch (e) {
    debugLogger.warn('Failed to record usage stats: ' + e);
  }
}
