import { supabase } from './client.js';
import { setButtonLoading, toast } from './ui.js';
document.querySelector('#support-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  setButtonLoading(button, true, 'Sending…');
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('tickets').insert({ ...payload, user_id: user?.id || null });
  setButtonLoading(button, false);
  if (error) { toast('We could not submit your support request. Please try again.', 'error'); return; }
  event.currentTarget.reset();
  toast('Your support request has been sent.');
});
