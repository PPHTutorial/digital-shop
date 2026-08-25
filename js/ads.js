/**
 * Sponsored placements.
 *
 * Fetches servable campaigns, marks the promoted cards, and reports billable
 * events. The browser never decides what anything costs — it reports that an
 * event happened and `record_ad_event` prices it, dedupes it, and debits the
 * wallet. Purchases are not reported from here at all: they are attributed
 * server-side from the paid order, so a page cannot fabricate a conversion.
 */
import { supabase } from './client.js';

/**
 * A stable per-browser id. Combined with the campaign and the date it forms the
 * dedupe key, so a refreshed page or a re-opened tab bills once per day rather
 * than on every view. Falls back to a per-page-load value in private mode,
 * which over-counts slightly rather than failing.
 */
function viewerKey() {
  try {
    let key = localStorage.getItem('digistore.vk');
    if (!key) {
      key = (crypto.randomUUID?.() || String(Math.random())).slice(0, 24);
      localStorage.setItem('digistore.vk', key);
    }
    return key;
  } catch {
    return `session-${Math.random().toString(36).slice(2, 14)}`;
  }
}

const VIEWER = viewerKey();

/** Impressions already reported this page load — avoids a pointless round trip. */
const reported = new Set();

async function report(campaignId, eventType) {
  const token = `${campaignId}:${eventType}`;
  if (reported.has(token)) return;
  reported.add(token);

  try {
    await supabase.rpc('record_ad_event', {
      p_campaign_id: campaignId,
      p_event_type: eventType,
      p_dedupe_key: VIEWER,
    });
  } catch {
    // Ad accounting must never break the storefront.
  }
}

/**
 * Campaigns eligible to serve right now, newest first, keyed by product id.
 * Reads the `servable_ad_campaigns` view, which already filters on approval,
 * budget, wallet balance and schedule.
 */
export async function loadServableCampaigns(placement = null) {
  try {
    let query = supabase
      .from('servable_ad_campaigns')
      .select('id,product_id,placement,vendor_id')
      .limit(60);
    if (placement) query = query.eq('placement', placement);

    const { data, error } = await query;
    if (error) return new Map();

    const byProduct = new Map();
    for (const row of data || []) {
      if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, row);
    }
    return byProduct;
  } catch {
    return new Map();
  }
}

/**
 * Marks already-rendered cards as sponsored and starts billing them.
 *
 * An impression is only charged once the card has actually been on screen —
 * IntersectionObserver, not render — so a card far below the fold that nobody
 * scrolled to costs the vendor nothing.
 */
export function attachAdTracking(root = document, campaignsByProduct = new Map()) {
  if (!campaignsByProduct.size) return;

  const cards = root.querySelectorAll('[data-product-id]');
  const tracked = [];

  cards.forEach((card) => {
    const campaign = campaignsByProduct.get(card.dataset.productId);
    if (!campaign) return;

    card.dataset.campaignId = campaign.id;
    if (!card.querySelector('.sponsored-flag')) {
      const flag = document.createElement('span');
      flag.className = 'sponsored-flag';
      flag.textContent = 'Sponsored';
      card.appendChild(flag);
    }
    tracked.push(card);
  });

  if (!tracked.length) return;

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        report(entry.target.dataset.campaignId, 'impression');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.5 });
    tracked.forEach((card) => observer.observe(card));
  } else {
    tracked.forEach((card) => report(card.dataset.campaignId, 'impression'));
  }

  // Clicks are delegated once, so re-rendering the grid cannot double-bind.
  if (!root.dataset.adClicksWired) {
    root.dataset.adClicksWired = 'true';
    root.addEventListener('click', (event) => {
      const card = event.target.closest('[data-campaign-id]');
      if (card) report(card.dataset.campaignId, 'click');
    });
  }
}

/** Sorts sponsored products to the front, preserving order otherwise. */
export function promoteSponsored(products, campaignsByProduct) {
  if (!campaignsByProduct.size) return products;
  const sponsored = [];
  const rest = [];
  for (const product of products) {
    (campaignsByProduct.has(product.id) ? sponsored : rest).push(product);
  }
  return [...sponsored, ...rest];
}
