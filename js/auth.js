/**
 * Sign in / register / password reset.
 *
 * One form, three modes. The `next` query parameter is validated before it is
 * used as a redirect target, so the page cannot be turned into an open
 * redirect by a crafted link.
 */

import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { $ } from './dom.js';
import { initTheme, mountHeader, mountFooter, toast, setBusy } from './ui.js';

initTheme();

const params = new URLSearchParams(window.location.search);
let mode = params.get('mode') === 'signup' ? 'signup' : 'signin';

const form = $('#auth-form');
const status = $('#auth-status');
const submit = $('#auth-submit');
const toggle = $('#auth-toggle');
const nameField = $('#name-field');

/** Only same-origin, same-directory page names are accepted as redirects. */
function safeNext() {
  const next = params.get('next');
  if (!next) return './account.html';
  if (!/^[a-z0-9_-]+\.html(\?[^#]*)?$/i.test(next)) return './account.html';
  return `./${next}`;
}

const COPY = {
  signin: {
    eyebrow: 'Account',
    title: 'Sign in',
    lede: 'Your purchases, download links, and receipts live in one place.',
    submit: 'Sign in',
    toggle: 'Create an account instead',
    autocomplete: 'current-password',
  },
  signup: {
    eyebrow: 'New account',
    title: 'Create your account',
    lede: 'You need an account so purchases can be tied to you and re-downloaded later.',
    submit: 'Create account',
    toggle: 'I already have an account',
    autocomplete: 'new-password',
  },
  reset: {
    eyebrow: 'Password',
    title: 'Reset your password',
    lede: 'Enter your email address and we will send a link to set a new password.',
    submit: 'Send reset link',
    toggle: 'Back to sign in',
    autocomplete: 'current-password',
  },
};

function setMode(next) {
  mode = next;
  const copy = COPY[mode];

  $('#auth-eyebrow').textContent = copy.eyebrow;
  $('#auth-title').textContent = copy.title;
  $('#auth-lede').textContent = copy.lede;
  submit.textContent = copy.submit;
  toggle.textContent = copy.toggle;

  nameField.hidden = mode !== 'signup';
  $('#full_name').required = mode === 'signup';

  const password = $('#password');
  password.closest('.field').hidden = mode === 'reset';
  password.required = mode !== 'reset';
  password.autocomplete = copy.autocomplete;
  $('#password-hint').textContent =
    mode === 'signup' ? 'At least 8 characters. Use something you do not reuse elsewhere.' : 'At least 8 characters.';

  $('#auth-reset').hidden = mode === 'reset';
  status.textContent = '';
  status.className = 'status';
}

function report(message, tone = 'error') {
  status.textContent = message;
  status.className = `status status--${tone}`;
}

/** Supabase auth errors are terse; these are the ones users actually hit. */
function describeAuthError(error) {
  const message = error?.message || '';
  if (/Invalid login credentials/i.test(message)) return 'That email and password combination is not recognised.';
  if (/Email not confirmed/i.test(message)) return 'Confirm your email address first — check your inbox for the link.';
  if (/User already registered/i.test(message)) return 'An account already exists for that address. Sign in instead.';
  if (/Password should be at least/i.test(message)) return 'The password must be at least 8 characters.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  return message || 'That did not work. Please try again.';
}

async function redirectIfSignedIn() {
  const { data } = await supabase.auth.getSession();
  if (data?.session) window.location.replace(safeNext());
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const values = Object.fromEntries(new FormData(form).entries());
  const email = String(values.email || '').trim();
  const password = String(values.password || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    report('Enter a valid email address.');
    $('#email').focus();
    return;
  }
  if (mode !== 'reset' && password.length < 8) {
    report('The password must be at least 8 characters.');
    $('#password').focus();
    return;
  }
  if (mode === 'signup' && !String(values.full_name || '').trim()) {
    report('Enter your name.');
    $('#full_name').focus();
    return;
  }

  setBusy(submit, true, COPY[mode].submit.replace(/^(\w+)/, (word) => `${word}ing`));

  const origin = window.location.origin + window.location.pathname.replace(/[^/]+$/, '');

  let result;
  if (mode === 'signup') {
    result = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: String(values.full_name).trim() },
        emailRedirectTo: `${origin}auth.html`,
      },
    });
  } else if (mode === 'reset') {
    result = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}auth.html?mode=signin` });
  } else {
    result = await supabase.auth.signInWithPassword({ email, password });
  }

  setBusy(submit, false);

  if (result.error) {
    report(describeAuthError(result.error));
    return;
  }

  if (mode === 'reset') {
    report('Check your inbox for the reset link.', 'ok');
    return;
  }

  if (mode === 'signup' && !result.data.session) {
    report(`Account created. Confirm your address from the email we sent to ${email}, then sign in.`, 'ok');
    setMode('signin');
    return;
  }

  toast('Signed in.');
  window.location.href = safeNext();
});

toggle.addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
$('#auth-reset').addEventListener('click', () => setMode('reset'));

mountHeader();
mountFooter();
setMode(mode);
redirectIfSignedIn();

// A recovery link returns here with a session already established.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    setMode('signin');
    report('You are signed in. Change your password from your account page.', 'ok');
  }
});

export { CONFIG };
