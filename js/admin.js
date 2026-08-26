/**
 * Admin back-office.
 *
 * Sidebar-nav + hash-routed content panels, same shape as the vendor
 * console (js/vendor.js). Every screen reads/writes the real Supabase
 * schema — no placeholder data. The CMS panel (A07) is the deepest: it
 * drives `cms_documents` through the `cms_*` RPC surface (save / publish /
 * unpublish / restore / duplicate / delete / claim-lock), renders
 * `cms_revisions` as a version-history panel, and `cms_assets` as a media
 * library.
 */
import { supabase } from './client.js';
import {
  escapeHtml, finishPageLoader, getAccount, icon, mountFooter, mountHeader,
  renderIcons, toast,
} from './ui.js';
import {
  confirmDialog, emptyState, initTabs, openModal, renderDataTable,
  setButtonBusy, statusBadge,
} from './uikit.js';
import { enhanceSelects, refreshSelect } from './select.js';

let account = null;

/* ==========================================================================
   Admin tier / permission matrix — mirrors admin_has_permission() in the
   20260826130000 migration. This is UX only (hide/disable what a viewer's
   own tier cannot do); the RPCs enforce the real boundary server-side.
   ========================================================================== */

const TIER_PERMS = {
  super_admin: ['manage_admins', 'manage_users', 'moderate_content', 'send_notifications', 'manage_settings'],
  admin: ['manage_users', 'moderate_content', 'send_notifications', 'manage_settings'],
  moderator: ['moderate_content', 'send_notifications'],
  support: ['send_notifications'],
};

function myTier() {
  if (account?.profile?.role !== 'admin') return null;
  return account.profile.admin_tier || 'super_admin'; // pre-migration admins backfilled to super_admin server-side
}

function hasPerm(permission) {
  const tier = myTier();
  return tier ? (TIER_PERMS[tier] || []).includes(permission) : false;
}

/* ==========================================================================
   Formatting helpers
   ========================================================================== */

const money = (value, currency = 'USD') =>
  `${currency} ${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (value) => value
  ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

const dateTime = (value) => value
  ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

function slugify(text) {
  return (text || '').toLowerCase().trim()
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function uploadTo(bucket, kind, file, statusEl) {
  if (statusEl) { statusEl.textContent = 'Uploading…'; statusEl.className = 'help'; }
  const path = `${kind}/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
  const { data, error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) {
    if (statusEl) { statusEl.textContent = error.message; statusEl.className = 'help'; statusEl.style.color = 'var(--danger)'; }
    return null;
  }
  if (statusEl) { statusEl.textContent = `✓ ${file.name}`; statusEl.className = 'help'; statusEl.style.color = '#2dab66'; }
  return data.path;
}

/* ==========================================================================
   Screen routing
   ========================================================================== */

const SCREEN_TITLES = {
  overview: 'Overview', customers: 'Customers', transactions: 'Transactions', products: 'Products',
  categories: 'Categories', promotions: 'Promotions', content: 'CMS & Journal', stores: 'Stores',
  moderation: 'Moderation', tickets: 'Tickets', notifications: 'Notifications', admins: 'Admins',
  settings: 'Site settings', audit: 'Audit log',
};

const SCREEN_LOADERS = {};

function activateScreen() {
  const key = location.hash.replace('#', '') || 'overview';
  const valid = SCREEN_TITLES[key] ? key : 'overview';
  document.querySelectorAll('.adm-tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.admPanel === valid);
  });
  document.querySelectorAll('[data-adm-link]').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.admLink === valid);
  });
  window.scrollTo(0, 0);
  SCREEN_LOADERS[valid]?.();
}

window.addEventListener('hashchange', activateScreen);

/* ==========================================================================
   Overview (A01)
   ========================================================================== */

let dashboardData = null;
let overviewLoaded = false;

function chart(points) {
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const stride = points.length > 12 ? 5 : 1;
  return `<div style="display:flex;height:100%;align-items:flex-end;gap:6px">${points.map((p, index) => `
    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;min-width:0" title="${p.date}: $${p.revenue.toFixed(2)}">
      <div style="width:100%;min-width:4px;border-radius:3px 3px 0 0;background:var(--accent);height:${Math.max(5, (p.revenue / max) * 150)}px"></div>
      <small style="font-size:9px;color:var(--text-soft)">${index % stride === 0 ? p.date.slice(5) : ''}</small>
    </div>`).join('')}</div>`;
}

function renderRankList(items, valueKey, meta) {
  if (!items?.length) return emptyState({ icon: 'bar-chart-3', title: 'No data yet', body: 'Figures appear once paid orders are recorded.' });
  const max = Math.max(...items.map((item) => Number(item[valueKey]) || 0), 1);
  return `<div class="adm-rank-list">${items.map((item) => `
    <div class="adm-rank-row">
      <div><strong>${escapeHtml(item.title || item.category)}</strong><small>${escapeHtml(meta(item))}</small></div>
      <span class="adm-rank-value">$${Number(item[valueKey]).toFixed(2)}</span>
      <div class="adm-rank-track"><span style="width:${Math.max(4, Number(item[valueKey]) / max * 100)}%"></span></div>
    </div>`).join('')}</div>`;
}

/** Small conic-gradient donut + legend — no dependency, matches the project's
 *  lightweight-charts convention (see .vnd-chart-bars in js/vendor.js). */
function donutChart(segments, { size = 132 } = {}) {
  const total = segments.reduce((sum, s) => sum + Number(s.value || 0), 0);
  if (!total) return emptyState({ icon: 'pie-chart', title: 'No data yet' });
  let acc = 0;
  const stops = segments.filter((s) => s.value > 0).map((s) => {
    const start = (acc / total) * 360; acc += Number(s.value);
    const end = (acc / total) * 360;
    return `${s.color} ${start}deg ${end}deg`;
  }).join(', ');
  return `
    <div style="display:flex;align-items:center;gap:22px;flex-wrap:wrap">
      <div style="width:${size}px;height:${size}px;border-radius:50%;background:conic-gradient(${stops});flex-shrink:0" role="img" aria-label="Breakdown chart"></div>
      <div class="adm-legend">
        ${segments.map((s) => `
          <div class="adm-legend-row"><span class="adm-legend-dot" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><strong>${s.value}</strong></div>`).join('')}
      </div>
    </div>`;
}

/** Horizontal stacked bar + legend, for a two/three-way status split. */
function stackedBar(segments) {
  const total = segments.reduce((sum, s) => sum + Number(s.value || 0), 0) || 1;
  return `
    <div style="display:flex;height:22px;border-radius:999px;overflow:hidden;border:1px solid var(--border)">
      ${segments.map((s) => `<span style="display:block;width:${(s.value / total) * 100}%;background:${s.color}" title="${escapeHtml(s.label)}: ${s.value}"></span>`).join('')}
    </div>
    <div class="adm-legend mt-3">
      ${segments.map((s) => `<div class="adm-legend-row"><span class="adm-legend-dot" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><strong>${s.value}</strong></div>`).join('')}
    </div>`;
}

/** Generic bar-chart-over-time, parametrized version of chart() above. */
function sparkBars(points, valueKey, labelFn) {
  if (!points.length) return `<div class="vnd-chart-empty">Not enough data yet.</div>`;
  const max = Math.max(1, ...points.map((p) => Number(p[valueKey]) || 0));
  const stride = points.length > 12 ? Math.ceil(points.length / 12) : 1;
  return `<div style="display:flex;height:100%;align-items:flex-end;gap:6px">${points.map((p, index) => `
    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;min-width:0" title="${escapeHtml(labelFn(p))}">
      <div style="width:100%;min-width:4px;border-radius:3px 3px 0 0;background:var(--accent);height:${Math.max(5, (Number(p[valueKey]) || 0) / max * 150)}px"></div>
      <small style="font-size:9px;color:var(--text-soft)">${index % stride === 0 ? p.label : ''}</small>
    </div>`).join('')}</div>`;
}

