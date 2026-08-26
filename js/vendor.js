/**
 * Seller centre.
 *
 * Everything money-related is read from `vendor_dashboard()` and written through
 * `apply_as_vendor()` / `request_payout()`. The browser never computes a balance
 * or a payout amount — it only renders what the database reports, and RLS keeps
 * every query scoped to the signed-in vendor.
 */
import { supabase } from './client.js';
import {
  escapeHtml, finishPageLoader, getAccount, icon, mountFooter, mountHeader,
  renderIcons, setButtonLoading, toast,
} from './ui.js';
import {
  confirmDialog, emptyState, openModal, renderDataTable, setButtonBusy,
  statusBadge,
} from './uikit.js';
import { enhanceSelect, refreshSelect } from './select.js';

let account = null;
let dashboard = null;
let vendor = null;
let categories = [];
let myProducts = [];
let wallet = null;

/** Mirrors the minimum enforced by create_ad_funding() in the database. */
const MIN_TOPUP = 25;

/* ==========================================================================
   Jurisdiction — which payout rails exist where
   ========================================================================== */

const COUNTRIES = [
  { code: 'GH', name: 'Ghana', currency: 'GHS' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'KE', name: 'Kenya', currency: 'KES' },
  { code: 'UG', name: 'Uganda', currency: 'UGX' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS' },
  { code: 'RW', name: 'Rwanda', currency: 'RWF' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { code: 'CM', name: 'Cameroon', currency: 'XAF' },
  { code: 'CI', name: "Côte d'Ivoire", currency: 'XOF' },
  { code: 'SN', name: 'Senegal', currency: 'XOF' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
  { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'OTHER', name: 'Elsewhere', currency: 'USD' },
];

/** Mobile money is only offered where it is actually used. */
const MOMO_PROVIDERS = {
  GH: ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'],
  NG: ['MTN MoMo', 'Airtel Money', 'OPay', 'PalmPay'],
  KE: ['M-Pesa', 'Airtel Money'],
  UG: ['MTN MoMo', 'Airtel Money'],
  TZ: ['M-Pesa', 'Tigo Pesa', 'Airtel Money'],
  RW: ['MTN MoMo', 'Airtel Money'],
  CM: ['MTN MoMo', 'Orange Money'],
  CI: ['Orange Money', 'MTN MoMo', 'Moov Money'],
  SN: ['Orange Money', 'Free Money', 'Wave'],
};

function methodsFor(countryCode) {
  const methods = [{ value: 'bank_transfer', label: 'Bank transfer' }];
  if (MOMO_PROVIDERS[countryCode]) methods.push({ value: 'mobile_money', label: 'Mobile money' });
  methods.push({ value: 'paypal', label: 'PayPal' });
  methods.push({ value: 'crypto', label: 'Cryptocurrency' });
  return methods;
}

function countryOptions(selected = 'GH') {
  return COUNTRIES.map((c) => `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

/* ==========================================================================
   Formatting
   ========================================================================== */

const money = (value, currency = 'USD') =>
  `${currency} ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/* ==========================================================================
   Screen routing
   ========================================================================== */

const SCREEN_TITLES = {
  overview: 'Overview',
  products: 'My products',
  sales: 'Sales & earnings',
  payouts: 'Payouts',
  boost: 'Boost & ads',
  wallet: 'Ad wallet',
  team: 'Team',
  settings: 'Store settings',
};

function activateScreen() {
  const key = location.hash.replace('#', '') || 'overview';
  const valid = SCREEN_TITLES[key] ? key : 'overview';
  document.querySelectorAll('.vnd-tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.vndPanel === valid);
  });
  document.querySelectorAll('[data-vnd-link]').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.vndLink === valid);
  });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', activateScreen);

/* ==========================================================================
   Views
   ========================================================================== */

function show(which) {
  ['vendor-gate', 'vendor-apply', 'vendor-status', 'vendor-shell'].forEach((id) => {
    document.querySelector(`#${id}`)?.classList.toggle('hidden', id !== which);
  });
}

function showStatusScreen(status, reason) {
  const copy = {
    pending: {
      icon: 'clock',
      title: 'Your application is under review',
      body: 'We are checking your details. This usually takes less than a working day — you will get an email as soon as your store is approved.',
    },
    suspended: {
      icon: 'pause-circle',
      title: 'Your store is suspended',
      body: reason || 'Selling is paused on this account. Contact support if you believe this is a mistake.',
    },
    rejected: {
      icon: 'x-circle',
      title: 'Your application was not approved',
      body: reason || 'Unfortunately we could not approve this application. You can contact support for details.',
    },
  }[status];

  document.querySelector('#status-icon').innerHTML = icon(copy.icon, 24);
  document.querySelector('#status-title').textContent = copy.title;
  document.querySelector('#status-copy').textContent = copy.body;
  show('vendor-status');
  renderIcons();
  finishPageLoader();
}

/* --- Overview -------------------------------------------------------------- */

function renderOverview() {
  const balance = dashboard.balance || {};
  const counts = dashboard.counts || {};
  const currency = balance.currency || vendor.payout_currency || 'USD';

  document.querySelector('#vnd-welcome-title').textContent = `Welcome back, ${vendor.display_name}`;
  document.querySelector('#vnd-welcome-sub').textContent = vendor.approved_at
    ? `Selling since ${shortDate(vendor.approved_at)}.`
    : 'A snapshot of how your store is performing.';

  document.querySelector('#m-lifetime').textContent = money(balance.lifetime, currency);
  document.querySelector('#m-commission').textContent = `${money(balance.commission, currency)} platform commission`;
  document.querySelector('#m-sales-count').textContent = counts.sales ?? 0;
  document.querySelector('#m-products').textContent = counts.published_products ?? 0;

  const ratingTotals = myProducts.reduce((acc, p) => ({
    sum: acc.sum + Number(p.rating_sum || 0),
    count: acc.count + Number(p.rating_count || 0),
  }), { sum: 0, count: 0 });
  document.querySelector('#m-rating').textContent = ratingTotals.count
    ? (ratingTotals.sum / ratingTotals.count).toFixed(1)
    : '—';
  document.querySelector('#m-rating-note').textContent = ratingTotals.count
    ? `From ${ratingTotals.count} review${ratingTotals.count === 1 ? '' : 's'}`
    : 'No reviews yet';

  document.querySelector('#vnd-sidebar-balance').textContent = money(balance.available, currency);

  renderChart(dashboard.daily_net || []);
  renderChecklist();
  renderRecentSales(dashboard.recent_sales || [], currency);
}

/** Minimal inline bar chart — no dependency. */
function renderChart(daily) {
  const host = document.querySelector('#vendor-chart');
  if (!daily.length) {
    host.innerHTML = '<div class="vnd-chart-empty">Your revenue will chart here after your first sale.</div>';
    return;
  }
  const max = Math.max(...daily.map((d) => Number(d.net)), 1);
  host.innerHTML = `
    <div class="vnd-chart-bars">
      ${daily.map((d) => `
        <div class="vnd-chart-bar" title="${escapeHtml(shortDate(d.day))}: ${money(d.net)}">
          <div class="vnd-chart-bar__fill" style="height:${Math.max(4, (Number(d.net) / max) * 150)}px"></div>
          <small>${new Date(d.day).getDate()}</small>
        </div>`).join('')}
    </div>`;
}

function renderChecklist() {
  const counts = dashboard.counts || {};
  const steps = [
    { done: true, label: 'Store approved', hint: 'You can publish products.' },
    { done: (counts.products ?? 0) > 0, label: 'Add your first product', hint: 'Nothing can sell until you publish something.', href: '#products' },
    { done: (counts.payout_accounts ?? 0) > 0, label: 'Add a payout account', hint: 'Required before you can withdraw.', href: '#payouts' },
    { done: (counts.sales ?? 0) > 0, label: 'Make your first sale', hint: 'Boost a product to reach more buyers.', href: '#boost' },
    { done: (counts.campaigns ?? 0) > 0, label: 'Configure your first ad campaign', hint: 'Get in front of more buyers.', href: '#boost' },
  ];

  document.querySelector('#vendor-checklist').innerHTML = steps.map((step) => `
    <div class="vnd-check-row ${step.done ? 'is-done' : ''}">
      <span class="vnd-check-row__dot">${step.done ? icon('check', 12) : icon('circle', 10)}</span>
      <span class="min-w-0">
        <strong>${escapeHtml(step.label)}</strong>
        ${step.done ? '' : `<span class="vnd-check-hint">${escapeHtml(step.hint)}</span>`}
        ${!step.done && step.href ? `<a href="${step.href}">Go →</a>` : ''}
      </span>
    </div>`).join('');
}

function renderRecentSales(sales, currency) {
  const host = document.querySelector('#recent-sales');
  if (!sales.length) {
    host.innerHTML = emptyState({ icon: 'receipt', title: 'No sales yet', body: 'Once a buyer completes checkout it appears here.' });
    return;
  }
  host.innerHTML = sales.map((sale) => `
    <div class="vnd-activity-row">
      <div class="vnd-activity-row__meta">
        <strong>${escapeHtml(sale.title || 'Product')}</strong>
        <span>${escapeHtml(shortDate(sale.created_at))}</span>
      </div>
      <div class="vnd-activity-row__value">
        <strong>${money(sale.net_amount, sale.currency || currency)}</strong>
        ${statusBadge(sale.status)}
      </div>
    </div>`).join('');
}

/* --- Products -------------------------------------------------------------- */

let productsPage = 1;
const PRODUCTS_PAGE_SIZE = 10;

async function loadProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id,title,slug,category,price,original_price,currency,cover_url,is_published,purchase_count,rating_sum,rating_count,created_at')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false });

  myProducts = data || [];
  const host = document.querySelector('#vendor-products-table');
  if (!host) return;

  if (error) {
    host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load products', body: error.message });
    return;
  }
  if (!myProducts.length) {
    host.innerHTML = emptyState({
      icon: 'package',
      title: 'You have not added a product yet',
      body: 'Publish your first digital product to start selling.',
      ctaLabel: 'Add your first product',
      ctaHref: '#',
    });
    host.querySelector('.uk-empty__cta')?.addEventListener('click', (e) => { e.preventDefault(); openProductModal(); });
    return;
  }

  paintProductsTable();
}

function paintProductsTable() {
  const host = document.querySelector('#vendor-products-table');
  const start = (productsPage - 1) * PRODUCTS_PAGE_SIZE;
  const pageRows = myProducts.slice(start, start + PRODUCTS_PAGE_SIZE);

  renderDataTable(host, {
    columns: [
      {
        key: 'title', label: 'Product', render: (p) => `
          <div class="flex items-center gap-3">
            ${p.cover_url
              ? `<img src="${escapeHtml(p.cover_url)}" alt="" style="width:52px;height:38px;border-radius:6px;object-fit:cover">`
              : `<span style="display:grid;place-items:center;width:52px;height:38px;border-radius:6px;background:var(--surface-sunken);font-size:9px;color:var(--text-soft)">No image</span>`}
            <span class="min-w-0">
              <strong style="display:block;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px">${escapeHtml(p.title)}</strong>
              <span style="font-size:.72rem;color:var(--text-muted)">${escapeHtml(p.category || 'General')}</span>
            </span>
          </div>`,
      },
      { key: 'price', label: 'Price', render: (p) => `<strong>${money(p.price, p.currency)}</strong>` },
      { key: 'purchase_count', label: 'Sales', render: (p) => p.purchase_count ?? 0 },
      { key: 'rating', label: 'Rating', render: (p) => p.rating_count ? `${(p.rating_sum / p.rating_count).toFixed(1)} ★ (${p.rating_count})` : '—' },
      { key: 'status', label: 'Status', render: (p) => statusBadge(p.is_published ? 'published' : 'draft') },
    ],
    rows: pageRows,
    page: productsPage,
    pageSize: PRODUCTS_PAGE_SIZE,
    total: myProducts.length,
    onPage: (p) => { productsPage = p; paintProductsTable(); },
    rowActions: (p) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-edit="${p.id}">Edit</button>
      <button class="button !min-h-8 !px-3 text-xs button-danger" type="button" data-delete="${p.id}">Delete</button>`,
    emptyMessage: 'You have not added a product yet.',
  });
}

/* --- Sales ----------------------------------------------------------------- */

let salesRows = [];
let salesPage = 1;
const SALES_PAGE_SIZE = 10;

async function loadSales() {
  const { data, error } = await supabase
    .from('vendor_earnings')
    .select('id,gross_amount,commission_amount,commission_rate,net_amount,currency,status,created_at,available_at,products(title)')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false })
    .limit(200);

  const host = document.querySelector('#vendor-sales-table');
  if (!host) return;
  if (error) { host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load sales', body: error.message }); return; }

  salesRows = data || [];

  const currency = salesRows[0]?.currency || vendor.payout_currency || 'USD';
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = salesRows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
  const gross30 = recent.reduce((sum, r) => sum + Number(r.gross_amount), 0);
  const net30 = recent.reduce((sum, r) => sum + Number(r.net_amount), 0);
  const commission30 = recent.reduce((sum, r) => sum + Number(r.commission_amount), 0);
  document.querySelector('#s-gross').textContent = money(gross30, currency);
  document.querySelector('#s-net').textContent = money(net30, currency);
  document.querySelector('#s-commission').textContent = money(commission30, currency);
  document.querySelector('#s-commission-label').textContent = `Commission (${vendor.commission_rate}%, 30d)`;

  salesPage = 1;
  paintSalesTable();
}

function paintSalesTable() {
  const host = document.querySelector('#vendor-sales-table');
  const start = (salesPage - 1) * SALES_PAGE_SIZE;
  const pageRows = salesRows.slice(start, start + SALES_PAGE_SIZE);

  renderDataTable(host, {
    columns: [
      { key: 'product', label: 'Product', render: (r) => `<strong>${escapeHtml(r.products?.title || 'Product')}</strong>` },
      { key: 'created_at', label: 'Date', render: (r) => shortDate(r.created_at) },
      { key: 'gross_amount', label: 'Gross', render: (r) => money(r.gross_amount, r.currency) },
      { key: 'commission_amount', label: 'Comm.', render: (r) => `−${money(r.commission_amount, r.currency)} (${r.commission_rate}%)` },
      { key: 'net_amount', label: 'Net', render: (r) => `<strong>${money(r.net_amount, r.currency)}</strong>` },
      {
        key: 'status', label: 'Status', render: (r) => `
          ${statusBadge(r.status, r.status === 'available' ? 'Available' : undefined)}
          ${r.status === 'pending' ? `<div style="font-size:.66rem;color:var(--text-soft);margin-top:2px">clears ${escapeHtml(shortDate(r.available_at))}</div>` : ''}`,
      },
    ],
    rows: pageRows,
    page: salesPage,
    pageSize: SALES_PAGE_SIZE,
    total: salesRows.length,
    onPage: (p) => { salesPage = p; paintSalesTable(); },
    emptyMessage: 'No sales recorded yet.',
  });
}

/* --- Payouts --------------------------------------------------------------- */

let payoutAccounts = [];
let payoutHistory = [];

async function loadPayouts() {
  const balance = dashboard.balance || {};
  const currency = balance.currency || vendor.payout_currency || 'USD';

  document.querySelector('#payout-balance').textContent = money(balance.available, currency);
  document.querySelector('#payout-balance-note').textContent =
    Number(balance.pending) > 0
      ? `${money(balance.pending, currency)} still clearing the refund window.`
      : 'Earnings become available after the refund window closes.';

  const [accountsResult, historyResult] = await Promise.all([
    supabase.from('payout_accounts')
      .select('id,method,country,currency,account_name,account_last4,bank_name,momo_provider,paypal_email,crypto_asset,is_default,is_verified,created_at')
      .eq('vendor_id', vendor.id).order('created_at', { ascending: false }),
    supabase.from('payouts')
      .select('id,amount,currency,status,reference,requested_at,processed_at,failure_reason')
      .eq('vendor_id', vendor.id).order('requested_at', { ascending: false }).limit(50),
  ]);

  payoutAccounts = accountsResult.data || [];
  const accountsHost = document.querySelector('#payout-accounts-list');

  accountsHost.innerHTML = payoutAccounts.length
    ? payoutAccounts.map((a) => {
        const label = {
          bank_transfer: `${a.bank_name || 'Bank'} ····${a.account_last4 || ''}`,
          mobile_money: `${a.momo_provider || 'Mobile money'} ····${a.account_last4 || ''}`,
          paypal: a.paypal_email || 'PayPal',
          crypto: `${a.crypto_asset || 'Crypto'} ····${a.account_last4 || ''}`,
        }[a.method];
        return `
          <div class="vnd-account-row">
            <div class="vnd-account-row__meta">
              <strong>${escapeHtml(label)}</strong>
              <span>${escapeHtml(a.account_name)} · ${escapeHtml(a.country)}</span>
            </div>
            <div class="vnd-account-row__actions">
              ${a.is_default ? '<span class="uk-badge uk-badge--info">Default</span>' : ''}
              ${statusBadge(a.is_verified ? 'verified' : 'pending')}
              <button class="button !min-h-8 !px-3 text-xs button-danger" type="button" data-delete-account="${a.id}">Remove</button>
            </div>
          </div>`;
      }).join('')
    : emptyState({ icon: 'landmark', title: 'No payout account yet', body: 'Add one before requesting a withdrawal.' });

  payoutHistory = historyResult.data || [];
  const historyHost = document.querySelector('#payouts-history');
  renderDataTable(historyHost, {
    columns: [
      { key: 'amount', label: 'Amount', render: (p) => `<strong>${money(p.amount, p.currency)}</strong>` },
      { key: 'reference', label: 'Reference', render: (p) => p.reference ? `<span style="font-family:var(--font-mono);font-size:.78rem">${escapeHtml(p.reference)}</span>` : '—' },
      { key: 'requested_at', label: 'Requested', render: (p) => shortDate(p.requested_at) },
      {
        key: 'status', label: 'Status', render: (p) => `
          ${statusBadge(p.status)}
          ${p.failure_reason ? `<div style="font-size:.66rem;color:var(--danger);margin-top:2px">${escapeHtml(p.failure_reason)}</div>` : ''}`,
      },
    ],
    rows: payoutHistory,
    page: 1,
    pageSize: payoutHistory.length || 1,
    total: payoutHistory.length,
    emptyMessage: 'No withdrawals yet.',
  });

  return payoutAccounts;
}

/* --- Ad wallet --------------------------------------------------------------- */

async function loadWallet() {
  const { data } = await supabase
    .from('ad_wallets').select('balance,currency,lifetime_topup,lifetime_spend')
    .eq('vendor_id', vendor.id).maybeSingle();

  wallet = data || { balance: 0, currency: vendor.payout_currency || 'USD', lifetime_topup: 0, lifetime_spend: 0 };

  document.querySelector('#wallet-balance').textContent = money(wallet.balance, wallet.currency);
  document.querySelector('#wallet-balance-mini').textContent = money(wallet.balance, wallet.currency);
  document.querySelector('#wallet-lifetime-topup').textContent = money(wallet.lifetime_topup, wallet.currency);
  document.querySelector('#wallet-lifetime-spend').textContent = money(wallet.lifetime_spend, wallet.currency);

  const baseNote = Number(wallet.balance) > 0
    ? `${money(wallet.lifetime_spend, wallet.currency)} spent on ads so far.`
    : 'Top up before your campaigns can run.';
  document.querySelector('#wallet-note').textContent = baseNote;
  document.querySelector('#wallet-note-mini').textContent = baseNote;

  // A crypto/bank payment can sit unconfirmed for a while; surface it so the
  // seller is not left wondering where their money went.
  const { data: inFlight } = await supabase
    .from('ad_funding_payments').select('amount,currency,provider,created_at')
    .eq('vendor_id', vendor.id).eq('status', 'pending')
    .gt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if (inFlight?.length) {
    const total = inFlight.reduce((sum, r) => sum + Number(r.amount), 0);
    const extra = ` ${money(total, wallet.currency)} awaiting payment confirmation.`;
    document.querySelector('#wallet-note').textContent += extra;
    document.querySelector('#wallet-note-mini').textContent += extra;
  }
}

async function loadWalletHistory() {
  const host = document.querySelector('#wallet-history');
  if (!host) return;
  const { data } = await supabase
    .from('ad_wallet_transactions')
    .select('type,amount,balance_after,currency,description,created_at')
    .eq('vendor_id', vendor.id).order('created_at', { ascending: false }).limit(50);

  renderDataTable(host, {
    columns: [
      { key: 'created_at', label: 'Date', render: (t) => shortDate(t.created_at) },
      { key: 'type', label: 'Type', render: (t) => statusBadge(t.type === 'topup' ? 'active' : t.type === 'refund' ? 'available' : t.type === 'charge' ? 'pending' : t.type, t.type) },
      { key: 'description', label: 'Description', render: (t) => escapeHtml(t.description || '—') },
      {
        key: 'amount', label: 'Amount', render: (t) => `
          <strong style="color:${Number(t.amount) < 0 ? 'var(--danger)' : '#2dab66'}">
            ${Number(t.amount) < 0 ? '' : '+'}${money(t.amount, t.currency)}
          </strong>`,
      },
      { key: 'balance_after', label: 'Wallet bal.', render: (t) => money(t.balance_after, t.currency) },
    ],
    rows: data || [],
    page: 1,
    pageSize: (data || []).length || 1,
    total: (data || []).length,
    emptyMessage: 'No wallet activity yet.',
  });
}

/* --- Wallet top-up modal ----------------------------------------------------- */

function openTopupModal() {
  const { dialog } = openModal({
    id: 'topup-modal',
    title: 'Add funds to your ad wallet',
    body: `
      <p style="margin-bottom:16px">Your wallet is credited automatically as soon as the payment clears.</p>
      <form id="topup-form">
        <span class="label">Amount</span>
        <div class="mt-1 flex flex-wrap gap-2" id="topup-presets">
          ${[25, 50, 100, 250].map((n) => `<button type="button" class="button !min-h-9 !px-4 text-xs" data-amount="${n}">$${n}</button>`).join('')}
        </div>
        <input class="field mt-3 font-bold" name="amount" type="number" step="1" min="${MIN_TOPUP}" value="${MIN_TOPUP}" required>
        <small class="help">Minimum $${MIN_TOPUP}. Enter any higher amount you like.</small>

        <div class="mt-4">
          <span class="label">Pay with</span>
          <div class="mt-2 grid gap-2">
            <label class="vnd-check-line" style="align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md)">
              <input type="radio" name="provider" value="flutterwave" checked>
              <span>
                <strong style="display:block">Card, bank transfer or mobile money</strong>
                <span style="font-size:.76rem;color:var(--text-muted)">Visa, Mastercard, bank transfer, MTN MoMo, M-Pesa</span>
              </span>
            </label>
            <label class="vnd-check-line" style="align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md)">
              <input type="radio" name="provider" value="nowpayments">
              <span>
                <strong style="display:block">Cryptocurrency</strong>
                <span style="font-size:.76rem;color:var(--text-muted)">Bitcoin, Ethereum, USDT and 300+ coins</span>
              </span>
            </label>
          </div>
        </div>
        <p id="topup-feedback" class="status-line mt-3 text-xs"></p>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="topup-form" class="button button-primary">Continue to payment</button>`,
  });

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#topup-presets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-amount]');
    if (!button) return;
    dialog.querySelector('#topup-form').elements.amount.value = button.dataset.amount;
  });

  dialog.querySelector('#topup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = dialog.querySelector('#topup-feedback');
    const button = dialog.querySelector('button[form="topup-form"]');
    const amount = Number(form.elements.amount.value);

    if (!Number.isFinite(amount) || amount < MIN_TOPUP) {
      feedback.textContent = `The minimum top-up is $${MIN_TOPUP}.`;
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'flutterwave';

    setBusy(button, true, 'Opening payment…');
    feedback.textContent = 'Preparing a secure payment page…';
    feedback.className = 'status-line mt-3 text-xs';

    const siteUrl = /localhost|127\.0\.0\.1/.test(window.location.origin)
      ? window.location.origin
      : 'https://digistore.codeinktechnologies.com';

    const { data, error } = await supabase.functions.invoke('create-ad-funding-payment', {
      body: { amount, provider, site_url: siteUrl },
    });

    if (error || !data?.payment_url) {
      setBusy(button, false);
      feedback.textContent = data?.error || error?.message || 'The payment page could not be opened.';
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    window.location.href = data.payment_url;
  });
}

/**
 * The funding callback returns here with ?funding=<state>. The wallet is
 * credited server-side, so this only reports the outcome and cleans the URL.
 */
function reportFundingOutcome() {
  const state = new URLSearchParams(window.location.search).get('funding');
  if (!state) return;

  const messages = {
    success: ['Payment received — your wallet has been credited.', 'success'],
    cancelled: ['Top-up cancelled. Nothing was charged.', 'info'],
    failed: ['That payment did not go through. Nothing was charged.', 'error'],
    unknown: ['We could not match that payment. Contact support if you were charged.', 'error'],
    error: ['Something went wrong confirming the payment.', 'error'],
  };
  const [message, kind] = messages[state] || messages.error;
  toast(message, kind === 'success' ? 'success' : kind === 'info' ? 'info' : 'error');

  const url = new URL(window.location.href);
  url.searchParams.delete('funding');
  history.replaceState(null, '', url.toString());
}

/* --- Campaigns --------------------------------------------------------------- */

async function loadCampaigns() {
  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('id,name,placement,budget,spend,currency,status,review_status,review_note,impressions,clicks,conversions,cpm_rate,cpc_rate,cpa_percent,starts_at,ends_at,products(title)')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false });

  // Show the live rate card from whatever campaign exists, else the defaults.
  const rates = data?.[0] || { cpm_rate: 2.5, cpc_rate: 0.35, cpa_percent: 3 };
  const rateCurrency = wallet?.currency || vendor.payout_currency || 'USD';
  const rateHost = document.querySelector('#rate-card');
  if (rateHost) {
    rateHost.innerHTML = `
      <div class="grid grid-cols-3 gap-2 text-center">
        <div style="border-radius:var(--radius-md);background:var(--surface-sunken);padding:12px">
          <strong style="display:block;font-family:var(--font-display);color:var(--text)">${money(rates.cpm_rate, rateCurrency)}</strong>
          <span style="font-size:.62rem;font-weight:700;text-transform:uppercase;color:var(--text-soft)">per 1,000 views</span>
        </div>
        <div style="border-radius:var(--radius-md);background:var(--surface-sunken);padding:12px">
          <strong style="display:block;font-family:var(--font-display);color:var(--text)">${money(rates.cpc_rate, rateCurrency)}</strong>
          <span style="font-size:.62rem;font-weight:700;text-transform:uppercase;color:var(--text-soft)">per click</span>
        </div>
        <div style="border-radius:var(--radius-md);background:var(--surface-sunken);padding:12px">
          <strong style="display:block;font-family:var(--font-display);color:var(--text)">${rates.cpa_percent}%</strong>
          <span style="font-size:.62rem;font-weight:700;text-transform:uppercase;color:var(--text-soft)">per sale</span>
        </div>
      </div>`;
  }

  const host = document.querySelector('#campaigns-list');
  if (!host) return;
  if (error) { host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load campaigns', body: error.message }); return; }
  if (!data?.length) {
    host.innerHTML = emptyState({
      icon: 'megaphone',
      title: 'No campaigns yet',
      body: 'Boosting puts a product in front of more buyers.',
      ctaLabel: 'Create a campaign',
      ctaHref: '#',
    });
    host.querySelector('.uk-empty__cta')?.addEventListener('click', (e) => { e.preventDefault(); openCampaignModal(); });
    return;
  }

  host.innerHTML = data.map((c) => {
    const used = Math.min(100, (Number(c.spend) / Number(c.budget || 1)) * 100);
    const statusChip = c.review_status === 'pending'
      ? statusBadge('pending', 'In review')
      : c.review_status === 'rejected'
        ? statusBadge('rejected')
        : statusBadge(c.status);
    return `
      <div class="vnd-campaign-card">
        <div class="vnd-campaign-card__head">
          <div class="min-w-0">
            <strong>${escapeHtml(c.name)}</strong>
            <div class="vnd-campaign-card__sub">Targeting: ${escapeHtml(c.products?.title || '—')}</div>
          </div>
          ${statusChip}
        </div>
        ${c.review_status === 'rejected' && c.review_note ? `<div style="margin-top:6px;font-size:.72rem;color:var(--text-soft)">${escapeHtml(c.review_note)}</div>` : ''}
        <div class="vnd-campaign-bar"><div class="vnd-campaign-bar__fill" style="width:${used}%"></div></div>
        <div class="vnd-campaign-spend">${money(c.spend, c.currency)} / ${money(c.budget, c.currency)} spent · ${escapeHtml(c.placement)}</div>
        <div class="vnd-campaign-stats">
          <div><strong>${Number(c.impressions).toLocaleString()}</strong><span>Views</span></div>
          <div><strong>${Number(c.clicks).toLocaleString()}</strong><span>Clicks</span></div>
          <div><strong>${Number(c.conversions).toLocaleString()}</strong><span>Sold</span></div>
        </div>
        ${c.review_status === 'approved' && ['active', 'paused'].includes(c.status)
          ? `<div class="vnd-campaign-card__actions"><button class="button !min-h-8 !px-3 text-xs" type="button" data-toggle-campaign="${c.id}" data-status="${c.status}">${c.status === 'active' ? 'Pause' : 'Resume'}</button></div>`
          : ''}
      </div>`;
  }).join('');

  renderIcons();
}

function openCampaignModal() {
  const sellable = myProducts.filter((p) => p.is_published);
  if (!sellable.length) {
    toast('Publish a product before boosting it.', 'error');
    location.hash = '#products';
    return;
  }

  const { dialog } = openModal({
    id: 'campaign-modal',
    title: 'Promote a product',
    body: `
      <form id="campaign-form">
        <label class="vnd-field vnd-field--span2">
          <span class="label">Campaign name</span>
          <input class="field" name="name" required placeholder="e.g. Launch week push">
        </label>
        <label class="vnd-field vnd-field--span2" style="margin-top:14px">
          <span class="label">Product</span>
          <select class="field" name="product_id" required>
            ${sellable.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('')}
          </select>
        </label>
        <div class="vnd-modal-grid" style="margin-top:14px">
          <label class="vnd-field">
            <span class="label">Placement</span>
            <select class="field" name="placement">
              <option value="featured">Featured — home page rails</option>
              <option value="search">Search — weighted in results</option>
              <option value="category">Category — top of its category</option>
            </select>
          </label>
          <label class="vnd-field">
            <span class="label">Budget</span>
            <input class="field" name="budget" type="number" step=".01" min="1" required placeholder="50.00">
          </label>
          <label class="vnd-field">
            <span class="label">Starts</span>
            <input class="field" name="starts_at" type="date" value="${new Date().toISOString().slice(0, 10)}">
          </label>
          <label class="vnd-field">
            <span class="label">Ends <span class="vnd-optional">(optional)</span></span>
            <input class="field" name="ends_at" type="date">
          </label>
        </div>
        <p class="vnd-callout" style="margin-top:14px">
          Campaigns start as a draft and are reviewed before going live. Spend is drawn from your ad wallet balance.
        </p>
        <p id="campaign-feedback" class="status-line text-xs my-0"></p>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="campaign-form" class="button button-primary">Create campaign</button>`,
  });

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#campaign-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = dialog.querySelector('#campaign-feedback');
    const button = dialog.querySelector('button[form="campaign-form"]');

    setBusy(button, true, 'Creating…');
    const { error } = await supabase.from('ad_campaigns').insert({
      vendor_id: vendor.id,
      product_id: form.elements.product_id.value,
      name: form.elements.name.value.trim(),
      placement: form.elements.placement.value,
      budget: Number(form.elements.budget.value),
      currency: vendor.payout_currency || 'USD',
      starts_at: form.elements.starts_at.value || new Date().toISOString(),
      ends_at: form.elements.ends_at.value || null,
    });
    setBusy(button, false);

    if (error) {
      feedback.textContent = error.message;
      feedback.className = 'status-line error text-xs my-0';
      return;
    }
    dialog.close();
    toast('Campaign submitted — it goes live once our team approves it.');
    await loadCampaigns();
  });
}

/* ==========================================================================
   Uploads
   ========================================================================== */

/**
 * Storage RLS only accepts writes under vendors/<vendor_id>/, so every upload
 * path is built here rather than at each call site.
 */
function vendorPath(kind, fileName) {
  const safe = fileName.replace(/[^a-z0-9._-]/gi, '_');
  return `vendors/${vendor.id}/${kind}/${Date.now()}-${safe}`;
}

async function uploadTo(bucket, kind, file, statusEl) {
  if (statusEl) {
    statusEl.textContent = 'Uploading…';
    statusEl.className = 'help';
  }
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(vendorPath(kind, file.name), file, { upsert: true });

  if (error) {
    if (statusEl) {
      statusEl.textContent = error.message;
      statusEl.className = 'help';
      statusEl.style.color = 'var(--danger)';
    }
    return null;
  }
  if (statusEl) {
    statusEl.textContent = `✓ ${file.name}`;
    statusEl.className = 'help';
    statusEl.style.color = '#2dab66';
  }
  return data.path;
}

/* ==========================================================================
   Product editor
   ========================================================================== */

function slugify(value) {
  return (value || '').toLowerCase().trim()
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function openProductModal(product = null) {
  const { dialog } = openModal({
    id: 'product-modal',
    title: product ? 'Edit product' : 'New product',
    body: `
      <form id="product-form">
        <input type="hidden" name="id" value="${product?.id || ''}">
        <label class="vnd-field vnd-field--span2">
          <span class="label">Title</span>
          <input class="field" name="title" id="v-title" required placeholder="e.g. The 24-Hour Product Launch Kit" value="${escapeHtml(product?.title || '')}">
        </label>
        <div class="vnd-modal-grid" style="margin-top:14px">
          <label class="vnd-field">
            <span class="label">Category</span>
            <select class="field" name="category" id="v-category">
              ${categories.map((c) => `<option value="${escapeHtml(c.name)}" ${product?.category === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </label>
          <label class="vnd-field">
            <span class="label">URL slug</span>
            <input class="field font-mono text-xs" name="slug" id="v-slug" required value="${escapeHtml(product?.slug || '')}">
          </label>
          <label class="vnd-field">
            <span class="label">Price</span>
            <input class="field font-bold" name="price" type="number" step=".01" min="0" required placeholder="0.00" value="${product?.price ?? ''}">
          </label>
          <label class="vnd-field">
            <span class="label">Compare-at price <span class="vnd-optional">(optional)</span></span>
            <input class="field" name="original_price" type="number" step=".01" min="0" placeholder="0.00" value="${product?.original_price ?? ''}">
          </label>
        </div>
        <label class="vnd-field vnd-field--span2" style="margin-top:14px">
          <span class="label">Short description</span>
          <input class="field" name="short_description" maxlength="160" placeholder="One line shown on the product card" value="${escapeHtml(product?.short_description || '')}">
        </label>
        <label class="vnd-field vnd-field--span2" style="margin-top:14px">
          <span class="label">Full description</span>
          <textarea class="field" name="description" rows="4" placeholder="What's included, who it's for, what they'll achieve…">${escapeHtml(product?.description || '')}</textarea>
        </label>
        <div class="vnd-modal-grid" style="margin-top:14px">
          <div>
            <span class="label">Cover image</span>
            <div class="vnd-upload mt-1">
              <input type="file" id="v-cover-file" accept="image/*" class="text-xs">
              <img id="v-cover-preview" class="${product?.cover_url ? '' : 'hidden'}" src="${escapeHtml(product?.cover_url || '')}" alt="">
            </div>
            <input type="hidden" name="cover_url" id="v-cover-url" value="${escapeHtml(product?.cover_url || '')}">
            <small id="v-cover-status" class="help"></small>
          </div>
          <div>
            <span class="label">Product file <span class="vnd-optional">(what buyers download)</span></span>
            <div class="vnd-upload mt-1">
              <input type="file" id="v-product-file" class="text-xs">
            </div>
            <input type="hidden" name="file_path" id="v-file-path" value="${escapeHtml(product?.file_path || '')}">
            <small id="v-file-status" class="help"></small>
          </div>
          <label class="vnd-field">
            <span class="label">File type</span>
            <input class="field" name="file_type" placeholder="e.g. PDF, ZIP, MP4" value="${escapeHtml(product?.file_type || '')}">
          </label>
          <label class="vnd-field">
            <span class="label">Licence</span>
            <select class="field" name="license_type">
              <option value="personal" ${product?.license_type === 'personal' ? 'selected' : ''}>Personal use</option>
              <option value="commercial" ${product?.license_type === 'commercial' ? 'selected' : ''}>Commercial use</option>
              <option value="extended" ${product?.license_type === 'extended' ? 'selected' : ''}>Extended licence</option>
            </select>
          </label>
        </div>
        <label class="vnd-check-line" style="margin-top:14px">
          <input type="checkbox" name="is_published" ${!product || product.is_published ? 'checked' : ''}>
          Publish to the storefront
        </label>
        <p id="product-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="product-form" class="button button-primary">Save product</button>`,
  });
  dialog.classList.add('uk-modal--wide');

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());

  dialog.querySelector('#v-title').addEventListener('input', (event) => {
    const slugField = dialog.querySelector('#v-slug');
    // Only auto-fill the slug while creating; never rewrite a published URL.
    if (!dialog.querySelector('#product-form').elements.id.value) {
      slugField.value = slugify(event.target.value);
    }
  });

  dialog.querySelector('#v-cover-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const path = await uploadTo('product-images', 'covers', file, dialog.querySelector('#v-cover-status'));
    if (!path) return;
    const { data } = supabase.storage.from('product-images').getPublicUrl(path);
    dialog.querySelector('#v-cover-url').value = data.publicUrl;
    const preview = dialog.querySelector('#v-cover-preview');
    preview.src = data.publicUrl;
    preview.classList.remove('hidden');
  });

  dialog.querySelector('#v-product-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const path = await uploadTo('books', 'files', file, dialog.querySelector('#v-file-status'));
    if (!path) return;
    dialog.querySelector('#v-file-path').value = path;
    // Offer the extension as the file type when the seller has not set one.
    const typeField = dialog.querySelector('#product-form').elements.file_type;
    if (!typeField.value) typeField.value = (file.name.split('.').pop() || '').toUpperCase();
  });

  dialog.querySelector('#product-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="product-form"]');
    const feedback = dialog.querySelector('#product-feedback');
    const id = form.elements.id.value;

    const filePath = dialog.querySelector('#v-file-path').value;
    if (!filePath) {
      feedback.textContent = 'Upload the file buyers will download.';
      feedback.className = 'status-line error text-xs my-0';
      return;
    }

    const payload = {
      vendor_id: vendor.id,
      title: form.elements.title.value.trim(),
      slug: slugify(form.elements.slug.value) || slugify(form.elements.title.value),
      category: dialog.querySelector('#v-category').value,
      price: Number(form.elements.price.value),
      original_price: form.elements.original_price.value ? Number(form.elements.original_price.value) : null,
      short_description: form.elements.short_description.value.trim() || null,
      description: form.elements.description.value.trim() || null,
      cover_url: dialog.querySelector('#v-cover-url').value || null,
      file_path: filePath,
      file_type: form.elements.file_type.value.trim() || null,
      license_type: form.elements.license_type.value,
      is_published: form.elements.is_published.checked,
      currency: vendor.payout_currency || 'USD',
    };

    setBusy(button, true, 'Saving…');
    const { error } = id
      ? await supabase.from('products').update(payload).eq('id', id)
      : await supabase.from('products').insert(payload);
    setBusy(button, false);

    if (error) {
      feedback.textContent = error.message;
      feedback.className = 'status-line error text-xs my-0';
      return;
    }

    dialog.close();
    toast(id ? 'Product updated.' : 'Product published.');
    await loadProducts();
    await refreshDashboard();
  });

  renderIcons();
}

