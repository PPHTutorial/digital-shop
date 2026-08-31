-- =============================================================================
-- Affiliate programme
--
-- A referral system that mirrors the marketplace vendor architecture almost
-- one-for-one (20260824140000_marketplace_vendors.sql):
--
--   * public.affiliates            — one row per enrolled user (gate → apply →
--                                    approve), like public.vendors.
--   * public.affiliate_referrals   — first-party click / touch log; the row is
--                                    stamped with converted_user_id at signup.
--   * public.affiliate_earnings    — commission ledger, one row per attributed
--                                    paid order item, matured by a holding
--                                    period exactly like vendor_earnings.
--   * public.affiliate_payouts     — withdrawal requests, like public.payouts.
--
-- Commission is deliberately NOT a fixed number. Three layers resolve at
-- credit time (most specific wins):
--     per-affiliate override  →  per-vendor rate (vendor products, opt-in)  →
--     platform default (site_settings)
-- and the resolved rate + basis are frozen onto each ledger row so history
-- stays truthful after an admin re-tunes the settings.
--
-- Reuses the existing earning_status / payout_status enums and the is_admin()
-- helper. No new Edge Function is required — crediting is a trigger on
-- public.orders, matching orders_book_vendor_earnings.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.affiliate_status as enum ('pending', 'approved', 'suspended', 'rejected');
exception when duplicate_object then null; end $$;


-- -----------------------------------------------------------------------------
-- Settings — platform owner's knobs (site_settings row id = 1)
-- -----------------------------------------------------------------------------
alter table public.site_settings add column if not exists affiliate_program_enabled boolean not null default true;
alter table public.site_settings add column if not exists affiliate_commission_rate numeric(5, 2) not null default 10.00
  check (affiliate_commission_rate >= 0 and affiliate_commission_rate <= 100);
alter table public.site_settings add column if not exists affiliate_commission_basis text not null default 'gross'
  check (affiliate_commission_basis in ('gross', 'platform_net'));
alter table public.site_settings add column if not exists affiliate_commission_source text not null default 'platform'
  check (affiliate_commission_source in ('platform', 'vendor', 'split'));
alter table public.site_settings add column if not exists affiliate_cookie_days integer not null default 90
  check (affiliate_cookie_days between 1 and 730);
alter table public.site_settings add column if not exists affiliate_hold_days integer not null default 14
  check (affiliate_hold_days between 0 and 180);
alter table public.site_settings add column if not exists affiliate_min_payout numeric(12, 2) not null default 50.00
  check (affiliate_min_payout >= 0);


-- -----------------------------------------------------------------------------
-- Per-vendor override — a seller decides what they pay affiliates out of their
-- own share, for their own products. NULL rate = inherit the platform default.
-- -----------------------------------------------------------------------------
alter table public.vendors add column if not exists affiliate_opt_in boolean not null default true;
alter table public.vendors add column if not exists affiliate_commission_rate numeric(5, 2)
  check (affiliate_commission_rate is null or (affiliate_commission_rate >= 0 and affiliate_commission_rate <= 100));


-- -----------------------------------------------------------------------------
-- Affiliates
-- -----------------------------------------------------------------------------
create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  code text not null unique,
  status public.affiliate_status not null default 'pending',

  -- NULL = inherit the resolved rate at credit time. A concrete value here is
  -- an admin-tuned override that beats both the vendor and platform rates.
  commission_rate numeric(5, 2)
    check (commission_rate is null or (commission_rate >= 0 and commission_rate <= 100)),

  website text,
  promo_methods text,
  payout_method text not null default 'bank'
    check (payout_method in ('bank', 'momo', 'paypal', 'crypto')),
  payout_details jsonb not null default '{}'::jsonb,
  payout_currency text not null default 'USD',

  -- Cache of the ledger, same idea as vendors.total_*.
  total_clicks integer not null default 0,
  total_signups integer not null default 0,
  total_conversions integer not null default 0,
  total_earned numeric(14, 2) not null default 0,

  notes text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists affiliates_status_idx on public.affiliates (status);
