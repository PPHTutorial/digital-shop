import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons } from './ui.js';
import { loadServableCampaigns, attachAdTracking, promoteSponsored } from './ads.js';
import { enhanceSelect } from './select.js';
import { enhanceCheckboxes, enhanceRadios } from './form-controls.js';
import { wishlistButton, loadWishlist, paintWishlist, wireWishlist } from './wishlist.js';
import { AD_LISTING_COLS, stripAdListings } from './ad-listing.js';

let adCampaigns = new Map();

let allProducts = [];
let managedCategories = [];
const params = new URLSearchParams(window.location.search);

// Filter state — every dimension the sidebar exposes.
let activeCategories = new Set(params.get('category') ? [params.get('category')] : []);
let activeFileTypes = new Set();
let minRating = 0;
let priceBounds = { min: 0, max: 500 };
let priceMin = 0;
let priceMax = 500;
let priceUserTouched = false;
let activeSearchQuery = params.get('search') || '';
let activeSort = 'bestselling';
const PAGE_SIZE = 12;
let currentPage = 1;

const grid = document.querySelector('#product-grid');
const pagination = document.querySelector('#store-pagination');
const sortSelect = document.querySelector('#store-sort-select');
if (sortSelect) enhanceSelect(sortSelect, { label: 'Sort products by' });

const priceMinRange = document.querySelector('#price-min-range');
const priceMaxRange = document.querySelector('#price-max-range');
const priceMinLabel = document.querySelector('#price-min-label');
const priceMaxLabel = document.querySelector('#price-max-label');
const priceFill = document.querySelector('#price-slider-fill');

/** Human-readable file size, e.g. "2.4 MB". */
function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function ratingAverage(p) {
  return Number(p.rating_count) > 0 ? Number(p.rating_sum) / Number(p.rating_count) : 0;
}

