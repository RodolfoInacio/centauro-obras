// ─── MOTOR DE AGENDAMENTO (estilo MS Project) ───────────────────────────────
// Calcula Início/Término das tarefas a partir de duração + predecessoras (Fim→Início)
// sobre um calendário de trabalho (dias úteis, expediente, almoço).

export const MESES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
export const DOW1 = ["D", "S", "T", "Q", "Q", "S", "S"]; // Dom Seg Ter Qua Qui Sex Sab

export const CONFIG_PADRAO = {
  horasDia: 9,
  expediente: ["08:00", "18:00"],
  almoco: ["12:00", "13:00"],
  diasUteis: [1, 2, 3, 4, 5, 6], // getDay(): 0=Dom..6=Sáb → seg a sáb
  dataBase: "",                  // "YYYY-MM-DD" (se vazio, usa hoje)
};

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
export function ehDiaUtil(date, config) { return config.diasUteis.includes(date.getDay()); }

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

// Retorna { [taskId]: { inicio, termino, percent, durDias, isSummary } }
export function agendar(tasks, config) {
  const cfg = { ...CONFIG_PADRAO, ...(config || {}) };
  const base = proximoInstanteUtil(
    cfg.dataBase ? parseDT(cfg.dataBase + "T" + cfg.expediente[0]) : new Date(new Date().setHours(hm(cfg.expediente[0]) / 60 | 0, 0, 0, 0)),
    cfg
  );
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
      const totH = leaves.reduce((a, k) => a + duracaoParaHoras(k, cfg), 0);
      percent = totH > 0 ? Math.round(leaves.reduce((a, k) => a + duracaoParaHoras(k, cfg) * (Number(k.percent) || 0), 0) / totH) : 0;
    } else percent = Number(t.percent) || 0;
    const durDias = Math.round(minutosUteisEntre(s.inicio, s.termino, cfg) / (cfg.horasDia * 60) * 100) / 100;
    out[t.id] = { inicio: s.inicio, termino: s.termino, percent, durDias, isSummary: summary[i] };
  }
  return out;
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
