import { supabase } from './client.js';
import { finishPageLoader, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { enhanceSelect } from './select.js';

const CATEGORY_LABEL = {
  Payment: 'Payment & Gateway Confirmation',
  Download: 'Download Token & File Access',
  Account: 'Customer Account & Vault',
  Licensing: 'Product Licensing & Updates',
  Other: 'General Inquiry',
};

async function init() {
  mountHeader();
  mountFooter();
  renderIcons();
  enhanceSelect(document.querySelector('#contact-category'), { label: 'Subject category' });

  document.querySelector('#contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    setButtonLoading(button, true, 'Sending…');

    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const { data: { user } } = await supabase.auth.getUser();

    // The Figma form has no separate subject field — the contact form's
    // "category" doubles as `tickets.subject` (which is NOT NULL), rather
    // than fabricating an invisible field the visitor never sees.
    const { error } = await supabase.from('tickets').insert({
      name: payload.name,
      email: payload.email,
      category: payload.category,
      subject: CATEGORY_LABEL[payload.category] || payload.category,
      message: payload.message,
      user_id: user?.id || null,
    });

    setButtonLoading(button, false);
    if (error) {
      toast('We could not send your message. Please try again.', 'error');
      return;
    }
    event.currentTarget.reset();
    toast('Thanks — your message has been sent. We’ll reply by email.');
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
