# Figma → Real Site Rebuild — Progress Checkpoint

**Figma file:** `LzTCRyBdXF1p7V5RSwXlSN` ("Storefront" canvas, node `0:1`), all frames 1440px wide, flat under root.
**Reference brief:** [../../figma-design-brief.md](../../figma-design-brief.md) — data model + full flow spec.
**Stack (unchanged):** static multi-page HTML, Tailwind (CDN) + `css/app.css` custom classes, vanilla JS per-page (`js/*.js`), shared header/footer/loader/toast in `js/ui.js`, Supabase (Postgres+RLS+Edge Functions) as backend — **no framework migration**, we are re-skinning/upgrading the existing architecture, not replacing it.

**Rule for every page below:** pull design via `get_design_context` (figma-design-to-code skill), adapt (don't paste verbatim) into the existing HTML/Tailwind/vanilla-JS conventions, reuse the shared UI kit (Phase 0) instead of one-off styles, wire every dynamic value to the REAL Supabase schema/RPCs (no placeholder data), and update this file's status column before finishing.

## Status legend
`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked/needs decision

---

## Phase 0 — Foundation (do first, everything else depends on it)

- [x] Extract design tokens (color, type scale, spacing, radius, shadow) from Figma into `css/app.css` `:root` vars, light+dark.
- [x] Shared UI kit components (new, in `css/app.css` + a new `js/uikit.js`):
  - [x] Modal/dialog (generic, reused by all admin/vendor CRUD modals) — `openModal()`, `.uk-modal`
  - [x] Confirmation dialog (destructive-action pattern) — `confirmDialog({title, body, confirmLabel, danger}) -> Promise<boolean>`
  - [x] Toast (extend existing `toast()` in `js/ui.js` to match new visual language, add variants: success/error/info/warning) — restyled to tokens, all 4 variants have distinct glyph + accent color
  - [x] Tooltip — `attachTooltip(el, text)`, CSS-only `.uk-tip`
  - [x] Popover (extend existing account popover pattern into a generic popover primitive) — `attachPopover(trigger, html)`; the header's own account popover is left on its original `<details>` pattern (it already worked and wasn't broken), the new primitive is for future dashboard menus
  - [x] Skeleton loader — 3 variants: **full-page** (existing `#page-loader` shimmer, retoned to tokens), **inline/section** (`skeletonCardGrid()`/`paintSkeletonGrid()`, used live by the homepage rails while `storefront_rails()` loads), **button/inline-progress** (`inlineSpinner()`, `setButtonBusy()`)
  - [x] Empty state pattern — `emptyState({icon, title, body, ctaLabel, ctaHref})`, used live by the homepage rails/tables when a section has no results
  - [x] Status/badge pill system — `statusBadge()`/`statusVariant()`, one lookup table mapping every status string in the data model (paid/approved/active/published/pending/processing/draft/failed/rejected/suspended/... ) to success/warning/danger/info/neutral
  - [x] Tabs primitive — `initTabs(root)`, `.uk-tabs__list` / `[data-uk-tab]` / `[data-uk-tab-panel]`
  - [x] Data table primitive — `renderDataTable(host, {columns, rows, page, pageSize, total, onSort, onPage, rowActions})`, sortable header click + row-actions slot + pagination footer
  - Note: none of Phase 0's kit components except the toast/skeleton/empty-state are consumed by the Homepage itself (modal/confirm/tabs/data-table have no natural home on a public storefront page) — they're built, styled, and ready for Phase 2/3/4 to import from `js/uikit.js`, not yet exercised in a live screen beyond what's listed above.

## Phase 1 — Public Storefront (8 Figma screens)

| # | Screen | Figma node | Target file(s) | Status |
|---|---|---|---|---|
| 1 | Homepage | `3:8` | `index.html`, `js/storefront.js` | [x] |
| 2 | Store / All Products | `3:1294` | `store.html`, `js/store.js` | [x] |
| 3 | Product Detail | `3:1939` | `product.html`, `js/product.js` | [x] |
| 4 | Categories | `3:2343` | `categories.html`, `js/categories.js` | [x] |
| 5 | About | `3:2660` | `about.html`, `js/about.js` | [x] |
| 6 | Contact | `3:2868` | `contact.html`, `js/contact.js` | [x] |
| 7 | Blog (list + post detail sub-page) | `3:3020` | `blog.html`, `js/blog.js` | [x] (list only — no detail-page Figma frame exists) |
| 8 | Support | `3:3184` | `support.html`, `js/support.js` | [x] |

Extra sub-pages implied but not separate Figma frames yet (flag if missing, build to match kit): Vendor public storefront page, Blog post detail, 404/error page, legal/terms/privacy template.

## Phase 2 — Auth / Account / Checkout flow (5 Figma screens)

| # | Screen | Figma node | Target file(s) | Status |
|---|---|---|---|---|
| 9 | Auth (sign in/up) | `1:3532` | `auth.html`, `js/auth.js` | [x] |
| 10 | Account Dashboard (+ tabs: Overview/Orders/Wishlist/Profile) | `1:3640` | `account.html`, `js/account.js` | [x] |
| 11 | Cart | `1:3777` | `cart.html`, `js/cart.js` (real page, not a drawer — see notes) | [x] |
| 12 | Checkout (3-step: cart review → billing → payment) | `1:3893` | `checkout.html`, `js/checkout.js` (real multi-item rebuild, matches Figma structure — see notes) | [x] |
| 13 | Order Success | `1:4014` | `success.html`, `js/success.js` | [x] |

## Phase 3 — Vendor Dashboard (6 Figma screens, each likely a tab within `vendor.html`)

| # | Screen | Figma node | Status |
|---|---|---|---|
| 14 | V01 Overview | `1:4148` | [x] |
| 15 | V02 My Products | `1:4311` | [x] |
| 16 | V03 Sales & Earnings | `1:4579` | [x] |
| 17 | V04 Payouts | `1:4774` | [x] |
| 18 | V05 Boost & Ads | `1:4921` | [x] |
| 19 | V06 Ad Wallet | `1:5084` | [x] |

Plus: vendor application (pending/approved/rejected/suspended states), product add/edit modal, payout account modal, campaign creation modal, add-funds modal.

## Phase 4 — Admin Dashboard (11 Figma screens, tabs within `admin.html`) — **user flagged: enrich CMS section especially**

| # | Screen | Figma node | Status |
|---|---|---|---|
| 20 | A01 Overview | `1:5281` | [x] |
| 21 | A02 Customers | `1:5533` | [x] |
| 22 | A03 Transactions | `1:5789` | [x] |
| 23 | A04 Products Manager | `1:6071` | [x] |
| 24 | A05 Categories Manager | `1:6387` | [x] |
| 25 | A06 Promotions | `1:8054` | [x] |
| 26 | A07 CMS / Content Editor — **enrich**: document list w/ status, rich editor, draft/publish/unpublish/restore/duplicate, version history panel, media library grid, edit-lock indicator | `1:6922` | [x] |
| 27 | A08 Moderation Queue (vendors/campaigns/topups/payouts tabs) | `1:7158` | [x] |
| 28 | A09 Support Tickets | `1:7335` | [x] |
| 29 | A10 Site Settings | `1:7530` | [x] |
| 30 | A11 Audit Log | `1:7688` | [x] |

---

## Session notes

**2026-08-26 — Admin Back-Office rebuilt (Phase 4, all 11 screens; CMS enriched)**

Replaced the pre-rebuild `admin.html`/`js/admin.js` (hardcoded `#142c55` navy, `soft-panel`/`admin-sidebar` utility soup) with the same "sidebar nav + hash-routed content panels" shell shape used for Phase 3's vendor console, scoped under a new `.adm-` class prefix in `css/app.css` (mirrors `.vnd-` — shell/sidebar/nav/content/tab-panel/stat-grid/two-col/panel — plus new CMS-editor, moderation-row, media-grid, version-history, lock-banner, and settings/audit-row rules). `admin.html` now includes the shared `#site-header`/`#site-footer`/`#page-loader` via `mountHeader()`/`mountFooter()` from `js/ui.js`, same as `vendor.html`/`account.html`; the sidebar groups the 11 screens under Operations / Catalog / Content / Marketplace / Support / System headings and routes on `location.hash`.

Preserved and adapted (not re-derived) the real Supabase wiring already in the old `js/admin.js`: the `admin-dashboard` Edge Function still drives Overview/Customers/Transactions/Products/Categories/Promotions/Tickets in one fetch, and `moderation_queue()` + `moderate_vendor`/`moderate_campaign`/`settle_ad_topup`/direct `payouts`/`vendor_earnings` writes still drive the Moderation queue — now rendered through `renderDataTable()`/`statusBadge()`/`confirmDialog()`/`openModal()` from `js/uikit.js` instead of hand-rolled pagination and raw `<dialog>` markup, and the moderation vendors/campaigns/topups/payouts sub-views are real `initTabs()`-driven tabs (`uk-tabs__btn`/`uk-tabs__panel`) instead of four stacked panels. Product image/file upload now uses the same direct `supabase.storage.upload()` pattern as `js/vendor.js`'s product modal (dropped the old bespoke canvas crop/compress tool — out of scope for a straight Figma rebuild and duplicative of the kit's upload conventions; noted here as a deliberate simplification). Transactions gained a real order-detail modal reading `order_items` (was previously list-only). Site Settings now edits the full `site_settings` row (`tagline`, `social` jsonb, `announcement_active`/`announcement_ends_at`, `default_currency`, `checkout_note`), not just the three fields the old CMS form exposed. Audit Log is new — a straight read of `audit_log` (RLS already scoped admin-only) with client-side search/entity filtering, intentionally kept simple per its "read-only, don't over-invest" instruction.

