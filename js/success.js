/**
 * Order status / return page.
 *
 * Reached from a payment provider redirect, which is never trusted as proof
 * of payment — the order is only "paid" once the server has said so. This
 * page polls the database and listens on Realtime until that happens, then
 * exchanges the token for a signed download URL.
 */

import { supabase } from './client.js';
import { $ } from './dom.js';
import { icon } from './icons.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy } from './ui.js';

initTheme();
mountHeader();
mountFooter();

const q = new URLSearchParams(location.search);
let token = q.get('token');
let orderId = q.get('order_id');
const txRef = q.get('tx_ref');
const statusParam = (q.get('status') || '').toLowerCase().trim();

const iconEl = $('#status-icon');
const eyebrow = $('#status-eyebrow');
const title = $('#status-title');
const copy = $('#status-copy');
const area = $('#download-area');

let pollTimer = null;
let pollAttempts = 0;
const MAX_POLL_ATTEMPTS = 15; // 15 x 2.5s = ~37s

function paintIcon(name, tone) {
  iconEl.className = tone;
  iconEl.innerHTML = icon(name, 40);
}

function showState(type, data = {}) {
  if (type === 'cancelled') {
    paintIcon('xCircle', 'warn');
    eyebrow.textContent = 'Transaction cancelled';
    title.textContent = 'Payment cancelled';
    copy.textContent = 'You cancelled the payment transaction. No charges were made to your account or payment method.';
    area.innerHTML = `
      <div class="row row-4 justify-center wrap">
        <a href="./checkout.html" class="btn btn--primary">${icon('refresh', 14)}<span>Try checkout again</span></a>
        <a href="./store.html" class="btn">${icon('arrowLeft', 14)}<span>Return to catalog</span></a>
      </div>`;
  } else if (type === 'failed') {
    paintIcon('alertCircle', 'danger');
    eyebrow.textContent = 'Payment not completed';
    title.textContent = 'Payment incomplete';
    copy.textContent = data.message || 'Your payment could not be confirmed by the payment gateway. If funds were deducted, please contact support with your payment reference.';
    area.innerHTML = `
      <div class="row row-4 justify-center wrap">
        <a href="./checkout.html" class="btn btn--primary">${icon('refresh', 14)}<span>Try again</span></a>
        <a href="./support.html" class="btn">${icon('support', 14)}<span>Contact support</span></a>
      </div>`;
  } else if (type === 'processing') {
    paintIcon('clock', 'muted');
    eyebrow.textContent = 'Verifying payment';
    title.textContent = 'Confirming your transaction…';
    copy.textContent = data.message || 'We are verifying your transaction with the payment network. Your download will appear automatically in a few seconds.';
    area.innerHTML = `
      <div class="stack-4">
        <div class="progress" style="max-width: 220px; margin-inline: auto"></div>
        <div class="row row-4 justify-center wrap">
          <button id="manual-verify-btn" class="btn btn--sm" type="button">${icon('refresh', 13)}<span>Check status now</span></button>
          <a href="./account.html" class="btn btn--sm">${icon('package', 13)}<span>View account orders</span></a>
        </div>
      </div>`;
    $('#manual-verify-btn')?.addEventListener('click', async (event) => {
      setBusy(event.currentTarget, true, 'Checking…');
      await checkPaymentStatus();
      setBusy(event.currentTarget, false);
    });
  } else if (type === 'paid') {
    paintIcon('checkCircle', 'ok');
    eyebrow.textContent = 'Payment successful';
    title.textContent = 'Payment confirmed';
    copy.textContent = 'Thank you for your purchase. Your digital product is ready for instant download.';
    const directUrl = data.url.includes('download=') ? data.url : `${data.url}${data.url.includes('?') ? '&' : '?'}download=`;
    area.innerHTML = `
      <div class="stack-3">
        <a href="${directUrl}" download class="btn btn--lg btn--primary">${icon('download', 16)}<span>Download your product</span></a>
        <a href="./account.html" class="btn btn--link t-12">${icon('inbox', 13)}<span>View in my account downloads</span></a>
      </div>`;
    toast('Your protected download is ready.');
  }
}

async function tryFetchDownload(t = token, oId = orderId) {
  try {
    const { data, error } = await supabase.functions.invoke('download-book', {
      body: { token: t, order_id: oId },
    });
    if (!error && data?.url) {
      if (pollTimer) clearInterval(pollTimer);
      showState('paid', { url: data.url });
      return true;
    }
  } catch {
    /* keep polling */
  }
  return false;
}

async function checkPaymentStatus() {
  pollAttempts++;

  if (token || orderId) {
    const ready = await tryFetchDownload(token, orderId);
    if (ready) return;
  }

  let query = supabase.from('orders').select('id,status,provider_reference');
  if (orderId) query = query.eq('id', orderId);
  else if (txRef) query = query.eq('provider_reference', txRef);
  else {
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
      if (!ready) showState('paid', { url: './account.html' });
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

  if (pollAttempts >= MAX_POLL_ATTEMPTS) {
    if (pollTimer) clearInterval(pollTimer);
    showState('processing', {
      message: 'Your payment is still finalizing with the network. Please allow 1–2 minutes, then visit your account downloads.',
    });
  }
}

async function run() {
  if (statusParam === 'cancelled' || statusParam === 'canceled') {
    showState('cancelled');
    bootDone();
    return;
  }
  if (['failed', 'mismatch', 'error', 'config_error', 'order_not_found'].includes(statusParam)) {
    showState('failed');
    bootDone();
    return;
  }
  if (token) {
    const ready = await tryFetchDownload(token, orderId);
    if (ready) {
      bootDone();
      return;
    }
  }

  showState('processing');
  bootDone();
  await checkPaymentStatus();

  if (orderId || txRef) {
    const channel = supabase
      .channel('order-status-sync')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders' },
        async (payload) => {
          const updated = payload.new;
          if (!updated || (updated.id !== orderId && updated.provider_reference !== txRef)) return;
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
        },
      )
      .subscribe();
  }

  pollTimer = setInterval(checkPaymentStatus, 2500);
}

run();
