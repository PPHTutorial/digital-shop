#!/usr/bin/env node
/**
 * Pre-renders one real HTML file per published blog post and product so
 * crawlers (and the first paint) get a complete document — unique <title>,
 * meta, canonical, structured data, and the article/description body — instead
 * of the empty client-hydrated shell.
 *
 *   node tools/prerender.mjs [--check]
 *
 * Output:
 *   blog/<slug>.html      served by GitHub Pages at /blog/<slug>
 *   product/<slug>.html   served at /product/<slug>
 *
 * GitHub Pages resolves `foo.html` at the extensionless `/foo` and 301s
 * `/foo.html` -> `/foo`, so nothing in the address bar ever shows `.html`.
 *
 * The page's own JS still runs and hydrates interactivity (likes, comments,
 * cart, reviews); it now reads the slug from the path, detects the
 * prerendered body, and skips re-injecting it. Content edited in Supabase
 * between deploys is refreshed live by that hydration and baked in on the
 * next deploy (scripts/deploy.ps1 runs this).
 *
 * Credentials: SUPABASE_URL + SUPABASE_ANON_KEY from the environment, else the
 * committed public values in js/config.js. Only published rows are readable.
 *
 * --check exits non-zero when the set of generated files no longer matches the
 * published rows (used by CI / npm run check).
 */

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.slice(2).includes('--check');
const SITE = (process.env.PUBLIC_SITE_URL || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

/* ==========================================================================
   Supabase (public REST, anon key — same access the browser has)
   ========================================================================== */

async function resolveCredentials() {
  let url = process.env.SUPABASE_URL?.trim();
  let key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!url || !key) {
    const config = await readFile(path.join(ROOT, 'js', 'config.js'), 'utf8');
    url ||= config.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
    key ||= config.match(/SUPABASE_ANON_KEY:\s*\n?\s*'([^']+)'/)?.[1];
  }
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

/* ==========================================================================
   Tiny helpers — escapeHtml and renderMarkdown are copied verbatim from
   js/ui.js (which can't be imported here: it pulls in the browser Supabase
   client at module load). Keep the two in sync.
   ========================================================================== */

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]
));

function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const inline = (line) => escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) return '';
    const heading = lines.length === 1 && lines[0].match(/^(#{1,3})\s+(.*)$/);
    if (heading) { const lvl = heading[1].length + 1; return `<h${lvl}>${inline(heading[2])}</h${lvl}>`; }
    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

/* ==========================================================================
   Social links — baked from site_settings.social so the static blog/product
   pages ship real, crawlable profile links (rel="me" in <head> + a visible
   footer nav) instead of waiting for js/ui.js mountFooter() to hydrate them.
   Keys/labels mirror SOCIAL_LINKS in js/ui.js. `social` is `{}` until an admin
   fills handles in on the Settings screen — until then this is a no-op.
   ========================================================================== */

const SOCIAL_ORDER = [
  ['twitter', 'X / Twitter'], ['instagram', 'Instagram'], ['facebook', 'Facebook'],
  ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['tiktok', 'TikTok'],
  ['github', 'GitHub'], ['discord', 'Discord'], ['whatsapp', 'WhatsApp'],
];

function injectSocial(shell, social) {
  const entries = SOCIAL_ORDER.filter(([key]) => social && social[key]);
  if (!entries.length) return shell;

  const headLinks = entries
    .map(([key]) => `  <link rel="me" href="${escapeHtml(social[key])}">`)
    .join('\n');

  const footerNav = `<nav class="footer-social" aria-label="DigiStore on social media">`
    + entries
      .map(([key, label]) =>
        `<a href="${escapeHtml(social[key])}" target="_blank" rel="noopener noreferrer me" `
        + `aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${escapeHtml(label)}</a>`)
      .join('')
    + `</nav>`;

  return shell
    .replace('</head>', `${headLinks}\n</head>`)
    .replace('<footer id="site-footer"></footer>', `<footer id="site-footer">${footerNav}</footer>`);
}

const readTime = (html) => {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 200))} min read`;
};
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Replace an exact substring once; throw if it isn't there (shell drifted). */
function cut(html, needle, replacement, where) {
  if (!html.includes(needle)) throw new Error(`prerender: "${where}" anchor not found — the shell changed.\n  looking for: ${needle}`);
  return html.replace(needle, replacement);
}

/**
 * A generated page lives one directory deep and its header/footer links are
 * injected at runtime as "./x". Rewrite the static "./x" refs to root-absolute
 * and add <base href="/"> so the runtime ones resolve too. Fragment links must
 * then carry the page path so they don't jump to "/".
 */
function reroot(html, cleanPath) {
  return html
    .replace(/(href|src)="\.\//g, '$1="/')
    .replace(/href="#(?!")/g, `href="${cleanPath}#`)
    .replace('<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n  <base href="/">');
}

const PAGE_LOADER = `  <div id="page-loader" class="page-loader">
    <div class="loader-card">
      <div class="shimmer logo"></div>
      <div class="shimmer hero"></div>
      <div class="shimmer short"></div>
    </div>
  </div>

`;

