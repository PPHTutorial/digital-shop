-- Fix: quote_promo returned a bogus "valid" row for every invalid code.
--
-- In PL/pgSQL `return query` APPENDS to the result set and does not exit the
-- function. The guard clauses lost their bare `return;` statements when this
-- function was reformatted, so an unknown/expired code fell through to the
-- success branch and appended a second row:
--
--   row 1: valid=false, 'That promotion code is not available.'
--   row 2: valid=true,  discount_amount = the FULL product price
--
-- Row 2 reads as a 100% discount because `promo` is all NULLs there:
-- `case when NULL = 'percent' ... else promo.discount_value end` is NULL, and
-- `least(product_price, NULL)` is `product_price` — LEAST ignores NULLs.
--
-- Today's callers happen to read the first row, so nothing was mispriced. Any
-- caller using .single(), .maybeSingle(), or find(r => r.valid) would have
-- handed out free products. Restoring the early returns so exactly one row
-- comes back, which is what the `returns table` contract implies.
create or replace function public.quote_promo(p_code text, p_product_id uuid)
returns table(valid boolean, code text, discount_amount numeric, message text)
language plpgsql
security definer set search_path = public
as $$
declare
  promo public.promo_codes;
  product_price numeric;
begin
  select price
    into product_price
  from public.products
  where id = p_product_id
    and is_published = true;

  select *
    into promo
  from public.promo_codes
  where promo_codes.code = p_code
    and is_active = true
    and starts_at <= now()
    and (ends_at is null or ends_at > now())
    and (max_redemptions is null or redemption_count < max_redemptions);

  if product_price is null then
    return query select false, null::text, 0::numeric, 'Product is unavailable.';
    return;
  end if;

  if promo.id is null then
    return query select false, null::text, 0::numeric, 'That promotion code is not available.';
    return;
  end if;

  return query
  select
    true,
    promo.code::text,
    least(
      product_price,
      case
        when promo.discount_type = 'percent'
          then round(product_price * promo.discount_value / 100, 2)
        else promo.discount_value
      end
    ),
    'Promotion applied.';
  return;
end;
$$;

grant execute on function public.quote_promo(text, uuid) to anon, authenticated;
