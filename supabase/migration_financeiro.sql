-- ============================================================================
-- Financeiro por contrato: plano de recebimento (parcelas) + baixas (recebimentos reais).
-- Rodar no SQL Editor do Supabase DEPOIS da migration_acessos_compras.sql e da
-- migration_ficha_obra.sql. Pode rodar de novo.
--
-- fin_contratos  uma linha por obra: o contrato financeiro (valor, forma, multa/juros, parcelas,
--                histórico de renegociação) no `data jsonb`, com trava de versão pelo updated_at.
-- fin_baixas     uma linha por recebimento. Imutável, como o estoque: errou, estorna (linha nova
--                apontando para a original). A única coisa que muda depois é a lista de anexos
--                (comprovante/NF que chega depois), e só crescendo.
--
-- Ler: todo admin (os valores continuam ocultos pelo Sigilo do app).
-- Gravar: só quem tem o acesso "financeiro" (Configurações → Pessoas e acessos) ou o master.
-- ============================================================================

create or replace function public.pode_financeiro()
returns boolean language sql stable security definer set search_path = public as $$
  select public.tem_acesso('financeiro') or public.is_master();
$$;

-- ─── Contrato financeiro ────────────────────────────────────────────────────
create table if not exists public.fin_contratos (
  obra_id     text primary key,          -- sem FK: a obra excluída de vez não leva o financeiro junto
  updated_at  timestamptz not null default now(),
  data        jsonb not null default '{}'::jsonb
);

alter table public.fin_contratos enable row level security;
drop policy if exists fin_contratos_select on public.fin_contratos;
create policy fin_contratos_select on public.fin_contratos for select using (public.is_admin());
drop policy if exists fin_contratos_insert on public.fin_contratos;
create policy fin_contratos_insert on public.fin_contratos for insert with check (public.pode_financeiro());
drop policy if exists fin_contratos_update on public.fin_contratos;
create policy fin_contratos_update on public.fin_contratos for update
  using (public.pode_financeiro()) with check (public.pode_financeiro());
-- Sem policy de delete, e o trigger recusa até para o SQL Editor.

create or replace function public.fin_contratos_carimbo()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists fin_contratos_carimbo on public.fin_contratos;
create trigger fin_contratos_carimbo before update on public.fin_contratos
  for each row execute function public.fin_contratos_carimbo();

create or replace function public.fin_sem_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Registro financeiro não se apaga — estorne a baixa ou renegocie o contrato.';
end; $$;
drop trigger if exists fin_contratos_sem_delete on public.fin_contratos;
create trigger fin_contratos_sem_delete before delete on public.fin_contratos
  for each row execute function public.fin_sem_delete();
drop trigger if exists fin_contratos_sem_truncate on public.fin_contratos;
create trigger fin_contratos_sem_truncate before truncate on public.fin_contratos
  for each statement execute function public.fin_sem_delete();

-- ─── Baixas ─────────────────────────────────────────────────────────────────
create table if not exists public.fin_baixas (
  id              uuid primary key default gen_random_uuid(),
  obra_id         text not null,
  parcela_id      text,                  -- null = recebimento sem parcela (abate na ordem de vencimento)
  tipo            text not null default 'baixa' check (tipo in ('baixa', 'saldo_inicial', 'estorno')),
  dia             date not null,         -- data em que o dinheiro entrou
  principal       numeric(14,2) not null default 0 check (principal >= 0),  -- quanto abate da parcela
  juros           numeric(14,2) not null default 0 check (juros >= 0),
  multa           numeric(14,2) not null default 0 check (multa >= 0),
  desconto        numeric(14,2) not null default 0 check (desconto >= 0),
  forma           text,
  nf_numero       text,
  obs             text,
  anexos          uuid[] not null default '{}',   -- ids de obra_anexos (comprovante, NF)
  estorno_de      uuid references public.fin_baixas(id),
  lancado_por_id  uuid default auth.uid(),
  lancado_por     text,
  created_at      timestamptz not null default now()
);
create index if not exists fin_baixas_obra_idx on public.fin_baixas (obra_id);
-- Uma baixa só se estorna uma vez.
create unique index if not exists fin_baixas_estorno_unico on public.fin_baixas (estorno_de) where estorno_de is not null;

alter table public.fin_baixas enable row level security;
drop policy if exists fin_baixas_select on public.fin_baixas;
create policy fin_baixas_select on public.fin_baixas for select using (public.is_admin());
drop policy if exists fin_baixas_insert on public.fin_baixas;
create policy fin_baixas_insert on public.fin_baixas for insert
  with check (public.pode_financeiro() and lancado_por_id = auth.uid());
drop policy if exists fin_baixas_update on public.fin_baixas;
create policy fin_baixas_update on public.fin_baixas for update
  using (public.pode_financeiro()) with check (public.pode_financeiro());

-- Estorno: tem que apontar para uma baixa (não para outro estorno) da mesma obra, e repete os
-- valores dela — o app soma as duas como zero, e o histórico mostra as duas.
create or replace function public.fin_baixas_confere()
returns trigger language plpgsql as $$
declare o public.fin_baixas;
begin
  if new.tipo = 'estorno' then
    select * into o from public.fin_baixas where id = new.estorno_de;
    if o.id is null or o.tipo = 'estorno' or o.obra_id <> new.obra_id then
      raise exception 'Estorno precisa apontar para uma baixa desta obra.';
    end if;
    new.parcela_id := o.parcela_id;
    new.principal := o.principal; new.juros := o.juros; new.multa := o.multa; new.desconto := o.desconto;
  elsif new.estorno_de is not null then
    raise exception 'Só o estorno aponta para outra baixa.';
  elsif new.principal + new.juros + new.multa = 0 then
    raise exception 'Baixa sem valor.';
  end if;
  return new;
end; $$;
drop trigger if exists fin_baixas_confere on public.fin_baixas;
create trigger fin_baixas_confere before insert on public.fin_baixas
  for each row execute function public.fin_baixas_confere();

-- Imutável: só a lista de anexos muda, e só ganhando itens.
create or replace function public.fin_baixas_imutavel()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'anexos') = (to_jsonb(old) - 'anexos')
     and new.anexos @> old.anexos then
    return new;
  end if;
  raise exception 'Baixa não se altera nem se apaga — estorne e lance de novo. (Só dá para anexar comprovante/NF.)';
end; $$;
drop trigger if exists fin_baixas_imutavel on public.fin_baixas;
create trigger fin_baixas_imutavel before update or delete on public.fin_baixas
  for each row execute function public.fin_baixas_imutavel();
drop trigger if exists fin_baixas_sem_truncate on public.fin_baixas;
create trigger fin_baixas_sem_truncate before truncate on public.fin_baixas
  for each statement execute function public.fin_sem_delete();

-- ─── Anexos: categoria "nota_fiscal" ────────────────────────────────────────
-- A NF de venda que o financeiro anexa na baixa ganha categoria própria.
alter table public.obra_anexos drop constraint if exists obra_anexos_categoria_check;
alter table public.obra_anexos add constraint obra_anexos_categoria_check
  check (categoria in ('contrato','orcamento','comprovante','projeto','foto','outro','nota_fiscal'));

-- Depois de rodar: dê o acesso "Financeiro" às pessoas em Configurações → Pessoas e acessos.
