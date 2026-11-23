-- ============================================================================
-- PORTAL DO CLIENTE — rodar no SQL Editor DEPOIS da migration_acessos_compras.sql, da
-- migration_mensagens.sql, da migration_comercial.sql e da migration_financeiro.sql.
-- Pode rodar de novo sem estragar nada.
--
-- O cliente entra com um login próprio (papel 'cliente'), criado pela Edge Function
-- `portal-cliente` e ligado à obra em obra_membros. REGRA CENTRAL: ele NUNCA lê obras,
-- cronogramas nem diarios direto — o jsonb da obra traz compras, valores e financeiro, e
-- qualquer um veria pelo devtools. Tudo o que o portal mostra sai de portal_obra(), uma
-- projeção limpa (sem R$, sem equipe, sem ocorrência interna).
--
--   portal_mensagens  a conversa cliente × Centauro: comentário, pergunta, sugestão de data
--   portal_lidas      até quando cada um leu a conversa de cada obra (contador de não lidas)
--   obra_anexos.portal  o anexo que o cliente pode baixar (pela function, URL assinada)
-- ============================================================================

-- ─── PAPEL DO LOGIN ─────────────────────────────────────────────────────────
-- O papel vem do app_metadata, que só a service_role grava (a Edge Function). O
-- user_metadata o próprio usuário consegue mudar — nunca decidir permissão por ele.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, papel, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', new.email),
    case when new.raw_app_meta_data->>'papel' = 'cliente' then 'cliente' else 'admin' end,
    new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

create or replace function public.is_cliente_da(p_obra text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.obra_membros m
      join public.profiles p on p.id = m.user_id
     where m.obra_id = p_obra and m.user_id = auth.uid() and m.papel = 'cliente' and p.papel = 'cliente'
  );
$$;

-- obra_membros: o cliente vê as próprias linhas (para saber de que obras é membro).
drop policy if exists obra_membros_proprio on public.obra_membros;
create policy obra_membros_proprio on public.obra_membros for select using (user_id = auth.uid());

-- ─── STORAGE: só a equipe grava ─────────────────────────────────────────────
-- Os buckets públicos aceitavam escrita de qualquer login. Com cliente logando, passa a
-- ser só admin (a leitura pública continua igual).
drop policy if exists desenhos_write on storage.objects;
create policy desenhos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'desenhos' and public.is_admin());
drop policy if exists desenhos_update on storage.objects;
create policy desenhos_update on storage.objects for update to authenticated
  using (bucket_id = 'desenhos' and public.is_admin());
drop policy if exists diario_write on storage.objects;
create policy diario_write on storage.objects for insert to authenticated
  with check (bucket_id = 'diario' and public.is_admin());
drop policy if exists diario_update on storage.objects;
create policy diario_update on storage.objects for update to authenticated
  using (bucket_id = 'diario' and public.is_admin());
drop policy if exists diario_delete on storage.objects;
create policy diario_delete on storage.objects for delete to authenticated
  using (bucket_id = 'diario' and public.is_admin());

-- ─── ANEXO VISÍVEL AO CLIENTE ───────────────────────────────────────────────
-- A guarda do anexo (obra_anexos_guarda) não confere esta coluna, então ela pode mudar.
alter table public.obra_anexos add column if not exists portal boolean not null default false;

-- ─── CONVERSA ───────────────────────────────────────────────────────────────
create table if not exists public.portal_mensagens (
  id             uuid primary key default gen_random_uuid(),
  obra_id        text not null,
  lado           text not null check (lado in ('cliente', 'centauro')),
  autor_id       uuid not null default auth.uid() references auth.users(id),
  autor_nome     text,
  tipo           text not null default 'comentario' check (tipo in ('comentario', 'pergunta', 'sugestao_data')),
  texto          text not null default '' check (length(texto) <= 4000),
  -- sugestão de data: a tarefa do cronograma e a data proposta
  cronograma_id  text,
  task_id        integer,
  task_nome      text,
  campo          text check (campo is null or campo in ('inicio', 'termino')),
  data_atual     date,
  data_sugerida  date,
  -- decisão (só a Centauro)
  estado         text not null default '' check (estado in ('', 'pendente', 'aprovada', 'recusada')),
  decidido_por   text,
  decidido_por_id uuid,
  decidido_em    timestamptz,
  motivo         text,
  created_at     timestamptz not null default now(),
  check (tipo <> 'sugestao_data' or (cronograma_id is not null and task_id is not null and campo is not null and data_sugerida is not null)),
  check (tipo = 'sugestao_data' or length(trim(texto)) > 0)
);
create index if not exists portal_mensagens_obra_idx on public.portal_mensagens (obra_id, created_at);

