import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { categoryLook } from './category-look.js';
import { wishlistButton, loadWishlist, paintWishlist, wireWishlist } from './wishlist.js';
import { paintSkeletonGrid } from './uikit.js';
import { AD_LISTING_COLS, stripAdListings } from './ad-listing.js';

let allProducts = []; // full published catalogue — powers the category-specific rails + jumbotron counts
let managedCategories = [];
const RAIL_LIMIT = 10;

// ============================================================
// Rating stars (real data only — hidden entirely when a product has no
// reviews yet, rather than rendering a fabricated 0-star row).
// ============================================================
function ratingStarsHtml(ratingAverage, ratingCount) {
  if (!ratingCount) return '';
  const rounded = Math.round(Number(ratingAverage) || 0);
  const stars = Array.from({ length: 5 }, (_, i) =>
    `<i data-lucide="star" width="12" height="12" class="${i < rounded ? '' : 'is-empty'}"></i>`).join('');
  return `
    <span class="catalog-card__rating-row">
      <span class="catalog-card__stars">${stars}</span>
      <span class="catalog-card__rating-count">(${ratingCount})</span>
    </span>`;
}

// ============================================================
// Badge — one clear label per card, derived from real product fields.
// `context` lets a rail assert its own reason ("New", "Bestseller"...)
// when the card is already known to belong to that rail; otherwise the
// badge is inferred from the product's own fields.
// ============================================================
function badgeHtml(p, context) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  if (hasDiscount) {
    const pct = Math.round((1 - Number(p.price) / Number(p.original_price)) * 100);
    return `<span class="catalog-card__badge catalog-card__badge--deal">−${pct}%</span>`;
  }
  if (p.is_featured) return `<span class="catalog-card__badge catalog-card__badge--featured">Featured</span>`;
  if (context === 'bestseller' && p.purchase_count > 0) return `<span class="catalog-card__badge catalog-card__badge--bestseller">Bestseller</span>`;
  const ageDays = (Date.now() - new Date(p.created_at || p.published_at || 0).getTime()) / 86400000;
  if (context === 'new' || ageDays <= 21) return `<span class="catalog-card__badge catalog-card__badge--new">New</span>`;
  return '';
}

// ============================================================
// Single Product Card HTML Generator
// ============================================================
function createProductCardHtml(p, context) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const canonicalSlug = p.slug || p.id;
  const ratingAverage = p.rating_average ?? (p.rating_count ? Number(p.rating_sum) / Number(p.rating_count) : null);

  return `
    <article class="scroll-card-item catalog-card is-clickable" data-product-id="${p.id}">
      <span class="catalog-card__media">
        ${
          p.cover_url
            ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
            : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`
        }
        <span class="catalog-card__badges">${badgeHtml(p, context)}</span>
      </span>

      ${wishlistButton(p.id, p.title)}

      <span class="catalog-card__body">
        <span class="catalog-card__cat">${escapeHtml(p.category || 'General')}</span>
        <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        ${ratingStarsHtml(ratingAverage, p.rating_count)}
      </span>

      <span class="catalog-card__foot">
        <span class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency || 'USD'} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency || 'USD'} ${Number(p.price).toFixed(2)}</strong>
        </span>
        <span class="catalog-card__go" aria-hidden="true">${icon('arrow-right', 15)}</span>
      </span>

      <a class="catalog-card__link" href="./product/${encodeURIComponent(canonicalSlug)}">
        <span class="sr-only">${escapeHtml(p.title)}</span>
      </a>
    </article>`;
}

function paintSection(id, countClass, items, context) {
  const container = document.querySelector(`#${id}`);
  const countEl = document.querySelector(countClass);
  if (countEl) countEl.textContent = items.length;
  if (!container) return;

  // A rail with nothing in it isn't worth a "coming soon" placeholder — it's
  // one more empty box competing with the rails that do have products, so
  // the whole section (heading, prev/next, "see all") disappears with it.
  const section = container.closest('section');
  section?.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;

  container.innerHTML = items.map((p) => createProductCardHtml(p, context)).join('');
}

