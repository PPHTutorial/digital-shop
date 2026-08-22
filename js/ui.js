import { supabase } from './client.js';

const brand = 'DigiStore';

export function toast(message, type = 'success') {
  let region = document.querySelector('#toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</span><p>${escapeHtml(message)}</p><button aria-label="Dismiss notification">×</button>`;
  item.querySelector('button').addEventListener('click', () => item.remove());
  region.append(item);
  window.setTimeout(() => item.remove(), 6000);
}

export function setButtonLoading(button, loading, label = 'Please wait…') {
  if (!button) return;
  if (loading) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label}`;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || button.textContent;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

export async function getAccount() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };
  const { data: profile } = await supabase.from('profiles').select('full_name,role,phone,address,country,occupation,age').eq('id', user.id).maybeSingle();
  return { user, profile };
}

export async function mountHeader() {
  const target = document.querySelector('#site-header');
  if (!target) return;
  const render = async () => {
    const { user, profile } = await getAccount();
    const name = profile?.full_name || user?.email?.split('@')[0] || 'Account';
    target.innerHTML = `<div class="utility-bar"><div class="shell utility-content"><span>Digital products, delivered securely</span><a href="mailto:hello@codeinktechnologies.com">hello@codeinktechnologies.com</a></div></div><div class="shell main-nav"><a href="./index.html" class="brand"><span class="brand-mark">D</span><span>DigiStore<small>powered by codeinktechnologies</small></span></a><nav class="nav-links" aria-label="Main navigation"><a href="./index.html">Home</a><div class="nav-dropdown"><button type="button">Catalog <span>⌄</span></button><div class="dropdown-panel"><a href="./index.html#store">All products</a><a href="./index.html#featured">Featured releases</a><a href="./index.html#collections">Collections</a></div></div><a href="./support.html">Support</a>${profile?.role === 'admin' ? '<a href="./admin.html">Admin</a>' : ''}</nav><div class="nav-actions">${user ? `<a class="account-chip" href="./account.html" title="Manage account"><span class="avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span><span>${escapeHtml(name)}</span></a><button id="sign-out" class="text-action">Log out</button>` : '<a class="text-action" href="./auth.html">Log in</a><a class="button button-primary" href="./auth.html?mode=signup">Get started</a>'}</div></div>`;
    target.querySelector('#sign-out')?.addEventListener('click', async () => {
      await supabase.auth.signOut();
      toast('You have been logged out.');
      window.setTimeout(() => location.href = './index.html', 350);
    });
  };
  await render();
  supabase.auth.onAuthStateChange(() => render());
}

export function requireElement(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}
