/**
 * Shared UI: site chrome, notifications, dialogs, and theme.
 *
 * Everything here renders with the design-system classes in css/src — no
 * inline styling, no utility-class soup, and no runtime CSS injection.
 */

import { supabase, getAccount } from './client.js';
import { CONFIG } from './config.js';
import { icon } from './icons.js';
import { $, esc, html, raw, when, on, trapFocus } from './dom.js';
import { initials } from './format.js';

export { esc, html, raw, when } from './dom.js';
export { icon } from './icons.js';

/* ==========================================================================
   Theme
   ========================================================================== */

const THEME_KEY = 'digistore.theme';

/** Applies the saved theme before first paint. Call at module top level. */
export function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }
  return stored ?? 'system';
}

export function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode — the choice simply does not persist */
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  return next;
}

/* ==========================================================================
   Boot screen
   ========================================================================== */

export function bootDone() {
  const boot = $('#boot');
  if (!boot) return;
  boot.classList.add('is-done');
  setTimeout(() => boot.remove(), 300);
}

/* ==========================================================================
   Toast
   ========================================================================== */

const TOAST_ICON = { ok: 'checkCircle', error: 'alertCircle', info: 'info' };

/**
 * Shows a transient message. `type` is one of ok | error | info.
 * Errors stay twice as long because they usually require reading.
 */
export function toast(message, type = 'ok', { duration } = {}) {
  let region = $('#toaster');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toaster';
    region.className = 'toaster';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.innerHTML = html`
    ${raw(icon(TOAST_ICON[type] || 'info'))}
    <p>${message}</p>
    <button class="toast__close" type="button" aria-label="Dismiss">${raw(icon('x', 14))}</button>
  `;

  const dismiss = () => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 160);
  };

  node.querySelector('.toast__close').addEventListener('click', dismiss);
  region.append(node);
  setTimeout(dismiss, duration ?? (type === 'error' ? 9000 : 4500));
  return dismiss;
}

/* ==========================================================================
   Busy state
   ========================================================================== */

/** Swaps a button into a disabled, spinner-labelled state and back again. */
export function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    if (button.dataset.idleHtml === undefined) button.dataset.idleHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner"></span>${esc(label)}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleHtml !== undefined) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
  }
}

/* ==========================================================================
   Confirm dialog — replaces window.confirm
   ========================================================================== */

export function confirmDialog({
  title,
  body = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog dialog--narrow';
    dialog.innerHTML = html`
      <div class="dialog__head">
        <div>
          <h2 class="dialog__title">${title}</h2>
          ${when(body, () => html`<p class="dialog__sub">${body}</p>`)}
        </div>
      </div>
      <div class="dialog__foot">
        <button class="btn" value="cancel" type="button">${cancelLabel}</button>
        <button class="btn btn--${tone === 'danger' ? 'danger' : 'primary'}" value="confirm" type="button">
          ${confirmLabel}
        </button>
      </div>
    `;

    const finish = (result) => {
      release();
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    dialog.querySelector('[value="cancel"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[value="confirm"]').addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });

    document.body.append(dialog);
    const release = trapFocus(dialog);
    dialog.showModal();
    dialog.querySelector('[value="confirm"]').focus();
  });
}

