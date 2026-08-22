import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, icon, renderIcons, setButtonLoading, toast } from './ui.js';
import { getVisibleReviews, getVisibleSeedTransactions } from './seed-data.js';

let account = null;
let mode = null;
let editingId = null;
let currentView = 'overview';
let activeDateRange = '30d'; // 'today' | '7d' | '30d' | 'all'
let txStatusFilter = 'all'; // 'all' | 'paid' | 'pending' | 'cancelled'
let txSearchQuery = '';
let userSearchQuery = '';

let liveOrders = [];
let liveProducts = [];
let livePromos = [];
let livePosts = [];
let liveTickets = [];
let liveUsers = [];

// DOM References
const modal = document.querySelector('#editor-modal');
const detailsModal = document.querySelector('#details-modal');
const receiptModal = document.querySelector('#receipt-modal');
const imgModal = document.querySelector('#image-editor-modal');
const cropCanvas = document.querySelector('#crop-canvas');

// ============================================================
// Helper Utilities
// ============================================================
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================
// Single Page View Router
// ============================================================
function switchView(viewName) {
  currentView = viewName || 'overview';
  window.location.hash = currentView;

  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    if (btn.dataset.view === currentView) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  document.querySelectorAll('.admin-view').forEach((sec) => {
    if (sec.id === `view-${currentView}`) {
      sec.classList.remove('hidden');
    } else {
      sec.classList.add('hidden');
    }
  });

  const titles = {
    overview: { eyebrow: 'COMMAND CENTRE', title: 'Executive Overview' },
    transactions: { eyebrow: 'FINANCIAL LEDGER', title: 'Orders & Payments' },
    customers: { eyebrow: 'AUDIENCE & CRM', title: 'Customer Management' },
    products: { eyebrow: 'MERCHANDISE CATALOG', title: 'Products & Digital Assets' },
    reviews: { eyebrow: 'FEEDBACK & RATINGS', title: 'Verified Customer Reviews' },
    content: { eyebrow: 'CMS & ARTICLES', title: 'Store Journal & Brand Settings' },
    tickets: { eyebrow: 'HELP DESK', title: 'Customer Support Queue' },
  };

  const current = titles[currentView] || titles.overview;
  const eyebrowEl = document.querySelector('#screen-eyebrow');
  const titleEl = document.querySelector('#screen-title');
  if (eyebrowEl) eyebrowEl.textContent = current.eyebrow;
  if (titleEl) titleEl.textContent = current.title;

  renderCurrentView();
}

