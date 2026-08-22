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
    let downloadUrl = product.file_path;

    if (product.file_path && !product.file_path.startsWith('http://') && !product.file_path.startsWith('https://')) {
      const cleanPath = product.file_path.replace(/^books\//, '');
      const { data, error } = await db.storage.from('books').createSignedUrl(cleanPath, 3600, {
        download: true,
      });
      if (!error && data?.signedUrl) {
        downloadUrl = data.signedUrl;
      }
    } else if (downloadUrl && !downloadUrl.includes('download=')) {
      const sep = downloadUrl.includes('?') ? '&' : '?';
      downloadUrl = `${downloadUrl}${sep}download=`;
    }

    return json({ url: downloadUrl });
  } catch (error) {
    return json({ error: 'Unable to generate download: ' + (error?.message || 'Server error') }, { status: 500 });
  }
});
