import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { mountFooter, mountHeader, setButtonLoading, toast } from './ui.js';

mountHeader();
mountFooter();

const form = document.querySelector('#auth-form');
const title = document.querySelector('#auth-title');
const submit = document.querySelector('#auth-submit');
const toggle = document.querySelector('#auth-toggle');
const notice = document.querySelector('#auth-notice');
let mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';

function setMode(nextMode) {
  mode = nextMode;
  title.textContent = mode === 'signup' ? 'Create your account' : 'Welcome back';
  submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  toggle.textContent = mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account';
  document.querySelector('#full-name-wrap').hidden = mode !== 'signup';
  document.querySelector('[name="full_name"]').required = mode === 'signup';
  notice.textContent = '';
}

async function redirectIfSignedIn() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const next = new URLSearchParams(location.search).get('next');
    if (next) {
      location.replace(next.startsWith('./') || next.startsWith('/') ? next : `./${next}`);
    } else {
      location.replace('./account.html');
    }
  }
}

toggle.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  setButtonLoading(submit, true, mode === 'signup' ? 'Creating account…' : 'Signing in…');
  notice.textContent = '';
  const redirectTo = `${CONFIG.SITE_URL}${location.pathname.replace(/[^/]+$/, 'auth.html')}`;
  const result = mode === 'signup'
    ? await supabase.auth.signUp({ email: values.email, password: values.password, options: { data: { full_name: values.full_name }, emailRedirectTo: redirectTo } })
    : await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
  setButtonLoading(submit, false);
  if (result.error) {
    notice.textContent = result.error.message;
    notice.className = 'status-line error';
    toast(result.error.message, 'error');
    return;
  }
  if (mode === 'signup' && !result.data.session) {
    notice.textContent = 'Check your email to confirm your DigiStore account, then sign in.';
    notice.className = 'status-line success';
    return;
  }
  const next = new URLSearchParams(location.search).get('next');
  location.href = next ? `./${next}` : './account.html';
});

setMode(mode);
redirectIfSignedIn();
