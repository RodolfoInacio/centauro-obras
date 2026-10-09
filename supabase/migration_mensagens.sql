-- ============================================================================
-- MENÇÕES, NOTIFICAÇÕES E CHAT INTERNO — rodar separado, DEPOIS da migration_ficha_obra.sql.
--
--   obra_comentarios.mencoes  ids (auth.users) marcados com @ no comentário
--   notificacoes              o 🔔 da barra do topo: uma linha por pessoa marcada
--   mensagens                 o ✉️: canal "Geral" (todos) e conversa direta entre duas pessoas
--   mensagens_lidas           até quando cada pessoa leu cada conversa (contador de não lidas)
--
-- Notificação e mensagem dependem de cada pessoa ter o PRÓPRIO login (Authentication → Users).
-- O nome que aparece vem de profiles.nome — cada um ajusta o seu na tela de Mensagens.
-- Tudo imutável, no mesmo padrão dos comentários: mensagem não se edita nem se apaga.
-- ============================================================================

-- ─── COMENTÁRIOS: quem foi marcado ──────────────────────────────────────────
alter table public.obra_comentarios add column if not exists mencoes  uuid[] not null default '{}';
alter table public.obra_comentarios add column if not exists autor_id uuid default auth.uid();

-- A guarda passa a proteger as colunas novas. Corrige também o TRUNCATE: com tg_op 'TRUNCATE'
-- a função antiga comparava new/old nulos, não levantava erro e o TRUNCATE passava.
create or replace function public.obra_comentarios_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Comentário não se apaga — use Ocultar.';
  end if;
  if new.id <> old.id or new.obra_id <> old.obra_id or new.tipo <> old.tipo or new.texto <> old.texto
     or new.autor is distinct from old.autor or new.created_at <> old.created_at
     or new.mencoes is distinct from old.mencoes or new.autor_id is distinct from old.autor_id then
    raise exception 'Comentário não se edita — escreva um novo ou oculte este.';
  end if;
  return new;
end; $$;

-- ─── NOTIFICAÇÕES ───────────────────────────────────────────────────────────
-- Só nascem pelo trigger do comentário (security definer): o cliente não tem policy de INSERT,
-- então ninguém fabrica notificação para outra pessoa. O dono só pode marcar como lida.
create table if not exists public.notificacoes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,  -- quem recebe
  tipo          text not null default 'mencao' check (tipo in ('mencao')),
  de_id         uuid,
  de_nome       text,
  obra_id       text,
  comentario_id uuid,
  texto         text,
  created_at    timestamptz not null default now(),
  lida_em       timestamptz
);
create index if not exists notificacoes_user_idx on public.notificacoes (user_id, created_at desc);

alter table public.notificacoes enable row level security;
drop policy if exists notificacoes_select on public.notificacoes;
create policy notificacoes_select on public.notificacoes for select using (user_id = auth.uid());
drop policy if exists notificacoes_update on public.notificacoes;
create policy notificacoes_update on public.notificacoes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.notificacoes_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'Notificação não se apaga.'; end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.tipo <> old.tipo
     or new.de_id is distinct from old.de_id or new.de_nome is distinct from old.de_nome
     or new.obra_id is distinct from old.obra_id or new.comentario_id is distinct from old.comentario_id
     or new.texto is distinct from old.texto or new.created_at <> old.created_at then
    raise exception 'Notificação só pode ser marcada como lida.';
  end if;
  return new;
end; $$;
drop trigger if exists notificacoes_guarda on public.notificacoes;
create trigger notificacoes_guarda before update or delete on public.notificacoes
  for each row execute function public.notificacoes_guarda();
drop trigger if exists notificacoes_sem_truncate on public.notificacoes;
create trigger notificacoes_sem_truncate before truncate on public.notificacoes
  for each statement execute function public.notificacoes_guarda();

