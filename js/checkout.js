import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { convertAmount, formatCurrency, getExchangeRates } from './currency.js';
import { refreshCartBadges } from './cart-actions.js';
import { enhanceSelects } from './select.js';
import { enhanceRadios } from './form-controls.js';
import { AD_LISTING_COLS, isAdListing } from './ad-listing.js';

enhanceSelects('#flw-currency-select, #flw-method-select, #crypto-currency-select', {
  'flw-currency-select': 'Pay in your currency',
  'flw-method-select': 'Payment channel',
  'crypto-currency-select': 'Cryptocurrency',
});
enhanceRadios('input[name="payment_provider"]');

const params = new URLSearchParams(location.search);
const directSlug = params.get('product') || params.get('id') || params.get('slug');
const directQty = Math.max(1, Math.min(20, parseInt(params.get('qty') || '1', 10) || 1));

/**
 * A promotion code may ride along on the checkout link
 * (checkout?promo=CODE) so a campaign or affiliate link
 * lands with the discount already applied.
 */
const linkPromoCode = (params.get('promo') || params.get('code') || params.get('coupon') || '').trim();

// Each entry: { cart_row_id?, product_id, slug, title, cover_url, currency, unit_price, quantity }
let items = [];
let fromCart = false;
let baseCurrency = 'USD';
let promotion = null;
let exchangeRates = null;
let selectedProvider = 'flutterwave';

function subtotalBase() {
  return items.reduce((sum, it) => sum + Number(it.unit_price) * it.quantity, 0);
}

function getActiveCurrency() {
  if (selectedProvider === 'flutterwave') {
    return document.querySelector('#flw-currency-select')?.value || baseCurrency;
  }
  return baseCurrency;
}

function getCalculatedTotals() {
  const activeCurrency = getActiveCurrency().toUpperCase();
  const basePrice = subtotalBase();
  const baseDiscount = Number(promotion?.discount_amount || 0);
  const baseTotal = Math.max(0, basePrice - baseDiscount);

  const convPrice = convertAmount(basePrice, baseCurrency, activeCurrency, exchangeRates);
  const convDiscount = convertAmount(baseDiscount, baseCurrency, activeCurrency, exchangeRates);
  const convTotal = convertAmount(baseTotal, baseCurrency, activeCurrency, exchangeRates);

  return { basePrice, baseDiscount, baseTotal, convPrice, convDiscount, convTotal, activeCurrency, baseCurrency };
}

function renderSummaryItems() {
  document.querySelector('#checkout-summary-items').innerHTML = items.map((it) => `
    <div class="checkout-summary-item">
      ${it.cover_url ? `<img src="${escapeHtml(it.cover_url)}" alt="${escapeHtml(it.title)}">` : `<span></span>`}
      <div class="checkout-summary-item__meta">
        <strong>${escapeHtml(it.title)}</strong>
        <span>${it.quantity} × ${formatCurrency(Number(it.unit_price), it.currency)}</span>
      </div>
      <span class="checkout-summary-item__price">${formatCurrency(Number(it.unit_price) * it.quantity, it.currency)}</span>
    </div>`).join('');
}

function renderTotals() {
  if (!items.length) return;
  const { baseDiscount, baseTotal, convPrice, convDiscount, convTotal, activeCurrency, baseCurrency: bc } = getCalculatedTotals();

  document.querySelector('#subtotal').textContent = formatCurrency(convPrice, activeCurrency);
  document.querySelector('#total').textContent = formatCurrency(convTotal, activeCurrency);

  const discountRow = document.querySelector('#discount-row');
  discountRow.classList.toggle('hidden', !baseDiscount);
  discountRow.classList.toggle('flex', Boolean(baseDiscount));
  document.querySelector('#discount').textContent = `−${formatCurrency(convDiscount, activeCurrency)}`;

  const noteEl = document.querySelector('#conversion-note');
  if (noteEl) {
    if (activeCurrency !== bc) {
      noteEl.textContent = `Converted from ${formatCurrency(baseTotal, bc)}`;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }
  }

  updatePayButtonLabel();
}

