// ─── MOTOR DE AGENDAMENTO (estilo MS Project) ───────────────────────────────
// Calcula Início/Término das tarefas a partir de duração + predecessoras (Fim→Início)
// sobre um calendário de trabalho (dias úteis, expediente, almoço).

export const MESES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
export const DOW1 = ["D", "S", "T", "Q", "Q", "S", "S"]; // Dom Seg Ter Qua Qui Sex Sab

export const CONFIG_PADRAO = {
  horasDia: 9,
  expediente: ["08:00", "18:00"],
  almoco: ["12:00", "13:00"],
  diasUteis: [1, 2, 3, 4, 5], // getDay(): 0=Dom..6=Sáb → seg a sex
  dataBase: "",               // "YYYY-MM-DD" ou "YYYY-MM-DDTHH:mm" (se vazio, usa hoje)
};

// Dias úteis são regra da empresa, não do cronograma: o valor gravado nos cronogramas antigos
// (que incluía sábado) é descartado — vale sempre o CONFIG_PADRAO.
export function normConfig(config) {
  return { ...CONFIG_PADRAO, ...(config || {}), diasUteis: CONFIG_PADRAO.diasUteis };
}

// ── datas ──
function hm(str) { const [h, m] = (str || "00:00").split(":").map(Number); return h * 60 + (m || 0); }
export function parseDT(s) {
  if (!s) return null;
  const [d, t] = s.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (t || "00:00").split(":").map(Number);
  return new Date(y, mo - 1, da, h || 0, mi || 0);
}
function atMinutes(date, minutes) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
}
export function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// "YYYY-MM-DDTHH:mm" no fuso local — formato aceito por parseDT e por <input type="datetime-local">
export function toLocalISO(date) {
  if (!date) return "";
  const p = n => String(n).padStart(2, "0");
  return `${dayKey(date)}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
export function fmtDataHora(date) {
  if (!date) return "—";
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${MESES_ABBR[date.getMonth()]} ${hh}:${mi}`;
}

// ── calendário de trabalho ──
function intervalosDia(config) {
  const eS = hm(config.expediente[0]), eE = hm(config.expediente[1]);
  const lS = hm(config.almoco?.[0] || ""), lE = hm(config.almoco?.[1] || "");
  if (config.almoco && lS > eS && lE < eE) return [[eS, lS], [lE, eE]];
  return [[eS, eE]];
}
export function ehDiaUtil(date, config) { return normConfig(config).diasUteis.includes(date.getDay()); }

function proximoInstanteUtil(d, config) {
  let cur = new Date(d);
  const ints = intervalosDia(config);
  for (let g = 0; g < 3660; g++) {
    if (ehDiaUtil(cur, config)) {
      const cm = cur.getHours() * 60 + cur.getMinutes();
      for (const [s, e] of ints) {
        if (cm < s) return atMinutes(cur, s);
        if (cm >= s && cm < e) return cur;
      }
    }
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0);
  }
  return cur;
}

function addMinutosUteis(start, minutos, config) {
  let cur = proximoInstanteUtil(start, config);
  let rem = Math.max(0, Math.round(minutos));
  const ints = intervalosDia(config);
  let guard = 0;
  while (rem > 0 && guard++ < 100000) {
    const cm = cur.getHours() * 60 + cur.getMinutes();
    let done = false;
    for (const [s, e] of ints) {
      if (cm >= s && cm < e) {
        const avail = e - cm;
        if (rem <= avail) { cur = atMinutes(cur, cm + rem); rem = 0; }
        else { rem -= avail; cur = proximoInstanteUtil(atMinutes(cur, e), config); }
        done = true; break;
      }
    }
    if (!done) cur = proximoInstanteUtil(cur, config);
  }
  return cur;
}

function minutosUteisEntre(a, b, config) {
  if (!a || !b || b <= a) return 0;
  const ints = intervalosDia(config);
  let total = 0;
  let cur = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  let guard = 0;
  while (cur <= end && guard++ < 4000) {
    if (ehDiaUtil(cur, config)) {
      for (const [s, e] of ints) {
        const iniInt = atMinutes(cur, s), fimInt = atMinutes(cur, e);
        const lo = a > iniInt ? a : iniInt;
        const hi = b < fimInt ? b : fimInt;
        if (hi > lo) total += (hi - lo) / 60000;
      }
    }
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return total;
}

export function duracaoParaHoras(t, config) {
  const v = Number(t.durValor) || 0;
  return t.durUnid === "hrs" ? v : v * config.horasDia;
}

// ── agendamento ──
export function ehResumo(tasks, i) {
  return i < tasks.length - 1 && tasks[i + 1].nivel > tasks[i].nivel;
}
function filhosIdx(tasks, i) {
  const r = [];
  for (let j = i + 1; j < tasks.length && tasks[j].nivel > tasks[i].nivel; j++) r.push(j);
  return r;
}

// Todos os descendentes (qualquer nível abaixo, não só filhos diretos) da task no índice i.
export function descendentesDe(tasks, i) {
  const r = [];
  for (let j = i + 1; j < tasks.length && tasks[j].nivel > tasks[i].nivel; j++) r.push(j);
  return r;
}

// Índices (no array completo) das tasks visíveis, considerando colapsamento de resumos ancestrais.
export function indicesVisiveis(tasks) {
  const idxs = [];
  const stack = []; // níveis dos ancestrais colapsados ainda "ativos"
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    while (stack.length && stack[stack.length - 1] >= t.nivel) stack.pop();
    if (stack.length === 0) idxs.push(i);
    if (t.colapsada && ehResumo(tasks, i)) stack.push(t.nivel);
  }
  return idxs;
}

