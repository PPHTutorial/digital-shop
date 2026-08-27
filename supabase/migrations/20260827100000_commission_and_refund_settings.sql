-- =============================================================================
-- Admin-editable commissions, ad rate card, and refund rate.
--
-- Three numbers used to live only as hardcoded literals: the 15% vendor
-- commission (a column default on `vendors`, applied once at signup), the
-- ad placement rate card (a VALUES list inside a trigger function), and
-- there was no refund percentage anywhere at all. All three now live in the
-- database and are editable from the admin Settings screen without a code
-- change or a new migration.
-- =============================================================================

alter table public.site_settings add column if not exists default_commission_rate numeric(5, 2) not null default 15.00
  check (default_commission_rate >= 0 and default_commission_rate <= 100);
alter table public.site_settings add column if not exists refund_rate_percent numeric(5, 2) not null default 30.00
  check (refund_rate_percent >= 0 and refund_rate_percent <= 100);

-- -----------------------------------------------------------------------------
-- Vendor commission — was a static column default (15.00); a new vendor row
-- now picks up whatever `site_settings.default_commission_rate` says at the
-- moment they apply, while an explicitly-set rate (e.g. a hand-tuned rate for
-- one vendor) is still respected.
-- -----------------------------------------------------------------------------
alter table public.vendors alter column commission_rate drop default;
alter table public.vendors alter column commission_rate drop not null;

create or replace function public.apply_default_commission_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.commission_rate is null then
    select coalesce(s.default_commission_rate, 15.00) into new.commission_rate
    from public.site_settings s where s.id = 1;
    new.commission_rate := coalesce(new.commission_rate, 15.00);
  end if;
  return new;
end;
$$;

drop trigger if exists vendors_default_commission on public.vendors;
create trigger vendors_default_commission
before insert on public.vendors
for each row execute procedure public.apply_default_commission_rate();

-- Backfill: nothing to do, existing rows already carry a concrete rate from
-- the old column default.

-- -----------------------------------------------------------------------------
-- Ad placement rate card — was a hardcoded VALUES list inside
-- apply_ad_rate_card() (see 20260825100000_ad_wallet_and_billing.sql). Moved
-- into a real table so admins can tune it; the trigger now reads from it.
-- -----------------------------------------------------------------------------
create table if not exists public.ad_rate_card (
  placement text primary key check (placement in ('featured', 'search', 'category')),
  cpm_rate numeric(10, 4) not null check (cpm_rate >= 0),
  cpc_rate numeric(10, 4) not null check (cpc_rate >= 0),
  cpa_percent numeric(5, 2) not null check (cpa_percent >= 0 and cpa_percent <= 100),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.ad_rate_card (placement, cpm_rate, cpc_rate, cpa_percent) values
  ('featured', 2.50, 0.35, 3.00),
  ('search',   1.50, 0.25, 2.00),
  ('category', 1.00, 0.18, 1.50)
on conflict (placement) do nothing;

alter table public.ad_rate_card enable row level security;

drop policy if exists "admins manage ad rate card" on public.ad_rate_card;
create policy "admins manage ad rate card"
on public.ad_rate_card
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "anyone can read ad rate card" on public.ad_rate_card;
create policy "anyone can read ad rate card"
on public.ad_rate_card
for select
to anon, authenticated
using (true);

create or replace function public.apply_ad_rate_card()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    select r.cpm_rate, r.cpc_rate, r.cpa_percent into new.cpm_rate, new.cpc_rate, new.cpa_percent
    from public.ad_rate_card r
    where r.placement = new.placement;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- The trigger already exists (created in 20260825100000); replacing the
-- function body is enough, no need to re-create the trigger itself.

grant select on public.ad_rate_card to anon, authenticated;
