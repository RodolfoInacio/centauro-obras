-- ============================================================================
-- Excluir negociação declinada (botão 🗑 na pasta Declinadas do 💼 Comercial).
-- Rodar no SQL Editor do Supabase DEPOIS da migration_comercial.sql. Pode rodar de novo.
--
-- O trigger negociacoes_sem_delete continua recusando DELETE de qualquer um. A única porta é a
-- função negociacao_excluir, que:
--   1. só aceita quem é master (profiles.master);
--   2. só aceita negociação declinada;
--   3. guarda a negociação inteira em negociacoes_excluidas (imutável);
--   4. libera o trigger só para aquele id nesta transação, e apaga.
-- Anexos e comentários (obra_anexos/obra_comentarios com o id NEG-…) NÃO são apagados.
-- Por isso o número nunca volta a ser usado: o app conta os excluídos ao numerar, e um trigger
-- recusa INSERT com id que já foi excluído (senão os anexos antigos grudariam na negociação nova).
-- ============================================================================

create table if not exists public.negociacoes_excluidas (
  id           bigserial primary key,
  neg_id       text not null,
  numero       text,
  cliente      text,
  excluida_em  timestamptz not null default now(),
  excluida_por text,
  data         jsonb                    -- a negociação inteira no momento da exclusão
);
create index if not exists negociacoes_excluidas_neg_idx on public.negociacoes_excluidas (neg_id);

alter table public.negociacoes_excluidas enable row level security;
drop policy if exists negociacoes_excluidas_select on public.negociacoes_excluidas;
create policy negociacoes_excluidas_select on public.negociacoes_excluidas for select using (public.is_admin());
-- Sem policy de insert/update/delete: só a função grava, e o registro não se altera.

create or replace function public.negociacoes_excluidas_imutavel()
returns trigger language plpgsql as $$
begin
  raise exception 'Registro de negociação excluída não se altera nem se apaga.';
end; $$;
drop trigger if exists negociacoes_excluidas_imutavel on public.negociacoes_excluidas;
create trigger negociacoes_excluidas_imutavel before update or delete on public.negociacoes_excluidas
  for each row execute function public.negociacoes_excluidas_imutavel();
drop trigger if exists negociacoes_excluidas_sem_truncate on public.negociacoes_excluidas;
create trigger negociacoes_excluidas_sem_truncate before truncate on public.negociacoes_excluidas
  for each statement execute function public.negociacoes_excluidas_imutavel();

-- O trigger anti-DELETE passa a deixar apagar só a negociação que a função liberou.
create or replace function public.negociacoes_sem_delete()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.excluir_neg', true) = old.id then
    return old;
  end if;
  raise exception 'Negociação não se apaga direto — declinar e, se for o master, excluir pelo app.';
end; $$;

-- Número de negociação excluída não volta.
create or replace function public.negociacoes_numero_novo()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.negociacoes_excluidas where neg_id = new.id) then
    raise exception 'O número % já foi usado por uma negociação excluída — recarregue a página e tente de novo.', new.id;
  end if;
  return new;
end; $$;
drop trigger if exists negociacoes_numero_novo on public.negociacoes;
create trigger negociacoes_numero_novo before insert on public.negociacoes
  for each row execute function public.negociacoes_numero_novo();

create or replace function public.negociacao_excluir(p_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_data jsonb;
  v_numero text;
  v_cliente text;
  v_etapa text;
  v_nome text;
begin
  if not public.is_master() then
    raise exception 'Só o master exclui negociação.';
  end if;

  select data, numero, cliente, etapa into v_data, v_numero, v_cliente, v_etapa
    from public.negociacoes where id = p_id for update;
  if not found then
    raise exception 'A negociação % não existe mais.', p_id;
  end if;
  if v_etapa <> 'declinada' then
    raise exception 'Só dá para excluir negociação declinada.';
  end if;

  select split_part(coalesce(nullif(trim(nome), ''), email, ''), '@', 1) into v_nome from public.profiles where id = auth.uid();

  insert into public.negociacoes_excluidas (neg_id, numero, cliente, excluida_por, data)
  values (p_id, v_numero, v_cliente, v_nome, v_data);

  perform set_config('app.excluir_neg', p_id, true);
  delete from public.negociacoes where id = p_id;
  perform set_config('app.excluir_neg', '', true);
end; $$;

revoke all on function public.negociacao_excluir(text) from public, anon;
grant execute on function public.negociacao_excluir(text) to authenticated;
