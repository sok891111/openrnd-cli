/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PythonExecTool } from './python-exec.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs/promises', () => {
  const api = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  // python-exec uses `import * as fs`, so expose named members too.
  return { ...api, default: api };
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
}

/**
 * Makes spawn return a fake child whose stdout emits the given byte chunks and
 * then closes with exit code 0.
 */
function mockSpawnEmitting(stdoutChunks: Buffer[]): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      for (const chunk of stdoutChunks) {
        child.stdout.emit('data', chunk);
      }
      child.emit('close', 0);
    });
    return child;
  });
}

async function runCode(code: string): Promise<string> {
  const tool = new PythonExecTool(createMockMessageBus());
  const invocation = tool.build({ code });
  const result = await invocation.execute({
    abortSignal: new AbortController().signal,
  });
  return result.llmContent as string;
}

describe('PythonExecTool encoding handling', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('forces Python UTF-8 mode and does not use a shell', async () => {
    mockSpawnEmitting([Buffer.from('ok', 'utf-8')]);

    await runCode('print("ok")');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0];
    // Missing these env vars is what caused Korean output to throw
    // UnicodeEncodeError / arrive as mojibake on Windows.
    expect(opts.env.PYTHONUTF8).toBe('1');
    expect(opts.env.PYTHONIOENCODING).toBe('utf-8');
    // No shell -> argv goes to CreateProcessW as Unicode (no cmd.exe codepage
    // corruption of the temp script path).
    expect(opts.shell).toBeFalsy();
  });

  it('decodes Korean stdout correctly even when split across chunk boundaries', async () => {
    // "한글" in UTF-8 is 6 bytes; split it mid-character to simulate the OS
    // delivering the pipe data in two chunks.
    const full = Buffer.from('한글', 'utf-8');
    const part1 = full.subarray(0, 4);
    const part2 = full.subarray(4);
    mockSpawnEmitting([part1, part2]);

    const out = await runCode('print("한글")');

    expect(out).toContain('한글');
    expect(out).not.toContain('�'); // no replacement characters
  });
});
