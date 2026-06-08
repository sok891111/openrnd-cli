/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { waitFor } from '../../test-utils/async.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { UsageDisplay } from './UsageDisplay.js';
import { usageStatsStore, type PersistedModelUsage } from '@openrnd/core';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

vi.mock('@openrnd/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openrnd/core')>();
  return {
    ...actual,
    usageStatsStore: {
      getAggregated: vi.fn(),
      getEarliestDay: vi.fn(),
    },
  };
});

const RIGHT_ARROW = '\u001B[C';
const ESCAPE = '\u001B';

const mockUsage = (total: number) => ({
  requests: 3,
  input: 1_200_000,
  output: 340_000,
  cached: 5000,
  thoughts: 0,
  tool: 0,
  total,
});

describe('UsageDisplay', () => {
  // The dialog sizes its columns to the terminal width (via useTerminalSize).
  // Pin a wide-enough width so model names aren't truncated in assertions.
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    process.stdout.columns = 120;
    vi.mocked(usageStatsStore.getEarliestDay).mockReturnValue('2026-06-01');
    vi.mocked(usageStatsStore.getAggregated).mockImplementation(
      (periodDays?: number): Record<string, PersistedModelUsage> => {
        if (periodDays === 7) {
          return { 'gemini-2.5-flash': mockUsage(305_000) };
        }
        return {
          'gemini-2.5-pro': mockUsage(1_600_000),
          'gemini-2.5-flash': mockUsage(305_000),
        };
      },
    );
  });

  afterEach(() => {
    process.stdout.columns = originalColumns;
  });

  it('renders the all-time tab with model rows by default', async () => {
    const { lastFrame } = await renderWithProviders(
      <UsageDisplay onExit={vi.fn()} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Token Usage by Model');
    expect(frame).toContain('[ All time ]');
    expect(frame).toContain('gemini-2.5-pro');
    expect(frame).toContain('1.6M');
    expect(frame).toContain('Tracking since 2026-06-01');
  });

  // Regression: if any rendered line is wider than the terminal, the terminal
  // wraps it without Ink's knowledge, so switching tabs leaves stale rows and
  // the output drifts downward (seen on Windows terminals). Every line must fit
  // within the terminal width at any size.
  it.each([60, 80, 100])(
    'never renders a line wider than the terminal (%i cols)',
    async (cols) => {
      process.stdout.columns = cols;
      const { lastFrame } = await renderWithProviders(
        <UsageDisplay onExit={vi.fn()} />,
      );
      const lines = (lastFrame() ?? '').split('\n');
      for (const line of lines) {
        expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
      }
    },
  );

  it('switches period when pressing the right arrow', async () => {
    const { stdin, lastFrame } = await renderWithProviders(
      <UsageDisplay onExit={vi.fn()} />,
    );

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('[ Last 7 days ]');
    });
    // Only flash usage is present in the 7-day window mock.
    expect(lastFrame()).not.toContain('gemini-2.5-pro');
  });

  it('calls onExit when Escape is pressed', async () => {
    const onExit = vi.fn();
    const { stdin, waitUntilReady } = await renderWithProviders(
      <UsageDisplay onExit={onExit} />,
    );

    await act(async () => {
      stdin.write(ESCAPE);
    });
    // Escape has a 50ms debounce in KeypressContext.
    await act(async () => {
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(onExit).toHaveBeenCalled();
    });
  });
});