/** Buckets an array of ISO timestamps into the last `weeks` weekly counts. */
function weeklyBuckets(dates, weeks = 12) {
  const now = new Date();
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(now); end.setDate(end.getDate() - i * 7);
    const start = new Date(end); start.setDate(start.getDate() - 7);
    buckets.push({ start, end, label: `${start.getMonth() + 1}/${start.getDate()}`, count: 0 });
  }
  dates.forEach((iso) => {
    if (!iso) return;
    const d = new Date(iso);
    const bucket = buckets.find((b) => d >= b.start && d < b.end);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/* ==========================================================================
   Platform analytics (stores / admins / customers / ads) — E
   Client-side aggregation over broad admin read access (RLS: is_admin()).
   No new RPC needed; these are simple GROUP BY-shaped selects.
   ========================================================================== */

let governanceProfiles = [];

async function loadGovernance() {
  const { data, error } = await supabase.from('profiles')
    .select('id,full_name,role,admin_tier,account_status,account_status_reason,account_status_at,created_at');
  if (error) { governanceProfiles = []; return; }
  governanceProfiles = data || [];
  const map = new Map(governanceProfiles.map((p) => [p.id, p]));
  customersState.users.forEach((u) => {
    const p = map.get(u.id);
    if (p) { u.account_status = p.account_status; u.account_status_reason = p.account_status_reason; u.admin_tier = p.admin_tier; }
  });
}

async function loadPlatformAnalytics() {
  const [{ data: vendorsAll }, { data: campaigns }, { data: walletTx }] = await Promise.all([
    supabase.from('vendors').select('id,user_id,display_name,status,applied_at,approved_at'),
    supabase.from('ad_campaigns').select('id,name,status,spend,budget,currency,created_at').order('spend', { ascending: false }),
    supabase.from('ad_wallet_transactions').select('amount,type,created_at').eq('type', 'spend').order('created_at', { ascending: false }).limit(2000),
  ]);
  storesState.vendors = vendorsAll || [];
  paintStores();

  const vendors = vendorsAll || [];
  const admins = governanceProfiles.filter((p) => p.role === 'admin');
  const customers = governanceProfiles.filter((p) => p.role === 'customer');

  const statRow = document.querySelector('#entity-stat-row');
  if (statRow) {
    statRow.innerHTML = `
      <div class="adm-stat-card"><span>Stores</span><strong>${vendors.length}</strong><small>${vendors.filter((v) => v.status === 'approved').length} approved</small></div>
      <div class="adm-stat-card"><span>Admins</span><strong>${admins.length}</strong><small>${admins.filter((a) => a.admin_tier === 'super_admin').length} super_admin</small></div>
      <div class="adm-stat-card"><span>Customers</span><strong>${customers.length}</strong><small>${customers.filter((c) => c.account_status && c.account_status !== 'active').length} restricted</small></div>`;
  }

  const vendorStatusColors = { pending: 'var(--warning)', approved: 'var(--success)', suspended: 'var(--danger)', rejected: 'var(--text-soft)' };
  const donut = document.querySelector('#stores-donut');
  if (donut) {
    donut.innerHTML = donutChart(['pending', 'approved', 'suspended', 'rejected'].map((status) => ({
      label: status[0].toUpperCase() + status.slice(1), value: vendors.filter((v) => v.status === status).length, color: vendorStatusColors[status],
    })));
  }

  const growthChart = document.querySelector('#stores-growth-chart');
  if (growthChart) {
    const buckets = weeklyBuckets(vendors.filter((v) => v.status === 'approved').map((v) => v.approved_at));
    growthChart.innerHTML = sparkBars(buckets, 'count', (b) => `${b.label}: ${b.count} approved`);
  }

  const signupsChart = document.querySelector('#signups-chart');
  if (signupsChart) {
    const buckets = weeklyBuckets(customers.map((c) => c.created_at));
    signupsChart.innerHTML = sparkBars(buckets, 'count', (b) => `${b.label}: ${b.count} signups`);
  }

  const statusBar = document.querySelector('#account-status-bar');
  if (statusBar) {
    const statusColors = { active: 'var(--success)', blocked: 'var(--danger)', suspended: 'var(--warning)', terminated: 'var(--text-soft)' };
    statusBar.innerHTML = stackedBar(['active', 'suspended', 'blocked', 'terminated'].map((s) => ({
      label: s[0].toUpperCase() + s.slice(1), value: customers.filter((c) => (c.account_status || 'active') === s).length, color: statusColors[s],
    })));
  }

  const adSpendChart = document.querySelector('#ad-spend-chart');
  if (adSpendChart) {
    const buckets = weeklyBuckets((walletTx || []).map((t) => t.created_at));
    (walletTx || []).forEach((t) => {
      const d = new Date(t.created_at);
      const bucket = buckets.find((b) => d >= b.start && d < b.end);
      if (bucket) bucket.spend = (bucket.spend || 0) + Number(t.amount || 0);
    });
    buckets.forEach((b) => { b.spendAbs = Math.abs(b.spend || 0); });
    adSpendChart.innerHTML = (walletTx || []).length
      ? sparkBars(buckets, 'spendAbs', (b) => `${b.label}: $${(b.spendAbs || 0).toFixed(2)}`)
      : `<div class="vnd-chart-empty">No ad spend recorded yet.</div>`;
  }

  const campaignDonut = document.querySelector('#campaign-donut');
  if (campaignDonut) {
    const campaignColors = { draft: 'var(--text-soft)', active: 'var(--success)', paused: 'var(--warning)', completed: 'var(--info)', rejected: 'var(--danger)' };
    campaignDonut.innerHTML = donutChart(['draft', 'active', 'paused', 'completed', 'rejected'].map((status) => ({
      label: status[0].toUpperCase() + status.slice(1), value: (campaigns || []).filter((c) => c.status === status).length, color: campaignColors[status],
    })));
  }

  const topCampaigns = document.querySelector('#top-campaigns');
  if (topCampaigns) {
    const top = (campaigns || []).filter((c) => Number(c.spend) > 0).slice(0, 6)
      .map((c) => ({ title: c.name, revenue: Number(c.spend), status: c.status }));
    topCampaigns.innerHTML = renderRankList(top, 'revenue', (item) => `Status: ${item.status}`);
  }

  renderIcons();
}

async function loadOverview(force = false) {
  if (overviewLoaded && !force) return;
  const { data, error } = await supabase.functions.invoke('admin-dashboard');
  if (error || data?.error) {
    toast(data?.error || error?.message || 'Could not load the dashboard.', 'error');
    return;
  }
  overviewLoaded = true;
  dashboardData = data;
  const { metrics, orders, users, tickets, products, promos, categories = [], revenueByDay, topProducts = [], categoryStats = [] } = data;

  document.querySelector('#m-revenue').textContent = `$${metrics.revenue.toFixed(2)}`;
  document.querySelector('#m-orders').textContent = metrics.paidOrders;
  document.querySelector('#m-customers').textContent = metrics.customers;
  document.querySelector('#m-tickets').textContent = metrics.openTickets;
  const averageOrder = metrics.paidOrders ? metrics.revenue / metrics.paidOrders : 0;
  document.querySelector('#m-aov').textContent = `Average order $${averageOrder.toFixed(2)}`;
  document.querySelector('#m-conversion').textContent = `${users.filter((u) => u.last_sign_in_at).length} signed in before`;
  document.querySelector('#m-catalog').textContent = `${metrics.activeProducts} of ${products.length} products live`;

  const renderRevenue = () => {
    const days = Number(document.querySelector('#revenue-period')?.value || 30);
    const selected = revenueByDay.slice(-days);
    const total = selected.reduce((sum, item) => sum + Number(item.revenue), 0);
    document.querySelector('#m-revenue-change').textContent = `$${total.toFixed(2)} in the selected period`;
    document.querySelector('#revenue-chart').innerHTML = chart(selected);
  };
  document.querySelector('#revenue-period').onchange = renderRevenue;
  renderRevenue();

  document.querySelector('#operations-list').innerHTML = `
    <div class="adm-stat-card !p-4"><span>Published products</span><strong>${metrics.activeProducts}</strong><small>${products.length - metrics.activeProducts} drafts remaining</small></div>
    <div class="adm-stat-card !p-4"><span>Support queue</span><strong>${metrics.openTickets}</strong><small>${tickets.filter((t) => t.status === 'pending').length} awaiting follow-up</small></div>`;
  document.querySelector('#top-products').innerHTML = renderRankList(topProducts, 'revenue', (item) => `${item.orders} paid order${item.orders === 1 ? '' : 's'}`);
  document.querySelector('#category-performance').innerHTML = renderRankList(categoryStats, 'revenue', (item) => `${item.products} product${item.products === 1 ? '' : 's'}`);

  document.querySelector('#customers-insight').textContent = `${users.length} customer profile${users.length === 1 ? '' : 's'} on record`;
  document.querySelector('#orders-insight').textContent = `${orders.filter((o) => o.status === 'paid').length} paid · ${orders.filter((o) => o.status === 'pending').length} pending`;
  document.querySelector('#support-insight').textContent = `${tickets.filter((t) => t.status !== 'closed').length} conversation${tickets.filter((t) => t.status !== 'closed').length === 1 ? '' : 's'} to resolve`;

  renderCustomers(users, orders);
  renderTransactions(orders);
  renderProducts(products, categories);
  renderCategories(categories, products);
  renderPromos(promos);
  renderTickets(tickets);

  await loadGovernance();
  paintCustomers();
  paintAdmins();
  loadPlatformAnalytics().catch((err) => console.error('Platform analytics failed:', err));
}

/* ==========================================================================
   Customers (A02)
   ========================================================================== */

let customersState = { page: 1, pageSize: 10, users: [], orders: [] };

function renderCustomers(users, orders) {
  customersState.users = users;
  customersState.orders = orders;
  paintCustomers();
}

function filteredCustomers() {
  const search = (document.querySelector('#customer-search')?.value || '').trim().toLowerCase();
  const role = document.querySelector('#customer-role-filter')?.value || '';
  return customersState.users.filter((u) => {
    if (role && u.role !== role) return false;
    if (!search) return true;
    return (u.full_name || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search);
  });
}

function paintCustomers() {
  const host = document.querySelector('#users-table');
  if (!host) return;
  const rows = filteredCustomers();
  const start = (customersState.page - 1) * customersState.pageSize;
  const pageRows = rows.slice(start, start + customersState.pageSize);

  renderDataTable(host, {
    columns: [
      {
        key: 'full_name', label: 'Customer', render: (u) => `
          <strong style="display:block;color:var(--text)">${escapeHtml(u.full_name || 'Anonymous user')}</strong>
          <span style="font-size:.74rem;color:var(--text-muted)">${escapeHtml(u.email || '')}</span>`,
      },
      { key: 'role', label: 'Role', render: (u) => statusBadge(u.role === 'admin' ? 'active' : 'neutral', u.role === 'admin' ? 'Admin' : 'Customer') },
      { key: 'account_status', label: 'Account', render: (u) => statusBadge(u.account_status || 'active') },
      {
        key: 'phone', label: 'Phone / country', render: (u) => `
          <div style="font-size:.78rem">${escapeHtml(u.phone || '—')}</div>
          <div style="font-size:.72rem;color:var(--text-soft)">${escapeHtml(u.country || '—')}</div>`,
      },
      { key: 'created_at', label: 'Joined', render: (u) => shortDate(u.created_at) },
    ],
    rows: pageRows,
    page: customersState.page,
    pageSize: customersState.pageSize,
    total: rows.length,
    onPage: (p) => { customersState.page = p; paintCustomers(); },
    rowActions: (u) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-manage-customer="${u.id}">Manage</button>
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-view-orders="${u.id}">Orders</button>
      ${accountStatusActionsHtml(u)}
      ${u.role !== 'admin' && hasPerm('manage_admins') ? `<button class="button !min-h-8 !px-3 text-xs" type="button" data-promote-admin="${u.id}">Promote</button>` : ''}`,
    emptyMessage: 'No customers match this filter.',
  });

  host.querySelectorAll('[data-manage-customer]').forEach((btn) => btn.addEventListener('click', () => {
    const user = customersState.users.find((u) => u.id === btn.dataset.manageCustomer);
    if (user) openCustomerModal(user);
  }));
  host.querySelectorAll('[data-view-orders]').forEach((btn) => btn.addEventListener('click', () => {
    const user = customersState.users.find((u) => u.id === btn.dataset.viewOrders);
    if (user) openCustomerOrdersModal(user);
  }));
  host.querySelectorAll('[data-account-status]').forEach((btn) => btn.addEventListener('click', () => {
    const user = customersState.users.find((u) => u.id === btn.dataset.accountStatus);
    if (user) openAccountStatusModal(user, btn.dataset.targetStatus);
  }));
  host.querySelectorAll('[data-promote-admin]').forEach((btn) => btn.addEventListener('click', () => {
    const user = customersState.users.find((u) => u.id === btn.dataset.promoteAdmin);
    if (user) openTierModal(user, { promote: true });
  }));
}

/**
 * Row-action buttons for account_status transitions. A viewer who lacks
 * manage_users sees nothing; one who has it but the target is itself an
 * admin (and the viewer isn't super_admin) also sees nothing — mirrors the
 * RPC's own guard, for a clean UX rather than a rejected-call error.
 */
function accountStatusActionsHtml(u) {
  if (!hasPerm('manage_users')) return '';
  if (u.role === 'admin' && !hasPerm('manage_admins')) return '';
  const current = u.account_status || 'active';
  const options = [
    current !== 'blocked' && { status: 'blocked', label: 'Block' },
    current !== 'suspended' && { status: 'suspended', label: 'Suspend' },
    current !== 'terminated' && { status: 'terminated', label: 'Terminate' },
    current !== 'active' && { status: 'active', label: 'Reactivate' },
  ].filter(Boolean);
  return options.map((o) => `<button class="button !min-h-8 !px-3 text-xs ${o.status === 'active' ? '' : 'button-danger'}" type="button" data-account-status="${u.id}" data-target-status="${o.status}">${o.label}</button>`).join('');
}

function openAccountStatusModal(user, targetStatus) {
  const label = { active: 'Reactivate', blocked: 'Block', suspended: 'Suspend', terminated: 'Terminate' }[targetStatus] || targetStatus;
  const { dialog } = openModal({
    id: 'account-status-modal',
    title: `${label} ${user.full_name || user.email}?`,
    danger: targetStatus !== 'active',
    body: `
      <form id="account-status-form">
        <p style="font-size:.84rem;color:var(--text-muted)">${targetStatus === 'active'
          ? 'This restores full account access immediately.'
          : `This immediately blocks the account from signing purchases, payouts, or store actions. It does not delete any data.`}</p>
        <label class="adm-field" style="margin-top:14px"><span class="label">Reason ${targetStatus === 'active' ? '(optional)' : '(recorded, shown to the user)'}</span><textarea class="field" name="reason" rows="3" placeholder="Why is this account being ${label.toLowerCase()}d?"></textarea></label>
        <p id="account-status-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="account-status-form" class="button ${targetStatus === 'active' ? 'button-primary' : 'button-danger'}">${label}</button>`,
  });
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#account-status-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = dialog.querySelector('button[form="account-status-form"]');
    const feedback = dialog.querySelector('#account-status-feedback');
    const reason = event.currentTarget.elements.reason.value.trim() || null;
    setBusy(button, true, 'Saving…');
    const { error } = await supabase.rpc('admin_set_account_status', { p_user_id: user.id, p_status: targetStatus, p_reason: reason });
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast(`Account ${targetStatus === 'active' ? 'reactivated' : label.toLowerCase() + 'd'}.`);
    await loadOverview(true);
  });
}

document.querySelector('#customer-search')?.addEventListener('input', () => { customersState.page = 1; paintCustomers(); });
document.querySelector('#customer-role-filter')?.addEventListener('change', () => { customersState.page = 1; paintCustomers(); });

function openCustomerModal(user) {
  const { dialog } = openModal({
    id: 'customer-modal',
    title: `Manage ${user.email}`,
    body: `
      <form id="customer-form">
        <label class="adm-field"><span class="label">Full name</span><input class="field" name="full_name" value="${escapeHtml(user.full_name || '')}"></label>
        <div class="adm-modal-grid" style="margin-top:14px">
          <label class="adm-field">
            <span class="label">System role</span>
            <select class="field" name="role">
              <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer</option>
              <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrator</option>
            </select>
          </label>
          <label class="adm-field"><span class="label">Phone</span><input class="field" name="phone" value="${escapeHtml(user.phone || '')}"></label>
          <label class="adm-field"><span class="label">Country</span><input class="field" name="country" value="${escapeHtml(user.country || '')}"></label>
          <label class="adm-field"><span class="label">Occupation</span><input class="field" name="occupation" value="${escapeHtml(user.occupation || '')}"></label>
        </div>
        <label class="adm-field" style="margin-top:14px"><span class="label">Address</span><textarea class="field" name="address" rows="2">${escapeHtml(user.address || '')}</textarea></label>
        <p id="customer-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="customer-form" class="button button-primary">Save changes</button>`,
  });
  dialog.classList.add('uk-modal--wide');
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#customer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="customer-form"]');
    const feedback = dialog.querySelector('#customer-feedback');
    setBusy(button, true, 'Saving…');
    const { data: res, error } = await supabase.functions.invoke('admin-dashboard', {
      body: {
        action: 'update_user_role', target_user_id: user.id,
        role: form.elements.role.value, full_name: form.elements.full_name.value,
        phone: form.elements.phone.value, country: form.elements.country.value,
        address: form.elements.address.value, occupation: form.elements.occupation.value,
      },
    });
    setBusy(button, false);
    if (error || res?.error) { feedback.textContent = res?.error || error?.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast('Customer updated.');
    await loadOverview(true);
  });
}

