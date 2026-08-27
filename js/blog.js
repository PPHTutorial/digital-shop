import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, getAccount, icon, mountFooter, mountHeader, renderIcons, setButtonLoading, toast } from './ui.js';
import { wishlistButton, loadWishlist, paintWishlist, wireWishlist } from './wishlist.js';

const PAGE_SIZE = 6;
let allPosts = [];
let currentPage = 1;

let currentPostId = null;
let currentUser = null;
let engagement = { like_count: 0, viewer_liked: false, viewer_saved: false, comment_count: 0, comments: [] };

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return formatDate(iso);
}

function readTimeFor(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

function blogCardHtml(post) {
  const href = `./blog?post=${encodeURIComponent(post.slug)}`;
  return `
    <article class="blog-card is-clickable">
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
      <a class="blog-card__link" href="${href}"><span class="sr-only">${escapeHtml(post.title)}</span></a>
    </article>`;
}

function renderFeatured(post) {
  const host = document.querySelector('#blog-featured-wrap');
  if (!host) return;
  if (!post) { host.innerHTML = ''; return; }

  const href = `./blog?post=${encodeURIComponent(post.slug)}`;
  host.innerHTML = `
    <article class="blog-featured is-clickable">
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
      <a class="blog-card__link" href="${href}"><span class="sr-only">${escapeHtml(post.title)}</span></a>
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

function wireSubscribeForm() {
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
}

/* ==========================================================================
   Related products — a blog post has no category of its own, so this is a
   generic "keep shopping" cross-sell rather than a topical match.
   ========================================================================== */
function relatedProductCardHtml(p) {
  const hasDiscount = p.original_price && Number(p.original_price) > Number(p.price);
  const href = `./product?product=${encodeURIComponent(p.slug || p.id)}`;
  return `
    <article class="catalog-card is-clickable" data-product-id="${p.id}">
      <span class="catalog-card__media">
        ${p.cover_url
          ? `<img src="${escapeHtml(p.cover_url)}" alt="${escapeHtml(p.title)}" loading="lazy">`
          : `<span class="catalog-card__placeholder"><i data-lucide="file-text" width="26" height="26"></i></span>`}
        ${p.is_featured ? `<span class="catalog-card__badges"><span class="catalog-card__badge catalog-card__badge--featured">Featured</span></span>` : ''}
      </span>
      ${wishlistButton(p.id, p.title)}
      <span class="catalog-card__body">
        <h3 class="catalog-card__title">${escapeHtml(p.title)}</h3>
        ${p.short_description ? `<span class="catalog-card__blurb">${escapeHtml(p.short_description)}</span>` : ''}
      </span>
      <span class="catalog-card__foot">
        <span class="catalog-card__price">
          ${hasDiscount ? `<span class="price-original">${p.currency} ${Number(p.original_price).toFixed(2)}</span>` : ''}
          <strong>${p.currency} ${Number(p.price).toFixed(2)}</strong>
        </span>
        <span class="catalog-card__go">${icon('arrow-right', 15)}</span>
      </span>
      <a class="catalog-card__link" href="${href}"><span class="sr-only">${escapeHtml(p.title)}</span></a>
    </article>`;
}

async function renderRelatedProducts() {
  const host = document.querySelector('#blog-related-grid');
  const section = document.querySelector('#blog-related');
  if (!host || !section) return;

  const { data } = await supabase
    .from('products')
    .select('id,title,slug,short_description,price,original_price,currency,cover_url,is_featured')
    .eq('is_published', true)
    .order('is_featured', { ascending: false })
    .order('purchase_count', { ascending: false })
    .limit(4);

  if (!data?.length) return;
  section.classList.remove('hidden');
  host.innerHTML = data.map(relatedProductCardHtml).join('');
  await loadWishlist();
  paintWishlist(host);
  wireWishlist(host);
  renderIcons();
}

/* ==========================================================================
   Comments — one level of replies, rendered as a flat list grouped under
   their parent (matches the common "reply nests once" pattern).
   ========================================================================== */
function commentRowHtml(comment, { isReply = false } = {}) {
  const canManage = comment.is_own;
  return `
    <div class="blog-comment${isReply ? ' is-reply' : ''}" data-comment-id="${comment.id}">
      <div class="blog-comment__head">
        <strong>${escapeHtml(comment.author_name)}</strong>
        <span>${timeAgo(comment.created_at)}</span>
      </div>
      <p class="blog-comment__body">${escapeHtml(comment.body)}</p>
      <div class="blog-comment__actions">
        ${!isReply ? `<button type="button" class="blog-comment__reply-btn" data-reply-to="${comment.id}">Reply</button>` : ''}
        ${canManage ? `<button type="button" class="blog-comment__delete-btn" data-delete-comment="${comment.id}">Delete</button>` : ''}
      </div>
      ${!isReply ? `<div class="blog-comment__reply-form-slot" data-reply-slot="${comment.id}"></div>` : ''}
    </div>`;
}

function renderComments() {
  const host = document.querySelector('#blog-comments-list');
  if (!host) return;

  document.querySelector('#blog-comments-title').textContent = `Comments (${engagement.comment_count})`;
  document.querySelector('#blog-comment-count-chip').textContent = engagement.comment_count;

  const byParent = new Map();
  const roots = [];
  for (const c of engagement.comments) {
    if (c.parent_id) {
      if (!byParent.has(c.parent_id)) byParent.set(c.parent_id, []);
      byParent.get(c.parent_id).push(c);
    } else {
      roots.push(c);
    }
  }

  if (!roots.length) {
    host.innerHTML = '<p class="text-sm py-6 text-center" style="color:var(--text-muted)">No comments yet. Be the first to share your thoughts.</p>';
    return;
  }

  host.innerHTML = roots.map((root) => {
    const replies = (byParent.get(root.id) || [])
      .map((reply) => commentRowHtml(reply, { isReply: true })).join('');
    return commentRowHtml(root) + replies;
  }).join('');

  renderIcons();
}

function replyFormHtml(parentId) {
  return `
    <form class="blog-comment-form blog-comment-form--reply" data-reply-form="${parentId}">
      <textarea rows="2" placeholder="Write a reply…" maxlength="2000" required></textarea>
      <div class="flex items-center gap-2">
        <button type="submit" class="button button-primary !min-h-8 !px-3 text-xs font-bold">Reply</button>
        <button type="button" class="button !min-h-8 !px-3 text-xs" data-cancel-reply="${parentId}">Cancel</button>
      </div>
    </form>`;
}

async function loadEngagement(postId) {
  const { data, error } = await supabase.rpc('blog_post_engagement', { p_post_id: postId });
  if (error || !data) return;
  engagement = {
    like_count: data.like_count || 0,
    viewer_liked: Boolean(data.viewer_liked),
    viewer_saved: Boolean(data.viewer_saved),
    comment_count: data.comment_count || 0,
    comments: data.comments || [],
  };
  paintEngagement();
  renderComments();
}

function paintEngagement() {
  const likeBtn = document.querySelector('#blog-like-btn');
  likeBtn.classList.toggle('is-active', engagement.viewer_liked);
  likeBtn.setAttribute('aria-pressed', String(engagement.viewer_liked));
  document.querySelector('#blog-like-count').textContent = engagement.like_count;

  const saveBtn = document.querySelector('#blog-save-btn');
  saveBtn.classList.toggle('is-active', engagement.viewer_saved);
  saveBtn.setAttribute('aria-pressed', String(engagement.viewer_saved));
  saveBtn.querySelector('span:last-child').textContent = engagement.viewer_saved ? 'Saved' : 'Save';
}

function signInRedirectUrl() {
  const next = `blog${window.location.search}`;
  return `./auth?mode=signin&next=${encodeURIComponent(next)}`;
}

function wireEngagementActions() {
  document.querySelector('#blog-like-btn')?.addEventListener('click', async () => {
    if (!currentUser) { window.location.href = signInRedirectUrl(); return; }
    const wasLiked = engagement.viewer_liked;
    engagement.viewer_liked = !wasLiked;
    engagement.like_count += wasLiked ? -1 : 1;
    paintEngagement();
    try {
      if (wasLiked) {
        const { error } = await supabase.from('blog_post_likes').delete().eq('post_id', currentPostId).eq('user_id', currentUser.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('blog_post_likes').insert({ post_id: currentPostId, user_id: currentUser.id });
        if (error) throw error;
      }
    } catch (err) {
      engagement.viewer_liked = wasLiked;
      engagement.like_count += wasLiked ? 1 : -1;
      paintEngagement();
      toast(err.message || 'That did not save. Please try again.', 'error');
    }
  });

  document.querySelector('#blog-save-btn')?.addEventListener('click', async () => {
    if (!currentUser) { window.location.href = signInRedirectUrl(); return; }
    const wasSaved = engagement.viewer_saved;
    engagement.viewer_saved = !wasSaved;
    paintEngagement();
    try {
      if (wasSaved) {
        const { error } = await supabase.from('blog_post_saves').delete().eq('post_id', currentPostId).eq('user_id', currentUser.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('blog_post_saves').insert({ post_id: currentPostId, user_id: currentUser.id });
        if (error) throw error;
        toast('Saved to your reading list.');
      }
    } catch (err) {
      engagement.viewer_saved = wasSaved;
      paintEngagement();
      toast(err.message || 'That did not save. Please try again.', 'error');
    }
  });

  document.querySelector('#blog-share-btn')?.addEventListener('click', async () => {
    const url = window.location.href;
    const title = document.querySelector('#blog-article-title')?.textContent || 'DigiStore Journal';
    if (navigator.share) {
      try { await navigator.share({ title, url }); } catch { /* user cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard.');
    } catch {
      toast('Could not copy the link.', 'error');
    }
  });
}

function wireComments() {
  const formWrap = document.querySelector('#blog-comment-form-wrap');
  const signInLink = document.querySelector('#blog-comment-signin');

  document.querySelector('#blog-comment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = event.currentTarget.querySelector('textarea');
    const body = textarea.value.trim();
    if (!body) return;
    const button = event.currentTarget.querySelector('button');
    setButtonLoading(button, true, 'Posting…');
    const { error } = await supabase.from('blog_comments').insert({ post_id: currentPostId, user_id: currentUser.id, body });
    setButtonLoading(button, false);
    if (error) { toast(error.message, 'error'); return; }
    textarea.value = '';
    await loadEngagement(currentPostId);
  });

  document.querySelector('#blog-comments-list')?.addEventListener('click', async (event) => {
    const replyBtn = event.target.closest('[data-reply-to]');
    const cancelBtn = event.target.closest('[data-cancel-reply]');
    const deleteBtn = event.target.closest('[data-delete-comment]');

    if (replyBtn) {
      if (!currentUser) { window.location.href = signInRedirectUrl(); return; }
      const slot = document.querySelector(`[data-reply-slot="${replyBtn.dataset.replyTo}"]`);
      if (slot) slot.innerHTML = slot.innerHTML ? '' : replyFormHtml(replyBtn.dataset.replyTo);
      return;
    }

    if (cancelBtn) {
      const slot = document.querySelector(`[data-reply-slot="${cancelBtn.dataset.cancelReply}"]`);
      if (slot) slot.innerHTML = '';
      return;
    }

    if (deleteBtn) {
      const ok = window.confirm('Delete this comment?');
      if (!ok) return;
      const { error } = await supabase.from('blog_comments').delete().eq('id', deleteBtn.dataset.deleteComment);
      if (error) { toast(error.message, 'error'); return; }
      await loadEngagement(currentPostId);
    }
  });

  document.querySelector('#blog-comments-list')?.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-reply-form]');
    if (!form) return;
    event.preventDefault();
    const parentId = form.dataset.replyForm;
    const textarea = form.querySelector('textarea');
    const body = textarea.value.trim();
    if (!body) return;
    const button = form.querySelector('button[type="submit"]');
    setButtonLoading(button, true, 'Posting…');
    const { error } = await supabase.from('blog_comments').insert({ post_id: currentPostId, user_id: currentUser.id, parent_id: parentId, body });
    setButtonLoading(button, false);
    if (error) { toast(error.message, 'error'); return; }
    await loadEngagement(currentPostId);
  });

  if (currentUser) {
    formWrap?.classList.remove('hidden');
    signInLink?.classList.add('hidden');
  } else {
    formWrap?.classList.add('hidden');
    if (signInLink) { signInLink.href = signInRedirectUrl(); signInLink.classList.remove('hidden'); }
  }
}

/* ==========================================================================
   Single article view — ?post=<slug>. Sitemap/search-index both link here,
   so this has to resolve to real content rather than the generic listing.
   ========================================================================== */
async function loadArticle(slug) {
  document.querySelector('#blog-hero')?.classList.add('hidden');
  document.querySelector('#blog-listing')?.classList.add('hidden');
  document.querySelector('#blog-article-wrap')?.classList.remove('hidden');

  const { data, error } = await supabase
    .from('blog_posts')
    .select('id,title,excerpt,content,cover_url,published_at')
    .eq('status', 'published')
    .eq('slug', slug)
    .maybeSingle();

  document.querySelector('#blog-article-loading')?.classList.add('hidden');

  if (error || !data) {
    document.querySelector('#blog-article-not-found')?.classList.remove('hidden');
    finishPageLoader();
    return;
  }

  currentPostId = data.id;

  document.title = `${data.title} | DigiStore Journal`;
  const descMeta = document.querySelector('meta[name="description"]');
  if (descMeta && data.excerpt) descMeta.setAttribute('content', data.excerpt);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${data.title} | DigiStore`);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', data.excerpt || '');
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', `${data.title} | DigiStore`);
  document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', data.excerpt || '');

  document.querySelector('#blog-article-date').textContent = formatDate(data.published_at);
  document.querySelector('#blog-article-readtime').textContent = readTimeFor(data.content);
  document.querySelector('#blog-article-title').textContent = data.title;
  document.querySelector('#blog-article-html').innerHTML = data.content || '';

  const coverWrap = document.querySelector('#blog-article-cover-wrap');
  const cover = document.querySelector('#blog-article-cover');
  if (data.cover_url) {
    cover.src = data.cover_url;
    cover.alt = data.title;
    coverWrap.classList.remove('hidden');
  }

  document.querySelector('#blog-article-content')?.classList.remove('hidden');
  renderIcons();

  const { user } = await getAccount();
  currentUser = user;
  wireEngagementActions();
  wireComments();
  await loadEngagement(currentPostId);
  await renderRelatedProducts();

  finishPageLoader();
}

async function loadListing() {
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
  finishPageLoader();
}

async function init() {
  mountHeader();
  mountFooter();
  wireSubscribeForm();

  const params = new URLSearchParams(window.location.search);
  const slug = params.get('post');

  if (slug) {
    await loadArticle(slug);
  } else {
    await loadListing();
  }
}

init().catch(() => finishPageLoader());
