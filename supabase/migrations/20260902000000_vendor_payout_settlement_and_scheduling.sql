-- =============================================================================
-- Vendor payouts — part 1 of 3: settlement reconciliation + scheduled cadence
--
-- Today a vendor_earning matures pending -> available on a hardcoded 14-day
-- timer with no check that the payment provider has actually released the
-- money, and payouts are 100% manual (request_payout + an admin clicking
-- "Mark paid", which is two un-transactional client-side writes). This adds:
--
--   * orders.settlement_status / settled_at / settlement_ref / payment_type
--   * public.flw_settlements  — local mirror of Flutterwave settlement batches
--   * site_settings.payout_settlement_watermark — "Flutterwave has settled
--     everything paid on or before this instant"; set by the reconcile Edge
--     Function (part of the payouts Edge-Function set).
--   * mature_vendor_earnings() now gates a Flutterwave earning on its order
--     being settled (or older than the watermark). Crypto keeps the time hold.
--   * vendors.payout_cadence (manual | weekly | monthly) + next_payout_at.
--     weekly = every Friday, monthly = first business day of the month.
--   * _bundle_available_earnings() — a row-LOCKING bundler that closes the
--     TOCTOU in the current request_payout(); request_payout() + the scheduler
--     both call it. payouts gains `source` + a unique `idempotency_key` (reused
--     as the Flutterwave transfer reference in part 2).
--   * run_scheduled_payouts() — creates the due payout rows.
--   * admin_settle_payout() — ONE atomic RPC replacing the client-side writes.
--
-- Auto-dispatch (Flutterwave Transfers) is part 2, behind
-- site_settings.payout_auto_dispatch (added here, default false).
--
-- Reuses: is_admin(), current_vendor_id(), assert_account_active(),
-- record_audit(), the notifications table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- orders — settlement bookkeeping
-- -----------------------------------------------------------------------------
alter table public.orders add column if not exists settlement_status text not null default 'unsettled'
  check (settlement_status in ('unsettled', 'settled'));
alter table public.orders add column if not exists settled_at timestamptz;
alter table public.orders add column if not exists settlement_ref text;
alter table public.orders add column if not exists payment_type text;

create index if not exists orders_settlement_idx on public.orders (provider, settlement_status)
  where settlement_status = 'unsettled';


-- -----------------------------------------------------------------------------
-- flw_settlements — audit mirror of Flutterwave settlement batches. Field names
-- follow the /v3/settlements payload; `raw` always holds the untouched object,
-- so a schema drift only nulls the typed columns, never loses data.
-- -----------------------------------------------------------------------------
create table if not exists public.flw_settlements (
  id text primary key,                     -- Flutterwave settlement id
  status text,
  gross_amount numeric(14, 2),
  fee numeric(14, 2),
  net_amount numeric(14, 2),
  currency text,
  due_at timestamptz,
  processed_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);

create index if not exists flw_settlements_processed_idx on public.flw_settlements (processed_at desc);

alter table public.flw_settlements enable row level security;

drop policy if exists "admins read flw settlements" on public.flw_settlements;
create policy "admins read flw settlements" on public.flw_settlements
for select to authenticated
using (public.is_admin());

grant select on public.flw_settlements to authenticated;


-- -----------------------------------------------------------------------------
-- site_settings — payout knobs
-- -----------------------------------------------------------------------------
alter table public.site_settings add column if not exists payout_min_amount numeric(12, 2) not null default 50.00
  check (payout_min_amount >= 0);
alter table public.site_settings add column if not exists payout_settlement_watermark timestamptz;
alter table public.site_settings add column if not exists payout_auto_dispatch boolean not null default false;
alter table public.site_settings add column if not exists payout_run_cap numeric(14, 2) not null default 100000
  check (payout_run_cap >= 0);


-- -----------------------------------------------------------------------------
-- vendors — payout cadence
-- -----------------------------------------------------------------------------
alter table public.vendors add column if not exists payout_cadence text not null default 'manual'
  check (payout_cadence in ('manual', 'weekly', 'monthly'));
alter table public.vendors add column if not exists payout_min_amount numeric(12, 2)
  check (payout_min_amount is null or payout_min_amount >= 0);
alter table public.vendors add column if not exists next_payout_at timestamptz;

create index if not exists vendors_next_payout_idx on public.vendors (next_payout_at)
  where payout_cadence <> 'manual' and next_payout_at is not null;


-- -----------------------------------------------------------------------------
-- payouts — provenance + idempotency
-- -----------------------------------------------------------------------------
alter table public.payouts add column if not exists source text not null default 'manual'
  check (source in ('manual', 'scheduled_weekly', 'scheduled_monthly'));
