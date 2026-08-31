/**
 * Ad-wallet top-up modal — shared by the seller console (js/vendor.js) and the
 * admin back-office (js/admin.js).
 *
 * The amount and the minimum are enforced by create_ad_funding() in the
 * database and again by the create-ad-funding-payment Edge Function; this modal
 * only collects an amount + a gateway and hands off to the hosted payment page.
 * The wallet is credited automatically when the payment clears, so there is
 * nothing to reconcile here on return.
 */
import { supabase } from './client.js';
import { openModal, setButtonBusy } from './uikit.js';

export const MIN_TOPUP = 25;

/**
 * Opens the top-up modal. Returns `{ dialog, close }` so a caller (e.g. a
 * product modal opening it on top of itself) can react to it closing.
 * `onClose` fires after the dialog is dismissed for any reason.
 */
export function openAdTopupModal({ onClose } = {}) {
  const { dialog, close } = openModal({
    id: 'ad-topup-modal',
    title: 'Add funds to your ad wallet',
    onClose,
    body: `
      <p style="margin-bottom:16px">Your wallet is credited automatically as soon as the payment clears.</p>
      <form id="ad-topup-form">
        <span class="label">Amount</span>
        <div class="mt-1 flex flex-wrap gap-2" id="ad-topup-presets">
          ${[25, 50, 100, 250].map((n) => `<button type="button" class="button !min-h-9 !px-4 text-xs" data-amount="${n}">$${n}</button>`).join('')}
        </div>
        <input class="field mt-3 font-bold" name="amount" type="number" step="1" min="${MIN_TOPUP}" value="${MIN_TOPUP}" required>
        <small class="help">Minimum $${MIN_TOPUP}. Enter any higher amount you like.</small>

        <div class="mt-4">
          <span class="label">Pay with</span>
          <div class="mt-2 grid gap-2">
            <label class="vnd-check-line" style="align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md)">
              <input type="radio" name="provider" value="flutterwave" checked>
              <span>
                <strong style="display:block">Card, bank transfer or mobile money</strong>
                <span style="font-size:.76rem;color:var(--text-muted)">Visa, Mastercard, bank transfer, MTN MoMo, M-Pesa</span>
              </span>
            </label>
            <label class="vnd-check-line" style="align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md)">
              <input type="radio" name="provider" value="nowpayments">
              <span>
                <strong style="display:block">Cryptocurrency</strong>
                <span style="font-size:.76rem;color:var(--text-muted)">Bitcoin, Ethereum, USDT and 300+ coins</span>
              </span>
            </label>
          </div>
        </div>
        <p id="ad-topup-feedback" class="status-line mt-3 text-xs"></p>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="ad-topup-form" class="button button-primary">Continue to payment</button>`,
  });

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', close);
  dialog.querySelector('#ad-topup-presets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-amount]');
    if (button) dialog.querySelector('#ad-topup-form').elements.amount.value = button.dataset.amount;
  });

  dialog.querySelector('#ad-topup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = dialog.querySelector('#ad-topup-feedback');
    const button = dialog.querySelector('button[form="ad-topup-form"]');
    const amount = Number(form.elements.amount.value);

    if (!Number.isFinite(amount) || amount < MIN_TOPUP) {
      feedback.textContent = `The minimum top-up is $${MIN_TOPUP}.`;
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    const provider = form.querySelector('input[name="provider"]:checked')?.value || 'flutterwave';

    setButtonBusy(button, true, 'Opening payment…');
    feedback.textContent = 'Preparing a secure payment page…';
    feedback.className = 'status-line mt-3 text-xs';

    const siteUrl = /localhost|127\.0\.0\.1/.test(window.location.origin)
      ? window.location.origin
      : 'https://digistore.codeinktechnologies.com';

    const { data, error } = await supabase.functions.invoke('create-ad-funding-payment', {
      body: { amount, provider, site_url: siteUrl },
    });

    if (error || !data?.payment_url) {
      setButtonBusy(button, false);
      feedback.textContent = data?.error || error?.message || 'The payment page could not be opened.';
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    window.location.href = data.payment_url;
  });

  return { dialog, close };
}