/* ==========================================================================
   Payout account editor
   ========================================================================== */

function openPayoutModal() {
  const { dialog } = openModal({
    id: 'payout-modal',
    title: 'Payout account',
    body: `
      <form id="payout-form">
        <div class="vnd-modal-grid">
          <label class="vnd-field">
            <span class="label">Country</span>
            <select class="field" name="country" id="payout-country">${countryOptions(vendor.country)}</select>
          </label>
          <label class="vnd-field">
            <span class="label">Method</span>
            <select class="field" name="method" id="payout-method"></select>
          </label>
        </div>
        <label class="vnd-field vnd-field--span2" style="margin-top:14px">
          <span class="label">Account holder name</span>
          <input class="field" name="account_name" required placeholder="Name exactly as it appears on the account">
        </label>

        <div id="fields-bank" class="hidden vnd-modal-grid" style="margin-top:14px">
          <label class="vnd-field vnd-field--span2">
            <span class="label">Bank name</span>
            <input class="field" name="bank_name" placeholder="e.g. GCB Bank">
          </label>
          <label class="vnd-field">
            <span class="label">Account number</span>
            <input class="field font-mono" name="account_number" inputmode="numeric" autocomplete="off">
          </label>
          <label class="vnd-field">
            <span class="label">Branch / sort code <span class="vnd-optional">(optional)</span></span>
            <input class="field" name="branch_code">
          </label>
          <label class="vnd-field">
            <span class="label">SWIFT / BIC <span class="vnd-optional">(optional)</span></span>
            <input class="field" name="swift_code">
          </label>
          <label class="vnd-field">
            <span class="label">IBAN <span class="vnd-optional">(optional)</span></span>
            <input class="field" name="iban">
          </label>
        </div>

        <div id="fields-momo" class="hidden vnd-modal-grid" style="margin-top:14px">
          <label class="vnd-field">
            <span class="label">Provider</span>
            <select class="field" name="momo_provider" id="momo-provider"></select>
          </label>
          <label class="vnd-field">
            <span class="label">Mobile money number</span>
            <input class="field font-mono" name="momo_number" inputmode="tel" placeholder="e.g. 024 123 4567">
          </label>
        </div>

        <div id="fields-paypal" class="hidden" style="margin-top:14px">
          <label class="vnd-field">
            <span class="label">PayPal email</span>
            <input class="field" name="paypal_email" type="email" placeholder="you@example.com">
          </label>
        </div>

        <div id="fields-crypto" class="hidden vnd-modal-grid" style="margin-top:14px">
          <label class="vnd-field">
            <span class="label">Asset</span>
            <select class="field" name="crypto_asset">
              <option value="USDT">USDT</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="USDC">USDC</option>
            </select>
          </label>
          <label class="vnd-field">
            <span class="label">Wallet address</span>
            <input class="field font-mono text-xs" name="crypto_address">
          </label>
        </div>

        <label class="vnd-check-line" style="margin-top:14px">
          <input type="checkbox" name="is_default" checked>
          Use as my default payout account
        </label>

        <p class="vnd-callout" style="margin-top:14px">
          Your payout details are visible only to you and our payments team. They are never shown on your
          public store or shared with buyers.
        </p>
        <p id="payout-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="payout-form" class="button button-primary">Save account</button>`,
  });
  dialog.classList.add('uk-modal--wide');

  function syncPayoutMethodFields() {
    const country = dialog.querySelector('#payout-country').value;
    const methodSelect = dialog.querySelector('#payout-method');
    const available = methodsFor(country);
    const current = methodSelect.value;

    methodSelect.innerHTML = available.map((m) => `<option value="${m.value}">${escapeHtml(m.label)}</option>`).join('');
    if (available.some((m) => m.value === current)) methodSelect.value = current;
    refreshSelect(methodSelect);

    const method = methodSelect.value;
    dialog.querySelector('#fields-bank').classList.toggle('hidden', method !== 'bank_transfer');
    dialog.querySelector('#fields-momo').classList.toggle('hidden', method !== 'mobile_money');
    dialog.querySelector('#fields-paypal').classList.toggle('hidden', method !== 'paypal');
    dialog.querySelector('#fields-crypto').classList.toggle('hidden', method !== 'crypto');

    const providers = MOMO_PROVIDERS[country] || [];
    const momoSelect = dialog.querySelector('#momo-provider');
    momoSelect.innerHTML = providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    refreshSelect(momoSelect);
  }

  dialog.querySelector('#payout-country').addEventListener('change', syncPayoutMethodFields);
  dialog.querySelector('#payout-method').addEventListener('change', syncPayoutMethodFields);
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  syncPayoutMethodFields();

  dialog.querySelector('#payout-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = dialog.querySelector('#payout-feedback');
    const button = dialog.querySelector('button[form="payout-form"]');
    const method = dialog.querySelector('#payout-method').value;
    const country = dialog.querySelector('#payout-country').value;

    const payload = {
      vendor_id: vendor.id,
      method,
      country,
      currency: COUNTRIES.find((c) => c.code === country)?.currency || 'USD',
      account_name: form.elements.account_name.value.trim(),
      is_default: form.elements.is_default.checked,
    };

    if (method === 'bank_transfer') {
      Object.assign(payload, {
        bank_name: form.elements.bank_name.value.trim(),
        account_number: form.elements.account_number.value.trim(),
        branch_code: form.elements.branch_code.value.trim() || null,
        swift_code: form.elements.swift_code.value.trim() || null,
        iban: form.elements.iban.value.trim() || null,
      });
    } else if (method === 'mobile_money') {
      Object.assign(payload, {
        momo_provider: dialog.querySelector('#momo-provider').value,
        momo_number: form.elements.momo_number.value.trim(),
      });
    } else if (method === 'paypal') {
      payload.paypal_email = form.elements.paypal_email.value.trim();
    } else {
      Object.assign(payload, {
        crypto_asset: form.elements.crypto_asset.value,
        crypto_address: form.elements.crypto_address.value.trim(),
      });
    }

    setBusy(button, true, 'Saving…');
    // Only one account can be the default; clear the others first.
    if (payload.is_default) {
      await supabase.from('payout_accounts').update({ is_default: false }).eq('vendor_id', vendor.id);
    }

    const { error } = await supabase.from('payout_accounts').insert(payload);
    setBusy(button, false);

    if (error) {
      feedback.textContent = error.message;
      feedback.className = 'status-line error text-xs my-0';
      return;
    }

    dialog.close();
    toast('Payout account saved.');
    await loadPayouts();
    await refreshDashboard();
  });
}

