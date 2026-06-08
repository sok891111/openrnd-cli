/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { PPTX_REGION_HELPERS } from './pptx-region-helpers.js';

export const ANALYZE_PPTX_TOOL_NAME = 'analyze_pptx_template';
export const ANALYZE_PPTX_DISPLAY_NAME = 'Analyze PowerPoint Template';

/** PowerPoint launch + open can be slow; allow a generous default. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface AnalyzePptxParams {
  /** Reference deck (.ppt/.pptx) to analyze. DRM-protected in-house files are
   * supported because they are opened through PowerPoint (win32com). */
  sample_path: string;
  /** Max analysis time in seconds (default 120, max 600). */
  timeout_seconds?: number;
}

function detectPythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Python helper that opens a deck through the installed PowerPoint application
 * (win32com, the DRM-allowed path) and emits a per-slide structural description:
 * for each slide, the fillable text regions (with the SAME structural-path ids
 * the build tool uses), their guessed role, bounding box, current text, and
 * shape-kind flags. The model reads this to choose which slide to reuse and to
 * map new content to specific regions. Reads the sample path from argv[1];
 * prints one JSON object to stdout on success; diagnostics go to stderr.
 */
const PPTX_ANALYZE_SCRIPT =
  String.raw`# -*- coding: utf-8 -*-
import os
import sys
import json


def _utf8():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def ensure_pywin32():
    try:
        import win32com.client  # noqa: F401
        return True
    except ImportError:
        pass
    import subprocess
    sys.stderr.write("PYWIN32_MISSING: installing pywin32 with %s\n" % sys.executable)
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "pywin32"]
        )
    except Exception as exc:
        sys.stderr.write("PYWIN32_AUTO_INSTALL_FAILED: %s\n" % exc)
        return False
    try:
        import win32com.client  # noqa: F401
        return True
    except ImportError as exc:
        sys.stderr.write("PYWIN32_STILL_MISSING: %s\n" % exc)
        return False


WARN = []


def warn(msg):
    WARN.append(str(msg))


# PowerPoint enums used for role guessing.
ppPlaceholderTitle = 13
ppPlaceholderCenterTitle = 12
ppPlaceholderSubtitle = 4
ppPlaceholderBody = 2
msoPicture = 13
msoChart = 3

` +
  PPTX_REGION_HELPERS +
  String.raw`

def _bbox(shp, sw, sh):
    try:
        return {
            "left": round(float(shp.Left) / sw, 3),
            "top": round(float(shp.Top) / sh, 3),
            "width": round(float(shp.Width) / sw, 3),
            "height": round(float(shp.Height) / sh, 3),
        }
    except Exception:
        return None


def _title_id(slide):
    try:
        t = slide.Shapes.Title
        if t is not None:
            return t.Id
    except Exception:
        pass
    return None


def _role(slide, shp, kind, title_id, sh):
    if kind == "table_cell":
        return "table_cell"
    try:
        if title_id is not None and shp.Id == title_id:
            return "title"
    except Exception:
        pass
    try:
        ptype = shp.PlaceholderFormat.Type
        if ptype in (ppPlaceholderTitle, ppPlaceholderCenterTitle):
            return "title"
        if ptype == ppPlaceholderSubtitle:
            return "subtitle"
        if ptype == ppPlaceholderBody:
            return "body"
    except Exception:
        pass
    # Heuristic by vertical position.
    try:
        top_frac = float(shp.Top) / sh
    except Exception:
        top_frac = 0.5
    if top_frac >= 0.88:
        return "footer"
    if top_frac <= 0.10:
        return "title"
    return "body"


def _snippet(text, limit=120):
    t = (text or "").replace("\r", " ").replace("\n", " ").strip()
    if len(t) > limit:
        t = t[: limit - 1] + "…"
    return t


def _flags(slide):
    has_table = has_pic = has_chart = has_smartart = False
    try:
        for shp in slide.Shapes:
            try:
                if shp.HasTable:
                    has_table = True
            except Exception:
                pass
            try:
                if shp.Type == msoPicture:
                    has_pic = True
            except Exception:
                pass
            try:
                if shp.Type == msoChart or shp.HasChart:
                    has_chart = True
            except Exception:
                pass
            try:
                if shp.HasSmartArt:
                    has_smartart = True
            except Exception:
                pass
    except Exception:
        pass
    return has_table, has_pic, has_chart, has_smartart


def _layout_name(slide):
    try:
        return slide.CustomLayout.Name or ""
    except Exception:
        return ""


def analyze_slide(slide, idx, sw, sh):
    title_id = _title_id(slide)
    regions = []
    for rid, shp, kind in iter_text_regions(slide):
        role = _role(slide, shp, kind, title_id, sh)
        txt = region_text(shp)
        n_lines = len([x for x in (txt or "").split("\r") if x.strip()])
        regions.append({
            "id": rid,
            "role": role,
            "kind": kind,
            "bbox": _bbox(shp, sw, sh),
            "sample_text": _snippet(txt),
            "is_bulleted": n_lines > 1,
        })
    has_table, has_pic, has_chart, has_smartart = _flags(slide)
    # Compact human summary to help the model pick a slide.
    n_title = sum(1 for r in regions if r["role"] == "title")
    n_body = sum(1 for r in regions if r["role"] == "body")
    bits = ["%d개 텍스트영역" % len(regions)]
    if n_title:
        bits.append("제목")
    if n_body:
        bits.append("본문 %d" % n_body)
    if has_table:
        bits.append("표")
    if has_pic:
        bits.append("이미지")
    if has_chart:
        bits.append("차트")
    if has_smartart:
        bits.append("SmartArt")
    summary = ", ".join(bits)
    return {
        "index": idx,
        "layout_name": _layout_name(slide),
        "summary": summary,
        "has_table": has_table,
        "has_picture": has_pic,
        "has_chart": has_chart,
        "has_smartart": has_smartart,
        "regions": regions,
    }


def main():
    _utf8()
    if len(sys.argv) < 2:
        sys.stderr.write("USAGE: analyze.py <sample.pptx>\n")
        return 2
    sample = os.path.abspath(sys.argv[1])

    if not ensure_pywin32():
        sys.stderr.write("WIN32COM_IMPORT_ERROR: pywin32 required.\n")
        return 4
    import win32com.client
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass

    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    pres = None
    slides_out = []
    try:
        pres = ppt.Presentations.Open(sample, ReadOnly=True, WithWindow=False)
        try:
            sw = float(pres.PageSetup.SlideWidth)
            sh = float(pres.PageSetup.SlideHeight)
        except Exception:
            sw, sh = 960.0, 540.0
        count = pres.Slides.Count
        for i in range(1, count + 1):
            try:
                slides_out.append(analyze_slide(pres.Slides.Item(i), i, sw, sh))
            except Exception as exc:
                warn("slide %d: %s" % (i, exc))
                slides_out.append({"index": i, "layout_name": "", "summary": "분석 실패", "regions": []})
        pres.Close()
    except Exception as exc:
        sys.stderr.write("PPTX_ANALYZE_ERROR: %s\n" % exc)
        try:
            if pres is not None:
                pres.Close()
        except Exception:
            pass
        try:
            ppt.Quit()
        except Exception:
            pass
        return 5
    finally:
        try:
            ppt.Quit()
        except Exception:
            pass

    print(json.dumps({
        "sample_path": sample,
        "slide_count": len(slides_out),
        "slides": slides_out,
        "warnings": WARN,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

class AnalyzePptxInvocation extends BaseToolInvocation<
  AnalyzePptxParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: AnalyzePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `Analyze PowerPoint template (${this.params.sample_path})`;
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const sp = this.params.sample_path?.trim();
    if (!sp) {
      const msg = "'sample_path' is required.";
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // Reading slide geometry/shapes requires driving PowerPoint via win32com →
    // Windows only (mirrors the create_pptx sample path).
    if (process.platform !== 'win32') {
      const msg =
        '양식 분석은 설치된 PowerPoint를 win32com으로 구동하므로 Windows에서만 동작합니다. ' +
        `현재 플랫폼: ${process.platform}.`;
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const samplePath = path.isAbsolute(sp)
      ? path.resolve(sp)
      : path.resolve(this.config.getTargetDir(), sp);
    try {
      await fs.access(samplePath);
    } catch {
      const msg = `Sample deck not found: ${samplePath}`;
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    const timeout = Math.min(
      (this.params.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
      MAX_TIMEOUT_MS,
    );

    const tmpScript = path.join(
      os.tmpdir(),
      `openrnd_pptx_analyze_${randomUUID()}.py`,
    );

    try {
      await fs.writeFile(tmpScript, PPTX_ANALYZE_SCRIPT, 'utf-8');

      const pythonExe = detectPythonExecutable();
      let stdout = '';
      let stderr = '';
      let killed = false;

      await new Promise<void>((resolve, reject) => {
        // No shell: pass argv straight to CreateProcessW as Unicode so Korean
        // paths / file names survive (see officeReader.ts / create-pptx.ts).
        const child = spawn(pythonExe, [tmpScript, samplePath], {
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);

        const abortHandler = () => {
          killed = true;
          child.kill();
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });

        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf-8');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf-8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (err.message.includes('ENOENT')) {
            reject(
              new Error(
                `Python 실행 파일 '${pythonExe}' 을(를) 찾을 수 없습니다. ` +
                  `Python 3 와 pywin32 (pip install pywin32), 그리고 PowerPoint가 설치되어 있어야 합니다.`,
              ),
            );
          } else {
            reject(err);
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (killed) {
            reject(
              new Error(
                `양식 분석이 ${timeout / 1000}s 후 타임아웃되었거나 중단되었습니다.`,
              ),
            );
          } else if (code !== 0) {
            reject(
              new Error(
                `양식 분석 실패 (exit ${code}). ` +
                  (stderr.trim() || '진단 메시지 없음'),
              ),
            );
          } else {
            resolve();
          }
        });
      });

      const lastLine = stdout.trim().split('\n').pop() ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        const msg = `분석 결과를 해석하지 못했습니다. 출력: ${lastLine.slice(0, 200)}`;
        return {
          llmContent: `Error: ${msg}`,
          returnDisplay: `Error: ${msg}`,
          error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      let slideCount: number | undefined;
      if (parsed && typeof parsed === 'object' && 'slide_count' in parsed) {
        const v: unknown = (parsed as Record<string, unknown>)['slide_count'];
        if (typeof v === 'number') slideCount = v;
      }

      return {
        // Hand the full structured analysis back to the model so it can pick a
        // slide per content slide and map new content to specific region ids.
        llmContent:
          `PowerPoint template analysis for ${samplePath}\n` +
          'Use this to choose, per output slide, a sample slide to reuse: call create_pptx ' +
          'with sample_path set, and for each slide set mode="reuse", sample_slide_index to the ' +
          'chosen slide index, and "regions" mapping each region id to the new content. Any ' +
          'region you omit is left blank; all original text is cleared automatically.\n\n' +
          JSON.stringify(parsed),
        returnDisplay: `🔍 양식 분석 완료 — \`${samplePath}\` (슬라이드 ${slideCount ?? '?'}장)`,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error analyzing PowerPoint template: ${msg}`,
        returnDisplay: `Error analyzing PowerPoint template: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    } finally {
      await fs.rm(tmpScript, { force: true }).catch(() => {});
    }
  }
}

