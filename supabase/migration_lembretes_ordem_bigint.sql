-- ============================================================================
-- Lembretes: `ordem` precisa ser bigint, não int
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
-- O app grava `ordem: Date.now()` (~1.79e12, e crescendo) como número de criação, do
-- mesmo jeito que a agenda faz. A coluna nasceu `int`, que só vai até 2.147.483.647,
-- então todo lembrete novo era recusado com:
--   value "1788184147925" is out of range for type integer
-- A agenda não sofria disso porque lá o `ordem` mora só dentro do jsonb.
--
-- Seguro de rodar mais de uma vez, e seguro com dados dentro: bigint comporta todo
-- int, então o ALTER não perde nem converte nada.

alter table public.lembretes
  alter column ordem type bigint;
