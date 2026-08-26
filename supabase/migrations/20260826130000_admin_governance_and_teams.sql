-- =============================================================================
-- Admin governance, account lifecycle, store teams, notifications
--
-- Four additive features on top of the existing marketplace schema. Nothing
-- here removes or renames an existing column, type, or RPC — every legacy
-- caller (`is_admin()`, `role = 'admin'`, `current_vendor_id()`, `vendor.status`
-- reads in js/admin.js and js/vendor.js) keeps working unchanged.
--
-- -----------------------------------------------------------------------------
-- 1. Account status (profiles.account_status, independent from vendor status)
-- -----------------------------------------------------------------------------
-- `profiles.account_status` is the account-level switch (customer, vendor
-- owner, or admin — every signed-in person has exactly one profiles row).
-- `vendors.status` already carries 'suspended' as part of `public.vendor_status`
-- (pending/approved/suspended/rejected) from 20260824140000, so the STORE-level
-- switch already existed; nothing new was added to `vendors` for this. The two
-- are deliberately independent: a vendor's personal account can be blocked
-- while their store stays approved (e.g. handed to a co-owner), or a store can
-- be suspended for a policy violation while the owner's personal account (and
-- ability to shop as a customer) stays active.
--
-- Enforcement is server-side. RLS cannot stop `auth.users` sign-in, so the
-- frontend is expected to read `profiles.account_status` on session load and
-- force a sign-out with a message — but that is UX only. The real gate is here:
-- every money-moving / write RPC a non-admin user can call now starts with
-- `perform public.assert_account_active();`, which raises if the caller's own
-- profile is not 'active'. A blocked/suspended/terminated user therefore can't
-- place an order, apply to sell, request a payout, fund an ad wallet, top up,
-- or touch store_members, even if they bypass the client-side gate entirely.
--
-- -----------------------------------------------------------------------------
-- 2. Multi-tier admin roles + permission matrix
-- -----------------------------------------------------------------------------
-- `profiles.role` (public.app_role: customer/admin) is untouched — every
-- existing `is_admin()` / `role = 'admin'` check keeps meaning exactly what it
-- did. `profiles.admin_tier` is a new, nullable column that only means
-- something when `role = 'admin'`:
--
--   super_admin  everything, including managing other admins' tier/status
--   admin        day-to-day operations: users, moderation, notifications, settings
--   moderator    moderation queue + notifications only
--   support      notifications only (read access to admin screens is still
--                gated solely by is_admin(), unaffected by tier)
--
-- Permission matrix (checked by public.admin_has_permission(text)):
--
--   permission          | super_admin | admin | moderator | support
--   ---------------------+-------------+-------+-----------+--------
--   manage_admins        |     yes     |  no   |    no     |   no
--   manage_users         |     yes     |  yes  |    no     |   no
--   moderate_content     |     yes     |  yes  |   yes     |   no
--   send_notifications   |     yes     |  yes  |   yes     |  yes
--   manage_settings      |     yes     |  yes  |    no     |   no
--
-- `manage_admins` is deliberately super_admin-only: it is the only permission
-- that can change someone's `role`/`admin_tier`. Because
-- `admin_update_admin_tier()`/`admin_revoke_admin()` require that exact
-- permission, and only a super_admin ever holds it, no admin tier can ever
-- grant itself or anyone else a tier equal to or higher than caller-only-if-
-- super_admin — i.e. privilege escalation through this path is structurally
-- impossible, not just checked-for. Any pre-existing `role = 'admin'` profile
-- with no tier set is backfilled to 'super_admin' below (it already held full
-- admin power before this migration; treating it as anything less would be a
-- silent capability downgrade).
--
-- `admin_set_account_status()` / `admin_set_vendor_status()` additionally
-- require `super_admin` specifically (not just `manage_users`) whenever the
-- TARGET is itself an admin — a lower admin tier can hold `manage_users` (to
-- block/suspend ordinary customers and vendors) without ever being able to
-- touch another admin's status. See the explicit `role = 'admin'` guard inside
-- each function.
--
-- -----------------------------------------------------------------------------
-- 3. Vendor store team members (store_members)
-- -----------------------------------------------------------------------------
-- DECISION (read this before wiring the UI): `public.current_vendor_id()` is
-- left completely unchanged — it still returns only the store where
-- `vendors.user_id = auth.uid()`, i.e. the ORIGINAL owner. It is referenced by
-- a large number of existing RLS policies (products, payout_accounts,
-- vendor_earnings, payouts, ad_campaigns, ad_wallets, ad_wallet_transactions,
-- ad_topup_requests, ad_funding_payments, storage) and changing its return
-- shape would have meant touching every one of those policies in this single
-- migration — too wide a blast radius for what was asked here.
--
-- Instead, a NEW helper `public.current_vendor_ids()` (plural, returns
-- SETOF uuid) is added, covering the owner's store PLUS every store where the
-- caller has an active `store_members` row (any role). It is used only by the
-- new `store_members` RLS policy in this migration. Every pre-existing
-- vendor-scoped table (products, earnings, payouts, campaigns, wallet, ...)
-- still scopes strictly to the primary owner via `current_vendor_id()` and is
-- UNCHANGED — staff members do not yet gain access to those tables. Extending
-- those policies to `current_vendor_ids()` is a deliberate follow-up, not done
-- here, so the UI task should treat "staff can manage products/earnings/etc."
-- as NOT YET WIRED, even though the store_members table + invite flow exists.
-- `vendors.user_id` keeps its original meaning (the primary/original owner)
-- and can never be reassigned by anything in this migration.
--
-- UNRESOLVED-BY-SQL-ALONE: inviting someone who has never signed up. A SQL
-- migration cannot create an auth.users row (no service-role key available to
-- plain SQL/RLS/RPC code) and there is no existing Edge Function in
-- supabase/functions/ for admin-driven user creation. The invite RPC
-- (`store_member_invite`) therefore stores the invite against `invited_email`
-- with `user_id` left NULL when no matching auth.users row exists yet. To
-- close the loop without an Edge Function, `handle_new_user()` (the trigger
-- that already fires on every new auth.users signup) is extended here to
-- backfill `store_members.user_id` for any pending invite matching the new
-- user's email. The invite still requires an explicit
-- `store_member_accept_invite()` call from the now-registered user before it
-- becomes 'active'. This works, but only because signup already runs through
-- SQL-visible `auth.users` — if the project ever wants to invite someone by
-- email who should be able to accept WITHOUT first discovering the site and
-- signing up on their own (e.g. a "click this emailed link to create your
-- account" flow), that still needs an Edge Function to send the email and/or
-- pre-provision the account. For now, UI should treat "invite an unregistered
-- email" as "queued silently until they sign up with that exact address" —
-- there is no notification/email sent by this migration.
--
-- -----------------------------------------------------------------------------
-- 4. Admin-sendable notifications
-- -----------------------------------------------------------------------------
-- `notifications` (one row per broadcast/targeted message) + `notification_reads`
-- (per-user read state, small and simple: a (notification_id, user_id) primary
-- key with a read_at timestamp) so the UI can show an unread badge/count.
--
-- -----------------------------------------------------------------------------
-- Security checklist (verified explicitly, see the inline comment at each item)
-- -----------------------------------------------------------------------------
--   [x] No policy/RPC lets a user change their own role/admin_tier/account_status
--       — every write to those columns lives in a SECURITY DEFINER function
--       that checks the CALLER's own tier/status against the CALLER's row,
--       never the target row, before writing the TARGET row. Self-service
--       profile update policies ("users update own profile") predate this
--       migration and only ever touched non-privileged columns; not changed.
--   [x] Every new privileged RPC is `security definer`, `set search_path = public`,
--       `revoke all ... from public`, then an explicit `grant execute ... to
--       authenticated` (never `anon`) — matching 20260824100000's pattern. Per
--       20260825120000's finding, `revoke all from public` alone is NOT enough
--       on Supabase (new functions are auto-granted to anon/authenticated by
--       default privileges), so every function below is followed by its own
--       `revoke all on function ... from public, anon, authenticated` and then
--       the narrow `grant ... to authenticated`.
--   [x] Blocked/suspended/terminated accounts are rejected by every other
--       still-open privileged path: create_order(), apply_as_vendor(),
--       request_payout(), request_ad_topup(), create_ad_funding(), and the new
--       store_member_* / admin_send_notification RPCs all call
--       assert_account_active() first. record_ad_event()/credit_ad_funding()
--       are intentionally left alone (anon/service_role paths, not "as the
--       calling user"). mature_vendor_earnings()/settle_ad_topup()/
--       moderate_vendor()/moderate_campaign()/moderation_queue() are unchanged
--       admin-only paths gated by is_admin(); admin actions on a target account
--       are exactly what admin_set_account_status()/admin_set_vendor_status()
--       exist to police, not something the acting admin does "as" the target.
--   [x] Staff/support store_members rows cannot add/remove/promote members —
--       store_member_invite/update_role/remove all require the caller to be
--       the store's original owner (vendors.user_id), an admin, or hold an
--       active 'owner'/'manager' store_members row, and granting 'owner' or
--       'manager' additionally requires 'owner'-tier (or admin/original owner).
--   [x] Only super_admin can touch another admin's tier/status — see the
--       explicit checks inside admin_update_admin_tier, admin_revoke_admin,
--       admin_set_account_status, and admin_set_vendor_status.
-- =============================================================================


-- =========================
-- profiles: account status + admin tier
-- =========================
alter table public.profiles add column if not exists account_status text not null default 'active'
  check (account_status in ('active', 'blocked', 'suspended', 'terminated'));
alter table public.profiles add column if not exists account_status_reason text;
alter table public.profiles add column if not exists account_status_at timestamptz;
alter table public.profiles add column if not exists account_status_by uuid references auth.users(id) on delete set null;

alter table public.profiles add column if not exists admin_tier text
  check (admin_tier in ('super_admin', 'admin', 'moderator', 'support'));

create index if not exists profiles_account_status_idx on public.profiles (account_status);
create index if not exists profiles_admin_tier_idx on public.profiles (admin_tier) where admin_tier is not null;

-- Backward-compat backfill: any admin created before this migration held full
-- admin power by virtue of role = 'admin' alone. Treat as super_admin so
-- nothing that used to work silently narrows.
update public.profiles
set admin_tier = 'super_admin'
where role = 'admin'::public.app_role and admin_tier is null;


-- =========================
-- Helpers
-- =========================

-- Raises if the CALLING user's own account is not active. Used at the top of
-- every privileged RPC a non-admin can reach, so a blocked/suspended/
-- terminated account cannot keep writing through some RPC the client-side
-- gate failed to catch. A caller with no profiles row (should not happen —
-- handle_new_user backfills one on signup) is treated as active rather than
-- locking out an edge case this migration cannot reproduce.
create or replace function public.assert_account_active()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select account_status into v_status from public.profiles where id = auth.uid();
  if v_status is not null and v_status <> 'active' then
    raise exception 'Your account is %. Contact support for help.', v_status using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_account_active() from public, anon, authenticated;
grant execute on function public.assert_account_active() to authenticated;

-- Tier -> permission matrix. See the header comment for the full table.
create or replace function public.admin_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case coalesce(p.admin_tier, '')
    when 'super_admin' then true
    when 'admin'       then p_permission in ('manage_users', 'moderate_content', 'send_notifications', 'manage_settings')
    when 'moderator'   then p_permission in ('moderate_content', 'send_notifications')
    when 'support'     then p_permission in ('send_notifications')
    else false
  end
  from public.profiles p
  where p.id = auth.uid()
    and p.role = 'admin'::public.app_role;
$$;

revoke all on function public.admin_has_permission(text) from public, anon, authenticated;
grant execute on function public.admin_has_permission(text) to authenticated;


-- =========================
-- Account status RPCs
-- =========================

-- Blocks/suspends/terminates/reactivates a PERSONAL account. Requires
-- manage_users; additionally requires super_admin when the target is itself
-- an admin, so no admin tier below super_admin can ever touch another admin.
create or replace function public.admin_set_account_status(
  p_user_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_role public.app_role;
begin
  if not public.admin_has_permission('manage_users') then
    raise exception 'You do not have permission to manage account status.' using errcode = '42501';
  end if;

  if p_status not in ('active', 'blocked', 'suspended', 'terminated') then
    raise exception 'Unknown account status.' using errcode = '22023';
  end if;

  select role into v_target_role from public.profiles where id = p_user_id;
  if v_target_role is null then
    raise exception 'That account does not exist.' using errcode = '22023';
  end if;

  -- Privilege-escalation guard: a non-super_admin holding manage_users can
  -- moderate ordinary customers/vendors but must never be able to lock out
  -- (or reactivate) another admin.
  if v_target_role = 'admin'::public.app_role and not public.admin_has_permission('manage_admins') then
    raise exception 'Only a super_admin can change another admin''s account status.' using errcode = '42501';
  end if;

  update public.profiles
  set account_status = p_status,
      account_status_reason = p_reason,
      account_status_at = now(),
      account_status_by = auth.uid()
  where id = p_user_id;

  perform public.record_audit(
    'account.status_changed', 'profile', p_user_id::text,
    format('Account status set to %s', p_status),
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );

  return jsonb_build_object('id', p_user_id, 'account_status', p_status);
end;
$$;

revoke all on function public.admin_set_account_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_account_status(uuid, text, text) to authenticated;


-- Suspends/reactivates an already-approved STORE, independent of the vendor
-- application approve/reject flow (moderate_vendor(), unchanged, still owns
-- pending/rejected). This is an additional lever for a store that already
-- passed application review; it deliberately refuses 'pending'/'rejected'
-- so the two flows can never fight over the same transition.
create or replace function public.admin_set_vendor_status(
  p_vendor_id uuid,
  p_status public.vendor_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.vendor_status;
  v_owner_role public.app_role;
begin
  if not public.admin_has_permission('manage_users') then
    raise exception 'You do not have permission to manage store status.' using errcode = '42501';
  end if;

  if p_status not in ('approved', 'suspended') then
    raise exception 'Use moderate_vendor() for pending applications; this action only suspends or reinstates an approved store.' using errcode = '22023';
  end if;

  select status into v_current from public.vendors where id = p_vendor_id;
  if v_current is null then
    raise exception 'That store does not exist.' using errcode = '22023';
  end if;
  if v_current = 'pending'::public.vendor_status then
    raise exception 'That store has not been approved yet; use the moderation queue.' using errcode = '22023';
  end if;

  select p.role into v_owner_role
  from public.vendors v
  join public.profiles p on p.id = v.user_id
  where v.id = p_vendor_id;

  if v_owner_role = 'admin'::public.app_role and not public.admin_has_permission('manage_admins') then
    raise exception 'Only a super_admin can suspend a store owned by another admin.' using errcode = '42501';
  end if;

  update public.vendors
  set status = p_status,
      rejection_reason = case when p_status = 'suspended' then p_reason else null end,
      updated_at = now()
  where id = p_vendor_id;

  if p_status = 'suspended' then
    update public.products set is_published = false where vendor_id = p_vendor_id;
    update public.ad_campaigns set status = 'paused' where vendor_id = p_vendor_id and status = 'active';
  end if;

  perform public.record_audit(
    'vendor.status_changed', 'vendor', p_vendor_id::text,
    format('Store status set to %s', p_status),
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );

  return jsonb_build_object('id', p_vendor_id, 'status', p_status);
end;
$$;

revoke all on function public.admin_set_vendor_status(uuid, public.vendor_status, text) from public, anon, authenticated;
grant execute on function public.admin_set_vendor_status(uuid, public.vendor_status, text) to authenticated;


-- =========================
-- Admin management RPCs (super_admin only, enforced via manage_admins)
-- =========================

-- Promotes an EXISTING profiles row (i.e. someone who already signed up) to
-- admin at the given tier, or changes an existing admin's tier. This doubles
-- as "create an admin" per the header's design decision (a): Supabase auth
-- users cannot be created from plain SQL, so onboarding is sign-up-then-
-- promote, mirroring how apply_as_vendor() only ever operates on an
-- already-authenticated caller.
create or replace function public.admin_update_admin_tier(p_user_id uuid, p_tier text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- manage_admins is held only by super_admin (see the permission matrix), so
  -- this single check is also the complete privilege-escalation guard: nobody
  -- who isn't already a super_admin can reach any line below.
  if not public.admin_has_permission('manage_admins') then
    raise exception 'Only a super_admin can manage admin accounts.' using errcode = '42501';
  end if;

  if p_tier not in ('super_admin', 'admin', 'moderator', 'support') then
    raise exception 'Unknown admin tier.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'That user has not signed up yet; they must create an account before being promoted.' using errcode = '22023';
  end if;

  update public.profiles
  set role = 'admin'::public.app_role,
      admin_tier = p_tier,
      updated_at = now()
  where id = p_user_id;

  perform public.record_audit(
    'admin.tier_set', 'profile', p_user_id::text,
    format('Admin tier set to %s', p_tier)
  );

  return jsonb_build_object('id', p_user_id, 'role', 'admin', 'admin_tier', p_tier);
end;
$$;

revoke all on function public.admin_update_admin_tier(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_update_admin_tier(uuid, text) to authenticated;


-- Demotes an admin back to an ordinary customer. Refuses to remove the last
-- remaining super_admin so the platform can never lock itself out of
-- admin-management entirely.
create or replace function public.admin_revoke_admin(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_tier text;
  v_super_admin_count integer;
begin
  if not public.admin_has_permission('manage_admins') then
    raise exception 'Only a super_admin can manage admin accounts.' using errcode = '42501';
  end if;

  select admin_tier into v_target_tier from public.profiles where id = p_user_id and role = 'admin'::public.app_role;
  if v_target_tier is null then
    raise exception 'That user is not an admin.' using errcode = '22023';
  end if;

  if v_target_tier = 'super_admin' then
    select count(*) into v_super_admin_count
    from public.profiles
    where role = 'admin'::public.app_role and admin_tier = 'super_admin';

    if v_super_admin_count <= 1 then
      raise exception 'Cannot remove the last super_admin.' using errcode = '22023';
    end if;
  end if;

  update public.profiles
  set role = 'customer'::public.app_role,
      admin_tier = null,
      updated_at = now()
  where id = p_user_id;

  perform public.record_audit('admin.revoked', 'profile', p_user_id::text, 'Admin access revoked');

  return jsonb_build_object('id', p_user_id, 'role', 'customer');
end;
$$;

revoke all on function public.admin_revoke_admin(uuid) from public, anon, authenticated;
grant execute on function public.admin_revoke_admin(uuid) to authenticated;

-- No new "list admins" RPC: `profiles` is already selectable by admins via the
-- existing "users read own profile" policy (`auth.uid() = id or is_admin()`),
-- so the frontend should simply select
-- `id, full_name, role, admin_tier, account_status, account_status_reason` from
-- `profiles where role = 'admin'`.


-- =========================
-- Guard existing money-moving / write RPCs with assert_account_active()
--
-- Full CREATE OR REPLACE redefinitions, matching the project's established
-- pattern (see 20260824120000_fix_quote_promo_fallthrough.sql) for landing a
-- behavioural change on an existing function from a later migration. Only one
-- line changes in each: an assert_account_active() call added right after the
-- existing "must be signed in" / "must be a vendor" check. Everything else is
-- byte-for-byte the function body from its defining migration.
-- =========================

create or replace function public.create_order(
  p_items jsonb,
  p_promo_code text default null,
  p_billing jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_name text;
  v_currency text := 'USD';
  v_subtotal numeric(12, 2) := 0;
  v_discount numeric(12, 2) := 0;
  v_order_id uuid;
  v_primary uuid;
  v_promo public.promo_codes;
  item jsonb;
  v_product public.products;
  v_qty integer;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Sign in before creating an order.' using errcode = '42501';
  end if;

  perform public.assert_account_active();

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one product is required.' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 20 then
    raise exception 'An order may contain at most 20 line items.' using errcode = '22023';
  end if;

  select email into v_email from auth.users where id = v_user;
  select full_name into v_name from public.profiles where id = v_user;

  insert into public.orders (user_id, product_id, customer_email, customer_name, amount, currency, status, billing)
  values (v_user, null, coalesce(v_email, 'unknown@invalid'), v_name, 0, v_currency, 'pending', coalesce(p_billing, '{}'::jsonb))
  returning id into v_order_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := greatest(1, least(20, coalesce((item ->> 'quantity')::int, 1)));

    select * into v_product
    from public.products
    where id = (item ->> 'product_id')::uuid and is_published = true;

    if v_product.id is null then
      raise exception 'Product % is not available for purchase.', item ->> 'product_id' using errcode = '22023';
    end if;

    if v_subtotal = 0 then
      v_currency := v_product.currency;
      v_primary := v_product.id;
    elsif v_product.currency <> v_currency then
      raise exception 'All items in an order must share one currency.' using errcode = '22023';
    end if;

    insert into public.order_items (order_id, product_id, title_snapshot, unit_price, quantity, currency)
    values (v_order_id, v_product.id, v_product.title, v_product.price, v_qty, v_product.currency)
    on conflict (order_id, product_id) do update set quantity = public.order_items.quantity + excluded.quantity;

    v_subtotal := v_subtotal + (v_product.price * v_qty);
  end loop;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo
    from public.promo_codes pc
    where pc.code = trim(p_promo_code)
      and pc.is_active
      and pc.starts_at <= now()
      and (pc.ends_at is null or pc.ends_at > now())
      and (pc.max_redemptions is null or pc.redemption_count < pc.max_redemptions);

    if v_promo.id is not null then
      v_discount := least(
        v_subtotal,
        case when v_promo.discount_type = 'percent'
          then round(v_subtotal * v_promo.discount_value / 100, 2)
          else v_promo.discount_value
        end
      );
    end if;
  end if;

  update public.orders o
  set product_id = v_primary,
      subtotal = v_subtotal,
      discount_amount = v_discount,
      amount = greatest(0, v_subtotal - v_discount),
      currency = v_currency,
      promo_code = case when v_discount > 0 then v_promo.code::text else null end,
      quantity = (select coalesce(sum(oi.quantity), 1) from public.order_items oi where oi.order_id = v_order_id)
  where o.id = v_order_id;

  select jsonb_build_object(
    'id', o.id,
    'order_no', o.order_no,
    'amount', o.amount,
    'currency', o.currency,
    'discount_amount', o.discount_amount,
    'subtotal', o.subtotal,
    'promo_code', o.promo_code,
    'status', o.status,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id,
        'title', oi.title_snapshot,
        'unit_price', oi.unit_price,
        'quantity', oi.quantity
      ) order by oi.created_at), '[]'::jsonb)
      from public.order_items oi where oi.order_id = o.id
    )
  )
  into v_result
  from public.orders o
  where o.id = v_order_id;

  perform public.record_audit('order.created', 'order', v_order_id::text,
    format('Order %s created for %s', v_result ->> 'order_no', v_email));

  return v_result;
end;
$$;

revoke all on function public.create_order(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_order(jsonb, text, jsonb) to authenticated;


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

  perform public.assert_account_active();

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

  -- The applicant is always their store's first owner-role team member.
  insert into public.store_members (vendor_id, user_id, role, invited_by, status, accepted_at)
  values (v_id, v_user, 'owner', v_user, 'active', now())
  on conflict do nothing;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'status', 'pending');
end;
$$;

revoke all on function public.apply_as_vendor(text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_as_vendor(text, text, text, text) to authenticated;


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

  perform public.assert_account_active();

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

revoke all on function public.request_payout(uuid) from public, anon, authenticated;
grant execute on function public.request_payout(uuid) to authenticated;


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

  perform public.assert_account_active();

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

revoke all on function public.request_ad_topup(numeric, text) from public, anon, authenticated;
grant execute on function public.request_ad_topup(numeric, text) to authenticated;


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

  perform public.assert_account_active();

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

  insert into public.ad_wallets (vendor_id, currency)
  values (v_vendor, upper(v_currency))
  on conflict (vendor_id) do nothing;

  insert into public.ad_funding_payments (vendor_id, amount, currency, provider)
  values (v_vendor, round(p_amount, 2), upper(v_currency), p_provider)
  returning id into v_id;

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

revoke all on function public.create_ad_funding(numeric, text, text) from public, anon, authenticated;
grant execute on function public.create_ad_funding(numeric, text, text) to authenticated;


-- =========================
-- Store team members
-- =========================
create table if not exists public.store_members (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  -- Nullable: an invite sent to an email with no matching auth.users row yet
  -- is stored with user_id = null and gets linked by handle_new_user() the
  -- moment that email signs up. See the header comment, section 3.
  user_id uuid references auth.users(id) on delete cascade,
  invited_email citext,
  role text not null default 'staff' check (role in ('owner', 'manager', 'staff', 'support')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'active', 'removed')),
  constraint store_members_identity check (user_id is not null or invited_email is not null)
);

-- A person can only have one row per store once resolved to a real user.
create unique index if not exists store_members_vendor_user_uidx
  on public.store_members (vendor_id, user_id) where user_id is not null;

-- ...and only one outstanding pending invite per (store, email) before then.
create unique index if not exists store_members_vendor_invite_email_uidx
  on public.store_members (vendor_id, invited_email) where user_id is null and status = 'pending';

create index if not exists store_members_user_idx on public.store_members (user_id) where user_id is not null;
create index if not exists store_members_vendor_idx on public.store_members (vendor_id, status);

-- store_members has no updated_at column by design (invited_at/accepted_at
-- already timestamp the lifecycle), so it does not need attach_touch_trigger.

-- Backfill: every existing vendor's original owner becomes an active 'owner'
-- row, so the new table starts in sync with the vendors table it augments.
insert into public.store_members (vendor_id, user_id, role, invited_by, status, accepted_at)
select v.id, v.user_id, 'owner', v.user_id, 'active', v.approved_at
from public.vendors v
where not exists (
  select 1 from public.store_members sm where sm.vendor_id = v.id and sm.user_id = v.user_id
);

-- Extends the existing signup trigger (20260822000000) to also claim any
-- pending store invite addressed to the new user's email. Full redefinition,
-- matching the project's established pattern for evolving a trigger function
-- from a later migration; the profiles-insert branch is unchanged.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      split_part(new.email, '@', 1),
      'Customer'
    )
  )
  on conflict (id) do nothing;

  -- Claim any pending store_members invite sent to this email before they
  -- signed up. Still requires store_member_accept_invite() to go 'active'.
  update public.store_members
  set user_id = new.id
  where user_id is null
    and status = 'pending'
    and invited_email is not null
    and lower(invited_email) = lower(new.email);

  return new;
end;
$$;

-- current_vendor_id() (singular, owner-only) is unchanged on purpose — see the
-- header's "DECISION" note. This is the new plural helper, used only by the
-- store_members RLS policy below.
create or replace function public.current_vendor_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.vendors where user_id = auth.uid()
  union
  select vendor_id from public.store_members where user_id = auth.uid() and status = 'active';
$$;

revoke all on function public.current_vendor_ids() from public, anon, authenticated;
grant execute on function public.current_vendor_ids() to authenticated;


-- Invites a user (by email) onto a store's team. If no auth.users row matches
-- the email yet, the invite is stored against invited_email and resolved
-- automatically at signup (see handle_new_user() above).
create or replace function public.store_member_invite(
  p_vendor_id uuid,
  p_email text,
  p_role text default 'staff'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner boolean;
  v_caller_role text;
  v_target uuid;
  v_id uuid;
begin
  perform public.assert_account_active();

  if coalesce(trim(p_email), '') = '' then
    raise exception 'An email address is required.' using errcode = '22023';
  end if;

  if p_role not in ('owner', 'manager', 'staff', 'support') then
    raise exception 'Unknown store role.' using errcode = '22023';
  end if;

  v_is_owner := exists (select 1 from public.vendors where id = p_vendor_id and user_id = auth.uid());

  select role into v_caller_role
  from public.store_members
  where vendor_id = p_vendor_id and user_id = auth.uid() and status = 'active';

  if not (public.is_admin() or v_is_owner or v_caller_role in ('owner', 'manager')) then
    raise exception 'You do not have permission to invite store members.' using errcode = '42501';
  end if;

  -- Only owner-tier (the original owner, an 'owner' row, or an admin) may
  -- grant owner/manager access; a manager may only bring on staff/support.
  if p_role in ('owner', 'manager') and not (public.is_admin() or v_is_owner or v_caller_role = 'owner') then
    raise exception 'Only a store owner can grant owner or manager access.' using errcode = '42501';
  end if;

  select id into v_target from auth.users where lower(email) = lower(trim(p_email));

  if v_target is not null and exists (
    select 1 from public.store_members where vendor_id = p_vendor_id and user_id = v_target
  ) then
    raise exception 'That person is already part of this store.' using errcode = '23505';
  end if;

  insert into public.store_members (vendor_id, user_id, invited_email, role, invited_by, status)
  values (p_vendor_id, v_target, lower(trim(p_email)), p_role, auth.uid(), 'pending')
  returning id into v_id;

  perform public.record_audit(
    'store_member.invited', 'store_members', v_id::text,
    format('Invited %s as %s', p_email, p_role)
  );

  return jsonb_build_object('id', v_id, 'status', 'pending', 'linked_existing_user', v_target is not null);
end;
$$;

revoke all on function public.store_member_invite(uuid, text, text) from public, anon, authenticated;
grant execute on function public.store_member_invite(uuid, text, text) to authenticated;


-- The invited (now-registered) user accepts their own pending invite.
create or replace function public.store_member_accept_invite(p_vendor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_account_active();

  update public.store_members
  set status = 'active', accepted_at = now()
  where vendor_id = p_vendor_id and user_id = auth.uid() and status = 'pending'
  returning id into v_id;

  if v_id is null then
    raise exception 'No pending invite found for you at that store.' using errcode = '22023';
  end if;

  return jsonb_build_object('id', v_id, 'status', 'active');
end;
$$;

revoke all on function public.store_member_accept_invite(uuid) from public, anon, authenticated;
grant execute on function public.store_member_accept_invite(uuid) to authenticated;


-- Changes a team member's role. Same permission shape as invite: caller must
-- be owner-tier (original owner / active 'owner' row / admin) or an active
-- 'manager' acting only on staff/support rows. The row belonging to the
-- store's original owner (vendors.user_id) can never be changed here — it
-- stays 'owner' for as long as they remain the vendor's user_id.
create or replace function public.store_member_update_role(p_member_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.store_members;
  v_is_owner boolean;
  v_caller_role text;
begin
  perform public.assert_account_active();

  if p_role not in ('owner', 'manager', 'staff', 'support') then
    raise exception 'Unknown store role.' using errcode = '22023';
  end if;

  select * into m from public.store_members where id = p_member_id;
  if m.id is null then
    raise exception 'That store member does not exist.' using errcode = '22023';
  end if;

  if exists (select 1 from public.vendors where id = m.vendor_id and user_id = m.user_id) then
    raise exception 'The store''s original owner cannot be reassigned.' using errcode = '42501';
  end if;

  v_is_owner := exists (select 1 from public.vendors where id = m.vendor_id and user_id = auth.uid());
  select role into v_caller_role from public.store_members
  where vendor_id = m.vendor_id and user_id = auth.uid() and status = 'active';

  if not (public.is_admin() or v_is_owner or v_caller_role in ('owner', 'manager')) then
    raise exception 'You do not have permission to change store member roles.' using errcode = '42501';
  end if;

  if (p_role in ('owner', 'manager') or m.role in ('owner', 'manager'))
     and not (public.is_admin() or v_is_owner or v_caller_role = 'owner') then
    raise exception 'Only a store owner can change owner or manager access.' using errcode = '42501';
  end if;

  update public.store_members set role = p_role where id = p_member_id;

  perform public.record_audit('store_member.role_changed', 'store_members', p_member_id::text,
    format('Role set to %s', p_role));

  return jsonb_build_object('id', p_member_id, 'role', p_role);
end;
$$;

revoke all on function public.store_member_update_role(uuid, text) from public, anon, authenticated;
grant execute on function public.store_member_update_role(uuid, text) to authenticated;


-- Removes a team member. The store's original owner row can never be removed
-- while they remain vendors.user_id.
create or replace function public.store_member_remove(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.store_members;
  v_is_owner boolean;
  v_caller_role text;
begin
  perform public.assert_account_active();

  select * into m from public.store_members where id = p_member_id;
  if m.id is null then
    raise exception 'That store member does not exist.' using errcode = '22023';
  end if;

  if exists (select 1 from public.vendors where id = m.vendor_id and user_id = m.user_id) then
    raise exception 'The store''s original owner cannot be removed.' using errcode = '42501';
  end if;

  v_is_owner := exists (select 1 from public.vendors where id = m.vendor_id and user_id = auth.uid());
  select role into v_caller_role from public.store_members
  where vendor_id = m.vendor_id and user_id = auth.uid() and status = 'active';

  if not (public.is_admin() or v_is_owner or v_caller_role in ('owner', 'manager')) then
    raise exception 'You do not have permission to remove store members.' using errcode = '42501';
  end if;

  if m.role in ('owner', 'manager') and not (public.is_admin() or v_is_owner or v_caller_role = 'owner') then
    raise exception 'Only a store owner can remove an owner or manager.' using errcode = '42501';
  end if;

  update public.store_members set status = 'removed' where id = p_member_id;

  perform public.record_audit('store_member.removed', 'store_members', p_member_id::text, 'Removed from store');

  return jsonb_build_object('id', p_member_id, 'status', 'removed');
end;
$$;

revoke all on function public.store_member_remove(uuid) from public, anon, authenticated;
grant execute on function public.store_member_remove(uuid) to authenticated;


-- =========================
-- Notifications
-- =========================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null check (audience in ('all', 'customers', 'vendors', 'admins', 'specific_user')),
  target_user_id uuid references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint notifications_target_matches_audience check (
    (audience = 'specific_user' and target_user_id is not null)
    or (audience <> 'specific_user' and target_user_id is null)
  )
);

create index if not exists notifications_audience_idx on public.notifications (audience, created_at desc);
create index if not exists notifications_target_idx on public.notifications (target_user_id) where target_user_id is not null;

-- Per-user read state, kept deliberately tiny: one row per (notification, user)
-- the moment it's read, so the UI can compute an unread badge/count.
create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create or replace function public.admin_send_notification(
  p_title text,
  p_body text,
  p_audience text,
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.admin_has_permission('send_notifications') then
    raise exception 'You do not have permission to send notifications.' using errcode = '42501';
  end if;

  perform public.assert_account_active();

  if coalesce(trim(p_title), '') = '' or coalesce(trim(p_body), '') = '' then
    raise exception 'A title and message body are required.' using errcode = '22023';
  end if;

  if p_audience not in ('all', 'customers', 'vendors', 'admins', 'specific_user') then
    raise exception 'Unknown notification audience.' using errcode = '22023';
  end if;

  if p_audience = 'specific_user' then
    if p_target_user_id is null or not exists (select 1 from auth.users where id = p_target_user_id) then
      raise exception 'A valid target user is required for a specific_user notification.' using errcode = '22023';
    end if;
  elsif p_target_user_id is not null then
    raise exception 'target_user_id may only be set when audience = specific_user.' using errcode = '22023';
  end if;

  insert into public.notifications (title, body, audience, target_user_id, created_by)
  values (trim(p_title), p_body, p_audience, p_target_user_id, auth.uid())
  returning id into v_id;

  perform public.record_audit('notification.sent', 'notification', v_id::text,
    format('Sent "%s" to %s', p_title, p_audience));

  return jsonb_build_object('id', v_id, 'audience', p_audience);
end;
$$;

revoke all on function public.admin_send_notification(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_send_notification(text, text, text, uuid) to authenticated;


create or replace function public.notification_mark_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_reads (notification_id, user_id)
  values (p_notification_id, auth.uid())
  on conflict (notification_id, user_id) do nothing;
end;
$$;

revoke all on function public.notification_mark_read(uuid) from public, anon, authenticated;
grant execute on function public.notification_mark_read(uuid) to authenticated;


-- =========================
-- RLS
-- =========================
alter table public.store_members enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;

-- Visible to: the invited person themselves, the store's original owner, any
-- active teammate of that same store (any role, via current_vendor_ids()), or
-- an admin. No insert/update/delete policy for regular users — every write
-- goes through store_member_invite/accept_invite/update_role/remove above;
-- admins get a full "for all" policy for support/cleanup.
drop policy if exists "store members are visible to the store team" on public.store_members;
create policy "store members are visible to the store team"
on public.store_members
for select
to authenticated
using (
  public.is_admin()
  or user_id = auth.uid()
  or vendor_id in (select public.current_vendor_ids())
);

drop policy if exists "admins manage store members" on public.store_members;
create policy "admins manage store members"
on public.store_members
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Notifications: readable by their audience; only insert is via
-- admin_send_notification(). Admins get a "for all" policy for cleanup.
drop policy if exists "notifications are visible to their audience" on public.notifications;
create policy "notifications are visible to their audience"
on public.notifications
for select
to authenticated
using (
  public.is_admin()
  or audience = 'all'
  or (audience = 'specific_user' and target_user_id = auth.uid())
  or (audience = 'admins' and exists (
        select 1 from public.profiles where id = auth.uid() and role = 'admin'::public.app_role
      ))
  or (audience = 'vendors' and exists (
        select 1 from public.vendors where user_id = auth.uid()
        union
        select 1 from public.store_members where user_id = auth.uid() and status = 'active'
      ))
  or (audience = 'customers' and exists (
        select 1 from public.profiles where id = auth.uid() and role = 'customer'::public.app_role
      ))
);

drop policy if exists "admins manage notifications" on public.notifications;
create policy "admins manage notifications"
on public.notifications
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Read receipts: strictly self-service.
drop policy if exists "users manage own notification reads" on public.notification_reads;
create policy "users manage own notification reads"
on public.notification_reads
for all
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid());
