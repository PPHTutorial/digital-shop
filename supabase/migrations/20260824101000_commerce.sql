-- =============================================================================
-- Commerce upgrade
--
--   * Richer product records (merchandising flags, SEO, file metadata).
--   * Denormalised sales counters so "best selling" and "trending" are real
--     numbers instead of an arbitrary slice of the catalog.
--   * Multi-item orders, a persisted cart, wishlists, and moderated reviews.
--   * Server-side order creation. The browser can no longer choose the price
--     it pays, which the previous insert policy allowed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Products
-- -----------------------------------------------------------------------------

alter table public.products add column if not exists short_description text;
alter table public.products add column if not exists is_featured boolean not null default false;
alter table public.products add column if not exists published_at timestamptz;
alter table public.products add column if not exists sort_order integer not null default 0;
alter table public.products add column if not exists tags text[] not null default '{}';
alter table public.products add column if not exists file_type text;
alter table public.products add column if not exists file_size_bytes bigint;
alter table public.products add column if not exists license_type text not null default 'single-seat';
alter table public.products add column if not exists delivery_note text;
alter table public.products add column if not exists seo jsonb not null default '{}'::jsonb;

-- Aggregates maintained by trigger. Public-readable: they carry no PII.
alter table public.products add column if not exists purchase_count integer not null default 0;
alter table public.products add column if not exists revenue_total numeric(14, 2) not null default 0;
alter table public.products add column if not exists view_count integer not null default 0;
alter table public.products add column if not exists rating_sum integer not null default 0;
alter table public.products add column if not exists rating_count integer not null default 0;
alter table public.products add column if not exists last_purchased_at timestamptz;

update public.products
set published_at = coalesce(published_at, created_at)
where is_published and published_at is null;

create index if not exists products_featured_idx on public.products (is_featured, sort_order) where is_published;
create index if not exists products_bestseller_idx on public.products (purchase_count desc) where is_published;
create index if not exists products_tags_idx on public.products using gin (tags);

-- Average rating is derived, never stored twice.
create or replace view public.product_ratings as
select
  id as product_id,
  rating_count,
  case when rating_count = 0 then null else round(rating_sum::numeric / rating_count, 2) end as rating_average
from public.products;

-- -----------------------------------------------------------------------------
-- Orders: human-readable reference and multi-item support
-- -----------------------------------------------------------------------------

create sequence if not exists public.order_number_seq start with 1000;

alter table public.orders add column if not exists order_no text;
alter table public.orders add column if not exists quantity integer not null default 1 check (quantity > 0);
alter table public.orders add column if not exists subtotal numeric(12, 2) not null default 0;
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_country text;
alter table public.orders add column if not exists billing jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists notes text;
alter table public.orders add column if not exists refunded_at timestamptz;
alter table public.orders add column if not exists updated_at timestamptz not null default now();

create or replace function public.assign_order_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.order_no is null then
    new.order_no := 'DS-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists orders_assign_number on public.orders;
create trigger orders_assign_number
  before insert on public.orders
  for each row execute function public.assign_order_number();

-- Legacy rows predate the sequence, so they get a distinct DS-LEG- prefix.
update public.orders o
set order_no = 'DS-LEG-' || lpad(numbered.seq::text, 5, '0')
from (
  select id, row_number() over (order by created_at, id) as seq
  from public.orders
  where order_no is null
) numbered
where o.id = numbered.id and o.order_no is null;

create unique index if not exists orders_order_no_idx on public.orders (order_no);

select public.attach_touch_trigger('public.orders');

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  title_snapshot text not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null default 1 check (quantity > 0),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  unique (order_id, product_id)
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

-- Backfills a line item for every legacy single-product order.
insert into public.order_items (order_id, product_id, title_snapshot, unit_price, quantity, currency)
select o.id, o.product_id, coalesce(p.title, 'Digital product'), o.amount, 1, o.currency
from public.orders o
join public.products p on p.id = o.product_id
left join public.order_items oi on oi.order_id = o.id
where oi.id is null
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Sales counters
-- -----------------------------------------------------------------------------