alter table public.payouts add column if not exists idempotency_key text;

create unique index if not exists payouts_idempotency_key_key on public.payouts (idempotency_key)
  where idempotency_key is not null;


-- =============================================================================
-- Business-day helpers (immutable — no table reads, no now())
-- =============================================================================
create or replace function public.add_business_days(p_from timestamptz, p_days integer)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_date timestamptz := p_from;
  v_step integer := case when p_days < 0 then -1 else 1 end;
  v_left integer := abs(coalesce(p_days, 0));
begin
  while v_left > 0 loop
    v_date := v_date + (v_step || ' days')::interval;
    if extract(dow from v_date) not in (0, 6) then   -- 0 Sun, 6 Sat
      v_left := v_left - 1;
    end if;
  end loop;
  return v_date;
end;
$$;

-- The Friday strictly after p_from (if p_from is a Friday, the next one).
create or replace function public.next_friday(p_from timestamptz)
returns timestamptz
language sql
immutable
as $$
  select date_trunc('day', p_from)
    + (case when ((5 - extract(dow from p_from)::int + 7) % 7) = 0
            then 7
            else ((5 - extract(dow from p_from)::int + 7) % 7) end) * interval '1 day';
$$;

create or replace function public.first_business_day_of_month(p_month_start timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case extract(dow from date_trunc('month', p_month_start))
    when 6 then date_trunc('month', p_month_start) + interval '2 days'
    when 0 then date_trunc('month', p_month_start) + interval '1 day'
    else date_trunc('month', p_month_start)
  end;
$$;


-- =============================================================================
-- Settlement reconciliation
-- =============================================================================
create or replace function public.record_flw_settlement(p_settlement jsonb)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  insert into public.flw_settlements
    (id, status, gross_amount, fee, net_amount, currency, due_at, processed_at, raw)
  values (
    p_settlement ->> 'id',
    p_settlement ->> 'status',
    nullif(p_settlement ->> 'gross_amount', '')::numeric,
    nullif(coalesce(p_settlement ->> 'app_fee', p_settlement ->> 'fee'), '')::numeric,
    nullif(coalesce(p_settlement ->> 'settlement_amount', p_settlement ->> 'net_amount'), '')::numeric,
    coalesce(p_settlement ->> 'currency', 'NGN'),
    nullif(coalesce(p_settlement ->> 'due_date', p_settlement ->> 'due_at'), '')::timestamptz,
    nullif(coalesce(p_settlement ->> 'processed_date', p_settlement ->> 'processed_at'), '')::timestamptz,
    p_settlement
  )
  on conflict (id) do update set
    status = excluded.status,
    gross_amount = excluded.gross_amount,
    fee = excluded.fee,
    net_amount = excluded.net_amount,
    currency = excluded.currency,
    due_at = excluded.due_at,
    processed_at = excluded.processed_at,
    raw = excluded.raw;
end;
$$;

revoke all on function public.record_flw_settlement(jsonb) from public;
revoke execute on function public.record_flw_settlement(jsonb) from anon, authenticated;
grant execute on function public.record_flw_settlement(jsonb) to service_role;


-- Marks Flutterwave orders whose payment is older than the reconcile watermark
-- as settled. Called by the reconcile Edge Function after it refreshes the
-- watermark. Idempotent (only touches still-unsettled rows).
create or replace function public.mark_settled_orders()
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
  v_watermark timestamptz;
begin
  select payout_settlement_watermark into v_watermark from public.site_settings where id = 1;
  if v_watermark is null then
    return 0;
  end if;

  update public.orders
  set settlement_status = 'settled', settled_at = now()
  where provider = 'flutterwave'
    and settlement_status = 'unsettled'
    and paid_at is not null
    and paid_at <= v_watermark;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_settled_orders() from public;
revoke execute on function public.mark_settled_orders() from anon, authenticated;
grant execute on function public.mark_settled_orders() to service_role;


-- Redefinition of 20260824140000_marketplace_vendors.sql:476. UNCHANGED except
-- the settled-funds gate: a Flutterwave earning matures only once its order is
-- explicitly settled OR its payment predates the reconcile watermark. Non-
-- Flutterwave (crypto/other) keeps the pure time hold.
create or replace function public.mature_vendor_earnings()
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
  v_watermark timestamptz;
begin
  select payout_settlement_watermark into v_watermark from public.site_settings where id = 1;

  update public.vendor_earnings ve
  set status = 'available'
  from public.orders o
  where ve.order_id = o.id
    and ve.status = 'pending'
    and ve.available_at <= now()
    and (
          o.provider is distinct from 'flutterwave'
       or o.settlement_status = 'settled'
       or (v_watermark is not null and o.paid_at is not null and o.paid_at <= v_watermark)
        );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mature_vendor_earnings() from public;
revoke execute on function public.mature_vendor_earnings() from anon, authenticated;
grant execute on function public.mature_vendor_earnings() to service_role;


-- =============================================================================
-- Payout bundling — the locked, correct path
-- =============================================================================
create or replace function public._bundle_available_earnings(
  p_vendor uuid, p_account uuid, p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_amount numeric(12, 2);
  v_currency text;
  v_payout uuid;
begin
  -- Hold the candidate rows for the whole transaction so a concurrent bundle
  -- (a manual request racing the scheduled run) cannot claim the same
  -- earnings twice — the gap the previous request_payout() left open.
  perform 1
  from public.vendor_earnings
  where vendor_id = p_vendor and status = 'available' and payout_id is null
  for update;

  select coalesce(sum(net_amount), 0), coalesce(min(currency), 'USD')
    into v_amount, v_currency
  from public.vendor_earnings
  where vendor_id = p_vendor and status = 'available' and payout_id is null;

  if v_amount <= 0 then
    return jsonb_build_object('created', false);
  end if;

  insert into public.payouts
    (vendor_id, payout_account_id, amount, currency, source, idempotency_key)
  values
    (p_vendor, p_account, v_amount, v_currency, coalesce(p_source, 'manual'),
     'pt_' || replace(gen_random_uuid()::text, '-', ''))
  returning id into v_payout;

  update public.vendor_earnings
  set payout_id = v_payout
  where vendor_id = p_vendor and status = 'available' and payout_id is null;

  perform public.record_audit(
    'payout.requested', 'payout', v_payout::text,
    format('Payout of %s %s bundled (%s)', v_amount, v_currency, coalesce(p_source, 'manual'))
  );

  return jsonb_build_object('created', true, 'payout_id', v_payout,
                            'amount', v_amount, 'currency', v_currency);
end;
$$;

revoke all on function public._bundle_available_earnings(uuid, uuid, text) from public;
revoke execute on function public._bundle_available_earnings(uuid, uuid, text) from anon, authenticated;
grant execute on function public._bundle_available_earnings(uuid, uuid, text) to service_role;


-- Redefinition of 20260831150000_marketplace_admin_extras.sql:214. Same
-- validation; the bundling body is delegated to _bundle_available_earnings().
create or replace function public.request_payout(p_payout_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_verified text;
  v_result jsonb;
begin
  if v_vendor is null then
    raise exception 'Only vendors can request a payout.' using errcode = '42501';
  end if;

  perform public.assert_account_active();

  select verification_status into v_verified
  from public.payout_accounts
  where id = p_payout_account_id and vendor_id = v_vendor;

  if v_verified is null then
    raise exception 'That payout account does not belong to you.' using errcode = '42501';
  end if;
  if v_verified <> 'verified' then
    raise exception 'That payout account is still being reviewed. Withdrawals open once it is verified.' using errcode = '22023';
  end if;

  v_result := public._bundle_available_earnings(v_vendor, p_payout_account_id, 'manual');

  if not coalesce((v_result ->> 'created')::boolean, false) then
    raise exception 'You have no matured earnings to withdraw yet.' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'payout_id', v_result ->> 'payout_id',
    'amount', (v_result ->> 'amount')::numeric,
    'currency', v_result ->> 'currency'
  );
end;
$$;

revoke all on function public.request_payout(uuid) from public, anon, authenticated;
grant execute on function public.request_payout(uuid) to authenticated;


-- =============================================================================
-- Cadence
-- =============================================================================
create or replace function public.set_payout_cadence(p_cadence text)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_next timestamptz;
begin
  if v_vendor is null then
    raise exception 'Only vendors can set a payout schedule.' using errcode = '42501';
  end if;
  perform public.assert_account_active();

  if p_cadence not in ('manual', 'weekly', 'monthly') then
    raise exception 'Unknown payout cadence.' using errcode = '22023';
  end if;

  if p_cadence <> 'manual' and not exists (
    select 1 from public.payout_accounts
    where vendor_id = v_vendor and is_default and verification_status = 'verified'
  ) then
    raise exception 'Add and verify a default payout account before choosing an automatic schedule.'
      using errcode = '22023';
  end if;

  v_next := case p_cadence
    when 'weekly'  then public.next_friday(now())
    when 'monthly' then public.first_business_day_of_month(date_trunc('month', now()) + interval '1 month')
    else null
  end;

  update public.vendors
  set payout_cadence = p_cadence, next_payout_at = v_next, updated_at = now()
  where id = v_vendor;

  perform public.record_audit('vendor.payout_cadence_set', 'vendor', v_vendor::text,
    format('Payout cadence set to %s', p_cadence));

  return jsonb_build_object('cadence', p_cadence, 'next_payout_at', v_next);
end;
$$;

revoke all on function public.set_payout_cadence(text) from public, anon, authenticated;
grant execute on function public.set_payout_cadence(text) to authenticated;


-- Runs the due cadences. Advances next_payout_at unconditionally (a skip never
-- re-fires on the next tick); creates a payout row only when there is a
-- verified default account and the available balance clears the minimum.
create or replace function public.run_scheduled_payouts()
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_row record;
  v_account uuid;
  v_balance numeric(12, 2);
  v_min numeric(12, 2);
  v_default_min numeric(12, 2);
  v_bundle jsonb;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  select coalesce(payout_min_amount, 50) into v_default_min from public.site_settings where id = 1;

  for v_row in
    select id as vendor_id, user_id, payout_cadence, payout_min_amount
    from public.vendors
    where payout_cadence <> 'manual'
      and next_payout_at is not null
      and next_payout_at <= now()
    for update skip locked
  loop
    update public.vendors
    set next_payout_at = case v_row.payout_cadence
          when 'weekly'  then public.next_friday(now() + interval '1 day')
          when 'monthly' then public.first_business_day_of_month(date_trunc('month', now()) + interval '1 month')
          else null end,
        updated_at = now()
    where id = v_row.vendor_id;

    select id into v_account
    from public.payout_accounts
    where vendor_id = v_row.vendor_id and is_default and verification_status = 'verified'
    limit 1;

    if v_account is null then
      insert into public.notifications (title, body, audience, target_user_id)
      values ('Payout skipped',
              'Your scheduled payout could not run. Add and verify a default payout account to receive automatic payouts.',
              'specific_user', v_row.user_id);
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('vendor_id', v_row.vendor_id, 'reason', 'no_verified_account'));
      continue;
    end if;

    select coalesce(sum(net_amount), 0) into v_balance
    from public.vendor_earnings
    where vendor_id = v_row.vendor_id and status = 'available' and payout_id is null;

    v_min := coalesce(v_row.payout_min_amount, v_default_min);
    if v_balance < v_min then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'vendor_id', v_row.vendor_id, 'reason', 'below_minimum', 'balance', v_balance));
      continue;
    end if;

    v_bundle := public._bundle_available_earnings(v_row.vendor_id, v_account,
                                                  'scheduled_' || v_row.payout_cadence);
    if coalesce((v_bundle ->> 'created')::boolean, false) then
      v_created := v_created || jsonb_build_array(v_bundle);
    else
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('vendor_id', v_row.vendor_id, 'reason', 'nothing_to_bundle'));
    end if;
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

