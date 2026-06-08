/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { usageCommand } from './usageCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { type OpenCustomDialogActionReturn } from './types.js';

describe('usageCommand', () => {
  it('is registered with the expected metadata', () => {
    expect(usageCommand.name).toBe('usage');
    expect(usageCommand.altNames).toBeUndefined();
    expect(usageCommand.description).toMatch(/token usage/i);
  });

  it('returns a custom dialog component', () => {
    const context = createMockCommandContext();
    const result = usageCommand.action!(
      context,
      '',
    ) as OpenCustomDialogActionReturn;

    expect(result.type).toBe('custom_dialog');
    expect(result.component).toBeDefined();
  });

  it('removes the component on exit', () => {
    const removeComponent = vi.fn();
    const context = createMockCommandContext({
      ui: { removeComponent },
    });
    const result = usageCommand.action!(
      context,
      '',
    ) as OpenCustomDialogActionReturn;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onExit = (result.component as any).props.onExit;
    onExit();
    expect(removeComponent).toHaveBeenCalledTimes(1);
  });
});
