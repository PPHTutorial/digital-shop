-- =============================================================================
-- Store & account settings — extra data fields
--
--  1. public.vendors: legal / tax identity, contact details, storefront
--     policies, and a social-links map. (banner_url / website_url / support_email
--     already exist from the marketplace migration.)
--  2. public.profiles: date of birth, billing / invoice details, timezone, and
--     per-channel email notification opt-ins. (avatar_url / locale /
--     preferred_currency / marketing_opt_in already exist from core hardening.)
--  3. A public "avatars" storage bucket, writable by each user only under their
--     own "{uid}/…" path prefix.
--
-- RLS: both tables already carry row-level "update own row" policies, which
-- cover the new columns — no policy changes needed for (1) and (2).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Store settings (public.vendors)
-- ---------------------------------------------------------------------------
alter table public.vendors add column if not exists legal_name text;
alter table public.vendors add column if not exists tax_id text;
alter table public.vendors add column if not exists business_address text;
alter table public.vendors add column if not exists support_phone text;
alter table public.vendors add column if not exists support_hours text;
alter table public.vendors add column if not exists return_policy text;
alter table public.vendors add column if not exists terms text;
alter table public.vendors add column if not exists social_links jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. Account settings (public.profiles)
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists date_of_birth date
  check (date_of_birth is null or date_of_birth > date '1900-01-01');
alter table public.profiles add column if not exists company_name text;
alter table public.profiles add column if not exists vat_number text;
alter table public.profiles add column if not exists billing_address text;
alter table public.profiles add column if not exists timezone text;
alter table public.profiles add column if not exists notify_product_news boolean not null default true;
alter table public.profiles add column if not exists notify_order_updates boolean not null default true;

-- ---------------------------------------------------------------------------
-- 3. Avatar storage bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "avatars are public" on storage.objects;
create policy "avatars are public"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'avatars');

drop policy if exists "users upload own avatar" on storage.objects;
create policy "users upload own avatar"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users update own avatar" on storage.objects;
create policy "users update own avatar"
on storage.objects
for update
to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "users delete own avatar" on storage.objects;
create policy "users delete own avatar"
on storage.objects
for delete
to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
