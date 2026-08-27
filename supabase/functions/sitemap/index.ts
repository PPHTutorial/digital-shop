import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const escape = (value: string) =>
  String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]!));

Deno.serve(async () => {
  const base = (Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const [{ data: products }, { data: posts }] = await Promise.all([
    db.from('products').select('id,slug,updated_at').eq('is_published', true),
    db.from('blog_posts').select('slug,updated_at').eq('status', 'published'),
  ]);

  const staticUrls = [
    `<url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/about</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`,
    `<url><loc>${base}/contact</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`,
    `<url><loc>${base}/support</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`,
    `<url><loc>${base}/blog</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${base}/store</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${base}/categories</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
    `<url><loc>${base}/legal?doc=terms</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>`,
    `<url><loc>${base}/legal?doc=privacy</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>`,
    `<url><loc>${base}/legal?doc=refunds</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>`,
    `<url><loc>${base}/legal?doc=licence</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>`,
  ];

  const productUrls = (products || []).map((item) => {
    const slug = item.slug || item.id;
    const lastmod = item.updated_at ? new Date(item.updated_at).toISOString() : new Date().toISOString();
    return `<url><loc>${base}/product?product=${encodeURIComponent(slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`;
  });

  const postUrls = (posts || []).map((post) => {
    const lastmod = post.updated_at ? new Date(post.updated_at).toISOString() : new Date().toISOString();
    return `<url><loc>${base}/blog?post=${encodeURIComponent(post.slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
  });

  const urls = [...staticUrls, ...productUrls, ...postUrls].join('');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
