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

    // ---- Period filter -------------------------------------------------------
    // The client sends the resolved window as ISO strings (single source of
    // truth — see js/filters.js). `overviewOnly` is the lightweight repaint
    // path used when only the dashboard period changed.
    let periodBody: any = {};
    if (request.method === 'POST') {
      try { periodBody = await request.json(); } catch { /* no body */ }
    }
    const fromIso: string | null = typeof periodBody?.from === 'string' && periodBody.from ? periodBody.from : null;
    const toIso: string | null = typeof periodBody?.to === 'string' && periodBody.to ? periodBody.to : null;
    const bounded = Boolean(fromIso || toIso);
    const vendorId: string | null = typeof periodBody?.vendorId === 'string' && periodBody.vendorId ? periodBody.vendorId : null;
    const category: string | null = typeof periodBody?.category === 'string' && periodBody.category ? periodBody.category : null;

    // Product ids the overview aggregation is confined to when a store and/or
    // category filter is active (null = no confinement).
    const scopedProductIds = async (): Promise<string[] | null> => {
      if (!vendorId && !category) return null;
      let q = db.from('products').select('id');
      if (vendorId) q = q.eq('vendor_id', vendorId);
      if (category) q = q.eq('category', category);
      const { data } = await q.limit(100000);
      return (data || []).map((p: any) => p.id as string);
    };

    // Paid orders inside the window — a dedicated, essentially uncapped
    // aggregation query (thin column set) so revenue figures never depend on
    // the row-list fetch limits below.
    const scopedPaidOrders = async (productIds: string[] | null) => {
      if (productIds && productIds.length === 0) return [];
      let q = db.from('orders').select('amount,created_at,product_id').eq('status', 'paid');
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      if (productIds) q = q.in('product_id', productIds);
      const { data } = await q.order('created_at', { ascending: false }).limit(100000);
      return data || [];
    };

    const newCustomerCount = async () => {
      let q = db.from('profiles').select('id', { count: 'exact', head: true });
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      const { count } = await q;
      return count || 0;
    };

    // Bucket keys spanning the window: daily up to ~13 weeks, monthly beyond.
    const bucketKeys = (): { keys: string[]; sliceLen: number } => {
      const end = toIso ? new Date(toIso) : new Date();
      const start = fromIso
        ? new Date(fromIso)
        : (() => { const d = new Date(end); d.setUTCDate(d.getUTCDate() - 29); return d; })();
      const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      if (spanDays <= 92) {
        const keys: string[] = [];
        const d = new Date(start); d.setUTCHours(0, 0, 0, 0);
        while (d <= end) { keys.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
        return { keys, sliceLen: 10 };
      }
      const keys: string[] = [];
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      while (d <= end) { keys.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
      return { keys: keys.slice(-36), sliceLen: 7 };
    };

    const buildPeriodMetrics = (scopedPaid: any[], products: any[], newCustomers: number) => {
      const { keys, sliceLen } = bucketKeys();
      const revenueByDay = keys.map((key) => ({
        date: key,
        revenue: scopedPaid
          .filter((o) => String(o.created_at).slice(0, sliceLen) === key)
          .reduce((sum, o) => sum + Number(o.amount), 0),
      }));
      const byProduct = new Map<string, { orders: number; revenue: number }>();
      for (const o of scopedPaid) {
        const cur = byProduct.get(o.product_id) || { orders: 0, revenue: 0 };
        cur.orders += 1;
        cur.revenue += Number(o.amount);
        byProduct.set(o.product_id, cur);
      }
      const topProducts = [...byProduct.entries()]
        .map(([id, v]) => ({ id, title: products.find((p) => p.id === id)?.title || 'Unlisted product', orders: v.orders, revenue: v.revenue }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
      const categoryStats = Array.from(new Set(products.map((p) => p.category || 'General')))
        .map((category) => {
          const ids = new Set(products.filter((p) => (p.category || 'General') === category).map((p) => p.id));
          const matching = scopedPaid.filter((o) => ids.has(o.product_id));
          return { category, products: ids.size, revenue: matching.reduce((sum, o) => sum + Number(o.amount), 0) };
        })
        .sort((a, b) => b.revenue - a.revenue);
      return {
        from: fromIso,
        to: toIso,
        bounded,
        revenue: scopedPaid.reduce((sum, o) => sum + Number(o.amount), 0),
        paidOrders: scopedPaid.length,
        newCustomers,
        revenueByDay,
        topProducts,
        categoryStats,
      };
    };

    const overviewProductIds = await scopedProductIds();
    const overviewProducts = (all: any[]): any[] =>
      overviewProductIds ? all.filter((p: any) => overviewProductIds.includes(p.id)) : all;

    if (periodBody?.overviewOnly) {
      const [scopedPaid, newCustomers, prodRes] = await Promise.all([
        scopedPaidOrders(overviewProductIds),
        newCustomerCount(),
        db.from('products').select('id,title,category').limit(5000),
      ]);
      return json({ periodMetrics: buildPeriodMetrics(scopedPaid, overviewProducts(prodRes.data || []), newCustomers) });
    }

    // Default: Fetch complete dashboard data with ALL columns for full editing
    const [ordersResult, profilesResult, ticketsResult, productsResult, postsResult, promosResult, categoriesResult, usersResult, scopedPaid, newCustomers] = await Promise.all([
      db.from('orders').select('*, products(id, title, slug, price, currency, cover_url)').order('created_at', { ascending: false }).limit(1000),
      db.from('profiles').select('*').order('created_at', { ascending: false }).limit(500),
      db.from('tickets').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('products').select('*').order('created_at', { ascending: false }).limit(1000),
      db.from('blog_posts').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(100),
      db.from('categories').select('*').order('sort_order').order('name').limit(100),
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      scopedPaidOrders(overviewProductIds),
      newCustomerCount(),
    ]);

    const orders = ordersResult.data || [];
    const paid = orders.filter((order) => order.status === 'paid');
    const revenueByDay = Array.from({ length: 30 }, (_, index) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - (29 - index));
      const key = date.toISOString().slice(0, 10);
      return {
        date: key,
        revenue: paid
          .filter((order) => order.created_at.slice(0, 10) === key)
          .reduce((sum, order) => sum + Number(order.amount), 0),
      };
    });

    const topProducts = [...new Map(paid.map((order) => [order.product_id, order])).keys()]
      .map((productId) => {
        const matching = paid.filter((order) => order.product_id === productId);
        const product = (productsResult.data || []).find((item) => item.id === productId);
        return {
          id: productId,
          title: product?.title || matching[0]?.products?.title || 'Unlisted product',
          orders: matching.length,
          revenue: matching.reduce((sum, order) => sum + Number(order.amount), 0),
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const categoryStats = Array.from(new Set((productsResult.data || []).map((product) => product.category || 'General')))
      .map((category) => {
        const productIds = (productsResult.data || []).filter((product) => (product.category || 'General') === category).map((product) => product.id);
        const matching = paid.filter((order) => productIds.includes(order.product_id));
        return { category, products: productIds.length, revenue: matching.reduce((sum, order) => sum + Number(order.amount), 0) };
      })
      .sort((a, b) => b.revenue - a.revenue);

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
      topProducts,
      categoryStats,
      // Period-scoped, uncapped aggregation for the dashboard period filter.
      // On the initial load `from`/`to` are absent, so this is the all-time view.
      periodMetrics: buildPeriodMetrics(scopedPaid, productsResult.data || [], newCustomers),
      orders,
      profiles: profilesResult.data || [],
      users,
      tickets: ticketsResult.data || [],
      products: productsResult.data || [],
      posts: postsResult.data || [],
      promos: promosResult.data || [],
      categories: categoriesResult.data || [],
    });
  } catch (error) {
    return json({ error: String((error as Error)?.message || error) }, { status: 500 });
  }
});
