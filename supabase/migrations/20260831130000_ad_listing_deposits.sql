-- =============================================================================
-- External-link (ad) listing deposits + admin moderation
--
-- Publishing an is_ad listing (see 20260827160000) now goes through the same
-- admin moderation gate as campaigns and vendor applications, and puts a
-- REFUNDABLE HOLD on the seller's ad wallet:
--
--   * A listing is created `ad_status='pending'` and cannot be published until
--     an admin approves it — enforced by a trigger, not just the client.
--   * On approval a flat hold — site_settings.ad_listing_deposit — is debited
--     from the ad wallet and recorded in ad_wallet_transactions. A seller with
--     no ad wallet (a platform / admin-owned listing) is not charged.
--   * A clean takedown (by the seller, or by an admin without p_forfeit)
--     returns the hold. An admin takedown WITH p_forfeit keeps it — the
--     penalty for a misleading / scam / policy-violating listing.
--
-- The hold is separate from campaign CPM/CPC/CPA spend and from
-- ad_min_wallet_balance (the balance a seller must already hold to create an
-- external-link listing at all).
-- =============================================================================

-- --- Setting ---------------------------------------------------------------
alter table public.site_settings
  add column if not exists ad_listing_deposit numeric(12, 2) not null default 50.00
  check (ad_listing_deposit >= 0);

comment on column public.site_settings.ad_listing_deposit is
  'Refundable ad-wallet hold taken when an external-link listing is approved; returned on a clean takedown, forfeited on a policy rejection.';

-- --- Per-listing bookkeeping ---------------------------------------------
alter table public.products
  add column if not exists ad_deposit_held numeric(12, 2) not null default 0
  check (ad_deposit_held >= 0);

comment on column public.products.ad_deposit_held is
  'Ad-wallet hold currently tied up by this listing; 0 when none is held.';

-- ad_wallet_transactions gains a product link so a listing hold/refund is
-- traceable the same way a campaign charge already is via campaign_id.
alter table public.ad_wallet_transactions
  add column if not exists product_id uuid references public.products(id) on delete set null;


-- --- Publish gate -------------------------------------------------------
-- An unapproved ad listing can never be live, whatever the client sends.
create or replace function public.enforce_ad_listing_gate()
returns trigger
language plpgsql
set search_path = public as $$
begin
  if coalesce(new.is_ad, false) and new.ad_status is distinct from 'active' then
    new.is_published := false;
  end if;
  return new;
end;
$$;

drop trigger if exists products_ad_listing_gate on public.products;
create trigger products_ad_listing_gate
before insert or update on public.products
for each row execute procedure public.enforce_ad_listing_gate();