function openCustomerOrdersModal(user) {
  const userOrders = customersState.orders.filter((o) => o.user_id === user.id || o.customer_email?.toLowerCase() === user.email?.toLowerCase());
  const { dialog } = openModal({
    id: 'customer-orders-modal',
    title: user.full_name || user.email,
    body: `
      <div style="padding:14px;border-radius:var(--radius-md);background:var(--surface-sunken);border:1px solid var(--border);font-size:.78rem;display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;justify-content:space-between"><strong>Email</strong><span>${escapeHtml(user.email)}</span></div>
        <div style="display:flex;justify-content:space-between"><strong>Role</strong><span>${escapeHtml(user.role)}</span></div>
        <div style="display:flex;justify-content:space-between"><strong>Joined</strong><span>${shortDate(user.created_at)}</span></div>
      </div>
      <h3 style="margin-top:16px;font-family:var(--font-display);font-weight:800;font-size:.92rem">Order history (${userOrders.length})</h3>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto">
        ${userOrders.length ? userOrders.map((o) => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:var(--radius-md);background:var(--surface-sunken);border:1px solid var(--border)">
            <div><strong style="display:block;font-size:.82rem;color:var(--text)">${escapeHtml(o.products?.title || 'Digital product')}</strong><span style="font-size:.7rem;color:var(--text-muted)">${dateTime(o.created_at)} · ${escapeHtml(o.provider_reference || o.id.slice(0, 8))}</span></div>
            <div style="text-align:right"><strong style="display:block;font-size:.82rem">${money(o.amount, o.currency)}</strong>${statusBadge(o.status)}</div>
          </div>`).join('') : emptyState({ icon: 'receipt', title: 'No orders yet' })}
      </div>`,
    footer: `<button type="button" class="button" data-uk-cancel>Close</button>`,
  });
  dialog.classList.add('uk-modal--wide');
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
}

/* ==========================================================================
   Transactions (A03)
   ========================================================================== */

let ordersState = { page: 1, pageSize: 10, filter: 'all', orders: [] };

function renderTransactions(orders) {
  ordersState.orders = orders;
  ordersState.page = 1;
  paintOrdersSummary();
  paintOrdersTable();
}

function paintOrdersSummary() {
  const orders = ordersState.orders;
  const counts = { paid: 0, pending: 0, cancelled: 0, failed: 0, refunded: 0 };
  orders.forEach((o) => { if (counts[o.status] !== undefined) counts[o.status]++; });
  const summaryEl = document.querySelector('#orders-status-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      ${statusBadge('paid', `${counts.paid} paid`)} ${statusBadge('pending', `${counts.pending} pending`)}
      ${statusBadge('cancelled', `${counts.cancelled} cancelled`)} ${statusBadge('failed', `${counts.failed} failed`)}
      ${statusBadge('refunded', `${counts.refunded} refunded`)}
      <span style="color:var(--text-soft);font-size:.72rem;margin-left:4px">(Only paid orders count towards revenue)</span>`;
  }
  const filterEl = document.querySelector('#orders-filter-tabs');
  if (filterEl) {
    const tabs = [
      { key: 'all', label: `All (${orders.length})` }, { key: 'paid', label: `Paid (${counts.paid})` },
      { key: 'pending', label: `Pending (${counts.pending})` }, { key: 'cancelled', label: `Cancelled (${counts.cancelled})` },
      { key: 'failed', label: `Failed (${counts.failed})` }, { key: 'refunded', label: `Refunded (${counts.refunded})` },
    ];
    filterEl.innerHTML = tabs.map((t) => `
      <button type="button" class="button !min-h-8 !px-3 text-xs" data-filter="${t.key}" style="${ordersState.filter === t.key ? 'background:var(--ink-950);color:#fff;border-color:var(--ink-950)' : ''}">${t.label}</button>`).join('');
    filterEl.querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => {
      ordersState.filter = btn.dataset.filter; ordersState.page = 1; paintOrdersSummary(); paintOrdersTable();
    }));
  }
}

function paintOrdersTable() {
  const host = document.querySelector('#orders-table');
  if (!host) return;
  const filtered = ordersState.filter === 'all' ? ordersState.orders : ordersState.orders.filter((o) => o.status === ordersState.filter);
  const start = (ordersState.page - 1) * ordersState.pageSize;
  const pageRows = filtered.slice(start, start + ordersState.pageSize);

  renderDataTable(host, {
    columns: [
      {
        key: 'customer_email', label: 'Customer', render: (o) => `
          <div style="font-weight:600">${escapeHtml(o.customer_email)}</div>
          <div style="font-size:.7rem;color:var(--text-soft)">${escapeHtml(o.provider || 'gateway')} · ${escapeHtml(o.provider_reference || o.id.slice(0, 8))}</div>`,
      },
      { key: 'product', label: 'Product', render: (o) => escapeHtml(o.products?.title || 'Digital product') },
      { key: 'amount', label: 'Amount', render: (o) => `<strong>${money(o.amount, o.currency)}</strong>` },
      { key: 'status', label: 'Status', render: (o) => statusBadge(o.status) },
      { key: 'created_at', label: 'Date', render: (o) => shortDate(o.created_at) },
    ],
    rows: pageRows,
    page: ordersState.page,
    pageSize: ordersState.pageSize,
    total: filtered.length,
    onPage: (p) => { ordersState.page = p; paintOrdersTable(); },
    rowActions: (o) => `<button class="button !min-h-8 !px-3 text-xs" type="button" data-order-detail="${o.id}">Detail</button>`,
    emptyMessage: 'No orders in this filter.',
  });
  host.querySelectorAll('[data-order-detail]').forEach((btn) => btn.addEventListener('click', () => {
    const order = ordersState.orders.find((o) => o.id === btn.dataset.orderDetail);
    if (order) openOrderDetailModal(order);
  }));
}

async function openOrderDetailModal(order) {
  const { dialog } = openModal({
    id: 'order-detail-modal',
    title: `Order ${order.id.slice(0, 8)}`,
    body: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:.8rem">
        <div><strong>Customer</strong><div style="color:var(--text-muted)">${escapeHtml(order.customer_email)}</div></div>
        <div><strong>Status</strong><div>${statusBadge(order.status)}</div></div>
        <div><strong>Amount</strong><div>${money(order.amount, order.currency)}</div></div>
        <div><strong>Provider</strong><div style="color:var(--text-muted)">${escapeHtml(order.provider || '—')} · ${escapeHtml(order.provider_reference || '—')}</div></div>
        <div><strong>Placed</strong><div style="color:var(--text-muted)">${dateTime(order.created_at)}</div></div>
      </div>
      <h3 style="margin-top:16px;font-family:var(--font-display);font-weight:800;font-size:.88rem">Line items</h3>
      <div id="order-items-list" style="margin-top:8px;font-size:.8rem;color:var(--text-muted)">Loading…</div>`,
    footer: `
      ${order.status === 'paid' ? `<button type="button" class="button button-danger" data-refund>Mark refunded</button>` : ''}
      <button type="button" class="button" data-uk-cancel>Close</button>`,
  });
  dialog.classList.add('uk-modal--wide');
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-refund]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Mark this order refunded?', body: 'This only updates the record — process the actual refund with your payment provider separately.', confirmLabel: 'Mark refunded', danger: true });
    if (!ok) return;
    const { error } = await supabase.from('orders').update({ status: 'refunded' }).eq('id', order.id);
    if (error) { toast(error.message, 'error'); return; }
    toast('Order marked refunded.');
    dialog.close();
    await loadOverview(true);
  });

  const { data: items, error } = await supabase.from('order_items').select('title_snapshot,unit_price,quantity,currency').eq('order_id', order.id);
  const host = dialog.querySelector('#order-items-list');
  if (error || !items?.length) {
    host.innerHTML = `<div>${escapeHtml(order.products?.title || 'Digital product')} — ${money(order.amount, order.currency)}</div>`;
  } else {
    host.innerHTML = items.map((it) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border)">
        <span>${escapeHtml(it.title_snapshot)} × ${it.quantity}</span><strong>${money(it.unit_price * it.quantity, it.currency)}</strong>
      </div>`).join('');
  }
}

/* ==========================================================================
   Products (A04)
   ========================================================================== */

let productsState = { page: 1, pageSize: 10, products: [], categories: [] };

function categoryOptions(selected = 'General') {
  const managed = productsState.categories.map((c) => c.name);
  const defaults = ['Ebooks & Guides', 'Software & Tools', 'Templates & Themes', 'Online Courses', 'Audio & Media', 'Design & Graphics', 'General'];
  return [...new Set([...managed, ...defaults, selected])].filter(Boolean)
    .map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

function renderProducts(products, categories) {
  productsState.products = products;
  productsState.categories = categories;
  paintProducts();
}

function paintProducts() {
  const host = document.querySelector('#products-table');
  if (!host) return;
  const start = (productsState.page - 1) * productsState.pageSize;
  const pageRows = productsState.products.slice(start, start + productsState.pageSize);

  renderDataTable(host, {
    columns: [
      {
        key: 'title', label: 'Product', render: (p) => `
          <div style="display:flex;align-items:center;gap:10px">
            ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" alt="" style="width:44px;height:34px;border-radius:6px;object-fit:cover">` : `<span style="display:grid;place-items:center;width:44px;height:34px;border-radius:6px;background:var(--surface-sunken);font-size:8px;color:var(--text-soft)">No image</span>`}
            <span style="min-width:0"><strong style="display:block;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">${escapeHtml(p.title)}</strong><span style="font-size:.7rem;color:var(--text-muted)">${escapeHtml(p.category || 'General')}</span></span>
          </div>`,
      },
      { key: 'price', label: 'Price', render: (p) => p.original_price ? `<span style="text-decoration:line-through;color:var(--text-soft);font-size:.72rem">${money(p.original_price, p.currency)}</span> <strong>${money(p.price, p.currency)}</strong>` : `<strong>${money(p.price, p.currency)}</strong>` },
      { key: 'slug', label: 'Slug', render: (p) => `<span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text-muted)">${escapeHtml(p.slug || '—')}</span>` },
      { key: 'is_published', label: 'Status', render: (p) => statusBadge(p.is_published ? 'published' : 'draft') },
    ],
    rows: pageRows,
    page: productsState.page,
    pageSize: productsState.pageSize,
    total: productsState.products.length,
    onPage: (p) => { productsState.page = p; paintProducts(); },
    rowActions: (p) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-copy-link="${escapeHtml(p.slug || p.id)}" title="Copy checkout link">${icon('link', 12)}</button>
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-edit-product="${p.id}">Edit</button>
      <button class="button !min-h-8 !px-3 text-xs button-danger" type="button" data-delete-product="${p.id}">Delete</button>`,
    emptyMessage: 'No products in the catalog yet.',
  });

  host.querySelectorAll('[data-copy-link]').forEach((btn) => btn.addEventListener('click', () => {
    navigator.clipboard.writeText(`${window.location.origin}/checkout?product=${encodeURIComponent(btn.dataset.copyLink)}`);
    toast('Checkout link copied.');
  }));
  host.querySelectorAll('[data-edit-product]').forEach((btn) => btn.addEventListener('click', () => {
    const product = productsState.products.find((p) => p.id === btn.dataset.editProduct);
    openProductModal(product);
  }));
  host.querySelectorAll('[data-delete-product]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this product?', body: 'This removes it from the catalog permanently. Past orders are unaffected.', confirmLabel: 'Delete product' });
    if (!ok) return;
    const { error } = await supabase.from('products').delete().eq('id', btn.dataset.deleteProduct);
    if (error) { toast(error.message, 'error'); return; }
    toast('Product deleted.');
    supabase.functions.invoke('sitemap').catch(() => {});
    await loadOverview(true);
  }));
}

document.querySelector('#new-product')?.addEventListener('click', () => openProductModal(null));

function openProductModal(product = null) {
  const { dialog } = openModal({
    id: 'product-modal',
    title: product ? 'Edit product' : 'New product',
    body: `
      <form id="product-form">
        <input type="hidden" name="id" value="${product?.id || ''}">
        <label class="adm-field adm-field--span2"><span class="label">Title</span><input class="field" name="title" id="p-title" required value="${escapeHtml(product?.title || '')}"></label>
        <div class="adm-modal-grid" style="margin-top:14px">
          <label class="adm-field"><span class="label">Category</span><select class="field" name="category" id="p-category">${categoryOptions(product?.category || 'General')}</select></label>
          <label class="adm-field"><span class="label">URL slug</span><input class="field font-mono text-xs" name="slug" id="p-slug" required value="${escapeHtml(product?.slug || '')}"></label>
          <label class="adm-field"><span class="label">Sale price</span><input class="field font-bold" name="price" type="number" step=".01" min="0" required value="${product?.price ?? ''}"></label>
          <label class="adm-field"><span class="label">Compare-at price (optional)</span><input class="field" name="original_price" type="number" step=".01" min="0" value="${product?.original_price ?? ''}"></label>
        </div>
        <label class="adm-field" style="margin-top:14px"><span class="label">Description</span><textarea class="field" name="description" rows="4">${escapeHtml(product?.description || '')}</textarea></label>
        <div class="adm-modal-grid" style="margin-top:14px">
          <div><span class="label">Cover image</span>
            <div class="adm-upload mt-1"><input type="file" id="p-cover-file" accept="image/*" class="text-xs"><img id="p-cover-preview" class="${product?.cover_url ? '' : 'hidden'}" src="${escapeHtml(product?.cover_url || '')}" alt=""></div>
            <input type="hidden" name="cover_url" id="p-cover-url" value="${escapeHtml(product?.cover_url || '')}"><small id="p-cover-status" class="help"></small>
          </div>
          <div><span class="label">Downloadable file</span>
            <div class="adm-upload mt-1"><input type="file" id="p-file" class="text-xs"></div>
            <input type="hidden" name="file_path" id="p-file-path" value="${escapeHtml(product?.file_path || '')}"><small id="p-file-status" class="help">${product?.file_path ? `Current: ${escapeHtml(product.file_path)}` : ''}</small>
          </div>
        </div>
        <label class="adm-check-line" style="margin-top:14px"><input type="checkbox" name="is_published" ${!product || product.is_published ? 'checked' : ''}> Publish to catalog</label>
        <p id="product-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="product-form" class="button button-primary">Save product</button>`,
  });
  dialog.classList.add('uk-modal--wide');
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());

  dialog.querySelector('#p-title').addEventListener('input', (e) => {
    const slugField = dialog.querySelector('#p-slug');
    if (!dialog.querySelector('#product-form').dataset.slugEdited) slugField.value = slugify(e.target.value);
  });
  dialog.querySelector('#p-slug').addEventListener('input', () => { dialog.querySelector('#product-form').dataset.slugEdited = 'true'; });

  dialog.querySelector('#p-cover-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = await uploadTo('product-images', 'covers', file, dialog.querySelector('#p-cover-status'));
    if (!path) return;
    const { data } = supabase.storage.from('product-images').getPublicUrl(path);
    dialog.querySelector('#p-cover-url').value = data.publicUrl;
    const prev = dialog.querySelector('#p-cover-preview');
    prev.src = data.publicUrl; prev.classList.remove('hidden');
  });
  dialog.querySelector('#p-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = await uploadTo('books', 'files', file, dialog.querySelector('#p-file-status'));
    if (path) dialog.querySelector('#p-file-path').value = path;
  });

  dialog.querySelector('#product-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="product-form"]');
    const feedback = dialog.querySelector('#product-feedback');
    const id = form.elements.id.value;
    const filePath = dialog.querySelector('#p-file-path').value;
    if (!filePath) { feedback.textContent = 'Upload the file buyers will download.'; feedback.className = 'status-line error text-xs my-0'; return; }
    const payload = {
      title: form.elements.title.value.trim(),
      slug: slugify(form.elements.slug.value) || slugify(form.elements.title.value),
      category: dialog.querySelector('#p-category').value,
      price: Number(form.elements.price.value),
      original_price: form.elements.original_price.value ? Number(form.elements.original_price.value) : null,
      description: form.elements.description.value.trim() || null,
      cover_url: dialog.querySelector('#p-cover-url').value || null,
      file_path: filePath,
      is_published: form.elements.is_published.checked,
      currency: 'USD',
    };
    setBusy(button, true, 'Saving…');
    const { error } = id ? await supabase.from('products').update(payload).eq('id', id) : await supabase.from('products').insert(payload);
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast(id ? 'Product updated.' : 'Product created.');
    supabase.functions.invoke('sitemap').catch(() => {});
    await loadOverview(true);
  });
}

