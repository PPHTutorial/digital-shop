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

    const flwSecretKey = Deno.env.get('FLW_SECRET_KEY');
    if (!flwSecretKey) {
      throw new Error('FLW_SECRET_KEY is missing. Please add FLW_SECRET_KEY in Supabase Edge Function secrets.');
    }

    const body_ = await request.json();
    const order_id = body_.order_id;
    const paymentOption = body_.payment_option || 'all';
    const chosenCurrency = body_.currency;
    const clientSiteUrl = (body_.site_url || Deno.env.get('PUBLIC_SITE_URL') || 'https://digistore.codeinktechnologies.com').replace(/\/$/, '');
    if (!order_id) {
      return json({ error: 'order_id is required.' }, { status: 400 });
    }

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: order, error } = await db.from('orders')
      .select('id,user_id,product_id,customer_email,promo_code,amount,currency,discount_amount,products(title,price,currency,cover_url)')
      .eq('id', order_id).single();
    if (error || !order || order.user_id !== user.id) return json({ error: 'Order not found.' }, { status: 404 });

    const product = Array.isArray(order.products) ? order.products[0] : order.products;
    if (!product) {
      throw new Error('Product not found for this order.');
    }

    const chargeCurrency = (order.currency || chosenCurrency || product.currency || 'USD').toUpperCase();
    let amount = Number(order.amount);
    let discount = Number(order.discount_amount || 0);

    if (!amount || amount <= 0) {
      amount = Number(product.price);
      if (order.promo_code) {
        const { data: quote } = await db.rpc('quote_promo', { p_code: order.promo_code, p_product_id: order.product_id });
        const validQuote = Array.isArray(quote) ? quote[0] : quote;
        if (validQuote?.valid) discount = Number(validQuote.discount_amount);
      }
      amount = Math.max(0, amount - discount);
    }

    // Build robust redirect_url that is guaranteed to be a valid absolute URI
    const functionsBase =
      Deno.env.get('SUPABASE_FUNCTIONS_URL')?.replace(/\/$/, '') ||
      `${url.replace(/\/$/, '')}/functions/v1`;
    const redirectUrl = `${functionsBase}/flutterwave-callback?site_url=${encodeURIComponent(clientSiteUrl)}`;

    // Unique reference per payment attempt
    const reference = `BOOK-${order.id.slice(0, 8)}-${Date.now()}`;
    const customerName = user.user_metadata?.full_name || order.customer_email.split('@')[0] || 'Customer';
    const chargeCurrency = (chosenCurrency || product.currency || 'USD').toUpperCase();

    // Map payment option preference to Flutterwave payment_options string
    let paymentOptionsStr = 'card, banktransfer, ussd, mobilemoneyghana, mobilemoneyuganda, mobilemoneyrwanda, mobilemoneyzambia, mpesa, qr, enaira, credit, account, barter, googlepay, applepay';
    if (paymentOption === 'card') {
      paymentOptionsStr = 'card';
    } else if (paymentOption === 'banktransfer') {
      paymentOptionsStr = 'banktransfer, account';
    } else if (paymentOption === 'mobilemoney') {
      paymentOptionsStr = 'mobilemoneyghana, mobilemoneyuganda, mobilemoneyrwanda, mobilemoneyzambia, mpesa';
    } else if (paymentOption === 'ussd') {
      paymentOptionsStr = 'ussd';
    } else if (typeof paymentOption === 'string' && paymentOption !== 'all') {
      paymentOptionsStr = paymentOption;
    }

    const payload = {
      tx_ref: reference,
      amount: String(amount),
      currency: chargeCurrency,
      payment_options: paymentOptionsStr,
      redirect_url: redirectUrl,
      customer: {
        email: order.customer_email,
        name: customerName,
        phonenumber: user.phone || '0000000000',
      },
      meta: {
        order_id: order.id,
        user_id: user.id,
        payment_option: paymentOption,
      },
      customizations: {
        title: Deno.env.get('STORE_NAME') || 'DigiStore',
        description: product.title || 'Digital Product',
        logo: product.cover_url || undefined,
      },
    };

    const payment = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${flwSecretKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await payment.json();
    if (!payment.ok || !result.data?.link) {
      const message = result.message || (result.errors ? JSON.stringify(result.errors) : 'Unable to create Flutterwave payment');
      throw new Error(`Flutterwave API Error: ${message}`);
    }

    await db.from('orders').update({
      amount,
      discount_amount: discount,
      currency: chargeCurrency,
      provider: 'flutterwave',
      provider_reference: reference,
    }).eq('id', order.id);

    return json({ payment_url: result.data.link });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
