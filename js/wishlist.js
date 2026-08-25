/**
 * Wishlist.
 *
 * The heart is the only interactive control left on a product card — the card
 * itself is a link to checkout — so it has to sit above the card's stretched
 * link and stop its own clicks from bubbling into it.
 *
 * State is loaded once per page and painted onto whatever cards exist, so a
 * re-rendered grid (filter, sort, load-more) keeps its hearts filled without
 * another round trip.
 */
import { supabase } from './client.js';
import { getAccount, toast } from './ui.js';

let savedIds = new Set();
let loaded = false;

/** Markup for one card's heart. Rendered unfilled; state is painted after. */
export function wishlistButton(productId, title = '') {
  return `
    <button type="button" class="wishbtn" data-wish="${productId}"
            aria-pressed="false" aria-label="Save ${title.replace(/"/g, '&quot;')} to your wishlist"
            title="Save for later">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/>
      </svg>
    </button>`;
}

/** Reads the signed-in shopper's saved ids. Anonymous visitors get an empty set. */
export async function loadWishlist() {
  if (loaded) return savedIds;
  loaded = true;
  try {
    const { user } = await getAccount();
    if (!user) return savedIds;
    const { data } = await supabase.from('wishlist_items').select('product_id');
    savedIds = new Set((data || []).map((row) => row.product_id));
  } catch {
    /* a wishlist failure must never blank the catalogue */
  }
  return savedIds;
}

function paint(button, saved) {
  button.classList.toggle('is-saved', saved);
  button.setAttribute('aria-pressed', String(saved));
}

/** Applies known state to every heart currently in `root`. */
export function paintWishlist(root = document) {
  root.querySelectorAll('[data-wish]').forEach((button) => {
    paint(button, savedIds.has(button.dataset.wish));
  });
}

/**
 * Delegated once per root, so re-rendering the grid cannot double-bind and a
 * heart added later still works.
 */
export function wireWishlist(root = document) {
  if (root.dataset?.wishWired === 'true') return;
  if (root.dataset) root.dataset.wishWired = 'true';

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-wish]');
    if (!button) return;

    // The card is a link; without this the click would navigate to checkout.
    event.preventDefault();
    event.stopPropagation();

    const { user } = await getAccount();
    if (!user) {
      const next = `${window.location.pathname.split('/').pop() || 'index'}${window.location.search}`;
      window.location.href = `./auth?mode=signin&next=${encodeURIComponent(next)}`;
      return;
    }

    const productId = button.dataset.wish;
    const wasSaved = savedIds.has(productId);

    // Optimistic: the heart responds immediately and reverts only on failure.
    paint(button, !wasSaved);
    button.disabled = true;

    try {
      if (wasSaved) {
        const { error } = await supabase.from('wishlist_items')
          .delete().eq('product_id', productId).eq('user_id', user.id);
        if (error) throw error;
        savedIds.delete(productId);
      } else {
        const { error } = await supabase.from('wishlist_items')
          .insert({ product_id: productId, user_id: user.id });
        if (error) throw error;
        savedIds.add(productId);
        toast('Saved to your wishlist.');
      }
      // Other copies of the same product elsewhere on the page stay in step.
      document.querySelectorAll(`[data-wish="${productId}"]`).forEach((el) => paint(el, savedIds.has(productId)));
    } catch (error) {
      paint(button, wasSaved);
      toast(error.message || 'That did not save. Please try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}
