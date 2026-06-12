/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Marked } from 'marked';
import open from 'open';
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

export const VISUALIZE_ANALYSIS_TOOL_NAME = 'visualize_analysis';
export const VISUALIZE_ANALYSIS_DISPLAY_NAME = 'Visualize Analysis';

/** Default subdirectory (under the target dir) for generated reports. */
const DEFAULT_OUTPUT_DIR = 'openwork-analysis';

export interface VisualizeAnalysisParams {
  /** Report title shown in the page header and used to name the file. */
  title: string;
  /**
   * The analysis written as Markdown. Embed Mermaid diagrams in fenced
   * ```mermaid blocks (flowchart / sequenceDiagram / classDiagram / etc.) to
   * visualize business flows. Write for a non-developer business audience.
   */
  content: string;
  /**
   * Optional output path for the .html file (absolute, or relative to the
   * workspace). Defaults to `<targetDir>/openwork-analysis/<slug>-<ts>.html`.
   */
  output_path?: string;
  /** Open the generated file in the default browser. Default: true. */
  open?: boolean;
}

/** Escapes a string for safe inclusion in HTML text/attribute context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turns a title into a filesystem-safe slug. */
function slugify(title: string): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    // keep word chars (incl. unicode letters like Hangul), collapse the rest to '-'
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'analysis';
}

/** Compact local timestamp, e.g. 20260604-231500. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Renders the Markdown body to HTML. Fenced ```mermaid blocks are converted to
 * `<pre class="mermaid">` so the client-side Mermaid runtime can draw them; if
 * Mermaid fails to load (e.g. offline), the raw diagram source remains visible
 * as preformatted text — a graceful degradation rather than a blank box.
 */
function renderMarkdown(content: string): string {
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      code({ text, lang }): string | false {
        if ((lang ?? '').trim().toLowerCase() === 'mermaid') {
          return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
        }
        return false; // fall back to marked's default code rendering
      },
    },
  });
  return md.parse(content, { async: false });
}

/**
 * Builds the <script> that loads and runs Mermaid.
 *
 * Offline-friendly: if `localMermaidJs` is provided (the contents of a local
 * mermaid UMD build, pointed to by OPENWORK_MERMAID_JS) it is inlined so no
 * network is needed. Otherwise it loads the ESM build from a CDN (overridable
 * via OPENWORK_MERMAID_URL). When neither is reachable, the diagram source still
 * shows as text (see renderMarkdown).
 */
function buildMermaidLoader(localMermaidJs: string | undefined): string {
  if (localMermaidJs) {
    return `<script>${localMermaidJs}</script>
<script>
  try {
    window.mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: 'neutral' });
  } catch (e) { console.error('mermaid init failed', e); }
</script>`;
  }
  const url =
    process.env['OPENWORK_MERMAID_URL'] ||
    'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  return `<script type="module">
  try {
    const { default: mermaid } = await import('${url}');
    mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: 'neutral' });
    await mermaid.run();
  } catch (e) {
    console.error('Mermaid could not be loaded (offline?). Diagram source is shown as text.', e);
  }
</script>`;
}

/** Wraps rendered body HTML in a self-contained, styled, printable document. */
function buildHtmlDocument(
  title: string,
  bodyHtml: string,
  mermaidLoader: string,
): string {
  const safeTitle = escapeHtml(title);
  const generatedAt = new Date().toLocaleString();
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic",
      "Apple SD Gothic Neo", Roboto, sans-serif;
    line-height: 1.7; margin: 0; color: #1f2328; background: #f6f8fa;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 24px 80px; }
  header.report { border-bottom: 2px solid #d0d7de; margin-bottom: 28px; padding-bottom: 16px; }
  header.report h1 { margin: 0 0 6px; font-size: 1.9rem; }
  header.report .meta { color: #656d76; font-size: .85rem; }
  main { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 28px 32px; }
  h1, h2, h3 { line-height: 1.3; }
  main h2 { margin-top: 1.8em; padding-bottom: .3em; border-bottom: 1px solid #eaecef; }
  main h3 { margin-top: 1.5em; }
  code { background: #eff1f3; padding: .15em .4em; border-radius: 5px; font-size: .9em;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  pre { background: #1f2328; color: #e6edf3; padding: 14px 16px; border-radius: 8px; overflow:auto; }
  pre code { background: none; padding: 0; color: inherit; }
  pre.mermaid { background: #fbfdff; color: #1f2328; border: 1px dashed #c4d0dd; text-align: center; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  th { background: #f6f8fa; }
  blockquote { margin: 1em 0; padding: .4em 1em; color: #57606a; border-left: 4px solid #d0d7de; background:#f6f8fa; }
  a { color: #0969da; }
  footer { margin-top: 36px; color: #8b949e; font-size: .8rem; text-align: center; }
  @media print {
    body { background: #fff; } main { border: none; padding: 0; }
    .wrap { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="report">
    <h1>${safeTitle}</h1>
    <div class="meta">openwork 소스코드 분석 · 생성: ${escapeHtml(generatedAt)}</div>
  </header>
  <main>
${bodyHtml}
  </main>
  <footer>Generated by openwork · visualize_analysis</footer>
</div>
${mermaidLoader}
</body>
</html>
`;
}

