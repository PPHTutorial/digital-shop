-- =============================================================================
-- Vendor payouts — part 3 of 3: legal acceptance + policy revisions
--
--   * public.legal_acceptances  — an audit row each time a user ticks "I agree"
--     (signup / checkout / seller onboarding / affiliate signup). Record-only;
--     nothing is gated.
--   * record_legal_acceptance(slugs[], context, user_agent) — writes one row
--     per slug, stamped with the doc's current cms_documents.version.
--   * Revised legal docs (cms_documents type='legal'): payouts, vendor-
--     agreement, refunds, dispute-resolution, terms — settlement timing,
--     automated transfers, failed-transfer handling, chargebacks, and a
--     "Changes to these terms" clause. Applied with a guarded UPDATE (skips a
--     doc an editor has already moved past this revision) + a revision snapshot.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Acceptance log
-- -----------------------------------------------------------------------------
create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_slug text not null,
  doc_version integer not null,
  context text not null default 'signup'
    check (context in ('signup', 'checkout', 'seller_onboarding', 'affiliate_signup')),
  user_agent text,
  accepted_at timestamptz not null default now()
);

create index if not exists legal_acceptances_user_idx on public.legal_acceptances (user_id, accepted_at desc);
create index if not exists legal_acceptances_doc_idx on public.legal_acceptances (doc_slug, doc_version);

alter table public.legal_acceptances enable row level security;

drop policy if exists "users read own acceptances" on public.legal_acceptances;
create policy "users read own acceptances" on public.legal_acceptances
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

grant select on public.legal_acceptances to authenticated;
-- No write policy: rows come only from record_legal_acceptance() (SECURITY DEFINER).