/* ==========================================================================
   Store settings
   ========================================================================== */

document.querySelector('#logo-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const path = await uploadTo('product-images', 'branding', file, document.querySelector('#logo-status'));
  if (!path) return;
  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  document.querySelector('#logo-url').value = data.publicUrl;
  document.querySelector('#logo-preview').innerHTML = `<img src="${escapeHtml(data.publicUrl)}" alt="">`;
});

document.querySelector('#vendor-settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector('#settings-feedback');
  const button = form.querySelector('button[type="submit"]');

  setBusy(button, true, 'Saving…');
  const { error } = await supabase.from('vendors').update({
    display_name: form.elements.display_name.value.trim(),
    bio: form.elements.bio.value.trim() || null,
    country: form.elements.country.value,
    support_email: form.elements.support_email.value.trim() || null,
    logo_url: document.querySelector('#logo-url').value || null,
    updated_at: new Date().toISOString(),
  }).eq('id', vendor.id);
  setBusy(button, false);

  feedback.textContent = error ? error.message : '✓ Saved.';
  feedback.className = `status-line text-xs my-0 ${error ? 'error' : 'success'}`;
  if (!error) {
    toast('Store settings saved.');
    await refreshDashboard();
    fillSettings();
  }
});

/* ==========================================================================
   Team (store_members) — visible to the owner (and, once RLS is extended,
   to manager-tier teammates). Only owner-tier callers (the original owner,
   an active 'owner' row, or an admin) may invite/change-role/remove — a
   'manager' may only bring on staff/support, matching store_member_invite's
   own server-side rule. See the schema task's scope-boundary note: staff and
   support do not yet inherit access to products/earnings/payouts/campaigns.
   ========================================================================== */