function starsHtml(count, size = 12) {
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<i data-lucide="star" width="${size}" height="${size}" class="${i <= count ? '' : 'is-empty'}"></i>`;
  }
  return out;
}

/**
 * The small facts row under the title. Each entry only appears when the
 * product actually carries that data, so the row never renders half-empty.
 */
function cardMetaHtml(p) {
  const bits = [];

  if (Number(p.rating_count) > 0) {
    const average = ratingAverage(p).toFixed(1);
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
  const href = `./product?product=${encodeURIComponent(p.slug || p.id)}`;
  const blurb = p.short_description || p.description || '';
  const vendorLabel = p.vendor_id ? (p.vendor?.display_name || 'Marketplace Seller') : 'DigiStore Official';

  // The whole card is the link. A single stretched anchor covers it, so the
  // title, image, price and empty space all lead to checkout without nesting
  // interactive elements inside one another.
  return `
    <article class="catalog-card is-clickable" data-product-id="${p.id}">
      <span class="catalog-card__media">
        ${
          p.cover_url
            ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
            : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`
        }
        <span class="catalog-card__badges">
          ${p.is_featured ? `<span class="catalog-card__badge catalog-card__badge--featured">Featured</span>` : ''}
          ${hasDiscount ? `<span class="catalog-card__badge catalog-card__badge--sale">−${discountPct}%</span>` : ''}
        </span>
      </span>

      ${wishlistButton(p.id, p.title)}

      <span class="catalog-card__body">
        <span class="store-card-vendor">${escapeHtml(vendorLabel)}</span>
        <span class="catalog-card__cat">${escapeHtml(p.category || 'General')}</span>
        <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        ${blurb ? `<span class="catalog-card__blurb">${escapeHtml(blurb)}</span>` : ''}
        ${cardMetaHtml(p)}
      </span>

      <span class="catalog-card__foot">
        <span class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
        </span>
        <span class="catalog-card__go">${icon('arrow-right', 15)}</span>
      </span>

      <a class="catalog-card__link" href="${href}">
        <span class="sr-only">${escapeHtml(p.title)}</span>
      </a>
    </article>`;
}

/* ==========================================================================
   Filter predicates — one function per sidebar dimension, so facet counts
   can exclude their own dimension (standard faceted-search behaviour: a
   filter option's count reflects every OTHER active filter, not itself).
   ========================================================================== */
const matchesCategory = (p) => activeCategories.size === 0 || activeCategories.has(p.category || 'General');
const matchesFileType = (p) => activeFileTypes.size === 0 || activeFileTypes.has(String(p.file_type || '').toLowerCase());
const matchesRating = (p) => minRating === 0 || ratingAverage(p) >= minRating;
const matchesPrice = (p) => {
  const price = Number(p.price || 0);
  return price >= priceMin && price <= priceMax;
};
const matchesSearch = (p) => {
  if (!activeSearchQuery.trim()) return true;
  const q = activeSearchQuery.toLowerCase().trim();
  return (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q);
};

function passesExcept(p, exceptDim) {
  if (exceptDim !== 'category' && !matchesCategory(p)) return false;
  if (exceptDim !== 'filetype' && !matchesFileType(p)) return false;
  if (exceptDim !== 'rating' && !matchesRating(p)) return false;
  if (exceptDim !== 'price' && !matchesPrice(p)) return false;
  if (!matchesSearch(p)) return false;
  return true;
}

function sortList(list) {
  const sorted = [...list];
  if (activeSort === 'newest') {
    sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } else if (activeSort === 'price-low') {
    sorted.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  } else if (activeSort === 'price-high') {
    sorted.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  } else if (activeSort === 'title') {
    sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else {
    sorted.sort((a, b) => Number(b.purchase_count || 0) - Number(a.purchase_count || 0));
  }

  // Sponsored products lift to the front of the default (bestselling) view
  // only. An explicit sort (price, title, newest) is the shopper's
  // instruction and paid placement must not override it.
  return activeSort === 'bestselling' ? promoteSponsored(sorted, adCampaigns) : sorted;
}

function getFilteredList() {
  const list = allProducts.filter((p) => passesExcept(p, null));
  return sortList(list);
}

/* ==========================================================================
   Sidebar rendering
   ========================================================================== */
function renderCategoryFilter() {
  const host = document.querySelector('#filter-category-list');
  const clearBtn = document.querySelector('#filter-category-clear');
  if (!host) return;

  const named = managedCategories.map((c) => c.name);
  const present = new Set(allProducts.map((p) => p.category || 'General'));
  const names = [...new Set([...named, ...present])].filter((n) => present.has(n) || activeCategories.has(n));

  host.innerHTML = names.map((name) => {
    const count = allProducts.filter((p) => passesExcept(p, 'category') && (p.category || 'General') === name).length;
    const checked = activeCategories.has(name);
    return `
      <label class="store-check">
        <input type="checkbox" data-filter="category" value="${escapeHtml(name)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(name)}</span>
        <span class="store-check__count">${count}</span>
      </label>`;
  }).join('') || '<p class="text-xs" style="color:var(--text-soft)">No categories yet.</p>';
  enhanceCheckboxes('#filter-category-list input[type="checkbox"]');

  clearBtn?.classList.toggle('hidden', activeCategories.size === 0);
}

function renderFileTypeFilter() {
  const host = document.querySelector('#filter-filetype-list');
  const clearBtn = document.querySelector('#filter-filetype-clear');
  if (!host) return;

  const types = [...new Set(allProducts.map((p) => String(p.file_type || '').toLowerCase()).filter(Boolean))].sort();

  host.innerHTML = types.map((type) => {
    const count = allProducts.filter((p) => passesExcept(p, 'filetype') && String(p.file_type || '').toLowerCase() === type).length;
    const checked = activeFileTypes.has(type);
    return `
      <label class="store-check">
        <input type="checkbox" data-filter="filetype" value="${escapeHtml(type)}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(type.toUpperCase())}</span>
        <span class="store-check__count">${count}</span>
      </label>`;
  }).join('') || '<p class="text-xs" style="color:var(--text-soft)">No file types yet.</p>';
  enhanceCheckboxes('#filter-filetype-list input[type="checkbox"]');

  clearBtn?.classList.toggle('hidden', activeFileTypes.size === 0);
}

function renderRatingFilter() {
  const host = document.querySelector('#filter-rating-list');
  const clearBtn = document.querySelector('#filter-rating-clear');
  if (!host) return;

  host.innerHTML = [4, 3, 2, 1].map((threshold) => {
    const count = allProducts.filter((p) => passesExcept(p, 'rating') && ratingAverage(p) >= threshold).length;
    const checked = minRating === threshold;
    return `
      <label class="store-check">
        <input type="radio" name="rating-filter" data-filter="rating" value="${threshold}" ${checked ? 'checked' : ''}>
        <span class="store-check__stars">${starsHtml(threshold)}</span>
        <span>&amp; up</span>
        <span class="store-check__count">${count}</span>
      </label>`;
  }).join('');
  enhanceRadios('#filter-rating-list input[type="radio"]');

  clearBtn?.classList.toggle('hidden', minRating === 0);
}

function renderPriceSlider() {
  if (!priceMinRange || !priceMaxRange) return;
  const pct = (value) => priceBounds.max > priceBounds.min ? ((value - priceBounds.min) / (priceBounds.max - priceBounds.min)) * 100 : 0;
  const left = pct(priceMin);
  const right = pct(priceMax);
  if (priceFill) {
    priceFill.style.left = `${left}%`;
    priceFill.style.width = `${Math.max(0, right - left)}%`;
  }
  if (priceMinLabel) priceMinLabel.textContent = `$${Math.round(priceMin)}`;
  if (priceMaxLabel) priceMaxLabel.textContent = `$${Math.round(priceMax)}`;
}

function renderFilterChips() {
  const host = document.querySelector('#store-filter-chips');
  if (!host) return;
  const chips = [];

  for (const name of activeCategories) {
    chips.push({ label: name, clear: () => activeCategories.delete(name) });
  }
  for (const type of activeFileTypes) {
    chips.push({ label: type.toUpperCase(), clear: () => activeFileTypes.delete(type) });
  }
  if (minRating > 0) {
    chips.push({ label: `${minRating}★ & up`, clear: () => { minRating = 0; } });
  }
  if (priceUserTouched && (priceMin > priceBounds.min || priceMax < priceBounds.max)) {
    chips.push({ label: `$${Math.round(priceMin)}–$${Math.round(priceMax)}`, clear: () => { priceMin = priceBounds.min; priceMax = priceBounds.max; priceUserTouched = false; } });
  }

  host.innerHTML = chips.map((c, i) => `
    <span class="store-chip">${escapeHtml(c.label)}<button type="button" data-chip="${i}" aria-label="Remove filter">${icon('x', 12)}</button></span>`).join('');

  host.querySelectorAll('[data-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      chips[Number(btn.dataset.chip)]?.clear();
      currentPage = 1;
      renderAll();
    });
  });
  renderIcons();
}