/* ==========================================================================
   Categories (A05)
   ========================================================================== */

let categoriesState = { categories: [], products: [] };

function renderCategories(categories, products) {
  categoriesState = { categories, products };
  const host = document.querySelector('#categories-table');
  if (!host) return;
  renderDataTable(host, {
    columns: [
      { key: 'name', label: 'Category', render: (c) => `<strong style="display:block;color:var(--text)">${escapeHtml(c.name)}</strong><span style="font-size:.72rem;color:var(--text-muted)">${escapeHtml(c.description || 'No description')}</span>` },
      { key: 'slug', label: 'Storefront URL', render: (c) => `<span style="font-family:var(--font-mono);font-size:.72rem;color:var(--text-muted)">/${escapeHtml(c.slug)}</span>` },
      { key: 'products', label: 'Products', render: (c) => products.filter((p) => (p.category || 'General').toLowerCase() === c.name.toLowerCase()).length },
      { key: 'is_active', label: 'Visibility', render: (c) => statusBadge(c.is_active ? 'published' : 'unpublished', c.is_active ? 'Visible' : 'Hidden') },
    ],
    rows: categories, page: 1, pageSize: categories.length || 1, total: categories.length,
    rowActions: (c) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-edit-category="${c.id}">Edit</button>
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-toggle-category="${c.id}" data-active="${c.is_active}">${c.is_active ? 'Hide' : 'Show'}</button>`,
    emptyMessage: 'No categories yet.',
  });
  host.querySelectorAll('[data-edit-category]').forEach((btn) => btn.addEventListener('click', () => openCategoryModal(categories.find((c) => c.id === btn.dataset.editCategory))));
  host.querySelectorAll('[data-toggle-category]').forEach((btn) => btn.addEventListener('click', async () => {
    const { error } = await supabase.from('categories').update({ is_active: btn.dataset.active !== 'true' }).eq('id', btn.dataset.toggleCategory);
    if (error) toast(error.message, 'error'); else { toast('Category visibility updated.'); await loadOverview(true); }
  }));
}

document.querySelector('#new-category')?.addEventListener('click', () => openCategoryModal(null));

function openCategoryModal(category = null) {
  const { dialog } = openModal({
    id: 'category-modal',
    title: category ? 'Edit category' : 'New category',
    body: `
      <form id="category-form">
        <label class="adm-field"><span class="label">Name</span><input class="field" id="c-name" name="name" required value="${escapeHtml(category?.name || '')}"></label>
        <label class="adm-field" style="margin-top:14px"><span class="label">Storefront slug</span><input class="field font-mono text-xs" id="c-slug" name="slug" required value="${escapeHtml(category?.slug || '')}"></label>
        <label class="adm-field" style="margin-top:14px"><span class="label">Description</span><textarea class="field" name="description" rows="3">${escapeHtml(category?.description || '')}</textarea></label>
        <div class="adm-modal-grid" style="margin-top:14px">
          <label class="adm-field"><span class="label">Display order</span><input class="field" name="sort_order" type="number" min="0" value="${category?.sort_order ?? 0}"></label>
          <label class="adm-check-line" style="align-items:center"><input type="checkbox" name="is_active" ${category?.is_active !== false ? 'checked' : ''}> Show in storefront</label>
        </div>
        <p id="category-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="category-form" class="button button-primary">Save category</button>`,
  });
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#c-name').addEventListener('input', (e) => { if (!dialog.querySelector('#category-form').dataset.slugEdited) dialog.querySelector('#c-slug').value = slugify(e.target.value); });
  dialog.querySelector('#c-slug').addEventListener('input', () => { dialog.querySelector('#category-form').dataset.slugEdited = 'true'; });
  dialog.querySelector('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="category-form"]');
    const feedback = dialog.querySelector('#category-feedback');
    const payload = {
      name: form.elements.name.value.trim(),
      slug: slugify(form.elements.slug.value) || slugify(form.elements.name.value),
      description: form.elements.description.value.trim() || null,
      sort_order: Number(form.elements.sort_order.value || 0),
      is_active: form.elements.is_active.checked,
    };
    if (!payload.slug) { feedback.textContent = 'Enter a category name or slug.'; feedback.className = 'status-line error text-xs my-0'; return; }
    setBusy(button, true, 'Saving…');
    const { error } = category ? await supabase.from('categories').update(payload).eq('id', category.id) : await supabase.from('categories').insert(payload);
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast(category ? 'Category updated.' : 'Category created.');
    await loadOverview(true);
  });
}

/* ==========================================================================
   Promotions (A06)
   ========================================================================== */

function renderPromos(promos) {
  const host = document.querySelector('#promos-table');
  if (!host) return;
  renderDataTable(host, {
    columns: [
      { key: 'code', label: 'Promo code', render: (p) => `<strong style="font-family:var(--font-mono)">${escapeHtml(p.code)}</strong>` },
      { key: 'discount_value', label: 'Discount', render: (p) => p.discount_type === 'percent' ? `${p.discount_value}%` : money(p.discount_value) },
      { key: 'redemption_count', label: 'Redemptions', render: (p) => `${p.redemption_count}${p.max_redemptions ? ` / ${p.max_redemptions}` : ''}` },
      { key: 'is_active', label: 'Status', render: (p) => statusBadge(p.is_active ? 'active' : 'paused', p.is_active ? 'Active' : 'Paused') },
    ],
    rows: promos, page: 1, pageSize: promos.length || 1, total: promos.length,
    rowActions: (p) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-toggle-promo="${p.id}" data-active="${p.is_active}">${p.is_active ? 'Pause' : 'Activate'}</button>
      <button class="button !min-h-8 !px-3 text-xs button-danger" type="button" data-delete-promo="${p.id}">Delete</button>`,
    emptyMessage: 'No promotion codes yet.',
  });
  host.querySelectorAll('[data-toggle-promo]').forEach((btn) => btn.addEventListener('click', async () => {
    const current = btn.dataset.active === 'true';
    const { error } = await supabase.from('promo_codes').update({ is_active: !current }).eq('id', btn.dataset.togglePromo);
    if (error) toast(error.message, 'error'); else { toast(`Promo ${current ? 'paused' : 'activated'}.`); await loadOverview(true); }
  }));
  host.querySelectorAll('[data-delete-promo]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this promo code?', body: 'Customers will no longer be able to redeem it.', confirmLabel: 'Delete code' });
    if (!ok) return;
    const { error } = await supabase.from('promo_codes').delete().eq('id', btn.dataset.deletePromo);
    if (error) toast(error.message, 'error'); else { toast('Promo code deleted.'); await loadOverview(true); }
  }));
}

document.querySelector('#new-promo')?.addEventListener('click', () => {
  const { dialog } = openModal({
    id: 'promo-modal', title: 'New promotion code',
    body: `
      <form id="promo-form">
        <label class="adm-field"><span class="label">Code</span><input class="field font-mono uppercase font-bold" name="code" required placeholder="e.g. SAVE20"></label>
        <div class="adm-modal-grid" style="margin-top:14px">
          <label class="adm-field"><span class="label">Discount type</span><select class="field" name="discount_type"><option value="percent">Percentage (%)</option><option value="fixed">Fixed amount ($)</option></select></label>
          <label class="adm-field"><span class="label">Value</span><input class="field" name="discount_value" type="number" step=".01" min="0.01" required></label>
        </div>
        <label class="adm-field" style="margin-top:14px"><span class="label">Max redemptions (optional)</span><input class="field" name="max_redemptions" type="number" min="1" placeholder="Unlimited if empty"></label>
        <p id="promo-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="promo-form" class="button button-primary">Create code</button>`,
  });
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#promo-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = dialog.querySelector('button[form="promo-form"]');
    const feedback = dialog.querySelector('#promo-feedback');
    const payload = {
      code: form.elements.code.value.toUpperCase().trim(),
      discount_type: form.elements.discount_type.value,
      discount_value: Number(form.elements.discount_value.value),
      max_redemptions: form.elements.max_redemptions.value ? parseInt(form.elements.max_redemptions.value, 10) : null,
    };
    setBusy(button, true, 'Saving…');
    const { error } = await supabase.from('promo_codes').insert(payload);
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast('Promotion code created.');
    await loadOverview(true);
  });
});

/* ==========================================================================
   Stores — approved/suspended vendor management (separate from the pending-
   application Moderation Queue, which keeps owning pending/rejected).
   ========================================================================== */

let storesState = { page: 1, pageSize: 10, vendors: [] };

