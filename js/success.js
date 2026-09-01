import { supabase } from "./client.js";
import { escapeHtml, finishPageLoader, icon, mountFooter, mountHeader, renderIcons, toast } from './ui.js';

mountHeader();
mountFooter();

const q = new URLSearchParams(location.search);
let token = q.get("token");
let orderId = q.get("order_id");
const txRef = q.get("tx_ref");
const txId = q.get("transaction_id");
const statusParam = (q.get("status") || '').toLowerCase().trim();

const iconContainer = document.querySelector("#status-icon-container");
const iconSpan = document.querySelector("#status-icon");
const eyebrow = document.querySelector("#status-eyebrow");
const title = document.querySelector("#status-title");
const copy = document.querySelector("#status-copy");
const area = document.querySelector("#download-area");

let pollTimer = null;
let pollAttempts = 0;
const MAX_POLL_ATTEMPTS = 15; // 15 x 2.5s = ~37s

// Icon container color only changes by state — layout (.success-icon) stays.
const ICON_STATE_STYLE = {
  cancelled: { background: 'var(--warning-bg)', color: '#b45309' },
  failed: { background: 'var(--danger-bg)', color: 'var(--danger)' },
  processing: { background: 'var(--info-bg)', color: 'var(--info)' },
  paid: { background: 'var(--success-bg)', color: '#2dab66' },
};

function setIconState(type) {
  if (!iconContainer) return;
  const style = ICON_STATE_STYLE[type] || {};
  iconContainer.style.background = style.background || '';
  iconContainer.style.color = style.color || '';
  iconContainer.classList.toggle('animate-pulse', type === 'processing');
}

async function renderCrossSell(category, excludeId) {
  const host = document.querySelector('#success-cross-sell-grid');
  const section = document.querySelector('#success-cross-sell');
  if (!host || !section) return;

  const { data } = await supabase.from('products')
    .select('id,slug,title,price,original_price,currency,cover_url,is_featured')
    .eq('is_published', true).eq('category', category || '').neq('id', excludeId || '')
    .order('purchase_count', { ascending: false }).limit(4);

  const items = data || [];
  if (!items.length) return;

  section.classList.remove('hidden');
  host.innerHTML = items.map((p) => {
    const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
    return `
      <a class="catalog-card is-clickable" href="./product/${encodeURIComponent(p.slug)}">
        <span class="catalog-card__media">
          ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">` : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`}
        </span>
        <span class="catalog-card__body">
          <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        </span>
        <span class="catalog-card__foot">
          <span class="catalog-card__price">
            ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
            <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
          </span>
          <span class="catalog-card__go">${icon('arrow-right', 15)}</span>
        </span>
      </a>`;
  }).join('');
  renderIcons();
}

async function renderOrderDetails(oId) {
  const { data: order } = await supabase.from('orders')
    .select('order_no,amount,currency,order_items(title_snapshot,quantity,unit_price,product_id,products(category))')
    .eq('id', oId).maybeSingle();
  if (!order) return null;

  if (copy) {
    copy.textContent = `Order ${order.order_no} processed successfully. Your files are now instantly ready.`;
  }

  const items = order.order_items || [];
  if (items.length) {
    const listHtml = `
      <div class="success-download-list">
        ${items.map((it) => `
          <div class="success-download-item">
            <span class="success-download-item__icon">${icon('file-check-2', 24)}</span>
            <span class="success-download-item__meta">
              <strong>${escapeHtml(it.title_snapshot)}</strong>
              <span>Qty ${it.quantity} · ${order.currency} ${Number(it.unit_price).toFixed(2)}</span>
            </span>
          </div>`).join('')}
      </div>
      <p class="success-note">* Download links are delivered below and valid for a limited time.</p>`;
    area.insertAdjacentHTML('afterbegin', listHtml);
  }

  const firstCategory = items[0]?.products?.category;
  const firstProductId = items[0]?.product_id;
  return { firstCategory, firstProductId };
}

