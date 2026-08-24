#!/usr/bin/env node
/**
 * Repository checks. No dependencies, runs in CI and locally.
 *
 *   node tools/check.mjs [--only=js,html,css,sql,design,links]
 *
 * The `design` group is the interesting one: it fails the build when the
 * visual patterns this rebuild removed reappear — capsule radii, glow
 * shadows, gradient washes, CDN stylesheets, decorative emoji. Style rules
 * that are only written down get re-broken; these ones cannot be.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'node_modules', '.check');

const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const wants = (group) => !only.length || only.includes(group);

const problems = [];
const notes = [];

function fail(file, message, line) {
  problems.push({ file: path.relative(ROOT, file), message, line });
}

/* ==========================================================================
   File discovery
   ========================================================================== */

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', 'supabase/.temp', 'tests/.artifacts']);

async function walk(dir, filter, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(ROOT, full).replace(/\\/g, '/');
    if (IGNORED_DIRS.has(entry.name) || IGNORED_DIRS.has(relative)) continue;
    if (entry.isDirectory()) await walk(full, filter, found);
    else if (filter(full)) found.push(full);
  }
  return found;
}

/* ==========================================================================
   JavaScript — syntax
   ========================================================================== */

async function checkJs() {
  const files = await walk(ROOT, (f) => /\.(m?js)$/.test(f) && !f.includes('seed-data'));
  await mkdir(TMP, { recursive: true });

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // `node --check` treats .js as CommonJS, so ESM sources are checked via a
    // temporary .mjs copy.
    const scratch = path.join(TMP, `${path.basename(file, path.extname(file))}-${files.indexOf(file)}.mjs`);
    await writeFile(scratch, source);
    try {
      await run(process.execPath, ['--check', scratch]);
    } catch (error) {
      const message = String(error.stderr || error.message)
        .split('\n')
        .find((line) => /SyntaxError|Error:/.test(line));
      fail(file, `syntax: ${message || 'failed to parse'}`);
    }
  }

  // Debug leftovers that should never ship.
  for (const file of files) {
    if (file.includes('tools' + path.sep) || file.includes('tests' + path.sep)) continue;
    const source = await readFile(file, 'utf8');
    source.split('\n').forEach((text, index) => {
      if (/\bdebugger\b/.test(text)) fail(file, 'debugger statement left in source', index + 1);
      if (/console\.log\(/.test(text) && !/eslint|allow-log/.test(text)) {
        notes.push(`${path.relative(ROOT, file)}:${index + 1} console.log`);
      }
    });
  }

  await rm(TMP, { recursive: true, force: true });
  return files.length;
}

/* ==========================================================================
   Design rules
   ========================================================================== */

const DESIGN_RULES = [
  {
    id: 'cdn-tailwind',
    pattern: /cdn\.tailwindcss\.com/,
    message: 'the Tailwind CDN is a development-only build and must not be referenced',
  },
  {
    id: 'cdn-icons',
    pattern: /unpkg\.com\/lucide|cdn\.jsdelivr\.net\/npm\/lucide/,
    message: 'icons are inlined from js/icons.js — no icon CDN',
  },
  {
    id: 'unpinned-cdn',
    pattern: /(unpkg\.com|cdn\.jsdelivr\.net)\/[^"']*@latest/,
    message: 'unpinned @latest CDN dependency',
  },
  {
    id: 'capsule-radius',
    pattern: /border-radius:\s*(?:99+px|9999px|100px|50rem|999rem)/,
    message: 'capsule radius — the design system caps radii at 6px (var(--radius-4))',
  },
  {
    id: 'tailwind-pill',
    pattern: /class="[^"]*\brounded-(?:full|3xl|2xl)\b/,
    message: 'pill/oversized radius utility class',
  },
  {
    id: 'glow-shadow',
    pattern: /box-shadow:[^;]*(?:rgba?\(\s*(?:249|251|59|168|34|139)\s*,)|shadow-(?:orange|blue|purple|emerald|cyan)-/,
    message: 'coloured glow shadow — elevation is neutral and reserved for overlays',
  },
  {
    id: 'gradient-wash',
    pattern: /bg-gradient-to-|linear-gradient\((?![^)]*(?:transparent|--surface|--line))/,
    message: 'decorative gradient',
  },
  {
    id: 'blur-orb',
    pattern: /blur-(?:2xl|3xl)|backdrop-filter:\s*blur/,
    message: 'blur orb / glassmorphism effect',
  },
  {
    id: 'font-black',
    pattern: /font-black|font-weight:\s*(?:800|900)\b/,
    message: 'weight above 700 — the type scale stops at semibold/bold',
  },
  {
    id: 'emoji',
    // Pictographic emoji in shipped copy. Arrows and typographic marks are fine.
    pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u,
    message: 'decorative emoji — use an icon from js/icons.js',
  },
];

async function checkDesign() {
  const files = await walk(
    ROOT,
    (f) =>
      (/\.(html|css|js)$/.test(f) &&
        !f.includes('seed-data') &&
        !f.includes(`tools${path.sep}check.mjs`) &&
        !f.includes(`${path.sep}docs${path.sep}`)) ||
      false,
  );

  for (const file of files) {
    // The bundled stylesheet is generated; its sources are checked instead.
    if (file.endsWith(`css${path.sep}app.css`)) continue;

    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');

    for (const rule of DESIGN_RULES) {
      lines.forEach((text, index) => {
        if (text.includes('check-ignore')) return;
        if (rule.pattern.test(text)) fail(file, `${rule.id}: ${rule.message}`, index + 1);
      });
    }
  }

  return files.length;
}

/* ==========================================================================
   HTML
   ========================================================================== */

async function checkHtml() {
  const files = (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(ROOT, entry.name));

  for (const file of files) {
    const source = await readFile(file, 'utf8');

    if (!/<html[^>]+lang=/.test(source)) fail(file, 'missing lang attribute on <html>');
    if (!/<meta[^>]+name="viewport"/.test(source)) fail(file, 'missing viewport meta');
    if (!/<title>[^<]+<\/title>/.test(source)) fail(file, 'missing or empty <title>');
    if (!/href="\.\/css\/app\.css\?v=[a-f0-9]{8}"/.test(source)) {
      fail(file, 'stylesheet link is missing its cache stamp — run npm run build');
    }
    if (/<img(?![^>]*\balt=)/.test(source)) fail(file, '<img> without an alt attribute');

    // Local references must resolve.
    for (const match of source.matchAll(/(?:href|src)="(\.\/[^"#?]+)/g)) {
      const target = path.join(ROOT, match[1]);
      try {
        await readFile(target);
      } catch {
        fail(file, `broken local reference: ${match[1]}`);
      }
    }

    // Every element id the page declares should be unique.
    const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) fail(file, `duplicate element id "${id}"`);
      seen.add(id);
    }
  }

  return files.length;
}

