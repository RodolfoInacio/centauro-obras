-- ============================================================================
-- Cronograma Comercial (mini MS Project) — rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
create table if not exists public.cronogramas (
  id         text primary key,
  titulo     text,
  obra_id    text,
  updated_at timestamptz default now(),
  data       jsonb not null
);

alter table public.cronogramas enable row level security;

drop policy if exists cronogramas_admin on public.cronogramas;
create policy cronogramas_admin on public.cronogramas for all
  using (public.is_admin()) with check (public.is_admin());
