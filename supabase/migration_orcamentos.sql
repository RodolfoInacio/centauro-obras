-- ============================================================================
-- Orçamentos livres (tela 🧾 Orçamentos): orçamento rápido feito no próprio app, fora do Wvetro
-- (serviço avulso, acabamento, cantoneira em todos os vãos, manutenção…).
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
-- Mesmo padrão das outras tabelas: colunas soltas só para busca/ordenação e o orçamento
-- inteiro no jsonb. Sem a tabela o app não quebra: a lista vem vazia e a gravação avisa.
create table if not exists public.orcamentos (
  id         text primary key,
  numero     text not null,
  cliente    text,
  status     text,
  obra_id    text,            -- vínculo opcional com uma obra (sem FK, como no estoque)
  updated_at timestamptz default now(),
  data       jsonb not null
);

-- Número repetido (duas abas criando ao mesmo tempo) é recusado em vez de virar dois "L-0007".
create unique index if not exists orcamentos_numero_unico on public.orcamentos (numero);

alter table public.orcamentos enable row level security;

drop policy if exists orcamentos_admin on public.orcamentos;
create policy orcamentos_admin on public.orcamentos for all
  using (public.is_admin()) with check (public.is_admin());
