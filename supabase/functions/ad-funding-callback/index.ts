/**
 * Flutterwave callback for ad-wallet funding only.
 *
 * Deliberately separate from flutterwave-callback: that one releases a download
 * and books vendor earnings, neither of which applies here. Keeping them apart
 * means a funding payment can never mint a download token, and a product
 * payment can never top up a wallet.
 *
 * Handles both the browser redirect (GET) and the server webhook (POST). Both
 * verify the transaction with Flutterwave before crediting, and both funnel
 * into credit_ad_funding(), which is idempotent — whichever arrives first
 * credits, the other is a no-op.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Confirms with Flutterwave that this reference really was paid, and for how much. */
async function verify(transactionId: string, key: string) {
  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  const body = await response.json();
  return { ok: response.ok, data: body?.data };
}

Deno.serve(async (request) => {
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();

  /* --- Webhook ------------------------------------------------------------- */
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const event = body.data || body;
      const reference: string | undefined = event.tx_ref;
      const transactionId = event.id || event.transaction_id;
      const status = String(event.status || body.event || '').toLowerCase();

      // Ignore anything that is not ours — the shop has its own callback.
      if (!reference?.startsWith('ADFUND-')) {
        return Response.json({ ignored: true }, { status: 200 });
      }

      if (status.includes('cancel') || status.includes('fail')) {
        await db.rpc('credit_ad_funding', {
          p_reference: reference,
          p_succeeded: false,
          p_failure_reason: `Gateway reported: ${status}`,
        });
        return Response.json({ status: 'acknowledged' }, { status: 200 });
      }

      if (!flwKey) return Response.json({ error: 'FLW_SECRET_KEY missing' }, { status: 500 });

      const verified = await verify(String(transactionId), flwKey);
      if (!verified.ok || verified.data?.status !== 'successful' || verified.data?.tx_ref !== reference) {
        await db.rpc('credit_ad_funding', {
          p_reference: reference,
          p_succeeded: false,
          p_failure_reason: 'Verification with Flutterwave failed.',
        });
        return Response.json({ status: 'verification_failed' }, { status: 200 });
      }

      const { data } = await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_provider_transaction_id: String(transactionId),
      });
      return Response.json({ status: 'ok', result: data }, { status: 200 });
    } catch (error) {
      return Response.json({ error: String((error as Error)?.message || error) }, { status: 500 });
    }
  }

  /* --- Browser redirect ----------------------------------------------------- */
  const requestUrl = new URL(request.url);
  const siteUrl = (requestUrl.searchParams.get('site_url') ||
    Deno.env.get('PUBLIC_SITE_URL') ||
    'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

  const back = (state: string) => Response.redirect(`${siteUrl}/vendor?funding=${state}#boost`, 302);

  try {
    const transactionId = requestUrl.searchParams.get('transaction_id');
    const reference = requestUrl.searchParams.get('tx_ref');
    const status = (requestUrl.searchParams.get('status') || '').toLowerCase();

    if (!reference?.startsWith('ADFUND-')) return back('unknown');

    if (status === 'cancelled' || status === 'canceled') {
      await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_succeeded: false,
        p_failure_reason: 'Cancelled at the payment page.',
      });
      return back('cancelled');
    }

    if (status !== 'successful' || !transactionId) {
      await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_succeeded: false,
        p_failure_reason: `Payment not completed (${status || 'no status'}).`,
      });
      return back('failed');
    }

    if (!flwKey) return back('error');

    const verified = await verify(transactionId, flwKey);
    if (!verified.ok || verified.data?.status !== 'successful' || verified.data?.tx_ref !== reference) {
      await db.rpc('credit_ad_funding', {
        p_reference: reference,
        p_succeeded: false,
        p_failure_reason: 'Verification with Flutterwave failed.',
      });
      return back('failed');
    }

    await db.rpc('credit_ad_funding', {
      p_reference: reference,
      p_provider_transaction_id: String(transactionId),
    });
    return back('success');
  } catch {
    return back('error');
  }
});