alter table public.portal_mensagens enable row level security;
drop policy if exists portal_mensagens_select on public.portal_mensagens;
create policy portal_mensagens_select on public.portal_mensagens for select
  using (public.is_admin() or public.is_cliente_da(obra_id));
drop policy if exists portal_mensagens_insert on public.portal_mensagens;
create policy portal_mensagens_insert on public.portal_mensagens for insert
  with check (
    autor_id = auth.uid() and decidido_em is null and decidido_por_id is null
    and (
      (lado = 'cliente' and public.is_cliente_da(obra_id)
        and estado = case when tipo = 'sugestao_data' then 'pendente' else '' end)
      or (lado = 'centauro' and public.is_admin() and tipo <> 'sugestao_data' and estado = '')
    )
  );
-- Sem policy de update: a decisão passa por portal_decidir(). Sem policy de delete.

create or replace function public.portal_mensagens_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'Mensagem do portal não se apaga.'; end if;
  if new.id <> old.id or new.obra_id <> old.obra_id or new.lado <> old.lado or new.autor_id <> old.autor_id
     or new.autor_nome is distinct from old.autor_nome or new.tipo <> old.tipo or new.texto <> old.texto
     or new.cronograma_id is distinct from old.cronograma_id or new.task_id is distinct from old.task_id
     or new.task_nome is distinct from old.task_nome or new.campo is distinct from old.campo
     or new.data_atual is distinct from old.data_atual or new.data_sugerida is distinct from old.data_sugerida
     or new.created_at <> old.created_at then
    raise exception 'Mensagem do portal não se edita — só a decisão da sugestão muda.';
  end if;
  return new;
end; $$;
drop trigger if exists portal_mensagens_guarda on public.portal_mensagens;
create trigger portal_mensagens_guarda before update or delete on public.portal_mensagens
  for each row execute function public.portal_mensagens_guarda();
drop trigger if exists portal_mensagens_sem_truncate on public.portal_mensagens;
create trigger portal_mensagens_sem_truncate before truncate on public.portal_mensagens
  for each statement execute function public.portal_mensagens_guarda();

-- O nome de quem escreve sai do perfil, não do que o navegador mandou.
create or replace function public.portal_mensagens_autor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select split_part(coalesce(nullif(trim(nome), ''), email, ''), '@', 1) into new.autor_nome
    from public.profiles where id = new.autor_id;
  return new;
end; $$;
drop trigger if exists portal_mensagens_autor on public.portal_mensagens;
create trigger portal_mensagens_autor before insert on public.portal_mensagens
  for each row execute function public.portal_mensagens_autor();

-- Decisão da sugestão de data. Quem aplica a data no cronograma é o app, pela gravação normal
-- do cronograma; aqui fica só o registro de quem decidiu.
create or replace function public.portal_decidir(p_msg uuid, p_estado text, p_motivo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_nome text;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if p_estado not in ('aprovada', 'recusada') then raise exception 'Decisão inválida: %', p_estado; end if;
  select split_part(coalesce(nullif(trim(nome), ''), email, ''), '@', 1) into v_nome from public.profiles where id = auth.uid();
  update public.portal_mensagens
     set estado = p_estado, motivo = nullif(trim(coalesce(p_motivo, '')), ''),
         decidido_por = v_nome, decidido_por_id = auth.uid(), decidido_em = now()
   where id = p_msg and tipo = 'sugestao_data' and estado = 'pendente';
  if not found then raise exception 'Sugestão não encontrada ou já decidida.'; end if;
end; $$;
revoke all on function public.portal_decidir(uuid, text, text) from public, anon;
grant execute on function public.portal_decidir(uuid, text, text) to authenticated;

-- Leitura da conversa por obra.
create table if not exists public.portal_lidas (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  obra_id  text not null,
  lida_ate timestamptz not null default now(),
  primary key (user_id, obra_id)
);
alter table public.portal_lidas enable row level security;
drop policy if exists portal_lidas_dono on public.portal_lidas;
create policy portal_lidas_dono on public.portal_lidas for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── AVISO NO 🔔 (e, pelo gatilho existente, no WhatsApp) ───────────────────
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo in ('mencao', 'compra_pedido', 'compra_aprovada', 'compra_recusada',
                  'comercial_liberado', 'comercial_pronto', 'comercial_revisao', 'comercial_atribuido',
                  'portal_mensagem'));

