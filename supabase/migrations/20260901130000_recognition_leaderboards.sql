-- =============================================================================
-- Recognition & Rewards — part 2 of 3: leaderboards
--
--   * public.leaderboard_snapshots — frozen top-100 per board per finished month
--                                    (the hall of fame). Read-only history.
--   * public.display_handle(uuid)   — one place that turns a private profile
--                                     name into a public label: full name if
--                                     the user opted in (profiles.show_on_
--                                     leaderboards), else "First L.".
--   * public._leaderboard_live(...) — the aggregations, one per board, over an
--                                     arbitrary from/to window. Locked to
--                                     service_role; only ever reached through
--                                     the two SECURITY DEFINER callers below.
--   * public.leaderboard(board, period, limit) — the public read. period is
--                                     'current' (month-to-date), 'all_time', or
--                                     'YYYY-MM'. A finished month with a
--                                     snapshot is served frozen.
--   * public.close_month_leaderboards(period, force) — freezes the month and
--                                     awards the "… of the Month" badges. Run
--                                     monthly by pg_cron (see the end of file).
--
-- Boards: top_sellers · top_buyers · top_affiliates · top_engagers ·
--         most_followed_creators · top_community.
-- =============================================================================

create table if not exists public.leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  board text not null check (board in (
    'top_sellers', 'top_buyers', 'top_affiliates',
    'top_engagers', 'most_followed_creators', 'top_community'
  )),
  period text not null,                         -- 'YYYY-MM'
  rank integer not null,
  subject_user_id uuid references auth.users(id) on delete set null,
  subject_vendor_id uuid references public.vendors(id) on delete set null,
  display_name text not null,                   -- frozen label (respects opt-in at close time)
  metric_value numeric not null default 0,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (board, period, rank)
);

create index if not exists leaderboard_snapshots_period_idx
  on public.leaderboard_snapshots (period, board, rank);
create index if not exists leaderboard_snapshots_subject_user_idx
  on public.leaderboard_snapshots (subject_user_id) where subject_user_id is not null;
create index if not exists leaderboard_snapshots_subject_vendor_idx
  on public.leaderboard_snapshots (subject_vendor_id) where subject_vendor_id is not null;


