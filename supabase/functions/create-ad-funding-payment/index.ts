/**
 * Starts an ad-wallet top-up.
 *
 * Same gateways as the shop, entirely separate pipeline: this never creates an
 * order and never touches the purchase tables. The amount is decided by
 * create_ad_funding() in the database (which enforces the minimum and the
 * seller's approval), so a browser cannot dictate what gets charged or credited.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const MIN_TOPUP = 25;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Authentication required.' }, { status: 401 });

    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const auth = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return json({ error: 'Invalid session.' }, { status: 401 });

    const body = await request.json();
    const amount = Number(body.amount);
    const provider = body.provider === 'nowpayments' ? 'nowpayments' : 'flutterwave';
    const payCurrency = body.pay_currency || 'any';
    const siteUrl = (body.site_url || Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

    if (!Number.isFinite(amount) || amount < MIN_TOPUP) {
      return json({ error: `The minimum top-up is $${MIN_TOPUP}.` }, { status: 400 });
    }

    // Create the funding record as the signed-in user, so current_vendor_id()
    // resolves and the approval check inside the function actually applies.
    const { data: funding, error: fundingError } = await auth.rpc('create_ad_funding', {
      p_amount: amount,
      p_provider: provider,
    });
    if (fundingError) return json({ error: fundingError.message }, { status: 400 });

    const functionsBase =
      Deno.env.get('SUPABASE_FUNCTIONS_URL')?.replace(/\/$/, '') ||
      `${url.replace(/\/$/, '')}/functions/v1`;

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    /* --- Flutterwave -------------------------------------------------------- */
    if (provider === 'flutterwave') {
      const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();
      if (!flwKey) return json({ error: 'FLW_SECRET_KEY is not configured.' }, { status: 500 });

      const payload = {
        tx_ref: funding.reference,
        amount: String(funding.amount),
        currency: funding.currency,
        payment_options: 'card, banktransfer, ussd, mobilemoneyghana, mpesa, account',
        // Its own callback — the purchase callback is never involved.
        redirect_url: `${functionsBase}/ad-funding-callback?site_url=${encodeURIComponent(siteUrl)}`,
        customer: {
          email: user.email,
          name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Seller',
        },
        meta: { kind: 'ad_funding', funding_id: funding.id, vendor_user: user.id },
        customizations: {
          title: Deno.env.get('STORE_NAME') || 'DigiStore',
          description: 'Advertising wallet top-up',
        },
      };

      const response = await fetch('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${flwKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok || !result.data?.link) {
        const message = result.message || 'Flutterwave did not return a payment link.';
        await db.from('ad_funding_payments')
          .update({ status: 'failed', failure_reason: message })
          .eq('id', funding.id);
        return json({ error: `Flutterwave: ${message}` }, { status: 502 });
      }

      return json({ payment_url: result.data.link, funding_id: funding.id });
    }

    /* --- NOWPayments -------------------------------------------------------- */
    const npKey = (Deno.env.get('NOWPAYMENTS_API_KEY') || '').trim();
    if (!npKey) return json({ error: 'NOWPAYMENTS_API_KEY is not configured.' }, { status: 500 });

    const invoice: Record<string, unknown> = {
      price_amount: Number(funding.amount),
      price_currency: String(funding.currency).toLowerCase(),
      ipn_callback_url: `${functionsBase}/ad-funding-ipn`,
      success_url: `${siteUrl}/vendor#boost`,
      cancel_url: `${siteUrl}/vendor#boost`,
      order_id: funding.reference,
      order_description: 'DigiStore advertising wallet top-up',
    };
    if (payCurrency && payCurrency !== 'any') invoice.pay_currency = payCurrency;

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': npKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(invoice),
    });
    const result = await response.json();

    if (!response.ok || !result.invoice_url) {
      const message = result.message || 'NOWPayments did not return an invoice.';
      await db.from('ad_funding_payments')
        .update({ status: 'failed', failure_reason: message })
        .eq('id', funding.id);
      return json({ error: `NOWPayments: ${message}` }, { status: 502 });
    }

    return json({ payment_url: result.invoice_url, funding_id: funding.id });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