function paintStores() {
  const host = document.querySelector('#stores-table');
  if (!host) return;
  const start = (storesState.page - 1) * storesState.pageSize;
  const rows = storesState.vendors;
  const pageRows = rows.slice(start, start + storesState.pageSize);
  const ownerAdminMap = new Map(governanceProfiles.map((p) => [p.id, p.role]));

  renderDataTable(host, {
    columns: [
      { key: 'display_name', label: 'Store', render: (v) => `<strong style="display:block;color:var(--text)">${escapeHtml(v.display_name)}</strong>` },
      { key: 'status', label: 'Status', render: (v) => statusBadge(v.status) },
      { key: 'applied_at', label: 'Applied', render: (v) => shortDate(v.applied_at) },
      { key: 'approved_at', label: 'Approved', render: (v) => shortDate(v.approved_at) },
    ],
    rows: pageRows, page: storesState.page, pageSize: storesState.pageSize, total: rows.length,
    onPage: (p) => { storesState.page = p; paintStores(); },
    rowActions: (v) => {
      if (v.status === 'pending' || v.status === 'rejected') return `<span style="font-size:.72rem;color:var(--text-soft)">See Moderation queue</span>`;
      const ownerIsAdmin = ownerAdminMap.get(v.user_id) === 'admin';
      if (!hasPerm('manage_users') || (ownerIsAdmin && !hasPerm('manage_admins'))) return '';
      return v.status === 'approved'
        ? `<button class="button button-danger !min-h-8 !px-3 text-xs" type="button" data-suspend-store="${v.id}">Suspend</button>`
        : `<button class="button button-primary !min-h-8 !px-3 text-xs" type="button" data-reinstate-store="${v.id}">Reinstate</button>`;
    },
    emptyMessage: 'No stores yet.',
  });

  host.querySelectorAll('[data-suspend-store],[data-reinstate-store]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.suspendStore || btn.dataset.reinstateStore;
    const targetStatus = btn.dataset.suspendStore ? 'suspended' : 'approved';
    const vendor = storesState.vendors.find((v) => v.id === id);
    openStoreStatusModal(vendor, targetStatus);
  }));
}

function openStoreStatusModal(vendor, targetStatus) {
  const suspending = targetStatus === 'suspended';
  const { dialog } = openModal({
    id: 'store-status-modal',
    title: `${suspending ? 'Suspend' : 'Reinstate'} ${vendor.display_name}?`,
    danger: suspending,
    body: `
      <form id="store-status-form">
        <p style="font-size:.84rem;color:var(--text-muted)">${suspending
          ? 'Their products are unpublished and active ad campaigns are paused immediately. The owner keeps their personal account.'
          : 'The store becomes visible and sellable again immediately.'}</p>
        <label class="adm-field" style="margin-top:14px"><span class="label">Reason ${suspending ? '(recorded, shown to the seller)' : '(optional)'}</span><textarea class="field" name="reason" rows="3"></textarea></label>
        <p id="store-status-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="store-status-form" class="button ${suspending ? 'button-danger' : 'button-primary'}">${suspending ? 'Suspend store' : 'Reinstate store'}</button>`,
  });
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#store-status-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = dialog.querySelector('button[form="store-status-form"]');
    const feedback = dialog.querySelector('#store-status-feedback');
    const reason = event.currentTarget.elements.reason.value.trim() || null;
    setBusy(button, true, 'Saving…');
    const { error } = await supabase.rpc('admin_set_vendor_status', { p_vendor_id: vendor.id, p_status: targetStatus, p_reason: reason });
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast(`Store ${suspending ? 'suspended' : 'reinstated'}.`);
    await loadOverview(true);
  });
}

/* ==========================================================================
   Admins & tiers — super_admin-gated management screen.
   ========================================================================== */

function paintAdmins() {
  const gate = document.querySelector('#admins-gate');
  const content = document.querySelector('#admins-content');
  if (!gate || !content) return;

  if (!hasPerm('manage_admins')) {
    gate.innerHTML = emptyState({
      icon: 'lock', title: 'Super_admin access required',
      body: `Your tier (${myTier() || 'none'}) can view admin screens but cannot manage other admins. Ask a super_admin to change tiers or revoke access.`,
    });
    gate.classList.remove('hidden');
    content.classList.add('hidden');
    renderIcons();
    return;
  }
  gate.innerHTML = '';
  gate.classList.add('hidden');
  content.classList.remove('hidden');

  const admins = governanceProfiles.filter((p) => p.role === 'admin');
  const host = document.querySelector('#admins-table');
  renderDataTable(host, {
    columns: [
      { key: 'full_name', label: 'Admin', render: (a) => `<strong style="display:block;color:var(--text)">${escapeHtml(a.full_name || 'Unnamed')}</strong>` },
      { key: 'admin_tier', label: 'Tier', render: (a) => statusBadge(a.admin_tier || 'admin') },
      { key: 'account_status', label: 'Account', render: (a) => statusBadge(a.account_status || 'active') },
      { key: 'created_at', label: 'Joined', render: (a) => shortDate(a.created_at) },
    ],
    rows: admins, page: 1, pageSize: admins.length || 1, total: admins.length,
    rowActions: (a) => `
      <button class="button !min-h-8 !px-3 text-xs" type="button" data-change-tier="${a.id}">Change tier</button>
      <button class="button button-danger !min-h-8 !px-3 text-xs" type="button" data-revoke-admin="${a.id}">Revoke</button>`,
    emptyMessage: 'No admins on record.',
  });

  host.querySelectorAll('[data-change-tier]').forEach((btn) => btn.addEventListener('click', () => {
    const admin = admins.find((a) => a.id === btn.dataset.changeTier);
    if (admin) openTierModal(admin, { promote: false });
  }));
  host.querySelectorAll('[data-revoke-admin]').forEach((btn) => btn.addEventListener('click', async () => {
    const admin = admins.find((a) => a.id === btn.dataset.revokeAdmin);
    const ok = await confirmDialog({
      title: `Revoke admin access for ${admin?.full_name || 'this user'}?`,
      body: 'They immediately drop to a regular customer account. This is refused if they are the last remaining super_admin.',
      confirmLabel: 'Revoke admin access',
    });
    if (!ok) return;
    const { error } = await supabase.rpc('admin_revoke_admin', { p_user_id: btn.dataset.revokeAdmin });
    if (error) { toast(error.message, 'error'); return; }
    toast('Admin access revoked.');
    governanceProfiles = [];
    await loadOverview(true);
    paintAdmins();
  }));
}

function openTierModal(user, { promote = false } = {}) {
  const { dialog } = openModal({
    id: 'tier-modal',
    title: promote ? `Promote ${user.full_name || user.email} to admin` : `Change tier for ${user.full_name || ''}`,
    body: `
      <form id="tier-form">
        <label class="adm-field"><span class="label">Admin tier</span>
          <select class="field" name="tier">
            <option value="support">Support — notifications only</option>
            <option value="moderator">Moderator — moderation + notifications</option>
            <option value="admin">Admin — users, moderation, notifications, settings</option>
            <option value="super_admin" ${user.admin_tier === 'super_admin' ? 'selected' : ''}>Super admin — everything, incl. managing other admins</option>
          </select>
        </label>
        <p id="tier-feedback" class="status-line text-xs my-0" style="margin-top:10px"></p>
      </form>`,
    footer: `<button type="button" class="button" data-uk-cancel>Cancel</button><button type="submit" form="tier-form" class="button button-primary">${promote ? 'Promote' : 'Save tier'}</button>`,
  });
  if (user.admin_tier) dialog.querySelector('select[name="tier"]').value = user.admin_tier;
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('#tier-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = dialog.querySelector('button[form="tier-form"]');
    const feedback = dialog.querySelector('#tier-feedback');
    const tier = event.currentTarget.elements.tier.value;
    setBusy(button, true, 'Saving…');
    const { error } = await supabase.rpc('admin_update_admin_tier', { p_user_id: user.id, p_tier: tier });
    setBusy(button, false);
    if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
    dialog.close();
    toast(promote ? 'User promoted to admin.' : 'Admin tier updated.');
    governanceProfiles = [];
    await loadOverview(true);
    paintAdmins();
  });
}

/* ==========================================================================
   Notifications — compose + send, history below.
   ========================================================================== */

let notifHistory = [];
let notifLoaded = false;

async function loadNotifications(force = false) {
  const gate = document.querySelector('#notif-permission-gate');
  const compose = document.querySelector('#notif-compose-panel');
  const history = document.querySelector('#notif-history-panel');
  if (!gate) return;

  if (!hasPerm('send_notifications')) {
    gate.innerHTML = emptyState({ icon: 'lock', title: 'Permission required', body: 'Your admin tier cannot send notifications.' });
    gate.classList.remove('hidden');
    compose.classList.add('hidden');
    history.classList.add('hidden');
    renderIcons();
    return;
  }
  gate.innerHTML = '';
  gate.classList.add('hidden');
  compose.classList.remove('hidden');
  history.classList.remove('hidden');

  if (notifLoaded && !force) { paintNotifHistory(); return; }
  const { data, error } = await supabase.from('notifications')
    .select('id,title,body,audience,target_user_id,created_by,created_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) {
    document.querySelector('#notif-history-table').innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load history', body: error.message });
    return;
  }
  notifLoaded = true;
  notifHistory = data || [];
  paintNotifHistory();
}

function paintNotifHistory() {
  const host = document.querySelector('#notif-history-table');
  if (!host) return;
  const nameFor = (id) => governanceProfiles.find((p) => p.id === id)?.full_name || (id ? id.slice(0, 8) : 'system');
  renderDataTable(host, {
    columns: [
      { key: 'title', label: 'Title', render: (n) => `<strong style="display:block;color:var(--text)">${escapeHtml(n.title)}</strong><span style="font-size:.7rem;color:var(--text-soft)">${escapeHtml((n.body || '').slice(0, 80))}${(n.body || '').length > 80 ? '…' : ''}</span>` },
      { key: 'audience', label: 'Audience', render: (n) => statusBadge('neutral', n.audience === 'specific_user' ? 'Specific user' : n.audience[0].toUpperCase() + n.audience.slice(1)) },
      { key: 'created_by', label: 'Sent by', render: (n) => escapeHtml(nameFor(n.created_by)) },
      { key: 'created_at', label: 'Sent', render: (n) => dateTime(n.created_at) },
    ],
    rows: notifHistory, page: 1, pageSize: notifHistory.length || 1, total: notifHistory.length,
    emptyMessage: 'No notifications sent yet.',
  });
}

document.querySelector('#notif-audience')?.addEventListener('change', (event) => {
  document.querySelector('#notif-target-wrap').style.display = event.target.value === 'specific_user' ? '' : 'none';
});

document.querySelector('#notif-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector('#notif-feedback');
  const audience = form.elements.audience.value;
  let targetUserId = null;
  if (audience === 'specific_user') {
    const email = form.elements.target_email.value.trim().toLowerCase();
    const match = customersState.users.find((u) => (u.email || '').toLowerCase() === email);
    if (!match) { feedback.textContent = 'No user found with that email among loaded customers.'; feedback.className = 'status-line error text-xs my-0'; return; }
    targetUserId = match.id;
  }
  setBusy(button, true, 'Sending…');
  const { error } = await supabase.rpc('admin_send_notification', {
    p_title: form.elements.title.value.trim(), p_body: form.elements.body.value.trim(),
    p_audience: audience, p_target_user_id: targetUserId,
  });
  setBusy(button, false);
  if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
  feedback.textContent = '';
  form.reset();
  document.querySelector('#notif-target-wrap').style.display = 'none';
  toast('Notification sent.');
  await loadNotifications(true);
});

/* ==========================================================================
   Tickets (A09)
   ========================================================================== */

let ticketsState = { tickets: [] };

function renderTickets(tickets) {
  ticketsState.tickets = tickets;
  paintTickets();
}

function paintTickets() {
  const host = document.querySelector('#tickets-table');
  if (!host) return;
  const filterVal = document.querySelector('#ticket-status-filter')?.value || '';
  const rows = filterVal ? ticketsState.tickets.filter((t) => t.status === filterVal) : ticketsState.tickets;
  renderDataTable(host, {
    columns: [
      { key: 'name', label: 'Sender', render: (t) => `<strong style="display:block">${escapeHtml(t.name || 'User')}</strong><span style="font-size:.7rem;color:var(--text-soft)">${escapeHtml(t.email)}</span>` },
      { key: 'subject', label: 'Subject', render: (t) => `<span style="display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.subject)}</span>` },
      { key: 'status', label: 'Status', render: (t) => statusBadge(t.status) },
      { key: 'created_at', label: 'Date', render: (t) => shortDate(t.created_at) },
    ],
    rows, page: 1, pageSize: rows.length || 1, total: rows.length,
    rowActions: (t) => `<button class="button !min-h-8 !px-3 text-xs" type="button" data-open-ticket="${t.id}">Open</button>`,
    emptyMessage: 'No tickets in this filter.',
  });
  host.querySelectorAll('[data-open-ticket]').forEach((btn) => btn.addEventListener('click', () => {
    const ticket = ticketsState.tickets.find((t) => t.id === btn.dataset.openTicket);
    if (ticket) openTicketModal(ticket);
  }));
}

