-- =============================================================================
-- External-link listings (ad placements)
--
-- A product's "delivery" can now be EITHER an uploaded file (file_path) OR an
-- external URL (external_url). A listing that resolves to an external
-- destination rather than a file hosted by DigiStore is an ad placement:
-- `is_ad` is set, it goes through `ad_status`, and (on the seller side) it is
-- funded from the vendor ad wallet. The storefront shows a "leaving DigiStore"
-- interstitial before following one.
--
-- `file_path` was NOT NULL since the original schema; every existing row has a
-- real file, so relaxing it is safe and the new CHECK still guarantees each
-- listing has one delivery mechanism or the other.
-- =============================================================================

alter table public.products add column if not exists external_url text
  check (external_url is null or external_url ~* '^https?://.+');
alter table public.products add column if not exists is_ad boolean not null default false;
alter table public.products add column if not exists ad_status text not null default 'none'
  check (ad_status in ('none', 'pending', 'active', 'rejected', 'paused'));

alter table public.products alter column file_path drop not null;

alter table public.products drop constraint if exists products_delivery_present;
alter table public.products add constraint products_delivery_present
  check (file_path is not null or external_url is not null);

-- An ad listing carries a link and no file; a normal listing carries a file.
alter table public.products drop constraint if exists products_ad_shape;
alter table public.products add constraint products_ad_shape check (
  (is_ad and external_url is not null and file_path is null)
  or (not is_ad and external_url is null)
);

create index if not exists products_is_ad_idx on public.products (is_ad) where is_ad;

comment on column public.products.external_url is 'Destination for an ad/external-link listing; mutually exclusive with file_path.';
comment on column public.products.is_ad is 'True when the listing points to an external destination rather than a hosted file.';
comment on column public.products.ad_status is 'Review/billing state for is_ad listings.';
