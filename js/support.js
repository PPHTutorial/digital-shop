/**
 * Support page: ticket submission plus the CMS-driven FAQ list
 * (`cms_documents`, type `faq`, one document per question).
 */

import { supabase } from './client.js';
import { $, esc } from './dom.js';
import { initTheme, mountHeader, mountFooter, bootDone, toast, setBusy } from './ui.js';

initTheme();
mountHeader();
mountFooter();

async function loadFaqs() {
  const { data } = await supabase
    .from('cms_documents')
    .select('title,published')
    .eq('type', 'faq')
    .not('published', 'is', null);
  return (data || [])
    .map((row) => ({ question: row.title, ...row.published }))
    .sort((a, b) => (Number(a.ordering) || 0) - (Number(b.ordering) || 0));
}

function paintFaqs(items) {
  const grid = $('#faq-grid');
  grid.innerHTML = items.length
    ? items
        .map(
          (item) => `
            <article class="panel">
              <div class="panel__body stack-2">
                <h3 class="t-14 w-semibold">${esc(item.question)}</h3>
                <p class="t-13 muted">${esc(item.answer || '')}</p>
              </div>
            </article>
          `,
        )
        .join('')
    : '<p class="t-13 muted">FAQs are coming soon.</p>';
}

async function run() {
  try {
    paintFaqs(await loadFaqs());
  } catch {
    paintFaqs([]);
  }
  bootDone();
}

run();

$('#support-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, 'Sending…');

  const payload = Object.fromEntries(new FormData(form).entries());
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('tickets').insert({ ...payload, user_id: user?.id || null });

  setBusy(button, false);
  if (error) {
    toast('We could not submit your support request. Please try again.', 'error');
    return;
  }
  form.reset();
  toast('Your support request has been sent.');
});
