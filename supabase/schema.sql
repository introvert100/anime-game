-- =========================================================
-- Sakura Dash — Supabase schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- =========================================================

create extension if not exists pgcrypto;

create table if not exists public.scores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 12),
  score       integer not null check (score >= 0 and score <= 1000000),
  created_at  timestamptz not null default now()
);

-- Index to make "top 10" queries fast as the table grows.
create index if not exists scores_score_desc_idx
  on public.scores (score desc, created_at asc);

-- Row Level Security: lock the table down by default.
alter table public.scores enable row level security;

-- The Node backend talks to Supabase using the SERVICE ROLE key,
-- which bypasses RLS entirely — so technically no policy is required
-- for the app to work. We still add a narrow "anon read" policy below
-- in case you ever want to query scores directly from the browser
-- with the public anon key (e.g. for a future client-only version).

drop policy if exists "Public can read scores" on public.scores;
create policy "Public can read scores"
  on public.scores
  for select
  to anon
  using (true);

-- Intentionally NOT adding an anon INSERT policy.
-- Score submission should always go through the backend (server/server.js),
-- which validates name/score server-side before writing with the service
-- role key. This prevents anyone from POSTing fake scores directly to
-- Supabase from the browser using the anon key.
