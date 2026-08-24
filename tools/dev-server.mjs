#!/usr/bin/env node
/**
 * Zero-dependency static server for local development.
 *
 *   node tools/dev-server.mjs [--port 4173] [--host 127.0.0.1]
 *
 * Serves the repository root with correct MIME types, no-cache headers, and
 * `/foo` → `/foo.html` resolution so links behave the way GitHub Pages does.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(flag('port', process.env.PORT || 4173));
const HOST = flag('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.normalize(path.join(ROOT, clean));
  if (!target.startsWith(ROOT)) return null; // path traversal

  const candidates = clean.endsWith('/')
    ? [path.join(target, 'index.html')]
    : [target, `${target}.html`, path.join(target, 'index.html')];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const file = await resolve(req.url || '/');

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><p style="font:14px system-ui;padding:2rem">Not found.</p>');
    console.log(`404 ${req.method} ${req.url}`);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });

  createReadStream(file)
    .on('error', () => res.end())
    .pipe(res)
    .on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`200 ${req.method} ${req.url} (${ms.toFixed(1)}ms)`);
    });
});

server.listen(PORT, HOST, () => {
  console.log(`DigiStore dev server → http://${HOST}:${PORT}`);
});
