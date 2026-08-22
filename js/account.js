import { supabase } from './client.js';
import { escapeHtml, getAccount, mountHeader, setButtonLoading, toast } from './ui.js';

let account;
async function load() {
  mountHeader();
  account = await getAccount();
  if (!account.user) { location.replace('./auth.html?mode=signin'); return; }
  const { user, profile } = account;
  document.querySelector('#account-subtitle').textContent = `${user.email} · ${profile?.role === 'admin' ? 'Administrator' : 'Customer account'}`;
  const form = document.querySelector('#profile-form');
  ['full_name', 'phone', 'country', 'address', 'occupation', 'age'].forEach((field) => form.elements[field].value = profile?.[field] ?? '');
  document.querySelector('#admin-card').classList.toggle('hidden', profile?.role !== 'admin');
  const { data: orders, error } = await supabase.from('orders').select('id,status,amount,currency,created_at,products(title)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(12);
  const list = document.querySelector('#orders-list');
  if (error) { list.innerHTML = '<p class="text-sm text-red-700">Orders are unavailable right now.</p>'; return; }
  list.innerHTML = orders?.length ? orders.map((order) => `<div class="border-t border-slate-100 py-4"><div class="flex justify-between gap-4"><div><strong class="text-sm text-[#142c55]">${escapeHtml(order.products?.title || 'Digital product')}</strong><p class="mt-1 text-xs text-slate-500">${new Date(order.created_at).toLocaleDateString()}</p></div><div class="text-right"><strong class="text-sm">${order.currency} ${Number(order.amount).toFixed(2)}</strong><p class="mt-1 text-xs font-bold ${order.status === 'paid' ? 'text-green-700' : 'text-slate-500'}">${escapeHtml(order.status)}</p></div></div></div>`).join('') : '<p class="py-4 text-sm text-slate-500">No purchases yet.</p>';
}
document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  setButtonLoading(button, true, 'Saving…');
  const { error } = await supabase.from('profiles').update({ ...values, age: values.age ? Number(values.age) : null, updated_at: new Date().toISOString() }).eq('id', account.user.id);
  setButtonLoading(button, false);
  const feedback = document.querySelector('#profile-feedback');
  if (error) { feedback.textContent = error.message; feedback.className = 'status-line error sm:col-span-2'; return; }
  feedback.textContent = 'Your account details have been saved.'; feedback.className = 'status-line success sm:col-span-2'; toast('Account details saved.');
});
load();
