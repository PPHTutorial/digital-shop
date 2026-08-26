import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://127.0.0.1:4173';
const PROJECT_REF = 'synnepvvxpluoydkmphb';

const FAKE_USER = {
  id: '99999999-9999-9999-9999-999999999999',
  email: 'admin@digistore.test',
  aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {},
};
const FAKE_SESSION = {
  access_token: 'fake-access-token', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh-token', user: FAKE_USER,
};
const PROFILE = { full_name: 'Ama Admin', role: 'admin', phone: null, address: null, country: 'GH', occupation: null, age: null, created_at: '2025-01-01T00:00:00Z' };

const now = () => new Date().toISOString();

const PRODUCTS = [
  { id: 'p1', title: 'Aether UI Kit', slug: 'aether-ui-kit', category: 'UI Kits', price: 49, original_price: 69, currency: 'USD', cover_url: null, description: 'A premium UI kit.', is_published: true, file_path: 'books/f1.zip', created_at: now() },
  { id: 'p2', title: 'TypeScript Mastery', slug: 'typescript-mastery', category: 'Ebooks & Guides', price: 29, original_price: null, currency: 'USD', cover_url: null, description: 'Learn TS.', is_published: false, file_path: null, created_at: now() },
];
const CATEGORIES = [
  { id: 'c1', name: 'UI Kits', slug: 'ui-kits', description: 'Design assets', sort_order: 1, is_active: true },
  { id: 'c2', name: 'Ebooks & Guides', slug: 'ebooks-guides', description: 'Reading material', sort_order: 2, is_active: true },
];
const PROMOS = [
  { id: 'pr1', code: 'SAVE20', discount_type: 'percent', discount_value: 20, redemption_count: 12, max_redemptions: 100, is_active: true },
];
const USERS = [
  { id: 'u1', full_name: 'Kwame Buyer', email: 'kwame@example.com', role: 'customer', phone: '+233555', country: 'GH', created_at: now(), last_sign_in_at: now() },
  { id: 'u2', full_name: 'Ama Admin', email: 'admin@digistore.test', role: 'admin', phone: null, country: 'GH', created_at: now(), last_sign_in_at: null },
];
const ORDERS = [
  { id: 'o1', user_id: 'u1', customer_email: 'kwame@example.com', amount: 49, currency: 'USD', status: 'paid', provider: 'flutterwave', provider_reference: 'FLW-1', created_at: now(), products: { title: 'Aether UI Kit' } },
  { id: 'o2', user_id: 'u1', customer_email: 'kwame@example.com', amount: 29, currency: 'USD', status: 'pending', provider: 'crypto', provider_reference: 'CR-2', created_at: now(), products: { title: 'TypeScript Mastery' } },
];
const TICKETS = [
  { id: 't1', name: 'Kwame Buyer', email: 'kwame@example.com', category: 'Billing', subject: 'Refund question', message: 'I need help with a refund.', status: 'open', created_at: now(), order_ref: 'o1' },
];

const DASHBOARD = {
  metrics: { revenue: 49, paidOrders: 1, customers: 2, openTickets: 1, activeProducts: 1 },
  orders: ORDERS, users: USERS, tickets: TICKETS, products: PRODUCTS, promos: PROMOS, posts: [], categories: CATEGORIES,
  revenueByDay: Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10), revenue: Math.random() * 60 })),
  topProducts: [{ title: 'Aether UI Kit', revenue: 49, orders: 1 }],
  categoryStats: [{ category: 'UI Kits', revenue: 49, products: 1 }],
};

const MODERATION = {
  vendors: [{ id: 'v1', display_name: 'CreativeHub Studio', country: 'GH', payout_currency: 'USD', applied_at: now(), commission_rate: 15, bio: 'We make premium UI kits.' }],
  campaigns: [{ id: 'camp1', name: 'Search Boost', vendor_name: 'CreativeHub Studio', product_title: 'Aether UI Kit', placement: 'search', budget: 500, currency: 'USD', cpm_rate: 2.5, cpc_rate: 0.35, cpa_percent: 3, wallet_balance: 100 }],
  topups: [{ id: 'top1', amount: 100, currency: 'USD', vendor_name: 'CreativeHub Studio', created_at: now(), note: 'MOMO-REF' }],
  payouts: [{ id: 'pay1', amount: 250, currency: 'USD', vendor_name: 'CreativeHub Studio', method: 'bank_transfer', bank_name: 'First National', account_last4: '4521', account_name: 'K. Asante', requested_at: now() }],
};

