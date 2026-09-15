-- ============================================================================
-- Ficha da obra: histórico de versões, obra que não se apaga, anexos e comentários
-- Rode no SQL Editor do Supabase (uma vez). Pode rodar de novo sem estragar nada.
--
-- Regra da casa: o que o usuário insere aqui não se perde. Por isso quase tudo é trigger,
-- e não só RLS — o service_role e o SQL Editor ignoram RLS, mas não ignoram trigger.
-- ============================================================================

-- ─── HISTÓRICO DE VERSÕES DA OBRA ───────────────────────────────────────────
-- A obra é gravada inteira (jsonb) a cada alteração. Se alguém sobrescrever algo, a versão
-- anterior está aqui. Para não inchar o banco com uma versão por tecla, guarda no máximo uma
-- a cada 10 minutos por obra — o estado de ANTES da primeira alteração da janela —, mais toda
-- mudança grande (itens ou valor total trocados, que é o que a reimportação do PDF faz).
create table if not exists public.obras_historico (
  id         bigserial primary key,
  obra_id    text not null,
  operacao   text not null,              -- 'update' | 'delete'
  data       jsonb,
  gravado_em timestamptz not null default now()
);
create index if not exists obras_historico_obra_idx on public.obras_historico (obra_id, gravado_em desc);

alter table public.obras_historico enable row level security;
-- Só leitura pelo app. Quem grava é o trigger (security definer), nunca o usuário.
drop policy if exists obras_historico_select on public.obras_historico;
create policy obras_historico_select on public.obras_historico for select using (public.is_admin());

create or replace function public.obras_guardar_versao()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.obras_historico (obra_id, operacao, data) values (old.id, 'delete', old.data);
    return old;
  end if;
  if new.data is distinct from old.data and (
       jsonb_array_length(coalesce(old.data->'itens', '[]'::jsonb)) is distinct from jsonb_array_length(coalesce(new.data->'itens', '[]'::jsonb))
    or (old.data->'valorTotal') is distinct from (new.data->'valorTotal')
    or not exists (
      select 1 from public.obras_historico
      where obra_id = old.id and gravado_em > now() - interval '10 minutes'
    )
  ) then
    insert into public.obras_historico (obra_id, operacao, data) values (old.id, 'update', old.data);
  end if;
  return new;
end; $$;

drop trigger if exists obras_historico_trg on public.obras;
create trigger obras_historico_trg after update or delete on public.obras
  for each row execute function public.obras_guardar_versao();

-- O histórico em si também não se altera nem se apaga.
create or replace function public.obras_historico_imutavel()
returns trigger language plpgsql as $$
begin
  raise exception 'O histórico de versões das obras não pode ser alterado nem apagado.';
end; $$;

drop trigger if exists obras_historico_imutavel on public.obras_historico;
create trigger obras_historico_imutavel before update or delete on public.obras_historico
  for each row execute function public.obras_historico_imutavel();
drop trigger if exists obras_historico_sem_truncate on public.obras_historico;
create trigger obras_historico_sem_truncate before truncate on public.obras_historico
  for each statement execute function public.obras_historico_imutavel();

-- ─── OBRA NÃO SE APAGA ──────────────────────────────────────────────────────
-- Nenhuma tela apaga obra: agenda, cronograma, diário, lembretes e anexos guardam o id dela.
-- Para apagar de verdade é preciso desligar este trigger à mão — de propósito.
create or replace function public.obras_sem_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Obra não se apaga. Mude o status para Concluído. (Para apagar mesmo, desligue o trigger obras_sem_delete antes.)';
end; $$;

drop trigger if exists obras_sem_delete on public.obras;
create trigger obras_sem_delete before delete on public.obras
  for each row execute function public.obras_sem_delete();
drop trigger if exists obras_sem_truncate on public.obras;
create trigger obras_sem_truncate before truncate on public.obras
  for each statement execute function public.obras_sem_delete();

-- ─── ANEXOS DA OBRA ─────────────────────────────────────────────────────────
-- Uma linha por arquivo, fora do jsonb da obra: lá valeria o "última gravação vence" e dois
-- anexos enviados ao mesmo tempo se apagariam. Remover é lixeira (removido_em), nunca DELETE.
create table if not exists public.obra_anexos (
  id           uuid primary key default gen_random_uuid(),
  obra_id      text not null,            -- sem FK de propósito, igual ao estoque
  nome         text not null,
  path         text not null unique,     -- caminho no bucket "obras"
  mime         text,
  tamanho      bigint,
  categoria    text not null default 'outro'
               check (categoria in ('contrato','orcamento','comprovante','projeto','foto','outro')),
  autor        text,
  created_at   timestamptz not null default now(),
  removido_em  timestamptz,
  removido_por text
);
create index if not exists obra_anexos_obra_idx on public.obra_anexos (obra_id, created_at);