let teamMembers = [];
/** The signed-in user's own role on THIS store, if they have one via store_members. */
let myTeamRole = null;

function isTeamOwnerTier() {
  return vendor.user_id === account.user.id || myTeamRole === 'owner';
}

async function loadTeam() {
  const { data, error } = await supabase
    .from('store_members')
    .select('id,vendor_id,user_id,invited_email,role,status,invited_at,accepted_at')
    .eq('vendor_id', vendor.id)
    .order('invited_at', { ascending: true });
  if (error) {
    document.querySelector('#team-list').innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load team', body: error.message });
    return;
  }
  teamMembers = data || [];
  // store_members.user_id references auth.users, not public.profiles, so
  // PostgREST can't auto-embed a profiles relationship here — fetch names
  // in a second small query keyed by id instead.
  const userIds = [...new Set(teamMembers.map((m) => m.user_id).filter(Boolean))];
  if (userIds.length) {
    const { data: names } = await supabase.from('profiles').select('id,full_name').in('id', userIds);
    const nameMap = new Map((names || []).map((p) => [p.id, p.full_name]));
    teamMembers.forEach((m) => { m.full_name = m.user_id ? nameMap.get(m.user_id) : null; });
  }
  myTeamRole = teamMembers.find((m) => m.user_id === account.user.id && m.status === 'active')?.role || null;
  paintTeam();
}