function headMeta(html, { title, description, canonical, jsonLd }) {
  const desc = escapeHtml(description || '');
  const before = html;
  html = html
    .replace(`<link rel="canonical" href="${SITE}/blog">`, `<link rel="canonical" href="${canonical}">`)
    .replace(`<link rel="canonical" href="${SITE}/product">`, `<link rel="canonical" href="${canonical}">`);
  if (html === before) throw new Error('prerender: canonical <link> anchor not found — the shell changed.');
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(">)/, `$1${desc}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, `$1${escapeHtml(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, `$1${desc}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(">)/, `$1${canonical}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(">)/, `$1${escapeHtml(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(">)/, `$1${desc}$2`)
    // \u003c so a stray "</script>" in any field can't break out of the block.
    .replace('</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n</head>`);
  return html;
}

/* ==========================================================================
   Blog post  ->  blog/<slug>.html
   ========================================================================== */

function renderPost(shell, post) {
  const clean = `${SITE}/blog/${encodeURIComponent(post.slug)}`;
  const body = post.content || '';
  let html = shell.replace(PAGE_LOADER, '');

  html = headMeta(html, {
    title: `${post.title} | DigiStore Journal`,
    description: post.excerpt,
    canonical: clean,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt || '',
      image: post.cover_url || `${SITE}/img/brand/og-image.png`,
      datePublished: post.published_at,
      dateModified: post.updated_at || post.published_at,
      author: { '@type': 'Organization', name: 'DigiStore', url: SITE },
      publisher: { '@type': 'Organization', name: 'DigiStore', logo: { '@type': 'ImageObject', url: `${SITE}/img/brand/icon-192.png` } },
      mainEntityOfPage: clean,
    },
  });

  html = cut(html, '<section id="blog-hero" class="page-hero">', '<section id="blog-hero" class="page-hero hidden">', 'blog-hero');
  html = cut(html, '<section id="blog-listing">', '<section id="blog-listing" class="hidden">', 'blog-listing');
  html = cut(html, '<section id="blog-article-wrap" class="hidden">', '<section id="blog-article-wrap">', 'blog-article-wrap');
  html = cut(html, '<div id="blog-article-loading" class="legal-skel">', '<div id="blog-article-loading" class="legal-skel hidden">', 'blog-article-loading');
  html = cut(html, '<article id="blog-article-content" class="hidden">',
    `<article id="blog-article-content" data-prerendered="true" data-post-id="${escapeHtml(post.id)}">`, 'blog-article-content');
  html = cut(html, '<span id="blog-article-date" class="legal-effective"></span>',
    `<span id="blog-article-date" class="legal-effective">${escapeHtml(fmtDate(post.published_at))}</span>`, 'blog-article-date');
  html = cut(html, '<span id="blog-article-readtime" class="blog-article-readtime"></span>',
    `<span id="blog-article-readtime" class="blog-article-readtime">${escapeHtml(readTime(body))}</span>`, 'blog-article-readtime');
  html = cut(html, '<h1 id="blog-article-title" class="legal-title"></h1>',
    `<h1 id="blog-article-title" class="legal-title">${escapeHtml(post.title)}</h1>`, 'blog-article-title');
  if (post.cover_url) {
    html = cut(html, '<div id="blog-article-cover-wrap" class="blog-article-cover hidden"><img id="blog-article-cover" alt=""></div>',
      `<div id="blog-article-cover-wrap" class="blog-article-cover"><img id="blog-article-cover" alt="${escapeHtml(post.title)}" src="${escapeHtml(post.cover_url)}"></div>`,
      'blog-article-cover');
  }
  html = cut(html, '<div id="blog-article-html" class="legal-doc-body pd-markdown"></div>',
    `<div id="blog-article-html" class="legal-doc-body pd-markdown">${body}</div>`, 'blog-article-html');

  return reroot(html, `/blog/${encodeURIComponent(post.slug)}`);
}

/* ==========================================================================
   Product  ->  product/<slug>.html
   ========================================================================== */

function renderProduct(shell, p) {
  const clean = `${SITE}/product/${encodeURIComponent(p.slug)}`;
  const price = `${p.currency} ${Number(p.price).toFixed(2)}`;
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  let html = shell.replace(PAGE_LOADER, '');

  html = headMeta(html, {
    title: `${p.title} | DigiStore`,
    description: p.short_description,
    canonical: clean,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.title,
      description: p.short_description || '',
      image: p.cover_url || `${SITE}/img/brand/og-image.png`,
      category: p.category || undefined,
      brand: { '@type': 'Brand', name: 'DigiStore' },
      offers: {
        '@type': 'Offer', price: Number(p.price).toFixed(2), priceCurrency: p.currency,
        availability: 'https://schema.org/InStock', url: clean,
      },
      ...(Number(p.rating_count) > 0 ? {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: (Number(p.rating_sum) / Number(p.rating_count)).toFixed(1),
          reviewCount: p.rating_count,
        },
      } : {}),
    },
  });

  html = cut(html, '<div id="pd-content" class="hidden">', '<div id="pd-content" data-prerendered="true">', 'pd-content');
  html = cut(html, '<div id="pd-loading" class="pd-layout">', '<div id="pd-loading" class="pd-layout hidden">', 'pd-loading');
  html = cut(html, '<span id="pd-category" class="pd-cat-badge"></span>',
    `<span id="pd-category" class="pd-cat-badge">${escapeHtml(p.category || 'General')}</span>`, 'pd-category');
  html = cut(html, '<h1 id="pd-title" class="pd-title"></h1>',
    `<h1 id="pd-title" class="pd-title">${escapeHtml(p.title)}</h1>`, 'pd-title');
  html = cut(html, '<span id="pd-crumb-title"></span>',
    `<span id="pd-crumb-title">${escapeHtml(p.title)}</span>`, 'pd-crumb-title');
  html = cut(html, '<span id="pd-price-current" class="pd-price-current"></span>',
    `<span id="pd-price-current" class="pd-price-current">${escapeHtml(price)}</span>`, 'pd-price-current');
  if (hasDiscount) {
    html = cut(html, '<span id="pd-price-original" class="pd-price-original hidden"></span>',
      `<span id="pd-price-original" class="pd-price-original">${escapeHtml(`${p.currency} ${Number(p.original_price).toFixed(2)}`)}</span>`,
      'pd-price-original');
  }
  if (p.cover_url) {
    html = cut(html, '<div id="pd-gallery-main" class="pd-gallery-main"></div>',
      `<div id="pd-gallery-main" class="pd-gallery-main"><img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}"></div>`,
      'pd-gallery-main');
  }
  html = cut(html, '<div id="pd-description" class="pd-tab-body pd-markdown"></div>',
    `<div id="pd-description" class="pd-tab-body pd-markdown">${renderMarkdown(p.description)}</div>`, 'pd-description');

  return reroot(html, `/product/${encodeURIComponent(p.slug)}`);
}

/* ==========================================================================
   Drive
   ========================================================================== */

async function emptyDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function listGenerated(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.html')).sort();
  } catch {
    return [];
  }
}

