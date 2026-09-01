/**
 * Flutterwave settlement reconciliation.
 *
 * A confirmed charge is not cleared money — Flutterwave releases card payments
 * to us on its own settlement cycle (often up to 5 business days). This job
 * pulls the recent settlement batches, mirrors them into public.flw_settlements
 * for audit, and moves a "settled through" watermark forward. Orders whose
 * `paid_at` predates the watermark are marked settled, and
 * mature_vendor_earnings() then only matures earnings backed by settled funds.
 *
 * Auth: the cron secret in `x-cron-secret`, or a signed-in admin.
 * Schedule (Supabase Dashboard → Integrations → Cron): once or twice daily.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const FLW_BASE = 'https://api.flutterwave.com/v3';
const COMPLETED = new Set(['completed', 'processed', 'settled', 'success', 'successful']);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const cronSecret = Deno.env.get('CRON_SECRET');
  const presentedSecret = request.headers.get('x-cron-secret') ?? '';
  const cronAuthorized = Boolean(cronSecret) && presentedSecret === cronSecret;

  if (!cronAuthorized) {
    if (!token) return json({ error: 'Unauthorized' }, { status: 401 });
    const auth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const adminDb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: profile } = await adminDb.from('profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
  }

  const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();
  if (!flwKey) return json({ error: 'FLW_SECRET_KEY is not set.' }, { status: 500 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let seen = 0;
  let latestProcessed = 0;

  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`${FLW_BASE}/settlements?page=${page}`, {
      headers: { Authorization: `Bearer ${flwKey}` },
    });
    if (!res.ok) {
      if (page === 1) {
        return json({ error: `Flutterwave settlements ${res.status}: ${await res.text()}` }, { status: 502 });
      }
      break;
    }
    const body = await res.json();
    const rows: Record<string, unknown>[] = Array.isArray(body?.data) ? body.data : [];
    if (!rows.length) break;

    for (const row of rows) {
      seen += 1;
      await db.rpc('record_flw_settlement', { p_settlement: row });
      const status = String(row.status ?? '').toLowerCase();
      const processed = Date.parse(
        String(row.processed_date ?? row.processed_at ?? row.due_date ?? row.date_created ?? ''),
      );
      if (COMPLETED.has(status) && Number.isFinite(processed)) {
        latestProcessed = Math.max(latestProcessed, processed);
      }
    }

    const info = body?.meta?.page_info;
    if (info && Number(info.current_page) >= Number(info.total_pages)) break;
  }

  let watermark: string | null = null;
  if (latestProcessed > 0) {
    // 1-day safety margin: only settle orders comfortably inside a completed batch.
    watermark = new Date(latestProcessed - 24 * 60 * 60 * 1000).toISOString();
    await db.from('site_settings').update({ payout_settlement_watermark: watermark }).eq('id', 1);
  }

  const { data: settled } = await db.rpc('mark_settled_orders');
  const { data: matured } = await db.rpc('mature_vendor_earnings');

  return json({
    settlements_seen: seen,
    watermark,
    orders_settled: settled ?? 0,
    earnings_matured: matured ?? 0,
  });
});
