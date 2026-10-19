// Manda pelo WhatsApp (Evolution API v2) o aviso que acabou de nascer no 🔔.
//
// Dois jeitos de chamar:
//   1. Gatilho do banco (migration_whatsapp.sql): POST { notificacaoId } + header x-segredo.
//      O segredo é o WHATSAPP_WEBHOOK_SECRET, o mesmo gravado no Vault. Por isso a função
//      roda com verify_jwt = false (config.toml): quem chama é o banco, não um usuário.
//   2. Botão "Testar" do master (Configurações → Pessoas e acessos):
//      POST { teste: <userId> } + Authorization: Bearer <jwt>. Só o master consegue.
//
// O número sai de profiles.whatsapp; a mensagem nunca leva valor em R$ (mesma regra do 🔔).
// Cada tentativa vai para whatsapp_envios.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const APP_URL = "https://obras.centauroesquadrias.com.br";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// "(42) 99999-9999" → "5542999999999". Número com DDI já é mantido.
function normalizarNumero(n: string): string {
  const d = (n || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
}

// Comparação em tempo constante, para o segredo não vazar pelo tempo de resposta.
function iguais(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function enviarEvolution(numero: string, texto: string): Promise<void> {
  const base = (Deno.env.get("EVOLUTION_URL") || "").replace(/\/+$/, "");
  const instancia = Deno.env.get("EVOLUTION_INSTANCE") || "";
  const apikey = Deno.env.get("EVOLUTION_APIKEY") || "";
  if (!base || !instancia || !apikey) throw new Error("Faltam os secrets EVOLUTION_URL, EVOLUTION_INSTANCE ou EVOLUTION_APIKEY.");
  const resp = await fetch(`${base}/message/sendText/${encodeURIComponent(instancia)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey },
    body: JSON.stringify({ number: numero, text: texto }),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) {
    const corpo = (await resp.text()).slice(0, 300);
    throw new Error(`Evolution respondeu ${resp.status}: ${corpo}`);
  }
}

type Notif = { id: string; user_id: string; tipo: string; de_nome: string | null; obra_id: string | null; texto: string | null };

function montarMensagem(n: Notif, obra: { numero?: string; cliente?: string } | null): string {
  const quem = n.de_nome || "Alguém";
  const rotuloObra = obra ? `#${obra.numero || n.obra_id} ${obra.cliente || ""}`.trim() : (n.obra_id ? `#${n.obra_id}` : "");
  // Aviso do 💼 Comercial (ou @menção na ficha da negociação): obra_id é o NEG-….
  const ehNeg = /^NEG-/.test(n.obra_id || "");
  const titulo = {
    compra_pedido: `📝 *${quem}* pediu aprovação de compra`,
    compra_aprovada: `✅ *${quem}* liberou uma compra`,
    compra_recusada: `✖ *${quem}* recusou uma compra`,
    mencao: `💬 *${quem}* marcou você num comentário`,
    comercial_liberado: `📐 *${quem}* liberou para orçamento`,
    comercial_pronto: `💼 *${quem}* terminou o orçamento`,
    comercial_revisao: `🔁 *${quem}* pediu revisão do orçamento`,
    comercial_atribuido: `👤 *${quem}* colocou você numa negociação`,
  }[n.tipo] || `🔔 Aviso de *${quem}*`;
  const link = n.tipo === "compra_pedido" ? `${APP_URL}/#/aprovacoes`
    : ehNeg ? `${APP_URL}/#/comercial/${encodeURIComponent(n.obra_id!)}`
    : n.obra_id ? `${APP_URL}/#/obra/${encodeURIComponent(n.obra_id)}` : APP_URL;
  return [
    titulo,
    rotuloObra ? `${ehNeg ? "Negociação" : "Obra"}: *${rotuloObra}*` : "",
    (n.texto || "").trim(),
    "",
    `Abrir: ${link}`,
    "_Centauro · Gestão de Obras_",
  ].filter((l, i) => l !== "" || i === 3).join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const registrar = (linha: Record<string, unknown>) =>
    admin.from("whatsapp_envios").insert(linha).then(({ error }) => { if (error) console.warn("whatsapp_envios:", error.message); });

  let corpo: { notificacaoId?: string; teste?: string };
  try { corpo = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  // ─── 2. Teste pelo master ───────────────────────────────────────────────
  if (corpo.teste) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);
    const usuario = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await usuario.auth.getUser();
    if (!user) return json({ error: "Não autenticado" }, 401);
    const { data: eu } = await admin.from("profiles").select("master").eq("id", user.id).maybeSingle();
    if (!eu?.master) return json({ error: "Só o master testa o WhatsApp." }, 403);

    const { data: p } = await admin.from("profiles").select("nome, whatsapp").eq("id", corpo.teste).maybeSingle();
    const numero = normalizarNumero(p?.whatsapp || "");
    if (!numero) return json({ error: "Essa pessoa está sem número de WhatsApp." }, 400);
    try {
      await enviarEvolution(numero, `✅ Teste da *Centauro · Gestão de Obras*.\nOs avisos do 🔔 vão chegar neste número.\n\n${APP_URL}`);
      await registrar({ user_id: corpo.teste, numero, status: "teste_enviado" });
      return json({ ok: true, numero }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await registrar({ user_id: corpo.teste, numero, status: "teste_erro", erro: msg });
      return json({ error: msg }, 502);
    }
  }

  // ─── 1. Gatilho do banco ────────────────────────────────────────────────
  if (!iguais(req.headers.get("x-segredo") || "", Deno.env.get("WHATSAPP_WEBHOOK_SECRET") || "")) {
    return json({ error: "Segredo inválido" }, 401);
  }
  if (!corpo.notificacaoId) return json({ error: "notificacaoId obrigatório" }, 400);

  const { data: n, error: nErr } = await admin.from("notificacoes")
    .select("id, user_id, tipo, de_nome, obra_id, texto").eq("id", corpo.notificacaoId).maybeSingle();
  if (nErr || !n) return json({ error: nErr?.message || "Notificação não encontrada" }, 404);

  const { data: p } = await admin.from("profiles").select("whatsapp").eq("id", n.user_id).maybeSingle();
  const numero = normalizarNumero(p?.whatsapp || "");
  if (!numero) return json({ ok: true, ignorado: "sem número" }, 200);

  const { data: obra } = !n.obra_id ? { data: null }
    : /^NEG-/.test(n.obra_id)
      ? await admin.from("negociacoes").select("numero, cliente").eq("id", n.obra_id).maybeSingle()
      : await admin.from("obras").select("numero, cliente").eq("id", n.obra_id).maybeSingle();

  try {
    await enviarEvolution(numero, montarMensagem(n as Notif, obra));
    await registrar({ notificacao_id: n.id, user_id: n.user_id, numero, status: "enviado" });
    return json({ ok: true }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("whatsapp-notificar:", msg);
    await registrar({ notificacao_id: n.id, user_id: n.user_id, numero, status: "erro", erro: msg });
    return json({ error: msg }, 502);
  }
});
