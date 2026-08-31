#!/usr/bin/env node
/**
 * Stamps every HTML reference to css/app.css with a content hash so a deploy
 * can never serve a stale stylesheet from cache.
 *
 *   node tools/build.mjs [--check] [--watch]
 *
 * css/app.css is the hand-maintained source of truth (the old css/src/*.css
 * split was removed in commit 56725e3). This script no longer bundles — it
 * only hashes the committed file and rewrites `./css/app.css?v=…` in each page.
 *
 * --check exits non-zero when any page's stamp is out of date, which is what
 * `npm run check` uses to keep the deploy honest.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, watch } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = path.join(ROOT, 'css', 'app.css');

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const WATCH = args.has('--watch');

async function cssHash() {
  const css = await readFile(CSS_FILE, 'utf8');
  return createHash('sha256').update(css).digest('hex').slice(0, 8);
}

/** Rewrites `./css/app.css?v=…` in every page so the hash always matches. */
async function stampHtml(hash) {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const pages = entries.filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => e.name);
  const changed = [];

  for (const page of pages) {
    const file = path.join(ROOT, page);
    const html = await readFile(file, 'utf8');
    const next = html.replace(
      /(href="\.\/css\/app\.css)(\?v=[a-f0-9]+)?(")/g,
      `$1?v=${hash}$3`,
    );
    if (next !== html) {
      if (!CHECK) await writeFile(file, next);
      changed.push(page);
    }
  }
  return changed;
}

async function run() {
  const hash = await cssHash();

  if (CHECK) {
    const drifted = await stampHtml(hash);
    if (drifted.length) {
      console.error('css cache stamp is out of date. Run: npm run build');
      console.error(`  stale stamp in: ${drifted.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`css/app.css cache stamp is current (build ${hash}).`);
    return;
  }

  const stamped = await stampHtml(hash);
  const kb = ((await readFile(CSS_FILE)).byteLength / 1024).toFixed(1);
  console.log(
    `css/app.css ${kb} kB, build ${hash}` +
      (stamped.length ? `; stamped ${stamped.length} page(s): ${stamped.join(', ')}` : '; all pages current'),
  );
}

await run();

if (WATCH) {
  console.log('Watching css/app.css for changes. Ctrl+C to stop.');
  let queued = null;
  for await (const _event of watch(CSS_FILE)) {
    clearTimeout(queued);
    queued = setTimeout(() => run().catch((err) => console.error(err.message)), 60);
  }
}
