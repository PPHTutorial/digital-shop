import { supabase } from "./client.js";
import { toast } from './ui.js';

const q = new URLSearchParams(location.search);
const token = q.get("token");
const orderId = q.get("order_id");
const status = q.get("status");

const title = document.querySelector("#status-title");
const copy = document.querySelector("#status-copy");
const area = document.querySelector("#download-area");

async function run() {
  if (status === 'cancelled') {
    title.textContent = "Payment Cancelled";
    copy.textContent = "You cancelled the payment transaction. No charges were made to your account.";
    area.innerHTML = `<a href="./index.html#store" class="inline-flex rounded-full bg-slate-950 px-7 py-3 font-bold text-white hover:bg-slate-800 transition-colors">Return to Store</a>`;
    return;
  }

  if (status === 'failed' || status === 'mismatch' || status === 'error') {
    title.textContent = "Payment Incomplete";
    copy.textContent = "Your payment could not be confirmed. If funds were deducted, please contact support with your payment reference.";
    area.innerHTML = `<div class="flex flex-wrap justify-center gap-3">
      <a href="./index.html#store" class="inline-flex rounded-full bg-slate-950 px-7 py-3 font-bold text-white hover:bg-slate-800 transition-colors">Browse Store</a>
      <a href="./support.html" class="inline-flex rounded-full bg-orange-600 px-7 py-3 font-bold text-white hover:bg-orange-500 transition-colors">Contact Support</a>
    </div>`;
    return;
  }

  if (!token && !orderId) {
    title.textContent = "Payment Received";
    copy.textContent = "Your payment is being confirmed. Refresh this page in a few moments if your download is not immediately ready.";
    return;
  }

  const { data, error } = await supabase.functions.invoke("download-book", {
    body: { token, order_id: orderId },
  });

  if (error || !data?.url) {
    title.textContent = "Payment is still being confirmed";
    copy.textContent =
      "Your payment may still be processing. Refresh this page in a moment, or open a support ticket if the problem persists.";
    return;
  }

  title.textContent = "Payment Confirmed!";
  copy.textContent =
    "Thank you for your purchase! Your book is ready for download. This download link is secure and valid for immediate access.";
  area.innerHTML = `<a href="${data.url}" class="inline-flex rounded-full bg-orange-600 px-8 py-3.5 font-bold text-white hover:bg-orange-500 shadow-lg shadow-orange-600/30 transition-all hover:scale-105">⬇ Download Your Book</a>`;
  toast('Your protected download is ready.');
}

run();
