-- ============================================================================
-- Estoque: cadastro de material + livro-razão de movimentos (rodar separado)
-- Rode no SQL Editor do Supabase (uma vez). Pode rodar de novo sem perder nada.
--
-- Aqui NÃO vale o padrão do resto do app (objeto inteiro em data jsonb + upsert).
-- Upsert sobrescreve: uma aba atrasada gravaria um saldo velho por cima do novo.
-- Então:
--   * o saldo nunca é gravado — é a soma dos movimentos (view estoque_saldos);
--   * documento e movimento são imutáveis — errou, faz estorno (documento novo);
--   * o lançamento é uma função no banco: grava tudo numa transação, trava os
--     itens envolvidos e recusa saída maior que o saldo;
--   * a numeração vem de uma tabela de contadores dentro da mesma transação —
--     sequence pula número quando o lançamento falha, e buraco na numeração
--     parece documento sumido.
-- ============================================================================

-- ─── CONTADORES (numeração sem buraco) ──────────────────────────────────────
create table if not exists public.estoque_contadores (
  chave  text primary key,
  ultimo bigint not null default 0
);
insert into public.estoque_contadores (chave) values
  ('item'), ('entrada'), ('saida'), ('ajuste'), ('estorno')
on conflict (chave) do nothing;

-- ─── ITENS (cadastro) ────────────────────────────────────────────────────────
create table if not exists public.estoque_itens (
  id             text primary key,
  codigo         text not null unique,          -- EST-00001: vai na etiqueta, nunca muda
  nome           text not null,
  categoria      text not null default 'outro'
                 check (categoria in ('perfil','vidro','acessorio','pintura','consumivel','ferramenta','outro')),
  unidade        text not null default 'un',
  local          text,
  estoque_minimo numeric(14,3) not null default 0 check (estoque_minimo >= 0),
  arquivado      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  data           jsonb not null default '{}'::jsonb  -- extras livres: descrição, acabamento, cód. fornecedor
);

-- ─── DOCUMENTOS (cabeçalho de cada entrada/saída/ajuste/estorno) ────────────
create table if not exists public.estoque_documentos (
  id           uuid primary key default gen_random_uuid(),
  tipo         text not null check (tipo in ('entrada','saida','ajuste','estorno')),
  numero       bigint not null,
  motivo       text not null,
  dia          date not null,
  obra_id      text,             -- sem FK: a obra pode ser apagada, o documento não
  obra_rotulo  text,             -- "#2597 — CLIENTE", fotografado no lançamento
  equipe_id    text,
  fornecedor   text,
  nf_numero    text,
  responsavel  text,             -- texto livre: o login é da empresa, não da pessoa
  recebido_por text,
  obs          text,
  estorna_id   uuid unique references public.estoque_documentos(id) on delete restrict,
  criado_por   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (tipo, numero)
);
create index if not exists estoque_documentos_dia_idx  on public.estoque_documentos (dia);
create index if not exists estoque_documentos_obra_idx on public.estoque_documentos (obra_id);

-- ─── MOVIMENTOS (uma linha por item do documento) ────────────────────────────
create table if not exists public.estoque_movimentos (
  id             bigserial primary key,
  documento_id   uuid not null references public.estoque_documentos(id) on delete restrict,
  item_id        text not null references public.estoque_itens(id) on delete restrict,
  quantidade     numeric(14,3) not null check (quantidade <> 0),  -- + entra, − sai
  valor_unitario numeric(14,2),
  item_nome      text,           -- fotografado no lançamento: a folha reimpressa sai igual
  unidade        text,
  created_at     timestamptz not null default now()
);
create index if not exists estoque_movimentos_item_idx on public.estoque_movimentos (item_id);
create index if not exists estoque_movimentos_doc_idx  on public.estoque_movimentos (documento_id);

-- ─── SALDO (derivado, nunca gravado) ────────────────────────────────────────
create or replace view public.estoque_saldos with (security_invoker = true) as
  select i.id as item_id,
         coalesce(sum(m.quantidade), 0) as saldo,
         max(m.created_at) as ultima_movimentacao
    from public.estoque_itens i
    left join public.estoque_movimentos m on m.item_id = i.id
   group by i.id;

-- ============================================================================
-- IMUTABILIDADE
-- Trigger, e não só RLS: o service_role ignora RLS, mas não ignora trigger.
-- Segura até um DELETE digitado por engano no SQL Editor.
-- ============================================================================
create or replace function public.estoque_imutavel()
returns trigger language plpgsql as $$
begin
  raise exception 'Lançamento de estoque não pode ser alterado nem apagado. Para corrigir, faça um estorno.';
