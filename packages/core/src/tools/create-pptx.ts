/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import open from 'open';
import { launch, type Browser } from 'puppeteer-core';
import pptxgenDefault from 'pptxgenjs';

// pptxgenjs ships a faux-ESM CommonJS type declaration; under NodeNext TS types
// the default import as the module namespace, but the runtime ESM/CJS default
// export is the class constructor itself (`export { PptxGenJS as default }` /
// `module.exports = PptxGenJS`). Re-type the runtime value to its constructor.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const PptxGen = pptxgenDefault as unknown as typeof import('pptxgenjs').default;
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import { resolveChromeExecutablePath } from '../utils/chromeFinder.js';
import { renderPptxToImages } from '../utils/officeReader.js';
import {
  getVisionConfigFromEnv,
  describeImageData,
} from '../core/visionDescriber.js';

export const CREATE_PPTX_TOOL_NAME = 'create_pptx';
export const CREATE_PPTX_DISPLAY_NAME = 'Create PowerPoint';

/** Default subdirectory (under the target dir) for generated decks. */
const DEFAULT_OUTPUT_DIR = 'openrnd-ppt';

/** Default CSS selector that marks each slide element in the HTML deck. */
const DEFAULT_SLIDE_SELECTOR = '.slide';

/** Rendering can be slow on first Chrome launch; allow a generous default. */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

/** Device scale factor for crisp (retina) slide images. */
const RENDER_SCALE = 2;

/** Supported deck aspect ratios. */
export type CreatePptxAspect = '16:9' | '4:3';

export interface CreatePptxParams {
  /**
   * The full HTML of the slide deck, authored so each slide is one element
   * matching `slide_selector` (default `.slide`). Provide this OR `html_path`.
   */
  html?: string;
  /**
   * Path to an existing self-contained HTML deck file. Provide this OR `html`.
   * Relative paths resolve against the workspace target dir.
   */
  html_path?: string;
  /**
   * CSS selector matching each slide element. Default `.slide`. If nothing
   * matches, the whole page is rendered as a single slide.
   */
  slide_selector?: string;
  /** Deck aspect ratio. Default '16:9'. */
  aspect?: CreatePptxAspect;
  /** Override the render width in CSS pixels (advanced). */
  width_px?: number;
  /** Override the render height in CSS pixels (advanced). */
  height_px?: number;
  /** Output .pptx path. Default: <workspace>/openrnd-ppt/<name>-<ts>.pptx. */
  output_path?: string;
  /** Open the generated deck when done. Default true. */
  open?: boolean;
  /** Max time (seconds) for the whole render+pack. Default 180, max 600. */
  timeout_seconds?: number;
  /**
   * Path to a sample PPT/PPTX deck to use as a visual TEMPLATE. When provided
   * WITHOUT `html`/`html_path`, the tool runs in analysis mode: it renders the
   * sample's slides to images, analyzes them with the vision model, and returns
   * a reusable visual style guide (it does NOT create a .pptx). Author your HTML
   * to follow that guide, then call again with `html`. Relative paths resolve
   * against the workspace target dir.
   */
  template_path?: string;
}

/** Max slides rendered from a sample deck for template analysis (cost bound). */
const TEMPLATE_MAX_SLIDES = 10;

/** Vision instruction for extracting a reusable design system from sample slides. */
const TEMPLATE_STYLE_GUIDE_PROMPT =
  'These images are slides from a sample PowerPoint deck the user provided as a ' +
  'DESIGN TEMPLATE. Analyze them together and produce a concise, reusable VISUAL ' +
  'STYLE GUIDE another designer can follow to recreate this deck’s look in ' +
  'HTML/CSS. Cover: overall tone/mood; the color palette with approximate hex ' +
  'codes (background, primary, accent, text); typography (font family feel, ' +
  'heading vs body sizes/weights, casing); layout grid, margins and content ' +
  'density; title/header placement and any recurring header band; footer and ' +
  'page-number treatment; recurring components (KPI/stat cards, tables, charts, ' +
  'icons, dividers, callouts) and how they are styled; and whitespace rhythm. ' +
  'Output structured bullet points. Do NOT summarize the slide CONTENT/topic — ' +
  'describe only the reusable visual design system.';