function showState(type, data = {}) {
  setIconState(type);

  if (type === 'cancelled') {
    if (iconSpan) iconSpan.innerHTML = icon('x-circle', 28);
    if (eyebrow) eyebrow.textContent = 'TRANSACTION CANCELLED';
    if (title) title.textContent = "Payment Cancelled";
    if (copy) copy.textContent = "You cancelled the payment transaction. No charges were made to your account or payment method.";
    if (area) {
      area.innerHTML = `
        <div class="flex flex-wrap justify-center gap-3 mt-6">
          <a href="./checkout" class="button button-primary !min-h-10 !px-6 text-sm inline-flex items-center gap-2">
            <i data-lucide="refresh-cw" width="16" height="16"></i><span>Try Checkout Again</span>
          </a>
          <a href="./store" class="button !min-h-10 !px-6 text-sm inline-flex items-center gap-2">
            <i data-lucide="arrow-left" width="16" height="16"></i><span>Return to Catalog</span>
          </a>
        </div>`;
    }
  } else if (type === 'failed') {
    if (iconSpan) iconSpan.innerHTML = icon('alert-triangle', 28);
    if (eyebrow) eyebrow.textContent = 'PAYMENT NOT COMPLETED';
    if (title) title.textContent = "Payment Incomplete";
    if (copy) copy.textContent = data.message || "Your payment could not be confirmed or verified by the payment gateway. If funds were deducted, please contact support with your payment reference.";
    if (area) {
      area.innerHTML = `
        <div class="flex flex-wrap justify-center gap-3 mt-6">
          <a href="./checkout" class="button button-primary !min-h-10 !px-6 text-sm inline-flex items-center gap-2">
            <i data-lucide="refresh-cw" width="16" height="16"></i><span>Try Again</span>
          </a>
          <a href="./support" class="button !min-h-10 !px-6 text-sm inline-flex items-center gap-2">
            <i data-lucide="life-buoy" width="16" height="16"></i><span>Contact Support</span>
          </a>
        </div>`;
    }
  } else if (type === 'processing') {
    if (iconSpan) iconSpan.innerHTML = icon('clock', 28);
    if (eyebrow) eyebrow.textContent = 'VERIFYING PAYMENT';
    if (title) title.textContent = "Confirming your transaction…";
    if (copy) copy.textContent = data.message || "We are verifying your transaction with the payment network. Your download will appear automatically in a few seconds.";
    if (area) {
      area.innerHTML = `
        <div class="mt-6 space-y-4">
          <div class="progress-track max-w-xs mx-auto"></div>
          <div class="flex flex-wrap justify-center gap-3">
            <button id="manual-verify-btn" class="button !min-h-9 !px-4 text-xs font-semibold inline-flex items-center gap-1.5">
              <i data-lucide="refresh-cw" width="13" height="13"></i><span>Check status now</span>
            </button>
            <a href="./account" class="button !min-h-9 !px-4 text-xs inline-flex items-center gap-1.5">
              <i data-lucide="package" width="13" height="13"></i><span>View Account Orders</span>
            </a>
          </div>
        </div>`;
      document.querySelector('#manual-verify-btn')?.addEventListener('click', checkPaymentStatus);
    }
  } else if (type === 'paid') {
    if (iconSpan) iconSpan.innerHTML = icon('check-circle-2', 28);
    if (eyebrow) eyebrow.textContent = 'PAYMENT SUCCESSFUL';
    if (title) title.textContent = "Order Confirmed!";
    if (copy) copy.textContent = "Thank you for your purchase! Your digital product is ready for instant download.";
    if (area) {
      const directUrl = data.url.includes('download=') ? data.url : (data.url.includes('?') ? `${data.url}&download=` : `${data.url}?download=`);
      area.innerHTML = `
        <div class="mt-6 space-y-4">
          <a href="${directUrl}" download class="button button-primary !min-h-11 !px-8 text-sm inline-flex items-center gap-2">
            <i data-lucide="download" width="18" height="18"></i><span>Download Your Product</span>
          </a>
          <div>
            <a href="./account" class="inline-flex items-center gap-1 text-xs font-bold" style="color:var(--text-muted)">
              <i data-lucide="archive" width="13" height="13"></i><span>View in My Account Downloads</span>
            </a>
          </div>
        </div>`;
    }
    toast('Your protected download is ready.');

    if (orderId) {
      renderOrderDetails(orderId).then((details) => {
        if (details?.firstCategory) renderCrossSell(details.firstCategory, details.firstProductId);
      });
    }
  }

  renderIcons();
  finishPageLoader();
}

