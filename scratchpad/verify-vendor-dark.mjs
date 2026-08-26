import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://127.0.0.1:4173';
const PROJECT_REF = 'synnepvvxpluoydkmphb';

const FAKE_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'creator@creativehub.studio',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {}, user_metadata: {},
};
const FAKE_SESSION = {
  access_token: 'fake-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'fake-refresh-token',
  user: FAKE_USER,
};

const VENDOR = {
  id: 'v1', display_name: 'CreativeHub Studio', slug: 'creativehub-studio', bio: 'We make premium UI kits.',
  logo_url: null, banner_url: null, country: 'GH', payout_currency: 'USD', status: 'approved',
  commission_rate: 15, total_sales_count: 234, total_gross: 14650, total_net: 12452.5,
  applied_at: '2025-01-01T00:00:00Z', approved_at: '2025-01-05T00:00:00Z', support_email: 'support@creativehub.studio',
};

const DASHBOARD = {
  is_vendor: true,
  vendor: VENDOR,
  balance: { available: 8234, pending: 1250, paid: 3200, lifetime: 12452.5, commission: 2197.5, currency: 'USD' },
  counts: { products: 8, published_products: 7, sales: 234, campaigns: 2, payout_accounts: 3 },
  recent_sales: [
    { id: 's1', title: 'Aether UI Kit Premium License', net_amount: 41.65, currency: 'USD', status: 'available', created_at: new Date().toISOString() },
    { id: 's2', title: 'TypeScript Mastery Book', net_amount: 24.65, currency: 'USD', status: 'pending', created_at: new Date().toISOString() },
  ],
  daily_net: Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - i * 86400000).toISOString(), net: Math.random() * 200 })),
};

const PRODUCTS = [
  { id: 'p1', title: 'Aether UI Kit', slug: 'aether-ui-kit', category: 'UI Kits', price: 49, original_price: null, currency: 'USD', cover_url: null, is_published: true, purchase_count: 112, rating_sum: 470, rating_count: 100, created_at: new Date().toISOString() },
  { id: 'p2', title: 'TypeScript Mastery', slug: 'typescript-mastery', category: 'Ebooks & Guides', price: 29, original_price: null, currency: 'USD', cover_url: null, is_published: true, purchase_count: 240, rating_sum: 480, rating_count: 100, created_at: new Date().toISOString() },
  { id: 'p3', title: 'Vibrant 3D Icon Pack', slug: 'vibrant-3d-icons', category: 'Design & Graphics', price: 45, original_price: null, currency: 'USD', cover_url: null, is_published: false, purchase_count: 14, rating_sum: 46, rating_count: 10, created_at: new Date().toISOString() },
];

const EARNINGS = [
  { id: 'e1', gross_amount: 29, commission_amount: 4.35, commission_rate: 15, net_amount: 24.65, currency: 'USD', status: 'available', created_at: new Date().toISOString(), available_at: new Date().toISOString(), products: { title: 'TypeScript Mastery' } },
  { id: 'e2', gross_amount: 49, commission_amount: 7.35, commission_rate: 15, net_amount: 41.65, currency: 'USD', status: 'pending', created_at: new Date().toISOString(), available_at: new Date(Date.now() + 10 * 86400000).toISOString(), products: { title: 'Aether UI Kit' } },
];

const PAYOUT_ACCOUNTS = [
  { id: 'a1', method: 'bank_transfer', country: 'GH', currency: 'USD', account_name: 'Kwame Asante', account_last4: '4521', bank_name: 'First National Bank', momo_provider: null, paypal_email: null, crypto_asset: null, is_default: true, is_verified: true, created_at: new Date().toISOString() },
  { id: 'a2', method: 'paypal', country: 'GH', currency: 'USD', account_name: 'Kwame Asante', account_last4: null, bank_name: null, momo_provider: null, paypal_email: 'creator@creativehub.studio', crypto_asset: null, is_default: false, is_verified: true, created_at: new Date().toISOString() },
];

const PAYOUTS = [
  { id: 'pay1', amount: 1250, currency: 'USD', status: 'paid', reference: 'FT-9923184', requested_at: new Date().toISOString(), processed_at: new Date().toISOString(), failure_reason: null },
];

const AD_WALLET = { balance: 1250, currency: 'USD', lifetime_topup: 5000, lifetime_spend: 3750 };
const AD_WALLET_TX = [
  { type: 'charge', amount: -14.2, balance_after: 1250, currency: 'USD', description: 'Aether UI Kit campaign click deduction', created_at: new Date().toISOString() },
  { type: 'topup', amount: 500, balance_after: 1264.2, currency: 'USD', description: 'Direct gateway funds top-up', created_at: new Date().toISOString() },
];