document.querySelector('#ticket-status-filter')?.addEventListener('change', paintTickets);

function openTicketModal(ticket) {
  const { dialog } = openModal({
    id: 'ticket-modal',
    title: ticket.subject,
    body: `
      <div style="font-size:.78rem;color:var(--text-muted);display:flex;flex-direction:column;gap:2px">
        <span>${escapeHtml(ticket.name || 'User')} &lt;${escapeHtml(ticket.email)}&gt;</span>
        <span>${escapeHtml(ticket.category || 'Other')} · ${dateTime(ticket.created_at)} ${ticket.order_ref ? `· Order ${escapeHtml(ticket.order_ref)}` : ''}</span>
      </div>
      <p style="margin-top:12px;padding:12px 14px;border-radius:var(--radius-md);background:var(--surface-sunken);border:1px solid var(--border);font-size:.84rem;line-height:1.6;white-space:pre-wrap">${escapeHtml(ticket.message || '')}</p>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Close</button>
      ${ticket.status !== 'pending' ? `<button type="button" class="button" data-status="pending">Mark pending</button>` : ''}
      ${ticket.status !== 'closed' ? `<button type="button" class="button button-primary" data-status="closed">Resolve</button>` : `<button type="button" class="button button-primary" data-status="open">Reopen</button>`}`,
  });
  dialog.classList.add('uk-modal--wide');
  dialog.querySelector('[data-uk-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelectorAll('[data-status]').forEach((btn) => btn.addEventListener('click', async () => {
    setBusy(btn, true, 'Updating…');
    const { error } = await supabase.from('tickets').update({ status: btn.dataset.status }).eq('id', ticket.id);
    setBusy(btn, false);
    if (error) { toast(error.message, 'error'); return; }
    toast('Ticket updated.');
    dialog.close();
    await loadOverview(true);
  }));
}

/* ==========================================================================
   Moderation queue (A08) — vendors / campaigns / topups / payouts tabs
   ========================================================================== */

const modEmpty = (message) => emptyState({ icon: 'inbox', title: 'Nothing to review', body: message });

async function loadModeration() {
  const { data, error } = await supabase.rpc('moderation_queue');
  if (error) {
    ['mod-vendors', 'mod-campaigns', 'mod-topups', 'mod-payouts'].forEach((id) => {
      document.querySelector(`#${id}`).innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load queue', body: error.message });
    });
    return;
  }

  const counts = {
    vendors: data.vendors?.length || 0, campaigns: data.campaigns?.length || 0,
    topups: data.topups?.length || 0, payouts: data.payouts?.length || 0,
  };
  const pendingTotal = counts.vendors + counts.campaigns + counts.topups + counts.payouts;
  const badge = document.querySelector('#mod-badge');
  if (badge) { badge.textContent = pendingTotal; badge.classList.toggle('hidden', pendingTotal === 0); }
  Object.entries(counts).forEach(([key, n]) => {
    const el = document.querySelector(`#mod-count-${key}`);
    if (el) el.textContent = n || '';
  });

  document.querySelector('#mod-vendors').innerHTML = data.vendors?.length
    ? data.vendors.map((v) => `
        <div class="adm-mod-row">
          <div class="adm-mod-row__meta">
            <strong>${escapeHtml(v.display_name)}</strong>
            <span>${escapeHtml(v.country)} · ${escapeHtml(v.payout_currency)} · applied ${shortDate(v.applied_at)} · ${v.commission_rate}% commission</span>
            ${v.bio ? `<p class="adm-mod-row__note">${escapeHtml(v.bio)}</p>` : ''}
          </div>
          <div class="adm-mod-row__actions">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-vendor="${v.id}">Approve</button>
            <button class="button button-danger !min-h-8 !px-3 text-xs" data-reject-vendor="${v.id}">Reject</button>
          </div>
        </div>`).join('')
    : modEmpty('No seller applications waiting.');

  document.querySelector('#mod-campaigns').innerHTML = data.campaigns?.length
    ? data.campaigns.map((c) => `
        <div class="adm-mod-row">
          <div class="adm-mod-row__meta">
            <strong>${escapeHtml(c.name)}</strong>
            <span>${escapeHtml(c.vendor_name)} · ${escapeHtml(c.product_title || 'product removed')} · ${escapeHtml(c.placement)} · budget ${money(c.budget, c.currency)}</span>
            <p class="adm-mod-row__note">${money(c.cpm_rate, c.currency)}/1k views · ${money(c.cpc_rate, c.currency)}/click · ${c.cpa_percent}%/sale · wallet ${money(c.wallet_balance || 0, c.currency)}
            ${Number(c.wallet_balance || 0) <= 0 ? ' — ' + statusBadge('pending', 'Wallet empty') : ''}</p>
          </div>
          <div class="adm-mod-row__actions">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-campaign="${c.id}">Approve</button>
            <button class="button button-danger !min-h-8 !px-3 text-xs" data-reject-campaign="${c.id}">Reject</button>
          </div>
        </div>`).join('')
    : modEmpty('No campaigns waiting for review.');

  document.querySelector('#mod-topups').innerHTML = data.topups?.length
    ? data.topups.map((t) => `
        <div class="adm-mod-row">
          <div class="adm-mod-row__meta"><strong>${money(t.amount, t.currency)}</strong><span>${escapeHtml(t.vendor_name)} · ${shortDate(t.created_at)}${t.note ? ` · Ref: ${escapeHtml(t.note)}` : ''}</span></div>
          <div class="adm-mod-row__actions">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-approve-topup="${t.id}">Credit</button>
            <button class="button button-danger !min-h-8 !px-3 text-xs" data-reject-topup="${t.id}">Reject</button>
          </div>
        </div>`).join('')
    : modEmpty('No top-ups waiting.');

  document.querySelector('#mod-payouts').innerHTML = data.payouts?.length
    ? data.payouts.map((p) => {
        const dest = p.method === 'mobile_money' ? `${p.momo_provider || 'MoMo'} ····${p.account_last4 || ''}` : p.method === 'bank_transfer' ? `${p.bank_name || 'Bank'} ····${p.account_last4 || ''}` : (p.method || 'account');
        return `
        <div class="adm-mod-row">
          <div class="adm-mod-row__meta"><strong>${money(p.amount, p.currency)}</strong><span>${escapeHtml(p.vendor_name)} → ${escapeHtml(dest)} · ${escapeHtml(p.account_name || '')} · requested ${shortDate(p.requested_at)}</span></div>
          <div class="adm-mod-row__actions">
            <button class="button button-primary !min-h-8 !px-3 text-xs" data-pay-payout="${p.id}">Mark paid</button>
            <button class="button button-danger !min-h-8 !px-3 text-xs" data-fail-payout="${p.id}">Fail</button>
          </div>
        </div>`;
      }).join('')
    : modEmpty('No payout requests waiting.');

  renderIcons();
}

document.addEventListener('click', async (event) => {
  const el = event.target.closest(
    '[data-approve-vendor],[data-reject-vendor],[data-approve-campaign],[data-reject-campaign],' +
    '[data-approve-topup],[data-reject-topup],[data-pay-payout],[data-fail-payout]'
  );
  if (!el) return;
  const d = el.dataset;
  let result;

  if (d.approveVendor) {
    result = await supabase.rpc('moderate_vendor', { p_vendor_id: d.approveVendor, p_status: 'approved' });
  } else if (d.rejectVendor) {
    const reason = window.prompt('Why is this application being rejected? (shown to the applicant)');
    if (reason === null) return;
    result = await supabase.rpc('moderate_vendor', { p_vendor_id: d.rejectVendor, p_status: 'rejected', p_reason: reason });
  } else if (d.approveCampaign) {
    result = await supabase.rpc('moderate_campaign', { p_campaign_id: d.approveCampaign, p_approve: true });
  } else if (d.rejectCampaign) {
    const note = window.prompt('Why is this campaign being rejected? (shown to the seller)');
    if (note === null) return;
    result = await supabase.rpc('moderate_campaign', { p_campaign_id: d.rejectCampaign, p_approve: false, p_note: note });
  } else if (d.approveTopup) {
    const reference = window.prompt('Payment reference for this top-up (optional):') ?? null;
    result = await supabase.rpc('settle_ad_topup', { p_request_id: d.approveTopup, p_approve: true, p_reference: reference });
  } else if (d.rejectTopup) {
    result = await supabase.rpc('settle_ad_topup', { p_request_id: d.rejectTopup, p_approve: false });
  } else if (d.payPayout) {
    const reference = window.prompt('Transfer reference (optional):') ?? null;
    result = await supabase.from('payouts').update({ status: 'paid', processed_at: new Date().toISOString(), reference }).eq('id', d.payPayout);
    if (!result.error) await supabase.from('vendor_earnings').update({ status: 'paid' }).eq('payout_id', d.payPayout);
  } else if (d.failPayout) {
    const reason = window.prompt('Why did this payout fail?');
    if (reason === null) return;
    result = await supabase.from('payouts').update({ status: 'failed', failure_reason: reason, processed_at: new Date().toISOString() }).eq('id', d.failPayout);
    if (!result.error) await supabase.from('vendor_earnings').update({ payout_id: null }).eq('payout_id', d.failPayout);
  }

  if (result?.error) { toast(result.error.message, 'error'); return; }
  toast('Done.');
  await loadModeration();
});

document.querySelector('#refresh-moderation')?.addEventListener('click', loadModeration);
initTabs(document.querySelector('#mod-tabs-root'));

/* ==========================================================================
   A07 — CMS / Content editor (the deep screen)
   ========================================================================== */

const CMS_TYPE_FIELDS = {
  page: [
    { key: 'heading', label: 'Heading', type: 'text' },
    { key: 'subheading', label: 'Subheading', type: 'text' },
    { key: 'body', label: 'Body', type: 'textarea', rows: 10 },
    { key: 'seo_title', label: 'SEO title', type: 'text' },
    { key: 'seo_description', label: 'SEO description', type: 'textarea', rows: 2 },
  ],
  post: [
    { key: 'excerpt', label: 'Excerpt', type: 'textarea', rows: 2 },
    { key: 'body', label: 'Article body', type: 'textarea', rows: 12 },
    { key: 'cover_url', label: 'Cover image URL', type: 'text' },
    { key: 'tags', label: 'Tags (comma separated)', type: 'text' },
  ],
  author: [
    { key: 'name', label: 'Display name', type: 'text' },
    { key: 'role', label: 'Role / title', type: 'text' },
    { key: 'avatar_url', label: 'Avatar URL', type: 'text' },
    { key: 'bio', label: 'Bio', type: 'textarea', rows: 4 },
  ],
  faq: [
    { key: 'question', label: 'Question', type: 'text' },
    { key: 'answer', label: 'Answer', type: 'textarea', rows: 4 },
    { key: 'category', label: 'Category', type: 'text' },
  ],
  announcement: [
    { key: 'message', label: 'Message', type: 'textarea', rows: 2 },
    { key: 'cta_label', label: 'CTA label', type: 'text' },
    { key: 'cta_href', label: 'CTA link', type: 'text' },
  ],
  legal: [
    { key: 'effective_date', label: 'Effective date', type: 'text' },
    { key: 'body', label: 'Document body', type: 'textarea', rows: 16 },
  ],
  navigation: [
    { key: 'label', label: 'Label', type: 'text' },
    { key: 'href', label: 'Link', type: 'text' },
    { key: 'group', label: 'Group', type: 'text' },
  ],
  homepage: [
    { key: 'section_key', label: 'Section key', type: 'text' },
    { key: 'heading', label: 'Heading', type: 'text' },
    { key: 'body', label: 'Body', type: 'textarea', rows: 4 },
    { key: 'cta_label', label: 'CTA label', type: 'text' },
    { key: 'cta_href', label: 'CTA link', type: 'text' },
  ],
};

let cmsDocs = [];
let cmsSelectedId = null;
let cmsHeldLock = false;
let cmsLockTimer = null;
let cmsLoaded = false;

async function loadCms(force = false) {
  if (cmsLoaded && !force) return;
  const { data, error } = await supabase.from('cms_documents')
    .select('id,type,slug,title,status,version,updated_at,published_at')
    .order('updated_at', { ascending: false })
    .limit(300);
  if (error) {
    document.querySelector('#cms-doc-list').innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load content', body: error.message });
    return;
  }
  cmsLoaded = true;
  cmsDocs = data || [];
  paintCmsList();
  if (!cmsSelectedId && cmsDocs.length) selectCmsDoc(cmsDocs[0].id);
  else if (!cmsDocs.length) paintCmsEmptyEditor();
}