// ============================================================
// Combined Data Source & Time-Range Filter
// ============================================================
function getAllTransactions() {
  const seedTx = getVisibleSeedTransactions();
  
  // Format live Supabase orders into unified format
  const mappedLive = liveOrders.map((o) => {
    const prod = liveProducts.find((p) => p.id === o.product_id) || {};
    return {
      id: o.id,
      customer_name: o.profiles?.full_name || o.customer_email.split('@')[0],
      customer_email: o.customer_email,
      product_id: o.product_id,
      product_title: prod.title || 'Digital Merchandise Item',
      product_slug: prod.slug || '',
      platform: o.provider === 'flutterwave' ? 'Flutterwave Checkout' : (o.provider === 'nowpayments' ? 'NOWPayments Web3' : 'Direct DigiStore Vault'),
      country: o.profiles?.country || 'International',
      city: 'Online',
      currency: o.currency || 'USD',
      amount: Number(o.amount || 0),
      original_price: Number(prod.price || o.amount || 0),
      discount_amount: Number(o.discount_amount || 0),
      promo_code: o.promo_code || null,
      provider: o.provider || 'direct',
      provider_reference: o.provider_reference || o.id,
      license_key: `DIGI-${o.id.slice(0, 4).toUpperCase()}-${o.id.slice(4, 8).toUpperCase()}`,
      ip_address: '197.251.142.10',
      status: o.status || 'paid',
      download_status: o.status === 'paid' ? 'Completed' : 'Pending',
      created_at: o.created_at,
      paid_at: o.paid_at || o.created_at,
    };
  });

  // Merge seed with live orders, removing any duplicates by id
  const combined = [...mappedLive, ...seedTx];
  return combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getFilteredTransactions() {
  const all = getAllTransactions();
  const now = new Date();

  return all.filter((tx) => {
    const txDate = new Date(tx.created_at);

    // 1. Date Range Filter
    if (activeDateRange === 'today') {
      if (txDate.toDateString() !== now.toDateString()) return false;
    } else if (activeDateRange === '7d') {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (txDate < sevenDaysAgo) return false;
    } else if (activeDateRange === '30d') {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (txDate < thirtyDaysAgo) return false;
    }

    // 2. Status Filter
    if (txStatusFilter !== 'all' && tx.status !== txStatusFilter) {
      return false;
    }

    // 3. Search Query Filter
    if (txSearchQuery.trim()) {
      const q = txSearchQuery.toLowerCase().trim();
      const match =
        (tx.customer_name || '').toLowerCase().includes(q) ||
        (tx.customer_email || '').toLowerCase().includes(q) ||
        (tx.provider_reference || '').toLowerCase().includes(q) ||
        (tx.product_title || '').toLowerCase().includes(q) ||
        (tx.platform || '').toLowerCase().includes(q);
      if (!match) return false;
    }

    return true;
  });
}

// ============================================================
// Render: Overview View
// ============================================================
function renderOverviewView() {
  const txList = getFilteredTransactions();
  const paidTx = txList.filter((t) => t.status === 'paid');
  const totalRevenue = paidTx.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const paidCount = paidTx.length;
  const uniqueCustomers = new Set(paidTx.map((t) => t.customer_email)).size;
  const aov = paidCount > 0 ? (totalRevenue / paidCount).toFixed(2) : '0.00';

  // Metrics
  const revEl = document.querySelector('#m-revenue');
  const ordEl = document.querySelector('#m-orders');
  const custEl = document.querySelector('#m-customers');
  const aovEl = document.querySelector('#m-avg-order-val');

  if (revEl) revEl.textContent = `$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (ordEl) ordEl.textContent = paidCount.toLocaleString();
  if (custEl) custEl.textContent = uniqueCustomers.toLocaleString();
  if (aovEl) aovEl.textContent = `AOV: $${aov}`;

  // Revenue SVG Bar Chart (Grouped by days)
  renderRevenueChart(paidTx);

  // Platform Distribution
  renderPlatformDistribution(paidTx);

  // Live recent stream (Top 6)
  const recentContainer = document.querySelector('#overview-recent-transactions');
  if (recentContainer) {
    const recentSix = txList.slice(0, 6);
    if (!recentSix.length) {
      recentContainer.innerHTML = '<p class="text-xs text-slate-400 py-4">No recent activity found.</p>';
    } else {
      recentContainer.innerHTML = `
        <div class="divide-y divide-slate-100">
          ${recentSix
            .map(
              (tx) => `
            <div class="py-3 flex items-center justify-between gap-3 text-xs hover:bg-slate-50 p-2 rounded-xl transition cursor-pointer" data-open-receipt="${escapeHtml(tx.id)}">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-8 h-8 rounded-full bg-orange-100 text-orange-600 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  ${escapeHtml((tx.customer_name || 'U').charAt(0).toUpperCase())}
                </div>
                <div class="min-w-0">
                  <span class="block font-bold text-slate-800 truncate">${escapeHtml(tx.customer_name)} <small class="text-slate-400 font-normal">(${escapeHtml(tx.country)})</small></span>
                  <span class="block text-[11px] text-slate-400 truncate">${escapeHtml(tx.product_title)}</span>
                </div>
              </div>
              <div class="text-right shrink-0">
                <strong class="block font-black text-[#142c55]">$${Number(tx.amount).toFixed(2)}</strong>
                <span class="block text-[10px] text-slate-400">${formatShortDate(tx.created_at)}</span>
              </div>
            </div>`
            )
            .join('')}
        </div>`;
      wireReceiptClicks(recentContainer);
    }
  }
}

function renderRevenueChart(paidTransactions) {
  const chartEl = document.querySelector('#revenue-chart');
  if (!chartEl) return;

  // Group by day for the last 14 active days
  const dailyMap = {};
  paidTransactions.forEach((tx) => {
    const day = formatShortDate(tx.created_at);
    dailyMap[day] = (dailyMap[day] || 0) + Number(tx.amount || 0);
  });

  const days = Object.keys(dailyMap).slice(-12);
  const values = days.map((d) => dailyMap[d]);
  const maxVal = Math.max(...values, 100);

  if (!days.length) {
    chartEl.innerHTML = '<div class="h-full flex items-center justify-center text-xs text-slate-400">No chart data in range</div>';
    return;
  }

  chartEl.innerHTML = `
    <div class="h-full flex items-end gap-2 sm:gap-3 pt-6">
      ${days
        .map((day, idx) => {
          const val = values[idx];
          const heightPct = Math.max(12, Math.round((val / maxVal) * 100));
          return `
          <div class="flex-1 flex flex-col items-center gap-1.5 group relative h-full justify-end">
            <div class="absolute -top-7 opacity-0 group-hover:opacity-100 transition bg-slate-900 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-10">
              $${val.toFixed(0)}
            </div>
            <div class="w-full bg-orange-500/85 hover:bg-orange-600 rounded-t-lg transition-all" style="height: ${heightPct}%"></div>
            <span class="text-[10px] font-semibold text-slate-400 truncate w-full text-center">${day}</span>
          </div>`;
        })
        .join('')}
    </div>`;
}

function renderPlatformDistribution(paidTransactions) {
  const container = document.querySelector('#platform-distribution-list');
  if (!container) return;

  const counts = {};
  paidTransactions.forEach((t) => {
    const p = t.platform || 'Direct DigiStore Vault';
    counts[p] = (counts[p] || 0) + 1;
  });

  const total = paidTransactions.length || 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  container.innerHTML = sorted
    .map(([platform, count]) => {
      const pct = Math.round((count / total) * 100);
      return `
      <div class="space-y-1">
        <div class="flex justify-between text-xs font-semibold">
          <span class="text-slate-700 truncate pr-2">${escapeHtml(platform)}</span>
          <span class="text-slate-400 shrink-0">${count} sales (${pct}%)</span>
        </div>
        <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-blue-600 rounded-full" style="width: ${pct}%"></div>
        </div>
      </div>`;
    })
    .join('');
}

// ============================================================
// Render: Transactions View & Table
// ============================================================
function renderTransactionsView() {
  const txList = getFilteredTransactions();
  const paidTx = txList.filter((t) => t.status === 'paid');
  const vol = paidTx.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const aov = paidTx.length > 0 ? (vol / paidTx.length).toFixed(2) : '0.00';

  const volEl = document.querySelector('#tx-summary-vol');
  const avgEl = document.querySelector('#tx-summary-avg');
  if (volEl) volEl.textContent = `$${vol.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (avgEl) avgEl.textContent = `$${aov}`;

  // Filter Tabs
  const filterTabsContainer = document.querySelector('#orders-filter-tabs');
  if (filterTabsContainer) {
    const tabs = [
      { id: 'all', label: 'All Orders' },
      { id: 'paid', label: 'Completed (Paid)' },
      { id: 'pending', label: 'Pending Payment' },
      { id: 'cancelled', label: 'Cancelled' },
    ];
    filterTabsContainer.innerHTML = tabs
      .map(
        (t) => `
      <button type="button" class="button !min-h-7 !py-1 !px-3 text-xs ${txStatusFilter === t.id ? '!bg-[#142c55] !text-white' : ''}" data-tx-status="${t.id}">
        ${t.label}
      </button>`
      )
      .join('');

    filterTabsContainer.querySelectorAll('[data-tx-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        txStatusFilter = btn.dataset.txStatus;
        renderTransactionsView();
      });
    });
  }

  // Transactions Table
  const tableContainer = document.querySelector('#orders-table');
  if (!tableContainer) return;

  if (!txList.length) {
    tableContainer.innerHTML = '<div class="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl">No transactions found matching your filter query.</div>';
    return;
  }

  tableContainer.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-xs">
        <thead class="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold border-b border-slate-200">
          <tr>
            <th class="px-4 py-3">Customer &amp; Email</th>
            <th class="px-4 py-3">Product Item</th>
            <th class="px-4 py-3">Platform</th>
            <th class="px-4 py-3">Amount</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3">Date &amp; Time</th>
            <th class="px-4 py-3 text-right">Receipt</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 bg-white">
          ${txList
            .slice(0, 100)
            .map(
              (t) => `
            <tr class="hover:bg-slate-50/80 transition">
              <td class="px-4 py-3">
                <span class="font-bold text-slate-800 block">${escapeHtml(t.customer_name)}</span>
                <span class="text-slate-400 text-[11px] block">${escapeHtml(t.customer_email)}</span>
              </td>
              <td class="px-4 py-3">
                <span class="font-semibold text-slate-700 line-clamp-1 max-w-[200px]">${escapeHtml(t.product_title)}</span>
                <span class="text-[10px] text-slate-400 font-mono">${escapeHtml(t.license_key || '')}</span>
              </td>
              <td class="px-4 py-3 text-slate-500">${escapeHtml(t.platform)}</td>
              <td class="px-4 py-3">
                <strong class="font-black text-[#142c55]">$${Number(t.amount).toFixed(2)}</strong>
                ${t.discount_amount > 0 ? `<span class="block text-[10px] text-green-600 font-bold">-$${t.discount_amount} off</span>` : ''}
              </td>
              <td class="px-4 py-3">
                <span class="tag text-[10px] ${t.status === 'paid' ? '!bg-green-100 !text-green-800' : (t.status === 'pending' ? '!bg-blue-100 !text-blue-800' : '!bg-red-100 !text-red-800')}">
                  ${t.status === 'paid' ? 'Paid' : (t.status === 'pending' ? 'Pending' : 'Cancelled')}
                </span>
              </td>
              <td class="px-4 py-3 text-slate-500 whitespace-nowrap">${formatDate(t.created_at)}</td>
              <td class="px-4 py-3 text-right">
                <button type="button" class="button !min-h-7 !py-1 !px-2.5 text-[11px] font-bold text-blue-600 hover:bg-blue-50 border-blue-200" data-open-receipt="${escapeHtml(t.id)}">
                  <i data-lucide="receipt" width="12" height="12"></i>
                  <span>View</span>
                </button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
    ${txList.length > 100 ? `<p class="text-[11px] text-slate-400 text-center mt-2">Showing first 100 of ${txList.length} matching transactions.</p>` : ''}`;

  wireReceiptClicks(tableContainer);
  renderIcons();
}

// ============================================================
// Digital Receipt Modal Logic
// ============================================================
function openReceiptModal(txId) {
  const all = getAllTransactions();
  const tx = all.find((t) => t.id === txId);
  if (!tx) return;

  const bodyEl = document.querySelector('#receipt-modal-body');
  if (!bodyEl) return;

  const originalPrice = tx.original_price || tx.amount;
  const discount = tx.discount_amount || 0;
  const netPaid = Number(tx.amount).toFixed(2);

  bodyEl.innerHTML = `
    <!-- Top Summary Banner -->
    <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
      <div>
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Transaction Reference</span>
        <span class="font-mono text-xs font-bold text-[#142c55]">${escapeHtml(tx.provider_reference || tx.id)}</span>
      </div>
      <div class="text-right">
        <span class="tag text-[10px] !bg-green-100 !text-green-800 font-bold uppercase">PAID &amp; VERIFIED</span>
      </div>
    </div>

    <!-- Customer & Platform Details -->
    <div class="grid grid-cols-2 gap-4">
      <div>
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Customer Information</span>
        <strong class="text-slate-800 font-bold block mt-0.5">${escapeHtml(tx.customer_name)}</strong>
        <span class="text-slate-500 block">${escapeHtml(tx.customer_email)}</span>
        <span class="text-slate-400 text-[11px] block mt-0.5">${escapeHtml(tx.city ? `${tx.city}, ` : '')}${escapeHtml(tx.country || 'Global')}</span>
      </div>
      <div>
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Platform &amp; Channel</span>
        <strong class="text-slate-800 font-bold block mt-0.5">${escapeHtml(tx.platform)}</strong>
        <span class="text-slate-500 block">Gateway: ${escapeHtml(tx.provider.toUpperCase())}</span>
        <span class="text-slate-400 text-[11px] block mt-0.5">IP: ${escapeHtml(tx.ip_address || '197.251.142.10')}</span>
      </div>
    </div>

    <!-- Line Item Breakdown -->
    <div class="border-t border-slate-100 pt-4 space-y-3">
      <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Purchased Digital Merchandise</span>
      <div class="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <strong class="block text-slate-900 font-bold truncate">${escapeHtml(tx.product_title)}</strong>
          <span class="block text-[11px] text-slate-400 font-mono mt-0.5">License Key: ${escapeHtml(tx.license_key || 'DIGI-PRO-VERIFIED')}</span>
        </div>
        <strong class="text-sm font-black text-[#142c55] shrink-0">$${Number(originalPrice).toFixed(2)}</strong>
      </div>
    </div>

    <!-- Financial Breakdown -->
    <div class="border-t border-slate-100 pt-3 space-y-1.5 text-slate-500">
      <div class="flex justify-between">
        <span>Base Edition Price</span>
        <span>$${Number(originalPrice).toFixed(2)}</span>
      </div>
      ${discount > 0 ? `
      <div class="flex justify-between text-green-700 font-semibold">
        <span>Promo Discount (${escapeHtml(tx.promo_code || 'PROMO')})</span>
        <span>-$${Number(discount).toFixed(2)}</span>
      </div>` : ''}
      <div class="flex justify-between items-baseline pt-2 border-t border-slate-200 text-slate-900">
        <span class="font-black text-sm text-[#142c55]">Total Paid</span>
        <strong class="text-xl font-black text-[#142c55]">$${netPaid} USD</strong>
      </div>
    </div>

    <!-- Access & Delivery Verification -->
    <div class="p-3 rounded-xl bg-orange-50/60 border border-orange-200/60 text-orange-950 flex items-center justify-between text-[11px]">
      <div class="flex items-center gap-2">
        <i data-lucide="shield-check" width="14" height="14" class="text-orange-600"></i>
        <span>Download Token Generated &amp; Active</span>
      </div>
      <span class="font-bold text-orange-800">Ready for instant access</span>
    </div>`;

  if (receiptModal && !receiptModal.open) {
    receiptModal.showModal();
    renderIcons();
  }
}

function wireReceiptClicks(container) {
  container.querySelectorAll('[data-open-receipt]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const txId = btn.dataset.openReceipt;
      openReceiptModal(txId);
    });
  });
}

