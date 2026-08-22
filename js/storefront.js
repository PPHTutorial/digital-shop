import { supabase } from "./client.js";
import { escapeHtml, finishPageLoader, initMotion, mountHeader, setButtonLoading, startPageLoader, toast } from './ui.js';
document.querySelector("#year").textContent = new Date().getFullYear();
const grid = document.querySelector("#product-grid");
async function load() {
  document.querySelector('#product-loading').classList.remove('hidden');
  const { data, error } = await supabase
    .from("products")
    .select("id,title,slug,description,price,original_price,currency,cover_url,is_published")
    .eq("is_published", true)
    .order("created_at", { ascending: false });
  if (error) {
    grid.innerHTML = '<div class="soft-panel p-8 text-slate-600">The catalog is unavailable right now. Please try again shortly.</div>';
    document.querySelector('#product-loading').classList.add('hidden');
    finishPageLoader(); return;
  }
  document.querySelector("#product-count").textContent =
    `${data.length} published title${data.length === 1 ? "" : "s"}`;
  if (!data.length) {
    grid.innerHTML =
      '<div class="soft-panel p-8 text-slate-600">No books are published yet.</div>';
    document.querySelector('#product-loading').classList.add('hidden');
    finishPageLoader(); return;
  }
  grid.innerHTML = data
    .map(
      (p) => {
        const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
        const discountPct = hasDiscount ? Math.round((1 - Number(p.price) / Number(p.original_price)) * 100) : 0;
        const priceHtml = hasDiscount
          ? `<div class="flex items-baseline gap-1.5">
               <span class="price-original text-xs">${p.currency} ${Number(p.original_price).toFixed(2)}</span>
               <strong class="text-lg text-[#142c55]">${p.currency} ${Number(p.price).toFixed(2)}</strong>
             </div>`
          : `<strong class="text-lg text-[#142c55]">${p.currency} ${Number(p.price).toFixed(2)}</strong>`;

        return `<article class="catalog-card overflow-hidden">
          ${p.cover_url ? `<img src="${p.cover_url}" alt="${escapeHtml(p.title)}">` : '<div class="aspect-[1.5] bg-slate-100"></div>'}
          <div class="card-body">
            <div class="flex items-center justify-between gap-2">
              <span class="tag">Digital product</span>
              ${hasDiscount ? `<span class="discount-pill">${discountPct}% OFF</span>` : ''}
            </div>
            <h3 class="mt-3 text-lg font-black text-[#142c55]">${escapeHtml(p.title)}</h3>
            <p class="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">${escapeHtml(p.description || "")}</p>
            <div class="mt-5 flex items-center justify-between gap-3">
              ${priceHtml}
              <a class="button button-primary !min-h-9 !px-3 !text-xs" href="./checkout.html?product=${encodeURIComponent(p.id)}">Get product</a>
            </div>
          </div>
        </article>`;
      }
    )
    .join("");
  document.querySelector('#product-loading').classList.add('hidden');
  finishPageLoader();

  // Cache selected product into sessionStorage when clicking Get product
  grid.querySelectorAll('a[href*="checkout.html"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = new URL(btn.href, location.href);
      const pid = url.searchParams.get('product');
      if (pid) sessionStorage.setItem('last_selected_product', pid);
    });
  });
}
document
  .querySelector("#subscribe-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get("email");
    const button = e.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Subscribing…');
    const { error } = await supabase.from("subscribers").insert({ email });
    setButtonLoading(button, false);
    const status = document.querySelector('#subscribe-status');
    if (error && error.code !== '23505') {
      status.textContent = 'We could not save your subscription. Please try again.';
      status.className = 'status-line error';
      toast('Subscription could not be saved.', 'error');
      return;
    }
    status.textContent = 'You’re on the list. Watch your inbox for DigiStore updates.';
    status.className = 'status-line success';
    e.currentTarget.reset();
    toast('Subscription confirmed.');
  });
startPageLoader(); mountHeader();
initMotion();
load();
