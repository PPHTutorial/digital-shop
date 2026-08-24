/**
 * Product card.
 *
 * One renderer, used by the home rails, the catalog grid, search results, and
 * the account library, so a card looks and behaves identically everywhere.
 */

import { icon } from './icons.js';
import { esc, html, raw, when, copyText } from './dom.js';
import { formatMoney, discountPercent, truncate } from './format.js';
import { toast } from './ui.js';

/** Canonical storefront URL for a product. */
export function productHref(product) {
  return `./product.html?p=${encodeURIComponent(product.slug || product.id)}`;
}

function priceMarkup(product) {
  const off = discountPercent(product.price, product.original_price);
  return html`
    <span class="price">
      <span class="price__now">${formatMoney(product.price, product.currency)}</span>
      ${when(
        off > 0,
        () => html`
          <span class="price__was">${formatMoney(product.original_price, product.currency)}</span>
          <span class="price__off">−${String(off)}%</span>
        `,
      )}
    </span>
  `;
}

function ratingMarkup(product) {
  if (!product.rating_count) return '';
  return html`
    <span class="tag" title="${`${product.rating_average} out of 5 from ${product.rating_count} reviews`}">
      ${raw(icon('star', 11))}${String(product.rating_average ?? '—')}
      <span class="subtle">(${String(product.rating_count)})</span>
    </span>
  `;
}

/**
 * @param {object} product
 * @param {object} [options]
 * @param {boolean} [options.compact] hides the description line
 */
export function productCard(product, { compact = false } = {}) {
  const href = productHref(product);
  const off = discountPercent(product.price, product.original_price);
  const summary = product.short_description || truncate(stripBlocks(product.description), 120);

  return html`
    <article class="product" data-product="${product.id}">
      <a class="product__media${product.cover_url ? '' : ' product__media--empty'}" href="${href}"
         aria-label="${product.title}">
        ${when(
          product.cover_url,
          () => raw(`<img src="${esc(product.cover_url)}" alt="" loading="lazy" decoding="async">`),
        )}
        ${when(!product.cover_url, () => 'Digital product')}
        <span class="product__flags">
          ${when(product.is_featured, () => html`<span class="tag tag--accent">Featured</span>`)}
          ${when(off > 0, () => html`<span class="tag">${String(off)}% off</span>`)}
        </span>
      </a>
      <div class="product__body">
        <span class="product__cat">${product.category || 'General'}</span>
        <h3 class="product__title"><a href="${href}">${product.title}</a></h3>
        ${when(!compact && summary, () => html`<p class="product__desc">${summary}</p>`)}
        ${when(product.rating_count, () => html`<div class="row row-2 mt-3">${raw(ratingMarkup(product))}</div>`)}
      </div>
      <div class="product__foot">
        ${raw(priceMarkup(product))}
        <span class="row row-1">
          <button class="btn btn--sm btn--icon" type="button" data-share="${href}"
                  title="Copy link" aria-label="Copy link to ${esc(product.title)}">
            ${raw(icon('link'))}
          </button>
          <a class="btn btn--sm btn--primary" href="${href}">View</a>
        </span>
      </div>
    </article>
  `;
}

/** Plain text from either a legacy string description or a block array. */
function stripBlocks(description) {
  if (typeof description === 'string') return description;
  if (!Array.isArray(description)) return '';
  return description
    .map((block) => block?.text || '')
    .filter(Boolean)
    .join(' ');
}

/** A loading placeholder with the same footprint as a real card. */
export function productSkeleton(count = 4) {
  return Array.from(
    { length: count },
    () => html`
      <article class="product" aria-hidden="true">
        <span class="product__media skeleton"></span>
        <div class="product__body stack-2">
          <span class="skeleton block" style="height:10px;width:34%"></span>
          <span class="skeleton block" style="height:15px;width:88%"></span>
          <span class="skeleton block" style="height:13px;width:62%"></span>
        </div>
        <div class="product__foot">
          <span class="skeleton block" style="height:18px;width:70px"></span>
          <span class="skeleton block" style="height:30px;width:76px"></span>
        </div>
      </article>
    `,
  ).join('');
}

/**
 * Wires the copy-link buttons inside `root`. Uses the Web Share sheet on
 * devices that have one, and falls back to the clipboard everywhere else.
 */
export function wireShareButtons(root = document) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-share]');
    if (!button) return;
    event.preventDefault();

    const url = new URL(button.dataset.share, window.location.href).href;
    const title = button.closest('.product')?.querySelector('.product__title')?.textContent?.trim();

    if (navigator.share) {
      try {
        await navigator.share({ title: title || document.title, url });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }

    toast((await copyText(url)) ? 'Link copied to the clipboard.' : 'Could not copy the link.', 'ok');
  });
}

/**
 * Renders a horizontally scrolling rail with its own heading and controls.
 */
export function railSection({ id, eyebrow, title, href, items }) {
  if (!items?.length) return '';
  return html`
    <section class="section" id="${id}">
      <div class="section__head">
        <div>
          <span class="eyebrow">${eyebrow}</span>
          <h2 class="section__title mt-1">${title}</h2>
        </div>
        <div class="row row-2">
          <div class="btn-group hide-sm">
            <button class="btn btn--sm btn--icon" type="button" data-rail-prev="${id}" aria-label="Scroll left">
              ${raw(icon('chevronLeft'))}
            </button>
            <button class="btn btn--sm btn--icon" type="button" data-rail-next="${id}" aria-label="Scroll right">
              ${raw(icon('chevronRight'))}
            </button>
          </div>
          <a class="btn btn--sm" href="${href}">All ${String(items.length)}${raw(icon('arrowRight'))}</a>
        </div>
      </div>
      <div class="rail" id="rail-${id}">${raw(items.map((item) => productCard(item)).join(''))}</div>
    </section>
  `;
}

/** Wires the prev/next buttons for every rail inside `root`. */
export function wireRails(root = document) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rail-prev],[data-rail-next]');
    if (!button) return;
    const id = button.dataset.railPrev || button.dataset.railNext;
    const rail = document.getElementById(`rail-${id}`);
    if (!rail) return;
    const step = rail.clientWidth * 0.8;
    rail.scrollBy({ left: button.dataset.railPrev ? -step : step, behavior: 'smooth' });
  });
}
