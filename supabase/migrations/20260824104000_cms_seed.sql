-- =============================================================================
-- Starter content
--
-- Gives the studio something real to open on first run and lets the storefront
-- render its legal and help pages from the CMS rather than from hard-coded
-- markup. Every insert is keyed on (type, slug) so re-running is a no-op.
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
-- Legal pages
-- -----------------------------------------------------------------------------

select public.cms_seed_document('legal', 'terms', 'Terms of Service', jsonb_build_object(
  'summary', 'The agreement between you and Codeink Technologies when you buy from DigiStore.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Agreement'),
    jsonb_build_object('type', 'p', 'text', 'By creating an account or completing a purchase you agree to these terms. They apply to every product sold through DigiStore, which is operated by Codeink Technologies.'),
    jsonb_build_object('type', 'h2', 'text', 'Your account'),
    jsonb_build_object('type', 'p', 'text', 'You are responsible for keeping your credentials secure. Purchases are tied to the account that made them, and download links are issued to that account only.'),
    jsonb_build_object('type', 'h2', 'text', 'Acceptable use'),
    jsonb_build_object('type', 'p', 'text', 'You may not resell, redistribute, or publish any purchased file unless the product listing grants that right explicitly. Automated scraping of the catalog is not permitted.'),
    jsonb_build_object('type', 'h2', 'text', 'Availability'),
    jsonb_build_object('type', 'p', 'text', 'We aim to keep the service available at all times but do not guarantee uninterrupted access. Planned maintenance is announced on the storefront in advance where practical.')
  )
));

select public.cms_seed_document('legal', 'privacy', 'Privacy Policy', jsonb_build_object(
  'summary', 'What we collect, why we collect it, and how long we keep it.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'What we collect'),
    jsonb_build_object('type', 'p', 'text', 'We store the email address you register with, the name you supply, your order history, and any support messages you send. Optional profile fields such as country and occupation are exactly that — optional.'),
    jsonb_build_object('type', 'h2', 'text', 'Payment data'),
    jsonb_build_object('type', 'p', 'text', 'Card and wallet details are handled by our payment providers. DigiStore never receives or stores your card number.'),
    jsonb_build_object('type', 'h2', 'text', 'Retention'),
    jsonb_build_object('type', 'p', 'text', 'Order records are retained for as long as tax and accounting rules require. You may request deletion of your profile at any time; order records are anonymised rather than removed.'),
    jsonb_build_object('type', 'h2', 'text', 'Your rights'),
    jsonb_build_object('type', 'p', 'text', 'You can export or delete your data by contacting support. We respond within 30 days.')
  )
));

select public.cms_seed_document('legal', 'refunds', 'Refund Policy', jsonb_build_object(
  'summary', 'Digital goods are refundable when they are faulty or misdescribed.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'When we refund'),
    jsonb_build_object('type', 'p', 'text', 'If a file is corrupt, materially differs from its description, or cannot be delivered, we refund in full. Contact support within 14 days of purchase.'),
    jsonb_build_object('type', 'h2', 'text', 'When we do not'),
    jsonb_build_object('type', 'p', 'text', 'Because the goods are digital and delivered immediately, we cannot refund a working product simply because it was no longer wanted.'),
    jsonb_build_object('type', 'h2', 'text', 'How to request one'),
    jsonb_build_object('type', 'p', 'text', 'Open a support ticket with your order reference. Approved refunds are returned to the original payment method within five business days.')
  )
));

select public.cms_seed_document('legal', 'licence', 'Digital Licence Agreement', jsonb_build_object(
  'summary', 'What you may and may not do with a file you have bought.',
  'effective_date', '2026-01-01',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'Grant'),
    jsonb_build_object('type', 'p', 'text', 'Unless the listing states otherwise, a purchase grants one person a perpetual, non-exclusive, non-transferable licence to use the file, including in commercial work.'),
    jsonb_build_object('type', 'h2', 'text', 'Restrictions'),
    jsonb_build_object('type', 'p', 'text', 'You may not redistribute the file, sell it, or include it in a competing product. Team and extended licences are available on request.')
  )
));