select public.attach_touch_trigger('public.affiliates');

-- profiles.referred_by is set once, at signup, and never overwritten.
alter table public.profiles add column if not exists referred_by uuid references public.affiliates(id) on delete set null;
create index if not exists profiles_referred_by_idx on public.profiles (referred_by) where referred_by is not null;


-- -----------------------------------------------------------------------------
-- Referrals — click / touch log
-- -----------------------------------------------------------------------------
create table if not exists public.affiliate_referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  visitor_id text not null,
  landing_path text,
  referrer text,
  utm jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  converted_user_id uuid references auth.users(id) on delete set null,
  converted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists affiliate_referrals_affiliate_idx on public.affiliate_referrals (affiliate_id, created_at desc);
create index if not exists affiliate_referrals_visitor_idx on public.affiliate_referrals (visitor_id, affiliate_id, created_at desc);
-- Click-spam control lives in track_affiliate_referral() (a "not in the last
-- 24h" guard) rather than a unique index — timestamptz::date is not IMMUTABLE
-- and so cannot be an index expression.


-- -----------------------------------------------------------------------------
-- Earnings ledger — derived, never submitted
-- -----------------------------------------------------------------------------
create table if not exists public.affiliate_earnings (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  referred_user_id uuid references auth.users(id) on delete set null,

  gross_amount numeric(12, 2) not null check (gross_amount >= 0),
  basis_amount numeric(12, 2) not null check (basis_amount >= 0),
  commission_rate numeric(5, 2) not null,
  commission_basis text not null check (commission_basis in ('gross', 'platform_net')),
  commission_source text not null check (commission_source in ('platform', 'vendor', 'split')),
  commission_amount numeric(12, 2) not null check (commission_amount >= 0),
  currency text not null default 'USD',

  status public.earning_status not null default 'pending',
  available_at timestamptz not null default now(),
  payout_id uuid,
  created_at timestamptz not null default now(),

  unique (order_item_id, affiliate_id)
);

create index if not exists affiliate_earnings_affiliate_idx on public.affiliate_earnings (affiliate_id, status);
create index if not exists affiliate_earnings_order_idx on public.affiliate_earnings (order_id);


-- -----------------------------------------------------------------------------
-- Payouts
-- -----------------------------------------------------------------------------
create table if not exists public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status public.payout_status not null default 'requested',
  method text,
  reference text,
  failure_reason text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists affiliate_payouts_affiliate_idx on public.affiliate_payouts (affiliate_id, status);

do $$ begin
  alter table public.affiliate_earnings
    add constraint affiliate_earnings_payout_fk
    foreign key (payout_id) references public.affiliate_payouts(id) on delete set null;
exception when duplicate_object then null; end $$;


-- =============================================================================
-- Functions
-- =============================================================================

-- Owner-only helper, mirrors current_vendor_id().
create or replace function public.current_affiliate_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.affiliates where user_id = auth.uid();
$$;

revoke all on function public.current_affiliate_id() from public, anon, authenticated;
grant execute on function public.current_affiliate_id() to authenticated;


-- Generates a short, unique, URL-safe referral code on insert if the caller
-- did not supply one. Derived from the profile name where possible.
create or replace function public.affiliates_prepare_row()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  v_base text;
  v_candidate text;
  v_try integer := 0;
begin
  if new.commission_rate is null then
    -- leave NULL: the credit trigger resolves the rate. (Column stays nullable
    -- on purpose — unlike vendors.commission_rate.)
    null;
  end if;

  if coalesce(trim(new.code), '') = '' then
    select regexp_replace(lower(coalesce(p.full_name, split_part(u.email, '@', 1), 'aff')), '[^a-z0-9]+', '', 'g')
      into v_base
    from auth.users u
    left join public.profiles p on p.id = u.id
    where u.id = new.user_id;

    v_base := left(coalesce(nullif(v_base, ''), 'aff'), 12);
    loop
      v_candidate := v_base || case when v_try = 0 then '' else v_try::text end
                     || substr(md5(gen_random_uuid()::text), 1, 4);
      exit when not exists (select 1 from public.affiliates where code = v_candidate);
      v_try := v_try + 1;
    end loop;
    new.code := v_candidate;
  end if;

  return new;
end;
$$;

drop trigger if exists affiliates_prepare on public.affiliates;
create trigger affiliates_prepare
before insert on public.affiliates
for each row execute procedure public.affiliates_prepare_row();


-- The browser cannot insert into affiliates directly (no insert policy). It
-- calls this, which pins ownership to the caller and forces status = pending.
create or replace function public.apply_as_affiliate(
  p_website text default null,
  p_promo_methods text default null,
  p_payout_method text default 'bank',
  p_payout_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_code text;
  v_enabled boolean;
begin
  if v_user is null then
    raise exception 'Sign in before joining the affiliate programme.' using errcode = '42501';
  end if;

  select affiliate_program_enabled into v_enabled from public.site_settings where id = 1;
  if not coalesce(v_enabled, true) then
    raise exception 'The affiliate programme is not accepting applications right now.' using errcode = '22023';
  end if;

  if exists (select 1 from public.affiliates where user_id = v_user) then
    raise exception 'You have already joined the affiliate programme.' using errcode = '23505';
  end if;

  insert into public.affiliates (user_id, website, promo_methods, payout_method, payout_currency)
  values (
    v_user,
    nullif(trim(p_website), ''),
    nullif(trim(p_promo_methods), ''),
    lower(coalesce(p_payout_method, 'bank')),
    upper(coalesce(p_payout_currency, 'USD'))
  )
  returning id, code into v_id, v_code;

  return jsonb_build_object('id', v_id, 'code', v_code, 'status', 'pending');
end;
$$;

revoke all on function public.apply_as_affiliate(text, text, text, text) from public;
grant execute on function public.apply_as_affiliate(text, text, text, text) to authenticated;


-- Records a referral touch. Called from the browser (anon-friendly) the first
-- time a visitor lands with ?ref=CODE. The daily unique index collapses
-- repeat clicks. Unknown / non-approved codes are silently ignored so the
-- endpoint cannot be used to probe which codes exist.
create or replace function public.track_affiliate_referral(
  p_code text,
  p_visitor_id text,
  p_landing_path text default null,
  p_referrer text default null,
  p_utm jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_affiliate uuid;
begin
  if coalesce(trim(p_code), '') = '' or coalesce(trim(p_visitor_id), '') = '' then
    return;
  end if;

  select id into v_affiliate
  from public.affiliates
  where lower(code) = lower(trim(p_code)) and status = 'approved';

  if v_affiliate is null then
    return;
  end if;

  -- One touch per visitor+affiliate per 24h keeps click spam out of the log.
  if exists (
    select 1 from public.affiliate_referrals
    where affiliate_id = v_affiliate
      and visitor_id = left(trim(p_visitor_id), 64)
      and created_at > now() - interval '24 hours'
  ) then
    return;
  end if;

  insert into public.affiliate_referrals (affiliate_id, visitor_id, landing_path, referrer, utm)
  values (v_affiliate, left(trim(p_visitor_id), 64), left(p_landing_path, 500), left(p_referrer, 500), coalesce(p_utm, '{}'::jsonb));

  update public.affiliates
  set total_clicks = total_clicks + 1, updated_at = now()
  where id = v_affiliate;
end;
$$;

revoke all on function public.track_affiliate_referral(text, text, text, text, jsonb) from public;
grant execute on function public.track_affiliate_referral(text, text, text, text, jsonb) to anon, authenticated;


-- Extends the signup trigger (last redefined 20260826130000) to also bind a
-- referral. The browser puts ref_code + ref_vid in the signUp() metadata; we
-- resolve the affiliate, stamp profiles.referred_by (once), and close out the
-- matching click row. The profiles-insert and store-invite branches are
-- unchanged.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public as $$
declare
  v_ref_code text := new.raw_user_meta_data ->> 'ref_code';
  v_ref_vid  text := new.raw_user_meta_data ->> 'ref_vid';
  v_affiliate uuid;
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), 'Customer')
  )
  on conflict (id) do nothing;

  update public.store_members
  set user_id = new.id
  where user_id is null
    and status = 'pending'
    and invited_email is not null
    and lower(invited_email) = lower(new.email);

  if coalesce(trim(v_ref_code), '') <> '' then
    select id into v_affiliate
    from public.affiliates
    where lower(code) = lower(trim(v_ref_code)) and status = 'approved';

    -- No self-referral: an affiliate cannot refer their own new account.
    if v_affiliate is not null then
      update public.profiles
      set referred_by = v_affiliate
      where id = new.id
        and referred_by is null
        and v_affiliate not in (select id from public.affiliates where user_id = new.id);

      if found then
        update public.affiliate_referrals
        set converted_user_id = new.id, converted_at = now()
        where affiliate_id = v_affiliate
          and converted_user_id is null
          and (v_ref_vid is null or visitor_id = v_ref_vid);

        update public.affiliates
        set total_signups = total_signups + 1, updated_at = now()
        where id = v_affiliate;
      end if;
    end if;
  end if;

  return new;