-- -----------------------------------------------------------------------------
-- Public display name for a private profile. Mirrors the reviewer_name /
-- author_name pattern (product_detail, blog_post_engagement) — a SECURITY
-- DEFINER read of the otherwise-private profiles table that returns only a
-- label. Full name only when the user opted in; otherwise "First L.".
-- -----------------------------------------------------------------------------
create or replace function public.display_handle(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public as $$
  select case
    when coalesce(nullif(btrim(p.full_name), ''), '') = '' then 'DigiStore member'
    when p.show_on_leaderboards then btrim(p.full_name)
    else initcap(split_part(btrim(p.full_name), ' ', 1))
         || case when split_part(btrim(p.full_name), ' ', 2) <> ''
                 then ' ' || upper(left(split_part(btrim(p.full_name), ' ', 2), 1)) || '.'
                 else '' end
  end
  from public.profiles p
  where p.id = p_user_id;
$$;

revoke all on function public.display_handle(uuid) from public;
grant execute on function public.display_handle(uuid) to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- Live aggregation for one board over the half-open window p_from .. p_to.
-- Internal — service_role only. p_reveal = true keeps the real subject_user_id
-- on every row, for the close job / admin; the public path always passes false,
-- so a masked user's id is withheld unless they are the viewer or opted in.
-- Returns a jsonb array of
--   { rank, vendor_id, user_id, name, slug, avatar_url, value, is_viewer }
-- -----------------------------------------------------------------------------
create or replace function public._leaderboard_live(
  p_board text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer,
  p_uid uuid,
  p_reveal boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_rows jsonb;
begin
  if p_board = 'top_sellers' then
    select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) into v_rows from (
      select row_number() over (order by sum(e.net_amount) desc, v.id) as rank,
             v.id as vendor_id, null::uuid as user_id, v.display_name as name,
             v.slug, v.logo_url as avatar_url, sum(e.net_amount) as value,
             (v.user_id = p_uid) as is_viewer
      from public.vendor_earnings e
      join public.vendors v on v.id = e.vendor_id
      where e.created_at >= p_from and e.created_at < p_to and e.status <> 'reversed'
      group by v.id, v.display_name, v.slug, v.logo_url, v.user_id
      order by value desc, v.id
      limit p_limit
    ) r;

  elsif p_board = 'most_followed_creators' then
    select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) into v_rows from (
      select row_number() over (order by count(*) desc, v.id) as rank,
             v.id as vendor_id, null::uuid as user_id, v.display_name as name,
             v.slug, v.logo_url as avatar_url, count(*)::numeric as value,
             (v.user_id = p_uid) as is_viewer
      from public.vendor_follows f
      join public.vendors v on v.id = f.vendor_id
      where f.created_at >= p_from and f.created_at < p_to
      group by v.id, v.display_name, v.slug, v.logo_url, v.user_id
      order by value desc, v.id
      limit p_limit
    ) r;

  elsif p_board = 'top_buyers' then
    select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) into v_rows from (
      select row_number() over (order by sum(o.amount) desc, o.user_id) as rank,
             null::uuid as vendor_id,
             case when p_reveal or pr.show_on_leaderboards or o.user_id = p_uid
                  then o.user_id else null end as user_id,
             coalesce(public.display_handle(o.user_id), 'DigiStore member') as name,
             null::text as slug, null::text as avatar_url,
             sum(o.amount) as value, (o.user_id = p_uid) as is_viewer
      from public.orders o
      left join public.profiles pr on pr.id = o.user_id
      where o.status = 'paid'
        and coalesce(o.paid_at, o.created_at) >= p_from
        and coalesce(o.paid_at, o.created_at) < p_to
        and o.user_id is not null
      group by o.user_id, pr.show_on_leaderboards
      order by value desc, o.user_id
      limit p_limit
    ) r;

  elsif p_board = 'top_affiliates' then
    select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) into v_rows from (
      select row_number() over (order by sum(ae.commission_amount) desc, a.user_id) as rank,
             null::uuid as vendor_id,
             case when p_reveal or pr.show_on_leaderboards or a.user_id = p_uid
                  then a.user_id else null end as user_id,
             coalesce(public.display_handle(a.user_id), 'DigiStore member') as name,
             null::text as slug, null::text as avatar_url,
             sum(ae.commission_amount) as value, (a.user_id = p_uid) as is_viewer
      from public.affiliate_earnings ae
      join public.affiliates a on a.id = ae.affiliate_id
      left join public.profiles pr on pr.id = a.user_id
      where ae.created_at >= p_from and ae.created_at < p_to and ae.status <> 'reversed'
      group by a.user_id, pr.show_on_leaderboards
      order by value desc, a.user_id
      limit p_limit
    ) r;

  else  -- top_engagers / top_community — weighted engagement in the window
    select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) into v_rows from (
      select row_number() over (order by s.score desc, s.user_id) as rank,
             null::uuid as vendor_id,
             case when p_reveal or pr.show_on_leaderboards or s.user_id = p_uid
                  then s.user_id else null end as user_id,
             coalesce(public.display_handle(s.user_id), 'DigiStore member') as name,
             null::text as slug, null::text as avatar_url,
             s.score as value, (s.user_id = p_uid) as is_viewer
      from (
        select u.user_id, sum(u.w)::numeric as score
        from (
          select user_id, 5 as w from public.reviews
            where status = 'approved' and created_at >= p_from and created_at < p_to
          union all
          select user_id, 2 from public.blog_comments
            where status = 'visible' and created_at >= p_from and created_at < p_to
          union all
          select user_id, 1 from public.blog_post_likes
            where created_at >= p_from and created_at < p_to
          union all
          select user_id, (case when p_board = 'top_community' then 3 else 1 end)
            from public.vendor_follows
            where created_at >= p_from and created_at < p_to
        ) u
        where u.user_id is not null
        group by u.user_id
      ) s
      left join public.profiles pr on pr.id = s.user_id
      order by s.score desc, s.user_id
      limit p_limit
    ) r;
  end if;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public._leaderboard_live(text, timestamptz, timestamptz, integer, uuid, boolean) from public;
