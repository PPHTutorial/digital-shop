/**
 * Customer account.
 *
 * Four tabs over one fetch: the download library (paid orders), full order
 * history with receipts, the saved list, and the profile form.
 */

import { supabase, requireAuth, unwrap, callFunction, describeError } from './client.js';
import { $, $$, html, raw, esc, on } from './dom.js';
import { icon } from './icons.js';
import { formatMoney, formatDate, relativeTime, initials, formatNumber } from './format.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy, confirmDialog } from './ui.js';
import { lineChart } from './chart.js';

initTheme();

const STATUS_BADGE = {
  paid: ['ok', 'Paid'],
  pending: ['warn', 'Awaiting payment'],
  failed: ['danger', 'Failed'],
  cancelled: ['neutral', 'Cancelled'],
  refunded: ['info', 'Refunded'],
};

const state = {
  account: null,
  orders: [],
  saved: [],
};

/* ==========================================================================
   Data
   ========================================================================== */

async function loadOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id,order_no,status,amount,currency,subtotal,discount_amount,promo_code,provider,' +
        'provider_transaction_id,created_at,paid_at,' +
        'order_items(product_id,title_snapshot,unit_price,quantity,products(slug,cover_url,file_type,category))',
    )
    .order('created_at', { ascending: false });

  if (error) throw new Error(describeError(error));
  return data || [];
}

async function loadSaved() {
  const { data } = await supabase
    .from('wishlist_items')
    .select('added_at,products(id,slug,title,short_description,price,original_price,currency,cover_url,category)')
    .order('added_at', { ascending: false });
  return (data || []).filter((row) => row.products);
}

/* ==========================================================================
   Stats
   ========================================================================== */

function paintStats() {
  const paid = state.orders.filter((order) => order.status === 'paid');
  const spend = paid.reduce((total, order) => total + Number(order.amount), 0);
  const currency = paid[0]?.currency || 'USD';
  const files = paid.reduce((total, order) => total + (order.order_items?.length || 0), 0);
  const since = state.account.profile?.created_at;

  const monthly = new Map();
  for (const order of paid) {
    const bucket = formatDate(order.paid_at || order.created_at, 'monthYear');
    monthly.set(bucket, (monthly.get(bucket) || 0) + Number(order.amount));
  }
  const points = Array.from(monthly, ([label, value]) => ({ label, value })).slice(-8);

  $('#account-stats').innerHTML = html`
    <div class="metric">
      <span class="metric__label">Purchases</span>
      <span class="metric__value">${formatNumber(paid.length)}</span>
      <span class="metric__foot">${String(state.orders.length - paid.length)} not completed</span>
    </div>
    <div class="metric">
      <span class="metric__label">Total spent</span>
      <span class="metric__value">${formatMoney(spend, currency)}</span>
      <span class="metric__foot">Across ${String(paid.length)} order${paid.length === 1 ? '' : 's'}</span>
    </div>
    <div class="metric">
      <span class="metric__label">Files available</span>
      <span class="metric__value">${formatNumber(files)}</span>
      <span class="metric__foot">Re-downloadable at any time</span>
    </div>
    <div class="metric">
      <span class="metric__label">Member since</span>
      <span class="metric__value" style="font-size:var(--t-18)">${since ? formatDate(since, 'monthYear') : '—'}</span>
      <span class="metric__foot">${since ? relativeTime(since) : ''}</span>
    </div>
  `;

  if (points.length > 1) {
    $('#account-stats').insertAdjacentHTML(
      'afterend',
      html`
        <section class="panel mt-6" id="spend-chart">
          <div class="panel__head">
            <div>
              <h2 class="panel__title">Spending over time</h2>
              <p class="panel__sub">Completed orders only.</p>
            </div>
          </div>
          <div class="panel__body">${raw(lineChart(points, { format: (v) => formatMoney(v, currency) }))}</div>
        </section>
      `,
    );
  }
}

/* ==========================================================================
   Library
   ========================================================================== */

