/**
 * Search-engine indexing.
 *
 * Drains `search_index_queue` and tells search engines about the URLs that
 * changed. Two independent sinks, either of which may be unconfigured:
 *
 *   IndexNow  — Bing, Yandex, Seznam, Naver. One key, no OAuth. The key must
 *               also be served at https://<host>/<key>.txt containing the key,
 *               which the `sitemap` deployment covers.
 *   Google    — Indexing API, requires a service account (client email +
 *               private key) and a signed JWT exchanged for an access token.
 *
 * A queue row is only marked processed when at least one sink accepted it, so
 * a misconfigured key leaves work to retry rather than silently dropping it.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

/** Maps a queue row to the public URL a crawler should fetch. */
function publicUrlFor(entityType: string, slug: string | null, id: string): string {
  const key = slug || id;
  switch (entityType) {
    case 'product':
      return `${SITE_URL}/checkout.html?product=${encodeURIComponent(key)}`;
    case 'blog_post':
      return `${SITE_URL}/blog.html?post=${encodeURIComponent(key)}`;
    default:
      return `${SITE_URL}/`;
  }
}

/** base64url without padding — what JWT requires. */
function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Turns a PEM private key into a CryptoKey for RS256 signing. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Exchanges a service-account JWT for a Google access token. */
async function googleAccessToken(clientEmail: string, privateKey: string): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/indexing',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
    const key = await importPrivateKey(privateKey);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );
    const jwt = `${unsigned}.${b64url(new Uint8Array(signature))}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: either the cron secret, or a signed-in admin.
  //
  // The cron secret travels in `x-cron-secret`, NOT in Authorization: the API
  // gateway parses Authorization as a JWT and rejects a raw secret with
  // UNAUTHORIZED_INVALID_JWT_FORMAT before this code runs.
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

    const adminDb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: profile } = await adminDb.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const indexNowKey = Deno.env.get('INDEXNOW_KEY');
  const googleEmail = Deno.env.get('GOOGLE_INDEXING_CLIENT_EMAIL');
  const googleKey = Deno.env.get('GOOGLE_INDEXING_PRIVATE_KEY');

  if (!indexNowKey && !(googleEmail && googleKey)) {
    return json({
      processed: 0,
      message: 'Search indexing is not configured. Set INDEXNOW_KEY and/or GOOGLE_INDEXING_CLIENT_EMAIL + GOOGLE_INDEXING_PRIVATE_KEY.',
    });
  }

  const { data: jobs, error } = await db
    .from('search_index_queue')
    .select('*')
    .is('processed_at', null)
    .limit(100);

  if (error) return json({ error: error.message }, { status: 500 });
  if (!jobs?.length) return json({ processed: 0, message: 'Nothing queued.' });

  // Resolve slugs in two batched reads rather than one per job.
  const productIds = jobs.filter((j) => j.entity_type === 'product').map((j) => j.entity_id);
  const postIds = jobs.filter((j) => j.entity_type === 'blog_post').map((j) => j.entity_id);

  const slugById = new Map<string, string>();
  if (productIds.length) {
    const { data } = await db.from('products').select('id,slug').in('id', productIds);
    for (const row of data || []) slugById.set(row.id, row.slug);
  }
  if (postIds.length) {
    const { data } = await db.from('blog_posts').select('id,slug').in('id', postIds);
    for (const row of data || []) slugById.set(row.id, row.slug);
  }

  // A deleted entity has no page left to crawl; its URL is still submitted so
  // engines can re-check and drop it.
  const urls = jobs.map((job) => publicUrlFor(job.entity_type, slugById.get(job.entity_id) ?? null, job.entity_id));
  const uniqueUrls = [...new Set(urls)];

  const results: Record<string, unknown> = {};
  let anyAccepted = false;

  // --- IndexNow -------------------------------------------------------------
  if (indexNowKey) {
    try {
      const host = new URL(SITE_URL).host;
      const response = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host,
          key: indexNowKey,
          keyLocation: `${SITE_URL}/${indexNowKey}.txt`,
          urlList: uniqueUrls,
        }),
      });
      // IndexNow returns 200 or 202 on acceptance.
      results.indexnow = { status: response.status, ok: response.ok };
      if (response.ok) anyAccepted = true;
    } catch (e) {
      results.indexnow = { error: String((e as Error)?.message || e) };
    }
  }

  // --- Google Indexing API --------------------------------------------------
  if (googleEmail && googleKey) {
    const accessToken = await googleAccessToken(googleEmail, googleKey);
    if (!accessToken) {
      results.google = { error: 'Could not obtain an access token — check the service-account credentials.' };
    } else {
      let ok = 0;
      let failed = 0;
      for (const job of jobs) {
        const url = publicUrlFor(job.entity_type, slugById.get(job.entity_id) ?? null, job.entity_id);
        try {
          const response = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url,
              type: job.operation === 'delete' ? 'URL_DELETED' : 'URL_UPDATED',
            }),
          });
          if (response.ok) ok++;
          else failed++;
        } catch {
          failed++;
        }
      }
      results.google = { ok, failed };
      if (ok > 0) anyAccepted = true;
    }
  }

  // Only clear the queue when something actually accepted the work.
  if (anyAccepted) {
    await db
      .from('search_index_queue')
      .update({ processed_at: new Date().toISOString() })
      .in('id', jobs.map((j) => j.id));
  }

  return json({
    processed: anyAccepted ? jobs.length : 0,
    queued: jobs.length,
    urls: uniqueUrls.length,
    results,
  });
});
