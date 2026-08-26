/**
 * Cart actions shared by product cards, the product detail page, and the
 * cart page itself — one place for "add to cart" + keeping the header badge
 * in sync, mirroring wishlist.js's pattern.
 */
import { supabase } from './client.js';
import { getAccount, toast } from './ui.js';

let cachedCount = null;

/** Real count for the signed-in shopper. Anonymous visitors get 0, cached per page load. */
export async function getCartCount() {
  if (cachedCount !== null) return cachedCount;
  const { user } = await getAccount();
  if (!user) { cachedCount = 0; return 0; }
  const { count } = await supabase.from('cart_items').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  cachedCount = count || 0;
  return cachedCount;
}

function invalidateCartCount() { cachedCount = null; }

/** Repaints whatever cart-badge element(s) exist on the current page (header included). */
export async function refreshCartBadges() {
  const count = await getCartCount();
  document.querySelectorAll('[data-cart-badge]').forEach((el) => {
    el.textContent = String(count);
    el.classList.toggle('hidden', count === 0);
  });
}

/**
 * Adds a product to the signed-in shopper's cart (or bumps quantity if it's
 * already there, capped at 20 per the `cart_items` check constraint).
 * Anonymous visitors are sent to sign in first, same pattern as the wishlist.
 */
export async function addToCart(productId, quantity = 1) {
  const { user } = await getAccount();
  if (!user) {
    const next = `${window.location.pathname.split('/').pop() || 'index'}${window.location.search}`;
    window.location.href = `./auth?mode=signin&next=${encodeURIComponent(next)}`;
    return false;
  }

  const { data: existing } = await supabase.from('cart_items')
    .select('id,quantity').eq('user_id', user.id).eq('product_id', productId).maybeSingle();

  const result = existing
    ? await supabase.from('cart_items').update({ quantity: Math.min(20, existing.quantity + quantity) }).eq('id', existing.id)
    : await supabase.from('cart_items').insert({ user_id: user.id, product_id: productId, quantity });

  if (result.error) {
    toast(result.error.message || 'Could not add that to your cart.', 'error');
    return false;
  }

  invalidateCartCount();
  await refreshCartBadges();
  toast('Added to cart.');
  return true;
}
