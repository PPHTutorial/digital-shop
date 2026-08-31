-- =============================================================================
-- product_detail(): keep ad listings out of the "related products" rail.
--
-- The `prod` CTE already returns `p.*`, so `is_ad` / `external_url` / `ad_status`
-- (added in 20260827160000) now flow through to the page unchanged and power the
-- "Visit site" click-through CTA. Only the `related` rail needed a fix: it must
-- never surface an external-link listing as a recommendation. Single added
-- predicate: `and not rp.is_ad`. Function body is otherwise identical to
-- 20260826120000.
-- =============================================================================

create or replace function public.product_detail(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with prod as (
    select p.*,
      case when p.rating_count = 0 then null
           else round(p.rating_sum::numeric / p.rating_count, 2) end as rating_average
    from public.products p
    where p.slug = p_slug and p.is_published
    limit 1
  ),
  vend as (
    select v.display_name, v.slug as vendor_slug, v.logo_url
    from public.vendors v
    join prod on prod.vendor_id = v.id
  ),
  reviews_base as (
    select r.id, r.rating, r.title, r.body, r.created_at,
           coalesce(pr.full_name, 'Verified Buyer') as reviewer_name
    from public.reviews r
    join prod on prod.id = r.product_id
    left join public.profiles pr on pr.id = r.user_id
    where r.status = 'approved'::public.review_status
  ),
  breakdown as (
    select rating, count(*) as n from reviews_base group by rating
  ),
  related as (
    select rp.id, rp.slug, rp.title, rp.short_description, rp.price, rp.original_price,
           rp.currency, rp.cover_url, rp.is_featured, rp.purchase_count, rp.rating_count,
           case when rp.rating_count = 0 then null
                else round(rp.rating_sum::numeric / rp.rating_count, 2) end as rating_average
    from public.products rp, prod
    where rp.is_published and rp.category = prod.category and rp.id <> prod.id
      and not rp.is_ad
    order by rp.purchase_count desc, rp.created_at desc
    limit 4
  )
  select jsonb_build_object(
    'product', (select to_jsonb(prod) from prod),
    'vendor', (select to_jsonb(vend) from vend),
    'reviews', (select coalesce(jsonb_agg(to_jsonb(reviews_base) order by reviews_base.created_at desc), '[]'::jsonb) from reviews_base),
    'rating_breakdown', (select coalesce(jsonb_object_agg(breakdown.rating, breakdown.n), '{}'::jsonb) from breakdown),
    'related', (select coalesce(jsonb_agg(to_jsonb(related)), '[]'::jsonb) from related)
  );
$$;

grant execute on function public.product_detail(text) to anon, authenticated;
