import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const cronAuthorized = token === Deno.env.get('CRON_SECRET');
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
  const { data: jobs } = await db.from('search_index_queue').select('*').is('processed_at', null).limit(100);
  const endpoint = Deno.env.get('SEARCH_INDEX_ENDPOINT'); const apiKey = Deno.env.get('SEARCH_INDEX_API_KEY');
  if (!endpoint || !apiKey) return json({ processed: 0, message: 'Search indexing is not configured.' });
  for (const job of jobs || []) { const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(job) }); if (response.ok) await db.from('search_index_queue').update({ processed_at: new Date().toISOString() }).eq('id', job.id); }
  return json({ processed: jobs?.length || 0 });
});
