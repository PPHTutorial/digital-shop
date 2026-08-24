/**
 * Admin console.
 *
 * Scope is deliberately narrower than the previous dashboard: catalog,
 * categories, promotions, and editorial content now live in the content
 * studio (studio.html), which gives that data real drafts, revisions, and
 * soft locks. This console covers what the studio does not — commercial
 * performance, orders, customers, and support.
 */

import { supabase, requireAdmin, unwrap, describeError } from './client.js';
import { CONFIG } from './config.js';
import { $, $$, html, raw, esc, on, debounce } from './dom.js';
import { icon } from './icons.js';
import { formatMoney, formatNumber, formatDate, formatPercent, relativeTime } from './format.js';
import { initTheme, toggleTheme, currentTheme, toast, bootDone, setBusy } from './ui.js';
import { lineChart, meterList, toDailyPoints } from './chart.js';

initTheme();

const SCREENS = ['overview', 'orders', 'customers', 'tickets', 'settings'];
const SCREEN_TITLES = {
  overview: 'Dashboard',
  orders: 'Orders',
  customers: 'Customers',
  tickets: 'Tickets',
  settings: 'Settings',
};

const ORDER_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'cancelled'];
const STATUS_BADGE = {
  paid: ['ok', 'Paid'],
  pending: ['warn', 'Awaiting payment'],
  failed: ['danger', 'Failed'],
  cancelled: ['neutral', 'Cancelled'],
  refunded: ['info', 'Refunded'],
};

const TICKET_STATUSES = ['open', 'pending', 'closed'];
const TICKET_BADGE = {
  open: ['danger', 'Open'],
  pending: ['warn', 'Pending'],
  closed: ['neutral', 'Closed'],
};

const PAGE_SIZE = 20;

const state = {
  account: null,
  screen: 'overview',
  loaded: new Set(),
  overview: { days: 30, data: null },
  orders: { status: '', search: '', page: 0, total: 0, rows: [] },
  customers: { search: '', all: [] },
  tickets: { status: '', all: [] },
};

/* ==========================================================================
   Shell — routing, theme, sign-out, mobile rail
   ========================================================================== */

function readScreen() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return SCREENS.includes(hash) ? hash : 'overview';
}

function setRail(open) {
  $('#rail').classList.toggle('is-open', open);
  $('#scrim').classList.toggle('is-open', open);
}

async function applyRoute() {
  state.screen = readScreen();

  $$('.screen').forEach((section) => section.classList.toggle('is-active', section.dataset.screen === state.screen));
  $$('.rail-link[data-screen]').forEach((link) => link.classList.toggle('is-active', link.dataset.screen === state.screen));
  $('#crumb-title').textContent = SCREEN_TITLES[state.screen];
  setRail(false);

  try {
    if (state.screen === 'overview') await loadOverview();
    else if (state.screen === 'orders') await loadOrders();
    else if (state.screen === 'customers') await loadCustomers();
    else if (state.screen === 'tickets') await loadTickets();
    else if (state.screen === 'settings') await loadSettings();
  } catch (error) {
    toast(error.message || 'Could not load this screen.', 'error');
  }
}

function deltaMarkup(curr, prev) {
  curr = Number(curr) || 0;
  prev = Number(prev) || 0;
  if (!prev) return curr ? '<span class="delta delta--up">New this period</span>' : '<span class="delta delta--flat">No orders yet</span>';
  const change = (curr - prev) / prev;
  if (Math.abs(change) < 0.01) return '<span class="delta delta--flat">Flat vs prior period</span>';
  const up = change > 0;
  return `<span class="delta delta--${up ? 'up' : 'down'}">${icon(up ? 'trendUp' : 'trendDown', 12)}${esc(formatPercent(Math.abs(change)))} vs prior period</span>`;
}

/* ==========================================================================
   Overview
   ========================================================================== */

