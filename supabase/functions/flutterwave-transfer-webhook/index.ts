/**
 * Flutterwave transfer webhook — the only place a payout is marked paid.
 *
 * Stricter than the charge callback because this moves money to a final state:
 *   1. verif-hash header must equal FLW_SECRET_HASH (set in the FLW dashboard).
 *   2. The transfer is re-fetched from GET /v3/transfers/:id — the webhook
 *      body's status is never trusted on its own.
 *   3. apply_transfer_webhook() applies the terminal state idempotently:
 *      SUCCESSFUL → payout paid + earnings paid; FAILED → payout failed +
 *      earnings released to `available` (swept next cycle as a fresh payout).
 *
 * Deployed --no-verify-jwt; the verif-hash check is the security boundary.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const FLW_BASE = 'https://api.flutterwave.com/v3';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });

  const secretHash = (Deno.env.get('FLW_SECRET_HASH') || '').trim();
  const presented = request.headers.get('verif-hash') || request.headers.get('verif_hash') || '';
  if (!secretHash || presented !== secretHash) {
    return json({ error: 'Bad signature' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const data = (body?.data ?? body ?? {}) as Record<string, unknown>;
  const transferId = data.id != null ? String(data.id) : '';
  const reference = data.reference != null ? String(data.reference) : '';

  if (!transferId && !reference) {
    return json({ ok: true, note: 'no transfer id or reference in payload' });
  }

  const flwKey = (Deno.env.get('FLW_SECRET_KEY') || '').trim();
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let status = String(data.status ?? '');
  let verified: Record<string, unknown> = data;

  if (transferId && flwKey) {
    const res = await fetch(`${FLW_BASE}/transfers/${encodeURIComponent(transferId)}`, {
      headers: { Authorization: `Bearer ${flwKey}` },
    });
    if (res.ok) {
      const vr = await res.json();
      verified = (vr?.data ?? {}) as Record<string, unknown>;
      status = String(verified.status ?? status);
    }
  }

  const { data: applied, error } = await db.rpc('apply_transfer_webhook', {
    p_flw_transfer_id: transferId,
    p_flw_status: status,
    p_raw: { ...verified, reference: reference || (verified.reference ?? '') },
  });

  if (error) return json({ ok: false, error: error.message }, { status: 500 });
  return json({ ok: true, applied });
});
