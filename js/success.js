import { supabase } from "./client.js";
import { finishPageLoader, icon, mountFooter, mountHeader, renderIcons, toast } from './ui.js';

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

function showState(type, data = {}) {
  if (type === 'cancelled') {
    if (iconContainer) iconContainer.className = 'mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-600';
    if (iconSpan) iconSpan.innerHTML = icon('x-circle', 32);
    if (eyebrow) eyebrow.textContent = 'TRANSACTION CANCELLED';
    if (title) title.textContent = "Payment Cancelled";
    if (copy) copy.textContent = "You cancelled the payment transaction. No charges were made to your account or payment method.";
    if (area) {
      area.innerHTML = `
        <div class="flex flex-wrap justify-center gap-3">
          <a href="./checkout" class="inline-flex items-center gap-2 rounded-full bg-orange-600 px-7 py-3 font-bold text-white hover:bg-orange-500 transition-colors">
            <i data-lucide="refresh-cw" width="16" height="16"></i>
            <span>Try Checkout Again</span>
          </a>
          <a href="./store" class="inline-flex items-center gap-2 rounded-full bg-slate-950 px-7 py-3 font-bold text-white hover:bg-slate-800 transition-colors">
            <i data-lucide="arrow-left" width="16" height="16"></i>
            <span>Return to Catalog</span>
          </a>
        </div>`;
    }
  } else if (type === 'failed') {
    if (iconContainer) iconContainer.className = 'mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600';
    if (iconSpan) iconSpan.innerHTML = icon('alert-triangle', 32);
    if (eyebrow) eyebrow.textContent = 'PAYMENT NOT COMPLETED';
    if (title) title.textContent = "Payment Incomplete";
    if (copy) copy.textContent = data.message || "Your payment could not be confirmed or verified by the payment gateway. If funds were deducted, please contact support with your payment reference.";
    if (area) {
      area.innerHTML = `
        <div class="flex flex-wrap justify-center gap-3">
          <a href="./checkout" class="inline-flex items-center gap-2 rounded-full bg-orange-600 px-7 py-3 font-bold text-white hover:bg-orange-500 transition-colors">
            <i data-lucide="refresh-cw" width="16" height="16"></i>
            <span>Try Again</span>
          </a>
          <a href="./support" class="inline-flex items-center gap-2 rounded-full bg-slate-950 px-7 py-3 font-bold text-white hover:bg-slate-800 transition-colors">
            <i data-lucide="life-buoy" width="16" height="16"></i>
            <span>Contact Support</span>
          </a>
        </div>`;
    }
  } else if (type === 'processing') {
    if (iconContainer) iconContainer.className = 'mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-blue-600 animate-pulse';
    if (iconSpan) iconSpan.innerHTML = icon('clock', 32);
    if (eyebrow) eyebrow.textContent = 'VERIFYING PAYMENT';
    if (title) title.textContent = "Confirming your transaction…";
    if (copy) copy.textContent = data.message || "We are verifying your transaction with the payment network. Your download will appear automatically in a few seconds.";
    if (area) {
      area.innerHTML = `
        <div class="space-y-4">
          <div class="progress-track max-w-xs mx-auto"></div>
          <div class="flex flex-wrap justify-center gap-3">
            <button id="manual-verify-btn" class="button !min-h-9 !px-4 text-xs font-semibold inline-flex items-center gap-1.5">
              <i data-lucide="refresh-cw" width="13" height="13"></i>
              <span>Check status now</span>
            </button>
            <a href="./account" class="button !min-h-9 !px-4 text-xs inline-flex items-center gap-1.5">
              <i data-lucide="package" width="13" height="13"></i>
              <span>View Account Orders</span>
            </a>
          </div>
        </div>`;
      document.querySelector('#manual-verify-btn')?.addEventListener('click', checkPaymentStatus);
    }
  } else if (type === 'paid') {
    if (iconContainer) iconContainer.className = 'mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-600 shadow-md shadow-green-200';
    if (iconSpan) iconSpan.innerHTML = icon('check-circle-2', 32);
    if (eyebrow) eyebrow.textContent = 'PAYMENT SUCCESSFUL';
    if (title) title.textContent = "Payment Confirmed!";
    if (copy) copy.textContent = "Thank you for your purchase! Your digital product is ready for instant download. Your access token is valid for immediate access.";
    if (area) {
      const directUrl = data.url.includes('download=') ? data.url : (data.url.includes('?') ? `${data.url}&download=` : `${data.url}?download=`);
      area.innerHTML = `
        <div class="space-y-4">
          <a href="${directUrl}" download class="inline-flex items-center gap-2 rounded-full bg-orange-600 px-8 py-3.5 font-bold text-white hover:bg-orange-500 shadow-lg shadow-orange-600/30 transition-all hover:scale-105">
            <i data-lucide="download" width="18" height="18"></i>
            <span>Download Your Product</span>
          </a>
          <div>
            <a href="./account" class="inline-flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-900 underline">
              <i data-lucide="archive" width="13" height="13"></i>
              <span>View in My Account Downloads</span>
            </a>
          </div>
        </div>`;
    }
    toast('Your protected download is ready.');
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