// ============================================================
// Category-specific rails, sliced from the full published catalogue
// (storefront_rails covers the algorithmic ones — featured/new/bestseller/
// trending/deals — but has no notion of category, so those five stay
// client-side over `allProducts`).
// ============================================================
function renderCategoryRails() {
  const byCategory = (needle) => allProducts.filter((p) => (p.category || '').toLowerCase().includes(needle)).slice(0, RAIL_LIMIT);

  paintSection('scroll-ebooks', '.count-ebooks', byCategory('ebook'));
  paintSection('scroll-software', '.count-software', [
    ...allProducts.filter((p) => (p.category || '').toLowerCase().includes('software') || (p.category || '').toLowerCase().includes('tool')),
  ].slice(0, RAIL_LIMIT));
  paintSection('scroll-templates', '.count-templates', [
    ...allProducts.filter((p) => (p.category || '').toLowerCase().includes('template') || (p.category || '').toLowerCase().includes('theme')),
  ].slice(0, RAIL_LIMIT));
  paintSection('scroll-courses', '.count-courses', [
    ...allProducts.filter((p) => (p.category || '').toLowerCase().includes('course') || (p.category || '').toLowerCase().includes('masterclass')),
  ].slice(0, RAIL_LIMIT));
  paintSection('scroll-audio', '.count-audio', [
    ...allProducts.filter((p) => (p.category || '').toLowerCase().includes('audio') || (p.category || '').toLowerCase().includes('media')),
  ].slice(0, RAIL_LIMIT));

  wireHorizontalScrollButtons();
  paintWishlist(document);
  renderIcons();
}

// ============================================================
// Algorithmic rails — one call to storefront_rails(), server-computed
// (featured/new/best_selling/trending/deals), so ordering and rating
// averages match exactly what every other screen in the app will show.
// ============================================================
async function renderRailSections() {
  ['scroll-featured', 'scroll-new', 'scroll-bestsellers', 'scroll-trending', 'scroll-deals']
    .forEach((id) => paintSkeletonGrid(document.querySelector(`#${id}`), 4));

  const { data, error } = await supabase.rpc('storefront_rails', { p_limit: RAIL_LIMIT });
  if (error || !data) {
    console.error('storefront_rails failed:', error);
    // Fall back to what we already have client-side, so the page never sits empty.
    paintSection('scroll-featured', '.count-featured', allProducts.filter((p) => p.is_featured).slice(0, RAIL_LIMIT), 'featured');
    paintSection('scroll-new', '.count-new', [...allProducts].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, RAIL_LIMIT), 'new');
    paintSection('scroll-bestsellers', '.count-bestsellers', [...allProducts].sort((a, b) => (b.purchase_count || 0) - (a.purchase_count || 0)).slice(0, RAIL_LIMIT), 'bestseller');
    paintSection('scroll-trending', '.count-trending', [...allProducts].slice(0, RAIL_LIMIT));
    paintSection('scroll-deals', '.count-deals', allProducts.filter((p) => p.original_price && Number(p.original_price) > Number(p.price)));
  } else {
    paintSection('scroll-featured', '.count-featured', data.featured || [], 'featured');
    paintSection('scroll-new', '.count-new', data.new || [], 'new');
    paintSection('scroll-bestsellers', '.count-bestsellers', data.best_selling || [], 'bestseller', 'Sales are just getting started — check back soon.');
    paintSection('scroll-trending', '.count-trending', data.trending || []);
    paintSection('scroll-deals', '.count-deals', data.deals || [], null, 'No active deals right now — check back soon.');
  }

  wireHorizontalScrollButtons();
  paintWishlist(document);
  renderIcons();
}

// ============================================================
// Horizontal Scroll Button Arrow Controls
// ============================================================
function wireHorizontalScrollButtons() {
  document.querySelectorAll('[data-scroll-left]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const targetId = btn.dataset.scrollLeft;
      const target = document.querySelector(`#${targetId}`);
      target?.scrollBy({ left: -340, behavior: 'smooth' });
    };
  });

  document.querySelectorAll('[data-scroll-right]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const targetId = btn.dataset.scrollRight;
      const target = document.querySelector(`#${targetId}`);
      target?.scrollBy({ left: 340, behavior: 'smooth' });
    };
  });
}

