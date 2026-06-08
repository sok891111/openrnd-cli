/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { usageStatsStore, type PersistedModelUsage } from '@openrnd/core';

interface UsageTab {
  label: string;
  periodDays?: number;
}

const TABS: UsageTab[] = [
  { label: 'All time', periodDays: undefined },
  { label: 'Last 7 days', periodDays: 7 },
  { label: 'Last 30 days', periodDays: 30 },
];

/** Formats a token count compactly, e.g. 1234567 -> "1.2M". */
function formatCompact(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

interface UsageDisplayProps {
  onExit: () => void;
}

// Number of right-aligned numeric columns (Reqs / Input / Output / Cached / Total).
const NUM_COLS = 5;
// Overhead added by the outer frame: round border (2) + paddingX*2 (4).
const FRAME_OVERHEAD = 6;
// Widest frame we ever want, regardless of how wide the terminal is.
const MAX_FRAME_WIDTH = 91; // 30 (name) + 5*11 (numbers) + FRAME_OVERHEAD.

export const UsageDisplay: React.FC<UsageDisplayProps> = ({ onExit }) => {
  const [activeTab, setActiveTab] = useState(0);
  const { columns: terminalWidth } = useTerminalSize();

  // Captured once on mount; usage data does not change while the dialog is open.
  const earliestDay = useMemo(() => usageStatsStore.getEarliestDay(), []);
  const aggregates = useMemo(
    () => TABS.map((tab) => usageStatsStore.getAggregated(tab.periodDays)),
    [],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape' || key.name === 'q') {
        onExit();
        return;
      }
      if (key.name === 'left') {
        setActiveTab((t) => (t - 1 + TABS.length) % TABS.length);
        return;
      }
      if (key.name === 'right' || key.name === 'tab') {
        setActiveTab((t) => (t + 1) % TABS.length);
        return;
      }
    },
    { isActive: true },
  );

  const models = aggregates[activeTab];
  const rows = Object.entries(models).sort(([, a], [, b]) => b.total - a.total);

  // Keep the dialog the same height on every tab so switching periods doesn't
  // change the rendered frame height. A varying height makes Ink leave a stale
  // line behind on each switch (the terminal "drifts" down one row at a time).
  // Reserve space for the widest tab: header border (2 lines) + one line per
  // model + totals border (2 lines).
  const maxModelCount = Math.max(
    1,
    ...aggregates.map((agg) => Object.keys(agg).length),
  );
  const tableHeight = 2 + maxModelCount + 2;

  const totals = rows.reduce<PersistedModelUsage>(
    (acc, [, u]) => {
      acc.requests += u.requests;
      acc.input += u.input;
      acc.output += u.output;
      acc.cached += u.cached;
      acc.total += u.total;
      return acc;
    },
    {
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      thoughts: 0,
      tool: 0,
      total: 0,
    },
  );

  // Make the dialog fit within the terminal so Ink/Yoga performs all wrapping
  // itself. If the rendered frame is wider than the terminal, the *terminal*
  // wraps lines that Ink can't see, so on each tab switch Ink under-clears the
  // previous frame and the output drifts down a row at a time (notably on
  // Windows terminals). Constraining the width keeps every line within bounds.
  const frameWidth = Math.max(44, Math.min(terminalWidth, MAX_FRAME_WIDTH));
  const innerWidth = frameWidth - FRAME_OVERHEAD;
  // Numbers prefer 11 columns each but shrink (down to 7) on narrow terminals;
  // the model name takes whatever remains, capped at 30 and floored at 6.
  const numWidth = Math.max(
    7,
    Math.min(11, Math.floor((innerWidth - 6) / NUM_COLS)),
  );
  const nameWidth = Math.max(6, Math.min(30, innerWidth - numWidth * NUM_COLS));

  const NumCell: React.FC<{ children: React.ReactNode; bold?: boolean }> = ({
    children,
    bold,
  }) => (
    <Box width={numWidth} justifyContent="flex-end">
      <Text color={theme.text.primary} bold={bold}>
        {children}
      </Text>
    </Box>
  );

  return (
    <Box
      width={frameWidth}
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingTop={1}
      paddingX={2}
    >
      <Text bold color={theme.text.accent}>
        Token Usage by Model
      </Text>

      {/* Tabs */}
      <Box marginTop={1}>
        {TABS.map((tab, idx) => (
          <Box key={tab.label} marginRight={2}>
            <Text
              bold={idx === activeTab}
              color={
                idx === activeTab ? theme.text.accent : theme.text.secondary
              }
            >
              {idx === activeTab ? `[ ${tab.label} ]` : `  ${tab.label}  `}
            </Text>
          </Box>
        ))}
      </Box>

      <Box height={1} />

      {rows.length === 0 ? (
        <Box height={tableHeight}>
          <Text color={theme.text.secondary}>
            No usage recorded for this period yet.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" height={tableHeight}>
          {/* Header */}
          <Box
            borderBottom={true}
            borderStyle="single"
            borderColor={theme.border.default}
            borderTop={false}
            borderLeft={false}
            borderRight={false}
          >
            <Box width={nameWidth}>
              <Text bold color={theme.text.secondary}>
                Model
              </Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end">
              <Text bold color={theme.text.secondary}>
                Reqs
              </Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end">
              <Text bold color={theme.text.secondary}>
                Input
              </Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end">
              <Text bold color={theme.text.secondary}>
                Output
              </Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end">
              <Text bold color={theme.text.secondary}>
                Cached
              </Text>
            </Box>
            <Box width={numWidth} justifyContent="flex-end">
              <Text bold color={theme.text.secondary}>
                Total
              </Text>
            </Box>
          </Box>

          {/* Rows */}
          {rows.map(([model, u]) => (
            <Box key={model}>
              <Box width={nameWidth}>
                <Text color={theme.text.primary} wrap="truncate-end">
                  {model}
                </Text>
              </Box>
              <NumCell>{u.requests.toLocaleString()}</NumCell>
              <NumCell>{formatCompact(u.input)}</NumCell>
              <NumCell>{formatCompact(u.output)}</NumCell>
              <NumCell>{formatCompact(u.cached)}</NumCell>
              <NumCell>{formatCompact(u.total)}</NumCell>
            </Box>
          ))}

          {/* Totals */}
          {rows.length > 1 && (
            <Box
              borderTop={true}
              borderStyle="single"
              borderColor={theme.border.default}
              borderBottom={false}
              borderLeft={false}
              borderRight={false}
            >
              <Box width={nameWidth}>
                <Text bold color={theme.text.primary}>
                  Total
                </Text>
              </Box>
              <NumCell bold>{totals.requests.toLocaleString()}</NumCell>
              <NumCell bold>{formatCompact(totals.input)}</NumCell>
              <NumCell bold>{formatCompact(totals.output)}</NumCell>
              <NumCell bold>{formatCompact(totals.cached)}</NumCell>
              <NumCell bold>{formatCompact(totals.total)}</NumCell>
            </Box>
          )}
        </Box>
      )}

      <Box height={1} />
      <Text color={theme.text.secondary}>
        {earliestDay ? `Tracking since ${earliestDay}.  ` : ''}
        ←/→ or Tab to switch period · Esc to close
      </Text>
    </Box>
  );
};