/* ==========================================================================
   Pagination
   ========================================================================== */
function renderPagination(totalItems) {
  if (!pagination) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);

  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }

  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  const sortedPages = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let html = `<button type="button" class="store-page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevron-left', 16)}</button>`;

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) html += `<span class="store-page-ellipsis">…</span>`;
    html += `<button type="button" class="store-page-btn ${p === currentPage ? 'is-active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }

  html += `<button type="button" class="store-page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevron-right', 16)}</button>`;

  pagination.innerHTML = html;
  pagination.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentPage = Number(btn.dataset.page);
      renderCatalog();
      grid?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  renderIcons();
}

/* ==========================================================================
   Main render
   ========================================================================== */
function renderCatalog() {
  if (!grid) return;
  const filtered = getFilteredList();

  // Nothing to filter or sort when the catalog itself has no products at
  // all — hide that chrome entirely rather than showing controls that act
  // on zero items.
  const catalogEmpty = allProducts.length === 0;
  document.querySelector('.store-sidebar')?.classList.toggle('hidden', catalogEmpty);
  document.querySelector('#store-sort-row')?.classList.toggle('hidden', catalogEmpty);
  document.querySelector('#store-layout')?.classList.toggle('is-single-col', catalogEmpty);

  const countEl = document.querySelector('#product-count');
  if (countEl) {
    if (!filtered.length) {
      countEl.textContent = '0 products found';
    } else {
      const start = (currentPage - 1) * PAGE_SIZE + 1;
      const end = Math.min(currentPage * PAGE_SIZE, filtered.length);
      countEl.textContent = `Showing ${start}–${end} of ${filtered.length} result${filtered.length === 1 ? '' : 's'}`;
    }
  }

  const crumbCurrent = document.querySelector('#store-crumb-current');
  const crumbLabel = document.querySelector('#store-crumb-current-label');
  const headingEl = document.querySelector('#store-heading');
  if (activeCategories.size === 1) {
    const [only] = activeCategories;
    if (headingEl) headingEl.textContent = only;
    if (crumbLabel) crumbLabel.textContent = only;
    crumbCurrent?.classList.remove('hidden');
  } else {
    if (headingEl) headingEl.textContent = 'All Products & Assets';
    crumbCurrent?.classList.add('hidden');
  }

  if (!filtered.length) {
    grid.innerHTML = catalogEmpty
      ? `
      <div class="store-empty col-span-full">
        <div class="store-empty__emoji">🛍️</div>
        <h3>No products yet</h3>
        <p>The catalog is empty right now. Check back soon.</p>
      </div>`
      : `
      <div class="store-empty col-span-full">
        <div class="store-empty__emoji">🔍</div>
        <h3>No products found</h3>
        <p>No products matched your selected criteria. Try adjusting your filters or search keywords.</p>
        <button type="button" id="reset-filters-btn" class="button button-primary store-empty__cta">Clear All Filters</button>
      </div>`;
    document.querySelector('#reset-filters-btn')?.addEventListener('click', resetAllFilters);
    pagination.innerHTML = '';
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const subset = filtered.slice(start, start + PAGE_SIZE);
  grid.innerHTML = subset.map(createCardHtml).join('');

  renderIcons();
  paintWishlist(grid);
  attachAdTracking(grid, adCampaigns);
  renderPagination(filtered.length);
}

function renderAll() {
  renderCategoryFilter();
  renderFileTypeFilter();
  renderRatingFilter();
  renderPriceSlider();
  renderFilterChips();
  renderCatalog();
}

function resetAllFilters() {
  activeCategories = new Set();
  activeFileTypes = new Set();
  minRating = 0;
  priceMin = priceBounds.min;
  priceMax = priceBounds.max;
  priceUserTouched = false;
  activeSearchQuery = '';
  const headerInput = document.querySelector('#header-search-input');
  if (headerInput) headerInput.value = '';
  currentPage = 1;
  renderAll();
}

/* ==========================================================================
   Mobile filters drawer — same `#dash-sidebar`/`#dash-menu-button`/
   `#dash-scrim` off-canvas pattern as the admin/vendor/account consoles.
   ========================================================================== */
function wireFiltersDrawer() {
  const sidebar = document.querySelector('#dash-sidebar');
  const menuButton = document.querySelector('#dash-menu-button');
  const closeButton = document.querySelector('#dash-sidebar-close');
  const scrim = document.querySelector('#dash-scrim');
  if (!sidebar || !menuButton) return;

  const setOpen = (open) => {
    sidebar.classList.toggle('is-open', open);
    scrim?.classList.toggle('is-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  };

  menuButton.addEventListener('click', () => setOpen(true));
  closeButton?.addEventListener('click', () => setOpen(false));
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
}
wireFiltersDrawer();

/* ==========================================================================
   Wiring
   ========================================================================== */
document.body.addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.filter) return;

  currentPage = 1;
  if (target.dataset.filter === 'category') {
    target.checked ? activeCategories.add(target.value) : activeCategories.delete(target.value);
  } else if (target.dataset.filter === 'filetype') {
    target.checked ? activeFileTypes.add(target.value) : activeFileTypes.delete(target.value);
  } else if (target.dataset.filter === 'rating') {
    minRating = Number(target.value);
  }
  renderAll();
});

