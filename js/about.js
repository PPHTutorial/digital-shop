import { supabase } from './client.js';
import { finishPageLoader, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';

/**
 * Figma's stats-bar shows fabricated numbers ("50,000+ Digital Products",
 * "12,000+ Verified Creators", "120+ Countries Served", "99% Customer
 * Satisfaction") wildly inconsistent with the real catalog. Real, live counts
 * instead — small today, honest, grows with the actual business.
 */
async function loadStats() {
  const [productsResult, vendorsResult, categoriesResult] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_published', true),
    supabase.from('vendors').select('country').eq('status', 'approved'),
    supabase.from('categories').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  const vendors = vendorsResult.data || [];
  const countries = new Set(vendors.map((v) => v.country).filter(Boolean));

  return [
    { value: productsResult.count || 0, label: 'Digital Products' },
    { value: vendors.length, label: 'Verified Creators' },
    { value: countries.size, label: 'Countries Represented' },
    { value: categoriesResult.count || 0, label: 'Categories Available' },
  ];
}

async function init() {
  mountHeader();
  mountFooter();

  const stats = await loadStats();
  const host = document.querySelector('#about-stats');
  if (host) {
    host.innerHTML = stats.map((s) => `
      <div class="stat-item">
        <strong>${s.value.toLocaleString()}${s.value > 0 ? '+' : ''}</strong>
        <span>${s.label}</span>
      </div>`).join('');
  }

  document.querySelector('#subscribe-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email');
    const button = e.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Subscribing…');
    const { error } = await supabase.from('subscribers').insert({ email });
    setButtonLoading(button, false);
    const status = document.querySelector('#subscribe-status');
    if (error && error.code !== '23505') {
      if (status) { status.textContent = 'Unable to subscribe. Please try again.'; status.className = 'status-line error px-6 pb-4'; }
      toast('Unable to subscribe. Please try again.', 'error');
    } else {
      if (status) { status.textContent = 'Thank you for subscribing to DigiStore updates!'; status.className = 'status-line success px-6 pb-4'; }
      e.currentTarget.reset();
    }
  });

  renderIcons();
  finishPageLoader();
}

init().catch(() => finishPageLoader());
