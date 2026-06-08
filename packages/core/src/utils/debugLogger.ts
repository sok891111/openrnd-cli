/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { Storage } from '../config/storage.js';
import { isDebugLoggingEnabled } from './debugLogging.js';

/**
 * Resolves the debug log file path, or undefined if debug logging is off.
 *
 * Precedence:
 *   1. GEMINI_DEBUG_LOG_FILE env var (explicit override, any path).
 *   2. settings.general.debugLogging / OPENRND_DEBUG -> ~/.openrnd/debug.log.
 */
function resolveDebugLogFile(): string | undefined {
  const explicit = process.env['GEMINI_DEBUG_LOG_FILE'];
  if (explicit) {
    return explicit;
  }
  if (isDebugLoggingEnabled()) {
    return path.join(Storage.getGlobalGeminiDir(), 'debug.log');
  }
  return undefined;
}

/**
 * A simple, centralized logger for developer-facing debug messages.
 *
 * WHY USE THIS?
 * - It makes the INTENT of the log clear (it's for developers, not users).
 * - It provides a single point of control for debug logging behavior.
 * - We can lint against direct `console.*` usage to enforce this pattern.
 *
 * HOW IT WORKS:
 * This is a thin wrapper around the native `console` object. The `ConsolePatcher`
 * will intercept these calls and route them to the debug drawer UI.
 */
class DebugLogger {
  private logStream: fs.WriteStream | undefined;
  // The stream is opened lazily on first write rather than in the constructor.
  // `debugLogger` is a module-level singleton and `resolveDebugLogFile()`
  // touches `Storage`, which sits in an import cycle with this module
  // (storage -> projectRegistry/storageMigration -> debugLogger). Deferring the
  // access until first use sidesteps the temporal-dead-zone hazard.
  private streamResolved = false;

  private getLogStream(): fs.WriteStream | undefined {
    if (this.streamResolved) {
      return this.logStream;
    }
    this.streamResolved = true;
    const logFile = resolveDebugLogFile();
    if (logFile) {
      try {
        // The target directory (e.g. ~/.openrnd) may not exist yet on a fresh
        // install; createWriteStream won't create it for us.
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
        // Handle potential errors with the stream.
        this.logStream.on('error', (err) => {
          // Log to console as a fallback, but don't crash the app.
          console.error('Error writing to debug log stream:', err);
        });
      } catch (err) {
        // Never let a logging-setup failure crash the app.
        console.error('Error opening debug log file:', err);
      }
    }
    return this.logStream;
  }

  private writeToFile(level: string, args: unknown[]) {
    const stream = this.getLogStream();
    if (stream) {
      const message = util.format(...args);
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [${level}] ${message}\n`;
      stream.write(logEntry);
    }
  }

  log(...args: unknown[]): void {
    this.writeToFile('LOG', args);
    console.log(...args);
  }

  warn(...args: unknown[]): void {
    this.writeToFile('WARN', args);
    console.warn(...args);
  }

  error(...args: unknown[]): void {
    this.writeToFile('ERROR', args);
    console.error(...args);
  }

  debug(...args: unknown[]): void {
    this.writeToFile('DEBUG', args);
    console.debug(...args);
  }
}

export const debugLogger = new DebugLogger();
