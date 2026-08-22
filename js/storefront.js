import { supabase } from "./client.js";
import { escapeHtml, finishPageLoader, icon, initMotion, mountHeader, renderIcons, setButtonLoading, startPageLoader, toast } from './ui.js';
const grid = document.querySelector("#product-grid");
const loadMoreContainer = document.querySelector("#load-more-container");
const loadMoreBtn = document.querySelector("#load-more-btn");

const PAGE_SIZE = 6;
let visibleCount = PAGE_SIZE;
let allProducts = [];
let activeCategory = 'all';
let currentFilteredList = [];

function renderProducts(list) {
  currentFilteredList = list;
  if (!list.length) {
    grid.innerHTML = '<div class="soft-panel p-8 text-slate-600 sm:col-span-2 xl:col-span-3">No products found in this category.</div>';
    loadMoreContainer?.classList.add('hidden');
    return;
  }

  const visibleList = list.slice(0, visibleCount);

  grid.innerHTML = visibleList
    .map((p) => {
      const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
      const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
      const priceHtml = hasDiscount
        ? `<div class="flex items-baseline gap-1.5">
             <span class="price-original text-xs">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
             <strong class="text-lg text-[#142c55]">${p.currency} ${Number(p.price).toFixed(2)}</strong>
           </div>`
        : `<strong class="text-lg text-[#142c55]">${p.currency} ${Number(p.price).toFixed(2)}</strong>`;

      return `<article class="catalog-card overflow-hidden">
        ${p.cover_url ? `<img src="${p.cover_url}" alt="${escapeHtml(p.title)}">` : '<div class="aspect-[1.5] bg-slate-100"></div>'}
        <div class="card-body">
          <div class="flex items-center justify-between gap-2">
            <span class="tag">${escapeHtml(p.category || 'Digital product')}</span>
            ${hasDiscount ? `<span class="discount-pill">${discountPct}% OFF</span>` : ''}
          </div>
          <h3 class="mt-3 text-lg font-black text-[#142c55]">${escapeHtml(p.title)}</h3>
          <p class="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">${escapeHtml(p.description || '')}</p>
          <div class="mt-5 flex items-center justify-between gap-3">
            ${priceHtml}
            <div class="flex items-center gap-2">
              <button type="button" class="button !min-h-9 !px-2.5 text-xs share-product-btn" data-share-url="${encodeURIComponent(p.slug || p.id)}" title="Share product advertising link">
                ${icon('share-2', 15)}
              </button>
              <a class="button button-primary !min-h-9 !px-3.5 !text-xs" href="./checkout.html?product=${encodeURIComponent(p.slug || p.id)}">Get product</a>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join('');

  renderIcons();

  // Load More Button visibility & text
  if (loadMoreContainer && loadMoreBtn) {
    if (visibleCount < list.length) {
      loadMoreContainer.classList.remove('hidden');
      const remaining = list.length - visibleCount;
      loadMoreBtn.textContent = `Load more products (${remaining} remaining)`;
    } else {
      loadMoreContainer.classList.add('hidden');
    }
  }

  // Wire share buttons on cards
  grid.querySelectorAll('.share-product-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
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
      toast('Product advertising link copied to clipboard!');
    });
  });

  // Wire product clicks to save session storage
  grid.querySelectorAll('a[href*="checkout.html"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = new URL(btn.href, location.href);
      const pid = url.searchParams.get('product');
      if (pid) sessionStorage.setItem('last_selected_product', pid);
    });
  });
}

if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    renderProducts(currentFilteredList);
  });
}

function renderCategoryFilters() {
  const sidebar = document.querySelector('#category-sidebar-list');
  if (!sidebar) return;

  const categories = ['all', ...new Set(allProducts.map((p) => p.category || 'General'))];

  sidebar.innerHTML = categories
    .map((cat) => {
      const isActive = cat === activeCategory;
      const count = cat === 'all' ? allProducts.length : allProducts.filter((p) => (p.category || 'General') === cat).length;
      return `
        <button type="button" class="category-filter-btn flex items-center justify-between text-left rounded-lg px-3 py-2 text-sm font-semibold transition ${
          isActive ? 'bg-orange-50 text-orange-700 font-bold' : 'text-slate-600 hover:bg-slate-100'
        }" data-category="${escapeHtml(cat)}">
          <span>${cat === 'all' ? 'All products' : escapeHtml(cat)}</span>
          <span class="text-xs ${isActive ? 'text-orange-600' : 'text-slate-400'}">${count}</span>
        </button>`;
    })
    .join('');

  sidebar.querySelectorAll('.category-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.category;
      visibleCount = PAGE_SIZE; // reset pagination on category switch
      renderCategoryFilters();
      const filtered = activeCategory === 'all' ? allProducts : allProducts.filter((p) => (p.category || 'General') === activeCategory);
      renderProducts(filtered);
    });
  });
}

async function load() {
  document.querySelector('#product-loading')?.classList.remove('hidden');
  const { data, error } = await supabase
    .from('products')
    .select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published')
    .eq('is_published', true)
    .order('created_at', { ascending: false });

  if (error) {
    grid.innerHTML = '<div class="soft-panel p-8 text-slate-600">The catalog is unavailable right now. Please try again shortly.</div>';
    document.querySelector('#product-loading')?.classList.add('hidden');
    finishPageLoader();
    return;
  }

  allProducts = data || [];
  document.querySelector('#product-count').textContent = `${allProducts.length} published title${allProducts.length === 1 ? '' : 's'}`;

  renderCategoryFilters();
  renderProducts(allProducts);

  document.querySelector('#product-loading')?.classList.add('hidden');
  finishPageLoader();
}
document
  .querySelector("#subscribe-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get("email");
    const button = e.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Subscribing…');
    const { error } = await supabase.from("subscribers").insert({ email });
    setButtonLoading(button, false);
    const status = document.querySelector('#subscribe-status');
    if (error && error.code !== '23505') {
      status.textContent = 'We could not save your subscription. Please try again.';
      status.className = 'status-line error';
      toast('Subscription could not be saved.', 'error');
      return;
    }
    status.textContent = 'You’re on the list. Watch your inbox for DigiStore updates.';
    status.className = 'status-line success';
    e.currentTarget.reset();
    toast('Subscription confirmed.');
  });
startPageLoader(); mountHeader();
initMotion();
load();