**CMS enrichment (A07) — the deep screen.** Built as a real two-pane content workspace (document list + editor), not a form, wired entirely to the `cms_*` RPC surface added in `20260824102000_cms.sql` (`cms_save`/`cms_publish`/`cms_unpublish`/`cms_restore`/`cms_duplicate`/`cms_delete`/`cms_claim_lock`/`cms_release_lock`) plus direct reads of `cms_documents`/`cms_revisions`/`cms_assets`:
- Document list (`renderDataTable`-free, custom list to keep the two-pane layout) shows status pill (draft/published/changed/unpublished via the existing `statusBadge()` lookup, which already covered all four CMS states), type, version and updated-at, with type + text filters.
- The editor renders **type-specific structured fields** (a small per-type schema for `page`/`post`/`author`/`faq`/`announcement`/`legal`/`navigation`/`homepage`, e.g. heading/body/SEO for a page, question/answer for a FAQ) rather than one generic textarea, plus an "advanced extra fields (JSON)" box so nothing in an unusual draft payload is ever silently dropped on save. Draft vs published are visibly distinct: **Save draft** (`cms_save`, optimistic-locked on `version`) and **Publish** (`cms_save` then `cms_publish`) are separate actions, and the editor shows an explicit "unpublished changes" note when `draft ≠ published`. **Unpublish**, **Duplicate** and **Delete** are wired to their respective RPCs, with `confirmDialog()` gates on the destructive ones.
- **Version history** tab reads `cms_revisions` (version, action, actor email, timestamp) with a **Restore** button per row wired to `cms_restore`.
- **Media library** tab reads `cms_assets` as a thumbnail grid (dimensions/size shown), uploads new files straight to the `product-images` bucket (same bucket/pattern the CMS storage policies already grant admins, mirroring the upload convention from `js/vendor.js`/old `js/admin.js`), inserts the resulting row into `cms_assets`, and backfills width/height for images asynchronously after upload. Actions: copy URL (to paste into a body field), delete asset.
- **Edit-lock indicator**: on selecting a document, the client calls `cms_claim_lock`, which is a genuine soft lock in the schema — not a UI-only approximation. If another admin holds it, a banner reads "Being edited by X" and the Save/Publish controls disable (view stays live). The client refreshes its own lock every 90s while the document stays open (the lock auto-expires server-side after 3 minutes of no refresh) and releases it via `cms_release_lock` on switching documents or signing out. **Known limitation**: release-on-tab-close/crash isn't handled (no reliable way to fire an authenticated RPC from `beforeunload`), so a lock can go stale for up to 3 minutes if an admin closes the tab mid-edit — acceptable given the schema's own comment describes this as intentionally a "soft lock… stale locks cannot wedge a document."
- **Scope note**: the storefront's live blog (`blog.html`) still reads from the older `blog_posts` table, which is a separate table from `cms_documents`. The design brief's CMS Document data model (§1) and this phase's instructions both point at `cms_documents`/`cms_revisions`/`cms_assets`/`cms_locks`, so the new CMS & Journal screen manages that system, not `blog_posts` — `blog_posts` CRUD from the old admin was dropped from this screen. `blog.html` itself was out of scope for this phase and was not touched.