const creds = await resolveCredentials();
const [posts, products, social, rawBlogShell, rawProductShell] = await Promise.all([
  fetchRows(creds, 'blog_posts?select=id,slug,title,excerpt,content,cover_url,published_at,updated_at&status=eq.published'),
  fetchRows(creds, 'products?select=id,slug,title,short_description,description,price,original_price,currency,cover_url,category,rating_sum,rating_count&is_published=eq.true'),
  fetchRows(creds, 'site_settings?select=social&id=eq.1').then((rows) => rows[0]?.social || {}).catch(() => ({})),
  readFile(path.join(ROOT, 'blog.html'), 'utf8').then((s) => s.replace(/\r\n/g, '\n')),
  readFile(path.join(ROOT, 'product.html'), 'utf8').then((s) => s.replace(/\r\n/g, '\n')),
]);

// Same handles on every page, so resolve them into the shells once.
const blogShell = injectSocial(rawBlogShell, social);
const productShell = injectSocial(rawProductShell, social);

const pages = [
  ...posts.filter((p) => p.slug).map((p) => ({ dir: 'blog', name: `${p.slug}.html`, html: renderPost(blogShell, p) })),
  ...products.filter((p) => p.slug).map((p) => ({ dir: 'product', name: `${p.slug}.html`, html: renderProduct(productShell, p) })),
];

if (CHECK) {
  const stale = [];
  for (const dir of ['blog', 'product']) {
    const want = new Set(pages.filter((p) => p.dir === dir).map((p) => p.name));
    for (const name of await listGenerated(path.join(ROOT, dir))) {
      if (!want.has(name)) stale.push(`${dir}/${name} (no longer published)`);
    }
  }
  for (const page of pages) {
    const current = await readFile(path.join(ROOT, page.dir, page.name), 'utf8').catch(() => null);
    if (current !== page.html) stale.push(`${page.dir}/${page.name}`);
  }
  if (stale.length) {
    console.error(`prerender out of date (${stale.length}) — run: npm run prerender`);
    for (const s of stale.slice(0, 15)) console.error(`  ${s}`);
    if (stale.length > 15) console.error(`  …and ${stale.length - 15} more`);
    process.exitCode = 1;
  } else {
    console.log(`prerender up to date — ${pages.length} pages.`);
  }
} else {
  await emptyDir(path.join(ROOT, 'blog'));
  await emptyDir(path.join(ROOT, 'product'));
  for (const page of pages) {
    await writeFile(path.join(ROOT, page.dir, page.name), page.html);
  }
  const blogCount = pages.filter((p) => p.dir === 'blog').length;
  console.log(`prerendered ${blogCount} posts -> blog/, ${pages.length - blogCount} products -> product/`);
}