create or replace function public.record_legal_acceptance(
  p_slugs text[], p_context text default 'signup', p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_slug text;
  v_version integer;
  v_recorded integer := 0;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_context not in ('signup', 'checkout', 'seller_onboarding', 'affiliate_signup') then
    p_context := 'signup';
  end if;

  foreach v_slug in array coalesce(p_slugs, array[]::text[]) loop
    select version into v_version
    from public.cms_documents
    where type = 'legal' and slug = v_slug and locale = 'en' and published is not null;

    if v_version is not null then
      insert into public.legal_acceptances (user_id, doc_slug, doc_version, context, user_agent)
      values (v_uid, v_slug, v_version, p_context, left(coalesce(p_user_agent, ''), 400));
      v_recorded := v_recorded + 1;
    end if;
  end loop;

  return jsonb_build_object('recorded', v_recorded);
end;
$$;

revoke all on function public.record_legal_acceptance(text[], text, text) from public, anon;
grant execute on function public.record_legal_acceptance(text[], text, text) to authenticated;


-- =============================================================================
-- Policy revisions
-- =============================================================================
create or replace function public._legal_revise(
  p_slug text, p_title text, p_payload jsonb, p_effective text
)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_id uuid;
  v_version integer;
begin
  select id, version into v_id, v_version
  from public.cms_documents
  where type = 'legal' and slug = p_slug and locale = 'en';

  if v_id is null then
    return;  -- seeded by an earlier migration; nothing to revise on a fresh DB race
  end if;

  if coalesce((select published ->> 'effective_date' from public.cms_documents where id = v_id), '') = p_effective then
    return;  -- already at this revision (idempotent re-run)
  end if;

  update public.cms_documents
  set draft = p_payload,
      published = p_payload,
      title = coalesce(p_title, title),
      version = version + 1,
      published_at = now(),
      status = 'published'::public.cms_status,
      updated_at = now()
  where id = v_id;

  -- Revision history is best-effort — don't fail a policy publish over it.
  begin
    perform public.cms_record_revision(v_id, 'save', p_payload, coalesce(p_title, p_slug), v_version + 1);
  exception when others then
    null;
  end;
end;
$$;


select public._legal_revise('payouts', 'Payout & Settlement Policy', jsonb_build_object(
  'summary', 'How seller earnings are settled, held, matured, scheduled, and paid out.',
  'effective_date', '2026-09-02',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'How a balance builds'),
    jsonb_build_object('type', 'p', 'text', 'When a sale is confirmed, its net amount — the list price less platform commission and any buyer taxes DigiStore remits — is credited to your account as a pending balance.'),
    jsonb_build_object('type', 'h2', 'text', 'Settlement of card payments'),
    jsonb_build_object('type', 'p', 'text', 'A confirmed sale is not the same as cleared money. Card payments are released to DigiStore by the payment provider on the provider''s own settlement cycle, which commonly takes up to five business days and can be longer for cross-border cards. Only funds the provider has actually settled to DigiStore are eligible to be paid out to you.'),
    jsonb_build_object('type', 'h2', 'text', 'Holding period'),
    jsonb_build_object('type', 'p', 'text', 'On top of settlement, a pending amount matures to an available balance after a holding period that covers the refund and dispute window. Until an amount is both settled and matured it cannot be withdrawn, and a refund or reversal in that window is netted off before maturity.'),
    jsonb_build_object('type', 'h2', 'text', 'Payout schedule'),
    jsonb_build_object('type', 'p', 'text', 'You choose how your available balance is paid out: on request only (manual), weekly on Fridays, or monthly on the first business day of the month, in each case for the balance available at that point. A minimum payout amount applies; if your available balance is below it at a scheduled run, the balance carries forward to the next run. Choosing a weekly or monthly schedule requires a verified default payout account.'),
    jsonb_build_object('type', 'h2', 'text', 'Requesting a payout'),
    jsonb_build_object('type', 'p', 'text', 'For a manual payout you withdraw your available balance to a payout account you have added and verified. Payouts are made in your chosen payout currency; currency conversion from USD uses the rate at the time the payout is processed, and the payment provider''s transfer fee may be deducted.'),
    jsonb_build_object('type', 'h2', 'text', 'Automated transfers'),
    jsonb_build_object('type', 'p', 'text', 'Where automated payouts are enabled, DigiStore initiates the bank transfer to your verified default account on your schedule. A transfer is marked complete only once the provider confirms it. A transfer that fails — for example because of incorrect account details — is returned to your available balance, you are notified, and it is retried on your next scheduled payout. Each payout is processed once; a repeated or duplicated instruction for the same payout is ignored.'),
    jsonb_build_object('type', 'h2', 'text', 'Verification (KYC)'),
    jsonb_build_object('type', 'p', 'text', 'Before your first payout, and again if a threshold or a risk check is triggered, you may be asked to verify your identity and the ownership of your payout account. Payouts are held until verification is complete.'),
    jsonb_build_object('type', 'h2', 'text', 'Reversals and negative balances'),
    jsonb_build_object('type', 'p', 'text', 'Refunds, chargebacks, and fraud reversals are deducted from your balance, including any commission already accrued on the original sale and any transfer fee incurred. If they exceed your balance the account goes negative, future earnings are applied to it first, and DigiStore may pause payouts and may invoice a persistent negative balance.'),
    jsonb_build_object('type', 'h2', 'text', 'Holds'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may place a temporary hold on a balance or a specific payout where there is a suspected policy breach, an unusual dispute rate, a legal request, or a payment-provider instruction. We tell you why and what is needed to release it.'),
    jsonb_build_object('type', 'h2', 'text', 'Dormant balances'),
    jsonb_build_object('type', 'p', 'text', 'If a store is closed with an available balance and no valid payout account, DigiStore will make reasonable efforts to reach you. Unclaimed balances are handled as required by applicable unclaimed-property law.'),
    jsonb_build_object('type', 'h2', 'text', 'Changes to this policy'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may revise this policy. Material changes are notified by email or an on-site notice a reasonable time before they take effect, and continued selling after the effective date is acceptance. The version in effect when a sale is made governs the payout of that sale. See the Terms of Service for how changes to our terms work generally.')
  )
), '2026-09-02');


select public._legal_revise('vendor-agreement', 'Vendor Agreement', jsonb_build_object(
  'summary', 'The terms that apply when you open a store and sell digital products through DigiStore.',
  'effective_date', '2026-09-02',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Who can sell'),
    jsonb_build_object('type', 'p', 'text', 'You must be at least 18, hold a DigiStore account in good standing, and be able to enter a binding contract in your country of residence. A store application is reviewed before it is approved, and approval can be declined or later withdrawn at DigiStore''s discretion.'),
    jsonb_build_object('type', 'h2', 'text', 'Your content and your rights'),
    jsonb_build_object('type', 'p', 'text', 'You keep ownership of everything you upload. You grant Codeink Technologies a non-exclusive, worldwide licence to host, market, display, and deliver your products to buyers for as long as they are listed, plus the period needed to honour past purchases.'),
    jsonb_build_object('type', 'p', 'text', 'You warrant that you own or are licensed to sell every file you list, that it does not infringe anyone''s intellectual property, and that it contains no malware.'),
    jsonb_build_object('type', 'h2', 'text', 'Commission and pricing'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore deducts a platform commission from each completed sale. The default rate applied to new stores is published in the seller onboarding screen and set by DigiStore; an individual store may be given a different negotiated rate. The rate that applied at the time of a sale is shown on that sale''s record and does not change retroactively.'),
    jsonb_build_object('type', 'p', 'text', 'You set your own list prices in USD. Buyer-facing taxes, where DigiStore is required to collect them, are added at checkout and are not part of your commissionable revenue.'),
    jsonb_build_object('type', 'h2', 'text', 'Delivery and support'),
    jsonb_build_object('type', 'p', 'text', 'Products are delivered by signed download link on confirmed payment. You are responsible for the accuracy of your listings and for answering buyer questions about your products within a reasonable time.'),
    jsonb_build_object('type', 'h2', 'text', 'Payouts'),
    jsonb_build_object('type', 'p', 'text', 'Your earnings are settled, held, matured, and paid out under the Payout & Settlement Policy, which also governs the payout schedule you choose and how automated transfers and failed transfers are handled.'),
    jsonb_build_object('type', 'h2', 'text', 'Refunds and chargebacks'),
    jsonb_build_object('type', 'p', 'text', 'Refunds are handled under the Refund Policy. A refund, chargeback, or payment reversal on one of your sales is deducted from your balance, including any commission already accrued on it and any transfer fee incurred.'),
    jsonb_build_object('type', 'p', 'text', 'When a buyer''s bank raises a chargeback, DigiStore may ask you for evidence that the product was delivered and matched its description and will submit a response on your behalf where that is reasonable. The card networks decide the outcome; DigiStore does not control it, and a chargeback fee charged by the payment provider is passed on to you. DigiStore may withhold a payout while a dispute on your sales is open.'),
    jsonb_build_object('type', 'p', 'text', 'A high refund or dispute rate may lead to review, a rolling reserve on your balance, suspension, or termination.'),
    jsonb_build_object('type', 'h2', 'text', 'Tax'),
    jsonb_build_object('type', 'p', 'text', 'You are solely responsible for reporting and paying any income, sales, VAT, GST, or withholding tax that arises from your sales, except amounts DigiStore is legally required to collect and remit on your behalf.'),
    jsonb_build_object('type', 'h2', 'text', 'Suspension and termination'),
    jsonb_build_object('type', 'p', 'text', 'You can close your store at any time. DigiStore may suspend or remove a store for breach of this agreement, the Store & Listing Policy, or the Acceptable Use Policy, for legal or payment-provider reasons, or to protect buyers. Matured balances remain payable to you subject to the Payout & Settlement Policy and any open disputes.'),
    jsonb_build_object('type', 'h2', 'text', 'Changes to this agreement'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may revise this agreement and the policies it references. Material changes are notified before they take effect and continued selling after the effective date is acceptance; see the Terms of Service. The version in effect at the time of a sale governs that sale.')
  )
), '2026-09-02');


select public._legal_revise('refunds', 'Refund Policy', jsonb_build_object(
  'summary', 'Digital goods are refundable when they are faulty or misdescribed.',
  'effective_date', '2026-09-02',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'When we refund'),
    jsonb_build_object('type', 'p', 'text', 'If a file is corrupt, materially differs from its description, or cannot be delivered, we refund in full. Contact support within 14 days of purchase.'),
    jsonb_build_object('type', 'h2', 'text', 'When we do not'),
    jsonb_build_object('type', 'p', 'text', 'Because the goods are digital and delivered immediately, we cannot refund a working product simply because it was no longer wanted.'),
    jsonb_build_object('type', 'h2', 'text', 'How to request one'),
    jsonb_build_object('type', 'p', 'text', 'Open a support ticket with your order reference. We aim to review requests within a few business days.'),
    jsonb_build_object('type', 'h2', 'text', 'How refunds are returned'),
    jsonb_build_object('type', 'p', 'text', 'An approved refund is returned to the original payment method. How long it takes to appear depends on your bank or card issuer, and is usually a few business days after we process it.'),
    jsonb_build_object('type', 'h2', 'text', 'Chargebacks'),
    jsonb_build_object('type', 'p', 'text', 'Asking your bank or card issuer to reverse a charge instead of contacting us is a chargeback. Please try support first — most issues are resolved faster that way. A chargeback that is decided in your favour is treated as a refund of that order. Repeatedly charging back completed, as-described orders may lead to restrictions on your account.'),
    jsonb_build_object('type', 'h2', 'text', 'Changes to this policy'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may revise this policy; see the Terms of Service for how changes take effect. The version in effect at the time of a purchase governs that purchase.')
  )
), '2026-09-02');


select public._legal_revise('dispute-resolution', 'Dispute Resolution & Chargebacks', jsonb_build_object(
  'summary', 'How to raise a problem with an order, and how payment disputes are handled.',
  'effective_date', '2026-09-02',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Talk to us first'),
    jsonb_build_object('type', 'p', 'text', 'Most problems — a broken file, a wrong version, a delivery that did not arrive — are fixed fastest by opening a support ticket with your order reference. We aim to respond within two business days.'),
    jsonb_build_object('type', 'h2', 'text', 'Buyer–seller disputes'),
    jsonb_build_object('type', 'p', 'text', 'If you and a seller cannot agree, DigiStore support will review the listing, the delivered file, and the messages between you, and will decide on a refund, partial refund, or no refund. That decision is final within the platform.'),
    jsonb_build_object('type', 'h2', 'text', 'Chargebacks'),
    jsonb_build_object('type', 'p', 'text', 'Asking your bank or card issuer to reverse a payment before contacting us slows resolution and costs the seller a fee. Where a chargeback is raised on an order that was delivered as described, we will contest it with evidence of delivery and of these terms. The card networks decide the outcome.'),
    jsonb_build_object('type', 'h2', 'text', 'Effect on seller balances'),
    jsonb_build_object('type', 'p', 'text', 'While a dispute or chargeback on a seller''s sales is open, DigiStore may withhold the affected amount or a payout. A chargeback decided for the buyer is deducted from the seller''s balance under the Payout & Settlement Policy, along with any provider fee.'),
    jsonb_build_object('type', 'h2', 'text', 'Abuse'),
    jsonb_build_object('type', 'p', 'text', 'Accounts that repeatedly charge back completed, as-described orders may be restricted or closed and prevented from purchasing again.'),
    jsonb_build_object('type', 'h2', 'text', 'Governing law'),
    jsonb_build_object('type', 'p', 'text', 'These policies and any dispute with DigiStore are governed by the laws of Ghana, where Codeink Technologies is established, without affecting mandatory consumer-protection rights you have where you live.')
  )
), '2026-09-02');