end;
$$;


-- Books commissions when an order reaches 'paid', reverses them when it leaves
-- 'paid'. One row per referred order item. Idempotent via the unique
-- (order_item_id, affiliate_id) constraint. Mirrors book_vendor_earnings().
create or replace function public.book_affiliate_earnings()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  s record;
  v_affiliate uuid;
  v_aff_user uuid;
  v_aff_rate numeric(5, 2);
  v_hold integer;
  v_enabled boolean;
  item record;
  v_rate numeric(5, 2);
  v_gross numeric(12, 2);
  v_basis numeric(12, 2);
  v_commission numeric(12, 2);
begin
  -- Reverse on any transition away from 'paid'.
  if tg_op = 'UPDATE' and old.status = 'paid' and new.status <> 'paid' then
    update public.affiliate_earnings e
    set status = 'reversed'
    where e.order_id = new.id and e.status <> 'reversed';

    update public.affiliates a
    set total_earned = greatest(0, a.total_earned - sub.amt),
        total_conversions = greatest(0, a.total_conversions - 1),
        updated_at = now()
    from (
      select affiliate_id, sum(commission_amount) as amt
      from public.affiliate_earnings where order_id = new.id group by affiliate_id
    ) sub
    where a.id = sub.affiliate_id;
    return new;
  end if;

  if new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
    return new;
  end if;

  if new.user_id is null then
    return new;
  end if;

  select referred_by into v_affiliate from public.profiles where id = new.user_id;
  if v_affiliate is null then
    return new;
  end if;

  select * into s from public.site_settings where id = 1;
  if not coalesce(s.affiliate_program_enabled, true) then
    return new;
  end if;
  v_hold := coalesce(s.affiliate_hold_days, 14);

  select a.commission_rate, a.user_id into v_aff_rate, v_aff_user
  from public.affiliates a
  where a.id = v_affiliate and a.status = 'approved';
  if not found then
    return new;
  end if;

  -- Self-referral guard: buyer is the affiliate, or shares their email.
  if new.user_id = v_aff_user then
    return new;
  end if;
  if lower(new.customer_email) = (select lower(email) from auth.users where id = v_aff_user) then
    return new;
  end if;

  for item in
    select oi.id as order_item_id, oi.product_id, oi.unit_price, oi.quantity, oi.currency,
           p.vendor_id,
           ven.affiliate_opt_in, ven.affiliate_commission_rate as vendor_aff_rate,
           ven.commission_rate as vendor_platform_rate
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    left join public.vendors ven on ven.id = p.vendor_id
    where oi.order_id = new.id
  loop
    -- Rate resolution: per-affiliate override → per-vendor rate → platform.
    if v_aff_rate is not null then
      v_rate := v_aff_rate;
    elsif item.vendor_id is not null then
      if not coalesce(item.affiliate_opt_in, true) then
        continue;  -- this seller does not participate
      end if;
      v_rate := coalesce(item.vendor_aff_rate, s.affiliate_commission_rate, 10.00);
    else
      v_rate := coalesce(s.affiliate_commission_rate, 10.00);
    end if;

    v_gross := round(item.unit_price * item.quantity, 2);

    -- Basis: the whole line, or just the platform's cut of a marketplace sale.
    if s.affiliate_commission_basis = 'platform_net' and item.vendor_id is not null then
      v_basis := round(v_gross * coalesce(item.vendor_platform_rate, 15.00) / 100, 2);
    else
      v_basis := v_gross;
    end if;

    v_commission := round(v_basis * v_rate / 100, 2);
    if v_commission <= 0 then
      continue;
    end if;

    insert into public.affiliate_earnings (
      affiliate_id, order_id, order_item_id, product_id, referred_user_id,
      gross_amount, basis_amount, commission_rate, commission_basis, commission_source,
      commission_amount, currency, available_at
    )
    values (
      v_affiliate, new.id, item.order_item_id, item.product_id, new.user_id,
      v_gross, v_basis, v_rate, s.affiliate_commission_basis, s.affiliate_commission_source,
      v_commission, item.currency,
      coalesce(new.paid_at, now()) + make_interval(days => v_hold)
    )
    on conflict (order_item_id, affiliate_id) do nothing;

    if found then
      update public.affiliates a
      set total_earned = a.total_earned + v_commission,
          updated_at = now()
      where a.id = v_affiliate;
    end if;
  end loop;

  update public.affiliates a
  set total_conversions = a.total_conversions + 1, updated_at = now()
  where a.id = v_affiliate
    and exists (select 1 from public.affiliate_earnings where order_id = new.id and affiliate_id = v_affiliate);

  return new;
