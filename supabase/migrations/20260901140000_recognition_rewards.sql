-- =============================================================================
-- Recognition & Rewards — part 3 of 3: rewards, perks, plaque queue, read RPCs
--
--   * public.rewards                       — perk ledger (one row per granted
--                                            perk). Written only by SECURITY
--                                            DEFINER functions.
--   * grant_reward_for_achievement(...)    — turns a badge whose def carries a
--                                            reward_kind into a rewards row.
--                                            Fired by a trigger on
--                                            user_achievements, so both
--                                            milestone badges (e.g. 1M sales →
--                                            plaque) and monthly-winner badges
--                                            get their perk automatically.
--   * A commission_discount reward is applied by writing vendors.commission_rate
--     DOWN once at grant time (with the original stashed in the reward's
--     metadata) and restoring it in expire_rewards(). book_vendor_earnings() is
--     NOT touched — it keeps reading vendors.commission_rate as it always has,
--     so nothing new runs on the live payment path. A rate cut earned this
--     month therefore only affects orders paid next month (the close job runs on
--     the 1st for the month that just ended) and never rewrites an earning row
--     already booked.
--   * store_credit is issued as a single-use fixed-amount promo_codes row —
--     no change to create_order().
--   * submit_plaque_shipping / admin_fulfil_reward — the plaque fulfilment loop.
--   * my_recognition()                     — the account "Rewards" tab payload.
--   * vendor_storefront() / vendor_dashboard() re-defined to surface follows +
--     badges + spotlight.  spotlight_creators() feeds a homepage strip.
--   * admin_recognition_overview / admin_award_achievement /
--     admin_revoke_achievement / admin_fulfil_reward / admin_run_month_close.
--   * expire_rewards() — nightly pg_cron; ends time-boxed perks.
-- =============================================================================

do $$ begin
  create type public.reward_status as enum ('pending', 'active', 'fulfilled', 'expired', 'cancelled');
exception when duplicate_object then null; end $$;

alter table public.vendors add column if not exists spotlight_until timestamptz;


-- -----------------------------------------------------------------------------
-- Reward ledger
-- -----------------------------------------------------------------------------
create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.reward_kind not null,
  status public.reward_status not null default 'pending',
  -- 'achievement:<key>' for milestone perks, 'leaderboard:<board>:<period>:1'
  -- for monthly winners. Used as the idempotency key.
  source text not null,
  value numeric,                                 -- credit amount / discount points / bonus %
  currency text,
  starts_at timestamptz,
  ends_at timestamptz,                           -- time-boxed perks (commission_discount, featured_placement)
  metadata jsonb not null default '{}'::jsonb,
  -- plaque fulfilment
  ship_to_name text,
  ship_to_address text,
  ship_to_country text,
  tracking_ref text,
  fulfilled_at timestamptz,
  fulfilled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source)
);

create index if not exists rewards_user_idx on public.rewards (user_id, created_at desc);
create index if not exists rewards_status_kind_idx on public.rewards (status, kind);
select public.attach_touch_trigger('public.rewards');


-- -----------------------------------------------------------------------------
-- Turn an earned badge into a perk. No-op when the def carries no reward_kind
-- or the same (user, source) reward already exists.
--
-- book_vendor_earnings() is deliberately NOT redefined here — a commission_
-- discount is applied by writing vendors.commission_rate down once below and
-- restored in expire_rewards(), so the live payment path is unchanged.
-- -----------------------------------------------------------------------------
create or replace function public.grant_reward_for_achievement(
  p_user_id uuid,
  p_achievement_key text,
  p_period text default null,
  p_board text default null
)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  d public.achievement_defs;
  v_source text;
  v_vendor uuid;
  v_code text;
  v_original_rate numeric(5, 2);
  v_cut numeric;