end; $$;

drop trigger if exists estoque_documentos_imutavel on public.estoque_documentos;
create trigger estoque_documentos_imutavel before update or delete on public.estoque_documentos
  for each row execute function public.estoque_imutavel();
drop trigger if exists estoque_documentos_sem_truncate on public.estoque_documentos;
create trigger estoque_documentos_sem_truncate before truncate on public.estoque_documentos
  for each statement execute function public.estoque_imutavel();

drop trigger if exists estoque_movimentos_imutavel on public.estoque_movimentos;
create trigger estoque_movimentos_imutavel before update or delete on public.estoque_movimentos
  for each row execute function public.estoque_imutavel();
drop trigger if exists estoque_movimentos_sem_truncate on public.estoque_movimentos;
create trigger estoque_movimentos_sem_truncate before truncate on public.estoque_movimentos
  for each statement execute function public.estoque_imutavel();

-- Item: não se apaga (arquiva), o código não muda (já pode estar em etiqueta colada)
-- e só arquiva com saldo zero — item arquivado com saldo é material que some da lista.
create or replace function public.estoque_itens_guarda()
returns trigger language plpgsql as $$
declare v_saldo numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'Item de estoque não se apaga — arquive.';
  end if;
  if new.id <> old.id or new.codigo <> old.codigo then
    raise exception 'O código do item não muda: ele pode já estar numa etiqueta impressa.';
  end if;
  if new.arquivado and not old.arquivado then
    select coalesce(sum(quantidade), 0) into v_saldo from public.estoque_movimentos where item_id = new.id;
    if v_saldo <> 0 then
      raise exception 'O item % ainda tem saldo % — zere com um ajuste antes de arquivar.', new.codigo, trim_scale(v_saldo);
    end if;
  end if;
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists estoque_itens_guarda on public.estoque_itens;
create trigger estoque_itens_guarda before update or delete on public.estoque_itens
  for each row execute function public.estoque_itens_guarda();

-- ============================================================================
-- RLS
-- Documentos e movimentos: só leitura pelo app. Escrita só pelas funções abaixo
-- (security definer), que conferem saldo. Sem policy de insert, ninguém consegue
-- gravar um movimento direto e pular a conferência.
-- ============================================================================
alter table public.estoque_contadores enable row level security;  -- sem policy: só as funções
alter table public.estoque_itens      enable row level security;
alter table public.estoque_documentos enable row level security;
alter table public.estoque_movimentos enable row level security;

drop policy if exists estoque_itens_select on public.estoque_itens;
create policy estoque_itens_select on public.estoque_itens for select using (public.is_admin());
drop policy if exists estoque_itens_update on public.estoque_itens;
create policy estoque_itens_update on public.estoque_itens for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists estoque_documentos_select on public.estoque_documentos;
create policy estoque_documentos_select on public.estoque_documentos for select using (public.is_admin());

drop policy if exists estoque_movimentos_select on public.estoque_movimentos;
create policy estoque_movimentos_select on public.estoque_movimentos for select using (public.is_admin());

-- ============================================================================
-- FUNÇÕES (RPC)
-- ============================================================================

-- "Hoje" no Brasil. current_date do servidor é UTC: às 21h já seria amanhã.
create or replace function public.estoque_hoje()
returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Novo item: o código sai do contador.
create or replace function public.estoque_novo_item(item jsonb)
returns public.estoque_itens
language plpgsql security definer set search_path = public as $$
declare
  v_num bigint;
  v_row public.estoque_itens;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if coalesce(trim(item->>'nome'), '') = '' then raise exception 'Informe o nome do item.'; end if;

  update public.estoque_contadores set ultimo = ultimo + 1 where chave = 'item' returning ultimo into v_num;

  insert into public.estoque_itens (id, codigo, nome, categoria, unidade, local, estoque_minimo, data)
  values (
    gen_random_uuid()::text,
    'EST-' || lpad(v_num::text, 5, '0'),
    trim(item->>'nome'),
    coalesce(nullif(item->>'categoria', ''), 'outro'),
    coalesce(nullif(item->>'unidade', ''), 'un'),
    nullif(trim(coalesce(item->>'local', '')), ''),
    greatest(coalesce((item->>'estoque_minimo')::numeric, 0), 0),
    coalesce(item->'data', '{}'::jsonb)
  )
  returning * into v_row;
  return v_row;
end; $$;

