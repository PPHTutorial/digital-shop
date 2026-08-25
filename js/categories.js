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
  const href = `./store?category=${encodeURIComponent(category.name)}`;
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
 * Bare icon, no tile. The name rides in a tooltip so the strip costs one row
 * of icons rather than a grid of boxes — the tiles were still too heavy on
 * small screens.
 */
export function categoryIcon(category) {
  const href = `./store?category=${encodeURIComponent(category.name)}`;
  return `
    <a class="caticon caticon--${escapeHtml(category.accent)}" href="${href}"
       data-tip="${escapeHtml(category.name)}" aria-label="${escapeHtml(category.name)}">
      ${icon(category.icon, 26)}
    </a>`;
}

/**
 * The home-page strip: popular categories as icons on one scrollable line,
 * with an arrow to the full list. Capped, because the point is compactness.
 */
export function renderCategoryJumbotron(host, categories, cap = 12) {
  if (!host) return;
  // Busiest first — the strip should show what people actually buy.
  const ranked = [...categories].sort((a, b) => b.count - a.count).slice(0, cap);

  host.innerHTML = `
    <div class="catstrip">
      <span class="catstrip__label">Popular</span>
      <div class="catstrip__scroll">${ranked.map(categoryIcon).join('')}</div>
      <a class="catstrip__more" href="./categories" data-tip="All categories" aria-label="View all categories">
        ${icon('arrow-right', 20)}
      </a>
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
