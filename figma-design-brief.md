# DigiStore — Full-Site UI/UX Design Brief for Figma

**Purpose of this document:** This is a design prompt to feed into Figma (or a Figma AI design tool), alongside a reference image whose visual *structure/layout language* we want to borrow. The reference supplies the aesthetic direction; everything below supplies the **real content, data, and flow** that must be mapped onto that structure. The goal is a premium, best-in-class digital-goods marketplace UI — visually competitive with Gumroad, Etsy, Amazon, Shopify storefronts, and Stripe's dashboard polish — built from our actual data model, not placeholder content.

DigiStore is a **multi-vendor digital marketplace**: first-party + third-party sellers list downloadable products (ebooks, courses, templates, software, design assets, audio, etc.). Three audiences need full UI coverage: **Buyers** (storefront), **Vendors/Sellers** (seller console), and **Admins** (back-office).

---

## 0. Design Direction

- **Tone:** premium, trustworthy, fast — think "creative marketplace meets fintech-grade checkout." Confident whitespace, strong product photography focus, clear pricing, visible trust signals (secure delivery, verified buyer reviews, ratings).
- **Take structural cues from the reference image**: grid rhythm, hero treatment, card proportions, nav density, spacing scale — but reflow them around the content inventory below (do not drop our sections to fit the reference; adapt the reference's structure to carry our content).
- Must support **light/dark**, be fully responsive (mobile / tablet / desktop breakpoints), and define reusable states: default, hover, loading (skeleton/shimmer), empty, error, disabled.
- Deliver as a component-driven design system first (tokens, atoms, molecules) then assemble the page inventory below as high-fidelity frames.

---

## 1. Data Model (source of truth for every field shown in the UI)

### Product (`products`)
id, slug, title, category, description, short_description, price, original_price (strike-through "deal" price), currency, cover_url, gallery_urls[], file_type, file_size, license_type (e.g. "single-seat"), delivery_note, is_featured, tags[], vendor_id (null = first-party "DigiStore Official"), purchase_count, view_count, rating_average / rating_count, last_purchased_at, created/updated timestamps.
- Derived rails: Featured, New Arrivals, Bestsellers, Trending, Deals, Top Rated — plus category-specific rails (Ebooks, Software, Templates, Courses, Audio…).
- Search/filter facets: category, tags, price range, sort (relevance / newest / price asc-desc / best-selling / title).

### Category (`categories`)
name, slug, description, image_url, sort_order. 20 top-level categories (Ebooks & Guides, Online Courses, Templates & Themes, Software & Apps, Design & Graphics, Photography & Presets, Audio & Music, Video & Motion, Fonts & Typography, UI Kits & Wireframes, Productivity Templates, Stock Media & Assets, Plugins & Extensions, Game Assets, 3D Models & Assets, Marketing & Ad Creatives, Business & Legal Documents, Spreadsheets & Models, Printables & Planners, AI Prompts & Models).

### User Profile (`profiles`)
full_name, phone, address, gender, country, occupation, age, role (customer/admin), avatar_url, locale, preferred_currency, marketing_opt_in.

### Order (`orders`) + Order Items (`order_items`)
order_no ("DS-YYMM-#####"), customer name/email/country, amount, subtotal, discount_amount, promo_code, provider (Flutterwave / NOWPayments), status (pending/paid/failed/refunded/cancelled), quantity, billing (jsonb), notes, download_token + expiry, paid_at/refunded_at. Line items: title snapshot, unit price, quantity, currency.

### Cart (`cart_items`) — server-persisted, not local storage
user_id, product_id, quantity (1–20), added_at.

### Wishlist (`wishlist_items`)
user_id, product_id, added_at.

### Promo Codes (`promo_codes`)
code, discount_type (percent/fixed), discount_value, validity window, max_redemptions, redemption_count, is_active.

### Review (`reviews`) — gated to verified buyers only
product_id, user_id, order_id, rating (1–5), title, body, status (pending/approved/rejected), moderated_by/at.

### Download Events (`download_events`) — audit trail
order_id, product_id, user_id, ip_hash, user_agent, succeeded, reason, timestamp. (Files served via short-lived signed URLs, never direct links.)

### Support Ticket (`tickets`)
name, email, order_ref, category, subject, message, status (open/pending/closed).

### Newsletter (`subscribers`): email, subscribed_at.

### Blog Post (`blog_posts`): slug, title, excerpt, content, cover_url, status, published_at.

### Site Settings (`site_settings`) — single global row
site_title, support_email, announcement (+ active flag + expiry), tagline, social links, default_currency, checkout_note.

### CMS Document (`cms_documents`) — schema-less content store
type (page/post/author/faq/announcement/legal/navigation/homepage), slug, title, locale, draft/published jsonb payloads, status, version (optimistic lock), ordering. Plus `cms_revisions` (version history, restore), `cms_assets` (media library: bucket/path/url/dims/alt/tags), `cms_locks` (soft edit-lock, "being edited by X").

### Vendor (`vendors`)
display_name, slug, bio, logo_url, banner_url, support_email, website_url, country, payout_currency, status (pending/approved/suspended/rejected), commission_rate (default 15%), total_sales_count, total_gross, total_net, rejection_reason.

### Payout Account (`payout_accounts`)
method (bank_transfer/mobile_money/paypal/crypto) with method-specific fields (bank name/account/swift/iban, momo provider/number, paypal email, crypto asset/address), is_default, is_verified.

### Vendor Earnings (`vendor_earnings`)
gross_amount, commission_rate, commission_amount, net_amount, status (pending → available after 14 days → paid/reversed).

### Payout (`payouts`)
amount, currency, status (requested/processing/paid/failed/cancelled), reference, failure_reason.

### Ad Campaign (`ad_campaigns`) — product boosting
name, placement (featured/search/category), budget, spend, bid_amount, status (draft/active/paused/completed/rejected), impressions, clicks, conversions, cpm/cpc/cpa rates, daily_cap, review_status.

### Ad Wallet (`ad_wallets`) + Ledger (`ad_wallet_transactions`) + Top-up Requests (`ad_topup_requests`)
balance, currency, lifetime_topup, lifetime_spend; transaction ledger (topup/charge/refund/adjustment); top-up requests (pending/approved/rejected).

### Payments (Edge Functions, two rails)
- **Flutterwave**: card, bank transfer, USSD, mobile money (multi-country), M-Pesa, QR, Apple/Google Pay.
- **NOWPayments**: 300+ cryptocurrencies, invoice-based.
- Separate ad-wallet funding pipeline reuses the same two gateways (prefix `ADFUND-` vs order prefix `BOOK-`).
- All pricing/discounts computed server-side — UI must never imply client-side price editing.

---

## 2. Full Site Map (in flow order, start → finish)

### A. Storefront (Buyer-facing, public + logged-in)

1. **Home (`/`)**
   - Sticky header: utility bar (support email), logo, primary nav (Home / All Products / Blog / About / Contact / Support), search, cart icon w/ count, account popover (Sign in / Get started, OR avatar → Overview/Orders/Cart/Seller centre/Admin centre/Logout).
   - Category jumbotron (20 category tiles, icon + label, bare-icon compact style per current site).
   - "Have something worth selling?" seller CTA band.
   - Product rails (each: eyebrow label, H2 title, left/right scroll arrows, "See all (count)" link, horizontal-scroll product cards): **Featured Releases, New Arrivals, Bestsellers, Trending, Deals**, then category rails (Ebooks, Software, Templates, Courses, Audio…).
   - Product card anatomy: cover image, badge (New/Bestseller/Deal %), title, vendor name (or "DigiStore Official"), rating stars + count, price (+ strikethrough original price if on deal), quick-add-to-cart / wishlist-heart icon.
   - Full-bleed gradient promo banner: "Instant Digital Downloads Delivered Securely to Your Vault."
   - Newsletter subscribe panel.
   - Footer: sitemap columns, social links, payment-method badges, legal links.

2. **Store / All Products (`/store`)** — full catalog grid, left/top filter panel (category, tags, price range slider, rating), sort dropdown, pagination or infinite scroll, active-filter chips, results count, empty-state ("no products match").

3. **Categories (`/categories`)** — category grid/list browse, each tile → filtered store view.

4. **Product Detail (`/select?...`)**
   - Gallery (cover + gallery_urls carousel/lightbox), title, vendor byline (with link to vendor storefront), category & tag chips, rating summary + review count, price block (current + original + savings %), license_type, file_type/size, delivery_note.
   - Primary CTA: Add to Cart / Buy Now, secondary: Wishlist, Share.
   - Description (rich text), "What's included" / delivery note, FAQ accordion (if CMS-driven).
   - Reviews section: rating breakdown bars (5★…1★), sorted review list (title, body, rating, reviewer name, date, "Verified Buyer" badge), "Write a review" (only visible/enabled to verified purchasers), pagination.
   - Related/You-may-also-like rail (same category or vendor).
   - Sticky mobile buy bar.

5. **Vendor Storefront** (public page per vendor — logo/banner, bio, rating, product grid) — implied by `vendor_storefront()` RPC; include as a page in the design even if not yet a distinct route.

6. **Cart** (drawer or `/cart` panel within checkout) — line items (cover thumb, title, unit price, qty stepper 1–20, remove), subtotal, promo code input + applied discount line, continue shopping / proceed to checkout, empty-cart state.

7. **Checkout (`/checkout`)**
   - Step 1: Cart review (as above) + promo code apply/quote.
   - Step 2: Billing details form (name, email, country, address — maps to `billing` jsonb).
   - Step 3: Payment method select — Card / Bank transfer / Mobile Money / USSD / Apple/Google Pay (Flutterwave) OR Crypto (NOWPayments, coin picker).
   - Order summary sidebar persists across steps (subtotal, discount, total, currency).
   - Redirect-to-gateway transitional state ("Redirecting to secure payment…").
   - Error/decline state with retry.

8. **Order Success (`/success`)** — confirmation (order_no, amount, items), secure download button(s) (signed URL, expiry countdown/notice), "view in account" link, receipt/email notice, cross-sell rail.

9. **Auth (`/auth`)** — unified page, toggle Sign in / Create account, fields per mode, forgot-password state, email-confirmation-pending state, `next=` redirect notice, social proof or trust badges optional.

10. **Account Dashboard (`/account`)**
    - Overview: profile summary, quick stats (orders count, wishlist count).
    - Orders list (`#orders-list`): order_no, date, items, status badge, total, "Download" (if paid & not expired) / "View" actions; order detail drawer (line items, billing, payment status, download log/expiry).
    - Wishlist grid (add-to-cart from here).
    - Profile/settings form (full_name, phone, address, gender, country, occupation, age, locale, preferred_currency, marketing_opt_in, avatar upload, password change).
    - Entry points to "Seller centre" (if vendor) / "Start selling" (if not) / "Admin centre" (if admin).

11. **Blog (`/blog`)** — post grid (cover, title, excerpt, date), post detail page (content, related posts).

12. **About (`/about`)** — CMS-driven brand story page.

13. **Contact (`/contact`)** — contact form (feeds into ticket/email).

14. **Support (`/support`)** — ticket form (name, email, order_ref, category, subject, message) + FAQ list; ticket-submitted confirmation state.

15. **Static/legal pages** (CMS type "legal") — Terms, Privacy, Refund Policy — simple content template.

16. **404 / error states**, **maintenance/announcement banner** (site-wide, driven by `site_settings.announcement`).

### B. Vendor / Seller Console (`/vendor`)

1. **Apply as Vendor** (for non-vendor logged-in users) — application form (display_name, bio, logo/banner upload, support_email, website_url, country, payout_currency) → "Application submitted, pending review" state.
2. **Vendor Overview** — net revenue stat, "Next steps" onboarding checklist, activity feed.
3. **My Products** — CRUD table/grid, product modal (mirrors Product data model fields), publish toggle, status badges.
4. **Sales & Earnings** — earnings table (gross/commission/net/status, maturity date at +14 days), charts over time.
5. **Payouts** — payout accounts manager (method-specific forms: bank / mobile money / PayPal / crypto), set-default, verification badge; payout request flow + payout history table (status timeline).
6. **Boost & Ads** — campaign list, "Promote a product" modal (placement, budget, bid, dates, daily cap), performance stats (impressions/clicks/conversions/spend), review_status badge (pending/approved/rejected).
7. **Ad Wallet** — balance, lifetime topup/spend, transaction ledger, "Add funds" modal (amount, gateway choice: Flutterwave/crypto) → payment redirect flow (mirrors checkout gateway UX).
8. **Store Settings** — vendor profile edit (same fields as application).
9. **Suspended/rejected state screens** (status banners with reason).

### C. Admin Back-Office (`/admin`)

1. **Overview** — revenue-over-time chart, operations snapshot (orders/customers/products counts), top-earning products, category performance (backed by `admin_overview()`).
2. **Customers** — user table (profile fields, role), search/filter, customer detail drill-down (activity, orders).
3. **Transactions** — orders/payments table (status, provider, amount, order_no), filters, order detail (line items, billing, refund action).
4. **Products** — full catalog manager (all products across all vendors), add/edit modal (full Product model), image editor modal, feature/publish toggles, bulk actions.
5. **Categories** — CRUD table + add modal (name, slug, description, image, sort_order, active toggle).
6. **Promotions** — promo code CRUD (code, type, value, validity window, usage caps, active toggle), usage stats.
7. **Content (CMS & Journal)** — page/post/FAQ/announcement/legal/navigation editor: document list (status: draft/published/changed/unpublished), rich editor with draft/publish/unpublish/restore/duplicate actions, version history panel (`cms_revisions`), media library (`cms_assets` grid — upload, alt text, tags), edit-lock indicator ("being edited by X").
8. **Automation** — search-index queue status, publishing operations, scheduled/automation jobs list.
9. **Moderation (Sellers & Advertising)** — vendor application queue (approve/reject/suspend + reason), ad campaign review queue (approve/reject + note), ad top-up approval queue, payout request queue — unified `moderation_queue()` inbox pattern with tabs per entity type.
10. **Support Tickets** — queue (open/pending/closed), ticket detail + reply/close actions.
11. **Site Settings** — global settings form (site_title, support_email, announcement + active/expiry, tagline, socials, default_currency, checkout_note).
12. **Audit Log** — read-only append-only activity table (actor, action, entity, summary, timestamp) — filterable.

---

## 3. Core End-to-End Flows to Storyboard

1. **Guest → Buyer:** Home → browse/search/filter → Product Detail → Add to Cart → Cart review → Sign in/Guest checkout prompt → Billing → Payment method → Gateway redirect → Success (download) → Account → Order history → (post-purchase) Write a Review.
2. **Customer → Vendor:** Account → "Start selling" → Vendor application → Pending state → Approved notification → Vendor Overview → Add Product → (Admin approves visibility if needed) → Sales/Earnings accrue → Request Payout → Payout paid.
3. **Vendor Boosting:** Vendor → Boost & Ads → Fund Ad Wallet (gateway redirect) → Create Campaign → Admin reviews/approves → Campaign live → Performance stats update.
4. **Admin Moderation:** Moderation queue → review vendor/campaign/topup/payout → approve/reject with reason → audit log entry recorded.
5. **Support:** Contact/Support form → Ticket created → Admin Tickets queue → status open → pending → closed, with visibility to submitter (email).
6. **CMS Publishing:** Admin drafts content in CMS editor → autosave draft → preview → Publish → live on storefront (About/Blog/legal/homepage sections) → Revision history allows restore.

---

## 4. Design System Requirements

- **Foundations:** color tokens (light + dark), type scale, spacing scale, radius/elevation scale, icon set (Lucide-style line icons), grid (12-col desktop, 4-col mobile).
- **Component library:** buttons (primary/secondary/ghost/destructive, all sizes+states), form inputs (text/select/textarea/stepper/toggle/radio/file-upload), badges/status pills (order status, vendor status, campaign status, review status — each needs a distinct color mapping), cards (product card, order card, vendor card, blog card), tables (sortable, paginated, row actions), modals/drawers, toasts, tabs, accordions, stat/KPI tiles, charts (line/bar for revenue & performance), rating stars, avatar, breadcrumbs, pagination, empty states, skeleton loaders, banners/announcements.
- **Cross-cutting states every list/detail screen needs:** loading (skeleton), empty, error/retry, permission-denied (e.g., non-vendor viewing vendor pages, non-admin viewing admin).
- **Responsive:** mobile-first flows for storefront + account; desktop-first (data-dense) for vendor & admin consoles, with a usable tablet/mobile fallback.
- **Accessibility:** color contrast AA minimum, focus states, form error messaging tied to fields.

---

## 5. Figma File Organization (deliverable structure)

- Page: `00 - Foundations` (tokens, type, color, icons, grid)
- Page: `01 - Components` (atoms → molecules → organisms)
- Page: `02 - Storefront` (frames per route in §2A, mobile + desktop)
- Page: `03 - Auth & Account`
- Page: `04 - Cart & Checkout & Payment`
- Page: `05 - Vendor Console`
- Page: `06 - Admin Back-Office`
- Page: `07 - CMS/Content Editor`
- Page: `08 - Flows` (the storyboards from §3, as connected frame flows using Figma's flow/prototype arrows)

Each frame should be annotated with the underlying data fields it renders (per §1) so engineering can map design back to the schema 1:1 when implementing.
