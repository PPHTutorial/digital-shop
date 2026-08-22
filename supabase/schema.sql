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

alter table public.products enable row level security;
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.subscribers enable row level security;
alter table public.tickets enable row level security;
alter table public.site_settings enable row level security;

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

insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;