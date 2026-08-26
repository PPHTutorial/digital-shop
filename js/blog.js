import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';

const PAGE_SIZE = 6;
let allPosts = [];
let currentPage = 1;

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function blogCardHtml(post) {
  return `
    <article class="blog-card">
      <span class="blog-card__cover">
        ${post.cover_url ? `<img src="${escapeHtml(post.cover_url)}" alt="${escapeHtml(post.title)}" loading="lazy">` : ''}
      </span>
      <span class="blog-card__body">
        <h3>${escapeHtml(post.title)}</h3>
        ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ''}
        <span class="blog-card__foot">
          <span>${formatDate(post.published_at)}</span>
        </span>
      </span>
    </article>`;
}

function renderFeatured(post) {
  const host = document.querySelector('#blog-featured-wrap');
  if (!host) return;
  if (!post) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <article class="blog-featured">
      <span class="blog-featured__cover">
        ${post.cover_url ? `<img src="${escapeHtml(post.cover_url)}" alt="${escapeHtml(post.title)}" loading="lazy">` : ''}
      </span>
      <div class="blog-featured__meta">
        <span class="blog-badge">Latest Publication</span>
        <h3>${escapeHtml(post.title)}</h3>
        ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ''}
        <div class="blog-featured__foot">
          <span class="blog-featured__date">${formatDate(post.published_at)}</span>
        </div>
      </div>
    </article>`;
}

function renderGrid() {
  const host = document.querySelector('#blog-grid');
  if (!host) return;

  const rest = allPosts.slice(1);
  if (!rest.length) {
    host.innerHTML = allPosts.length
      ? ''
      : '<p class="col-span-full py-12 text-center text-sm" style="color:var(--text-muted)">New journal articles are coming soon.</p>';
    return;
  }

  const start = (currentPage - 1) * PAGE_SIZE;
  const subset = rest.slice(start, start + PAGE_SIZE);
  host.innerHTML = subset.map(blogCardHtml).join('');
  renderIcons();
}

async function init() {
  mountHeader();
  mountFooter();

  const { data, error } = await supabase
    .from('blog_posts')
    .select('title,slug,excerpt,cover_url,published_at')
    .eq('status', 'published')
    .order('published_at', { ascending: false });

  if (error) {
    document.querySelector('#blog-grid').innerHTML = '<p class="col-span-full py-8 text-center" style="color:var(--text-muted)">The journal is unavailable right now.</p>';
    finishPageLoader();
    return;
  }

  allPosts = data || [];
  renderFeatured(allPosts[0]);
  renderGrid();

  document.querySelector('#subscribe-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email');
    const button = e.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Subscribing…');
    const { error: subError } = await supabase.from('subscribers').insert({ email });
    setButtonLoading(button, false);
    const status = document.querySelector('#subscribe-status');
    if (subError && subError.code !== '23505') {
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
