-- =============================================================================
-- Vendor payouts — part 2 of 3: Flutterwave Transfers auto-dispatch
--
-- Turns a `payouts` row (status 'requested', created by request_payout() or
-- run_scheduled_payouts()) into an actual outbound bank transfer, safely:
--
--   * public.payout_transfers   — exactly ONE row per payout, ever. unique on
--                                 (payout_id) and (idempotency_key). The key is
--                                 payouts.idempotency_key, which the Edge
--                                 Function sends to Flutterwave as the transfer
--                                 `reference` — so a retried POST returns the
--                                 same transfer instead of a second one.
--   * claim_payout_for_transfer() — the idempotency gate. Locks the payout,
--                                   refuses unless status = 'requested' and no
--                                   transfer row exists, flips it to
--                                   'processing', returns the resolved verified
--                                   payout-account fields.
--   * record_transfer_result()  — stores the API response. Marks the payout
--                                 PAID never here — only on a verified webhook.
--                                 An immediate FAILED at initiation rolls back.
--   * apply_transfer_webhook()  — terminal state from a signature-checked,
--                                 re-verified webhook. SUCCESS -> payout paid +
--                                 earnings paid. FAILED -> payout failed +
--                                 earnings released to 'available' (swept next
--                                 cycle as a fresh payout). Idempotent.
--   * flag_stale_transfers()    — surfaces stuck transfers for a human.
--
-- Auto-dispatch is gated by site_settings.payout_auto_dispatch (part 1,
-- default false). Until it's on, run-payouts stops after creating the
-- 'requested' rows and an admin settles via admin_settle_payout().
-- =============================================================================

