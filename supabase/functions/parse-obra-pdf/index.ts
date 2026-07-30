// Recebe o texto (linhas) já extraído de um PDF de orçamento no browser (pdf.js) e usa a
// Anthropic API para extrair os dados estruturados da obra (cabeçalho + itens).
// Não faz nenhuma lógica de negócio do app (defaults de status/etapas/percentual ficam no cliente).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

const EXTRACT_TOOL = {
  name: "extrair_obra",
  description: "Extrai os dados estruturados de um orçamento (proposta) de esquadrias/vidraçaria da Centauro Esquadrias.",
  input_schema: {
    type: "object",
    properties: {
      numero: { type: "string", description: "Número da proposta (ex: campo 'Proposta 1234')" },
      cliente: { type: "string" },
      obra: { type: "string", description: "Nome da obra (campo 'Obra:'), pode vir vazio" },
      cidade: { type: "string" },
      vendedor: { type: "string" },
      data: { type: "string", description: "Data da proposta (Dt.Proposta), formato dd/mm/aaaa" },
      valorTotal: { type: "number", description: "Valor Final da proposta em reais" },
      itens: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: { type: "string" },
            descricao: { type: "string" },
            perfil: { type: "string" },
            acessorios: { type: "string" },
            vidro: { type: "string" },
            localizacao: { type: "string" },
            qtd: { type: "number" },
            L: { type: "number" },
            H: { type: "number" },
            vlrUnt: { type: "number" },
            vlrTotal: { type: "number" },
          },
          required: ["descricao", "qtd", "vlrTotal"],
        },
      },
    },
    required: ["numero", "cliente", "itens"],
  },
};

const SYSTEM_PROMPT = `Você extrai dados de orçamentos (propostas comerciais) de esquadrias de alumínio e vidraçaria da empresa Centauro Esquadrias, gerados pelo sistema Wvetro. O texto a seguir foi extraído de um PDF linha por linha e pode ter quebras de linha e ordem um pouco diferentes do PDF original.

Regras importantes:
- O campo "Obra:" no cabeçalho às vezes vem vazio — nesse caso retorne obra como string vazia.
- Cada bloco de item tem uma descrição (título em maiúsculas), depois "Perfil:", "Acessórios:", "Vidro:", "Localização:", e uma linha "Tipo: Qtd: L: H: Vlr Unt: Vlr Total:" seguida dos valores correspondentes.
- Alguns itens são apenas SERVIÇO (ex: "SERVIÇO DE INSTALAÇÃO...", "SERVIÇO DE MÃO DE OBRA") — não têm medidas reais de L/H (costumam vir como 1 ou vazio). Extraia-os normalmente como um item só, mesmo sem medidas reais — não invente múltiplos itens a partir de texto livre em "Observações".
- A numeração dos itens pode ter buracos (não é sequencial) — ignore isso, extraia todos os itens que encontrar, na ordem em que aparecem.
- Valores monetários usam vírgula decimal e ponto de milhar (ex: "7.427,92" = 7427.92) — converta para número.
- Se um campo não existir no texto, retorne string vazia ("") ou 0, nunca invente informação.

Responda chamando a ferramenta "extrair_obra" com os dados extraídos.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Não autenticado" }, 401);

    const { lines, filename } = await req.json();
    if (!Array.isArray(lines) || lines.length === 0) {
      return json({ error: "Nenhum texto extraído do PDF" }, 400);
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY não configurada" }, 500);

    const texto = lines.join("\n");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Arquivo: ${filename || "(sem nome)"}\n\n${texto}` }],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "extrair_obra" },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: `Anthropic API: ${resp.status} ${errText.slice(0, 300)}` }, 502);
    }

    const result = await resp.json();
    // Resposta cortada pelo limite de tokens devolve itens incompletos (ou nenhum) — falhar aqui
    // deixa o cliente cair no parser local em vez de gravar uma obra pela metade.
    if (result.stop_reason === "max_tokens") {
      return json({ error: "Orçamento longo demais para extração em uma resposta (max_tokens)" }, 502);
    }

    const toolUse = (result.content || []).find(
      (b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "extrair_obra"
    );
    if (!toolUse) return json({ error: "IA não retornou dados estruturados" }, 502);
    if (!Array.isArray(toolUse.input?.itens) || toolUse.input.itens.length === 0) {
      return json({ error: "IA não encontrou itens no orçamento" }, 502);
    }

    return json(toolUse.input, 200);
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