function paintTeam() {
  const host = document.querySelector('#team-list');
  if (!host) return;
  const canManage = isTeamOwnerTier() || myTeamRole === 'manager';
  const canGrantOwnerManager = isTeamOwnerTier();

  if (!teamMembers.length) {
    host.innerHTML = emptyState({ icon: 'users-round', title: 'No team members yet', body: 'Invite someone to help run this store.' });
    return;
  }

  host.innerHTML = teamMembers.map((m) => {
    const isOriginalOwner = m.user_id === vendor.user_id;
    const label = m.full_name || m.invited_email || (m.user_id ? m.user_id.slice(0, 8) : 'Pending');
    const roleChangeAllowed = canManage && !isOriginalOwner && (canGrantOwnerManager || !['owner', 'manager'].includes(m.role));
    const removeAllowed = canManage && !isOriginalOwner && (canGrantOwnerManager || !['owner', 'manager'].includes(m.role));
    return `
      <div class="vnd-team-row">
        <div class="vnd-team-row__meta">
          <strong>${escapeHtml(label)}${isOriginalOwner ? ' (original owner)' : ''}</strong>
          <span>${statusBadge(m.role)} ${statusBadge(m.status)} · invited ${shortDate(m.invited_at)}${m.accepted_at ? ` · accepted ${shortDate(m.accepted_at)}` : ''}</span>
        </div>
        <div class="flex gap-2 flex-wrap">
          ${roleChangeAllowed ? `<button class="button !min-h-8 !px-3 text-xs" type="button" data-team-role="${m.id}">Change role</button>` : ''}
          ${removeAllowed && m.status !== 'removed' ? `<button class="button button-danger !min-h-8 !px-3 text-xs" type="button" data-team-remove="${m.id}">Remove</button>` : ''}
        </div>
      </div>`;
  }).join('');

  host.querySelectorAll('[data-team-role]').forEach((btn) => btn.addEventListener('click', () => {
    const member = teamMembers.find((m) => m.id === btn.dataset.teamRole);
    if (member) openTeamRoleModal(member, canGrantOwnerManager);
  }));
  host.querySelectorAll('[data-team-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    const member = teamMembers.find((m) => m.id === btn.dataset.teamRemove);
    const ok = await confirmDialog({
      title: `Remove ${member?.profiles?.full_name || member?.invited_email || 'this member'}?`,
      body: 'They immediately lose access to this store\'s team screens.',
      confirmLabel: 'Remove member',
    });
    if (!ok) return;
    const { error } = await supabase.rpc('store_member_remove', { p_member_id: member.id });
    if (error) { toast(error.message, 'error'); return; }
    toast('Removed from team.');
    await loadTeam();
  }));
  renderIcons();
}

