/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildPowerShellShim,
  findNodeModulesRoot,
  getPowerShellShimCandidates,
  quotePowerShellString,
} = require('../install-pywin32.cjs');

describe('install-pywin32 postinstall helpers', () => {
  it('escapes PowerShell single quoted strings', () => {
    expect(quotePowerShellString("C:\\Users\\O'Brien\\openrnd")).toBe(
      "'C:\\Users\\O''Brien\\openrnd'",
    );
  });

  it('finds the nearest node_modules directory', () => {
    const packageRoot = path.join('/repo', 'node_modules', '@openrnd', 'cli');

    expect(findNodeModulesRoot(packageRoot)).toBe('/repo/node_modules');
  });

  it('returns global and local PowerShell shim candidates', () => {
    const packageRoot = path.join('/repo', 'node_modules', '@openrnd', 'cli');

    expect(
      getPowerShellShimCandidates({
        packageRoot,
        prefix: '/global/npm',
      }),
    ).toEqual([
      path.join('/global/npm', 'openrnd.ps1'),
      path.join('/repo', 'node_modules', '.bin', 'openrnd.ps1'),
    ]);
  });

  it('builds a PowerShell shim that avoids native node invocation', () => {
    const shim = buildPowerShellShim({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      targetPath:
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openrnd\\cli\\bundle\\gemini.js',
    });

    expect(shim).toContain('System.Diagnostics.ProcessStartInfo');
    expect(shim).toContain('$psi.FileName = $node');
    expect(shim).toContain('C:\\Program Files\\nodejs\\node.exe');
    expect(shim).not.toContain('& $node');
    expect(shim).not.toContain('& "node');
    expect(shim).not.toContain('exit $LASTEXITCODE');
  });
});