begin
  select * into d from public.achievement_defs where key = p_achievement_key;
  if d.key is null or d.reward_kind is null then
    return;
  end if;

  v_source := case
    when p_period is not null and p_board is not null
      then 'leaderboard:' || p_board || ':' || p_period || ':1'
    else 'achievement:' || p_achievement_key
  end;

  if exists (select 1 from public.rewards where user_id = p_user_id and source = v_source) then
    return;
  end if;

  if d.reward_kind = 'commission_discount' then
    select id, commission_rate into v_vendor, v_original_rate
      from public.vendors where user_id = p_user_id;
    if v_vendor is null then return; end if;
    -- One active commission_discount at a time — don't stack, and don't lose
    -- track of which rate to restore.
    if exists (
      select 1 from public.rewards
      where user_id = p_user_id and kind = 'commission_discount' and status = 'active'
    ) then
      return;
    end if;
    v_cut := coalesce(d.reward_value, 5);
    -- Apply the cut now (one write). Restored by expire_rewards() when ends_at
    -- passes. book_vendor_earnings() keeps reading vendors.commission_rate.
    update public.vendors
      set commission_rate = greatest(0, commission_rate - v_cut), updated_at = now()
      where id = v_vendor;
    insert into public.rewards (user_id, kind, status, source, value, starts_at, ends_at, metadata)
    values (p_user_id, 'commission_discount', 'active', v_source, v_cut,
            now(), now() + interval '1 month',
            jsonb_build_object('vendor_id', v_vendor, 'achievement', p_achievement_key,
                               'original_rate', v_original_rate));

  elsif d.reward_kind = 'store_credit' then
    v_code := 'RWD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    insert into public.promo_codes (code, discount_type, discount_value, max_redemptions, ends_at, is_active)
    values (v_code, 'fixed', coalesce(d.reward_value, 10), 1, now() + interval '90 days', true);
    insert into public.rewards (user_id, kind, status, source, value, currency, starts_at, ends_at, metadata)
    values (p_user_id, 'store_credit', 'active', v_source, coalesce(d.reward_value, 10), 'USD',
            now(), now() + interval '90 days',
            jsonb_build_object('promo_code', v_code, 'achievement', p_achievement_key));

  elsif d.reward_kind = 'featured_placement' then
    select id into v_vendor from public.vendors where user_id = p_user_id;
    if v_vendor is null then return; end if;
    update public.vendors
      set spotlight_until = greatest(coalesce(spotlight_until, now()), now() + interval '1 month'),
          updated_at = now()
      where id = v_vendor;
    insert into public.rewards (user_id, kind, status, source, starts_at, ends_at, metadata)
    values (p_user_id, 'featured_placement', 'active', v_source,
            now(), now() + interval '1 month',
            jsonb_build_object('vendor_id', v_vendor, 'achievement', p_achievement_key));

  elsif d.reward_kind = 'affiliate_bonus' then
    insert into public.rewards (user_id, kind, status, source, value, metadata)
    values (p_user_id, 'affiliate_bonus', 'pending', v_source, coalesce(d.reward_value, 5),
            jsonb_build_object('achievement', p_achievement_key,
                               'note', 'Apply as a manual commission credit'));

  elsif d.reward_kind = 'plaque' then
    insert into public.rewards (user_id, kind, status, source, metadata)
    values (p_user_id, 'plaque', 'pending', v_source,
            jsonb_build_object('achievement', p_achievement_key));
  end if;
end;
$$;

revoke all on function public.grant_reward_for_achievement(uuid, text, text, text) from public;
revoke execute on function public.grant_reward_for_achievement(uuid, text, text, text) from anon, authenticated;
grant execute on function public.grant_reward_for_achievement(uuid, text, text, text) to service_role;

-- Every awarded badge runs the perk grant. context.period/context.board are
-- set for monthly winners (by close_month_leaderboards), null for milestones.
create or replace function public.reward_on_achievement()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  perform public.grant_reward_for_achievement(
    new.user_id, new.achievement_key, new.context ->> 'period', new.context ->> 'board'
  );
  return null;
end;
$$;

drop trigger if exists user_achievements_reward on public.user_achievements;
create trigger user_achievements_reward
after insert on public.user_achievements
for each row execute procedure public.reward_on_achievement();