document.querySelector('#filter-category-clear')?.addEventListener('click', () => { activeCategories = new Set(); currentPage = 1; renderAll(); });
document.querySelector('#filter-filetype-clear')?.addEventListener('click', () => { activeFileTypes = new Set(); currentPage = 1; renderAll(); });
document.querySelector('#filter-rating-clear')?.addEventListener('click', () => { minRating = 0; currentPage = 1; renderAll(); });
document.querySelector('#filter-price-clear')?.addEventListener('click', () => {
  priceMin = priceBounds.min; priceMax = priceBounds.max; priceUserTouched = false; currentPage = 1; renderAll();
});

function wirePriceSlider() {
  if (!priceMinRange || !priceMaxRange) return;
  priceMinRange.addEventListener('input', () => {
    priceMin = Math.min(Number(priceMinRange.value), priceMax);
    priceMinRange.value = priceMin;
    priceUserTouched = true;
    renderPriceSlider();
  });
  priceMaxRange.addEventListener('input', () => {
    priceMax = Math.max(Number(priceMaxRange.value), priceMin);
    priceMaxRange.value = priceMax;
    priceUserTouched = true;
    renderPriceSlider();
  });
  ['change'].forEach((evt) => {
    priceMinRange.addEventListener(evt, () => { currentPage = 1; renderAll(); });
    priceMaxRange.addEventListener(evt, () => { currentPage = 1; renderAll(); });
  });
}