/* ==========================================================================
   SQL migrations
   ========================================================================== */

async function checkSql() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    fail(dir, 'no migrations directory');
    return 0;
  }

  if (!files.length) fail(dir, 'no migrations found');

  for (const name of files) {
    const file = path.join(dir, name);
    const source = await readFile(file, 'utf8');

    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(name)) {
      fail(file, 'migration filename must be <14-digit timestamp>_<snake_case>.sql');
    }

    // Unbalanced dollar quoting silently swallows the rest of a migration.
    const dollars = (source.match(/\$\$/g) || []).length;
    if (dollars % 2 !== 0) fail(file, `unbalanced $$ quoting (${dollars} delimiters)`);

    const parens = (source.match(/\(/g) || []).length - (source.match(/\)/g) || []).length;
    if (parens !== 0) fail(file, `unbalanced parentheses (${parens > 0 ? parens + ' unclosed' : -parens + ' extra'})`);

    for (const [pattern, message] of [
      [/\bdrop\s+table\s+(?!if\s+exists\s+_)/i, 'DROP TABLE in a migration — data loss risk; use a deprecation step'],
      [/\bdrop\s+schema\b/i, 'DROP SCHEMA in a migration'],
      [/\btruncate\b/i, 'TRUNCATE in a migration'],
    ]) {
      const line = source.split('\n').findIndex((text) => pattern.test(text));
      if (line !== -1) fail(file, message, line + 1);
    }

    // Every function that touches user data should pin its search_path.
    // Comments are stripped first so prose about SECURITY DEFINER does not count.
    const code = source
      .split('\n')
      .filter((text) => !text.trimStart().startsWith('--'))
      .join('\n');
    const definers = [...code.matchAll(/security\s+definer/gi)].length;
    const searchPaths = [...code.matchAll(/set\s+search_path\s*=/gi)].length;
    if (definers > searchPaths) {
      fail(file, `${definers} SECURITY DEFINER function(s) but only ${searchPaths} set search_path`);
    }
  }

  return files.length;
}

/* ==========================================================================
   Edge Functions
   ========================================================================== */

async function checkFunctions() {
  const dir = path.join(ROOT, 'supabase', 'functions');
  const files = await walk(dir, (f) => f.endsWith('.ts')).catch(() => []);

  for (const file of files) {
    const source = await readFile(file, 'utf8');

    // A service-role client must never be built from a request-supplied key.
    if (/SERVICE_ROLE/.test(source) && !/Deno\.env\.get/.test(source)) {
      fail(file, 'service-role key referenced without Deno.env.get');
    }
    if (/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(source) && /SERVICE_ROLE/.test(source)) {
      notes.push(`${path.relative(ROOT, file)}: wildcard CORS on a privileged function`);
    }
    for (const match of source.matchAll(/from\s+['"](https:\/\/esm\.sh\/[^'"]+)['"]/g)) {
      if (!/@\d/.test(match[1])) fail(file, `unpinned import: ${match[1]}`);
    }
  }

  return files.length;
}

/* ==========================================================================
   Report
   ========================================================================== */

const groups = [
  ['js', 'JavaScript', checkJs],
  ['design', 'Design rules', checkDesign],
  ['html', 'HTML', checkHtml],
  ['sql', 'Migrations', checkSql],
  ['functions', 'Edge Functions', checkFunctions],
];

let checked = 0;
for (const [id, label, fn] of groups) {
  if (!wants(id)) continue;
  const before = problems.length;
  const count = await fn();
  checked += count;
  const failures = problems.length - before;
  const mark = failures ? 'FAIL' : ' ok ';
  console.log(`[${mark}] ${label.padEnd(16)} ${String(count).padStart(3)} file(s)${failures ? `  ${failures} problem(s)` : ''}`);
}

if (notes.length) {
  console.log(`\n${notes.length} note(s):`);
  for (const note of notes.slice(0, 20)) console.log(`  · ${note}`);
  if (notes.length > 20) console.log(`  · …and ${notes.length - 20} more`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n`);
  for (const problem of problems) {
    console.log(`  ${problem.file}${problem.line ? `:${problem.line}` : ''}\n    ${problem.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\nAll checks passed across ${checked} file(s).`);
}
