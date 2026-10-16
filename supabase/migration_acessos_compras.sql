-- ============================================================================
-- ACESSOS POR PESSOA + APROVAÇÃO DE COMPRAS NO 🔔
-- Rodar no SQL Editor do Supabase, DEPOIS da migration_mensagens.sql. Pode rodar de novo.
--
--   profiles.acessos   o que cada pessoa faz: 'aprova_compras' (aprova orçamento de compra),
--                      'compras' (recebe o aviso de compra liberada/recusada)
--   profiles.master    quem controla os acessos (tela Configurações → Pessoas e acessos)
--   profiles.email     só para a tela do master saber quem é quem
--   profiles.whatsapp  para a fase 2 (aviso por WhatsApp); ainda sem uso
--
-- Acesso, master e papel só mudam pelo master — trigger, não só policy: hoje cada um pode
-- editar o próprio perfil (o nome), e sem a trava qualquer um se daria acesso.
--
-- ⚠ DEPOIS DE RODAR, marque o master UMA VEZ (o e-mail não fica no repositório, que é público):
--     update public.profiles set master = true where email = 'SEU-EMAIL-AQUI';
-- ============================================================================

alter table public.profiles add column if not exists acessos  text[]  not null default '{}';
alter table public.profiles add column if not exists master   boolean not null default false;
alter table public.profiles add column if not exists email    text;
alter table public.profiles add column if not exists whatsapp text;

-- E-mail de quem já existe, e de quem for criado daqui para frente.
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is distinct from u.email;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, papel, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), 'admin', new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

create or replace function public.is_master()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and master);
$$;

create or replace function public.tem_acesso(p_acesso text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and p_acesso = any(acessos));
$$;

-- Sem login (SQL Editor, service_role) passa: é quem já manda no banco inteiro, e é assim que o
-- primeiro master é marcado.
create or replace function public.profiles_guarda()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_master() and (
       new.acessos is distinct from old.acessos or new.master is distinct from old.master
    or new.papel is distinct from old.papel or new.email is distinct from old.email
    or new.whatsapp is distinct from old.whatsapp) then
    raise exception 'Só o master muda acessos. Cada um pode trocar apenas o próprio nome.';
  end if;
  return new;
end; $$;
drop trigger if exists profiles_guarda on public.profiles;
create trigger profiles_guarda before update on public.profiles
  for each row execute function public.profiles_guarda();

-- ─── NOTIFICAÇÕES DE COMPRA ─────────────────────────────────────────────────
alter table public.notificacoes drop constraint if exists notificacoes_tipo_check;
alter table public.notificacoes add constraint notificacoes_tipo_check
  check (tipo in ('mencao', 'compra_pedido', 'compra_aprovada', 'compra_recusada'));
alter table public.notificacoes add column if not exists dados jsonb;

create or replace function public.notificacoes_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'Notificação não se apaga.'; end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.tipo <> old.tipo
     or new.de_id is distinct from old.de_id or new.de_nome is distinct from old.de_nome
     or new.obra_id is distinct from old.obra_id or new.comentario_id is distinct from old.comentario_id
     or new.texto is distinct from old.texto or new.created_at <> old.created_at
     or new.dados is distinct from old.dados then
    raise exception 'Notificação só pode ser marcada como lida.';
  end if;
  return new;
end; $$;

-- O cliente continua sem INSERT em notificacoes: o aviso de compra passa por aqui, que decide
-- os destinatários pelo acesso de cada um e confere quem está chamando.
--   compra_pedido              → todos com 'aprova_compras'
--   compra_aprovada / recusada → só quem tem 'aprova_compras' dispara; vai para quem pediu
--                                (p_para) e para todos com 'compras'
-- Quem dispara nunca recebe o próprio aviso. O nome de quem disparou sai do perfil, não do cliente.
create or replace function public.notificar_compra(p_tipo text, p_obra_id text, p_texto text, p_dados jsonb, p_para uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_nome text;
  v_n integer;
begin
  if not public.is_admin() then raise exception 'Sem permissão.'; end if;
  if p_tipo not in ('compra_pedido', 'compra_aprovada', 'compra_recusada') then
    raise exception 'Tipo de aviso inválido: %', p_tipo;
  end if;
  if p_tipo <> 'compra_pedido' and not public.tem_acesso('aprova_compras') then
    raise exception 'Só quem aprova compras pode liberar ou recusar.';
  end if;

  select split_part(coalesce(nullif(trim(nome), ''), email, ''), '@', 1) into v_nome from public.profiles where id = auth.uid();

  insert into public.notificacoes (user_id, tipo, de_id, de_nome, obra_id, texto, dados)
  select distinct p.id, p_tipo, auth.uid(), v_nome, p_obra_id, left(p_texto, 600), p_dados
    from public.profiles p
   where p.id is distinct from auth.uid()
     and (
       (p_tipo = 'compra_pedido' and 'aprova_compras' = any(p.acessos))
       or (p_tipo <> 'compra_pedido' and (p.id = p_para or 'compras' = any(p.acessos)))
     );
  get diagnostics v_n = row_count;
  return v_n;
end; $$;

revoke all on function public.notificar_compra(text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.notificar_compra(text, text, text, jsonb, uuid) to authenticated;
