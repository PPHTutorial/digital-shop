import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async (request) => {
  if (request.headers.get('Authorization') !== `Bearer ${Deno.env.get('CRON_SECRET')}`) return new Response('Unauthorized', { status: 401 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: jobs } = await db.from('search_index_queue').select('*').is('processed_at', null).limit(100);
  const endpoint = Deno.env.get('SEARCH_INDEX_ENDPOINT'); const apiKey = Deno.env.get('SEARCH_INDEX_API_KEY');
  if (!endpoint || !apiKey) return Response.json({ processed: 0, message: 'Search indexing is not configured.' });
  for (const job of jobs || []) { const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(job) }); if (response.ok) await db.from('search_index_queue').update({ processed_at: new Date().toISOString() }).eq('id', job.id); }
  return Response.json({ processed: jobs?.length || 0 });
});
