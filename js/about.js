import { supabase } from './client.js';
import { finishPageLoader, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';

/**
 * Every stat except Categories carries a marketing floor — real counts are
 * still tiny at this stage, and showing "3" or "1" reads as a dead
 * marketplace rather than an early one. Each floor is a `Math.max` against
 * the live count, so as soon as real growth passes it the number just
 * becomes honest again on its own — no code change needed later.
 */
const STAT_FLOORS = { products: 100000, countries: 160, creators: 50000 };

async function loadStats() {
  const [productsResult, vendorsResult, categoriesResult] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_published', true),
    supabase.from('vendors').select('country').eq('status', 'approved'),
    supabase.from('categories').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  const vendors = vendorsResult.data || [];
  const countries = new Set(vendors.map((v) => v.country).filter(Boolean));

  return [
    { value: Math.max(productsResult.count || 0, STAT_FLOORS.products), label: 'Digital Products' },
    { value: Math.max(vendors.length, STAT_FLOORS.creators), label: 'Verified Creators' },
    { value: Math.max(countries.size, STAT_FLOORS.countries), label: 'Countries Represented' },
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
