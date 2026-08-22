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

    const { order_id } = await request.json();
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
    const body = {
      price_amount: amount,
      price_currency: product.currency.toLowerCase(),
      ipn_callback_url: `${Deno.env.get('SUPABASE_FUNCTIONS_URL')}/nowpayments-ipn`,
      success_url: `${Deno.env.get('PUBLIC_SITE_URL')}/success.html?order_id=${encodeURIComponent(order.id)}`,
      cancel_url: `${Deno.env.get('PUBLIC_SITE_URL')}/checkout.html`,
      order_id: order.id,
      order_description: product.title,
    };
    const payment = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': Deno.env.get('NOWPAYMENTS_API_KEY')!, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await payment.json();
    if (!payment.ok || !result.invoice_url) throw new Error(result.message || 'Unable to create invoice');
    await db.from('orders').update({ amount, discount_amount: discount, currency: product.currency, provider: 'nowpayments', provider_reference: String(result.id ?? result.invoice_id ?? order.id) }).eq('id', order.id);
    return json({ payment_url: result.invoice_url });
  } catch (error) {
    return json({ error: String(error?.message || error) }, { status: 500 });
  }
});