-- Comentário com @ gera uma notificação por pessoa marcada (menos quem escreveu).
create or replace function public.comentario_notifica_mencoes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(array_length(new.mencoes, 1), 0) = 0 then return new; end if;
  insert into public.notificacoes (user_id, tipo, de_id, de_nome, obra_id, comentario_id, texto)
  select distinct p.id, 'mencao', new.autor_id, new.autor, new.obra_id, new.id, left(new.texto, 400)
    from public.profiles p
   where p.id = any(new.mencoes)
     and p.id is distinct from new.autor_id;
  return new;
end; $$;
drop trigger if exists obra_comentarios_mencoes on public.obra_comentarios;
create trigger obra_comentarios_mencoes after insert on public.obra_comentarios
  for each row execute function public.comentario_notifica_mencoes();

-- ─── MENSAGENS (chat) ───────────────────────────────────────────────────────
-- conversa = 'geral' (todos) ou 'dm:<uuid menor>:<uuid maior>' (duas pessoas).
-- A chave é conferida pelo banco: não dá para gravar numa conversa de que não se participa.
create table if not exists public.mensagens (
  id         uuid primary key default gen_random_uuid(),
  conversa   text not null,
  de_id      uuid not null default auth.uid() references auth.users(id),
  de_nome    text,
  para_id    uuid references auth.users(id),
  texto      text not null check (length(trim(texto)) > 0 and length(texto) <= 4000),
  obra_id    text,
  created_at timestamptz not null default now(),
  check (
    (para_id is null and conversa = 'geral')
    or (para_id is not null and para_id <> de_id and conversa = 'dm:' || least(de_id::text, para_id::text) || ':' || greatest(de_id::text, para_id::text))
  )
);
create index if not exists mensagens_conversa_idx on public.mensagens (conversa, created_at);

alter table public.mensagens enable row level security;
drop policy if exists mensagens_select on public.mensagens;
create policy mensagens_select on public.mensagens for select
  using (public.is_admin() and (conversa = 'geral' or de_id = auth.uid() or para_id = auth.uid()));
drop policy if exists mensagens_insert on public.mensagens;
create policy mensagens_insert on public.mensagens for insert
  with check (public.is_admin() and de_id = auth.uid());

create or replace function public.mensagens_guarda()
returns trigger language plpgsql as $$
begin
  raise exception 'Mensagem não se edita nem se apaga.';
end; $$;
drop trigger if exists mensagens_guarda on public.mensagens;
create trigger mensagens_guarda before update or delete on public.mensagens
  for each row execute function public.mensagens_guarda();
drop trigger if exists mensagens_sem_truncate on public.mensagens;
create trigger mensagens_sem_truncate before truncate on public.mensagens
  for each statement execute function public.mensagens_guarda();

-- Até quando cada um leu cada conversa. Uma linha por (pessoa, conversa), só a própria.
create table if not exists public.mensagens_lidas (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversa text not null,
  lida_ate timestamptz not null default now(),
  primary key (user_id, conversa)
);
alter table public.mensagens_lidas enable row level security;
drop policy if exists mensagens_lidas_dono on public.mensagens_lidas;
create policy mensagens_lidas_dono on public.mensagens_lidas for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Resumo para a lista de conversas e o contador do ✉️: por conversa visível, a última
-- mensagem e quantas chegaram depois da última leitura (as próprias não contam).
create or replace function public.resumo_mensagens()
returns table (conversa text, ultima_em timestamptz, nao_lidas bigint)
language sql stable security invoker set search_path = public as $$
  select m.conversa,
         max(m.created_at) as ultima_em,
         count(*) filter (where m.de_id <> auth.uid() and m.created_at > coalesce(l.lida_ate, '-infinity'::timestamptz)) as nao_lidas
    from public.mensagens m
    left join public.mensagens_lidas l on l.user_id = auth.uid() and l.conversa = m.conversa
   group by m.conversa;
$$;

-- ─── TEMPO REAL ─────────────────────────────────────────────────────────────
-- O sino e a cartinha acendem na hora pelo Realtime (respeita o RLS acima). Sem isso o app
-- ainda funciona: confere de novo a cada minuto e quando a aba volta ao foco.
do $$
begin
  begin alter publication supabase_realtime add table public.notificacoes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.mensagens;    exception when duplicate_object then null; end;
end $$;