class VisualizeAnalysisInvocation extends BaseToolInvocation<
  VisualizeAnalysisParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: VisualizeAnalysisParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `Visualize analysis "${this.params.title}" as an HTML report`;
  }

  /** Resolves the output .html path, defaulting under <targetDir>/openwork-analysis/. */
  private resolveOutputPath(): string {
    const { output_path, title } = this.params;
    if (output_path && output_path.trim()) {
      let p = output_path.trim();
      if (
        !p.toLowerCase().endsWith('.html') &&
        !p.toLowerCase().endsWith('.htm')
      ) {
        p = `${p}.html`;
      }
      return path.isAbsolute(p)
        ? path.resolve(p)
        : path.resolve(this.config.getTargetDir(), p);
    }
    const fileName = `${slugify(title)}-${timestamp()}.html`;
    return path.resolve(
      this.config.getTargetDir(),
      DEFAULT_OUTPUT_DIR,
      fileName,
    );
  }

  async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const { title, content } = this.params;

    if (!title?.trim() || !content?.trim()) {
      const msg = "'title' and 'content' are required and must be non-empty.";
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    const outPath = this.resolveOutputPath();

    // Keep generated files inside the workspace.
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

    try {
      // Optional local Mermaid build for fully-offline corporate networks.
      let localMermaidJs: string | undefined;
      const localMermaidPath = process.env['OPENWORK_MERMAID_JS'];
      if (localMermaidPath) {
        try {
          localMermaidJs = await fs.readFile(localMermaidPath, 'utf8');
        } catch (e) {
          debugLogger.warn(
            `[visualize_analysis] Could not read OPENWORK_MERMAID_JS (${localMermaidPath}): ${getErrorMessage(e)}. Falling back to CDN.`,
          );
        }
      }

      const bodyHtml = renderMarkdown(content);
      const html = buildHtmlDocument(
        title,
        bodyHtml,
        buildMermaidLoader(localMermaidJs),
      );

      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, html, 'utf8');

      let opened = false;
      let openError: string | undefined;
      if (this.params.open !== false) {
        try {
          await open(outPath);
          opened = true;
        } catch (e) {
          openError = getErrorMessage(e);
          debugLogger.warn(
            `[visualize_analysis] Failed to open ${outPath}: ${openError}`,
          );
        }
      }

      const fileUrl = `file://${outPath.replace(/\\/g, '/')}`;
      const note = opened
        ? 'The report was opened in your default browser.'
        : this.params.open === false
          ? 'The report was not opened (open=false).'
          : `Could not auto-open the report (${openError}). Open it manually.`;

      return {
        llmContent:
          `Visualization written to: ${outPath}\n` + `URL: ${fileUrl}\n${note}`,
        returnDisplay: `📊 분석 시각화 생성 완료\n\n- 파일: \`${outPath}\`\n- ${note}`,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error creating visualization: ${msg}`,
        returnDisplay: `Error creating visualization: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

/**
 * Built-in tool that turns a Markdown + Mermaid analysis into a styled,
 * self-contained HTML report and opens it in the browser. Markdown is rendered
 * server-side (no network needed); Mermaid diagrams render client-side and
 * degrade to readable source text when offline.
 */
export class VisualizeAnalysisTool extends BaseDeclarativeTool<
  VisualizeAnalysisParams,
  ToolResult
> {
  static readonly Name = VISUALIZE_ANALYSIS_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      VisualizeAnalysisTool.Name,
      VISUALIZE_ANALYSIS_DISPLAY_NAME,
      'Create a visual HTML report from a source-code / business-logic analysis and open it in ' +
        'the browser. Use this AFTER you have analyzed the code (e.g. Java source) whenever the ' +
        'user asks to visualize, diagram, or make the analysis easy to understand — Korean ' +
        'triggers include 시각화(해줘), 분석 후 시각화, 다이어그램(으로), 흐름도/플로우차트, ' +
        '비즈니스 로직 정리/도식화. The audience knows the business but NOT Java, so explain the ' +
        'business logic in plain language. Pass the analysis as Markdown in "content"; embed ' +
        'Mermaid diagrams in fenced ```mermaid blocks (flowchart for process/business flows, ' +
        'sequenceDiagram for call/interaction order, classDiagram for domain models/structure) ' +
        'to make flows clear without reading code. The tool renders Markdown to a styled, ' +
        'self-contained HTML file, saves it (default under <workspace>/openwork-analysis/), and ' +
        'opens it in the default browser.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Report title (shown in the header and used to name the file).',
          },
          content: {
            type: 'string',
            description:
              'The analysis as Markdown, written for a non-developer business audience. ' +
              'Embed Mermaid diagrams in fenced ```mermaid code blocks (flowchart / ' +
              'sequenceDiagram / classDiagram, etc.) to visualize business flows, call ' +
              'sequences, and domain structure. Use headings, tables, and lists to organize.',
          },
          output_path: {
            type: 'string',
            description:
              'Optional .html output path (absolute or relative to the workspace). ' +
              'Defaults to <workspace>/openwork-analysis/<slug>-<timestamp>.html.',
          },
          open: {
            type: 'boolean',
            description:
              'Whether to open the generated report in the default browser. Default: true.',
          },
        },
        required: ['title', 'content'],
      },
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: VisualizeAnalysisParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<VisualizeAnalysisParams, ToolResult> {
    return new VisualizeAnalysisInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
