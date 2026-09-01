import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, icon, mountFooter, mountHeader, renderIcons, renderMarkdown, setCanonical, setJsonLd, SITE_ORIGIN, toast } from './ui.js';
import { initTabs, openModal } from './uikit.js';
import { wishlistButton, loadWishlist, paintWishlist, wireWishlist } from './wishlist.js';
import { openFileViewer } from './preview.js';
import { addToCart } from './cart-actions.js';
import { isAdListing, openLeavingInterstitial, stripAdListings } from './ad-listing.js';

// Products live at /product/<slug>. Legacy ?product=/?slug=/?id= links still
// resolve; init() rewrites the address bar to the clean path once loaded.
const params = new URLSearchParams(window.location.search);
const pathSlug = window.location.pathname.match(/^\/product\/([^/]+)\/?$/)?.[1];
const legacySlug = params.get('product') || params.get('slug') || params.get('id');
const slug = pathSlug ? decodeURIComponent(pathSlug) : legacySlug;

let product = null;
let vendor = null;
let reviews = [];
let ratingBreakdown = {};
let related = [];

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!size || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function starsHtml(value, size = 13) {
  const rounded = Math.round(value);
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<i data-lucide="star" width="${size}" height="${size}" class="${i <= rounded ? '' : 'is-empty'}"></i>`;
  }
  return out;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/* ==========================================================================
   Related product card — same visual family as store.js's, trimmed to what
   this rail needs (no quick-buy chrome duplication effort beyond that).
   ========================================================================== */
function relatedCardHtml(p) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const href = `./product/${encodeURIComponent(p.slug)}`;
  return `
    <article class="catalog-card is-clickable" data-product-id="${p.id}">
      <span class="catalog-card__media">
        ${p.cover_url
          ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
          : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`}
        ${p.is_featured ? `<span class="catalog-card__badges"><span class="catalog-card__badge catalog-card__badge--featured">Featured</span></span>` : ''}
      </span>
      ${wishlistButton(p.id, p.title)}
      <span class="catalog-card__body">
        <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        ${p.short_description ? `<span class="catalog-card__blurb">${escapeHtml(p.short_description)}</span>` : ''}
      </span>
      <span class="catalog-card__foot">
        <span class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
        </span>
        <span class="catalog-card__go">${icon('arrow-right', 15)}</span>
      </span>
      <a class="catalog-card__link" href="${href}"><span class="sr-only">${escapeHtml(p.title)}</span></a>
    </article>`;
}

/* ==========================================================================
   Render
   ========================================================================== */
function renderGallery() {
  const images = [product.cover_url, ...(Array.isArray(product.gallery_urls) ? product.gallery_urls : [])].filter(Boolean);
  const main = document.querySelector('#pd-gallery-main');
  const thumbs = document.querySelector('#pd-thumbs');

  let currentImage = images[0];
  const showImage = (url) => {
    currentImage = url;
    main.innerHTML = url
      ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(product.title)}" style="cursor:zoom-in">
         <button type="button" class="pd-gallery-zoom" aria-label="View full size"><i data-lucide="maximize-2" width="15" height="15"></i></button>`
      : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="40" height="40"></i></span>`;
    renderIcons();
  };
  showImage(images[0]);

  // Click the main image (or the zoom button) to open the zoom/pan viewer.
  main.addEventListener('click', (e) => {
    if (!currentImage) return;
    if (e.target.tagName === 'IMG' || e.target.closest('.pd-gallery-zoom')) {
      openFileViewer({ src: currentImage, name: product.title, mime: 'image/*' });
    }
  });

  if (images.length > 1) {
    thumbs.classList.remove('hidden');
    thumbs.innerHTML = images.map((url, i) => `
      <button type="button" class="pd-thumb ${i === 0 ? 'is-active' : ''}" data-src="${escapeHtml(url)}">
        <img src="${escapeHtml(url)}" alt="Thumbnail ${i + 1}">
      </button>`).join('');
    thumbs.querySelectorAll('.pd-thumb').forEach((btn) => {
      btn.addEventListener('click', () => {
        thumbs.querySelectorAll('.pd-thumb').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        showImage(btn.dataset.src);
      });
    });
  }
}