**Verification**: mocked Supabase REST/auth/RPC/Edge-Function responses with Playwright (`scratchpad/verify-admin.mjs`, kept alongside the Phase 3 vendor scripts) and screenshotted all 11 panels, the CMS editor's Edit/Version-history/Media-library sub-tabs, the moderation sub-tabs, and the product add modal, in both light and `prefers-color-scheme: dark`. Caught and fixed one real bug this way: `supabase.rpc(...).catch(...)` isn't valid (`PostgrestFilterBuilder` is thenable but has no `.catch` method) and threw a page error on every CMS document open — replaced with `try/catch` around `await`. Also caught a dark-mode contrast bug introduced by this phase: the new `.adm-cms-tab-btn.is-active` and `.adm-media-upload:hover` rules paired `--accent-ink` (near-black, undefined for dark mode — by design, since it's meant for text on the always-gold `--accent` background) against `--surface-sunken` (near-black in dark mode), making the active CMS tab label invisible in dark mode; fixed by switching both to the same text-on-surface + accent-underline/border convention `.uk-tabs__btn.is-active` already uses elsewhere. Zero console errors in either theme after the fixes. Non-admin/unauthenticated redirect logic mirrors `vendor.js`'s pattern (`getAccount()` → redirect to `auth` if signed out, to `account` if signed in but `profile.role !== 'admin'`) and was not separately re-verified beyond code review, since it is unchanged from the already-working prior implementation.

**Pre-existing gap noted, not fixed (out of scope for this phase)**: `.field` (the shared text-input/textarea/select class used site-wide) has a hardcoded `background: #fff` with no dark-mode override, so form inputs render as light boxes inside otherwise-dark admin/vendor/checkout panels. This predates Phase 4, affects every page with a form, and fixing it is a Phase-0-level token change outside this phase's file scope — flagged here for whoever picks up a future dark-mode polish pass.

