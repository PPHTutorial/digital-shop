-- =============================================================================
-- Search and analytics
--
-- Catalog search moves from "fetch everything and filter in JavaScript" to a
-- ranked server-side query, and the console dashboard reads one aggregate
-- function instead of pulling 200 rows per table and summing them in the page.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Full-text search over products
-- -----------------------------------------------------------------------------

alter table public.products add column if not exists search_vector tsvector;

create or replace function public.products_build_search_vector()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.short_description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'D');
  return new;
end;
$$;

drop trigger if exists products_search_vector on public.products;
create trigger products_search_vector
  before insert or update of title, tags, category, short_description, description
  on public.products
  for each row execute function public.products_build_search_vector();

update public.products set updated_at = updated_at where search_vector is null;

create index if not exists products_search_vector_idx on public.products using gin (search_vector);

/**
 * Ranked catalog search with filtering, sorting, and a total count.
 *
 * Returns one jsonb object: { total, items: [...] }. A single round trip is
 * enough to render a page of results plus the pagination footer.
 */
create or replace function public.search_products(
  p_query text default null,
  p_category text default null,
  p_tags text[] default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_sort text default 'relevance',
  p_limit integer default 24,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_query tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 60);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_term text := nullif(trim(coalesce(p_query, '')), '');
  v_total integer;
  v_items jsonb;
begin
  if v_term is not null then
    -- websearch_to_tsquery tolerates the punctuation people actually type.
    v_query := websearch_to_tsquery('english', v_term);
  end if;

  -- Ranked once, then sliced. `ranked` carries the row number under the
  -- requested sort so the page can be taken without re-sorting, and
  -- jsonb_agg can restore the order it was taken in.
  with filtered as (
    select
      p.id, p.slug, p.title, p.short_description, p.description, p.category, p.tags,
      p.price, p.original_price, p.currency, p.cover_url, p.is_featured,
      p.purchase_count, p.view_count, p.rating_sum, p.rating_count,
      p.created_at, p.published_at,
      case
        when v_query is null then 0::real
        else ts_rank(p.search_vector, v_query) + similarity(p.title, v_term)
      end as rank
    from public.products p
    where p.is_published = true
      and (v_query is null or p.search_vector @@ v_query or p.title ilike '%' || v_term || '%')
      and (p_category is null or p_category = 'all' or lower(p.category) = lower(p_category))
      and (p_tags is null or cardinality(p_tags) = 0 or p.tags && p_tags)
      and (p_min_price is null or p.price >= p_min_price)
      and (p_max_price is null or p.price <= p_max_price)
  ),
  ranked as (
    select f.*, row_number() over (
      order by
        case when p_sort = 'relevance' then f.rank end desc nulls last,
        case when p_sort = 'newest' then f.created_at end desc nulls last,
        case when p_sort = 'price-asc' then f.price end asc nulls last,
        case when p_sort = 'price-desc' then f.price end desc nulls last,
        case when p_sort = 'best-selling' then f.purchase_count end desc nulls last,
        case when p_sort = 'title' then f.title end asc nulls last,
        f.created_at desc
    ) as position
    from filtered f
  )
  select
    (select count(*)::int from filtered),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'slug', r.slug,
      'title', r.title,
      'short_description', r.short_description,
      'description', r.description,
      'category', r.category,
      'tags', r.tags,
      'price', r.price,
      'original_price', r.original_price,
      'currency', r.currency,
      'cover_url', r.cover_url,
      'is_featured', r.is_featured,
      'purchase_count', r.purchase_count,
      'rating_count', r.rating_count,
      'rating_average', case when r.rating_count = 0 then null
                             else round(r.rating_sum::numeric / r.rating_count, 2) end,
      'created_at', r.created_at,
      'published_at', r.published_at
    ) order by r.position), '[]'::jsonb)
  into v_total, v_items
  from ranked r
  where r.position > v_offset and r.position <= v_offset + v_limit;

  return jsonb_build_object(
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.search_products(text, text, text[], numeric, numeric, text, integer, integer)
  to anon, authenticated;

/** Category counts for the catalog sidebar, in one query. */
create or replace function public.catalog_facets()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', category, 'count', n) order by n desc, category)
      from (
        select coalesce(nullif(trim(category), ''), 'General') as category, count(*)::int as n
        from public.products where is_published group by 1
      ) c
    ), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('name', tag, 'count', n) order by n desc, tag)
      from (
        select unnest(tags) as tag, count(*)::int as n
        from public.products where is_published group by 1 order by 2 desc limit 40
      ) t
    ), '[]'::jsonb),
    'price', coalesce((
      select jsonb_build_object('min', min(price), 'max', max(price))
      from public.products where is_published
    ), '{}'::jsonb),
    'total', (select count(*)::int from public.products where is_published)
  );
$$;

grant execute on function public.catalog_facets() to anon, authenticated;

/**
 * Curated storefront rails in a single call, so the home page makes one
 * request instead of ten client-side slices of the same array.
 */