create or replace function public.sync_product_sales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  became_paid boolean := new.status = 'paid'::public.order_status
    and (tg_op = 'INSERT' or old.status is distinct from 'paid'::public.order_status);
  left_paid boolean := tg_op = 'UPDATE'
    and old.status = 'paid'::public.order_status
    and new.status is distinct from 'paid'::public.order_status;
begin
  if became_paid then
    update public.products p
    set purchase_count = p.purchase_count + oi.quantity,
        revenue_total = p.revenue_total + (oi.unit_price * oi.quantity),
        last_purchased_at = coalesce(new.paid_at, now())
    from public.order_items oi
    where oi.order_id = new.id and p.id = oi.product_id;

    if new.promo_code is not null then
      update public.promo_codes
      set redemption_count = redemption_count + 1
      where code = new.promo_code;
    end if;

  elsif left_paid then
    update public.products p
    set purchase_count = greatest(0, p.purchase_count - oi.quantity),
        revenue_total = greatest(0, p.revenue_total - (oi.unit_price * oi.quantity))
    from public.order_items oi
    where oi.order_id = new.id and p.id = oi.product_id;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_sync_product_sales on public.orders;
create trigger orders_sync_product_sales
  after insert or update of status on public.orders
  for each row execute function public.sync_product_sales();

-- Rebuilds the counters from scratch. Run after a bulk data fix.
create or replace function public.rebuild_product_sales()
returns void
language sql
security definer
set search_path = public
as $$
  update public.products p
  set purchase_count = coalesce(agg.units, 0),
      revenue_total = coalesce(agg.revenue, 0),
      last_purchased_at = agg.last_at
  from (
    select oi.product_id,
           sum(oi.quantity) as units,
           sum(oi.unit_price * oi.quantity) as revenue,
           max(o.paid_at) as last_at
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'paid'::public.order_status
    group by oi.product_id
  ) agg
  where agg.product_id = p.id;
$$;

revoke all on function public.rebuild_product_sales() from public;

-- -----------------------------------------------------------------------------
-- Cart — survives device changes, unlike localStorage
-- -----------------------------------------------------------------------------

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null default 1 check (quantity between 1 and 20),
  added_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create index if not exists cart_items_user_idx on public.cart_items (user_id, added_at desc);

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create index if not exists wishlist_items_user_idx on public.wishlist_items (user_id, added_at desc);

-- -----------------------------------------------------------------------------
-- Reviews — only verified buyers, and moderated before they appear
-- -----------------------------------------------------------------------------

do $$ begin
  create type public.review_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  rating smallint not null check (rating between 1 and 5),
  title text,
  body text,
  status public.review_status not null default 'pending',
  moderated_by uuid references auth.users(id),
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, user_id)
);

create index if not exists reviews_product_idx on public.reviews (product_id, status, created_at desc);
create index if not exists reviews_pending_idx on public.reviews (status, created_at desc);
select public.attach_touch_trigger('public.reviews');

create or replace function public.sync_product_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products p
  set rating_sum = coalesce(agg.total, 0),
      rating_count = coalesce(agg.n, 0)
  from (
    select sum(rating)::int as total, count(*)::int as n
    from public.reviews
    where product_id = target and status = 'approved'::public.review_status
  ) agg
  where p.id = target;
  return null;
end;
$$;

drop trigger if exists reviews_sync_rating on public.reviews;
create trigger reviews_sync_rating
  after insert or update or delete on public.reviews
  for each row execute function public.sync_product_rating();

-- -----------------------------------------------------------------------------
-- Download audit
-- -----------------------------------------------------------------------------