function openTeamRoleModal(member, canGrantOwnerManager) {
  const { dialog } = openModal({
    id: 'team-role-modal',
    title: `Change role for ${member.full_name || member.invited_email || 'this member'}`,
    body: `
      <form id="team-role-form">
        <label class="vnd-field"><span class="label">Role</span>
          <select class="field" name="role">
            ${canGrantOwnerManager ? '<option value="manager">Manager — can invite/manage staff &amp; support</option>' : ''}
            <option value="staff">Staff</option>
            <option value="support">Support</option>
          </select>
        </label>
        <p id="team-role-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="team-role-form" class="button button-primary">Save role</button>`,
  });
  if (['staff', 'support', 'manager'].includes(member.role)) dialog.querySelector('select[name="role"]').value = member.role;
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#team-role-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = dialog.querySelector('button[form="team-role-form"]');
    const feedback = dialog.querySelector('#team-role-feedback');
    setBusy(button, true, 'Saving…');
    const { error } = await supabase.rpc('store_member_update_role', { p_member_id: member.id, p_role: event.currentTarget.elements.role.value });
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast('Role updated.');
    await loadTeam();
  });
}

document.querySelector('#invite-member')?.addEventListener('click', () => {
  const canGrantOwnerManager = isTeamOwnerTier();
  const { dialog } = openModal({
    id: 'invite-modal',
    title: 'Invite a team member',
    body: `
      <form id="invite-form">
        <label class="vnd-field"><span class="label">Email</span><input class="field" name="email" type="email" required placeholder="teammate@example.com"></label>
        <label class="vnd-field" style="margin-top:14px"><span class="label">Role</span>
          <select class="field" name="role">
            ${canGrantOwnerManager ? '<option value="manager">Manager — can invite/manage staff &amp; support</option>' : ''}
            <option value="staff" selected>Staff</option>
            <option value="support">Support</option>
          </select>
        </label>
        <p style="margin-top:10px;font-size:.76rem;color:var(--text-muted)">If they haven't signed up yet, the invite is queued silently and links to their account the moment they register with this exact email — no email is sent automatically.</p>
        <p id="invite-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="invite-form" class="button button-primary">Send invite</button>`,
  });
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="invite-form"]');
    const feedback = dialog.querySelector('#invite-feedback');
    setBusy(button, true, 'Sending…');
    const { error } = await supabase.rpc('store_member_invite', {
      p_vendor_id: vendor.id, p_email: form.elements.email.value.trim(), p_role: form.elements.role.value,
    });
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast('Invite sent.');
    await loadTeam();
  });
});

