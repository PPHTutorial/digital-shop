import { supabase } from "./client.js";
import { CONFIG } from "./config.js";
const productId = new URLSearchParams(location.search).get("product");
const summary = document.querySelector("#order-summary");
const total = document.querySelector("#total");
async function load() {
  if (!productId) {
    summary.innerHTML =
      '<p class="text-slate-600">Choose a book from the store first.</p>';
    return;
  }
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .single();
  if (error) {
    summary.innerHTML =
      '<p class="text-slate-600">Could not load this book.</p>';
    return;
  }
  summary.innerHTML = `<div class="flex gap-4"><div class="h-20 w-16 rounded-2xl bg-white">${data.cover_url ? `<img src="${data.cover_url}" class="h-full w-full rounded-2xl object-cover">` : ""}</div><div><h3 class="font-black">${esc(data.title)}</h3><p class="mt-1 text-sm text-slate-500">Digital edition</p></div></div>`;
  total.textContent = `${data.currency} ${Number(data.price).toFixed(2)}`;
}
document
  .querySelector("#checkout-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!productId) return;
    const fd = new FormData(e.currentTarget);
    const provider = e.submitter?.value || fd.get("provider") || 'flutterwave';
    const form = Object.fromEntries(fd.entries());
    const marketing = e.currentTarget.marketing.checked;
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    let user = currentUser;
    let uid = user?.id;
    if (!uid) {
      const signIn = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      });
      if (!signIn.error) {
        user = signIn.data.user;
        uid = user.id;
      } else {
        const signUp = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            data: { full_name: form.full_name },
            emailRedirectTo: `${CONFIG.SITE_URL}${location.pathname.replace(/[^/]+$/, 'auth.html')}`,
          },
        });
        if (signUp.error) {
          alert(signUp.error.message);
          return;
        }
        if (!signUp.data.session) {
          alert('Check your email to confirm your account, then return and sign in before checkout.');
          location.href = './auth.html';
          return;
        }
        user = signUp.data.user;
        uid = user.id;
      }
      if (!uid) {
        alert('Unable to establish an authenticated session. Please sign in and try again.');
        return;
      }
    }
    const { error: profileErr } = await supabase
      .from("profiles")
      .upsert({
        id: uid,
        full_name: form.full_name,
        phone: form.phone,
        address: form.address,
        gender: form.gender,
        country: form.country,
        occupation: form.occupation,
        age: form.age ? Number(form.age) : null,
      });
    if (profileErr) {
      alert(profileErr.message);
      return;
    }
    if (marketing) {
      const { error: subscriberError } = await supabase.from("subscribers").insert({ email: form.email });
      if (subscriberError && subscriberError.code !== '23505') {
        console.warn('Subscription was not saved:', subscriberError.message);
      }
    }
    const { data: order, error } = await supabase
      .from("orders")
      .insert({
        user_id: uid,
        product_id: productId,
        customer_email: user?.email || form.email,
        amount: 0,
        currency: "USD",
        status: "pending",
      })
      .select("id")
      .single();
    if (error) {
      alert(error.message);
      return;
    }
    const functionName = provider === 'nowpayments' ? 'create-nowpayments-payment' : 'create-flutterwave-payment';
    const { data: payment, error: paymentError } = await supabase.functions.invoke(functionName, {
      body: { order_id: order.id },
    });
    if (paymentError || !payment?.payment_url) {
      alert(payment?.error || paymentError?.message || 'Unable to start payment checkout.');
      return;
    }
    location.href = payment.payment_url;
  });
function esc(v) {
  return String(v ?? "").replace(
    /[&<>\"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '\"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}
load();