// Renumera IDs para 1..N (na ordem do array) e remapeia/limpa predecessoras órfãs.
export function renumerarIds(tasks) {
  const mapa = {};
  tasks.forEach((t, i) => { mapa[t.id] = i + 1; });
  return tasks.map((t, i) => ({
    ...t,
    id: i + 1,
    predecessoras: (t.predecessoras || [])
      .filter(pid => mapa[pid] !== undefined)
      .map(pid => mapa[pid]),
  }));
}

// Média ponderada pelas horas de duração — a regra do rollup de % dos resumos.
export function percentPonderado(folhas, config) {
  const cfg = normConfig(config);
  const totH = folhas.reduce((a, k) => a + duracaoParaHoras(k, cfg), 0);
  if (totH <= 0) return 0;
  const v = Math.round(folhas.reduce((a, k) => a + duracaoParaHoras(k, cfg) * (Number(k.percent) || 0), 0) / totH);
  return Math.max(0, Math.min(100, v));
}

// Distribui um percentual-alvo entre as folhas descendentes de `i`, consumindo o peso
// (horas de duração) na ordem da lista: as primeiras completam antes de a próxima começar.
// Devolve { [índice da task no array]: novoPercent }.
export function distribuirPercent(tasks, i, alvo, config) {
  const cfg = normConfig(config);
  const alvoC = Math.max(0, Math.min(100, Math.round(Number(alvo) || 0)));
  const idxFolhas = descendentesDe(tasks, i).filter(j => !ehResumo(tasks, j));
  const mapa = {};
  if (!idxFolhas.length) return mapa;

  const pesos = idxFolhas.map(j => duracaoParaHoras(tasks[j], cfg));
  const total = pesos.reduce((a, b) => a + b, 0);
  if (total <= 0) { idxFolhas.forEach(j => { mapa[j] = alvoC; }); return mapa; }

  let restante = total * (alvoC / 100);
  let corte = -1; // posição (em idxFolhas) da folha parcialmente preenchida
  idxFolhas.forEach((j, k) => {
    const p = pesos[k];
    if (p <= 0) { mapa[j] = restante > 0 ? 100 : 0; return; } // marco acompanha a frente de trabalho
    if (restante >= p) { mapa[j] = 100; restante -= p; }
    else if (restante > 0) { mapa[j] = Math.round(restante / p * 100); corte = k; restante = 0; }
    else mapa[j] = 0;
  });

  // Fechamento exato: o arredondamento por folha pode deixar o grupo em 49% com alvo 50%.
  // A folha de corte é a única com valor fracionário — é nela que a diferença é absorvida.
  if (corte >= 0) {
    for (let g = 0; g < 3; g++) {
      const atual = percentPonderado(idxFolhas.map(j => ({ ...tasks[j], percent: mapa[j] })), cfg);
      if (atual === alvoC) break;
      const jCorte = idxFolhas[corte];
      const novo = Math.max(0, Math.min(100, Math.round(mapa[jCorte] + (alvoC - atual) * total / pesos[corte])));
      if (novo === mapa[jCorte]) break;
      mapa[jCorte] = novo;
    }
  }
  return mapa;
}

