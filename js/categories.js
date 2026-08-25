/**
 * Category presentation.
 *
 * One source of truth for the icon/accent each category carries and for the
 * card markup, so the home jumbotron and the dedicated page cannot drift apart.
 */
import { supabase } from './client.js';
import { escapeHtml, icon, renderIcons, mountHeader, mountFooter, finishPageLoader } from './ui.js';

/**
 * Icon + accent per category slug. Falls back to a neutral tile, so seeding a
 * new category never renders a blank card.
 */
const LOOKS = {
  'ebooks-guides': { icon: 'book-open', accent: 'amber' },
  'online-courses': { icon: 'graduation-cap', accent: 'violet' },
  'templates-themes': { icon: 'layout-template', accent: 'sky' },
  'software-apps': { icon: 'app-window', accent: 'indigo' },
  'design-graphics': { icon: 'palette', accent: 'rose' },
  'photography-presets': { icon: 'camera', accent: 'teal' },
  'audio-music': { icon: 'music', accent: 'fuchsia' },
  'video-motion': { icon: 'clapperboard', accent: 'red' },
  'fonts-typography': { icon: 'type', accent: 'slate' },
  'ui-kits-wireframes': { icon: 'component', accent: 'cyan' },
  'productivity-templates': { icon: 'list-checks', accent: 'emerald' },
  'stock-media-assets': { icon: 'images', accent: 'orange' },
  'plugins-extensions': { icon: 'puzzle', accent: 'lime' },
  'game-assets': { icon: 'gamepad-2', accent: 'purple' },
  '3d-models-assets': { icon: 'box', accent: 'blue' },
  'marketing-ad-creatives': { icon: 'megaphone', accent: 'pink' },
  'business-legal-documents': { icon: 'scale', accent: 'stone' },
  'spreadsheets-models': { icon: 'table-2', accent: 'green' },
  'printables-planners': { icon: 'printer', accent: 'yellow' },
  'ai-prompts-models': { icon: 'sparkles', accent: 'brand' },
};

export const categoryLook = (slug) => LOOKS[slug] || { icon: 'folder', accent: 'slate' };
const lookFor = categoryLook;

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
    ...lookFor(category.slug),
  }));
}

export function categoryCard(category) {
  const href = `./store.html?category=${encodeURIComponent(category.name)}`;
  return `
    <a class="catcard catcard--${escapeHtml(category.accent)}" href="${href}">
      <span class="catcard__icon">${icon(category.icon, 22)}</span>
      <span class="catcard__body">
        <strong class="catcard__name">${escapeHtml(category.name)}</strong>
        <span class="catcard__count">${category.count} ${category.count === 1 ? 'product' : 'products'}</span>
        ${category.description ? `<span class="catcard__desc">${escapeHtml(category.description)}</span>` : ''}
      </span>
      <span class="catcard__go">${icon('arrow-right', 15)}</span>
    </a>`;
}

/**
 * Compact tile: just an icon and a name. The description and arrow are what
 * made the full card tall, and a row of tall cards pushed the actual products
 * off the first screen — worse on a phone, where they stacked one per row.
 */
export function categoryTile(category) {
  const href = `./store.html?category=${encodeURIComponent(category.name)}`;
  return `
    <a class="cattile cattile--${escapeHtml(category.accent)}" href="${href}" title="${escapeHtml(category.name)}">
      <span class="cattile__icon">${icon(category.icon, 20)}</span>
      <span class="cattile__name">${escapeHtml(category.name)}</span>
      <span class="cattile__count">${category.count}</span>
    </a>`;
}

/**
 * The home-page strip. Compact tiles rather than cards, capped, with the rest
 * behind "View all".
 */
export function renderCategoryJumbotron(host, categories, cap = 10) {
  if (!host) return;
  // Busiest first: an empty category is a poor advert for the marketplace.
  const ranked = [...categories].sort((a, b) => b.count - a.count).slice(0, cap);

  host.innerHTML = `
    <div class="catjumbo">
      <div class="catjumbo__head">
        <div>
          <span class="eyebrow">BROWSE BY CATEGORY</span>
          <h2 class="catjumbo__title">Find exactly what you need</h2>
        </div>
        <a class="catjumbo__all" href="./categories.html">
          <span>All ${categories.length}</span>${icon('arrow-right', 14)}
        </a>
      </div>
      <div class="cattiles">${ranked.map(categoryTile).join('')}</div>
    </div>`;
  renderIcons();
}

/* ==========================================================================
   Dedicated page
   ========================================================================== */

async function initPage() {
  const grid = document.querySelector('#all-categories');
  if (!grid) return;

  mountFooter();
  const categories = await loadCategories();

  const totalProducts = categories.reduce((sum, c) => sum + c.count, 0);
  document.querySelector('#cat-count').textContent =
    `${categories.length} categories · ${totalProducts} products`;

  const render = (list) => {
    grid.innerHTML = list.length
      ? list.map(categoryCard).join('')
      : '<p class="col-span-full py-12 text-center text-sm text-slate-500">No category matches that search.</p>';
    renderIcons();
  };

  render(categories);

  const search = document.querySelector('#cat-search');
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    render(!query ? categories : categories.filter((c) =>
      c.name.toLowerCase().includes(query) || (c.description || '').toLowerCase().includes(query)));
  });

  await mountHeader();
  finishPageLoader();
}

initPage().catch(() => finishPageLoader());
