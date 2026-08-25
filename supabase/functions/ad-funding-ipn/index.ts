/**
 * NOWPayments IPN for ad-wallet funding only.
 *
 * Separate from nowpayments-ipn for the same reason as the Flutterwave
 * callback: the purchase IPN mints download tokens and books earnings, which
 * must never happen for a wallet top-up.
 *
 * The HMAC check is the security boundary — this endpoint is unauthenticated,
 * so an unsigned or wrongly signed body is rejected before anything is read
 * from it.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** NOWPayments signs the JSON with keys sorted recursively. */
function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return Object.keys(source).sort().reduce((out: Record<string, unknown>, key) => {
    out[key] = sortObject(source[key]);
    return out;
  }, {});
}

async function hmacSha512(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  try {
    const raw = await request.text();
    const signature = request.headers.get('x-nowpayments-sig') || '';
    const secret = Deno.env.get('NOWPAYMENTS_IPN_SECRET');

    if (!secret) return new Response('NOWPAYMENTS_IPN_SECRET not set', { status: 500 });

    const parsed = JSON.parse(raw);
    const expected = await hmacSha512(secret.trim(), JSON.stringify(sortObject(parsed)));
    if (signature.toLowerCase() !== expected.toLowerCase()) {
      return new Response('Invalid signature', { status: 401 });
    }

    // `order_id` carries our funding reference. Anything else belongs to the
    // purchase IPN and is not ours to act on.
    const reference: string = parsed.order_id || '';
    if (!reference.startsWith('ADFUND-')) {
      return new Response('Not an ad funding payment', { status: 200 });
    }

    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const status = String(parsed.payment_status || '').toLowerCase();

    if (status === 'finished' || status === 'confirmed') {
      const { data } = await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_provider_transaction_id: String(parsed.payment_id ?? ''),
      });
      return Response.json({ status: 'ok', result: data }, { status: 200 });
    }

    if (status === 'failed' || status === 'expired' || status === 'refunded') {
      await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_succeeded: false,
        p_failure_reason: `NOWPayments reported: ${status}`,
      });
      return Response.json({ status: 'acknowledged' }, { status: 200 });
    }

    // waiting / confirming / sending — nothing to settle yet.
    return Response.json({ status: 'pending', payment_status: status }, { status: 200 });
  } catch (error) {
    return new Response(String((error as Error)?.message || error), { status: 400 });
  }
});
