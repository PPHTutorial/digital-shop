import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { convertAmount, formatCurrency, getExchangeRates } from './currency.js';

const params = new URLSearchParams(location.search);
let productId = params.get('product') || params.get('id') || params.get('slug');

/**
 * A promotion code may ride along on the product link
 * (checkout?product=slug&promo=CODE) so a campaign or affiliate link
 * lands with the discount already applied. `code` and `coupon` are accepted
 * as aliases because those are what people tend to hand-write.
 */
const linkPromoCode = (params.get('promo') || params.get('code') || params.get('coupon') || '').trim();

if (productId) {
  sessionStorage.setItem('last_selected_product', productId);
} else {
  productId = sessionStorage.getItem('last_selected_product');
}

let product = null;
let promotion = null;
let exchangeRates = null;
let selectedProvider = 'flutterwave';

// Modal elements
const descModal = document.querySelector('#description-modal');
const descContent = document.querySelector('#modal-desc-content');
const descTitle = document.querySelector('#modal-book-title');

function getActiveCurrency() {
  if (!product) return 'USD';
  if (selectedProvider === 'flutterwave') {
    return document.querySelector('#flw-currency-select')?.value || product.currency || 'USD';
  }
  return product.currency || 'USD';
}

function getCalculatedTotals() {
  if (!product) {
    return { basePrice: 0, baseDiscount: 0, baseTotal: 0, convPrice: 0, convDiscount: 0, convTotal: 0, activeCurrency: 'USD' };
  }
  const baseCurrency = (product.currency || 'USD').toUpperCase();
  const activeCurrency = getActiveCurrency().toUpperCase();

  const basePrice = Number(product.price || 0);
  const baseDiscount = Number(promotion?.discount_amount || 0);
  const baseTotal = Math.max(0, basePrice - baseDiscount);

  const convPrice = convertAmount(basePrice, baseCurrency, activeCurrency, exchangeRates);
  const convDiscount = convertAmount(baseDiscount, baseCurrency, activeCurrency, exchangeRates);
  const convTotal = convertAmount(baseTotal, baseCurrency, activeCurrency, exchangeRates);

  return { basePrice, baseDiscount, baseTotal, convPrice, convDiscount, convTotal, activeCurrency, baseCurrency };
}