-- Lança entrada, saída ou ajuste.
--   cab:    { tipo, motivo, dia, obra_id, equipe_id, fornecedor, nf_numero, responsavel, recebido_por, obs }
--   linhas: [{ item_id, quantidade, valor_unitario }]   — entrada/saída: quantidade > 0
--           [{ item_id, contagem }]                      — ajuste: o que foi contado na prateleira
-- No ajuste a diferença é calculada aqui, com o item travado: se alguém lançou uma saída
-- entre abrir a tela e confirmar, a contagem continua valendo.
create or replace function public.estoque_lancar(cab jsonb, linhas jsonb)
returns public.estoque_documentos
language plpgsql security definer set search_path = public as $$
declare
  v_tipo   text := cab->>'tipo';
  v_motivo text := coalesce(cab->>'motivo', '');
  v_obra   text := nullif(cab->>'obra_id', '');
  v_rotulo text;
  v_num    bigint;
  v_doc    public.estoque_documentos;
  v_item   public.estoque_itens;
  v_saldo  numeric;
  v_delta  numeric;
  v_ok     jsonb := '[]'::jsonb;
  l        record;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if v_tipo is null or v_tipo not in ('entrada', 'saida', 'ajuste') then
    raise exception 'Tipo de documento inválido: %', coalesce(v_tipo, '(vazio)');
  end if;
  if v_motivo = '' then raise exception 'Informe o motivo.'; end if;
  if jsonb_typeof(linhas) is distinct from 'array' or jsonb_array_length(linhas) = 0 then
    raise exception 'O documento não tem nenhum item.';
  end if;
  if v_tipo = 'ajuste' and coalesce(trim(cab->>'obs'), '') = '' then
    raise exception 'Ajuste de inventário precisa de justificativa na observação.';
  end if;

  -- Obra só fica no documento quando o material foi para ela ou voltou dela. Uma compra com
  -- obra marcada contaria como "devolução" no consumo da obra.
  if not ((v_tipo = 'saida' and v_motivo = 'obra') or (v_tipo = 'entrada' and v_motivo = 'devolucao')) then
    v_obra := null;
  elsif v_obra is null then
    raise exception 'Escolha a obra.';
  end if;
  if v_obra is not null then
    select '#' || coalesce(numero, id) || ' — ' || coalesce(cliente, '') into v_rotulo from public.obras where id = v_obra;
    v_rotulo := coalesce(v_rotulo, cab->>'obra_rotulo', v_obra);
  end if;

  -- O mesmo item bipado duas vezes vira uma linha só. Ordem por id: duas transações
  -- travam os itens na mesma ordem e não entram em deadlock.
  for l in
    select x->>'item_id' as item_id,
           sum(coalesce((x->>'quantidade')::numeric, 0)) as quantidade,
           max((x->>'contagem')::numeric) as contagem,
           bool_or(x ? 'contagem') as tem_contagem,
           max((x->>'valor_unitario')::numeric) as valor_unitario
      from jsonb_array_elements(linhas) x
     group by x->>'item_id'
     order by x->>'item_id'
  loop
    select * into v_item from public.estoque_itens where id = l.item_id for update;
    if not found then raise exception 'Item não encontrado (%).', l.item_id; end if;
    if v_item.arquivado then raise exception 'O item % está arquivado — reative antes de movimentar.', v_item.codigo; end if;

    select coalesce(sum(quantidade), 0) into v_saldo from public.estoque_movimentos where item_id = v_item.id;

    if v_tipo = 'ajuste' then
      if not l.tem_contagem or l.contagem is null or l.contagem < 0 then
        raise exception 'Informe a contagem de % (%).', v_item.codigo, v_item.nome;
      end if;
      v_delta := l.contagem - v_saldo;
      continue when v_delta = 0;   -- contagem bateu: nada a ajustar nesse item
    else
      if l.quantidade <= 0 then
        raise exception 'Quantidade inválida para % (%).', v_item.codigo, v_item.nome;
      end if;
      v_delta := case when v_tipo = 'saida' then -l.quantidade else l.quantidade end;
      if v_saldo + v_delta < 0 then
        raise exception 'Saldo insuficiente de % (%): tem % %, a saída pede %.',
          v_item.codigo, v_item.nome, trim_scale(v_saldo), v_item.unidade, trim_scale(l.quantidade);
      end if;
    end if;

    v_ok := v_ok || jsonb_build_object(
      'item_id', v_item.id, 'quantidade', v_delta, 'item_nome', v_item.nome, 'unidade', v_item.unidade,
      'valor_unitario', case when v_tipo = 'entrada' then l.valor_unitario end);
  end loop;

  if jsonb_array_length(v_ok) = 0 then
    raise exception 'A contagem bateu com o saldo em todos os itens — não há nada a ajustar.';
  end if;

  update public.estoque_contadores set ultimo = ultimo + 1 where chave = v_tipo returning ultimo into v_num;

  insert into public.estoque_documentos
    (tipo, numero, motivo, dia, obra_id, obra_rotulo, equipe_id, fornecedor, nf_numero, responsavel, recebido_por, obs)
  values (
    v_tipo, v_num, v_motivo,
    coalesce(nullif(cab->>'dia', '')::date, public.estoque_hoje()),
    v_obra, v_rotulo,
    case when v_tipo = 'saida' then nullif(cab->>'equipe_id', '') end,
    case when v_tipo = 'entrada' then nullif(trim(coalesce(cab->>'fornecedor', '')), '') end,
    case when v_tipo = 'entrada' then nullif(trim(coalesce(cab->>'nf_numero', '')), '') end,
    nullif(trim(coalesce(cab->>'responsavel', '')), ''),
    nullif(trim(coalesce(cab->>'recebido_por', '')), ''),
    nullif(trim(coalesce(cab->>'obs', '')), '')
  )
  returning * into v_doc;

  insert into public.estoque_movimentos (documento_id, item_id, quantidade, valor_unitario, item_nome, unidade)
  select v_doc.id, x->>'item_id', (x->>'quantidade')::numeric, (x->>'valor_unitario')::numeric, x->>'item_nome', x->>'unidade'
    from jsonb_array_elements(v_ok) x;

  return v_doc;
