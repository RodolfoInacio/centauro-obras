-- ============================================================================
-- Exclusão de obra em duas etapas: Arquivadas → Excluídas → exclusão definitiva.
-- Rode no SQL Editor do Supabase (uma vez), DEPOIS da migration_ficha_obra.sql.
-- Pode rodar de novo sem estragar nada.
--
-- Arquivar e mandar para Excluídas são só um campo no jsonb da obra (data->'arquivo'), gravado
-- pelo app como qualquer outra alteração. Este arquivo cuida da última etapa: apagar a linha.
--
-- O trigger obras_sem_delete continua recusando DELETE — de qualquer um, inclusive SQL Editor.
-- A única porta é a função obra_excluir_definitivo, que:
--   1. confere a senha (SHA-256, o texto não fica no repositório);
--   2. só aceita obra que já está em "Excluídas";
--   3. grava a obra inteira, com o histórico de arquivamento, em obras_excluidas;
--   4. liga uma flag local da transação que o trigger reconhece, e apaga.
-- O obras_historico_trg também grava a versão 'delete', como sempre gravou.
-- Agenda, cronograma, diário, lembretes, anexos e comentários NÃO são apagados: ficam no banco
-- com o obra_id, e os arquivos continuam no Storage (o bucket não tem policy de delete).
-- ============================================================================

create table if not exists public.obras_excluidas (
  id           bigserial primary key,
  obra_id      text not null,
  numero       text,
  cliente      text,
  excluida_em  timestamptz not null default now(),
  excluida_por text,
  data         jsonb                    -- a obra inteira no momento da exclusão
);
create index if not exists obras_excluidas_em_idx on public.obras_excluidas (excluida_em desc);

alter table public.obras_excluidas enable row level security;
drop policy if exists obras_excluidas_select on public.obras_excluidas;
create policy obras_excluidas_select on public.obras_excluidas for select using (public.is_admin());
-- Sem policy de insert/update/delete: só a função grava, e o registro não se altera.

drop trigger if exists obras_excluidas_imutavel on public.obras_excluidas;
create trigger obras_excluidas_imutavel before update or delete on public.obras_excluidas
  for each row execute function public.obras_historico_imutavel();
drop trigger if exists obras_excluidas_sem_truncate on public.obras_excluidas;
create trigger obras_excluidas_sem_truncate before truncate on public.obras_excluidas
  for each statement execute function public.obras_historico_imutavel();

-- O trigger passa a deixar apagar só a obra que a função liberou nesta transação.
create or replace function public.obras_sem_delete()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.excluir_obra', true) = old.id then
    return old;
  end if;
  raise exception 'Obra não se apaga direto. Arquive, mande para Excluídas e use "Excluir definitivamente" no app.';
end; $$;

create or replace function public.obra_excluir_definitivo(p_id text, p_senha text, p_por text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb;
  v_numero text;
  v_cliente text;
begin
  if not public.is_admin() then
    raise exception 'Sem permissão para excluir obra.';
  end if;
  if encode(sha256(convert_to(coalesce(p_senha, ''), 'UTF8')), 'hex')
     <> '6b75be1ff60b7abca42c2b6bca606109b79c998706ab8bf626a44e78899d796b' then
    raise exception 'Senha de exclusão incorreta.';
  end if;

  select data, numero, cliente into v_data, v_numero, v_cliente
    from public.obras where id = p_id for update;
  if not found then
    raise exception 'A obra % não existe mais.', p_id;
  end if;
  if coalesce(v_data->'arquivo'->>'estado', '') <> 'excluida' then
    raise exception 'Só dá para excluir de vez uma obra que já está em Excluídas.';
  end if;

  -- O registro leva o último passo do histórico também.
  v_data := jsonb_set(v_data, '{arquivo,historico}',
    coalesce(v_data->'arquivo'->'historico', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('acao', 'excluida_definitivo', 'em', now(), 'por', coalesce(p_por, ''))));

  insert into public.obras_excluidas (obra_id, numero, cliente, excluida_por, data)
  values (p_id, v_numero, v_cliente, nullif(p_por, ''), v_data);

  perform set_config('app.excluir_obra', p_id, true);
  delete from public.obras where id = p_id;
  perform set_config('app.excluir_obra', '', true);
end; $$;

revoke all on function public.obra_excluir_definitivo(text, text, text) from public, anon;
grant execute on function public.obra_excluir_definitivo(text, text, text) to authenticated;
