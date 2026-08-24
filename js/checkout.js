/**
 * Checkout.
 *
 * The browser no longer decides what anything costs. It sends a list of
 * product ids to `create_order`, which prices the basket, validates the
 * promotion, and returns the authoritative total. The displayed figures are
 * a preview; the charged figure comes back from the database.
 */

import { supabase, getAccount, unwrap, callFunction } from './client.js';
import { CONFIG } from './config.js';
import { $, html, raw, esc, on } from './dom.js';
import { icon } from './icons.js';
import { formatMoney, discountPercent } from './format.js';
import { convertAmount, formatCurrency, getExchangeRates } from './currency.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy } from './ui.js';

initTheme();

/** Currencies Flutterwave settles in that are useful to this catalog. */
const CHARGE_CURRENCIES = ['USD', 'GBP', 'EUR', 'NGN', 'GHS', 'KES', 'UGX', 'ZAR', 'TZS', 'RWF'];

const METHODS = [
  {
    id: 'flutterwave',
    name: 'Card, bank transfer, or mobile money',
    meta: 'Visa, Mastercard, bank transfer, USSD, M-Pesa, MTN MoMo, Airtel',
    icon: 'card',
  },
  {
    id: 'nowpayments',
    name: 'Cryptocurrency',
    meta: 'Bitcoin, Ethereum, USDT, and 300+ other coins. Charged in USD.',
    icon: 'bolt',
  },
];

const FLW_CHANNELS = [
  { value: 'all', label: 'Any available method' },
  { value: 'card', label: 'Card only' },
  { value: 'banktransfer', label: 'Bank transfer' },
  { value: 'mobilemoney', label: 'Mobile money' },
  { value: 'ussd', label: 'USSD' },
];

const state = {
  items: [],
  account: { user: null },
  provider: 'flutterwave',
  chargeCurrency: 'USD',
  channel: 'all',
  cryptoCurrency: 'any',
  promoCode: null,
  quote: null,
  rates: null,
};

/* ==========================================================================
   Basket
   ========================================================================== */

/** The basket comes from `?p=` (buy now) or, failing that, the saved cart. */
async function loadBasket() {
  const key = new URLSearchParams(window.location.search).get('p');

  if (key) {
    const column = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) ? 'id' : 'slug';
    const { data } = await supabase
      .from('products')
      .select('id,slug,title,short_description,price,original_price,currency,cover_url,category,file_type')
      .eq(column, key)
      .eq('is_published', true)
      .maybeSingle();
    if (data) return [{ ...data, quantity: 1 }];
  }

  if (!state.account.user) return [];

  const { data } = await supabase
    .from('cart_items')
    .select('quantity,products(id,slug,title,short_description,price,original_price,currency,cover_url,category,file_type)')
    .order('added_at', { ascending: false });

  return (data || [])
    .filter((row) => row.products)
    .map((row) => ({ ...row.products, quantity: row.quantity }));
}

function baseCurrency() {
  return (state.items[0]?.currency || CONFIG.BASE_CURRENCY).toUpperCase();
}

function subtotal() {
  return state.items.reduce((total, item) => total + Number(item.price) * item.quantity, 0);
}

function discount() {
  return Number(state.quote?.discount_amount || 0);
}

function total() {
  return Math.max(0, subtotal() - discount());
}

