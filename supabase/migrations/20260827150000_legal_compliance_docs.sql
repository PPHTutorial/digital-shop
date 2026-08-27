-- =============================================================================
-- Additional legal / compliance documents
--
-- The storefront's /legal page renders whatever `cms_documents` rows exist with
-- type = 'legal' (see js/legal.js). Four were seeded in
-- 20260824104000_cms_seed.sql (terms, privacy, refunds, licence). A
-- multi-vendor marketplace that takes payments, holds seller balances and pays
-- out across borders needs more than that: a seller agreement, a listing
-- policy, a payout/settlement policy, an acceptable-use policy, an IP/DMCA
-- takedown process, a cookie policy, and a dispute/chargeback policy.
--
-- Same contract as the original seed: every insert is keyed on (type, slug) and
-- is a no-op if an editor has already created or changed that document.
-- =============================================================================

create or replace function public.cms_seed_document(
  p_type text,
  p_slug text,
  p_title text,
  p_draft jsonb,
  p_publish boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.cms_documents d
  where d.type = p_type and d.slug = p_slug and d.locale = 'en';

  if v_id is not null then
    return; -- never overwrite content an editor may have changed
  end if;

  insert into public.cms_documents (type, slug, title, draft, published, published_at, status)
  values (
    p_type,
    p_slug,
    p_title,
    p_draft,
    case when p_publish then p_draft else null end,
    case when p_publish then now() else null end,
    case when p_publish then 'published'::public.cms_status else 'draft'::public.cms_status end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Vendor / Seller Agreement
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'vendor-agreement', 'Vendor Agreement', jsonb_build_object(
  'summary', 'The terms that apply when you open a store and sell digital products through DigiStore.',
  'effective_date', '2026-01-01',
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
    jsonb_build_object('type', 'h2', 'text', 'Refunds and chargebacks'),
    jsonb_build_object('type', 'p', 'text', 'Refunds are handled under the Refund Policy. A refund, chargeback, or payment reversal on one of your sales is deducted from your balance, including any commission already accrued on it. Excessive refund or dispute rates may lead to review or suspension.'),
    jsonb_build_object('type', 'h2', 'text', 'Tax'),
    jsonb_build_object('type', 'p', 'text', 'You are solely responsible for reporting and paying any income, sales, VAT, GST, or withholding tax that arises from your sales, except amounts DigiStore is legally required to collect and remit on your behalf.'),
    jsonb_build_object('type', 'h2', 'text', 'Suspension and termination'),
    jsonb_build_object('type', 'p', 'text', 'You can close your store at any time. DigiStore may suspend or remove a store for breach of this agreement, the Store & Listing Policy, or the Acceptable Use Policy, for legal or payment-provider reasons, or to protect buyers. Matured balances remain payable to you subject to the Payout & Settlement Policy and any open disputes.')
  )
));

-- -----------------------------------------------------------------------------
-- Store & Listing Policy
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'store-policy', 'Store & Listing Policy', jsonb_build_object(
  'summary', 'What may be sold, how listings must be described, and how stores are reviewed.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Store identity'),
    jsonb_build_object('type', 'p', 'text', 'Your store name and branding must not impersonate another business, use a trademark you do not hold, or mislead buyers about who they are purchasing from. DigiStore may require a name change.'),
    jsonb_build_object('type', 'h2', 'text', 'What you may sell'),
    jsonb_build_object('type', 'p', 'text', 'Finished digital products you are authorised to distribute: ebooks and written guides, software and scripts, templates and themes, courses, design assets, and audio or media files.'),
    jsonb_build_object('type', 'h2', 'text', 'What you may not sell'),
    jsonb_build_object('type', 'li', 'text', 'Content that infringes copyright, trademarks, or other IP, including nulled, cracked, or resold third-party licences.'),
    jsonb_build_object('type', 'li', 'text', 'Malware, credential stealers, botnet tooling, or code whose main purpose is unauthorised access.'),
    jsonb_build_object('type', 'li', 'text', 'Personal data sets, scraped databases, or lead lists.'),
    jsonb_build_object('type', 'li', 'text', 'Sexual content involving minors, non-consensual content, or content that promotes hate or violence.'),
    jsonb_build_object('type', 'li', 'text', 'Regulated goods and services — financial, medical, or legal products that require a licence you do not hold.'),
    jsonb_build_object('type', 'li', 'text', 'Anything illegal to sell or deliver in Ghana or in the buyer''s country.'),
    jsonb_build_object('type', 'h2', 'text', 'Listing accuracy'),
    jsonb_build_object('type', 'p', 'text', 'The title, description, screenshots, file format, and version must match what the buyer actually receives. Disclose material limitations — required accounts, paid dependencies, or platform restrictions — on the listing itself.'),
    jsonb_build_object('type', 'h2', 'text', 'Review and enforcement'),
    jsonb_build_object('type', 'p', 'text', 'Products may be reviewed before and after publication. DigiStore may unlist a product, hold its sales, or suspend a store that breaches this policy. Repeated or serious breaches end the seller relationship.')
  )
));

