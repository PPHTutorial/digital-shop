-- =============================================================================
-- Core hardening
--
-- Shared helper functions, updated_at discipline, an append-only audit trail,
-- and the profile columns the new account and console screens depend on.
--
-- Every statement is written to be safe to re-run.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- unaccent is not enabled on every project tier, so fold the common Latin-1
-- range by hand rather than making the whole migration depend on it.
create or replace function public.unaccent_fallback(p_input text)
returns text
language sql
immutable
strict
as $$
  select translate(
    p_input,
    'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿŠšŽž',
    'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyySsZz'
  );
$$;

-- Mirrors slugify() in js/format.js. Both must stay in step; a unit test
-- asserts the two produce identical output for a shared fixture list.
-- Apostrophes are dropped rather than converted, so "O'Brien" becomes
-- "obrien" and not "o-brien".
create or replace function public.slugify(p_input text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select left(
    trim(both '-' from regexp_replace(
      regexp_replace(lower(public.unaccent_fallback(p_input)), '[''’]', '', 'g'),
      '[^a-z0-9]+', '-', 'g'
    )),
    96
  );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attaches the updated_at trigger to a table without repeating boilerplate.
create or replace function public.attach_touch_trigger(p_table regclass)
returns void
language plpgsql
as $$
declare
  trigger_name text := 'touch_' || replace(p_table::text, 'public.', '') || '_updated_at';
begin
  execute format('drop trigger if exists %I on %s', trigger_name, p_table);
  execute format(
    'create trigger %I before update on %s for each row execute function public.touch_updated_at()',
    trigger_name, p_table
  );
end;
$$;

select public.attach_touch_trigger('public.products');
select public.attach_touch_trigger('public.categories');
select public.attach_touch_trigger('public.profiles');
select public.attach_touch_trigger('public.blog_posts');

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists locale text not null default 'en';
alter table public.profiles add column if not exists preferred_currency text not null default 'USD';
alter table public.profiles add column if not exists marketing_opt_in boolean not null default false;
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- Backfills the profile row for any auth user created before the trigger
-- existed, so the console never shows an order without a customer.
insert into public.profiles (id, full_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1), 'Customer')
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Audit trail
--
-- Append-only. Readable by admins, writable only by SECURITY DEFINER helpers,
-- so an admin cannot quietly rewrite the record of what they changed.
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  entity_type text not null,
  entity_id text,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id, created_at desc);

create or replace function public.record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id text default null,
  p_summary text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.audit_log (actor_id, actor_email, action, entity_type, entity_id, summary, metadata)
  values (
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    p_action,
    p_entity_type,
    p_entity_id,
    p_summary,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_audit(text, text, text, text, jsonb) from public;
grant execute on function public.record_audit(text, text, text, text, jsonb) to authenticated;

alter table public.audit_log enable row level security;

drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log"
on public.audit_log
for select
to authenticated
using (public.is_admin());

-- -----------------------------------------------------------------------------
-- Indexes the existing tables were missing
-- -----------------------------------------------------------------------------

create index if not exists products_published_idx on public.products (is_published, created_at desc);
create index if not exists products_category_idx on public.products (category) where is_published;
create index if not exists products_slug_idx on public.products (slug);
create index if not exists products_title_trgm_idx on public.products using gin (title gin_trgm_ops);

create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);
create index if not exists orders_product_idx on public.orders (product_id);
create index if not exists orders_paid_idx on public.orders (paid_at desc) where status = 'paid';
create index if not exists orders_email_idx on public.orders (customer_email);

create index if not exists tickets_status_idx on public.tickets (status, created_at desc);
create index if not exists blog_posts_published_idx on public.blog_posts (status, published_at desc);
create index if not exists categories_active_idx on public.categories (is_active, sort_order);

-- -----------------------------------------------------------------------------
-- Site settings: one row, richer shape
-- -----------------------------------------------------------------------------

alter table public.site_settings add column if not exists tagline text;
alter table public.site_settings add column if not exists social jsonb not null default '{}'::jsonb;
alter table public.site_settings add column if not exists announcement_active boolean not null default false;
alter table public.site_settings add column if not exists announcement_ends_at timestamptz;
alter table public.site_settings add column if not exists default_currency text not null default 'USD';
alter table public.site_settings add column if not exists checkout_note text;

insert into public.site_settings (id, site_title, support_email)
values (1, 'DigiStore', 'hello@codeinktechnologies.com')
on conflict (id) do nothing;

-- The storefront needs to read the public parts of the settings row.
drop policy if exists "public read site settings" on public.site_settings;
create policy "public read site settings"
on public.site_settings
for select
to anon, authenticated
using (true);
