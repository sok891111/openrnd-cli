/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { UsageDisplay } from '../components/UsageDisplay.js';

export const usageCommand: SlashCommand = {
  name: 'usage',
  description:
    'Show cross-session token usage by model (all time / last 7 / 30 days)',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  action: (context: CommandContext) => ({
    type: 'custom_dialog',
    component: <UsageDisplay onExit={() => context.ui.removeComponent()} />,
  }),
};