function paintLibrary() {
  const paid = state.orders.filter((order) => order.status === 'paid');
  const entries = paid.flatMap((order) =>
    (order.order_items || []).map((item) => ({ order, item })),
  );

  $('#panel-library').innerHTML = entries.length
    ? html`
        <div class="panel">
          <div class="panel__head">
            <div>
              <h2 class="panel__title">Your library</h2>
              <p class="panel__sub">Download links are generated fresh each time and expire after an hour.</p>
            </div>
          </div>
          <div class="panel__body--flush">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Order</th>
                    <th>Purchased</th>
                    <th class="num">Download</th>
                  </tr>
                </thead>
                <tbody>
                  ${raw(
                    entries
                      .map(
                        ({ order, item }) => html`
                          <tr>
                            <td>
                              <div class="row row-3">
                                ${item.products?.cover_url
                                  ? raw(`<img class="line-item__thumb" src="${esc(item.products.cover_url)}" alt="" loading="lazy">`)
                                  : ''}
                                <span>
                                  <span class="cell-title">${item.title_snapshot}</span>
                                  <span class="cell-meta">
                                    ${item.products?.category || 'Digital product'}${item.products?.file_type ? ` · ${item.products.file_type}` : ''}
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td class="mono t-12">${order.order_no || order.id.slice(0, 8)}</td>
                            <td class="t-12 muted">${formatDate(order.paid_at || order.created_at)}</td>
                            <td class="num">
                              <button class="btn btn--sm btn--primary" type="button"
                                      data-download="${order.id}" data-product="${item.product_id}">
                                ${raw(icon('download'))}<span>Download</span>
                              </button>
                            </td>
                          </tr>
                        `,
                      )
                      .join(''),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `
    : html`
        <div class="empty">
          ${raw(icon('download'))}
          <p class="empty__title">Nothing here yet</p>
          <p class="empty__body">Products appear here as soon as a payment completes.</p>
          <a class="btn btn--sm btn--primary mt-2" href="./store.html">Browse the catalog</a>
        </div>
      `;
}

/* ==========================================================================
   Orders
   ========================================================================== */

function paintOrders() {
  $('#panel-orders').innerHTML = state.orders.length
    ? html`
        <div class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Order history</h2>
            <span class="t-12 muted">${formatNumber(state.orders.length)} order${state.orders.length === 1 ? '' : 's'}</span>
          </div>
          <div class="panel__body--flush">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Items</th>
                    <th>Placed</th>
                    <th>Status</th>
                    <th class="num">Total</th>
                    <th class="num"></th>
                  </tr>
                </thead>
                <tbody>
                  ${raw(
                    state.orders
                      .map((order) => {
                        const [tone, label] = STATUS_BADGE[order.status] || ['neutral', order.status];
                        return html`
                          <tr>
                            <td class="mono t-12">${order.order_no || order.id.slice(0, 8)}</td>
                            <td>
                              <span class="cell-title">${order.order_items?.[0]?.title_snapshot || 'Digital product'}</span>
                              ${order.order_items?.length > 1
                                ? html`<span class="cell-meta">+${String(order.order_items.length - 1)} more</span>`
                                : ''}
                            </td>
                            <td class="t-12 muted">${formatDate(order.created_at)}</td>
                            <td><span class="badge badge--${tone}">${label}</span></td>
                            <td class="num">${formatMoney(order.amount, order.currency)}</td>
                            <td class="num">
                              <button class="btn btn--xs" type="button" data-receipt="${order.id}">Receipt</button>
                            </td>
                          </tr>
                        `;
                      })
                      .join(''),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `
    : html`
        <div class="empty">
          ${raw(icon('inbox'))}
          <p class="empty__title">No orders yet</p>
          <p class="empty__body">Your purchase history will appear here.</p>
        </div>
      `;
}