-- -----------------------------------------------------------------------------
-- Plaque fulfilment
-- -----------------------------------------------------------------------------
create or replace function public.submit_plaque_shipping(
  p_reward_id uuid, p_name text, p_address text, p_country text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  r public.rewards;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into r from public.rewards where id = p_reward_id;
  if r.id is null or r.user_id <> auth.uid() then
    raise exception 'Reward not found.' using errcode = '42501';
  end if;
  if r.kind <> 'plaque' then
    raise exception 'This reward does not need a shipping address.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_address), '') = '' then
    raise exception 'Name and address are required.' using errcode = '22023';
  end if;

  update public.rewards
  set ship_to_name = btrim(p_name),
      ship_to_address = btrim(p_address),
      ship_to_country = nullif(btrim(p_country), ''),
      status = 'active',            -- pending (needs address) -> active (queued to ship)
      updated_at = now()
  where id = p_reward_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.submit_plaque_shipping(uuid, text, text, text) from public;
grant execute on function public.submit_plaque_shipping(uuid, text, text, text) to authenticated;


-- -----------------------------------------------------------------------------
-- Nightly: end time-boxed perks, drop stale spotlights.
-- -----------------------------------------------------------------------------
create or replace function public.expire_rewards()
returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_count integer;
begin
  -- Lift an elapsed commission_discount: put vendors.commission_rate back to the
  -- rate stashed at grant time. Only when the vendor is still at/below that
  -- rate, so a manual admin change since then isn't clobbered.
  update public.vendors v
  set commission_rate = (r.metadata ->> 'original_rate')::numeric,
      updated_at = now()
  from public.rewards r
  where r.kind = 'commission_discount'
    and r.status = 'active'
    and r.ends_at is not null and r.ends_at <= now()
    and (r.metadata ->> 'original_rate') is not null
    and v.id = (r.metadata ->> 'vendor_id')::uuid
    and v.commission_rate <= (r.metadata ->> 'original_rate')::numeric;

  update public.rewards
  set status = 'expired', updated_at = now()
  where status = 'active'
    and ends_at is not null and ends_at <= now()
    and kind in ('commission_discount', 'featured_placement');
  get diagnostics v_count = row_count;

  update public.vendors
  set spotlight_until = null, updated_at = now()
  where spotlight_until is not null and spotlight_until <= now();

  return v_count;
end;
$$;

revoke all on function public.expire_rewards() from public;
revoke execute on function public.expire_rewards() from anon, authenticated;
grant execute on function public.expire_rewards() to service_role;


-- =============================================================================
-- Read helpers (internal — service_role only; the public RPCs below are
-- SECURITY DEFINER and reach them as the function owner).
-- =============================================================================
create or replace function public._recognition_metric_value(p_user_id uuid, p_metric text)
returns numeric
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_vendor uuid;
  v_aff uuid;
begin
  if p_metric like 'seller_%' then
    select id into v_vendor from public.vendors where user_id = p_user_id;
    if v_vendor is null then return null; end if;
  elsif p_metric like 'affiliate_%' then
    select id into v_aff from public.affiliates where user_id = p_user_id;
    if v_aff is null then return null; end if;
  end if;

  case p_metric
    when 'seller_sales_count' then
      return (select coalesce(sum(oi.quantity), 0)
              from public.order_items oi
              join public.orders o on o.id = oi.order_id
              join public.products p on p.id = oi.product_id
              where p.vendor_id = v_vendor and o.status = 'paid');
    when 'seller_gross_revenue' then
      return (select coalesce(sum(round(oi.unit_price * oi.quantity, 2)), 0)
              from public.order_items oi
              join public.orders o on o.id = oi.order_id
              join public.products p on p.id = oi.product_id
              where p.vendor_id = v_vendor and o.status = 'paid');
    when 'seller_followers' then
      return (select count(*) from public.vendor_follows where vendor_id = v_vendor);
    when 'buyer_orders_count' then
      return (select count(*) from public.orders where user_id = p_user_id and status = 'paid');
    when 'buyer_total_spend' then
      return (select coalesce(sum(amount), 0) from public.orders where user_id = p_user_id and status = 'paid');
    when 'affiliate_conversions' then
      return (select count(distinct order_id) from public.affiliate_earnings
              where affiliate_id = v_aff and status <> 'reversed');
    when 'affiliate_earned' then
      return (select coalesce(sum(commission_amount), 0) from public.affiliate_earnings
              where affiliate_id = v_aff and status <> 'reversed');
    when 'community_reviews' then
      return (select count(*) from public.reviews where user_id = p_user_id and status = 'approved');
    when 'community_score' then
      return (select count(*) * 5 from public.reviews where user_id = p_user_id and status = 'approved')
        + (select count(*) * 2 from public.blog_comments where user_id = p_user_id and status = 'visible')
        + (select count(*) from public.blog_post_likes where user_id = p_user_id)
        + (select count(*) from public.vendor_follows where user_id = p_user_id);
    else
      return null;
  end case;
end;
$$;

revoke all on function public._recognition_metric_value(uuid, text) from public;
revoke execute on function public._recognition_metric_value(uuid, text) from anon, authenticated;
grant execute on function public._recognition_metric_value(uuid, text) to service_role;

create or replace function public._my_rank(p_board text, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_rows jsonb;
  v_row jsonb;
begin
  v_rows := public._leaderboard_live(p_board, date_trunc('month', now()), now() + interval '1 second',
                                     5000, p_user_id, true);
  select value into v_row
  from jsonb_array_elements(v_rows)
  where nullif(value ->> 'user_id', '')::uuid = p_user_id
  limit 1;

  if v_row is null then
    return jsonb_build_object('rank', null);
  end if;
  return jsonb_build_object('rank', (v_row ->> 'rank')::int, 'value', (v_row ->> 'value')::numeric);
end;
$$;

revoke all on function public._my_rank(text, uuid) from public;
revoke execute on function public._my_rank(text, uuid) from anon, authenticated;
grant execute on function public._my_rank(text, uuid) to service_role;


-- =============================================================================
-- my_recognition() — the account "Rewards" tab.
-- =============================================================================
create or replace function public.my_recognition()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('authenticated', false);
  end if;

  return jsonb_build_object(
    'authenticated', true,
    'badges', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', ua.achievement_key, 'title', d.title, 'description', d.description,
        'icon', d.icon, 'tier', d.tier, 'audience', d.audience,
        'awarded_at', ua.awarded_at, 'metric_value', ua.metric_value, 'context', ua.context
      ) order by ua.awarded_at desc), '[]'::jsonb)
      from public.user_achievements ua
      join public.achievement_defs d on d.key = ua.achievement_key
      where ua.user_id = v_uid
    ),
    'next_badges', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', x.key, 'title', x.title, 'icon', x.icon, 'tier', x.tier,
        'audience', x.audience, 'metric', x.metric, 'threshold', x.threshold,
        'current_value', x.current_value,
        'progress', round(least(1, x.current_value / nullif(x.threshold, 0))::numeric, 4)
      ) order by x.audience, x.sort_order), '[]'::jsonb)
      from (
        select distinct on (d.metric)
               d.key, d.title, d.icon, d.tier, d.audience, d.metric, d.threshold, d.sort_order,
               public._recognition_metric_value(v_uid, d.metric) as current_value
        from public.achievement_defs d
        where d.is_active and d.metric <> 'monthly_winner'
          and not exists (
            select 1 from public.user_achievements ua
            where ua.user_id = v_uid and ua.achievement_key = d.key
          )
          and public._recognition_metric_value(v_uid, d.metric) is not null
        order by d.metric, d.threshold asc
      ) x
    ),
    'ranks', jsonb_build_object(
      'top_buyers',   public._my_rank('top_buyers', v_uid),
      'top_engagers', public._my_rank('top_engagers', v_uid)
    ),
    'rewards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'status', r.status, 'value', r.value,
        'currency', r.currency, 'source', r.source, 'starts_at', r.starts_at,
        'ends_at', r.ends_at, 'metadata', r.metadata,
        'ship_to_name', r.ship_to_name, 'ship_to_address', r.ship_to_address,
        'ship_to_country', r.ship_to_country, 'tracking_ref', r.tracking_ref,
        'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from public.rewards r where r.user_id = v_uid
    ),
    'plaque_actions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'source', r.source, 'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from public.rewards r
      where r.user_id = v_uid and r.kind = 'plaque' and r.status = 'pending'
        and coalesce(btrim(r.ship_to_address), '') = ''
    )
  );
