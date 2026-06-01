/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Best-effort installer for pywin32, run as an npm `postinstall` hook.
 *
 * In-house DRM-protected Office files (Word/Excel/PowerPoint) can only be read
 * through win32com COM automation, which needs the `pywin32` Python package.
 * Bundling it into `npm install` means users don't have to `pip install pywin32`
 * as a separate step.
 *
 * This script never fails the install:
 *  - It is a no-op on non-Windows platforms (win32com is Windows-only).
 *  - Any error (no Python, no pip, no network) is logged and swallowed; the
 *    runtime office reader will retry the install on first use as a fallback.
 */

const { spawnSync } = require('node:child_process');

function log(message) {
  process.stderr.write(`[pywin32-install] ${message}\n`);
}

function isAlreadyInstalled(pythonExe) {
  const probe = spawnSync(pythonExe, ['-c', 'import win32com.client'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return probe.status === 0;
}

function tryInstall(pythonExe) {
  const probe = spawnSync(pythonExe, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  if (probe.status !== 0) {
    return false; // This Python executable is not available.
  }

  if (isAlreadyInstalled(pythonExe)) {
    log(`pywin32 already available for '${pythonExe}'. Skipping.`);
    return true;
  }

  log(`Installing pywin32 via '${pythonExe} -m pip install --user pywin32'...`);
  const result = spawnSync(
    pythonExe,
    ['-m', 'pip', 'install', '--user', '--upgrade', 'pywin32'],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );

  if (result.status === 0) {
    log(`pywin32 installed for '${pythonExe}'.`);
    return true;
  }
  log(`pip install failed for '${pythonExe}' (exit ${result.status}).`);
  return false;
}

function main() {
  if (process.platform !== 'win32') {
    // win32com only exists on Windows; nothing to do elsewhere.
    return;
  }

  // Honor the standard opt-out used by Office automation environments / CI.
  if (process.env.OPENRND_SKIP_PYWIN32_INSTALL === '1') {
    log('OPENRND_SKIP_PYWIN32_INSTALL=1 set. Skipping pywin32 install.');
    return;
  }

  for (const pythonExe of ['python', 'py', 'python3']) {
    try {
      if (tryInstall(pythonExe)) {
        return;
      }
    } catch (err) {
      log(`Error with '${pythonExe}': ${err && err.message ? err.message : err}`);
    }
  }

  log(
    'Could not auto-install pywin32. It will be installed automatically on ' +
      'the first Office file read, or you can run: python -m pip install pywin32',
  );
}

try {
  main();
} catch (err) {
  // Never break `npm install`.
  log(`Unexpected error: ${err && err.message ? err.message : err}`);
}