create table if not exists public.payout_transfers (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null unique references public.payouts(id) on delete cascade,
  idempotency_key text not null unique,
  provider text not null default 'flutterwave',
  flw_transfer_id text,
  amount numeric(12, 2) not null,
  currency text not null default 'USD',
  fee numeric(12, 2),
  status text not null default 'queued'
    check (status in ('queued', 'initiated', 'pending', 'success', 'failed')),
  flw_status text,
  failure_reason text,
  raw_request jsonb,
  raw_response jsonb,
  raw_webhook jsonb,
  stale_flagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payout_transfers_status_idx on public.payout_transfers (status, created_at);
create index if not exists payout_transfers_flw_idx on public.payout_transfers (flw_transfer_id)
  where flw_transfer_id is not null;
select public.attach_touch_trigger('public.payout_transfers');

alter table public.payout_transfers enable row level security;

drop policy if exists "vendors read own payout transfers" on public.payout_transfers;
create policy "vendors read own payout transfers" on public.payout_transfers
for select to authenticated
using (
  public.is_admin()
  or payout_id in (select id from public.payouts where vendor_id = public.current_vendor_id())
);

grant select on public.payout_transfers to authenticated;


-- =============================================================================
-- Claim — the idempotency gate
-- =============================================================================
create or replace function public.claim_payout_for_transfer(p_payout_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  p public.payouts;
  a public.payout_accounts;
  v_transfer uuid;
begin
  select * into p from public.payouts where id = p_payout_id for update;
  if p.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;
  if p.status <> 'requested' then
    return jsonb_build_object('claimed', false, 'reason', 'status_' || p.status::text);
  end if;
  if p.idempotency_key is null then
    return jsonb_build_object('claimed', false, 'reason', 'no_idempotency_key');
  end if;
  if exists (select 1 from public.payout_transfers where payout_id = p_payout_id) then
    return jsonb_build_object('claimed', false, 'reason', 'transfer_exists');
  end if;

  select * into a from public.payout_accounts
  where id = p.payout_account_id and verification_status = 'verified';
  if a.id is null then
    return jsonb_build_object('claimed', false, 'reason', 'account_unverified');
  end if;

  update public.payouts set status = 'processing' where id = p_payout_id;

  insert into public.payout_transfers (payout_id, idempotency_key, amount, currency, status)
  values (p_payout_id, p.idempotency_key, p.amount, p.currency, 'queued')
  returning id into v_transfer;

  perform public.record_audit('payout.transfer_claimed', 'payout', p_payout_id::text,
    format('Transfer %s queued for %s %s', v_transfer, p.amount, p.currency));

  return jsonb_build_object(
    'claimed', true,
    'transfer_id', v_transfer,
    'idempotency_key', p.idempotency_key,
    'amount', p.amount,
    'currency', p.currency,
    'account', jsonb_build_object(
      'method', a.method,
      'bank_code', a.bank_code,
      'account_number', a.account_number,
      'account_name', a.account_name,
      'branch_code', a.branch_code,
      'swift_code', a.swift_code,
      'iban', a.iban,
      'momo_provider', a.momo_provider,
      'momo_number', a.momo_number,
      'country', a.country,
      'currency', a.currency
    )
  );
end;
$$;

revoke all on function public.claim_payout_for_transfer(uuid) from public;
revoke execute on function public.claim_payout_for_transfer(uuid) from anon, authenticated;
grant execute on function public.claim_payout_for_transfer(uuid) to service_role;


-- =============================================================================
-- Terminal-state handling — one place, used by both the initiation result and
-- the webhook. Locks the transfer row; a repeat call is a no-op.
-- =============================================================================
create or replace function public._finalize_transfer(
  p_transfer_id uuid, p_succeeded boolean, p_reason text, p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  t public.payout_transfers;
begin
  select * into t from public.payout_transfers where id = p_transfer_id for update;
  if t.id is null then
    return jsonb_build_object('applied', false, 'reason', 'transfer_not_found');
  end if;
  if t.status in ('success', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'already_final', 'status', t.status);
  end if;

  if p_succeeded then
    update public.payout_transfers
    set status = 'success', raw_webhook = coalesce(p_raw, raw_webhook), updated_at = now()
    where id = p_transfer_id;

    update public.payouts
    set status = 'paid', processed_at = now(),
        reference = coalesce(t.flw_transfer_id, reference)
    where id = t.payout_id and status in ('requested', 'processing');

    update public.vendor_earnings set status = 'paid' where payout_id = t.payout_id;

    perform public.record_audit('payout.transfer_completed', 'payout', t.payout_id::text,
      format('Transfer %s completed', coalesce(t.flw_transfer_id, t.id::text)));
    return jsonb_build_object('applied', true, 'status', 'success');
  end if;

  update public.payout_transfers
  set status = 'failed',
      failure_reason = coalesce(nullif(btrim(p_reason), ''), failure_reason, 'Transfer failed'),
      raw_webhook = coalesce(p_raw, raw_webhook), updated_at = now()
  where id = p_transfer_id;

  -- Roll the payout back: earnings return to 'available' and are swept again on
  -- the next cycle as a brand-new payout (new id -> new idempotency key).
  update public.payouts
  set status = 'failed', processed_at = now(),
      failure_reason = coalesce(nullif(btrim(p_reason), ''), 'Transfer failed')
  where id = t.payout_id and status in ('requested', 'processing');

  update public.vendor_earnings set payout_id = null where payout_id = t.payout_id;

  insert into public.notifications (title, body, audience, target_user_id)
  select 'Payout transfer failed',
         'A payout transfer did not go through. The funds are back in your available balance and will retry on your next payout.',
         'specific_user', v.user_id
  from public.payouts po
  join public.vendors v on v.id = po.vendor_id
  where po.id = t.payout_id;

  perform public.record_audit('payout.transfer_failed', 'payout', t.payout_id::text,
    coalesce(nullif(btrim(p_reason), ''), 'Transfer failed'));
  return jsonb_build_object('applied', true, 'status', 'failed');
end;
$$;

revoke all on function public._finalize_transfer(uuid, boolean, text, jsonb) from public;
revoke execute on function public._finalize_transfer(uuid, boolean, text, jsonb) from anon, authenticated;
grant execute on function public._finalize_transfer(uuid, boolean, text, jsonb) to service_role;


-- Called right after POST /v3/transfers returns. FLW's immediate status is
-- NEW / PENDING (-> we wait for the webhook) or, for a rejected instruction,
-- FAILED (-> roll back now, no webhook will come).
create or replace function public.record_transfer_result(
  p_transfer_id uuid, p_flw_transfer_id text, p_flw_status text, p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_failed boolean := lower(coalesce(p_flw_status, '')) in ('failed', 'error');
begin
  update public.payout_transfers
  set flw_transfer_id = coalesce(nullif(btrim(p_flw_transfer_id), ''), flw_transfer_id),
      flw_status = p_flw_status,
      status = case when status in ('success', 'failed') then status
                    when v_failed then status
                    else 'pending' end,
      raw_response = p_raw,
      updated_at = now()
  where id = p_transfer_id;

  if v_failed then
    return public._finalize_transfer(p_transfer_id, false,
      coalesce(p_raw ->> 'complete_message', p_raw ->> 'message', 'Transfer rejected at initiation'),
      p_raw);
  end if;
  return jsonb_build_object('applied', true, 'status', 'pending');
end;
$$;

revoke all on function public.record_transfer_result(uuid, text, text, jsonb) from public;
revoke execute on function public.record_transfer_result(uuid, text, text, jsonb) from anon, authenticated;
grant execute on function public.record_transfer_result(uuid, text, text, jsonb) to service_role;


-- Called by the transfer webhook after verif-hash + a GET /v3/transfers/:id
-- re-check. Matches on the FLW transfer id, falling back to the reference we
-- sent (= idempotency_key).
create or replace function public.apply_transfer_webhook(
  p_flw_transfer_id text, p_flw_status text, p_raw jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_transfer uuid;
  v_status text := lower(coalesce(p_flw_status, ''));
begin
  select id into v_transfer from public.payout_transfers
  where flw_transfer_id = p_flw_transfer_id
     or idempotency_key = (p_raw ->> 'reference')
  limit 1;

  if v_transfer is null then
    return jsonb_build_object('applied', false, 'reason', 'transfer_not_found');
  end if;

  update public.payout_transfers
  set flw_transfer_id = coalesce(flw_transfer_id, nullif(btrim(p_flw_transfer_id), '')),
      flw_status = p_flw_status, updated_at = now()
  where id = v_transfer;

  if v_status in ('successful', 'success', 'completed') then
    return public._finalize_transfer(v_transfer, true, null, p_raw);
  elsif v_status in ('failed', 'error', 'reversed') then
    return public._finalize_transfer(v_transfer, false,
      coalesce(p_raw ->> 'complete_message', p_raw ->> 'message', 'Transfer failed at the bank'), p_raw);
  end if;

  return jsonb_build_object('applied', false, 'reason', 'non_terminal_' || v_status);
end;
$$;

revoke all on function public.apply_transfer_webhook(text, text, jsonb) from public;
revoke execute on function public.apply_transfer_webhook(text, text, jsonb) from anon, authenticated;
grant execute on function public.apply_transfer_webhook(text, text, jsonb) to service_role;


create or replace function public.flag_stale_transfers(p_hours integer default 12)
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
begin
  update public.payout_transfers
  set stale_flagged_at = now(), updated_at = now()
  where status in ('queued', 'initiated', 'pending')
    and stale_flagged_at is null
    and created_at < now() - make_interval(hours => greatest(1, coalesce(p_hours, 12)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.flag_stale_transfers(integer) from public;
revoke execute on function public.flag_stale_transfers(integer) from anon, authenticated;
grant execute on function public.flag_stale_transfers(integer) to service_role;