async function loadOverview({ force = false } = {}) {
  if (state.loaded.has('overview') && !force) return paintOverview();
  state.overview.data = await unwrap(supabase.rpc('admin_overview', { p_days: state.overview.days }));
  state.loaded.add('overview');
  paintOverview();
}

function activityIcon(action = '') {
  if (action.includes('delete')) return 'trash';
  if (action.includes('publish')) return 'checkCircle';
  if (action.includes('order') || action.includes('refund')) return 'card';
  return 'doc';
}

function paintOverview() {
  const data = state.overview.data;
  if (!data) return;
  const { current, previous, lifetime, series, top_products, top_categories, payment_mix, recent_activity } = data;

  $('#overview-stats').innerHTML = html`
    <div class="metric">
      <span class="metric__label">Revenue</span>
      <span class="metric__value">${formatMoney(current.revenue, 'USD')}</span>
      <span class="metric__foot">${raw(deltaMarkup(current.revenue, previous.revenue))}</span>
    </div>
    <div class="metric">
      <span class="metric__label">Paid orders</span>
      <span class="metric__value">${formatNumber(current.orders)}</span>
      <span class="metric__foot">Average order ${formatMoney(current.aov, 'USD')}</span>
    </div>
    <div class="metric">
      <span class="metric__label">Customers</span>
      <span class="metric__value">${formatNumber(lifetime.customers)}</span>
      <span class="metric__foot">${formatNumber(lifetime.published_products)} of ${formatNumber(lifetime.products)} products live</span>
    </div>
    <div class="metric">
      <span class="metric__label">Open tickets</span>
      <span class="metric__value">${formatNumber(lifetime.open_tickets)}</span>
      <span class="metric__foot">${formatNumber(current.pending)} order${current.pending === 1 ? '' : 's'} awaiting payment</span>
    </div>
  `;

  $('#overview-chart').innerHTML = lineChart(toDailyPoints(series, 'revenue'), { format: (v) => formatMoney(v, 'USD'), accent: true });

  $('#overview-activity').innerHTML = recent_activity?.length
    ? `<div class="feed">${recent_activity
        .map(
          (item) => html`
            <div class="feed__item">
              <span class="feed__icon">${raw(icon(activityIcon(item.action || '')))}</span>
              <span class="feed__text">
                <strong>${item.summary || item.action}</strong>
                <p>${item.actor || 'System'}${item.entity_type ? ` · ${item.entity_type}` : ''}</p>
              </span>
              <span class="feed__time">${relativeTime(item.at)}</span>
            </div>
          `,
        )
        .join('')}</div>`
    : '<p class="t-13 subtle">No recent activity.</p>';

  $('#overview-top-products').innerHTML = meterList(
    (top_products || []).map((p) => ({ label: p.title, value: p.revenue })),
    { format: (v) => formatMoney(v, 'USD'), accent: true },
  );
  $('#overview-top-categories').innerHTML = meterList(
    (top_categories || []).map((c) => ({ label: c.name, value: c.revenue })),
    { format: (v) => formatMoney(v, 'USD') },
  );
  $('#overview-payment-mix').innerHTML = meterList(
    (payment_mix || []).map((m) => ({ label: m.provider, value: m.revenue })),
    { format: (v) => formatMoney(v, 'USD') },
  );
}

/* ==========================================================================
   Orders
   ========================================================================== */

const ORDER_TABS = [{ value: '', label: 'All' }, ...ORDER_STATUSES.map((value) => ({ value, label: STATUS_BADGE[value][1] }))];

function paintOrdersTabs() {
  $('#orders-tabs').innerHTML = ORDER_TABS.map(
    (tab) => `<button type="button" role="tab" aria-selected="${tab.value === state.orders.status}" data-status="${esc(tab.value)}">${esc(tab.label)}</button>`,
  ).join('');
}

