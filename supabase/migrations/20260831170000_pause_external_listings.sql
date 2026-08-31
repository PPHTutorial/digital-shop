-- =============================================================================
-- Pause external-link ("ad") listings
--
-- Sellers (and admins) may not CREATE new external-link listings until the
-- feature is ready. Existing is_ad rows are untouched — they stay editable and
-- removable, and the storefront still handles them via CONFIG.ADS_LIVE.
--
--   * site_settings.external_listings_open — the master switch (default FALSE)
--   * a BEFORE INSERT/UPDATE trigger on products rejects any write that turns a
--     row into an is_ad listing while the switch is off
--
-- The client mirrors this with CONFIG.EXTERNAL_LISTINGS_OPEN (js/config.js):
-- flip BOTH back on together when the feature reopens.
-- =============================================================================

alter table public.site_settings
  add column if not exists external_listings_open boolean not null default false;

comment on column public.site_settings.external_listings_open is
  'When false, no new external-link (is_ad) product listings may be created. Existing ones are unaffected.';

create or replace function public.enforce_external_listings_open()
returns trigger
language plpgsql
set search_path = public as $$
declare
  v_open boolean;
begin
  -- Only a write that turns a row INTO an external-link listing is gated;
  -- editing (or removing) an existing is_ad row stays allowed.
  if coalesce(new.is_ad, false)
     and (tg_op = 'INSERT' or coalesce(old.is_ad, false) = false)
  then
    select external_listings_open into v_open from public.site_settings where id = 1;
    if not coalesce(v_open, false) then
      raise exception 'External-link listings are paused — new ones cannot be created right now.'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists products_external_listings_open on public.products;
create trigger products_external_listings_open
before insert or update on public.products
for each row execute procedure public.enforce_external_listings_open();
