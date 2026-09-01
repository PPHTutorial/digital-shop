import { supabase } from './client.js';
import { CONFIG } from './config.js';
import { enhanceSelect, refreshSelect } from './select.js';
import { enhanceCheckbox, enhanceRadio, enhanceDateInput, enhanceDateTimeInput } from './form-controls.js';
// Side-effect: captures ?ref=CODE into a first-party cookie on every page load.
import './affiliate-track.js';

export function startPageLoader() {
  if (document.querySelector('#page-loader')) return;
  const l = document.createElement('div');
  l.id = 'page-loader';
  l.className = 'page-loader';
  l.innerHTML = '<div class="loader-card"><div class="shimmer logo"></div><div class="shimmer hero"></div><div class="shimmer short"></div></div>';
  document.body.prepend(l);
}
export function finishPageLoader() {
  const loader = document.querySelector('#page-loader');
  if (loader) {
    loader.classList.add('is-done');
    setTimeout(() => {
      loader.remove();
    }, 400);
  }
}
export function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

/**
 * Compact "1.2K / 3.4M / 5.6B / 7.8T" formatting for dashboard cards and
 * tables where a raw figure (revenue, order counts, product counts…) would
 * otherwise blow out a stat card's width. Values under 1000 print as-is —
 * no point compacting "482".
 */
export function compactNumber(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const units = [
    { at: 1e12, suffix: 'T' },
    { at: 1e9, suffix: 'B' },
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'K' },
  ];
  for (const { at, suffix } of units) {
    if (abs >= at) {
      const scaled = n / at;
      const rounded = Math.abs(scaled) >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `${rounded}${suffix}`;
    }
  }
  return n.toLocaleString();
}