function updatePayButtonLabel() {
  const labelEl = document.querySelector('#pay-btn-label');
  if (!labelEl) return;

  const { convTotal, activeCurrency } = getCalculatedTotals();

  if (selectedProvider === 'flutterwave') {
    const methodSelect = document.querySelector('#flw-method-select');
    const methodVal = methodSelect?.value || 'all';
    let channelLabel = 'Card / Bank / Mobile';
    if (methodVal === 'card') channelLabel = 'Card';
    else if (methodVal === 'mobilemoney') channelLabel = 'Mobile Money';
    else if (methodVal === 'banktransfer') channelLabel = 'Bank Transfer';
    else if (methodVal === 'ussd') channelLabel = 'USSD';

    labelEl.textContent = `Pay ${formatCurrency(convTotal, activeCurrency)} with ${channelLabel}`;
  } else {
    const cryptoSelect = document.querySelector('#crypto-currency-select');
    const selectedVal = cryptoSelect?.value || 'any';
    const selectedText = cryptoSelect?.options[cryptoSelect.selectedIndex]?.text.split('—')[0].trim() || 'Crypto';

    if (selectedVal === 'any') {
      labelEl.textContent = 'Pay with Cryptocurrency (300+ coins)';
    } else {
      labelEl.textContent = `Pay with ${selectedText}`;
    }
  }
}

function showEmpty(hadDirectSlug) {
  document.querySelector('#checkout-progress').classList.add('hidden');
  document.querySelector('#checkout-grid').classList.add('hidden');
  document.querySelector('#checkout-empty-copy').textContent = hadDirectSlug
    ? 'That product could not be found or is no longer published.'
    : 'Add a digital product before checking out.';
  document.querySelector('#checkout-empty').classList.remove('hidden');
}

async function load() {
  await mountHeader();
  mountFooter();
  const { user } = await getAccount();

  if (directSlug) {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(directSlug);
    let query = supabase.from('products').select('id,slug,title,price,currency,cover_url,is_published' + AD_LISTING_COLS);
    query = isUUID ? query.eq('id', directSlug) : query.eq('slug', directSlug);
    const { data } = await query.maybeSingle();
    if (data && data.is_published && !isAdListing(data)) {
      items = [{
        product_id: data.id, slug: data.slug, title: data.title, cover_url: data.cover_url,
        currency: (data.currency || 'USD').toUpperCase(), unit_price: Number(data.price), quantity: directQty,
      }];
      fromCart = false;
    }
  } else if (user) {
    const { data } = await supabase
      .from('cart_items')
      .select('id,quantity,product:products(id,slug,title,price,currency,cover_url,is_published' + AD_LISTING_COLS + ')')
      .eq('user_id', user.id)
      .order('added_at', { ascending: false });
    items = (data || [])
      .filter((r) => r.product?.is_published && !isAdListing(r.product))
      .map((r) => ({
        cart_row_id: r.id, product_id: r.product.id, slug: r.product.slug, title: r.product.title,
        cover_url: r.product.cover_url, currency: (r.product.currency || 'USD').toUpperCase(),
        unit_price: Number(r.product.price), quantity: r.quantity,
      }));
    fromCart = true;
  }

  if (!items.length) {
    showEmpty(Boolean(directSlug));
    finishPageLoader();
    return;
  }

  // create_order requires every line item to share one currency — enforce it
  // here too so the customer sees why, instead of hitting an RPC error at submit.
  baseCurrency = items[0].currency;
  const mixedCount = items.filter((it) => it.currency !== baseCurrency).length;
  if (mixedCount) {
    items = items.filter((it) => it.currency === baseCurrency);
    toast(`${mixedCount} item${mixedCount === 1 ? '' : 's'} priced in a different currency stayed in your cart — checkout one currency at a time.`);
  }

  renderSummaryItems();

  try {
    exchangeRates = await getExchangeRates(baseCurrency);
  } catch {
    exchangeRates = null;
  }

  const curSelect = document.querySelector('#flw-currency-select');
  if (curSelect) {
    const hasOption = Array.from(curSelect.options).some((o) => o.value.toUpperCase() === baseCurrency);
    if (hasOption) curSelect.value = baseCurrency;
  }

  if (user) {
    const { data: profile } = await supabase.from('profiles').select('full_name,country').eq('id', user.id).maybeSingle();
    document.querySelector('#billing-name').value = profile?.full_name || '';
    document.querySelector('#billing-email').value = user.email || '';
    document.querySelector('#billing-country').value = profile?.country || '';
  }

  document.querySelector('#checkout-progress').classList.remove('hidden');
  document.querySelector('#checkout-grid').classList.remove('hidden');
  document.querySelector('#checkout-empty').classList.add('hidden');

  renderTotals();
  renderIcons();
  finishPageLoader();

  if (linkPromoCode) {
    document.querySelector('#promo-code').value = linkPromoCode;
    await applyPromoCode(linkPromoCode, { fromLink: true });
  }
}

