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

def read_ppt(path):
    import win32com.client
    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    parts = []
    try:
        # PowerPoint cannot run fully hidden; WithWindow=False keeps it offscreen.
        pres = ppt.Presentations.Open(path, ReadOnly=True, WithWindow=False)
        try:
            for idx, slide in enumerate(pres.Slides, start=1):
                parts.append("# Slide %d" % idx)
                for shape in slide.Shapes:
                    try:
                        if shape.HasTextFrame and shape.TextFrame.HasText:
                            parts.append(shape.TextFrame.TextRange.Text)
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
            text = read_ppt(path)
        elif forced == "word":
            text = read_word(path)
        elif forced == "pdf":
            text = read_pdf(path)
        elif forced == "excel":
            text = read_excel(path)
        elif forced == "ppt":
            text = read_ppt(path)
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

/**
 * Extracts plain text from an in-house Office document using win32com.
 *
 * Always goes through the Office COM automation path so DRM-protected files can
 * be read; never falls back to reading bytes off disk.
 */
export async function readOfficeFile(
  filePath: string,
  options?: { fallbackReader?: OfficeFallbackReader },
): Promise<OfficeReadResult> {
  if (process.platform !== 'win32') {
    const error =
      'win32com 기반 Office 읽기는 Windows에서만 지원됩니다. ' +
      '현재 플랫폼: ' +
      process.platform;
    return { error };
  }

  const pythonExe = detectPythonExecutable();
  const tmpScript = path.join(os.tmpdir(), `openrnd_office_${randomUUID()}.py`);

  try {
    await fs.writeFile(tmpScript, WIN32COM_EXTRACT_SCRIPT, 'utf-8');

    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve, reject) => {
      const spawnArgs = options?.fallbackReader
        ? [tmpScript, filePath, options.fallbackReader]
        : [tmpScript, filePath];
      // IMPORTANT: do NOT spawn through a shell here. On Windows `shell: true`
      // runs `cmd.exe /d /s /c "..."`, and cmd.exe re-encodes the command line
      // through the console's OEM code page (e.g. CP437/949). Any character not
      // representable there -- e.g. a Korean file name like "한글.xlsx", even
      // with no spaces -- is replaced with "?", so win32com receives a corrupted
      // path and reports "file not found". It also splits unquoted paths on
      // spaces. Spawning without a shell passes the argv array straight to
      // CreateProcessW as Unicode (libuv does the quoting), which preserves
      // both Unicode characters and spaces. libuv still resolves `python` on
      // PATH via PATHEXT, so we don't need the shell to find the interpreter.
      const child = spawn(pythonExe, spawnArgs, {
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
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
              `win32com 추출이 ${OFFICE_READ_TIMEOUT_MS / 1000}s 후 타임아웃되었습니다.`,
            ),
          );
          return;
        }
        resolve({ stdout: out, stderr: err, code: c });
      });
    });

    if (code !== 0) {
      const error =
        `win32com Office 읽기 실패 (exit ${code}). ` +
        (stderr.trim() || '진단 메시지 없음');
      return { error };
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
  }
}