/** Same compacting, prefixed with a currency amount, e.g. "$1.2M". */
export function compactMoney(value, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${compactNumber(value)}`;
}

/**
 * A small, dependency-free markdown-to-HTML pass — headings, bold/italic,
 * links, inline code, unordered/ordered lists, and paragraphs. Not a full
 * CommonMark implementation; it covers what a product/blog author actually
 * types. Input is escaped first, so the only HTML that reaches the page is
 * what this function itself emits.
 */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const inline = (line) => escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const blocks = text.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) return '';

    const headingMatch = lines.length === 1 && lines[0].match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length + 1; // # -> h2, ## -> h3, ### -> h4
      return `<h${level}>${inline(headingMatch[2])}</h${level}>`;
    }

    const isUnordered = lines.every((l) => /^[-*]\s+/.test(l));
    if (isUnordered) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }

    const isOrdered = lines.every((l) => /^\d+\.\s+/.test(l));
    if (isOrdered) {
      return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }

    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');

  return html;
}
const TOAST_GLYPH = { success: '✓', error: '!', warning: '!', info: 'i' };
export function toast(message,type='success'){let r=document.querySelector('#toast-region');if(!r){r=document.createElement('div');r.id='toast-region';r.className='toast-region';document.body.append(r)}const e=document.createElement('div');e.className=`toast toast-${type}`;e.innerHTML=`<span>${TOAST_GLYPH[type]||'✓'}</span><p>${escapeHtml(message)}</p><button>×</button>`;e.querySelector('button').onclick=()=>e.remove();r.append(e);setTimeout(()=>e.remove(),6000)}
export function setButtonLoading(b,loading,label='Please wait…'){if(!b)return;if(loading){b.dataset.label=b.textContent;b.disabled=true;b.innerHTML=`<span class="spinner"></span>${label}`}else{b.disabled=false;b.textContent=b.dataset.label||b.textContent}}
export async function getAccount(){const{data:{user}}=await supabase.auth.getUser();if(!user)return{user:null,profile:null};const{data:profile}=await supabase.from('profiles').select('full_name,role,phone,address,country,occupation,age,created_at,admin_tier,account_status,account_status_reason').eq('id',user.id).maybeSingle();return{user,profile}}
export const icon = (name, size = 18) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;

export const SITE_ORIGIN = 'https://digistore.codeinktechnologies.com';

/**
 * Point rel=canonical (and og:url) at one specific URL. Blog posts and
 * products have their own path (/blog/<slug>, /product/<slug>); the remaining
 * param views (?doc=, ?category=, ?vendor=) still share a shell, so without an
 * explicit canonical Google clusters the variants and drops all but one. Call
 * this once per view with the URL that view should own. Pass a path
 * ("/blog/slug"); an absolute URL is used as-is. Creates the <link> if the
 * page's HTML lacks one.
 */
export function setCanonical(pathOrUrl) {
  const href = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : SITE_ORIGIN + (String(pathOrUrl).startsWith('/') ? pathOrUrl : `/${pathOrUrl}`);
  let link = document.head.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  link.href = href;
  document.head.querySelector('meta[property="og:url"]')?.setAttribute('content', href);
}

/**
 * Inject (or replace) a single JSON-LD <script> for structured data. `id`
 * keeps repeat calls idempotent when a view re-renders.
 */
export function setJsonLd(data, id = 'page-jsonld') {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

// Social handles stored in site_settings.social (jsonb). Edited on the admin
// Settings screen, rendered in the footer. `icon` is a lucide name — brand
// glyphs that lucide lacks fall back to a close-enough generic.
export const SOCIAL_LINKS = [
  { key: 'twitter', label: 'X / Twitter', icon: 'twitter', placeholder: 'https://x.com/yourhandle' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram', placeholder: 'https://instagram.com/yourhandle' },
  { key: 'facebook', label: 'Facebook', icon: 'facebook', placeholder: 'https://facebook.com/yourpage' },
  { key: 'linkedin', label: 'LinkedIn', icon: 'linkedin', placeholder: 'https://linkedin.com/company/…' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube', placeholder: 'https://youtube.com/@yourchannel' },
  { key: 'tiktok', label: 'TikTok', icon: 'music-2', placeholder: 'https://tiktok.com/@yourhandle' },
  { key: 'github', label: 'GitHub', icon: 'github', placeholder: 'https://github.com/yourorg' },
  { key: 'discord', label: 'Discord', icon: 'message-circle', placeholder: 'https://discord.gg/invite' },
  { key: 'whatsapp', label: 'WhatsApp', icon: 'phone', placeholder: 'https://wa.me/1234567890' },
];
export function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/lucide@latest';
  script.onload = () => window.lucide?.createIcons();
  document.head.append(script);
}

/* ==========================================================================
   Theme (light / dark / system)
   ---------------------------------------------------------------------------
   css/app.css already carries the palette: `:root` is light, an explicit
   `:root[data-theme="dark"]` block is dark, and
   `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`
   follows the OS when nothing explicit is set. These helpers are the only
   thing that writes `data-theme`; the tiny inline script in each page's
   <head> re-applies the stored choice before first paint (no flash).
   ========================================================================== */

const THEME_KEY = 'digistore-theme';
export const THEME_MODES = ['system', 'light', 'dark'];
const THEME_META = {
  system: { icon: 'monitor', label: 'System' },
  light: { icon: 'sun', label: 'Light' },
  dark: { icon: 'moon', label: 'Dark' },
};

export function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

export function setTheme(theme) {
  const next = THEME_MODES.includes(theme) ? theme : 'system';
  try {
    if (next === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch { /* storage may be unavailable; theme still applies for this load */ }
  applyTheme(next);
  syncThemeToggles();
  window.dispatchEvent(new CustomEvent('digistore:theme', { detail: { theme: next } }));
}

/** Call once on page load to restore whatever the visitor last chose. */
export function initTheme() {
  applyTheme(getStoredTheme());
  syncThemeToggles();
}

/**
 * Markup for a 3-way segmented control. `compact` drops the text labels
 * (utility bar); the drawers use the full version. Multiple instances can
 * live on one page — `syncThemeToggles()` keeps every copy in step.
 */
export function renderThemeToggle({ compact = false } = {}) {
  const current = getStoredTheme();
  const opts = THEME_MODES.map((mode) => {
    const meta = THEME_META[mode];
    return `<button type="button" class="theme-toggle__opt" data-theme-set="${mode}"
      role="radio" aria-checked="${mode === current ? 'true' : 'false'}"
      aria-label="${meta.label} theme" title="${meta.label} theme">
      ${icon(meta.icon, 15)}<span class="theme-toggle__label">${meta.label}</span>
    </button>`;
  }).join('');
  return `<div class="theme-toggle${compact ? ' theme-toggle--compact' : ''}" role="radiogroup" aria-label="Colour theme" data-theme-toggle>${opts}</div>`;
}

/** Reflect the stored choice onto every rendered toggle on the page. */
export function syncThemeToggles() {
  const current = getStoredTheme();
  document.querySelectorAll('[data-theme-toggle]').forEach((group) => {
    group.querySelectorAll('[data-theme-set]').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.themeSet === current ? 'true' : 'false');
    });
  });
}

/**
 * Delegate clicks for every theme toggle to the document, once per page.
 * Toggles are re-rendered by mountHeader on each auth change, so binding
 * per-element would stack listeners — delegation sidesteps that.
 */
export function wireThemeToggles() {
  if (document.body.dataset.themeToggleWired) return;
  document.body.dataset.themeToggleWired = 'true';
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-theme-set]');
    if (!btn) return;
    setTheme(btn.dataset.themeSet);
  });
}

/* ==========================================================================
   Custom form controls, site-wide
   ---------------------------------------------------------------------------
   js/select.js and js/form-controls.js each keep the native element in the
   DOM and layer a token-styled control on top; every enhancer is a no-op on
   an element it has already handled (guards on `data-enhanced`). This is the
   one entry point that applies all of them — used both for a one-shot pass
   and by the MutationObserver in initControlsAutoEnhance().
   Opt out by putting `data-no-enhance` on the control or any ancestor.
   ========================================================================== */

export function enhanceControls(scope = document) {
  const root = scope || document;
  if (root.nodeType !== 1 && root.nodeType !== 9) return;
  const ok = (el) => !el.closest('[data-no-enhance]');
  const label = (el) =>
    el.closest('label')?.querySelector('.label, .field-label')?.textContent?.trim() ||
    el.getAttribute('aria-label') || '';

  root.querySelectorAll('select:not([data-enhanced])').forEach((el) => {
    // Skip a select that has nothing in it yet — country/category pickers are
    // populated async. The observer re-runs once the <option>s land.
    if (ok(el) && el.options.length) { el._optCount = el.options.length; enhanceSelect(el, { label: label(el) }); }
  });
  // A select whose option list was swapped out with innerHTML= after it was
  // enhanced needs its custom list re-read (callers should call refreshSelect,
  // but this heals the ones that forget).
  root.querySelectorAll('select[data-enhanced]').forEach((el) => {
    if (el._optCount !== el.options.length) { el._optCount = el.options.length; refreshSelect(el); }
  });
  root.querySelectorAll('input[type="checkbox"]:not([data-enhanced])').forEach((el) => { if (ok(el)) enhanceCheckbox(el); });
  root.querySelectorAll('input[type="radio"]:not([data-enhanced])').forEach((el) => { if (ok(el)) enhanceRadio(el); });
  root.querySelectorAll('input[type="date"]:not([data-enhanced])').forEach((el) => { if (ok(el)) enhanceDateInput(el); });
  root.querySelectorAll('input[type="datetime-local"]:not([data-enhanced])').forEach((el) => { if (ok(el)) enhanceDateTimeInput(el); });
}

let _controlsObserver = null;
const RAW_CONTROL_SEL = 'select:not([data-enhanced]), input[type="checkbox"]:not([data-enhanced]), input[type="radio"]:not([data-enhanced]), input[type="date"]:not([data-enhanced]), input[type="datetime-local"]:not([data-enhanced])';

/**
 * Enhance what's on the page now, then watch <body> for injected markup and
 * enhance that too — page scripts render lists, tables and modals well after
 * this runs, and asking every call site to remember an enhance call is how
 * coverage rots. Debounced to one pass per frame, and only re-scans when an
 * added node actually carries an un-enhanced native control, so a custom
 * control mutating its own innards (e.g. a select repainting its trigger)
 * does not trigger a document sweep.
 */
export function initControlsAutoEnhance() {
  if (_controlsObserver) return;
  enhanceControls(document);
  let queued = false;
  const flush = () => { queued = false; enhanceControls(document); };
  const hasRawControl = (node) =>
    node.nodeType === 1 && (node.matches?.(RAW_CONTROL_SEL) || node.querySelector?.(RAW_CONTROL_SEL));
  _controlsObserver = new MutationObserver((records) => {
    if (queued) return;
    for (const rec of records) {
      // <option>s arriving into a select that was added empty (populated async).
      if (rec.target?.nodeName === 'SELECT' && !rec.target.dataset.enhanced && rec.target.options.length) {
        queued = true; requestAnimationFrame(flush); return;
      }
      for (const node of rec.addedNodes) {
        if (hasRawControl(node)) {
          queued = true;
          requestAnimationFrame(flush);
          return;
        }
      }
    }
  });
  _controlsObserver.observe(document.body, { childList: true, subtree: true });
}

// Fetched once per page load and cached — every page's header shows the
// same "top categories" quick-nav, and mountHeader's render() re-runs on
// every auth-state change, so this must not re-query each time.
let topCategoriesPromise = null;
function loadTopCategories() {
  if (topCategoriesPromise) return topCategoriesPromise;
  topCategoriesPromise = (async () => {
    try {
      let productsQuery = supabase.from('products').select('category').eq('is_published', true);
      if (CONFIG.ADS_LIVE) productsQuery = productsQuery.eq('is_ad', false);
      const [productsResult, categoriesResult] = await Promise.all([
        productsQuery,
        supabase.from('categories').select('name,slug').eq('is_active', true),
      ]);
      const counts = new Map();
      for (const row of productsResult.data || []) {
        const key = row.category || 'General';
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const slugByName = new Map((categoriesResult.data || []).map((c) => [c.name, c.slug]));
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name]) => ({ name, slug: slugByName.get(name) || '' }));
    } catch {
      return [];
    }
  })();
  return topCategoriesPromise;
}

export async function mountHeader() {
  const target = document.querySelector('#site-header');
  if (!target) return;
  // Re-assert the saved theme (the <head> inline script already did this for
  // first paint; this covers pages that somehow lack it) and bind the toggle.
  initTheme();
  wireThemeToggles();
  // Custom select/checkbox/radio/date controls, on this page and anything
  // rendered into it later.
  initControlsAutoEnhance();
  const render = async () => {
    const { user, profile } = await getAccount();
    const name = profile?.full_name || 'My account';

    // Existing sellers get a route to their centre rather than a pitch to
    // become one. Single indexed lookup on a unique column; if it fails we just
    // show the invitation, which still lands on the right page either way.
    let isSeller = false;
    if (user) {
      try {
        const { data: vendorRow } = await supabase
          .from('vendors').select('status').eq('user_id', user.id).maybeSingle();
        isSeller = Boolean(vendorRow);
      } catch {
        /* non-fatal */
      }
    }

    // URLs are extensionless now, but a direct /index.html hit must still read
    // as home, so both spellings are accepted below. The first path segment is
    // the section — /blog/<slug> and /product/<slug> keep the nav highlighted.
    const segments = window.location.pathname.toLowerCase().split('/').filter(Boolean);
    const path = segments[segments.length - 1] || '';
    const section = segments[0] || '';
    const hash = window.location.hash.toLowerCase();

    const isHome = (segments.length === 0 || path === 'index' || path === 'index.html');
    const isStore = section === 'store' || section === 'product';
    const isBlog = section === 'blog';
    const isAbout = section === 'about';
    const isContact = section === 'contact';
    const isSupport = section === 'support';
    const isLeaderboard = section === 'leaderboard';

    // The Figma nav was 4 plain-text links (Home/All Products/About/Contact)
    // with no icons; Blog is back in the visible nav per the project owner,
    // Support still stays reachable via the drawer/footer only. The search
    // bar's width now flexes (see .nav-search) rather than holding a fixed
    // 480px, so the 5th link doesn't crowd it.
    const links = `
      <a href="./" class="${isHome ? 'active' : ''}">Home</a>
      <a href="./store" class="${isStore ? 'active' : ''}">All Products</a>
      <a href="./blog" class="${isBlog ? 'active' : ''}">Blog</a>
      <a href="./leaderboard" class="${isLeaderboard ? 'active' : ''}">Leaderboard</a>
      <a href="./about" class="${isAbout ? 'active' : ''}">About</a>
      <a href="./contact" class="${isContact ? 'active' : ''}">Contact</a>
    `;

    // The nav drawer (hamburger) carries only site destinations — icons plus
    // the two pages the compact desktop nav dropped. Account-specific links
    // (My account/Admin centre/Log out/Log in/Create account) live in the
    // separate account drawer below instead, opened from the account chip.
    const drawerLinks = `
      <a href="./" class="${isHome ? 'active' : ''}">${icon('house')}<span>Home</span></a>
      <a href="./store" class="${isStore ? 'active' : ''}">${icon('shopping-bag')}<span>All Products</span></a>
      <a href="./blog" class="${isBlog ? 'active' : ''}">${icon('newspaper')}<span>Blog</span></a>
      <a href="./leaderboard" class="${isLeaderboard ? 'active' : ''}">${icon('trophy')}<span>Leaderboard</span></a>
      <a href="./about" class="${isAbout ? 'active' : ''}">${icon('info')}<span>About</span></a>
      <a href="./contact" class="${isContact ? 'active' : ''}">${icon('mail')}<span>Contact</span></a>
      <a href="./support" class="${isSupport ? 'active' : ''}">${icon('circle-help')}<span>Support</span></a>
    `;

    // Selling is a headline route, not a buried one: a signed-in seller goes
    // straight to their centre, everyone else to the pitch.
    const sellHref = './vendor';
    const sellLabel = isSeller ? 'Seller centre' : 'Start selling';

    const topCategories = await loadTopCategories();
    const categoryLinksHtml = topCategories.map(({ name }) => {
      const shortLabel = name.split(' & ')[0];
      return `<a class="catnavbar__link" href="./store?category=${encodeURIComponent(name)}"><span>${escapeHtml(shortLabel)}</span>${icon('chevron-down', 10)}</a>`;
    }).join('');

    target.innerHTML = `
      <div class="utility-bar">
        <div class="header-shell utility-content">
          <div class="utility-left">
            <a href="mailto:hello@codeinktechnologies.com">${icon('mail', 13)} hello@codeinktechnologies.com</a>
            <span>Digital products, delivered securely</span>
          </div>
          <div class="utility-right">
            <span>${icon('shield-check', 13)} Tax &amp; VAT Compliant</span>
            ${renderThemeToggle({ compact: true })}
          </div>
        </div>
      </div>
      <div class="main-nav-container">
        <div class="main-nav">
          <a href="./" class="brand">
            <span class="brand-mark">D</span>
            <span>Digi<em>Store</em></span>
          </a>
          <form id="header-search-form" class="nav-search" role="search">
            <span class="nav-search__icon">${icon('search', 16)}</span>
            <input id="header-search-input" type="search" name="search" placeholder="Search templates, ebooks, software, design assets…" aria-label="Search products">
            <span class="nav-search__kbd">${navigator.platform?.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl K'}</span>
          </form>
          <div class="header-actions">
          <nav class="nav-links" aria-label="Main navigation">${links}</nav>
          <span class="nav-divider" aria-hidden="true"></span>
          <div class="nav-actions">
            <a class="cart-link" href="./cart" aria-label="View cart">
              ${icon('shopping-bag', 20)}
              <span class="cart-link__badge hidden" data-cart-badge>0</span>
            </a>
            ${
              user
                ? `<details class="account-popover">
                    <summary class="account-chip">
                      <span class="avatar">${escapeHtml(name[0].toUpperCase())}</span>
                      <!-- <span>${escapeHtml(name)}</span> -->
                      ${icon('chevron-down', 15)}
                    </summary>
                    <div class="account-popover-panel">
                      <strong>${escapeHtml(name)}</strong>
                      <a href="./account">${icon('layout-dashboard', 16)} Overview</a>
                      <a href="./account#orders-list">${icon('package', 16)} Orders</a>
                      <a href="./checkout">${icon('shopping-cart', 16)} Cart / checkout</a>
                      <a href="${sellHref}" class="popover-sell">${icon('store', 16)} ${sellLabel}</a>
                      ${profile?.role === 'admin' ? `<a href="./admin">${icon('shield-check', 16)} Admin centre</a>` : ''}
                      <button id="sign-out">${icon('log-out', 16)} Log out</button>
                    </div>
                  </details>`
                : `<a class="text-action" href="./auth">Log in</a><a class="button button-primary" href="./auth?mode=signup">Get started</a>`
            }
            <button id="account-menu-button" class="account-menu-button" aria-label="Account menu">
              ${user ? `<span class="avatar">${escapeHtml(name[0].toUpperCase())}</span>` : icon('user-round', 20)}
            </button>
            <button id="mobile-menu-button" class="mobile-menu-button" aria-label="Open menu">${icon('menu', 22)}</button>
          </div>
          </div>
        </div>
      </div>
      <div class="catnavbar">
        <div class="header-shell catnavbar__inner">
          <a class="catnavbar__all" href="./categories">${icon('list', 16)}<span>All Categories</span></a>
          <div class="catnavbar__links">${categoryLinksHtml}</div>
        </div>
      </div>
    `;

    // The drawers live on <body>, never inside #site-header. The header carries
    // `backdrop-blur`, and backdrop-filter creates a containing block for
    // position:fixed descendants — nested here a drawer would be positioned
    // and clipped against the header box instead of the viewport, and its
    // z-index would be trapped inside the header's stacking context.
    document.querySelector('#mobile-drawer')?.remove();
    document.querySelector('#mobile-scrim')?.remove();
    document.querySelector('#account-drawer')?.remove();
    document.querySelector('#account-scrim')?.remove();

    const scrim = document.createElement('div');
    scrim.id = 'mobile-scrim';
    scrim.className = 'mobile-scrim';

    const drawer = document.createElement('aside');
    drawer.id = 'mobile-drawer';
    drawer.className = 'mobile-drawer';
    drawer.setAttribute('aria-label', 'Menu');
    drawer.innerHTML = `
      <div class="mobile-drawer-head">
        <strong>DigiStore</strong>
        <button id="mobile-menu-close" aria-label="Close menu">${icon('x', 22)}</button>
      </div>
      <nav>
        <form id="drawer-search-form" class="drawer-search" role="search">
          <span class="drawer-search__icon">${icon('search', 16)}</span>
          <input id="drawer-search-input" type="search" name="search" placeholder="Search products…" aria-label="Search products">
        </form>
        ${drawerLinks}
        <a href="./categories">${icon('layout-grid')} Browse Categories</a>
        <a href="./affiliate">${icon('link')} Affiliate programme</a>
        <a href="${sellHref}" class="drawer-sell">${icon('store')} ${sellLabel}</a>
        <div class="drawer-theme"><span>Theme</span>${renderThemeToggle()}</div>
      </nav>`;

    // The account drawer carries only account/session actions — split out of
    // the old combined drawer so the hamburger stays pure navigation. Opened
    // from the account chip (`#account-menu-button`), which is the mobile
    // stand-in for the desktop hover/click popover (hidden below 1024px).
    const acctScrim = document.createElement('div');
    acctScrim.id = 'account-scrim';
    acctScrim.className = 'mobile-scrim';

    const acctDrawer = document.createElement('aside');
    acctDrawer.id = 'account-drawer';
    acctDrawer.className = 'mobile-drawer';
    acctDrawer.setAttribute('aria-label', 'Account menu');
    acctDrawer.innerHTML = `
      <div class="mobile-drawer-head">
        <strong>${user ? escapeHtml(name) : 'Your account'}</strong>
        <button id="account-drawer-close" aria-label="Close account menu">${icon('x', 22)}</button>
      </div>
      <nav>
        ${
          user
            ? `<a href="./account">${icon('layout-dashboard')}<span>Overview</span></a>
               <a href="./account#orders-list">${icon('package')}<span>Orders</span></a>
               <a href="./checkout">${icon('shopping-cart')}<span>Cart / checkout</span></a>
               <a href="${sellHref}">${icon('store')}<span>${sellLabel}</span></a>
               <a href="./affiliate">${icon('link')}<span>Affiliate programme</span></a>
               ${profile?.role === 'admin' ? `<a href="./admin">${icon('shield-check')}<span>Admin centre</span></a>` : ''}
               <button id="account-drawer-signout">${icon('log-out')}<span>Log out</span></button>`
            : `<a href="./auth">${icon('log-in')}<span>Log in</span></a>
               <a href="./auth?mode=signup">${icon('user-plus')}<span>Create account</span></a>
               <a href="./affiliate">${icon('link')}<span>Affiliate programme</span></a>`
        }
        <div class="drawer-theme"><span>Theme</span>${renderThemeToggle()}</div>
      </nav>`;

    document.body.append(scrim, drawer, acctScrim, acctDrawer);

    // A shared scroll lock: the page behind must not scroll while either
    // drawer is open.
    const syncScrollLock = () => {
      const anyOpen = drawer.classList.contains('open') || acctDrawer.classList.contains('open');
      document.body.style.overflow = anyOpen ? 'hidden' : '';
    };
    const setDrawer = (open) => {
      drawer.classList.toggle('open', open);
      scrim.classList.toggle('open', open);
      syncScrollLock();
      if (open) drawer.querySelector('a, button')?.focus();
    };
    const setAccountDrawer = (open) => {
      acctDrawer.classList.toggle('open', open);
      acctScrim.classList.toggle('open', open);
      syncScrollLock();
      if (open) acctDrawer.querySelector('a, button')?.focus();
    };

    // Header search. On the catalog page itself, typing filters the grid in
    // place (debounced — store.js listens for 'digistore:search'); no reload,
    // no need to press Enter. From every other page there's no local grid to
    // filter, so a query still hands off to the catalog, just debounced
    // instead of requiring Enter.
    const isStorePage = /(^|\/)store(\.html)?\/?$/.test(location.pathname);
    const debounce = (fn, wait) => {
      let timer;
      return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
    };
    const goSearch = (value) => {
      const q = value.trim();
      if (!q) return;
      location.href = `./store?search=${encodeURIComponent(q)}`;
    };
    const liveSearch = debounce((value) => {
      const q = value.trim();
      if (isStorePage) {
        const url = new URL(location.href);
        if (q) url.searchParams.set('search', q); else url.searchParams.delete('search');
        history.replaceState(null, '', url);
        window.dispatchEvent(new CustomEvent('digistore:search', { detail: { query: q } }));
      } else if (q) {
        goSearch(q);
      }
    }, 350);
    const initialQuery = new URLSearchParams(location.search).get('search') || '';
    if (initialQuery) {
      const headerInput = target.querySelector('#header-search-input');
      const drawerInput = drawer.querySelector('#drawer-search-input');
      if (headerInput) headerInput.value = initialQuery;
      if (drawerInput) drawerInput.value = initialQuery;
    }
    target.querySelector('#header-search-input')?.addEventListener('input', (e) => liveSearch(e.target.value));
    drawer.querySelector('#drawer-search-input')?.addEventListener('input', (e) => liveSearch(e.target.value));
    target.querySelector('#header-search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!isStorePage) goSearch(target.querySelector('#header-search-input')?.value || '');
    });
    drawer.querySelector('#drawer-search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!isStorePage) goSearch(drawer.querySelector('#drawer-search-input')?.value || '');
    });
    // ⌘K / Ctrl+K jumps focus to the header search from anywhere on the page.
    // Bound once, guarded like the popover dismiss handler below.
    if (!document.body.dataset.searchShortcutWired) {
      document.body.dataset.searchShortcutWired = 'true';
      document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          const input = document.querySelector('#header-search-input');
          if (input) {
            event.preventDefault();
            input.focus();
            input.select();
          }
        }
      });
    }

    target.querySelector('#mobile-menu-button').onclick = () => setDrawer(true);
    drawer.querySelector('#mobile-menu-close').onclick = () => setDrawer(false);
    scrim.onclick = () => setDrawer(false);
    // Any destination closes it — in-page links would otherwise leave it open.
    drawer.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setDrawer(false)));

    target.querySelector('#account-menu-button').onclick = () => setAccountDrawer(true);
    acctDrawer.querySelector('#account-drawer-close').onclick = () => setAccountDrawer(false);
    acctScrim.onclick = () => setAccountDrawer(false);
    acctDrawer.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setAccountDrawer(false)));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setDrawer(false);
        setAccountDrawer(false);
      }
    });

    renderIcons();
    finishPageLoader();

    // Publish the real height of the sticky header (utility bar + main nav +
    // category bar) as `--header-h`. Every `position: sticky` top offset and
    // the page's `scroll-padding-top` are expressed as `calc(var(--header-h) +
    // …)`, so anything pinned below the header — dashboard sidebars, the cart
    // and checkout summaries, in-page anchor jumps — clears it instead of
    // tucking underneath. The height changes with the viewport (the category
    // bar is hidden under 1024px, the nav shrinks) so we re-measure on resize.
    const syncHeaderHeight = () => {
      const h = target.getBoundingClientRect().height;
      if (h) document.documentElement.style.setProperty('--header-h', `${Math.round(h)}px`);
    };
    syncHeaderHeight();
    requestAnimationFrame(syncHeaderHeight);
    if (document.fonts?.ready) document.fonts.ready.then(syncHeaderHeight).catch(() => {});
    if (!document.body.dataset.headerHeightWired) {
      document.body.dataset.headerHeightWired = 'true';
      window.addEventListener('resize', () => requestAnimationFrame(syncHeaderHeight));
    }

    // Real cart count for a signed-in shopper — no badge (not a "0") for
    // anonymous visitors, since there's nothing server-side to count for them.
    if (user) {
      supabase.from('cart_items').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
        .then(({ count }) => {
          document.querySelectorAll('[data-cart-badge]').forEach((el) => {
            el.textContent = String(count || 0);
            el.classList.toggle('hidden', !count);
          });
        });
    }

    const logout = async () => {
      await supabase.auth.signOut();
      location.href = './';
    };
    target.querySelector('#sign-out')?.addEventListener('click', logout);
    acctDrawer.querySelector('#account-drawer-signout')?.addEventListener('click', logout);

    // <details> has no dismiss-on-outside-click of its own, so it would stay
    // open until clicked again. Bound once, guarded by a flag, because
    // mountHeader re-renders on every auth state change.
    if (!document.body.dataset.popoverWired) {
      document.body.dataset.popoverWired = 'true';
      document.addEventListener('click', (event) => {
        document.querySelectorAll('details.account-popover[open]').forEach((details) => {
          if (!details.contains(event.target)) details.open = false;
        });
      });
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('details.account-popover[open]').forEach((d) => { d.open = false; });
      });
    }
  };
  await render();
  supabase.auth.onAuthStateChange(() => render());
}
export function mountFooter() {
  let target = document.querySelector('#site-footer');
  if (!target) {
    target = document.createElement('footer');
    target.id = 'site-footer';
    document.body.append(target);
  }
  const year = new Date().getFullYear();
  target.className = 'pt-14 pb-10 border-t mt-auto';
  target.style.background = 'var(--surface)';
  target.style.borderColor = 'var(--border)';
  target.style.color = 'var(--text-muted)';
  target.innerHTML = `
    <div class="shell space-y-12">
      <div class="seller-strip">
        <div>
          <span class="seller-strip__eyebrow">Sell on DigiStore</span>
          <h3 class="seller-strip__title">Turn what you make into income</h3>
          <p class="seller-strip__body">
            Publish your templates, ebooks, courses or software. We handle checkout, payment
            verification and secure delivery — you get paid to your bank or mobile money.
          </p>
        </div>
        <a class="seller-strip__cta" href="./vendor">
          ${icon('store', 16)}<span>Open your store</span>
        </a>
      </div>

      <div class="grid gap-10 grid-cols-2 lg:grid-cols-6 text-sm">
        <div class="col-span-2 space-y-4 pr-4">
          <div class="flex items-center gap-3">
            <span class="brand-mark">D</span>
            <div>
              <span class="text-xl font-black tracking-tight" style="color:var(--text);font-family:var(--font-display)">DigiStore</span>
              <span class="block text-[11px] font-medium uppercase tracking-wider" style="color:var(--text-muted)">by Codeink Technologies</span>
            </div>
          </div>
          <p class="text-xs leading-relaxed max-w-sm" style="color:var(--text-muted)">
            DigiStore is a global marketplace for premium digital products — ebooks, software, templates, online courses and design assets — from verified independent creators. Human-reviewed listings, instant secure delivery, and buyer protection on every order.
          </p>
          <div class="pt-2 flex flex-wrap gap-2 items-center text-[11px]" style="color:var(--text-muted)">
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-medium" style="background:var(--surface-sunken)">
              ${icon('shield-check', 13)}
              <span>Verified Merchant Platform</span>
            </span>
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-medium" style="background:var(--surface-sunken)">
              ${icon('lock', 13)}
              <span>256-Bit SSL Encrypted</span>
            </span>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="text-xs uppercase tracking-wider" style="color:var(--text);font-family:var(--font-display);font-weight:700">Digital Catalog</h3>
          <ul class="space-y-2 text-xs" style="color:var(--text-muted)">
            <li><a href="./store?category=Ebooks%20%26%20Guides" class="hover:opacity-100" style="transition:color .15s">Ebooks &amp; Guides</a></li>
            <li><a href="./store?category=Software%20%26%20Tools">Software &amp; Tools</a></li>
            <li><a href="./store?category=Templates%20%26%20Themes">Templates &amp; Themes</a></li>
            <li><a href="./store?category=Online%20Courses">Online Courses</a></li>
            <li><a href="./store?category=Audio%20%26%20Media">Audio &amp; Media</a></li>
            <li><a href="./store?category=Design%20%26%20Graphics">Design &amp; Graphics</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="text-xs uppercase tracking-wider" style="color:var(--text);font-family:var(--font-display);font-weight:700">Customer Hub</h3>
          <ul class="space-y-2 text-xs" style="color:var(--text-muted)">
            <li><a href="./account">My Account &amp; Vault</a></li>
            <li><a href="./account#orders-list">Order History</a></li>
            <li><a href="./support">Customer Helpdesk</a></li>
            <li><a href="./support">Submit Support Ticket</a></li>
            <li><a href="./leaderboard">Leaderboards &amp; Badges</a></li>
            <li><a href="./blog">Articles &amp; Updates</a></li>
            <li><a href="./about">About Codeink</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="text-xs uppercase tracking-wider" style="color:var(--text);font-family:var(--font-display);font-weight:700">Sell With Us</h3>
          <ul class="space-y-2 text-xs" style="color:var(--text-muted)">
            <li><a href="./vendor" class="font-bold" style="color:var(--accent-strong,#92660a)">Start selling →</a></li>
            <li><a href="./vendor">Seller centre</a></li>
            <li><a href="./affiliate">Affiliate programme</a></li>
            <li><a href="./categories">What sells here</a></li>
            <li><a href="./legal?doc=vendor-agreement">Vendor Agreement</a></li>
            <li><a href="./legal?doc=payouts">Payout &amp; Settlement Policy</a></li>
            <li><a href="./support">Seller support</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="text-xs uppercase tracking-wider" style="color:var(--text);font-family:var(--font-display);font-weight:700">Trust &amp; Legal</h3>
          <ul class="space-y-2 text-xs" style="color:var(--text-muted)">
            <li><a href="./legal?doc=terms">Terms of Service</a></li>
            <li><a href="./legal?doc=privacy">Privacy Policy</a></li>
            <li><a href="./legal?doc=cookies">Cookie Policy</a></li>
            <li><a href="./legal?doc=refunds">Refund &amp; Return Policy</a></li>
            <li><a href="./legal?doc=licence">Digital License Agreement</a></li>
            <li><a href="./legal?doc=acceptable-use">Acceptable Use Policy</a></li>
            <li><a href="./legal?doc=ip-dmca">IP &amp; Takedown Policy</a></li>
            <li><a href="./legal">All legal &amp; compliance</a></li>
          </ul>
        </div>
      </div>

      <div class="pt-8 flex flex-wrap items-center justify-between gap-6 text-xs" style="border-top:1px solid var(--border);color:var(--text-soft)">
        <div>
          <p>© ${year} <strong style="color:var(--text-muted)">Codeink Technologies</strong>. All rights reserved.</p>
          <p class="text-[11px] mt-0.5">DigiStore is a registered digital-commerce platform operated by Codeink Technologies.</p>
          <div id="footer-social" class="footer-social"></div>
        </div>
        <div class="flex flex-wrap items-center gap-5 sm:gap-6">
          <div class="flex items-center gap-1.5 opacity-80 hover:opacity-100 transition cursor-default" title="Flutterwave Verified Partner">
            <svg class="h-4 w-auto" viewBox="0 0 120 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 0C5.6 0 0 5.6 0 12.5C0 19.4 5.6 25 12.5 25C13.8 25 15.1 24.8 16.3 24.4C13.2 21.6 11.2 17.5 11.2 13C11.2 8.5 13.2 4.4 16.3 1.6C15.1 1.2 13.8 0 12.5 0Z" fill="#FB9129"/>
              <path d="M17.5 3.2C15.1 5.7 13.7 9.2 13.7 13C13.7 16.8 15.1 20.3 17.5 22.8C20 20.3 21.4 16.8 21.4 13C21.4 9.2 20 5.7 17.5 3.2Z" fill="#F5A623"/>
              <path d="M22.5 1.6C25.6 4.4 27.6 8.5 27.6 13C27.6 17.5 25.6 21.6 22.5 24.4C23.7 24.8 25 25 26.3 25C33.2 25 38.8 19.4 38.8 12.5C38.8 5.6 33.2 0 26.3 0C25 0 23.7 0.2 22.5 1.6Z" fill="#2563EB"/>
              <text x="44" y="17" fill="#FFFFFF" font-family="system-ui, sans-serif" font-weight="800" font-size="12" letter-spacing="-0.2">Flutterwave</text>
            </svg>
          </div>
          <div class="flex items-center gap-1.5 opacity-80 hover:opacity-100 transition cursor-default" title="NOWPayments Crypto Gateway">
            <svg class="h-4 w-auto" viewBox="0 0 125 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="13" r="10" fill="#00E5FF" fill-opacity="0.15"/>
              <path d="M8 8L16 13L8 18V8Z" fill="#00E5FF"/>
              <text x="26" y="17" fill="#00E5FF" font-family="system-ui, sans-serif" font-weight="800" font-size="11.5" letter-spacing="0.2">NOWPayments</text>
            </svg>
          </div>
          <div class="flex items-center gap-1.5 opacity-80 hover:opacity-100 transition cursor-default" title="Mobile Money (GHS / KES / UGX / RWF)">
            <svg class="h-4 w-auto" viewBox="0 0 105 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="10" cy="13" r="8" fill="#FFCC00"/>
              <path d="M7 10H13V16H7V10Z" fill="#000000"/>
              <text x="22" y="17" fill="#FFCC00" font-family="system-ui, sans-serif" font-weight="800" font-size="11.5">MoMo &amp; M-Pesa</text>
            </svg>
          </div>
          <div class="flex items-center opacity-80 hover:opacity-100 transition cursor-default" title="Visa">
            <svg class="h-4 w-auto" viewBox="0 0 45 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <text x="2" y="14" fill="#60A5FA" font-family="system-ui, sans-serif" font-weight="900" font-style="italic" font-size="16" letter-spacing="1">VISA</text>
            </svg>
          </div>
          <div class="flex items-center opacity-80 hover:opacity-100 transition cursor-default" title="Mastercard">
            <svg class="h-4 w-auto" viewBox="0 0 34 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="10" cy="10" r="9" fill="#EB001B"/>
              <circle cx="24" cy="10" r="9" fill="#F79E1B" fill-opacity="0.85"/>
            </svg>
          </div>
        </div>
      </div>
    </div>`;
  renderIcons();

  // Social handles come from site_settings.social (admin-editable). Only the
  // ones that are filled in are shown.
  supabase.from('site_settings').select('social').eq('id', 1).maybeSingle().then(({ data }) => {
    const social = data?.social || {};
    const host = document.querySelector('#footer-social');
    if (!host) return;
    host.innerHTML = SOCIAL_LINKS
      .filter((s) => social[s.key])
      .map((s) => `<a href="${escapeHtml(social[s.key])}" target="_blank" rel="noopener noreferrer" aria-label="${s.label}" title="${s.label}">${icon(s.icon, 16)}</a>`)
      .join('');
    renderIcons();
  }, () => {});
}

export function initMotion(){document.body.classList.add('page-enter');const items=document.querySelectorAll('.reveal');if(!('IntersectionObserver'in window)){items.forEach(i=>i.classList.add('is-visible'));return}const o=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');o.unobserve(e.target)}}),{threshold:.12});items.forEach(i=>o.observe(i))}
