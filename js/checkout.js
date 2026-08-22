import { supabase } from './client.js';
import { escapeHtml, getAccount, mountHeader, setButtonLoading, toast } from './ui.js';

const productId = new URLSearchParams(location.search).get('product');
let product;
let promotion = null;

function money(amount) {
  return `${product.currency} ${Number(amount).toFixed(2)}`;
}

function renderTotals() {
  const discount = promotion?.discount_amount || 0;
  document.querySelector('#subtotal').textContent = money(product.price);
  document.querySelector('#total').textContent = money(Math.max(0, Number(product.price) - Number(discount)));
  const row = document.querySelector('#discount-row');
  row.classList.toggle('hidden', !discount);
  row.classList.toggle('flex', Boolean(discount));
  document.querySelector('#discount').textContent = `−${money(discount)}`;
}

async function load() {
  mountHeader();
  const { user } = await getAccount();
  if (!user) {
    location.replace(`./auth.html?mode=signin&next=${encodeURIComponent(`checkout.html?product=${productId || ''}`)}`);
    return;
  }
  document.querySelector('#checkout-status').textContent = `Signed in as ${user.email}. Your account details are protected.`;
  if (!productId) {
    document.querySelector('#order-summary').innerHTML = '<p class="text-slate-600">Choose a product from the catalog first.</p>';
    return;
  }
  const { data, error } = await supabase.from('products').select('id,title,description,price,currency,cover_url').eq('id', productId).single();
  if (error || !data) {
    document.querySelector('#order-summary').innerHTML = '<p class="text-red-700">This product could not be loaded.</p>';
    return;
  }
  product = data;
  document.querySelector('#order-summary').innerHTML = `<div class="flex gap-4">${data.cover_url ? `<img src="${data.cover_url}" alt="" class="h-20 w-24 rounded-xl object-cover">` : '<div class="h-20 w-24 rounded-xl bg-orange-50"></div>'}<div><h3 class="font-black text-[#142c55]">${escapeHtml(data.title)}</h3><p class="mt-1 text-sm leading-5 text-slate-500">${escapeHtml(data.description || 'Digital product')}</p></div></div>`;
  renderTotals();
}

document.querySelector('#apply-promo').addEventListener('click', async (event) => {
  if (!product) return;
  const code = document.querySelector('#promo-code').value.trim();
  const feedback = document.querySelector('#promo-feedback');
  if (!code) {
    feedback.textContent = 'Enter a promotion code first.';
    feedback.className = 'status-line error mt-2';
    return;
  }
  setButtonLoading(event.currentTarget, true, 'Checking…');
  const { data, error } = await supabase.rpc('quote_promo', { p_code: code, p_product_id: product.id });
  setButtonLoading(event.currentTarget, false);
  const quote = Array.isArray(data) ? data[0] : data;
  if (error || !quote?.valid) {
    promotion = null;
    feedback.textContent = quote?.message || 'That promotion code is not available.';
    feedback.className = 'status-line error mt-2';
    renderTotals();
    return;
  }
  promotion = { code: quote.code, discount_amount: Number(quote.discount_amount) };
  feedback.textContent = `${quote.code} applied — you save ${money(promotion.discount_amount)}.`;
  feedback.className = 'status-line success mt-2';
  renderTotals();
  toast('Promotion applied.');
});

document.querySelector('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!product) return;
  const button = event.submitter;
  const provider = button?.value || 'flutterwave';
  const feedback = document.querySelector('#checkout-feedback');
  const { user } = await getAccount();
  if (!user) {
    location.href = './auth.html?mode=signin';
    return;
  }
  setButtonLoading(button, true, 'Creating secure payment…');
  feedback.textContent = 'Preparing your protected payment session…';
  feedback.className = 'status-line mt-4';
  const discount = promotion?.discount_amount || 0;
  const { data: order, error } = await supabase.from('orders').insert({
    user_id: user.id, product_id: product.id, customer_email: user.email,
    amount: Math.max(0, Number(product.price) - Number(discount)), currency: product.currency,
    status: 'pending', promo_code: promotion?.code || null, discount_amount: discount,
  }).select('id').single();
  if (error) {
    setButtonLoading(button, false);
    feedback.textContent = error.message;
    feedback.className = 'status-line error mt-4';
    return;
  }
  const functionName = provider === 'nowpayments' ? 'create-nowpayments-payment' : 'create-flutterwave-payment';
  const { data: payment, error: paymentError } = await supabase.functions.invoke(functionName, { body: { order_id: order.id } });
  if (paymentError || !payment?.payment_url) {
    setButtonLoading(button, false);
    feedback.textContent = payment?.error || paymentError?.message || 'Payment could not be started.';
    feedback.className = 'status-line error mt-4';
    return;
  }
  location.href = payment.payment_url;
});

load();
