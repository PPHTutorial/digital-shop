/**
 * Daily journal draft.
 *
 * Pulls a headline, asks the model for an original post about it, and files the
 * result as a DRAFT for a human to review before publishing.
 *
 * Every upstream failure is reported with the provider's own message. The
 * previous version collapsed billing errors, quota errors, malformed JSON and
 * an empty response into one flat "AI generation failed.", which made a plain
 * out-of-credit account indistinguishable from a code fault.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/**
 * Pulls the assistant's text out of a Responses API payload.
 *
 * `output_text` is a convenience the SDKs synthesise and is not dependable in
 * the raw REST body, so fall back to walking `output[]` for the message item.
 * Reasoning models emit a `reasoning` item before the `message`, hence the
 * filter on type rather than taking output[0].
 */
function extractText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];

  for (const item of output as Array<Record<string, unknown>>) {
    if (item?.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }

  return chunks.join('').trim();
}

/** Tolerates a model that wraps its JSON in a markdown fence. */
function parseJsonLoosely(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: cron secret, or a signed-in admin.
  //
  // The cron secret travels in `x-cron-secret`, NOT in Authorization. The API
  // gateway parses any Authorization header as a JWT and rejects a raw secret
  // with UNAUTHORIZED_INVALID_JWT_FORMAT before this code ever runs, which made
  // the previous Authorization-based cron check unreachable.
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const cronSecret = Deno.env.get('CRON_SECRET');
  const presentedSecret = request.headers.get('x-cron-secret') ?? '';
  const cronAuthorized = Boolean(cronSecret) && presentedSecret === cronSecret;

  if (!cronAuthorized) {
    if (!token) return json({ error: 'Unauthorized' }, { status: 401 });
    const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: profile } = await db.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
  }

  const newsKey = Deno.env.get('NEWS_API_KEY');
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  const model = Deno.env.get('OPENAI_MODEL') || 'gpt-5';

  const missing = [!newsKey && 'NEWS_API_KEY', !openAiKey && 'OPENAI_API_KEY'].filter(Boolean);
  if (missing.length) {
    return json({ error: `Missing function secret(s): ${missing.join(', ')}.` }, { status: 400 });
  }

  // --- Headline -------------------------------------------------------------
  let article: { title?: string; url?: string; description?: string } | undefined;
  try {
    const newsResponse = await fetch(
      `https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${newsKey}`,
    );
    const news = await newsResponse.json();

    if (!newsResponse.ok || news.status === 'error') {
      return json(
        { error: `News API: ${news.message || newsResponse.statusText}`, stage: 'news' },
        { status: 502 },
      );
    }
    article = news.articles?.find((item: { title?: string }) => item.title);
  } catch (e) {
    return json({ error: `News API request failed: ${String((e as Error)?.message || e)}`, stage: 'news' }, { status: 502 });
  }

  if (!article?.title) {
    return json({ error: 'No usable news article was returned.', stage: 'news' }, { status: 502 });
  }

  // --- Draft ----------------------------------------------------------------
  const prompt =
    `Write a factual, original 500-word DigiStore journal post inspired by this news headline: ` +
    `"${article.title}"${article.description ? ` (summary: ${article.description})` : ''}. ` +
    `Do not assert facts that are not supported by the headline or summary.`;

  let ai: Record<string, unknown>;
  try {
    const aiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: prompt,
        // Structured output: the schema is enforced, so the reply is valid JSON
        // rather than prose that happens to look like it.
        text: {
          format: {
            type: 'json_schema',
            name: 'journal_post',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'excerpt', 'content'],
              properties: {
                title: { type: 'string' },
                excerpt: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      }),
    });

    ai = await aiResponse.json();

    // Surface the provider's own error — quota, billing, bad model, rate limit.
    if (!aiResponse.ok || ai.error) {
      const err = (ai.error ?? {}) as Record<string, unknown>;
      return json(
        {
          error: `OpenAI: ${err.message || aiResponse.statusText}`,
          code: err.code ?? null,
          type: err.type ?? null,
          stage: 'openai',
        },
        { status: 502 },
      );
    }
  } catch (e) {
    return json({ error: `OpenAI request failed: ${String((e as Error)?.message || e)}`, stage: 'openai' }, { status: 502 });
  }

  // An incomplete response usually means the token budget ran out mid-answer.
  if (ai.status === 'incomplete') {
    const details = (ai.incomplete_details ?? {}) as Record<string, unknown>;
    return json({ error: `OpenAI returned an incomplete response (${details.reason || 'unknown reason'}).`, stage: 'openai' }, { status: 502 });
  }

  const text = extractText(ai);
  if (!text) {
    return json({ error: 'OpenAI returned no text content.', stage: 'parse' }, { status: 502 });
  }

  const post = parseJsonLoosely(text);
  if (!post) {
    return json({ error: 'The model did not return valid JSON.', stage: 'parse', sample: text.slice(0, 200) }, { status: 502 });
  }
  if (!post.title || !post.content) {
    return json({ error: 'The generated post was missing a title or body.', stage: 'parse', keys: Object.keys(post) }, { status: 502 });
  }

  // --- File as a draft ------------------------------------------------------
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db
    .from('blog_posts')
    .insert({
      slug: `${slugify(String(post.title))}-${Date.now()}`,
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      source_url: article.url,
      status: 'draft',
    })
    .select('id,slug,title')
    .single();

  if (error) return json({ error: `Could not save the draft: ${error.message}`, stage: 'save' }, { status: 500 });

  return json({ created: true, post: data });
});
