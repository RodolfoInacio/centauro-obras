// Portal do cliente: cria e cuida dos logins dos clientes, e entrega os documentos liberados.
//
// Entrada: POST { acao, ... } + Authorization: Bearer <jwt>.
//   Equipe (profiles.papel = 'admin'):
//     criar        { obraId, usuario, nome }  → cria o login (papel 'cliente') e liga à obra.
//                                               Devolve a senha UMA vez; ela não fica guardada.
//     vincular     { obraId, usuario }        → liga um cliente que já existe a mais um contrato
//     desvincular  { obraId, userId }
//     nova_senha   { userId }                 → gera outra senha (a antiga para de valer)
//     bloquear     { userId } / desbloquear { userId }
//     listar       { obraId }                 → logins ligados à obra
//   Cliente (ou equipe):
//     anexo        { anexoId }                → URL assinada (1 h) de um anexo liberado (portal)
//
// Só mexe em login de papel 'cliente': senha e bloqueio de quem é da equipe nunca passam por aqui.
// O usuário vira e-mail interno <usuario>@cliente.centauroesquadrias.com.br (o cliente não
// precisa de e-mail; a tela de login completa o domínio quando não há "@").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const DOMINIO = "cliente.centauroesquadrias.com.br";
const BLOQUEIO = "876000h"; // ~100 anos

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// Sem 0/O, 1/l/I: a senha vai ser lida no celular e digitada por quem recebeu no WhatsApp.
function gerarSenha(n = 10): string {
  const alfabeto = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, v => alfabeto[v % alfabeto.length]).join("");
}

function normUsuario(u: string): string {
  return (u || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Não autenticado" }, 401);
  const usuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await usuario.auth.getUser();
  if (!user) return json({ error: "Não autenticado" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: eu } = await admin.from("profiles").select("papel").eq("id", user.id).maybeSingle();
  const ehEquipe = eu?.papel === "admin";

  let corpo: Record<string, string>;
  try { corpo = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const acao = corpo.acao;

  // ─── Documento liberado (cliente) ─────────────────────────────────────────
  if (acao === "anexo") {
    const { data: a } = await admin.from("obra_anexos")
      .select("id, obra_id, path, nome, portal, removido_em").eq("id", corpo.anexoId || "").maybeSingle();
    if (!a || a.removido_em) return json({ error: "Documento não encontrado." }, 404);
    if (!ehEquipe) {
      const { data: m } = await admin.from("obra_membros").select("user_id")
        .eq("obra_id", a.obra_id).eq("user_id", user.id).eq("papel", "cliente").maybeSingle();
      if (!m || eu?.papel !== "cliente") return json({ error: "Sem acesso a este documento." }, 403);
      // A capa escolhida na obra também abre (é a foto do topo do portal).
      const { data: o } = await admin.from("obras").select("data->capa").eq("id", a.obra_id).maybeSingle();
      const ehCapa = (o as { capa?: { anexoId?: string } } | null)?.capa?.anexoId === a.id;
      if (!a.portal && !ehCapa) return json({ error: "Documento não liberado para o cliente." }, 403);
    }
    const { data: s, error } = await admin.storage.from("obras").createSignedUrl(a.path, 3600);
    if (error || !s) return json({ error: error?.message || "Falha ao gerar o link." }, 500);
    return json({ url: s.signedUrl, nome: a.nome });
  }

  // Daqui para baixo, só a equipe.
  if (!ehEquipe) return json({ error: "Só a equipe da Centauro gerencia os acessos." }, 403);

  async function clienteDe(userId: string) {
    const { data: p } = await admin.from("profiles").select("id, nome, email, papel").eq("id", userId || "").maybeSingle();
    if (!p || p.papel !== "cliente") throw new Error("Esse login não é de cliente.");
    return p;
  }
  async function obraExiste(obraId: string) {
    const { data: o } = await admin.from("obras").select("id").eq("id", obraId || "").maybeSingle();
    if (!o) throw new Error("Obra não encontrada.");
  }

  try {
    if (acao === "listar") {
      const { data: ms, error } = await admin.from("obra_membros").select("user_id, papel").eq("obra_id", corpo.obraId || "").eq("papel", "cliente");
      if (error) throw error;
      const out = [];
      for (const m of ms || []) {
        const { data: p } = await admin.from("profiles").select("nome, email").eq("id", m.user_id).maybeSingle();
        const { data: u } = await admin.auth.admin.getUserById(m.user_id);
        const banido = u?.user?.banned_until ? new Date(u.user.banned_until) > new Date() : false;
        out.push({
          userId: m.user_id, nome: p?.nome || "", email: p?.email || "",
          usuario: (p?.email || "").endsWith("@" + DOMINIO) ? p!.email.split("@")[0] : (p?.email || ""),
          ultimoAcesso: u?.user?.last_sign_in_at || null, bloqueado: banido,
        });
      }
      return json({ acessos: out });
    }

    if (acao === "criar") {
      await obraExiste(corpo.obraId);
      const u = normUsuario(corpo.usuario);
      if (u.length < 3 || u.length > 40) return json({ error: "Usuário precisa ter de 3 a 40 letras ou números." }, 400);
      const email = `${u}@${DOMINIO}`;
      const senha = gerarSenha();
      const nome = (corpo.nome || "").trim() || u;
      const { data: criado, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true,
        app_metadata: { papel: "cliente" }, user_metadata: { nome },
      });
      if (error || !criado?.user) {
        const msg = error?.message || "";
        if (/already|registered|exists/i.test(msg)) return json({ error: `O usuário "${u}" já existe. Use "Ligar cliente existente" ou escolha outro.` }, 409);
        throw new Error(msg || "Falha ao criar o login.");
      }
      const id = criado.user.id;
      // O trigger handle_new_user cria o perfil; garante o papel mesmo se a migration antiga estiver valendo.
      await admin.from("profiles").upsert({ id, nome, email, papel: "cliente" }, { onConflict: "id" });
      const { error: mErr } = await admin.from("obra_membros").insert({ obra_id: corpo.obraId, user_id: id, papel: "cliente" });
      if (mErr) throw mErr;
      return json({ userId: id, usuario: u, senha, nome });
    }

    if (acao === "vincular") {
      await obraExiste(corpo.obraId);
      const u = normUsuario(corpo.usuario);
      const email = u.includes("@") ? u : `${u}@${DOMINIO}`;
      const { data: p } = await admin.from("profiles").select("id, papel").eq("email", email).maybeSingle();
      if (!p) return json({ error: `Não existe login "${u}".` }, 404);
      if (p.papel !== "cliente") return json({ error: "Esse login é da equipe, não de cliente." }, 400);
      const { error } = await admin.from("obra_membros").upsert({ obra_id: corpo.obraId, user_id: p.id, papel: "cliente" }, { onConflict: "obra_id,user_id" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (acao === "desvincular") {
      await clienteDe(corpo.userId);
      const { error } = await admin.from("obra_membros").delete().eq("obra_id", corpo.obraId || "").eq("user_id", corpo.userId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (acao === "nova_senha") {
      await clienteDe(corpo.userId);
      const senha = gerarSenha();
      const { error } = await admin.auth.admin.updateUserById(corpo.userId, { password: senha });
      if (error) throw error;
      return json({ senha });
    }

    if (acao === "bloquear" || acao === "desbloquear") {
      await clienteDe(corpo.userId);
      const { error } = await admin.auth.admin.updateUserById(corpo.userId, { ban_duration: acao === "bloquear" ? BLOQUEIO : "none" });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `Ação desconhecida: ${acao}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
