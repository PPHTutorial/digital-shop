-- =============================================================================
-- Ad wallet funding — its own payment pipeline
--
-- Uses the same gateways as the shop but never touches `orders`. A product
-- purchase and a wallet top-up are different things: an order fulfils a
-- download and books vendor earnings, whereas funding only moves money into an
-- ad balance. Sharing the orders table would have meant an order with no
-- product, and every trigger hanging off `orders` (earnings, conversions,
-- download tokens) would have had to learn to ignore it. Separate table,
-- separate callbacks, no special cases in the purchase path.
--
-- Crediting is automatic and idempotent: the redirect and the webhook both
-- call credit_ad_funding(), and only the first one to arrive moves money.
-- =============================================================================

create table if not exists public.ad_funding_payments (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 25),
  currency text not null default 'USD',
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'cancelled')),
  provider text not null check (provider in ('flutterwave', 'nowpayments')),
  provider_reference text unique,
  provider_transaction_id text,
  credited_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ad_funding_vendor_idx on public.ad_funding_payments (vendor_id, created_at desc);
create index if not exists ad_funding_status_idx on public.ad_funding_payments (status);

comment on table public.ad_funding_payments is
  'Ad wallet top-ups. Deliberately separate from public.orders: funding fulfils no product and must not trip order triggers.';


-- The minimum is enforced here as well as in the constraint so the caller gets
-- a sentence rather than a constraint violation.
create or replace function public.create_ad_funding(
  p_amount numeric,
  p_provider text default 'flutterwave',
  p_currency text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_currency text;
  v_id uuid;
  v_reference text;
  v_min constant numeric := 25;
begin
  if v_vendor is null then
    raise exception 'Only sellers can fund an ad wallet.' using errcode = '42501';
  end if;

  if not public.is_approved_vendor() then
    raise exception 'Your seller account must be approved first.' using errcode = '42501';
  end if;

  if p_amount is null or p_amount < v_min then
    raise exception 'The minimum top-up is %.', to_char(v_min, 'FM999990.00') using errcode = '22023';
  end if;

  if p_provider not in ('flutterwave', 'nowpayments') then
    raise exception 'Unknown payment provider.' using errcode = '22023';
  end if;

  select coalesce(p_currency, payout_currency, 'USD') into v_currency
  from public.vendors where id = v_vendor;

  -- Wallet exists from the moment funding is attempted.
  insert into public.ad_wallets (vendor_id, currency)
  values (v_vendor, upper(v_currency))
  on conflict (vendor_id) do nothing;

  insert into public.ad_funding_payments (vendor_id, amount, currency, provider)
  values (v_vendor, round(p_amount, 2), upper(v_currency), p_provider)
  returning id into v_id;

  -- Prefixed so it is unmistakable in gateway dashboards and can never be
  -- confused with a product order reference (which uses BOOK-).
  v_reference := 'ADFUND-' || replace(v_id::text, '-', '') || '-' || extract(epoch from now())::bigint;

  update public.ad_funding_payments
  set provider_reference = v_reference, updated_at = now()
  where id = v_id;

  return jsonb_build_object(
    'id', v_id,
    'reference', v_reference,
    'amount', round(p_amount, 2),
    'currency', upper(v_currency)
  );
end;
$$;

revoke all on function public.create_ad_funding(numeric, text, text) from public;
grant execute on function public.create_ad_funding(numeric, text, text) to authenticated;


-- Settles a funding payment and credits the wallet. Called only by the funding
-- callbacks running with the service role — never from a browser, because it
-- moves money on the strength of its arguments alone.
--
-- Idempotent by design: the redirect and the webhook race each other, and a
-- gateway may retry. Only the transition out of 'pending' credits.
create or replace function public.credit_ad_funding(
  p_reference text,
  p_provider_transaction_id text default null,
  p_succeeded boolean default true,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  f public.ad_funding_payments;
  v_new_balance numeric(12, 2);
begin
  select * into f
  from public.ad_funding_payments
  where provider_reference = p_reference
  for update;

  if f.id is null then
    return jsonb_build_object('credited', false, 'reason', 'unknown_reference');
  end if;

  if f.status = 'paid' then
    return jsonb_build_object('credited', false, 'reason', 'already_credited', 'amount', f.amount);
  end if;

  if not p_succeeded then
    update public.ad_funding_payments
    set status = 'failed', failure_reason = p_failure_reason, updated_at = now()
    where id = f.id and status = 'pending';
    return jsonb_build_object('credited', false, 'reason', 'marked_failed');
  end if;

  update public.ad_funding_payments
  set status = 'paid',
      provider_transaction_id = p_provider_transaction_id,
      credited_at = now(),
      updated_at = now()
  where id = f.id;

  insert into public.ad_wallets (vendor_id, currency, balance, lifetime_topup)
  values (f.vendor_id, f.currency, f.amount, f.amount)
  on conflict (vendor_id) do update
    set balance = public.ad_wallets.balance + excluded.balance,
        lifetime_topup = public.ad_wallets.lifetime_topup + excluded.balance,
        updated_at = now()
  returning balance into v_new_balance;

  insert into public.ad_wallet_transactions
    (vendor_id, type, amount, balance_after, currency, description)
  values
    (f.vendor_id, 'topup', f.amount, v_new_balance, f.currency,
     format('Wallet funding via %s', f.provider));

  -- Funding often follows a campaign pausing for an empty wallet; bring those
  -- back automatically so the seller does not have to hunt for them.
  update public.ad_campaigns
  set status = 'active', updated_at = now()
  where vendor_id = f.vendor_id
    and status = 'paused'
    and review_status = 'approved'
    and spend < budget;

  return jsonb_build_object('credited', true, 'amount', f.amount, 'balance', v_new_balance);
end;
$$;

revoke all on function public.credit_ad_funding(text, text, boolean, text) from public;
grant execute on function public.credit_ad_funding(text, text, boolean, text) to service_role;


-- =========================
-- RLS
-- =========================
alter table public.ad_funding_payments enable row level security;

drop policy if exists "vendors read own funding" on public.ad_funding_payments;
create policy "vendors read own funding"
on public.ad_funding_payments for select to authenticated
using (vendor_id = public.current_vendor_id() or public.is_admin());

-- No insert/update policy: rows are created by create_ad_funding() and settled
-- by credit_ad_funding(). A browser can read its own funding history, nothing more.
drop policy if exists "admins manage funding" on public.ad_funding_payments;
create policy "admins manage funding"
on public.ad_funding_payments for all to authenticated
using (public.is_admin()) with check (public.is_admin());