/* ==========================================================================
   Application
   ========================================================================== */

document.querySelector('#apply-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector('#apply-feedback');

  setButtonLoading(button, true, 'Submitting…');
  const { error } = await supabase.rpc('apply_as_vendor', {
    p_display_name: form.elements.display_name.value.trim(),
    p_country: form.elements.country.value,
    p_bio: form.elements.bio.value.trim() || null,
    p_payout_currency: form.elements.payout_currency.value,
  });
  setButtonLoading(button, false);

  if (error) {
    feedback.textContent = error.message;
    feedback.className = 'status-line error text-xs';
    return;
  }
  toast('Application submitted.');
  await boot();
});

/* ==========================================================================
   Wiring
   ========================================================================== */

function setBusy(button, busy, label) {
  setButtonBusy(button, busy, label);
}

function wireDelegates() {
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-edit],[data-delete],[data-delete-account],[data-toggle-campaign]');
    if (!target) return;

    if (target.dataset.edit) {
      const { data } = await supabase.from('products').select('*').eq('id', target.dataset.edit).single();
      if (data) openProductModal(data);
      return;
    }

    if (target.dataset.delete) {
      const ok = await confirmDialog({
        title: 'Delete this product?',
        body: 'Buyers who already bought it keep their download. This cannot be undone.',
        confirmLabel: 'Delete product',
      });
      if (!ok) return;
      const { error } = await supabase.from('products').delete().eq('id', target.dataset.delete);
      toast(error ? error.message : 'Product deleted.', error ? 'error' : 'success');
      if (!error) { await loadProducts(); await refreshDashboard(); }
      return;
    }

    if (target.dataset.deleteAccount) {
      const ok = await confirmDialog({
        title: 'Remove this payout account?',
        body: 'You will need to add it again before requesting a withdrawal to it.',
        confirmLabel: 'Remove account',
      });
      if (!ok) return;
      const { error } = await supabase.from('payout_accounts').delete().eq('id', target.dataset.deleteAccount);
      toast(error ? error.message : 'Account removed.', error ? 'error' : 'success');
      if (!error) await loadPayouts();
      return;
    }

    if (target.dataset.toggleCampaign) {
      const next = target.dataset.status === 'active' ? 'paused' : 'active';
      const { error } = await supabase.from('ad_campaigns').update({ status: next }).eq('id', target.dataset.toggleCampaign);
      toast(error ? error.message : `Campaign ${next}.`, error ? 'error' : 'success');
      if (!error) await loadCampaigns();
    }
  });

  document.querySelector('#new-product-btn')?.addEventListener('click', () => openProductModal());
  document.querySelector('#new-payout-account')?.addEventListener('click', () => openPayoutModal());
  document.querySelector('#new-campaign')?.addEventListener('click', () => openCampaignModal());
  document.querySelector('#topup-btn')?.addEventListener('click', () => openTopupModal());

  document.querySelector('#request-payout-btn')?.addEventListener('click', async (event) => {
    const accounts = await loadPayouts();
    const target = accounts.find((a) => a.is_default) || accounts[0];

    if (!target) {
      toast('Add a payout account first.', 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'Request a payout?',
      body: `Your available balance will be sent to ${target.account_name}.`,
      confirmLabel: 'Request payout',
      danger: false,
    });
    if (!ok) return;

    setBusy(event.currentTarget, true, 'Requesting…');
    const { data, error } = await supabase.rpc('request_payout', { p_payout_account_id: target.id });
    setBusy(event.currentTarget, false);

    if (error) {
      toast(error.message, 'error');
      return;
    }
    toast(`Payout of ${money(data.amount, data.currency)} requested.`);
    await refreshDashboard();
    await loadPayouts();
  });

}

