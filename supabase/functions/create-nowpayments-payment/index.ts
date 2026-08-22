import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

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

    const body_ = await request.json();
    const order_id = body_.order_id;
    // Allow caller to pass a preferred pay_currency (e.g. "btc", "eth", "usdttrc20", or "any")
    const payCurrency: string =
      body_.pay_currency !== undefined ? body_.pay_currency : (Deno.env.get('NP_DEFAULT_PAY_CURRENCY') || '');

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: order, error } = await db.from('orders')
      .select('id,user_id,product_id,customer_email,promo_code,products(title,price,currency)')
      .eq('id', order_id).single();
    if (error || !order || order.user_id !== user.id) return json({ error: 'Order not found.' }, { status: 404 });

    const product = Array.isArray(order.products) ? order.products[0] : order.products;
    let amount = Number(product.price);
    let discount = 0;
    if (order.promo_code) {
      const { data: quote } = await db.rpc('quote_promo', { p_code: order.promo_code, p_product_id: order.product_id });
      const validQuote = Array.isArray(quote) ? quote[0] : quote;
      if (validQuote?.valid) discount = Number(validQuote.discount_amount);
    }
    amount = Math.max(0, amount - discount);

    // Build and validate the IPN callback URL — must be an absolute https:// URI
    const functionsBase =
      Deno.env.get('SUPABASE_FUNCTIONS_URL') ||
      `${url.replace(/\/$/, '')}/functions/v1`;
    const ipnCallbackUrl = `${functionsBase}/nowpayments-ipn`;
    if (!ipnCallbackUrl.startsWith('https://')) {
      throw new Error(
        `ipn_callback_url is not a valid https URI: "${ipnCallbackUrl}". ` +
        `Set SUPABASE_FUNCTIONS_URL to your public functions base URL (e.g. https://<ref>.functions.supabase.co).`
      );
    }
    const siteUrl = (body_.site_url || Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');

    const invoiceBody: Record<string, any> = {
      price_amount: amount,
      price_currency: (product.currency || 'USD').toLowerCase(),
      ipn_callback_url: ipnCallbackUrl,
      success_url: `${siteUrl}/success.html?order_id=${encodeURIComponent(order.id)}`,
      cancel_url: `${siteUrl}/checkout.html?product=${encodeURIComponent(order.product_id)}`,
      order_id: order.id,
      order_description: product.title,
    };

    // If caller specified a currency (e.g. 'btc', 'eth', 'usdttrc20', 'sol'), pass it.
    // If 'any' or omitted, leave pay_currency undefined so NOWPayments allows all 300+ coins on checkout.
    if (payCurrency && payCurrency !== 'any' && payCurrency !== 'all' && payCurrency.trim() !== '') {
      invoiceBody.pay_currency = payCurrency.toLowerCase().trim();
    }

    const payment = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': Deno.env.get('NOWPAYMENTS_API_KEY')!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(invoiceBody),
    });
    const result = await payment.json();
    if (!payment.ok || !result.invoice_url) {
      throw new Error(result.message || JSON.stringify(result));
    }

    await db.from('orders').update({
      amount,
      discount_amount: discount,
      currency: product.currency,
      provider: 'nowpayments',
      provider_reference: String(result.id ?? result.invoice_id ?? order.id),
    }).eq('id', order.id);

    return json({ payment_url: result.invoice_url });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