-- -----------------------------------------------------------------------------
-- Help centre
-- -----------------------------------------------------------------------------

select public.cms_seed_document('faq', 'delivery-time', 'How quickly is my purchase delivered?', jsonb_build_object(
  'category', 'Orders & delivery',
  'answer', 'Immediately. Once the payment provider confirms the transaction, a signed download link appears on the confirmation page and in your account library.',
  'ordering', 1
));

select public.cms_seed_document('faq', 'download-expired', 'My download link expired. What now?', jsonb_build_object(
  'category', 'Orders & delivery',
  'answer', 'Links are short-lived on purpose. Sign in and open your library — you can generate a fresh link for any completed order at any time, for as long as you hold the account.',
  'ordering', 2
));

select public.cms_seed_document('faq', 'payment-methods', 'Which payment methods do you accept?', jsonb_build_object(
  'category', 'Payments',
  'answer', 'Cards and African mobile money through Flutterwave, and more than 300 cryptocurrencies through NOWPayments. Prices are quoted in USD and converted at checkout.',
  'ordering', 3
));

select public.cms_seed_document('faq', 'invoice', 'Can I get an invoice?', jsonb_build_object(
  'category', 'Payments',
  'answer', 'Yes. Every completed order has a printable receipt in your account, including the order reference, the amount, and the payment provider''s transaction identifier.',
  'ordering', 4
));

select public.cms_seed_document('faq', 'commercial-use', 'May I use a product in client work?', jsonb_build_object(
  'category', 'Licensing',
  'answer', 'A standard licence covers commercial use by one person, including client projects. It does not allow redistributing the file itself. See the licence agreement for the full terms.',
  'ordering', 5
));

select public.cms_seed_document('faq', 'team-licence', 'Do you offer team licences?', jsonb_build_object(
  'category', 'Licensing',
  'answer', 'Yes — contact support with the product and the number of seats and we will issue a quote.',
  'ordering', 6
));

-- -----------------------------------------------------------------------------
-- Home page composition
-- -----------------------------------------------------------------------------

select public.cms_seed_document('homepage', 'home', 'Home page', jsonb_build_object(
  'hero_eyebrow', 'Digital catalog',
  'hero_title', 'Tools, books, and templates that earn their place in your workflow.',
  'hero_body', 'Every listing is reviewed before it goes live, priced in the open, and delivered through a signed link the moment payment clears. No subscriptions, no bundles you did not ask for.',
  'hero_primary_label', 'Browse the catalog',
  'hero_primary_href', './store.html',
  'hero_secondary_label', 'How delivery works',
  'hero_secondary_href', './support.html',
  'rails', jsonb_build_array('featured', 'new', 'best_selling', 'deals', 'top_rated'),
  'band_title', 'Buy once. Download for as long as you hold the account.',
  'band_body', 'Purchases stay in your library permanently. Regenerate a download link whenever you need it, on any device you are signed in on.'
));

select public.cms_seed_document('page', 'about', 'About DigiStore', jsonb_build_object(
  'lede', 'DigiStore is the storefront Codeink Technologies uses to sell the things it builds — and a small, carefully chosen set of work by people we trust.',
  'body', jsonb_build_array(
    jsonb_build_object('type', 'h2', 'text', 'What we sell'),
    jsonb_build_object('type', 'p', 'text', 'Ebooks and long-form guides, working software and scripts, interface templates, courses, and production-ready media. Everything is finished work, not a promise of future updates.'),
    jsonb_build_object('type', 'h2', 'text', 'How listings are reviewed'),
    jsonb_build_object('type', 'p', 'text', 'Before a product is published, someone downloads it, opens it, and checks it does what the description says. Listings that fail that check do not go live.'),
    jsonb_build_object('type', 'h2', 'text', 'How delivery works'),
    jsonb_build_object('type', 'p', 'text', 'Files live in a private bucket. When a payment provider confirms a transaction server-side, the order is marked paid and a signed URL is issued that expires shortly afterwards. A redirect back from a payment page is never treated as proof of payment.')
  )
));

drop function if exists public.cms_seed_document(text, text, text, jsonb, boolean);
