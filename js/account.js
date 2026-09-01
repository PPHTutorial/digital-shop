import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { wishlistButton, paintWishlist, wireWishlist } from './wishlist.js';

let account;

const statusVariant = {
  paid: { bg: 'var(--success-bg)', fg: '#2dab66', label: 'Paid' },
  pending: { bg: 'var(--warning-bg)', fg: '#b45309', label: 'Pending' },
  cancelled: { bg: 'var(--danger-bg)', fg: 'var(--danger)', label: 'Cancelled' },
  failed: { bg: 'var(--danger-bg)', fg: 'var(--danger)', label: 'Failed' },
  refunded: { bg: 'var(--info-bg)', fg: 'var(--info)', label: 'Refunded' },
};

function statusBadgeHtml(status) {
  const v = statusVariant[status] || { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)', label: status };
  return `<span style="display:inline-flex;padding:4px 10px;border-radius:6px;background:${v.bg};color:${v.fg};font-size:.72rem;font-weight:700">${escapeHtml(v.label)}</span>`;
}

const ORDERS_PAGE_SIZE = 8;
let ordersPage = 1;
let ordersAll = [];

function ordersTableHtml(orders, { compact = false } = {}) {
  if (!orders.length) {
    return `<p class="py-6 text-sm text-center" style="color:var(--text-muted)">No purchases yet. <a href="./store" style="color:var(--text);font-weight:700">Browse the catalog</a> to find your first digital product.</p>`;
  }
  return `
    <table class="acct-table">
      <thead>
        <tr>
          <th>Order</th><th>Date</th><th>Total</th><th>Status</th>${compact ? '' : '<th>Actions</th>'}
        </tr>
      </thead>
      <tbody>
        ${orders.map((o) => `
          <tr>
            <td><strong style="font-family:var(--font-mono)">${escapeHtml(o.order_no || o.id.slice(0, 8))}</strong><div style="color:var(--text-muted);font-size:.78rem">${escapeHtml(o.products?.title || 'Digital product')}</div></td>
            <td>${new Date(o.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
            <td>${o.currency} ${Number(o.amount).toFixed(2)}</td>
            <td>${statusBadgeHtml(o.status)}</td>
            ${compact ? '' : `<td>${o.status === 'paid' ? `<a href="./success?order_id=${o.id}">Download</a>` : '—'}</td>`}
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderOrdersPagination(total) {
  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  ordersPage = Math.min(ordersPage, pageCount);
  const el = document.querySelector('#acct-orders-pagination');
  if (!el) return;

  if (pageCount <= 1) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <button type="button" id="orders-prev" class="button !min-h-8 !px-3" ${ordersPage <= 1 ? 'disabled' : ''}>Previous</button>
    <span style="color:var(--text-muted)">Page ${ordersPage} of ${pageCount}</span>
    <button type="button" id="orders-next" class="button !min-h-8 !px-3" ${ordersPage >= pageCount ? 'disabled' : ''}>Next</button>`;

  document.querySelector('#orders-prev')?.addEventListener('click', () => { ordersPage -= 1; paintOrdersPage(); });
  document.querySelector('#orders-next')?.addEventListener('click', () => { ordersPage += 1; paintOrdersPage(); });
}

function paintOrdersPage() {
  const start = (ordersPage - 1) * ORDERS_PAGE_SIZE;
  const pageItems = ordersAll.slice(start, start + ORDERS_PAGE_SIZE);
  document.querySelector('#acct-orders-list').innerHTML = ordersTableHtml(pageItems);
  renderOrdersPagination(ordersAll.length);
}

async function loadWishlistTab() {
  const host = document.querySelector('#acct-wishlist-grid');
  if (!host) return 0;

  const { data, error } = await supabase
    .from('wishlist_items')
    .select('added_at,product:products(id,slug,title,price,original_price,currency,cover_url,is_published)')
    .eq('user_id', account.user.id)
    .order('added_at', { ascending: false });

  const items = (data || []).filter((r) => r.product?.is_published);

  if (error || !items.length) {
    host.innerHTML = `<p class="col-span-full py-6 text-sm text-center" style="color:var(--text-muted)">Nothing saved yet. Tap the heart on any product to save it here.</p>`;
    return 0;
  }

  host.innerHTML = items.map(({ product: p }) => {
    const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
    return `
      <article class="catalog-card is-clickable" data-product-id="${p.id}">
        <span class="catalog-card__media">
          ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">` : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`}
        </span>
        ${wishlistButton(p.id, p.title)}
        <span class="catalog-card__body">
          <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        </span>
        <span class="catalog-card__foot">
          <span class="catalog-card__price">
            ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
            <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
          </span>
        </span>
        <a class="catalog-card__link" href="./product/${encodeURIComponent(p.slug)}"><span class="sr-only">${escapeHtml(p.title)}</span></a>
      </article>`;
  }).join('');

  paintWishlist(host);
  wireWishlist(host);
  renderIcons();
  return items.length;
}

/** Pending store_members invites addressed to this (now-registered) user —
 *  see the 20260826130000 migration: an invite queues silently until the
 *  invitee explicitly accepts it, and this banner is the reachable place to
 *  do that (account.html rather than vendor.html, since the invitee may not
 *  be the store's owner and vendor.html gates on that). */
async function loadPendingInvites(userId) {
  const banner = document.querySelector('#acct-invites-banner');
  if (!banner) return;
  const { data, error } = await supabase
    .from('store_members')
    .select('id,vendor_id,role,vendor:vendor_id(display_name)')
    .eq('user_id', userId).eq('status', 'pending');
  if (error || !data?.length) { banner.classList.add('hidden'); return; }

  banner.classList.remove('hidden');
  banner.innerHTML = data.map((invite) => `
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;width:100%">
      <span style="font-size:.86rem"><strong>${escapeHtml(invite.vendor?.display_name || 'A store')}</strong> invited you to join their team as <strong>${escapeHtml(invite.role)}</strong>.</span>
      <button type="button" class="button button-primary !min-h-8 !px-3 text-xs" data-accept-invite="${invite.vendor_id}">Accept invite</button>
    </div>`).join('');

  banner.querySelectorAll('[data-accept-invite]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Accepting…';
    const { error: acceptError } = await supabase.rpc('store_member_accept_invite', { p_vendor_id: btn.dataset.acceptInvite });
    if (acceptError) { toast(acceptError.message, 'error'); btn.disabled = false; btn.textContent = 'Accept invite'; return; }
    toast('Invite accepted.');
    await loadPendingInvites(userId);
  }));
}

async function load() {
  mountHeader();
  mountFooter();
  account = await getAccount();

  if (!account.user) {
    const nextUrl = `account${location.search}${location.hash}`;
    location.replace(`./auth?mode=signin&next=${encodeURIComponent(nextUrl)}`);
    return;
  }

  const { user, profile } = account;
  const name = profile?.full_name || 'there';

  document.querySelector('#acct-welcome-title').textContent = `Welcome back, ${name}!`;
  document.querySelector('#acct-welcome-sub').textContent = profile?.created_at
    ? `Member since ${new Date(profile.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
    : 'A private overview of your DigiStore activity.';
  document.querySelector('#acct-avatar').textContent = name[0]?.toUpperCase() || '?';
  document.querySelector('#acct-admin-link-wrap').classList.toggle('hidden', profile?.role !== 'admin');

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id,order_no,status,amount,currency,created_at,products(title)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const all = orders || [];
  const paid = all.filter((o) => o.status === 'paid');

  document.querySelector('#acct-stat-orders').textContent = paid.length;
  document.querySelector('#acct-stat-spend').textContent = `$${paid.reduce((s, o) => s + Number(o.amount), 0).toFixed(2)}`;

  // Selling: show the invitation, or a shortcut straight to the seller centre.
  const { data: vendorRow } = await supabase
    .from('vendors').select('display_name,status').eq('user_id', user.id).maybeSingle();

  const sellerCard = document.querySelector('#acct-seller-card');
  if (vendorRow) {
    sellerCard.classList.remove('hidden');
    document.querySelector('#acct-seller-title').textContent = vendorRow.status === 'approved' ? 'Seller Centre' : 'Seller Application';
    document.querySelector('#acct-seller-copy').textContent = vendorRow.status === 'approved'
      ? 'Manage your products, sales, and payouts.'
      : `Application status: ${vendorRow.status}.`;
    document.querySelector('#acct-seller-link').textContent = vendorRow.status === 'approved' ? 'Seller Centre' : 'View Application';
  } else {
    sellerCard.classList.remove('hidden');
  }

  ordersAll = all;
  ordersPage = 1;
  if (error) {
    document.querySelector('#acct-orders-list').innerHTML = `<p style="color:var(--danger)">Orders are unavailable right now.</p>`;
  } else {
    paintOrdersPage();
    document.querySelector('#acct-overview-orders').innerHTML = ordersTableHtml(all.slice(0, 5), { compact: true });
  }

  await loadPendingInvites(user.id);

  const wishlistCount = await loadWishlistTab();
  document.querySelector('#acct-stat-wishlist').textContent = wishlistCount;

  // Profile form prefill
  const form = document.querySelector('#profile-form');
  [
    'full_name', 'phone', 'country', 'address', 'occupation', 'date_of_birth',
    'company_name', 'vat_number', 'billing_address', 'timezone',
    'preferred_currency', 'locale',
  ].forEach((k) => {
    if (form.elements[k]) form.elements[k].value = profile?.[k] ?? '';
  });
  [['marketing_opt_in', false], ['notify_product_news', true], ['notify_order_updates', true]].forEach(([k, def]) => {
    if (form.elements[k]) form.elements[k].checked = profile?.[k] ?? def;
  });

  // Avatar: welcome badge + the profile-form preview.
  const avatarBadge = document.querySelector('#acct-avatar');
  const avatarPreview = document.querySelector('#avatar-preview');
  if (profile?.avatar_url) {
    const img = `<img src="${escapeHtml(profile.avatar_url)}" alt="">`;
    if (avatarBadge) avatarBadge.innerHTML = img;
    if (avatarPreview) avatarPreview.innerHTML = img;
    document.querySelector('#avatar-url').value = profile.avatar_url;
  } else if (avatarPreview) {
    avatarPreview.textContent = name[0]?.toUpperCase() || '?';
  }

  renderIcons();
  finishPageLoader();
}

// Avatar upload — dedicated public "avatars" bucket, each user writes only
// under their own "{uid}/…" path (see the storage policies in the
// 20260831160000 migration).
document.querySelector('#avatar-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file || !account?.user) return;
  const statusEl = document.querySelector('#avatar-status');
  if (file.size > 3 * 1024 * 1024) { statusEl.textContent = 'That image is over 3 MB.'; return; }
  statusEl.textContent = 'Uploading…';
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${account.user.id}/avatar-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) { statusEl.textContent = upErr.message; return; }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  document.querySelector('#avatar-url').value = data.publicUrl;
  document.querySelector('#avatar-preview').innerHTML = `<img src="${escapeHtml(data.publicUrl)}" alt="">`;
  statusEl.textContent = 'Photo ready — press Save to apply.';
});

// Sidebar tab switching — plain click handlers rather than uikit's initTabs
// (that helper expects [data-uk-tab] wiring; this dashboard's own markup
// predates it and reuses the simpler pattern already used elsewhere).
document.querySelectorAll('[data-acct-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.acctTab;
    document.querySelectorAll('[data-acct-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('[data-acct-panel]').forEach((p) => p.classList.toggle('is-active', p.dataset.acctPanel === key));
    setDashSidebarOpen(false);
  });
});

// Mobile off-canvas drawer — same `#dash-sidebar`/`#dash-menu-button`/
// `#dash-scrim` pattern as the admin/vendor consoles (js/admin.js,
// js/vendor.js), so the account sidebar collapses into a real slide-in
// panel below the 980px breakpoint instead of a static stacked block.
const dashSidebar = document.querySelector('#dash-sidebar');
const dashMenuButton = document.querySelector('#dash-menu-button');
const dashCloseButton = document.querySelector('#dash-sidebar-close');
const dashScrim = document.querySelector('#dash-scrim');

function setDashSidebarOpen(open) {
  dashSidebar?.classList.toggle('is-open', open);
  dashScrim?.classList.toggle('is-open', open);
  dashMenuButton?.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
}

dashMenuButton?.addEventListener('click', () => setDashSidebarOpen(true));
dashCloseButton?.addEventListener('click', () => setDashSidebarOpen(false));
dashScrim?.addEventListener('click', () => setDashSidebarOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setDashSidebarOpen(false);
});

