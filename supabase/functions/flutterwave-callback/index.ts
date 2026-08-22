import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();

  // ============================================================
  // 1. SERVER-TO-SERVER WEBHOOK (HTTP POST)
  // ============================================================
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const eventData = body.data || body;
      const tx = eventData.id || eventData.transaction_id;
      const ref = eventData.tx_ref;
      const eventStatus = (eventData.status || body.event || '').toLowerCase();

      if (!tx || !ref) {
        return Response.json({ message: 'Missing transaction data in webhook' }, { status: 400 });
      }

      // If webhook reports failure or cancellation
      if (eventStatus.includes('cancel') || eventStatus.includes('failed')) {
        await sb.from('orders').update({ status: eventStatus.includes('cancel') ? 'cancelled' : 'failed' })
          .eq('provider_reference', ref).eq('status', 'pending');
        return Response.json({ status: 'acknowledged', order_status: 'cancelled' }, { status: 200 });
      }

      // Verify transaction directly with Flutterwave API for absolute security
      if (!flwKey) {
        return Response.json({ error: 'FLW_SECRET_KEY not configured' }, { status: 500 });
      }

      const vr = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(tx)}/verify`, {
        headers: { Authorization: `Bearer ${flwKey}` },
      });
      const v = await vr.json();

      if (!vr.ok || v.data?.status !== 'successful' || v.data?.tx_ref !== ref) {
        await sb.from('orders').update({ status: 'failed' }).eq('provider_reference', ref).eq('status', 'pending');
        return Response.json({ status: 'verification_failed' }, { status: 200 });
      }

      const { data: o } = await sb.from('orders')
        .select('id,amount,currency,status')
        .eq('provider_reference', ref)
        .single();

      if (!o) {
        return Response.json({ message: 'Order not found for ref: ' + ref }, { status: 404 });
      }

      // Generate download token hash for customer access
      const rawToken = crypto.randomUUID() + crypto.randomUUID();
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
      const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

      await sb.from('orders').update({
        status: 'paid',
        provider: 'flutterwave',
        provider_transaction_id: String(tx),
        paid_at: new Date().toISOString(),
        download_token_hash: hash,
        download_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      }).eq('id', o.id);

      return Response.json({ status: 'success', order_id: o.id, order_status: 'paid' }, { status: 200 });
    } catch (err) {
      return Response.json({ error: String((err as Error)?.message || err) }, { status: 500 });
    }
  }

  // ============================================================
  // 2. BROWSER REDIRECT CALLBACK (HTTP GET)
  // ============================================================
  try {
    const u = new URL(req.url);
    const tx = u.searchParams.get('transaction_id');
    const status = (u.searchParams.get('status') || '').toLowerCase();
    const ref = u.searchParams.get('tx_ref');
    const paramSite = u.searchParams.get('site_url');
    const siteUrl = (paramSite || Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

    // Handle user cancellation
    if (status === 'cancelled' || status === 'canceled') {
      if (ref) {
        await sb.from('orders').update({ status: 'cancelled' }).eq('provider_reference', ref).eq('status', 'pending');
      }
      return Response.redirect(`${siteUrl}/success.html?status=cancelled`, 302);
    }

    if (status !== 'successful' || !tx || !ref) {
      if (ref) {
        await sb.from('orders').update({ status: 'failed' }).eq('provider_reference', ref).eq('status', 'pending');
      }
      return Response.redirect(`${siteUrl}/success.html?status=failed`, 302);
    }

    if (!flwKey) {
      return Response.redirect(`${siteUrl}/success.html?status=config_error`, 302);
    }

    const vr = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(tx)}/verify`, {
      headers: { Authorization: `Bearer ${flwKey}` },
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

    const rawToken = crypto.randomUUID() + crypto.randomUUID();
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

    await sb.from('orders').update({
      status: 'paid',
      provider: 'flutterwave',
      provider_transaction_id: String(tx),
      paid_at: new Date().toISOString(),
      download_token_hash: hash,
      download_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', o.id);

    return Response.redirect(`${siteUrl}/success.html?token=${encodeURIComponent(rawToken)}&order_id=${encodeURIComponent(o.id)}`, 302);
  } catch (e) {
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');
    return Response.redirect(`${siteUrl}/success.html?status=error`, 302);
  }
});
