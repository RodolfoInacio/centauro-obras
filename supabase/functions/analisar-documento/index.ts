// Lê um anexo da obra (contrato, comprovante de pagamento, nota fiscal de compra ou orçamento de
// fornecedor) com a IA e devolve os campos para a tela de conferência preencher.
// Não grava nada: quem aplica é o app, depois que o usuário confere (ver src/LeituraIA.jsx).
//
// Entrada: POST { anexoId, contexto } + Authorization: Bearer <jwt>.
// O arquivo é buscado AQUI, pelo id, com o login do usuário — a RLS de obra_anexos e do bucket
// "obras" vale igual ao app, e o cliente não consegue pedir um caminho qualquer do Storage.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import Anthropic from "npm:@anthropic-ai/sdk@0.126.0";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

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

// PDF vai como `document` (lê texto e escaneado); foto de comprovante vai como `image`.
const IMAGENS = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// Base64 infla 33%: 20 MB viram ~27 MB, abaixo dos 32 MB por requisição da API.
const LIMITE_BYTES = 20 * 1024 * 1024;

const txt = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const DATA = "Data no formato AAAA-MM-DD, ou \"\" se não houver";

// Structured outputs: todo campo é obrigatório e volta vazio ("" / 0) quando o documento não tem.
// Só o bloco do tipo identificado vem preenchido; os outros voltam zerados.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipo", "resumo", "contrato", "pagamento", "compra", "avisos"],
  properties: {
    tipo: {
      type: "string",
      enum: ["contrato", "comprovante", "nota_fiscal", "orcamento_fornecedor", "outro"],
      description: "contrato = contrato de venda/prestação com o cliente; comprovante = comprovante de pagamento RECEBIDO do cliente (PIX, TED, boleto pago, recibo); nota_fiscal = NF de compra de material de um fornecedor; orcamento_fornecedor = cotação/orçamento de um fornecedor para a Centauro; outro = qualquer outra coisa",
    },
    resumo: txt("Uma frase curta dizendo o que é o documento"),
    contrato: {
      type: "object",
      additionalProperties: false,
      required: ["cliente", "contatoNome", "telefones", "enderecoObra", "enderecoCliente", "cidade", "dataContrato", "dataLimiteEntrega", "valorTotal", "linha", "cor", "vidro", "obs"],
      properties: {
        cliente: txt("Nome ou razão social do contratante"),
        contatoNome: txt("Pessoa de contato na obra, se o contrato indicar"),
        telefones: txt("Telefones do contratante, separados por \" / \""),
        enderecoObra: txt("Endereço onde o serviço será executado (sem a cidade)"),
        enderecoCliente: txt("Endereço do contratante (sem a cidade), se diferente do da obra"),
        cidade: txt("Cidade da obra"),
        dataContrato: txt(DATA + " — data da assinatura"),
        dataLimiteEntrega: txt(DATA + " — prazo final de entrega/instalação. Só preencha se o contrato der uma data; prazo em dias vai em obs"),
        valorTotal: num("Valor total do contrato em reais, 0 se não houver"),
        linha: txt("Linha de perfil de alumínio (ex.: Suprema, Gold)"),
        cor: txt("Cor/acabamento do alumínio"),
        vidro: txt("Especificação do vidro"),
        obs: txt("Condições de pagamento, prazo em dias e outras cláusulas úteis para o escritório, em poucas linhas"),
      },
    },
    pagamento: {
      type: "object",
      additionalProperties: false,
      required: ["valor", "data", "pagador", "forma", "identificador"],
      properties: {
        valor: num("Valor pago em reais"),
        data: txt(DATA + " — data do pagamento"),
        pagador: txt("Quem pagou"),
        forma: txt("PIX, TED, boleto, depósito, dinheiro, cartão…"),
        identificador: txt("ID da transação, autenticação ou nº do recibo"),
      },
    },
    compra: {
      type: "object",
      additionalProperties: false,
      required: ["fornecedor", "numeroNF", "data", "valor", "categoria", "especificacao", "itemCompraId"],
      properties: {
        fornecedor: txt("Nome fantasia ou razão social do fornecedor, curto"),
        numeroNF: txt("Número da nota fiscal (só dígitos), \"\" se for orçamento"),
        data: txt(DATA + " — emissão da NF ou data do orçamento"),
        valor: num("Valor total da NF ou do orçamento em reais"),
        categoria: {
          type: "string",
          enum: ["perfil", "pintura", "acessorio", "vidro", ""],
          description: "perfil = perfis de alumínio; pintura = pintura/anodização; acessorio = fechaduras, roldanas, escovas, parafusos, borrachas; vidro = vidros. \"\" se não der para saber",
        },
        especificacao: txt("O que foi comprado/orçado, resumido numa linha técnica (ex.: vidro temperado 8 mm incolor · 12 peças)"),
        itemCompraId: txt("Id do item de compra da obra (lista do contexto) que este documento atende, ou \"\" se nenhum casar com segurança"),
      },
    },
    avisos: {
      type: "array",
      items: { type: "string" },
      description: "Dúvidas que o usuário precisa conferir: campo ilegível, valor que não bate, documento de outra obra/cliente etc.",
    },
  },
};

