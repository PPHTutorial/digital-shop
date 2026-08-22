import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';

document.querySelector('#year').textContent = new Date().getFullYear();

let allProducts = [];
let activeCatalogCategory = 'all';
let activeSearchQuery = '';
let activeSort = 'newest';
const PAGE_SIZE = 8;
let catalogVisibleCount = PAGE_SIZE;

const grid = document.querySelector('#product-grid');
const loadMoreContainer = document.querySelector('#load-more-container');
const loadMoreBtn = document.querySelector('#load-more-btn');
const searchInput = document.querySelector('#store-search-input');
const sortSelect = document.querySelector('#store-sort-select');

// ============================================================
// Single Product Card HTML Generator
// ============================================================
function createProductCardHtml(p, isScrollItem = false) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
  const priceHtml = hasDiscount
    ? `<div class="flex items-baseline gap-1.5">
         <span class="price-original text-xs">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
         <strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency} ${Number(p.price).toFixed(2)}</strong>
       </div>`
    : `<strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency} ${Number(p.price).toFixed(2)}</strong>`;

  const wrapperClass = isScrollItem
    ? 'scroll-card-item catalog-card flex flex-col justify-between overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 bg-white border border-slate-200/80 rounded-2xl'
    : 'catalog-card flex flex-col justify-between overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 bg-white border border-slate-200/80 rounded-2xl';

  return `
    <article class="${wrapperClass}">
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

// ============================================================
// Render All 10 Horizontal Scrolling Sections
// ============================================================
function renderShowcaseSections() {
  const sections = [
    {
      id: 'scroll-featured',
      countClass: '.count-featured',
      items: allProducts.slice(0, 10),
    },
    {
      id: 'scroll-new',
      countClass: '.count-new',
      items: [...allProducts].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 10),
    },
    {
      id: 'scroll-bestsellers',
      countClass: '.count-bestsellers',
      items: allProducts.filter((p) => p.is_published).slice(0, 10),
    },
    {
      id: 'scroll-trending',
      countClass: '.count-trending',
      items: [...allProducts].reverse().slice(0, 10),
    },
    {
      id: 'scroll-deals',
      countClass: '.count-deals',
      items: allProducts.filter((p) => p.original_price && Number(p.original_price) > Number(p.price)),
    },
    {
      id: 'scroll-ebooks',
      countClass: '.count-ebooks',
      items: allProducts.filter((p) => (p.category || '').toLowerCase().includes('ebook')),
    },
    {
      id: 'scroll-software',
      countClass: '.count-software',
      items: allProducts.filter((p) => (p.category || '').toLowerCase().includes('software') || (p.category || '').toLowerCase().includes('tool')),
    },
    {
      id: 'scroll-templates',
      countClass: '.count-templates',
      items: allProducts.filter((p) => (p.category || '').toLowerCase().includes('template') || (p.category || '').toLowerCase().includes('theme')),
    },
    {
      id: 'scroll-courses',
      countClass: '.count-courses',
      items: allProducts.filter((p) => (p.category || '').toLowerCase().includes('course') || (p.category || '').toLowerCase().includes('masterclass')),
    },
    {
      id: 'scroll-audio',
      countClass: '.count-audio',
      items: allProducts.filter((p) => (p.category || '').toLowerCase().includes('audio') || (p.category || '').toLowerCase().includes('media')),
    },
  ];

  sections.forEach((sec) => {
    const container = document.querySelector(`#${sec.id}`);
    const countEl = document.querySelector(sec.countClass);
    if (countEl) countEl.textContent = sec.items.length;

    if (container) {
      if (sec.items.length > 0) {
        container.innerHTML = sec.items.map((p) => createProductCardHtml(p, true)).join('');
      } else {
        container.innerHTML = `<div class="p-6 text-xs text-slate-400 bg-white border border-slate-200 rounded-2xl w-full">New releases in this collection are arriving soon.</div>`;
      }
    }
  });

  wireHorizontalScrollButtons();
  wireShareButtons();
}

// ============================================================
// Horizontal Scroll Button Arrow Controls
// ============================================================
function wireHorizontalScrollButtons() {
  document.querySelectorAll('[data-scroll-left]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.scrollLeft;
      const target = document.querySelector(`#${targetId}`);
      target?.scrollBy({ left: -320, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('[data-scroll-right]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.scrollRight;
      const target = document.querySelector(`#${targetId}`);
      target?.scrollBy({ left: 320, behavior: 'smooth' });
    });
  });
}

