import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { renderCategoryJumbotron, categoryLook } from './categories.js';
import { wishlistButton, loadWishlist, paintWishlist, wireWishlist } from './wishlist.js';

let allProducts = [];
let managedCategories = [];

// ============================================================
// Single Product Card HTML Generator
// ============================================================
function createProductCardHtml(p) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
  const priceHtml = hasDiscount
    ? `<div class="flex items-baseline gap-1.5">
         <span class="price-original text-xs">${p.currency || 'USD'} ${Number(p.original_price).toFixed(2)}</span>
         <strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency || 'USD'} ${Number(p.price).toFixed(2)}</strong>
       </div>`
    : `<strong class="text-base sm:text-lg text-[#142c55] font-black">${p.currency || 'USD'} ${Number(p.price).toFixed(2)}</strong>`;

  const canonicalSlug = p.slug || p.id;

  return `
    <article class="scroll-card-item catalog-card is-clickable" data-product-id="${p.id}">
      <span class="catalog-card__media">
        ${
          p.cover_url
            ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
            : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`
        }
        <span class="catalog-card__badges">
          ${hasDiscount ? `<span class="catalog-card__badge catalog-card__badge--sale">−${discountPct}%</span>` : ''}
        </span>
      </span>

      ${wishlistButton(p.id, p.title)}

      <span class="catalog-card__body">
        <span class="catalog-card__cat">${escapeHtml(p.category || 'General')}</span>
        <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        ${p.description ? `<span class="catalog-card__blurb">${escapeHtml(p.description)}</span>` : ''}
      </span>

      <span class="catalog-card__foot">
        <span class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency || 'USD'} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency || 'USD'} ${Number(p.price).toFixed(2)}</strong>
        </span>
        <span class="catalog-card__go">${icon('arrow-right', 15)}</span>
      </span>

      <a class="catalog-card__link" href="./checkout?product=${encodeURIComponent(canonicalSlug)}">
        <span class="sr-only">${escapeHtml(p.title)}</span>
      </a>
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
        container.innerHTML = sec.items.map((p) => createProductCardHtml(p)).join('');
      } else {
        container.innerHTML = `<div class="p-6 text-xs text-slate-400 bg-white border border-slate-200 rounded-2xl w-full">New releases in this collection are arriving soon.</div>`;
      }
    }
  });

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
// Main Storefront Load
// ============================================================
async function load() {
  mountHeader();
  mountFooter();

  try {
    const [productsResult, categoriesResult] = await Promise.all([
      supabase.from('products').select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published,created_at').eq('is_published', true).order('created_at', { ascending: false }),
      supabase.from('categories').select('name,slug,description,sort_order').eq('is_active', true).order('sort_order').order('name'),
    ]);
    const { data, error } = productsResult;
    managedCategories = categoriesResult.data || [];

    if (error) {
      console.error('Error loading products:', error);
    } else {
      allProducts = data || [];
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }


  // Category jumbotron — counts come from the same product list already loaded.
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
    renderCategoryJumbotron(document.querySelector('#category-jumbotron'), withCounts);
  } catch (error) {
    console.error('Category jumbotron failed:', error);
  }

  await loadWishlist();
  wireWishlist(document.body);
  renderShowcaseSections();
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
