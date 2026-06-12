/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const openMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('open', () => ({ default: openMock }));

// Headless Chrome (puppeteer-core) — a controllable fake page/browser.
const puppeteerState = vi.hoisted(() => ({
  slideCount: 3,
  screenshots: 0,
  launched: 0,
  closed: 0,
}));
const pageMock = vi.hoisted(() => ({
  setDefaultTimeout: vi.fn(),
  setViewport: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  addStyleTag: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  $$eval: vi.fn(),
  screenshot: vi.fn(),
}));
const browserMock = vi.hoisted(() => ({
  newPage: vi.fn(),
  close: vi.fn(),
}));
const launchMock = vi.hoisted(() => vi.fn());
vi.mock('puppeteer-core', () => ({
  launch: launchMock,
  default: { launch: launchMock },
}));

// pptxgenjs — capture slides/images and the written file name.
const pptxState = vi.hoisted(() => ({
  layouts: [] as Array<{ name: string; width: number; height: number }>,
  images: [] as unknown[],
  writtenFileName: '' as string,
  slidesAdded: 0,
}));
const PptxMock = vi.hoisted(
  () =>
    class {
      layout = '';
      defineLayout(def: { name: string; width: number; height: number }) {
        pptxState.layouts.push(def);
      }
      addSlide() {
        pptxState.slidesAdded++;
        return {
          addImage: (img: unknown) => {
            pptxState.images.push(img);
          },
        };
      }
      writeFile({ fileName }: { fileName: string }) {
        pptxState.writtenFileName = fileName;
        return Promise.resolve(fileName);
      }
    },
);
vi.mock('pptxgenjs', () => ({ default: PptxMock }));

// Chrome resolution — controllable.
const resolveChromeMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue('/fake/chrome'),
);
vi.mock('../utils/chromeFinder.js', () => ({
  resolveChromeExecutablePath: resolveChromeMock,
  ChromeNotFoundError: class ChromeNotFoundError extends Error {},
}));

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
import { ToolErrorType } from './tool-error.js';
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
  return invocation.execute({ abortSignal: new AbortController().signal });
}