// ============================================================
// Category tile grid — icon-circle cards fed by real category rows +
// live product counts (categories.js keeps the icon/accent lookup so the
// dedicated /categories page and this grid cannot drift apart).
// ============================================================
function categoryTileHtml(category) {
  const href = `./store?category=${encodeURIComponent(category.name)}`;
  return `
    <a class="cattile" href="${href}">
      <span class="cattile__icon">${icon(category.icon, 22)}</span>
      <span>
        <span class="cattile__name" style="display:block">${escapeHtml(category.name)}</span>
        <span class="cattile__count" style="display:block">${category.count.toLocaleString()} ${category.count === 1 ? 'item' : 'items'}</span>
      </span>
    </a>`;
}

function renderCategoryTiles(host, categories) {
  if (!host) return;
  const ranked = [...categories].sort((a, b) => b.count - a.count);
  host.innerHTML = ranked.map(categoryTileHtml).join('') + `
    <a class="cattile__more" href="./categories">
      ${icon('layout-grid', 20)}
      <span>View all categories</span>
    </a>`;
  renderIcons();
}

// ============================================================
// Hero visual — a real collage of current covers, not a stock illustration.
// ============================================================
function renderHeroVisual(products) {
  const host = document.querySelector('#hero-visual');
  if (!host) return;
  const covers = products.filter((p) => p.cover_url).slice(0, 4);
  if (!covers.length) {
    host.innerHTML = `<span style="display:grid;place-items:center;height:100%;color:var(--ink-muted)">${icon('sparkles', 40)}</span>`;
    renderIcons();
    return;
  }
  host.style.display = 'grid';
  host.style.gridTemplateColumns = '1fr 1fr';
  host.style.gap = '2px';
  host.innerHTML = covers.map((p) => `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">`).join('');
}

// ============================================================
// Main Storefront Load
// ============================================================
async function load() {
  mountHeader();
  mountFooter();

  try {
    const [productsResult, categoriesResult] = await Promise.all([
      supabase.from('products')
        .select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published,is_featured,purchase_count,rating_sum,rating_count,created_at' + AD_LISTING_COLS)
        .eq('is_published', true).order('created_at', { ascending: false }),
      supabase.from('categories').select('name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name'),
    ]);
    const { data, error } = productsResult;
    managedCategories = categoriesResult.data || [];

    if (error) {
      console.error('Error loading products:', error);
    } else {
      allProducts = stripAdListings(data || []);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }

  renderHeroVisual(allProducts.filter((p) => p.is_featured).length ? allProducts.filter((p) => p.is_featured) : allProducts);

  // Category tiles — counts come from the same product list already loaded.
  try {
    const counts = new Map();
    for (const product of allProducts) {
      const key = product.category || 'General';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const withCounts = managedCategories.map((category) => ({
      ...category,
      count: counts.get(category.name) || 0,
      ...categoryLook(category.slug),
    }));
    // Top 9 categories by live product count — the grid renders these plus a
    // trailing "View all" card (9 + 1). How many of the 9 are actually visible
    // is capped per breakpoint in CSS (`.cattile-grid` rules): the full 9 only
    // on lg, fewer as the grid narrows.
    const topCategories = [...withCounts].sort((a, b) => b.count - a.count).slice(0, 9);
    renderCategoryTiles(document.querySelector('#category-jumbotron'), topCategories);
  } catch (error) {
    console.error('Category tiles failed:', error);
  }

  await loadWishlist();
  wireWishlist(document.body);
  await renderRailSections();
  renderCategoryRails();
  renderIcons();
  finishPageLoader();
}

// Newsletter Subscription Form
document.querySelector('#subscribe-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = new FormData(e.currentTarget).get('email');
  const button = e.currentTarget.querySelector('button');
  setButtonLoading(button, true, 'Subscribing…');
  const { error } = await supabase.from('subscribers').insert({ email });
  setButtonLoading(button, false);
  const status = document.querySelector('#subscribe-status');
  if (error && error.code !== '23505') {
    if (status) {
      status.textContent = 'Unable to subscribe. Please try again.';
      status.className = 'status-line error';
    }
    toast('Unable to subscribe. Please try again.', 'error');
  } else {
    if (status) {
      status.textContent = 'Thank you for subscribing to DigiStore updates!';
      status.className = 'status-line success';
    }
    toast('Subscribed! Watch your inbox for new releases.', 'success');
    e.currentTarget.reset();
  }
});

load();
