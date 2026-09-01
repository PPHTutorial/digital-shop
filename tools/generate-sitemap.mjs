#!/usr/bin/env node
/**
 * Rebuilds sitemap.xml from live Supabase data so it can never drift from the
 * published catalogue and journal.
 *
 *   node tools/generate-sitemap.mjs [--check]
 *
 * Credentials come from the environment (SUPABASE_URL + SUPABASE_ANON_KEY) or,
 * failing that, from the committed js/config.js — the same public anon key the
 * browser already uses. Only `is_published` products and `published` posts are
 * anon-readable under RLS, which is exactly what belongs in a sitemap.
 *
 * --check exits non-zero when the committed sitemap.xml is stale, so
 * `npm run check` keeps the deploy honest.
 *
 * Posts and products are path-routed (/blog/<slug>, /product/<slug>) and
 * prerendered by tools/prerender.mjs; ?doc= / ?category= pages stay query-
 * routed. URL shapes here must match supabase/functions/sitemap/index.ts and
 * the rel=canonical each page emits (js/ui.js setCanonical). Keep them in step.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'sitemap.xml');
const CHECK = process.argv.slice(2).includes('--check');

const SITE = (process.env.PUBLIC_SITE_URL || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

const STATIC_PATHS = [
  { loc: '/', priority: '1.0', changefreq: 'daily' },
  { loc: '/store', priority: '0.9', changefreq: 'daily' },
  { loc: '/blog', priority: '0.8', changefreq: 'daily' },
  { loc: '/leaderboard', priority: '0.6', changefreq: 'daily' },
  { loc: '/categories', priority: '0.6', changefreq: 'weekly' },
  { loc: '/about', priority: '0.7', changefreq: 'monthly' },
  { loc: '/contact', priority: '0.7', changefreq: 'monthly' },
  { loc: '/support', priority: '0.7', changefreq: 'monthly' },
  { loc: '/affiliate', priority: '0.7', changefreq: 'monthly' },
];

const CATEGORY_NAMES = [
  'Ebooks & Guides', 'Software & Tools', 'Templates & Themes',
  'Online Courses', 'Audio & Media', 'Design & Graphics',
];

const LEGAL_DOCS = [
  'terms', 'privacy', 'cookies', 'refunds', 'licence', 'acceptable-use',
  'dispute-resolution', 'ip-dmca', 'vendor-agreement', 'store-policy', 'payouts',
];

const xmlEscape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));

/** Read the public Supabase URL + anon key from env, else from js/config.js. */
async function resolveCredentials() {
  let url = process.env.SUPABASE_URL?.trim();
  let key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (url && key) return { url: url.replace(/\/$/, ''), key };

  const config = await readFile(path.join(ROOT, 'js', 'config.js'), 'utf8');
  url ||= config.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
  key ||= config.match(/SUPABASE_ANON_KEY:\s*\n?\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('Could not resolve Supabase URL / anon key from env or js/config.js.');
  return { url: url.replace(/\/$/, ''), key };
}

async function fetchRows({ url, key }, query) {
  const res = await fetch(`${url}/rest/v1/${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase REST ${res.status}: ${await res.text()}`);
  return res.json();
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  const parts = [`<loc>${xmlEscape(loc)}</loc>`];
  if (lastmod) parts.push(`<lastmod>${lastmod}</lastmod>`);
  if (changefreq) parts.push(`<changefreq>${changefreq}</changefreq>`);
  if (priority) parts.push(`<priority>${priority}</priority>`);
  return `  <url>${parts.join('')}</url>`;
}

async function build() {
  const creds = await resolveCredentials();
  const [products, posts] = await Promise.all([
    fetchRows(creds, 'products?select=slug,id,updated_at&is_published=eq.true'),
    fetchRows(creds, 'blog_posts?select=slug,updated_at&status=eq.published'),
  ]);

  const entries = [
    ...STATIC_PATHS.map((p) => ({ ...p, loc: `${SITE}${p.loc}` })),
    ...CATEGORY_NAMES.map((name) => ({
      loc: `${SITE}/store?category=${encodeURIComponent(name)}`,
      changefreq: 'weekly',
      priority: '0.6',
    })),
    ...LEGAL_DOCS.map((doc) => ({
      loc: `${SITE}/legal?doc=${doc}`,
      changefreq: 'yearly',
      priority: '0.3',
    })),
    ...products.map((row) => ({
      loc: `${SITE}/product/${encodeURIComponent(row.slug || row.id)}`,
      lastmod: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
      changefreq: 'weekly',
      priority: '0.9',
    })),
    ...posts.map((row) => ({
      loc: `${SITE}/blog/${encodeURIComponent(row.slug)}`,
      lastmod: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
      changefreq: 'weekly',
      priority: '0.7',
    })),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + `${entries.map(urlEntry).join('\n')}\n`
    + `</urlset>\n`;
}

const next = await build();

if (CHECK) {
  const current = await readFile(OUT_FILE, 'utf8').catch(() => '');
  // lastmod timestamps move on every content edit; compare only the URL set.
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort().join('\n');
  if (locs(current) !== locs(next)) {
    console.error('sitemap.xml is out of date. Run: npm run sitemap');
    process.exitCode = 1;
  } else {
    console.log('sitemap.xml URL set is current.');
  }
} else {
  await writeFile(OUT_FILE, next);
  const count = (next.match(/<url>/g) || []).length;
  console.log(`sitemap.xml written — ${count} URLs.`);
}