async function tryFetchDownload(t = token, oId = orderId) {
  try {
    const { data, error } = await supabase.functions.invoke("download-book", {
      body: { token: t, order_id: oId },
    });
    if (!error && data?.url) {
      if (pollTimer) clearInterval(pollTimer);
      showState('paid', { url: data.url });
      return true;
    }
  } catch {}
  return false;
}

async function checkPaymentStatus() {
  pollAttempts++;

  // 1. Direct download token check
  if (token || orderId) {
    const ready = await tryFetchDownload(token, orderId);
    if (ready) return;
  }

  // 2. Query database for order by id or txRef
  let query = supabase.from('orders').select('id,status,provider_reference');
  if (orderId) query = query.eq('id', orderId);
  else if (txRef) query = query.eq('provider_reference', txRef);
  else {
    // If no identifier, stop polling
    if (pollTimer) clearInterval(pollTimer);
    showState('processing', { message: 'Awaiting confirmation. Please check your account orders in a few moments.' });
    return;
  }

  const { data: order } = await query.maybeSingle();

  if (order) {
    orderId = order.id;

    if (order.status === 'paid') {
      if (pollTimer) clearInterval(pollTimer);
      const ready = await tryFetchDownload(token, order.id);
      if (!ready) {
        showState('paid', { url: `./account` });
      }
      return;
    }

    if (order.status === 'cancelled') {
      if (pollTimer) clearInterval(pollTimer);
      showState('cancelled');
      return;
    }

    if (order.status === 'failed') {
      if (pollTimer) clearInterval(pollTimer);
      showState('failed');
      return;
    }
  }

  // If reached max polling attempts, give clear options
  if (pollAttempts >= MAX_POLL_ATTEMPTS) {
    if (pollTimer) clearInterval(pollTimer);
    showState('processing', {
      message: 'Your payment is still finalizing with the network. Please allow 1–2 minutes, then visit your Account Downloads.',
    });
  }
}

async function run() {
  // Case 1: Explicit cancellation param
  if (statusParam === 'cancelled' || statusParam === 'canceled') {
    showState('cancelled');
    return;
  }

  // Case 2: Explicit failure param
  if (['failed', 'mismatch', 'error', 'config_error', 'order_not_found'].includes(statusParam)) {
    showState('failed');
    return;
  }

  // Case 3: Token provided in URL
  if (token) {
    const ready = await tryFetchDownload(token, orderId);
    if (ready) return;
  }

  // Case 4: Start active polling and realtime listening
  showState('processing');
  await checkPaymentStatus();

  // Subscribe to Realtime DB updates on the orders table
  if (orderId || txRef) {
    const channel = supabase
      .channel('order-status-sync')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
        },
        async (payload) => {
          const updated = payload.new;
          if (updated && (updated.id === orderId || updated.provider_reference === txRef)) {
            if (updated.status === 'paid') {
              if (pollTimer) clearInterval(pollTimer);
              channel.unsubscribe();
              await tryFetchDownload(token, updated.id);
            } else if (updated.status === 'cancelled') {
              if (pollTimer) clearInterval(pollTimer);
              channel.unsubscribe();
              showState('cancelled');
            } else if (updated.status === 'failed') {
              if (pollTimer) clearInterval(pollTimer);
              channel.unsubscribe();
              showState('failed');
            }
          }
        }
      )
      .subscribe();
  }

  // Start polling interval
  pollTimer = setInterval(checkPaymentStatus, 2500);
}

run();