async function loadOrders() {
  paintOrdersTabs();
  $('#orders-body').innerHTML = `<tr><td colspan="7"><div class="skeleton" style="height:44px"></div></td></tr>`;

  const from = state.orders.page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from('orders')
    .select(
      'id,order_no,status,customer_name,customer_email,amount,currency,provider,provider_transaction_id,promo_code,discount_amount,paid_at,created_at,order_items(product_id,title_snapshot,unit_price,quantity)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (state.orders.status) query = query.eq('status', state.orders.status);
  if (state.orders.search.trim()) {
    const q = state.orders.search.trim().replace(/[%,]/g, '');
    query = query.or(`order_no.ilike.%${q}%,customer_name.ilike.%${q}%,customer_email.ilike.%${q}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(describeError(error));
  state.orders.rows = data || [];
  state.orders.total = count || 0;
  paintOrdersTable();
}

function paintOrdersTable() {
  const rows = state.orders.rows;

  $('#orders-body').innerHTML = rows.length
    ? rows
        .map((order) => {
          const [tone, label] = STATUS_BADGE[order.status] || ['neutral', order.status];
          const items = order.order_items || [];
          return html`
            <tr>
              <td class="mono t-12">${order.order_no || order.id.slice(0, 8)}</td>
              <td>
                <span class="cell-title">${order.customer_name || 'Unnamed'}</span>
                <span class="cell-meta">${order.customer_email}</span>
              </td>
              <td>
                <span class="cell-title">${items[0]?.title_snapshot || '—'}</span>
                ${items.length > 1 ? html`<span class="cell-meta">+${String(items.length - 1)} more</span>` : ''}
              </td>
              <td class="t-12 muted">${formatDate(order.created_at)}</td>
              <td><span class="badge badge--${tone}">${label}</span></td>
              <td class="num">${formatMoney(order.amount, order.currency)}</td>
              <td class="num"><button class="btn btn--xs" type="button" data-order="${order.id}">View</button></td>
            </tr>
          `;
        })
        .join('')
    : html`
        <tr>
          <td colspan="7">
            <div class="empty">
              ${raw(icon('inbox'))}
              <p class="empty__title">No orders found</p>
              <p class="empty__body">Try a different filter or search term.</p>
            </div>
          </td>
        </tr>
      `;

  const totalPages = Math.max(1, Math.ceil(state.orders.total / PAGE_SIZE));
  $('#orders-count').textContent = state.orders.total ? `${formatNumber(state.orders.total)} order${state.orders.total === 1 ? '' : 's'}` : '';
  $('#orders-pagination').innerHTML = html`
    <button class="btn btn--sm" type="button" data-page="prev" ${state.orders.page === 0 ? 'disabled' : ''}>${raw(icon('chevronLeft', 14))}</button>
    <button class="btn btn--sm" type="button" disabled>Page ${state.orders.page + 1} of ${totalPages}</button>
    <button class="btn btn--sm" type="button" data-page="next" ${state.orders.page + 1 >= totalPages ? 'disabled' : ''}>${raw(icon('chevronRight', 14))}</button>
  `;
}

function openOrderModal(orderId) {
  const order = state.orders.rows.find((entry) => entry.id === orderId);
  if (!order) return;
  const [tone, label] = STATUS_BADGE[order.status] || ['neutral', order.status];
  const items = order.order_items || [];

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = html`
    <div class="dialog__head">
      <div>
        <h2 class="dialog__title">Order ${order.order_no || order.id.slice(0, 8)}</h2>
        <p class="dialog__sub">${formatDate(order.created_at, 'datetime')}</p>
      </div>
      <span class="badge badge--${tone}">${label}</span>
    </div>
    <div class="dialog__body stack-5">
      <div>
        ${raw(
          items
            .map(
              (item) => html`
                <div class="summary-line">
                  <span>${item.title_snapshot}${item.quantity > 1 ? ` × ${item.quantity}` : ''}</span>
                  <span>${formatMoney(Number(item.unit_price) * item.quantity, order.currency)}</span>
                </div>
              `,
            )
            .join(''),
        )}
        ${Number(order.discount_amount) > 0
          ? html`
              <div class="summary-line">
                <span>Discount${order.promo_code ? ` · ${order.promo_code}` : ''}</span>
                <span class="ok">−${formatMoney(order.discount_amount, order.currency)}</span>
              </div>
            `
          : ''}
        <div class="summary-line summary-line--total">
          <span>Total</span><span>${formatMoney(order.amount, order.currency)}</span>
        </div>
      </div>
      <dl class="kv">
        <div><dt>Customer</dt><dd>${order.customer_name || '—'}</dd></div>
        <div><dt>Email</dt><dd class="break">${order.customer_email}</dd></div>
        <div><dt>Payment method</dt><dd>${order.provider || '—'}</dd></div>
        <div><dt>Provider reference</dt><dd class="mono break">${order.provider_transaction_id || '—'}</dd></div>
        <div><dt>Paid</dt><dd>${order.paid_at ? formatDate(order.paid_at, 'datetime') : 'Not yet'}</dd></div>
      </dl>
      <label class="field">
        <span class="field__label">Update status</span>
        <select class="select" id="order-status-select">
          ${raw(ORDER_STATUSES.map((value) => `<option value="${value}" ${value === order.status ? 'selected' : ''}>${esc(STATUS_BADGE[value][1])}</option>`).join(''))}
        </select>
      </label>
    </div>
    <div class="dialog__foot dialog__foot--split">
      <button class="btn" type="button" data-close>Close</button>
      <button class="btn btn--primary" type="button" data-save>Save status</button>
    </div>
  `;

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('[data-save]').addEventListener('click', async (event) => {
    const next = dialog.querySelector('#order-status-select').value;
    if (next === order.status) {
      dialog.close();
      return;
    }
    setBusy(event.currentTarget, true, 'Saving…');
    const patch = { status: next };
    if (next === 'refunded' && order.status !== 'refunded') patch.refunded_at = new Date().toISOString();
    const { error } = await supabase.from('orders').update(patch).eq('id', order.id);
    setBusy(event.currentTarget, false);
    if (error) {
      toast(describeError(error), 'error');
      return;
    }
    order.status = next;
    toast('Order status updated.');
    dialog.close();
    paintOrdersTable();
    state.loaded.delete('overview');
  });

  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Customers — aggregated from orders; there is no separate customer API
   ========================================================================== */

async function loadCustomers({ force = false } = {}) {
  if (state.loaded.has('customers') && !force) return paintCustomers();

  const { data, error } = await supabase
    .from('orders')
    .select('customer_name,customer_email,customer_country,amount,currency,status,created_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(describeError(error));

  const byEmail = new Map();
  for (const row of data || []) {
    const key = row.customer_email;
    if (!key) continue;
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        name: row.customer_name,
        email: key,
        country: row.customer_country,
        currency: row.currency,
        orders: 0,
        spend: 0,
        pending: 0,
        last: row.created_at,
        history: [],
      });
    }
    const entry = byEmail.get(key);
    entry.history.push(row);
    if (row.status === 'paid') {
      entry.orders += 1;
      entry.spend += Number(row.amount) || 0;
    }
    if (row.status === 'pending') entry.pending += 1;
    if (!entry.name && row.customer_name) entry.name = row.customer_name;
    if (new Date(row.created_at) > new Date(entry.last)) entry.last = row.created_at;
  }

  state.customers.all = Array.from(byEmail.values()).sort((a, b) => b.spend - a.spend);
  state.loaded.add('customers');
  paintCustomers();
}

function paintCustomers() {
  const q = state.customers.search.trim().toLowerCase();
  const rows = q
    ? state.customers.all.filter((c) => (c.name || '').toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    : state.customers.all;

  $('#customers-body').innerHTML = rows.length
    ? rows
        .map(
          (c) => html`
            <tr>
              <td>
                <span class="cell-title">${c.name || 'Unnamed customer'}</span>
                <span class="cell-meta">${c.email}</span>
              </td>
              <td class="t-12 muted">${c.country || '—'}</td>
              <td class="num">${formatNumber(c.orders)}${c.pending ? ` (+${String(c.pending)} pending)` : ''}</td>
              <td class="num">${formatMoney(c.spend, c.currency)}</td>
              <td class="t-12 muted">${relativeTime(c.last)}</td>
              <td class="num"><button class="btn btn--xs" type="button" data-customer="${c.email}">View</button></td>
            </tr>
          `,
        )
        .join('')
    : html`
        <tr>
          <td colspan="6">
            <div class="empty">${raw(icon('users'))}<p class="empty__title">No customers found</p></div>
          </td>
        </tr>
      `;
}

function openCustomerModal(email) {
  const customer = state.customers.all.find((c) => c.email === email);
  if (!customer) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = html`
    <div class="dialog__head">
      <div>
        <h2 class="dialog__title">${customer.name || 'Unnamed customer'}</h2>
        <p class="dialog__sub">${customer.email}</p>
      </div>
    </div>
    <div class="dialog__body stack-5">
      <div class="stat-row">
        <div class="metric">
          <span class="metric__label">Lifetime spend</span>
          <span class="metric__value">${formatMoney(customer.spend, customer.currency)}</span>
          <span class="metric__foot">${formatNumber(customer.orders)} paid order${customer.orders === 1 ? '' : 's'}</span>
        </div>
        <div class="metric">
          <span class="metric__label">Last order</span>
          <span class="metric__value" style="font-size: var(--t-18)">${formatDate(customer.last)}</span>
          <span class="metric__foot">${customer.country || 'Country unknown'}</span>
        </div>
      </div>
      <div>
        <span class="panel__title">Order history</span>
        <div class="mt-3">
          ${raw(
            customer.history
              .slice(0, 20)
              .map((row) => {
                const [tone, label] = STATUS_BADGE[row.status] || ['neutral', row.status];
                return html`
                  <div class="summary-line">
                    <span>${formatDate(row.created_at)} <span class="badge badge--${tone}">${label}</span></span>
                    <span>${formatMoney(row.amount, row.currency)}</span>
                  </div>
                `;
              })
              .join(''),
          )}
        </div>
      </div>
    </div>
    <div class="dialog__foot">
      <button class="btn btn--primary" type="button" data-close>Close</button>
    </div>
  `;

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Tickets
   ========================================================================== */

const TICKET_TABS = [{ value: '', label: 'All' }, ...TICKET_STATUSES.map((value) => ({ value, label: TICKET_BADGE[value][1] }))];

function paintTicketsTabs() {
  $('#tickets-tabs').innerHTML = TICKET_TABS.map(
    (tab) => `<button type="button" role="tab" aria-selected="${tab.value === state.tickets.status}" data-status="${esc(tab.value)}">${esc(tab.label)}</button>`,
  ).join('');
}

async function loadTickets({ force = false } = {}) {
  if (!state.loaded.has('tickets') || force) {
    const { data, error } = await supabase
      .from('tickets')
      .select('id,name,email,order_ref,category,subject,message,status,created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw new Error(describeError(error));
    state.tickets.all = data || [];
    state.loaded.add('tickets');
  }
  paintTicketsTabs();
  paintTickets();
}

function paintTickets() {
  const rows = state.tickets.status ? state.tickets.all.filter((t) => t.status === state.tickets.status) : state.tickets.all;

  $('#tickets-body').innerHTML = rows.length
    ? rows
        .map((ticket) => {
          const [tone, label] = TICKET_BADGE[ticket.status] || ['neutral', ticket.status];
          return html`
            <tr>
              <td>
                <span class="cell-title">${ticket.subject}</span>
                ${ticket.order_ref ? html`<span class="cell-meta">Ref ${ticket.order_ref}</span>` : ''}
              </td>
              <td>
                <span class="cell-title">${ticket.name || 'Anonymous'}</span>
                <span class="cell-meta">${ticket.email}</span>
              </td>
              <td class="t-12 muted">${ticket.category}</td>
              <td class="t-12 muted">${relativeTime(ticket.created_at)}</td>
              <td><span class="badge badge--${tone}">${label}</span></td>
              <td class="num"><button class="btn btn--xs" type="button" data-ticket="${ticket.id}">Open</button></td>
            </tr>
          `;
        })
        .join('')
    : html`
        <tr>
          <td colspan="6">
            <div class="empty">${raw(icon('inbox'))}<p class="empty__title">No tickets here</p></div>
          </td>
        </tr>
      `;
}

function openTicketModal(id) {
  const ticket = state.tickets.all.find((t) => t.id === id);
  if (!ticket) return;
  const [tone, label] = TICKET_BADGE[ticket.status] || ['neutral', ticket.status];

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = html`
    <div class="dialog__head">
      <div>
        <h2 class="dialog__title">${ticket.subject}</h2>
        <p class="dialog__sub">${ticket.name || 'Anonymous'} · ${ticket.email} · ${formatDate(ticket.created_at, 'datetime')}</p>
      </div>
      <span class="badge badge--${tone}">${label}</span>
    </div>
    <div class="dialog__body stack-5">
      <dl class="kv">
        <div><dt>Category</dt><dd>${ticket.category}</dd></div>
        ${ticket.order_ref ? html`<div><dt>Order reference</dt><dd class="mono">${ticket.order_ref}</dd></div>` : ''}
      </dl>
      <p class="t-14" style="white-space: pre-wrap">${ticket.message}</p>
      <label class="field">
        <span class="field__label">Update status</span>
        <select class="select" id="ticket-status-select">
          ${raw(TICKET_STATUSES.map((value) => `<option value="${value}" ${value === ticket.status ? 'selected' : ''}>${esc(TICKET_BADGE[value][1])}</option>`).join(''))}
        </select>
      </label>
    </div>
    <div class="dialog__foot dialog__foot--split">
      <a class="btn" href="mailto:${ticket.email}?subject=${encodeURIComponent(`Re: ${ticket.subject}`)}">${raw(icon('mail', 14))}<span>Reply by email</span></a>
      <button class="btn btn--primary" type="button" data-save>Save status</button>
    </div>
  `;

  dialog.querySelector('[data-save]').addEventListener('click', async (event) => {
    const next = dialog.querySelector('#ticket-status-select').value;
    if (next === ticket.status) {
      dialog.close();
      return;
    }
    setBusy(event.currentTarget, true, 'Saving…');
    const { error } = await supabase.from('tickets').update({ status: next }).eq('id', ticket.id);
    setBusy(event.currentTarget, false);
    if (error) {
      toast(describeError(error), 'error');
      return;
    }
    ticket.status = next;
    toast('Ticket status updated.');
    dialog.close();
    paintTickets();
    refreshCounts();
  });

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Settings
   ========================================================================== */

function toLocalInput(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadSettings({ force = false } = {}) {
  if (state.loaded.has('settings') && !force) return;
  const { data, error } = await supabase.from('site_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(describeError(error));

  const form = $('#settings-form');
  const s = data || {};
  form.site_title.value = s.site_title || '';
  form.tagline.value = s.tagline || '';
  form.support_email.value = s.support_email || '';
  form.default_currency.value = s.default_currency || 'USD';
  form.announcement.value = s.announcement || '';
  form.announcement_active.checked = Boolean(s.announcement_active);
  form.announcement_ends_at.value = s.announcement_ends_at ? toLocalInput(s.announcement_ends_at) : '';
  form.checkout_note.value = s.checkout_note || '';
  state.loaded.add('settings');
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function refreshCounts() {
  const [{ count: pendingOrders }, { count: openTickets }] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  const orderBadge = $('#count-orders');
  if (orderBadge) orderBadge.textContent = pendingOrders ? String(pendingOrders) : '';
  const ticketBadge = $('#count-tickets');
  if (ticketBadge) ticketBadge.textContent = openTickets ? String(openTickets) : '';
}

async function boot() {
  const account = await requireAdmin('admin.html');
  if (!account) return;
  state.account = account;

  $('#admin-user').textContent = account.profile?.full_name || account.user.email;

  $('#admin-theme').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
  $('#admin-theme').addEventListener('click', (event) => {
    const next = toggleTheme();
    event.currentTarget.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
  });

  $('#rail-toggle').innerHTML = icon('menu');
  $('#rail-toggle').addEventListener('click', () => setRail(true));
  $('#scrim').addEventListener('click', () => setRail(false));

  $('#admin-signout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = './index.html';
  });

  on($('#orders-tabs'), 'click', 'button', (event, button) => {
    state.orders.status = button.dataset.status;
    state.orders.page = 0;
    loadOrders().catch((error) => toast(error.message, 'error'));
  });
  on($('#orders-body'), 'click', '[data-order]', (event, button) => openOrderModal(button.dataset.order));
  $('#orders-search').addEventListener(
    'input',
    debounce((event) => {
      state.orders.search = event.target.value;
      state.orders.page = 0;
      loadOrders().catch((error) => toast(error.message, 'error'));
    }, 300),
  );
  on($('#orders-pagination'), 'click', 'button[data-page]', (event, button) => {
    state.orders.page += button.dataset.page === 'next' ? 1 : -1;
    loadOrders().catch((error) => toast(error.message, 'error'));
  });

  on($('#customers-body'), 'click', '[data-customer]', (event, button) => openCustomerModal(button.dataset.customer));
  $('#customers-search').addEventListener(
    'input',
    debounce((event) => {
      state.customers.search = event.target.value;
      paintCustomers();
    }, 200),
  );

  on($('#tickets-tabs'), 'click', 'button', (event, button) => {
    state.tickets.status = button.dataset.status;
    paintTickets();
  });
  on($('#tickets-body'), 'click', '[data-ticket]', (event, button) => openTicketModal(button.dataset.ticket));

  $('#overview-range').addEventListener('change', (event) => {
    state.overview.days = Number(event.target.value);
    loadOverview({ force: true }).catch((error) => toast(error.message, 'error'));
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Saving…');

    const payload = {
      site_title: form.site_title.value.trim(),
      tagline: form.tagline.value.trim(),
      support_email: form.support_email.value.trim(),
      default_currency: form.default_currency.value,
      announcement: form.announcement.value.trim(),
      announcement_active: form.announcement_active.checked,
      announcement_ends_at: form.announcement_ends_at.value ? new Date(form.announcement_ends_at.value).toISOString() : null,
      checkout_note: form.checkout_note.value.trim(),
      updated_by: state.account.user.id,
    };
    const { error } = await supabase.from('site_settings').update(payload).eq('id', 1);
    setBusy(button, false);
    if (error) {
      toast(describeError(error), 'error');
      return;
    }
    toast('Store settings saved.');
  });

  $('#view-sitemap').href = `${CONFIG.FUNCTIONS_URL}/sitemap`;
  $('#run-search-index').addEventListener('click', async (event) => {
    const feedback = $('#automation-feedback');
    setBusy(event.currentTarget, true, 'Processing…');
    try {
      const { data, error } = await supabase.functions.invoke('search-index');
      if (error) throw error;
      feedback.textContent = data?.message || `Processed ${data?.processed ?? 0} queued item(s).`;
      feedback.className = 'status status--ok';
    } catch (error) {
      feedback.textContent = error.message || 'Could not process the search queue.';
      feedback.className = 'status status--error';
    }
    setBusy(event.currentTarget, false);
  });

  window.addEventListener('hashchange', () => {
    applyRoute().catch((error) => toast(error.message, 'error'));
  });

  await applyRoute();
  refreshCounts().catch(() => {});
  bootDone();
}

boot().catch((error) => {
  console.error(error);
  toast(error.message || 'The admin console failed to start.', 'error');
  bootDone();
});
