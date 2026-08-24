-- =============================================================================
-- Content store
--
-- A schema-less document table with an explicit draft/published split, full
-- revision history, and an asset registry. Field shapes are declared in
-- js/studio/schema.js and validated there and in the `cms` Edge Function; the
-- database enforces identity, ownership, and history.
--
-- Two payload columns rather than two rows:
--   draft      — always present, always the working copy
--   published  — the snapshot the storefront reads; null until first publish
-- `status` is derived from those two by trigger, so a list query can filter on
-- it with an index instead of comparing jsonb at read time.
-- =============================================================================

do $$ begin
  create type public.cms_status as enum ('draft', 'published', 'changed', 'unpublished');
exception when duplicate_object then null; end $$;

create table if not exists public.cms_documents (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  slug text,
  title text not null default 'Untitled',
  locale text not null default 'en',
  draft jsonb not null default '{}'::jsonb,
  published jsonb,
  status public.cms_status not null default 'draft',
  version integer not null default 1,
  ordering integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text text
);

create unique index if not exists cms_documents_slug_idx
  on public.cms_documents (type, locale, slug)
  where slug is not null;

create index if not exists cms_documents_type_idx on public.cms_documents (type, updated_at desc);
create index if not exists cms_documents_status_idx on public.cms_documents (type, status, ordering);
create index if not exists cms_documents_published_idx on public.cms_documents (type, published_at desc)
  where published is not null;
create index if not exists cms_documents_search_idx on public.cms_documents using gin (search_text gin_trgm_ops);

create table if not exists public.cms_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.cms_documents(id) on delete cascade,
  version integer not null,
  action text not null check (action in ('create', 'save', 'publish', 'unpublish', 'restore', 'duplicate')),
  snapshot jsonb not null,
  title text,
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  created_at timestamptz not null default now()
);

create index if not exists cms_revisions_document_idx on public.cms_revisions (document_id, created_at desc);

create table if not exists public.cms_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'product-images',
  path text not null,
  url text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  width integer,
  height integer,
  alt text,
  caption text,
  tags text[] not null default '{}',
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (bucket, path)
);

create index if not exists cms_assets_created_idx on public.cms_assets (created_at desc);
create index if not exists cms_assets_filename_idx on public.cms_assets using gin (filename gin_trgm_ops);