async function refreshDashboard() {
  const { data } = await supabase.rpc('vendor_dashboard');
  dashboard = data;
  vendor = data?.vendor || vendor;
  if (vendor) renderOverview();
}

function fillSettings() {
  const form = document.querySelector('#vendor-settings-form');
  form.elements.display_name.value = vendor.display_name || '';
  form.elements.bio.value = vendor.bio || '';
  form.elements.support_email.value = vendor.support_email || '';
  const settingsCountry = document.querySelector('#settings-country');
  settingsCountry.innerHTML = countryOptions(vendor.country);
  enhanceSelect(settingsCountry, { label: 'Country' });
  refreshSelect(settingsCountry);
  enhanceSelect(document.querySelector('select[name="payout_currency"]'), { label: 'Payout currency' });
  document.querySelector('#logo-url').value = vendor.logo_url || '';

  const initial = (vendor.display_name || '?').trim().charAt(0).toUpperCase();
  const avatarMarkup = vendor.logo_url
    ? `<img src="${escapeHtml(vendor.logo_url)}" alt="">`
    : escapeHtml(initial);
  document.querySelector('#logo-preview').innerHTML = avatarMarkup;
  document.querySelector('#vendor-avatar').innerHTML = avatarMarkup;
  document.querySelector('#vendor-name').textContent = vendor.display_name;
  document.querySelector('#vendor-tier').textContent = `${vendor.commission_rate}% commission`;
  const storeLink = document.querySelector('#vendor-view-store');
  storeLink.href = `./store?vendor=${encodeURIComponent(vendor.slug)}`;
}

/* ==========================================================================
   Dashboard sidebar (mobile off-canvas drawer)
   Mirrors the `setDrawer`-style open/close pattern in js/ui.js, scoped to the
   dashboard's own sidebar nav below the 980px breakpoint it already switches
   layout at.
   ========================================================================== */

function wireDashSidebar() {
  const sidebar = document.querySelector('#dash-sidebar');
  const menuButton = document.querySelector('#dash-menu-button');
  const closeButton = document.querySelector('#dash-sidebar-close');
  const scrim = document.querySelector('#dash-scrim');
  if (!sidebar || !menuButton) return;

  const setOpen = (open) => {
    sidebar.classList.toggle('is-open', open);
    scrim?.classList.toggle('is-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  };

  menuButton.addEventListener('click', () => setOpen(true));
  closeButton?.addEventListener('click', () => setOpen(false));
  scrim?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
}

async function boot() {
  mountHeader();
  mountFooter();
  account = await getAccount();

  if (!account.user) {
    location.replace(`./auth?mode=signin&next=${encodeURIComponent('vendor')}`);
    return;
  }

  const { data } = await supabase.rpc('vendor_dashboard');
  dashboard = data;

  if (!data?.is_vendor) {
    const applyCountry = document.querySelector('#apply-country');
    applyCountry.innerHTML = countryOptions();
    enhanceSelect(applyCountry, { label: 'Country' });
    enhanceSelect(document.querySelector('select[name="payout_currency"]'), { label: 'Payout currency' });
    show('vendor-apply');
    renderIcons();
    finishPageLoader();
    return;
  }

  vendor = data.vendor;

  if (vendor.status !== 'approved') {
    showStatusScreen(vendor.status, vendor.rejection_reason);
    return;
  }

  const { data: cats } = await supabase
    .from('categories').select('name,slug').eq('is_active', true).order('sort_order');
  categories = cats || [];

  show('vendor-shell');
  wireDashSidebar();
  activateScreen();
  fillSettings();

  await loadWallet();
  reportFundingOutcome();
  await Promise.all([loadProducts(), loadSales(), loadPayouts(), loadCampaigns(), loadWalletHistory(), loadTeam()]);
  renderOverview();

  renderIcons();
  finishPageLoader();
}

wireDelegates();
boot().catch((error) => {
  console.error(error);
  toast(error.message || 'The seller centre could not be loaded.', 'error');
  finishPageLoader();
});
