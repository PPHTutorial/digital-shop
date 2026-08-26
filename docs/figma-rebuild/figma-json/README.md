# Figma raw JSON (all 30 screens)

Fetched directly from the Figma REST API (`GET /v1/files/:key/nodes?ids=...`),
not the rate-limited MCP `get_design_context` tool — the MCP server is on a
Starter plan (20 calls/month) and was exhausted after Homepage + Store. The
REST API has its own, much higher limit and needs only a personal access
token (kept out of the repo, session-local only).

File key: `LzTCRyBdXF1p7V5RSwXlSN` ("Storefront" canvas).

Each file here is `{ nodes: { "<id>": <full Figma node tree> } }` for exactly
one top-level frame — the same shape the REST API returns, just split apart
so each screen is its own file. Filenames are `<screen>-<node-id-with-dashes>.json`,
matching the screen table in `../PROGRESS.md`.

## Using this for a new page

1. Read the target screen's JSON here directly, or run the tree extractor
   for a readable summary (position, size, fill color, font, text) instead
   of the raw node graph — much easier to scan:

   ```
   node docs/figma-rebuild/figma-json/extract-tree.mjs \
     docs/figma-rebuild/figma-json/<screen>.json <node-id> > /tmp/tree.txt
   ```

2. For exact pixel values (position/size/radius/font-size/weight/color) of a
   *specific* element, query the JSON directly instead of guessing from the
   tree dump — `node.absoluteBoundingBox`, `node.style.fontSize` /
   `fontWeight` / `fontFamily`, `node.cornerRadius`, `node.fills[0].color`.
   Positions are absolute canvas coordinates; subtract the frame's own
   `absoluteBoundingBox.x/y` to get coordinates relative to the frame.

3. After implementing, don't just eyeball a screenshot — measure the live
   page the same way (Playwright `boundingBox()` / `getComputedStyle()`) and
   diff the numbers against step 2. This caught several real bugs a visual
   comparison alone missed (padding that never reached its clamp() max,
   flex-grow where Figma actually uses a fixed width, wrong border-radius
   tokens, etc.) — see the 2026-08-26 entries in `../PROGRESS.md`.

## Project-wide layout convention (settled 2026-08-26)

The site's container max-width is **1440px** (the frame width itself, not
the content area after padding) — `.shell` and the header-scoped
`.header-shell` in `css/app.css` both use `max-width:1440px` with
`padding-inline` creating the inset (80px for header chrome via
`clamp(20px, 6vw, 80px)`, 24px for general body content via `.shell`). Use
`.header-shell` for any new full-bleed chrome band; use `.shell` for normal
page content.