function renderTotals() {
  if (!product) return;
  const { basePrice, baseDiscount, baseTotal, convPrice, convDiscount, convTotal, activeCurrency, baseCurrency } = getCalculatedTotals();

  // Summary box price
  document.querySelector('#summary-price').textContent = formatCurrency(convPrice, activeCurrency);
  const origPriceEl = document.querySelector('#summary-orig-price');
  if (product.original_price && Number(product.original_price) > Number(product.price)) {
    const convOrig = convertAmount(Number(product.original_price), baseCurrency, activeCurrency, exchangeRates);
    origPriceEl.textContent = formatCurrency(convOrig, activeCurrency);
    origPriceEl.classList.remove('hidden');
  } else {
    origPriceEl.classList.add('hidden');
  }

  // Totals breakdown
  document.querySelector('#subtotal').textContent = formatCurrency(convPrice, activeCurrency);
  document.querySelector('#total').textContent = formatCurrency(convTotal, activeCurrency);

  const discountRow = document.querySelector('#discount-row');
  discountRow.classList.toggle('hidden', !baseDiscount);
  discountRow.classList.toggle('flex', Boolean(baseDiscount));
  document.querySelector('#discount').textContent = `−${formatCurrency(convDiscount, activeCurrency)}`;

  // Conversion note if currency is converted from base
  const noteEl = document.querySelector('#conversion-note');
  if (noteEl) {
    if (activeCurrency !== baseCurrency) {
      noteEl.textContent = `Converted from ${formatCurrency(baseTotal, baseCurrency)}`;
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

function setupImageGallery(coverUrl, galleryUrls = []) {
  const allImages = [];
  if (coverUrl) allImages.push(coverUrl);
  if (Array.isArray(galleryUrls)) {
    galleryUrls.forEach((url) => {
      if (url && !allImages.includes(url)) allImages.push(url);
    });
  }

  const mainImg = document.querySelector('#main-book-img');
  const placeholder = document.querySelector('#main-book-placeholder');
  const strip = document.querySelector('#thumbnail-strip');

  if (allImages.length > 0) {
    mainImg.src = allImages[0];
    mainImg.classList.remove('hidden');
    placeholder.classList.add('hidden');

    if (allImages.length > 1) {
      strip.innerHTML = allImages.map((url, idx) => `
        <button type="button" class="thumb-btn ${idx === 0 ? 'active' : ''}" data-src="${escapeHtml(url)}">
          <img src="${escapeHtml(url)}" alt="Thumbnail ${idx + 1}">
        </button>
      `).join('');
      strip.classList.remove('hidden');

      strip.querySelectorAll('.thumb-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          strip.querySelectorAll('.thumb-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          mainImg.src = btn.dataset.src;
        });
      });
    } else {
      strip.classList.add('hidden');
    }

    // Lightbox modal setup
    const lightbox = document.querySelector('#image-lightbox-modal');
    const lightboxImg = document.querySelector('#lightbox-img');
    const lightboxTitle = document.querySelector('#lightbox-title');
    const closeLightbox = document.querySelector('#close-lightbox-btn');

    document.querySelector('#main-image-wrapper').onclick = () => {
      if (mainImg.src && !mainImg.classList.contains('hidden') && lightbox && lightboxImg) {
        lightboxImg.src = mainImg.src;
        if (lightboxTitle) lightboxTitle.textContent = product?.title || 'Product Image Preview';
        lightbox.showModal();
      }
    };

    closeLightbox?.addEventListener('click', () => lightbox?.close());
    lightbox?.addEventListener('click', (e) => {
      if (e.target === lightbox) lightbox.close();
    });
  } else {
    mainImg.classList.add('hidden');
    placeholder.classList.remove('hidden');
    placeholder.innerHTML = '<span>Digital Product</span>';
    strip.classList.add('hidden');
  }
}

function setupDescription(text, title) {
  const preview = document.querySelector('#description-preview');
  const readMoreBtn = document.querySelector('#read-more-btn');
  const trimmed = (text || '').trim();

  if (!trimmed) {
    preview.textContent = 'Digital product download with instant access upon payment completion.';
    readMoreBtn.classList.add('hidden');
    return;
  }

  preview.textContent = trimmed;

  if (trimmed.length > 250 || trimmed.split('\n').length > 5) {
    readMoreBtn.classList.remove('hidden');
    readMoreBtn.onclick = () => {
      descTitle.textContent = title || 'Book Details';
      descContent.textContent = trimmed;
      descModal.showModal();
    };
  } else {
    readMoreBtn.classList.add('hidden');
  }
}

