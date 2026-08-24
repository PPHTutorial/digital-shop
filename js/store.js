/**
 * Catalog page.
 *
 * Search, filtering, sorting, and pagination all happen in Postgres via
 * `search_products`. The page holds only the query state, which is mirrored
 * into the URL so a filtered view can be shared or bookmarked.
 */

import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { $, html, raw, esc, debounce, query } from './dom.js';
import { icon } from './icons.js';
import { formatNumber, formatMoney } from './format.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast } from './ui.js';
import { productCard, productSkeleton, wireShareButtons } from './product-card.js';

initTheme();

const state = {
  search: query.get('search', ''),
  category: query.get('category', 'all') || 'all',
  tags: (query.get('tags', '') || '').split(',').filter(Boolean),
  minPrice: query.get('min') ? Number(query.get('min')) : null,
  maxPrice: query.get('max') ? Number(query.get('max')) : null,
  sort: query.get('sort', 'relevance'),
  offset: 0,
  total: 0,
  items: [],
  facets: { categories: [], tags: [], price: {}, total: 0 },
  loading: false,
};

const dom = {};

/* ==========================================================================
   Query
   ========================================================================== */

async function fetchPage({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (!append) {
    state.offset = 0;
    dom.grid.innerHTML = productSkeleton(8);
  }

  const { data, error } = await supabase.rpc('search_products', {
    p_query: state.search || null,
    p_category: state.category === 'all' ? null : state.category,
    p_tags: state.tags.length ? state.tags : null,
    p_min_price: Number.isFinite(state.minPrice) ? state.minPrice : null,
    p_max_price: Number.isFinite(state.maxPrice) ? state.maxPrice : null,
    p_sort: state.sort,
    p_limit: CONFIG.PAGE_SIZE,
    p_offset: state.offset,
  });

  state.loading = false;

  if (error) {
    dom.grid.innerHTML = html`
      <div class="alert alert--danger" style="grid-column: 1 / -1">
        ${raw(icon('alertCircle'))}
        <span><span class="alert__title">The catalog is unavailable</span>${esc(error.message)}</span>
      </div>
    `;
    return;
  }

  state.total = data.total ?? 0;
  state.items = append ? [...state.items, ...(data.items || [])] : data.items || [];
  paintResults();
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function paintResults() {
  dom.count.textContent = `${formatNumber(state.total)} product${state.total === 1 ? '' : 's'}`;
  dom.heading.textContent = state.category === 'all' ? 'All products' : state.category;

  if (!state.items.length) {
    dom.grid.innerHTML = html`
      <div class="empty" style="grid-column: 1 / -1">
        ${raw(icon('search'))}
        <p class="empty__title">Nothing matched</p>
        <p class="empty__body">
          ${state.search
            ? `No product matches “${state.search}”. Try a broader term, or clear the filters.`
            : 'No product matches the current filters.'}
        </p>
        <button class="btn btn--sm mt-2" type="button" data-reset>Clear filters</button>
      </div>
    `;
    dom.more.hidden = true;
    return;
  }

  dom.grid.innerHTML = state.items.map((item) => productCard(item)).join('');
  dom.more.hidden = state.items.length >= state.total;
  dom.loadMore.textContent = `Load ${Math.min(CONFIG.PAGE_SIZE, state.total - state.items.length)} more`;
}

function paintFacets() {
  const { categories, tags, price } = state.facets;

  dom.facetCategories.innerHTML = html`
    <button class="chip" type="button" data-category="all" aria-pressed="${String(state.category === 'all')}">
      <span class="fill">All categories</span>
      <span class="chip__count">${formatNumber(state.facets.total)}</span>
    </button>
    ${raw(
      categories
        .map(
          (entry) => html`
            <button class="chip" type="button" data-category="${entry.name}"
                    aria-pressed="${String(state.category.toLowerCase() === entry.name.toLowerCase())}">
              <span class="fill truncate">${entry.name}</span>
              <span class="chip__count">${formatNumber(entry.count)}</span>
            </button>
          `,
        )
        .join(''),
    )}
  `;
  // Chips stack vertically in the sidebar.
  dom.facetCategories.querySelectorAll('.chip').forEach((chip) => {
    chip.style.width = '100%';
    chip.style.justifyContent = 'space-between';
  });

  dom.facetTags.innerHTML = tags.length
    ? tags
        .slice(0, 18)
        .map(
          (entry) => html`
            <button class="chip" type="button" data-tag="${entry.name}"
                    aria-pressed="${String(state.tags.includes(entry.name))}">
              ${entry.name}<span class="chip__count">${formatNumber(entry.count)}</span>
            </button>
          `,
        )
        .join('')
    : html`<p class="t-12 subtle">No tags yet.</p>`;

  if (price?.min != null) {
    dom.priceMin.placeholder = String(Math.floor(price.min));
    dom.priceMax.placeholder = String(Math.ceil(price.max));
    dom.priceMin.value = state.minPrice ?? '';
    dom.priceMax.value = state.maxPrice ?? '';
  }
}

function paintActiveFilters() {
  const chips = [];

  if (state.search) chips.push({ label: `“${state.search}”`, clear: () => (state.search = '') });
  if (state.category !== 'all') chips.push({ label: state.category, clear: () => (state.category = 'all') });
  for (const tag of state.tags) {
    chips.push({ label: `#${tag}`, clear: () => (state.tags = state.tags.filter((t) => t !== tag)) });
  }
  if (state.minPrice != null || state.maxPrice != null) {
    const from = state.minPrice != null ? formatMoney(state.minPrice) : 'any';
    const to = state.maxPrice != null ? formatMoney(state.maxPrice) : 'any';
    chips.push({
      label: `${from} – ${to}`,
      clear: () => {
        state.minPrice = null;
        state.maxPrice = null;
      },
    });
  }

  dom.activeFilters.hidden = chips.length === 0;
  dom.activeFilters.innerHTML = chips.length
    ? html`
        <span class="t-12 subtle">Filtering by</span>
        ${raw(
          chips
            .map(
              (chip, index) => html`
                <button class="chip" type="button" data-clear="${String(index)}">
                  ${chip.label}${raw(icon('x', 12))}
                </button>
              `,
            )
            .join(''),
        )}
        <button class="btn btn--xs btn--link" type="button" data-reset>Clear all</button>
      `
    : '';

  dom.activeFilters._chips = chips;
}

/* ==========================================================================
   State plumbing
   ========================================================================== */

function syncUrl() {
  query.set({
    search: state.search || null,
    category: state.category === 'all' ? null : state.category,
    tags: state.tags.length ? state.tags.join(',') : null,
    min: state.minPrice ?? null,
    max: state.maxPrice ?? null,
    sort: state.sort === 'relevance' ? null : state.sort,
  });
}

function refresh() {
  syncUrl();
  paintFacets();
  paintActiveFilters();
  fetchPage();
}

function resetFilters() {
  state.search = '';
  state.category = 'all';
  state.tags = [];
  state.minPrice = null;
  state.maxPrice = null;
  dom.search.value = '';
  refresh();
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function main() {
  dom.grid = $('#catalog-grid');
  dom.count = $('#catalog-count');
  dom.heading = $('#catalog-heading');
  dom.search = $('#catalog-search');
  dom.sort = $('#catalog-sort');
  dom.more = $('#catalog-more');
  dom.loadMore = $('#load-more');
  dom.facetCategories = $('#facet-categories');
  dom.facetTags = $('#facet-tags');
  dom.activeFilters = $('#active-filters');
  dom.priceMin = $('#price-min');
  dom.priceMax = $('#price-max');

  dom.search.value = state.search;
  dom.sort.value = state.sort;

  mountFooter();
  wireShareButtons(document);

  dom.search.addEventListener(
    'input',
    debounce(() => {
      state.search = dom.search.value.trim();
      refresh();
    }, CONFIG.SEARCH_DEBOUNCE_MS),
  );

  dom.sort.addEventListener('change', () => {
    state.sort = dom.sort.value;
    refresh();
  });

  dom.facetCategories.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    refresh();
  });

  dom.facetTags.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag]');
    if (!button) return;
    const tag = button.dataset.tag;
    state.tags = state.tags.includes(tag) ? state.tags.filter((t) => t !== tag) : [...state.tags, tag];
    refresh();
  });

  $('#apply-price').addEventListener('click', () => {
    state.minPrice = dom.priceMin.value === '' ? null : Number(dom.priceMin.value);
    state.maxPrice = dom.priceMax.value === '' ? null : Number(dom.priceMax.value);
    if (state.minPrice != null && state.maxPrice != null && state.minPrice > state.maxPrice) {
      toast('The minimum price is above the maximum.', 'error');
      return;
    }
    refresh();
  });

  $('#reset-filters').addEventListener('click', resetFilters);

  dom.activeFilters.addEventListener('click', (event) => {
    if (event.target.closest('[data-reset]')) {
      resetFilters();
      return;
    }
    const chip = event.target.closest('[data-clear]');
    if (!chip) return;
    dom.activeFilters._chips?.[Number(chip.dataset.clear)]?.clear();
    if (!state.search) dom.search.value = '';
    refresh();
  });

  dom.grid.addEventListener('click', (event) => {
    if (event.target.closest('[data-reset]')) resetFilters();
  });

  dom.loadMore.addEventListener('click', () => {
    state.offset += CONFIG.PAGE_SIZE;
    fetchPage({ append: true });
  });

  window.addEventListener('popstate', () => window.location.reload());

  const [{ data: facets }] = await Promise.all([supabase.rpc('catalog_facets'), fetchPage()]);
  state.facets = facets || state.facets;

  await mountHeader({ categories: state.facets.categories || [] });
  paintFacets();
  paintActiveFilters();
  bootDone();
}

main().catch((error) => {
  console.error(error);
  toast('The catalog could not be loaded.', 'error');
  bootDone();
});
