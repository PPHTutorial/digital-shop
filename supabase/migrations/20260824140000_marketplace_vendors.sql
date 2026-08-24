-- =============================================================================
-- Multi-vendor marketplace
--
-- Turns the single-operator store into a marketplace where any signed-in user
-- can apply to sell. The design rules that matter:
--
--   * A product with vendor_id IS NULL is first-party (the store's own stock).
--     Every existing product stays first-party, so nothing changes for them.
--   * Money is never computed in the browser. Vendor earnings are derived by a
--     trigger from order_items at the moment an order is marked paid, using the
--     commission rate frozen onto the vendor at that time.
--   * Payout details are the most sensitive data here. They are readable only
--     by their owner and admins, and the account number is stored alongside a
--     display-safe last-four so the UI never needs to read the full value.
--   * A vendor only sells once status = 'approved'. Publishing is gated on it.
-- =============================================================================

-- =========================
-- Types
-- =========================
do $$ begin
  create type public.vendor_status as enum ('pending', 'approved', 'suspended', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payout_method as enum ('bank_transfer', 'mobile_money', 'paypal', 'crypto');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.earning_status as enum ('pending', 'available', 'paid', 'reversed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payout_status as enum ('requested', 'processing', 'paid', 'failed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.campaign_status as enum ('draft', 'active', 'paused', 'completed', 'rejected');
exception when duplicate_object then null; end $$;


-- =========================
-- Vendors
-- =========================
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  slug text unique not null,
  bio text,
  logo_url text,
  banner_url text,
  support_email citext,
  website_url text,

  -- Jurisdiction drives which payout methods are offered and which currency
  -- the vendor is settled in.
  country text not null default 'GH',
  payout_currency text not null default 'USD',

  status public.vendor_status not null default 'pending',
  -- Platform's cut, as a percentage of gross. Frozen onto each earning row so
  -- changing it later never rewrites historical payouts.
  commission_rate numeric(5, 2) not null default 15.00
    check (commission_rate >= 0 and commission_rate <= 100),

  -- Denormalised counters, maintained by trigger. Cheap dashboard reads.
  total_sales_count integer not null default 0,
  total_gross numeric(14, 2) not null default 0,
  total_net numeric(14, 2) not null default 0,

  rejection_reason text,
  applied_at timestamptz not null default now(),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_status_idx on public.vendors (status);
create index if not exists vendors_user_idx on public.vendors (user_id);

-- Products gain an owner. NULL keeps the existing first-party behaviour.
alter table public.products add column if not exists vendor_id uuid references public.vendors(id) on delete restrict;
create index if not exists products_vendor_idx on public.products (vendor_id);


-- =========================
-- Payout accounts
-- =========================
create table if not exists public.payout_accounts (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  method public.payout_method not null,
  country text not null,
  currency text not null default 'USD',

  account_name text not null,
  -- Full value, readable only by owner/admin under RLS. `account_last4` exists
  -- so lists and confirmations can be rendered without touching it.
  account_number text,
  account_last4 text,

  -- Bank transfer
  bank_name text,
  bank_code text,
  branch_code text,
  swift_code text,
  iban text,

  -- Mobile money (MTN / Vodafone / AirtelTigo / M-Pesa / Airtel ...)
  momo_provider text,
  momo_number text,

  -- PayPal / crypto
  paypal_email citext,
  crypto_asset text,
  crypto_address text,

  is_default boolean not null default false,
  is_verified boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Each method must carry the fields it is actually paid through.
  constraint payout_account_details_present check (
    case method
      when 'bank_transfer' then account_number is not null and bank_name is not null
      when 'mobile_money'  then momo_number is not null and momo_provider is not null
      when 'paypal'        then paypal_email is not null
      when 'crypto'        then crypto_address is not null and crypto_asset is not null
    end
  )
);

create index if not exists payout_accounts_vendor_idx on public.payout_accounts (vendor_id);

-- At most one default account per vendor.
create unique index if not exists payout_accounts_one_default
  on public.payout_accounts (vendor_id) where is_default;

-- Keeps the display-safe last four in step with whatever identifier applies.
create or replace function public.sync_payout_last4()
returns trigger
language plpgsql
set search_path = public as $$
declare
  v_source text;
begin
  v_source := coalesce(new.account_number, new.momo_number, new.crypto_address, new.paypal_email::text, '');
  new.account_last4 := nullif(right(regexp_replace(v_source, '\s', '', 'g'), 4), '');
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payout_accounts_last4 on public.payout_accounts;
create trigger payout_accounts_last4
before insert or update on public.payout_accounts
for each row execute procedure public.sync_payout_last4();


-- =========================
-- Earnings ledger
-- =========================
-- One row per sold line item belonging to a vendor. This is the source of
-- truth for what a vendor is owed; vendor totals are only a cache of it.
create table if not exists public.vendor_earnings (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,

  gross_amount numeric(12, 2) not null check (gross_amount >= 0),
  commission_rate numeric(5, 2) not null,
  commission_amount numeric(12, 2) not null check (commission_amount >= 0),
  net_amount numeric(12, 2) not null check (net_amount >= 0),
  currency text not null default 'USD',

  status public.earning_status not null default 'pending',
  -- Funds mature before they can be withdrawn, covering the refund window.
  available_at timestamptz not null default (now() + interval '14 days'),
  payout_id uuid,
  created_at timestamptz not null default now(),

  unique (order_item_id)
);

create index if not exists vendor_earnings_vendor_idx on public.vendor_earnings (vendor_id, status);
create index if not exists vendor_earnings_order_idx on public.vendor_earnings (order_id);


-- =========================
-- Payouts
-- =========================
create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  payout_account_id uuid references public.payout_accounts(id) on delete set null,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status public.payout_status not null default 'requested',
  reference text,
  failure_reason text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payouts_vendor_idx on public.payouts (vendor_id, status);

do $$ begin
  alter table public.vendor_earnings
    add constraint vendor_earnings_payout_fk
    foreign key (payout_id) references public.payouts(id) on delete set null;
exception when duplicate_object then null; end $$;


-- =========================
-- Ad campaigns (product boosting)
-- =========================
create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,

  -- 'featured' lifts the product onto the home rails, 'search' weights it in
  -- results, 'category' promotes it within its own category page.
  placement text not null default 'featured'
    check (placement in ('featured', 'search', 'category')),

  budget numeric(12, 2) not null check (budget > 0),
  spend numeric(12, 2) not null default 0 check (spend >= 0),
  bid_amount numeric(12, 2) not null default 0.10 check (bid_amount >= 0),
  currency text not null default 'USD',

  status public.campaign_status not null default 'draft',
  starts_at timestamptz not null default now(),
  ends_at timestamptz,

  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ad_campaign_window check (ends_at is null or ends_at > starts_at)
);

create index if not exists ad_campaigns_vendor_idx on public.ad_campaigns (vendor_id, status);
create index if not exists ad_campaigns_product_idx on public.ad_campaigns (product_id);

-- A campaign is live only while active, funded, and inside its window.
-- security_invoker so the view is filtered by the caller's RLS rather than the
-- view owner's — without it this would hand every vendor's campaigns to anyone.
create or replace view public.active_ad_campaigns
with (security_invoker = true) as
select c.*
from public.ad_campaigns c
where c.status = 'active'
  and c.spend < c.budget
  and c.starts_at <= now()
  and (c.ends_at is null or c.ends_at > now());


-- =========================
-- Helpers
-- =========================
-- SECURITY DEFINER so vendor-scoped policies never recurse through RLS.
create or replace function public.current_vendor_id()
returns uuid
language sql
stable
security definer
set search_path = public as $$
  select id from public.vendors where user_id = auth.uid();
$$;

revoke all on function public.current_vendor_id() from public;
grant execute on function public.current_vendor_id() to authenticated;

create or replace function public.is_approved_vendor()
returns boolean
language sql
stable
security definer
set search_path = public as $$
  select exists (
    select 1 from public.vendors
    where user_id = auth.uid() and status = 'approved'
  );
$$;

revoke all on function public.is_approved_vendor() from public;
grant execute on function public.is_approved_vendor() to authenticated;


-- =========================
-- Earnings are derived, never submitted
-- =========================
-- Fires when an order reaches 'paid' and books one earning row per vendor line
-- item. Idempotent: the unique constraint on order_item_id means replaying a
-- webhook cannot pay a vendor twice.
create or replace function public.book_vendor_earnings()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  v_rate numeric(5, 2);
  item record;
  v_gross numeric(12, 2);
  v_commission numeric(12, 2);
begin
  -- AFTER UPDATE guarantees OLD is present, so no coalesce is needed (and
  -- coalescing an order_status enum with '' would not type-check anyway).
  if new.status <> 'paid' or old.status = 'paid' then
    return new;
  end if;

  for item in
    select oi.id as order_item_id,
           oi.product_id,
           oi.unit_price,
           oi.quantity,
           oi.currency,
           p.vendor_id
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = new.id
      and p.vendor_id is not null
  loop
    select commission_rate into v_rate from public.vendors where id = item.vendor_id;
    v_rate := coalesce(v_rate, 15.00);

    v_gross := round(item.unit_price * item.quantity, 2);
    v_commission := round(v_gross * v_rate / 100, 2);

    insert into public.vendor_earnings (
      vendor_id, order_id, order_item_id, product_id,
      gross_amount, commission_rate, commission_amount, net_amount, currency
    )
    values (
      item.vendor_id, new.id, item.order_item_id, item.product_id,
      v_gross, v_rate, v_commission, greatest(0, v_gross - v_commission), item.currency
    )
    on conflict (order_item_id) do nothing;

    update public.vendors
    set total_sales_count = total_sales_count + item.quantity,
        total_gross = total_gross + v_gross,
        total_net = total_net + greatest(0, v_gross - v_commission),
        updated_at = now()
    where id = item.vendor_id;
  end loop;

  return new;
end;
$$;

drop trigger if exists orders_book_vendor_earnings on public.orders;
create trigger orders_book_vendor_earnings
after update of status on public.orders
for each row execute procedure public.book_vendor_earnings();


-- =========================
-- Vendor application
-- =========================
-- The browser cannot insert into vendors directly (no insert policy). It calls
-- this, which forces the safe defaults: pending status, platform commission,
-- and ownership pinned to the caller.
create or replace function public.apply_as_vendor(
  p_display_name text,
  p_country text default 'GH',
  p_bio text default null,
  p_payout_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_suffix integer := 0;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in before applying to sell.' using errcode = '42501';
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'A store name is required.' using errcode = '22023';
  end if;

  if exists (select 1 from public.vendors where user_id = v_user) then
    raise exception 'You have already applied to sell.' using errcode = '23505';
  end if;

  v_slug := regexp_replace(lower(trim(p_display_name)), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then v_slug := 'vendor'; end if;

  while exists (select 1 from public.vendors where slug = v_slug || case when v_suffix = 0 then '' else '-' || v_suffix end) loop
    v_suffix := v_suffix + 1;
  end loop;
  if v_suffix > 0 then v_slug := v_slug || '-' || v_suffix; end if;

  insert into public.vendors (user_id, display_name, slug, bio, country, payout_currency)
  values (v_user, trim(p_display_name), v_slug, p_bio, upper(coalesce(p_country, 'GH')), upper(coalesce(p_payout_currency, 'USD')))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'status', 'pending');
end;
$$;

revoke all on function public.apply_as_vendor(text, text, text, text) from public;
grant execute on function public.apply_as_vendor(text, text, text, text) to authenticated;


-- Requests a withdrawal of matured earnings. Server-side so the amount can
-- never be dictated by the client.
create or replace function public.request_payout(p_payout_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_currency text;
  v_amount numeric(12, 2);
  v_payout uuid;
begin
  if v_vendor is null then
    raise exception 'Only vendors can request a payout.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.payout_accounts
    where id = p_payout_account_id and vendor_id = v_vendor
  ) then
    raise exception 'That payout account does not belong to you.' using errcode = '42501';
  end if;

  select coalesce(sum(net_amount), 0), coalesce(min(currency), 'USD')
    into v_amount, v_currency
  from public.vendor_earnings
  where vendor_id = v_vendor
    and status = 'available'
    and payout_id is null;

  if v_amount <= 0 then
    raise exception 'You have no matured earnings to withdraw yet.' using errcode = '22023';
  end if;

  insert into public.payouts (vendor_id, payout_account_id, amount, currency)
  values (v_vendor, p_payout_account_id, v_amount, v_currency)
  returning id into v_payout;

  update public.vendor_earnings
  set payout_id = v_payout
  where vendor_id = v_vendor and status = 'available' and payout_id is null;

  return jsonb_build_object('payout_id', v_payout, 'amount', v_amount, 'currency', v_currency);
end;
$$;

revoke all on function public.request_payout(uuid) from public;
grant execute on function public.request_payout(uuid) to authenticated;


-- Matures earnings whose holding period has elapsed. Safe to run on a cron.
create or replace function public.mature_vendor_earnings()
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
begin
  update public.vendor_earnings
  set status = 'available'
  where status = 'pending' and available_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mature_vendor_earnings() from public;


-- =========================
-- RLS
-- =========================
alter table public.vendors enable row level security;
alter table public.payout_accounts enable row level security;
alter table public.vendor_earnings enable row level security;
alter table public.payouts enable row level security;
alter table public.ad_campaigns enable row level security;

-- Vendors: approved storefronts are public; owners and admins see the rest.
drop policy if exists "approved vendors are public" on public.vendors;
create policy "approved vendors are public"
on public.vendors
for select
using (status = 'approved' or user_id = auth.uid() or public.is_admin());

-- No insert policy on purpose — applications go through apply_as_vendor().
drop policy if exists "vendors update own profile" on public.vendors;
create policy "vendors update own profile"
on public.vendors
for update
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "admins manage vendors" on public.vendors;
create policy "admins manage vendors"
on public.vendors
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Payout accounts: strictly owner or admin. Never public, at any status.
drop policy if exists "owners manage payout accounts" on public.payout_accounts;
create policy "owners manage payout accounts"
on public.payout_accounts
for all
to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin())
with check (vendor_id = public.current_vendor_id() or public.is_admin());

-- Earnings are read-only to the vendor; only the trigger writes them.
drop policy if exists "vendors read own earnings" on public.vendor_earnings;
create policy "vendors read own earnings"
on public.vendor_earnings
for select
to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "admins manage earnings" on public.vendor_earnings;
create policy "admins manage earnings"
on public.vendor_earnings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Payouts are read-only to the vendor; created via request_payout().
drop policy if exists "vendors read own payouts" on public.payouts;
create policy "vendors read own payouts"
on public.payouts
for select
to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "admins manage payouts" on public.payouts;
create policy "admins manage payouts"
on public.payouts
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Ad campaigns: vendors manage their own, but only for products they own.
drop policy if exists "vendors read own campaigns" on public.ad_campaigns;
create policy "vendors read own campaigns"
on public.ad_campaigns
for select
to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "vendors write own campaigns" on public.ad_campaigns;
create policy "vendors write own campaigns"
on public.ad_campaigns
for insert
to authenticated
with check (
  vendor_id = public.current_vendor_id()
  and public.is_approved_vendor()
  and exists (
    select 1 from public.products p
    where p.id = product_id and p.vendor_id = public.current_vendor_id()
  )
);

drop policy if exists "vendors update own campaigns" on public.ad_campaigns;
create policy "vendors update own campaigns"
on public.ad_campaigns
for update
to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin())
with check (vendor_id = public.current_vendor_id() or public.is_admin());

drop policy if exists "admins manage campaigns" on public.ad_campaigns;
create policy "admins manage campaigns"
on public.ad_campaigns
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());


-- =========================
-- Products: vendors manage their own
-- =========================
-- The existing "admins manage products" policy stays. This adds vendor access,
-- scoped so a vendor can only ever touch rows carrying their own vendor_id.
drop policy if exists "vendors insert own products" on public.products;
create policy "vendors insert own products"
on public.products
for insert
to authenticated
with check (vendor_id = public.current_vendor_id() and public.is_approved_vendor());

drop policy if exists "vendors update own products" on public.products;
create policy "vendors update own products"
on public.products
for update
to authenticated
using (vendor_id is not null and vendor_id = public.current_vendor_id())
with check (vendor_id is not null and vendor_id = public.current_vendor_id());

drop policy if exists "vendors delete own products" on public.products;
create policy "vendors delete own products"
on public.products
for delete
to authenticated
using (vendor_id is not null and vendor_id = public.current_vendor_id());