// Payment method UI switching
const providerTabs = document.querySelectorAll('.payment-tab-btn');
const flwPanel = document.querySelector('#flutterwave-options-panel');
const npPanel = document.querySelector('#nowpayments-options-panel');

providerTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const radio = tab.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      selectedProvider = radio.value;

      providerTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      if (selectedProvider === 'flutterwave') {
        flwPanel?.classList.remove('hidden');
        npPanel?.classList.add('hidden');
      } else {
        flwPanel?.classList.add('hidden');
        npPanel?.classList.remove('hidden');
      }
      renderTotals();
    }
  });
});

// Real-time conversion on currency or channel change
const flwCurrencySelect = document.querySelector('#flw-currency-select');
const flwMethodSelect = document.querySelector('#flw-method-select');
const cryptoCurrencySelect = document.querySelector('#crypto-currency-select');

// Currency → Payment Channel mapping:
// Which payment channels each currency supports on Flutterwave
const currencyChannelMap = {
  USD: ['all', 'card'],
  GBP: ['all', 'card'],
  EUR: ['all', 'card'],
  CAD: ['all', 'card'],
  AUD: ['all', 'card'],
  NGN: ['all', 'card', 'banktransfer', 'ussd'],
  GHS: ['all', 'card', 'mobilemoney'],
  KES: ['all', 'card', 'mobilemoney'],
  UGX: ['all', 'card', 'mobilemoney'],
  ZAR: ['all', 'card'],
};

// Payment Channel → Best default currency
const channelCurrencyDefault = {
  mobilemoney: 'GHS',
  ussd: 'NGN',
  banktransfer: 'NGN',
};

function syncCurrencyAndMethod(source) {
  if (!flwCurrencySelect || !flwMethodSelect) return;

  const currency = flwCurrencySelect.value;
  const method = flwMethodSelect.value;

  if (source === 'method') {
    const supportedCurrencies = Object.entries(currencyChannelMap)
      .filter(([, channels]) => channels.includes(method))
      .map(([cur]) => cur);

    if (method !== 'all' && method !== 'card' && !supportedCurrencies.includes(currency)) {
      const defaultCur = channelCurrencyDefault[method] || supportedCurrencies[0] || 'USD';
      flwCurrencySelect.value = defaultCur;
      toast(`Currency switched to ${defaultCur} for ${method === 'mobilemoney' ? 'Mobile Money' : method === 'ussd' ? 'USSD' : 'Bank Transfer'} compatibility.`);
    }
  } else if (source === 'currency') {
    const allowed = currencyChannelMap[currency] || ['all', 'card'];
    if (!allowed.includes(method)) {
      flwMethodSelect.value = 'all';
      toast(`Payment channel reset — ${method} is not available for ${currency}.`);
    }
  }

  const allowed = currencyChannelMap[currency] || ['all', 'card'];
  Array.from(flwMethodSelect.options).forEach((opt) => {
    opt.disabled = !allowed.includes(opt.value);
  });
}

flwCurrencySelect?.addEventListener('change', () => {
  syncCurrencyAndMethod('currency');
  renderTotals();
});

flwMethodSelect?.addEventListener('change', () => {
  syncCurrencyAndMethod('method');
  renderTotals();
});

cryptoCurrencySelect?.addEventListener('change', () => updatePayButtonLabel());

// Promotion Code Application
/**
 * Validates a code against the full basket and applies it to the total.
 * `quote_promo_for_items` is the database's authority on whether the code is
 * live and what it's worth against this exact set of items — shared by the
 * Apply button and by the `?promo=` link parameter.
 */
async function applyPromoCode(code, { button = null, fromLink = false } = {}) {
  if (!items.length) return false;

  const feedback = document.querySelector('#promo-feedback');
  const input = document.querySelector('#promo-code');
  const trimmed = (code || '').trim();

  if (!trimmed) {
    feedback.textContent = 'Enter a promotion code first.';
    feedback.className = 'status-line error mt-2 text-xs';
    return false;
  }

  if (button) setButtonLoading(button, true, 'Applying…');
  const { data, error } = await supabase.rpc('quote_promo_for_items', {
    p_code: trimmed,
    p_items: items.map((it) => ({ product_id: it.product_id, quantity: it.quantity })),
  });
  if (button) setButtonLoading(button, false);

  if (error || !data?.valid) {
    promotion = null;
    renderTotals();
    feedback.textContent = fromLink
      ? `The code in this link (${trimmed}) is no longer available.`
      : data?.message || error?.message || 'That promotion code is not available.';
    feedback.className = 'status-line error mt-2 text-xs';
    return false;
  }

  promotion = { code: data.code, discount_amount: Number(data.discount_amount) };
  if (input) input.value = data.code;
  renderTotals();

  feedback.textContent = fromLink
    ? `✓ Code ${data.code} applied automatically.`
    : `✓ Code ${data.code} applied: Saved!`;
  feedback.className = 'status-line success mt-2 text-xs';
  toast(fromLink ? `Promotion ${data.code} applied automatically!` : 'Promotion applied successfully!');
  return true;
}

