import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, toast } from './ui.js';
import { loadServableCampaigns, attachAdTracking, promoteSponsored } from './ads.js';
import { enhanceSelect } from './select.js';

let adCampaigns = new Map();
let categorySelect = null;

let allProducts = [];
let managedCategories = [];
const params = new URLSearchParams(window.location.search);
let activeCategory = params.get('category') || 'all';
let activeSearchQuery = params.get('search') || '';
let activeSort = 'newest';
const PAGE_SIZE = 12;
let visibleCount = PAGE_SIZE;

const grid = document.querySelector('#product-grid');
const loadMoreContainer = document.querySelector('#load-more-container');
const loadMoreBtn = document.querySelector('#load-more-btn');
const searchInput = document.querySelector('#store-search-input');
const sortSelect = document.querySelector('#store-sort-select');
if (sortSelect) enhanceSelect(sortSelect, { label: 'Sort products by' });

/** Human-readable file size, e.g. "2.4 MB". */
function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * The small facts row under the title. Each entry only appears when the
 * product actually carries that data, so the row never renders half-empty.
 */
function cardMetaHtml(p) {
  const bits = [];

  if (Number(p.rating_count) > 0) {
    const average = (Number(p.rating_sum) / Number(p.rating_count)).toFixed(1);
    bits.push(
      `<span class="catalog-card__meta-item catalog-card__rating">
         <i data-lucide="star" width="12" height="12"></i>${average}
         <span class="text-slate-400 font-semibold">(${Number(p.rating_count)})</span>
       </span>`
    );
  }

  if (p.file_type) {
    bits.push(`<span class="catalog-card__meta-item">${escapeHtml(String(p.file_type).toUpperCase())}</span>`);
  }

  const size = formatFileSize(p.file_size_bytes);
  if (size) bits.push(`<span class="catalog-card__meta-item">${size}</span>`);

  if (Number(p.purchase_count) > 0) {
    const count = Number(p.purchase_count);
    bits.push(`<span class="catalog-card__meta-item">${count.toLocaleString()} sold</span>`);
  }

  if (!bits.length) return '';
  return `<div class="catalog-card__meta">${bits.join('<span class="catalog-card__meta-dot">·</span>')}</div>`;
}

function createCardHtml(p) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
  const href = `./checkout.html?product=${encodeURIComponent(p.slug || p.id)}`;
  const blurb = p.short_description || p.description || '';

  return `
    <article class="catalog-card" data-product-id="${p.id}">
      <a href="${href}" class="catalog-card__media" aria-label="${escapeHtml(p.title)}">
        ${
          p.cover_url
            ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
            : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`
        }
        <span class="catalog-card__badges">
          ${p.is_featured ? `<span class="catalog-card__badge catalog-card__badge--featured">Featured</span>` : ''}
          ${hasDiscount ? `<span class="catalog-card__badge catalog-card__badge--sale">−${discountPct}%</span>` : ''}
        </span>
      </a>

      <button type="button" class="catalog-card__share share-product-btn" data-share-url="${encodeURIComponent(p.slug || p.id)}" title="Share product link" aria-label="Share this product">
        <i data-lucide="share-2" width="14" height="14"></i>
      </button>

      <div class="catalog-card__body">
        <span class="catalog-card__cat">${escapeHtml(p.category || 'General')}</span>
        <h3 class="catalog-card__title"><a href="${href}">${escapeHtml(p.title)}</a></h3>
        ${blurb ? `<p class="catalog-card__blurb">${escapeHtml(blurb)}</p>` : ''}
        ${cardMetaHtml(p)}
      </div>

      <div class="catalog-card__foot">
        <div class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
        </div>
        <a class="catalog-card__cta" href="${href}">
          Get product<i data-lucide="arrow-right" width="14" height="14"></i>
        </a>
      </div>
    </article>`;
}

function getFilteredList() {
  let list = [...allProducts];

  if (activeCategory !== 'all') {
    list = list.filter((p) => (p.category || 'General').toLowerCase() === activeCategory.toLowerCase());
  }

  if (activeSearchQuery.trim()) {
    const q = activeSearchQuery.toLowerCase().trim();
    list = list.filter((p) => (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  }

  if (activeSort === 'newest') {
    list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } else if (activeSort === 'price-low') {
    list.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  } else if (activeSort === 'price-high') {
    list.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  } else if (activeSort === 'title') {
    list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  // Sponsored products lift to the front of the default view only. An explicit
  // sort (price, title) is the shopper's instruction and paid placement must
  // not override it.
  if (activeSort === 'newest') {
    list = promoteSponsored(list, adCampaigns);
  }

  return list;
}

function renderCatalog() {
  if (!grid) return;
  const filtered = getFilteredList();

  document.querySelector('#product-count').textContent = `${filtered.length} product${filtered.length === 1 ? '' : 's'} available`;

  const headingEl = document.querySelector('#store-heading');
  if (headingEl) {
    headingEl.textContent = activeCategory === 'all' ? 'All Products' : activeCategory;
  }

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="col-span-full py-16 text-center bg-white rounded-2xl border border-slate-200 p-8 space-y-3">
        <div class="text-4xl">🔍</div>
        <h3 class="font-black text-xl text-[#142c55]">No products found</h3>
        <p class="text-xs text-slate-500 max-w-sm mx-auto">No products matched your selected criteria. Try adjusting your filters or search keywords.</p>
        <button type="button" id="reset-filters-btn" class="button button-primary !min-h-9 !px-4 text-xs font-bold">Clear All Filters</button>
      </div>`;
    document.querySelector('#reset-filters-btn')?.addEventListener('click', () => {
      activeCategory = 'all';
      activeSearchQuery = '';
      if (searchInput) searchInput.value = '';
      renderPills();
      renderCatalog();
    });
    loadMoreContainer?.classList.add('hidden');
    return;
  }

  const subset = filtered.slice(0, visibleCount);
  grid.innerHTML = subset.map(createCardHtml).join('');

  if (loadMoreContainer && loadMoreBtn) {
    if (visibleCount < filtered.length) {
      loadMoreContainer.classList.remove('hidden');
      loadMoreBtn.textContent = `Load more products (${filtered.length - visibleCount} remaining)`;
    } else {
      loadMoreContainer.classList.add('hidden');
    }
  }

  renderIcons();
  wireShareButtons();
  attachAdTracking(grid, adCampaigns);
}

