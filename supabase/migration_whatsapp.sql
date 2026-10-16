-- ============================================================================
-- AVISO POR WHATSAPP (Evolution API) — rodar DEPOIS da migration_acessos_compras.sql.
-- Pode rodar de novo sem estragar nada.
--
-- Toda notificação nova (o 🔔: @menção, pedido de compra, compra liberada/recusada) cuja pessoa
-- tem profiles.whatsapp preenchido dispara a Edge Function `whatsapp-notificar`, que manda a
-- mensagem pela Evolution. A chamada é assíncrona (pg_net): se o WhatsApp falhar, o 🔔 continua
-- funcionando e nada no app trava. Cada tentativa fica registrada em whatsapp_envios.
--
-- A função só aceita a chamada com um segredo combinado. ANTES de rodar este arquivo, invente
-- uma senha longa e grave a MESMA em dois lugares:
--   1. aqui no banco (Vault), rodando no SQL Editor:
--        select vault.create_secret('COLE-AQUI-O-SEGREDO', 'whatsapp_webhook_secret');
--   2. nos secrets da Edge Function (Edge Functions → Secrets): WHATSAPP_WEBHOOK_SECRET
-- Sem o segredo no Vault o gatilho não chama nada (fica calado, o 🔔 segue normal).
-- ============================================================================

create extension if not exists pg_net;

-- Registro de cada envio: para saber por que uma mensagem não chegou.
create table if not exists public.whatsapp_envios (
  id              bigserial primary key,
  notificacao_id  uuid,
  user_id         uuid,
  numero          text,
  status          text not null check (status in ('enviado', 'erro', 'teste_enviado', 'teste_erro')),
  erro            text,
  created_at      timestamptz not null default now()
);
create index if not exists whatsapp_envios_em_idx on public.whatsapp_envios (created_at desc);
alter table public.whatsapp_envios enable row level security;
drop policy if exists whatsapp_envios_select on public.whatsapp_envios;
create policy whatsapp_envios_select on public.whatsapp_envios for select using (public.is_master());
-- Sem policy de escrita: quem grava é a Edge Function, com a service_role.

create or replace function public.notificacao_whatsapp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_numero text;
  v_segredo text;
begin
  select nullif(trim(whatsapp), '') into v_numero from public.profiles where id = new.user_id;
  if v_numero is null then return new; end if;

  select decrypted_secret into v_segredo from vault.decrypted_secrets where name = 'whatsapp_webhook_secret' limit 1;
  if v_segredo is null then return new; end if;

  perform net.http_post(
    url := 'https://rlyfnlsntlasrwvmgjbo.supabase.co/functions/v1/whatsapp-notificar',
    body := jsonb_build_object('notificacaoId', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-segredo', v_segredo),
    timeout_milliseconds := 15000
  );
  return new;
exception when others then
  -- WhatsApp nunca pode impedir a notificação de nascer.
  raise warning 'notificacao_whatsapp: %', sqlerrm;
  return new;
end; $$;

drop trigger if exists notificacoes_whatsapp on public.notificacoes;
create trigger notificacoes_whatsapp after insert on public.notificacoes
  for each row execute function public.notificacao_whatsapp();
