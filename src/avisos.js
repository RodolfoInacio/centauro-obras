// ─────────────────────────────────────────────────────────────────────────────
// Avisos de uma obra: o que falta (documento, cadastro, orçar, comprar, medir, prazo…). Função
// pura, usada pela Central de avisos (todas as obras) e pelo chip no cabeçalho da obra.
// Nada aqui é gravado: é tudo deduzido dos dados, como o status de Compras e o % do grupo.
//
// nivel: "erro" (bloqueia ou já passou do prazo) · "atencao" (falta fazer) · "info" (bom ter).
// ─────────────────────────────────────────────────────────────────────────────
import { pendenciasCompras, comprasTotais } from "./ComprasObra";
import { contagemMedicao } from "./MedicaoItem";
import { obraComTrava, liberacaoEtapa } from "./regrasEtapas";

export const AREAS = [
  { k: "itens", rotulo: "Itens", secao: "itens" },
  { k: "docs", rotulo: "Documentos", secao: "anexos" },
  { k: "cadastro", rotulo: "Cadastro", secao: "cadastro" },
  { k: "prazos", rotulo: "Prazos", secao: null },
  { k: "orcar", rotulo: "Orçar", secao: "compras" },
  { k: "comprar", rotulo: "Comprar", secao: "compras" },
  { k: "medicao", rotulo: "Medição", secao: "itens" },
  { k: "producao", rotulo: "Produção", secao: "itens" },
  { k: "agenda", rotulo: "Agenda", secao: null },
];
export const PESO_NIVEL = { erro: 3, atencao: 2, info: 1 };

function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DOCS = [
  { cat: "contrato", ck: "ck_contrato", rotulo: "contrato" },
  { cat: "orcamento", ck: "ck_orcamento", rotulo: "orçamento" },
  { cat: "projeto", ck: "ck_projeto", rotulo: "projeto / fotos" },
];

// ctx: { anexos: Map<obraId, Set<categoria>> | null, agenda: [], cronogramas: [], hoje }
export function avisosDaObra(obra, ctx = {}) {
  const hoje = ctx.hoje || hojeLocal();
  const out = [];
  const add = (area, nivel, texto) => out.push({ area, nivel, texto });
  const itens = obra.itens || [];
  const cad = obra.cadastro || {};
  const ck = Object.fromEntries((obra.checklist || []).map(c => [c.id, c.feito]));

  // Itens
  if (!itens.length) add("itens", "erro", "Sem itens — importe o PDF do orçamento");

  // Documentos: anexo da categoria ou o item do checklist marcado (documento guardado fora).
  const cats = ctx.anexos ? (ctx.anexos.get(obra.id) || new Set()) : null;
  for (const d of DOCS) {
    const temAnexo = cats ? cats.has(d.cat) || (d.cat === "projeto" && cats.has("foto")) : false;
    if (!temAnexo && !ck[d.ck]) add("docs", d.cat === "projeto" ? "info" : "atencao", `Sem ${d.rotulo} anexado`);
  }

  // Cadastro
  if (!String(cad.telefones || "").trim()) add("cadastro", "atencao", "Sem telefone do cliente");
  if (!String(cad.enderecoObra || "").trim()) add("cadastro", "atencao", "Sem endereço da obra");
  if (!String(cad.contatoNome || "").trim()) add("cadastro", "info", "Sem responsável da obra");
  if (!String(obra.vendedor || "").trim()) add("cadastro", "info", "Sem vendedor");

  // Prazos
  if (!obra.dataInicio) add("prazos", "atencao", "Sem data de início");
  if (!obra.dataLimiteEntrega) add("prazos", "atencao", "Sem prazo de entrega");
  else if (obra.dataLimiteEntrega < hoje) add("prazos", "erro", `Prazo de entrega vencido (${obra.dataLimiteEntrega.split("-").reverse().join("/")})`);

  // Compras
  const pend = pendenciasCompras(obra, hoje);
  for (const p of pend) {
    if (p.nivel === "orcar" || p.nivel === "aprovar") add("orcar", p.nivel === "orcar" ? "atencao" : "info", p.texto);
    else add("comprar", p.nivel === "atrasada" ? "erro" : "atencao", p.texto);
  }
  const { aComprar, gasto } = comprasTotais(obra);
  const aReceber = Math.max(0, (Number(obra.valorTotal) || 0) - (Number(obra.valorRecebido) || 0));
  if (aComprar > aReceber) add("comprar", "erro", "🚩 A comprar maior que o saldo a receber");
  const conferido = obra.compras && obra.compras.conferido && obra.compras.conferido.em;
  if (!conferido && (gasto > 0 || pend.some(p => p.nivel === "comprar"))) add("comprar", "atencao", "Compra sem conferência dos itens");

  // Medição: obrigatória na obra nova (trava); na antiga, só informativa.
  if (itens.length) {
    let feitas = 0, total = 0;
    for (const it of itens) { const c = contagemMedicao(it); feitas += c.feitas; total += c.total; }
    if (feitas < total) add("medicao", obraComTrava(obra) ? "atencao" : "info", `${total - feitas} de ${total} unidade(s) sem medição`);
  }

  // Produção (só obra nova): item pronto para produzir, mas travado.
  if (obraComTrava(obra)) {
    const travados = itens.filter(it => it.etapas?.["Conf. Medidas"]?.feito && !it.etapas?.["Produção"]?.feito && !liberacaoEtapa(obra, it, "Produção").ok);
    if (travados.length) add("producao", "erro", `${travados.length} item(ns) medidos esperando Compras para produzir`);
  }

  // Agenda e cronograma
  if (ctx.agenda && !ctx.agenda.some(a => a.obraId === obra.id)) add("agenda", "info", "Nenhum serviço lançado no calendário");
  if (ctx.cronogramas && !ctx.cronogramas.some(c => c.obraId === obra.id)) add("agenda", "info", "Sem cronograma");

  return out;
}

// Pior nível por área: { itens: "erro", docs: "atencao", … } (área ausente = ok).
export function resumoPorArea(avisos) {
  const r = {};
  for (const a of avisos) if (!r[a.area] || PESO_NIVEL[a.nivel] > PESO_NIVEL[r[a.area]]) r[a.area] = a.nivel;
  return r;
}