end;
$$;

revoke all on function public.my_recognition() from public;
grant execute on function public.my_recognition() to authenticated;


-- =============================================================================
-- vendor_storefront() — re-defined to add follows + seller badges + spotlight.
-- Products block unchanged from 20260824150000.
-- =============================================================================
create or replace function public.vendor_storefront(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select jsonb_build_object(
    'vendor', (
      select to_jsonb(v) from (
        select ven.id, ven.display_name, ven.slug, ven.bio, ven.logo_url, ven.banner_url,
               ven.country, ven.total_sales_count, ven.approved_at,
               ven.follower_count,
               (ven.spotlight_until is not null and ven.spotlight_until > now()) as spotlight,
               exists (
                 select 1 from public.vendor_follows f
                 where f.vendor_id = ven.id and f.user_id = auth.uid()
               ) as viewer_following,
               (
                 select count(*) from public.leaderboard_snapshots s
                 where s.rank = 1
                   and (s.subject_vendor_id = ven.id or s.subject_user_id = ven.user_id)
               ) as monthly_wins,
               (
                 select coalesce(jsonb_agg(jsonb_build_object(
                   'key', ua.achievement_key, 'title', d.title, 'icon', d.icon,
                   'tier', d.tier, 'awarded_at', ua.awarded_at
                 ) order by d.sort_order), '[]'::jsonb)
                 from public.user_achievements ua
                 join public.achievement_defs d on d.key = ua.achievement_key
                 where ua.user_id = ven.user_id and d.audience = 'seller'
               ) as badges
        from public.vendors ven
        where ven.slug = p_slug and ven.status = 'approved'
      ) v
    ),
    'products', (
      select coalesce(jsonb_agg(p order by p.created_at desc), '[]'::jsonb)
      from (
        select pr.id, pr.slug, pr.title, pr.short_description, pr.description,
               pr.price, pr.original_price, pr.currency, pr.cover_url, pr.category,
               pr.file_type, pr.file_size_bytes, pr.purchase_count,
               pr.rating_sum, pr.rating_count, pr.is_featured, pr.created_at
        from public.products pr
        join public.vendors vv on vv.id = pr.vendor_id
        where vv.slug = p_slug and vv.status = 'approved' and pr.is_published
      ) p
    )
  );
$$;

revoke all on function public.vendor_storefront(text) from public;
grant execute on function public.vendor_storefront(text) to anon, authenticated;


-- =============================================================================
-- vendor_dashboard() — re-defined from 20260901000000. UNCHANGED except the
-- added recognition block (follower_count, sales_rank_current, badges,
-- active_rewards) at the end of the object.
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
               affiliate_opt_in, affiliate_commission_rate,
               follower_count, spotlight_until
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
    ),
    'recognition', jsonb_build_object(
      'follower_count', (select follower_count from public.vendors where id = v_vendor),
      'sales_rank_current', (
        select ranked.rank from (
          select v2.id, row_number() over (order by sum(e.net_amount) desc, v2.id) as rank
          from public.vendor_earnings e
          join public.vendors v2 on v2.id = e.vendor_id
          where e.created_at >= date_trunc('month', now()) and e.status <> 'reversed'
          group by v2.id
        ) ranked where ranked.id = v_vendor
      ),
      'badges', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'key', ua.achievement_key, 'title', d.title, 'description', d.description,
          'icon', d.icon, 'tier', d.tier, 'awarded_at', ua.awarded_at
        ) order by ua.awarded_at desc), '[]'::jsonb)
        from public.user_achievements ua
        join public.achievement_defs d on d.key = ua.achievement_key
        where ua.user_id = (select user_id from public.vendors where id = v_vendor)
          and d.audience = 'seller'
      ),
      'active_rewards', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'kind', r.kind, 'status', r.status, 'value', r.value,
          'ends_at', r.ends_at, 'metadata', r.metadata
        ) order by r.created_at desc), '[]'::jsonb)
        from public.rewards r
        where r.user_id = (select user_id from public.vendors where id = v_vendor)
          and r.status in ('active', 'pending')
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.vendor_dashboard() from public;
grant execute on function public.vendor_dashboard() to authenticated;


