/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  UsageStatsStore,
  getDayKey,
  type UsageStatsFile,
} from './usagePersistence.js';

const usage = (overrides: Partial<Record<string, number>> = {}) => ({
  input: 100,
  output: 50,
  cached: 10,
  thoughts: 5,
  tool: 2,
  total: 167,
  ...overrides,
});

describe('UsageStatsStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: UsageStatsStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-'));
    filePath = path.join(tmpDir, 'usage_stats.json');
    store = new UsageStatsStore();
    store.setFilePathForTesting(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('records usage and aggregates over all time', () => {
    store.record('model-a', usage());
    store.record('model-a', usage({ total: 200 }));
    store.record('model-b', usage({ total: 300 }));

    const all = store.getAggregated();
    expect(all['model-a'].requests).toBe(2);
    expect(all['model-a'].total).toBe(367);
    expect(all['model-b'].requests).toBe(1);
    expect(all['model-b'].total).toBe(300);
  });

  it('persists to disk and reloads in a new store instance', () => {
    store.record('model-a', usage());
    store.flush();

    const reloaded = new UsageStatsStore();
    reloaded.setFilePathForTesting(filePath);
    const all = reloaded.getAggregated();
    expect(all['model-a'].requests).toBe(1);
    expect(all['model-a'].input).toBe(100);
  });

  it('filters by trailing window when aggregating', () => {
    const today = new Date();
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(today.getDate() - 10);

    store.record('model-a', usage({ total: 111 }), today);
    store.record('model-a', usage({ total: 999 }), tenDaysAgo);

    const last7 = store.getAggregated(7);
    expect(last7['model-a'].total).toBe(111);

    const last30 = store.getAggregated(30);
    expect(last30['model-a'].total).toBe(1110);

    const all = store.getAggregated();
    expect(all['model-a'].total).toBe(1110);
  });

  it('ignores empty model names', () => {
    store.record('', usage());
    expect(Object.keys(store.getAggregated())).toHaveLength(0);
  });

  it('returns the earliest recorded day', () => {
    const today = new Date();
    const earlier = new Date();
    earlier.setDate(today.getDate() - 5);

    store.record('model-a', usage(), today);
    store.record('model-a', usage(), earlier);

    expect(store.getEarliestDay()).toBe(getDayKey(earlier));
  });

  it('survives a corrupt usage file', () => {
    fs.writeFileSync(filePath, 'not json', 'utf8');
    const corruptStore = new UsageStatsStore();
    corruptStore.setFilePathForTesting(filePath);
    expect(corruptStore.getAggregated()).toEqual({});
    corruptStore.record('model-a', usage());
    expect(corruptStore.getAggregated()['model-a'].requests).toBe(1);
  });

  it('clears all data', () => {
    store.record('model-a', usage());
    store.clear();
    expect(store.getAggregated()).toEqual({});

    const onDisk = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as UsageStatsFile;
    expect(onDisk.days).toEqual({});
  });
});
