import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Authentication required.' }, { status: 401 });
    const url = Deno.env.get('SUPABASE_URL')!;
    const auth = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return json({ error: 'Invalid session.' }, { status: 401 });
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: caller } = await db.from('profiles').select('role').eq('id', user.id).single();
    if (caller?.role !== 'admin') return json({ error: 'Administrator access required.' }, { status: 403 });

    const [ordersResult, profilesResult, ticketsResult, productsResult, postsResult, promosResult, usersResult] = await Promise.all([
      db.from('orders').select('id,amount,currency,status,created_at,customer_email,provider,provider_transaction_id,products(title)').order('created_at', { ascending: false }).limit(100),
      db.from('profiles').select('id,full_name,role,created_at').order('created_at', { ascending: false }).limit(100),
      db.from('tickets').select('id,email,subject,status,category,created_at').order('created_at', { ascending: false }).limit(50),
      db.from('products').select('id,title,price,currency,is_published,created_at').order('created_at', { ascending: false }).limit(100),
      db.from('blog_posts').select('id,title,status,published_at,created_at').order('created_at', { ascending: false }).limit(100),
      db.from('promo_codes').select('id,code,is_active,redemption_count,created_at').order('created_at', { ascending: false }).limit(100),
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    const orders = ordersResult.data || [];
    const paid = orders.filter((order) => order.status === 'paid');
    const revenueByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (6 - index));
      const key = date.toISOString().slice(0, 10);
      return { date: key, revenue: paid.filter((order) => order.created_at.slice(0, 10) === key).reduce((sum, order) => sum + Number(order.amount), 0) };
    });
    const users = (usersResult.data?.users || []).map((item) => ({ id: item.id, email: item.email, created_at: item.created_at, last_sign_in_at: item.last_sign_in_at }));
    return json({
      metrics: { revenue: paid.reduce((sum, order) => sum + Number(order.amount), 0), paidOrders: paid.length, orders: orders.length, customers: users.length, openTickets: (ticketsResult.data || []).filter((ticket) => ticket.status !== 'closed').length, activeProducts: (productsResult.data || []).filter((product) => product.is_published).length },
      revenueByDay, orders, profiles: profilesResult.data || [], users, tickets: ticketsResult.data || [], products: productsResult.data || [], posts: postsResult.data || [], promos: promosResult.data || [],
    });
  } catch (error) { return json({ error: String(error?.message || error) }, { status: 500 }); }
});
