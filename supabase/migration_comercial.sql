-- ============================================================================
-- COMERCIAL (tela 💼 Comercial): negociações da prospecção até virar obra ou ser declinada.
-- Rodar no SQL Editor do Supabase, DEPOIS da migration_acessos_compras.sql. Pode rodar de novo.
--
--   negociacoes        uma linha por negociação (NEG-0001), o objeto inteiro no jsonb — mesmo
--                      padrão de obras/orcamentos. Não se apaga: perdeu, declina.
--   notificacoes.tipo  ganha comercial_liberado / comercial_pronto / comercial_revisao / comercial_atribuido
--   notificar_comercial  RPC que cria o aviso no 🔔 (e, pelo gatilho do WhatsApp, no celular)
--
-- Acessos novos (marcados pelo master em Configurações → Pessoas e acessos):
--   'comercial'     cria, libera para orçamento, negocia, converte, declina
--   'orcamentista'  pega o orçamento e devolve pronto
-- Fotos, anexos e comentários da negociação usam obra_anexos/obra_comentarios com o id NEG-…
-- (essas tabelas não têm FK com obras, de propósito).
-- ============================================================================

create table if not exists public.negociacoes (
  id              text primary key,
  numero          text not null,
  cliente         text,
  etapa           text not null default 'prospeccao',
  vendedor_id     uuid,
  orcamentista_id uuid,
  obra_id         text,            -- obra criada na conversão (sem FK, como no estoque)
  updated_at      timestamptz default now(),
  data            jsonb not null
);
create unique index if not exists negociacoes_numero_unico on public.negociacoes (numero);
create index if not exists negociacoes_etapa_idx on public.negociacoes (etapa);

alter table public.negociacoes enable row level security;
drop policy if exists negociacoes_select on public.negociacoes;
create policy negociacoes_select on public.negociacoes for select using (public.is_admin());
drop policy if exists negociacoes_insert on public.negociacoes;
create policy negociacoes_insert on public.negociacoes for insert with check (public.is_admin());
drop policy if exists negociacoes_update on public.negociacoes;
create policy negociacoes_update on public.negociacoes for update using (public.is_admin()) with check (public.is_admin());
-- sem policy de delete

create or replace function public.negociacoes_sem_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Negociação não se apaga — use Declinar. (Para apagar mesmo, desligue o trigger negociacoes_sem_delete antes.)';
end; $$;
drop trigger if exists negociacoes_sem_delete on public.negociacoes;
create trigger negociacoes_sem_delete before delete on public.negociacoes
  for each row execute function public.negociacoes_sem_delete();
drop trigger if exists negociacoes_sem_truncate on public.negociacoes;
create trigger negociacoes_sem_truncate before truncate on public.negociacoes
  for each statement execute function public.negociacoes_sem_delete();

-- ─── NOTIFICAÇÕES DO COMERCIAL ──────────────────────────────────────────────
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo in ('mencao', 'compra_pedido', 'compra_aprovada', 'compra_recusada',
                  'comercial_liberado', 'comercial_pronto', 'comercial_revisao', 'comercial_atribuido'));

-- Destinatários:
--   comercial_liberado / comercial_revisao → o orçamentista escolhido (p_para); sem ele, todos com 'orcamentista'
--   comercial_pronto                       → o vendedor (p_para); sem ele, todos com 'comercial'
--   comercial_atribuido                    → só p_para (alguém foi marcado como vendedor/orçamentista)
-- Quem dispara nunca recebe o próprio aviso. `obra_id` leva o id da negociação (NEG-…).
create or replace function public.notificar_comercial(p_tipo text, p_neg_id text, p_texto text, p_dados jsonb, p_para uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_nome text;
  v_n integer;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if p_tipo not in ('comercial_liberado', 'comercial_pronto', 'comercial_revisao', 'comercial_atribuido') then
    raise exception 'Tipo de aviso inválido: %', p_tipo;
  end if;
  if p_tipo = 'comercial_pronto' and not (public.tem_acesso('orcamentista') or public.tem_acesso('comercial')) then
    raise exception 'Só o orçamentista devolve o orçamento pronto.';
  end if;
  if p_tipo in ('comercial_liberado', 'comercial_revisao') and not public.tem_acesso('comercial') then
    raise exception 'Só o comercial libera para orçamento.';
  end if;

  select split_part(coalesce(nullif(trim(nome), ''), email, ''), '@', 1) into v_nome from public.profiles where id = auth.uid();

  insert into public.notificacoes (user_id, tipo, de_id, de_nome, obra_id, texto, dados)
  select distinct p.id, p_tipo, auth.uid(), v_nome, p_neg_id, left(p_texto, 600), p_dados
    from public.profiles p
   where p.id is distinct from auth.uid()
     and (
       p.id = p_para
       or (p_para is null and p_tipo in ('comercial_liberado', 'comercial_revisao') and 'orcamentista' = any(p.acessos))
       or (p_para is null and p_tipo = 'comercial_pronto' and 'comercial' = any(p.acessos))
     );
  get diagnostics v_n = row_count;
  return v_n;
end; $$;

revoke all on function public.notificar_comercial(text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.notificar_comercial(text, text, text, jsonb, uuid) to authenticated;