create table if not exists public.download_events (
  id bigint generated always as identity primary key,
  order_id uuid references public.orders(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  ip_hash text,
  user_agent text,
  succeeded boolean not null default true,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists download_events_order_idx on public.download_events (order_id, created_at desc);
create index if not exists download_events_created_idx on public.download_events (created_at desc);

-- -----------------------------------------------------------------------------
-- Server-side order creation
--
-- Prices, discounts, and currency all come from the database. The caller only
-- supplies which products they want.
-- -----------------------------------------------------------------------------

-- product_id becomes the "primary" line item and is filled in after pricing,
-- so it can no longer be NOT NULL at insert time.
alter table public.orders alter column product_id drop not null;

-- Returns jsonb rather than a composite so that no OUT parameter name can
-- collide with a column name inside the body.
create or replace function public.create_order(
  p_items jsonb,
  p_promo_code text default null,
  p_billing jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_name text;
  v_currency text := 'USD';
  v_subtotal numeric(12, 2) := 0;
  v_discount numeric(12, 2) := 0;
  v_order_id uuid;
  v_primary uuid;
  v_promo public.promo_codes;
  item jsonb;
  v_product public.products;
  v_qty integer;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Sign in before creating an order.' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one product is required.' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 20 then
    raise exception 'An order may contain at most 20 line items.' using errcode = '22023';
  end if;

  select email into v_email from auth.users where id = v_user;
  select full_name into v_name from public.profiles where id = v_user;

  insert into public.orders (user_id, product_id, customer_email, customer_name, amount, currency, status, billing)
  values (v_user, null, coalesce(v_email, 'unknown@invalid'), v_name, 0, v_currency, 'pending', coalesce(p_billing, '{}'::jsonb))
  returning id into v_order_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := greatest(1, least(20, coalesce((item ->> 'quantity')::int, 1)));

    select * into v_product
    from public.products
    where id = (item ->> 'product_id')::uuid and is_published = true;

    if v_product.id is null then
      raise exception 'Product % is not available for purchase.', item ->> 'product_id' using errcode = '22023';
    end if;

    if v_subtotal = 0 then
      v_currency := v_product.currency;
      v_primary := v_product.id;
    elsif v_product.currency <> v_currency then
      raise exception 'All items in an order must share one currency.' using errcode = '22023';
    end if;

    insert into public.order_items (order_id, product_id, title_snapshot, unit_price, quantity, currency)
    values (v_order_id, v_product.id, v_product.title, v_product.price, v_qty, v_product.currency)
    on conflict (order_id, product_id) do update set quantity = public.order_items.quantity + excluded.quantity;

    v_subtotal := v_subtotal + (v_product.price * v_qty);
  end loop;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo
    from public.promo_codes pc
    where pc.code = trim(p_promo_code)
      and pc.is_active
      and pc.starts_at <= now()
      and (pc.ends_at is null or pc.ends_at > now())
      and (pc.max_redemptions is null or pc.redemption_count < pc.max_redemptions);

    if v_promo.id is not null then
      v_discount := least(
        v_subtotal,
        case when v_promo.discount_type = 'percent'
          then round(v_subtotal * v_promo.discount_value / 100, 2)
          else v_promo.discount_value
        end
      );
    end if;
  end if;

  update public.orders o
  set product_id = v_primary,
      subtotal = v_subtotal,
      discount_amount = v_discount,
      amount = greatest(0, v_subtotal - v_discount),
      currency = v_currency,
      promo_code = case when v_discount > 0 then v_promo.code::text else null end,
      quantity = (select coalesce(sum(oi.quantity), 1) from public.order_items oi where oi.order_id = v_order_id)
  where o.id = v_order_id;

  select jsonb_build_object(
    'id', o.id,
    'order_no', o.order_no,
    'amount', o.amount,
    'currency', o.currency,
    'discount_amount', o.discount_amount,
    'subtotal', o.subtotal,
    'promo_code', o.promo_code,
    'status', o.status,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id,
        'title', oi.title_snapshot,
        'unit_price', oi.unit_price,
        'quantity', oi.quantity
      ) order by oi.created_at), '[]'::jsonb)
      from public.order_items oi where oi.order_id = o.id
    )
  )
  into v_result
  from public.orders o
  where o.id = v_order_id;

  perform public.record_audit('order.created', 'order', v_order_id::text,
    format('Order %s created for %s', v_result ->> 'order_no', v_email));

  return v_result;
end;
$$;

revoke all on function public.create_order(jsonb, text, jsonb) from public;
grant execute on function public.create_order(jsonb, text, jsonb) to authenticated;

