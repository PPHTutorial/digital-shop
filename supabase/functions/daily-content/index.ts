import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
Deno.serve(async (request) => {
  if (request.headers.get('Authorization') !== `Bearer ${Deno.env.get('CRON_SECRET')}`) return new Response('Unauthorized', { status: 401 });
  const newsKey = Deno.env.get('NEWS_API_KEY'); const openAiKey = Deno.env.get('OPENAI_API_KEY');
  if (!newsKey || !openAiKey) return Response.json({ error: 'NEWS_API_KEY and OPENAI_API_KEY are required.' }, { status: 400 });
  const news = await fetch(`https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${newsKey}`).then((response) => response.json());
  const article = news.articles?.find((item: { title?: string }) => item.title);
  if (!article) return Response.json({ error: 'No news article available.' }, { status: 502 });
  const prompt = `Write a factual, original 500-word DigiStore journal post inspired by this news headline: ${article.title}. Do not claim facts not in the headline/source. Return only JSON with title, excerpt, content.`;
  const ai = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5', input: prompt }) }).then((response) => response.json());
  const post = JSON.parse(ai.output_text || '{}');
  if (!post.title || !post.content) return Response.json({ error: 'AI generation failed.' }, { status: 502 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { error } = await db.from('blog_posts').insert({ slug: `${slugify(post.title)}-${Date.now()}`, title: post.title, excerpt: post.excerpt, content: post.content, source_url: article.url, status: 'draft' });
  return Response.json({ created: !error, error: error?.message });
});
