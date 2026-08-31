-- =============================================================================
-- Marketplace admin extras
--
--  1. Wider product file-type allowlist — audio, video, docs, fonts, design,
--     3D, subtitles, e-books, more image + archive formats. zip/apk still need
--     the inspect-product-archive scan verdict; everything else is allowed
--     outright (subject to the size cap). Dangerous executables stay blocked.
--  2. Payout-account verification — vendors' bank / MoMo / PayPal / crypto
--     destinations are reviewed by an admin before a withdrawal can be sent to
--     them. request_payout() now refuses an unverified account, and the
--     moderation queue gains a 'payout_accounts' bucket.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Product file-type allowlist
-- ---------------------------------------------------------------------------
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

  -- Enforced for a published hosted file (legacy rows with a null / odd type
  -- are left alone until someone republishes them) and for every is_ad row.
  -- 'link' is the sentinel for an is_ad listing.
  if (v_published and v_hosted and v_type <> '') or coalesce(new.is_ad, false) then
    -- Executables and scripts are never a valid digital-download product here.
    if v_type in (
      'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'cpl', 'dll',
      'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'ps1', 'psm1', 'sh', 'run',
      'app', 'deb', 'rpm', 'jar', 'lnk', 'reg'
    ) then
      raise exception 'Executable and script files ("%") cannot be sold as downloads. Package the assets in a ZIP, or publish an external link.', new.file_type
        using errcode = '22023';
    end if;

    if v_type not in (
      'link',
      -- images
      'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'tif', 'tiff',
      'heic', 'heif', 'ico', 'avif',
      -- raw photo
      'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2',
      -- audio
      'mp3', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'ogg', 'oga', 'opus',
      'aiff', 'aif', 'wma', 'mid', 'midi',
      -- video
      'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg',
      -- documents
      'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'tex', 'pages',
      'xls', 'xlsx', 'ods', 'csv', 'numbers',
      'ppt', 'pptx', 'odp', 'key',
      -- e-books
      'epub', 'mobi', 'azw3', 'azw', 'fb2', 'ibooks',
      -- design / creative
      'psd', 'psb', 'ai', 'eps', 'indd', 'idml', 'sketch', 'fig', 'xd',
      'afdesign', 'afphoto', 'afpub', 'procreate', 'clip', 'kra', 'xcf',
      'lut', 'cube', 'abr', 'brushset', 'aseprite',
      -- fonts
      'ttf', 'otf', 'woff', 'woff2', 'eot',
      -- 3D / CAD
      'stl', 'obj', 'fbx', 'blend', '3ds', 'dae', 'gltf', 'glb', 'ply',
      'dwg', 'dxf', 'skp', 'c4d', '3mf',
      -- data / notebooks / markup
      'json', 'xml', 'yaml', 'yml', 'html', 'css', 'ipynb', 'sql',
      -- subtitles
      'srt', 'vtt', 'ass', 'ssa',
      -- archives (zip/apk are scan-gated below)
      'zip', 'apk', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'
    ) then
      raise exception 'File type "%" is not supported. Package it in a ZIP, or publish it as an external link.', new.file_type
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


-- ---------------------------------------------------------------------------
-- 2. Payout-account verification
-- ---------------------------------------------------------------------------
alter table public.payout_accounts
  add column if not exists verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected'));
alter table public.payout_accounts
  add column if not exists verification_note text;
alter table public.payout_accounts
  add column if not exists verified_by uuid references auth.users(id) on delete set null;

comment on column public.payout_accounts.verification_status is
  'Admin review state. A withdrawal can only be sent to a verified account.';

-- Bring the existing boolean into line with the new state column.
update public.payout_accounts
  set verification_status = case when is_verified then 'verified' else 'pending' end
  where verification_status = 'pending';