-- =============================================================================
-- spotlight_creators() — homepage "Creators of the Month" strip.
-- =============================================================================
create or replace function public.spotlight_creators(p_limit integer default 8)
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.spotlight_until desc), '[]'::jsonb)
  from (
    select id, display_name, slug, bio, logo_url, banner_url,
           follower_count, total_sales_count, spotlight_until
    from public.vendors
    where status = 'approved' and spotlight_until is not null and spotlight_until > now()
    order by spotlight_until desc
    limit greatest(1, least(coalesce(p_limit, 8), 24))
  ) x;
$$;

revoke all on function public.spotlight_creators(integer) from public;
grant execute on function public.spotlight_creators(integer) to anon, authenticated;


-- =============================================================================
-- Admin
-- =============================================================================
create or replace function public.admin_recognition_overview()
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
    'defs', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.audience, d.sort_order), '[]'::jsonb)
      from public.achievement_defs d
    ),
    'plaque_queue', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'user_id', r.user_id, 'name', public.display_handle(r.user_id),
        'status', r.status, 'source', r.source,
        'ship_to_name', r.ship_to_name, 'ship_to_address', r.ship_to_address,
        'ship_to_country', r.ship_to_country, 'tracking_ref', r.tracking_ref,
        'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from public.rewards r
      where r.kind = 'plaque' and r.status in ('pending', 'active')
    ),
    'recent_rewards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'user_id', r.user_id, 'name', public.display_handle(r.user_id),
        'kind', r.kind, 'status', r.status, 'value', r.value, 'source', r.source,
        'created_at', r.created_at
      ) order by r.created_at desc), '[]'::jsonb)
      from (select * from public.rewards order by created_at desc limit 50) r
    ),
    'periods', (
      select coalesce(jsonb_agg(distinct period order by period desc), '[]'::jsonb)
      from public.leaderboard_snapshots
    )
  );