/** The figure actually charged, in the currency the provider will use. */
function chargeAmount() {
  if (state.provider === 'nowpayments') return total();
  return convertAmount(total(), baseCurrency(), state.chargeCurrency, state.rates);
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function itemsMarkup() {
  return state.items
    .map((item) => {
      const off = discountPercent(item.price, item.original_price);
      return html`
        <div class="line-item" data-item="${item.id}">
          ${item.cover_url
            ? raw(`<img class="line-item__thumb" src="${esc(item.cover_url)}" alt="" loading="lazy">`)
            : raw('<span class="line-item__thumb"></span>')}
          <div class="truncate">
            <a class="line-item__title" href="./product.html?p=${encodeURIComponent(item.slug || item.id)}">${item.title}</a>
            <span class="line-item__meta">
              ${item.category || 'Digital product'}${item.file_type ? ` · ${item.file_type}` : ''}
              ${item.quantity > 1 ? ` · ×${item.quantity}` : ''}
            </span>
          </div>
          <div class="end">
            <span class="price">
              <span class="price__now t-14">${formatMoney(Number(item.price) * item.quantity, item.currency)}</span>
            </span>
            ${off > 0 ? raw(`<span class="block price__was">${esc(formatMoney(item.original_price, item.currency))}</span>`) : ''}
            ${state.items.length > 1
              ? html`<button class="btn btn--xs btn--link mt-1" type="button" data-remove="${item.id}">Remove</button>`
              : ''}
          </div>
        </div>
      `;
    })
    .join('');
}

function methodsMarkup() {
  return METHODS.map(
    (method) => html`
      <label class="method" aria-checked="${String(state.provider === method.id)}">
        <input type="radio" name="provider" value="${method.id}" ${state.provider === method.id ? 'checked' : ''}>
        <span class="fill">
          <span class="method__name">${method.name}</span>
          <span class="method__meta">${method.meta}</span>
        </span>
        ${raw(icon(method.icon))}
      </label>
    `,
  ).join('');
}

function providerOptionsMarkup() {
  if (state.provider === 'nowpayments') {
    return html`
      <div class="stack-3">
        <label class="field">
          <span class="field__label" for="crypto-currency">Pay with</span>
          <select class="select" id="crypto-currency">
            <option value="any">Choose at the payment page (300+ coins)</option>
            <option value="btc">Bitcoin (BTC)</option>
            <option value="eth">Ethereum (ETH)</option>
            <option value="usdttrc20">Tether (USDT · TRC-20)</option>
            <option value="usdterc20">Tether (USDT · ERC-20)</option>
            <option value="usdc">USD Coin (USDC)</option>
            <option value="ltc">Litecoin (LTC)</option>
            <option value="bnbbsc">BNB (BSC)</option>
            <option value="sol">Solana (SOL)</option>
          </select>
          <span class="field__hint">
            The invoice is denominated in ${baseCurrency()}. The coin amount is fixed at the payment page.
          </span>
        </label>
      </div>
    `;
  }

  return html`
    <div class="stack-3">
      <div class="row row-3">
        <label class="field fill">
          <span class="field__label" for="charge-currency">Charge in</span>
          <select class="select" id="charge-currency">
            ${raw(
              CHARGE_CURRENCIES.map(
                (code) => html`<option value="${code}" ${state.chargeCurrency === code ? 'selected' : ''}>${code}</option>`,
              ).join(''),
            )}
          </select>
        </label>
        <label class="field fill">
          <span class="field__label" for="flw-channel">Method</span>
          <select class="select" id="flw-channel">
            ${raw(
              FLW_CHANNELS.map(
                (channel) => html`
                  <option value="${channel.value}" ${state.channel === channel.value ? 'selected' : ''}>${channel.label}</option>
                `,
              ).join(''),
            )}
          </select>
        </label>
      </div>
      ${state.chargeCurrency !== baseCurrency()
        ? html`
            <p class="field__hint row row-2">
              ${raw(icon('info', 13))}
              <span>
                Indicative rate. The final ${state.chargeCurrency} amount is recalculated on our server at the
                moment the payment is created.
              </span>
            </p>
          `
        : ''}
    </div>
  `;
}

function summaryMarkup() {
  const base = baseCurrency();
  const converted = state.provider === 'flutterwave' && state.chargeCurrency !== base;

  return html`
    <div class="panel__body">
      <div class="summary-line"><span>Subtotal</span><span>${formatMoney(subtotal(), base)}</span></div>
      ${discount() > 0
        ? html`
            <div class="summary-line">
              <span>Discount${state.quote?.code ? ` · ${state.quote.code}` : ''}</span>
              <span class="ok">−${formatMoney(discount(), base)}</span>
            </div>
          `
        : ''}
      <div class="summary-line summary-line--total">
        <span>Total</span>
        <span>${formatMoney(total(), base)}</span>
      </div>
      ${converted
        ? html`
            <p class="t-12 subtle end mt-2">
              ≈ ${formatCurrency(chargeAmount(), state.chargeCurrency)} charged
            </p>
          `
        : ''}
    </div>
  `;
}

function paint() {
  const root = $('#checkout-root');

  if (!state.items.length) {
    root.innerHTML = html`
      <div class="empty" style="grid-column:1/-1">
        ${raw(icon('cart'))}
        <p class="empty__title">Your basket is empty</p>
        <p class="empty__body">Pick a product from the catalog to continue.</p>
        <a class="btn btn--sm btn--primary mt-2" href="./store.html">Browse the catalog</a>
      </div>
    `;
    return;
  }

  root.innerHTML = html`
    <div class="stack-6">
      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Your order</h2>
          <span class="t-12 muted">${String(state.items.length)} item${state.items.length === 1 ? '' : 's'}</span>
        </div>
        <div class="panel__body" id="items">${raw(itemsMarkup())}</div>
      </section>

      <section class="panel">
        <div class="panel__head"><h2 class="panel__title">Payment method</h2></div>
        <div class="panel__body stack-5">
          <div class="methods" id="methods">${raw(methodsMarkup())}</div>
          <div id="provider-options">${raw(providerOptionsMarkup())}</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head"><h2 class="panel__title">Promotion code</h2></div>
        <div class="panel__body">
          <div class="row row-2">
            <input class="input input--mono fill" id="promo-code" placeholder="WELCOME10"
                   autocomplete="off" autocapitalize="characters" value="${state.quote?.code || ''}">
            <button class="btn" type="button" id="apply-promo">Apply</button>
          </div>
          <p class="status mt-2" id="promo-status" aria-live="polite"></p>
        </div>
      </section>
    </div>

    <aside class="panel" style="position:sticky;top:calc(var(--header-h) + var(--s-6))">
      <div class="panel__head"><h2 class="panel__title">Summary</h2></div>
      <div id="summary">${raw(summaryMarkup())}</div>
      <div class="panel__body border-t stack-3">
        <button class="btn btn--lg btn--accent btn--block" type="button" id="pay">
          ${raw(icon('lock'))}<span id="pay-label">Pay ${formatMoney(total(), baseCurrency())}</span>
        </button>
        <p class="status" id="checkout-status" aria-live="polite"></p>
        <ul class="list-reset stack-2 t-12 subtle">
          <li class="row row-2">${raw(icon('shield', 13))}<span>Payment verified server-side before release</span></li>
          <li class="row row-2">${raw(icon('download', 13))}<span>Signed download link, valid for one hour</span></li>
          <li class="row row-2">${raw(icon('history', 13))}<span>Re-download any time from your library</span></li>
        </ul>
      </div>
    </aside>
  `;

  updatePayLabel();
}

function updatePayLabel() {
  const label = $('#pay-label');
  if (!label) return;
  label.textContent =
    state.provider === 'nowpayments'
      ? `Pay ${formatMoney(total(), baseCurrency())} in crypto`
      : `Pay ${formatCurrency(chargeAmount(), state.chargeCurrency)}`;
}

function repaintSummary() {
  const summary = $('#summary');
  if (summary) summary.innerHTML = summaryMarkup();
  updatePayLabel();
}

/* ==========================================================================
   Actions
   ========================================================================== */

async function applyPromo(button) {
  const input = $('#promo-code');
  const status = $('#promo-status');
  const code = input.value.trim();

  if (!code) {
    state.quote = null;
    status.textContent = 'Enter a code first.';
    status.className = 'status status--error mt-2';
    repaintSummary();
    return;
  }

  setBusy(button, true, 'Checking…');
  const { data, error } = await supabase.rpc('quote_promo_for_items', {
    p_code: code,
    p_items: state.items.map((item) => ({ product_id: item.id, quantity: item.quantity })),
  });
  setBusy(button, false);

  if (error || !data?.valid) {
    state.quote = null;
    status.textContent = data?.message || error?.message || 'That code is not available.';
    status.className = 'status status--error mt-2';
    repaintSummary();
    return;
  }

  state.quote = { code: data.code, discount_amount: Number(data.discount_amount) };
  status.textContent = `${data.code} applied — you save ${formatMoney(state.quote.discount_amount, baseCurrency())}.`;
  status.className = 'status status--ok mt-2';
  repaintSummary();
}

async function pay(button) {
  const status = $('#checkout-status');

  if (!state.account.user) {
    const next = `checkout.html${window.location.search}`;
    window.location.href = `./auth.html?next=${encodeURIComponent(next)}`;
    return;
  }

  setBusy(button, true, 'Preparing payment…');
  status.textContent = 'Creating the order…';
  status.className = 'status status--muted';

  try {
    // The database prices the basket. Anything the page displayed was a preview.
    const order = await unwrap(
      supabase.rpc('create_order', {
        p_items: state.items.map((item) => ({ product_id: item.id, quantity: item.quantity })),
        p_promo_code: state.quote?.code ?? null,
        p_billing: {},
      }),
    );

    if (!order?.id) throw new Error('The order could not be created.');

    status.textContent = 'Opening the payment page…';

    const siteUrl = /localhost|127\.0\.0\.1/.test(window.location.origin)
      ? window.location.origin
      : 'https://digistore.codeinktechnologies.com';

    const payment =
      state.provider === 'nowpayments'
        ? await callFunction('create-nowpayments-payment', {
            body: { order_id: order.id, pay_currency: state.cryptoCurrency, site_url: siteUrl },
          })
        : await callFunction('create-flutterwave-payment', {
            body: {
              order_id: order.id,
              payment_option: state.channel,
              currency: state.chargeCurrency,
              site_url: siteUrl,
            },
          });

    if (!payment?.payment_url) throw new Error(payment?.error || 'The payment page could not be opened.');

    // The order id is kept so the confirmation page can poll for its status.
    try {
      sessionStorage.setItem('digistore.pending_order', order.id);
    } catch {
      /* private mode */
    }

    window.location.href = payment.payment_url;
  } catch (error) {
    setBusy(button, false);
    status.textContent = error.message;
    status.className = 'status status--error';
    toast(error.message, 'error');
  }
}

/* ==========================================================================
   Wiring
   ========================================================================== */

function wire() {
  const root = $('#checkout-root');

  on(root, 'change', 'input[name="provider"]', (event) => {
    state.provider = event.target.value;
    document.querySelectorAll('.method').forEach((node) => {
      node.setAttribute('aria-checked', String(node.querySelector('input').checked));
    });
    $('#provider-options').innerHTML = providerOptionsMarkup();
    repaintSummary();
  });

  on(root, 'change', '#charge-currency', (event) => {
    state.chargeCurrency = event.target.value;
    $('#provider-options').innerHTML = providerOptionsMarkup();
    repaintSummary();
  });

  on(root, 'change', '#flw-channel', (event) => {
    state.channel = event.target.value;
  });

  on(root, 'change', '#crypto-currency', (event) => {
    state.cryptoCurrency = event.target.value;
  });

  on(root, 'click', '#apply-promo', (event, button) => applyPromo(button));
  on(root, 'click', '#pay', (event, button) => pay(button));

  on(root, 'click', '[data-remove]', async (event, button) => {
    const id = button.dataset.remove;
    state.items = state.items.filter((item) => item.id !== id);
    if (state.account.user) {
      await supabase.from('cart_items').delete().eq('product_id', id);
    }
    state.quote = null;
    paint();
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function main() {
  mountFooter();
  wire();

  state.account = await getAccount();
  state.items = await loadBasket();

  if (state.items.length) {
    state.chargeCurrency = baseCurrency();
    state.rates = await getExchangeRates(baseCurrency()).catch(() => null);
  }

  paint();
  await mountHeader();
  bootDone();
}

main().catch((error) => {
  console.error(error);
  toast(error.message || 'Checkout could not be loaded.', 'error');
  bootDone();
});
