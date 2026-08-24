/**
 * Home page.
 *
 * Two round trips: one for the curated rails (`storefront_rails`) and one for
 * the CMS home-page document plus the category list. The previous version
 * fetched the whole catalog and sliced the same array ten different ways;
 * the rails are now genuinely different queries computed in the database.
 */

import { supabase } from './client.js';
import { $, html, raw, esc } from './dom.js';
import { icon } from './icons.js';
import { formatNumber } from './format.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy, initReveal } from './ui.js';
import { railSection, wireRails, wireShareButtons, productCard, productSkeleton } from './product-card.js';

initTheme();

const RAILS = {
  featured: { eyebrow: 'Editor’s picks', title: 'Featured', href: './store.html?sort=relevance' },
  new: { eyebrow: 'Just published', title: 'New arrivals', href: './store.html?sort=newest' },
  best_selling: { eyebrow: 'Most purchased', title: 'Best selling', href: './store.html?sort=best-selling' },
  trending: { eyebrow: 'Gaining attention', title: 'Trending now', href: './store.html?sort=best-selling' },
  deals: { eyebrow: 'Reduced', title: 'On sale', href: './store.html' },
  top_rated: { eyebrow: 'Highest rated', title: 'Top rated', href: './store.html' },
};

const DEFAULT_ORDER = ['featured', 'new', 'best_selling', 'deals', 'top_rated'];

/* ==========================================================================
   Data
   ========================================================================== */

async function loadHomeDocument() {
  const { data } = await supabase
    .from('cms_documents')
    .select('title,published')
    .eq('type', 'homepage')
    .not('published', 'is', null)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.published ?? null;
}

async function loadCategories() {
  const { data } = await supabase
    .from('categories')
    .select('name,slug')
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  return data || [];
}

async function loadRails() {
  const { data, error } = await supabase.rpc('storefront_rails', { p_limit: 12 });
  if (error) throw new Error(error.message);
  return data || {};
}

async function loadCounts() {
  const [{ count: products }, { count: orders }] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_published', true),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid'),
  ]);
  return { products: products ?? 0, orders: orders ?? 0 };
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function paintHero(home, counts, spotlight) {
  const hero = $('#hero');
  if (!home) {
    // Without a published CMS document the hero is simply not shown, rather
    // than rendering placeholder copy that looks like a mistake.
    hero.hidden = true;
    return;
  }

  hero.hidden = false;
  $('[data-hero-eyebrow]').textContent = home.hero_eyebrow || 'Digital catalog';
  $('[data-hero-title]').textContent = home.hero_title || '';
  $('[data-hero-body]').textContent = home.hero_body || '';

  const primary = $('[data-hero-primary]');
  primary.textContent = home.hero_primary_label || 'Browse the catalog';
  primary.href = home.hero_primary_href || './store.html';

  const secondary = $('[data-hero-secondary]');
  if (home.hero_secondary_label) {
    secondary.hidden = false;
    secondary.textContent = home.hero_secondary_label;
    secondary.href = home.hero_secondary_href || './support.html';
  } else {
    secondary.hidden = true;
  }

  $('[data-fact-products]').textContent = formatNumber(counts.products);
  $('[data-fact-orders]').textContent = formatNumber(counts.orders);

  const aside = $('[data-hero-aside]');
  aside.innerHTML = spotlight
    ? productCard(spotlight, { compact: true })
    : '';
}

function paintRails(data, order) {
  const container = $('#rails');
  const sections = order
    .filter((key) => RAILS[key] && data[key]?.length)
    .map((key) => railSection({ id: key, ...RAILS[key], items: data[key] }));

  container.innerHTML = sections.length
    ? sections.join('')
    : html`
        <div class="empty">
          ${raw(icon('package'))}
          <p class="empty__title">The catalog is empty</p>
          <p class="empty__body">
            Nothing has been published yet. An administrator can add the first product from the admin console.
          </p>
        </div>
      `;
}

function paintBand(home) {
  const band = $('#band');
  if (!home?.band_title) {
    band.hidden = true;
    return;
  }
  band.hidden = false;
  $('[data-band-title]').textContent = home.band_title;
  $('[data-band-body]').textContent = home.band_body || '';
}

/* ==========================================================================
   Newsletter
   ========================================================================== */

function wireSubscribe() {
  const form = $('#subscribe-form');
  const status = $('#subscribe-status');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = new FormData(form).get('email')?.toString().trim();
    const button = form.querySelector('button');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      status.textContent = 'Enter a valid email address.';
      status.className = 'status status--error';
      return;
    }

    setBusy(button, true, 'Subscribing…');
    const { error } = await supabase.from('subscribers').insert({ email });
    setBusy(button, false);

    // 23505 is a duplicate — from the subscriber's point of view that is success.
    if (error && error.code !== '23505') {
      status.textContent = 'That did not go through. Please try again.';
      status.className = 'status status--error';
      return;
    }

    status.textContent = 'Subscribed. Watch for the next release note.';
    status.className = 'status status--ok';
    form.reset();
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function main() {
  $('#rail-boot').innerHTML = productSkeleton(5);
  mountFooter();
  wireSubscribe();
  wireRails(document);
  wireShareButtons(document);

  const [categories, home, counts] = await Promise.all([
    loadCategories(),
    loadHomeDocument().catch(() => null),
    loadCounts().catch(() => ({ products: 0, orders: 0 })),
  ]);

  await mountHeader({ categories });

  try {
    const rails = await loadRails();
    const order = Array.isArray(home?.rails) && home.rails.length ? home.rails : DEFAULT_ORDER;
    const spotlight = rails.featured?.[0] || rails.new?.[0] || null;

    paintHero(home, counts, spotlight);
    paintRails(rails, order);
    paintBand(home);
    initReveal();
  } catch (error) {
    $('#rails').innerHTML = html`
      <div class="alert alert--danger">
        ${raw(icon('alertCircle'))}
        <span>
          <span class="alert__title">The catalog could not be loaded</span>
          ${esc(error.message)}
        </span>
      </div>
    `;
  }

  bootDone();
}

main().catch((error) => {
  console.error(error);
  toast('Something went wrong loading the page.', 'error');
  bootDone();
});
