-- =============================================================================
-- Vendor storage access + dashboard aggregate
--
-- Storage was admin-only, so an approved vendor could not upload a cover image
-- or a deliverable. Vendors are granted write access scoped to their own
-- folder: <bucket>/vendors/<vendor_id>/...
--
-- The private `books` bucket stays unreadable to everyone. Vendors may write
-- their own deliverables but cannot read them back out of storage directly —
-- delivery continues to run only through the download-book function, so a
-- vendor can never fetch a file belonging to someone else's product.
-- =============================================================================

-- Path helper: true when `name` sits under vendors/<caller's vendor id>/.
create or replace function public.storage_path_is_own_vendor(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, storage as $$
  select
    public.current_vendor_id() is not null
    and (storage.foldername(object_name))[1] = 'vendors'
    and (storage.foldername(object_name))[2] = public.current_vendor_id()::text;
$$;

revoke all on function public.storage_path_is_own_vendor(text) from public;
grant execute on function public.storage_path_is_own_vendor(text) to authenticated;


-- --- Public media bucket: vendors write within their own folder --------------
drop policy if exists "vendors write own media" on storage.objects;
create policy "vendors write own media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-images'
  and public.is_approved_vendor()
  and public.storage_path_is_own_vendor(name)
);

drop policy if exists "vendors update own media" on storage.objects;
create policy "vendors update own media"
on storage.objects
for update
to authenticated
using (bucket_id = 'product-images' and public.storage_path_is_own_vendor(name))
with check (bucket_id = 'product-images' and public.storage_path_is_own_vendor(name));

drop policy if exists "vendors delete own media" on storage.objects;
create policy "vendors delete own media"
on storage.objects
for delete
to authenticated
using (bucket_id = 'product-images' and public.storage_path_is_own_vendor(name));


-- --- Private file bucket: write-only, still never readable --------------------
drop policy if exists "vendors write own files" on storage.objects;
create policy "vendors write own files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'books'
  and public.is_approved_vendor()
  and public.storage_path_is_own_vendor(name)
);

drop policy if exists "vendors update own files" on storage.objects;
create policy "vendors update own files"
on storage.objects
for update
to authenticated
using (bucket_id = 'books' and public.storage_path_is_own_vendor(name))
with check (bucket_id = 'books' and public.storage_path_is_own_vendor(name));

drop policy if exists "vendors delete own files" on storage.objects;
create policy "vendors delete own files"
on storage.objects
for delete
to authenticated
using (bucket_id = 'books' and public.storage_path_is_own_vendor(name));


-- =============================================================================
-- Dashboard aggregate
--
-- One round trip for everything the vendor overview shows. SECURITY DEFINER but
-- scoped hard to the caller's own vendor id, so it can never read another
-- vendor's figures.
-- =============================================================================
create or replace function public.vendor_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_vendor uuid := public.current_vendor_id();
  v_result jsonb;
begin
  if v_vendor is null then
    return jsonb_build_object('is_vendor', false);
  end if;

  select jsonb_build_object(
    'is_vendor', true,
    'vendor', (
      select to_jsonb(x) from (
        select id, display_name, slug, bio, logo_url, banner_url, country,
               payout_currency, status, commission_rate, total_sales_count,
               total_gross, total_net, applied_at, approved_at
        from public.vendors where id = v_vendor
      ) x
    ),
    'balance', (
      select jsonb_build_object(
        'available', coalesce(sum(net_amount) filter (where status = 'available' and payout_id is null), 0),
        'pending',   coalesce(sum(net_amount) filter (where status = 'pending'), 0),
        'paid',      coalesce(sum(net_amount) filter (where status = 'paid'), 0),
        'lifetime',  coalesce(sum(net_amount) filter (where status <> 'reversed'), 0),
        'commission',coalesce(sum(commission_amount) filter (where status <> 'reversed'), 0),
        'currency',  coalesce(min(currency), 'USD')
      )
      from public.vendor_earnings where vendor_id = v_vendor
    ),
    'counts', jsonb_build_object(
      'products',           (select count(*) from public.products where vendor_id = v_vendor),
      'published_products', (select count(*) from public.products where vendor_id = v_vendor and is_published),
      'sales',              (select count(*) from public.vendor_earnings where vendor_id = v_vendor),
      'campaigns',          (select count(*) from public.ad_campaigns where vendor_id = v_vendor and status = 'active'),
      'payout_accounts',    (select count(*) from public.payout_accounts where vendor_id = v_vendor)
    ),
    'recent_sales', (
      select coalesce(jsonb_agg(s order by s.created_at desc), '[]'::jsonb)
      from (
        select e.id, e.gross_amount, e.net_amount, e.commission_amount, e.currency,
               e.status, e.created_at, e.available_at, p.title
        from public.vendor_earnings e
        left join public.products p on p.id = e.product_id
        where e.vendor_id = v_vendor
        order by e.created_at desc
        limit 10
      ) s
    ),
    -- Last 30 days of net revenue, for the dashboard sparkline.
    'daily_net', (
      select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
      from (
        select date_trunc('day', created_at)::date as day, sum(net_amount) as net
        from public.vendor_earnings
        where vendor_id = v_vendor and created_at > now() - interval '30 days'
        group by 1
      ) d
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.vendor_dashboard() from public;
grant execute on function public.vendor_dashboard() to authenticated;


-- Public storefront for one vendor: approved vendors and their live products.
create or replace function public.vendor_storefront(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select jsonb_build_object(
    'vendor', (
      select to_jsonb(v) from (
        select id, display_name, slug, bio, logo_url, banner_url, country,
               total_sales_count, approved_at
        from public.vendors
        where slug = p_slug and status = 'approved'
      ) v
    ),
    'products', (
      select coalesce(jsonb_agg(p order by p.created_at desc), '[]'::jsonb)
      from (
        select pr.id, pr.slug, pr.title, pr.short_description, pr.description,
               pr.price, pr.original_price, pr.currency, pr.cover_url, pr.category,
               pr.file_type, pr.file_size_bytes, pr.purchase_count,
               pr.rating_sum, pr.rating_count, pr.is_featured, pr.created_at
        from public.products pr
        join public.vendors vv on vv.id = pr.vendor_id
        where vv.slug = p_slug and vv.status = 'approved' and pr.is_published
      ) p
    )
  );
$$;

revoke all on function public.vendor_storefront(text) from public;
grant execute on function public.vendor_storefront(text) to anon, authenticated;
