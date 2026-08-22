create extension if not exists pgcrypto;
create extension if not exists citext;

do $$ begin create type public.app_role as enum ('customer','admin'); exception when duplicate_object then null; end $$;
do $$ begin create type public.order_status as enum ('pending','paid','failed','refunded','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.ticket_status as enum ('open','pending','closed'); exception when duplicate_object then null; end $$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(), slug text unique not null, title text not null, description text, price numeric(12,2) not null check (price >= 0), currency text not null default 'USD', cover_url text, file_path text not null, is_published boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade, full_name text not null, phone text, address text, gender text, country text, occupation text, age integer check(age is null or age between 13 and 120), role public.app_role not null default 'customer', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  product_id uuid not null references public.products(id),
  customer_email citext not null,
  amount numeric(12,2) not null default 0,
  currency text not null default 'USD',
  provider text,
  provider_transaction_id text,
  provider_reference text unique,
  status public.order_status not null default 'pending',
  download_token_hash text,
  download_expires_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.orders add column if not exists promo_code text;
alter table public.orders add column if not exists discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0);

create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code citext unique not null,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric(12,2) not null check (discount_value > 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  max_redemptions integer,
  redemption_count integer not null default 0 check (redemption_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.quote_promo(p_code text, p_product_id uuid)
returns table(valid boolean, code text, discount_amount numeric, message text)
language plpgsql
security definer set search_path = public
as $$
declare promo public.promo_codes; product_price numeric;
begin
  select price into product_price from public.products where id = p_product_id and is_published = true;
  select * into promo from public.promo_codes where promo_codes.code = p_code and is_active = true and starts_at <= now() and (ends_at is null or ends_at > now()) and (max_redemptions is null or redemption_count < max_redemptions);
  if product_price is null then return query select false, null::text, 0::numeric, 'Product is unavailable.'; return; end if;
  if promo.id is null then return query select false, null::text, 0::numeric, 'That promotion code is not available.'; return; end if;
  return query select true, promo.code::text, least(product_price, case when promo.discount_type = 'percent' then round(product_price * promo.discount_value / 100, 2) else promo.discount_value end), 'Promotion applied.';
end;
$$;
grant execute on function public.quote_promo(text, uuid) to anon, authenticated;

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  subscribed_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text,
  email citext not null,
  order_ref text,
  category text not null default 'Other',
  subject text not null,
  message text not null,
  status public.ticket_status not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  id integer primary key default 1,
  site_title text,
  support_email citext,
  announcement text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  excerpt text,
  content text not null,
  cover_url text,
  source_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.search_index_queue (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'blog_post')),
  entity_id uuid not null,
  operation text not null default 'upsert' check (operation in ('upsert', 'delete')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create or replace function public.queue_search_index()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.search_index_queue(entity_type, entity_id, operation) values (tg_argv[0], old.id, 'delete');
    return old;
  end if;
  insert into public.search_index_queue(entity_type, entity_id, operation) values (tg_argv[0], new.id, 'upsert');
  return new;
end; $$;
drop trigger if exists products_search_index on public.products;
create trigger products_search_index after insert or update or delete on public.products for each row execute procedure public.queue_search_index('product');
drop trigger if exists blog_posts_search_index on public.blog_posts;
create trigger blog_posts_search_index after insert or update or delete on public.blog_posts for each row execute procedure public.queue_search_index('blog_post');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), 'Customer')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.products enable row level security;
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.subscribers enable row level security;
alter table public.tickets enable row level security;
alter table public.site_settings enable row level security;
alter table public.promo_codes enable row level security;
alter table public.blog_posts enable row level security;
alter table public.search_index_queue enable row level security;

drop policy if exists "published products are public" on public.products;
drop policy if exists "users read own profile" on public.profiles;
drop policy if exists "users insert own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;
drop policy if exists "users read own orders" on public.orders;
drop policy if exists "users create own pending orders" on public.orders;
drop policy if exists "admins manage products" on public.products;
drop policy if exists "public can subscribe" on public.subscribers;
drop policy if exists "admins read subscribers" on public.subscribers;
drop policy if exists "public can create tickets" on public.tickets;
drop policy if exists "owners/admins read tickets" on public.tickets;
drop policy if exists "admins update tickets" on public.tickets;
drop policy if exists "admins manage cms" on public.site_settings;
drop policy if exists "admins manage promotion codes" on public.promo_codes;
drop policy if exists "public read published blogs" on public.blog_posts;
drop policy if exists "admins manage blogs" on public.blog_posts;
drop policy if exists "admins manage search queue" on public.search_index_queue;

create policy "published products are public" on public.products for select using (is_published = true or auth.uid() in (select id from public.profiles where role='admin'));
create policy "users read own profile" on public.profiles for select using (auth.uid()=id or auth.uid() in (select id from public.profiles where role='admin'));
create policy "users insert own profile" on public.profiles for insert with check (auth.uid()=id);
create policy "users update own profile" on public.profiles for update using (auth.uid()=id or auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid()=id or auth.uid() in (select id from public.profiles where role='admin'));
create policy "users read own orders" on public.orders for select using (auth.uid()=user_id or auth.uid() in (select id from public.profiles where role='admin'));
create policy "users create own pending orders" on public.orders for insert with check (auth.uid()=user_id and status='pending');
create policy "admins manage products" on public.products for all using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));
create policy "public can subscribe" on public.subscribers for insert with check (true);
create policy "admins read subscribers" on public.subscribers for select using (auth.uid() in (select id from public.profiles where role='admin'));
create policy "public can create tickets" on public.tickets for insert with check (true);
create policy "owners/admins read tickets" on public.tickets for select using (auth.uid()=user_id or auth.uid() in (select id from public.profiles where role='admin'));
create policy "admins update tickets" on public.tickets for update using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));
create policy "admins manage cms" on public.site_settings for all using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));
create policy "admins manage promotion codes" on public.promo_codes for all using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));
create policy "public read published blogs" on public.blog_posts for select using (status = 'published' or auth.uid() in (select id from public.profiles where role='admin'));
create policy "admins manage blogs" on public.blog_posts for all using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));
create policy "admins manage search queue" on public.search_index_queue for all using (auth.uid() in (select id from public.profiles where role='admin')) with check (auth.uid() in (select id from public.profiles where role='admin'));

insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;
