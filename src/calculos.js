// ─────────────────────────────────────────────────────────────────────────────
// Cálculos derivados da obra (progresso, financeiro, agrupamento por cliente). Funções puras,
// usadas pelo App e pelos Relatórios — saíram do App.jsx para os relatórios não importarem o
// App (ciclo). Nada aqui é gravado: muda o dado, muda o número.
// ─────────────────────────────────────────────────────────────────────────────
import { comprasTotais } from "./ComprasObra";
import { chaveGrupo } from "./agrupamento";

// Etapas do item, com pesos (% concluído)
export const ETAPAS = ["Conf. Medidas", "Produção", "Instalação", "Acabamentos"];
export const PESOS = { "Conf. Medidas": 10, "Produção": 30, "Instalação": 50, "Acabamentos": 10 };

// % concluído do item = soma dos pesos das etapas concluídas
export function itemPercentual(item) {
  const et = item.etapas || {};
  return ETAPAS.reduce((a, e) => a + (et[e] && et[e].feito ? PESOS[e] : 0), 0);
}

// Compras por categoria: modelo, totais e tela moram em ComprasObra.jsx.
// "A comprar" = orçamentos lançados que ainda não viraram compra (ver comprasTotais).
// Flag vermelha: o que ainda falta comprar é maior do que o que ainda vai entrar de caixa dessa obra.
export function precisaAlertaCompras(obra) {
  const { aComprar } = comprasTotais(obra);
  const aReceber = Math.max(0, (obra.valorTotal || 0) - (obra.valorRecebido || 0));
  return aComprar > aReceber;
}

export function finObra(o) {
  const itens = o.itens || [];
  const total = Number(o.valorTotal) || 0;
  const recebido = Number(o.valorRecebido) || 0;
  const pct = itens.length ? itens.reduce((a, i) => a + itemPercentual(i), 0) / itens.length : 0;
  return {
    total,
    recebido,
    aReceber: Math.max(0, total - recebido),
    aPagar: comprasTotais(o).aComprar,
    aEntregar: total * (1 - pct / 100),
  };
}
// Soma o financeiro de uma lista de obras (recalcula sempre — muda valor, muda o painel).
export function finTotais(obras) {
  return obras.reduce((acc, o) => {
    const f = finObra(o);
    acc.total += f.total; acc.recebido += f.recebido; acc.aReceber += f.aReceber;
    acc.aPagar += f.aPagar; acc.aEntregar += f.aEntregar;
    if (precisaAlertaCompras(o)) acc.emAlerta += 1;
    return acc;
  }, { total: 0, recebido: 0, aReceber: 0, aPagar: 0, aEntregar: 0, emAlerta: 0 });
}

// ─── AGRUPAMENTO DE OBRAS (um cliente, vários contratos) ─────────────────────
// Duas propostas do mesmo cliente são a mesma obra com dois contratos. O agrupamento é só de
// APRESENTAÇÃO: cada contrato continua sendo uma obra própria no banco, porque o `id` da obra é o
// número da proposta e agenda, cronograma, lembretes e diário todos guardam esse id. Fundir os
// registros quebraria esses vínculos e faria os ids de item (sequenciais por obra) colidirem.

// A chave em si mora em agrupamento.js, para o DiarioObra.jsx usar a mesma sem ciclo de
// importação (o App importa o diário). Aqui fica só a consolidação, que depende de
// finObra/itemPercentual.

// Mesmo fallback da carga inicial e da ordenação da lista: sem `ordem`, vai para o fim por número.
function ordemDeObra(o) { return Number.isFinite(o.ordem) ? o.ordem : 1e9 + (Number(o.numero) || 0); }

// Agrupa e já entrega os consolidados que a tela precisa.
export function agruparObras(obras) {
  const mapa = new Map();
  for (const o of obras) {
    const chave = chaveGrupo(o);
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(o);
  }
  return [...mapa.entries()].map(([chave, lista]) => {
    const contratos = [...lista].sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));
    // O financeiro soma contrato a contrato via finObra — nunca recalcula sobre valores já somados.
    // O clamp `Math.max(0, total - recebido)` de finObra é o que impede o adiantamento de um
    // contrato mascarar o que o outro ainda tem a receber.
    const fin = finTotais(contratos);
    const todosItens = contratos.flatMap(o => o.itens || []);
    return {
      chave,
      nome: contratos[0].cliente,
      contratos,
      ordem: Math.min(...contratos.map(ordemDeObra)),
      // A obra só acabou quando não sobra contrato aberto.
      concluido: contratos.every(o => o.status === "Concluído"),
      itens: todosItens.length,
      pecas: todosItens.reduce((a, i) => a + (i.qtd || 0), 0),
      // Média sobre os itens de todos os contratos juntos, não média das médias por contrato.
      pct: todosItens.length ? Math.round(todosItens.reduce((a, i) => a + itemPercentual(i), 0) / todosItens.length) : 0,
      fin,
      emAlerta: fin.emAlerta,
    };
  });
}

