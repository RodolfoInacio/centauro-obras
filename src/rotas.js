import { useEffect, useState } from "react";

// Rotas do app: a `view` ({type, ...params}) vive no histórico do navegador (history.state) e
// num hash legível na URL. Assim o voltar do Chrome/celular e o "← Voltar" do app são o mesmo
// caminho, e o F5 reabre a mesma tela. Hash e não caminho porque o GitHub Pages não tem
// fallback de rota: /obra/2729 daria 404.
//
// O history.state guarda a view inteira (inclusive o que não cabe na URL, como o preset de
// entrada do estoque); o hash é só para F5 numa aba nova, favorito ou link colado.

const enc = encodeURIComponent;
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export const VIEW_INICIAL = { type: "dashboard" };

export function viewParaHash(v) {
  if (!v || !v.type) return "#/";
  switch (v.type) {
    case "dashboard": return "#/";
    case "obrasPasta": return `#/obras/${v.pasta === "concluidas" ? "concluidas" : "andamento"}`;
    case "gantt": return `#/obra/${enc(v.obraId)}${v.itemId != null ? `/item/${enc(v.itemId)}` : ""}`;
    case "print": return `#/obra/${enc(v.obraId)}/nota`;
    case "medicaoPrint": return `#/obra/${enc(v.obraId)}/medicao${v.modo === "branco" ? "/branco" : ""}`;
    case "calendar": return `#/calendario${v.mes ? `/${v.mes}${v.dia ? `/${v.dia}` : ""}` : ""}`;
    case "osPrint": return `#/os/${v.inicio}/${v.fim}`;
    case "equipes": return "#/equipes";
    case "cronogramas": return "#/cronogramas";
    case "cronograma": return `#/cronograma/${enc(v.id)}`;
    case "cronogramaPrint": return `#/cronograma/${enc(v.id)}/imprimir`;
    case "financeiro": return "#/financeiro";
    case "avisos": return "#/avisos";
    case "relatorios": return "#/relatorios";
    case "configuracoes": return "#/configuracoes";
    case "relatorio": return `#/relatorio/${enc(v.tipo)}${v.inicio && v.fim ? `/${v.inicio}/${v.fim}` : ""}`;
    case "diario": return `#/diario${v.obraId ? `/${enc(v.obraId)}${v.diarioId ? `/${enc(v.diarioId)}` : ""}` : ""}`;
    case "diarioPrint": return `#/diario/${enc(v.obraId)}/imprimir/${v.inicio}/${v.fim}`;
    case "estoque": {
      const t = v.tela;
      if (t?.tipo === "item" && t.codigo) return `#/estoque/item/${enc(t.codigo)}`;
      if (t?.tipo === "documentos") return "#/estoque/documentos";
      if (t?.tipo === "lancar") return "#/estoque/lancar";
      return "#/estoque";
    }
    case "estoqueDoc": return `#/estoque/doc/${enc(v.docId)}`;
    case "estoqueEtiquetas": return "#/estoque/etiquetas";
    case "orcamentos": return v.id ? `#/orcamentos/${enc(v.id)}` : "#/orcamentos";
    case "orcamentoPrint": return `#/orcamentos/${enc(v.id)}/imprimir`;
    default: return "#/";
  }
}

