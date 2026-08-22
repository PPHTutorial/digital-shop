import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]!));
Deno.serve(async () => {
  const base = Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const [{ data: products }, { data: posts }] = await Promise.all([
    db.from('products').select('id,updated_at').eq('is_published', true),
    db.from('blog_posts').select('slug,updated_at').eq('status', 'published'),
  ]);
  const urls = [`<url><loc>${base}/</loc></url>`, `<url><loc>${base}/blog.html</loc></url>`, ...(products || []).map((item) => `<url><loc>${base}/checkout.html?product=${item.id}</loc><lastmod>${new Date(item.updated_at).toISOString()}</lastmod></url>`), ...(posts || []).map((post) => `<url><loc>${base}/blog.html?post=${encodeURIComponent(post.slug)}</loc><lastmod>${new Date(post.updated_at).toISOString()}</lastmod></url>`)].join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
});
