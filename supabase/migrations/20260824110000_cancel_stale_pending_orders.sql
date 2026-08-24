-- A real payment resolves (paid/failed/cancelled) within minutes via the
-- provider webhook — flutterwave-callback and nowpayments-ipn already retire
-- a pending order the moment the provider reports it. A `pending` order still
-- sitting untouched after 24 hours has no such report coming: the shopper
-- closed the tab before paying, or the attempt predates that webhook logic.
-- One-time cleanup; safe to re-run, since a resolved order is no longer
-- `pending` and won't match again.
update public.orders
set status = 'cancelled'
where status = 'pending'
  and created_at < now() - interval '24 hours';