interface SlideDimensions {
  /** CSS pixel width/height of one slide (the render viewport). */
  widthPx: number;
  heightPx: number;
  /** PPTX slide size in inches. */
  widthIn: number;
  heightIn: number;
}

function buildSlideViewerInjection(dims: SlideDimensions): string {
  return `<style id="openrnd-slide-viewer-style">
@media screen {
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
  }
  html { background: #111318; }
  body.openrnd-slide-viewer {
    margin: 0;
    background: #111318;
    overflow: hidden;
  }
  body.openrnd-slide-viewer .slide {
    width: ${dims.widthPx}px;
    height: ${dims.heightPx}px;
    box-sizing: border-box;
    overflow: hidden;
    margin: 0;
  }
  .openrnd-slide-stage {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px 88px;
    background:
      radial-gradient(circle at top left, rgba(96, 151, 255, 0.14), transparent 32%),
      radial-gradient(circle at bottom right, rgba(26, 203, 135, 0.12), transparent 28%),
      linear-gradient(180deg, #171a22 0%, #0f1117 100%);
  }
  .openrnd-slide-stage .slide {
    display: none;
    box-shadow:
      0 28px 72px rgba(0, 0, 0, 0.42),
      0 0 0 1px rgba(255, 255, 255, 0.08);
  }
  .openrnd-slide-stage .slide.openrnd-slide-visible {
    display: block;
  }
  .openrnd-slide-controls {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    border-radius: 999px;
    background: rgba(17, 19, 24, 0.82);
    color: #fff;
    font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(8px);
  }
  .openrnd-slide-controls button {
    width: 32px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  .openrnd-slide-controls button:hover {
    background: rgba(255, 255, 255, 0.24);
  }
  .openrnd-slide-counter {
    min-width: 54px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
}
</style>
<script id="openrnd-slide-viewer-script">
(() => {
  const init = () => {
    const slides = Array.from(document.querySelectorAll('.slide'));
    if (slides.length === 0 || document.querySelector('.openrnd-slide-controls')) return;
    document.body.classList.add('openrnd-slide-viewer');
    const stage = document.createElement('div');
    stage.className = 'openrnd-slide-stage';
    slides.forEach((slide) => stage.appendChild(slide));
    document.body.appendChild(stage);
    const controls = document.createElement('div');
    controls.className = 'openrnd-slide-controls';
    controls.innerHTML = '<button type="button" data-openrnd-prev aria-label="Previous slide">&lt;</button><span class="openrnd-slide-counter"></span><button type="button" data-openrnd-next aria-label="Next slide">&gt;</button>';
    document.body.appendChild(controls);
    const counter = controls.querySelector('.openrnd-slide-counter');
    let index = 0;
    const show = (next) => {
      index = Math.max(0, Math.min(slides.length - 1, next));
      slides.forEach((slide, slideIndex) => {
        slide.classList.toggle('openrnd-slide-visible', slideIndex === index);
      });
      counter.textContent = String(index + 1) + ' / ' + String(slides.length);
    };
    controls.querySelector('[data-openrnd-prev]').addEventListener('click', () => show(index - 1));
    controls.querySelector('[data-openrnd-next]').addEventListener('click', () => show(index + 1));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') show(index + 1);
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'PageUp') show(index - 1);
      if (event.key === 'Home') show(0);
      if (event.key === 'End') show(slides.length - 1);
    });
    let wheelLock = false;
    window.addEventListener('wheel', (event) => {
      if (wheelLock) return;
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(delta) < 12) return;
      wheelLock = true;
      show(index + (delta > 0 ? 1 : -1));
      window.setTimeout(() => { wheelLock = false; }, 180);
    }, { passive: true });
    show(0);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}

function injectBeforeClosingTag(
  html: string,
  tag: 'head' | 'body',
  value: string,
): string {
  const re = new RegExp(`</${tag}>`, 'i');
  if (re.test(html)) {
    return html.replace(re, `${value}</${tag}>`);
  }
  return `${html}\n${value}`;
}

function enhanceInlineHtmlForSlideViewing(
  html: string,
  dims: SlideDimensions,
): string {
  if (html.includes('id="openrnd-slide-viewer-style"')) {
    return html;
  }
  const injection = buildSlideViewerInjection(dims);
  return injectBeforeClosingTag(html, 'body', injection);
}

/** Maps params to concrete render + PPTX dimensions. */
function resolveDimensions(params: CreatePptxParams): SlideDimensions {
  if (
    typeof params.width_px === 'number' &&
    typeof params.height_px === 'number' &&
    params.width_px > 0 &&
    params.height_px > 0
  ) {
    const heightIn = 7.5;
    const widthIn =
      Math.round(((heightIn * params.width_px) / params.height_px) * 1000) /
      1000;
    return {
      widthPx: Math.round(params.width_px),
      heightPx: Math.round(params.height_px),
      widthIn,
      heightIn,
    };
  }
  if (params.aspect === '4:3') {
    return { widthPx: 1280, heightPx: 960, widthIn: 10, heightIn: 7.5 };
  }
  // 16:9 default
  return { widthPx: 1280, heightPx: 720, widthIn: 13.333, heightIn: 7.5 };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'deck'
  );
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

class CreatePptxInvocation extends BaseToolInvocation<
  CreatePptxParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CreatePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const src = this.params.html_path
      ? path.basename(this.params.html_path)
      : 'inline HTML';
    return `Render an HTML deck (${src}) to a PowerPoint file`;
  }

  /** Resolves the output .pptx path, defaulting under <targetDir>/openrnd-ppt/. */
  private resolveOutputPath(): string {
    const { output_path } = this.params;
    if (output_path && output_path.trim()) {
      let p = output_path.trim();
      if (!p.toLowerCase().endsWith('.pptx')) {
        p = `${p}.pptx`;
      }
      return path.isAbsolute(p)
        ? path.resolve(p)
        : path.resolve(this.config.getTargetDir(), p);
    }
    const base = this.params.html_path
      ? slugify(
          path.basename(
            this.params.html_path,
            path.extname(this.params.html_path),
          ),
        )
      : 'deck';
    return path.resolve(
      this.config.getTargetDir(),
      DEFAULT_OUTPUT_DIR,
      `${base}-${timestamp()}.pptx`,
    );
  }

  /**
   * Analysis mode: render a sample deck's slides to images, have the vision
   * model extract a reusable visual style guide, save it, and return it so the
   * model can author HTML that matches the sample's look.
   */
  private async analyzeTemplate(templatePath: string): Promise<ToolResult> {
    const resolved = path.isAbsolute(templatePath)
      ? path.resolve(templatePath)
      : path.resolve(this.config.getTargetDir(), templatePath);
    try {
      await fs.access(resolved);
    } catch {
      const msg = `Template file not found: ${resolved}`;
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    const visionConfig = getVisionConfigFromEnv();
    if (!visionConfig) {
      const msg =
        'Visual template analysis requires a configured vision model ' +
        '(settings.json `llm.vision.*`). Without it the sample deck’s visual ' +
        'style cannot be analyzed; author the deck generically instead.';
      return {
        llmContent: `Template analysis unavailable: ${msg}`,
        returnDisplay:
          'Template analysis skipped (no vision model configured).',
      };
    }

    const dims = resolveDimensions(this.params);
    const renderDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrnd_tpl_'));
    try {
      const rendered = await renderPptxToImages(resolved, renderDir, {
        widthPx: dims.widthPx,
        heightPx: dims.heightPx,
        maxSlides: TEMPLATE_MAX_SLIDES,
      });
      if (rendered.error || !rendered.imagePaths?.length) {
        const msg =
          rendered.error ?? 'No slides were rendered from the sample deck.';
        return {
          llmContent: `Template analysis failed: ${msg}`,
          returnDisplay: `Template analysis failed: ${msg}`,
          error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const images = await Promise.all(
        rendered.imagePaths.map(async (p) => ({
          data: (await fs.readFile(p)).toString('base64'),
          mimeType: 'image/png',
        })),
      );

      let styleGuide: string;
      try {
        styleGuide = await describeImageData(
          visionConfig,
          images,
          TEMPLATE_STYLE_GUIDE_PROMPT,
        );
      } catch (e) {
        const msg = getErrorMessage(e);
        return {
          llmContent: `Template analysis failed (vision model error): ${msg}`,
          returnDisplay: `Template analysis failed: ${msg}`,
          error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      // Save the style guide next to where decks are written, for reuse.
      const guidePath = path.resolve(
        this.config.getTargetDir(),
        DEFAULT_OUTPUT_DIR,
        `template-style-${timestamp()}.md`,
      );
      await fs
        .mkdir(path.dirname(guidePath), { recursive: true })
        .catch(() => {});
      const guideDoc =
        `# Visual style guide extracted from ${path.basename(resolved)}\n` +
        `(Analyzed ${images.length} slide(s) with vision model "${visionConfig.model}")\n\n` +
        styleGuide;
      await fs.writeFile(guidePath, guideDoc, 'utf-8').catch(() => {});

      return {
        llmContent:
          `VISUAL STYLE GUIDE extracted from the sample deck ` +
          `(${path.basename(resolved)}, ${images.length} slide(s) analyzed).\n` +
          `NEXT STEP: author the HTML deck so it closely follows this style ` +
          `guide — palette, typography, layout, header/footer, and components — ` +
          `then call create_pptx again with that HTML.\n\n` +
          `${styleGuide}\n\n(Saved to: ${guidePath})`,
        returnDisplay:
          `🎨 샘플 PPT 양식 분석 완료 (${images.length}장)\n\n` +
          `- 추출한 스타일 가이드를 반영해 HTML을 작성한 뒤 create_pptx를 다시 호출합니다.\n` +
          `- 가이드 저장: \`${guidePath}\``,
      };
    } catch (e) {
      const msg = getErrorMessage(e);
      return {
        llmContent: `Error analyzing template: ${msg}`,
        returnDisplay: `Error analyzing template: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    } finally {
      await fs.rm(renderDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const inlineHtml =
      typeof this.params.html === 'string' ? this.params.html.trim() : '';
    const htmlPathParam =
      typeof this.params.html_path === 'string'
        ? this.params.html_path.trim()
        : '';
    const templatePathParam =
      typeof this.params.template_path === 'string'
        ? this.params.template_path.trim()
        : '';

    // Analysis mode: a sample template was given without HTML to render. Extract
    // a visual style guide from the sample and return it so the model can author
    // matching HTML, then call again with `html`.
    if (templatePathParam && !inlineHtml && !htmlPathParam) {
      return this.analyzeTemplate(templatePathParam);
    }

    if (!inlineHtml && !htmlPathParam) {
      const msg =
        "Provide the deck as 'html' (inline HTML string) or 'html_path' (path to an HTML file). " +
        "To analyze a sample deck's visual style first, pass only 'template_path'.";
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    const outPath = this.resolveOutputPath();
    const validationError = this.config.validatePathAccess(outPath, 'write');
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: 'Output path is not in the workspace.',
        error: {
          message: validationError,
          type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
        },
      };
    }

    const dims = resolveDimensions(this.params);

    // Resolve the HTML source into a file:// URL the browser can load. Inline
    // HTML is saved permanently next to the .pptx (same basename) so the user
    // gets the editable source alongside the deck.
    let htmlFileUrl: string;
    // The HTML path we report back to the user (the saved source deck).
    let reportedHtmlPath: string;
    try {
      if (inlineHtml) {
        const htmlSavePath = path.join(
          path.dirname(outPath),
          `${path.basename(outPath, path.extname(outPath))}.html`,
        );
        const htmlValidationError = this.config.validatePathAccess(
          htmlSavePath,
          'write',
        );
        if (htmlValidationError) {
          return {
            llmContent: `Error: ${htmlValidationError}`,
            returnDisplay: 'HTML output path is not in the workspace.',
            error: {
              message: htmlValidationError,
              type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
            },
          };
        }
        await fs.mkdir(path.dirname(htmlSavePath), { recursive: true });
        await fs.writeFile(
          htmlSavePath,
          enhanceInlineHtmlForSlideViewing(inlineHtml, dims),
          'utf-8',
        );
        htmlFileUrl = pathToFileUrl(htmlSavePath);
        reportedHtmlPath = htmlSavePath;
      } else {
        const resolved = path.isAbsolute(htmlPathParam)
          ? path.resolve(htmlPathParam)
          : path.resolve(this.config.getTargetDir(), htmlPathParam);
        try {
          await fs.access(resolved);
        } catch {
          const msg = `HTML file not found: ${resolved}`;
          return {
            llmContent: `Error: ${msg}`,
            returnDisplay: `Error: ${msg}`,
            error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
          };
        }
        htmlFileUrl = pathToFileUrl(resolved);
        reportedHtmlPath = resolved;
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      return {
        llmContent: `Error preparing HTML: ${msg}`,
        returnDisplay: `Error preparing HTML: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    // Locate a Chrome to render with.
    let chromePath: string;
    try {
      chromePath = await resolveChromeExecutablePath();
    } catch (e) {
      const msg = getErrorMessage(e);
      // ChromeNotFoundError carries actionable guidance in its message.
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const timeout = Math.min(
      (this.params.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
      MAX_TIMEOUT_MS,
    );
    const selector =
      this.params.slide_selector?.trim() || DEFAULT_SLIDE_SELECTOR;
    const tmpDir = path.join(os.tmpdir(), `openrnd_pptx_${randomUUID()}`);

    let browser: Browser | undefined;
    const onAbort = () => {
      browser?.close().catch(() => {});
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.mkdir(path.dirname(outPath), { recursive: true });

      browser = await launch({
        executablePath: chromePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--hide-scrollbars'],
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(timeout);
      await page.setViewport({
        width: dims.widthPx,
        height: dims.heightPx,
        deviceScaleFactor: RENDER_SCALE,
      });
      await page.goto(htmlFileUrl, { waitUntil: 'networkidle0', timeout });
      // Korean wraps between any two characters by default, which looks ragged.
      // Inject a low-specificity base rule so it breaks at word boundaries
      // instead; the deck's own CSS can still override per element.
      await page
        .addStyleTag({
          content:
            'html{word-break:keep-all;overflow-wrap:break-word;line-break:strict;}' +
            `html.openrnd-pptx-capture,html.openrnd-pptx-capture body{margin:0!important;padding:0!important;width:${dims.widthPx}px!important;height:${dims.heightPx}px!important;overflow:hidden!important;}` +
            `html.openrnd-pptx-capture .openrnd-pptx-slide{box-sizing:border-box!important;width:${dims.widthPx}px!important;height:${dims.heightPx}px!important;max-width:none!important;max-height:none!important;margin:0!important;overflow:hidden!important;}` +
            'html.openrnd-pptx-capture .openrnd-pptx-active{display:block!important;visibility:visible!important;position:fixed!important;inset:0 auto auto 0!important;transform:none!important;opacity:1!important;z-index:1!important;}' +
            'html.openrnd-pptx-capture .openrnd-pptx-hidden{display:none!important;visibility:hidden!important;}' +
            'html.openrnd-pptx-capture .openrnd-slide-controls{display:none!important;}',
        })
        .catch(() => {});
      // Make sure web fonts are ready before snapshotting.
      await page.evaluate(() => document.fonts?.ready).catch(() => {});

      const clip = { x: 0, y: 0, width: dims.widthPx, height: dims.heightPx };
      const shoot = async (file: string): Promise<void> => {
        const buf = await page.screenshot({ clip });
        await fs.writeFile(file, buf);
      };

      const slideCount = await page
        .$$eval(selector, (els) => els.length)
        .catch(() => 0);

      const pngPaths: string[] = [];
      const warnings: string[] = [];

      if (slideCount === 0) {
        // No slide elements matched: render the whole page as one slide.
        warnings.push(
          `No elements matched selector "${selector}"; rendered the whole page as a single slide.`,
        );
        const png = path.join(tmpDir, 'slide-0.png');
        await shoot(png);
        pngPaths.push(png);
      } else {
        await page.evaluate((sel) => {
          document.documentElement.classList.add('openrnd-pptx-capture');
          document.body?.classList.remove('openrnd-slide-viewer');
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          els.forEach((e) => {
            e.classList.add('openrnd-pptx-slide');
          });
        }, selector);

        for (let i = 0; i < slideCount; i++) {
          if (abortSignal?.aborted) throw new Error('Aborted');
          // Isolate slide i: show only it, full-viewport, at the top.
          await page.evaluate(
            (sel, idx) => {
              const els = Array.from(
                document.querySelectorAll<HTMLElement>(sel),
              );
              els.forEach((e, j) => {
                e.classList.toggle('openrnd-pptx-active', j === idx);
                e.classList.toggle('openrnd-pptx-hidden', j !== idx);
              });
              window.scrollTo(0, 0);
            },
            selector,
            i,
          );
          const png = path.join(tmpDir, `slide-${i}.png`);
          await shoot(png);
          pngPaths.push(png);
        }
      }

      await browser.close();
      browser = undefined;

      // Pack the rendered slides into a .pptx, one full-bleed image per slide.
      const pres = new PptxGen();
      pres.defineLayout({
        name: 'OPENRND',
        width: dims.widthIn,
        height: dims.heightIn,
      });
      pres.layout = 'OPENRND';
      for (const png of pngPaths) {
        const slide = pres.addSlide();
        slide.addImage({
          path: png,
          x: 0,
          y: 0,
          w: dims.widthIn,
          h: dims.heightIn,
        });
      }
      await pres.writeFile({ fileName: outPath });

      let opened = false;
      let openError: string | undefined;
      if (this.params.open !== false) {
        try {
          await open(outPath);
          opened = true;
        } catch (e) {
          openError = getErrorMessage(e);
          debugLogger.warn(
            `[create_pptx] Failed to open ${outPath}: ${openError}`,
          );
        }
      }

      const note = opened
        ? '열었습니다.'
        : this.params.open === false
          ? '파일을 열지 않았습니다 (open=false).'
          : `자동으로 열지 못했습니다 (${openError}). 직접 열어 주세요.`;
      const warnText =
        warnings.length > 0 ? `\n참고: ${warnings.join(' ')}` : '';

      return {
        llmContent:
          `PowerPoint deck written to: ${outPath}\n` +
          `Source HTML saved to: ${reportedHtmlPath}\n` +
          `Slides: ${pngPaths.length} (rendered from HTML via headless Chrome)\n` +
          (warnings.length ? `Warnings: ${warnings.join(' | ')}\n` : '') +
          note,
        returnDisplay:
          `📊 PPT 생성 완료 (${pngPaths.length}장)\n\n` +
          `- PPT: \`${outPath}\`\n` +
          `- 원본 HTML: \`${reportedHtmlPath}\`\n` +
          `- HTML을 헤드리스 Chrome으로 렌더링해 슬라이드 이미지로 변환했습니다.\n` +
          `- ${note}${warnText}`,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error creating PowerPoint: ${msg}`,
        returnDisplay: `Error creating PowerPoint: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      if (browser) await browser.close().catch(() => {});
      // The rendered PNGs are temporary; the saved .html source is kept.
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Converts an absolute filesystem path to a file:// URL. */
function pathToFileUrl(p: string): string {
  let resolved = path.resolve(p).replace(/\\/g, '/');
  if (!resolved.startsWith('/')) {
    resolved = `/${resolved}`; // Windows drive paths (C:/...) need a leading slash.
  }
  return `file://${encodeURI(resolved)}`;
}

export class CreatePptxTool extends BaseDeclarativeTool<
  CreatePptxParams,
  ToolResult
> {
  static readonly Name = CREATE_PPTX_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CreatePptxTool.Name,
      CREATE_PPTX_DISPLAY_NAME,
      'Create a PowerPoint (.pptx) deck from an HTML slide deck and open it. Use this ' +
        'whenever the user asks to make slides or a deck — Korean triggers include PPT/피피티/' +
        '슬라이드/장표 만들어줘, 보고서 슬라이드로, 발표자료 만들어줘.\n\n' +
        'HOW IT WORKS: you FIRST author a single self-contained HTML slide deck, not a long ' +
        'scrolling report. Each slide is one top-level element with class "slide" (the default ' +
        'selector). Design it like a ' +
        'real deck — strong typography, infographics, KPI/stat cards, charts, icons, color — ' +
        'using inline CSS (and inline <svg> or a CDN chart lib if helpful). Size each slide as ' +
        'an exact slide canvas (16:9 ⇒ 1280×720 px). The saved HTML is enhanced with a presentation-style ' +
        'viewer so the user can page through it in the browser one slide at a time. Then call this tool with that HTML as "html" ' +
        '(or a saved file via "html_path"). The tool renders every ".slide" element to a ' +
        'high-resolution image with headless Chrome and packs them, one full-bleed image per ' +
        'slide, into a .pptx. This preserves your visual design exactly (the slides are images, ' +
        'so they are NOT text-editable in PowerPoint). No PowerPoint install is needed; it works ' +
        'on macOS, Windows and Linux.\n\n' +
        'HTML CONTRACT: each slide = <section class="slide">…</section>; every .slide should be ' +
        'the same fixed size as the render viewport so it fills the PPTX slide edge-to-edge. ' +
        'Do not let one slide flow into another: use a clear slide boundary, fixed dimensions, ' +
        'box-sizing:border-box, overflow:hidden, and keep all content inside that one canvas. ' +
        'Avoid content taller than one slide because the PPT image intentionally captures exactly ' +
        'one viewport. Do NOT write slides like a report page with content stacked only in the top area and empty space below. ' +
        'Instead, deliberately compose the whole slide canvas: use 2-column or 3-zone layouts, cards, sidebars, visual anchors, ' +
        'and bottom-aligned supporting blocks so the main content typically occupies roughly 70-90% of the slide height. ' +
        'Write action-title takeaways, one idea per slide. For Korean/CJK text use ' +
        'word-break: keep-all so lines wrap at word boundaries (the tool also applies this by default).\n\n' +
        'TEMPLATE MATCHING: if the user provides a sample PPT/PPTX deck (e.g. @sample.pptx) to match its style, DO NOT rely on reading it as text — a text read ' +
        'cannot convey the visual design. Instead FIRST call this tool with ONLY `template_path` set to the sample deck (and no `html`/`html_path`). The tool ' +
        'renders the sample’s slides to images, analyzes them with the vision model, and returns a concrete VISUAL STYLE GUIDE (palette, typography, layout grid, ' +
        'header/footer, recurring cards/charts/icons, density). THEN author the HTML deck so it closely follows that style guide, and call this tool again with that ' +
        'HTML. If no sample deck is given, just author a strong generic deck as usual.\n\n' +
        'The .pptx is saved (default under <workspace>/openrnd-ppt/) and opened, and the original ' +
        'HTML is saved next to it (same name, .html) — both paths are reported so the user can ' +
        're-edit the HTML and regenerate.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          html: {
            type: 'string',
            description:
              'The full HTML of the deck. Author each slide as one element matching ' +
              'slide_selector (default class "slide"), sized to the render viewport (16:9 ⇒ ' +
              '1280×720 px). Use inline CSS/SVG for infographics, KPI cards, charts, icons, and ' +
              'fill the full slide canvas rather than stacking content only at the top. ' +
              'Provide this OR html_path.',
          },
          html_path: {
            type: 'string',
            description:
              'Path to an existing self-contained HTML deck file (relative paths resolve ' +
              'against the workspace). Provide this OR html.',
          },
          slide_selector: {
            type: 'string',
            description:
              'CSS selector for each slide element. Default ".slide". If nothing matches, the ' +
              'whole page is rendered as a single slide.',
          },
          aspect: {
            type: 'string',
            enum: ['16:9', '4:3'],
            description: "Deck aspect ratio. Default '16:9'.",
          },
          width_px: {
            type: 'number',
            description:
              'Advanced: override the render width in CSS pixels (use with height_px).',
          },
          height_px: {
            type: 'number',
            description:
              'Advanced: override the render height in CSS pixels (use with width_px).',
          },
          output_path: {
            type: 'string',
            description:
              'Output .pptx path. Relative paths resolve against the workspace. Default: ' +
              '<workspace>/openrnd-ppt/<name>-<timestamp>.pptx.',
          },
          open: {
            type: 'boolean',
            description: 'Open the generated deck when done. Default true.',
          },
          timeout_seconds: {
            type: 'number',
            description:
              'Max seconds for the whole render+pack. Default 180, max 600.',
          },
          template_path: {
            type: 'string',
            description:
              'Path to a sample PPT/PPTX deck to match its visual style. Pass this ' +
              'ALONE (no html/html_path) to run analysis mode: the tool renders the ' +
              'sample slides and returns a visual style guide to author HTML against. ' +
              'Relative paths resolve against the workspace. Requires a configured ' +
              'vision model and (for rendering) Windows + PowerPoint.',
          },
        },
        required: [],
      },
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: CreatePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<CreatePptxParams, ToolResult> {
    return new CreatePptxInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