/**
 * Renders one seller's public store. Returns false when the slug does not
 * resolve, so the caller can fall back to the normal catalog.
 */
async function renderVendorStore(slug) {
  await loadWishlist();
  wireWishlist(grid);
  const { data, error } = await supabase.rpc('vendor_storefront', { p_slug: slug });
  const vendor = data?.vendor;

  if (error || !vendor) {
    document.querySelector('#product-loading')?.classList.add('hidden');
    grid.innerHTML = `
      <div class="soft-panel col-span-full p-10 text-center">
        <p class="font-bold" style="color:var(--text)">That store could not be found.</p>
        <p class="mt-1 text-sm" style="color:var(--text-muted)">It may have been closed or renamed.</p>
        <a class="button button-primary mt-4" href="./store">Browse all products</a>
      </div>`;
    finishPageLoader();
    return true;
  }

  const products = stripAdListings(data.products || []);

  document.querySelector('#vendor-header').classList.remove('hidden');
  document.querySelector('#store-header').classList.add('hidden');
  document.querySelector('.store-sidebar')?.classList.add('hidden');
  document.querySelector('#store-layout')?.classList.add('is-single-col');
  document.querySelector('#store-search-row')?.classList.add('hidden');
  document.querySelector('#store-sort-row')?.classList.add('hidden');
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

  grid.innerHTML = products.length
    ? products.map(createCardHtml).join('')
    : '<div class="soft-panel col-span-full p-10 text-center" style="color:var(--text-muted)">This store has not published anything yet.</div>';

  const count = document.querySelector('#product-count');
  if (count) count.textContent = `${products.length} product${products.length === 1 ? '' : 's'}`;

  renderIcons();
  paintWishlist(grid);
  finishPageLoader();
  return true;
}

async function init() {
  mountHeader();
  mountFooter();
  wirePriceSlider();

  // The catalog has no search box of its own — the header search (js/ui.js)
  // filters this page live via this event, debounced, with no navigation.
  window.addEventListener('digistore:search', (e) => {
    activeSearchQuery = e.detail?.query || '';
    currentPage = 1;
    renderAll();
  });

  sortSelect?.addEventListener('change', (e) => {
    activeSort = e.target.value;
    currentPage = 1;
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
    supabase.from('products')
      .select('id,title,slug,category,description,short_description,price,original_price,currency,cover_url,file_type,file_size_bytes,purchase_count,rating_sum,rating_count,is_featured,is_published,created_at,vendor_id,vendor:vendors(display_name,slug)' + AD_LISTING_COLS)
      .eq('is_published', true).order('created_at', { ascending: false }),
    supabase.from('categories').select('name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name'),
  ]);
  const { data, error } = productsResult;
  managedCategories = categoriesResult.data || [];

  document.querySelector('#product-loading')?.classList.add('hidden');

  if (error) {
    grid.innerHTML = '<div class="soft-panel p-8 col-span-full" style="color:var(--text-muted)">The catalog is temporarily unavailable.</div>';
    finishPageLoader();
    return;
  }

  allProducts = stripAdListings(data || []);

  const prices = allProducts.map((p) => Number(p.price || 0)).filter((n) => Number.isFinite(n));
  priceBounds = { min: 0, max: prices.length ? Math.max(...prices, 1) : 500 };
  priceMin = priceBounds.min;
  priceMax = priceBounds.max;
  if (priceMinRange) { priceMinRange.min = priceBounds.min; priceMinRange.max = priceBounds.max; priceMinRange.value = priceMin; }
  if (priceMaxRange) { priceMaxRange.min = priceBounds.min; priceMaxRange.max = priceBounds.max; priceMaxRange.value = priceMax; }

  adCampaigns = await loadServableCampaigns();
  await loadWishlist();
  wireWishlist(grid);
  renderAll();
  finishPageLoader();
}

init();
