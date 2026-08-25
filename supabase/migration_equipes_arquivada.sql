-- ============================================================================
-- Equipe arquivada em vez de excluída — rode no SQL Editor do Supabase (uma vez)
-- Arquivar tira a equipe das listas de escolha, mas mantém os serviços que ela já
-- tem no calendário (histórico de quem fez o quê).
-- ============================================================================
alter table public.equipes add column if not exists arquivada boolean default false;