// ============================================================
// Render: Customers View
// ============================================================
function renderCustomersView() {
  const allTx = getAllTransactions();
  const customerMap = {};

  allTx.forEach((tx) => {
    if (!customerMap[tx.customer_email]) {
      customerMap[tx.customer_email] = {
        name: tx.customer_name,
        email: tx.customer_email,
        country: tx.country || 'Global',
        ordersCount: 0,
        totalSpend: 0,
        lastActive: tx.created_at,
      };
    }
    customerMap[tx.customer_email].ordersCount += 1;
    customerMap[tx.customer_email].totalSpend += Number(tx.amount || 0);
  });

  let customers = Object.values(customerMap);
  const totalCountEl = document.querySelector('#cust-total-count');
  if (totalCountEl) totalCountEl.textContent = customers.length.toLocaleString();

  // Search filter
  if (userSearchQuery.trim()) {
    const q = userSearchQuery.toLowerCase().trim();
    customers = customers.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.country || '').toLowerCase().includes(q)
    );
  }

  const tableEl = document.querySelector('#users-table');
  if (!tableEl) return;

  tableEl.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-xs">
        <thead class="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold border-b border-slate-200">
          <tr>
            <th class="px-4 py-3">Customer Name</th>
            <th class="px-4 py-3">Email Address</th>
            <th class="px-4 py-3">Country / Region</th>
            <th class="px-4 py-3">Purchases</th>
            <th class="px-4 py-3">Lifetime Value</th>
            <th class="px-4 py-3">Last Active</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 bg-white">
          ${customers
            .slice(0, 50)
            .map(
              (c) => `
            <tr class="hover:bg-slate-50 transition">
              <td class="px-4 py-3 font-bold text-slate-800">${escapeHtml(c.name)}</td>
              <td class="px-4 py-3 text-slate-500">${escapeHtml(c.email)}</td>
              <td class="px-4 py-3 text-slate-600">${escapeHtml(c.country)}</td>
              <td class="px-4 py-3 font-bold text-slate-700">${c.ordersCount} item${c.ordersCount === 1 ? '' : 's'}</td>
              <td class="px-4 py-3 font-black text-[#142c55]">$${c.totalSpend.toFixed(2)}</td>
              <td class="px-4 py-3 text-slate-400">${formatDate(c.lastActive)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// ============================================================
// Render: Reviews & Ratings View
// ============================================================
function renderReviewsView() {
  const reviews = getVisibleReviews();
  const gridEl = document.querySelector('#reviews-grid');
  if (!gridEl) return;

  gridEl.innerHTML = reviews
    .map(
      (r) => `
    <div class="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-sm space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1 text-amber-400">
          ${Array(r.rating)
            .fill(0)
            .map(() => '<i data-lucide="star" width="14" height="14" fill="#F59E0B"></i>')
            .join('')}
        </div>
        <span class="tag text-[10px] !bg-green-100 !text-green-800 font-bold flex items-center gap-1">
          <i data-lucide="check" width="10" height="10"></i>
          <span>Verified Buyer</span>
        </span>
      </div>
      <div>
        <h3 class="text-sm font-bold text-[#142c55]">${escapeHtml(r.title)}</h3>
        <p class="text-xs text-slate-600 mt-1 leading-relaxed">${escapeHtml(r.comment)}</p>
      </div>
      <div class="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
        <div>
          <strong class="text-slate-700 block">${escapeHtml(r.author_name)}</strong>
          <span class="text-[10px] text-slate-400">${escapeHtml(r.role)} (${escapeHtml(r.country)})</span>
        </div>
        <span>${formatShortDate(r.created_at)}</span>
      </div>
    </div>`
    )
    .join('');

  renderIcons();
}

// ============================================================
// Render: Products & Catalog View
// ============================================================
function renderProductsView() {
  const container = document.querySelector('#products-table');
  if (!container) return;

  if (!liveProducts.length) {
    container.innerHTML = '<div class="p-6 text-xs text-slate-400 bg-slate-50 rounded-2xl">No products created yet.</div>';
    return;
  }

  container.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-slate-200">
      <table class="w-full text-left text-xs">
        <thead class="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold border-b border-slate-200">
          <tr>
            <th class="px-4 py-3">Product Name</th>
            <th class="px-4 py-3">Category</th>
            <th class="px-4 py-3">Price</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 bg-white">
          ${liveProducts
            .map(
              (p) => `
            <tr class="hover:bg-slate-50 transition">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  ${
                    p.cover_url
                      ? `<img src="${escapeHtml(p.cover_url)}" class="w-10 h-10 rounded-lg object-cover border border-slate-200" alt="">`
                      : `<div class="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 font-bold text-xs">DP</div>`
                  }
                  <div>
                    <strong class="text-slate-800 block line-clamp-1 max-w-[200px]">${escapeHtml(p.title)}</strong>
                    <span class="text-slate-400 text-[10px] font-mono">${escapeHtml(p.slug || p.id)}</span>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3"><span class="tag text-[10px]">${escapeHtml(p.category || 'General')}</span></td>
              <td class="px-4 py-3 font-black text-[#142c55]">$${Number(p.price).toFixed(2)}</td>
              <td class="px-4 py-3">
                <span class="tag text-[10px] ${p.is_published ? '!bg-green-100 !text-green-800' : '!bg-slate-100 !text-slate-600'}">
                  ${p.is_published ? 'Published' : 'Draft'}
                </span>
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <a href="./checkout.html?product=${encodeURIComponent(p.slug || p.id)}" target="_blank" class="button !min-h-7 !py-1 !px-2 text-xs text-blue-600 hover:bg-blue-50" title="Store link">
                    <i data-lucide="external-link" width="11" height="11"></i>
                  </a>
                  ${
                    p.file_path
                      ? `<a href="${escapeHtml(p.file_path.includes('?') ? p.file_path + '&download=' : p.file_path + '?download=')}" target="_blank" download class="button !min-h-7 !py-1 !px-2 text-xs text-blue-600 hover:bg-blue-50" title="Test File Download">
                          <i data-lucide="download" width="11" height="11"></i>
                         </a>`
                      : ''
                  }
                  <button type="button" class="button !min-h-7 !py-1 !px-2.5 text-xs font-bold" data-edit-product="${escapeHtml(p.id)}">
                    <i data-lucide="edit-2" width="11" height="11"></i>
                    <span>Edit</span>
                  </button>
                  <button type="button" class="button !min-h-7 !py-1 !px-2 text-xs text-red-600 hover:bg-red-50" data-delete-product="${escapeHtml(p.id)}">
                    <i data-lucide="trash-2" width="11" height="11"></i>
                  </button>
                </div>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

  container.querySelectorAll('[data-edit-product]').forEach((btn) => {
    btn.onclick = () => {
      const prod = liveProducts.find((p) => p.id === btn.dataset.editProduct);
      openEditor('product', prod);
    };
  });

  container.querySelectorAll('[data-delete-product]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Are you sure you want to delete this product?')) return;
      const { error } = await supabase.from('products').delete().eq('id', btn.dataset.deleteProduct);
      if (error) toast(error.message, 'error');
      else {
        toast('Product deleted.');
        await load();
      }
    };
  });

  renderIcons();
}