-- --- Approve / reject a pending listing --------------------------------
create or replace function public.moderate_ad_listing(
  p_product_id uuid,
  p_approve boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  pr public.products;
  v_deposit numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_balance numeric(12, 2);
  v_currency text;
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  select * into pr from public.products where id = p_product_id for update;
  if pr.id is null then
    raise exception 'That listing does not exist.' using errcode = '22023';
  end if;
  if not pr.is_ad then
    raise exception 'That listing is not an external-link listing.' using errcode = '22023';
  end if;
  if pr.ad_status <> 'pending' then
    raise exception 'That listing is not awaiting review.' using errcode = '22023';
  end if;

  if not p_approve then
    update public.products
    set ad_status = 'rejected', is_published = false, updated_at = now()
    where id = pr.id;
    return jsonb_build_object('id', pr.id, 'ad_status', 'rejected');
  end if;

  select balance, currency into v_balance, v_currency
  from public.ad_wallets where vendor_id = pr.vendor_id for update;

  if pr.ad_deposit_held > 0 then
    -- Re-approval of an edited listing: the hold is already in place.
    v_deposit := pr.ad_deposit_held;
  elsif v_balance is not null then
    select coalesce(ad_listing_deposit, 0) into v_deposit
    from public.site_settings where id = 1;

    if v_deposit > 0 then
      if v_balance < v_deposit then
        raise exception 'Seller ad wallet holds % but the listing deposit is %. Ask them to top up before approval.',
          to_char(v_balance, 'FM999990.00'), to_char(v_deposit, 'FM999990.00')
          using errcode = '22023';
      end if;

      v_new_balance := v_balance - v_deposit;

      update public.ad_wallets
      set balance = v_new_balance, updated_at = now()
      where vendor_id = pr.vendor_id;

      insert into public.ad_wallet_transactions
        (vendor_id, type, amount, balance_after, currency, product_id, description, created_by)
      values
        (pr.vendor_id, 'charge', -v_deposit, v_new_balance, coalesce(v_currency, 'USD'),
         pr.id, format('Listing deposit held — "%s"', pr.title), auth.uid());
    end if;
  else
    -- Platform / admin-owned listing with no ad wallet: nothing to hold.
    v_deposit := 0;
  end if;

  update public.products
  set ad_status = 'active',
      is_published = true,
      ad_deposit_held = coalesce(v_deposit, 0),
      updated_at = now()
  where id = pr.id;

  return jsonb_build_object('id', pr.id, 'ad_status', 'active', 'deposit_held', coalesce(v_deposit, 0));
end;
$$;

revoke all on function public.moderate_ad_listing(uuid, boolean, text) from public;
grant execute on function public.moderate_ad_listing(uuid, boolean, text) to authenticated;


-- --- Take a live listing down ----------------------------------------
-- Callable by the listing's own vendor (hold always returned) or an admin
-- (who may pass p_forfeit => keep the hold as a policy penalty).
create or replace function public.remove_ad_listing(
  p_product_id uuid,
  p_forfeit boolean default false,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  pr public.products;
  v_admin boolean := public.is_admin();
  v_held numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_balance numeric(12, 2);
  v_currency text;
  v_forfeit boolean;
begin
  select * into pr from public.products where id = p_product_id for update;
  if pr.id is null then
    raise exception 'That listing does not exist.' using errcode = '22023';
  end if;
  if not pr.is_ad then
    raise exception 'That listing is not an external-link listing.' using errcode = '22023';
  end if;
  if not (v_admin or pr.vendor_id = public.current_vendor_id()) then
    raise exception 'You cannot remove that listing.' using errcode = '42501';
  end if;

  v_forfeit := v_admin and coalesce(p_forfeit, false);
  v_held := pr.ad_deposit_held;

  if v_held > 0 then
    select balance, currency into v_balance, v_currency
    from public.ad_wallets where vendor_id = pr.vendor_id for update;

    if v_balance is not null and not v_forfeit then
      v_new_balance := v_balance + v_held;
      update public.ad_wallets
      set balance = v_new_balance, updated_at = now()
      where vendor_id = pr.vendor_id;

      insert into public.ad_wallet_transactions
        (vendor_id, type, amount, balance_after, currency, product_id, description, created_by)
      values
        (pr.vendor_id, 'refund', v_held, v_new_balance, coalesce(v_currency, 'USD'),
         pr.id, format('Listing deposit returned — "%s"', pr.title), auth.uid());
    elsif v_balance is not null and v_forfeit then
      insert into public.ad_wallet_transactions
        (vendor_id, type, amount, balance_after, currency, product_id, description, created_by)
      values
        (pr.vendor_id, 'adjustment', 0, v_balance, coalesce(v_currency, 'USD'),
         pr.id, coalesce(p_note, format('Listing deposit forfeited — "%s"', pr.title)), auth.uid());
    end if;
  end if;

  update public.products
  set ad_status = 'rejected',
      is_published = false,
      ad_deposit_held = 0,
      updated_at = now()
  where id = pr.id;

  return jsonb_build_object(
    'id', pr.id,
    'ad_status', 'rejected',
    'deposit_returned', case when v_held > 0 and not v_forfeit then v_held else 0 end,
    'deposit_forfeited', case when v_held > 0 and v_forfeit then v_held else 0 end
  );
end;
$$;

revoke all on function public.remove_ad_listing(uuid, boolean, text) from public;
grant execute on function public.remove_ad_listing(uuid, boolean, text) to authenticated;


-- --- Moderation queue: add the pending ad-listing bucket -------------
-- Body identical to 20260825100000_ad_wallet_and_billing.sql plus the
-- 'ad_listings' key.
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
