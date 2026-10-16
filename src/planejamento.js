// ─────────────────────────────────────────────────────────────────────────────
// Planejamento: o cronograma é a fonte única do "quem faz o quê, quando". Daqui saem, sempre
// derivados e nunca gravados:
//   - as datas de cada item da obra (datasDoItem);
//   - os serviços planejados do Calendário (servicosPlanejados + agendaEfetiva);
//   - os choques de agenda e de prazo (conflitosAgenda, avisosPlanejamento);
//   - os diários que aguardam registro (diariosPendentes) e as atividades do dia (tarefasDoDia).
// Funções puras, fora do App.jsx para o Diário, os avisos e os relatórios importarem sem ciclo.
// ─────────────────────────────────────────────────────────────────────────────
import { ehResumo, ehDiaUtil, dayKey, normConfig, percentEsperadoEm, situacaoTarefa, terminoProjetado, diasUteisEntre } from "./cronograma";

const ts = c => Number(String(c.id).replace(/^cr_/, "")) || 0;

// Todos os cronogramas de uma obra, do mais antigo para o mais novo.
export function cronogramasDaObra(cronogramas, obraId) {
  return (cronogramas || []).filter(c => c.obraId && c.obraId === obraId)
    .sort((a, b) => ts(a) - ts(b) || String(a.id).localeCompare(String(b.id)));
}
// O cronograma da obra é o mais antigo vinculado a ela; os outros continuam existindo como extras.
export function cronogramaDaObra(cronogramas, obraId) {
  return cronogramasDaObra(cronogramas, obraId)[0] || null;
}

// Folhas de todos os cronogramas com as datas do macro (início herdado já aplicado).
// [{ cronoId, obraId, task, inicio, termino, config }]
export function tarefasAgendadas(cronogramas, macro) {
  const out = [];
  for (const c of cronogramas || []) {
    const m = macro?.mapa?.[c.id];
    if (!m || !m.sched) continue;
    const tasks = c.tasks || [];
    tasks.forEach((t, i) => {
      if (ehResumo(tasks, i)) return;
      const s = m.sched[t.id];
      if (!s || !s.inicio) return;
      out.push({ cronoId: c.id, obraId: c.obraId || null, task: t, inicio: s.inicio, termino: s.termino, config: m.config });
    });
  }
  return out;
}

// Dias ("YYYY-MM-DD") em que a tarefa ocupa expediente. O dia do término só conta se ela
// termina depois do começo do expediente (tarefa que acaba às 18h de sexta não invade a segunda).
export function diasDaTarefa(inicio, termino, config) {
  const cfg = normConfig(config);
  if (!inicio || !termino) return [];
  const [h, m] = cfg.expediente[0].split(":").map(Number);
  const dias = [];
  const ini = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate());
  const fimDia = new Date(termino.getFullYear(), termino.getMonth(), termino.getDate());
  const terminaNoComeco = termino.getHours() * 60 + termino.getMinutes() <= h * 60 + (m || 0);
  for (let d = new Date(ini), g = 0; d <= fimDia && g < 800; d.setDate(d.getDate() + 1), g++) {
    if (!ehDiaUtil(d, cfg)) continue;
    if (d.getTime() === fimDia.getTime() && d.getTime() !== ini.getTime() && terminaNoComeco) continue;
    dias.push(dayKey(d));
  }
  return dias;
}

// Período de cada item no cronograma da obra: { [itemId]: { inicio, termino, porEtapa: { [etapa]: {inicio, termino} } } }
export function datasDosItens(cronogramas, macro, obraId) {
  const out = {};
  const ids = new Set(cronogramasDaObra(cronogramas, obraId).map(c => c.id));
  for (const a of tarefasAgendadas(cronogramas, macro)) {
    if (!ids.has(a.cronoId) || a.task.itemId == null) continue;
    const k = Number(a.task.itemId);
    const r = out[k] || (out[k] = { inicio: null, termino: null, porEtapa: {} });
    if (!r.inicio || a.inicio < r.inicio) r.inicio = a.inicio;
    if (!r.termino || a.termino > r.termino) r.termino = a.termino;
    const et = a.task.etapa;
    if (et) {
      const e = r.porEtapa[et] || (r.porEtapa[et] = { inicio: null, termino: null });
      if (!e.inicio || a.inicio < e.inicio) e.inicio = a.inicio;
      if (!e.termino || a.termino > e.termino) e.termino = a.termino;
    }
  }
  return out;
}

// ── Calendário planejado ──
// Endereço do serviço: o da obra no cadastro, senão "obra · cidade" (o mesmo do serviço manual).
function enderecoDaObra(obra) {
  if (!obra) return "";
  return obra.cadastro?.enderecoObra || [obra.obra, obra.cidade].filter(Boolean).join(" · ");
}
export const chaveOrigem = o => o ? `${o.cronoId}|${o.taskId}|${o.dia}` : "";
// Id fixo do serviço real que ajusta um planejado: editar duas vezes o mesmo dia regrava a mesma linha.
export const idAjuste = o => `ag_pl_${o.cronoId}_${o.taskId}_${o.dia}`;

