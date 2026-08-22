import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function sortObject(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.keys(obj)
    .sort()
    .reduce((result: any, key: string) => {
      result[key] = sortObject(obj[key]);
      return result;
    }, {});
}

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  try {
    const raw = await req.text();
    const signature = req.headers.get('x-nowpayments-sig') || '';
    const secret = Deno.env.get('NOWPAYMENTS_IPN_SECRET');

    if (!secret) {
      return new Response('NOWPAYMENTS_IPN_SECRET not set', { status: 500 });
    }

    const parsed = JSON.parse(raw);
    const sorted = sortObject(parsed);
    const expected = await hmac(secret.trim(), JSON.stringify(sorted));

    if (signature.toLowerCase() !== expected.toLowerCase()) {
      return new Response('Invalid signature', { status: 401 });
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const statusMap: Record<string, string> = {
      finished: 'paid',
      confirmed: 'paid',
      failed: 'failed',
      expired: 'failed',
      refunded: 'refunded',
    };

    const next = statusMap[parsed.payment_status];

    if (next === 'paid') {
      const rawToken = crypto.randomUUID() + crypto.randomUUID();
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
      const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

      await sb.from('orders').update({
        status: 'paid',
        provider: 'nowpayments',
        provider_transaction_id: String(parsed.payment_id),
        paid_at: new Date().toISOString(),
        download_token_hash: hash,
        download_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }).eq('id', parsed.order_id);
    } else if (next) {
      await sb.from('orders').update({ status: next }).eq('id', parsed.order_id);
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 400 });
  }
});