create or replace function public.review_payout_account(
  p_account_id uuid,
  p_approve boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  a public.payout_accounts;
begin
  if not public.admin_has_permission('manage_users') then
    raise exception 'You do not have permission to review payout accounts.' using errcode = '42501';
  end if;

  select * into a from public.payout_accounts where id = p_account_id for update;
  if a.id is null then
    raise exception 'That payout account does not exist.' using errcode = '22023';
  end if;

  update public.payout_accounts
  set verification_status = case when p_approve then 'verified' else 'rejected' end,
      is_verified = p_approve,
      verified_at = case when p_approve then now() else null end,
      verified_by = auth.uid(),
      verification_note = p_note,
      updated_at = now()
  where id = a.id;

  return jsonb_build_object('id', a.id, 'verification_status', case when p_approve then 'verified' else 'rejected' end);
end;
$$;

revoke all on function public.review_payout_account(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.review_payout_account(uuid, boolean, text) to authenticated;


-- request_payout(): body unchanged from 20260826130000 except the chosen
-- account must now be verified.
create or replace function public.request_payout(p_payout_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_currency text;
  v_amount numeric(12, 2);
  v_payout uuid;
  v_verified text;
begin
  if v_vendor is null then
    raise exception 'Only vendors can request a payout.' using errcode = '42501';
  end if;

  perform public.assert_account_active();

  select verification_status into v_verified
  from public.payout_accounts
  where id = p_payout_account_id and vendor_id = v_vendor;

  if v_verified is null then
    raise exception 'That payout account does not belong to you.' using errcode = '42501';
  end if;
  if v_verified <> 'verified' then
    raise exception 'That payout account is still being reviewed. Withdrawals open once it is verified.' using errcode = '22023';
  end if;

  select coalesce(sum(net_amount), 0), coalesce(min(currency), 'USD')
    into v_amount, v_currency
  from public.vendor_earnings
  where vendor_id = v_vendor
    and status = 'available'
    and payout_id is null;

  if v_amount <= 0 then
    raise exception 'You have no matured earnings to withdraw yet.' using errcode = '22023';
  end if;

  insert into public.payouts (vendor_id, payout_account_id, amount, currency)
  values (v_vendor, p_payout_account_id, v_amount, v_currency)
  returning id into v_payout;

  update public.vendor_earnings
  set payout_id = v_payout
  where vendor_id = v_vendor and status = 'available' and payout_id is null;

  return jsonb_build_object('payout_id', v_payout, 'amount', v_amount, 'currency', v_currency);
end;
$$;

revoke all on function public.request_payout(uuid) from public, anon, authenticated;
grant execute on function public.request_payout(uuid) to authenticated;


-- moderation_queue(): body unchanged from 20260831130000 plus a
-- 'payout_accounts' bucket for accounts awaiting verification.
create or replace function public.moderation_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'vendors', (
      select coalesce(jsonb_agg(v order by v.applied_at), '[]'::jsonb) from (
        select id, display_name, slug, bio, country, payout_currency, status,
               commission_rate, applied_at, total_sales_count
        from public.vendors where status = 'pending'
      ) v
    ),
    'campaigns', (
      select coalesce(jsonb_agg(c order by c.created_at), '[]'::jsonb) from (
        select ca.id, ca.name, ca.placement, ca.budget, ca.currency, ca.starts_at, ca.ends_at,
               ca.cpm_rate, ca.cpc_rate, ca.cpa_percent, ca.created_at,
               p.title as product_title, v.display_name as vendor_name,
               w.balance as wallet_balance
        from public.ad_campaigns ca
        join public.vendors v on v.id = ca.vendor_id
        left join public.products p on p.id = ca.product_id
        left join public.ad_wallets w on w.vendor_id = ca.vendor_id
        where ca.review_status = 'pending'
      ) c
    ),
    'ad_listings', (
      select coalesce(jsonb_agg(a order by a.created_at), '[]'::jsonb) from (
        select p.id, p.title, p.slug, p.external_url, p.short_description,
               p.price, p.currency, p.created_at,
               v.display_name as vendor_name,
               w.balance as wallet_balance,
               (select ad_listing_deposit from public.site_settings where id = 1) as deposit
        from public.products p
        join public.vendors v on v.id = p.vendor_id
        left join public.ad_wallets w on w.vendor_id = p.vendor_id
        where p.is_ad and p.ad_status = 'pending'
      ) a
    ),
    'payout_accounts', (
      select coalesce(jsonb_agg(pa order by pa.created_at), '[]'::jsonb) from (
        select p.id, p.method, p.country, p.currency, p.account_name, p.account_last4,
               p.bank_name, p.momo_provider, p.paypal_email, p.crypto_asset, p.created_at,
               v.display_name as vendor_name
        from public.payout_accounts p
        join public.vendors v on v.id = p.vendor_id
        where p.verification_status = 'pending'
      ) pa
    ),
    'topups', (
      select coalesce(jsonb_agg(t order by t.created_at), '[]'::jsonb) from (
        select tr.id, tr.amount, tr.currency, tr.note, tr.created_at,
               v.display_name as vendor_name
        from public.ad_topup_requests tr
        join public.vendors v on v.id = tr.vendor_id
        where tr.status = 'pending'
      ) t
    ),
    'payouts', (
      select coalesce(jsonb_agg(p order by p.requested_at), '[]'::jsonb) from (
        select po.id, po.amount, po.currency, po.status, po.requested_at,
               v.display_name as vendor_name,
               pa.method, pa.account_name, pa.account_last4, pa.bank_name, pa.momo_provider,
               pa.verification_status
        from public.payouts po
        join public.vendors v on v.id = po.vendor_id
        left join public.payout_accounts pa on pa.id = po.payout_account_id
        where po.status in ('requested', 'processing')
      ) p
    )
  );
end;
$$;

revoke all on function public.moderation_queue() from public;
grant execute on function public.moderation_queue() to authenticated;
