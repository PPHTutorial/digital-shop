# DigiStore 2.0 — upgrade plan and progress

Working document for the platform rebuild. Delete once the work has shipped and
the README covers everything here.

## Constraints discovered

- The build environment has **no network access** (DNS fails sandboxed and
  unsandboxed). Live Supabase verification and deployment must be run by the
  operator; this repo ships the test suite and CI that perform it.
- Hosting stays static (GitHub Pages + Supabase). No server-side rendering, so
  the toolchain must produce plain files.

## Design direction

Replacing the generated-looking surface with a designed one:

| Removed | Replaced with |
|---|---|
| `cdn.tailwindcss.com` (prints a production warning) | Owned CSS system in `css/src/*.css`, bundled by `tools/build.mjs` |
| `unpkg.com/lucide@latest` (unpinned CDN, two-pass hydration) | `js/icons.js` — inline SVG, no request |
| Capsule pills, `rounded-full`, `rounded-3xl` | 2–4px radii; chips and tags are rectangles |
| Coloured glow shadows | 1px rules; shadow only on overlays |
| Gradient bands, blur orbs | Flat ink surface, serif display type |
| `font-black` everywhere | 400/500/600 with a real type scale |
| Blue-grey slate palette | Warm neutral ramp, single restrained accent |
| Emoji in empty states | Line icons |
| Ad-hoc layout per page | 12-column grid + composition primitives |

## Status

### Done

- [x] `package.json`, `.editorconfig`, `.nvmrc`, tooling scaffold
- [x] `css/src/01-reset` … `09-utilities` — full design system
- [x] `tools/build.mjs` — CSS bundle + cache-stamping of HTML
- [x] `tools/dev-server.mjs` — zero-dependency static server
- [x] `tools/generate-config.mjs` — env → `js/config.js`, refuses service keys
- [x] `js/icons.js` — inline icon set
- [x] `js/format.js` — money/date/number/slug formatting
- [x] `js/dom.js` — escaping `html` tag, delegation, focus trap, query helpers
- [x] `js/config.js` — validated public config
- [x] `js/client.js` — Supabase client, error mapping, `callFunction`, guards
- [x] `js/ui.js` — header, footer, drawer, toast, dialog, theme
- [x] `supabase/migrations/20260822000000_digistore_schema.sql` — baseline
- [x] `…100000_core_hardening.sql` — helpers, audit log, indexes, settings
- [x] `…101000_commerce.sql` — sales counters, order items, cart, wishlist,
      reviews, **server-side `create_order`** (closes the client-set-price hole)
- [x] `…102000_cms.sql` — documents, revisions, assets, locks, RPCs, RLS

### Remaining

- [x] `…103000_search_and_analytics.sql` — search_products, catalog_facets,
      storefront_rails, admin_overview
- [x] `…104000_cms_seed.sql` — legal, FAQ, homepage, about starter content
- [x] `js/studio/*` + `studio.html` — schema DSL, validation, two store
      adapters, desk/list/editor panes, field kit, block editor, media library,
      revisions, soft locks, command palette
- [x] `js/portable-text.js` — shared block renderer + sanitiser
- [x] `js/product-card.js` — single card renderer, rails, share
- [x] `tools/check.mjs` — JS/HTML/CSS/SQL/design-rule linting
- [x] index.html + storefront.js
- [x] store.html + store.js (server-side search & facets)
- [x] product.html + product.js (new PDP, reviews, wishlist)
- [x] checkout.html + checkout.js (server-priced orders)
- [ ] auth.html, account.html, success.html, support.html, blog.html,
      post.html, legal.html, about.html, contact.html
- [ ] admin.html + js/admin/*
- [ ] Edge Functions: server-side FX in create-flutterwave-payment,
      download audit + multi-item in download-book
- [ ] .github/workflows/deploy.yml
- [ ] tests/unit + tests/integration
- [ ] README rewrite


## Security fixes folded into this work

1. **Client-priced orders.** The old `users create own pending orders` policy let
   the browser insert an order with any `amount`. Policy dropped; orders are now
   created by `create_order()`, which prices the basket from the products table.
2. **Committed secrets.** `js/config.js` now refuses to hold anything but public
   values, and `tools/generate-config.mjs` rejects service-role JWTs.
3. **No audit trail.** `audit_log` plus `record_audit()` records every
   privileged mutation; admins can read it but not write it.
4. **Unbounded storage access.** Explicit storage policies: `product-images`
   public-read/admin-write, `books` admin-only with delivery via signed URL.
