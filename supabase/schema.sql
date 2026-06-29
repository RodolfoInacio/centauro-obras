-- ============================================================================
-- CENTAURO ESQUADRIAS — Schema do Supabase
-- Rode este script inteiro no SQL Editor do seu projeto Supabase (uma vez).
-- ============================================================================

-- ─── PERFIS (usuário → papel) ───────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text,
  papel      text not null default 'admin' check (papel in ('admin','encarregado','cliente')),
  created_at timestamptz default now()
);

-- Cria o profile automaticamente quando um usuário é criado no Auth.
-- (No v1 todo novo usuário entra como 'admin'.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, papel)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), 'admin')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: o usuário atual é admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and papel = 'admin'
  );
$$;

-- ─── OBRAS (documento jsonb = o mesmo objeto usado no app) ───────────────────
create table if not exists public.obras (
  id         text primary key,         -- = numero da obra
  numero     text,
  cliente    text,
  updated_at timestamptz default now(),
  data       jsonb not null            -- objeto completo da obra (itens, etapas, material, etc.)
);

-- ─── EQUIPES ────────────────────────────────────────────────────────────────
create table if not exists public.equipes (
  id          text primary key,
  nome        text,
  integrantes jsonb default '[]'::jsonb,
  cor         text
);

-- ─── OBRA_MEMBROS (fundação para clientes/encarregados — vazia no v1) ────────
create table if not exists public.obra_membros (
  obra_id text references public.obras(id) on delete cascade,
  user_id uuid references auth.users(id)  on delete cascade,
  papel   text check (papel in ('encarregado','cliente')),
  primary key (obra_id, user_id)
);

-- ============================================================================
-- RLS (Row Level Security)
-- ============================================================================
alter table public.profiles     enable row level security;
alter table public.obras        enable row level security;
alter table public.equipes      enable row level security;
alter table public.obra_membros enable row level security;

-- profiles: cada um vê/edita o seu; admin vê todos
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- v1: admin tem acesso total a obras / equipes / membros
drop policy if exists obras_admin on public.obras;
create policy obras_admin on public.obras for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists equipes_admin on public.equipes;
create policy equipes_admin on public.equipes for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists obra_membros_admin on public.obra_membros;
create policy obra_membros_admin on public.obra_membros for all
  using (public.is_admin()) with check (public.is_admin());

-- ── (FUTURO) leitura por membro — descomentar quando criar clientes/encarregados:
-- create policy obras_select_membro on public.obras for select
--   using (exists (
--     select 1 from public.obra_membros m
--     where m.obra_id = obras.id and m.user_id = auth.uid()
--   ));

-- ============================================================================
-- STORAGE: bucket público "desenhos"
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('desenhos', 'desenhos', true)
on conflict (id) do nothing;

-- leitura pública dos desenhos
drop policy if exists desenhos_read on storage.objects;
create policy desenhos_read on storage.objects for select
  using (bucket_id = 'desenhos');

-- escrita só para usuários autenticados (a migração usa service_role, que ignora RLS)
drop policy if exists desenhos_write on storage.objects;
create policy desenhos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'desenhos');

drop policy if exists desenhos_update on storage.objects;
create policy desenhos_update on storage.objects for update to authenticated
  using (bucket_id = 'desenhos');
