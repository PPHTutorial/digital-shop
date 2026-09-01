/**
 * Affiliate centre.
 *
 * Public pitch + terms for anyone; an application form for signed-in users who
 * have not enrolled; a dashboard for approved affiliates. Everything money-
 * related is read straight from the affiliate_* tables (RLS scopes every row to
 * the signed-in affiliate) and written through apply_as_affiliate() /
 * request_affiliate_payout() — the browser never computes a balance.
 */
import { supabase } from './client.js';
import { CONFIG } from './config.js';
import {
  escapeHtml, finishPageLoader, getAccount, mountFooter, mountHeader, renderIcons, setButtonLoading, toast,
} from './ui.js';
import { renderDataTable, statusBadge } from './uikit.js';
import { formatCurrency } from './currency.js';

let account = null;
let affiliate = null;
let settings = null;

const $ = (sel, root = document) => root.querySelector(sel);
const show = (id) => {
  ['aff-gate', 'aff-public', 'aff-pending', 'aff-dashboard'].forEach((s) => {
    $(`#${s}`)?.classList.toggle('hidden', s !== id);
  });
};

async function loadSettings() {
  const { data } = await supabase
    .from('site_settings')
    .select('affiliate_program_enabled, affiliate_commission_rate, affiliate_commission_basis, affiliate_cookie_days, affiliate_hold_days, affiliate_min_payout')
    .eq('id', 1)
    .maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return data || {
    affiliate_program_enabled: true, affiliate_commission_rate: 10, affiliate_commission_basis: 'gross',
    affiliate_cookie_days: 90, affiliate_hold_days: 14, affiliate_min_payout: 50,
  };
}

function paintFacts() {
  const basis = settings.affiliate_commission_basis === 'platform_net' ? 'of the platform net' : 'of the order value';
  const map = {
    rate: `${Number(settings.affiliate_commission_rate)}% ${basis}`,
    cookie: `${settings.affiliate_cookie_days} days`,
    min: formatCurrency(settings.affiliate_min_payout, 'USD'),
    hold: `${settings.affiliate_hold_days} days`,
  };
  document.querySelectorAll('#aff-facts [data-fact]').forEach((el) => {
    el.textContent = map[el.dataset.fact] ?? '—';
  });
}

/* ==========================================================================
   Application form (public view)
   ========================================================================== */
function wireApplyForm() {
  const form = $('#aff-apply-form');
  const feedback = $('#aff-apply-feedback');
  const hint = $('#aff-signin-hint');

  if (!account?.user) {
    form.querySelectorAll('input, textarea, select, button').forEach((el) => { el.disabled = true; });
    hint?.classList.remove('hidden');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!account?.user) { location.href = './auth?mode=signup&next=affiliate'; return; }
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    feedback.textContent = '';
    setButtonLoading(button, true, 'Submitting…');
    const { data, error } = await supabase.rpc('apply_as_affiliate', {
      p_website: fd.get('website') || null,
      p_promo_methods: fd.get('promo_methods') || null,
      p_payout_method: fd.get('payout_method') || 'bank',
      p_payout_currency: fd.get('payout_currency') || 'USD',
    });
    setButtonLoading(button, false);
    if (error) {
      feedback.textContent = error.message;
      feedback.className = 'status-line error';
      toast(error.message, 'error');
      return;
    }
    supabase.rpc('record_legal_acceptance', {
      p_slugs: ['terms', 'vendor-agreement'], p_context: 'affiliate_signup', p_user_agent: navigator.userAgent,
    }).catch(() => {});
    toast('Application submitted — we’ll be in touch by email.', 'success');
    void data;
    await route();
  });
}

/* ==========================================================================
   Dashboard (approved view)
   ========================================================================== */
function referralLink() {
  return `${CONFIG.SITE_URL.replace(/\/$/, '')}/?ref=${encodeURIComponent(affiliate.code)}`;
}

async function loadEarnings() {
  const { data } = await supabase
    .from('affiliate_earnings')
    .select('id, created_at, commission_amount, commission_rate, commission_basis, currency, status, gross_amount, available_at, product_id, products(title)')
    .order('created_at', { ascending: false })
    .limit(200);
  return data || [];
}

async function loadPayouts() {
  const { data } = await supabase
    .from('affiliate_payouts')
    .select('id, requested_at, amount, currency, status, reference, processed_at')
    .order('requested_at', { ascending: false })
    .limit(50);
  return data || [];
}

function sumBy(rows, pred) {
  return rows.filter(pred).reduce((acc, r) => acc + Number(r.commission_amount || 0), 0);
}

