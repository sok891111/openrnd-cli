/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const openMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('open', () => ({ default: openMock }));

vi.mock('node:fs/promises', () => {
  const api = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
  };
  return { ...api, default: api };
});

import * as fsPromises from 'node:fs/promises';
import {
  VisualizeAnalysisTool,
  type VisualizeAnalysisParams,
} from './visualize-analysis.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const messageBus = {} as MessageBus;
const config = {
  getTargetDir: () => '/ws',
  validatePathAccess: () => null,
} as unknown as Config;

function makeTool() {
  return new VisualizeAnalysisTool(config, messageBus);
}

async function run(params: VisualizeAnalysisParams) {
  const invocation = makeTool().build(params);
  const result = await invocation.execute({
    abortSignal: new AbortController().signal,
  });
  const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
  const lastWrite = writeCalls[writeCalls.length - 1];
  return {
    result,
    writtenPath: lastWrite?.[0] as string | undefined,
    html: lastWrite?.[1] as string | undefined,
  };
}

describe('VisualizeAnalysisTool', () => {
  beforeEach(() => {
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsPromises.readFile).mockResolvedValue('');
    openMock.mockResolvedValue(undefined);
    delete process.env['OPENRND_MERMAID_JS'];
    delete process.env['OPENRND_MERMAID_URL'];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the visualize_analysis name and requires title + content', () => {
    const tool = makeTool();
    expect(tool.name).toBe('visualize_analysis');
    const schema = tool.schema.parametersJsonSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['title', 'content']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['title', 'content', 'output_path', 'open']),
    );
  });

  it('renders markdown to HTML and writes an .html file under openrnd-analysis by default', async () => {
    const { result, writtenPath, html } = await run({
      title: '주문 처리 로직',
      content: '# 개요\n\n주문 흐름을 설명합니다.\n',
    });

    expect(writtenPath).toMatch(/openrnd-analysis[/\\].*\.html$/);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('주문 처리 로직'); // title in header
    expect(html).toContain('<h1>개요</h1>'); // markdown heading rendered
    expect(result.error).toBeUndefined();
  });

  it('converts ```mermaid fences into <pre class="mermaid"> (not a normal code block)', async () => {
    const { html } = await run({
      title: 'flow',
      content: '```mermaid\nflowchart TD\n A-->B\n```\n',
    });
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('flowchart TD');
    // must NOT be wrapped as a generic highlighted code block
    expect(html).not.toContain('language-mermaid');
  });

  it('falls back to the CDN mermaid loader when no local build is configured', async () => {
    const { html } = await run({ title: 't', content: 'hello' });
    expect(html).toContain('cdn.jsdelivr.net/npm/mermaid');
  });

  it('inlines a local mermaid build when OPENRND_MERMAID_JS is set (offline)', async () => {
    process.env['OPENRND_MERMAID_JS'] = '/opt/mermaid.min.js';
    vi.mocked(fsPromises.readFile).mockResolvedValue(
      '/*LOCAL_MERMAID_BUNDLE*/' as never,
    );
    const { html } = await run({ title: 't', content: 'hi' });
    expect(html).toContain('/*LOCAL_MERMAID_BUNDLE*/');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('opens the report by default and skips opening when open=false', async () => {
    await run({ title: 't', content: 'c' });
    expect(openMock).toHaveBeenCalledTimes(1);

    openMock.mockClear();
    const { result } = await run({ title: 't', content: 'c', open: false });
    expect(openMock).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toContain('not opened');
  });

  it('honors an explicit output_path relative to the workspace', async () => {
    const { writtenPath } = await run({
      title: 't',
      content: 'c',
      output_path: 'reports/biz',
    });
    expect(writtenPath).toBe('/ws/reports/biz.html');
  });

  it('errors on empty title/content', async () => {
    const { result } = await run({ title: '   ', content: '' });
    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('required');
  });

  it('returns a workspace error when the path is outside the workspace', async () => {
    const badConfig = {
      getTargetDir: () => '/ws',
      validatePathAccess: () => 'Path not in workspace',
    } as unknown as Config;
    const invocation = new VisualizeAnalysisTool(badConfig, messageBus).build({
      title: 't',
      content: 'c',
      output_path: '/etc/evil.html',
    });
    const result = await invocation.execute({
      abortSignal: new AbortController().signal,
    });
    expect(result.error?.message).toContain('workspace');
  });
});
