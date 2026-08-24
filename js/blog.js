/**
 * Journal index. Reads published `post` documents from the CMS
 * (`cms_documents`, type `post`) — there is no separate blog API.
 */

import { supabase } from './client.js';
import { $, esc } from './dom.js';
import { formatDate } from './format.js';
import { initTheme, mountHeader, mountFooter, bootDone } from './ui.js';

initTheme();
mountHeader();
mountFooter();

async function loadPosts() {
  const { data, error } = await supabase
    .from('cms_documents')
    .select('title,slug,published,published_at')
    .eq('type', 'post')
    .not('published', 'is', null)
    .order('published_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

function paint(posts) {
  const grid = $('#blog-grid');
  if (!posts.length) {
    grid.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1">
        <p class="empty__title">No articles yet</p>
        <p class="empty__body">New journal articles and release notes are coming soon.</p>
      </div>`;
    return;
  }

  grid.innerHTML = posts
    .map((post) => {
      const doc = post.published || {};
      const meta = [post.published_at ? formatDate(post.published_at) : '', doc.reading_minutes ? `${doc.reading_minutes} min read` : '']
        .filter(Boolean)
        .join(' · ');
      return `
        <article class="article">
          ${doc.cover ? `<img class="article__media" src="${esc(doc.cover)}" alt="" loading="lazy" decoding="async">` : ''}
          <div class="article__body">
            <span class="tag">Journal</span>
            <h2 class="article__title">${esc(post.title)}</h2>
            <p class="article__excerpt">${esc(doc.excerpt || '')}</p>
          </div>
          ${meta ? `<div class="article__foot">${esc(meta)}</div>` : ''}
        </article>`;
    })
    .join('');
}

async function run() {
  try {
    paint(await loadPosts());
  } catch {
    paint([]);
  }
  bootDone();
}

run();
