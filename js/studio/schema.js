/**
 * Content schema.
 *
 * Document types are declared here and nowhere else. The studio compiles these
 * declarations into list columns, editor forms, validation rules, and preview
 * cards, so adding a content type is a matter of adding an entry to `TYPES` —
 * no new UI code.
 *
 * Two storage backends are supported:
 *
 *   store: 'documents'      — rows in `cms_documents`, with a draft/published
 *                             split and full revision history.
 *   store: 'table:<name>'   — an ordinary relational table. Used for records
 *                             that other parts of the system join against
 *                             (products, categories, promotions), where a
 *                             jsonb blob would be the wrong shape.
 */

/* ==========================================================================
   DSL
   ========================================================================== */

/** Declares one field. Defaults are filled in so call sites stay terse. */
export function field(definition) {
  return {
    type: 'string',
    required: false,
    hidden: false,
    readOnly: false,
    ...definition,
    title: definition.title ?? humanise(definition.name),
  };
}

/** Declares one document type. */
export function defineType(definition) {
  const type = {
    store: 'documents',
    icon: 'doc',
    titleField: 'title',
    slugField: null,
    orderings: [],
    listFilters: [],
    singleton: false,
    creatable: true,
    deletable: true,
    ...definition,
    fields: (definition.fields || []).map(field),
  };

  type.fieldsByName = new Map(type.fields.map((f) => [f.name, f]));
  return type;
}

