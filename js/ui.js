import { supabase } from './client.js';

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
export function toast(message,type='success'){let r=document.querySelector('#toast-region');if(!r){r=document.createElement('div');r.id='toast-region';r.className='toast-region';document.body.append(r)}const e=document.createElement('div');e.className=`toast toast-${type}`;e.innerHTML=`<span>${type==='error'?'!':'✓'}</span><p>${escapeHtml(message)}</p><button>×</button>`;e.querySelector('button').onclick=()=>e.remove();r.append(e);setTimeout(()=>e.remove(),6000)}
export function setButtonLoading(b,loading,label='Please wait…'){if(!b)return;if(loading){b.dataset.label=b.textContent;b.disabled=true;b.innerHTML=`<span class="spinner"></span>${label}`}else{b.disabled=false;b.textContent=b.dataset.label||b.textContent}}
export async function getAccount(){const{data:{user}}=await supabase.auth.getUser();if(!user)return{user:null,profile:null};const{data:profile}=await supabase.from('profiles').select('full_name,role,phone,address,country,occupation,age,created_at').eq('id',user.id).maybeSingle();return{user,profile}}
export const icon = (name, size = 18) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;
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

export async function mountHeader() {
  const target = document.querySelector('#site-header');
  if (!target) return;
  const render = async () => {
    const { user, profile } = await getAccount();
    const name = profile?.full_name || 'My account';

    const path = window.location.pathname.toLowerCase().split('/').pop() || 'index.html';
    const hash = window.location.hash.toLowerCase();

    const isHome = (path === 'index.html' || path === '' || path === '/');
    const isStore = path.includes('store');
    const isBlog = path.includes('blog');
    const isAbout = path.includes('about');
    const isContact = path.includes('contact');
    const isSupport = path.includes('support');

    const links = `
      <a href="./index.html" class="${isHome ? 'active' : ''}">${icon('house')}<span>Home</span></a>
      <a href="./store.html" class="${isStore ? 'active' : ''}">${icon('shopping-bag')}<span>All Products</span></a>
      <a href="./blog.html" class="${isBlog ? 'active' : ''}">${icon('newspaper')}<span>Blog</span></a>
      <a href="./about.html" class="${isAbout ? 'active' : ''}">${icon('info')}<span>About</span></a>
      <a href="./contact.html" class="${isContact ? 'active' : ''}">${icon('mail')}<span>Contact</span></a>
      <a href="./support.html" class="${isSupport ? 'active' : ''}">${icon('circle-help')}<span>Support</span></a>
    `;

    // Selling is a headline route, not a buried one: a signed-in seller goes
    // straight to their centre, everyone else to the pitch.
    const sellHref = './vendor.html';
    const sellLabel = 'Sell on DigiStore';
    target.innerHTML = `
      <div class="utility-bar">
        <div class="shell utility-content">
          <span>Digital products, delivered securely</span>
          <a href="mailto:hello@codeinktechnologies.com">hello@codeinktechnologies.com</a>
        </div>
      </div>
      <div class="main-nav-container">
        <div class="main-nav">
          <a href="./index.html" class="brand">
            <span class="brand-mark">D</span>
            <span>DigiStore<small>powered by codeinktechnologies</small></span>
          </a>
          <nav class="nav-links" aria-label="Main navigation">${links}
            <a href="${sellHref}" class="nav-sell">${icon('store')}<span>Sell</span></a>
          </nav>
          <div class="nav-actions">
            <a href="${sellHref}" class="button button-sell hide-below-md" title="${sellLabel}">
              ${icon('store', 15)}<span>Start selling</span>
            </a>
            ${
              user
                ? `<details class="account-popover">
                    <summary class="account-chip">
                      <span class="avatar">${escapeHtml(name[0].toUpperCase())}</span>
                      <span>${escapeHtml(name)}</span>
                      ${icon('chevron-down', 15)}
                    </summary>
                    <div class="account-popover-panel">
                      <strong>${escapeHtml(name)}</strong>
                      <a href="./account.html">${icon('layout-dashboard', 16)} Overview</a>
                      <a href="./account.html#orders-list">${icon('package', 16)} Orders</a>
                      <a href="./checkout.html">${icon('shopping-cart', 16)} Cart / checkout</a>
                      ${profile?.role === 'admin' ? `<a href="./admin.html">${icon('shield-check', 16)} Admin centre</a>` : ''}
                      <button id="sign-out">${icon('log-out', 16)} Log out</button>
                    </div>
                  </details>`
                : `<a class="text-action" href="./auth.html">Log in</a><a class="button button-primary" href="./auth.html?mode=signup">Get started</a>`
            }
            <button id="mobile-menu-button" class="mobile-menu-button" aria-label="Open menu">${icon('menu', 22)}</button>
          </div>
        </div>
      </div>
    `;

    // The drawer lives on <body>, never inside #site-header. The header carries
    // `backdrop-blur`, and backdrop-filter creates a containing block for
    // position:fixed descendants — nested here the drawer would be positioned
    // and clipped against the header box instead of the viewport, and its
    // z-index would be trapped inside the header's stacking context.
    document.querySelector('#mobile-drawer')?.remove();
    document.querySelector('#mobile-scrim')?.remove();

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
        ${links}
        <a href="${sellHref}" class="drawer-sell">${icon('store')} ${sellLabel}</a>
        ${
          user
            ? `<a href="./account.html">${icon('user-round')} ${escapeHtml(name)}</a>
               ${profile?.role === 'admin' ? `<a href="./admin.html">${icon('shield-check')} Admin centre</a>` : ''}
               <button id="mobile-sign-out">${icon('log-out')} Log out</button>`
            : `<a href="./auth.html">${icon('log-in')} Log in</a>
               <a href="./auth.html?mode=signup">${icon('user-plus')} Create account</a>`
        }
      </nav>`;

    document.body.append(scrim, drawer);

    const setDrawer = (open) => {
      drawer.classList.toggle('open', open);
      scrim.classList.toggle('open', open);
      // Body scroll lock, so the page behind does not scroll under the drawer.
      document.body.style.overflow = open ? 'hidden' : '';
      if (open) drawer.querySelector('a, button')?.focus();
    };

    target.querySelector('#mobile-menu-button').onclick = () => setDrawer(true);
    drawer.querySelector('#mobile-menu-close').onclick = () => setDrawer(false);
    scrim.onclick = () => setDrawer(false);
    // Any destination closes it — in-page links would otherwise leave it open.
    drawer.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setDrawer(false)));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setDrawer(false);
    });

    renderIcons();
    finishPageLoader();

    const logout = async () => {
      await supabase.auth.signOut();
      location.href = './index.html';
    };
    target.querySelector('#sign-out')?.addEventListener('click', logout);
    drawer.querySelector('#mobile-sign-out')?.addEventListener('click', logout);
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
  target.className = 'bg-[#0e1e38] text-slate-300 pt-16 pb-12 border-t border-slate-800 mt-auto';
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
        <a class="seller-strip__cta" href="./vendor.html">
          ${icon('store', 16)}<span>Open your store</span>
        </a>
      </div>

      <div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-6 text-sm">
        <div class="lg:col-span-2 space-y-4 pr-4">
          <div class="flex items-center gap-3">
            <span class="brand-mark !bg-orange-500 !text-white font-black text-lg w-10 h-10 rounded-xl flex items-center justify-center">D</span>
            <div>
              <span class="text-xl font-black text-white tracking-tight">DigiStore</span>
              <span class="block text-[11px] text-slate-400 font-medium uppercase tracking-wider">by Codeink Technologies</span>
            </div>
          </div>
          <p class="text-xs leading-relaxed text-slate-400 max-w-sm">
            Empowering professionals, creators, and developers worldwide with verified, high-value digital products, comprehensive ebooks, tools, and software templates.
          </p>
          <div class="pt-2 flex flex-wrap gap-2 items-center text-[11px] text-slate-400">
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 text-slate-300 font-medium">
              ${icon('shield-check', 13)}
              <span>Verified Merchant Platform</span>
            </span>
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 text-slate-300 font-medium">
              ${icon('lock', 13)}
              <span>256-Bit SSL Encrypted</span>
            </span>
          </div>
        </div>

        <div class="space-y-3">
          <h3 class="font-bold text-white text-xs uppercase tracking-wider">Digital Catalog</h3>
          <ul class="space-y-2 text-xs text-slate-400">
            <li><a href="./store.html?category=Ebooks%20%26%20Guides" class="hover:text-orange-400 transition">Ebooks &amp; Guides</a></li>
            <li><a href="./store.html?category=Software%20%26%20Tools" class="hover:text-orange-400 transition">Software &amp; Tools</a></li>
            <li><a href="./store.html?category=Templates%20%26%20Themes" class="hover:text-orange-400 transition">Templates &amp; Themes</a></li>
            <li><a href="./store.html?category=Online%20Courses" class="hover:text-orange-400 transition">Online Courses</a></li>
            <li><a href="./store.html?category=Audio%20%26%20Media" class="hover:text-orange-400 transition">Audio &amp; Media</a></li>
            <li><a href="./store.html?category=Design%20%26%20Graphics" class="hover:text-orange-400 transition">Design &amp; Graphics</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="font-bold text-white text-xs uppercase tracking-wider">Customer Hub</h3>
          <ul class="space-y-2 text-xs text-slate-400">
            <li><a href="./account.html" class="hover:text-orange-400 transition">My Account &amp; Vault</a></li>
            <li><a href="./account.html#orders-list" class="hover:text-orange-400 transition">Order History</a></li>
            <li><a href="./support.html" class="hover:text-orange-400 transition">Customer Helpdesk</a></li>
            <li><a href="./support.html" class="hover:text-orange-400 transition">Submit Support Ticket</a></li>
            <li><a href="./blog.html" class="hover:text-orange-400 transition">Articles &amp; Updates</a></li>
            <li><a href="./about.html" class="hover:text-orange-400 transition">About Codeink</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="font-bold text-white text-xs uppercase tracking-wider">Sell With Us</h3>
          <ul class="space-y-2 text-xs text-slate-400">
            <li><a href="./vendor.html" class="font-bold text-orange-400 hover:text-orange-300 transition">Start selling →</a></li>
            <li><a href="./vendor.html" class="hover:text-orange-400 transition">Seller centre</a></li>
            <li><a href="./categories.html" class="hover:text-orange-400 transition">What sells here</a></li>
            <li><a href="./support.html" class="hover:text-orange-400 transition">Seller support</a></li>
          </ul>
        </div>

        <div class="space-y-3">
          <h3 class="font-bold text-white text-xs uppercase tracking-wider">Trust &amp; Legal</h3>
          <ul class="space-y-2 text-xs text-slate-400">
            <li><a href="./support.html#faq" class="hover:text-orange-400 transition">Terms of Service</a></li>
            <li><a href="./support.html#faq" class="hover:text-orange-400 transition">Privacy Policy</a></li>
            <li><a href="./support.html#faq" class="hover:text-orange-400 transition">Refund &amp; Return Policy</a></li>
            <li><a href="./support.html#faq" class="hover:text-orange-400 transition">Digital License Agreement</a></li>
            <li><a href="./support.html#faq" class="hover:text-orange-400 transition">Security &amp; Compliance</a></li>
            <li><a href="./contact.html" class="hover:text-orange-400 transition">Contact Legal Team</a></li>
          </ul>
        </div>
      </div>

      <div class="border-t border-slate-800/80 pt-8 flex flex-wrap items-center justify-between gap-6 text-xs text-slate-500">
        <div>
          <p>© ${year} <strong class="text-slate-400">Codeink Technologies</strong>. All rights reserved.</p>
          <p class="text-[11px] text-slate-500 mt-0.5">DigiStore is a registered digital merchandise platform by Codeink Technologies.</p>
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
}

export function initMotion(){document.body.classList.add('page-enter');const items=document.querySelectorAll('.reveal');if(!('IntersectionObserver'in window)){items.forEach(i=>i.classList.add('is-visible'));return}const o=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');o.unobserve(e.target)}}),{threshold:.12});items.forEach(i=>o.observe(i))}
