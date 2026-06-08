/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const openMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('open', () => ({ default: openMock }));

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
    // Drive the process asynchronously so listeners are attached first.
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
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return { ...api, default: api };
});

import * as fsPromises from 'node:fs/promises';
import { CreatePptxTool, type CreatePptxParams } from './create-pptx.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const messageBus = {} as MessageBus;
const config = {
  getTargetDir: () => '/ws',
  validatePathAccess: () => null,
} as unknown as Config;

function makeTool(cfg: Config = config) {
  return new CreatePptxTool(cfg, messageBus);
}

async function run(params: CreatePptxParams, cfg: Config = config) {
  const invocation = makeTool(cfg).build(params);
  const result = await invocation.execute({
    abortSignal: new AbortController().signal,
  });
  // The JSON spec is the second writeFile (after the python script).
  const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
  const specCall = writeCalls.find((c) => String(c[0]).endsWith('.json'));
  return {
    result,
    spec: specCall ? (JSON.parse(specCall[1] as string) as unknown) : undefined,
    spawnArgs: spawnState.calls.at(-1)?.args,
  };
}

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('CreatePptxTool', () => {
  beforeEach(() => {
    setPlatform('win32'); // tool is Windows-only
    spawnState.calls.length = 0;
    spawnState.exitCode = 0;
    spawnState.stdout = JSON.stringify({
      output: 'out.pptx',
      slides: 1,
      warnings: [],
    });
    spawnState.stderr = '';
    spawnState.emitError = undefined;
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined as never);
    openMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.clearAllMocks();
  });

  it('exposes the create_pptx name and requires slides', () => {
    const tool = makeTool();
    expect(tool.name).toBe('create_pptx');
    const schema = tool.schema.parametersJsonSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['slides']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['slides', 'sample_path', 'output_path', 'open']),
    );
  });

  it('writes a default .pptx path under openrnd-ppt and passes it to python', async () => {
    const { result, spawnArgs } = await run({
      slides: [{ layout: 'title', title: '2026 1분기 보고' }],
    });
    expect(result.error).toBeUndefined();
    const outArg = spawnArgs?.[2] ?? '';
    expect(outArg).toMatch(/openrnd-ppt[/\\].*\.pptx$/);
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it('forwards slides and sample_path into the JSON spec', async () => {
    const { spec } = await run({
      slides: [
        {
          layout: 'bullets',
          title: '성과',
          bullets: ['매출 12%↑', '신규 5종'],
        },
      ],
      sample_path: '/samples/inhouse.pptx',
    });
    expect(spec).toMatchObject({
      sample_path: '/samples/inhouse.pptx',
      slides: [{ title: '성과', bullets: ['매출 12%↑', '신규 5종'] }],
    });
  });

  it('defaults style to consulting and forwards footer in the spec', async () => {
    const { spec } = await run({
      slides: [{ title: '개요', bullets: ['a', 'b'] }],
      footer: '개발팀 · Confidential',
    });
    expect(spec).toMatchObject({
      style: 'consulting',
      footer: '개발팀 · Confidential',
    });
  });

  it('passes style=plain through when requested', async () => {
    const { spec } = await run({
      slides: [{ title: 't' }],
      style: 'plain',
    });
    expect(spec).toMatchObject({ style: 'plain' });
  });

  it('honors an explicit output_path relative to the workspace', async () => {
    const { spawnArgs } = await run({
      slides: [{ title: 't' }],
      output_path: 'reports/q1',
    });
    expect(spawnArgs?.[2]).toBe('/ws/reports/q1.pptx');
  });

  it('skips opening when open=false', async () => {
    const { result } = await run({
      slides: [{ title: 't' }],
      open: false,
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain('open=false');
  });

  it('errors when slides is empty', async () => {
    const { result } = await run({ slides: [] });
    expect(result.error?.type).toBeDefined();
    expect(String(result.llmContent)).toContain('at least one slide');
  });

  it('errors when the sample deck does not exist', async () => {
    vi.mocked(fsPromises.access).mockRejectedValueOnce(new Error('ENOENT'));
    const { result } = await run({
      slides: [{ title: 't' }],
      sample_path: '/missing.pptx',
    });
    expect(String(result.llmContent)).toContain('Sample deck not found');
  });

  it('surfaces a non-zero python exit as an error with stderr', async () => {
    spawnState.exitCode = 5;
    spawnState.stdout = '';
    spawnState.stderr = 'PPTX_BUILD_ERROR: boom';
    const { result } = await run({ slides: [{ title: 't' }] });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('boom');
  });

  it('requires Windows only for the sample-clone path', async () => {
    setPlatform('darwin');
    const { result } = await run({
      slides: [{ title: 't' }],
      sample_path: '/samples/inhouse.pptx',
    });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('Windows');
    expect(spawnState.calls.length).toBe(0);
  });

  it('renders the consulting deck via python-pptx on non-Windows (no sample)', async () => {
    setPlatform('darwin');
    const { result, spawnArgs } = await run({
      slides: [
        {
          layout: 'content',
          title: '매출은 12% 성장했다',
          body: [{ type: 'kpis', items: [{ value: '+12%', label: '성장' }] }],
          takeaway: '성장 모멘텀 유지',
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(spawnState.calls.length).toBe(1);
    expect(spawnArgs?.[2]).toMatch(/\.pptx$/);
  });

  it('exposes process/timeline infographic blocks in the schema', () => {
    const tool = makeTool();
    const schema = tool.schema.parametersJsonSchema as Record<string, unknown>;
    // Drill into slides[].body[].type enum.
    const slides = (
      schema['properties'] as Record<string, { items?: unknown }>
    )['slides'];
    const slideItem = (slides.items as { properties: Record<string, unknown> })
      .properties;
    const body = slideItem['body'] as {
      items: { properties: Record<string, unknown> };
    };
    const blockProps = body.items.properties as {
      type: { enum: string[] };
      steps?: unknown;
      events?: unknown;
    };
    expect(blockProps.type.enum).toEqual(
      expect.arrayContaining(['process', 'timeline']),
    );
    expect(blockProps.steps).toBeDefined();
    expect(blockProps.events).toBeDefined();
  });

  it('forwards process and timeline blocks (with icons) into the JSON spec', async () => {
    const { spec } = await run({
      slides: [
        {
          layout: 'content',
          title: '전환은 4단계로 추진한다',
          body: [
            {
              type: 'process',
              steps: [
                { title: '진단', text: '현황 분석', icon: 'search' },
                { title: '실행', icon: 'launch' },
              ],
            },
            {
              type: 'timeline',
              events: [
                { label: '1분기', title: '착수', icon: 'flag' },
                { label: '2분기', title: '확산' },
              ],
            },
          ],
        },
      ],
    });
    expect(spec).toMatchObject({
      slides: [
        {
          body: [
            {
              type: 'process',
              steps: [
                { title: '진단', text: '현황 분석', icon: 'search' },
                { title: '실행', icon: 'launch' },
              ],
            },
            {
              type: 'timeline',
              events: [
                { label: '1분기', title: '착수', icon: 'flag' },
                { label: '2분기', title: '확산' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('coerces a JSON-stringified slides argument into a real array', async () => {
    // Some in-house models serialize structured tool args as strings, which
    // otherwise fails schema validation with "params/slides must be array".
    const { result, spec } = await run({
      slides: JSON.stringify([
        { layout: 'bullets', title: '성과', bullets: ['매출 12%↑'] },
      ]),
    } as unknown as CreatePptxParams);
    expect(result.error).toBeUndefined();
    expect(spec).toMatchObject({
      slides: [{ title: '성과', bullets: ['매출 12%↑'] }],
    });
  });

  it('coerces string-encoded nested body/bullets/table fields', async () => {
    const { result, spec } = await run({
      slides: [
        {
          layout: 'content',
          title: '개요',
          bullets: '["a","b"]',
          body: '[{"type":"kpis","items":[{"value":"+12%","label":"성장"}]}]',
        },
      ],
    } as unknown as CreatePptxParams);
    expect(result.error).toBeUndefined();
    expect(spec).toMatchObject({
      slides: [
        {
          title: '개요',
          bullets: ['a', 'b'],
          body: [{ type: 'kpis', items: [{ value: '+12%', label: '성장' }] }],
        },
      ],
    });
  });

  it('wraps a single slide object passed instead of an array', async () => {
    const { result, spec } = await run({
      slides: { layout: 'title', title: '단일 슬라이드' },
    } as unknown as CreatePptxParams);
    expect(result.error).toBeUndefined();
    expect(spec).toMatchObject({
      slides: [{ title: '단일 슬라이드' }],
    });
  });

  it('returns a workspace error when the output path is outside the workspace', async () => {
    const badConfig = {
      getTargetDir: () => '/ws',
      validatePathAccess: () => 'Path not in workspace',
    } as unknown as Config;
    const { result } = await run(
      { slides: [{ title: 't' }], output_path: '/etc/evil.pptx' },
      badConfig,
    );
    expect(result.error?.message).toContain('workspace');
  });
});