function paintCmsEmptyEditor() {
  document.querySelector('#cms-editor').classList.add('hidden');
  document.querySelector('#cms-editor-empty').innerHTML = emptyState({
    icon: 'file-text', title: 'No document selected', body: 'Choose a document on the left, or create a new one.',
  });
}

function paintCmsList() {
  const host = document.querySelector('#cms-doc-list');
  if (!host) return;
  const search = (document.querySelector('#cms-search')?.value || '').trim().toLowerCase();
  const typeFilter = document.querySelector('#cms-type-filter')?.value || '';
  const rows = cmsDocs.filter((d) => {
    if (typeFilter && d.type !== typeFilter) return false;
    if (!search) return true;
    return (d.title || '').toLowerCase().includes(search) || (d.slug || '').toLowerCase().includes(search);
  });
  host.innerHTML = rows.length ? rows.map((d) => `
    <button type="button" class="adm-cms-doc ${d.id === cmsSelectedId ? 'is-active' : ''}" data-cms-select="${d.id}">
      <div class="adm-cms-doc__head"><strong>${escapeHtml(d.title || 'Untitled')}</strong>${statusBadge(d.status)}</div>
      <div class="adm-cms-doc__meta"><span>${escapeHtml(d.type)}</span><span>·</span><span>v${d.version}</span><span>·</span><span>${shortDate(d.updated_at)}</span></div>
    </button>`).join('') : emptyState({ icon: 'search', title: 'No documents match', body: 'Try a different search or type filter.' });
  host.querySelectorAll('[data-cms-select]').forEach((btn) => btn.addEventListener('click', () => selectCmsDoc(btn.dataset.cmsSelect)));
}

document.querySelector('#cms-search')?.addEventListener('input', paintCmsList);
document.querySelector('#cms-type-filter')?.addEventListener('change', paintCmsList);

async function releaseCmsLock() {
  if (cmsLockTimer) { clearInterval(cmsLockTimer); cmsLockTimer = null; }
  if (cmsHeldLock && cmsSelectedId) {
    try { await supabase.rpc('cms_release_lock', { p_id: cmsSelectedId }); } catch { /* best effort */ }
  }
  cmsHeldLock = false;
}

async function selectCmsDoc(id) {
  if (id === cmsSelectedId) return;
  await releaseCmsLock();
  cmsSelectedId = id;
  paintCmsList();

  const { data: fresh, error } = await supabase.from('cms_documents').select('*').eq('id', id).maybeSingle();
  if (error || !fresh) { toast(error?.message || 'Document not found.', 'error'); return; }

  let lock = null;
  try {
    const res = await supabase.rpc('cms_claim_lock', { p_id: id });
    lock = res.data || null;
  } catch { /* soft lock is best-effort; editing still works without it */ }
  cmsHeldLock = lock ? lock.held_by_me : true;
  if (cmsHeldLock) {
    cmsLockTimer = setInterval(() => {
      supabase.rpc('cms_claim_lock', { p_id: id }).then(() => {}, () => {});
    }, 90000);
  }

  renderCmsEditor(fresh, lock);
}

function cmsExtraFields(doc) {
  const schemaKeys = new Set((CMS_TYPE_FIELDS[doc.type] || []).map((f) => f.key));
  const extra = {};
  Object.entries(doc.draft || {}).forEach(([k, v]) => { if (!schemaKeys.has(k)) extra[k] = v; });
  return extra;
}

function renderCmsEditor(doc, lock) {
  document.querySelector('#cms-editor-empty').innerHTML = '';
  const editor = document.querySelector('#cms-editor');
  editor.classList.remove('hidden');
  const fields = CMS_TYPE_FIELDS[doc.type] || [];
  const draft = doc.draft || {};
  const locked = lock && !lock.held_by_me;

  editor.innerHTML = `
    <div id="cms-lock-banner" class="adm-lock-banner" ${locked ? '' : 'hidden'}>
      ${icon('lock', 14)} <span>Being edited by ${escapeHtml(lock?.holder_name || 'another admin')} — you can view but changes may conflict.</span>
    </div>
    <div class="adm-cms-editor-head">
      <div style="flex:1;min-width:220px">
        <div class="adm-modal-grid">
          <label class="adm-field"><span class="label">Title</span><input class="field" id="cms-title" value="${escapeHtml(doc.title || '')}" ${locked ? 'disabled' : ''}></label>
          <label class="adm-field"><span class="label">Slug</span><input class="field font-mono text-xs" id="cms-slug" value="${escapeHtml(doc.slug || '')}" ${locked ? 'disabled' : ''}></label>
        </div>
        <p style="margin-top:6px;font-size:.72rem;color:var(--text-soft)">${escapeHtml(doc.type)} · version ${doc.version} · updated ${shortDate(doc.updated_at)} ${doc.published_at ? `· published ${shortDate(doc.published_at)}` : ''}</p>
      </div>
      <div class="adm-cms-actions">
        <button type="button" class="button" id="cms-save-draft" ${locked ? 'disabled' : ''}>Save draft</button>
        <button type="button" class="button button-primary" id="cms-publish">Publish</button>
        ${doc.published ? `<button type="button" class="button" id="cms-unpublish">Unpublish</button>` : ''}
        <button type="button" class="button" id="cms-duplicate">Duplicate</button>
        <button type="button" class="button button-danger" id="cms-delete">Delete</button>
      </div>
    </div>

    <div class="adm-cms-tabs" role="tablist">
      <button type="button" class="adm-cms-tab-btn is-active" data-cms-tab="edit">Edit</button>
      <button type="button" class="adm-cms-tab-btn" data-cms-tab="history">Version history</button>
      <button type="button" class="adm-cms-tab-btn" data-cms-tab="media">Media library</button>
    </div>

    <div class="adm-cms-tabpanel is-active" data-cms-tabpanel="edit">
      <div id="cms-field-form">
        ${fields.map((f) => `
          <div class="adm-field-group">
            <label class="label" for="cms-f-${f.key}">${escapeHtml(f.label)}</label>
            ${f.type === 'textarea'
              ? `<textarea class="field" id="cms-f-${f.key}" rows="${f.rows || 4}" ${locked ? 'disabled' : ''}>${escapeHtml(draft[f.key] ?? '')}</textarea>`
              : `<input class="field" id="cms-f-${f.key}" value="${escapeHtml(draft[f.key] ?? '')}" ${locked ? 'disabled' : ''}>`}
          </div>`).join('')}
        <div class="adm-field-group">
          <label class="label" for="cms-extra-json">Advanced: extra fields (JSON, merged in on save)</label>
          <textarea class="field font-mono text-xs" id="cms-extra-json" rows="4" ${locked ? 'disabled' : ''}>${escapeHtml(JSON.stringify(cmsExtraFields(doc), null, 2))}</textarea>
        </div>
        ${doc.published ? `<p class="adm-panel-note" style="margin-top:4px">This document has unpublished changes: the storefront still shows the last <strong>published</strong> snapshot until you press Publish.</p>` : ''}
      </div>
    </div>

    <div class="adm-cms-tabpanel" data-cms-tabpanel="history">
      <div id="cms-history-list">Loading…</div>
    </div>

    <div class="adm-cms-tabpanel" data-cms-tabpanel="media">
      <div class="adm-filter-row"><label class="adm-media-upload" style="width:auto;height:auto;padding:8px 14px;display:inline-flex">${icon('upload', 14)} <span>Upload to library</span><input type="file" id="cms-media-upload-input" accept="image/*" class="hidden"></label></div>
      <div id="cms-media-grid" class="adm-media-grid mt-4">Loading…</div>
    </div>`;

  editor.querySelectorAll('.adm-cms-tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    editor.querySelectorAll('.adm-cms-tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    editor.querySelectorAll('.adm-cms-tabpanel').forEach((p) => p.classList.toggle('is-active', p.dataset.cmsTabpanel === btn.dataset.cmsTab));
    if (btn.dataset.cmsTab === 'history') loadCmsHistory(doc.id);
    if (btn.dataset.cmsTab === 'media') loadCmsMedia();
  }));

  editor.querySelector('#cms-save-draft')?.addEventListener('click', () => saveCmsDraft(doc));
  editor.querySelector('#cms-publish')?.addEventListener('click', () => publishCms(doc));
  editor.querySelector('#cms-unpublish')?.addEventListener('click', () => unpublishCms(doc));
  editor.querySelector('#cms-duplicate')?.addEventListener('click', () => duplicateCms(doc));
  editor.querySelector('#cms-delete')?.addEventListener('click', () => deleteCms(doc));
  editor.querySelector('#cms-media-upload-input')?.addEventListener('change', (e) => uploadCmsMedia(e.target.files?.[0]));

  renderIcons();
}

function collectCmsDraft(doc) {
  const fields = CMS_TYPE_FIELDS[doc.type] || [];
  const draft = {};
  fields.forEach((f) => { draft[f.key] = document.querySelector(`#cms-f-${f.key}`)?.value ?? ''; });
  const extraRaw = document.querySelector('#cms-extra-json')?.value || '{}';
  try {
    Object.assign(draft, JSON.parse(extraRaw || '{}'));
  } catch {
    toast('Extra fields JSON is invalid — it was ignored.', 'error');
  }
  return draft;
}

async function saveCmsDraft(doc, { silent = false } = {}) {
  const button = document.querySelector('#cms-save-draft');
  const title = document.querySelector('#cms-title')?.value.trim() || 'Untitled';
  const slug = document.querySelector('#cms-slug')?.value.trim() || null;
  const draft = collectCmsDraft(doc);
  setBusy(button, true, 'Saving…');
  const { data, error } = await supabase.rpc('cms_save', {
    p_id: doc.id || null, p_type: doc.type, p_draft: draft, p_title: title, p_slug: slug, p_expected_version: doc.id ? doc.version : null,
  });
  setBusy(button, false);
  if (error) { toast(error.message, 'error'); return null; }
  if (!silent) toast('Draft saved.');
  cmsLoaded = false;
  await loadCms(true);
  cmsSelectedId = data.id;
  paintCmsList();
  const { data: fresh } = await supabase.from('cms_documents').select('*').eq('id', data.id).maybeSingle();
  if (fresh) renderCmsEditor(fresh, { held_by_me: true });
  return data;
}

async function publishCms(doc) {
  const saved = await saveCmsDraft(doc, { silent: true });
  const target = saved || doc;
  const ok = await confirmDialog({ title: 'Publish this document?', body: 'The draft becomes visible on the live storefront immediately.', confirmLabel: 'Publish', danger: false });
  if (!ok) return;
  const { error } = await supabase.rpc('cms_publish', { p_id: target.id, p_expected_version: target.version });
  if (error) { toast(error.message, 'error'); return; }
  toast('Published.');
  cmsLoaded = false;
  await loadCms(true);
  const { data: fresh } = await supabase.from('cms_documents').select('*').eq('id', target.id).maybeSingle();
  if (fresh) renderCmsEditor(fresh, { held_by_me: true });
}

async function unpublishCms(doc) {
  const ok = await confirmDialog({ title: 'Unpublish this document?', body: 'It disappears from the live storefront. The draft is kept.', confirmLabel: 'Unpublish', danger: true });
  if (!ok) return;
  const { error } = await supabase.rpc('cms_unpublish', { p_id: doc.id });
  if (error) { toast(error.message, 'error'); return; }
  toast('Unpublished.');
  cmsLoaded = false;
  await loadCms(true);
  const { data: fresh } = await supabase.from('cms_documents').select('*').eq('id', doc.id).maybeSingle();
  if (fresh) renderCmsEditor(fresh, { held_by_me: true });
}

async function duplicateCms(doc) {
  const { data, error } = await supabase.rpc('cms_duplicate', { p_id: doc.id });
  if (error) { toast(error.message, 'error'); return; }
  toast('Document duplicated.');
  cmsLoaded = false;
  cmsSelectedId = null;
  await loadCms(true);
  await selectCmsDoc(data.id);
}

async function deleteCms(doc) {
  const ok = await confirmDialog({ title: `Delete "${doc.title}"?`, body: 'This permanently removes the document and its revision history.', confirmLabel: 'Delete document' });
  if (!ok) return;
  const { error } = await supabase.rpc('cms_delete', { p_id: doc.id });
  if (error) { toast(error.message, 'error'); return; }
  toast('Document deleted.');
  await releaseCmsLock();
  cmsSelectedId = null;
  cmsLoaded = false;
  await loadCms(true);
  if (!cmsDocs.length) paintCmsEmptyEditor();
}

