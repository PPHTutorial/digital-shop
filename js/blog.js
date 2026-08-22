import { supabase } from './client.js';
import { escapeHtml, finishPageLoader, mountFooter, mountHeader } from './ui.js';

async function init() {
  mountHeader();
  mountFooter();

  const grid = document.querySelector('#blog-grid');
  const { data, error } = await supabase
    .from('blog_posts')
    .select('title,slug,excerpt,cover_url,published_at')
    .eq('status', 'published')
    .order('published_at', { ascending: false });

  grid.innerHTML = error
    ? '<p class="text-red-700">The journal is unavailable right now.</p>'
    : data?.length
    ? data
        .map(
          (post) => `
      <article class="catalog-card overflow-hidden bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md transition">
        ${post.cover_url ? `<img src="${post.cover_url}" alt="" class="h-44 w-full object-cover">` : ''}
        <div class="p-6">
          <span class="tag">Journal</span>
          <h2 class="mt-3 text-xl font-black text-[#142c55]">${escapeHtml(post.title)}</h2>
          <p class="mt-3 text-sm leading-relaxed text-slate-600">${escapeHtml(post.excerpt || '')}</p>
          <span class="mt-4 block text-xs font-semibold text-slate-400">${new Date(post.published_at).toLocaleDateString()}</span>
        </div>
      </article>`
        )
        .join('')
    : '<p class="text-slate-500 col-span-full py-8 text-center bg-white rounded-2xl border border-slate-200">New journal articles and release notes are coming soon.</p>';

  finishPageLoader();
}

init();
