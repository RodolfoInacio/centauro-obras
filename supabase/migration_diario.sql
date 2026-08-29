-- ============================================================================
-- Diário de Obras: um registro por obra por dia (RDO enxuto) + bucket das fotos
-- Rode no SQL Editor do Supabase (uma vez)
-- ============================================================================
create table if not exists public.diarios (
  id         text primary key,
  obra_id    text,
  dia        date,
  numero     int,
  updated_at timestamptz default now(),
  data       jsonb not null
);

create index if not exists diarios_obra_idx on public.diarios (obra_id, dia);
-- Chave de negócio é obra + dia. O índice único impede dois registros do mesmo dia
-- nascerem por duas abas abertas ao mesmo tempo.
create unique index if not exists diarios_obra_dia_uidx on public.diarios (obra_id, dia);

alter table public.diarios enable row level security;

drop policy if exists diarios_admin on public.diarios;
create policy diarios_admin on public.diarios for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- STORAGE: bucket público "diario" (fotos do dia, com e sem marcação)
-- Mesmas políticas do bucket "desenhos" do schema.sql.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('diario', 'diario', true)
on conflict (id) do nothing;

-- leitura pública (a folha impressa é só um <img> apontando para a URL)
drop policy if exists diario_read on storage.objects;
create policy diario_read on storage.objects for select
  using (bucket_id = 'diario');

drop policy if exists diario_write on storage.objects;
create policy diario_write on storage.objects for insert to authenticated
  with check (bucket_id = 'diario');

drop policy if exists diario_update on storage.objects;
create policy diario_update on storage.objects for update to authenticated
  using (bucket_id = 'diario');

drop policy if exists diario_delete on storage.objects;
create policy diario_delete on storage.objects for delete to authenticated
  using (bucket_id = 'diario');