// Profile form submit
document.querySelector('#profile-form').onsubmit = async (e) => {
  e.preventDefault();
  const b = e.currentTarget.querySelector('button[type="submit"]');
  const fd = new FormData(e.currentTarget);
  const str = (k) => { const s = (fd.get(k) ?? '').toString().trim(); return s || null; };

  const payload = {
    full_name: str('full_name') || '',
    phone: str('phone'),
    country: str('country'),
    address: str('address'),
    occupation: str('occupation'),
    date_of_birth: str('date_of_birth'),
    company_name: str('company_name'),
    vat_number: str('vat_number'),
    billing_address: str('billing_address'),
    timezone: str('timezone'),
    preferred_currency: str('preferred_currency') || 'USD',
    locale: str('locale') || 'en',
    avatar_url: str('avatar_url'),
    marketing_opt_in: fd.has('marketing_opt_in'),
    notify_product_news: fd.has('notify_product_news'),
    notify_order_updates: fd.has('notify_order_updates'),
    updated_at: new Date().toISOString(),
  };
  // Keep the legacy `age` column in step with the new date of birth.
  if (payload.date_of_birth) {
    const years = Math.floor((Date.now() - new Date(payload.date_of_birth).getTime()) / 31_557_600_000);
    payload.age = years >= 13 && years <= 120 ? years : null;
  } else {
    payload.age = null;
  }

  setButtonLoading(b, true, 'Saving…');
  const { error } = await supabase.from('profiles').update(payload).eq('id', account.user.id);
  setButtonLoading(b, false);
  document.querySelector('#profile-feedback').textContent = error ? error.message : 'Profile saved.';
  document.querySelector('#profile-feedback').className = `status-line span-2 ${error ? 'error' : 'success'}`;
  if (!error) toast('Profile updated.');
};

load();
