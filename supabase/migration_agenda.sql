-- ============================================================================
-- Agenda do dia: serviço = obra (ou avulso) + equipe + período
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
create table if not exists public.agenda (
  id         text primary key,
  dia        date,
  equipe_id  text,
  obra_id    text,
  updated_at timestamptz default now(),
  data       jsonb not null
);

create index if not exists agenda_dia_idx on public.agenda (dia);

alter table public.agenda enable row level security;

drop policy if exists agenda_admin on public.agenda;
create policy agenda_admin on public.agenda for all
  using (public.is_admin()) with check (public.is_admin());