const CAMPAIGNS = [
  { id: 'c1', name: 'Search Boost - Aether UI', placement: 'search', budget: 500, spend: 234.5, currency: 'USD', status: 'active', review_status: 'approved', review_note: null, impressions: 12400, clicks: 456, conversions: 23, cpm_rate: 2.5, cpc_rate: 0.35, cpa_percent: 3, starts_at: new Date().toISOString(), ends_at: null, products: { title: 'Aether UI Kit' } },
];

const CATEGORIES = [{ name: 'UI Kits', slug: 'ui-kits' }, { name: 'Ebooks & Guides', slug: 'ebooks-guides' }];
const PROFILE = { full_name: 'Kwame Asante', role: 'vendor', phone: null, address: null, country: 'GH', occupation: null, age: null, created_at: '2025-01-01T00:00:00Z' };

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${PROJECT_REF}-auth-token`, session: FAKE_SESSION });

  // Register the catch-all FIRST — Playwright evaluates route handlers
  // most-recently-registered-first, so anything added after this can still
  // take priority for its more specific pattern.
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '0-0/0' }, body: '' });
    console.log('UNMOCKED REST', route.request().method(), url);
    json(route, []);
  });

  await page.route('**/auth/v1/user*', (route) => json(route, { ...FAKE_USER }));
  await page.route('**/auth/v1/token*', (route) => json(route, FAKE_SESSION));

  await page.route(`**/rest/v1/rpc/vendor_dashboard*`, (route) => json(route, DASHBOARD));

  await page.route('**/rest/v1/vendors*', (route) => json(route, [{ status: 'approved' }]));
  await page.route('**/rest/v1/profiles*', (route) => json(route, [PROFILE]));
  await page.route('**/rest/v1/products*', (route) => {
    const url = route.request().url();
    if (route.request().method() !== 'GET') return json(route, {});
    if (/[?&]id=eq\./.test(url)) return json(route, PRODUCTS[0]);
    return json(route, PRODUCTS);
  });
  await page.route('**/rest/v1/vendor_earnings*', (route) => json(route, EARNINGS));
  await page.route('**/rest/v1/payout_accounts*', (route) => json(route, PAYOUT_ACCOUNTS));
  await page.route('**/rest/v1/payouts*', (route) => json(route, PAYOUTS));
  await page.route('**/rest/v1/ad_wallets*', (route) => json(route, AD_WALLET));
  await page.route('**/rest/v1/ad_wallet_transactions*', (route) => json(route, AD_WALLET_TX));
  await page.route('**/rest/v1/ad_funding_payments*', (route) => json(route, []));
  await page.route('**/rest/v1/ad_campaigns*', (route) => json(route, CAMPAIGNS));
  await page.route('**/rest/v1/categories*', (route) => json(route, CATEGORIES));
  await page.route('**/rest/v1/site_settings*', (route) => json(route, []));
  await page.route('**/rest/v1/cart_items*', (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '0-0/0' }, body: '' });
    return json(route, []);
  });

  await page.goto(`${BASE}/vendor.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const outDir = path.resolve('scratchpad');
  await page.screenshot({ path: path.join(outDir, 'vendor-overview.png'), fullPage: true });

  for (const tab of ['products', 'sales', 'payouts', 'boost', 'wallet', 'settings']) {
    await page.evaluate((t) => { location.hash = `#${t}`; }, tab);
    await page.waitForTimeout(400);
    if (tab === 'wallet') await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `vendor-${tab}.png`), fullPage: true });
  }

  // Modal checks
  await page.evaluate(() => { location.hash = '#products'; });
  await page.waitForTimeout(300);
  await page.click('#new-product-btn');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'vendor-modal-product.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => { location.hash = '#payouts'; });
  await page.waitForTimeout(300);
  await page.click('#new-payout-account');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'vendor-modal-payout.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => { location.hash = '#boost'; });
  await page.waitForTimeout(300);
  await page.click('#new-campaign');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'vendor-modal-campaign.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => { location.hash = '#wallet'; });
  await page.waitForTimeout(300);
  await page.click('#topup-btn');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'vendor-modal-topup.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Delete confirm dialog check
  await page.evaluate(() => { location.hash = '#products'; });
  await page.waitForTimeout(300);
  await page.click('[data-delete]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'vendor-confirm-delete.png') });

  console.log('CONSOLE ERRORS:', consoleErrors.length ? consoleErrors : 'none');
  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
