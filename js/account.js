import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, mountHeader, setButtonLoading, toast } from './ui.js';

let account;

function activityChart(orders) {
  const paid = orders.filter((o) => o.status === 'paid');
  const max = Math.max(1, ...paid.map((o) => Number(o.amount)));
  return paid.length
    ? `<div class="flex h-full items-end gap-3">${paid
        .slice(0, 7)
        .reverse()
        .map(
          (o) => `
          <div class="flex flex-1 flex-col items-center gap-2">
            <span class="text-xs font-bold">$${Number(o.amount).toFixed(0)}</span>
            <div class="w-full rounded-t bg-orange-500" style="height:${Math.max(8, (Number(o.amount) / max) * 125)}px"></div>
            <small class="text-[10px] text-slate-400">${new Date(o.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
          </div>`
        )
        .join('')}</div>`
    : '<p class="pt-16 text-center text-sm text-slate-500">Your purchase activity will appear here after your first completed order.</p>';
}

const statusColors = {
  paid: 'text-green-700 bg-green-50',
  pending: 'text-amber-700 bg-amber-50',
  cancelled: 'text-red-700 bg-red-50',
  failed: 'text-red-700 bg-red-50',
  refunded: 'text-blue-700 bg-blue-50',
};

const statusLabels = {
  paid: '✓ Paid',
  pending: '⏳ Pending',
  cancelled: '✕ Cancelled',
  failed: '! Failed',
  refunded: '↩ Refunded',
};

function renderOrdersList(orders) {
  if (!orders.length) {
    return '<p class="py-4 text-sm text-slate-500">No purchases yet. Browse the catalog to find your first digital product!</p>';
  }

  return orders
    .map((o) => {
      const colorClass = statusColors[o.status] || 'text-slate-600 bg-slate-50';
      const label = statusLabels[o.status] || o.status;

      return `
      <div class="flex justify-between gap-4 border-t border-slate-100 py-4 first:border-t-0">
        <div>
          <strong class="text-sm text-[#142c55]">${escapeHtml(o.products?.title || 'Digital product')}</strong>
          <p class="mt-1 text-xs text-slate-500">${new Date(o.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</p>
        </div>
        <div class="text-right shrink-0">
          <strong class="text-sm">${o.currency} ${Number(o.amount).toFixed(2)}</strong>
          <p class="mt-1"><span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${colorClass}">${escapeHtml(label)}</span></p>
        </div>
      </div>`;
    })
    .join('');
}

async function load() {
  mountHeader();
  account = await getAccount();

  if (!account.user) {
    location.replace('./auth.html?mode=signin');
    return;
  }

  const { user, profile } = account;

  document.querySelector('#account-title').textContent = `Welcome, ${profile?.full_name || 'there'}`;
  document.querySelector('#account-subtitle').textContent = 'A private overview of your DigiStore activity.';
  document.querySelector('#account-admin').classList.toggle('hidden', profile?.role !== 'admin');

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id,status,amount,currency,created_at,products(title)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const all = orders || [];
  const paid = all.filter((o) => o.status === 'paid');

  // Only count PAID orders for Purchases and Amount Spent
  document.querySelector('#a-orders').textContent = paid.length;
  document.querySelector('#a-spend').textContent = `$${paid.reduce((s, o) => s + Number(o.amount), 0).toFixed(2)}`;
  document.querySelector('#a-ready').textContent = paid.length;
  document.querySelector('#a-member').textContent = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : '—';

  document.querySelector('#activity-chart').innerHTML = activityChart(all);
  document.querySelector('#orders-list').innerHTML = error
    ? '<p class="text-red-700">Orders are unavailable right now.</p>'
    : renderOrdersList(all);

  // Profile form prefill
  const form = document.querySelector('#profile-form');
  ['full_name', 'phone', 'country', 'address', 'occupation', 'age'].forEach((k) => {
    if (form.elements[k]) form.elements[k].value = profile?.[k] ?? '';
  });

  finishPageLoader();
}

// Edit Profile toggle
document.querySelector('#edit-profile').onclick = () => document.querySelector('#profile-panel').classList.toggle('hidden');

// Profile form submit
document.querySelector('#profile-form').onsubmit = async (e) => {
  e.preventDefault();
  const b = e.currentTarget.querySelector('button');
  const v = Object.fromEntries(new FormData(e.currentTarget).entries());
  setButtonLoading(b, true, 'Saving…');
  const { error } = await supabase
    .from('profiles')
    .update({ ...v, age: v.age ? Number(v.age) : null, updated_at: new Date().toISOString() })
    .eq('id', account.user.id);
  setButtonLoading(b, false);
  document.querySelector('#profile-feedback').textContent = error ? error.message : 'Profile saved.';
  document.querySelector('#profile-feedback').className = `status-line sm:col-span-2 ${error ? 'error' : 'success'}`;
  if (!error) toast('Profile updated.');
};

load();