-- Quotes a promotion against a basket subtotal rather than a single product.
create or replace function public.quote_promo_for_items(p_code text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric(12, 2) := 0;
  v_promo public.promo_codes;
  item jsonb;
  v_price numeric;
begin
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    select p.price into v_price from public.products p
    where p.id = (item ->> 'product_id')::uuid and p.is_published = true;
    if v_price is not null then
      v_subtotal := v_subtotal + v_price * greatest(1, coalesce((item ->> 'quantity')::int, 1));
    end if;
  end loop;

  if v_subtotal = 0 then
    return jsonb_build_object('valid', false, 'discount_amount', 0, 'subtotal', 0,
      'message', 'No purchasable items in the basket.');
  end if;

  select * into v_promo
  from public.promo_codes pc
  where pc.code = trim(p_code)
    and pc.is_active
    and pc.starts_at <= now()
    and (pc.ends_at is null or pc.ends_at > now())
    and (pc.max_redemptions is null or pc.redemption_count < pc.max_redemptions);

  if v_promo.id is null then
    return jsonb_build_object('valid', false, 'discount_amount', 0, 'subtotal', v_subtotal,
      'message', 'That promotion code is not available.');
  end if;

  return jsonb_build_object(
    'valid', true,
    'code', v_promo.code::text,
    'discount_amount', least(v_subtotal, case when v_promo.discount_type = 'percent'
      then round(v_subtotal * v_promo.discount_value / 100, 2)
      else v_promo.discount_value end),
    'subtotal', v_subtotal,
    'message', 'Promotion applied.'
  );
end;
$$;

grant execute on function public.quote_promo_for_items(text, jsonb) to anon, authenticated;

-- Records a catalog view without exposing the products table to writes.
create or replace function public.record_product_view(p_product_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.products set view_count = view_count + 1
  where id = p_product_id and is_published = true;
$$;

grant execute on function public.record_product_view(uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row-level security for the new tables
-- -----------------------------------------------------------------------------

alter table public.order_items enable row level security;
alter table public.cart_items enable row level security;
alter table public.wishlist_items enable row level security;
alter table public.reviews enable row level security;
alter table public.download_events enable row level security;

drop policy if exists "owners read order items" on public.order_items;
create policy "owners read order items"
on public.order_items
for select
to authenticated
using (
  public.is_admin()
  or exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
);

drop policy if exists "owners manage cart" on public.cart_items;
create policy "owners manage cart"
on public.cart_items
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "owners manage wishlist" on public.wishlist_items;
create policy "owners manage wishlist"
on public.wishlist_items
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "approved reviews are public" on public.reviews;
create policy "approved reviews are public"
on public.reviews
for select
to anon, authenticated
using (status = 'approved'::public.review_status or user_id = auth.uid() or public.is_admin());

-- Only a verified buyer may leave a review, and only in the pending state.
drop policy if exists "buyers write reviews" on public.reviews;
create policy "buyers write reviews"
on public.reviews
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'::public.review_status
  and exists (
    select 1 from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.user_id = auth.uid()
      and oi.product_id = reviews.product_id
      and o.status = 'paid'::public.order_status
  )
);

drop policy if exists "authors edit own pending reviews" on public.reviews;
create policy "authors edit own pending reviews"
on public.reviews
for update
to authenticated
using (public.is_admin() or (user_id = auth.uid() and status = 'pending'::public.review_status))
with check (public.is_admin() or (user_id = auth.uid() and status = 'pending'::public.review_status));

drop policy if exists "admins moderate reviews" on public.reviews;
drop policy if exists "owners or admins delete reviews" on public.reviews;
create policy "owners or admins delete reviews"
on public.reviews
for delete
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "admins read download events" on public.download_events;
create policy "admins read download events"
on public.download_events
for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

-- The browser must go through create_order(), which prices the basket itself.
drop policy if exists "users create own pending orders" on public.orders;

drop policy if exists "admins update orders" on public.orders;
create policy "admins update orders"
on public.orders
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