-- Mensagem do cliente avisa quem tem o acesso 'portal'; sem ninguém com ele, avisa toda a equipe.
create or replace function public.portal_mensagem_notifica()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_texto text;
begin
  if new.lado <> 'cliente' then return new; end if;
  v_texto := case new.tipo
    when 'sugestao_data' then 'Sugeriu mudar ' || case new.campo when 'inicio' then 'o início' else 'o término' end
         || ' de "' || coalesce(new.task_nome, 'tarefa') || '" para ' || to_char(new.data_sugerida, 'DD/MM/YYYY')
         || case when length(trim(new.texto)) > 0 then '. ' || new.texto else '' end
    when 'pergunta' then 'Pergunta: ' || new.texto
    else new.texto end;
  insert into public.notificacoes (user_id, tipo, de_id, de_nome, obra_id, texto)
  select p.id, 'portal_mensagem', new.autor_id, coalesce(new.autor_nome, 'Cliente'), new.obra_id, left(v_texto, 600)
    from public.profiles p
   where p.papel = 'admin'
     and (
       'portal' = any(p.acessos)
       or not exists (select 1 from public.profiles q where q.papel = 'admin' and 'portal' = any(q.acessos))
     );
  return new;
end; $$;
drop trigger if exists portal_mensagens_notifica on public.portal_mensagens;
create trigger portal_mensagens_notifica after insert on public.portal_mensagens
  for each row execute function public.portal_mensagem_notifica();

-- ─── LEITURA DO CLIENTE ─────────────────────────────────────────────────────
-- Obras de que o login é cliente (o portal abre direto quando é uma só).
create or replace function public.portal_minhas_obras()
returns table (id text, numero text, cliente text, obra text, cidade text, status text)
language sql stable security definer set search_path = public as $$
  select o.id, o.numero, o.cliente, o.data->>'obra', o.data->>'cidade', o.data->>'status'
    from public.obras o
    join public.obra_membros m on m.obra_id = o.id and m.user_id = auth.uid() and m.papel = 'cliente'
   where coalesce(o.data->'arquivo'->>'estado', '') = ''
   order by o.id;
$$;
revoke all on function public.portal_minhas_obras() from public, anon;
grant execute on function public.portal_minhas_obras() to authenticated;

