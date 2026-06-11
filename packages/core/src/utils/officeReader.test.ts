/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  isOfficeFile,
  OFFICE_EXTENSIONS,
  readOfficeFile,
} from './officeReader.js';
import { coreEvents } from './events.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/openrnd_office_img_test'),
    readFile: vi.fn().mockRejectedValue(new Error('image file missing')),
  },
}));

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
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnMock.mockReset();
    vi.unstubAllEnvs();
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  function mockSuccessfulSpawn(stdout = 'extracted text'): void {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      // Emit content and close asynchronously so the listeners are attached.
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout, 'utf-8'));
        child.emit('close', 0);
      });
      return child;
    });
  }

  it('returns a clear error on non-Windows platforms', async () => {
    setPlatform('linux');
    const result = await readOfficeFile('/tmp/whatever.docx');
    expect(result.text).toBeUndefined();
    expect(result.error).toContain('Windows');
  });

  it('does NOT spawn through a shell on Windows (avoids cmd.exe codepage corruption of Korean paths)', async () => {
    setPlatform('win32');
    mockSuccessfulSpawn();

    // A Korean filename with no spaces still failed before, because cmd.exe
    // re-encodes the command line through the console OEM codepage and turns
    // non-ASCII characters into "?". Bypassing the shell keeps it intact.
    const filePath = 'C:\\Users\\사용자\\한글.xlsx';
    const result = await readOfficeFile(filePath);

    expect(result.text).toBe('extracted text');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawnMock.mock.calls[0];
    expect(exe).toBe('python');
    // shell must be falsy so argv goes straight to CreateProcessW as Unicode.
    expect(opts.shell).toBeFalsy();
    // The path is passed verbatim as a single argv entry (no manual quoting).
    expect(args).toContain(filePath);
  });

  it('passes a path with spaces as one intact (unquoted) argv entry', async () => {
    setPlatform('win32');
    mockSuccessfulSpawn();

    const filePath = 'C:\\내 문서\\보고서 최종본.xlsx';
    await readOfficeFile(filePath);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain(filePath);
  });

  it('passes the fallback reader as a separate trailing arg', async () => {
    setPlatform('win32');
    mockSuccessfulSpawn();

    const filePath = 'C:\\내 문서\\file.dat';
    await readOfficeFile(filePath, { fallbackReader: 'excel' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain(filePath);
    expect(args).toContain('excel');
    expect((args as string[])[args.length - 1]).toBe('excel');
  });

  it('does not emit user-facing errors when PPT image description fails', async () => {
    setPlatform('win32');
    vi.stubEnv('OPENRND_VISION_BASE_URL', 'http://vision/v1');
    vi.stubEnv('OPENRND_VISION_MODEL', 'llava');
    mockSuccessfulSpawn('# Slide 1\nTitle\n[[OFFICE_IMAGE:img_1_1.png]]');
    const feedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');

    try {
      const result = await readOfficeFile('C:\\deck.pptx');

      expect(result.text).toContain('could not be described');
      expect(feedbackSpy).not.toHaveBeenCalledWith('error', expect.any(String));
    } finally {
      feedbackSpy.mockRestore();
    }
  });
});