-- -----------------------------------------------------------------------------
-- Payout & Settlement Policy
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'payouts', 'Payout & Settlement Policy', jsonb_build_object(
  'summary', 'How seller earnings are held, matured, and paid out.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'How a balance builds'),
    jsonb_build_object('type', 'p', 'text', 'When a sale is confirmed, its net amount — the list price less platform commission and any buyer taxes DigiStore remits — is credited to your account as a pending balance.'),
    jsonb_build_object('type', 'h2', 'text', 'Holding period'),
    jsonb_build_object('type', 'p', 'text', 'Pending amounts mature to an available balance after a holding period that covers the refund and dispute window. Until an amount is available it cannot be withdrawn, and a refund or reversal in that window is netted off before maturity.'),
    jsonb_build_object('type', 'h2', 'text', 'Requesting a payout'),
    jsonb_build_object('type', 'p', 'text', 'You withdraw your available balance to a payout account you have added and verified. A minimum withdrawal amount may apply. Payouts are made in your chosen payout currency; currency conversion from USD uses the rate at the time the payout is processed, and the payment provider''s transfer fee may be deducted.'),
    jsonb_build_object('type', 'h2', 'text', 'Verification (KYC)'),
    jsonb_build_object('type', 'p', 'text', 'Before your first payout, and again if a threshold or a risk check is triggered, you may be asked to verify your identity and the ownership of your payout account. Payouts are held until verification is complete.'),
    jsonb_build_object('type', 'h2', 'text', 'Reversals and negative balances'),
    jsonb_build_object('type', 'p', 'text', 'Refunds, chargebacks, and fraud reversals are deducted from your balance. If they exceed your balance the account goes negative and future earnings are applied to it first; DigiStore may invoice a persistent negative balance.'),
    jsonb_build_object('type', 'h2', 'text', 'Holds'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore may place a temporary hold on a balance or a specific payout where there is a suspected policy breach, an unusual dispute rate, a legal request, or a payment-provider instruction. We tell you why and what is needed to release it.'),
    jsonb_build_object('type', 'h2', 'text', 'Dormant balances'),
    jsonb_build_object('type', 'p', 'text', 'If a store is closed with an available balance and no valid payout account, DigiStore will make reasonable efforts to reach you. Unclaimed balances are handled as required by applicable unclaimed-property law.')
  )
));

-- -----------------------------------------------------------------------------
-- Acceptable Use Policy
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'acceptable-use', 'Acceptable Use Policy', jsonb_build_object(
  'summary', 'The behaviour expected of everyone who uses DigiStore — buyers, sellers, and visitors.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'You must not'),
    jsonb_build_object('type', 'li', 'text', 'Break the law, or use DigiStore to help someone else break it.'),
    jsonb_build_object('type', 'li', 'text', 'Infringe intellectual property, or upload content you do not have the right to share.'),
    jsonb_build_object('type', 'li', 'text', 'Probe, scan, or test the security of the platform without written permission, or bypass access controls, rate limits, or download-link expiry.'),
    jsonb_build_object('type', 'li', 'text', 'Scrape the catalog, resell access, or use automated systems to place orders or create accounts.'),
    jsonb_build_object('type', 'li', 'text', 'Upload malware, or distribute a product that damages a buyer''s system or data.'),
    jsonb_build_object('type', 'li', 'text', 'Manipulate reviews, ratings, sales counts, or search ranking.'),
    jsonb_build_object('type', 'li', 'text', 'Harass, threaten, or abuse other users or staff.'),
    jsonb_build_object('type', 'h2', 'text', 'Fair use of the service'),
    jsonb_build_object('type', 'p', 'text', 'Download links are issued for personal use by the purchasing account. Sharing links, or serving purchased files to others, is a breach of this policy and of the licence agreement.'),
    jsonb_build_object('type', 'h2', 'text', 'Enforcement'),
    jsonb_build_object('type', 'p', 'text', 'We may remove content, restrict features, suspend, or close any account that breaches this policy, and we report unlawful activity to the relevant authorities.')
  )
));

