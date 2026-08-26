/**
 * Category presentation.
 *
 * One source of truth for the icon each category carries (`category-look.js`)
 * so the homepage strip and this dedicated page cannot drift apart. Every
 * category shows the same gold icon-circle treatment (Figma uses one uniform
 * accent for all categories, not a rainbow per category), and every count/
 * description is real — no per-tile placeholder copy or invented item counts.
 */
import { supabase } from './client.js';
import { escapeHtml, icon, renderIcons, mountHeader, mountFooter, finishPageLoader, setButtonLoading, toast } from './ui.js';
import { categoryLook } from './category-look.js';

/** Categories plus a live product count, cheapest way: one products read. */
export async function loadCategories() {
  const [categoriesResult, productsResult] = await Promise.all([
    supabase.from('categories').select('name,slug,description,image_url,sort_order')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('products').select('category').eq('is_published', true),
  ]);

  const counts = new Map();
  for (const row of productsResult.data || []) {
    const key = row.category || 'General';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return (categoriesResult.data || []).map((category) => ({
    ...category,
    count: counts.get(category.name) || 0,
    ...categoryLook(category.slug),
  }));
}

/* ==========================================================================
   Dedicated page (Figma "04 — Categories", node 3:2343)
   ========================================================================== */

function categoryTileHtml(category) {
  const href = `./store?category=${encodeURIComponent(category.name)}`;
  return `
    <a class="cat-tile" href="${href}">
      <div class="cat-tile__top">
        <span class="cat-tile__icon">${icon(category.icon, 24)}</span>
        <span class="cat-tile__count">${category.count.toLocaleString()} item${category.count === 1 ? '' : 's'}</span>
      </div>
      <div>
        <h3 class="cat-tile__name">${escapeHtml(category.name)}</h3>
        ${category.description ? `<p class="cat-tile__desc">${escapeHtml(category.description)}</p>` : ''}
      </div>
      <span class="cat-tile__cta">
        <span>Explore Marketplace</span>
        ${icon('arrow-right', 14)}
      </span>
    </a>`;
}

async function initPage() {
  const grid = document.querySelector('#all-categories');
  if (!grid) return;

  mountHeader();
  mountFooter();

  const categories = await loadCategories();

  grid.innerHTML = categories.length
    ? categories.map(categoryTileHtml).join('')
    : '<p class="col-span-full py-12 text-center text-sm" style="color:var(--text-muted)">No categories published yet.</p>';
  renderIcons();

  document.querySelector('#subscribe-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email');
    const button = e.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Subscribing…');
    const { error } = await supabase.from('subscribers').insert({ email });
    setButtonLoading(button, false);
    const status = document.querySelector('#subscribe-status');
    if (error && error.code !== '23505') {
      if (status) { status.textContent = 'Unable to subscribe. Please try again.'; status.className = 'status-line error px-6 pb-4'; }
      toast('Unable to subscribe. Please try again.', 'error');
    } else {
      if (status) { status.textContent = 'Thank you for subscribing to DigiStore updates!'; status.className = 'status-line success px-6 pb-4'; }
      e.currentTarget.reset();
    }
  });

  finishPageLoader();
}

initPage().catch(() => finishPageLoader());
