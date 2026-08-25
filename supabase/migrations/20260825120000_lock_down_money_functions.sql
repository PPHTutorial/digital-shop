-- =============================================================================
-- SECURITY: money-moving functions were reachable from the browser.
--
-- `revoke all ... from public` is not sufficient in a Supabase project. The
-- default privileges include
--     alter default privileges in schema public
--       grant execute on functions to anon, authenticated, service_role;
-- so every new function is granted to anon and authenticated the moment it is
-- created, independently of the PUBLIC pseudo-role. Revoking from PUBLIC left
-- those two grants untouched.
--
-- Confirmed against production: an anonymous request to credit_ad_funding()
-- executed and returned {"credited": false, "reason": "unknown_reference"} —
-- a rejection on the merits, not a permission error, proving it ran.
--
-- The exposure: credit_ad_funding() is SECURITY DEFINER and credits a wallet on
-- the strength of a reference alone. A seller can read their own pending
-- reference (RLS permits it), so they could start a $25 top-up, never pay, call
-- this with that reference, and credit themselves. mature_vendor_earnings() was
-- likewise callable, letting anyone clear the refund-holding window early.
--
-- Both are now revoked from anon and authenticated explicitly. credit_ad_funding
-- stays granted to service_role, which is what the funding callbacks run as.
-- =============================================================================

revoke execute on function public.credit_ad_funding(text, text, boolean, text) from anon, authenticated;
grant execute on function public.credit_ad_funding(text, text, boolean, text) to service_role;

revoke execute on function public.mature_vendor_earnings() from anon, authenticated;
grant execute on function public.mature_vendor_earnings() to service_role;

-- Admin-gated functions already refuse non-admins internally, but there is no
-- reason for anon to hold EXECUTE on them at all. Defence in depth.
revoke execute on function public.settle_ad_topup(uuid, boolean, text, text) from anon;
revoke execute on function public.moderate_vendor(uuid, public.vendor_status, text) from anon;
revoke execute on function public.moderate_campaign(uuid, boolean, text) from anon;
revoke execute on function public.moderation_queue() from anon;

-- Vendor-scoped functions: authenticated is required, anon never is.
revoke execute on function public.create_ad_funding(numeric, text, text) from anon;
revoke execute on function public.request_ad_topup(numeric, text) from anon;
revoke execute on function public.request_payout(uuid) from anon;
revoke execute on function public.apply_as_vendor(text, text, text, text) from anon;
revoke execute on function public.vendor_dashboard() from anon;
revoke execute on function public.current_vendor_id() from anon;
revoke execute on function public.is_approved_vendor() from anon;
revoke execute on function public.storage_path_is_own_vendor(text) from anon;

-- record_ad_event stays open to anon on purpose: impressions and clicks come
-- from logged-out visitors. It cannot credit anything — it only ever debits a
-- wallet, is deduped per viewer-day, and refuses unknown campaigns.
-- vendor_storefront stays open: it is the public seller page.
