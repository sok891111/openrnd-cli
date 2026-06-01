/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isOfficeFile,
  OFFICE_EXTENSIONS,
  readOfficeFile,
} from './officeReader.js';

describe('isOfficeFile', () => {
  it.each([
    'a.doc',
    'a.docx',
    'A.DOCX',
    'b.xls',
    'b.xlsx',
    'c.ppt',
    'c.pptx',
    'd.pdf',
    'D.PDF',
    '/abs/path/to/report.docm',
  ])('returns true for win32com-routed file %s', (file) => {
    expect(isOfficeFile(file)).toBe(true);
  });

  it.each(['a.txt', 'a.png', 'a.ts', 'README', 'a.csv'])(
    'returns false for non-office file %s',
    (file) => {
      expect(isOfficeFile(file)).toBe(false);
    },
  );

  it('covers Word, Excel, PowerPoint and PDF extensions', () => {
    expect(OFFICE_EXTENSIONS).toEqual(
      expect.arrayContaining([
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.pdf',
      ]),
    );
  });
});

describe('readOfficeFile', () => {
  it('returns a clear error on non-Windows platforms', async () => {
    if (process.platform === 'win32') {
      // win32com path is exercised manually in-house; skip on Windows CI.
      return;
    }
    const result = await readOfficeFile('/tmp/whatever.docx');
    expect(result.text).toBeUndefined();
    expect(result.error).toContain('Windows');
  });
});