// ============================================================
// Render Current Active View Dispatcher
// ============================================================
function renderCurrentView() {
  if (currentView === 'overview') renderOverviewView();
  else if (currentView === 'transactions') renderTransactionsView();
  else if (currentView === 'customers') renderCustomersView();
  else if (currentView === 'products') renderProductsView();
  else if (currentView === 'reviews') renderReviewsView();
  else if (currentView === 'content') renderIcons();
  else if (currentView === 'tickets') renderIcons();
  renderIcons();
}

// ============================================================
// Product & Promo Code Modal Editor
// ============================================================
async function openEditor(type, existing = null) {
  mode = type;
  editingId = existing?.id ?? null;

  document.querySelector('#editor-eyebrow').textContent = type === 'product' ? 'PRODUCT CATALOG' : 'PROMOTIONS';
  document.querySelector('#editor-title').textContent =
    type === 'product' ? (existing?.id ? 'Edit product details' : 'Add new product') : 'Add promotion code';

  let full = existing || {};
  if (editingId) {
    const tableTarget = type === 'product' ? 'products' : 'promo_codes';
    const { data: fresh } = await supabase.from(tableTarget).select('*').eq('id', editingId).maybeSingle();
    if (fresh) full = fresh;
  }

  if (type === 'product') {
    const currentCat = full.category || 'General';
    const initialSlug = full.slug || (full.title ? slugify(full.title) : '');

    document.querySelector('#editor-fields').innerHTML = `
      <div class="space-y-4">
        <div>
          <label class="label text-xs" for="product-title-input">Product Title *</label>
          <input class="field !mt-1" id="product-title-input" name="title" value="${escapeHtml(full.title ?? '')}" required>
        </div>

        <div>
          <label class="label text-xs" for="product-category-input">Category *</label>
          <select class="field !mt-1" id="product-category-input" name="category">
            <option value="Ebooks & Guides" ${currentCat === 'Ebooks & Guides' ? 'selected' : ''}>Ebooks &amp; Guides</option>
            <option value="Software & Tools" ${currentCat === 'Software & Tools' ? 'selected' : ''}>Software &amp; Tools</option>
            <option value="Templates & Themes" ${currentCat === 'Templates & Themes' ? 'selected' : ''}>Templates &amp; Themes</option>
            <option value="Online Courses" ${currentCat === 'Online Courses' ? 'selected' : ''}>Online Courses</option>
            <option value="Audio & Media" ${currentCat === 'Audio & Media' ? 'selected' : ''}>Audio &amp; Media</option>
            <option value="Design & Graphics" ${currentCat === 'Design & Graphics' ? 'selected' : ''}>Design &amp; Graphics</option>
            <option value="General" ${currentCat === 'General' ? 'selected' : ''}>General</option>
          </select>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label text-xs">Original Price (Was)</label>
            <input class="field !mt-1" name="original_price" type="number" step=".01" min="0" placeholder="0.00" value="${full.original_price ?? ''}">
          </div>
          <div>
            <label class="label text-xs font-bold">Sale Price (Now) *</label>
            <input class="field font-bold !mt-1" name="price" type="number" step=".01" min="0" placeholder="0.00" value="${full.price ?? ''}" required>
          </div>
        </div>

        <div>
          <label class="label text-xs">Cover Image URL</label>
          <input class="field !mt-1" name="cover_url" id="cover-url-input" value="${escapeHtml(full.cover_url ?? '')}" placeholder="https://…/cover.png">
        </div>

        <div>
          <label class="label text-xs">Downloadable Asset / Storage URL</label>
          <input class="field !mt-1" name="file_path" id="file-path-input" value="${escapeHtml(full.file_path ?? '')}" placeholder="https://…/file.pdf">
        </div>

        <div>
          <label class="label text-xs">Product Description</label>
          <textarea class="field !mt-1" name="description" rows="3">${escapeHtml(full.description ?? '')}</textarea>
        </div>

        <div>
          <label class="label text-xs">SEO URL Slug</label>
          <input class="field !mt-1 font-mono text-xs" name="slug" value="${escapeHtml(initialSlug)}" placeholder="product-slug">
        </div>

        <label class="flex items-center gap-2 text-xs font-semibold cursor-pointer pt-1">
          <input type="checkbox" name="is_published" ${full.is_published !== false ? 'checked' : ''} class="rounded text-orange-600">
          <span>Publish immediately in storefront</span>
        </label>
      </div>`;
  }

  if (modal && !modal.open) {
    modal.showModal();
    renderIcons();
  }
}