// Um serviço por dia útil de cada tarefa com equipe. Mesmo formato de normAgendamento, mais
// `planejado: true` e `origem` (de onde veio). Obra concluída não gera nada.
export function servicosPlanejados(cronogramas, macro, obras) {
  const porObra = Object.fromEntries((obras || []).map(o => [o.id, o]));
  const out = [];
  for (const a of tarefasAgendadas(cronogramas, macro)) {
    const t = a.task;
    if (!t.equipeId || !a.obraId) continue;
    const obra = porObra[a.obraId];
    if (!obra || obra.status === "Concluído") continue;
    for (const dia of diasDaTarefa(a.inicio, a.termino, a.config)) {
      const origem = { cronoId: a.cronoId, taskId: t.id, dia };
      out.push({
        id: `pl_${a.cronoId}_${t.id}_${dia}`,
        dia, equipeId: t.equipeId, obraId: a.obraId, titulo: "",
        endereco: enderecoDaObra(obra), referencia: "", periodo: "Dia todo", horaObs: "",
        descricao: t.nome || "", itens: t.itemId != null ? [Number(t.itemId)] : [],
        ordem: 0, planejado: true, origem,
      });
    }
  }
  return out;
}

// Agenda que as telas mostram: a manual + a planejada, menos o planejado que já foi ajustado
// (existe uma linha real com a mesma origem) e menos o que foi cancelado no calendário.
export function agendaEfetiva(agenda, planejados) {
  const ajustados = new Set((agenda || []).filter(a => a.origem).map(a => chaveOrigem(a.origem)));
  return [
    ...(agenda || []).filter(a => !a.cancelado),
    ...(planejados || []).filter(p => !ajustados.has(chaveOrigem(p.origem))),
  ];
}

// ── Choque de agenda: a mesma equipe em duas obras no mesmo dia ──
const HORAS_PERIODO = { "Dia todo": 9, "Manhã": 4, "Tarde": 5, "1h": 1, "2h": 2, "3h": 3, "4h": 4 };
const chaveDestino = a => a.obraId ? `o:${a.obraId}` : `t:${a.titulo || a.id}`;

// [{ dia, equipeId, obraIds: [...], servicos: [ids], motivo }]
export function conflitosAgenda(agendaEf) {
  const grupos = {};
  for (const a of agendaEf || []) {
    if (!a.equipeId || !a.dia) continue;
    (grupos[`${a.dia}|${a.equipeId}`] ||= []).push(a);
  }
  const out = [];
  for (const lista of Object.values(grupos)) {
    const destinos = new Set(lista.map(chaveDestino));
    if (destinos.size < 2) continue;
    const horas = lista.reduce((s, a) => s + (HORAS_PERIODO[a.periodo] ?? 9), 0);
    const diaTodo = lista.some(a => a.periodo === "Dia todo");
    const repetido = ["Manhã", "Tarde"].some(p => lista.filter(a => a.periodo === p).length > 1);
    if (!diaTodo && !repetido && horas <= 9) continue;
    out.push({
      dia: lista[0].dia, equipeId: lista[0].equipeId,
      obraIds: [...new Set(lista.map(a => a.obraId).filter(Boolean))],
      servicos: lista.map(a => a.id),
      motivo: diaTodo ? "dia todo em mais de um lugar" : repetido ? "dois serviços no mesmo período" : `${horas}h no dia`,
    });
  }
  return out.sort((a, b) => a.dia.localeCompare(b.dia));
}

// Índice rápido para o calendário: { "dia|equipeId": conflito }
export function indiceConflitos(conflitos) {
  return Object.fromEntries((conflitos || []).map(c => [`${c.dia}|${c.equipeId}`, c]));
}

// ── Andamento (planejado × realizado) por obra ──
// { termino, projetado, atrasoDias, atrasadas: [{task, ...}], situacao: {[taskId]: situacao} }
export function andamentoObra(cronogramas, macro, obraId, agora = new Date()) {
  const ids = new Set(cronogramasDaObra(cronogramas, obraId).map(c => c.id));
  let termino = null, projetado = null, config = null;
  const atrasadas = [];
  const situacao = {};
  for (const a of tarefasAgendadas(cronogramas, macro)) {
    if (!ids.has(a.cronoId)) continue;
    config = config || a.config;
    const sit = situacaoTarefa(a.task.percent, a.inicio, a.termino, agora, a.config);
    situacao[`${a.cronoId}|${a.task.id}`] = sit;
    if (sit === "atrasada") atrasadas.push(a);
    const p = terminoProjetado(a.task, a, agora, a.config);
    if (!termino || a.termino > termino) termino = a.termino;
    if (p && (!projetado || p > projetado)) projetado = p;
  }
  const atrasoDias = termino && projetado && projetado > termino ? Math.ceil(diasUteisEntre(termino, projetado, config)) : 0;
  return { termino, projetado, atrasoDias, atrasadas, situacao };
}