revoke all on function public.run_scheduled_payouts() from public;
revoke execute on function public.run_scheduled_payouts() from anon, authenticated;
grant execute on function public.run_scheduled_payouts() to service_role;


-- =============================================================================
-- Admin settlement — one atomic RPC, replaces the client-side writes in
-- js/admin.js. Only acts on a payout still in requested/processing.
-- =============================================================================
create or replace function public.admin_settle_payout(
  p_payout_id uuid, p_reference text, p_succeeded boolean, p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  select status into v_status from public.payouts where id = p_payout_id for update;
  if v_status is null then
    raise exception 'Payout not found.' using errcode = '22023';
  end if;
  if v_status not in ('requested', 'processing') then
    raise exception 'That payout is already %.', v_status using errcode = '22023';
  end if;

  if p_succeeded then
    update public.payouts
    set status = 'paid', processed_at = now(),
        reference = coalesce(nullif(btrim(p_reference), ''), reference)
    where id = p_payout_id;
    update public.vendor_earnings set status = 'paid' where payout_id = p_payout_id;
    perform public.record_audit('payout.settled', 'payout', p_payout_id::text, 'Marked paid by admin');
  else
    update public.payouts
    set status = 'failed', processed_at = now(),
        failure_reason = coalesce(nullif(btrim(p_failure_reason), ''), 'Marked failed by admin')
    where id = p_payout_id;
    update public.vendor_earnings set payout_id = null where payout_id = p_payout_id;
    perform public.record_audit('payout.failed', 'payout', p_payout_id::text,
      coalesce(nullif(btrim(p_failure_reason), ''), 'Marked failed by admin'));
  end if;

  return jsonb_build_object('ok', true, 'status', case when p_succeeded then 'paid' else 'failed' end);
end;
$$;

revoke all on function public.admin_settle_payout(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_settle_payout(uuid, text, boolean, text) to authenticated;
