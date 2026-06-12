/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { debugLogger } from './debugLogger.js';

/**
 * Thrown when no usable Chrome/Chromium executable can be located. The message
 * tells the user how to point the tool at their browser.
 */
export class ChromeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeNotFoundError';
  }
}

/** Environment variables (in priority order) that may name a Chrome binary. */
const CHROME_ENV_VARS = [
  'OPENWORK_CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'CHROME_PATH',
  'GOOGLE_CHROME_BIN',
  'GOOGLE_CHROME_SHIM',
];

/** Well-known install locations per platform, checked in order. */
function standardChromeLocations(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 =
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData =
      process.env['LOCALAPPDATA'] ??
      path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  }
  // linux / other unix
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
}

/** Candidate @puppeteer/browsers cache directories that may hold a Chrome. */
function puppeteerCacheDirs(): string[] {
  const dirs = [
    process.env['PUPPETEER_CACHE_DIR'],
    path.join(os.homedir(), '.cache', 'puppeteer'),
  ];
  return dirs.filter((d): d is string => !!d);
}

/**
 * Looks for a Chrome that was installed into a @puppeteer/browsers cache (e.g.
 * the one chrome-devtools-mcp downloads). Returns the first usable executable,
 * preferring full Chrome/Chromium over the headless shell.
 */
async function findCachedChrome(): Promise<string | undefined> {
  for (const cacheDir of puppeteerCacheDirs()) {
    if (!existsSync(cacheDir)) continue;
    try {
      const installed = await getInstalledBrowsers({ cacheDir });
      // Prefer a real Chrome/Chromium; the headless shell is a last resort.
      const ranked = [...installed].sort(
        (a, b) =>
          browserRank(a.browser) - browserRank(b.browser) ||
          // Newer buildId first when same browser.
          (a.buildId < b.buildId ? 1 : -1),
      );
      for (const browser of ranked) {
        if (browser.executablePath && existsSync(browser.executablePath)) {
          return browser.executablePath;
        }
      }
    } catch (e) {
      debugLogger.warn(
        `[chromeFinder] getInstalledBrowsers failed for ${cacheDir}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return undefined;
}

function browserRank(browser: string): number {
  if (browser === 'chrome') return 0;
  if (browser === 'chromium') return 1;
  return 2; // chrome-headless-shell and anything else
}

/**
 * Resolves a Chrome/Chromium executable path for headless rendering.
 *
 * Resolution order:
 *   1. Explicit env vars ({@link CHROME_ENV_VARS}).
 *   2. Well-known OS install locations.
 *   3. A Chrome installed in a @puppeteer/browsers cache (e.g. via
 *      chrome-devtools-mcp), so machines without a system Chrome still work.
 *
 * @throws {ChromeNotFoundError} when nothing usable is found.
 */
export async function resolveChromeExecutablePath(): Promise<string> {
  for (const envVar of CHROME_ENV_VARS) {
    const value = process.env[envVar]?.trim();
    if (value && existsSync(value)) {
      return value;
    }
  }

  for (const location of standardChromeLocations()) {
    if (existsSync(location)) {
      return location;
    }
  }

  const cached = await findCachedChrome();
  if (cached) {
    return cached;
  }

  throw new ChromeNotFoundError(
    'Chrome/Chromium 실행 파일을 찾지 못했습니다. HTML→PPTX 변환은 헤드리스 Chrome으로 ' +
      '슬라이드를 렌더링합니다. Google Chrome을 설치하거나, 설치된 브라우저 경로를 ' +
      '환경변수 OPENWORK_CHROME_PATH (또는 PUPPETEER_EXECUTABLE_PATH / CHROME_PATH)로 ' +
      '지정해 주세요.',
  );
}
