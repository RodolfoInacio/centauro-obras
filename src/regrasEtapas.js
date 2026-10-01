// ─────────────────────────────────────────────────────────────────────────────
// Trava das etapas do item: uma etapa só libera quando a anterior está pronta, e a Produção
// ainda exige o material comprado com previsão de entrega.
//
//   Conf. Medidas → item medido (todas as unidades com largura, altura e contramarco)
//   Produção      → Conf. Medidas feita + Compras liberadas (comprasLiberamProducao)
//   Instalação    → Produção feita
//   Acabamentos   → Instalação feita
//
// Vale só para obra nova: `obra.regrasEtapas === 2` é gravado no cadastro manual e no import de
// PDF de proposta nova. Obra antiga não tem o campo e continua livre como sempre foi — muitas
// já estão em produção sem nada lançado em Compras, e travá-las agora seria mentir sobre elas.
// ─────────────────────────────────────────────────────────────────────────────
import { medicaoCompleta, contagemMedicao } from "./MedicaoItem";
import { comprasLiberamProducao } from "./ComprasObra";

export const VERSAO_REGRAS = 2;
const ORDEM = ["Conf. Medidas", "Produção", "Instalação", "Acabamentos"];

export const obraComTrava = (obra) => obra?.regrasEtapas === VERSAO_REGRAS;
const feita = (item, etapa) => !!(item?.etapas || {})[etapa]?.feito;

// Pode MARCAR esta etapa? { ok, motivo }
export function liberacaoEtapa(obra, item, etapa) {
  if (!obraComTrava(obra)) return { ok: true, motivo: "" };
  const i = ORDEM.indexOf(etapa);
  if (i < 0) return { ok: true, motivo: "" };
  if (i > 0 && !feita(item, ORDEM[i - 1])) return { ok: false, motivo: `Conclua "${ORDEM[i - 1]}" primeiro.` };
  if (etapa === "Conf. Medidas" && !medicaoCompleta(item)) {
    const { feitas, total } = contagemMedicao(item);
    return { ok: false, motivo: `Lance a medição do item (${feitas}/${total} unidades medidas).` };
  }
  if (etapa === "Produção") {
    const { ok, faltas } = comprasLiberamProducao(obra);
    if (!ok) {
      const extra = faltas.length > 1 ? ` (+${faltas.length - 1})` : "";
      return { ok: false, motivo: `Compras: ${faltas[0].texto}${extra}. Produção libera com o material comprado e a previsão de entrega preenchida.` };
    }
  }
  return { ok: true, motivo: "" };
}

// Pode DESMARCAR? Não com a etapa seguinte marcada — senão a sequência fica furada.
export function liberacaoDesmarcar(obra, item, etapa) {
  if (!obraComTrava(obra)) return { ok: true, motivo: "" };
  const i = ORDEM.indexOf(etapa);
  const seguinte = ORDEM[i + 1];
  if (seguinte && feita(item, seguinte)) return { ok: false, motivo: `Desmarque "${seguinte}" primeiro.` };
  return { ok: true, motivo: "" };
}

// Status manual de Fabricação: em obra nova, "Em andamento"/"Concluído" só com Compras liberadas.
export function liberacaoStatusFabricacao(obra, valor) {
  if (!obraComTrava(obra) || (valor !== "Em andamento" && valor !== "Concluído")) return { ok: true, motivo: "" };
  const { ok, faltas } = comprasLiberamProducao(obra);
  return ok ? { ok: true, motivo: "" } : { ok: false, motivo: `Fabricação travada — Compras: ${faltas[0].texto}.` };
}
