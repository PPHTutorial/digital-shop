-- =============================================================================
-- Recognition & Rewards — part 1 of 3: follows + achievements
--
-- Adds the engagement + milestone substrate the marketplace was missing:
--
--   * public.vendor_follows     — a shopper follows a creator's store. Mirrors
--                                 public.blog_post_likes (direct insert/delete
--                                 under a "users manage own …" policy; all
--                                 side-effects run in a trigger).
--   * public.achievement_defs   — the seeded, admin-editable badge catalogue
--                                 (1 / 10 / 100 / 1K / 10K / 100K / 1M tiers for
--                                 sellers, buyers, affiliates, community).
--   * public.user_achievements  — one row per badge a user has earned.
--
-- Badges are awarded event-driven — no cron. public.evaluate_achievements()
-- recomputes a user's metrics live from source tables (so it never depends on
-- trigger ordering vs. the denormalised counters) and inserts any newly-cleared
-- tiers. Thin SECURITY DEFINER trigger dispatchers on orders / vendor_follows /
-- reviews / affiliate_earnings call it.
--
-- Monthly-winner badges (metric = 'monthly_winner') are seeded here but only
-- awarded by close_month_leaderboards() in part 2.
--
-- Reuses: is_admin(), attach_touch_trigger(). No new Edge Function.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.reward_kind as enum (
    'commission_discount', 'store_credit', 'featured_placement', 'affiliate_bonus', 'plaque'
  );
exception when duplicate_object then null; end $$;


-- -----------------------------------------------------------------------------
-- profiles — opt-in to being shown by full name on public leaderboards.
-- Default false: buyers/community never consented to public ranking, so they
-- appear masked ("First L.") until they flip this. See display_handle() in
-- part 2.
-- -----------------------------------------------------------------------------
alter table public.profiles add column if not exists show_on_leaderboards boolean not null default false;


-- -----------------------------------------------------------------------------
-- Follows
-- -----------------------------------------------------------------------------
create table if not exists public.vendor_follows (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (vendor_id, user_id)
);

create index if not exists vendor_follows_vendor_idx on public.vendor_follows (vendor_id);
create index if not exists vendor_follows_user_idx on public.vendor_follows (user_id, created_at desc);

-- Denormalised, maintained by the trigger below. Cheap storefront reads.
alter table public.vendors add column if not exists follower_count integer not null default 0;