function openReceipt(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  const [tone, label] = STATUS_BADGE[order.status] || ['neutral', order.status];
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = html`
    <div class="dialog__head">
      <div>
        <h2 class="dialog__title">Receipt ${order.order_no || order.id.slice(0, 8)}</h2>
        <p class="dialog__sub">${formatDate(order.created_at, 'datetime')}</p>
      </div>
      <span class="badge badge--${tone}">${label}</span>
    </div>
    <div class="dialog__body stack-5">
      <div>
        ${raw(
          (order.order_items || [])
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
          <span>Total paid</span><span>${formatMoney(order.amount, order.currency)}</span>
        </div>
      </div>

      <dl class="kv">
        <div><dt>Reference</dt><dd class="mono">${order.order_no || order.id}</dd></div>
        <div><dt>Payment method</dt><dd>${order.provider || '—'}</dd></div>
        <div><dt>Provider reference</dt><dd class="mono break">${order.provider_transaction_id || '—'}</dd></div>
        <div><dt>Paid</dt><dd>${order.paid_at ? formatDate(order.paid_at, 'datetime') : 'Not yet'}</dd></div>
        <div><dt>Billed to</dt><dd>${state.account.user.email}</dd></div>
      </dl>

      <p class="t-12 subtle">
        Issued by Codeink Technologies. Digital goods; no physical shipment. Keep this reference when contacting support.
      </p>
    </div>
    <div class="dialog__foot dialog__foot--split">
      <button class="btn" type="button" data-print>${raw(icon('file'))}<span>Print</span></button>
      <button class="btn btn--primary" type="button" data-close>Close</button>
    </div>
  `;

  dialog.querySelector('[data-close]').addEventListener('click', () => {
    dialog.close();
    dialog.remove();
  });
  dialog.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  dialog.addEventListener('cancel', () => dialog.remove());

  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Saved
   ========================================================================== */

function paintSaved() {
  $('#panel-saved').innerHTML = state.saved.length
    ? html`
        <div class="cards">
          ${raw(
            state.saved
              .map(
                ({ products: product }) => html`
                  <article class="product">
                    <a class="product__media${product.cover_url ? '' : ' product__media--empty'}"
                       href="./product.html?p=${encodeURIComponent(product.slug || product.id)}">
                      ${product.cover_url ? raw(`<img src="${esc(product.cover_url)}" alt="" loading="lazy">`) : 'Digital product'}
                    </a>
                    <div class="product__body">
                      <span class="product__cat">${product.category || 'General'}</span>
                      <h3 class="product__title">
                        <a href="./product.html?p=${encodeURIComponent(product.slug || product.id)}">${product.title}</a>
                      </h3>
                    </div>
                    <div class="product__foot">
                      <span class="price"><span class="price__now">${formatMoney(product.price, product.currency)}</span></span>
                      <span class="row row-1">
                        <button class="btn btn--sm btn--icon" type="button" data-unsave="${product.id}"
                                aria-label="Remove from saved">${raw(icon('trash'))}</button>
                        <a class="btn btn--sm btn--primary" href="./checkout.html?p=${encodeURIComponent(product.slug || product.id)}">Buy</a>
                      </span>
                    </div>
                  </article>
                `,
              )
              .join(''),
          )}
        </div>
      `
    : html`
        <div class="empty">
          ${raw(icon('star'))}
          <p class="empty__title">Nothing saved</p>
          <p class="empty__body">Use Save on a product page to keep it here for later.</p>
        </div>
      `;
}

/* ==========================================================================
   Profile
   ========================================================================== */

function paintProfile() {
  const profile = state.account.profile || {};

  $('#panel-profile').innerHTML = html`
    <div class="sidebar-layout" style="--aside-w: 300px">
      <form class="panel" id="profile-form" novalidate>
        <div class="panel__head">
          <div>
            <h2 class="panel__title">Your details</h2>
            <p class="panel__sub">Only your name and email are needed to buy. The rest is optional.</p>
          </div>
        </div>
        <div class="panel__body grid12">
          <label class="field col-12">
            <span class="field__label" for="full_name">Full name<span class="req"> *</span></span>
            <input class="input" id="full_name" name="full_name" required value="${profile.full_name || ''}">
          </label>
          <label class="field col-6 col-sm-12">
            <span class="field__label" for="phone">Phone</span>
            <input class="input" id="phone" name="phone" type="tel" value="${profile.phone || ''}">
          </label>
          <label class="field col-6 col-sm-12">
            <span class="field__label" for="country">Country</span>
            <input class="input" id="country" name="country" value="${profile.country || ''}">
          </label>
          <label class="field col-12">
            <span class="field__label" for="address">Address</span>
            <textarea class="textarea" id="address" name="address" rows="2">${profile.address || ''}</textarea>
          </label>
          <label class="field col-6 col-sm-12">
            <span class="field__label" for="occupation">Occupation</span>
            <input class="input" id="occupation" name="occupation" value="${profile.occupation || ''}">
          </label>
          <label class="field col-6 col-sm-12">
            <span class="field__label" for="preferred_currency">Preferred currency</span>
            <select class="select" id="preferred_currency" name="preferred_currency">
              ${raw(
                ['USD', 'GBP', 'EUR', 'NGN', 'GHS', 'KES', 'ZAR']
                  .map((code) => `<option ${profile.preferred_currency === code ? 'selected' : ''}>${code}</option>`)
                  .join(''),
              )}
            </select>
          </label>
          <div class="col-12">
            <label class="switch">
              <input type="checkbox" name="marketing_opt_in" ${profile.marketing_opt_in ? 'checked' : ''}>
              <span class="switch__track"></span>
              <span>Send me occasional release notes</span>
            </label>
          </div>
        </div>
        <div class="panel__foot">
          <p class="status" id="profile-status" aria-live="polite"></p>
          <button class="btn btn--primary" type="submit">Save changes</button>
        </div>
      </form>

      <aside class="stack-5">
        <div class="panel">
          <div class="panel__body stack-4">
            <div class="row row-3">
              <span class="avatar avatar--lg">${initials(profile.full_name || state.account.user.email)}</span>
              <div class="truncate">
                <strong class="block">${profile.full_name || 'Customer'}</strong>
                <span class="t-12 subtle truncate block">${state.account.user.email}</span>
              </div>
            </div>
            <dl class="kv kv--inline">
              <div><dt>Role</dt><dd>${profile.role === 'admin' ? 'Administrator' : 'Customer'}</dd></div>
              <div><dt>Joined</dt><dd>${formatDate(profile.created_at)}</dd></div>
            </dl>
          </div>
        </div>

        <div class="panel">
          <div class="panel__head"><h2 class="panel__title">Security</h2></div>
          <div class="panel__body stack-3">
            <button class="btn btn--block" type="button" id="change-password">Change password</button>
            <button class="btn btn--block" type="button" id="sign-out-all">Sign out</button>
          </div>
        </div>
      </aside>
    </div>
  `;

  $('#profile-form').addEventListener('submit', saveProfile);
  $('#change-password').addEventListener('click', changePassword);
  $('#sign-out-all').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = './index.html';
  });
}