const CMS_DOCS = [
  { id: 'd1', type: 'page', slug: 'about', title: 'About us', status: 'published', version: 3, updated_at: now(), published_at: now() },
  { id: 'd2', type: 'faq', slug: 'faq-1', title: 'Refund policy FAQ', status: 'changed', version: 5, updated_at: now(), published_at: now() },
  { id: 'd3', type: 'announcement', slug: null, title: 'Holiday sale', status: 'draft', version: 1, updated_at: now(), published_at: null },
];
const CMS_DOC_FULL = {
  d1: { ...CMS_DOCS[0], draft: { heading: 'About DigiStore', subheading: 'Our story', body: 'We are a marketplace.', seo_title: '', seo_description: '' }, published: { heading: 'About DigiStore', subheading: 'Our story', body: 'We are a marketplace.' } },
  d2: { ...CMS_DOCS[1], draft: { question: 'How do refunds work?', answer: 'Within 14 days.', category: 'Billing' }, published: { question: 'How do refunds work?', answer: 'Within 7 days.', category: 'Billing' } },
  d3: { ...CMS_DOCS[2], draft: { message: 'Big holiday sale!', cta_label: 'Shop now', cta_href: '/store' }, published: null },
};
const CMS_REVISIONS = [
  { id: 'r1', version: 3, action: 'publish', title: 'About us', actor_email: 'admin@digistore.test', created_at: now() },
  { id: 'r2', version: 2, action: 'save', title: 'About us', actor_email: 'admin@digistore.test', created_at: now() },
];
const CMS_ASSETS = [
  { id: 'a1', bucket: 'product-images', path: 'cms/hero.jpg', url: 'https://placehold.co/400x300', filename: 'hero.jpg', mime_type: 'image/jpeg', size_bytes: 245000, width: 1200, height: 800, alt: 'Hero image', tags: [], created_at: now() },
];
const AUDIT = [
  { id: 1, actor_email: 'admin@digistore.test', action: 'cms.publish', entity_type: 'page', entity_id: 'd1', summary: 'Published "About us"', created_at: now() },
  { id: 2, actor_email: 'admin@digistore.test', action: 'order.created', entity_type: 'order', entity_id: 'o1', summary: 'Order created', created_at: now() },
];
const SITE_SETTINGS = { id: 1, site_title: 'DigiStore', support_email: 'support@digistore.test', announcement: 'Free shipping on digital goods (always).', tagline: 'The marketplace for makers.', social: { twitter: 'https://x.com/digistore', instagram: '' }, announcement_active: true, announcement_ends_at: null, default_currency: 'USD', checkout_note: 'Thanks for your order.' };

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function run() {
  const browser = await chromium.launch();
  const outDir = path.resolve('scratchpad');

  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

    await page.addInitScript(({ key, session }) => {
      localStorage.setItem(key, JSON.stringify(session));
    }, { key: `sb-${PROJECT_REF}-auth-token`, session: FAKE_SESSION });

    await page.route('**/rest/v1/**', (route) => {
      if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '0-0/0' }, body: '' });
      console.log('UNMOCKED REST', route.request().method(), route.request().url());
      json(route, []);
    });
    await page.route('**/functions/v1/**', (route) => {
      console.log('UNMOCKED FN', route.request().url());
      json(route, {});
    });

    await page.route('**/auth/v1/user*', (route) => json(route, { ...FAKE_USER }));
    await page.route('**/auth/v1/token*', (route) => json(route, FAKE_SESSION));

    await page.route('**/functions/v1/admin-dashboard*', (route) => json(route, DASHBOARD));
    await page.route('**/rest/v1/rpc/moderation_queue*', (route) => json(route, MODERATION));
    await page.route('**/rest/v1/rpc/cms_claim_lock*', (route) => json(route, { held_by_me: true, holder_name: 'Ama Admin', acquired_at: now() }));
    await page.route('**/rest/v1/rpc/cms_release_lock*', (route) => json(route, null));

    await page.route('**/rest/v1/profiles*', (route) => json(route, [PROFILE]));
    await page.route('**/rest/v1/cms_documents*', (route) => {
      const url = route.request().url();
      const idMatch = url.match(/id=eq\.([\w-]+)/);
      if (idMatch && CMS_DOC_FULL[idMatch[1]]) return json(route, CMS_DOC_FULL[idMatch[1]]);
      return json(route, CMS_DOCS);
    });
    await page.route('**/rest/v1/cms_revisions*', (route) => json(route, CMS_REVISIONS));
    await page.route('**/rest/v1/cms_assets*', (route) => json(route, CMS_ASSETS));
    await page.route('**/rest/v1/audit_log*', (route) => json(route, AUDIT));
    await page.route('**/rest/v1/site_settings*', (route) => json(route, SITE_SETTINGS));
    await page.route('**/rest/v1/order_items*', (route) => json(route, [
      { title_snapshot: 'Aether UI Kit', unit_price: 49, quantity: 1, currency: 'USD' },
    ]));
    await page.route('**/rest/v1/categories*', (route) => json(route, CATEGORIES));

    await page.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    await page.screenshot({ path: path.join(outDir, `admin-${theme}-overview.png`), fullPage: true });

    for (const tab of ['customers', 'transactions', 'products', 'categories', 'promotions', 'content', 'moderation', 'tickets', 'settings', 'audit']) {
      await page.evaluate((t) => { location.hash = `#${t}`; }, tab);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, `admin-${theme}-${tab}.png`), fullPage: true });
    }

    // CMS editor deep-dive: history + media tabs, and open a product modal, and a moderation approve reason prompt path
    await page.evaluate(() => { location.hash = '#content'; });
    await page.waitForTimeout(500);
    const historyBtn = await page.$('[data-cms-tab="history"]');
    if (historyBtn) { await historyBtn.click(); await page.waitForTimeout(400); await page.screenshot({ path: path.join(outDir, `admin-${theme}-cms-history.png`) }); }
    const mediaBtn = await page.$('[data-cms-tab="media"]');
    if (mediaBtn) { await mediaBtn.click(); await page.waitForTimeout(400); await page.screenshot({ path: path.join(outDir, `admin-${theme}-cms-media.png`) }); }

    await page.evaluate(() => { location.hash = '#products'; });
    await page.waitForTimeout(300);
    await page.click('#new-product');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `admin-${theme}-modal-product.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    console.log(`[${theme}] CONSOLE ERRORS:`, consoleErrors.length ? consoleErrors : 'none');
    await page.close();
  }

  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
