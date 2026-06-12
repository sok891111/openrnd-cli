/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));

const getInstalledBrowsersMock = vi.hoisted(() => vi.fn());
vi.mock('@puppeteer/browsers', () => ({
  getInstalledBrowsers: getInstalledBrowsersMock,
}));

import {
  resolveChromeExecutablePath,
  ChromeNotFoundError,
} from './chromeFinder.js';

const CHROME_ENV_VARS = [
  'OPENWORK_CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'CHROME_PATH',
  'GOOGLE_CHROME_BIN',
  'GOOGLE_CHROME_SHIM',
  'PUPPETEER_CACHE_DIR',
];
let savedEnv: Record<string, string | undefined>;

describe('resolveChromeExecutablePath', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of CHROME_ENV_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    existsSyncMock.mockReset().mockReturnValue(false);
    getInstalledBrowsersMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    for (const k of CHROME_ENV_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns the path from an env var when it exists', async () => {
    process.env['OPENWORK_CHROME_PATH'] = '/custom/chrome';
    existsSyncMock.mockImplementation((p: string) => p === '/custom/chrome');

    await expect(resolveChromeExecutablePath()).resolves.toBe('/custom/chrome');
  });

  it('falls back to a @puppeteer/browsers-cached Chrome, preferring full Chrome', async () => {
    getInstalledBrowsersMock.mockResolvedValue([
      {
        browser: 'chrome-headless-shell',
        buildId: '131',
        executablePath: '/cache/shell',
      },
      { browser: 'chrome', buildId: '131', executablePath: '/cache/chrome' },
    ]);
    // The cache dir must "exist", but no browser binary on disk does except the
    // cached executables themselves.
    existsSyncMock.mockImplementation(
      (p: string) =>
        p.includes('.cache') || p === '/cache/chrome' || p === '/cache/shell',
    );

    await expect(resolveChromeExecutablePath()).resolves.toBe('/cache/chrome');
  });

  it('throws ChromeNotFoundError when nothing is found', async () => {
    existsSyncMock.mockReturnValue(false);
    getInstalledBrowsersMock.mockResolvedValue([]);

    await expect(resolveChromeExecutablePath()).rejects.toBeInstanceOf(
      ChromeNotFoundError,
    );
  });
});
