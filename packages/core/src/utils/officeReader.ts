/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getVisionConfigFromEnv,
  describeImageData,
  type VisionConfig,
} from '../core/visionDescriber.js';
import { emitFeedbackAfterDelay } from './delayedFeedback.js';
import { debugLogger } from './debugLogger.js';
import { coreEvents } from './events.js';

/**
 * Document extensions that must be read through win32com COM automation.
 *
 * In-house Office files (Word/PowerPoint/Excel) and PDFs are protected by a DRM
 * policy that prevents them from being read directly off disk. Opening them
 * through the installed Office application via win32com (pywin32) is the only
 * path that the DRM agent allows, so reads for these extensions are routed
 * there. PDFs are opened with Word (PDF reflow, Word 2013+) to extract text.
 */
export const OFFICE_EXTENSIONS: readonly string[] = [
  // Word
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  // Excel
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  // PowerPoint
  '.ppt',
  '.pptx',
  '.pptm',
  // PDF (opened via Word reflow)
  '.pdf',
];

/**
 * Returns true when the file extension must be read via win32com.
 */
export function isOfficeFile(filePath: string): boolean {
  return OFFICE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export interface OfficeReadResult {
  text?: string;
  error?: string;
}

/**
 * Leading marker the in-house DRM agent prepends to protected documents when
 * they are read off disk without the Office application. A file whose content
 * starts with this marker is DRM-wrapped and must be read via win32com,
 * regardless of its extension.
 */
export const DRM_DOCUMENT_MARKER = '<DOCUMENT SAFER';

/**
 * Which installed Office app to use as a LAST RESORT when the file's extension
 * is not a recognized office type. Extension-based dispatch always takes
 * precedence over this.
 */
export type OfficeFallbackReader = 'word' | 'excel' | 'ppt' | 'pdf';

/** Timeout for the win32com extraction process (Office launch can be slow). */
const OFFICE_READ_TIMEOUT_MS = 120_000;

function detectPythonExecutable(): string {
  // win32com (pywin32) only exists on Windows. On other platforms we still
  // attempt python3 so the caller surfaces a clear ImportError message.
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Python helper that opens the document through the installed Office
 * application (Word / Excel / PowerPoint) using win32com and prints the
 * extracted plain text to stdout (UTF-8). Diagnostics go to stderr.
 */
const WIN32COM_EXTRACT_SCRIPT = String.raw`# -*- coding: utf-8 -*-
import os
import sys

def _reconfigure_utf8():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

def ensure_pywin32():
    """Make sure pywin32 is importable, auto-installing it with THIS
    interpreter if needed so users never have to pip install separately."""
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

def read_word(path):
    import win32com.client
    word = win32com.client.DispatchEx("Word.Application")
    word.Visible = False
    try:
        word.DisplayAlerts = False
    except Exception:
        pass
    try:
        doc = word.Documents.Open(
            path,
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
        )
        try:
            return doc.Content.Text
        finally:
            doc.Close(False)
    finally:
        word.Quit()

def read_pdf(path):
    # Word 2013+ reflows a PDF into an editable document on open, which lets us
    # extract its text through the same COM path the DRM agent already allows.
    import win32com.client
    word = win32com.client.DispatchEx("Word.Application")
    word.Visible = False
    try:
        word.DisplayAlerts = False  # suppress the "convert PDF" prompt
    except Exception:
        pass
    try:
        doc = word.Documents.Open(
            path,
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
            Format=0,  # wdOpenFormatAuto -> triggers PDF reflow
        )
        try:
            return doc.Content.Text
        finally:
            doc.Close(False)
    finally:
        word.Quit()

def read_excel(path):
    import win32com.client
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    try:
        excel.DisplayAlerts = False
    except Exception:
        pass
    parts = []
    try:
        wb = excel.Workbooks.Open(path, ReadOnly=True, UpdateLinks=0)
        try:
            for sheet in wb.Worksheets:
                parts.append("# Sheet: %s" % sheet.Name)
                used = sheet.UsedRange
                values = used.Value
                if values is None:
                    continue
                if not isinstance(values, tuple):
                    parts.append("" if values is None else str(values))
                    continue
                for row in values:
                    if isinstance(row, tuple):
                        cells = ["" if c is None else str(c) for c in row]
                    else:
                        cells = ["" if row is None else str(row)]
                    parts.append("\t".join(cells))
        finally:
            wb.Close(False)
    finally:
        excel.Quit()
    return "\n".join(parts)

# msoGroup=6, msoPicture=13, msoLinkedPicture=11, ppShapeFormatPNG=2
_MSO_GROUP = 6
_PICTURE_TYPES = (11, 13)

def _iter_shapes(shapes):
    """Yield every shape, recursing into groups so pictures/tables nested in a
    grouped shape are not missed. The group container itself is yielded too, but
    it matches none of the text/table/picture checks and is harmlessly skipped."""
    for shape in shapes:
        yield shape
        try:
            if shape.Type == _MSO_GROUP:
                for child in _iter_shapes(shape.GroupItems):
                    yield child
        except Exception:
            pass

def _read_table(shape):
    """Extract a PowerPoint table as tab-separated rows."""
    rows = []
    try:
        table = shape.Table
        for row in table.Rows:
            cells = []
            for cell in row.Cells:
                try:
                    cells.append(cell.Shape.TextFrame.TextRange.Text)
                except Exception:
                    cells.append("")
            rows.append("\t".join(cells))
    except Exception:
        pass
    return rows

def read_ppt(path, image_dir=None):
    import win32com.client
    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    parts = []
    image_index = 0
    try:
        # PowerPoint cannot run fully hidden; WithWindow=False keeps it offscreen.
        pres = ppt.Presentations.Open(path, ReadOnly=True, WithWindow=False)
        try:
            for idx, slide in enumerate(pres.Slides, start=1):
                parts.append("# Slide %d" % idx)
                for shape in _iter_shapes(slide.Shapes):
                    # Tables: HasTextFrame is false, so handle them first.
                    try:
                        if shape.HasTable:
                            parts.append("[Table]")
                            parts.extend(_read_table(shape))
                            continue
                    except Exception:
                        pass
                    try:
                        if shape.HasTextFrame and shape.TextFrame.HasText:
                            parts.append(shape.TextFrame.TextRange.Text)
                            continue
                    except Exception:
                        pass
                    # Pictures: only exported when an image dir is provided, which
                    # the caller does only when a vision model is configured.
                    if image_dir:
                        try:
                            if shape.Type in _PICTURE_TYPES:
                                image_index += 1
                                fname = "img_%d_%d.png" % (idx, image_index)
                                shape.Export(os.path.join(image_dir, fname), 2)
                                parts.append("[[OFFICE_IMAGE:%s]]" % fname)
                        except Exception:
                            pass
        finally:
            pres.Close()
    finally:
        ppt.Quit()
    return "\n".join(parts)

def main():
    _reconfigure_utf8()
    if len(sys.argv) < 2:
        sys.stderr.write("MISSING_PATH_ARG\n")
        return 2
    path = os.path.abspath(sys.argv[1])
    forced = (sys.argv[2].strip().lower() if len(sys.argv) > 2 else "")
    ext = os.path.splitext(path)[1].lower()
    # Set only when the caller (vision configured) wants embedded pictures
    # exported for downstream description; empty/unset disables image export.
    image_dir = os.environ.get("OPENWORK_OFFICE_IMAGE_DIR") or None
    if not ensure_pywin32():
        sys.stderr.write(
            "WIN32COM_IMPORT_ERROR: pywin32 is required and could not be "
            "auto-installed (pip install pywin32).\n"
        )
        return 4
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass
    try:
        # Extension-based dispatch takes precedence; the optional fallback
        # reader (argv[2]) is only used when the extension is unrecognized
        # (e.g. a DRM-marked file with a non-office extension).
        if ext in (".doc", ".docx", ".docm", ".dot", ".dotx"):
            text = read_word(path)
        elif ext == ".pdf":
            text = read_pdf(path)
        elif ext in (".xls", ".xlsx", ".xlsm", ".xlsb"):
            text = read_excel(path)
        elif ext in (".ppt", ".pptx", ".pptm"):
            text = read_ppt(path, image_dir)
        elif forced == "word":
            text = read_word(path)
        elif forced == "pdf":
            text = read_pdf(path)
        elif forced == "excel":
            text = read_excel(path)
        elif forced == "ppt":
            text = read_ppt(path, image_dir)
        else:
            sys.stderr.write("UNSUPPORTED_OFFICE_EXT:%s\n" % ext)
            return 3
    except ImportError as exc:
        sys.stderr.write(
            "WIN32COM_IMPORT_ERROR: pywin32 is required (pip install pywin32). %s\n"
            % exc
        )
        return 4
    except Exception as exc:
        sys.stderr.write("WIN32COM_READ_ERROR: %s\n" % exc)
        return 5
    sys.stdout.write(text if text is not None else "")
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

/** PowerPoint extensions, the only readers that export embedded pictures. */
const PPT_EXTENSIONS: readonly string[] = ['.ppt', '.pptx', '.pptm'];

/**
 * Marker the win32com PPT reader emits in place of each embedded picture it
 * exports: `[[OFFICE_IMAGE:<filename>]]`, where filename lives in the image dir.
 */
const OFFICE_IMAGE_MARKER = /\[\[OFFICE_IMAGE:([^\]]+)\]\]/g;
const OFFICE_VISION_PROGRESS_FEEDBACK_DELAY_MS = 2_000;

/**
 * Image-heavy decks describe one image at a time through the (slow) in-house
 * vision model, so a single read can take minutes. Above this many *distinct*
 * images we auto-skip vision and return text only, leaving a per-image note so
 * the model can re-read with images forced if the user actually needs them.
 * Default 15; override with OPENWORK_OFFICE_VISION_MAX_IMAGES (0 disables the
 * cap entirely).
 */
const DEFAULT_OFFICE_VISION_MAX_IMAGES = 15;

function officeVisionMaxImages(): number {
  const raw = process.env['OPENWORK_OFFICE_VISION_MAX_IMAGES'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OFFICE_VISION_MAX_IMAGES;
  }
  const parsed = Number(raw);
  // 0 disables the cap; ignore negative/NaN and fall back to the default.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_OFFICE_VISION_MAX_IMAGES;
  }
  return Math.floor(parsed);
}

function mimeTypeForImage(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/**
 * Replace each `[[OFFICE_IMAGE:...]]` marker in the extracted text with a
 * vision-model description of the corresponding exported picture. Context for
 * each image is the slide it sits on (the nearest preceding `# Slide N` header).
 * A per-image failure leaves a short note instead of hard-failing the read.
 */
async function describeOfficeImages(
  text: string,
  imageDir: string,
  config: VisionConfig,
): Promise<string> {
  const markers = [...text.matchAll(OFFICE_IMAGE_MARKER)];
  if (markers.length === 0) return text;

  // Auto-skip vision when the deck carries too many images: describing them one
  // by one through the in-house vision model is too slow to be worth blocking
  // the read on. Replace each marker with a short note so the model can ask to
  // include images (forcing a full re-read) if they actually matter.
  const maxImages = officeVisionMaxImages();
  const uniqueImages = new Set(markers.map((m) => m[1])).size;
  if (maxImages > 0 && uniqueImages > maxImages) {
    debugLogger.debug(
      `[Vision] Skipping vision for slide deck: ${uniqueImages} images exceed the cap of ${maxImages}.`,
    );
    coreEvents.emitFeedback(
      'info',
      `[Vision] 이미지 ${uniqueImages}개가 많아 분석을 건너뛰고 텍스트만 읽었습니다 ` +
        `(임계값 ${maxImages}). 이미지 분석이 필요하면 "이미지도 포함해서" 다시 요청하세요.`,
    );
    return text.replace(
      OFFICE_IMAGE_MARKER,
      (_whole, fileName: string) =>
        `[Image "${fileName}" — vision skipped: deck has ${uniqueImages} images ` +
        `(> ${maxImages}). Ask to include images to force analysis.]`,
    );
  }

  debugLogger.debug(
    `[Vision] Describing ${markers.length} image(s) from the slide deck with ${config.model}...`,
  );
  const progressFeedback = emitFeedbackAfterDelay(
    'info',
    `[Vision] PowerPoint 이미지 ${markers.length}개를 분석 중입니다 (${config.model}). 잠시만 기다려 주세요...`,
    OFFICE_VISION_PROGRESS_FEEDBACK_DELAY_MS,
  );

  try {
    // Build replacements first, then splice them in, so indices stay stable.
    // Describe images sequentially so the vision endpoint isn't flooded with
    // potentially large concurrent requests.
    const replacements = new Map<string, string>();
    let describedCount = 0;
    const uniqueCount = new Set(markers.map((m) => m[1])).size;
    for (const match of markers) {
      const fileName = match[1];
      if (replacements.has(fileName)) continue;

      describedCount += 1;
      debugLogger.debug(
        `[Vision] (${describedCount}/${uniqueCount}) Describing "${fileName}"...`,
      );

      // Slide context: text from the start of this slide up to the marker.
      const slideStart = text.lastIndexOf('# Slide', match.index);
      const contextText = text
        .slice(slideStart === -1 ? 0 : slideStart, match.index)
        .replace(OFFICE_IMAGE_MARKER, '')
        .trim();

      try {
        const data = await fs.readFile(path.join(imageDir, fileName));
        const description = await describeImageData(
          config,
          [
            {
              data: data.toString('base64'),
              mimeType: mimeTypeForImage(fileName),
            },
          ],
          contextText,
        );
        replacements.set(
          fileName,
          `[Image "${fileName}" described by vision model "${config.model}"]\n${description}`,
        );
      } catch (err) {
        debugLogger.debug(
          `[Vision] Could not describe "${fileName}": ${String(err)}`,
        );
        replacements.set(
          fileName,
          `[Image "${fileName}" could not be described: ${String(err)}]`,
        );
      }
    }

    return text.replace(
      OFFICE_IMAGE_MARKER,
      (whole, fileName: string) => replacements.get(fileName) ?? whole,
    );
  } finally {
    progressFeedback.cancel();
  }
}

interface PythonRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Spawns a Python helper script (no shell) and collects its stdout/stderr.
 *
 * IMPORTANT: do NOT spawn through a shell. On Windows `shell: true` runs
 * `cmd.exe /d /s /c "..."`, and cmd.exe re-encodes the command line through the
 * console's OEM code page (e.g. CP437/949). Any character not representable
 * there -- e.g. a Korean file name like "한글.xlsx", even with no spaces -- is
 * replaced with "?", so win32com receives a corrupted path and reports "file
 * not found". It also splits unquoted paths on spaces. Spawning without a shell
 * passes the argv array straight to CreateProcessW as Unicode (libuv does the
 * quoting), preserving both Unicode characters and spaces. libuv still resolves
 * `python` on PATH via PATHEXT, so we don't need the shell to find it.
 */
function runPythonScript(
  pythonExe: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<PythonRunResult> {
  return new Promise<PythonRunResult>((resolve, reject) => {
    const child = spawn(pythonExe, args, {
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...extraEnv,
      },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, OFFICE_READ_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf-8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf-8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `win32com 처리가 ${OFFICE_READ_TIMEOUT_MS / 1000}s 후 타임아웃되었습니다.`,
          ),
        );
        return;
      }
      resolve({ stdout: out, stderr: err, code: c });
    });
  });
}

