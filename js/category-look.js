/**
 * Icon + accent per category slug — the one lookup table shared by the
 * homepage strip, the categories page, and the header's category-nav-bar.
 * Pulled out of categories.js so `js/ui.js` can use it without importing
 * categories.js itself (that module's own top-level `initPage()` call is a
 * dedicated-page side effect that must not run on every page site-wide).
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
