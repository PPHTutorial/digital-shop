import { supabase } from './client.js';
import { finishPageLoader, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { enhanceSelect } from './select.js';

async function init() {
  mountHeader();
  mountFooter();
  renderIcons();
  enhanceSelect(document.querySelector('#support-category'), { label: 'Ticket issue category' });

  document.querySelector('#support-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    setButtonLoading(button, true, 'Sending…');
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('tickets').insert({ ...payload, user_id: user?.id || null });
    setButtonLoading(button, false);
    if (error) { toast('We could not submit your support request. Please try again.', 'error'); return; }
    event.currentTarget.reset();
    toast('Your support request has been sent.');
  });

  // Filters the FAQ list client-side — the search box is real, not decorative.
  document.querySelector('#faq-search-form')?.addEventListener('submit', (e) => e.preventDefault());
  document.querySelector('#faq-search-input')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#support-faq-list .faq-item').forEach((item) => {
      const text = item.textContent.toLowerCase();
      item.classList.toggle('hidden', Boolean(q) && !text.includes(q));
    });
  });

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

  finishPageLoader();
}

init().catch(() => finishPageLoader());
