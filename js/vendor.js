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
  escapeHtml, finishPageLoader, getAccount, icon, renderIcons,
  setButtonLoading, toast,
} from './ui.js';

let account = null;
let dashboard = null;
let vendor = null;
let categories = [];
let myProducts = [];

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

function fillCountrySelect(select, selected = 'GH') {
  if (!select) return;
  select.innerHTML = COUNTRIES
    .map((c) => `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');
}

/* ==========================================================================
   Formatting
   ========================================================================== */

const money = (value, currency = 'USD') =>
  `${currency} ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const STATUS_PILL = {
  pending: 'bg-amber-50 text-amber-700',
  available: 'bg-green-50 text-green-700',
  paid: 'bg-blue-50 text-blue-700',
  reversed: 'bg-red-50 text-red-700',
  requested: 'bg-amber-50 text-amber-700',
  processing: 'bg-blue-50 text-blue-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-600',
  draft: 'bg-slate-100 text-slate-600',
  active: 'bg-green-50 text-green-700',
  paused: 'bg-amber-50 text-amber-700',
  completed: 'bg-slate-100 text-slate-600',
  rejected: 'bg-red-50 text-red-700',
};

const pill = (status) =>
  `<span class="inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold capitalize ${STATUS_PILL[status] || 'bg-slate-100 text-slate-600'}">${escapeHtml(status)}</span>`;

const empty = (message) => `<p class="py-6 text-center text-sm text-slate-500">${escapeHtml(message)}</p>`;

/* ==========================================================================
   Screen routing (mirrors the admin console)
   ========================================================================== */

const SCREEN_TITLES = {
  overview: 'Overview',
  products: 'My products',
  sales: 'Sales & earnings',
  payouts: 'Payouts',
  boost: 'Boost & ads',
  settings: 'Store settings',
};

function activateScreen() {
  const key = location.hash.replace('#', '') || 'overview';
  const valid = SCREEN_TITLES[key] ? key : 'overview';
  document.querySelectorAll('.admin-screen').forEach((screen) => {
    screen.classList.toggle('is-active', screen.id === valid);
  });
  document.querySelectorAll('.admin-link').forEach((link) => {
    link.classList.toggle('active', link.getAttribute('href') === `#${valid}`);
  });
  const title = document.querySelector('#vendor-page-title');
  if (title) title.textContent = SCREEN_TITLES[valid];
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', activateScreen);

/* --- Mobile drawer (same markup contract as the admin console) ------------- */
function setDrawer(open) {
  const sidebar = document.querySelector('#admin-sidebar');
  const scrim = document.querySelector('#admin-scrim');
  if (!sidebar || !scrim) return;
  sidebar.classList.toggle('is-open', open);
  scrim.classList.toggle('is-open', open);
  scrim.hidden = !open;
  document.querySelector('#admin-menu-button')?.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
}

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

  document.querySelector('#status-icon').innerHTML = icon(copy.icon, 26);
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

  document.querySelector('#m-available').textContent = money(balance.available, currency);
  document.querySelector('#m-pending').textContent = money(balance.pending, currency);
  document.querySelector('#m-lifetime').textContent = money(balance.lifetime, currency);
  document.querySelector('#m-commission').textContent = `${money(balance.commission, currency)} platform commission`;
  document.querySelector('#m-products').textContent = counts.published_products ?? 0;
  document.querySelector('#m-sales-count').textContent = `${counts.sales ?? 0} sale${counts.sales === 1 ? '' : 's'} all time`;
  document.querySelector('#m-available-note').textContent =
    Number(balance.available) > 0 ? 'Ready to withdraw now' : 'Nothing matured yet';

  renderChart(dashboard.daily_net || []);
  renderChecklist();
  renderRecentSales(dashboard.recent_sales || [], currency);
}

/** Minimal inline bar chart — no dependency, matches the account page. */
function renderChart(daily) {
  const host = document.querySelector('#vendor-chart');
  if (!daily.length) {
    host.innerHTML = '<p class="grid h-full place-items-center text-sm text-slate-500">Your revenue will chart here after your first sale.</p>';
    return;
  }
  const max = Math.max(...daily.map((d) => Number(d.net)), 1);
  host.innerHTML = `
    <div class="flex h-full items-end gap-1.5">
      ${daily.map((d) => `
        <div class="flex flex-1 flex-col items-center gap-1.5" title="${escapeHtml(shortDate(d.day))}: ${money(d.net)}">
          <div class="w-full rounded-t bg-orange-500" style="height:${Math.max(6, (Number(d.net) / max) * 130)}px"></div>
          <small class="text-[9px] text-slate-400">${new Date(d.day).getDate()}</small>
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
  ];

  document.querySelector('#vendor-checklist').innerHTML = steps.map((step) => `
    <div class="flex items-start gap-3">
      <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${step.done ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'}">
        ${step.done ? icon('check', 12) : icon('circle', 12)}
      </span>
      <span class="min-w-0">
        <strong class="block text-sm ${step.done ? 'text-slate-400 line-through' : 'text-[#142c55]'}">${escapeHtml(step.label)}</strong>
        ${step.done ? '' : `<span class="text-xs text-slate-500">${escapeHtml(step.hint)}</span>`}
        ${!step.done && step.href ? ` <a class="text-xs font-bold text-orange-600" href="${step.href}">Go →</a>` : ''}
      </span>
    </div>`).join('');
}

function renderRecentSales(sales, currency) {
  const host = document.querySelector('#recent-sales');
  if (!sales.length) {
    host.innerHTML = empty('No sales yet. Once a buyer completes checkout it appears here.');
    return;
  }
  host.innerHTML = sales.map((sale) => `
    <div class="flex items-center justify-between gap-4 border-t border-slate-100 py-3 first:border-t-0">
      <div class="min-w-0">
        <strong class="block truncate text-sm text-[#142c55]">${escapeHtml(sale.title || 'Product')}</strong>
        <span class="text-xs text-slate-500">${escapeHtml(shortDate(sale.created_at))}</span>
      </div>
      <div class="shrink-0 text-right">
        <strong class="block text-sm">${money(sale.net_amount, sale.currency || currency)}</strong>
        <span class="mt-0.5 block">${pill(sale.status)}</span>
      </div>
    </div>`).join('');
}

/* --- Products -------------------------------------------------------------- */

async function loadProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id,title,slug,category,price,original_price,currency,cover_url,is_published,purchase_count,created_at')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false });

  myProducts = data || [];
  const host = document.querySelector('#vendor-products-table');

  if (error) {
    host.innerHTML = empty(error.message);
    return;
  }
  if (!myProducts.length) {
    host.innerHTML = `
      <div class="py-10 text-center">
        <p class="text-sm text-slate-500">You have not added a product yet.</p>
        <button class="button button-primary mt-4" type="button" data-new-product>Add your first product</button>
      </div>`;
    return;
  }

  host.innerHTML = `
    <div class="scroll-x">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th class="pb-3">Product</th>
            <th class="pb-3">Price</th>
            <th class="pb-3">Sales</th>
            <th class="pb-3">Status</th>
            <th class="pb-3"></th>
          </tr>
        </thead>
        <tbody>
          ${myProducts.map((p) => `
            <tr class="border-t border-slate-100">
              <td class="py-3 pr-3">
                <div class="flex items-center gap-3">
                  ${p.cover_url
                    ? `<img src="${escapeHtml(p.cover_url)}" alt="" class="h-10 w-14 rounded-lg object-cover">`
                    : '<span class="grid h-10 w-14 place-items-center rounded-lg bg-slate-100 text-[10px] text-slate-400">No image</span>'}
                  <div class="min-w-0">
                    <strong class="block truncate text-[#142c55]">${escapeHtml(p.title)}</strong>
                    <span class="text-xs text-slate-400">${escapeHtml(p.category || 'General')}</span>
                  </div>
                </div>
              </td>
              <td class="py-3 pr-3 font-bold">${money(p.price, p.currency)}</td>
              <td class="py-3 pr-3">${p.purchase_count ?? 0}</td>
              <td class="py-3 pr-3">${p.is_published ? pill('active') : pill('draft')}</td>
              <td class="py-3 text-right">
                <button class="button !min-h-8 !px-3 text-xs" type="button" data-edit="${p.id}">Edit</button>
                <button class="button !min-h-8 !px-3 text-xs !text-red-600" type="button" data-delete="${p.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* --- Sales ----------------------------------------------------------------- */

async function loadSales() {
  const { data, error } = await supabase
    .from('vendor_earnings')
    .select('id,gross_amount,commission_amount,commission_rate,net_amount,currency,status,created_at,available_at,products(title)')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false })
    .limit(200);

  const host = document.querySelector('#vendor-sales-table');
  if (error) return void (host.innerHTML = empty(error.message));
  if (!data?.length) return void (host.innerHTML = empty('No sales recorded yet.'));

  const totalNet = data.reduce((sum, row) => sum + Number(row.net_amount), 0);
  document.querySelector('#sales-insight').textContent =
    `${data.length} sale${data.length === 1 ? '' : 's'} · ${money(totalNet, data[0].currency)} net`;

  host.innerHTML = `
    <div class="scroll-x">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th class="pb-3">Product</th><th class="pb-3">Date</th><th class="pb-3">Gross</th>
            <th class="pb-3">Commission</th><th class="pb-3">You earn</th><th class="pb-3">Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.map((row) => `
            <tr class="border-t border-slate-100">
              <td class="py-3 pr-3"><strong class="text-[#142c55]">${escapeHtml(row.products?.title || 'Product')}</strong></td>
              <td class="py-3 pr-3 text-slate-500">${escapeHtml(shortDate(row.created_at))}</td>
              <td class="py-3 pr-3">${money(row.gross_amount, row.currency)}</td>
              <td class="py-3 pr-3 text-slate-500">−${money(row.commission_amount, row.currency)} <span class="text-[11px] text-slate-400">(${row.commission_rate}%)</span></td>
              <td class="py-3 pr-3 font-bold text-[#142c55]">${money(row.net_amount, row.currency)}</td>
              <td class="py-3">${pill(row.status)}${row.status === 'pending' ? `<span class="mt-1 block text-[10px] text-slate-400">clears ${escapeHtml(shortDate(row.available_at))}</span>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* --- Payouts --------------------------------------------------------------- */

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

  const accounts = accountsResult.data || [];
  const accountsHost = document.querySelector('#payout-accounts-list');

  accountsHost.innerHTML = accounts.length
    ? accounts.map((a) => {
        const label = {
          bank_transfer: `${a.bank_name || 'Bank'} ····${a.account_last4 || ''}`,
          mobile_money: `${a.momo_provider || 'Mobile money'} ····${a.account_last4 || ''}`,
          paypal: a.paypal_email || 'PayPal',
          crypto: `${a.crypto_asset || 'Crypto'} ····${a.account_last4 || ''}`,
        }[a.method];
        return `
          <div class="flex items-center justify-between gap-4 border-t border-slate-100 py-3 first:border-t-0">
            <div class="min-w-0">
              <strong class="block truncate text-sm text-[#142c55]">${escapeHtml(label)}</strong>
              <span class="text-xs text-slate-500">${escapeHtml(a.account_name)} · ${escapeHtml(a.country)}</span>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              ${a.is_default ? '<span class="tag">Default</span>' : ''}
              ${a.is_verified ? pill('available') : pill('pending')}
              <button class="button !min-h-8 !px-3 text-xs !text-red-600" type="button" data-delete-account="${a.id}">Remove</button>
            </div>
          </div>`;
      }).join('')
    : empty('No payout account yet. Add one before requesting a withdrawal.');

  const history = historyResult.data || [];
  document.querySelector('#payouts-history').innerHTML = history.length
    ? history.map((p) => `
        <div class="flex items-center justify-between gap-4 border-t border-slate-100 py-3 first:border-t-0">
          <div>
            <strong class="block text-sm text-[#142c55]">${money(p.amount, p.currency)}</strong>
            <span class="text-xs text-slate-500">Requested ${escapeHtml(shortDate(p.requested_at))}${p.reference ? ` · ${escapeHtml(p.reference)}` : ''}</span>
            ${p.failure_reason ? `<span class="block text-xs text-red-600">${escapeHtml(p.failure_reason)}</span>` : ''}
          </div>
          ${pill(p.status)}
        </div>`).join('')
    : empty('No withdrawals yet.');

  return accounts;
}

/* --- Campaigns ------------------------------------------------------------- */

/* --- Ad wallet ------------------------------------------------------------- */

let wallet = null;

async function loadWallet() {
  const { data } = await supabase
    .from('ad_wallets').select('balance,currency,lifetime_topup,lifetime_spend')
    .eq('vendor_id', vendor.id).maybeSingle();

  wallet = data || { balance: 0, currency: vendor.payout_currency || 'USD', lifetime_spend: 0 };

  document.querySelector('#wallet-balance').textContent = money(wallet.balance, wallet.currency);
  document.querySelector('#wallet-note').textContent = Number(wallet.balance) > 0
    ? `${money(wallet.lifetime_spend, wallet.currency)} spent on ads so far.`
    : 'Top up before your campaigns can run.';

  // A crypto payment can sit unconfirmed for a while; surface it so the seller
  // is not left wondering where their money went.
  const { data: inFlight } = await supabase
    .from('ad_funding_payments').select('amount,currency,provider,created_at')
    .eq('vendor_id', vendor.id).eq('status', 'pending')
    .gt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if (inFlight?.length) {
    const total = inFlight.reduce((sum, r) => sum + Number(r.amount), 0);
    document.querySelector('#wallet-note').textContent +=
      ` ${money(total, wallet.currency)} awaiting payment confirmation.`;
  }
}

async function loadWalletHistory() {
  const host = document.querySelector('#wallet-history');
  const { data } = await supabase
    .from('ad_wallet_transactions')
    .select('type,amount,balance_after,currency,description,created_at')
    .eq('vendor_id', vendor.id).order('created_at', { ascending: false }).limit(30);

  host.innerHTML = data?.length
    ? data.map((t) => `
        <div class="flex items-center justify-between gap-3 border-t border-slate-100 py-2 text-xs first:border-t-0">
          <div class="min-w-0">
            <strong class="block truncate text-[#142c55]">${escapeHtml(t.description || t.type)}</strong>
            <span class="text-slate-400">${escapeHtml(shortDate(t.created_at))}</span>
          </div>
          <span class="shrink-0 font-bold ${Number(t.amount) < 0 ? 'text-red-600' : 'text-green-700'}">
            ${Number(t.amount) < 0 ? '' : '+'}${money(t.amount, t.currency)}
          </span>
        </div>`).join('')
    : empty('No wallet activity yet.');
}

document.querySelector('#wallet-history-btn')?.addEventListener('click', async () => {
  const host = document.querySelector('#wallet-history');
  host.classList.toggle('hidden');
  if (!host.classList.contains('hidden')) await loadWalletHistory();
});

document.querySelector('#topup-btn')?.addEventListener('click', () => {
  document.querySelector('#topup-form').reset();
  document.querySelector('#topup-feedback').textContent = '';
  document.querySelector('#topup-modal').showModal();
});

document.querySelector('#cancel-topup')?.addEventListener('click', () =>
  document.querySelector('#topup-modal').close());

// Preset buttons just fill the field; the field remains the source of truth.
document.querySelector('#topup-presets')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-amount]');
  if (!button) return;
  document.querySelector('#topup-form').elements.amount.value = button.dataset.amount;
});

document.querySelector('#topup-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector('#topup-feedback');
  const button = form.querySelector('button[type="submit"]');
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

async function loadCampaigns() {
  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('id,name,placement,budget,spend,currency,status,review_status,review_note,impressions,clicks,conversions,cpm_rate,cpc_rate,cpa_percent,starts_at,ends_at,products(title)')
    .eq('vendor_id', vendor.id)
    .order('created_at', { ascending: false });

  // Show the live rate card from whatever campaign exists, else the defaults.
  const rates = data?.[0] || { cpm_rate: 2.5, cpc_rate: 0.35, cpa_percent: 3 };
  const rateHost = document.querySelector('#rate-card');
  if (rateHost) {
    rateHost.innerHTML = `
      <div class="grid grid-cols-3 gap-2 text-center">
        <div class="rounded-xl bg-slate-50 p-3">
          <strong class="block text-sm font-black text-[#142c55]">${money(rates.cpm_rate, wallet?.currency)}</strong>
          <span class="text-[10px] font-bold uppercase tracking-wide text-slate-400">per 1,000 views</span>
        </div>
        <div class="rounded-xl bg-slate-50 p-3">
          <strong class="block text-sm font-black text-[#142c55]">${money(rates.cpc_rate, wallet?.currency)}</strong>
          <span class="text-[10px] font-bold uppercase tracking-wide text-slate-400">per click</span>
        </div>
        <div class="rounded-xl bg-slate-50 p-3">
          <strong class="block text-sm font-black text-[#142c55]">${rates.cpa_percent}%</strong>
          <span class="text-[10px] font-bold uppercase tracking-wide text-slate-400">per sale</span>
        </div>
      </div>`;
  }

  const host = document.querySelector('#campaigns-table');
  if (error) return void (host.innerHTML = empty(error.message));
  if (!data?.length) {
    host.innerHTML = `
      <div class="py-10 text-center">
        <p class="text-sm text-slate-500">No campaigns yet. Boosting puts a product in front of more buyers.</p>
        <button class="button button-primary mt-4" type="button" data-new-campaign>Create a campaign</button>
      </div>`;
    return;
  }

  host.innerHTML = `
    <div class="scroll-x">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr><th class="pb-3">Campaign</th><th class="pb-3">Product</th><th class="pb-3">Placement</th>
              <th class="pb-3">Budget used</th><th class="pb-3">Clicks</th><th class="pb-3">Status</th><th class="pb-3"></th></tr>
        </thead>
        <tbody>
          ${data.map((c) => {
            const used = Math.min(100, (Number(c.spend) / Number(c.budget)) * 100);
            return `
            <tr class="border-t border-slate-100">
              <td class="py-3 pr-3"><strong class="text-[#142c55]">${escapeHtml(c.name)}</strong></td>
              <td class="py-3 pr-3 text-slate-500">${escapeHtml(c.products?.title || '—')}</td>
              <td class="py-3 pr-3 capitalize text-slate-500">${escapeHtml(c.placement)}</td>
              <td class="py-3 pr-3">
                <span class="block text-xs">${money(c.spend, c.currency)} / ${money(c.budget, c.currency)}</span>
                <span class="mt-1 block h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                  <span class="block h-full rounded-full bg-orange-500" style="width:${used}%"></span>
                </span>
              </td>
              <td class="py-3 pr-3">${c.clicks} <span class="text-[11px] text-slate-400">/ ${c.impressions} views · ${c.conversions} sold</span></td>
              <td class="py-3 pr-3">
                ${c.review_status === 'pending'
                  ? '<span class="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold text-amber-700">In review</span>'
                  : c.review_status === 'rejected'
                    ? `<span class="inline-flex rounded-full bg-red-50 px-2.5 py-0.5 text-[11px] font-bold text-red-700">Rejected</span>
                       ${c.review_note ? `<span class="mt-1 block text-[10px] text-slate-400">${escapeHtml(c.review_note)}</span>` : ''}`
                    : pill(c.status)}
              </td>
              <td class="py-3 text-right">
                ${c.review_status === 'approved' && ['active', 'paused'].includes(c.status)
                  ? `<button class="button !min-h-8 !px-3 text-xs" type="button" data-toggle-campaign="${c.id}" data-status="${c.status}">${c.status === 'active' ? 'Pause' : 'Resume'}</button>`
                  : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
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
    statusEl.className = 'help text-slate-400';
  }
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(vendorPath(kind, file.name), file, { upsert: true });

  if (error) {
    if (statusEl) {
      statusEl.textContent = error.message;
      statusEl.className = 'help text-red-600';
    }
    return null;
  }
  if (statusEl) {
    statusEl.textContent = `✓ ${file.name}`;
    statusEl.className = 'help text-green-700';
  }
  return data.path;
}

/* ==========================================================================
   Product editor
   ========================================================================== */

const productModal = document.querySelector('#product-modal');

function slugify(value) {
  return (value || '').toLowerCase().trim()
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function openProductModal(product = null) {
  const form = document.querySelector('#product-form');
  form.reset();
  document.querySelector('#product-feedback').textContent = '';
  document.querySelector('#v-cover-preview').classList.add('hidden');
  document.querySelector('#v-cover-status').textContent = '';
  document.querySelector('#v-file-status').textContent = '';

  document.querySelector('#v-category').innerHTML = categories
    .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');

  document.querySelector('#product-modal-title').textContent = product ? 'Edit product' : 'New product';
  form.elements.id.value = product?.id || '';

  if (product) {
    form.elements.title.value = product.title || '';
    form.elements.slug.value = product.slug || '';
    form.elements.price.value = product.price ?? '';
    form.elements.original_price.value = product.original_price ?? '';
    form.elements.short_description.value = product.short_description || '';
    form.elements.description.value = product.description || '';
    form.elements.file_type.value = product.file_type || '';
    form.elements.is_published.checked = Boolean(product.is_published);
    document.querySelector('#v-cover-url').value = product.cover_url || '';
    document.querySelector('#v-file-path').value = product.file_path || '';
    if (product.category) document.querySelector('#v-category').value = product.category;
    if (product.license_type) form.elements.license_type.value = product.license_type;
    if (product.cover_url) {
      const preview = document.querySelector('#v-cover-preview');
      preview.src = product.cover_url;
      preview.classList.remove('hidden');
    }
  }

  productModal.showModal();
  renderIcons();
}

document.querySelector('#v-title')?.addEventListener('input', (event) => {
  const slugField = document.querySelector('#v-slug');
  // Only auto-fill the slug while creating; never rewrite a published URL.
  if (!document.querySelector('#product-form').elements.id.value) {
    slugField.value = slugify(event.target.value);
  }
});

document.querySelector('#v-cover-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const path = await uploadTo('product-images', 'covers', file, document.querySelector('#v-cover-status'));
  if (!path) return;
  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  document.querySelector('#v-cover-url').value = data.publicUrl;
  const preview = document.querySelector('#v-cover-preview');
  preview.src = data.publicUrl;
  preview.classList.remove('hidden');
});

document.querySelector('#v-product-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const path = await uploadTo('books', 'files', file, document.querySelector('#v-file-status'));
  if (!path) return;
  document.querySelector('#v-file-path').value = path;
  // Offer the extension as the file type when the seller has not set one.
  const typeField = document.querySelector('#product-form').elements.file_type;
  if (!typeField.value) typeField.value = (file.name.split('.').pop() || '').toUpperCase();
});

document.querySelector('#product-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector('#save-product');
  const feedback = document.querySelector('#product-feedback');
  const id = form.elements.id.value;

  const filePath = document.querySelector('#v-file-path').value;
  if (!filePath) {
    feedback.textContent = 'Upload the file buyers will download.';
    feedback.className = 'status-line error text-xs my-0';
    return;
  }

  const payload = {
    vendor_id: vendor.id,
    title: form.elements.title.value.trim(),
    slug: slugify(form.elements.slug.value) || slugify(form.elements.title.value),
    category: document.querySelector('#v-category').value,
    price: Number(form.elements.price.value),
    original_price: form.elements.original_price.value ? Number(form.elements.original_price.value) : null,
    short_description: form.elements.short_description.value.trim() || null,
    description: form.elements.description.value.trim() || null,
    cover_url: document.querySelector('#v-cover-url').value || null,
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

  productModal.close();
  toast(id ? 'Product updated.' : 'Product published.');
  await loadProducts();
  await refreshDashboard();
});

/* ==========================================================================
   Payout account editor
   ========================================================================== */

const payoutModal = document.querySelector('#payout-modal');

function syncPayoutMethodFields() {
  const country = document.querySelector('#payout-country').value;
  const methodSelect = document.querySelector('#payout-method');
  const available = methodsFor(country);
  const current = methodSelect.value;

  methodSelect.innerHTML = available
    .map((m) => `<option value="${m.value}">${escapeHtml(m.label)}</option>`).join('');
  if (available.some((m) => m.value === current)) methodSelect.value = current;

  const method = methodSelect.value;
  document.querySelector('#fields-bank').classList.toggle('hidden', method !== 'bank_transfer');
  document.querySelector('#fields-momo').classList.toggle('hidden', method !== 'mobile_money');
  document.querySelector('#fields-paypal').classList.toggle('hidden', method !== 'paypal');
  document.querySelector('#fields-crypto').classList.toggle('hidden', method !== 'crypto');

  const providers = MOMO_PROVIDERS[country] || [];
  document.querySelector('#momo-provider').innerHTML = providers
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
}

document.querySelector('#payout-country')?.addEventListener('change', syncPayoutMethodFields);
document.querySelector('#payout-method')?.addEventListener('change', syncPayoutMethodFields);

document.querySelector('#payout-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector('#payout-feedback');
  const method = document.querySelector('#payout-method').value;
  const country = document.querySelector('#payout-country').value;

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
      momo_provider: document.querySelector('#momo-provider').value,
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

  // Only one account can be the default; clear the others first.
  if (payload.is_default) {
    await supabase.from('payout_accounts').update({ is_default: false }).eq('vendor_id', vendor.id);
  }

  const { error } = await supabase.from('payout_accounts').insert(payload);
  if (error) {
    feedback.textContent = error.message;
    feedback.className = 'status-line error text-xs my-0';
    return;
  }

  payoutModal.close();
  toast('Payout account saved.');
  await loadPayouts();
  await refreshDashboard();
});

document.querySelector('#request-payout-btn')?.addEventListener('click', async (event) => {
  const accounts = await loadPayouts();
  const target = accounts.find((a) => a.is_default) || accounts[0];

  if (!target) {
    toast('Add a payout account first.', 'error');
    location.hash = '#payouts';
    return;
  }
  if (!window.confirm(`Request a withdrawal of your available balance to ${target.account_name}?`)) return;

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

/* ==========================================================================
   Campaigns
   ========================================================================== */

const campaignModal = document.querySelector('#campaign-modal');

function openCampaignModal() {
  const form = document.querySelector('#campaign-form');
  form.reset();
  document.querySelector('#campaign-feedback').textContent = '';

  const sellable = myProducts.filter((p) => p.is_published);
  if (!sellable.length) {
    toast('Publish a product before boosting it.', 'error');
    location.hash = '#products';
    return;
  }
  document.querySelector('#campaign-product').innerHTML = sellable
    .map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  form.elements.starts_at.value = new Date().toISOString().slice(0, 10);
  campaignModal.showModal();
  renderIcons();
}

document.querySelector('#campaign-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector('#campaign-feedback');

  const { error } = await supabase.from('ad_campaigns').insert({
    vendor_id: vendor.id,
    product_id: document.querySelector('#campaign-product').value,
    name: form.elements.name.value.trim(),
    placement: form.elements.placement.value,
    budget: Number(form.elements.budget.value),
    currency: vendor.payout_currency || 'USD',
    starts_at: form.elements.starts_at.value || new Date().toISOString(),
    ends_at: form.elements.ends_at.value || null,
  });

  if (error) {
    feedback.textContent = error.message;
    feedback.className = 'status-line error text-xs my-0';
    return;
  }
  campaignModal.close();
  toast('Campaign submitted — it goes live once our team approves it.');
  await loadCampaigns();
});

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
  document.querySelector('#logo-preview').innerHTML = `<img src="${escapeHtml(data.publicUrl)}" alt="" class="h-full w-full object-cover">`;
});

document.querySelector('#vendor-settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector('#settings-feedback');

  const { error } = await supabase.from('vendors').update({
    display_name: form.elements.display_name.value.trim(),
    bio: form.elements.bio.value.trim() || null,
    country: form.elements.country.value,
    support_email: form.elements.support_email.value.trim() || null,
    logo_url: document.querySelector('#logo-url').value || null,
    updated_at: new Date().toISOString(),
  }).eq('id', vendor.id);

  feedback.textContent = error ? error.message : '✓ Saved.';
  feedback.className = `status-line text-xs my-0 ${error ? 'error' : 'success'}`;
  if (!error) {
    toast('Store settings saved.');
    await refreshDashboard();
  }
});

/* ==========================================================================
   Application
   ========================================================================== */

document.querySelector('#apply-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector('#apply-feedback');

  setBusy(button, true, 'Submitting…');
  const { error } = await supabase.rpc('apply_as_vendor', {
    p_display_name: form.elements.display_name.value.trim(),
    p_country: form.elements.country.value,
    p_bio: form.elements.bio.value.trim() || null,
    p_payout_currency: form.elements.payout_currency.value,
  });
  setBusy(button, false);

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

/** setButtonLoading, but tolerant of buttons that contain markup. */
function setBusy(button, busy, label) {
  setButtonLoading(button, busy, label);
}

function wireDelegates() {
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-edit],[data-delete],[data-new-product],[data-new-campaign],[data-delete-account],[data-toggle-campaign]');
    if (!target) return;

    if (target.dataset.newProduct !== undefined) return void openProductModal();
    if (target.dataset.newCampaign !== undefined) return void openCampaignModal();

    if (target.dataset.edit) {
      const { data } = await supabase.from('products').select('*').eq('id', target.dataset.edit).single();
      if (data) openProductModal(data);
      return;
    }

    if (target.dataset.delete) {
      if (!window.confirm('Delete this product? Buyers who already bought it keep their download.')) return;
      const { error } = await supabase.from('products').delete().eq('id', target.dataset.delete);
      toast(error ? error.message : 'Product deleted.', error ? 'error' : 'success');
      if (!error) { await loadProducts(); await refreshDashboard(); }
      return;
    }

    if (target.dataset.deleteAccount) {
      if (!window.confirm('Remove this payout account?')) return;
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

  document.querySelector('#admin-menu-button')?.addEventListener('click', () => setDrawer(true));
  document.querySelector('#admin-menu-close')?.addEventListener('click', () => setDrawer(false));
  document.querySelector('#admin-scrim')?.addEventListener('click', () => setDrawer(false));
  document.querySelectorAll('.admin-link').forEach((link) => link.addEventListener('click', () => setDrawer(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });

  document.querySelector('#new-product-btn')?.addEventListener('click', () => openProductModal());
  document.querySelector('#new-product-btn-2')?.addEventListener('click', () => openProductModal());
  document.querySelector('#new-payout-account')?.addEventListener('click', () => {
    document.querySelector('#payout-form').reset();
    fillCountrySelect(document.querySelector('#payout-country'), vendor.country);
    syncPayoutMethodFields();
    payoutModal.showModal();
    renderIcons();
  });
  document.querySelector('#new-campaign')?.addEventListener('click', openCampaignModal);

  document.querySelector('#close-product-modal')?.addEventListener('click', () => productModal.close());
  document.querySelector('#cancel-product')?.addEventListener('click', () => productModal.close());
  document.querySelector('#close-payout-modal')?.addEventListener('click', () => payoutModal.close());
  document.querySelector('#cancel-payout')?.addEventListener('click', () => payoutModal.close());
  document.querySelector('#close-campaign-modal')?.addEventListener('click', () => campaignModal.close());
  document.querySelector('#cancel-campaign')?.addEventListener('click', () => campaignModal.close());
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
  fillCountrySelect(document.querySelector('#settings-country'), vendor.country);
  document.querySelector('#logo-url').value = vendor.logo_url || '';

  const initial = (vendor.display_name || '?').trim().charAt(0).toUpperCase();
  const avatarMarkup = vendor.logo_url
    ? `<img src="${escapeHtml(vendor.logo_url)}" alt="" class="h-full w-full object-cover">`
    : escapeHtml(initial);
  document.querySelector('#logo-preview').innerHTML = avatarMarkup;
  document.querySelector('#vendor-avatar').innerHTML = avatarMarkup;
  document.querySelector('#vendor-name').textContent = vendor.display_name;
  const storeLink = document.querySelector('#vendor-view-store');
  storeLink.href = `./store?vendor=${encodeURIComponent(vendor.slug)}`;
}

async function boot() {
  account = await getAccount();

  if (!account.user) {
    location.replace(`./auth?mode=signin&next=${encodeURIComponent('vendor')}`);
    return;
  }

  const { data } = await supabase.rpc('vendor_dashboard');
  dashboard = data;

  if (!data?.is_vendor) {
    fillCountrySelect(document.querySelector('#apply-country'));
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
  activateScreen();
  renderOverview();
  fillSettings();

  await loadWallet();
  reportFundingOutcome();
  await Promise.all([loadProducts(), loadSales(), loadPayouts(), loadCampaigns()]);

  renderIcons();
  finishPageLoader();
}

wireDelegates();
boot().catch((error) => {
  console.error(error);
  toast(error.message || 'The seller centre could not be loaded.', 'error');
  finishPageLoader();
});