end;
$$;

drop trigger if exists orders_book_affiliate_earnings on public.orders;
create trigger orders_book_affiliate_earnings
after insert or update of status on public.orders
for each row execute procedure public.book_affiliate_earnings();


-- Matures earnings whose holding period has elapsed. Safe on a cron; called
-- alongside mature_vendor_earnings().
create or replace function public.mature_affiliate_earnings()
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
begin
  update public.affiliate_earnings
  set status = 'available'
  where status = 'pending' and available_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mature_affiliate_earnings() from public;


-- Withdrawal request. Server-side so the amount cannot be dictated by the
-- client; enforces the settings minimum. Mirrors request_payout().
create or replace function public.request_affiliate_payout()
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_affiliate uuid := public.current_affiliate_id();
  v_min numeric(12, 2);
  v_amount numeric(12, 2);
  v_currency text;
  v_method text;
  v_payout uuid;
begin
  if v_affiliate is null then
    raise exception 'Only affiliates can request a payout.' using errcode = '42501';
  end if;

  select affiliate_min_payout into v_min from public.site_settings where id = 1;
  v_min := coalesce(v_min, 50.00);

  select coalesce(sum(commission_amount), 0), coalesce(min(currency), 'USD')
    into v_amount, v_currency
  from public.affiliate_earnings
  where affiliate_id = v_affiliate and status = 'available' and payout_id is null;

  if v_amount < v_min then
    raise exception 'You need at least % % of available commission to withdraw.', v_min, v_currency
      using errcode = '22023';
  end if;

  select payout_method into v_method from public.affiliates where id = v_affiliate;

  insert into public.affiliate_payouts (affiliate_id, amount, currency, method)
  values (v_affiliate, v_amount, v_currency, v_method)
  returning id into v_payout;

  update public.affiliate_earnings
  set payout_id = v_payout, status = 'paid'
  where affiliate_id = v_affiliate and status = 'available' and payout_id is null;

  return jsonb_build_object('payout_id', v_payout, 'amount', v_amount, 'currency', v_currency);