-- -----------------------------------------------------------------------------
-- Achievement catalogue
-- -----------------------------------------------------------------------------
create table if not exists public.achievement_defs (
  key text primary key,
  audience text not null check (audience in ('seller', 'buyer', 'affiliate', 'community')),
  title text not null,
  description text not null default '',
  icon text not null default 'award',            -- lucide glyph name
  tier text check (tier is null or tier in ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  metric text not null check (metric in (
    'seller_sales_count', 'seller_gross_revenue', 'seller_followers',
    'buyer_orders_count', 'buyer_total_spend',
    'affiliate_conversions', 'affiliate_earned',
    'community_reviews', 'community_score',
    'monthly_winner'
  )),
  threshold numeric not null default 0,
  -- Optional perk attached to earning this badge. Fulfilled by part 3
  -- (public.rewards); NULL = recognition only.
  reward_kind public.reward_kind,
  reward_value numeric,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists achievement_defs_audience_idx on public.achievement_defs (audience, sort_order);
select public.attach_touch_trigger('public.achievement_defs');


-- -----------------------------------------------------------------------------
-- Earned badges
-- -----------------------------------------------------------------------------
create table if not exists public.user_achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_key text not null references public.achievement_defs(key) on delete cascade,
  awarded_at timestamptz not null default now(),
  metric_value numeric,                            -- snapshot of the metric at award time
  context jsonb not null default '{}'::jsonb,      -- e.g. {"board":"top_sellers","period":"2026-08","rank":1}
  unique (user_id, achievement_key)
);

create index if not exists user_achievements_user_idx on public.user_achievements (user_id, awarded_at desc);
create index if not exists user_achievements_key_idx on public.user_achievements (achievement_key);


-- =============================================================================
-- Awarding engine
-- =============================================================================
-- Recomputes p_user_id's metrics for one audience straight from the source
-- tables (never the denormalised counters — this runs inside AFTER triggers
-- where those may not be updated yet) and inserts any achievement_defs tier the
-- user now clears. Idempotent via the unique (user_id, achievement_key).
create or replace function public.evaluate_achievements(p_user_id uuid, p_audience text)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid;
  v_affiliate uuid;
  v_sales_count numeric := 0;
  v_gross numeric := 0;
  v_followers numeric := 0;
  v_orders_count numeric := 0;
  v_spend numeric := 0;
  v_conversions numeric := 0;
  v_earned numeric := 0;
  v_reviews numeric := 0;
  v_score numeric := 0;
begin
  if p_user_id is null then
    return;
  end if;

  if p_audience = 'seller' then
    select id into v_vendor from public.vendors where user_id = p_user_id;
    if v_vendor is null then
      return;
    end if;
    select coalesce(sum(oi.quantity), 0),
           coalesce(sum(round(oi.unit_price * oi.quantity, 2)), 0)
      into v_sales_count, v_gross
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.products p on p.id = oi.product_id
      where p.vendor_id = v_vendor and o.status = 'paid';
    select count(*) into v_followers from public.vendor_follows where vendor_id = v_vendor;

    insert into public.user_achievements (user_id, achievement_key, metric_value)
    select p_user_id, d.key, m.value
    from public.achievement_defs d
    join (values
      ('seller_sales_count',   v_sales_count),
      ('seller_gross_revenue', v_gross),
      ('seller_followers',     v_followers)
    ) as m(metric, value) on m.metric = d.metric
    where d.audience = 'seller' and d.is_active and m.value >= d.threshold
    on conflict (user_id, achievement_key) do nothing;

  elsif p_audience = 'buyer' then
    select count(*), coalesce(sum(amount), 0)
      into v_orders_count, v_spend
      from public.orders
      where user_id = p_user_id and status = 'paid';

    insert into public.user_achievements (user_id, achievement_key, metric_value)
    select p_user_id, d.key, m.value
    from public.achievement_defs d
    join (values
      ('buyer_orders_count', v_orders_count),
      ('buyer_total_spend',  v_spend)
    ) as m(metric, value) on m.metric = d.metric
    where d.audience = 'buyer' and d.is_active and m.value >= d.threshold
    on conflict (user_id, achievement_key) do nothing;

  elsif p_audience = 'affiliate' then
    select id into v_affiliate from public.affiliates where user_id = p_user_id;
    if v_affiliate is null then
      return;
    end if;
    select count(distinct order_id), coalesce(sum(commission_amount), 0)
      into v_conversions, v_earned
      from public.affiliate_earnings
      where affiliate_id = v_affiliate and status <> 'reversed';

    insert into public.user_achievements (user_id, achievement_key, metric_value)
    select p_user_id, d.key, m.value
    from public.achievement_defs d
    join (values
      ('affiliate_conversions', v_conversions),
      ('affiliate_earned',      v_earned)
    ) as m(metric, value) on m.metric = d.metric
    where d.audience = 'affiliate' and d.is_active and m.value >= d.threshold
    on conflict (user_id, achievement_key) do nothing;

  elsif p_audience = 'community' then
    select count(*) into v_reviews
      from public.reviews where user_id = p_user_id and status = 'approved';
    v_score := v_reviews * 5
      + (select count(*) from public.blog_comments where user_id = p_user_id and status = 'visible') * 2
      + (select count(*) from public.blog_post_likes where user_id = p_user_id)
      + (select count(*) from public.vendor_follows where user_id = p_user_id);

    insert into public.user_achievements (user_id, achievement_key, metric_value)
    select p_user_id, d.key, m.value
    from public.achievement_defs d
    join (values
      ('community_reviews', v_reviews),
      ('community_score',   v_score)
    ) as m(metric, value) on m.metric = d.metric
    where d.audience = 'community' and d.is_active and m.value >= d.threshold
    on conflict (user_id, achievement_key) do nothing;
  end if;
end;
$$;

revoke all on function public.evaluate_achievements(uuid, text) from public;
grant execute on function public.evaluate_achievements(uuid, text) to authenticated, service_role;


-- =============================================================================
-- Trigger dispatchers
-- =============================================================================

-- orders → 'paid': buyer milestones for the purchaser, seller milestones for
-- every distinct vendor behind the order's line items. Runs after
-- orders_book_vendor_earnings (alphabetical) so vendor rows already exist.
create or replace function public.recognition_on_order()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor_user uuid;
begin
  if new.status <> 'paid' or old.status = 'paid' then
    return new;
  end if;

  if new.user_id is not null then
    perform public.evaluate_achievements(new.user_id, 'buyer');
  end if;

  for v_vendor_user in
    select distinct v.user_id
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    join public.vendors v on v.id = p.vendor_id
    where oi.order_id = new.id
  loop
    perform public.evaluate_achievements(v_vendor_user, 'seller');
  end loop;

  return new;
end;
$$;

drop trigger if exists orders_recognition on public.orders;
create trigger orders_recognition
after update of status on public.orders
for each row execute procedure public.recognition_on_order();


-- vendor_follows insert/delete: keep vendors.follower_count in step, then
-- re-evaluate the followed seller (follower-count tiers) and the follower
-- (community score). One trigger so the count is fresh before the eval reads it.
create or replace function public.vendor_follows_after_change()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := coalesce(new.vendor_id, old.vendor_id);
  v_follower uuid := coalesce(new.user_id, old.user_id);
  v_vendor_user uuid;
begin
  update public.vendors
  set follower_count = (select count(*) from public.vendor_follows where vendor_id = v_vendor),
      updated_at = now()
  where id = v_vendor;

  select user_id into v_vendor_user from public.vendors where id = v_vendor;
  if v_vendor_user is not null then
    perform public.evaluate_achievements(v_vendor_user, 'seller');
  end if;
  perform public.evaluate_achievements(v_follower, 'community');

  return null;
end;
$$;

drop trigger if exists vendor_follows_after_change on public.vendor_follows;
create trigger vendor_follows_after_change
after insert or delete on public.vendor_follows
for each row execute procedure public.vendor_follows_after_change();


-- reviews → 'approved': community milestones for the reviewer.
create or replace function public.recognition_on_review()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform public.evaluate_achievements(new.user_id, 'community');
  end if;
  return null;
end;
$$;

drop trigger if exists reviews_recognition on public.reviews;
create trigger reviews_recognition
after insert or update of status on public.reviews
for each row execute procedure public.recognition_on_review();


-- affiliate_earnings insert: affiliate milestones. Recomputed live from the
-- ledger, so it does not matter that book_affiliate_earnings updates the
-- affiliates.total_* counters after this row trigger fires.
create or replace function public.recognition_on_affiliate_earning()
returns trigger
language plpgsql
security definer
set search_path = public as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.affiliates where id = new.affiliate_id;
  if v_user is not null then
    perform public.evaluate_achievements(v_user, 'affiliate');
  end if;
  return null;
end;
$$;

drop trigger if exists affiliate_earnings_recognition on public.affiliate_earnings;
create trigger affiliate_earnings_recognition
after insert on public.affiliate_earnings
for each row execute procedure public.recognition_on_affiliate_earning();


-- =============================================================================
-- RLS
-- =============================================================================
alter table public.vendor_follows enable row level security;
alter table public.achievement_defs enable row level security;
alter table public.user_achievements enable row level security;

-- Follows — public signal (like blog_post_likes); only the owner writes.
drop policy if exists "public read follows" on public.vendor_follows;
create policy "public read follows" on public.vendor_follows
for select to anon, authenticated
using (true);

drop policy if exists "users manage own follows" on public.vendor_follows;
create policy "users manage own follows" on public.vendor_follows
for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Badge catalogue — active rows public, admins edit.
drop policy if exists "active achievement defs are public" on public.achievement_defs;
create policy "active achievement defs are public" on public.achievement_defs
for select to anon, authenticated
using (is_active or public.is_admin());

drop policy if exists "admins manage achievement defs" on public.achievement_defs;
create policy "admins manage achievement defs" on public.achievement_defs
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Earned badges — the row carries no PII (user_id + key), so it is public;
-- identity is resolved through SECURITY DEFINER RPCs elsewhere. Users never
-- write their own; awards come from evaluate_achievements() /
-- close_month_leaderboards(). Admins may still hand-award / revoke.
drop policy if exists "public read achievements" on public.user_achievements;
create policy "public read achievements" on public.user_achievements
for select to anon, authenticated
using (true);

drop policy if exists "admins manage achievements" on public.user_achievements;
create policy "admins manage achievements" on public.user_achievements
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select on public.vendor_follows to anon, authenticated;
grant select, insert, delete on public.vendor_follows to authenticated;
grant select on public.achievement_defs to anon, authenticated;
grant select, insert, update, delete on public.achievement_defs to authenticated;
grant select on public.user_achievements to anon, authenticated;
grant select, insert, update, delete on public.user_achievements to authenticated;


-- =============================================================================
-- Seed the badge catalogue
-- =============================================================================
insert into public.achievement_defs
  (key, audience, title, description, icon, tier, metric, threshold, reward_kind, reward_value, sort_order)
values
  -- Seller — units sold (matches vendors.total_sales_count semantics)
  ('seller_sales_1',      'seller', 'First Sale',        'Closed your first order on DigiStore.',            'trophy',   'bronze',   'seller_sales_count',    1,        null,                  null, 10),
  ('seller_sales_10',     'seller', '10 Sales',          'Ten units sold.',                                  'medal',    'bronze',   'seller_sales_count',    10,       null,                  null, 11),
  ('seller_sales_100',    'seller', '100 Sales',         'One hundred units sold.',                          'medal',    'silver',   'seller_sales_count',    100,      null,                  null, 12),
  ('seller_sales_1k',     'seller', '1K Sales',          'One thousand units sold.',                         'award',    'gold',     'seller_sales_count',    1000,     null,                  null, 13),
  ('seller_sales_10k',    'seller', '10K Sales',         'Ten thousand units sold.',                         'crown',    'platinum', 'seller_sales_count',    10000,    null,                  null, 14),
  ('seller_sales_100k',   'seller', '100K Sales',        'One hundred thousand units sold.',                 'gem',      'diamond',  'seller_sales_count',    100000,   null,                  null, 15),
  ('seller_sales_1m',     'seller', '1M Sales',          'One million units sold — a physical plaque ships to you.', 'gem', 'diamond', 'seller_sales_count', 1000000, 'plaque',            null, 16),
  -- Seller — gross revenue (USD)
  ('seller_rev_1k',       'seller', '$1K Revenue',       'One thousand dollars in gross sales.',             'star',     'bronze',   'seller_gross_revenue',  1000,     null,                  null, 20),
  ('seller_rev_10k',      'seller', '$10K Revenue',      'Ten thousand dollars in gross sales.',             'star',     'silver',   'seller_gross_revenue',  10000,    null,                  null, 21),
  ('seller_rev_100k',     'seller', '$100K Revenue',     'One hundred thousand dollars in gross sales.',     'sparkles', 'gold',     'seller_gross_revenue',  100000,   null,                  null, 22),
  ('seller_rev_1m',       'seller', '$1M Revenue',       'One million dollars in gross sales — a plaque ships to you.', 'crown', 'platinum', 'seller_gross_revenue', 1000000, 'plaque',       null, 23),
  ('seller_rev_10m',      'seller', '$10M Revenue',      'Ten million dollars in gross sales — a plaque ships to you.', 'gem', 'diamond', 'seller_gross_revenue', 10000000, 'plaque',       null, 24),
  -- Seller — followers
  ('seller_followers_10',  'seller', '10 Followers',     'Ten shoppers follow your store.',                  'users',    'bronze',   'seller_followers',      10,       null,                  null, 30),
  ('seller_followers_100', 'seller', '100 Followers',    'One hundred shoppers follow your store.',          'users',    'silver',   'seller_followers',      100,      null,                  null, 31),
  ('seller_followers_1k',  'seller', '1K Followers',     'One thousand shoppers follow your store.',         'users',    'gold',     'seller_followers',      1000,     null,                  null, 32),
  ('seller_followers_10k', 'seller', '10K Followers',    'Ten thousand shoppers follow your store.',         'users',    'platinum', 'seller_followers',      10000,    null,                  null, 33),
  -- Buyer — orders
  ('buyer_orders_1',      'buyer',  'First Purchase',    'Made your first purchase.',                        'badge-check', 'bronze', 'buyer_orders_count',    1,        null,                  null, 40),
  ('buyer_orders_10',     'buyer',  '10 Orders',         'Ten completed orders.',                            'medal',    'bronze',   'buyer_orders_count',    10,       null,                  null, 41),
  ('buyer_orders_50',     'buyer',  '50 Orders',         'Fifty completed orders.',                          'award',    'silver',   'buyer_orders_count',    50,       null,                  null, 42),
  ('buyer_orders_100',    'buyer',  '100 Orders',        'One hundred completed orders.',                    'crown',    'gold',     'buyer_orders_count',    100,      null,                  null, 43),
  -- Buyer — spend (USD)
  ('buyer_spend_100',     'buyer',  '$100 Spent',        'One hundred dollars spent on DigiStore.',          'star',     'bronze',   'buyer_total_spend',     100,      null,                  null, 50),
  ('buyer_spend_1k',      'buyer',  '$1K Spent',         'One thousand dollars spent on DigiStore.',         'star',     'silver',   'buyer_total_spend',     1000,     null,                  null, 51),
  ('buyer_spend_10k',     'buyer',  '$10K Spent',        'Ten thousand dollars spent on DigiStore.',         'sparkles', 'gold',     'buyer_total_spend',     10000,    null,                  null, 52),
  -- Affiliate — conversions
  ('affiliate_conv_1',    'affiliate', 'First Referral', 'Your first referred sale.',                        'heart-handshake', 'bronze', 'affiliate_conversions', 1,  null,                  null, 60),
  ('affiliate_conv_10',   'affiliate', '10 Referrals',   'Ten referred sales.',                              'medal',    'bronze',   'affiliate_conversions', 10,       null,                  null, 61),
  ('affiliate_conv_100',  'affiliate', '100 Referrals',  'One hundred referred sales.',                      'award',    'silver',   'affiliate_conversions', 100,      null,                  null, 62),
  ('affiliate_conv_1k',   'affiliate', '1K Referrals',   'One thousand referred sales.',                     'crown',    'gold',     'affiliate_conversions', 1000,     null,                  null, 63),
  -- Affiliate — earnings (USD)
  ('affiliate_earn_100',  'affiliate', '$100 Earned',    'One hundred dollars in commission.',               'star',     'bronze',   'affiliate_earned',      100,      null,                  null, 70),
  ('affiliate_earn_1k',   'affiliate', '$1K Earned',     'One thousand dollars in commission.',              'star',     'silver',   'affiliate_earned',      1000,     null,                  null, 71),
  ('affiliate_earn_10k',  'affiliate', '$10K Earned',    'Ten thousand dollars in commission.',              'sparkles', 'gold',     'affiliate_earned',      10000,    null,                  null, 72),
  -- Community — reviews written
  ('community_reviews_1',  'community', 'First Review',   'Wrote your first product review.',                'star',     'bronze',   'community_reviews',     1,        null,                  null, 80),
  ('community_reviews_10', 'community', '10 Reviews',     'Ten approved reviews.',                            'medal',    'bronze',   'community_reviews',     10,       null,                  null, 81),
  ('community_reviews_50', 'community', '50 Reviews',     'Fifty approved reviews.',                          'award',    'silver',   'community_reviews',     50,       null,                  null, 82),
  -- Community — weighted engagement score (reviews×5 + comments×2 + likes + follows)
  ('community_score_100',  'community', 'Active Member',    'A hundred engagement points.',                   'flame',    'bronze',   'community_score',       100,      null,                  null, 90),
  ('community_score_500',  'community', 'Community Pillar', 'Five hundred engagement points.',                'flame',    'silver',   'community_score',       500,      null,                  null, 91),
  ('community_score_2000', 'community', 'Community Legend', 'Two thousand engagement points.',                'flame',    'gold',     'community_score',       2000,     null,                  null, 92),
  -- Monthly winners — threshold 0; awarded only by close_month_leaderboards()
  ('seller_of_the_month',    'seller',    'Seller of the Month',      'Top seller by net revenue this month.',   'crown', 'gold', 'monthly_winner', 0, 'commission_discount', 5,  100),
  ('creator_of_the_month',   'seller',    'Creator of the Month',     'Most-followed creator this month.',        'users', 'gold', 'monthly_winner', 0, 'featured_placement',  null, 101),
  ('buyer_of_the_month',     'buyer',     'Buyer of the Month',       'Top buyer by spend this month.',           'trophy', 'gold', 'monthly_winner', 0, 'store_credit',       25, 102),
  ('affiliate_of_the_month', 'affiliate', 'Affiliate of the Month',   'Top affiliate by commission this month.',  'heart-handshake', 'gold', 'monthly_winner', 0, 'affiliate_bonus', 5, 103),
  ('engager_of_the_month',   'community', 'Top Engager of the Month', 'Highest engagement score this month.',     'flame', 'gold', 'monthly_winner', 0, 'store_credit',       10, 104)
on conflict (key) do update set
  audience     = excluded.audience,
  title        = excluded.title,
  description  = excluded.description,
  icon         = excluded.icon,
  tier         = excluded.tier,
  metric       = excluded.metric,
  threshold    = excluded.threshold,
  reward_kind  = excluded.reward_kind,
  reward_value = excluded.reward_value,
  sort_order   = excluded.sort_order,
  updated_at   = now();