end;
$$;

revoke all on function public.admin_recognition_overview() from public;
grant execute on function public.admin_recognition_overview() to authenticated;

create or replace function public.admin_award_achievement(p_user_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;
  insert into public.user_achievements (user_id, achievement_key, context)
  values (p_user_id, p_key, jsonb_build_object('manual', true, 'by', auth.uid()))
  on conflict (user_id, achievement_key) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_award_achievement(uuid, text) from public;
grant execute on function public.admin_award_achievement(uuid, text) to authenticated;

create or replace function public.admin_revoke_achievement(p_user_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;
  delete from public.user_achievements where user_id = p_user_id and achievement_key = p_key;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_revoke_achievement(uuid, text) from public;
grant execute on function public.admin_revoke_achievement(uuid, text) to authenticated;

create or replace function public.admin_fulfil_reward(p_reward_id uuid, p_tracking_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;
  update public.rewards
  set status = 'fulfilled',
      tracking_ref = coalesce(nullif(btrim(p_tracking_ref), ''), tracking_ref),
      fulfilled_at = now(),
      fulfilled_by = auth.uid(),
      updated_at = now()
  where id = p_reward_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_fulfil_reward(uuid, text) from public;
grant execute on function public.admin_fulfil_reward(uuid, text) to authenticated;

create or replace function public.admin_run_month_close(p_period text default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;
  return public.close_month_leaderboards(p_period, coalesce(p_force, false));
end;
$$;

revoke all on function public.admin_run_month_close(text, boolean) from public;
grant execute on function public.admin_run_month_close(text, boolean) to authenticated;


-- =============================================================================
-- RLS
-- =============================================================================
alter table public.rewards enable row level security;

drop policy if exists "users read own rewards" on public.rewards;
create policy "users read own rewards" on public.rewards
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

-- No write policy: rewards are created by grant_reward_for_achievement() and
-- edited by submit_plaque_shipping() / admin_fulfil_reward(), all SECURITY
-- DEFINER.
grant select on public.rewards to authenticated;


-- =============================================================================
-- Nightly perk expiry. Same pg_cron caveat as part 2 — if the extension is not
-- enabled, wire it by hand (Supabase Dashboard → Integrations → Cron):
--   select public.expire_rewards();  on  '15 1 * * *'
-- =============================================================================
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'recognition-expire-rewards') then
      perform cron.unschedule('recognition-expire-rewards');
    end if;
    perform cron.schedule('recognition-expire-rewards', '15 1 * * *',
      $cron$select public.expire_rewards();$cron$);
  end if;
end $$;
