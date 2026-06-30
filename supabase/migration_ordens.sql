-- ============================================================================
-- Ordens de Serviço (O.S.) por equipe — rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
create table if not exists public.ordens (
  id             text primary key,
  numero         int,
  equipe_id      text,
  periodo_inicio date,
  periodo_fim    date,
  updated_at     timestamptz default now(),
  data           jsonb not null
);

alter table public.ordens enable row level security;

drop policy if exists ordens_admin on public.ordens;
create policy ordens_admin on public.ordens for all
  using (public.is_admin()) with check (public.is_admin());
