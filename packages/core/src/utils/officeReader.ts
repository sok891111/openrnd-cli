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
import { writeToStderr } from './stdio.js';

/**
 * Office document extensions that must be read through win32com COM automation.
 *
 * In-house Office files (Word/PowerPoint/Excel) are protected by a DRM policy
 * that prevents them from being read directly off disk. Opening them through the
 * installed Office application via win32com (pywin32) is the only path that the
 * DRM agent allows, so reads for these extensions are routed there.
 *
 * PDF is intentionally excluded: it keeps its existing inlineData handling.
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

/** Timeout for the win32com extraction process (Office launch can be slow). */
const OFFICE_READ_TIMEOUT_MS = 120_000;

function logOffice(message: string): void {
  writeToStderr(`[office-read] ${message}\n`);
}

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
    ext = os.path.splitext(path)[1].lower()
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass
    try:
        if ext in (".doc", ".docx", ".docm", ".dot", ".dotx"):
            text = read_word(path)
        elif ext in (".xls", ".xlsx", ".xlsm", ".xlsb"):
            text = read_excel(path)
        elif ext in (".ppt", ".pptx", ".pptm"):
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
): Promise<OfficeReadResult> {
  const ext = path.extname(filePath).toLowerCase();
  logOffice(`win32com 로 읽기 시작: ${filePath} (확장자 ${ext})`);

  if (process.platform !== 'win32') {
    const error =
      'win32com 기반 Office 읽기는 Windows에서만 지원됩니다. ' +
      '현재 플랫폼: ' +
      process.platform;
    logOffice(`건너뜀: ${error}`);
    return { error };
  }

  const pythonExe = detectPythonExecutable();
  const tmpScript = path.join(os.tmpdir(), `openrnd_office_${randomUUID()}.py`);

  try {
    await fs.writeFile(tmpScript, WIN32COM_EXTRACT_SCRIPT, 'utf-8');
    logOffice(`Python 실행: ${pythonExe} <script> "${filePath}"`);

    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve, reject) => {
      const child = spawn(pythonExe, [tmpScript, filePath], {
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        shell: process.platform === 'win32',
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
        const chunk = d.toString('utf-8');
        err += chunk;
        // Surface win32com diagnostics directly in the terminal.
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) {
            logOffice(`[python] ${line.trim()}`);
          }
        }
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
      logOffice(`실패: ${error}`);
      return { error };
    }

    logOffice(`완료: ${stdout.length} chars 추출 (${filePath})`);
    return { text: stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const error =
      message.includes('ENOENT') || message.includes('not found')
        ? `Python 실행 파일 '${pythonExe}' 을(를) 찾을 수 없습니다. ` +
          `Python 3 와 pywin32 (pip install pywin32) 가 설치되어 있어야 합니다.`
        : `win32com Office 읽기 중 오류: ${message}`;
    logOffice(`오류: ${error}`);
    return { error };
  } finally {
    await fs.rm(tmpScript, { force: true }).catch(() => {});
  }
}