export function hashParaView(hash) {
  const p = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean).map(dec);
  const [a, b, c, d, e] = p;
  switch (a) {
    case undefined: return VIEW_INICIAL;
    case "obras": return { type: "obrasPasta", pasta: b === "concluidas" ? "concluidas" : "andamento" };
    case "obra":
      if (!b) return VIEW_INICIAL;
      if (c === "nota") return { type: "print", obraId: b };
      if (c === "medicao") return { type: "medicaoPrint", obraId: b, modo: d === "branco" ? "branco" : "preenchida" };
      return { type: "gantt", obraId: b, ...(c === "item" && d != null ? { itemId: numOuTexto(d) } : {}) };
    case "calendario": return { type: "calendar", ...(b ? { mes: b } : {}), ...(c ? { dia: c } : {}) };
    case "os": return b && c ? { type: "osPrint", inicio: b, fim: c } : { type: "calendar" };
    case "equipes": return { type: "equipes" };
    case "cronogramas": return { type: "cronogramas" };
    case "cronograma": return b ? (c === "imprimir" ? { type: "cronogramaPrint", id: b } : { type: "cronograma", id: b }) : { type: "cronogramas" };
    case "financeiro": return { type: "financeiro" };
    case "avisos": return { type: "avisos" };
    case "relatorios": return { type: "relatorios" };
    case "configuracoes": return { type: "configuracoes" };
    case "relatorio": return b ? { type: "relatorio", tipo: b, ...(c && d ? { inicio: c, fim: d } : {}) } : { type: "relatorios" };
    case "diario":
      if (b && c === "imprimir" && d && e) return { type: "diarioPrint", obraId: b, inicio: d, fim: e };
      return { type: "diario", ...(b ? { obraId: b } : {}), ...(c ? { diarioId: c } : {}) };
    case "estoque":
      if (b === "item" && c) return { type: "estoque", tela: { tipo: "item", codigo: c } };
      if (b === "documentos") return { type: "estoque", tela: { tipo: "documentos" } };
      if (b === "doc" && c) return { type: "estoqueDoc", docId: c };
      // Lançar e etiquetas dependem de dados que não cabem na URL: voltam para a lista.
      return { type: "estoque" };
    case "orcamentos":
      if (b && c === "imprimir") return { type: "orcamentoPrint", id: b };
      return { type: "orcamentos", ...(b ? { id: b } : {}) };
    default: return VIEW_INICIAL;
  }
}

// O id do item da obra é o nº da linha do orçamento (número); volta como número quando é.
function numOuTexto(s) { return /^\d+$/.test(s) ? Number(s) : s; }

// Para onde o "Voltar" vai quando não há tela anterior no histórico (entrou direto pelo link ou F5).
export function paiDe(v) {
  switch (v?.type) {
    case "gantt": return v.itemId != null ? { type: "gantt", obraId: v.obraId } : { type: "obrasPasta", pasta: "andamento" };
    case "print": case "medicaoPrint": return { type: "gantt", obraId: v.obraId };
    case "calendar": return v.dia ? { type: "calendar", mes: v.mes } : VIEW_INICIAL;
    case "osPrint": return { type: "calendar" };
    case "cronograma": return { type: "cronogramas" };
    case "cronogramaPrint": return { type: "cronograma", id: v.id };
    case "diario":
      if (v.diarioId) return { type: "diario", obraId: v.obraId };
      if (v.obraId) return { type: "diario" };
      return VIEW_INICIAL;
    case "diarioPrint": return { type: "diario", obraId: v.obraId };
    case "estoque": return v.tela && v.tela.tipo !== "lista" ? { type: "estoque" } : VIEW_INICIAL;
    case "estoqueDoc": case "estoqueEtiquetas": return { type: "estoque" };
    case "relatorio": return { type: "relatorios" };
    case "orcamentos": return v.id ? { type: "orcamentos" } : VIEW_INICIAL;
    case "orcamentoPrint": return { type: "orcamentos", id: v.id };
    default: return VIEW_INICIAL;
  }
}

// Filtro/busca de uma tela que deve sobreviver ao voltar, mas não ao fechar a aba.
export function lerSessao(chave, padrao) {
  try { const v = sessionStorage.getItem(chave); return v == null ? padrao : JSON.parse(v); } catch { return padrao; }
}
export function gravarSessao(chave, valor) {
  try { sessionStorage.setItem(chave, JSON.stringify(valor)); } catch { /* ignora */ }
}

// useState que lembra o valor na sessão da aba (busca e filtros de lista).
export function useEstadoSessao(chave, padrao) {
  const [v, setV] = useState(() => lerSessao(chave, padrao));
  useEffect(() => { gravarSessao(chave, v); }, [chave, v]);
  return [v, setV];
}