describe('CreatePptxTool (HTML → PPTX)', () => {
  beforeEach(() => {
    puppeteerState.slideCount = 3;
    pageMock.$$eval.mockResolvedValue(3);
    pageMock.addStyleTag.mockResolvedValue(undefined);
    pageMock.screenshot.mockResolvedValue(Buffer.from(''));
    browserMock.newPage.mockResolvedValue(pageMock);
    browserMock.close.mockResolvedValue(undefined);
    launchMock.mockResolvedValue(browserMock);
    resolveChromeMock.mockResolvedValue('/fake/chrome');
    pptxState.layouts.length = 0;
    pptxState.images.length = 0;
    pptxState.slidesAdded = 0;
    pptxState.writtenFileName = '';
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsPromises.access).mockResolvedValue(undefined as never);
    openMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the create_pptx name', () => {
    expect(makeTool().name).toBe('create_pptx');
  });

  it('errors when neither html nor html_path is provided', async () => {
    const result = await run({});
    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
  });

  it('renders each .slide element and packs one image per slide', async () => {
    const result = await run({
      html: '<section class="slide">A</section><section class="slide">B</section><section class="slide">C</section>',
    });

    expect(result.error).toBeUndefined();
    // Three slides matched ⇒ three screenshots ⇒ three images packed.
    expect(pageMock.screenshot).toHaveBeenCalledTimes(3);
    expect(pptxState.slidesAdded).toBe(3);
    expect(pptxState.images).toHaveLength(3);
    expect(pptxState.writtenFileName.toLowerCase().endsWith('.pptx')).toBe(
      true,
    );
    expect(result.returnDisplay).toContain('3장');
  });

  it('defaults to a 16:9 layout', async () => {
    await run({ html: '<section class="slide">A</section>' });
    expect(pptxState.layouts[0]).toMatchObject({ width: 13.333, height: 7.5 });
  });

  it('uses a 4:3 layout when requested', async () => {
    await run({ html: '<section class="slide">A</section>', aspect: '4:3' });
    expect(pptxState.layouts[0]).toMatchObject({ width: 10, height: 7.5 });
  });

  it('falls back to a single full-page slide when nothing matches', async () => {
    pageMock.$$eval.mockResolvedValue(0);
    const result = await run({ html: '<div>no slides here</div>' });
    expect(result.error).toBeUndefined();
    expect(pageMock.screenshot).toHaveBeenCalledTimes(1);
    expect(pptxState.slidesAdded).toBe(1);
    expect(result.returnDisplay).toContain('1장');
  });

  it('errors when html_path does not exist', async () => {
    vi.mocked(fsPromises.access).mockRejectedValueOnce(new Error('nope'));
    const result = await run({ html_path: 'missing.html' });
    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when no Chrome is found', async () => {
    resolveChromeMock.mockRejectedValueOnce(
      new Error('Chrome 실행 파일을 찾지 못했습니다.'),
    );
    const result = await run({ html: '<section class="slide">A</section>' });
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.returnDisplay).toContain('Chrome');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('saves the inline HTML next to the .pptx and reports both paths', async () => {
    const result = await run({
      html: '<section class="slide">한국어</section>',
      output_path: 'decks/q1',
    });

    expect(result.error).toBeUndefined();
    // The HTML is written with the same basename as the deck, alongside it.
    const writes = vi.mocked(fsPromises.writeFile).mock.calls;
    const htmlWrite = writes.find((c) => String(c[0]).endsWith('.html'));
    expect(htmlWrite).toBeDefined();
    expect(String(htmlWrite?.[0])).toContain('q1.html');
    expect(result.returnDisplay).toContain('원본 HTML');
    expect(result.returnDisplay).toContain('q1.html');
  });

  it('enhances saved inline HTML with slide viewer controls', async () => {
    await run({
      html: '<html><body><section class="slide">A</section></body></html>',
      output_path: 'decks/viewer',
    });

    const writes = vi.mocked(fsPromises.writeFile).mock.calls;
    const htmlWrite = writes.find((c) => String(c[0]).endsWith('.html'));
    expect(String(htmlWrite?.[1])).toContain('openwork-slide-viewer-style');
    expect(String(htmlWrite?.[1])).toContain('openwork-slide-controls');
    expect(String(htmlWrite?.[1])).toContain('openwork-slide-stage');
    expect(String(htmlWrite?.[1])).toContain('openwork-slide-visible');
    expect(String(htmlWrite?.[1])).not.toContain('scroll-snap-type');
  });

  it('does not inject the arrow-keys hint banner', async () => {
    await run({
      html: '<html><body><section class="slide">A</section></body></html>',
      output_path: 'decks/nohint',
    });
    const writes = vi.mocked(fsPromises.writeFile).mock.calls;
    const htmlWrite = writes.find((c) => String(c[0]).endsWith('.html'));
    expect(String(htmlWrite?.[1])).not.toContain('openwork-slide-hint');
    expect(String(htmlWrite?.[1])).not.toContain('Arrow keys or buttons');
  });

  it('skips template analysis (no .pptx) when no vision model is configured', async () => {
    const prevUrl = process.env['OPENWORK_VISION_BASE_URL'];
    const prevModel = process.env['OPENWORK_VISION_MODEL'];
    delete process.env['OPENWORK_VISION_BASE_URL'];
    delete process.env['OPENWORK_VISION_MODEL'];
    try {
      const result = await run({ template_path: 'sample.pptx' });
      // Gracefully degrades: no error, no deck rendered, no Chrome launched.
      expect(result.error).toBeUndefined();
      expect(result.returnDisplay).toContain('Template analysis skipped');
      expect(launchMock).not.toHaveBeenCalled();
      expect(pptxState.slidesAdded).toBe(0);
    } finally {
      if (prevUrl !== undefined)
        process.env['OPENWORK_VISION_BASE_URL'] = prevUrl;
      if (prevModel !== undefined)
        process.env['OPENWORK_VISION_MODEL'] = prevModel;
    }
  });

  it('reports the user-provided html_path as the source (no copy)', async () => {
    const result = await run({ html_path: 'deck.html' });
    expect(result.error).toBeUndefined();
    // html_path mode must not write a new HTML file.
    const wroteHtml = vi
      .mocked(fsPromises.writeFile)
      .mock.calls.some((c) => String(c[0]).endsWith('.html'));
    expect(wroteHtml).toBe(false);
    expect(result.llmContent).toContain('deck.html');
  });

  it('injects a Korean word-break (keep-all) base style before rendering', async () => {
    await run({ html: '<section class="slide">한국어 줄바꿈</section>' });
    expect(pageMock.addStyleTag).toHaveBeenCalledTimes(1);
    const arg = pageMock.addStyleTag.mock.calls[0][0] as { content: string };
    expect(arg.content).toContain('keep-all');
  });

  it('injects capture CSS that forces each slide to the viewport', async () => {
    await run({ html: '<section class="slide">A</section>' });
    const arg = pageMock.addStyleTag.mock.calls[0][0] as { content: string };
    expect(arg.content).toContain('openwork-pptx-capture');
    expect(arg.content).toContain('width:1280px');
    expect(arg.content).toContain('height:720px');
  });

  it('respects open=false', async () => {
    await run({ html: '<section class="slide">A</section>', open: false });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('writes to a custom output_path', async () => {
    await run({
      html: '<section class="slide">A</section>',
      output_path: 'reports/q1',
    });
    expect(pptxState.writtenFileName).toContain('reports');
    expect(pptxState.writtenFileName.endsWith('.pptx')).toBe(true);
  });
});
