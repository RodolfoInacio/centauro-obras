-- ============================================================================
-- Configurações do app (tela ⚙️ Configurações): valem para todos os computadores
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
-- Uma linha só (id = 'geral') com o objeto inteiro no jsonb, como nas outras tabelas.
-- Sem a tabela o app não quebra: usa os valores padrão e a tela avisa que não dá para salvar.
create table if not exists public.configuracoes (
  id         text primary key,
  updated_at timestamptz default now(),
  data       jsonb not null
);

alter table public.configuracoes enable row level security;

drop policy if exists configuracoes_admin on public.configuracoes;
create policy configuracoes_admin on public.configuracoes for all
  using (public.is_admin()) with check (public.is_admin());