revoke execute on function public._leaderboard_live(text, timestamptz, timestamptz, integer, uuid, boolean) from anon, authenticated;
grant execute on function public._leaderboard_live(text, timestamptz, timestamptz, integer, uuid, boolean) to service_role;


-- -----------------------------------------------------------------------------
-- Public leaderboard read.
-- -----------------------------------------------------------------------------
create or replace function public.leaderboard(
  p_board text,
  p_period text default 'current',
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_from timestamptz;
  v_to timestamptz;
  v_complete_month boolean := false;
  v_label text;
  v_frozen boolean := false;
  v_rows jsonb;
  v_uid uuid := auth.uid();
begin
  if p_board not in ('top_sellers', 'top_buyers', 'top_affiliates',
                     'top_engagers', 'most_followed_creators', 'top_community') then
    raise exception 'Unknown leaderboard board: %', p_board using errcode = '22023';
  end if;

  if p_period is null or p_period = 'current' then
    v_from := date_trunc('month', now());
    v_to := now();
    v_label := to_char(now(), 'YYYY-MM');
  elsif p_period = 'all_time' then
    v_from := timestamptz '1970-01-01';
    v_to := now() + interval '1 second';
    v_label := 'all_time';
  elsif p_period ~ '^\d{4}-\d{2}$' then
    v_from := to_timestamp(p_period || '-01', 'YYYY-MM-DD');
    v_to := v_from + interval '1 month';
    v_complete_month := v_to <= date_trunc('month', now());
    v_label := p_period;
  else
    raise exception 'Bad period % (use current, all_time, or YYYY-MM)', p_period using errcode = '22023';
  end if;

  if v_complete_month and exists (
    select 1 from public.leaderboard_snapshots where board = p_board and period = p_period
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'rank', s.rank,
      'name', s.display_name,
      'value', s.metric_value,
      'vendor_id', s.subject_vendor_id,
      'user_id', case when s.subject_user_id = v_uid then s.subject_user_id else null end,
      'slug', v.slug,
      'avatar_url', v.logo_url,
      'is_viewer', (s.subject_user_id = v_uid) or (v.user_id = v_uid)
    ) order by s.rank), '[]'::jsonb)
    into v_rows
    from public.leaderboard_snapshots s
    left join public.vendors v on v.id = s.subject_vendor_id
    where s.board = p_board and s.period = p_period and s.rank <= v_limit;
    v_frozen := true;
  else
    v_rows := public._leaderboard_live(p_board, v_from, v_to, v_limit, v_uid, false);
  end if;

  return jsonb_build_object(
    'board', p_board,
    'period', v_label,
    'from', v_from,
    'to', v_to,
    'frozen', v_frozen,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.leaderboard(text, text, integer) from public;
grant execute on function public.leaderboard(text, text, integer) to anon, authenticated;


-- -----------------------------------------------------------------------------
-- Freeze a finished month + award the monthly-winner badges. Idempotent:
-- skips a month that already has snapshots unless p_force (which rebuilds it).
-- Locked to service_role — invoked by pg_cron and by the admin RPC in part 3.
-- -----------------------------------------------------------------------------
create or replace function public.close_month_leaderboards(
  p_period text default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_period text := coalesce(p_period, to_char(date_trunc('month', now()) - interval '1 day', 'YYYY-MM'));
  v_from timestamptz;
  v_to timestamptz;
  v_board text;
  v_boards text[] := array['top_sellers', 'top_buyers', 'top_affiliates',
                           'top_engagers', 'most_followed_creators', 'top_community'];
  v_rows jsonb;
  v_row jsonb;
  v_winner_user uuid;
  v_winner_vendor uuid;
  v_badge_key text;
  v_count integer := 0;
  v_zero uuid := '00000000-0000-0000-0000-000000000000';
  v_has_rewards boolean := exists (
    select 1 from pg_proc where proname = 'grant_reward_for_achievement'
      and pronamespace = 'public'::regnamespace
  );
begin
  if v_period !~ '^\d{4}-\d{2}$' then
    raise exception 'Bad period %', v_period using errcode = '22023';
  end if;
  v_from := to_timestamp(v_period || '-01', 'YYYY-MM-DD');
  v_to := v_from + interval '1 month';

  if exists (select 1 from public.leaderboard_snapshots where period = v_period) then
    if not p_force then
      return jsonb_build_object('period', v_period, 'status', 'skipped', 'reason', 'already closed');
    end if;
    delete from public.leaderboard_snapshots where period = v_period;
  end if;

  foreach v_board in array v_boards loop
    v_rows := public._leaderboard_live(v_board, v_from, v_to, 100, v_zero, true);

    for v_row in select value from jsonb_array_elements(v_rows) loop
      insert into public.leaderboard_snapshots
        (board, period, rank, subject_user_id, subject_vendor_id, display_name, metric_value, context)
      values (
        v_board, v_period, (v_row->>'rank')::int,
        nullif(v_row->>'user_id', '')::uuid,
        nullif(v_row->>'vendor_id', '')::uuid,
        coalesce(v_row->>'name', 'DigiStore member'),
        coalesce((v_row->>'value')::numeric, 0),
        jsonb_build_object('board', v_board, 'period', v_period)
      )
      on conflict (board, period, rank) do nothing;
      v_count := v_count + 1;
    end loop;

    -- rank 1 → "… of the Month" badge (+ perk, if part 3 is deployed).
    -- top_community is a secondary view of engagement; it gets a snapshot but
    -- shares no auto-badge (top_engagers already awards the engager badge).
    v_badge_key := case v_board
      when 'top_sellers'            then 'seller_of_the_month'
      when 'most_followed_creators' then 'creator_of_the_month'
      when 'top_buyers'             then 'buyer_of_the_month'
      when 'top_affiliates'         then 'affiliate_of_the_month'
      when 'top_engagers'           then 'engager_of_the_month'
      else null
    end;

    if v_badge_key is not null then
      select value into v_row
      from jsonb_array_elements(v_rows)
      where (value->>'rank')::int = 1
      limit 1;

      if v_row is not null then
        v_winner_user := nullif(v_row->>'user_id', '')::uuid;
        v_winner_vendor := nullif(v_row->>'vendor_id', '')::uuid;
        if v_winner_user is null and v_winner_vendor is not null then
          select user_id into v_winner_user from public.vendors where id = v_winner_vendor;
        end if;

        if v_winner_user is not null then
          insert into public.user_achievements (user_id, achievement_key, metric_value, context)
          values (v_winner_user, v_badge_key, coalesce((v_row->>'value')::numeric, 0),
                  jsonb_build_object('board', v_board, 'period', v_period, 'rank', 1))
          on conflict (user_id, achievement_key) do nothing;

          if v_has_rewards then
            perform public.grant_reward_for_achievement(v_winner_user, v_badge_key, v_period, v_board);
          end if;
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'period', v_period,
    'status', 'closed',
    'snapshot_rows', v_count
  );
end;
$$;

revoke all on function public.close_month_leaderboards(text, boolean) from public;
revoke execute on function public.close_month_leaderboards(text, boolean) from anon, authenticated;
grant execute on function public.close_month_leaderboards(text, boolean) to service_role;


-- =============================================================================
-- RLS
-- =============================================================================
alter table public.leaderboard_snapshots enable row level security;

drop policy if exists "public read leaderboard snapshots" on public.leaderboard_snapshots;
create policy "public read leaderboard snapshots" on public.leaderboard_snapshots
for select to anon, authenticated
using (true);

drop policy if exists "admins manage leaderboard snapshots" on public.leaderboard_snapshots;
create policy "admins manage leaderboard snapshots" on public.leaderboard_snapshots
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select on public.leaderboard_snapshots to anon, authenticated;
grant select, insert, update, delete on public.leaderboard_snapshots to authenticated;


-- =============================================================================
-- Schedule the monthly close. pg_cron runs the SQL directly — no Edge
-- Function, no secret. If pg_cron is not enabled on the project this block is a
-- no-op; wire it by hand in Supabase Dashboard → Integrations → Cron with
--   select public.close_month_leaderboards();
-- on "10 0 1 * *" (00:10 on the 1st, closes the month that just ended).
-- =============================================================================
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'recognition-close-month') then
      perform cron.unschedule('recognition-close-month');
    end if;
    perform cron.schedule('recognition-close-month', '10 0 1 * *',
      $cron$select public.close_month_leaderboards();$cron$);
  end if;
end $$;