function renderPills() {
  const container = document.querySelector('#catalog-category-pills');
  const select = document.querySelector('#catalog-category-select');
  if (!container) return;

  // Only offer categories that actually have something in them, plus whatever
  // is currently selected — a list of empty categories is noise, and with a
  // full taxonomy seeded most of them will be empty early on.
  const counts = new Map();
  for (const product of allProducts) {
    const key = product.category || 'General';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const named = managedCategories.map((category) => category.name);
  const categories = ['all', ...new Set([...named, ...counts.keys()])]
    .filter((cat) => cat === 'all' || counts.get(cat) > 0 || cat.toLowerCase() === activeCategory.toLowerCase());

  const labelFor = (cat) => (cat === 'all' ? 'All products' : cat);
  const countFor = (cat) => (cat === 'all' ? allProducts.length : counts.get(cat) || 0);
  const isActive = (cat) => cat.toLowerCase() === activeCategory.toLowerCase();

  container.innerHTML = categories
    .map((cat) => `
      <button type="button" class="catpill ${isActive(cat) ? 'is-active' : ''}" data-cat="${escapeHtml(cat)}">
        <span>${escapeHtml(labelFor(cat))}</span>
        <span class="catpill__count">${countFor(cat)}</span>
      </button>`)
    .join('');

  if (select) {
    select.innerHTML = categories
      .map((cat) => `
        <option value="${escapeHtml(cat)}" ${isActive(cat) ? 'selected' : ''}>
          ${escapeHtml(labelFor(cat))} (${countFor(cat)})
        </option>`)
      .join('');
    // Rebuild the custom list whenever the options change.
    categorySelect = categorySelect || enhanceSelect(select, { label: 'Browse category' });
    categorySelect?.refresh();
  }

  container.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => selectCategory(btn.dataset.cat));
  });
}

/** Single entry point so the pills and the dropdown can never disagree. */
function selectCategory(category) {
  activeCategory = category;
  visibleCount = PAGE_SIZE;
  renderPills();
  renderCatalog();
}

document.querySelector('#catalog-category-select')
  ?.addEventListener('change', (event) => selectCategory(event.target.value));

/**
 * Renders one seller's public store. Returns false when the slug does not
 * resolve, so the caller can fall back to the normal catalog.
 */
