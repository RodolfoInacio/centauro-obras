-- ============================================================================
-- Lembretes: mural fixo do escritório, ao lado do calendário
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
-- Lista única e geral: não é por mês nem por dia. As colunas soltas existem só para
-- ordenar/filtrar — a fonte de verdade é o jsonb "data", como nas outras tabelas.
create table if not exists public.lembretes (
  id         text primary key,
  texto      text,
  prazo      date,
  arquivado  boolean default false,
  ordem      int,
  updated_at timestamptz default now(),
  data       jsonb not null
);

create index if not exists lembretes_prazo_idx on public.lembretes (prazo);

alter table public.lembretes enable row level security;

drop policy if exists lembretes_admin on public.lembretes;
create policy lembretes_admin on public.lembretes for all
  using (public.is_admin()) with check (public.is_admin());