create or replace function public.storefront_rails(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      p.id, p.slug, p.title, p.short_description, p.description, p.category, p.tags,
      p.price, p.original_price, p.currency, p.cover_url, p.is_featured,
      p.purchase_count, p.view_count, p.rating_count, p.created_at, p.published_at,
      case when p.rating_count = 0 then null
           else round(p.rating_sum::numeric / p.rating_count, 2) end as rating_average
    from public.products p
    where p.is_published
  )
  select jsonb_build_object(
    'featured', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base where is_featured order by created_at desc limit p_limit) x),
    'new', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base order by coalesce(published_at, created_at) desc limit p_limit) x),
    'best_selling', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base where purchase_count > 0 order by purchase_count desc limit p_limit) x),
    'trending', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base order by view_count desc, purchase_count desc limit p_limit) x),
    'deals', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base where original_price is not null and original_price > price
      order by (original_price - price) / nullif(original_price, 0) desc limit p_limit) x),
    'top_rated', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select * from base where rating_count >= 1 order by rating_average desc nulls last limit p_limit) x)
  );
$$;

grant execute on function public.storefront_rails(integer) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Console analytics
-- -----------------------------------------------------------------------------

/**
 * One aggregate call for the admin overview: totals for the window, the same
 * totals for the preceding window (so deltas are real), a daily revenue
 * series, and the leaderboards.
 */
create or replace function public.admin_overview(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from timestamptz := now() - make_interval(days => v_days);
  v_prev_from timestamptz := now() - make_interval(days => v_days * 2);
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'window_days', v_days,
    'current', (
      select jsonb_build_object(
        'revenue', coalesce(sum(amount) filter (where status = 'paid'), 0),
        'orders', count(*) filter (where status = 'paid'),
        'pending', count(*) filter (where status = 'pending'),
        'refunded', count(*) filter (where status = 'refunded'),
        'failed', count(*) filter (where status = 'failed'),
        'aov', coalesce(round(avg(amount) filter (where status = 'paid'), 2), 0)
      )
      from public.orders where created_at >= v_from
    ),
    'previous', (
      select jsonb_build_object(
        'revenue', coalesce(sum(amount) filter (where status = 'paid'), 0),
        'orders', count(*) filter (where status = 'paid')
      )
      from public.orders where created_at >= v_prev_from and created_at < v_from
    ),
    'lifetime', (
      select jsonb_build_object(
        'revenue', coalesce(sum(amount) filter (where status = 'paid'), 0),
        'orders', count(*) filter (where status = 'paid'),
        'customers', (select count(*) from public.profiles),
        'products', (select count(*) from public.products),
        'published_products', (select count(*) from public.products where is_published),
        'open_tickets', (select count(*) from public.tickets where status = 'open'),
        'pending_reviews', (select count(*) from public.reviews where status = 'pending')
      )
      from public.orders
    ),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', d::date,
        'revenue', coalesce(day.revenue, 0),
        'orders', coalesce(day.orders, 0)
      ) order by d), '[]'::jsonb)
      from generate_series(date_trunc('day', v_from), date_trunc('day', now()), interval '1 day') d
      left join lateral (
        select sum(amount) as revenue, count(*) as orders
        from public.orders o
        where o.status = 'paid' and date_trunc('day', o.created_at) = d
      ) day on true
    ),
    'top_products', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'units', t.units, 'revenue', t.revenue
      ) order by t.revenue desc), '[]'::jsonb)
      from (
        select p.id, p.title, sum(oi.quantity)::int as units, sum(oi.unit_price * oi.quantity) as revenue
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        join public.products p on p.id = oi.product_id
        where o.status = 'paid' and o.created_at >= v_from
        group by p.id, p.title
        order by revenue desc
        limit 8
      ) t
    ),
    'top_categories', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', t.category, 'revenue', t.revenue, 'units', t.units
      ) order by t.revenue desc), '[]'::jsonb)
      from (
        select coalesce(nullif(trim(p.category), ''), 'General') as category,
               sum(oi.unit_price * oi.quantity) as revenue,
               sum(oi.quantity)::int as units
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        join public.products p on p.id = oi.product_id
        where o.status = 'paid' and o.created_at >= v_from
        group by 1
        order by revenue desc
        limit 6
      ) t
    ),
    'payment_mix', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'provider', coalesce(provider, 'unknown'), 'orders', n, 'revenue', revenue
      ) order by revenue desc), '[]'::jsonb)
      from (
        select provider, count(*)::int as n, sum(amount) as revenue
        from public.orders
        where status = 'paid' and created_at >= v_from
        group by provider
      ) m
    ),
    'recent_activity', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'action', a.action, 'entity_type', a.entity_type, 'summary', a.summary,
        'actor', a.actor_email, 'at', a.created_at
      ) order by a.created_at desc), '[]'::jsonb)
      from (select * from public.audit_log order by created_at desc limit 12) a
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_overview(integer) from public;
grant execute on function public.admin_overview(integer) to authenticated;
