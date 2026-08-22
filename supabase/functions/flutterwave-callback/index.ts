import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const tx = u.searchParams.get('transaction_id');
    const status = u.searchParams.get('status');
    const ref = u.searchParams.get('tx_ref');
    const paramSite = u.searchParams.get('site_url');
    const siteUrl = (paramSite || Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

    // Handle user cancellation gracefully
    if (status === 'cancelled') {
      return Response.redirect(`${siteUrl}/success.html?status=cancelled`, 302);
    }

    if (status !== 'successful' || !tx || !ref) {
      return Response.redirect(`${siteUrl}/success.html?status=failed`, 302);
    }

    const flwKey = Deno.env.get('FLW_SECRET_KEY');
    if (!flwKey) {
      return Response.redirect(`${siteUrl}/success.html?status=config_error`, 302);
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const vr = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(tx)}/verify`, {
      headers: { Authorization: `Bearer ${flwKey.trim()}` },
    });
    const v = await vr.json();

    if (!vr.ok || v.data?.status !== 'successful' || v.data?.tx_ref !== ref) {
      return Response.redirect(`${siteUrl}/success.html?status=failed`, 302);
    }

    const { data: o } = await sb.from('orders')
      .select('id,amount,currency,status')
      .eq('provider_reference', ref)
      .single();

    if (!o) {
      return Response.redirect(`${siteUrl}/success.html?status=order_not_found`, 302);
    }

    if (Number(v.data.amount) !== Number(o.amount) || v.data.currency?.toUpperCase() !== o.currency?.toUpperCase()) {
      return Response.redirect(`${siteUrl}/success.html?status=mismatch`, 302);
    }

    const rawToken = crypto.randomUUID() + crypto.randomUUID();
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

    await sb.from('orders').update({
      status: 'paid',
      provider_transaction_id: String(tx),
      paid_at: new Date().toISOString(),
      download_token_hash: hash,
      download_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }).eq('id', o.id);

    return Response.redirect(`${siteUrl}/success.html?token=${encodeURIComponent(rawToken)}&order_id=${encodeURIComponent(o.id)}`, 302);
  } catch (e) {
    return Response.redirect(`${siteUrl}/success.html?status=error`, 302);
  }
});