async function loadCmsHistory(documentId) {
  const host = document.querySelector('#cms-history-list');
  if (!host) return;
  const { data, error } = await supabase.from('cms_revisions')
    .select('id,version,action,title,actor_email,created_at')
    .eq('document_id', documentId).order('created_at', { ascending: false }).limit(50);
  if (error) { host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load history', body: error.message }); return; }
  if (!data?.length) { host.innerHTML = emptyState({ icon: 'history', title: 'No revisions yet' }); return; }
  host.innerHTML = `<div class="adm-version-list">${data.map((r) => `
    <div class="adm-version-row">
      <div class="adm-version-row__meta"><strong>v${r.version} · ${escapeHtml(r.action)}</strong><span>${escapeHtml(r.actor_email || 'system')} · ${dateTime(r.created_at)}</span></div>
      <button type="button" class="button !min-h-8 !px-3 text-xs" data-restore-revision="${r.id}">Restore</button>
    </div>`).join('')}</div>`;
  host.querySelectorAll('[data-restore-revision]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Restore this revision?', body: 'The current draft is replaced with this older snapshot. This does not affect what is currently published until you publish again.', confirmLabel: 'Restore', danger: true });
    if (!ok) return;
    const { error } = await supabase.rpc('cms_restore', { p_id: documentId, p_revision_id: btn.dataset.restoreRevision });
    if (error) { toast(error.message, 'error'); return; }
    toast('Revision restored to draft.');
    cmsLoaded = false;
    await loadCms(true);
    const { data: fresh } = await supabase.from('cms_documents').select('*').eq('id', documentId).maybeSingle();
    if (fresh) renderCmsEditor(fresh, { held_by_me: true });
  }));
}

async function loadCmsMedia() {
  const host = document.querySelector('#cms-media-grid');
  if (!host) return;
  const { data, error } = await supabase.from('cms_assets').select('*').order('created_at', { ascending: false }).limit(60);
  if (error) { host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load media', body: error.message }); return; }
  if (!data?.length) { host.innerHTML = emptyState({ icon: 'image', title: 'No media uploaded yet', body: 'Upload an image to start the library.' }); return; }
  host.innerHTML = data.map((a) => `
    <div class="adm-media-card">
      <img class="adm-media-card__thumb" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.alt || a.filename)}" loading="lazy">
      <div class="adm-media-card__body">
        <strong title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</strong>
        <span>${a.width && a.height ? `${a.width}×${a.height} · ` : ''}${a.size_bytes ? `${(a.size_bytes / 1024).toFixed(0)} KB` : ''}</span>
        <div style="display:flex;gap:4px;margin-top:6px">
          <button type="button" class="button !min-h-7 !px-2 text-xs" style="flex:1" data-copy-asset="${escapeHtml(a.url)}">Copy URL</button>
          <button type="button" class="button button-danger !min-h-7 !px-2 text-xs" data-delete-asset="${a.id}">${icon('trash-2', 11)}</button>
        </div>
      </div>
    </div>`).join('');
  host.querySelectorAll('[data-copy-asset]').forEach((btn) => btn.addEventListener('click', () => { navigator.clipboard.writeText(btn.dataset.copyAsset); toast('Asset URL copied.'); }));
  host.querySelectorAll('[data-delete-asset]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete this asset?', body: 'Any content still referencing this URL will show a broken image.', confirmLabel: 'Delete asset' });
    if (!ok) return;
    const { error } = await supabase.from('cms_assets').delete().eq('id', btn.dataset.deleteAsset);
    if (error) { toast(error.message, 'error'); return; }
    toast('Asset deleted.');
    loadCmsMedia();
  }));
  renderIcons();
}

async function uploadCmsMedia(file) {
  if (!file) return;
  const path = `cms/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
  const { data: up, error } = await supabase.storage.from('product-images').upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) { toast(error.message, 'error'); return; }
  const { data: pub } = supabase.storage.from('product-images').getPublicUrl(up.path);
  const { data: assetRow, error: insertError } = await supabase.from('cms_assets').insert({
    bucket: 'product-images', path: up.path, url: pub.publicUrl, filename: file.name,
    mime_type: file.type || null, size_bytes: file.size || null, uploaded_by: account.user.id,
  }).select('id').single();
  if (insertError) { toast(insertError.message, 'error'); return; }
  toast('Uploaded to media library.');
  loadCmsMedia();
  if (file.type?.startsWith('image/') && assetRow) {
    const img = new Image();
    img.onload = () => { supabase.from('cms_assets').update({ width: img.naturalWidth, height: img.naturalHeight }).eq('id', assetRow.id).then(() => loadCmsMedia()); };
    img.src = pub.publicUrl;
  }
}

document.querySelector('#cms-new-doc')?.addEventListener('click', async () => {
  await releaseCmsLock();
  const type = document.querySelector('#cms-new-type')?.value || 'page';
  cmsSelectedId = null;
  renderCmsEditor({ id: null, type, title: '', slug: '', draft: {}, published: null, version: 0, status: 'draft', updated_at: new Date().toISOString() }, { held_by_me: true });
  cmsHeldLock = false;
  paintCmsList();
});

/* ==========================================================================
   A10 — Site settings
   ========================================================================== */

let settingsLoaded = false;

async function loadSettings(force = false) {
  if (settingsLoaded && !force) return;
  const { data } = await supabase.from('site_settings').select('*').eq('id', 1).maybeSingle();
  settingsLoaded = true;
  const form = document.querySelector('#settings-form');
  if (!form || !data) return;
  form.elements.site_title.value = data.site_title || '';
  form.elements.support_email.value = data.support_email || '';
  form.elements.default_currency.value = data.default_currency || 'USD';
  form.elements.tagline.value = data.tagline || '';
  form.elements.announcement.value = data.announcement || '';
  form.elements.announcement_active.value = String(Boolean(data.announcement_active));
  form.elements.announcement_ends_at.value = data.announcement_ends_at ? new Date(data.announcement_ends_at).toISOString().slice(0, 16) : '';
  form.elements.checkout_note.value = data.checkout_note || '';
  const social = data.social || {};
  form.elements.social_twitter.value = social.twitter || '';
  form.elements.social_instagram.value = social.instagram || '';
}

document.querySelector('#settings-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const feedback = document.querySelector('#settings-feedback');
  const payload = {
    id: 1,
    site_title: form.elements.site_title.value.trim() || null,
    support_email: form.elements.support_email.value.trim() || null,
    default_currency: (form.elements.default_currency.value.trim() || 'USD').toUpperCase(),
    tagline: form.elements.tagline.value.trim() || null,
    announcement: form.elements.announcement.value.trim() || null,
    announcement_active: form.elements.announcement_active.value === 'true',
    announcement_ends_at: form.elements.announcement_ends_at.value ? new Date(form.elements.announcement_ends_at.value).toISOString() : null,
    checkout_note: form.elements.checkout_note.value.trim() || null,
    social: { twitter: form.elements.social_twitter.value.trim() || undefined, instagram: form.elements.social_instagram.value.trim() || undefined },
    updated_by: account.user.id,
  };
  setBusy(button, true, 'Saving…');
  const { error } = await supabase.from('site_settings').upsert(payload);
  setBusy(button, false);
  if (error) { feedback.textContent = error.message; feedback.className = 'status-line error text-xs my-0'; return; }
  feedback.textContent = 'Settings saved.';
  feedback.className = 'status-line success text-xs my-0';
  toast('Site settings saved.');
});

/* ==========================================================================
   A11 — Audit log (read-only)
   ========================================================================== */

let auditRows = [];
let auditLoaded = false;
let auditPage = 1;
const AUDIT_PAGE_SIZE = 20;

async function loadAudit(force = false) {
  if (auditLoaded && !force) return;
  const host = document.querySelector('#audit-table');
  const { data, error } = await supabase.from('audit_log')
    .select('id,actor_email,action,entity_type,entity_id,summary,created_at')
    .order('created_at', { ascending: false }).limit(300);
  if (error) { host.innerHTML = emptyState({ icon: 'triangle-alert', title: 'Could not load the audit log', body: error.message }); return; }
  auditLoaded = true;
  auditRows = data || [];
  const entitySelect = document.querySelector('#audit-entity-filter');
  if (entitySelect && entitySelect.options.length <= 1) {
    const types = [...new Set(auditRows.map((r) => r.entity_type))].sort();
    entitySelect.innerHTML = `<option value="">All entities</option>${types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}`;
    refreshSelect(entitySelect);
  }
  paintAudit();
}

function paintAudit() {
  const host = document.querySelector('#audit-table');
  if (!host) return;
  const search = (document.querySelector('#audit-search')?.value || '').trim().toLowerCase();
  const entity = document.querySelector('#audit-entity-filter')?.value || '';
  const rows = auditRows.filter((r) => {
    if (entity && r.entity_type !== entity) return false;
    if (!search) return true;
    return [r.action, r.summary, r.actor_email, r.entity_id].some((v) => (v || '').toLowerCase().includes(search));
  });
  const start = (auditPage - 1) * AUDIT_PAGE_SIZE;
  const pageRows = rows.slice(start, start + AUDIT_PAGE_SIZE);
  renderDataTable(host, {
    columns: [
      { key: 'action', label: 'Action', render: (r) => `<strong style="font-family:var(--font-mono);font-size:.78rem">${escapeHtml(r.action)}</strong>` },
      { key: 'entity_type', label: 'Entity', render: (r) => `${escapeHtml(r.entity_type)}${r.entity_id ? ` <span style="color:var(--text-soft);font-size:.7rem">#${escapeHtml(String(r.entity_id).slice(0, 8))}</span>` : ''}` },
      { key: 'summary', label: 'Summary', render: (r) => `<span style="max-width:340px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.summary || '—')}</span>` },
      { key: 'actor_email', label: 'Actor', render: (r) => escapeHtml(r.actor_email || 'system') },
      { key: 'created_at', label: 'When', render: (r) => dateTime(r.created_at) },
    ],
    rows: pageRows, page: auditPage, pageSize: AUDIT_PAGE_SIZE, total: rows.length,
    onPage: (p) => { auditPage = p; paintAudit(); },
    emptyMessage: 'No matching audit entries.',
  });
}

document.querySelector('#audit-search')?.addEventListener('input', () => { auditPage = 1; paintAudit(); });
document.querySelector('#audit-entity-filter')?.addEventListener('change', () => { auditPage = 1; paintAudit(); });
document.querySelector('#refresh-audit')?.addEventListener('click', () => loadAudit(true));

SCREEN_LOADERS.moderation = loadModeration;
SCREEN_LOADERS.content = () => loadCms();
SCREEN_LOADERS.settings = () => loadSettings();
SCREEN_LOADERS.audit = () => loadAudit();
SCREEN_LOADERS.stores = () => paintStores();
SCREEN_LOADERS.admins = () => paintAdmins();
SCREEN_LOADERS.notifications = () => loadNotifications();

/* ==========================================================================
   Shared busy-button helper (bridges ui.js and uikit.js conventions)
   ========================================================================== */

function setBusy(button, busy, label) {
  setButtonBusy(button, busy, label);
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
  // Picking a section closes the drawer — otherwise it stays open over the
  // panel that just became active.
  sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function boot() {
  mountHeader();
  mountFooter();
  account = await getAccount();

  if (!account.user) {
    const nextUrl = `admin${location.search}${location.hash}`;
    location.replace(`./auth?mode=signin&next=${encodeURIComponent(nextUrl)}`);
    return;
  }
  if (account.profile?.role !== 'admin') {
    location.replace('./account');
    return;
  }

  document.querySelector('#admin-gate').classList.add('hidden');
  document.querySelector('#admin-shell').classList.remove('hidden');
  document.querySelector('#admin-user').textContent = account.user.email;
  document.querySelector('#admin-avatar').textContent = (account.profile?.full_name || account.user.email || 'A').trim().charAt(0).toUpperCase();

  wireDashSidebar();
  enhanceSelects('#admin-shell select', {
    'revenue-period': 'Revenue period',
    'customer-role-filter': 'Role',
    'cms-new-type': 'Document type',
    'cms-type-filter': 'Filter by type',
    'ticket-status-filter': 'Status',
    'audit-entity-filter': 'Entity',
    'notif-audience': 'Audience',
  });

  document.querySelectorAll('#admin-signout').forEach((btn) => btn.addEventListener('click', async () => {
    await releaseCmsLock();
    await supabase.auth.signOut();
    location.href = './';
  }));

  activateScreen();
  await loadOverview();
  loadModeration().catch(() => {});
  renderIcons();
  finishPageLoader();
}

boot().catch((error) => {
  console.error('Admin initialization error:', error);
  toast(error.message || 'The admin console could not be loaded.', 'error');
  finishPageLoader();
});