async function paintDashboard() {
  show('aff-dashboard');

  $('#aff-status-line').textContent =
    `Code ${affiliate.code} · joined ${new Date(affiliate.created_at).toLocaleDateString()}`;

  const link = $('#aff-link');
  link.value = referralLink();
  $('#aff-link-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      toast('Referral link copied.', 'success');
    } catch {
      link.select();
      document.execCommand?.('copy');
    }
  });

  const [earnings, payouts] = await Promise.all([loadEarnings(), loadPayouts()]);

  const currency = affiliate.payout_currency || 'USD';
  const pending = sumBy(earnings, (r) => r.status === 'pending');
  const available = sumBy(earnings, (r) => r.status === 'available' && !r.payout_id);
  const stats = {
    clicks: affiliate.total_clicks ?? 0,
    signups: affiliate.total_signups ?? 0,
    conversions: affiliate.total_conversions ?? 0,
    pending: formatCurrency(pending, currency),
    available: formatCurrency(available, currency),
    lifetime: formatCurrency(affiliate.total_earned ?? 0, currency),
  };
  document.querySelectorAll('#aff-stats [data-stat]').forEach((el) => {
    el.textContent = String(stats[el.dataset.stat] ?? '—');
  });

  // Payout control
  const min = Number(settings.affiliate_min_payout || 50);
  const btn = $('#aff-payout-btn');
  const note = $('#aff-payout-note');
  const canPayout = available >= min;
  btn.disabled = !canPayout;
  note.textContent = canPayout
    ? `${formatCurrency(available, currency)} available to withdraw.`
    : `You need ${formatCurrency(min, currency)} available to withdraw — you have ${formatCurrency(available, currency)}.`;
  btn.onclick = async () => {
    btn.disabled = true;
    const { data, error } = await supabase.rpc('request_affiliate_payout');
    if (error) { toast(error.message, 'error'); btn.disabled = false; return; }
    toast(`Payout of ${formatCurrency(data.amount, data.currency)} requested.`, 'success');
    await paintDashboard();
  };

  renderDataTable($('#aff-earnings-table'), {
    columns: [
      { key: 'created_at', label: 'Date', render: (r) => new Date(r.created_at).toLocaleDateString() },
      { key: 'product', label: 'Product', render: (r) => escapeHtml(r.products?.title || '—') },
      { key: 'gross_amount', label: 'Order', render: (r) => formatCurrency(r.gross_amount, r.currency) },
      { key: 'commission_rate', label: 'Rate', render: (r) => `${Number(r.commission_rate)}%` },
      { key: 'commission_amount', label: 'Commission', render: (r) => formatCurrency(r.commission_amount, r.currency) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status, r.status === 'paid' ? 'paid out' : r.status) },
    ],
    rows: earnings.slice(0, 50),
    page: 1,
    pageSize: 50,
    total: earnings.length,
    emptyMessage: 'No commissions yet. Share your link to get started.',
  });

  renderDataTable($('#aff-payouts-table'), {
    columns: [
      { key: 'requested_at', label: 'Requested', render: (r) => new Date(r.requested_at).toLocaleDateString() },
      { key: 'amount', label: 'Amount', render: (r) => formatCurrency(r.amount, r.currency) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status, r.status) },
      { key: 'reference', label: 'Reference', render: (r) => escapeHtml(r.reference || '—') },
    ],
    rows: payouts,
    page: 1,
    pageSize: 50,
    total: payouts.length,
    emptyMessage: 'No payouts requested yet.',
  });

  wireSettingsForm();
}

function wireSettingsForm() {
  const form = $('#aff-settings-form');
  if (form.dataset.wired) return;
  form.dataset.wired = 'true';

  form.payout_method.value = affiliate.payout_method || 'bank';
  form.payout_currency.value = affiliate.payout_currency || 'USD';
  form.payout_details.value = typeof affiliate.payout_details === 'string'
    ? affiliate.payout_details
    : (affiliate.payout_details?.raw || '');
  form.promo_methods.value = affiliate.promo_methods || '';
  document.querySelectorAll('#aff-settings-form select').forEach((s) => s.dispatchEvent(new Event('change')));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    const feedback = $('#aff-settings-feedback');
    setButtonLoading(button, true, 'Saving…');
    const { error } = await supabase
      .from('affiliates')
      .update({
        payout_method: fd.get('payout_method'),
        payout_currency: fd.get('payout_currency'),
        payout_details: { raw: fd.get('payout_details') || '' },
        promo_methods: fd.get('promo_methods') || null,
      })
      .eq('id', affiliate.id);
    setButtonLoading(button, false);
    if (error) {
      feedback.textContent = error.message;
      feedback.className = 'status-line error';
      return;
    }
    feedback.textContent = 'Saved.';
    feedback.className = 'status-line success';
    toast('Payout settings saved.', 'success');
  });
}

/* ==========================================================================
   Routing
   ========================================================================== */
async function route() {
  const { data } = await supabase
    .from('affiliates')
    .select('*')
    .eq('user_id', account?.user?.id || '00000000-0000-0000-0000-000000000000')
    .maybeSingle()
    .then((r) => r, () => ({ data: null }));
  affiliate = data;

  if (!affiliate) {
    show('aff-public');
    paintFacts();
    return;
  }
  if (affiliate.status === 'approved') {
    await paintDashboard();
    return;
  }
  if (affiliate.status === 'pending') {
    show('aff-pending');
    return;
  }
  // suspended / rejected — show the public page with a note
  show('aff-public');
  paintFacts();
  const fb = $('#aff-apply-feedback');
  fb.textContent = affiliate.status === 'suspended'
    ? 'Your affiliate account is currently suspended. Contact support if you think this is a mistake.'
    : 'Your previous application was not approved.';
  fb.className = 'status-line error';
}

async function init() {
  mountHeader();
  mountFooter();

  settings = await loadSettings();
  account = await getAccount();

  paintFacts();
  wireApplyForm();

  document.querySelectorAll('[data-aff-join-scroll]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      $('#aff-join')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  if (!settings.affiliate_program_enabled && !account?.user) {
    show('aff-public');
  } else {
    await route();
  }

  renderIcons();
  finishPageLoader();

  supabase.auth.onAuthStateChange(async () => {
    account = await getAccount();
    await route();
    renderIcons();
  });
}

init().catch((err) => {
  console.error(err);
  finishPageLoader();
  show('aff-public');
});