async function renderVendorStore(slug) {
  const { data, error } = await supabase.rpc('vendor_storefront', { p_slug: slug });
  const vendor = data?.vendor;

  if (error || !vendor) {
    document.querySelector('#product-loading')?.classList.add('hidden');
    grid.innerHTML = `
      <div class="soft-panel col-span-full p-10 text-center">
        <p class="font-bold text-[#142c55]">That store could not be found.</p>
        <p class="mt-1 text-sm text-slate-500">It may have been closed or renamed.</p>
        <a class="button button-primary mt-4" href="./store.html">Browse all products</a>
      </div>`;
    finishPageLoader();
    return true;
  }

  const products = data.products || [];

  document.querySelector('#vendor-header').classList.remove('hidden');
  document.querySelector('#store-header').classList.add('hidden');
  document.querySelector('#vendor-title').textContent = vendor.display_name;
  document.querySelector('#vendor-logo').innerHTML = vendor.logo_url
    ? `<img src="${escapeHtml(vendor.logo_url)}" alt="" class="h-full w-full object-cover">`
    : escapeHtml((vendor.display_name || '?').charAt(0).toUpperCase());
  if (vendor.banner_url) {
    document.querySelector('#vendor-banner').style.cssText =
      `background-image:url('${encodeURI(vendor.banner_url)}');background-size:cover;background-position:center`;
  }

  const since = vendor.approved_at
    ? new Date(vendor.approved_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;
  document.querySelector('#vendor-meta').textContent = [
    `${products.length} product${products.length === 1 ? '' : 's'}`,
    vendor.total_sales_count ? `${vendor.total_sales_count} sold` : null,
    since ? `Selling since ${since}` : null,
  ].filter(Boolean).join(' · ');

  const bio = document.querySelector('#vendor-bio');
  bio.textContent = vendor.bio || '';
  bio.classList.toggle('hidden', !vendor.bio);

  document.title = `${vendor.display_name} | DigiStore`;
  document.querySelector('#product-loading')?.classList.add('hidden');
  document.querySelector('#catalog-category-pills')?.closest('.bg-white')?.classList.add('hidden');

  grid.innerHTML = products.length
    ? products.map(createCardHtml).join('')
    : '<div class="soft-panel col-span-full p-10 text-center text-slate-500">This store has not published anything yet.</div>';

  const count = document.querySelector('#product-count');
  if (count) count.textContent = `${products.length} product${products.length === 1 ? '' : 's'}`;

  renderIcons();
  wireShareButtons();
  finishPageLoader();
  return true;
}

function wireShareButtons() {
  document.querySelectorAll('.share-product-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const slugOrId = decodeURIComponent(btn.dataset.shareUrl);
      const shareUrl = `${window.location.origin}/checkout.html?product=${encodeURIComponent(slugOrId)}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'DigiStore Product', url: shareUrl });
          return;
        } catch {}
      }
      navigator.clipboard.writeText(shareUrl);
      toast('Product checkout link copied to clipboard!');
    };
  });
}

async function init() {
  mountHeader();
  mountFooter();

  if (searchInput && activeSearchQuery) searchInput.value = activeSearchQuery;

  searchInput?.addEventListener('input', (e) => {
    activeSearchQuery = e.target.value;
    visibleCount = PAGE_SIZE;
    renderCatalog();
  });

  sortSelect?.addEventListener('change', (e) => {
    activeSort = e.target.value;
    renderCatalog();
  });

  loadMoreBtn?.addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    renderCatalog();
  });

  document.querySelector('#product-loading')?.classList.remove('hidden');

  // A ?vendor=<slug> link shows that seller's store instead of the full catalog.
  const vendorSlug = params.get('vendor');
  if (vendorSlug) {
    const shown = await renderVendorStore(vendorSlug);
    if (shown) return;
  }

  const [productsResult, categoriesResult] = await Promise.all([
    supabase.from('products').select('id,title,slug,category,description,short_description,price,original_price,currency,cover_url,file_type,file_size_bytes,purchase_count,rating_sum,rating_count,is_featured,is_published,created_at').eq('is_published', true).order('created_at', { ascending: false }),
    supabase.from('categories').select('name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name'),
  ]);
  const { data, error } = productsResult;
  managedCategories = categoriesResult.data || [];

  document.querySelector('#product-loading')?.classList.add('hidden');

  if (error) {
    grid.innerHTML = '<div class="soft-panel p-8 text-slate-600 col-span-full">The catalog is temporarily unavailable.</div>';
    finishPageLoader();
    return;
  }

  allProducts = data || [];
  adCampaigns = await loadServableCampaigns();
  renderPills();
  renderCatalog();
  finishPageLoader();
}

init();