-- A soft lock. It warns a second editor rather than blocking them, which is
-- the right trade-off for a small team: stale locks cannot wedge a document.
create table if not exists public.cms_locks (
  document_id uuid primary key references public.cms_documents(id) on delete cascade,
  holder_id uuid not null references auth.users(id) on delete cascade,
  holder_name text,
  acquired_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Derived status and search text
-- -----------------------------------------------------------------------------

create or replace function public.cms_sync_derived()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.status := case
    when new.published is null and new.draft is null then 'draft'::public.cms_status
    when new.published is null then 'draft'::public.cms_status
    when new.draft is null then 'published'::public.cms_status
    when new.draft = new.published then 'published'::public.cms_status
    else 'changed'::public.cms_status
  end;

  -- A flat, lowercase projection of every string leaf, for trigram search.
  new.search_text := lower(
    coalesce(new.title, '') || ' ' ||
    coalesce(new.slug, '') || ' ' ||
    coalesce(
      (select string_agg(value, ' ')
       from jsonb_each_text(case when jsonb_typeof(new.draft) = 'object' then new.draft else '{}'::jsonb end)
       where length(value) < 2000),
      ''
    )
  );

  return new;
end;
$$;

drop trigger if exists cms_documents_derive on public.cms_documents;
create trigger cms_documents_derive
  before insert or update on public.cms_documents
  for each row execute function public.cms_sync_derived();

select public.attach_touch_trigger('public.cms_documents');

-- -----------------------------------------------------------------------------
-- Write API
--
-- The studio never writes cms_documents directly. Every mutation goes through
-- one of these functions so that revision history and optimistic locking
-- cannot be bypassed by a hand-rolled PostgREST call.
-- -----------------------------------------------------------------------------

create or replace function public.cms_record_revision(
  p_document_id uuid,
  p_action text,
  p_snapshot jsonb,
  p_title text,
  p_version integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cms_revisions (document_id, version, action, snapshot, title, actor_id, actor_email)
  values (
    p_document_id,
    p_version,
    p_action,
    coalesce(p_snapshot, '{}'::jsonb),
    p_title,
    auth.uid(),
    (select email from auth.users where id = auth.uid())
  );

  -- Keep the tail bounded: the 50 most recent revisions per document.
  delete from public.cms_revisions r
  where r.document_id = p_document_id
    and r.id not in (
      select id from public.cms_revisions
      where document_id = p_document_id
      order by created_at desc
      limit 50
    );
end;
$$;

create or replace function public.cms_save(
  p_id uuid,
  p_type text,
  p_draft jsonb,
  p_title text default null,
  p_slug text default null,
  p_expected_version integer default null,
  p_locale text default 'en'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.cms_documents;
  v_action text := 'save';
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required to edit content.' using errcode = '42501';
  end if;

  if p_type is null or length(trim(p_type)) = 0 then
    raise exception 'A document type is required.' using errcode = '22023';
  end if;

  if p_id is not null then
    select * into v_doc from public.cms_documents d where d.id = p_id;
  end if;

  if v_doc.id is null then
    insert into public.cms_documents (id, type, slug, title, locale, draft, created_by, updated_by)
    values (
      coalesce(p_id, gen_random_uuid()),
      p_type,
      nullif(trim(coalesce(p_slug, '')), ''),
      coalesce(nullif(trim(coalesce(p_title, '')), ''), 'Untitled'),
      coalesce(p_locale, 'en'),
      coalesce(p_draft, '{}'::jsonb),
      auth.uid(),
      auth.uid()
    )
    returning * into v_doc;
    v_action := 'create';
  else
    if p_expected_version is not null and p_expected_version <> v_doc.version then
      raise exception
        'This document was changed elsewhere (expected version %, found %). Reload before saving.',
        p_expected_version, v_doc.version
        using errcode = '40001';
    end if;

    update public.cms_documents d
    set draft = coalesce(p_draft, d.draft),
        title = coalesce(nullif(trim(coalesce(p_title, '')), ''), d.title),
        slug = case when p_slug is null then d.slug else nullif(trim(p_slug), '') end,
        locale = coalesce(p_locale, d.locale),
        version = d.version + 1,
        updated_by = auth.uid()
    where d.id = p_id
    returning * into v_doc;
  end if;

  perform public.cms_record_revision(v_doc.id, v_action, v_doc.draft, v_doc.title, v_doc.version);
  return to_jsonb(v_doc);
end;
$$;

create or replace function public.cms_publish(p_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.cms_documents;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required to publish content.' using errcode = '42501';
  end if;

  select * into v_doc from public.cms_documents d where d.id = p_id;
  if v_doc.id is null then
    raise exception 'Document % does not exist.', p_id using errcode = 'P0002';
  end if;

  if p_expected_version is not null and p_expected_version <> v_doc.version then
    raise exception 'This document was changed elsewhere. Reload before publishing.' using errcode = '40001';
  end if;

  update public.cms_documents d
  set published = d.draft,
      published_at = now(),
      published_by = auth.uid(),
      version = d.version + 1,
      updated_by = auth.uid()
  where d.id = p_id
  returning * into v_doc;

  perform public.cms_record_revision(v_doc.id, 'publish', v_doc.published, v_doc.title, v_doc.version);
  perform public.record_audit('cms.publish', v_doc.type, v_doc.id::text, format('Published "%s"', v_doc.title));
  return to_jsonb(v_doc);
end;
$$;

create or replace function public.cms_unpublish(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.cms_documents;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  update public.cms_documents d
  set published = null,
      published_at = null,
      published_by = null,
      version = d.version + 1,
      updated_by = auth.uid()
  where d.id = p_id
  returning * into v_doc;

  if v_doc.id is null then
    raise exception 'Document % does not exist.', p_id using errcode = 'P0002';
  end if;

  -- The derived status collapses to 'draft'; record the intent explicitly.
  update public.cms_documents set status = 'unpublished'::public.cms_status where id = p_id;

  perform public.cms_record_revision(v_doc.id, 'unpublish', v_doc.draft, v_doc.title, v_doc.version);
  perform public.record_audit('cms.unpublish', v_doc.type, v_doc.id::text, format('Unpublished "%s"', v_doc.title));
  return to_jsonb(v_doc);
end;
$$;

create or replace function public.cms_restore(p_id uuid, p_revision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.cms_documents;
  v_revision public.cms_revisions;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select * into v_revision from public.cms_revisions r where r.id = p_revision_id and r.document_id = p_id;
  if v_revision.id is null then
    raise exception 'That revision does not belong to this document.' using errcode = 'P0002';
  end if;

  update public.cms_documents d
  set draft = v_revision.snapshot,
      title = coalesce(v_revision.title, d.title),
      version = d.version + 1,
      updated_by = auth.uid()
  where d.id = p_id
  returning * into v_doc;

  perform public.cms_record_revision(v_doc.id, 'restore', v_doc.draft, v_doc.title, v_doc.version);
  perform public.record_audit('cms.restore', v_doc.type, v_doc.id::text,
    format('Restored "%s" to a revision from %s', v_doc.title, v_revision.created_at));
  return to_jsonb(v_doc);
end;
$$;

create or replace function public.cms_duplicate(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.cms_documents;
  v_copy public.cms_documents;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select * into v_source from public.cms_documents d where d.id = p_id;
  if v_source.id is null then
    raise exception 'Document % does not exist.', p_id using errcode = 'P0002';
  end if;

  insert into public.cms_documents (type, slug, title, locale, draft, ordering, created_by, updated_by)
  values (
    v_source.type,
    case when v_source.slug is null then null else left(v_source.slug || '-copy', 96) end,
    left(v_source.title || ' (copy)', 200),
    v_source.locale,
    v_source.draft,
    v_source.ordering,
    auth.uid(),
    auth.uid()
  )
  returning * into v_copy;

  perform public.cms_record_revision(v_copy.id, 'duplicate', v_copy.draft, v_copy.title, v_copy.version);
  return to_jsonb(v_copy);
end;
$$;

create or replace function public.cms_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.cms_documents;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select * into v_doc from public.cms_documents d where d.id = p_id;
  if v_doc.id is null then return; end if;

  perform public.record_audit('cms.delete', v_doc.type, v_doc.id::text, format('Deleted "%s"', v_doc.title));
  delete from public.cms_documents where id = p_id;
end;
$$;

create or replace function public.cms_reorder(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  update public.cms_documents d
  set ordering = position.idx
  from (select unnest(p_ids) as id, generate_subscripts(p_ids, 1) as idx) position
  where d.id = position.id;
end;
$$;

-- Takes or refreshes the soft lock. Returns whoever currently holds it.
create or replace function public.cms_claim_lock(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock public.cms_locks;
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  delete from public.cms_locks where refreshed_at < now() - interval '3 minutes';

  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.cms_locks (document_id, holder_id, holder_name)
  values (p_id, auth.uid(), coalesce(v_name, 'An editor'))
  on conflict (document_id) do update
    set refreshed_at = now(),
        holder_id = case when public.cms_locks.holder_id = auth.uid() then auth.uid() else public.cms_locks.holder_id end
  returning * into v_lock;

  return jsonb_build_object(
    'held_by_me', v_lock.holder_id = auth.uid(),
    'holder_name', v_lock.holder_name,
    'acquired_at', v_lock.acquired_at
  );
end;
$$;

create or replace function public.cms_release_lock(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.cms_locks where document_id = p_id and holder_id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.cms_save(uuid, text, jsonb, text, text, integer, text)',
    'public.cms_publish(uuid, integer)',
    'public.cms_unpublish(uuid)',
    'public.cms_restore(uuid, uuid)',
    'public.cms_duplicate(uuid)',
    'public.cms_delete(uuid)',
    'public.cms_reorder(uuid[])',
    'public.cms_claim_lock(uuid)',
    'public.cms_release_lock(uuid)',
    'public.cms_record_revision(uuid, text, jsonb, text, integer)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Row-level security
--
-- Anonymous readers see published documents only, and only of the types the
-- storefront actually renders. Everything else is admin-only.
-- -----------------------------------------------------------------------------

alter table public.cms_documents enable row level security;
alter table public.cms_revisions enable row level security;
alter table public.cms_assets enable row level security;
alter table public.cms_locks enable row level security;

drop policy if exists "public read published documents" on public.cms_documents;
create policy "public read published documents"
on public.cms_documents
for select
to anon, authenticated
using (
  public.is_admin()
  or (published is not null and type in ('page', 'post', 'author', 'faq', 'announcement', 'legal', 'navigation', 'homepage'))
);

drop policy if exists "admins write documents" on public.cms_documents;
create policy "admins write documents"
on public.cms_documents
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admins read revisions" on public.cms_revisions;
create policy "admins read revisions"
on public.cms_revisions
for select
to authenticated
using (public.is_admin());

drop policy if exists "public read assets" on public.cms_assets;
create policy "public read assets"
on public.cms_assets
for select
to anon, authenticated
using (true);

drop policy if exists "admins manage assets" on public.cms_assets;
create policy "admins manage assets"
on public.cms_assets
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admins read locks" on public.cms_locks;
create policy "admins read locks"
on public.cms_locks
for select
to authenticated
using (public.is_admin());

-- -----------------------------------------------------------------------------
-- Storage policies for the media bucket
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "public read media" on storage.objects;
create policy "public read media"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'product-images');

drop policy if exists "admins write media" on storage.objects;
create policy "admins write media"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admins update media" on storage.objects;
create policy "admins update media"
on storage.objects
for update
to authenticated
using (bucket_id = 'product-images' and public.is_admin())
with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "admins delete media" on storage.objects;
create policy "admins delete media"
on storage.objects
for delete
to authenticated
using (bucket_id = 'product-images' and public.is_admin());

-- The private file bucket stays closed: downloads are served only through the
-- download-book Edge Function using a short-lived signed URL.
drop policy if exists "admins manage protected files" on storage.objects;
create policy "admins manage protected files"
on storage.objects
for all
to authenticated
using (bucket_id = 'books' and public.is_admin())
with check (bucket_id = 'books' and public.is_admin());
