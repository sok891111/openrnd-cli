/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Capture spawn calls and drive a fake child process.
const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  exitCode: 0 as number | null,
  stdout: '',
  stderr: '',
  emitError: undefined as Error | undefined,
}));

const spawnMock = vi.hoisted(() =>
  vi.fn((cmd: string, args: string[]) => {
    spawnState.calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      if (spawnState.emitError) {
        child.emit('error', spawnState.emitError);
        return;
      }
      if (spawnState.stdout)
        child.stdout.emit('data', Buffer.from(spawnState.stdout));
      if (spawnState.stderr)
        child.stderr.emit('data', Buffer.from(spawnState.stderr));
      child.emit('close', spawnState.exitCode);
    });
    return child;
  }),
);
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('node:fs/promises', () => {
  const api = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return { ...api, default: api };
});

import * as fsPromises from 'node:fs/promises';
import { AnalyzePptxTool, type AnalyzePptxParams } from './analyze-pptx.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const messageBus = {} as MessageBus;
const config = {
  getTargetDir: () => '/ws',
} as unknown as Config;

async function run(params: AnalyzePptxParams) {
  const invocation = new AnalyzePptxTool(config, messageBus).build(params);
  return invocation.execute({ abortSignal: new AbortController().signal });
}

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('AnalyzePptxTool', () => {
  beforeEach(() => {
    setPlatform('win32');
    spawnState.calls.length = 0;
    spawnState.exitCode = 0;
    spawnState.stdout = JSON.stringify({
      sample_path: '/samples/inhouse.pptx',
      slide_count: 1,
      slides: [
        {
          index: 1,
          layout_name: '제목 슬라이드',
          summary: '2개 텍스트영역, 제목',
          regions: [
            { id: '1', role: 'title', kind: 'shape', sample_text: '표지' },
            { id: '2', role: 'subtitle', kind: 'shape', sample_text: '부제' },
          ],
        },
      ],
      warnings: [],
    });
    spawnState.stderr = '';
    spawnState.emitError = undefined;
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.clearAllMocks();
  });

  it('exposes the analyze_pptx_template name and requires sample_path', () => {
    const tool = new AnalyzePptxTool(config, messageBus);
    expect(tool.name).toBe('analyze_pptx_template');
    const schema = tool.schema.parametersJsonSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['sample_path']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['sample_path', 'timeout_seconds']),
    );
  });

  it('returns the structured analysis JSON to the model', async () => {
    const result = await run({ sample_path: '/samples/inhouse.pptx' });
    expect(result.error).toBeUndefined();
    expect(spawnState.calls.length).toBe(1);
    // The sample path is passed as argv[1] (no shell, Unicode-safe).
    expect(spawnState.calls[0].args[1]).toBe('/samples/inhouse.pptx');
    expect(String(result.llmContent)).toContain('"id":"1"');
    expect(String(result.llmContent)).toContain('create_pptx');
  });

  it('only runs on Windows', async () => {
    setPlatform('darwin');
    const result = await run({ sample_path: '/samples/inhouse.pptx' });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('Windows');
    expect(spawnState.calls.length).toBe(0);
  });

  it('errors when the sample deck is missing', async () => {
    vi.mocked(fsPromises.access).mockRejectedValueOnce(new Error('ENOENT'));
    const result = await run({ sample_path: '/missing.pptx' });
    expect(String(result.llmContent)).toContain('Sample deck not found');
  });

  it('surfaces a non-zero python exit as an error with stderr', async () => {
    spawnState.exitCode = 5;
    spawnState.stdout = '';
    spawnState.stderr = 'PPTX_ANALYZE_ERROR: boom';
    const result = await run({ sample_path: '/samples/inhouse.pptx' });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('boom');
  });
});
