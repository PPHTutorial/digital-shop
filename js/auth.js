import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { getStoredReferral } from './affiliate-track.js';

mountHeader();
mountFooter();
renderIcons();

const form = document.querySelector('#auth-form');
const submit = document.querySelector('#auth-submit');
const notice = document.querySelector('#auth-notice');
const tabSignin = document.querySelector('#tab-signin');
const tabSignup = document.querySelector('#tab-signup');
let mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';
let forgotMode = false;

function setMode(nextMode) {
  mode = nextMode;
  forgotMode = false;
  tabSignin.classList.toggle('is-active', mode === 'signin');
  tabSignup.classList.toggle('is-active', mode === 'signup');
  submit.textContent = mode === 'signup' ? 'Create Account' : 'Sign In to Account';
  document.querySelector('#full-name-wrap').classList.toggle('hidden', mode !== 'signup');
  document.querySelector('[name="full_name"]').required = mode === 'signup';
  const termsWrap = document.querySelector('#auth-terms-wrap');
  termsWrap.classList.toggle('hidden', mode !== 'signup');
  document.querySelector('#auth-accept').required = mode === 'signup';
  document.querySelector('#auth-password').required = true;
  document.querySelector('#auth-password').closest('.form-field').classList.remove('hidden');
  notice.textContent = '';
}

async function redirectIfSignedIn() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const next = new URLSearchParams(location.search).get('next');
    if (next) {
      location.replace(next.startsWith('./') || next.startsWith('/') ? next : `./${next}`);
    } else {
      location.replace('./account');
    }
  }
}

tabSignin.addEventListener('click', () => setMode('signin'));
tabSignup.addEventListener('click', () => setMode('signup'));

document.querySelector('#forgot-password-link').addEventListener('click', async (event) => {
  event.preventDefault();
  if (!forgotMode) {
    forgotMode = true;
    document.querySelector('#auth-password').closest('.form-field').classList.add('hidden');
    document.querySelector('#auth-password').required = false;
    submit.textContent = 'Send Reset Link';
    notice.textContent = 'Enter your email above, then send a reset link.';
    notice.className = 'status-line';
    return;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());

  if (forgotMode) {
    setButtonLoading(submit, true, 'Sending…');
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${CONFIG.SITE_URL}${location.pathname.replace(/[^/]+$/, 'account')}`,
    });
    setButtonLoading(submit, false);
    submit.textContent = 'Send Reset Link';
    if (error) {
      notice.textContent = error.message;
      notice.className = 'status-line error';
      return;
    }
    notice.textContent = 'Check your email for a password reset link.';
    notice.className = 'status-line success';
    return;
  }

  setButtonLoading(submit, true, mode === 'signup' ? 'Creating account…' : 'Signing in…');
  notice.textContent = '';
  const redirectTo = `${CONFIG.SITE_URL}${location.pathname.replace(/[^/]+$/, 'auth')}`;
  // Carry any affiliate referral into signup metadata so the DB trigger
  // (handle_new_user) can set profiles.referred_by.
  const referral = getStoredReferral();
  const signupData = { full_name: values.full_name };
  if (referral) { signupData.ref_code = referral.code; signupData.ref_vid = referral.vid; }
  const result = mode === 'signup'
    ? await supabase.auth.signUp({ email: values.email, password: values.password, options: { data: signupData, emailRedirectTo: redirectTo } })
    : await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
  setButtonLoading(submit, false);
  submit.textContent = mode === 'signup' ? 'Create Account' : 'Sign In to Account';
  if (result.error) {
    notice.textContent = result.error.message;
    notice.className = 'status-line error';
    toast(result.error.message, 'error');
    return;
  }
  // Record legal acceptance (audit only, never blocks). Needs a session, so
  // when email confirmation defers it we stash a flag and record on first sign-in.
  const LEGAL_PENDING = 'digistore-legal-pending';
  const recordAcceptance = (slugs, ctx) => supabase.rpc('record_legal_acceptance', {
    p_slugs: slugs, p_context: ctx, p_user_agent: navigator.userAgent,
  }).catch(() => {});
  if (mode === 'signup') {
    if (result.data.session) recordAcceptance(['terms', 'privacy', 'refunds'], 'signup');
    else { try { localStorage.setItem(LEGAL_PENDING, 'terms,privacy,refunds|signup'); } catch { /* ignore */ } }
  } else if (result.data.session) {
    try {
      const pending = localStorage.getItem(LEGAL_PENDING);
      if (pending) {
        const [slugs, ctx] = pending.split('|');
        recordAcceptance(slugs.split(','), ctx || 'signup');
        localStorage.removeItem(LEGAL_PENDING);
      }
    } catch { /* ignore */ }
  }

  if (mode === 'signup' && !result.data.session) {
    notice.textContent = 'Check your email to confirm your DigiStore account, then sign in.';
    notice.className = 'status-line success';
    return;
  }
  const next = new URLSearchParams(location.search).get('next');
  location.href = next ? `./${next}` : './account';
});

setMode(mode);
redirectIfSignedIn();
