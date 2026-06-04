/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('node:fs/promises', () => {
  const api = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return { ...api, default: api };
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

/** Makes spawn return a fake child that emits `stdout` then closes with 0. */
function mockSpawn(stdout = '[]'): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: () => void };
      stderr: EventEmitter & { setEncoding: () => void };
      kill: () => void;
    };
    const mkStream = () => {
      const s = new EventEmitter() as EventEmitter & {
        setEncoding: () => void;
      };
      s.setEncoding = () => {};
      return s;
    };
    child.stdout = mkStream();
    child.stderr = mkStream();
    child.kill = vi.fn();
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  });
}

/** Runs the tool on win32 and returns the args passed to powershell.exe. */
async function captureArgs(params: object): Promise<string[]> {
  vi.mocked(os.platform).mockReturnValue('win32');
  mockSpawn();
  const invocation = makeTool().build(params);
  await invocation.execute({ abortSignal: new AbortController().signal });
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [exe, args] = spawnMock.mock.calls[0];
  expect(exe).toBe('powershell.exe');
  return args as string[];
}

describe('ReadOutlookTool', () => {
  beforeEach(() => {
    // Re-establish fs mock implementations each test (restoreAllMocks below
    // would otherwise strip them, leaving fs.rm/writeFile returning undefined).
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.rm).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
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
        'all_stores',
        'search_body',
        'store_id',
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

  it('defaults to single-folder Inbox mode (no -AllStores)', async () => {
    const args = await captureArgs({});
    expect(args).toContain('-Folder');
    expect(args).toContain('Inbox');
    expect(args).not.toContain('-AllStores');
  });

  it('searches all stores (incl. archives) and omits -Folder when all_stores is set', async () => {
    const args = await captureArgs({ all_stores: true, search: 'invoice' });
    expect(args).toContain('-AllStores');
    expect(args).not.toContain('-Folder');
    expect(args).toContain('-Search');
    expect(args).toContain('invoice');
  });

  it('passes -SearchBody for full-text body search', async () => {
    const args = await captureArgs({
      all_stores: true,
      search: 'q3',
      search_body: true,
    });
    expect(args).toContain('-SearchBody');
  });

  it('passes -StoreId alongside -EntryId so archived messages can be opened', async () => {
    const args = await captureArgs({ entry_id: 'ABC123', store_id: 'STORE9' });
    expect(args).toContain('-EntryId');
    expect(args).toContain('ABC123');
    expect(args).toContain('-StoreId');
    expect(args).toContain('STORE9');
    // entry_id mode ignores listing params
    expect(args).not.toContain('-Folder');
    expect(args).not.toContain('-AllStores');
  });

  it('reflects all-stores + body search in the description', () => {
    const invocation = makeTool().build({
      all_stores: true,
      search: 'budget',
      search_body: true,
    });
    const desc = invocation.getDescription();
    expect(desc).toContain('all stores + archives');
    expect(desc).toContain('incl. body');
  });
});