async function saveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = $('#profile-status');
  const values = Object.fromEntries(new FormData(form).entries());

  if (!String(values.full_name || '').trim()) {
    status.textContent = 'A name is required.';
    status.className = 'status status--error';
    return;
  }

  setBusy(button, true, 'Saving…');
  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: values.full_name.trim(),
      phone: values.phone?.trim() || null,
      country: values.country?.trim() || null,
      address: values.address?.trim() || null,
      occupation: values.occupation?.trim() || null,
      preferred_currency: values.preferred_currency || 'USD',
      marketing_opt_in: form.elements.marketing_opt_in.checked,
    })
    .eq('id', state.account.user.id);
  setBusy(button, false);

  if (error) {
    status.textContent = describeError(error);
    status.className = 'status status--error';
    return;
  }

  status.textContent = 'Saved.';
  status.className = 'status status--ok';
  toast('Profile updated.');
}

async function changePassword() {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog dialog--narrow';
  dialog.innerHTML = html`
    <div class="dialog__head"><h2 class="dialog__title">Change your password</h2></div>
    <div class="dialog__body stack-4">
      <label class="field">
        <span class="field__label" for="new-password">New password</span>
        <input class="input" id="new-password" type="password" minlength="8" autocomplete="new-password">
        <span class="field__hint">At least 8 characters.</span>
      </label>
      <p class="status" data-status></p>
    </div>
    <div class="dialog__foot">
      <button class="btn" type="button" data-cancel>Cancel</button>
      <button class="btn btn--primary" type="button" data-save>Update password</button>
    </div>
  `;

  const close = () => {
    dialog.close();
    dialog.remove();
  };

  dialog.querySelector('[data-cancel]').addEventListener('click', close);
  dialog.querySelector('[data-save]').addEventListener('click', async (event) => {
    const value = dialog.querySelector('#new-password').value;
    const status = dialog.querySelector('[data-status]');
    if (value.length < 8) {
      status.textContent = 'The password must be at least 8 characters.';
      status.className = 'status status--error';
      return;
    }
    setBusy(event.currentTarget, true, 'Updating…');
    const { error } = await supabase.auth.updateUser({ password: value });
    setBusy(event.currentTarget, false);
    if (error) {
      status.textContent = error.message;
      status.className = 'status status--error';
      return;
    }
    close();
    toast('Password updated.');
  });

  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Downloads
   ========================================================================== */

async function download(button, orderId, productId) {
  setBusy(button, true, 'Preparing…');
  try {
    const result = await callFunction('download-book', { body: { order_id: orderId, product_id: productId } });
    if (!result?.url) throw new Error(result?.error || 'The download link could not be created.');

    // A hidden anchor keeps the navigation in the same tab and preserves the
    // Content-Disposition the signed URL sets.
    const anchor = document.createElement('a');
    anchor.href = result.url;
    anchor.rel = 'noopener';
    anchor.download = '';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    toast('Download started.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

/* ==========================================================================
   Tabs
   ========================================================================== */

function selectTab(name) {
  for (const tab of $$('[data-tab]')) {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active));
    $(`#panel-${tab.dataset.tab}`).hidden = !active;
  }
  window.history.replaceState({}, '', `#${name}`);
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function main() {
  mountFooter();

  const account = await requireAuth('account.html');
  if (!account) return;
  state.account = account;

  await mountHeader();

  $('#account-name').textContent = account.profile?.full_name
    ? `Hello, ${account.profile.full_name.split(' ')[0]}`
    : 'Your account';
  $('#account-sub').textContent = 'Purchases, downloads, and settings.';
  if (account.isAdmin) $('#account-admin').classList.remove('hidden');

  if (new URLSearchParams(window.location.search).get('denied') === 'admin') {
    toast('That area needs administrator access.', 'error');
  }

  try {
    const [orders, saved] = await Promise.all([loadOrders(), loadSaved()]);
    state.orders = orders;
    state.saved = saved;
  } catch (error) {
    toast(error.message, 'error');
  }

  paintStats();
  paintLibrary();
  paintOrders();
  paintSaved();
  paintProfile();

  const hash = window.location.hash.replace('#', '');
  selectTab(['library', 'orders', 'saved', 'profile'].includes(hash) ? hash : 'library');

  on(document, 'click', '[data-tab]', (event, tab) => selectTab(tab.dataset.tab));
  on(document, 'click', '[data-download]', (event, button) =>
    download(button, button.dataset.download, button.dataset.product),
  );
  on(document, 'click', '[data-receipt]', (event, button) => openReceipt(button.dataset.receipt));
  on(document, 'click', '[data-unsave]', async (event, button) => {
    const productId = button.dataset.unsave;
    const confirmed = await confirmDialog({
      title: 'Remove from your saved list?',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await unwrap(supabase.from('wishlist_items').delete().eq('product_id', productId));
      state.saved = state.saved.filter((row) => row.products.id !== productId);
      paintSaved();
      toast('Removed.');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  bootDone();
}

main().catch((error) => {
  console.error(error);
  toast(error.message || 'Your account could not be loaded.', 'error');
  bootDone();
});
