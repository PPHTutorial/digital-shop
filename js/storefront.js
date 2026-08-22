import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';

let allProducts = [];

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
    <article class="scroll-card-item catalog-card flex flex-col justify-between overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 bg-white border border-slate-200/80 rounded-2xl">
      <div>
        <a href="./checkout.html?product=${encodeURIComponent(canonicalSlug)}" class="block relative overflow-hidden bg-slate-100 group aspect-[1.4]">
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
            <a href="./checkout.html?product=${encodeURIComponent(canonicalSlug)}">${escapeHtml(p.title)}</a>
          </h3>
          <p class="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-500">${escapeHtml(p.description || '')}</p>
        </div>
      </div>
      <div class="p-4 sm:p-5 pt-0 mt-auto border-t border-slate-100 flex items-center justify-between gap-2">
        ${priceHtml}
        <div class="flex items-center gap-1.5">
          <button type="button" class="button !min-h-8 !px-2.5 text-xs share-product-btn" data-share-url="${encodeURIComponent(canonicalSlug)}" title="Share product link">
            <i data-lucide="share-2" width="13" height="13"></i>
          </button>
          <a class="button button-primary !min-h-8 !px-3.5 !text-xs font-bold whitespace-nowrap" href="./checkout.html?product=${encodeURIComponent(canonicalSlug)}">Get product</a>
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
        container.innerHTML = sec.items.map((p) => createProductCardHtml(p)).join('');
      } else {
        container.innerHTML = `<div class="p-6 text-xs text-slate-400 bg-white border border-slate-200 rounded-2xl w-full">New releases in this collection are arriving soon.</div>`;
      }
    }
  });

  wireHorizontalScrollButtons();
  wireShareButtons();
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
// Share Buttons
// ============================================================
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
  mountFooter();

  try {
    const { data, error } = await supabase
      .from('products')
      .select('id,title,slug,category,description,price,original_price,currency,cover_url,is_published,created_at')
      .eq('is_published', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading products:', error);
    } else {
      allProducts = data || [];
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }

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
