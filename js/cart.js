import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, mountFooter, mountHeader, renderIcons, toast } from './ui.js';
import { refreshCartBadges } from './cart-actions.js';

let rows = [];

function lineTotal(row) {
  return Number(row.product.price) * row.quantity;
}

function cartRowHtml(row) {
  const p = row.product;
  const vendorLabel = p.vendor_id ? (p.vendor?.display_name || 'Marketplace Seller') : 'DigiStore Official';
  return `
    <div class="cart-item-row" data-cart-row="${row.id}">
      ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}">` : `<span class="cart-item-row__details" style="width:80px"></span>`}
      <div class="cart-item-row__details">
        <span class="cart-item-row__vendor">${escapeHtml(vendorLabel)}</span>
        <span class="cart-item-row__title">${escapeHtml(p.title)}</span>
      </div>
      <div class="cart-qty-stepper">
        <button type="button" data-qty="dec" aria-label="Decrease quantity" ${row.quantity <= 1 ? 'disabled' : ''}>−</button>
        <span>${row.quantity}</span>
        <button type="button" data-qty="inc" aria-label="Increase quantity" ${row.quantity >= 20 ? 'disabled' : ''}>+</button>
      </div>
      <span class="cart-item-row__price">${p.currency} ${lineTotal(row).toFixed(2)}</span>
      <button type="button" class="cart-item-row__remove" data-remove aria-label="Remove from cart">
        <i data-lucide="trash-2" width="16" height="16"></i>
      </button>
    </div>`;
}

function renderSummary() {
  const currency = rows[0]?.product.currency || 'USD';
  const subtotal = rows.reduce((sum, r) => sum + lineTotal(r), 0);

  document.querySelector('#cart-summary-lines').innerHTML = `
    <div class="cart-summary-line">
      <span>${rows.length} product${rows.length === 1 ? '' : 's'}</span>
      <strong>${currency} ${subtotal.toFixed(2)}</strong>
    </div>`;
  document.querySelector('#cart-total').textContent = `${currency} ${subtotal.toFixed(2)}`;

  // Checkout loads the real cart itself — no product param needed here.
  document.querySelector('#cart-checkout-btn').href = './checkout';
}

function render() {
  const listHost = document.querySelector('#cart-items-list');
  const layout = document.querySelector('#cart-layout');
  const empty = document.querySelector('#cart-empty');
  document.querySelector('#cart-loading').classList.add('hidden');

  if (!rows.length) {
    layout.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  layout.classList.remove('hidden');
  listHost.innerHTML = rows.map(cartRowHtml).join('');
  renderSummary();
  renderIcons();
}

async function loadCart(userId) {
  const { data, error } = await supabase
    .from('cart_items')
    .select('id,quantity,added_at,product:products(id,slug,title,price,currency,cover_url,vendor_id,vendor:vendors(display_name))')
    .eq('user_id', userId)
    .order('added_at', { ascending: false });

  if (error) {
    toast('Could not load your cart.', 'error');
    rows = [];
    return;
  }
  // A product can be deleted after it was added — drop orphaned rows quietly.
  rows = (data || []).filter((r) => r.product);
}

async function updateQuantity(rowId, delta) {
  const row = rows.find((r) => r.id === rowId);
  if (!row) return;
  const nextQty = Math.min(20, Math.max(1, row.quantity + delta));
  if (nextQty === row.quantity) return;

  row.quantity = nextQty;
  render();
  const { error } = await supabase.from('cart_items').update({ quantity: nextQty }).eq('id', rowId);
  if (error) toast('Could not update quantity.', 'error');
}

async function removeRow(rowId) {
  rows = rows.filter((r) => r.id !== rowId);
  render();
  const { error } = await supabase.from('cart_items').delete().eq('id', rowId);
  if (error) {
    toast('Could not remove that item.', 'error');
  } else {
    refreshCartBadges();
  }
}

document.querySelector('#cart-items-list')?.addEventListener('click', (event) => {
  const rowEl = event.target.closest('[data-cart-row]');
  if (!rowEl) return;
  const rowId = rowEl.dataset.cartRow;

  if (event.target.closest('[data-qty="inc"]')) updateQuantity(rowId, 1);
  else if (event.target.closest('[data-qty="dec"]')) updateQuantity(rowId, -1);
  else if (event.target.closest('[data-remove]')) removeRow(rowId);
});

async function init() {
  mountHeader();
  mountFooter();

  const { user } = await getAccount();
  if (!user) {
    location.href = `./auth?mode=signin&next=${encodeURIComponent('cart')}`;
    return;
  }

  await loadCart(user.id);
  render();
  refreshCartBadges();
  finishPageLoader();
}

init().catch(() => finishPageLoader());
