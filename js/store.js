import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, toast } from './ui.js';

let allProducts = [];
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

function createCardHtml(p) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
  const priceHtml = hasDiscount
    ? `<div class="flex items-baseline gap-1.5">
         <span class="price-original text-xs">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
         <strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency} ${Number(p.price).toFixed(2)}</strong>
       </div>`
    : `<strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency} ${Number(p.price).toFixed(2)}</strong>`;

  return `
    <article class="catalog-card flex flex-col justify-between overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 bg-white border border-slate-200/80 rounded-2xl">
      <div>
        <a href="./checkout.html?product=${encodeURIComponent(p.slug || p.id)}" class="block relative overflow-hidden bg-slate-100 group aspect-[1.4]">
          ${
            p.cover_url
              ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">`
              : `<div class="w-full h-full flex items-center justify-center text-slate-400 bg-slate-100 font-semibold text-xs">Digital Product</div>`
          }
          <div class="absolute top-2.5 left-2.5 flex flex-wrap gap-1.5">
            <span class="tag !text-[10px] !py-0.5 !px-2 font-bold shadow-sm">${escapeHtml(p.category || 'General')}</span>
            ${hasDiscount ? `<span class="discount-pill shadow-sm">${discountPct}% OFF</span>` : ''}
          </div>
        </a>
        <div class="p-4 sm:p-5">
          <h3 class="text-base font-black text-[#142c55] leading-snug line-clamp-2 hover:text-orange-600 transition">
            <a href="./checkout.html?product=${encodeURIComponent(p.slug || p.id)}">${escapeHtml(p.title)}</a>
          </h3>
          <p class="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-500">${escapeHtml(p.description || '')}</p>
        </div>
      </div>
      <div class="p-4 sm:p-5 pt-0 mt-auto border-t border-slate-100 flex items-center justify-between gap-2">
        ${priceHtml}
        <div class="flex items-center gap-1.5">
          <button type="button" class="button !min-h-8 !px-2.5 text-xs share-product-btn" data-share-url="${encodeURIComponent(p.slug || p.id)}" title="Share product link">
            <i data-lucide="share-2" width="13" height="13"></i>
          </button>
          <a class="button button-primary !min-h-8 !px-3.5 !text-xs font-bold whitespace-nowrap" href="./checkout.html?product=${encodeURIComponent(p.slug || p.id)}">Get product</a>
        </div>
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
}

function renderPills() {
  const container = document.querySelector('#catalog-category-pills');
  if (!container) return;

  const categories = ['all', 'Ebooks & Guides', 'Software & Tools', 'Templates & Themes', 'Online Courses', 'Audio & Media', 'Design & Graphics'];

  container.innerHTML = categories
    .map((cat) => {
      const isActive = cat.toLowerCase() === activeCategory.toLowerCase();
      const count = cat === 'all' ? allProducts.length : allProducts.filter((p) => (p.category || 'General').toLowerCase() === cat.toLowerCase()).length;
      return `
        <button type="button" class="rounded-full px-4 py-2 text-xs font-bold transition flex items-center gap-1.5 ${
          isActive ? 'bg-orange-500 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        }" data-cat="${escapeHtml(cat)}">
          <span>${cat === 'all' ? 'All Products' : escapeHtml(cat)}</span>
          <span class="text-[10px] ${isActive ? 'text-orange-100' : 'text-slate-400'}">(${count})</span>
        </button>`;
    })
    .join('');

  container.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      visibleCount = PAGE_SIZE;
      renderPills();
      renderCatalog();
    });
  });
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

  const { data, error } = await supabase
    .from('products')
    .select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published,created_at')
    .eq('is_published', true)
    .order('created_at', { ascending: false });

  document.querySelector('#product-loading')?.classList.add('hidden');

  if (error) {
    grid.innerHTML = '<div class="soft-panel p-8 text-slate-600 col-span-full">The catalog is temporarily unavailable.</div>';
    finishPageLoader();
    return;
  }

  allProducts = data || [];
  renderPills();
  renderCatalog();
  finishPageLoader();
}

init();
