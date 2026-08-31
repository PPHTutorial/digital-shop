# Project: HTML/JS + Supabase Web App

## Core Stack
- Frontend: Vanilla HTML5, CSS3 (Modern features only, no frameworks), ES6+ JavaScript.
- Backend: Supabase (Auth, Database, Storage).

## Database Schema & State Cheat Sheet
- Users: auth.users (handled via Supabase Auth)
- Profiles: public.profiles (id UUID references auth.users, username TEXT)
- Tasks: public.tasks (id SERIAL, user_id UUID references auth.users, title TEXT, completed BOOLEAN)

## Coding Standards & Token Constraints
- NEVER search or scan directories recursively. Ask me for paths if unsure.
- Do NOT output boilerplate HTML or whole CSS files if modifying a single line.
- Provide targeted code diffs or precise snippets only.
- Write vanilla `supabase-js` v2 client queries directly. Always assume Row Level Security (RLS) is active on tables.