-- -----------------------------------------------------------------------------
-- Intellectual Property & DMCA Policy
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'ip-dmca', 'Intellectual Property & Takedown Policy', jsonb_build_object(
  'summary', 'How to report content that infringes your rights, and how a seller can respond.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Our position'),
    jsonb_build_object('type', 'p', 'text', 'DigiStore respects intellectual property and expects its sellers to do the same. We act on valid infringement reports and terminate repeat infringers.'),
    jsonb_build_object('type', 'h2', 'text', 'Filing a notice'),
    jsonb_build_object('type', 'p', 'text', 'Send a notice to legal@codeinktechnologies.com that identifies the work you own, links to the specific DigiStore listing or file you say infringes it, gives your contact details, and states — under penalty of perjury — that you believe the use is unauthorised and that the information in your notice is accurate. Include your physical or electronic signature.'),
    jsonb_build_object('type', 'h2', 'text', 'What we do'),
    jsonb_build_object('type', 'p', 'text', 'On a valid notice we remove or disable the listing, notify the seller, and pass on your notice. Sales of the item are held pending resolution.'),
    jsonb_build_object('type', 'h2', 'text', 'Counter-notice'),
    jsonb_build_object('type', 'p', 'text', 'A seller who believes the removal was a mistake or misidentification can send a counter-notice with the same contact and signature requirements and a statement, under penalty of perjury, to that effect. If we receive a valid counter-notice we may restore the content unless the complainant pursues legal action.'),
    jsonb_build_object('type', 'h2', 'text', 'Repeat infringers'),
    jsonb_build_object('type', 'p', 'text', 'Stores that accumulate multiple substantiated infringement notices are closed and their operators barred from opening new stores.')
  )
));

-- -----------------------------------------------------------------------------
-- Cookie Policy
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'cookies', 'Cookie Policy', jsonb_build_object(
  'summary', 'The cookies and local storage DigiStore uses, and why.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Strictly necessary'),
    jsonb_build_object('type', 'p', 'text', 'We use cookies and browser storage to keep you signed in, hold your cart and checkout state, and protect against fraud and cross-site request forgery. The site does not work without these and they cannot be switched off from here.'),
    jsonb_build_object('type', 'h2', 'text', 'Preferences'),
    jsonb_build_object('type', 'p', 'text', 'We remember low-stakes choices such as your display currency and theme so you do not have to set them on every visit.'),
    jsonb_build_object('type', 'h2', 'text', 'Analytics'),
    jsonb_build_object('type', 'p', 'text', 'Where analytics are enabled we use them only in aggregate, to understand which pages and products are used. We do not sell this data or use it to build advertising profiles.'),
    jsonb_build_object('type', 'h2', 'text', 'Managing cookies'),
    jsonb_build_object('type', 'p', 'text', 'Your browser can block or delete cookies and site data. Blocking strictly-necessary cookies will stop you signing in or completing a purchase.')
  )
));

-- -----------------------------------------------------------------------------
-- Dispute Resolution & Chargebacks
-- -----------------------------------------------------------------------------
select public.cms_seed_document('legal', 'dispute-resolution', 'Dispute Resolution & Chargebacks', jsonb_build_object(
  'summary', 'How to raise a problem with an order, and how payment disputes are handled.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Talk to us first'),
    jsonb_build_object('type', 'p', 'text', 'Most problems — a broken file, a wrong version, a delivery that did not arrive — are fixed fastest by opening a support ticket with your order reference. We aim to respond within two business days.'),
    jsonb_build_object('type', 'h2', 'text', 'Buyer–seller disputes'),
    jsonb_build_object('type', 'p', 'text', 'If you and a seller cannot agree, DigiStore support will review the listing, the delivered file, and the messages between you, and will decide on a refund, partial refund, or no refund. That decision is final within the platform.'),
    jsonb_build_object('type', 'h2', 'text', 'Chargebacks'),
    jsonb_build_object('type', 'p', 'text', 'Asking your bank or card issuer to reverse a payment before contacting us slows resolution and costs the seller a fee. Where a chargeback is raised on an order that was delivered as described, we will contest it with evidence of delivery and of these terms.'),
    jsonb_build_object('type', 'h2', 'text', 'Abuse'),
    jsonb_build_object('type', 'p', 'text', 'Accounts that repeatedly charge back completed, as-described orders may be restricted or closed and prevented from purchasing again.'),
    jsonb_build_object('type', 'h2', 'text', 'Governing law'),
    jsonb_build_object('type', 'p', 'text', 'These policies and any dispute with DigiStore are governed by the laws of Ghana, where Codeink Technologies is established, without affecting mandatory consumer-protection rights you have where you live.')
  )
));

drop function if exists public.cms_seed_document(text, text, text, jsonb, boolean);
