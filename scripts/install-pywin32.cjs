/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Best-effort postinstall tasks.
 *
 * In-house DRM-protected Office files (Word/Excel/PowerPoint) can only be read
 * through win32com COM automation, which needs the `pywin32` Python package.
 * Bundling it into `npm install` means users don't have to `pip install pywin32`
 * as a separate step.
 *
 * On Windows, this also replaces npm's generated openwork.ps1 shim with one that
 * launches Node through .NET ProcessStartInfo instead of PowerShell's native
 * command invocation operator. That avoids PSReadLine/PowerShell surfacing
 * "Program 'node.exe' failed to run ... NativeCommandFailed" after TUI exit.
 *
 * This script never fails the install:
 *  - It is a no-op on non-Windows platforms (win32com is Windows-only).
 *  - Any error (no Python, no pip, no network) is logged and swallowed; the
 *    runtime office reader will retry the install on first use as a fallback.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function log(message) {
  process.stderr.write(`[openwork-postinstall] ${message}\n`);
}

function quotePowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findNodeModulesRoot(packageRoot) {
  let current = path.resolve(packageRoot);
  while (true) {
    if (path.basename(current).toLowerCase() === 'node_modules') {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getPowerShellShimCandidates({
  packageRoot = path.resolve(__dirname, '..'),
  prefix = process.env.npm_config_prefix,
} = {}) {
  const candidates = new Set();

  if (prefix) {
    candidates.add(path.join(prefix, 'openwork.ps1'));
  }

  const nodeModulesRoot = findNodeModulesRoot(packageRoot);
  if (nodeModulesRoot) {
    candidates.add(path.join(nodeModulesRoot, '.bin', 'openwork.ps1'));
  }

  return [...candidates];
}

function buildPowerShellShim({ nodePath, targetPath }) {
  return `#!/usr/bin/env pwsh
# openwork managed ProcessStartInfo shim.
# npm's default PowerShell shim invokes node.exe with "& node.exe ...".
# In classic Windows PowerShell/conhost, that path can surface a PSReadLine
# IndexOutOfRangeException as NativeCommandFailed after an interactive TUI exits.
$ErrorActionPreference = 'Stop'

function ConvertTo-WindowsArgument {
  param([AllowNull()][object]$Argument)

  if ($null -eq $Argument) {
    return '""'
  }

  $text = [string]$Argument
  if ($text.Length -eq 0) {
    return '""'
  }

  if ($text -notmatch '[\\s"]') {
    return $text
  }

  $result = '"'
  $backslashes = 0
  foreach ($char in $text.ToCharArray()) {
    if ($char -eq '\\') {
      $backslashes++
      continue
    }

    if ($char -eq '"') {
      $result += '\\' * (($backslashes * 2) + 1)
      $result += '"'
      $backslashes = 0
      continue
    }

    if ($backslashes -gt 0) {
      $result += '\\' * $backslashes
      $backslashes = 0
    }
    $result += $char
  }

  if ($backslashes -gt 0) {
    $result += '\\' * ($backslashes * 2)
  }
  $result += '"'
  return $result
}

$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
$node = ${quotePowerShellString(nodePath)}
if (-not (Test-Path $node)) {
  $localNode = Join-Path $basedir 'node.exe'
  if (Test-Path $localNode) {
    $node = $localNode
  } else {
    $node = 'node.exe'
  }
}

$target = ${quotePowerShellString(targetPath)}
$allArgs = @($target) + $args

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.UseShellExecute = $false
$psi.WorkingDirectory = (Get-Location).ProviderPath
$psi.Arguments = (($allArgs | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ')

if ($MyInvocation.ExpectingInput) {
  $psi.RedirectStandardInput = $true
}

$child = [System.Diagnostics.Process]::Start($psi)
if ($MyInvocation.ExpectingInput) {
  foreach ($line in $input) {
    $child.StandardInput.WriteLine([string]$line)
  }
  $child.StandardInput.Close()
}

$child.WaitForExit()
exit $child.ExitCode
`;
}

function patchPowerShellShim() {
  if (process.platform !== 'win32') {
    return;
  }

  if (process.env.OPENWORK_SKIP_POWERSHELL_SHIM_PATCH === '1') {
    log(
      'OPENWORK_SKIP_POWERSHELL_SHIM_PATCH=1 set. Skipping PowerShell shim patch.',
    );
    return;
  }

  const packageRoot = path.resolve(__dirname, '..');
  const targetPath = path.join(packageRoot, 'bundle', 'gemini.js');
  if (!fs.existsSync(targetPath)) {
    log(
      `CLI bundle not found at '${targetPath}'. Skipping PowerShell shim patch.`,
    );
    return;
  }

  const shim = buildPowerShellShim({
    nodePath: process.execPath,
    targetPath,
  });

  let patched = false;
  for (const candidate of getPowerShellShimCandidates({ packageRoot })) {
    try {
      const dir = path.dirname(candidate);
      if (!fs.existsSync(dir)) {
        continue;
      }
      fs.writeFileSync(candidate, shim, 'utf8');
      patched = true;
      log(`Patched PowerShell shim: ${candidate}`);
    } catch (err) {
      log(
        `Could not patch PowerShell shim '${candidate}': ${err && err.message ? err.message : err}`,
      );
    }
  }

  if (!patched) {
    log('No PowerShell shim candidate found to patch.');
  }
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

  patchPowerShellShim();

  // Honor the standard opt-out used by Office automation environments / CI.
  if (process.env.OPENWORK_SKIP_PYWIN32_INSTALL === '1') {
    log('OPENWORK_SKIP_PYWIN32_INSTALL=1 set. Skipping pywin32 install.');
    return;
  }

  for (const pythonExe of ['python', 'py', 'python3']) {
    try {
      if (tryInstall(pythonExe)) {
        return;
      }
    } catch (err) {
      log(
        `Error with '${pythonExe}': ${err && err.message ? err.message : err}`,
      );
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

module.exports = {
  buildPowerShellShim,
  findNodeModulesRoot,
  getPowerShellShimCandidates,
  quotePowerShellString,
};