/**
 * Built-in tool that opens a sample PowerPoint deck through the installed
 * PowerPoint application (win32com) and returns a per-slide structural map —
 * the fillable text regions (with the same structural-path ids the build tool
 * uses), their roles, bounding boxes, and current text. Pairs with create_pptx:
 * analyze first, then clone+fill the chosen slides by region id. Windows-only.
 */
export class AnalyzePptxTool extends BaseDeclarativeTool<
  AnalyzePptxParams,
  ToolResult
> {
  static readonly Name = ANALYZE_PPTX_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      AnalyzePptxTool.Name,
      ANALYZE_PPTX_DISPLAY_NAME,
      'Analyze an existing PowerPoint deck (.ppt/.pptx) to understand its per-slide design before ' +
        'cloning it with create_pptx. Returns, for each slide: its layout name, a short summary, ' +
        'shape-kind flags (table/picture/chart/SmartArt), and the list of fillable TEXT REGIONS — ' +
        'each with a stable structural-path id (e.g. "3", "3.2", "5.r2c1"), a guessed role ' +
        '(title/subtitle/body/footer/table_cell), a bounding box (fractions of the slide), the ' +
        "region's current sample text, and whether it is a bullet list. Use this as STEP 1 when a " +
        'user provides a sample deck to match: read the regions, decide which slide to reuse for ' +
        'each output slide, then call create_pptx (STEP 2) with sample_path + per-slide ' +
        'mode="reuse" + sample_slide_index + a "regions" map (region id → new text/bullets). ' +
        'The build clears ALL original text (including inside groups, tables, and SmartArt) and ' +
        'writes your content into the regions you specify. Windows + PowerPoint only (in-house ' +
        'DRM-protected files are supported because the deck is opened through PowerPoint).',
      Kind.Other,
      {
        type: 'object',
        properties: {
          sample_path: {
            type: 'string',
            description:
              'Path (absolute or workspace-relative) to the reference .ppt/.pptx to analyze. ' +
              'DRM-protected in-house files are supported (opened through PowerPoint).',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Max analysis time in seconds (default 120, max 600).',
          },
        },
        required: ['sample_path'],
      },
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: AnalyzePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<AnalyzePptxParams, ToolResult> {
    return new AnalyzePptxInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