select public._legal_revise('terms', 'Terms of Service', jsonb_build_object(
  'summary', 'The agreement between you and Codeink Technologies when you buy from DigiStore.',
  'effective_date', '2026-09-02',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Agreement'),
    jsonb_build_object('type', 'p', 'text', 'By creating an account or completing a purchase you agree to these terms. DigiStore is operated by Codeink Technologies.'),
    jsonb_build_object('type', 'h2', 'text', 'Your account'),
    jsonb_build_object('type', 'p', 'text', 'Keep your credentials secure. Purchases and their download links are tied to the account that made them.'),
    jsonb_build_object('type', 'h2', 'text', 'Acceptable use'),
    jsonb_build_object('type', 'p', 'text', 'Do not resell, redistribute, or publish files you purchase unless the listing grants that right. Do not scrape the catalog with automated tools.'),
    jsonb_build_object('type', 'h2', 'text', 'Availability'),
    jsonb_build_object('type', 'p', 'text', 'We aim for high uptime but do not guarantee it. Maintenance is announced where practical.'),
    jsonb_build_object('type', 'h2', 'text', 'Changes to these terms'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may revise these terms and the policies they reference — the Privacy Policy, Refund Policy, Vendor Agreement, and Payout & Settlement Policy. Material changes are notified by email or an on-site notice a reasonable time before they take effect. Continued use of DigiStore after the effective date means you accept the revised version. The version in effect at the time of a transaction governs that transaction, and a superseded version is available from support on request.')
  )
), '2026-09-02');


drop function if exists public._legal_revise(text, text, jsonb, text);