alter table public.obra_anexos enable row level security;
drop policy if exists obra_anexos_select on public.obra_anexos;
create policy obra_anexos_select on public.obra_anexos for select using (public.is_admin());
drop policy if exists obra_anexos_insert on public.obra_anexos;
create policy obra_anexos_insert on public.obra_anexos for insert with check (public.is_admin());
drop policy if exists obra_anexos_update on public.obra_anexos;
create policy obra_anexos_update on public.obra_anexos for update using (public.is_admin()) with check (public.is_admin());
-- sem policy de delete

create or replace function public.obra_anexos_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Anexo não se apaga — use Remover (vai para a lixeira e pode ser restaurado).';
  end if;
  if new.id <> old.id or new.obra_id <> old.obra_id or new.nome <> old.nome or new.path <> old.path
     or new.mime is distinct from old.mime or new.tamanho is distinct from old.tamanho
     or new.autor is distinct from old.autor or new.created_at <> old.created_at then
    raise exception 'No anexo só dá para mudar a categoria e mandar para a lixeira ou restaurar.';
  end if;
  return new;
end; $$;

drop trigger if exists obra_anexos_guarda on public.obra_anexos;
create trigger obra_anexos_guarda before update or delete on public.obra_anexos
  for each row execute function public.obra_anexos_guarda();
drop trigger if exists obra_anexos_sem_truncate on public.obra_anexos;
create trigger obra_anexos_sem_truncate before truncate on public.obra_anexos
  for each statement execute function public.obra_anexos_guarda();

-- ─── COMENTÁRIOS E ATIVIDADE ────────────────────────────────────────────────
-- Imutável: errou, escreve outro comentário ou oculta este. Oculto continua no banco e
-- aparece em "Mostrar ocultos". tipo 'sistema' = atividade registrada pelo próprio app.
create table if not exists public.obra_comentarios (
  id         uuid primary key default gen_random_uuid(),
  obra_id    text not null,
  tipo       text not null default 'comentario' check (tipo in ('comentario','sistema')),
  texto      text not null check (length(trim(texto)) > 0),
  autor      text,
  created_at timestamptz not null default now(),
  oculto_em  timestamptz
);
create index if not exists obra_comentarios_obra_idx on public.obra_comentarios (obra_id, created_at);

alter table public.obra_comentarios enable row level security;
drop policy if exists obra_comentarios_select on public.obra_comentarios;
create policy obra_comentarios_select on public.obra_comentarios for select using (public.is_admin());
drop policy if exists obra_comentarios_insert on public.obra_comentarios;
create policy obra_comentarios_insert on public.obra_comentarios for insert with check (public.is_admin());
drop policy if exists obra_comentarios_update on public.obra_comentarios;
create policy obra_comentarios_update on public.obra_comentarios for update using (public.is_admin()) with check (public.is_admin());

create or replace function public.obra_comentarios_guarda()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Comentário não se apaga — use Ocultar.';
  end if;
  if new.id <> old.id or new.obra_id <> old.obra_id or new.tipo <> old.tipo or new.texto <> old.texto
     or new.autor is distinct from old.autor or new.created_at <> old.created_at then
    raise exception 'Comentário não se edita — escreva um novo ou oculte este.';
  end if;
  return new;
end; $$;

drop trigger if exists obra_comentarios_guarda on public.obra_comentarios;
create trigger obra_comentarios_guarda before update or delete on public.obra_comentarios
  for each row execute function public.obra_comentarios_guarda();
drop trigger if exists obra_comentarios_sem_truncate on public.obra_comentarios;
create trigger obra_comentarios_sem_truncate before truncate on public.obra_comentarios
  for each statement execute function public.obra_comentarios_guarda();

-- ============================================================================
-- STORAGE: bucket PRIVADO "obras" (contrato assinado, orçamento, comprovante, fotos)
-- Diferente de "desenhos" e "diario": sem leitura pública. O app abre por URL assinada, que
-- expira — link vazado de contrato não fica valendo para sempre.
-- Sem policy de update e de delete: arquivo enviado nunca é sobrescrito nem apagado pelo app.
-- Limite de 25 MB por arquivo.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('obras', 'obras', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

drop policy if exists obras_arquivos_read on storage.objects;
create policy obras_arquivos_read on storage.objects for select to authenticated
  using (bucket_id = 'obras' and public.is_admin());

drop policy if exists obras_arquivos_write on storage.objects;
create policy obras_arquivos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'obras' and public.is_admin());