/** Closes a `<dialog>` when the backdrop, rather than the panel, is clicked. */
export function closeOnBackdrop(dialog) {
  dialog.addEventListener('mousedown', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
}

/* ==========================================================================
   Site header
   ========================================================================== */

const NAV = [
  { href: './index.html', label: 'Home', icon: 'home', match: ['index.html', ''] },
  { href: './store.html', label: 'Catalog', icon: 'store', match: ['store.html'] },
  { href: './blog.html', label: 'Journal', icon: 'journal', match: ['blog.html', 'post.html'] },
  { href: './about.html', label: 'About', icon: 'info', match: ['about.html'] },
  { href: './contact.html', label: 'Contact', icon: 'mail', match: ['contact.html'] },
  { href: './support.html', label: 'Support', icon: 'support', match: ['support.html'] },
];

function currentPage() {
  return (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
}

function navMarkup(page) {
  return NAV.map(
    (item) => html`
      <a href="${item.href}" class="${item.match.includes(page) ? 'is-active' : ''}">${item.label}</a>
    `,
  ).join('');
}

function drawerNavMarkup(page) {
  return NAV.map(
    (item) => html`
      <a href="${item.href}" class="${item.match.includes(page) ? 'is-active' : ''}">
        ${raw(icon(item.icon))}<span>${item.label}</span>
      </a>
    `,
  ).join('');
}

function accountMarkup(account) {
  if (!account.user) {
    return html`
      <a class="btn btn--sm hide-sm" href="./auth.html">Sign in</a>
      <a class="btn btn--sm btn--primary" href="./auth.html?mode=signup">Create account</a>
    `;
  }

  const name = account.profile?.full_name || account.user.email || 'Account';
  return html`
    <details class="account">
      <summary>
        <span class="account__trigger">
          <span class="avatar">${initials(name)}</span>
          <span>${name}</span>
          ${raw(icon('chevronDown'))}
        </span>
      </summary>
      <div class="account__panel menu">
        <div class="account__identity">
          <strong>${name}</strong>
          <small>${account.user.email}</small>
        </div>
        <a class="menu__item" href="./account.html">${raw(icon('dashboard'))} Overview</a>
        <a class="menu__item" href="./account.html#library">${raw(icon('download'))} My library</a>
        <a class="menu__item" href="./account.html#orders">${raw(icon('inbox'))} Orders</a>
        ${when(
          account.isAdmin,
          () => html`
            <div class="menu__sep"></div>
            <a class="menu__item" href="./admin.html">${raw(icon('shield'))} Admin console</a>
            <a class="menu__item" href="./studio.html">${raw(icon('docs'))} Content studio</a>
          `,
        )}
        <div class="menu__sep"></div>
        <button class="menu__item menu__item--danger" type="button" data-signout>
          ${raw(icon('logout'))} Sign out
        </button>
      </div>
    </details>
  `;
}

/**
 * Renders the header into `#site-header` and keeps it in sync with auth state.
 * Safe to call on any page; no-ops when the mount point is absent.
 */
export async function mountHeader({ categories = [] } = {}) {
  const target = $('#site-header');
  if (!target) return;

  const render = async () => {
    const account = await getAccount();
    const page = currentPage();

    target.className = 'site-header';
    target.innerHTML = html`
      <div class="utility">
        <div class="container utility__inner">
          <span>Instant, verified delivery on every digital order.</span>
          <div class="utility__list">
            <a href="./support.html">Help centre</a>
            <a href="mailto:${CONFIG.SUPPORT_EMAIL}">${CONFIG.SUPPORT_EMAIL}</a>
          </div>
        </div>
      </div>
      <div class="container masthead">
        <a class="wordmark" href="./index.html">
          <span class="wordmark__mark">D</span>
          <span>
            <span class="wordmark__name">${CONFIG.STORE_NAME}</span>
            <span class="wordmark__by">by ${CONFIG.STORE_OPERATOR}</span>
          </span>
        </a>
        <nav class="nav" aria-label="Primary">${raw(navMarkup(page))}</nav>
        <div class="masthead__actions">
          <button class="btn btn--sm btn--ghost btn--icon" type="button" data-theme-toggle
                  aria-label="Switch colour theme" title="Switch colour theme">
            ${raw(icon(currentTheme() === 'dark' ? 'sun' : 'moon'))}
          </button>
          ${raw(accountMarkup(account))}
          <button class="btn btn--sm btn--ghost btn--icon hide-md" type="button" data-drawer-open aria-label="Open menu">
            ${raw(icon('menu'))}
          </button>
        </div>
      </div>
      ${when(
        categories.length,
        () => html`
          <div class="catstrip">
            <div class="container catstrip__inner">
              <a href="./store.html" class="${page === 'store.html' && !new URLSearchParams(location.search).get('category') ? 'is-active' : ''}">All products</a>
              ${raw(
                categories
                  .slice(0, 8)
                  .map(
                    (category) => html`
                      <a href="./store.html?category=${encodeURIComponent(category.name)}">${category.name}</a>
                    `,
                  )
                  .join(''),
              )}
              <a class="catstrip__end" href="./store.html">Browse catalog →</a>
            </div>
          </div>
        `,
      )}
    `;

    mountDrawer(page, account);
    wireHeaderEvents(target);
  };

  await render();
  supabase.auth.onAuthStateChange(() => {
    render().catch(() => {});
  });
}

function wireHeaderEvents(target) {
  target.querySelector('[data-theme-toggle]')?.addEventListener('click', (event) => {
    const next = toggleTheme();
    event.currentTarget.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
  });

  on(target, 'click', '[data-signout]', async () => {
    await supabase.auth.signOut();
    window.location.href = './index.html';
  });

  target.querySelector('[data-drawer-open]')?.addEventListener('click', () => setDrawer(true));

  // A details-based menu should close when focus or the pointer leaves it.
  const account = target.querySelector('.account');
  if (account) {
    document.addEventListener('click', (event) => {
      if (account.open && !account.contains(event.target)) account.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && account.open) account.open = false;
    });
  }
}

function mountDrawer(page, account) {
  document.querySelector('#drawer')?.remove();
  document.querySelector('#scrim')?.remove();

  const scrim = document.createElement('div');
  scrim.id = 'scrim';
  scrim.className = 'scrim';

  const drawer = document.createElement('aside');
  drawer.id = 'drawer';
  drawer.className = 'drawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = html`
    <div class="drawer__head">
      <span class="wordmark">
        <span class="wordmark__mark">D</span>
        <span class="wordmark__name">${CONFIG.STORE_NAME}</span>
      </span>
      <button class="btn btn--sm btn--ghost btn--icon" type="button" data-drawer-close aria-label="Close menu">
        ${raw(icon('x'))}
      </button>
    </div>
    <nav class="drawer__nav" aria-label="Mobile">
      ${raw(drawerNavMarkup(page))}
      <hr />
      ${when(
        account.user,
        () => html`
          <a href="./account.html">${raw(icon('user'))}<span>My account</span></a>
          ${when(
            account.isAdmin,
            () => html`
              <a href="./admin.html">${raw(icon('shield'))}<span>Admin console</span></a>
              <a href="./studio.html">${raw(icon('docs'))}<span>Content studio</span></a>
            `,
          )}
          <button type="button" data-signout>${raw(icon('logout'))}<span>Sign out</span></button>
        `,
      )}
      ${when(
        !account.user,
        () => html`
          <a href="./auth.html">${raw(icon('login'))}<span>Sign in</span></a>
          <a href="./auth.html?mode=signup">${raw(icon('user'))}<span>Create account</span></a>
        `,
      )}
    </nav>
  `;

  document.body.append(scrim, drawer);
  scrim.addEventListener('click', () => setDrawer(false));
  drawer.querySelector('[data-drawer-close]').addEventListener('click', () => setDrawer(false));
  on(drawer, 'click', '[data-signout]', async () => {
    await supabase.auth.signOut();
    window.location.href = './index.html';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setDrawer(false);
  });
}

function setDrawer(open) {
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  if (!drawer || !scrim) return;
  drawer.classList.toggle('is-open', open);
  scrim.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) drawer.querySelector('a, button')?.focus();
}

/* ==========================================================================
   Site footer
   ========================================================================== */

const FOOTER_COLUMNS = [
  {
    title: 'Catalog',
    links: [
      ['Ebooks & guides', './store.html?category=Ebooks%20%26%20Guides'],
      ['Software & tools', './store.html?category=Software%20%26%20Tools'],
      ['Templates & themes', './store.html?category=Templates%20%26%20Themes'],
      ['Online courses', './store.html?category=Online%20Courses'],
      ['Audio & media', './store.html?category=Audio%20%26%20Media'],
      ['Design & graphics', './store.html?category=Design%20%26%20Graphics'],
    ],
  },
  {
    title: 'Your account',
    links: [
      ['Overview', './account.html'],
      ['Purchase history', './account.html#orders'],
      ['Download library', './account.html#library'],
      ['Help centre', './support.html'],
      ['Journal', './blog.html'],
    ],
  },
  {
    title: 'Company',
    links: [
      ['About DigiStore', './about.html'],
      ['Contact', './contact.html'],
      ['Terms of service', './legal.html#terms'],
      ['Privacy policy', './legal.html#privacy'],
      ['Refund policy', './legal.html#refunds'],
      ['Licence agreement', './legal.html#licence'],
    ],
  },
];

const PAY_MARKS = `
  <svg viewBox="0 0 48 16" role="img" aria-label="Visa"><text x="0" y="12.5" fill="currentColor" font-family="system-ui,sans-serif" font-size="13" font-weight="700" font-style="italic" letter-spacing="0.5">VISA</text></svg>
  <svg viewBox="0 0 34 16" role="img" aria-label="Mastercard"><circle cx="11" cy="8" r="6.5" fill="none" stroke="currentColor"/><circle cx="21" cy="8" r="6.5" fill="none" stroke="currentColor"/></svg>
  <svg viewBox="0 0 78 16" role="img" aria-label="Flutterwave"><circle cx="7" cy="8" r="5.5" fill="none" stroke="currentColor"/><text x="17" y="12" fill="currentColor" font-family="system-ui,sans-serif" font-size="10" font-weight="600">Flutterwave</text></svg>
  <svg viewBox="0 0 44 16" role="img" aria-label="Mobile Money"><rect x="1" y="1.5" width="9" height="13" rx="1.5" fill="none" stroke="currentColor"/><text x="14" y="12" fill="currentColor" font-family="system-ui,sans-serif" font-size="10" font-weight="600">MoMo</text></svg>
  <svg viewBox="0 0 62 16" role="img" aria-label="Crypto via NOWPayments"><path d="M4 3v10l7-5z" fill="none" stroke="currentColor"/><text x="15" y="12" fill="currentColor" font-family="system-ui,sans-serif" font-size="10" font-weight="600">Crypto</text></svg>
`;

export function mountFooter() {
  let target = $('#site-footer');
  if (!target) {
    target = document.createElement('footer');
    target.id = 'site-footer';
    document.body.append(target);
  }

  target.className = 'site-footer';
  target.innerHTML = html`
    <div class="container">
      <div class="footer__grid">
        <div class="footer__col">
          <span class="wordmark">
            <span class="wordmark__mark">D</span>
            <span>
              <span class="wordmark__name">${CONFIG.STORE_NAME}</span>
              <span class="wordmark__by">by ${CONFIG.STORE_OPERATOR}</span>
            </span>
          </span>
          <p class="footer__about">
            A digital storefront for practitioners: ebooks, software, templates, and courses,
            each delivered through a signed, expiring link the moment payment clears.
          </p>
          <div class="row row-2 mt-5">
            <span class="tag">${raw(icon('shield', 12))} Verified merchant</span>
            <span class="tag">${raw(icon('lock', 12))} TLS encrypted</span>
          </div>
        </div>
        ${raw(
          FOOTER_COLUMNS.map(
            (column) => html`
              <div class="footer__col">
                <h3>${column.title}</h3>
                <ul class="list-reset">
                  ${raw(column.links.map(([label, href]) => html`<li><a href="${href}">${label}</a></li>`).join(''))}
                </ul>
              </div>
            `,
          ).join(''),
        )}
      </div>
      <div class="footer__base">
        <p>© ${new Date().getFullYear()} ${CONFIG.STORE_OPERATOR}. All rights reserved.</p>
        <div class="footer__pay">
          <span>Payments</span>
          ${raw(PAY_MARKS)}
        </div>
      </div>
    </div>
  `;
}

/* ==========================================================================
   Scroll reveal
   ========================================================================== */

/** Adds `.is-visible` to `[data-reveal]` elements as they enter the viewport. */
export function initReveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]:not(.is-visible)');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px' },
  );
  items.forEach((item) => observer.observe(item));
}