const SYSTEM_PROMPT = `Você lê documentos anexados a uma obra da Centauro Esquadrias (esquadrias de alumínio e vidro, Paraná) e extrai os dados para o escritório conferir antes de gravar.

A Centauro é a CONTRATADA nos contratos, a RECEBEDORA nos comprovantes de pagamento e a COMPRADORA nas notas fiscais e orçamentos de fornecedor. Não confunda os dados da Centauro com os do cliente ou do fornecedor.

- Identifique o tipo e preencha só o bloco correspondente; os outros blocos voltam com "" e 0.
- Valores em reais como número: "7.427,92" = 7427.92.
- Datas sempre AAAA-MM-DD.
- Nunca invente: campo que não está no documento volta vazio. Se algo estiver ilegível, ambíguo ou parecer ser de outro cliente/obra (compare com o contexto), escreva em avisos.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Não autenticado" }, 401);

    const { anexoId, contexto } = await req.json();
    if (!anexoId) return json({ error: "anexoId obrigatório" }, 400);

    const { data: anexo, error: anexoErr } = await supabase
      .from("obra_anexos").select("id, obra_id, nome, path, mime, tamanho").eq("id", anexoId).maybeSingle();
    if (anexoErr) return json({ error: anexoErr.message }, 500);
    if (!anexo) return json({ error: "Anexo não encontrado" }, 404);

    const mime = (anexo.mime || "").toLowerCase();
    const ehPdf = mime === "application/pdf";
    if (!ehPdf && !IMAGENS.includes(mime)) {
      return json({ error: "A IA lê PDF e imagem (JPG, PNG, WEBP). Este arquivo é " + (mime || "de tipo desconhecido") }, 400);
    }
    if (Number(anexo.tamanho) > LIMITE_BYTES) {
      return json({ error: "Arquivo acima de 20 MB — grande demais para a leitura com IA" }, 400);
    }

    const { data: blob, error: dlErr } = await supabase.storage.from("obras").download(anexo.path);
    if (dlErr || !blob) return json({ error: "Não deu para baixar o arquivo: " + (dlErr?.message || "vazio") }, 500);
    const data = encodeBase64(new Uint8Array(await blob.arrayBuffer()));

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY não configurada" }, 500);
    const client = new Anthropic({ apiKey });

    const arquivo = ehPdf
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/jpeg", data } };

    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          arquivo,
          { type: "text", text: `Arquivo: ${anexo.nome}\n\nContexto da obra (para casar item de compra e conferir cliente):\n${JSON.stringify(contexto || {})}` },
        ],
      }],
    });

    if (response.stop_reason === "refusal") return json({ error: "A IA recusou ler este documento" }, 502);
    if (response.stop_reason === "max_tokens") return json({ error: "Resposta da IA cortada (max_tokens)" }, 502);

    const bloco = response.content.find((b) => b.type === "text");
    if (!bloco || bloco.type !== "text") return json({ error: "IA não retornou dados" }, 502);
    return json({ ...JSON.parse(bloco.text), anexoId: anexo.id }, 200);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return json({ error: `Anthropic API ${err.status}: ${err.message}`.slice(0, 400) }, 502);
    }
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
