-- The twenty categories that cover the overwhelming majority of digital-product
-- marketplaces. Seeded idempotently: re-running refreshes the description,
-- image, and ordering of an existing row without disturbing its id (so any
-- product already pointing at it keeps working) and without reactivating a
-- category the operator has deliberately switched off.
insert into public.categories (name, slug, description, sort_order, is_active)
values
  ('Ebooks & Guides',            'ebooks-guides',            'Long-form reads, playbooks, and how-to guides delivered as EPUB or PDF.',       10, true),
  ('Online Courses',             'online-courses',           'Structured video and written lessons, cohorts, and workshop recordings.',       20, true),
  ('Templates & Themes',         'templates-themes',         'Website, email, and document templates ready to brand and publish.',           30, true),
  ('Software & Apps',            'software-apps',            'Desktop, mobile, and web applications sold as a download or licence.',          40, true),
  ('Design & Graphics',          'design-graphics',          'Illustrations, icon sets, vectors, and print-ready artwork.',                   50, true),
  ('Photography & Presets',      'photography-presets',      'Stock photography, Lightroom presets, LUTs, and editing profiles.',            60, true),
  ('Audio & Music',              'audio-music',              'Beats, sample packs, sound effects, loops, and mastering-ready stems.',         70, true),
  ('Video & Motion',             'video-motion',             'Stock footage, motion graphics, transitions, and After Effects projects.',      80, true),
  ('Fonts & Typography',         'fonts-typography',         'Typefaces, lettering sets, and complete type families with licences.',         90, true),
  ('UI Kits & Wireframes',       'ui-kits-wireframes',       'Figma, Sketch, and Adobe XD component libraries and design systems.',         100, true),
  ('Productivity Templates',     'productivity-templates',   'Notion, Obsidian, and Airtable systems for planning and knowledge work.',     110, true),
  ('Stock Media & Assets',       'stock-media-assets',       'Mixed-media asset bundles licensed for commercial reuse.',                    120, true),
  ('Plugins & Extensions',       'plugins-extensions',       'Add-ons for WordPress, Shopify, browsers, and creative software.',            130, true),
  ('Game Assets',                'game-assets',              'Sprites, tilesets, shaders, and ready-to-import Unity and Unreal packs.',     140, true),
  ('3D Models & Assets',         '3d-models-assets',         'Meshes, textures, materials, and rigs for rendering and production.',         150, true),
  ('Marketing & Ad Creatives',   'marketing-ad-creatives',   'Ad creative sets, funnels, landing pages, and campaign swipe files.',         160, true),
  ('Business & Legal Documents', 'business-legal-documents', 'Contracts, policies, pitch decks, and operating documents.',                  170, true),
  ('Spreadsheets & Models',      'spreadsheets-models',      'Financial models, dashboards, trackers, and calculators.',                    180, true),
  ('Printables & Planners',      'printables-planners',      'Print-at-home planners, journals, wall art, and worksheets.',                 190, true),
  ('AI Prompts & Models',        'ai-prompts-models',        'Prompt libraries, fine-tunes, agent workflows, and AI toolkits.',             200, true)
on conflict (slug) do update
set name        = excluded.name,
    description = excluded.description,
    sort_order  = excluded.sort_order,
    updated_at  = now();
