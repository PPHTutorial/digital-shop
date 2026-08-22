import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Authentication required.' }, { status: 401 });

    const url = Deno.env.get('SUPABASE_URL')!;
    const auth = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userError } = await auth.auth.getUser();
    if (userError || !user) return json({ error: 'Invalid session.' }, { status: 401 });

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: caller } = await db.from('profiles').select('role').eq('id', user.id).single();
    if (caller?.role !== 'admin') return json({ error: 'Administrator access required.' }, { status: 403 });

    // Check if request is a management action (e.g. updating profile, role, deleting user)
    if (request.method === 'POST') {
      let body: any = {};
      try {
        body = await request.json();
      } catch {}

      if (body?.action === 'update_user_role') {
        const { target_user_id, role, full_name, phone, country, address, occupation } = body;
        if (!target_user_id) return json({ error: 'target_user_id is required' }, { status: 400 });

        const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
        if (role) updateData.role = role;
        if (full_name !== undefined) updateData.full_name = full_name;
        if (phone !== undefined) updateData.phone = phone;
        if (country !== undefined) updateData.country = country;
        if (address !== undefined) updateData.address = address;
        if (occupation !== undefined) updateData.occupation = occupation;

        const { error: updErr } = await db.from('profiles').update(updateData).eq('id', target_user_id);
        if (updErr) return json({ error: updErr.message }, { status: 500 });
        return json({ success: true, message: 'User updated successfully.' });
      }

      if (body?.action === 'delete_user') {
        const { target_user_id } = body;
        if (!target_user_id) return json({ error: 'target_user_id is required' }, { status: 400 });
        if (target_user_id === user.id) return json({ error: 'You cannot delete your own admin account.' }, { status: 400 });

        const { error: delErr } = await db.auth.admin.deleteUser(target_user_id);
        if (delErr) return json({ error: delErr.message }, { status: 500 });
        return json({ success: true, message: 'User deleted successfully.' });
      }
    }

    // Default: Fetch complete dashboard data with ALL columns for full editing
    const [ordersResult, profilesResult, ticketsResult, productsResult, postsResult, promosResult, usersResult] = await Promise.all([
      db.from('orders').select('*, products(id, title, slug, price, currency, cover_url)').order('created_at', { ascending: false }).limit(200),
      db.from('profiles').select('*').order('created_at', { ascending: false }).limit(200),
      db.from('tickets').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('products').select('*').order('created_at', { ascending: false }).limit(200),
      db.from('blog_posts').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(100),
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

    const orders = ordersResult.data || [];
    const paid = orders.filter((order) => order.status === 'paid');
    const revenueByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - (6 - index));
      const key = date.toISOString().slice(0, 10);
      return {
        date: key,
        revenue: paid
          .filter((order) => order.created_at.slice(0, 10) === key)
          .reduce((sum, order) => sum + Number(order.amount), 0),
      };
    });

    const profilesMap = new Map((profilesResult.data || []).map((p) => [p.id, p]));

    const users = (usersResult.data?.users || []).map((item) => {
      const prof = profilesMap.get(item.id);
      return {
        id: item.id,
        email: item.email,
        full_name: prof?.full_name || item.user_metadata?.full_name || '',
        role: prof?.role || 'customer',
        phone: prof?.phone || item.phone || '',
        country: prof?.country || '',
        address: prof?.address || '',
        occupation: prof?.occupation || '',
        created_at: item.created_at,
        last_sign_in_at: item.last_sign_in_at,
      };
    });

    return json({
      metrics: {
        revenue: paid.reduce((sum, order) => sum + Number(order.amount), 0),
        paidOrders: paid.length,
        orders: orders.length,
        customers: users.length,
        openTickets: (ticketsResult.data || []).filter((ticket) => ticket.status !== 'closed').length,
        activeProducts: (productsResult.data || []).filter((product) => product.is_published).length,
      },
      revenueByDay,
      orders,
      profiles: profilesResult.data || [],
      users,
      tickets: ticketsResult.data || [],
      products: productsResult.data || [],
      posts: postsResult.data || [],
      promos: promosResult.data || [],
    });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
