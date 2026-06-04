/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

import { ReadOutlookTool } from './read-outlook.js';
import { READ_OUTLOOK_TOOL_NAME } from './tool-names.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const config = {} as Config;
const messageBus = {} as MessageBus;

function makeTool() {
  return new ReadOutlookTool(config, messageBus);
}

describe('ReadOutlookTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the read_outlook name and an object schema with no required params', () => {
    const tool = makeTool();
    expect(tool.name).toBe(READ_OUTLOOK_TOOL_NAME);
    const schema = tool.schema.parametersJsonSchema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'folder',
        'count',
        'since_days',
        'unread_only',
        'search',
        'entry_id',
      ]),
    );
    expect(schema.required).toEqual([]);
  });

  it('is read-only', () => {
    expect(makeTool().isReadOnly).toBe(true);
  });

  it('returns an error result on non-Windows platforms', async () => {
    vi.mocked(os.platform).mockReturnValue('linux');
    const tool = makeTool();
    const invocation = tool.build({});
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('Windows');
  });
});