// ── Diário ──
// Tarefas da obra que ocupam o dia, com quanto deviam estar prontas no fim dele.
// [{ cronoId, task, inicio, termino, percentPlanejado }]
export function tarefasDoDia(cronogramas, macro, obraId, dia) {
  const ids = new Set(cronogramasDaObra(cronogramas, obraId).map(c => c.id));
  const [y, m, d] = dia.split("-").map(Number);
  const out = [];
  for (const a of tarefasAgendadas(cronogramas, macro)) {
    if (!ids.has(a.cronoId)) continue;
    if (!diasDaTarefa(a.inicio, a.termino, a.config).includes(dia)) continue;
    const fimDoDia = new Date(y, m - 1, d, 23, 59);
    out.push({ ...a, percentPlanejado: percentEsperadoEm(a.inicio, a.termino, fimDoDia, a.config) });
  }
  return out;
}

// Dias com serviço (manual ou planejado) até hoje e sem registro, mais os registros ainda em
// rascunho. Nada é gravado: o diário só nasce quando alguém abre o dia.
export function diariosPendentes(obraId, agendaEf, diarios, hoje) {
  const daObra = (diarios || []).filter(d => d.obraId === obraId);
  const comRegistro = new Set(daObra.map(d => d.dia));
  const semRegistro = [...new Set((agendaEf || []).filter(a => a.obraId === obraId && a.dia <= hoje).map(a => a.dia))]
    .filter(d => !comRegistro.has(d)).sort().reverse();
  const rascunhos = daObra.filter(d => d.status === "rascunho").sort((a, b) => b.dia.localeCompare(a.dia));
  return { semRegistro, rascunhos };
}

// ── Avisos do planejamento de uma obra (área "cronograma" e "diario" da Central) ──
// ctx: { cronogramas, macro, agendaEf, conflitos, diarios, hoje }
export function avisosPlanejamento(obra, ctx) {
  const out = [];
  const add = (area, nivel, texto) => out.push({ area, nivel, texto });
  const { cronogramas, macro, conflitos, diarios, agendaEf, hoje } = ctx;

  if (cronogramas) {
    const cr = cronogramaDaObra(cronogramas, obra.id);
    if (!cr) add("cronograma", "atencao", "Sem cronograma");
    else if (macro) {
      const and = andamentoObra(cronogramas, macro, obra.id);
      const limite = obra.dataLimiteEntrega;
      if (limite && and.termino && dayKey(and.termino) > limite)
        add("cronograma", "erro", `Cronograma termina em ${dayKey(and.termino).split("-").reverse().join("/")}, depois do prazo de entrega`);
      else if (limite && and.projetado && dayKey(and.projetado) > limite)
        add("cronograma", "erro", `No ritmo atual termina em ${dayKey(and.projetado).split("-").reverse().join("/")}, depois do prazo de entrega`);
      if (and.atrasadas.length) add("cronograma", "atencao", `${and.atrasadas.length} tarefa(s) atrasada(s)${and.atrasoDias ? ` · ~${and.atrasoDias} dia(s) de atraso` : ""}`);
      // Ordem das etapas por item: instalar antes de produzir é data errada no cronograma.
      const datas = datasDosItens(cronogramas, macro, obra.id);
      const foraDeOrdem = Object.values(datas).filter(d => {
        const p = d.porEtapa["Produção"], i = d.porEtapa["Instalação"];
        return p && i && i.inicio < p.termino;
      }).length;
      if (foraDeOrdem) add("cronograma", "atencao", `${foraDeOrdem} item(ns) com instalação começando antes de a produção terminar`);
    }
  }
  if (conflitos) {
    const meus = conflitos.filter(c => c.obraIds.includes(obra.id) && (!hoje || c.dia >= hoje));
    if (meus.length) {
      const c = meus[0];
      add("cronograma", "erro", `Equipe em duas obras no mesmo dia (${c.dia.split("-").reverse().join("/")}${meus.length > 1 ? ` e mais ${meus.length - 1}` : ""})`);
    }
  }
  if (diarios && agendaEf && hoje) {
    const { semRegistro, rascunhos } = diariosPendentes(obra.id, agendaEf, diarios, hoje);
    if (semRegistro.length) add("diario", semRegistro.length > 3 ? "erro" : "atencao", `${semRegistro.length} dia(s) com serviço sem diário`);
    if (rascunhos.length) add("diario", "atencao", `${rascunhos.length} diário(s) aguardando aprovação`);
  }
  return out;
}