function renderInfo() {
  const adListing = isAdListing(product);

  document.querySelector('#pd-category').textContent = product.category || 'General';
  document.querySelector('#pd-title').textContent = product.title;
  document.querySelector('#pd-crumb-title').textContent = product.title;
  document.querySelector('#pd-crumb-category').textContent = product.category || 'Shop';
  document.querySelector('#pd-crumb-category').href = `./store?category=${encodeURIComponent(product.category || '')}`;
  document.title = `${product.title} | DigiStore`;

  // Products live at /product/<slug> — pin the canonical there (otherwise
  // Google folds every product into /product) and expose Product/Offer
  // structured data. prerender.mjs writes the same tags into the static file.
  const productUrl = `${SITE_ORIGIN}/product/${encodeURIComponent(product.slug || product.id)}`;
  setCanonical(productUrl);
  const descMeta = document.querySelector('meta[name="description"]');
  if (descMeta && product.short_description) descMeta.setAttribute('content', product.short_description);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${product.title} | DigiStore`);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', product.short_description || '');
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', `${product.title} | DigiStore`);
  document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', product.short_description || '');
  setJsonLd({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.short_description || '',
    image: product.cover_url || `${SITE_ORIGIN}/img/brand/og-image.png`,
    category: product.category || undefined,
    brand: { '@type': 'Brand', name: (vendor && vendor.display_name) || 'DigiStore' },
    offers: {
      '@type': 'Offer',
      price: Number(product.price).toFixed(2),
      priceCurrency: product.currency,
      availability: 'https://schema.org/InStock',
      url: productUrl,
    },
    ...(Number(product.rating_count) > 0 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: Number(product.rating_average).toFixed(1),
        reviewCount: product.rating_count,
      },
    } : {}),
  });

  const vendorLink = document.querySelector('#pd-vendor-link');
  if (product.vendor_id && vendor) {
    vendorLink.textContent = vendor.display_name;
    vendorLink.href = `./store?vendor=${encodeURIComponent(vendor.vendor_slug)}`;
  } else {
    vendorLink.textContent = 'DigiStore Official';
    vendorLink.removeAttribute('href');
  }

  if (Number(product.rating_count) > 0) {
    document.querySelector('#pd-rating').classList.remove('hidden');
    document.querySelector('#pd-rating-sep').classList.remove('hidden');
    document.querySelector('#pd-rating .pd-stars').innerHTML = starsHtml(product.rating_average);
    document.querySelector('#pd-rating-count').textContent = `(${product.rating_count})`;
  }

  const hasDiscount = product.original_price && Number(product.original_price) > Number(product.price);
  document.querySelector('#pd-price-current').textContent = `${product.currency} ${Number(product.price).toFixed(2)}`;
  if (hasDiscount) {
    const pct = Math.round((1 - Number(product.price) / Number(product.original_price)) * 100);
    document.querySelector('#pd-price-original').textContent = `${product.currency} ${Number(product.original_price).toFixed(2)}`;
    document.querySelector('#pd-price-original').classList.remove('hidden');
    document.querySelector('#pd-price-save').textContent = `SAVE ${pct}%`;
    document.querySelector('#pd-price-save').classList.remove('hidden');
  }
  document.querySelector('#pd-price-note').textContent = adListing
    ? 'External listing — you leave DigiStore to visit the seller’s own site. DigiStore does not process this transaction or deliver files for it.'
    : product.delivery_note
      ? product.delivery_note
      : 'Instant delivery to your secure DigiStore vault after payment.';

  const specs = [];
  specs.push({ icon: 'file-badge-2', label: 'License', value: (product.license_type || 'single-seat').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ' License' });
  const sizeLabel = formatFileSize(product.file_size_bytes);
  specs.push({ icon: 'file-type', label: 'Format', value: [product.file_type ? String(product.file_type).toUpperCase() : null, sizeLabel].filter(Boolean).join(' • ') || 'Digital file' });
  specs.push({ icon: 'download-cloud', label: 'Delivery', value: 'Instant digital download' });
  document.querySelector('#pd-specs').innerHTML = specs.map((s) => `
    <div class="pd-spec">
      <span class="pd-spec__icon">${icon(s.icon, 17)}</span>
      <span>
        <span class="pd-spec__label">${escapeHtml(s.label)}</span>
        <span class="pd-spec__value">${escapeHtml(s.value)}</span>
      </span>
    </div>`).join('');

  const buyBtn = document.querySelector('#pd-buy-btn');
  document.querySelector('#pd-wish-slot').innerHTML = wishlistButton(product.id, product.title).replace('class="wishbtn"', 'class="wishbtn pd-wish-btn-lg"');

  if (adListing) {
    // External destination — the CTA is a guarded click-through, not a checkout.
    buyBtn.innerHTML = '<i data-lucide="external-link" width="18" height="18"></i><span>Visit site</span>';
    buyBtn.href = product.external_url;
    buyBtn.target = '_blank';
    buyBtn.rel = 'noopener noreferrer';
    buyBtn.addEventListener('click', (event) => {
      event.preventDefault();
      openLeavingInterstitial({ url: product.external_url, title: product.title });
    });
    document.querySelector('#pd-add-cart-btn')?.remove();
  } else {
    buyBtn.href = `./checkout?product=${encodeURIComponent(product.slug)}`;
    document.querySelector('#pd-add-cart-btn')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      await addToCart(product.id, 1);
      btn.disabled = false;
    });
  }

  document.querySelector('#pd-description').innerHTML = product.description
    ? renderMarkdown(product.description)
    : '<p>No description provided for this product yet.</p>';
  document.querySelector('#pd-description').classList.toggle('is-muted', !product.description);
  document.querySelector('#pd-included').textContent = product.delivery_note || `${product.title} — delivered instantly as a ${product.file_type ? String(product.file_type).toUpperCase() : 'digital'} file to your DigiStore account after payment.`;

  renderIcons();
}

function renderReviews() {
  const count = reviews.length;
  document.querySelector('#pd-tab-review-count').textContent = String(count);

  const avg = product.rating_average;
  document.querySelector('#pd-rating-big').textContent = avg != null ? avg.toFixed(1) : '—';
  document.querySelector('#pd-rating-big-stars').innerHTML = avg != null ? starsHtml(avg) : '';
  document.querySelector('#pd-rating-panel-count').textContent = count ? `${count} review${count === 1 ? '' : 's'}` : 'No reviews yet';

  const barsHost = document.querySelector('#pd-rating-bars');
  barsHost.innerHTML = [5, 4, 3, 2, 1].map((star) => {
    const n = Number(ratingBreakdown[star] || 0);
    const pct = count ? Math.round((n / count) * 100) : 0;
    return `
      <div class="pd-bar-row">
        <span class="pd-bar-label">${star}★</span>
        <span class="pd-bar-track"><span class="pd-bar-fill" style="width:${pct}%"></span></span>
        <span class="pd-bar-pct">${pct}%</span>
      </div>`;
  }).join('');

  const listHost = document.querySelector('#pd-reviews-list');
  if (!count) {
    listHost.innerHTML = `<div class="soft-panel p-8 text-center" style="color:var(--text-muted)">Be the first to review this product.</div>`;
  } else {
    listHost.innerHTML = reviews.map((r) => `
      <div class="pd-review-card">
        <div class="pd-review-head">
          <div class="pd-review-who">
            <span class="pd-review-name">${escapeHtml(r.reviewer_name)}</span>
            <span class="pd-review-verified">Verified Buyer</span>
          </div>
          <span class="pd-review-date">${timeAgo(r.created_at)}</span>
        </div>
        <span class="pd-stars">${starsHtml(r.rating, 12)}</span>
        ${r.title ? `<h4 class="pd-review-title">${escapeHtml(r.title)}</h4>` : ''}
        ${r.body ? `<p class="pd-review-body">${escapeHtml(r.body)}</p>` : ''}
      </div>`).join('');
  }
  renderIcons();
}

function renderRelated() {
  if (!related.length) return;
  document.querySelector('#pd-related').classList.remove('hidden');
  document.querySelector('#pd-related-grid').innerHTML = related.map(relatedCardHtml).join('');
  renderIcons();
}

/* ==========================================================================
   Write a review
   ========================================================================== */
async function openReviewModal() {
  const { user } = await getAccount();
  if (!user) {
    const next = window.location.pathname.replace(/^\/+/, '') + window.location.search;
    window.location.href = `./auth?mode=signin&next=${encodeURIComponent(next)}`;
    return;
  }

  const { data: existing } = await supabase.from('reviews')
    .select('id,rating,title,body,status').eq('product_id', product.id).eq('user_id', user.id).maybeSingle();

  if (existing && existing.status !== 'pending') {
    toast('You already reviewed this product.', 'info');
    return;
  }

  const { count } = await supabase.from('order_items')
    .select('id, order:orders!inner(status,user_id)', { count: 'exact', head: true })
    .eq('product_id', product.id).eq('order.user_id', user.id).eq('order.status', 'paid');

  if (!count && !existing) {
    toast('Only verified buyers can review this product.', 'error');
    return;
  }

  let selectedRating = existing?.rating || 5;
  const starBtn = (n) => `<button type="button" data-star="${n}" class="${n <= selectedRating ? 'is-active' : ''}">${icon('star', 26)}</button>`;

  const { dialog, close } = openModal({
    title: existing ? 'Edit your review' : 'Write a review',
    body: `
      <form id="pd-review-form" class="space-y-4">
        <div class="pd-review-field">
          <label>Your rating</label>
          <div class="pd-star-picker" id="pd-star-picker">${[1, 2, 3, 4, 5].map(starBtn).join('')}</div>
        </div>
        <div class="pd-review-field">
          <label for="pd-review-title-input">Title (optional)</label>
          <input id="pd-review-title-input" class="field !mt-0" type="text" maxlength="120" value="${escapeHtml(existing?.title || '')}">
        </div>
        <div class="pd-review-field">
          <label for="pd-review-body-input">Review</label>
          <textarea id="pd-review-body-input" class="field !mt-0" rows="4" maxlength="2000">${escapeHtml(existing?.body || '')}</textarea>
        </div>
      </form>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Cancel</button>
      <button type="submit" form="pd-review-form" class="button button-primary">${existing ? 'Save changes' : 'Submit review'}</button>
    `,
  });

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', close);
  dialog.querySelectorAll('[data-star]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedRating = Number(btn.dataset.star);
      dialog.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.star) <= selectedRating));
    });
  });

  dialog.querySelector('#pd-review-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = dialog.querySelector('#pd-review-title-input').value.trim();
    const body = dialog.querySelector('#pd-review-body-input').value.trim();
    const submitBtn = dialog.querySelector('button[type=submit]');
    submitBtn.disabled = true;

    const payload = { product_id: product.id, user_id: user.id, rating: selectedRating, title: title || null, body: body || null, status: 'pending' };
    const { error } = existing
      ? await supabase.from('reviews').update(payload).eq('id', existing.id)
      : await supabase.from('reviews').insert(payload);

    submitBtn.disabled = false;
    if (error) {
      toast(error.message || 'That review could not be saved.', 'error');
      return;
    }
    toast('Thanks! Your review is pending moderation.');
    close();
  });
}

async function init() {
  mountHeader();
  mountFooter();

  if (!slug) {
    document.querySelector('#pd-loading').classList.add('hidden');
    document.querySelector('#pd-not-found').classList.remove('hidden');
    finishPageLoader();
    return;
  }

  // tools/prerender.mjs bakes the listing into product/<slug>.html. If that
  // markup is present, a failed fetch keeps it visible rather than flashing
  // "not found"; otherwise this behaves as a normal client render.
  const prerendered = document.querySelector('#pd-content')?.dataset.prerendered === 'true';

  const { data, error } = await supabase.rpc('product_detail', { p_slug: slug });

  document.querySelector('#pd-loading').classList.add('hidden');

  if (error || !data?.product) {
    if (prerendered) { finishPageLoader(); return; }
    document.querySelector('#pd-not-found').classList.remove('hidden');
    finishPageLoader();
    return;
  }

  product = data.product;
  vendor = data.vendor;
  reviews = data.reviews || [];
  ratingBreakdown = data.rating_breakdown || {};
  related = stripAdListings(data.related || []);

  // Clean a legacy ?product=/?id= URL up to /product/<slug> now that we know it.
  if (legacySlug && !pathSlug && product.slug) {
    window.history.replaceState(null, '', `/product/${encodeURIComponent(product.slug)}`);
  }

  document.querySelector('#pd-content').classList.remove('hidden');

  renderGallery();
  renderInfo();
  renderReviews();
  renderRelated();
  initTabs(document.querySelector('#pd-tabs'));

  await loadWishlist();
  wireWishlist(document.querySelector('#pd-content'));
  paintWishlist(document.querySelector('#pd-content'));

  document.querySelector('#pd-write-review-btn')?.addEventListener('click', openReviewModal);

  finishPageLoader();
}

init().catch(() => finishPageLoader());