async function load() {
  await mountHeader();
  mountFooter();
  const { user } = await getAccount();
  document.querySelector('#checkout-status').textContent = user
    ? `Signed in as ${user.email} (Encrypted session).`
    : 'Browsing as a guest — you will sign in when you pay.';

  if (!productId) {
    document.querySelector('#product-title').textContent = 'No product selected';
    document.querySelector('#description-preview').innerHTML = '<p class="text-slate-500">Please choose a book from the <a href="./#store" class="text-orange-600 underline font-bold">catalog</a> first.</p>';
    finishPageLoader();
    return;
  }

  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId);
  let query = supabase
    .from('products')
    .select('id,title,slug,category,description,price,original_price,currency,cover_url,gallery_urls,is_published');

  if (isUUID) {
    query = query.eq('id', productId);
  } else {
    query = query.eq('slug', productId);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    document.querySelector('#product-title').textContent = 'Product unavailable';
    document.querySelector('#description-preview').innerHTML = '<p class="text-red-600">This book could not be loaded or is not published yet. <a href="./#store" class="text-orange-600 underline font-bold ml-1">Browse catalog</a></p>';
    finishPageLoader();
    return;
  }

  product = data;
  productId = data.id;
  sessionStorage.setItem('last_selected_product', data.id);

  // Update address bar with clean shareable URL. A promo code that arrived on
  // the link is kept, so the address bar stays a working shareable link.
  const canonicalKey = data.slug || data.id;
  const promoSuffix = linkPromoCode ? `&promo=${encodeURIComponent(linkPromoCode)}` : '';
  if (!location.search.includes(canonicalKey)) {
    history.replaceState(null, '', `checkout?product=${encodeURIComponent(canonicalKey)}${promoSuffix}`);
  }

  // Wire share button — shares whichever promotion is currently applied, so a
  // discount can be passed on simply by sharing the page.
  const shareBtn = document.querySelector('#share-checkout-btn');
  if (shareBtn) {
    shareBtn.onclick = async () => {
      const activePromo = promotion?.code ? `&promo=${encodeURIComponent(promotion.code)}` : '';
      const canonicalUrl = `${window.location.origin}/checkout?product=${encodeURIComponent(canonicalKey)}${activePromo}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: data.title, url: canonicalUrl });
          return;
        } catch {}
      }
      navigator.clipboard.writeText(canonicalUrl);
      toast(activePromo ? 'Link copied — the promotion is included!' : 'Shareable product link copied to clipboard!');
    };
  }

  // Left Column
  document.querySelector('#product-title').textContent = data.title;
  setupImageGallery(data.cover_url, data.gallery_urls || []);
  setupDescription(data.description, data.title);

  // Category Tag
  const categoryTag = document.querySelector('#product-category-tag');
  if (categoryTag) {
    categoryTag.textContent = data.category || 'Digital Edition';
  }

  // Discount badge
  const discountBadge = document.querySelector('#discount-badge');
  if (data.original_price && Number(data.original_price) > Number(data.price)) {
    const pct = Math.round((1 - Number(data.price) / Number(data.original_price)) * 100);
    discountBadge.textContent = `${pct}% OFF`;
    discountBadge.classList.remove('hidden');
  } else {
    discountBadge.classList.add('hidden');
  }

  // Right Column Summary
  document.querySelector('#summary-title').textContent = data.title;

  const summaryThumb = document.querySelector('#summary-thumb');
  if (data.cover_url) {
    summaryThumb.src = data.cover_url;
    summaryThumb.classList.remove('hidden');
  }

  // Pre-fetch live exchange rates
  try {
    exchangeRates = await getExchangeRates(data.currency || 'USD');
  } catch {
    exchangeRates = null;
  }

  // Set default currency selection in Flutterwave dropdown if matching
  const curSelect = document.querySelector('#flw-currency-select');
  if (curSelect && data.currency) {
    const hasOption = Array.from(curSelect.options).some((o) => o.value.toUpperCase() === data.currency.toUpperCase());
    if (hasOption) curSelect.value = data.currency.toUpperCase();
  }

  renderTotals();
  renderIcons();
  finishPageLoader();

  // A code carried on the link applies itself once the product (and therefore
  // its price) is known. Runs last so a failure never blocks the page.
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
    // User changed the payment channel → auto-switch currency if needed
    const supportedCurrencies = Object.entries(currencyChannelMap)
      .filter(([, channels]) => channels.includes(method))
      .map(([cur]) => cur);

    if (method !== 'all' && method !== 'card' && !supportedCurrencies.includes(currency)) {
      const defaultCur = channelCurrencyDefault[method] || supportedCurrencies[0] || 'USD';
      flwCurrencySelect.value = defaultCur;
      toast(`Currency switched to ${defaultCur} for ${method === 'mobilemoney' ? 'Mobile Money' : method === 'ussd' ? 'USSD' : 'Bank Transfer'} compatibility.`);
    }
  } else if (source === 'currency') {
    // User changed currency → auto-switch channel if current channel is incompatible
    const allowed = currencyChannelMap[currency] || ['all', 'card'];
    if (!allowed.includes(method)) {
      flwMethodSelect.value = 'all';
      toast(`Payment channel reset — ${method} is not available for ${currency}.`);
    }
  }

  // Disable incompatible method options for current currency
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

// Wire modal close buttons
[document.querySelector('#close-desc-modal'), document.querySelector('#close-desc-modal-btn')].forEach((btn) => {
  btn?.addEventListener('click', () => descModal.close());
});

descModal?.addEventListener('click', (e) => {
  if (e.target === descModal) descModal.close();
});

// Promotion Code Application
/**
 * Validates a code against the current product and applies it to the total.
 *
 * The database is the authority here as everywhere else: `quote_promo` decides
 * whether the code is live and what it is worth. Shared by the Apply button and
 * by the `?promo=` link parameter, so a link-applied code is checked exactly as
 * strictly as a typed one — an expired or fully-redeemed code in a link fails
 * the same way, it just fails quietly rather than shouting at a fresh visitor.
 */
async function applyPromoCode(code, { button = null, fromLink = false } = {}) {
  if (!product) return false;

  const feedback = document.querySelector('#promo-feedback');
  const input = document.querySelector('#promo-code');
  const trimmed = (code || '').trim();

  if (!trimmed) {
    feedback.textContent = 'Enter a promotion code first.';
    feedback.className = 'status-line error mt-2 text-xs';
    return false;
  }

  if (button) setButtonLoading(button, true, 'Applying…');
  const { data, error } = await supabase.rpc('quote_promo', {
    p_code: trimmed,
    p_product_id: product.id,
  });
  if (button) setButtonLoading(button, false);

  const quote = Array.isArray(data) ? data[0] : data;

  if (error || !quote?.valid) {
    promotion = null;
    renderTotals();
    // A dud code in a shared link is not the visitor's fault — say it plainly
    // and let them carry on at the normal price.
    feedback.textContent = fromLink
      ? `The code in this link (${trimmed}) is no longer available.`
      : quote?.message || error?.message || 'That promotion code is not available.';
    feedback.className = 'status-line error mt-2 text-xs';
    return false;
  }

  promotion = { code: quote.code, discount_amount: Number(quote.discount_amount) };
  if (input) input.value = quote.code;
  renderTotals();

  feedback.textContent = fromLink
    ? `✓ Code ${quote.code} applied automatically.`
    : `✓ Code ${quote.code} applied: Saved!`;
  feedback.className = 'status-line success mt-2 text-xs';
  toast(fromLink ? `Promotion ${quote.code} applied automatically!` : 'Promotion applied successfully!');
  return true;
}

document.querySelector('#apply-promo').addEventListener('click', (event) => {
  applyPromoCode(document.querySelector('#promo-code').value, { button: event.currentTarget });
});

// Enter in the code field applies it, the same as pressing Apply. The field
// sits outside #checkout-form, so this cannot fall through to starting payment.
document.querySelector('#promo-code')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const button = document.querySelector('#apply-promo');
  if (button?.disabled) return; // already applying
  applyPromoCode(event.currentTarget.value, { button });
});

// Checkout Form Submission
document.querySelector('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!product) return;

  const submitBtn = document.querySelector('#pay-submit-btn');
  const feedback = document.querySelector('#checkout-feedback');
  const { user } = await getAccount();

  if (!user) {
    location.href = `./auth?mode=signin&next=${encodeURIComponent(`checkout?product=${product.id}`)}`;
    return;
  }

  setButtonLoading(submitBtn, true, 'Preparing payment…');
  feedback.textContent = 'Securing transaction session…';
  feedback.className = 'status-line mt-3 text-xs';

  const { baseTotal, convTotal, activeCurrency } = getCalculatedTotals();

  const clientSiteUrl = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
    ? window.location.origin
    : 'https://digistore.codeinktechnologies.com';

  if (selectedProvider === 'nowpayments') {
    // The database prices the order — the client only ever sends what was picked.
    const { data: order, error } = await supabase.rpc('create_order', {
      p_items: [{ product_id: product.id, quantity: 1 }],
      p_promo_code: promotion?.code || null,
    });

    if (error) {
      setButtonLoading(submitBtn, false);
      feedback.textContent = error.message;
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

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
    // Flutterwave uses converted amount and selected currency
    const paymentOption = document.querySelector('#flw-method-select')?.value || 'all';

    const { data: order, error } = await supabase.rpc('create_order', {
      p_items: [{ product_id: product.id, quantity: 1 }],
      p_promo_code: promotion?.code || null,
    });

    if (error) {
      setButtonLoading(submitBtn, false);
      feedback.textContent = error.message;
      feedback.className = 'status-line error mt-3 text-xs';
      return;
    }

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