function humanise(name = '') {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/* ==========================================================================
   Shared field fragments
   ========================================================================== */

const seoField = {
  name: 'seo',
  type: 'object',
  title: 'Search engine listing',
  description: 'Overrides the title and description search engines and social cards show.',
  collapsible: true,
  collapsed: true,
  fields: [
    { name: 'title', type: 'string', title: 'Meta title', max: 60, description: 'Around 60 characters.' },
    { name: 'description', type: 'text', title: 'Meta description', rows: 2, max: 160 },
    { name: 'image', type: 'image', title: 'Social share image' },
    { name: 'noindex', type: 'boolean', title: 'Hide from search engines' },
  ],
};

/* ==========================================================================
   Types
   ========================================================================== */

export const TYPES = [
  /* ---------------------------------------------------------------- Catalog */
  defineType({
    name: 'product',
    title: 'Product',
    plural: 'Products',
    group: 'Catalog',
    icon: 'package',
    store: 'table:products',
    titleField: 'title',
    slugField: 'slug',
    publishField: 'is_published',
    orderField: 'sort_order',
    preview: { media: 'cover_url', subtitle: (doc) => doc.category || 'Uncategorised' },
    orderings: [
      { name: 'updated', title: 'Recently updated', column: 'updated_at', ascending: false },
      { name: 'created', title: 'Newest first', column: 'created_at', ascending: false },
      { name: 'title', title: 'Title A–Z', column: 'title', ascending: true },
      { name: 'sales', title: 'Best selling', column: 'purchase_count', ascending: false },
      { name: 'price', title: 'Price, high to low', column: 'price', ascending: false },
    ],
    listFilters: [
      { name: 'published', title: 'Published', column: 'is_published', value: true },
      { name: 'draft', title: 'Draft', column: 'is_published', value: false },
      { name: 'featured', title: 'Featured', column: 'is_featured', value: true },
    ],
    fields: [
      { name: 'title', type: 'string', required: true, max: 140, description: 'Shown on the card and the product page.' },
      { name: 'slug', type: 'slug', source: 'title', required: true, prefix: '/checkout.html?product=' },
      { name: 'category', type: 'reference', to: 'category', valueField: 'name', required: true },
      {
        name: 'short_description',
        type: 'text',
        title: 'Card summary',
        rows: 2,
        max: 180,
        description: 'One or two sentences. Used on catalog cards and in search results.',
      },
      { name: 'description', type: 'blocks', title: 'Full description' },
      { name: 'cover_url', type: 'image', title: 'Cover image', description: '3:2. At least 1200×800.' },
      { name: 'gallery_urls', type: 'gallery', title: 'Gallery', max: 8 },
      { name: 'price', type: 'number', required: true, min: 0, step: 0.01, prefix: '$', group: 'Pricing' },
      {
        name: 'original_price',
        type: 'number',
        title: 'Compare-at price',
        min: 0,
        step: 0.01,
        prefix: '$',
        group: 'Pricing',
        description: 'Leave empty when the product is not on sale. Must be above the price.',
      },
      {
        name: 'currency',
        type: 'select',
        group: 'Pricing',
        options: ['USD', 'GBP', 'EUR', 'NGN', 'GHS', 'KES', 'ZAR'],
        initialValue: 'USD',
      },
      { name: 'file_path', type: 'file', title: 'Deliverable', required: true, bucket: 'books', group: 'Delivery' },
      { name: 'file_type', type: 'string', title: 'File format', placeholder: 'PDF, ZIP, EPUB…', group: 'Delivery' },
      { name: 'file_size_bytes', type: 'number', title: 'File size (bytes)', min: 0, group: 'Delivery', readOnly: true },
      {
        name: 'license_type',
        type: 'select',
        title: 'Licence',
        group: 'Delivery',
        options: ['single-seat', 'team', 'extended', 'open-source'],
        initialValue: 'single-seat',
      },
      { name: 'delivery_note', type: 'text', rows: 2, title: 'Delivery note', group: 'Delivery' },
      { name: 'tags', type: 'tags', group: 'Merchandising' },
      { name: 'is_featured', type: 'boolean', title: 'Feature on the home page', group: 'Merchandising' },
      { name: 'sort_order', type: 'number', title: 'Manual sort weight', step: 1, group: 'Merchandising' },
      { name: 'is_published', type: 'boolean', title: 'Published', group: 'Merchandising', readOnly: true,
        description: 'Controlled by the Publish action.' },
      seoField,
    ],
  }),

  defineType({
    name: 'category',
    title: 'Category',
    plural: 'Categories',
    group: 'Catalog',
    icon: 'tags',
    store: 'table:categories',
    titleField: 'name',
    slugField: 'slug',
    publishField: 'is_active',
    orderField: 'sort_order',
    preview: { media: 'image_url', subtitle: (doc) => doc.slug },
    orderings: [
      { name: 'order', title: 'Manual order', column: 'sort_order', ascending: true },
      { name: 'name', title: 'Name A–Z', column: 'name', ascending: true },
    ],
    fields: [
      { name: 'name', type: 'string', required: true, max: 80 },
      { name: 'slug', type: 'slug', source: 'name', required: true, prefix: '/store.html?category=' },
      { name: 'description', type: 'text', rows: 3, max: 240 },
      { name: 'image_url', type: 'image', title: 'Category image' },
      { name: 'sort_order', type: 'number', title: 'Position', step: 1 },
      { name: 'is_active', type: 'boolean', title: 'Visible in the storefront', readOnly: true },
    ],
  }),

  defineType({
    name: 'promotion',
    title: 'Promotion code',
    plural: 'Promotions',
    group: 'Catalog',
    icon: 'percent',
    store: 'table:promo_codes',
    titleField: 'code',
    publishField: 'is_active',
    preview: {
      subtitle: (doc) =>
        doc.discount_type === 'percent' ? `${doc.discount_value}% off` : `${doc.discount_value} off`,
    },
    orderings: [{ name: 'created', title: 'Newest first', column: 'created_at', ascending: false }],
    fields: [
      { name: 'code', type: 'string', required: true, max: 32, uppercase: true, mono: true,
        description: 'Case-insensitive. Customers type this at checkout.' },
      { name: 'discount_type', type: 'select', required: true, options: ['percent', 'fixed'], initialValue: 'percent' },
      { name: 'discount_value', type: 'number', required: true, min: 0.01, step: 0.01 },
      { name: 'starts_at', type: 'datetime', title: 'Starts' },
      { name: 'ends_at', type: 'datetime', title: 'Ends', description: 'Leave empty for no expiry.' },
      { name: 'max_redemptions', type: 'number', title: 'Redemption limit', min: 1, step: 1 },
      { name: 'redemption_count', type: 'number', title: 'Times used', readOnly: true },
      { name: 'is_active', type: 'boolean', title: 'Active', readOnly: true },
    ],
  }),

  /* ---------------------------------------------------------------- Editorial */
  defineType({
    name: 'post',
    title: 'Journal post',
    plural: 'Journal',
    group: 'Editorial',
    icon: 'journal',
    slugField: 'slug',
    preview: { media: 'cover', subtitle: (doc) => doc.excerpt },
    fields: [
      { name: 'title', type: 'string', required: true, max: 140 },
      { name: 'slug', type: 'slug', source: 'title', required: true, prefix: '/blog/' },
      { name: 'excerpt', type: 'text', rows: 3, max: 240, required: true,
        description: 'Shown on the journal index and in link previews.' },
      { name: 'cover', type: 'image', title: 'Cover image' },
      { name: 'author', type: 'reference', to: 'author' },
      { name: 'published_at', type: 'datetime', title: 'Publish date' },
      { name: 'reading_minutes', type: 'number', title: 'Reading time (minutes)', min: 1, step: 1 },
      { name: 'tags', type: 'tags' },
      { name: 'body', type: 'blocks', required: true },
      seoField,
    ],
  }),

  defineType({
    name: 'author',
    title: 'Author',
    plural: 'Authors',
    group: 'Editorial',
    icon: 'user',
    slugField: 'slug',
    preview: { media: 'avatar', subtitle: (doc) => doc.role },
    fields: [
      { name: 'name', type: 'string', required: true, max: 80 },
      { name: 'slug', type: 'slug', source: 'name', required: true },
      { name: 'role', type: 'string', title: 'Role or title', max: 80 },
      { name: 'avatar', type: 'image', title: 'Portrait' },
      { name: 'bio', type: 'text', rows: 4, max: 320 },
      {
        name: 'links',
        type: 'array',
        title: 'Links',
        max: 5,
        of: {
          name: 'link',
          title: 'Link',
          labelField: 'label',
          fields: [
            { name: 'label', type: 'string', required: true, max: 40 },
            { name: 'url', type: 'url', required: true },
          ],
        },
      },
    ],
  }),

  /* ---------------------------------------------------------------- Site */
  defineType({
    name: 'page',
    title: 'Page',
    plural: 'Pages',
    group: 'Site',
    icon: 'docs',
    slugField: 'slug',
    preview: { subtitle: (doc) => doc.lede },
    fields: [
      { name: 'title', type: 'string', required: true, max: 120 },
      { name: 'slug', type: 'slug', source: 'title', required: true, prefix: '/' },
      { name: 'lede', type: 'text', rows: 3, max: 280, title: 'Introduction' },
      { name: 'body', type: 'blocks' },
      seoField,
    ],
  }),

  defineType({
    name: 'legal',
    title: 'Legal document',
    plural: 'Legal',
    group: 'Site',
    icon: 'shield',
    slugField: 'slug',
    preview: { subtitle: (doc) => doc.summary },
    fields: [
      { name: 'title', type: 'string', required: true, max: 120 },
      { name: 'slug', type: 'slug', source: 'title', required: true, prefix: '/legal.html#' },
      { name: 'summary', type: 'text', rows: 2, max: 200, title: 'One-line summary' },
      { name: 'effective_date', type: 'date', title: 'Effective from' },
      { name: 'body', type: 'blocks', required: true },
    ],
  }),

  defineType({
    name: 'faq',
    title: 'Help article',
    plural: 'Help centre',
    group: 'Site',
    icon: 'help',
    slugField: 'slug',
    preview: { subtitle: (doc) => doc.category },
    orderings: [
      { name: 'manual', title: 'Manual order', column: 'ordering', ascending: true },
      { name: 'updated', title: 'Recently updated', column: 'updated_at', ascending: false },
    ],
    fields: [
      { name: 'title', type: 'string', title: 'Question', required: true, max: 160 },
      { name: 'slug', type: 'slug', source: 'title', required: true },
      {
        name: 'category',
        type: 'select',
        required: true,
        options: ['Orders & delivery', 'Payments', 'Licensing', 'Account', 'Technical'],
      },
      { name: 'answer', type: 'text', rows: 6, required: true, max: 900 },
      { name: 'ordering', type: 'number', title: 'Position', step: 1 },
    ],
  }),

  defineType({
    name: 'announcement',
    title: 'Announcement',
    plural: 'Announcements',
    group: 'Site',
    icon: 'bolt',
    preview: { subtitle: (doc) => doc.message },
    fields: [
      { name: 'title', type: 'string', required: true, max: 80, title: 'Internal name' },
      { name: 'message', type: 'string', required: true, max: 160, description: 'Shown in the utility bar.' },
      { name: 'href', type: 'url', title: 'Link', description: 'Optional. Makes the banner clickable.' },
      { name: 'tone', type: 'select', options: ['info', 'ok', 'warn'], initialValue: 'info' },
      { name: 'starts_at', type: 'datetime', title: 'Show from' },
      { name: 'ends_at', type: 'datetime', title: 'Hide after' },
    ],
  }),

  defineType({
    name: 'homepage',
    title: 'Home page',
    group: 'Site',
    icon: 'home',
    singleton: true,
    creatable: false,
    deletable: false,
    slugField: 'slug',
    fields: [
      { name: 'hero_eyebrow', type: 'string', max: 40, group: 'Hero' },
      { name: 'hero_title', type: 'text', rows: 2, required: true, max: 120, group: 'Hero' },
      { name: 'hero_body', type: 'text', rows: 3, max: 320, group: 'Hero' },
      { name: 'hero_primary_label', type: 'string', max: 32, group: 'Hero' },
      { name: 'hero_primary_href', type: 'string', max: 200, group: 'Hero' },
      { name: 'hero_secondary_label', type: 'string', max: 32, group: 'Hero' },
      { name: 'hero_secondary_href', type: 'string', max: 200, group: 'Hero' },
      {
        name: 'rails',
        type: 'multiselect',
        title: 'Collections to show, in order',
        group: 'Collections',
        options: [
          { value: 'featured', label: 'Featured' },
          { value: 'new', label: 'New arrivals' },
          { value: 'best_selling', label: 'Best selling' },
          { value: 'trending', label: 'Trending' },
          { value: 'deals', label: 'On sale' },
          { value: 'top_rated', label: 'Top rated' },
        ],
      },
      { name: 'band_title', type: 'string', max: 120, group: 'Closing band' },
      { name: 'band_body', type: 'text', rows: 3, max: 320, group: 'Closing band' },
      seoField,
    ],
  }),

  defineType({
    name: 'navigation',
    title: 'Navigation',
    group: 'Site',
    icon: 'panelLeft',
    singleton: true,
    creatable: false,
    deletable: false,
    fields: [
      {
        name: 'primary',
        type: 'array',
        title: 'Primary navigation',
        max: 8,
        of: {
          name: 'item',
          labelField: 'label',
          fields: [
            { name: 'label', type: 'string', required: true, max: 24 },
            { name: 'href', type: 'string', required: true, max: 200 },
          ],
        },
      },
      {
        name: 'footer',
        type: 'array',
        title: 'Footer columns',
        max: 4,
        of: {
          name: 'column',
          labelField: 'heading',
          fields: [
            { name: 'heading', type: 'string', required: true, max: 32 },
            {
              name: 'links',
              type: 'array',
              max: 8,
              of: {
                name: 'link',
                labelField: 'label',
                fields: [
                  { name: 'label', type: 'string', required: true, max: 32 },
                  { name: 'href', type: 'string', required: true, max: 200 },
                ],
              },
            },
          ],
        },
      },
    ],
  }),
];

/* ==========================================================================
   Lookups
   ========================================================================== */

const BY_NAME = new Map(TYPES.map((type) => [type.name, type]));

export function getType(name) {
  const type = BY_NAME.get(name);
  if (!type) throw new Error(`Unknown document type "${name}"`);
  return type;
}

export function hasType(name) {
  return BY_NAME.has(name);
}

/** Types grouped for the structure pane, preserving declaration order. */
export function groupedTypes() {
  const groups = new Map();
  for (const type of TYPES) {
    const key = type.group || 'Content';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(type);
  }
  return Array.from(groups, ([title, types]) => ({ title, types }));
}

/** Fields split into the groups the editor renders as sections. */
export function fieldGroups(type) {
  const groups = new Map();
  for (const f of type.fields) {
    if (f.hidden) continue;
    const key = f.group || 'Content';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return Array.from(groups, ([title, fields]) => ({ title, fields }));
}

/** A blank document with every `initialValue` applied. */
export function emptyDocument(type) {
  const doc = {};
  for (const f of type.fields) {
    if (f.initialValue !== undefined) doc[f.name] = structuredClone(f.initialValue);
    else if (f.type === 'array' || f.type === 'tags' || f.type === 'gallery' || f.type === 'multiselect') doc[f.name] = [];
    else if (f.type === 'boolean') doc[f.name] = false;
    else if (f.type === 'object') doc[f.name] = {};
  }
  return doc;
}

/** The human-readable label for a document, used in lists and breadcrumbs. */
export function documentTitle(type, doc) {
  const value = doc?.[type.titleField];
  return (typeof value === 'string' && value.trim()) || 'Untitled';
}

export function documentSubtitle(type, doc) {
  const preview = type.preview?.subtitle;
  if (!preview) return '';
  const value = typeof preview === 'function' ? preview(doc || {}) : doc?.[preview];
  return typeof value === 'string' ? value : '';
}

export function documentMedia(type, doc) {
  const key = type.preview?.media;
  if (!key) return null;
  const value = doc?.[key];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.url === 'string') return value.url;
  return null;
}