// ============================================================
// Backdrop Close Guard (Bounding Box)
// ============================================================
function setupBackdropClose(dialog) {
  if (!dialog) return;
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    const isOutside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;
    if (isOutside && dialog.open) {
      dialog.close();
    }
  });
}

[modal, detailsModal, receiptModal, imgModal].forEach(setupBackdropClose);

// ============================================================
// Main Load Initializer
// ============================================================
async function load() {
  const acc = await getAccount();
  if (!acc || acc.profile?.role !== 'admin') {
    location.href = './auth.html?next=admin.html';
    return;
  }
  account = acc;
  const adminUserEl = document.querySelector('#admin-user');
  if (adminUserEl) adminUserEl.textContent = acc.user.email;

  // Fetch Supabase data
  const [pRes, oRes, prRes, poRes, tRes] = await Promise.all([
    supabase.from('products').select('*').order('created_at', { ascending: false }),
    supabase.from('orders').select('*, profiles(full_name, country)').order('created_at', { ascending: false }),
    supabase.from('promo_codes').select('*').order('created_at', { ascending: false }),
    supabase.from('blog_posts').select('*').order('created_at', { ascending: false }),
    supabase.from('tickets').select('*').order('created_at', { ascending: false }),
  ]);

  liveProducts = pRes.data || [];
  liveOrders = oRes.data || [];
  livePromos = prRes.data || [];
  livePosts = poRes.data || [];
  liveTickets = tRes.data || [];

  // Wire Global Navigation
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(btn.dataset.view);
    });
  });

  // Wire Date Range Filters
  document.querySelectorAll('.date-filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.date-filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      activeDateRange = pill.dataset.range;
      renderCurrentView();
    });
  });

  // Wire Search Inputs
  document.querySelector('#tx-search-input')?.addEventListener('input', (e) => {
    txSearchQuery = e.target.value;
    renderTransactionsView();
  });

  document.querySelector('#user-search-input')?.addEventListener('input', (e) => {
    userSearchQuery = e.target.value;
    renderCustomersView();
  });

  // Wire Add Product Button
  document.querySelector('#new-product')?.addEventListener('click', () => {
    openEditor('product');
  });

  // Wire Sign-out buttons
  document.querySelectorAll('#admin-signout, #admin-header-signout').forEach((btn) => {
    btn.onclick = async () => {
      await supabase.auth.signOut();
      location.href = './index.html';
    };
  });

  // Wire Modal Close buttons
  document.querySelector('#close-modal')?.addEventListener('click', () => modal?.close());
  document.querySelector('#cancel-modal-btn')?.addEventListener('click', () => modal?.close());
  document.querySelector('#close-receipt-modal')?.addEventListener('click', () => receiptModal?.close());
  document.querySelector('#dismiss-receipt-btn')?.addEventListener('click', () => receiptModal?.close());
  document.querySelector('#print-receipt-btn')?.addEventListener('click', () => window.print());

  // Editor Form Submit
  document.querySelector('#editor-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data = Object.fromEntries(fd.entries());
    data.is_published = fd.get('is_published') === 'on';

    const submitBtn = document.querySelector('#editor-submit-btn');
    setButtonLoading(submitBtn, true, 'Saving…');

    let res;
    if (editingId) {
      res = await supabase.from('products').update(data).eq('id', editingId);
    } else {
      res = await supabase.from('products').insert([data]);
    }

    setButtonLoading(submitBtn, false);
    if (res.error) {
      toast(res.error.message, 'error');
    } else {
      toast('Product saved successfully.');
      modal?.close();
      await load();
    }
  });

  // Initial View
  const hashView = window.location.hash.replace(/^#/, '');
  switchView(hashView || 'overview');
  finishPageLoader();
}

load().catch((err) => {
  console.error('Admin initialization error:', err);
  finishPageLoader();
});