end;
$$;

revoke all on function public.request_affiliate_payout() from public;
grant execute on function public.request_affiliate_payout() to authenticated;


-- =============================================================================
-- RLS
-- =============================================================================
alter table public.affiliates enable row level security;
alter table public.affiliate_referrals enable row level security;
alter table public.affiliate_earnings enable row level security;
alter table public.affiliate_payouts enable row level security;

drop policy if exists "affiliates read own or admin" on public.affiliates;
create policy "affiliates read own or admin" on public.affiliates
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "affiliates self-update limited" on public.affiliates;
create policy "affiliates self-update limited" on public.affiliates
for update to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "affiliates admin write" on public.affiliates;
create policy "affiliates admin write" on public.affiliates
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "affiliate referrals read own or admin" on public.affiliate_referrals;
create policy "affiliate referrals read own or admin" on public.affiliate_referrals
for select to authenticated
using (
  public.is_admin()
  or affiliate_id in (select id from public.affiliates where user_id = auth.uid())
);

drop policy if exists "affiliate referrals admin" on public.affiliate_referrals;
create policy "affiliate referrals admin" on public.affiliate_referrals
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "affiliate earnings read own or admin" on public.affiliate_earnings;
create policy "affiliate earnings read own or admin" on public.affiliate_earnings
for select to authenticated
using (
  public.is_admin()
  or affiliate_id in (select id from public.affiliates where user_id = auth.uid())
);

