-- =============================================================================
-- Blog engagement: likes, saves (bookmarks), and threaded comments.
--
-- The journal article view had no engagement surface at all beyond reading —
-- no way to like, save for later, or discuss a post. These three tables give
-- it the same shape as the rest of the marketplace (wishlist_items/reviews
-- already do this for products): small join tables keyed on (post, user),
-- read through a single bundled RPC so the article page stays one round trip.
-- =============================================================================

create table if not exists public.blog_post_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.blog_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create index if not exists blog_post_likes_post_idx on public.blog_post_likes (post_id);

create table if not exists public.blog_post_saves (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.blog_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create index if not exists blog_post_saves_user_idx on public.blog_post_saves (user_id, created_at desc);

create table if not exists public.blog_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.blog_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.blog_comments(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blog_comments_post_idx on public.blog_comments (post_id, status, created_at);
create index if not exists blog_comments_parent_idx on public.blog_comments (parent_id);

select public.attach_touch_trigger('public.blog_comments');

alter table public.blog_post_likes enable row level security;
alter table public.blog_post_saves enable row level security;
alter table public.blog_comments enable row level security;

-- Likes are a public signal (like counts elsewhere on the web) — anyone can
-- see who liked what, only the owner can create/remove their own row.
drop policy if exists "public read likes" on public.blog_post_likes;
create policy "public read likes"
on public.blog_post_likes for select
to anon, authenticated
using (true);

drop policy if exists "users manage own likes" on public.blog_post_likes;
create policy "users manage own likes"
on public.blog_post_likes for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Saves are personal bookmarks — only the owner (or an admin) can see their
-- own saved list.
drop policy if exists "users read own saves" on public.blog_post_saves;
create policy "users read own saves"
on public.blog_post_saves for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "users manage own saves" on public.blog_post_saves;
create policy "users manage own saves"
on public.blog_post_saves for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Comments: anyone can read visible ones; a signed-in reader can post their
-- own and edit/delete their own; admins can hide anything (moderation).
drop policy if exists "public read visible comments" on public.blog_comments;
create policy "public read visible comments"
on public.blog_comments for select
to anon, authenticated
using (status = 'visible' or user_id = auth.uid() or public.is_admin());

drop policy if exists "users create own comments" on public.blog_comments;
create policy "users create own comments"
on public.blog_comments for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "users update own comments" on public.blog_comments;
create policy "users update own comments"
on public.blog_comments for update
to authenticated
using (user_id = auth.uid() or public.is_admin())
with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "users delete own comments" on public.blog_comments;
create policy "users delete own comments"
on public.blog_comments for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

grant select on public.blog_post_likes to anon, authenticated;
grant select, insert, update, delete on public.blog_post_likes to authenticated;
grant select, insert, update, delete on public.blog_post_saves to authenticated;
grant select on public.blog_comments to anon, authenticated;
grant insert, update, delete on public.blog_comments to authenticated;

-- -----------------------------------------------------------------------------
-- One bundled read for the article page: like/comment counts, whether the
-- current viewer liked/saved it, and the comment tree with a public-safe
-- display name (mirrors product_detail()'s reviewer_name pattern, since
-- `profiles` itself is private).
-- -----------------------------------------------------------------------------
create or replace function public.blog_post_engagement(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with likes as (
    select count(*) as like_count,
           bool_or(user_id = auth.uid()) as viewer_liked
    from public.blog_post_likes
    where post_id = p_post_id
  ),
  saves as (
    select bool_or(user_id = auth.uid()) as viewer_saved
    from public.blog_post_saves
    where post_id = p_post_id and user_id = auth.uid()
  ),
  comments_base as (
    select c.id, c.parent_id, c.body, c.created_at, c.user_id,
           coalesce(pr.full_name, 'DigiStore reader') as author_name,
           (c.user_id = auth.uid()) as is_own
    from public.blog_comments c
    left join public.profiles pr on pr.id = c.user_id
    where c.post_id = p_post_id and (c.status = 'visible' or c.user_id = auth.uid() or public.is_admin())
    order by c.created_at asc
  )
  select jsonb_build_object(
    'like_count', (select coalesce(like_count, 0) from likes),
    'viewer_liked', (select coalesce(viewer_liked, false) from likes),
    'viewer_saved', (select coalesce(viewer_saved, false) from saves),
    'comment_count', (select count(*) from comments_base),
    'comments', (select coalesce(jsonb_agg(to_jsonb(comments_base)), '[]'::jsonb) from comments_base)
  );
$$;

grant execute on function public.blog_post_engagement(uuid) to anon, authenticated;
