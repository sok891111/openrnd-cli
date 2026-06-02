/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serves the release/ directory over plain HTTP so users on the same network
 * can install the CLI with a single command:
 *
 *   npm install -g http://<this-pc-ip>:8723/openrnd-latest.tgz
 *
 * Read-only static file server, no auth (intended for a trusted internal LAN).
 * Port is configurable via OPENRND_RELEASE_PORT (default 8723).
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const port = Number.parseInt(process.env.OPENRND_RELEASE_PORT ?? '8723', 10);

function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  return addrs;
}

if (!existsSync(releaseDir)) {
  process.stderr.write(
    `[serve] release/ not found. Run "npm run release:pack" first.\n`,
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  // Only allow GET/HEAD of files directly inside release/ (no traversal).
  const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(
    /^\/+/,
    '',
  );

  if (!name) {
    // Index: list available tarballs.
    const files = readdirSync(releaseDir).filter((f) => f.endsWith('.tgz'));
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `openrnd release server\n\nAvailable tarballs:\n${files
        .map((f) => `  /${f}`)
        .join('\n')}\n`,
    );
    return;
  }

  if (name.includes('/') || name.includes('..')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const filePath = path.join(releaseDir, name);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': statSync(filePath).size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  process.stdout.write(`[serve] Serving release/ on port ${port}\n`);
  const hosts = lanAddresses();
  if (hosts.length === 0) {
    process.stdout.write(
      `[serve] Install:  npm install -g http://localhost:${port}/openrnd-latest.tgz\n`,
    );
  } else {
    process.stdout.write('[serve] Users on your network install with:\n');
    for (const host of hosts) {
      process.stdout.write(
        `[serve]   npm install -g http://${host}:${port}/openrnd-latest.tgz\n`,
      );
    }
  }
});
