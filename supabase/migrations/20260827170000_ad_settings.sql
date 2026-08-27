-- =============================================================================
-- Admin-controlled threshold for external-link (ad) listings.
--
-- Publishing an external-link listing requires the seller to hold at least this
-- much in their ad wallet. It lived as a hardcoded $100 in the product modal;
-- it now sits in site_settings so an admin can raise or lower it from the
-- Settings screen without a code change (same pattern as
-- default_commission_rate / refund_rate_percent — see
-- 20260827100000_commission_and_refund_settings.sql).
-- =============================================================================

alter table public.site_settings
  add column if not exists ad_min_wallet_balance numeric(12, 2) not null default 100.00
  check (ad_min_wallet_balance >= 0);

comment on column public.site_settings.ad_min_wallet_balance is
  'Minimum ad-wallet balance (USD) a seller must hold to publish an external-link / ad listing.';

