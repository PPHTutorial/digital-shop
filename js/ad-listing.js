/**
 * External-link ("ad") listings — the storefront half.
 *
 * A listing whose end product is an external URL rather than a file we deliver
 * is an ad. Ads never appear in the ordinary catalog: buyers only reach them
 * through the listing's own detail page (or a sponsored slot), where the CTA is
 * a click-through guarded by a "you're leaving DigiStore" interstitial instead
 * of an Add to cart / checkout.
 *
 * Everything here is inert until CONFIG.ADS_LIVE is set — see js/config.js for
 * why (the products.is_ad / external_url columns do not exist before the
 * 20260827160000 migration, so selecting or filtering on them would 400 the
 * whole catalog query).
 */
import { CONFIG } from './config.js';
import { openModal } from './uikit.js';
import { escapeHtml, icon } from './ui.js';

export const ADS_LIVE = !!CONFIG.ADS_LIVE;

/**
 * Whether the product editor should offer "External link" as a delivery mode.
 * Paused for launch (see js/config.js). The server enforces this too, via
 * site_settings.external_listings_open + the enforce_product_delivery_rules
 * trigger — this flag only keeps the UI honest. Existing is_ad rows keep
 * working regardless, since ADS_LIVE above still governs their storefront
 * handling.
 */
export const EXTERNAL_LISTINGS_OPEN = !!CONFIG.EXTERNAL_LISTINGS_OPEN;

/**
 * Extra columns to append to a catalog `.select(...)` string. Empty (a no-op
 * concat) until the migration lands, so a pre-push build issues exactly the
 * query it does today.
 */
export const AD_LISTING_COLS = ADS_LIVE ? ',is_ad,external_url' : '';

/** True when a product row is a live, click-through external listing. */
export function isAdListing(p) {
  return ADS_LIVE && !!(p && p.is_ad && p.external_url);
}

/** Drops ad rows from a catalog list. No-op (returns the list) when ads are off. */
export function stripAdListings(list) {
  if (!Array.isArray(list)) return list || [];
  if (!ADS_LIVE) return list;
  return list.filter((p) => !p.is_ad);
}

/** Bare host for display, e.g. "acme.example" — falls back to the raw string. */
function destinationHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

/**
 * The safety gate shown before a click-through. Resolves nothing — on confirm
 * it opens the destination in a new tab and closes; on cancel it just closes.
 * `productId` is accepted now so click accounting can hook in here later.
 */
export function openLeavingInterstitial({ url, title = '' } = {}) {
  if (!url) return;
  const host = destinationHost(url);

  const { dialog, close } = openModal({
    title: 'You’re leaving DigiStore',
    danger: true,
    body: `
      <div class="leaving-int">
        <p class="leaving-int__lead">${title ? `<strong>${escapeHtml(title)}</strong> is an external listing. ` : ''}It sends you to a website DigiStore does not operate or control.</p>
        <p class="leaving-int__dest">${icon('external-link', 15)}<span>${escapeHtml(host)}</span></p>
        <ul class="leaving-int__tips">
          <li>Never enter your DigiStore password or payment details on the site you land on.</li>
          <li>DigiStore cannot verify, deliver, or refund anything obtained there.</li>
          <li>Leave immediately if it asks you to install software or grant unusual permissions.</li>
        </ul>
      </div>`,
    footer: `
      <button type="button" class="button" data-uk-cancel>Stay on DigiStore</button>
      <button type="button" class="button button-primary" data-uk-go>Continue to ${escapeHtml(host)}</button>
    `,
  });

  dialog.querySelector('[data-uk-cancel]').addEventListener('click', close);
  dialog.querySelector('[data-uk-go]').addEventListener('click', () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    close();
  });
}