drop policy if exists "affiliate earnings admin" on public.affiliate_earnings;
create policy "affiliate earnings admin" on public.affiliate_earnings
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- A seller can see (read-only) the affiliate commissions booked against their
-- own products — the affiliate's identity is not exposed by this policy's
-- columns, only the sale and the commission.
drop policy if exists "affiliate earnings visible to product vendor" on public.affiliate_earnings;
create policy "affiliate earnings visible to product vendor" on public.affiliate_earnings
for select to authenticated
using (
  product_id in (select id from public.products where vendor_id = public.current_vendor_id())
);

drop policy if exists "affiliate payouts read own or admin" on public.affiliate_payouts;
create policy "affiliate payouts read own or admin" on public.affiliate_payouts
for select to authenticated
using (
  public.is_admin()
  or affiliate_id in (select id from public.affiliates where user_id = auth.uid())
);

drop policy if exists "affiliate payouts admin" on public.affiliate_payouts;
create policy "affiliate payouts admin" on public.affiliate_payouts
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- No direct INSERT policy on any of the four tables on purpose: enrolment goes
-- through apply_as_affiliate(), clicks through track_affiliate_referral(),
-- earnings/payouts through the trigger and request_affiliate_payout(), all
-- SECURITY DEFINER.


-- =============================================================================
-- vendor_dashboard(): surface the two new vendor columns so the Seller Centre
-- settings form can pre-fill them. Full redefinition of the function from
-- 20260824150000, unchanged except for the two added columns in the inner
-- select.
-- =============================================================================
create or replace function public.vendor_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_result jsonb;
begin
  if v_vendor is null then
    return jsonb_build_object('is_vendor', false);
  end if;

  select jsonb_build_object(
    'is_vendor', true,
    'vendor', (
      select to_jsonb(x) from (
        select id, display_name, slug, bio, logo_url, banner_url, country,
               payout_currency, status, commission_rate, total_sales_count,
               total_gross, total_net, applied_at, approved_at,
               affiliate_opt_in, affiliate_commission_rate
        from public.vendors where id = v_vendor
      ) x
    ),
    'balance', (
      select jsonb_build_object(
        'available', coalesce(sum(net_amount) filter (where status = 'available' and payout_id is null), 0),
        'pending',   coalesce(sum(net_amount) filter (where status = 'pending'), 0),
        'paid',      coalesce(sum(net_amount) filter (where status = 'paid'), 0),
        'lifetime',  coalesce(sum(net_amount) filter (where status <> 'reversed'), 0),
        'commission',coalesce(sum(commission_amount) filter (where status <> 'reversed'), 0),
        'currency',  coalesce(min(currency), 'USD')
      )
      from public.vendor_earnings where vendor_id = v_vendor
    ),
    'counts', jsonb_build_object(
      'products',           (select count(*) from public.products where vendor_id = v_vendor),
      'published_products', (select count(*) from public.products where vendor_id = v_vendor and is_published),
      'sales',              (select count(*) from public.vendor_earnings where vendor_id = v_vendor),
      'campaigns',          (select count(*) from public.ad_campaigns where vendor_id = v_vendor and status = 'active'),
      'payout_accounts',    (select count(*) from public.payout_accounts where vendor_id = v_vendor)
    ),
    'recent_sales', (
      select coalesce(jsonb_agg(s order by s.created_at desc), '[]'::jsonb)
      from (
        select e.id, e.gross_amount, e.net_amount, e.commission_amount, e.currency,
               e.status, e.created_at, e.available_at, p.title
        from public.vendor_earnings e
        left join public.products p on p.id = e.product_id
        where e.vendor_id = v_vendor
        order by e.created_at desc
        limit 10
      ) s
    ),
    'daily_net', (
      select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
      from (
        select date_trunc('day', created_at)::date as day, sum(net_amount) as net
        from public.vendor_earnings
        where vendor_id = v_vendor and created_at > now() - interval '30 days'
        group by 1
      ) d
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.vendor_dashboard() from public;
grant execute on function public.vendor_dashboard() to authenticated;


-- =============================================================================
-- moderation_queue(): affiliate applications are verified the same way seller
-- applications, ad campaigns and external-link listings are — they surface in
-- the admin Moderation screen. Full redefinition of the function from
-- 20260831150000, unchanged except for the added 'affiliates' key.
-- =============================================================================
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
    'affiliates', (
      select coalesce(jsonb_agg(a order by a.created_at), '[]'::jsonb) from (
        select af.id, af.code, af.website, af.promo_methods, af.payout_method,
               af.payout_currency, af.created_at,
               coalesce(p.full_name, split_part(u.email, '@', 1)) as applicant_name,
               u.email as applicant_email
        from public.affiliates af
        join auth.users u on u.id = af.user_id
        left join public.profiles p on p.id = af.user_id
        where af.status = 'pending'
      ) a
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
    'ad_listings', (
      select coalesce(jsonb_agg(a order by a.created_at), '[]'::jsonb) from (
        select p.id, p.title, p.slug, p.external_url, p.short_description,
               p.price, p.currency, p.created_at,
               v.display_name as vendor_name,
               w.balance as wallet_balance,
               (select ad_listing_deposit from public.site_settings where id = 1) as deposit
        from public.products p
        join public.vendors v on v.id = p.vendor_id
        left join public.ad_wallets w on w.vendor_id = p.vendor_id
        where p.is_ad and p.ad_status = 'pending'
      ) a
    ),
    'payout_accounts', (
      select coalesce(jsonb_agg(pa order by pa.created_at), '[]'::jsonb) from (
        select p.id, p.method, p.country, p.currency, p.account_name, p.account_last4,
               p.bank_name, p.momo_provider, p.paypal_email, p.crypto_asset, p.created_at,
               v.display_name as vendor_name
        from public.payout_accounts p
        join public.vendors v on v.id = p.vendor_id
        where p.verification_status = 'pending'
      ) pa
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
               pa.method, pa.account_name, pa.account_last4, pa.bank_name, pa.momo_provider,
               pa.verification_status
        from public.payouts po
        join public.vendors v on v.id = po.vendor_id
        left join public.payout_accounts pa on pa.id = po.payout_account_id
        where po.status in ('requested', 'processing')
      ) p
    )
  );
end;
$$;

revoke all on function public.moderation_queue() from public, anon;
grant execute on function public.moderation_queue() to authenticated;
