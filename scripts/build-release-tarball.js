/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds a fully self-contained npm tarball for distribution.
 *
 * The esbuild bundle (`bundle/`) already inlines every JS dependency, so the
 * published package needs no runtime `dependencies` and no build step on the
 * user's machine. This script stages a slim package.json (no deps, no
 * `prepare`) alongside the prebuilt bundle and runs `npm pack`, producing a
 * tarball that installs with a single command and zero npm-registry access:
 *
 *   npm install -g openrnd-cli-<version>.tgz
 *
 * Native helpers (node-pty, keytar) are intentionally omitted: they are
 * optional and the CLI degrades gracefully without them (child_process shell,
 * file-based credential fallback).
 *
 * Output: release/openrnd-cli-<version>.tgz and release/openrnd-latest.tgz
 */

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const stagingDir = path.join(releaseDir, 'staging');

function log(message) {
  process.stdout.write(`[release] ${message}\n`);
}

function run(command, cwd = root) {
  log(`$ ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// 1. Build the bundle fresh so the tarball matches the current source.
log(`Building bundle for openrnd v${version}...`);
run('npm run bundle');

if (!existsSync(path.join(root, 'bundle', 'gemini.js'))) {
  throw new Error('bundle/gemini.js not found after build. Aborting.');
}

// 2. Reset the staging directory.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// 3. Copy the artifacts that ship in the tarball.
log('Staging bundle and assets...');
cpSync(path.join(root, 'bundle'), path.join(stagingDir, 'bundle'), {
  recursive: true,
});
mkdirSync(path.join(stagingDir, 'scripts'), { recursive: true });
copyFileSync(
  path.join(root, 'scripts', 'install-pywin32.cjs'),
  path.join(stagingDir, 'scripts', 'install-pywin32.cjs'),
);
for (const file of ['README.md', 'LICENSE']) {
  if (existsSync(path.join(root, file))) {
    copyFileSync(path.join(root, file), path.join(stagingDir, file));
  }
}

// 4. Write a slim, self-contained package.json (no deps, no prepare).
const slimPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  type: pkg.type,
  engines: pkg.engines,
  bin: pkg.bin,
  files: ['bundle/', 'scripts/install-pywin32.cjs', 'README.md', 'LICENSE'],
  scripts: {
    postinstall: 'node scripts/install-pywin32.cjs',
  },
};
writeFileSync(
  path.join(stagingDir, 'package.json'),
  JSON.stringify(slimPkg, null, 2) + '\n',
);

// 5. Pack the staged package (no lifecycle build runs here).
log('Packing tarball...');
run('npm pack --pack-destination .', stagingDir);

const tarball = readdirSync(stagingDir).find(
  (f) => f.endsWith('.tgz') && f.includes(version),
);
if (!tarball) {
  throw new Error('npm pack did not produce a .tgz in the staging directory.');
}

// 6. Publish into release/ with a versioned name and a stable "latest" alias.
const versionedPath = path.join(releaseDir, tarball);
const latestPath = path.join(releaseDir, 'openrnd-latest.tgz');
copyFileSync(path.join(stagingDir, tarball), versionedPath);
copyFileSync(path.join(stagingDir, tarball), latestPath);
rmSync(stagingDir, { recursive: true, force: true });

log('Done.');
log(`  Versioned: release/${tarball}`);
log('  Stable:    release/openrnd-latest.tgz');
log('');
log('Serve it from this machine with:  npm run release:serve');
log(
  'Then users install with one line:  npm install -g http://<this-pc-ip>:8723/openrnd-latest.tgz',
);