// Retorna { [taskId]: { inicio, termino, percent, durDias, isSummary } }
export function agendar(tasks, config) {
  const cfg = normConfig(config);
  const raw = cfg.dataBase
    ? (cfg.dataBase.includes("T") ? cfg.dataBase : cfg.dataBase + "T" + cfg.expediente[0])
    : dayKey(new Date()) + "T" + cfg.expediente[0];
  const base = proximoInstanteUtil(parseDT(raw), cfg);
  const summary = tasks.map((_, i) => ehResumo(tasks, i));
  const sched = {};

  const passes = tasks.length + 5;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < tasks.length; i++) {
      if (summary[i]) continue;
      const t = tasks[i];
      let inicio;
      if (t.inicioManual) inicio = parseDT(t.inicioManual);
      else {
        let latest = null;
        for (const pid of (t.predecessoras || [])) {
          const s = sched[pid];
          if (s && (!latest || s.termino > latest)) latest = s.termino;
        }
        inicio = latest ? new Date(latest) : new Date(base);
      }
      inicio = proximoInstanteUtil(inicio, cfg);
      const horas = duracaoParaHoras(t, cfg);
      const termino = horas > 0 ? addMinutosUteis(inicio, horas * 60, cfg) : inicio;
      sched[t.id] = { inicio, termino };
    }
    // resumos (de baixo p/ cima, para resumos aninhados)
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (!summary[i]) continue;
      const kids = filhosIdx(tasks, i).map(j => tasks[j].id).map(id => sched[id]).filter(Boolean);
      if (!kids.length) { sched[tasks[i].id] = { inicio: new Date(base), termino: new Date(base) }; continue; }
      let mn = null, mx = null;
      for (const s of kids) { if (!mn || s.inicio < mn) mn = s.inicio; if (!mx || s.termino > mx) mx = s.termino; }
      sched[tasks[i].id] = { inicio: mn, termino: mx };
    }
  }

  const out = {};
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const s = sched[t.id] || { inicio: base, termino: base };
    let percent;
    if (summary[i]) {
      const leaves = [];
      for (let j = i + 1; j < tasks.length && tasks[j].nivel > tasks[i].nivel; j++) if (!summary[j]) leaves.push(tasks[j]);
      percent = percentPonderado(leaves, cfg);
    } else percent = Math.max(0, Math.min(100, Math.round(Number(t.percent) || 0)));
    const durDias = Math.round(minutosUteisEntre(s.inicio, s.termino, cfg) / (cfg.horasDia * 60) * 100) / 100;
    out[t.id] = { inicio: s.inicio, termino: s.termino, percent, durDias, isSummary: summary[i] };
  }
  return out;
}

// ── macro: obra × obra ──
// Cada cronograma é uma barra. `predecessorasMacro` (ids de cronogramas) empurram o início do
// sucessor para o término do predecessor (Fim→Início), como as predecessoras do micro.
// Devolve { mapa: { [cronoId]: {...} }, ciclo: [ids que participam de dependência circular] }.
export function agendarMacro(cronogramas) {
  const lista = cronogramas || [];
  const porId = {};
  lista.forEach(c => { porId[c.id] = c; });

  // arestas válidas (descarta auto-referência e cronogramas já excluídos)
  const preds = {};
  lista.forEach(c => { preds[c.id] = (c.predecessorasMacro || []).filter(p => p !== c.id && porId[p]); });

  // ordem topológica (Kahn) — assim `agendar` roda uma única vez por cronograma
  const grau = {}, sucs = {};
  lista.forEach(c => { grau[c.id] = preds[c.id].length; sucs[c.id] = []; });
  lista.forEach(c => preds[c.id].forEach(p => sucs[p].push(c.id)));
  const fila = lista.filter(c => grau[c.id] === 0).map(c => c.id);
  const ordem = [];
  while (fila.length) {
    const id = fila.shift();
    ordem.push(id);
    for (const s of sucs[id]) if (--grau[s] === 0) fila.push(s);
  }
  // o que sobrou está num ciclo: entra no fim, com as arestas do ciclo desprezadas
  const resolvidos = new Set(ordem);
  const ciclo = lista.filter(c => !resolvidos.has(c.id)).map(c => c.id);
  ciclo.forEach(id => ordem.push(id));

  const mapa = {};
  for (const id of ordem) {
    const c = porId[id];
    const cfgBase = normConfig(c.config);
    let herdado = null, origemId = null;
    for (const p of preds[id]) {
      const m = mapa[p];
      if (m && m.termino && (!herdado || m.termino > herdado)) { herdado = m.termino; origemId = p; }
    }
    const dataBaseEfetiva = herdado ? toLocalISO(proximoInstanteUtil(herdado, cfgBase)) : (cfgBase.dataBase || "");
    const cfg = { ...cfgBase, dataBase: dataBaseEfetiva };
    const tasks = c.tasks || [];
    const sched = agendar(tasks, cfg);
    let inicio = null, termino = null;
    for (const t of tasks) {
      const s = sched[t.id]; if (!s) continue;
      if (!inicio || s.inicio < inicio) inicio = s.inicio;
      if (!termino || s.termino > termino) termino = s.termino;
    }
    const folhas = tasks.filter((_, i) => !ehResumo(tasks, i));
    mapa[id] = {
      inicio, termino,
      percent: percentPonderado(folhas, cfg),
      durDias: Math.round(minutosUteisEntre(inicio, termino, cfg) / (cfg.horasDia * 60) * 100) / 100,
      dataBaseEfetiva, origemId,
    };
  }
  return { mapa, ciclo };
}

// Texto da duração para exibir na grade (resumo = calculado em dias; folha = valor informado)
export function textoDuracao(t, sc) {
  if (sc && sc.isSummary) {
    const n = sc.durDias;
    return `${(Number.isInteger(n) ? n : n.toFixed(2)).toString().replace(".", ",")} dias`;
  }
  const v = Number(t.durValor) || 0;
  return `${v.toString().replace(".", ",")} ${t.durUnid === "hrs" ? "hrs" : "dias"}`;
}

// Duração em dias úteis, para as linhas do macro (que não têm `durValor` próprio).
export function textoDias(n) {
  const v = Number(n) || 0;
  return `${(Number.isInteger(v) ? v : v.toFixed(2)).toString().replace(".", ",")} dias`;
}