/**
 * Extracts plain text from an in-house Office document using win32com.
 *
 * Always goes through the Office COM automation path so DRM-protected files can
 * be read; never falls back to reading bytes off disk.
 */
export async function readOfficeFile(
  filePath: string,
  options?: { fallbackReader?: OfficeFallbackReader; disableVision?: boolean },
): Promise<OfficeReadResult> {
  if (process.platform !== 'win32') {
    const error =
      'win32com 기반 Office 읽기는 Windows에서만 지원됩니다. ' +
      '현재 플랫폼: ' +
      process.platform;
    return { error };
  }

  const pythonExe = detectPythonExecutable();
  const tmpScript = path.join(
    os.tmpdir(),
    `openwork_office_${randomUUID()}.py`,
  );

  // Embedded-picture description only runs for PowerPoint, and only when a
  // vision model is configured. When it is, hand the win32com reader a temp dir
  // to export pictures into; otherwise images are ignored (previous behavior).
  const ext = path.extname(filePath).toLowerCase();
  const isPpt =
    PPT_EXTENSIONS.includes(ext) || options?.fallbackReader === 'ppt';
  // Oversized documents skip vision image description (text-only) to keep the
  // read responsive — see disableVision handling in processSingleFileContent.
  const visionConfig =
    isPpt && !options?.disableVision ? getVisionConfigFromEnv() : undefined;
  let imageDir: string | undefined;

  try {
    if (visionConfig) {
      imageDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'openwork_office_img_'),
      );
    }
    await fs.writeFile(tmpScript, WIN32COM_EXTRACT_SCRIPT, 'utf-8');

    const spawnArgs = options?.fallbackReader
      ? [tmpScript, filePath, options.fallbackReader]
      : [tmpScript, filePath];
    const { stdout, stderr, code } = await runPythonScript(
      pythonExe,
      spawnArgs,
      imageDir ? { OPENWORK_OFFICE_IMAGE_DIR: imageDir } : undefined,
    );

    if (code !== 0) {
      const error =
        `win32com Office 읽기 실패 (exit ${code}). ` +
        (stderr.trim() || '진단 메시지 없음');
      return { error };
    }

    if (visionConfig && imageDir) {
      return {
        text: await describeOfficeImages(stdout, imageDir, visionConfig),
      };
    }
    return { text: stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const error =
      message.includes('ENOENT') || message.includes('not found')
        ? `Python 실행 파일 '${pythonExe}' 을(를) 찾을 수 없습니다. ` +
          `Python 3 와 pywin32 (pip install pywin32) 가 설치되어 있어야 합니다.`
        : `win32com Office 읽기 중 오류: ${message}`;
    return { error };
  } finally {
    await fs.rm(tmpScript, { force: true }).catch(() => {});
    if (imageDir) {
      await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export interface PptxRenderResult {
  /** Absolute PNG paths, one per exported slide, in slide order. */
  imagePaths?: string[];
  error?: string;
}

/**
 * Python helper that renders each slide of a PowerPoint deck to a PNG using the
 * installed PowerPoint app (the only path the DRM agent allows). Prints one
 * absolute PNG path per line to stdout. Used to capture a sample deck's *visual*
 * design for template matching, which plain text extraction cannot convey.
 */
const WIN32COM_RENDER_PPT_SCRIPT = String.raw`# -*- coding: utf-8 -*-
import os
import sys

def _reconfigure_utf8():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
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

def main():
    _reconfigure_utf8()
    if len(sys.argv) < 3:
        sys.stderr.write("MISSING_ARGS\n")
        return 2
    path = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])
    try:
        width = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
        height = int(sys.argv[4]) if len(sys.argv) > 4 else 720
    except Exception:
        width, height = 1280, 720
    try:
        max_slides = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    except Exception:
        max_slides = 0
    if not ensure_pywin32():
        sys.stderr.write("WIN32COM_IMPORT_ERROR\n")
        return 4
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass
    import win32com.client
    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        pres = ppt.Presentations.Open(path, ReadOnly=True, WithWindow=False)
        try:
            count = pres.Slides.Count
            if max_slides and count > max_slides:
                count = max_slides
            for i in range(1, count + 1):
                out = os.path.join(out_dir, "slide_%d.png" % i)
                pres.Slides(i).Export(out, "PNG", width, height)
                sys.stdout.write(out + "\n")
        finally:
            pres.Close()
    finally:
        ppt.Quit()
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

/**
 * Renders a PowerPoint deck's slides to PNG images (one per slide) into
 * `outDir`, using PowerPoint via win32com. Windows-only, like the office
 * reader. `maxSlides` (0 = all) bounds how many slides are exported.
 */
export async function renderPptxToImages(
  filePath: string,
  outDir: string,
  options?: { widthPx?: number; heightPx?: number; maxSlides?: number },
): Promise<PptxRenderResult> {
  if (process.platform !== 'win32') {
    return {
      error:
        'PPT 슬라이드 렌더링(시각 템플릿 분석)은 Windows + PowerPoint 환경에서만 지원됩니다. ' +
        '현재 플랫폼: ' +
        process.platform,
    };
  }

  const pythonExe = detectPythonExecutable();
  const tmpScript = path.join(
    os.tmpdir(),
    `openwork_render_${randomUUID()}.py`,
  );

  try {
    await fs.writeFile(tmpScript, WIN32COM_RENDER_PPT_SCRIPT, 'utf-8');
    const args = [
      tmpScript,
      filePath,
      outDir,
      String(options?.widthPx ?? 1280),
      String(options?.heightPx ?? 720),
      String(options?.maxSlides ?? 0),
    ];
    const { stdout, stderr, code } = await runPythonScript(pythonExe, args);
    if (code !== 0) {
      return {
        error:
          `win32com PPT 슬라이드 렌더링 실패 (exit ${code}). ` +
          (stderr.trim() || '진단 메시지 없음'),
      };
    }
    const imagePaths = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { imagePaths };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const error =
      message.includes('ENOENT') || message.includes('not found')
        ? `Python 실행 파일 '${pythonExe}' 을(를) 찾을 수 없습니다. ` +
          `Python 3 와 pywin32 (pip install pywin32) 가 설치되어 있어야 합니다.`
        : `win32com PPT 슬라이드 렌더링 중 오류: ${message}`;
    return { error };
  } finally {
    await fs.rm(tmpScript, { force: true }).catch(() => {});
  }
}