-- Tudo o que o portal mostra de uma obra, já sem valores. A equipe também pode chamar (para a
-- pré-visualização "ver como o cliente").
create or replace function public.portal_obra(p_obra text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  o public.obras%rowtype;
  v jsonb;
begin
  if not (public.is_admin() or public.is_cliente_da(p_obra)) then
    raise exception 'Sem acesso a esta obra.';
  end if;
  select * into o from public.obras where id = p_obra;
  if not found or coalesce(o.data->'arquivo'->>'estado', '') <> '' then
    raise exception 'Obra não encontrada.';
  end if;

  v := jsonb_build_object(
    'id', o.id,
    'numero', o.numero,
    'cliente', o.data->>'cliente',
    'obra', o.data->>'obra',
    'cidade', o.data->>'cidade',
    'status', o.data->>'status',
    'dataInicio', o.data->>'dataInicio',
    'dataLimiteEntrega', o.data->>'dataLimiteEntrega',
    'capaAnexoId', o.data->'capa'->>'anexoId',
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i->'id', 'tipo', i->>'tipo', 'descricao', i->>'descricao', 'perfil', i->>'perfil',
        'acessorios', i->>'acessorios', 'vidro', i->>'vidro', 'localizacao', i->>'localizacao',
        'qtd', i->'qtd', 'L', i->'L', 'H', i->'H', 'etapas', i->'etapas') order by ord)
      from jsonb_array_elements(coalesce(o.data->'itens', '[]'::jsonb)) with ordinality as x(i, ord)
    ), '[]'::jsonb)
  );

  -- Cronogramas da obra, sem equipe nem comentário interno.
  v := v || jsonb_build_object('cronogramas', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'titulo', c.data->>'titulo', 'obraId', c.obra_id, 'config', c.data->'config',
      'predecessorasMacro', coalesce(c.data->'predecessorasMacro', '[]'::jsonb),
      'tasks', coalesce((
        select jsonb_agg(t - 'equipeId' - 'comentario' - 'descricaoCompleta' order by ord)
          from jsonb_array_elements(coalesce(c.data->'tasks', '[]'::jsonb)) with ordinality as y(t, ord)
      ), '[]'::jsonb)) order by c.id)
    from public.cronogramas c where c.obra_id = p_obra
  ), '[]'::jsonb));

  -- Cronogramas de outras obras de que este depende (predecessorasMacro, em cadeia). Vão só com
  -- o que o agendamento precisa — sem nome, sem obra — para o portal calcular o mesmo início
  -- herdado que o macro da equipe mostra.
  v := v || jsonb_build_object('cadeia', coalesce((
    with recursive cad(id) as (
      select c.id from public.cronogramas c where c.obra_id = p_obra
      union
      select pm.value #>> '{}'
        from cad
        join public.cronogramas c on c.id = cad.id
        cross join jsonb_array_elements(coalesce(c.data->'predecessorasMacro', '[]'::jsonb)) pm
    )
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'obraId', '', 'config', c.data->'config',
      'predecessorasMacro', coalesce(c.data->'predecessorasMacro', '[]'::jsonb),
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t->'id', 'nivel', t->'nivel', 'nome', '', 'durValor', t->'durValor', 'durUnid', t->'durUnid',
          'percent', t->'percent', 'predecessoras', t->'predecessoras', 'inicioManual', t->'inicioManual',
          'inicioFixo', t->'inicioFixo', 'naoSeAplica', t->'naoSeAplica') order by ord)
          from jsonb_array_elements(coalesce(c.data->'tasks', '[]'::jsonb)) with ordinality as y(t, ord)
      ), '[]'::jsonb)))
    from public.cronogramas c
    join cad on cad.id = c.id
    left join public.obras ob on ob.id = c.obra_id
   where coalesce(c.obra_id, '') <> p_obra
     and coalesce(ob.data->'arquivo'->>'estado', '') = ''
  ), '[]'::jsonb));

  -- Diários aprovados: dia, clima, o que foi feito e as fotos (a versão marcada). Ficam de fora
  -- ocorrências, presença, responsável e assinaturas.
  v := v || jsonb_build_object('diarios', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'dia', d.dia, 'numero', d.numero,
      'clima', d.data->'clima',
      'atividades', coalesce((
        select jsonb_agg(jsonb_build_object('texto', a->>'texto', 'etapa', a->>'etapa', 'itemId', a->'itemId', 'status', a->>'status'))
          from jsonb_array_elements(coalesce(d.data->'atividades', '[]'::jsonb)) a
      ), '[]'::jsonb),
      'fotos', coalesce((
        select jsonb_agg(jsonb_build_object('id', f->>'id', 'url', f->>'url', 'legenda', f->>'legenda'))
          from jsonb_array_elements(coalesce(d.data->'fotos', '[]'::jsonb)) f
         where coalesce(f->>'url', '') <> ''
      ), '[]'::jsonb),
      'observacoes', d.data->>'observacoes') order by d.dia desc)
    from public.diarios d
   where d.obra_id = p_obra and coalesce(d.data->>'status', '') <> 'rascunho'
  ), '[]'::jsonb));

  -- Documentos liberados para o cliente (o arquivo sai pela function, com URL assinada).
  v := v || jsonb_build_object('anexos', coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'categoria', a.categoria, 'mime', a.mime, 'tamanho', a.tamanho, 'em', a.created_at) order by a.created_at desc)
      from public.obra_anexos a
     where a.obra_id = p_obra and a.portal and a.removido_em is null
  ), '[]'::jsonb));

  return v;
end; $$;
revoke all on function public.portal_obra(text) from public, anon;
grant execute on function public.portal_obra(text) to authenticated;

-- Resumo para a equipe: por obra, mensagens do cliente não lidas e sugestões pendentes.
create or replace function public.portal_resumo()
returns table (obra_id text, ultima_em timestamptz, nao_lidas bigint, pendentes bigint, sem_resposta boolean)
language sql stable security invoker set search_path = public as $$
  select m.obra_id,
         max(m.created_at),
         count(*) filter (where m.autor_id <> auth.uid() and m.created_at > coalesce(l.lida_ate, '-infinity'::timestamptz)),
         count(*) filter (where m.estado = 'pendente'),
         (array_agg(m.lado order by m.created_at desc))[1] = 'cliente'
    from public.portal_mensagens m
    left join public.portal_lidas l on l.user_id = auth.uid() and l.obra_id = m.obra_id
   group by m.obra_id;
$$;

-- ─── TEMPO REAL ─────────────────────────────────────────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.portal_mensagens; exception when duplicate_object then null; end;
end $$;
