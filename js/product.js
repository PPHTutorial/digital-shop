/**
 * Product detail page.
 *
 * Separated from checkout: this page sells, checkout collects payment. The
 * split means a product link can be shared without dropping the reader into a
 * payment form, and the page can be indexed.
 */

import { supabase, getAccount, unwrap } from './client.js';
import { $, html, raw, esc, on, copyText } from './dom.js';
import { icon } from './icons.js';
import { formatMoney, formatDate, formatBytes, discountPercent, relativeTime, initials } from './format.js';
import { renderBlocks, readingMinutes } from './portable-text.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy, confirmDialog } from './ui.js';
import { productCard, wireShareButtons } from './product-card.js';

initTheme();

const key = new URLSearchParams(window.location.search).get('p');
let product = null;
let account = { user: null, isAdmin: false };

/* ==========================================================================
   Data
   ========================================================================== */

async function loadProduct() {
  const column = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key || '') ? 'id' : 'slug';
  const { data, error } = await supabase
    .from('products')
    .select(
      'id,slug,title,short_description,description,category,tags,price,original_price,currency,' +
        'cover_url,gallery_urls,file_type,file_size_bytes,license_type,delivery_note,' +
        'purchase_count,rating_sum,rating_count,created_at,published_at,is_published',
    )
    .eq(column, key)
    .eq('is_published', true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function loadReviews(productId) {
  const { data } = await supabase
    .from('reviews')
    .select('id,rating,title,body,created_at,user_id,profiles:user_id(full_name)')
    .eq('product_id', productId)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(12);
  return data || [];
}

async function loadRelated(current) {
  const { data } = await supabase
    .from('products')
    .select('id,slug,title,short_description,category,price,original_price,currency,cover_url,is_featured,rating_count,rating_sum')
    .eq('is_published', true)
    .eq('category', current.category)
    .neq('id', current.id)
    .order('purchase_count', { ascending: false })
    .limit(4);

  return (data || []).map((item) => ({
    ...item,
    rating_average: item.rating_count ? Number((item.rating_sum / item.rating_count).toFixed(2)) : null,
  }));
}

/** Whether the signed-in customer already owns this product. */
async function loadOwnership(productId, userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('order_items')
    .select('order_id,orders!inner(id,order_no,status,paid_at)')
    .eq('product_id', productId)
    .eq('orders.status', 'paid')
    .limit(1)
    .maybeSingle();
  return data?.orders ?? null;
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function galleryMarkup() {
  const images = [product.cover_url, ...(product.gallery_urls || [])].filter(Boolean);
  if (!images.length) {
    return html`
      <div class="gallery__main product__media--empty" style="display:grid;place-items:center">
        <span class="eyebrow">Digital product</span>
      </div>
    `;
  }

  return html`
    <img class="gallery__main" id="gallery-main" src="${images[0]}" alt="${product.title}" decoding="async">
    ${when(
      images.length > 1,
      () => html`
        <div class="gallery__thumbs" role="group" aria-label="Product images">
          ${raw(
            images
              .map(
                (url, index) => html`
                  <button class="gallery__thumb" type="button" data-image="${url}"
                          aria-current="${String(index === 0)}" aria-label="Image ${String(index + 1)}">
                    <img src="${url}" alt="" loading="lazy">
                  </button>
                `,
              )
              .join(''),
          )}
        </div>
      `,
    )}
  `;
}

function factsMarkup() {
  const rows = [
    ['Category', product.category || 'General'],
    ['Format', product.file_type || '—'],
    product.file_size_bytes ? ['Size', formatBytes(product.file_size_bytes)] : null,
    ['Licence', licenceLabel(product.license_type)],
    ['Published', product.published_at ? formatDate(product.published_at, 'long') : formatDate(product.created_at, 'long')],
    product.purchase_count ? ['Purchases', String(product.purchase_count)] : null,
  ].filter(Boolean);

  return html`
    <dl class="kv">
      ${raw(rows.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`).join(''))}
    </dl>
  `;
}

function licenceLabel(value) {
  return (
    {
      'single-seat': 'Single seat — one person, commercial use allowed',
      team: 'Team — up to 10 seats',
      extended: 'Extended — redistribution within a product',
      'open-source': 'Open source licence',
    }[value] || 'Single seat'
  );
}

function reviewsMarkup(reviews) {
  const average = product.rating_count ? (product.rating_sum / product.rating_count).toFixed(1) : null;

  return html`
    <section class="section" id="reviews">
      <div class="section__head">
        <div>
          <span class="eyebrow">Verified buyers</span>
          <h2 class="section__title mt-1">
            Reviews
            ${when(average, () => html`<span class="muted t-16"> · ${average} out of 5 from ${String(product.rating_count)}</span>`)}
          </h2>
        </div>
        <button class="btn btn--sm" type="button" id="write-review" hidden>Write a review</button>
      </div>
      ${when(
        !reviews.length,
        () => html`
          <div class="empty">
            ${raw(icon('star'))}
            <p class="empty__title">No reviews yet</p>
            <p class="empty__body">Only customers who have bought this product can review it.</p>
          </div>
        `,
      )}
      ${when(
        reviews.length,
        () => html`
          <div class="stack-5">
            ${raw(
              reviews
                .map(
                  (review) => html`
                    <article class="panel">
                      <div class="panel__body">
                        <div class="row row--between">
                          <div class="row row-3">
                            <span class="avatar">${initials(review.profiles?.full_name || 'Customer')}</span>
                            <div>
                              <strong class="t-13">${review.profiles?.full_name || 'Verified buyer'}</strong>
                              <span class="block t-11 subtle">${relativeTime(review.created_at)}</span>
                            </div>
                          </div>
                          <span class="tag">${raw(icon('star', 11))}${String(review.rating)} / 5</span>
                        </div>
                        ${when(review.title, () => html`<h3 class="t-14 w-semibold mt-4">${review.title}</h3>`)}
                        ${when(review.body, () => html`<p class="t-13 muted mt-2">${review.body}</p>`)}
                      </div>
                    </article>
                  `,
                )
                .join(''),
            )}
          </div>
        `,
      )}
    </section>
  `;
}

function paintProduct({ reviews, owned }) {
  const off = discountPercent(product.price, product.original_price);
  const minutes = Array.isArray(product.description) ? readingMinutes(product.description) : null;

  $('#breadcrumb').innerHTML = html`
    <a href="./index.html">Home</a>${raw(icon('chevronRight', 12))}
    <a href="./store.html?category=${encodeURIComponent(product.category || '')}">${product.category || 'Catalog'}</a>
    ${raw(icon('chevronRight', 12))}
    <span class="strong truncate">${product.title}</span>
  `;

  $('#product-root').innerHTML = html`
    <div class="sidebar-layout" style="--aside-w: 340px">
      <div class="stack-7">
        <div>${raw(galleryMarkup())}</div>

        <div>
          <span class="eyebrow">${product.category || 'General'}</span>
          <h1 class="mt-2" style="font-size: var(--t-32)">${product.title}</h1>
          ${when(product.short_description, () => html`<p class="lede mt-4">${product.short_description}</p>`)}
          ${when(
            product.tags?.length,
            () => html`
              <div class="row row--wrap row-2 mt-5">
                ${raw(
                  product.tags
                    .map((tag) => html`<a class="tag" href="./store.html?tags=${encodeURIComponent(tag)}">${tag}</a>`)
                    .join(''),
                )}
              </div>
            `,
          )}
        </div>

        <section>
          <div class="section__head">
            <h2 class="section__title">About this product</h2>
            ${when(minutes, () => html`<span class="t-12 subtle">${String(minutes)} min read</span>`)}
          </div>
          <div class="prose">${raw(renderBlocks(product.description))}</div>
        </section>

        <section>
          <div class="section__head"><h2 class="section__title">Specification</h2></div>
          ${raw(factsMarkup())}
        </section>
      </div>

      <!-- Purchase panel -->
      <aside class="panel" style="position:sticky;top:calc(var(--header-h) + var(--s-6))">
        <div class="panel__body stack-4">
          <div class="row row--baseline row--between">
            <span class="price">
              <span class="price__now" style="font-size:var(--t-26)">${formatMoney(product.price, product.currency)}</span>
              ${when(
                off > 0,
                () => html`
                  <span class="price__was">${formatMoney(product.original_price, product.currency)}</span>
                  <span class="price__off">−${String(off)}%</span>
                `,
              )}
            </span>
            ${when(product.rating_count, () => html`
              <a class="tag" href="#reviews">${raw(icon('star', 11))}${(product.rating_sum / product.rating_count).toFixed(1)}</a>
            `)}
          </div>

          ${when(
            owned,
            () => html`
              <div class="alert alert--ok">
                ${raw(icon('checkCircle'))}
                <span>
                  <span class="alert__title">You already own this</span>
                  Order ${owned.order_no} · <a href="./account.html#library">open your library</a>
                </span>
              </div>
            `,
          )}

          <div class="stack-2">
            <a class="btn btn--lg btn--accent btn--block" href="./checkout.html?p=${encodeURIComponent(product.slug || product.id)}">
              ${when(owned, () => 'Buy again')}${when(!owned, () => 'Buy now')}
            </a>
            <div class="row row-2">
              <button class="btn btn--block" type="button" id="wishlist-toggle">
                ${raw(icon('star'))}<span>Save</span>
              </button>
              <button class="btn btn--block" type="button" id="copy-link">
                ${raw(icon('link'))}<span>Copy link</span>
              </button>
            </div>
          </div>

          <ul class="list-reset stack-2 t-12 muted">
            <li class="row row-2">${raw(icon('bolt', 14))}<span>Delivered the moment payment clears</span></li>
            <li class="row row-2">${raw(icon('download', 14))}<span>Re-download any time from your library</span></li>
            <li class="row row-2">${raw(icon('shield', 14))}<span>Payment verified server-side before release</span></li>
          </ul>

          ${when(
            product.delivery_note,
            () => html`<p class="t-12 subtle border-t pt-4">${product.delivery_note}</p>`,
          )}
        </div>
      </aside>
    </div>

    ${raw(reviewsMarkup(reviews))}
  `;
}

function paintRelated(items) {
  const root = $('#related-root');
  if (!items.length) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = html`
    <section class="section">
      <div class="section__head">
        <div>
          <span class="eyebrow">More in ${product.category || 'this category'}</span>
          <h2 class="section__title mt-1">Related products</h2>
        </div>
        <a class="btn btn--sm" href="./store.html?category=${encodeURIComponent(product.category || '')}">
          See category${raw(icon('arrowRight'))}
        </a>
      </div>
      <div class="cards">${raw(items.map((item) => productCard(item)).join(''))}</div>
    </section>
  `;
}

/* ==========================================================================
   Interaction
   ========================================================================== */

function wireGallery() {
  on(document, 'click', '[data-image]', (event, button) => {
    const main = $('#gallery-main');
    if (!main) return;
    main.src = button.dataset.image;
    document.querySelectorAll('[data-image]').forEach((node) => node.setAttribute('aria-current', 'false'));
    button.setAttribute('aria-current', 'true');
  });
}

async function wireWishlist() {
  const button = $('#wishlist-toggle');
  if (!button) return;

  if (!account.user) {
    button.addEventListener('click', () => {
      window.location.href = `./auth.html?next=${encodeURIComponent(`product.html?p=${key}`)}`;
    });
    return;
  }

  const { data: existing } = await supabase
    .from('wishlist_items')
    .select('id')
    .eq('product_id', product.id)
    .maybeSingle();

  let saved = Boolean(existing);
  const paint = () => {
    button.innerHTML = `${icon('star')}<span>${saved ? 'Saved' : 'Save'}</span>`;
    button.setAttribute('aria-pressed', String(saved));
  };
  paint();

  button.addEventListener('click', async () => {
    setBusy(button, true, '…');
    try {
      if (saved) {
        await unwrap(supabase.from('wishlist_items').delete().eq('product_id', product.id));
        saved = false;
        toast('Removed from your saved list.');
      } else {
        await unwrap(
          supabase.from('wishlist_items').insert({ product_id: product.id, user_id: account.user.id }),
        );
        saved = true;
        toast('Saved to your list.');
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(button, false);
      paint();
    }
  });
}

function wireCopyLink() {
  $('#copy-link')?.addEventListener('click', async () => {
    const copied = await copyText(window.location.href);
    toast(copied ? 'Link copied.' : 'Could not copy the link.', copied ? 'ok' : 'error');
  });
}

async function wireReviewForm(owned) {
  const button = $('#write-review');
  if (!button || !owned || !account.user) return;

  const { data: existing } = await supabase
    .from('reviews')
    .select('id,rating,title,body,status')
    .eq('product_id', product.id)
    .eq('user_id', account.user.id)
    .maybeSingle();

  button.hidden = false;
  button.textContent = existing ? 'Edit your review' : 'Write a review';

  button.addEventListener('click', () => openReviewDialog(existing));
}

function openReviewDialog(existing) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog dialog--narrow';
  dialog.innerHTML = html`
    <form method="dialog">
      <div class="dialog__head">
        <div>
          <h2 class="dialog__title">${existing ? 'Edit your review' : 'Write a review'}</h2>
          <p class="dialog__sub">Reviews are checked before they appear.</p>
        </div>
      </div>
      <div class="dialog__body stack-5">
        <div class="field">
          <span class="field__label">Rating<span class="req"> *</span></span>
          <div class="btn-group" role="radiogroup" aria-label="Rating">
            ${raw(
              [1, 2, 3, 4, 5]
                .map(
                  (value) => html`
                    <button class="btn" type="button" data-rating="${String(value)}"
                            aria-pressed="${String(existing?.rating === value)}">${String(value)}</button>
                  `,
                )
                .join(''),
            )}
          </div>
        </div>
        <label class="field">
          <span class="field__label" for="review-title">Headline</span>
          <input class="input" id="review-title" maxlength="80" value="${existing?.title || ''}">
        </label>
        <label class="field">
          <span class="field__label" for="review-body">What should other buyers know?</span>
          <textarea class="textarea" id="review-body" rows="5" maxlength="900">${existing?.body || ''}</textarea>
        </label>
        <p class="status" data-status></p>
      </div>
      <div class="dialog__foot">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn btn--primary" type="button" data-submit>Submit for review</button>
      </div>
    </form>
  `;

  let rating = existing?.rating ?? 0;

  dialog.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rating]');
    if (!button) return;
    rating = Number(button.dataset.rating);
    dialog.querySelectorAll('[data-rating]').forEach((node) => {
      node.setAttribute('aria-pressed', String(Number(node.dataset.rating) === rating));
    });
  });

  dialog.querySelector('[data-submit]').addEventListener('click', async (event) => {
    const status = dialog.querySelector('[data-status]');
    if (!rating) {
      status.textContent = 'Choose a rating from 1 to 5.';
      status.className = 'status status--error';
      return;
    }

    setBusy(event.currentTarget, true, 'Submitting…');
    const payload = {
      product_id: product.id,
      user_id: account.user.id,
      rating,
      title: dialog.querySelector('#review-title').value.trim() || null,
      body: dialog.querySelector('#review-body').value.trim() || null,
      status: 'pending',
    };

    const { error } = existing
      ? await supabase.from('reviews').update(payload).eq('id', existing.id)
      : await supabase.from('reviews').insert(payload);

    setBusy(event.currentTarget, false);

    if (error) {
      status.textContent = error.message;
      status.className = 'status status--error';
      return;
    }

    dialog.close();
    dialog.remove();
    toast('Thank you. Your review will appear once it has been checked.');
  });

  document.body.append(dialog);
  dialog.showModal();
}

/* ==========================================================================
   Boot
   ========================================================================== */

function when(condition, render) {
  return condition ? raw(typeof render === 'function' ? render() : render) : '';
}

async function main() {
  mountFooter();
  wireShareButtons(document);
  wireGallery();

  if (!key) {
    $('#product-root').innerHTML = html`
      <div class="empty">
        ${raw(icon('package'))}
        <p class="empty__title">No product selected</p>
        <p class="empty__body">Open a product from the catalog.</p>
        <a class="btn btn--sm btn--primary mt-2" href="./store.html">Browse the catalog</a>
      </div>
    `;
    await mountHeader();
    bootDone();
    return;
  }

  const [loaded, loadedAccount] = await Promise.all([loadProduct(), getAccount()]);
  account = loadedAccount;
  product = loaded;

  if (!product) {
    document.title = 'Product not found · DigiStore';
    $('#product-root').innerHTML = html`
      <div class="empty">
        ${raw(icon('search'))}
        <p class="empty__title">That product is not available</p>
        <p class="empty__body">It may have been unpublished, or the link may be out of date.</p>
        <a class="btn btn--sm btn--primary mt-2" href="./store.html">Browse the catalog</a>
      </div>
    `;
    await mountHeader();
    bootDone();
    return;
  }

  document.title = `${product.title} · DigiStore`;
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    product.short_description || `${product.title} — a digital product from DigiStore.`,
  );

  const [reviews, related, owned] = await Promise.all([
    loadReviews(product.id),
    loadRelated(product),
    loadOwnership(product.id, account.user?.id),
  ]);

  paintProduct({ reviews, owned });
  paintRelated(related);

  await mountHeader();
  wireWishlist();
  wireCopyLink();
  wireReviewForm(owned);

  // Fire-and-forget: a failed view count must never affect the page.
  supabase.rpc('record_product_view', { p_product_id: product.id }).catch(() => {});

  bootDone();
}

main().catch((error) => {
  console.error(error);
  toast(error.message || 'The product could not be loaded.', 'error');
  bootDone();
});
