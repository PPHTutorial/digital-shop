/**
 * Scheduled vendor payouts.
 *
 * Step 1 (always): run_scheduled_payouts() creates the payout rows whose
 * cadence is due (weekly on Fridays, monthly on the first business day),
 * bundling each vendor's available balance.
 *
 * Step 2 (only when site_settings.payout_auto_dispatch is true): for each
 * `requested` payout, claim it (claim_payout_for_transfer is the idempotency
 * gate — locks the payout, refuses if a transfer already exists), check the
 * Flutterwave float and the per-run cap, POST /v3/transfers with the payout's
 * idempotency_key as the transfer `reference`, and record the result. The
 * payout is NOT marked paid here — that waits for the signature-verified
 * transfer webhook.
 *
 * Auth: cron secret in `x-cron-secret`, or a signed-in admin.
 * Schedule: every business day (e.g. 07:00). Weekly/monthly cadence is decided
 * per-vendor inside run_scheduled_payouts(); a daily tick is fine.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const FLW_BASE = 'https://api.flutterwave.com/v3';

type Claim = {
  claimed: boolean;
  reason?: string;
  transfer_id?: string;
  idempotency_key?: string;
  amount?: number;
  currency?: string;
  account?: Record<string, string | null>;
};

function transferPayload(claim: Claim) {
  const a = claim.account || {};
  const base: Record<string, unknown> = {
    amount: Number(claim.amount),
    currency: claim.currency || 'USD',
    debit_currency: claim.currency || 'USD',
    reference: claim.idempotency_key,
    narration: 'DigiStore vendor payout',
  };
  if (a.method === 'mobile_money') {
    return { ...base, account_bank: a.momo_provider || 'MPS', account_number: a.momo_number, beneficiary_name: a.account_name };
  }
  return {
    ...base,
    account_bank: a.bank_code,
    account_number: a.account_number,
    beneficiary_name: a.account_name,
    ...(a.swift_code ? { meta: { swift_code: a.swift_code } } : {}),
  };
}

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

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: scheduled, error: schedErr } = await db.rpc('run_scheduled_payouts');
  if (schedErr) return json({ error: schedErr.message, stage: 'schedule' }, { status: 500 });

  const { data: settings } = await db.from('site_settings')
    .select('payout_auto_dispatch, payout_run_cap').eq('id', 1).maybeSingle();

  if (!settings?.payout_auto_dispatch) {
    return json({ scheduled, auto_dispatch: false, transfers: [] });
  }

  const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();
  if (!flwKey) return json({ error: 'FLW_SECRET_KEY is not set.', scheduled }, { status: 500 });

  const runCap = Number(settings.payout_run_cap ?? 0);

  const balByCcy: Record<string, number> = {};
  const balRes = await fetch(`${FLW_BASE}/balances`, { headers: { Authorization: `Bearer ${flwKey}` } });
  const balOk = balRes.ok;
  if (balOk) {
    const balBody = await balRes.json();
    for (const b of (Array.isArray(balBody?.data) ? balBody.data : [])) {
      balByCcy[String(b.currency).toUpperCase()] = Number(b.available_balance ?? 0);
    }
  }

  const { data: pending } = await db.from('payouts')
    .select('id, amount, currency').eq('status', 'requested').order('requested_at', { ascending: true });

  const spent: Record<string, number> = {};
  const results: unknown[] = [];

  for (const p of pending ?? []) {
    const ccy = String(p.currency || 'USD').toUpperCase();
    spent[ccy] = spent[ccy] ?? 0;
    const amt = Number(p.amount);

    if (runCap > 0 && spent[ccy] + amt > runCap) {
      results.push({ payout_id: p.id, skipped: 'run_cap' });
      continue;
    }
    if (balOk && balByCcy[ccy] !== undefined && spent[ccy] + amt > balByCcy[ccy]) {
      results.push({ payout_id: p.id, skipped: 'insufficient_float' });
      continue;
    }

    const { data: claim } = await db.rpc('claim_payout_for_transfer', { p_payout_id: p.id });
    if (!claim?.claimed) {
      results.push({ payout_id: p.id, skipped: claim?.reason ?? 'not_claimed' });
      continue;
    }

    let flwJson: Record<string, unknown> = {};
    try {
      const tRes = await fetch(`${FLW_BASE}/transfers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${flwKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(transferPayload(claim as Claim)),
      });
      flwJson = await tRes.json();
    } catch (e) {
      flwJson = { status: 'error', message: String((e as Error)?.message || e) };
    }

    const tdata = (flwJson?.data ?? {}) as Record<string, unknown>;
    const flwId = tdata.id != null ? String(tdata.id) : '';
    const flwStatus = String(tdata.status ?? flwJson?.status ?? 'PENDING');

    await db.rpc('record_transfer_result', {
      p_transfer_id: claim.transfer_id,
      p_flw_transfer_id: flwId,
      p_flw_status: flwStatus,
      p_raw: { ...flwJson, reference: claim.idempotency_key },
    });

    spent[ccy] += amt;
    results.push({ payout_id: p.id, transfer_id: claim.transfer_id, flw_transfer_id: flwId, flw_status: flwStatus });
  }

  await db.rpc('flag_stale_transfers', { p_hours: 12 });

  return json({ scheduled, auto_dispatch: true, float_checked: balOk, transfers: results });
});
