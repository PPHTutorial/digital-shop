-- =============================================================================
-- Server-side enforcement of product delivery rules
--
-- The product create/update path is a direct RLS-guarded insert from the
-- browser (js/vendor.js, js/admin.js). Until now the file-size cap, the
-- file-type allowlist, the "archive must not be a wrapper around external
-- links" rule and the ad-wallet minimum lived ONLY in that browser code. This
-- migration moves all four into a BEFORE INSERT/UPDATE trigger so they hold no
-- matter what writes the row.
--
--   * file_type must be in a fixed allowlist
--   * a published hosted file must declare a size within site_settings.max_product_file_bytes
--   * a published .zip / .apk must have a stored scan verdict of 'ok'
--     (written by the inspect-product-archive Edge Function into archive_scans)
--   * an is_ad listing going pending/active requires the seller's ad wallet to
--     hold >= site_settings.ad_min_wallet_balance (platform / no-wallet exempt)
--
-- The checks only fire when delivery fields actually change or the row is being
-- published, so editing price/title/flags on a legacy row is never blocked.
-- =============================================================================

-- --- Settings ------------------------------------------------------------
alter table public.site_settings
  add column if not exists max_product_file_bytes bigint not null default 5242880
  check (max_product_file_bytes > 0);

comment on column public.site_settings.max_product_file_bytes is
  'Largest hosted product file a published listing may declare (bytes). Default 5 MiB.';

-- --- Archive scan results ---------------------------------------------
-- Keyed by file_path, not product id: the Edge Function scans the uploaded
-- file before the product row exists, and one file is only ever scanned once.
create table if not exists public.archive_scans (
  file_path text primary key,
  verdict text not null check (verdict in ('ok', 'external_wrapper', 'error')),
  detail text,
  scanned_by uuid references auth.users(id) on delete set null,
  scanned_at timestamptz not null default now()
);

alter table public.archive_scans enable row level security;

drop policy if exists "archive scans readable" on public.archive_scans;
create policy "archive scans readable"
on public.archive_scans for select to authenticated
using (true);
-- Rows are written only by record_archive_scan() (definer, service_role).

create or replace function public.record_archive_scan(
  p_file_path text,
  p_verdict text,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
begin
  if p_verdict not in ('ok', 'external_wrapper', 'error') then
    raise exception 'Unknown scan verdict %.', p_verdict using errcode = '22023';
  end if;

  insert into public.archive_scans (file_path, verdict, detail, scanned_by)
  values (p_file_path, p_verdict, p_detail, auth.uid())
  on conflict (file_path) do update
    set verdict = excluded.verdict,
        detail = excluded.detail,
        scanned_by = excluded.scanned_by,
        scanned_at = now();

  return jsonb_build_object('file_path', p_file_path, 'verdict', p_verdict);
end;
$$;

revoke all on function public.record_archive_scan(text, text, text) from public;
revoke all on function public.record_archive_scan(text, text, text) from authenticated, anon;
grant execute on function public.record_archive_scan(text, text, text) to service_role;


-- --- The enforcement trigger --------------------------------------
create or replace function public.enforce_product_delivery_rules()
returns trigger
language plpgsql
set search_path = public as $$
declare
  v_type text := lower(coalesce(new.file_type, ''));
  v_cap bigint;
  v_min numeric(12, 2);
  v_balance numeric(12, 2);
  v_hosted boolean;
  v_is_archive boolean;
  v_published boolean := coalesce(new.is_published, false);
  v_delivery_touched boolean;
  v_became_ad boolean;
begin
  v_delivery_touched := tg_op = 'INSERT'
    or new.file_path is distinct from old.file_path
    or new.file_type is distinct from old.file_type
    or new.file_size_bytes is distinct from old.file_size_bytes
    or new.is_ad is distinct from old.is_ad
    or new.external_url is distinct from old.external_url
    or (v_published and not coalesce(old.is_published, false));

  if not v_delivery_touched then
    return new;
  end if;

  v_hosted := coalesce(new.is_ad, false) = false
              and new.file_path is not null
              and new.file_path !~* '^https?://';
  v_is_archive := v_type in ('zip', 'apk');

  -- file_type allowlist — only enforced for a published hosted file, so legacy
  -- rows with a null / odd type are untouched until someone republishes them.
  -- LINK is the sentinel for an is_ad listing.
  if (v_published and v_hosted and v_type <> '') or coalesce(new.is_ad, false) then
    if v_type not in (
      'link',
      'png', 'webp', 'jpg', 'jpeg', 'gif',
      'zip', 'apk',
      'pdf', 'doc', 'docx', 'epub'
    ) then
      raise exception 'File type "%" is not allowed. Use an image, PDF, DOCX, EPUB, ZIP or APK, or publish it as an external link.', new.file_type
        using errcode = '22023';
    end if;
  end if;

  -- Size: a published hosted file must declare a sane size within the cap.
  if v_hosted and v_published then
    select max_product_file_bytes into v_cap from public.site_settings where id = 1;
    v_cap := coalesce(v_cap, 5242880);

    if new.file_size_bytes is null or new.file_size_bytes <= 0 then
      raise exception 'The product file size is missing — re-upload the file.' using errcode = '22023';
    end if;
    if new.file_size_bytes > v_cap then
      raise exception 'The product file is % bytes; the limit is % bytes. Compress it or host it as an external link.',
        new.file_size_bytes, v_cap using errcode = '22023';
    end if;
  end if;

  -- Archive: a published .zip / .apk must have cleared the link-wrapper scan.
  if v_hosted and v_is_archive and v_published then
    if not exists (
      select 1 from public.archive_scans s
      where s.file_path = new.file_path and s.verdict = 'ok'
    ) then
      raise exception 'This archive has not passed inspection yet, or it looks like a wrapper around external links. Publish the real file, or use External link mode.'
        using errcode = '22023';
    end if;
  end if;

  -- Ad-wallet minimum when a listing becomes an ad (insert as ad, or flipped).
  v_became_ad := coalesce(new.is_ad, false)
                 and coalesce(new.ad_status, 'none') in ('pending', 'active')
                 and (
                   tg_op = 'INSERT'
                   or coalesce(old.is_ad, false) = false
                   or coalesce(old.ad_status, 'none') not in ('pending', 'active')
                 );

  if v_became_ad and new.vendor_id is not null then
    select balance into v_balance from public.ad_wallets where vendor_id = new.vendor_id;
    if v_balance is not null then
      select ad_min_wallet_balance into v_min from public.site_settings where id = 1;
      v_min := coalesce(v_min, 100);
      if v_balance < v_min then
        raise exception 'Your ad wallet holds % but external-link listings need at least %. Top up first.',
          to_char(v_balance, 'FM999990.00'), to_char(v_min, 'FM999990.00')
          using errcode = '22023';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists products_delivery_rules on public.products;
create trigger products_delivery_rules
before insert or update on public.products
for each row execute procedure public.enforce_product_delivery_rules();


-- --- Grandfather existing rows ----------------------------------
-- Existing published archives predate the scanner; trust them so their next
-- edit does not trip the new gate. New uploads still get scanned.
insert into public.archive_scans (file_path, verdict, detail)
select distinct p.file_path, 'ok', 'grandfathered at 20260831140000'
from public.products p
where p.file_path is not null
  and p.file_path !~* '^https?://'
  and lower(coalesce(p.file_type, '')) in ('zip', 'apk')
on conflict (file_path) do nothing;