end; $$;

-- Estorno: documento novo com as quantidades invertidas, apontando para o original.
-- O original fica intacto — o histórico mostra os dois.
create or replace function public.estoque_estornar(doc_id uuid, motivo text, responsavel text default null)
returns public.estoque_documentos
language plpgsql security definer set search_path = public as $$
declare
  v_orig  public.estoque_documentos;
  v_doc   public.estoque_documentos;
  v_ja    public.estoque_documentos;
  v_item  public.estoque_itens;
  v_saldo numeric;
  v_num   bigint;
  l       record;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if coalesce(trim(motivo), '') = '' then raise exception 'Informe o motivo do estorno.'; end if;

  select * into v_orig from public.estoque_documentos where id = doc_id;
  if not found then raise exception 'Documento não encontrado.'; end if;
  if v_orig.tipo = 'estorno' then raise exception 'Estorno não se estorna — lance um documento novo.'; end if;

  select * into v_ja from public.estoque_documentos where estorna_id = doc_id;
  if found then raise exception 'Este documento já foi estornado (nº %).', v_ja.numero; end if;

  for l in
    select item_id, sum(quantidade) as quantidade
      from public.estoque_movimentos where documento_id = doc_id
     group by item_id order by item_id
  loop
    select * into v_item from public.estoque_itens where id = l.item_id for update;
    if v_item.arquivado then raise exception 'O item % está arquivado — reative antes de estornar.', v_item.codigo; end if;
    select coalesce(sum(quantidade), 0) into v_saldo from public.estoque_movimentos where item_id = l.item_id;
    if v_saldo - l.quantidade < 0 then
      raise exception 'Não dá para estornar: % (%) já saiu do estoque — o saldo ficaria %.',
        v_item.codigo, v_item.nome, trim_scale(v_saldo - l.quantidade);
    end if;
  end loop;

  update public.estoque_contadores set ultimo = ultimo + 1 where chave = 'estorno' returning ultimo into v_num;

  insert into public.estoque_documentos
    (tipo, numero, motivo, dia, obra_id, obra_rotulo, equipe_id, responsavel, obs, estorna_id)
  values ('estorno', v_num, 'estorno', public.estoque_hoje(), v_orig.obra_id, v_orig.obra_rotulo, v_orig.equipe_id,
          nullif(trim(coalesce(responsavel, '')), ''), trim(motivo), v_orig.id)
  returning * into v_doc;

  insert into public.estoque_movimentos (documento_id, item_id, quantidade, valor_unitario, item_nome, unidade)
  select v_doc.id, item_id, -quantidade, valor_unitario, item_nome, unidade
    from public.estoque_movimentos where documento_id = doc_id;

  return v_doc;
end; $$;

revoke execute on function public.estoque_novo_item(jsonb)            from public, anon;
revoke execute on function public.estoque_lancar(jsonb, jsonb)        from public, anon;
revoke execute on function public.estoque_estornar(uuid, text, text)  from public, anon;
grant  execute on function public.estoque_novo_item(jsonb)            to authenticated;
grant  execute on function public.estoque_lancar(jsonb, jsonb)        to authenticated;
grant  execute on function public.estoque_estornar(uuid, text, text)  to authenticated;