document.querySelector('#apply-promo').addEventListener('click', (event) => {
  applyPromoCode(document.querySelector('#promo-code').value, { button: event.currentTarget });
});

document.querySelector('#promo-code')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const button = document.querySelector('#apply-promo');
  if (button?.disabled) return;
  applyPromoCode(event.currentTarget.value, { button });
});

// Checkout Form Submission
document.querySelector('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!items.length) return;

  const submitBtn = document.querySelector('#pay-submit-btn');
  const feedback = document.querySelector('#checkout-feedback');
  const { user } = await getAccount();

  if (!user) {
    location.href = `./auth?mode=signin&next=${encodeURIComponent(`checkout${location.search}`)}`;
    return;
  }

  const nameEl = document.querySelector('#billing-name');
  const emailEl = document.querySelector('#billing-email');
  const countryEl = document.querySelector('#billing-country');
  const acceptEl = document.querySelector('#checkout-accept');
  if (!nameEl.reportValidity() || !emailEl.reportValidity() || !countryEl.reportValidity()) return;
  if (acceptEl && !acceptEl.reportValidity()) return;

  setButtonLoading(submitBtn, true, 'Preparing payment…');
  feedback.textContent = 'Securing transaction session…';
  feedback.className = 'status-line mt-3 text-xs';

  const { activeCurrency } = getCalculatedTotals();

  const clientSiteUrl = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
    ? window.location.origin
    : 'https://digistore.codeinktechnologies.com';

  const p_items = items.map((it) => ({ product_id: it.product_id, quantity: it.quantity }));
  const p_billing = { name: nameEl.value.trim(), email: emailEl.value.trim(), country: countryEl.value.trim() };

  // The database prices the order — the client only ever sends what was picked.
  const { data: order, error } = await supabase.rpc('create_order', {
    p_items,
    p_promo_code: promotion?.code || null,
    p_billing,
  });

  if (error) {
    setButtonLoading(submitBtn, false);
    feedback.textContent = error.message;
    feedback.className = 'status-line error mt-3 text-xs';
    return;
  }

  // Audit-only record that this buyer agreed to the terms for this order.
  supabase.rpc('record_legal_acceptance', {
    p_slugs: ['terms', 'refunds'], p_context: 'checkout', p_user_agent: navigator.userAgent,
  }).catch(() => {});

  // The order is now committed server-side — clear the matching cart rows so
  // a customer mid-payment doesn't see (and risk re-buying) the same items.
  if (fromCart) {
    const cartRowIds = items.map((it) => it.cart_row_id).filter(Boolean);
    if (cartRowIds.length) {
      await supabase.from('cart_items').delete().in('id', cartRowIds);
      refreshCartBadges();
    }
  }

  if (selectedProvider === 'nowpayments') {
    const chosenCrypto = document.querySelector('#crypto-currency-select')?.value || 'any';
    const payload = {
      order_id: order.id,
      pay_currency: chosenCrypto,
      site_url: clientSiteUrl,
    };

    const { data: payment, error: paymentError } = await supabase.functions.invoke('create-nowpayments-payment', {
      body: payload,
    });

    if (paymentError || !payment?.payment_url) {
      setButtonLoading(submitBtn, false);
      feedback.textContent = payment?.error || paymentError?.message || 'Payment could not be started.';
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    location.href = payment.payment_url;
  } else {
    const paymentOption = document.querySelector('#flw-method-select')?.value || 'all';

    const payload = {
      order_id: order.id,
      payment_option: paymentOption,
      currency: activeCurrency,
      site_url: clientSiteUrl,
    };

    const { data: payment, error: paymentError } = await supabase.functions.invoke('create-flutterwave-payment', {
      body: payload,
    });

    if (paymentError || !payment?.payment_url) {
      setButtonLoading(submitBtn, false);
      feedback.textContent = payment?.error || paymentError?.message || 'Payment could not be started.';
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

    location.href = payment.payment_url;
  }
});

load();
