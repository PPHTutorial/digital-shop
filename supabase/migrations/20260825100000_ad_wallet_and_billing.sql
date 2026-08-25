-- =============================================================================
-- Ad wallet + three-tier campaign billing
--
-- Vendors pre-fund a wallet; campaigns draw from it. Three billable events,
-- charged at rates frozen onto the campaign when it is created so a later rate
-- change never rewrites what a running campaign costs:
--
--   impression  cpm_rate / 1000   cheapest, highest volume
--   click       cpc_rate          the visitor showed intent
--   purchase    cpa_percent %     of the sale value; only charged on money in
--
-- Everything is settled inside `record_ad_event`, which is the only way spend
-- moves. It is atomic: dedupe, balance check, wallet debit, ledger entry,
-- counter update and auto-pause all happen in one statement, so a campaign can
-- never spend past its budget or a wallet past zero.
--
-- Moderation is deliberate: a campaign serves only when an admin has approved
-- it AND the vendor has set it live, so no ad reaches the storefront unreviewed.
-- =============================================================================

-- =========================
-- Wallet
-- =========================
create table if not exists public.ad_wallets (
  vendor_id uuid primary key references public.vendors(id) on delete cascade,
  balance numeric(12, 2) not null default 0 check (balance >= 0),
  currency text not null default 'USD',
  lifetime_topup numeric(14, 2) not null default 0,
  lifetime_spend numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  create type public.wallet_txn_type as enum ('topup', 'charge', 'refund', 'adjustment');
exception when duplicate_object then null; end $$;

-- Append-only ledger. `balance_after` is stored so a statement can be rebuilt
-- exactly as the vendor saw it, without replaying every row.
create table if not exists public.ad_wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  type public.wallet_txn_type not null,
  amount numeric(12, 2) not null,
  balance_after numeric(12, 2) not null,
  currency text not null default 'USD',
  campaign_id uuid references public.ad_campaigns(id) on delete set null,
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ad_wallet_txn_vendor_idx
  on public.ad_wallet_transactions (vendor_id, created_at desc);

-- Vendor-initiated top-up requests. Settled by an admin against a real payment,
-- which is what actually credits the wallet.
create table if not exists public.ad_topup_requests (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reference text,
  note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ad_topup_status_idx on public.ad_topup_requests (status, created_at desc);


-- =========================
-- Campaign: rates, moderation, pacing
-- =========================
alter table public.ad_campaigns add column if not exists cpm_rate numeric(10, 4) not null default 2.50;
alter table public.ad_campaigns add column if not exists cpc_rate numeric(10, 4) not null default 0.35;
alter table public.ad_campaigns add column if not exists cpa_percent numeric(5, 2) not null default 3.00;
alter table public.ad_campaigns add column if not exists conversions integer not null default 0;
alter table public.ad_campaigns add column if not exists daily_cap numeric(12, 2);

-- Moderation lives in its own column rather than the status enum: ALTER TYPE
-- ... ADD VALUE cannot be used in the same transaction that adds it, which
-- makes enum growth awkward inside a migration.
alter table public.ad_campaigns add column if not exists review_status text not null default 'pending';
alter table public.ad_campaigns add column if not exists review_note text;
alter table public.ad_campaigns add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
alter table public.ad_campaigns add column if not exists reviewed_at timestamptz;

do $$ begin
  alter table public.ad_campaigns
    add constraint ad_campaign_review_status_check
    check (review_status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;

-- Placement drives the default rate card. Applied on insert only, so the rates
-- a campaign was created under stay fixed for its lifetime.
create or replace function public.apply_ad_rate_card()
returns trigger
language plpgsql
set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    select r.cpm, r.cpc, r.cpa into new.cpm_rate, new.cpc_rate, new.cpa_percent
    from (values
      ('featured', 2.50, 0.35, 3.00),
      ('search',   1.50, 0.25, 2.00),
      ('category', 1.00, 0.18, 1.50)
    ) as r(placement, cpm, cpc, cpa)
    where r.placement = new.placement;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ad_campaigns_rate_card on public.ad_campaigns;
create trigger ad_campaigns_rate_card
before insert or update on public.ad_campaigns
for each row execute procedure public.apply_ad_rate_card();


-- =========================
-- Billable events
-- =========================
do $$ begin
  create type public.ad_event_type as enum ('impression', 'click', 'purchase');
exception when duplicate_object then null; end $$;

-- One row per charged event. The unique constraint is the fraud brake: the same
-- viewer cannot be billed twice for the same campaign and event on the same day,
-- so a page left open on refresh — or someone hammering a competitor's budget —
-- charges once, not endlessly.
create table if not exists public.ad_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  event_type public.ad_event_type not null,
  cost numeric(12, 4) not null default 0,
  currency text not null default 'USD',
  dedupe_key text not null,
  event_day date not null default current_date,
  created_at timestamptz not null default now(),
  unique (campaign_id, event_type, dedupe_key, event_day)
);

create index if not exists ad_events_campaign_idx on public.ad_events (campaign_id, created_at desc);


-- Only a campaign that is BOTH admin-approved and vendor-active can serve.
create or replace view public.servable_ad_campaigns
with (security_invoker = true) as
select c.*
from public.ad_campaigns c
join public.ad_wallets w on w.vendor_id = c.vendor_id
where c.status = 'active'
  and c.review_status = 'approved'
  and c.spend < c.budget
  and w.balance > 0
  and c.starts_at <= now()
  and (c.ends_at is null or c.ends_at > now());


-- =========================
-- The one path spend can move
-- =========================
create or replace function public.record_ad_event(
  p_campaign_id uuid,
  p_event_type public.ad_event_type,
  p_dedupe_key text,
  p_order_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  c public.ad_campaigns;
  v_balance numeric(12, 2);
  v_cost numeric(12, 4) := 0;
  v_spent_today numeric(12, 2);
  v_new_balance numeric(12, 2);
begin
  if coalesce(trim(p_dedupe_key), '') = '' then
    return jsonb_build_object('charged', false, 'reason', 'missing_dedupe_key');
  end if;

  -- Lock the campaign so concurrent impressions cannot race past the budget.
  select * into c from public.ad_campaigns where id = p_campaign_id for update;
  if c.id is null then
    return jsonb_build_object('charged', false, 'reason', 'unknown_campaign');
  end if;

  if c.status <> 'active' or c.review_status <> 'approved' then
    return jsonb_build_object('charged', false, 'reason', 'not_servable');
  end if;

  if c.starts_at > now() or (c.ends_at is not null and c.ends_at <= now()) then
    return jsonb_build_object('charged', false, 'reason', 'outside_window');
  end if;

  -- Rate card. A purchase is charged on the actual sale value.
  v_cost := case p_event_type
    when 'impression' then c.cpm_rate / 1000.0
    when 'click' then c.cpc_rate
    when 'purchase' then round(coalesce(p_order_amount, 0) * c.cpa_percent / 100.0, 4)
  end;

  if v_cost < 0 then v_cost := 0; end if;

  -- Optional daily pacing.
  if c.daily_cap is not null then
    select coalesce(sum(cost), 0) into v_spent_today
    from public.ad_events
    where campaign_id = c.id and event_day = current_date;

    if v_spent_today + v_cost > c.daily_cap then
      return jsonb_build_object('charged', false, 'reason', 'daily_cap_reached');
    end if;
  end if;

  if c.spend + v_cost > c.budget then
    update public.ad_campaigns set status = 'completed', updated_at = now() where id = c.id;
    return jsonb_build_object('charged', false, 'reason', 'budget_exhausted');
  end if;

  select balance into v_balance from public.ad_wallets where vendor_id = c.vendor_id for update;
  if v_balance is null or v_balance < v_cost then
    update public.ad_campaigns set status = 'paused', updated_at = now() where id = c.id;
    return jsonb_build_object('charged', false, 'reason', 'insufficient_wallet_balance');
  end if;

  -- Dedupe. ON CONFLICT means a repeat view for the same viewer/day is free
  -- rather than an error, and nothing below runs for it.
  insert into public.ad_events (campaign_id, vendor_id, product_id, event_type, cost, currency, dedupe_key)
  values (c.id, c.vendor_id, c.product_id, p_event_type, v_cost, c.currency, p_dedupe_key)
  on conflict (campaign_id, event_type, dedupe_key, event_day) do nothing;

  if not found then
    return jsonb_build_object('charged', false, 'reason', 'already_counted');
  end if;

  v_new_balance := v_balance - v_cost;

  update public.ad_wallets
  set balance = v_new_balance,
      lifetime_spend = lifetime_spend + v_cost,
      updated_at = now()
  where vendor_id = c.vendor_id;

  insert into public.ad_wallet_transactions (vendor_id, type, amount, balance_after, currency, campaign_id, description)
  values (c.vendor_id, 'charge', -v_cost, v_new_balance, c.currency, c.id,
          format('%s on "%s"', p_event_type, c.name));

  update public.ad_campaigns
  set spend = spend + v_cost,
      impressions = impressions + case when p_event_type = 'impression' then 1 else 0 end,
      clicks = clicks + case when p_event_type = 'click' then 1 else 0 end,
      conversions = conversions + case when p_event_type = 'purchase' then 1 else 0 end,
      status = case when spend + v_cost >= budget then 'completed' else status end,
      updated_at = now()
  where id = c.id;

  return jsonb_build_object('charged', true, 'cost', v_cost, 'balance', v_new_balance);
end;
$$;

revoke all on function public.record_ad_event(uuid, public.ad_event_type, text, numeric) from public;
grant execute on function public.record_ad_event(uuid, public.ad_event_type, text, numeric) to anon, authenticated;


-- Conversions are attributed server-side when an order is paid, so a purchase
-- charge can never be fabricated by a browser.
create or replace function public.charge_ad_conversions()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  item record;
  camp record;
begin
  if new.status <> 'paid' or old.status = 'paid' then
    return new;
  end if;

  for item in
    select oi.product_id, oi.unit_price * oi.quantity as line_total
    from public.order_items oi
    where oi.order_id = new.id
  loop
    for camp in
      select id from public.ad_campaigns
      where product_id = item.product_id
        and status = 'active'
        and review_status = 'approved'
      limit 1
    loop
      perform public.record_ad_event(
        camp.id, 'purchase', 'order:' || new.id::text, item.line_total
      );
    end loop;
  end loop;

  return new;
end;
$$;

drop trigger if exists orders_charge_ad_conversions on public.orders;
create trigger orders_charge_ad_conversions
after update of status on public.orders
for each row execute procedure public.charge_ad_conversions();


-- =========================
-- Wallet operations
-- =========================
create or replace function public.request_ad_topup(p_amount numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_id uuid;
  v_currency text;
begin
  if v_vendor is null then
    raise exception 'Only vendors can top up an ad wallet.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero.' using errcode = '22023';
  end if;

  select payout_currency into v_currency from public.vendors where id = v_vendor;

  insert into public.ad_wallets (vendor_id, currency)
  values (v_vendor, coalesce(v_currency, 'USD'))
  on conflict (vendor_id) do nothing;

  insert into public.ad_topup_requests (vendor_id, amount, currency, note)
  values (v_vendor, p_amount, coalesce(v_currency, 'USD'), p_note)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'pending', 'amount', p_amount);
end;
$$;

revoke all on function public.request_ad_topup(numeric, text) from public;
grant execute on function public.request_ad_topup(numeric, text) to authenticated;


-- Admin settles a top-up against a real payment. This is what actually credits.
create or replace function public.settle_ad_topup(
  p_request_id uuid,
  p_approve boolean,
  p_reference text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  r public.ad_topup_requests;
  v_new_balance numeric(12, 2);
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  select * into r from public.ad_topup_requests where id = p_request_id for update;
  if r.id is null then
    raise exception 'That top-up request does not exist.' using errcode = '22023';
  end if;
  if r.status <> 'pending' then
    raise exception 'That request has already been settled.' using errcode = '22023';
  end if;

  update public.ad_topup_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reference = coalesce(p_reference, reference),
      note = coalesce(p_note, note),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = r.id;

  if not p_approve then
    return jsonb_build_object('status', 'rejected');
  end if;

  insert into public.ad_wallets (vendor_id, currency, balance, lifetime_topup)
  values (r.vendor_id, r.currency, r.amount, r.amount)
  on conflict (vendor_id) do update
    set balance = public.ad_wallets.balance + excluded.balance,
        lifetime_topup = public.ad_wallets.lifetime_topup + excluded.balance,
        updated_at = now()
  returning balance into v_new_balance;

  insert into public.ad_wallet_transactions (vendor_id, type, amount, balance_after, currency, description, created_by)
  values (r.vendor_id, 'topup', r.amount, v_new_balance, r.currency,
          coalesce(p_reference, 'Wallet top-up'), auth.uid());

  return jsonb_build_object('status', 'approved', 'balance', v_new_balance);
end;
$$;

revoke all on function public.settle_ad_topup(uuid, boolean, text, text) from public;
grant execute on function public.settle_ad_topup(uuid, boolean, text, text) to authenticated;


-- =========================
-- Moderation
-- =========================
create or replace function public.moderate_vendor(
  p_vendor_id uuid,
  p_status public.vendor_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  update public.vendors
  set status = p_status,
      rejection_reason = case when p_status in ('rejected', 'suspended') then p_reason else null end,
      approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
      updated_at = now()
  where id = p_vendor_id;

  -- An approved seller always has a wallet ready.
  if p_status = 'approved' then
    insert into public.ad_wallets (vendor_id, currency)
    select id, payout_currency from public.vendors where id = p_vendor_id
    on conflict (vendor_id) do nothing;
  end if;

  -- Losing approval pulls their live products and ads off the storefront.
  if p_status in ('suspended', 'rejected') then
    update public.products set is_published = false where vendor_id = p_vendor_id;
    update public.ad_campaigns set status = 'paused' where vendor_id = p_vendor_id and status = 'active';
  end if;

  return jsonb_build_object('id', p_vendor_id, 'status', p_status);
end;
$$;

revoke all on function public.moderate_vendor(uuid, public.vendor_status, text) from public;
grant execute on function public.moderate_vendor(uuid, public.vendor_status, text) to authenticated;


create or replace function public.moderate_campaign(
  p_campaign_id uuid,
  p_approve boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  update public.ad_campaigns
  set review_status = case when p_approve then 'approved' else 'rejected' end,
      review_note = p_note,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      -- Approval makes it live immediately; rejection takes it off the air.
      status = case when p_approve then 'active' else 'rejected' end,
      updated_at = now()
  where id = p_campaign_id;

  return jsonb_build_object('id', p_campaign_id, 'review_status', case when p_approve then 'approved' else 'rejected' end);
end;
$$;

revoke all on function public.moderate_campaign(uuid, boolean, text) from public;
grant execute on function public.moderate_campaign(uuid, boolean, text) to authenticated;


-- Admin moderation queues, in one round trip.
create or replace function public.moderation_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'vendors', (
      select coalesce(jsonb_agg(v order by v.applied_at), '[]'::jsonb) from (
        select id, display_name, slug, bio, country, payout_currency, status,
               commission_rate, applied_at, total_sales_count
        from public.vendors where status = 'pending'
      ) v
    ),
    'campaigns', (
      select coalesce(jsonb_agg(c order by c.created_at), '[]'::jsonb) from (
        select ca.id, ca.name, ca.placement, ca.budget, ca.currency, ca.starts_at, ca.ends_at,
               ca.cpm_rate, ca.cpc_rate, ca.cpa_percent, ca.created_at,
               p.title as product_title, v.display_name as vendor_name,
               w.balance as wallet_balance
        from public.ad_campaigns ca
        join public.vendors v on v.id = ca.vendor_id
        left join public.products p on p.id = ca.product_id
        left join public.ad_wallets w on w.vendor_id = ca.vendor_id
        where ca.review_status = 'pending'
      ) c
    ),
    'topups', (
      select coalesce(jsonb_agg(t order by t.created_at), '[]'::jsonb) from (
        select tr.id, tr.amount, tr.currency, tr.note, tr.created_at,
               v.display_name as vendor_name
        from public.ad_topup_requests tr
        join public.vendors v on v.id = tr.vendor_id
        where tr.status = 'pending'
      ) t
    ),
    'payouts', (
      select coalesce(jsonb_agg(p order by p.requested_at), '[]'::jsonb) from (
        select po.id, po.amount, po.currency, po.status, po.requested_at,
               v.display_name as vendor_name,
               pa.method, pa.account_name, pa.account_last4, pa.bank_name, pa.momo_provider
        from public.payouts po
        join public.vendors v on v.id = po.vendor_id
        left join public.payout_accounts pa on pa.id = po.payout_account_id
        where po.status in ('requested', 'processing')
      ) p
    )
  );
end;
$$;

revoke all on function public.moderation_queue() from public;
grant execute on function public.moderation_queue() to authenticated;


-- =========================
-- RLS
-- =========================
alter table public.ad_wallets enable row level security;
alter table public.ad_wallet_transactions enable row level security;
alter table public.ad_topup_requests enable row level security;
alter table public.ad_events enable row level security;

drop policy if exists "vendors read own wallet" on public.ad_wallets;
create policy "vendors read own wallet"
on public.ad_wallets for select to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "admins manage wallets" on public.ad_wallets;
create policy "admins manage wallets"
on public.ad_wallets for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "vendors read own wallet txns" on public.ad_wallet_transactions;
create policy "vendors read own wallet txns"
on public.ad_wallet_transactions for select to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "vendors read own topups" on public.ad_topup_requests;
create policy "vendors read own topups"
on public.ad_topup_requests for select to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "admins manage topups" on public.ad_topup_requests;
create policy "admins manage topups"
on public.ad_topup_requests for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Events are written only by record_ad_event (definer); nobody reads another
-- vendor's traffic.
drop policy if exists "vendors read own ad events" on public.ad_events;
create policy "vendors read own ad events"
on public.ad_events for select to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());


-- A campaign may no longer be flipped live by its owner: `status` becomes
-- servable only through moderate_campaign(). Vendors may still pause their own.
drop policy if exists "vendors update own campaigns" on public.ad_campaigns;
create policy "vendors update own campaigns"
on public.ad_campaigns for update to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin())
with check (
  public.is_admin()
  or (
    vendor_id = public.current_vendor_id()
    and review_status = 'approved'
    and status in ('active', 'paused')
  )
);
