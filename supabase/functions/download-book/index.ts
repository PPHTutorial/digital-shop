import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { token, order_id } = await request.json();
    if (!token && !order_id) return json({ error: 'Missing download reference' }, { status: 400 });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    let order;
    if (token) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      ({ data: order } = await db.from('orders')
        .select('id,status,download_token_hash,download_expires_at,products(file_path)')
        .eq('download_token_hash', hash).single());
      if (!order || !order.download_expires_at || new Date(order.download_expires_at) < new Date()) {
        return json({ error: 'Download unavailable' }, { status: 403 });
      }
    } else {
      const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
      const { data: { user } } = await auth.auth.getUser();
      if (!user) return json({ error: 'Authentication required' }, { status: 401 });
      ({ data: order } = await db.from('orders')
        .select('id,status,download_token_hash,download_expires_at,products(file_path)')
        .eq('id', order_id).eq('user_id', user.id).single());
    }
    if (!order || order.status !== 'paid') {
      return json({ error: 'Download unavailable' }, { status: 403 });
    }
    const product = Array.isArray(order.products) ? order.products[0] : order.products;
    const { data, error } = await db.storage.from('books').createSignedUrl(product.file_path, 600);
    if (error) throw error;
    if (token) await db.from('orders').update({ download_token_hash: null, download_expires_at: null }).eq('id', order.id);
    return json({ url: data.signedUrl });
  } catch (error) {
    return json({ error: 'Unable to generate download' }, { status: 500 });
  }
});