// ============================================================
// Full Catalog Filter, Search & Grid
// ============================================================
function getFilteredAndSortedCatalog() {
  let list = [...allProducts];

  // 1. Category Filter
  if (activeCatalogCategory !== 'all') {
    list = list.filter((p) => (p.category || 'General').toLowerCase() === activeCatalogCategory.toLowerCase());
  }

  // 2. Search Query Filter
  if (activeSearchQuery.trim()) {
    const q = activeSearchQuery.toLowerCase().trim();
    list = list.filter((p) => (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  }

  // 3. Sorting
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

function renderCatalogGrid() {
  if (!grid) return;
  const filteredList = getFilteredAndSortedCatalog();

  document.querySelector('#product-count').textContent = `${filteredList.length} product${filteredList.length === 1 ? '' : 's'} found`;

  const headingEl = document.querySelector('#catalog-heading');
  if (headingEl) {
    headingEl.textContent = activeCatalogCategory === 'all' ? 'All Products' : activeCatalogCategory;
  }

  if (!filteredList.length) {
    grid.innerHTML = `
      <div class="col-span-full py-12 text-center bg-white rounded-2xl border border-slate-200 p-8 space-y-3">
        <div class="text-3xl">🔍</div>
        <h3 class="font-black text-lg text-[#142c55]">No products matched your filter</h3>
        <p class="text-xs text-slate-500 max-w-sm mx-auto">Try selecting another category or clear your search query to see all available releases.</p>
        <button type="button" id="reset-catalog-filters-btn" class="button !min-h-9 !px-4 text-xs font-bold">Reset Filters</button>
      </div>`;
    document.querySelector('#reset-catalog-filters-btn')?.addEventListener('click', () => {
      activeCatalogCategory = 'all';
      activeSearchQuery = '';
      if (searchInput) searchInput.value = '';
      renderCategoryPills();
      renderCatalogGrid();
    });
    loadMoreContainer?.classList.add('hidden');
    return;
  }

  const visibleSubset = filteredList.slice(0, catalogVisibleCount);
  grid.innerHTML = visibleSubset.map((p) => createProductCardHtml(p, false)).join('');

  // Load More Button
  if (loadMoreContainer && loadMoreBtn) {
    if (catalogVisibleCount < filteredList.length) {
      loadMoreContainer.classList.remove('hidden');
      const remaining = filteredList.length - catalogVisibleCount;
      loadMoreBtn.textContent = `Load more products (${remaining} remaining)`;
    } else {
      loadMoreContainer.classList.add('hidden');
    }
  }

  renderIcons();
  wireShareButtons();
}

function renderCategoryPills() {
  const container = document.querySelector('#catalog-category-pills');
  if (!container) return;

  const categories = ['all', 'Ebooks & Guides', 'Software & Tools', 'Templates & Themes', 'Online Courses', 'Audio & Media', 'Design & Graphics'];

  container.innerHTML = categories
    .map((cat) => {
      const isActive = cat.toLowerCase() === activeCatalogCategory.toLowerCase();
      const count = cat === 'all' ? allProducts.length : allProducts.filter((p) => (p.category || 'General').toLowerCase() === cat.toLowerCase()).length;
      return `
        <button type="button" class="rounded-full px-3.5 py-1.5 text-xs font-bold transition flex items-center gap-1.5 ${
          isActive ? 'bg-orange-500 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
        }" data-cat-pill="${escapeHtml(cat)}">
          <span>${cat === 'all' ? 'All Products' : escapeHtml(cat)}</span>
          <span class="text-[10px] ${isActive ? 'text-orange-100' : 'text-slate-400'}">(${count})</span>
        </button>`;
    })
    .join('');

  container.querySelectorAll('[data-cat-pill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCatalogCategory = btn.dataset.catPill;
      catalogVisibleCount = PAGE_SIZE;
      renderCategoryPills();
      renderCatalogGrid();
    });
  });
}

// ============================================================
// Wire Search, Sort, "See All" & Quick Nav
// ============================================================
function wireInteractiveControls() {
  // Search Input
  searchInput?.addEventListener('input', (e) => {
    activeSearchQuery = e.target.value;
    catalogVisibleCount = PAGE_SIZE;
    renderCatalogGrid();
  });

  // Sort Dropdown
  sortSelect?.addEventListener('change', (e) => {
    activeSort = e.target.value;
    renderCatalogGrid();
  });

  // Load More Button
  loadMoreBtn?.addEventListener('click', () => {
    catalogVisibleCount += PAGE_SIZE;
    renderCatalogGrid();
  });

  // Quick Nav Pills at top
  document.querySelectorAll('[data-target-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.targetCategory;
      activeCatalogCategory = cat;
      catalogVisibleCount = PAGE_SIZE;
      renderCategoryPills();
      renderCatalogGrid();
      document.querySelector('#store')?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // "See all (X)" buttons on sections
  document.querySelectorAll('.see-all-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.seeAll;
      if (['Ebooks & Guides', 'Software & Tools', 'Templates & Themes', 'Online Courses', 'Audio & Media'].includes(target)) {
        activeCatalogCategory = target;
      } else {
        activeCatalogCategory = 'all';
      }
      catalogVisibleCount = PAGE_SIZE;
      renderCategoryPills();
      renderCatalogGrid();
      document.querySelector('#store')?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Footer Category Links
  document.querySelectorAll('[data-footer-cat]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const cat = link.dataset.footerCat;
      activeCatalogCategory = cat;
      catalogVisibleCount = PAGE_SIZE;
      renderCategoryPills();
      renderCatalogGrid();
      document.querySelector('#store')?.scrollIntoView({ behavior: 'smooth' });
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

// ============================================================
// Main Storefront Load
// ============================================================
async function load() {
  mountHeader();
  document.querySelector('#product-loading')?.classList.remove('hidden');

  const { data, error } = await supabase
    .from('products')
    .select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published,created_at')
    .eq('is_published', true)
    .order('created_at', { ascending: false });

  if (error) {
    if (grid) grid.innerHTML = '<div class="soft-panel p-8 text-slate-600 col-span-full">The catalog is temporarily unavailable. Please refresh in a moment.</div>';
    document.querySelector('#product-loading')?.classList.add('hidden');
    finishPageLoader();
    return;
  }

  allProducts = data || [];

  renderShowcaseSections();
  renderCategoryPills();
  renderCatalogGrid();
  wireInteractiveControls();

  document.querySelector('#product-loading')?.classList.add('hidden');
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
      status.className = 'status-line error sm:col-span-2';
    }
  } else {
    if (status) {
      status.textContent = 'Thank you for subscribing to DigiStore updates!';
      status.className = 'status-line success sm:col-span-2';
    }
    e.currentTarget.reset();
  }
});

load();
