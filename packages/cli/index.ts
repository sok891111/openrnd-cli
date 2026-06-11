#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import v8 from 'node:v8';
import {
  RELAUNCH_EXIT_CODE,
  getSpawnConfig,
  getScriptArgs,
} from './src/utils/processUtils.js';

// --- Global Entry Point ---

// Suppress known race condition error in node-pty on Windows and Linux
// Tracking bug: https://github.com/microsoft/node-pty/issues/827
process.on('uncaughtException', (error) => {
  if (error instanceof Error) {
    const message = error.message || '';
    const isPtyResizeError =
      message === 'Cannot resize a pty that has already exited';
    const isEbadfError =
      message.includes('EBADF') ||
      (error as { code?: string }).code === 'EBADF';
    const isFromNodePty =
      error.stack?.includes('node-pty') || error.stack?.includes('PtyResize');

    if ((isPtyResizeError || isEbadfError) && isFromNodePty) {
      // This error happens with node-pty when resizing a pty that has just exited.
      // It is a race condition in node-pty that we cannot prevent, so we silence it.
      return;
    }
  }

  // For other errors, we rely on the default behavior, but since we attached a listener,
  // we must manually replicate it.
  if (error instanceof Error) {
    process.stderr.write(error.stack + '\n');
  } else {
    process.stderr.write(String(error) + '\n');
  }
  process.exit(1);
});

async function getMemoryNodeArgs(): Promise<string[]> {
  let autoConfigureMemory = true;
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Respect GEMINI_CLI_HOME environment variable, falling back to os.homedir()
    const baseDir =
      process.env['GEMINI_CLI_HOME'] || join(os.homedir(), '.gemini');
    const settingsPath = join(baseDir, 'settings.json');
    const rawSettings = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(rawSettings);
    if (settings?.advanced?.autoConfigureMemory === false) {
      autoConfigureMemory = false;
    }
  } catch {
    // ignore
  }

  if (autoConfigureMemory) {
    const totalMemoryMB = os.totalmem() / (1024 * 1024);
    const heapStats = v8.getHeapStatistics();
    const currentMaxOldSpaceSizeMb = Math.floor(
      heapStats.heap_size_limit / 1024 / 1024,
    );
    const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);

    if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
      return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
    }
  }

  return [];
}

/**
 * Runs the CLI inline in the current process, without spawning a relaunch child.
 * Used when relaunch is disabled, inside the sandbox, and on Windows (see run()).
 */
async function runInline() {
  // --- Heavy Child Process ---
  // Now we can safely import everything.
  const { main } = await import('./src/gemini.js');
  const { FatalError, writeToStderr } = await import('@openrnd/core');
  const { runExitCleanup } = await import('./src/utils/cleanup.js');

  main().catch(async (error: unknown) => {
    // Set a timeout to force exit if cleanup hangs
    const cleanupTimeout = setTimeout(() => {
      writeToStderr('Cleanup timed out, forcing exit...\n');
      process.exit(1);
    }, 5000);

    try {
      await runExitCleanup();
    } catch (cleanupError: unknown) {
      writeToStderr(
        `Error during final cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    } finally {
      clearTimeout(cleanupTimeout);
    }

    if (error instanceof FatalError) {
      let errorMessage = error.message;
      if (!process.env['NO_COLOR']) {
        errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
      }
      writeToStderr(errorMessage + '\n');
      process.exit(error.exitCode);
    }

    writeToStderr('An unexpected critical error occurred:');
    if (error instanceof Error) {
      writeToStderr(error.stack + '\n');
    } else {
      writeToStderr(String(error) + '\n');
    }
    process.exit(1);
  });
}

async function run() {
  const relaunchDisabled =
    !!process.env['GEMINI_CLI_NO_RELAUNCH'] || !!process.env['SANDBOX'];

  // On Windows, the parent -> child `node.exe` relaunch (spawned with inherited
  // console handles) makes the PowerShell/conhost console teardown surface a
  // spurious OS error dialog when the CLI exits:
  //   "node.exe - 그 프로그램을 실행하지 못했습니다 / 인덱스가 배열 범위를 벗어났습니다"
  //   ("node.exe - The program can't be run / Index was outside the bounds of the array").
  // It is harmless (the CLI itself runs and exits fine) but confuses users.
  //
  // This relaunch only exists to auto-bump the V8 heap (--max-old-space-size).
  // We trade that auto-bump away on Windows to keep a clean single-process exit.
  // Users who need a larger heap can still set NODE_OPTIONS=--max-old-space-size=...,
  // which Node applies at startup without any relaunch.
  const skipRelaunchOnWindows = process.platform === 'win32';

  if (relaunchDisabled || skipRelaunchOnWindows) {
    await runInline();
    return;
  }

  // --- Lightweight Parent Process / Daemon ---
  // We avoid importing heavy dependencies here to save ~1.5s of startup time.

  const scriptArgs = getScriptArgs();
  const memoryArgs = await getMemoryNodeArgs();
  const { spawnArgs, env: newEnv } = getSpawnConfig(memoryArgs, scriptArgs);

  let latestAdminSettings: unknown = undefined;

  // Prevent the parent process from exiting prematurely on signals.
  // The child process will receive the same signals and handle its own cleanup.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig as NodeJS.Signals, () => {});
  }

  const runner = () => {
    process.stdin.pause();

    const child = spawn(process.execPath, spawnArgs, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: newEnv,
    });

    if (latestAdminSettings) {
      child.send({ type: 'admin-settings', settings: latestAdminSettings });
    }

    child.on('message', (msg: { type?: string; settings?: unknown }) => {
      if (msg.type === 'admin-settings-update' && msg.settings) {
        latestAdminSettings = msg.settings;
      }
    });

    return new Promise<number>((resolve) => {
      child.on('error', (err) => {
        process.stderr.write(
          'Error: Failed to start child process: ' + err.message + '\n',
        );
        resolve(1);
      });
      child.on('close', (code) => {
        process.stdin.resume();
        resolve(code ?? 1);
      });
    });
  };

  while (true) {
    try {
      const exitCode = await runner();
      if (process.platform === 'android' || exitCode !== RELAUNCH_EXIT_CODE) {
        process.exit(exitCode);
      }
    } catch (error: unknown) {
      process.stdin.resume();
      process.stderr.write(
        `Fatal error: Failed to relaunch the CLI process.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    }
  }
}

run();
