import { useState, useEffect, useRef, useCallback } from "react";
import logoWhite from "./assets/logo-white.png";
import logoDark from "./assets/logo-dark.png";
import { supabase } from "./supabase";
import { fetchObras, upsertObra, fetchEquipes, saveEquipes as dbSaveEquipes, fetchOrdens, upsertOrdem, deleteOrdem as dbDeleteOrdem, fetchCronogramas, upsertCronograma, deleteCronograma as dbDeleteCronograma } from "./api";
import { agendar, CONFIG_PADRAO, fmtDataHora, textoDuracao, MESES_ABBR, DOW1, ehDiaUtil } from "./cronograma";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
// Brand color (was navy #1a1a1a) — now charcoal black
const BRAND = "#1a1a1a";
const BRAND_BORDER = "#333333";
const BRAND_LIGHT = "#9ca3af";

// Etapas do item, com pesos (% concluído) e cores
const ETAPAS = ["Conf. Medidas", "Produção", "Instalação", "Acabamentos"];
const PESOS = { "Conf. Medidas": 10, "Produção": 30, "Instalação": 50, "Acabamentos": 10 };
const ETAPA_COLORS = {
  "Conf. Medidas": "#3b82f6",
  "Produção":      "#8b5cf6",
  "Instalação":    "#f97316",
  "Acabamentos":   "#10b981",
};
const STATUS_COLORS = {
  "Em andamento": "#3b82f6",
  "Aguardando":   "#f59e0b",
  "Concluído":    "#10b981",
  "Comprado":     "#10b981",
  "Atrasado":     "#ef4444",
};
const STATUS_OPTIONS = ["Aguardando", "Em andamento", "Concluído", "Atrasado"];

function mkEtapas() {
  return Object.fromEntries(ETAPAS.map(e => [e, { feito: false, inicio: "", entrega: "" }]));
}

// % concluído do item = soma dos pesos das etapas concluídas
function itemPercentual(item) {
  const et = item.etapas || {};
  return ETAPAS.reduce((a, e) => a + (et[e] && et[e].feito ? PESOS[e] : 0), 0);
}

// Status automático da compra de material (por data)
function statusCompra(material) {
  const m = material || {};
  if (m.dataCompra) return "Comprado";
  if (!m.dataLimite) return "Aguardando";
  const hoje = new Date().toISOString().split("T")[0];
  return hoje <= m.dataLimite ? "Em andamento" : "Atrasado";
}
// Status automático da entrega de material (por previsão)
function statusEntrega(material) {
  const m = material || {};
  if (!m.previsaoEntrega) return "Aguardando";
  const hoje = new Date().toISOString().split("T")[0];
  return hoje <= m.previsaoEntrega ? "Em andamento" : "Atrasado";
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
// Migrate an item's etapas to the current shape { nome: {feito, inicio, entrega} }
function normEtapas(old) {
  const base = mkEtapas();
  if (old && typeof old === "object") {
    for (const nome of ETAPAS) {
      const v = old[nome];
      if (v && typeof v === "object") {
        base[nome] = { feito: !!v.feito, inicio: v.inicio || "", entrega: v.entrega || "" };
      } else if (typeof v === "boolean") {
        base[nome] = { feito: v, inicio: "", entrega: "" };
      }
    }
    // old "Concluído" → "Acabamentos"
    if (old["Concluído"] !== undefined && old["Acabamentos"] === undefined) {
      const v = old["Concluído"];
      base["Acabamentos"] = { feito: typeof v === "object" ? !!v.feito : !!v, inicio: "", entrega: "" };
    }
  }
  return base;
}

// Normalise an item to the current schema
function normItem(i) {
  return {
    ...i,
    inicio: i.inicio || "",                                   // own start date ("" = a definir)
    diasExec: Number.isFinite(i.diasExec) ? i.diasExec : 0,   // own duration (0 = a definir)
    desenho: i.desenho || "",                                 // technical drawing (data URI)
    etapas: normEtapas(i.etapas),
  };
}

// Ensure an obra has the current-schema fields
function normObra(o) {
  return {
    ...o,
    equipes: o.equipes || [],
    dataLimiteEntrega: o.dataLimiteEntrega || "",
    material: o.material || { dataLimite: "", dataCompra: "", previsaoEntrega: "" },
    itens: o.itens.map(normItem),
  };
}

// ─── EQUIPES (TEAMS) ─────────────────────────────────────────────────────────
const EQUIPE_CORES = ["#3b82f6", "#8b5cf6", "#f97316", "#10b981", "#ef4444", "#0ea5e9", "#eab308", "#ec4899", "#14b8a6", "#6366f1"];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function fmt(n) {
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function parsePDFNumber(s) {
  return parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0;
}
// Last day (inclusive) an item occupies, or null if not scheduled
function itemFim(item) {
  if (!item.inicio || !(Number(item.diasExec) > 0)) return null;
  return addDays(item.inicio, Number(item.diasExec) - 1);
}
// Is the obra active on a given day string (YYYY-MM-DD)? Based on each item's own schedule.
function obraAtivaNoDia(obra, dStr) {
  if (!obra.dataInicio) return false;
  const agendados = obra.itens.filter(i => i.inicio && Number(i.diasExec) > 0);
  if (agendados.length === 0) return dStr === obra.dataInicio; // start marked, items still to schedule
  return agendados.some(i => dStr >= i.inicio && dStr <= itemFim(i));
}

// ─── HELPERS DE ORDEM DE SERVIÇO ─────────────────────────────────────────────
const DOW_ABBR = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
function hoje() { return new Date().toISOString().split("T")[0]; }
// "2025-06-25" → "25/06 (Qui)"
function fmtDiaSemana(dStr) {
  if (!dStr) return "";
  const [y, m, d] = dStr.split("-");
  const dow = DOW_ABBR[new Date(+y, +m - 1, +d).getDay()];
  return `${d}/${m} (${dow})`;
}
// lista de dias (YYYY-MM-DD) entre início e fim, inclusivo
function diasNoPeriodo(inicio, fim) {
  if (!inicio || !fim) return [];
  const out = [];
  let cur = inicio;
  let guard = 0;
  while (cur <= fim && guard < 366) { out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}
// etapa "atual" da obra: primeira etapa ainda não concluída em todos os itens
function etapaAtualObra(obra) {
  for (const e of ETAPAS) {
    const todosFeitos = obra.itens.length > 0 && obra.itens.every(i => (i.etapas || {})[e] && i.etapas[e].feito);
    if (!todosFeitos) return e;
  }
  return "Finalização";
}
// obras atribuídas a uma equipe
function obrasDaEquipe(equipeId, obras) {
  return obras.filter(o => (o.equipes || []).includes(equipeId));
}

// ─── PROGRESS BAR ────────────────────────────────────────────────────────────
function ProgressBar({ value, height = 6 }) {
  const color = value >= 100 ? "#10b981" : value >= 60 ? "#3b82f6" : value >= 30 ? "#f59e0b" : "#e2e8f0";
  return (
    <div style={{ background: "#e2e8f0", borderRadius: 999, height, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(value, 100)}%`, background: color, height: "100%", borderRadius: 999, transition: "width 0.4s" }} />
    </div>
  );
}

// Small colored status badge (auto statuses for material / delivery)
function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || "#94a3b8";
  return (
    <span style={{ background: c + "22", color: c, border: `1px solid ${c}55`, borderRadius: 999, padding: "1px 8px", fontSize: 10, fontWeight: 800, textTransform: "none" }}>
      {status}
    </span>
  );
}

// ─── PDF PARSER (browser) ─────────────────────────────────────────────────────
async function parsePDFFile(file) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error("pdf.js não carregado");

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;

  let allLines = [];
  for (let p = 2; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(i => i.str).join("\n");
    for (const line of pageText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !isJunk(trimmed)) allLines.push(trimmed);
    }
  }

  return parseObraLines(allLines, file.name);
}

const JUNK_RE = /©\sWvetro|https?:\/\/|comercial@|@esquadrias|\(41\)3442|^PEDIDO$|^CENTAURO ESQUADRIAS$|^\d+ \/ \d+$|^✉/i;
function isJunk(line) { return JUNK_RE.test(line.trim()); }

const HEADER_TYPE_LINE = "Tipo: Qtd: L: H: Vlr Unt: Vlr Total:";

function parseObraLines(allLines, filename) {
  const fullText = allLines.join("\n");

  const getField = (pattern) => {
    const m = fullText.match(new RegExp(pattern.source || pattern, 'm'));
    return m ? m[1].trim().split(/\s{2,}/)[0].trim() : "";
  };
  const getFieldM = (src) => {
    const m = fullText.match(new RegExp(src, 'm'));
    return m ? m[1].trim().split(/\s{2,}/)[0].trim() : "";
  };

  const numMatch = fullText.match(/Proposta\s+(\d+)/);
  const num = numMatch ? numMatch[1] : filename.replace(/\D/g, "");

  const valorMatch = fullText.match(/Valor Final:\s*R\$\s*([\d.,]+)/);
  const valorTotal = valorMatch ? parsePDFNumber(valorMatch[1]) : 0;

  const items = [];
  const headerIndices = allLines.reduce((acc, l, i) => {
    if (l.includes(HEADER_TYPE_LINE)) acc.push(i);
    return acc;
  }, []);

  for (const hi of headerIndices) {
    const prev = (offset) => (hi - offset >= 0 ? allLines[hi - offset] : "");
    const locLine = prev(1); const vidLine = prev(2);
    const acsLine = prev(3); const prfLine = prev(4);

    const localizacao = locLine.startsWith("Localização:") ? locLine.replace("Localização:", "").trim() : "";
    const vidro       = vidLine.startsWith("Vidro:")       ? vidLine.replace("Vidro:", "").trim()       : "";
    const acessorios  = acsLine.startsWith("Acessórios:")  ? acsLine.replace("Acessórios:", "").trim()  : "";
    const perfil      = prfLine.startsWith("Perfil:")      ? prfLine.replace("Perfil:", "").trim()       : "";

    const descLines = [];
    let j = hi - 5;
    while (j >= 0) {
      const line = allLines[j];
      if (/^(Vendedor:|Cliente:|Proposta|Cidade:|Endereço|Perfil:|Acessórios:|Vidro:|Localização:)/.test(line) || line.includes(HEADER_TYPE_LINE)) break;
      if (/^\d+$/.test(line)) break; // pure item number
      if (/[\d.,]+\s+[\d.,]+\s*$/.test(line) && line.split(/\s+/).length >= 5) break; // data line
      if (line) descLines.unshift(line);
      j--;
    }

    if (hi + 2 >= allLines.length) continue;
    const itemNumLine = allLines[hi + 1].trim();
    const dataLine    = allLines[hi + 2].trim();
    if (!/^\d+$/.test(itemNumLine)) continue;

    const tokens = dataLine.split(/\s+/);
    if (tokens.length < 5) continue;

    let tipo, qtd, L, H, vlrUnt, vlrTotal;
    try {
      if (/^\d+$/.test(tokens[0])) {
        tipo = ""; qtd = +tokens[0]; L = +tokens[1]; H = +tokens[2];
        vlrUnt = parsePDFNumber(tokens[3]); vlrTotal = parsePDFNumber(tokens[4]);
      } else {
        tipo = tokens[0]; qtd = +tokens[1]; L = +tokens[2]; H = +tokens[3];
        vlrUnt = parsePDFNumber(tokens[4]); vlrTotal = parsePDFNumber(tokens[5] || tokens[4]);
      }
    } catch { continue; }

    items.push({
      id: +itemNumLine, tipo, descricao: descLines.join(" ").trim(),
      perfil, acessorios, vidro, localizacao, qtd, L, H,
      vlrUnt, vlrTotal, percentual: 0, obs: "", inicio: "", diasExec: 0, desenho: "", etapas: mkEtapas()
    });
  }

  return {
    id: num, numero: num,
    cliente:   getField(/Cliente:\s*(.+?)(?:\n|$)/),
    obra:      getFieldM('Obra:\\s*(.*?)\\s*(?:Dt\\.Proposta|$)'),
    cidade:    getField(/Cidade:\s*(.+?)(?:\n|Telefone:|$)/),
    vendedor:  getField(/Vendedor:\s*(.+?)(?:\n|Telefone:|$)/),
    data:      getField(/Dt\.Proposta:\s*(.+?)(?:\n|$)/),
    valorTotal, status: "Aguardando", dataInicio: "", dataLimiteEntrega: "",
    material: { dataLimite: "", dataCompra: "", previsaoEntrega: "" }, equipes: [], itens: items
  };
}

// ─── GANTT VIEW ───────────────────────────────────────────────────────────────
function GanttView({ obra, onChange, equipes }) {
  const [expandedId, setExpandedId] = useState(null);
  const [localObra, setLocalObra] = useState(obra);

  useEffect(() => { setLocalObra(obra); }, [obra]);

  const update = (updated) => {
    setLocalObra(updated);
    onChange(updated);
  };

  // Teams assigned to this obra
  const equipesObra = (localObra.equipes || []);
  const equipesDisponiveis = equipes.filter(e => !equipesObra.includes(e.id));
  function addEquipe(id) {
    if (!id || equipesObra.includes(id)) return;
    update({ ...localObra, equipes: [...equipesObra, id] });
  }
  function removeEquipe(id) {
    update({ ...localObra, equipes: equipesObra.filter(e => e !== id) });
  }

  const hasStart = !!localObra.dataInicio;
  // Timeline origin = obra start date (the "initial column"); fall back to today only for layout
  const startDate = localObra.dataInicio || new Date().toISOString().split("T")[0];

  // Each item is scheduled INDEPENDENTLY by its own start date + duration (no auto-cascade).
  // Items may overlap / run simultaneously. Unscheduled items have no bar.
  const schedule = localObra.itens.map(item => {
    const dur = Number(item.diasExec) || 0;
    if (item.inicio && dur > 0) {
      return { inicio: item.inicio, fim: addDays(item.inicio, dur - 1), agendado: true };
    }
    return { inicio: null, fim: null, agendado: false };
  });

  // Grid width: from obra start to the latest scheduled item end (min 30 days so there's always a grid)
  let maxEnd = 30;
  schedule.forEach((s, idx) => {
    if (s.agendado) {
      const off = Math.max(daysBetween(startDate, s.inicio), 0);
      maxEnd = Math.max(maxEnd, off + (Number(localObra.itens[idx].diasExec) || 0) + 5);
    }
  });
  const totalDays = maxEnd;

  const weeks = [];
  let wd = new Date(startDate);
  while (daysBetween(startDate, wd.toISOString().split("T")[0]) < totalDays) {
    weeks.push(wd.toISOString().split("T")[0]);
    wd.setDate(wd.getDate() + 7);
  }

  function updateItem(id, field, value) {
    const updated = { ...localObra, itens: localObra.itens.map(i => i.id === id ? { ...i, [field]: value } : i) };
    update(updated);
  }
  function toggleEtapa(id, etapa) {
    const updated = { ...localObra, itens: localObra.itens.map(i => i.id === id
      ? { ...i, etapas: { ...i.etapas, [etapa]: { ...i.etapas[etapa], feito: !i.etapas[etapa].feito } } }
      : i) };
    update(updated);
  }
  function updateEtapaData(id, etapa, field, value) {
    const updated = { ...localObra, itens: localObra.itens.map(i => i.id === id
      ? { ...i, etapas: { ...i.etapas, [etapa]: { ...i.etapas[etapa], [field]: value } } }
      : i) };
    update(updated);
  }
  function updateMaterial(field, value) {
    update({ ...localObra, material: { ...(localObra.material || {}), [field]: value } });
  }

  const totalPct = localObra.itens.length > 0
    ? Math.round(localObra.itens.reduce((a, i) => a + itemPercentual(i), 0) / localObra.itens.length)
    : 0;

  const stCompra = statusCompra(localObra.material);
  const stEntrega = statusEntrega(localObra.material);

  const LEFT_COL = 340;
  const DAY_W = 18;
  const TIMELINE_W = Math.max(700, totalDays * DAY_W);

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", color: "#1e293b" }}>
      {/* Summary bar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "12px 20px", display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Pedido #{localObra.numero}</div>
          <div style={{ fontWeight: 800, fontSize: 15, color: BRAND }}>{localObra.cliente}</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{localObra.obra || localObra.cidade}</div>
        </div>

        {/* Material da obra */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 14px" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4, display: "flex", gap: 8, alignItems: "center" }}>
              Compra de Material
              <StatusPill status={stCompra} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div>
                <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Data limite</label>
                <input type="date" value={(localObra.material || {}).dataLimite || ""}
                  onChange={e => updateMaterial("dataLimite", e.target.value)}
                  style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", fontSize: 12 }} />
              </div>
              <div>
                <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Data da compra</label>
                <input type="date" value={(localObra.material || {}).dataCompra || ""}
                  onChange={e => updateMaterial("dataCompra", e.target.value)}
                  style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", fontSize: 12 }} />
              </div>
            </div>
          </div>
          <div style={{ borderLeft: "1px solid #e2e8f0", paddingLeft: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4, display: "flex", gap: 8, alignItems: "center" }}>
              Entrega
              <StatusPill status={stEntrega} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "#94a3b8", display: "block" }}>Previsão de entrega</label>
              <input type="date" value={(localObra.material || {}).previsaoEntrega || ""}
                onChange={e => updateMaterial("previsaoEntrega", e.target.value)}
                style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", fontSize: 12 }} />
            </div>
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ minWidth: 160 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Progresso — {totalPct}%</div>
            <ProgressBar value={totalPct} height={8} />
          </div>
          <div style={{ fontWeight: 800, color: "#c9a227", fontSize: 15 }}>R$ {fmt(localObra.valorTotal)}</div>
          <div>
            <label style={{ fontSize: 11, color: "#94a3b8", display: "block", marginBottom: 2 }}>Status</label>
            <select
              value={localObra.status}
              onChange={e => update({ ...localObra, status: e.target.value })}
              style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: STATUS_COLORS[localObra.status] || "#64748b", fontWeight: 700 }}
            >
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#94a3b8", display: "block", marginBottom: 2 }}>Início</label>
            <input type="date" value={localObra.dataInicio || ""}
              onChange={e => update({ ...localObra, dataInicio: e.target.value })}
              style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: "#1e293b" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#94a3b8", display: "block", marginBottom: 2 }}>Limite Entrega</label>
            <input type="date" value={localObra.dataLimiteEntrega || ""}
              onChange={e => update({ ...localObra, dataLimiteEntrega: e.target.value })}
              style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: "#1e293b" }} />
          </div>
        </div>
      </div>

      {/* Team bar */}
      <div style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "10px 20px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Equipe Responsável:</span>
        {equipesObra.length === 0 && (
          <span style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic" }}>Nenhuma equipe definida</span>
        )}
        {equipesObra.map(id => {
          const eq = equipes.find(e => e.id === id);
          if (!eq) return null;
          return (
            <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: eq.cor + "1a", color: eq.cor, border: `1px solid ${eq.cor}55`, borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 13, fontWeight: 700 }}>
              {eq.nome}
              {eq.integrantes.length > 0 && (
                <span style={{ fontWeight: 500, fontSize: 12, opacity: 0.85 }}>— {eq.integrantes.join(" + ")}</span>
              )}
              <button onClick={() => removeEquipe(id)} title="Remover"
                style={{ background: eq.cor, color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, fontSize: 12, lineHeight: "16px", cursor: "pointer", marginLeft: 2 }}>×</button>
            </span>
          );
        })}
        {equipes.length === 0 ? (
          <span style={{ fontSize: 12, color: "#94a3b8" }}>(cadastre equipes na tela inicial em "Equipes")</span>
        ) : equipesDisponiveis.length > 0 && (
          <select value="" onChange={e => addEquipe(e.target.value)}
            style={{ border: "1px dashed #c9a227", color: "#c9a227", background: "#fffbeb", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            <option value="">+ Adicionar Equipe</option>
            {equipesDisponiveis.map(eq => <option key={eq.id} value={eq.id}>{eq.nome}</option>)}
          </select>
        )}
      </div>

      {/* Hint: define obra start date (timeline still shown below) */}
      {!hasStart && (
        <div style={{ background: "#fffbeb", borderBottom: "1px solid #fde68a", padding: "10px 20px", fontSize: 13, color: "#92400e" }}>
          📅 Defina a <b>data de início</b> da obra no campo <b>Início</b> (ao lado de Status) para posicionar o cronograma e exibir a obra no calendário.
        </div>
      )}

      {/* Gantt grid */}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: LEFT_COL + TIMELINE_W }}>
          {/* Header */}
          <div style={{ display: "flex", background: "#1a1a1a", color: "#fff", position: "sticky", top: 0, zIndex: 10 }}>
            <div style={{ width: LEFT_COL, minWidth: LEFT_COL, padding: "8px 14px", fontSize: 12, fontWeight: 700, borderRight: "1px solid #333333", display: "flex", gap: 8 }}>
              <span style={{ flex: 1 }}>Item / Descrição</span>
              <span style={{ width: 50, textAlign: "center" }}>Qtd</span>
              <span style={{ width: 60, textAlign: "center" }}>%</span>
            </div>
            <div style={{ flex: 1, position: "relative", minWidth: TIMELINE_W, height: 28 }}>
              {weeks.map((w, i) => (
                <div key={i} style={{ position: "absolute", left: daysBetween(startDate, w) * DAY_W, fontSize: 10, color: "#9ca3af", top: 4, whiteSpace: "nowrap" }}>
                  {fmtDate(w)}
                </div>
              ))}
              {Array.from({ length: totalDays }).map((_, d) => (
                <div key={d} style={{ position: "absolute", left: d * DAY_W, top: 0, bottom: 0, borderLeft: d % 7 === 0 ? "1px solid #333333" : "1px solid #1a1a1a33", height: 28 }} />
              ))}
            </div>
          </div>

          {/* Item rows */}
          {localObra.itens.map((item, idx) => {
            const sch = schedule[idx] || { inicio: null, fim: null, agendado: false };
            const barLeft = sch.agendado ? Math.max(daysBetween(startDate, sch.inicio), 0) * DAY_W : 0;
            const barW = Math.max((Number(item.diasExec) || 0) * DAY_W, 22);
            const pct = itemPercentual(item);
            const feitas = ETAPAS.filter(e => (item.etapas || {})[e] && item.etapas[e].feito);
            const etapaAtual = feitas.length ? feitas[feitas.length - 1] : ETAPAS[0];
            const barColor = ETAPA_COLORS[etapaAtual];
            const expanded = expandedId === item.id;

            return (
              <div key={item.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ display: "flex", background: expanded ? "#f0f7ff" : idx % 2 === 0 ? "#fff" : "#fafafa", minHeight: 36 }}>
                  <div onClick={() => setExpandedId(expanded ? null : item.id)}
                    style={{ width: LEFT_COL, minWidth: LEFT_COL, padding: "7px 14px", display: "flex", gap: 8, alignItems: "center", cursor: "pointer", borderRight: "1px solid #e2e8f0" }}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <span style={{ color: "#94a3b8", marginRight: 6 }}>#{item.id}</span>
                        {item.tipo && <span style={{ color: "#c9a227", marginRight: 4 }}>{item.tipo}</span>}
                        {item.descricao}
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>
                        {item.L}×{item.H}mm · {item.qtd}un · {sch.agendado
                          ? `${fmtDate(sch.inicio)} → ${fmtDate(sch.fim)} (${item.diasExec}d)`
                          : <span style={{ color: "#f59e0b", fontWeight: 700 }}>sem agendamento</span>}
                      </div>
                    </div>
                    <div style={{ width: 50, textAlign: "center", fontWeight: 800, fontSize: 14 }}>{item.qtd}</div>
                    <div style={{ width: 60, textAlign: "center" }}>
                      <div style={{ fontWeight: 800, fontSize: 13, color: pct >= 100 ? "#10b981" : BRAND }}>{pct}%</div>
                      <ProgressBar value={pct} height={4} />
                    </div>
                  </div>

                  <div style={{ flex: 1, position: "relative", minWidth: TIMELINE_W }}>
                    {Array.from({ length: totalDays }).map((_, d) => (
                      <div key={d} style={{ position: "absolute", left: d * DAY_W, top: 0, bottom: 0, borderLeft: d % 7 === 0 ? "1px solid #e2e8f0" : "none" }} />
                    ))}
                    {sch.agendado && (
                      <div title={`${item.descricao}\n${fmtDate(sch.inicio)} → ${fmtDate(sch.fim)} (${item.diasExec} dias)`}
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        style={{ position: "absolute", left: barLeft, top: 6, width: barW, height: 22, borderRadius: 4, background: barColor, opacity: 0.85, display: "flex", alignItems: "center", paddingLeft: 6, overflow: "hidden", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }}>
                        <span style={{ fontSize: 10, color: "#fff", fontWeight: 700, whiteSpace: "nowrap" }}>
                          {item.tipo || (item.descricao || "").slice(0, 14)}
                        </span>
                        <div style={{ position: "absolute", left: 0, top: 0, width: `${pct}%`, height: "100%", background: "rgba(255,255,255,0.3)", borderRadius: 4 }} />
                      </div>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div style={{ background: "#f8fafc", borderTop: "1px solid #e2e8f0", padding: "16px 20px", display: "flex", gap: 20, flexWrap: "wrap" }}>
                    <div style={{ background: "#fff", borderRadius: 10, padding: 14, border: "1px solid #e2e8f0", width: 180 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 8 }}>Desenho</div>
                      {item.desenho
                        ? <img src={item.desenho} alt={`Desenho ${item.tipo || item.id}`} style={{ width: "100%", borderRadius: 6, border: "1px solid #e2e8f0", display: "block" }} />
                        : <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>sem desenho</div>}
                    </div>
                    <div style={{ background: "#fff", borderRadius: 10, padding: 14, border: "1px solid #e2e8f0", minWidth: 200, fontSize: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 8 }}>Especificações</div>
                      {[["Dimensões", `${item.L} × ${item.H} mm`], ["Qtd", item.qtd], ["Perfil", item.perfil], ["Acessórios", item.acessorios], ["Vidro", item.vidro || "—"], ["Localização", item.localizacao || "—"], ["Vlr Unit.", `R$ ${fmt(item.vlrUnt)}`], ["Vlr Total", `R$ ${fmt(item.vlrTotal)}`]].map(([l, v]) => (
                        <div key={l} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                          <span style={{ color: "#64748b", minWidth: 80 }}>{l}</span>
                          <span style={{ fontWeight: 600 }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    <div style={{ background: "#fff", borderRadius: 10, padding: 14, border: "1px solid #e2e8f0", minWidth: 300 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                        <span>Etapas (datas + conclusão)</span>
                        <span style={{ color: BRAND }}>{pct}%</span>
                      </div>
                      {ETAPAS.map(etapa => {
                        const e = (item.etapas || {})[etapa] || { feito: false, inicio: "", entrega: "" };
                        return (
                          <div key={etapa} onClick={ev => ev.stopPropagation()}
                            style={{ padding: "8px 10px", borderRadius: 7, background: e.feito ? ETAPA_COLORS[etapa] + "14" : "#f8fafc", border: `1px solid ${e.feito ? ETAPA_COLORS[etapa] + "55" : "#e2e8f0"}`, marginBottom: 6 }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, marginBottom: 6 }}>
                              <input type="checkbox" checked={e.feito} onChange={() => toggleEtapa(item.id, etapa)} style={{ accentColor: ETAPA_COLORS[etapa] }} />
                              <span style={{ fontWeight: 700, color: e.feito ? ETAPA_COLORS[etapa] : "#64748b" }}>{etapa}</span>
                              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>{PESOS[etapa]}%</span>
                            </label>
                            <div style={{ display: "flex", gap: 6 }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 2 }}>Início previsto</div>
                                <input type="date" value={e.inicio || ""}
                                  onChange={ev => updateEtapaData(item.id, etapa, "inicio", ev.target.value)}
                                  style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 6px", fontSize: 11, boxSizing: "border-box" }} />
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 2 }}>Data de entrega</div>
                                <input type="date" value={e.entrega || ""}
                                  onChange={ev => updateEtapaData(item.id, etapa, "entrega", ev.target.value)}
                                  style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 6px", fontSize: 11, boxSizing: "border-box" }} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ background: "#fff", borderRadius: 10, padding: 14, border: "1px solid #e2e8f0", minWidth: 240, display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#1a1a1a", textTransform: "uppercase", borderBottom: "1px solid #e2e8f0", paddingBottom: 6 }}>📅 Agendamento deste item</div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>Início do item</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input type="date" value={item.inicio || ""}
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateItem(item.id, "inicio", e.target.value)}
                            style={{ flex: 1, border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontSize: 13, boxSizing: "border-box" }} />
                          {localObra.dataInicio && (
                            <button onClick={e => { e.stopPropagation(); updateItem(item.id, "inicio", localObra.dataInicio); }}
                              title="Usar a data de início da obra"
                              style={{ background: "#eff6ff", color: "#1a1a1a", border: "1px solid #bfdbfe", borderRadius: 7, padding: "0 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                              = obra
                            </button>
                          )}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>Dias de execução</div>
                        <input type="number" min={0} max={365} value={item.diasExec || 0} placeholder="a definir"
                          onClick={e => e.stopPropagation()}
                          onChange={e => updateItem(item.id, "diasExec", Number(e.target.value))}
                          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontSize: 13, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>% Concluído (calculado pelas etapas)</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                          <span style={{ fontWeight: 800, fontSize: 18, color: pct >= 100 ? "#10b981" : BRAND }}>{pct}%</span>
                          <span style={{ fontSize: 11, color: "#94a3b8" }}>marque as etapas concluídas para somar</span>
                        </div>
                        <ProgressBar value={pct} height={6} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>Localização</div>
                        <input type="text" placeholder="Ex: Bloco A, Apto 101..." value={item.localizacao || ""}
                          onClick={e => e.stopPropagation()}
                          onChange={e => updateItem(item.id, "localizacao", e.target.value)}
                          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontSize: 12, boxSizing: "border-box" }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>Observações</div>
                        <textarea rows={2} value={item.obs || ""} onClick={e => e.stopPropagation()}
                          onChange={e => updateItem(item.id, "obs", e.target.value)}
                          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontSize: 12, resize: "vertical", boxSizing: "border-box" }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ display: "flex", background: "#1a1a1a", color: "#fff", padding: "10px 14px", fontSize: 12, gap: 20 }}>
            <span style={{ width: LEFT_COL - 28, fontWeight: 700 }}>{localObra.itens.length} itens · Progresso: {totalPct}%</span>
            <span style={{ fontWeight: 700, color: "#c9a227" }}>R$ {fmt(localObra.valorTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PRINT VIEW ───────────────────────────────────────────────────────────────
function PrintView({ obra, onBack }) {
  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", padding: 32, maxWidth: 960, margin: "0 auto", color: "#1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a" }}>CENTAURO ESQUADRIAS</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Nota de Serviço — Pedido #{obra.numero}</div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12, color: "#64748b" }}>
          <div>{obra.data}</div><div>{obra.vendedor}</div>
        </div>
      </div>
      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 12 }}>
        <b>Cliente:</b> {obra.cliente} &nbsp;|&nbsp; <b>Obra:</b> {obra.obra} &nbsp;|&nbsp; <b>Cidade:</b> {obra.cidade}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "#1a1a1a", color: "#fff" }}>
            {["#", "Tipo", "Descrição", "Qtd", "L(mm)", "H(mm)", "Localização", "Etapa", "%", "Obs"].map(h => (
              <th key={h} style={{ padding: "7px 8px", textAlign: "left", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {obra.itens.map((item, i) => {
            const feitas = ETAPAS.filter(e => (item.etapas || {})[e] && item.etapas[e].feito);
            const etapaAtual = feitas.length ? feitas[feitas.length - 1] : "—";
            const pct = itemPercentual(item);
            return (
              <tr key={item.id} style={{ background: i % 2 === 0 ? "#fff" : "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <td style={{ padding: "6px 8px" }}>{item.id}</td>
                <td style={{ padding: "6px 8px", fontWeight: 700 }}>{item.tipo || "—"}</td>
                <td style={{ padding: "6px 8px" }}>{item.descricao}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{item.qtd}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{item.L}</td>
                <td style={{ padding: "6px 8px", textAlign: "center" }}>{item.H}</td>
                <td style={{ padding: "6px 8px" }}>{item.localizacao || "—"}</td>
                <td style={{ padding: "6px 8px" }}><span style={{ color: etapaAtual === "—" ? "#94a3b8" : ETAPA_COLORS[etapaAtual], fontWeight: 700 }}>{etapaAtual}</span></td>
                <td style={{ padding: "6px 8px", textAlign: "center", fontWeight: 700 }}>{pct}%</td>
                <td style={{ padding: "6px 8px", color: "#64748b" }}>{item.obs || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 18px", fontWeight: 700, color: "#1a1a1a", fontSize: 14 }}>
          Valor Total: R$ {fmt(obra.valorTotal)}
        </div>
      </div>
      <div style={{ marginTop: 40, display: "flex", gap: 60 }}>
        <div style={{ flex: 1, borderTop: "2px solid #1a1a1a", paddingTop: 6, textAlign: "center", fontSize: 12, color: "#64748b" }}>Encarregado / Responsável</div>
        <div style={{ flex: 1, borderTop: "2px solid #1a1a1a", paddingTop: 6, textAlign: "center", fontSize: 12, color: "#64748b" }}>Centauro Esquadrias</div>
      </div>
      <div style={{ marginTop: 28, display: "flex", gap: 10 }}>
        <button onClick={onBack} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          Voltar
        </button>
        <button onClick={() => window.print()} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          Imprimir
        </button>
      </div>
    </div>
  );
}

// ─── EQUIPES VIEW ─────────────────────────────────────────────────────────────
function EquipesView({ equipes, onChange, obras }) {
  const [nome, setNome] = useState("");
  const [integrantes, setIntegrantes] = useState([]);
  const [novoInt, setNovoInt] = useState("");
  const [editingId, setEditingId] = useState(null);

  function addIntegrante() {
    const n = novoInt.trim();
    if (!n) return;
    setIntegrantes(prev => [...prev, n]);
    setNovoInt("");
  }
  function resetForm() {
    setNome(""); setIntegrantes([]); setNovoInt(""); setEditingId(null);
  }
  function salvar() {
    if (!nome.trim()) return;
    if (editingId) {
      onChange(equipes.map(e => e.id === editingId ? { ...e, nome: nome.trim(), integrantes } : e));
    } else {
      const cor = EQUIPE_CORES[equipes.length % EQUIPE_CORES.length];
      onChange([...equipes, { id: "eq_" + Date.now(), nome: nome.trim(), integrantes, cor }]);
    }
    resetForm();
  }
  function editar(eq) {
    setEditingId(eq.id); setNome(eq.nome); setIntegrantes([...eq.integrantes]); setNovoInt("");
  }
  function excluir(id) {
    if (!confirm("Excluir esta equipe? Ela será removida das obras onde está atribuída.")) return;
    onChange(equipes.filter(e => e.id !== id));
    if (editingId === id) resetForm();
  }
  // count obras using each team
  const usoCount = (id) => obras.filter(o => (o.equipes || []).includes(id)).length;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", marginBottom: 4 }}>Cadastro de Equipes</h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
        Cadastre as equipes com seus integrantes. Depois, dentro de cada obra, escolha qual(is) equipe(s) cuidará(ão) dela.
      </p>

      {/* Form */}
      <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 12 }}>
          {editingId ? "Editar Equipe" : "Nova Equipe"}
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Nome da equipe</label>
          <input type="text" placeholder="Ex: Equipe 01" value={nome} onChange={e => setNome(e.target.value)}
            style={{ width: "100%", maxWidth: 340, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, boxSizing: "border-box" }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Integrantes</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input type="text" placeholder="Nome do integrante" value={novoInt}
              onChange={e => setNovoInt(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addIntegrante(); } }}
              style={{ flex: 1, minWidth: 220, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, boxSizing: "border-box" }} />
            <button onClick={addIntegrante}
              style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Adicionar</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {integrantes.map((int, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#eff6ff", color: "#1a1a1a", borderRadius: 999, padding: "4px 6px 4px 12px", fontSize: 13, fontWeight: 600 }}>
                {int}
                <button onClick={() => setIntegrantes(prev => prev.filter((_, idx) => idx !== i))}
                  style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, fontSize: 12, lineHeight: "16px", cursor: "pointer" }}>×</button>
              </span>
            ))}
            {integrantes.length === 0 && <span style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>Nenhum integrante adicionado</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={salvar} disabled={!nome.trim()}
            style={{ background: nome.trim() ? "#10b981" : "#cbd5e1", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: nome.trim() ? "pointer" : "not-allowed" }}>
            {editingId ? "Salvar Alterações" : "Cadastrar Equipe"}
          </button>
          {editingId && (
            <button onClick={resetForm}
              style={{ background: "transparent", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          )}
        </div>
      </div>

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {equipes.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: "#94a3b8", fontSize: 14 }}>Nenhuma equipe cadastrada ainda</div>
        )}
        {equipes.map(eq => (
          <div key={eq.id} style={{ background: "#fff", borderRadius: 12, padding: "16px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", borderLeft: `5px solid ${eq.cor}`, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: eq.cor }}>{eq.nome}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
                {eq.integrantes.length > 0 ? eq.integrantes.join(" + ") : <span style={{ fontStyle: "italic", color: "#94a3b8" }}>sem integrantes</span>}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {usoCount(eq.id)} obra(s) atribuída(s)
              </div>
            </div>
            <button onClick={() => editar(eq)}
              style={{ background: "#eff6ff", color: "#1a1a1a", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Editar</button>
            <button onClick={() => excluir(eq.id)}
              style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Excluir</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CALENDAR VIEW ────────────────────────────────────────────────────────────
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function CalendarView({ obras, equipes, onSelectObra }) {
  const hoje = new Date();
  const [ano, setAno] = useState(hoje.getFullYear());
  const [mes, setMes] = useState(hoje.getMonth()); // 0-11

  // obras that have a start date defined (eligible to appear on the calendar)
  const agendadas = obras.filter(o => o.dataInicio);

  function prevMes() { if (mes === 0) { setMes(11); setAno(a => a - 1); } else setMes(m => m - 1); }
  function nextMes() { if (mes === 11) { setMes(0); setAno(a => a + 1); } else setMes(m => m + 1); }

  // Build calendar grid (start on Sunday)
  const primeiroDia = new Date(ano, mes, 1);
  const offset = primeiroDia.getDay();
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const celulas = [];
  for (let i = 0; i < offset; i++) celulas.push(null);
  for (let d = 1; d <= diasNoMes; d++) celulas.push(d);
  while (celulas.length % 7 !== 0) celulas.push(null);

  function corObra(o) {
    const eqId = (o.equipes || [])[0];
    const eq = eqId && equipes.find(e => e.id === eqId);
    return eq ? eq.cor : (STATUS_COLORS[o.status] || "#64748b");
  }
  // returns obras active on a given day-of-month
  function obrasNoDia(dia) {
    const dStr = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    return agendadas.filter(o => obraAtivaNoDia(o, dStr));
  }

  const ehHoje = (dia) => dia && ano === hoje.getFullYear() && mes === hoje.getMonth() && dia === hoje.getDate();

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", margin: 0 }}>Calendário de Obras</h2>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={prevMes} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: "pointer" }}>‹</button>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a1a", minWidth: 170, textAlign: "center" }}>{MESES[mes]} {ano}</div>
          <button onClick={nextMes} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: "pointer" }}>›</button>
          <button onClick={() => { setAno(hoje.getFullYear()); setMes(hoje.getMonth()); }}
            style={{ background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "0 14px", height: 34, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Hoje</button>
        </div>
      </div>

      {agendadas.length === 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "14px 18px", fontSize: 13, color: "#92400e", marginBottom: 16 }}>
          Nenhuma obra agendada ainda. Abra uma obra e defina a <b>data de início</b> para ela aparecer no calendário.
        </div>
      )}

      {/* Weekday header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginBottom: 6 }}>
        {DIAS_SEMANA.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>{d}</div>
        ))}
      </div>
      {/* Day cells */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
        {celulas.map((dia, i) => {
          const lista = dia ? obrasNoDia(dia) : [];
          return (
            <div key={i} style={{ minHeight: 110, background: dia ? "#fff" : "transparent", borderRadius: 8, border: dia ? "1px solid #e2e8f0" : "none", padding: dia ? 6 : 0, boxShadow: ehHoje(dia) ? "0 0 0 2px #c9a227" : "none" }}>
              {dia && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: ehHoje(dia) ? "#c9a227" : "#64748b", marginBottom: 4, textAlign: "right" }}>{dia}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {lista.slice(0, 4).map(o => (
                      <div key={o.id} onClick={() => onSelectObra(o.id)} title={`#${o.numero} — ${o.cliente}`}
                        style={{ background: corObra(o), color: "#fff", borderRadius: 4, padding: "2px 6px", fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        #{o.numero} {o.cliente}
                      </div>
                    ))}
                    {lista.length > 4 && <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 700 }}>+{lista.length - 4} mais</div>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ obras, onSelect, onStatusChange, onReorder, equipes }) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("Todos");
  const [sortBy, setSortBy] = useState("ordem"); // ordem | numero | nome | pct | itens | pecas
  const [dragArmed, setDragArmed] = useState(null); // id com alça pressionada (pode arrastar)
  const [dragId, setDragId] = useState(null);       // id sendo arrastado
  const [overId, setOverId] = useState(null);       // id sob o cursor

  const pctObra = (o) => o.itens.length ? Math.round(o.itens.reduce((a, i) => a + itemPercentual(i), 0) / o.itens.length) : 0;
  const pecasObra = (o) => o.itens.reduce((a, i) => a + (i.qtd || 0), 0);

  const filtered = obras.filter(o => {
    const q = search.toLowerCase();
    const matchText = !q || o.cliente.toLowerCase().includes(q) || o.numero.includes(q) || (o.obra || "").toLowerCase().includes(q) || (o.cidade || "").toLowerCase().includes(q);
    const matchStatus = filterStatus === "Todos" || o.status === filterStatus;
    return matchText && matchStatus;
  });

  // Ordenação escolhida (não muda a lista base; "ordem" = ordem manual/arrastar)
  const displayed = sortBy === "ordem" ? filtered : [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "numero": return (Number(a.numero) || 0) - (Number(b.numero) || 0);
      case "nome":   return a.cliente.localeCompare(b.cliente, "pt-BR");
      case "pct":    return pctObra(b) - pctObra(a);
      case "itens":  return b.itens.length - a.itens.length;
      case "pecas":  return pecasObra(b) - pecasObra(a);
      default: return 0;
    }
  });

  // Reordenar (arrastar) só faz sentido na lista completa e na ordem manual
  const canReorder = !search && filterStatus === "Todos" && sortBy === "ordem";

  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); setDragArmed(null); return; }
    const ids = obras.map(o => o.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onReorder(ids);
    setDragId(null); setOverId(null); setDragArmed(null);
  }

  const totalPecas = obras.reduce((a, o) => a + o.itens.reduce((b, i) => b + (i.qtd || 0), 0), 0);
  const progMedio  = obras.length > 0
    ? Math.round(obras.reduce((a, o) => a + (o.itens.length > 0 ? o.itens.reduce((b, i) => b + itemPercentual(i), 0) / o.itens.length : 0), 0) / obras.length)
    : 0;

  return (
    <div style={{ padding: "24px 28px" }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Total de Obras", value: obras.length, sub: `${obras.reduce((a,o)=>a+o.itens.length,0)} itens`, accent: "#1a1a1a" },
          { label: "Total de Peças", value: totalPecas, sub: "em todas as obras", accent: "#c9a227" },
          { label: "Progresso Médio", value: `${progMedio}%`, sub: "de todas as obras", accent: "#10b981" },
        ].map(({ label, value, sub, accent }) => (
          <div key={label} style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", borderLeft: `4px solid ${accent}` }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: accent }}>{value}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Search + filter bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Buscar por cliente, número ou obra..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 240, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, outline: "none" }}
        />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, background: "#fff", cursor: "pointer" }}>
          <option value="Todos">Todos os status</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} title="Ordenar por"
          style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, background: "#fff", cursor: "pointer" }}>
          <option value="ordem">↕ Ordem manual</option>
          <option value="numero"># Número</option>
          <option value="nome">Nome (A-Z)</option>
          <option value="pct">% Execução</option>
          <option value="itens">Itens</option>
          <option value="pecas">Peças</option>
        </select>
        <div style={{ fontSize: 13, color: "#94a3b8", display: "flex", alignItems: "center" }}>
          {displayed.length} de {obras.length} obras
        </div>
      </div>

      {/* Obra cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {displayed.map(os => {
          const pct = os.itens.length > 0
            ? Math.round(os.itens.reduce((a, i) => a + itemPercentual(i), 0) / os.itens.length)
            : 0;
          const statusColor = STATUS_COLORS[os.status] || "#94a3b8";
          const isDragging = dragId === os.id;
          const isOver = overId === os.id && dragId && dragId !== os.id;
          return (
            <div key={os.id}
              draggable={dragArmed === os.id}
              onDragStart={e => { setDragId(os.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={e => { if (canReorder && dragId) { e.preventDefault(); setOverId(os.id); } }}
              onDrop={e => { e.preventDefault(); handleDrop(os.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); setDragArmed(null); }}
              style={{ background: "#fff", borderRadius: 12, padding: "18px 22px", boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", borderTop: isOver ? "3px solid #1a1a1a" : "1px solid #e2e8f0", cursor: "pointer", transition: "box-shadow 0.15s", opacity: isDragging ? 0.4 : 1 }}
              onClick={() => onSelect(os.id)}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.07)"}
            >
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                {canReorder && (
                  <div
                    title="Arraste para reordenar"
                    onMouseDown={() => setDragArmed(os.id)}
                    onMouseUp={() => setDragArmed(null)}
                    onClick={e => e.stopPropagation()}
                    style={{ alignSelf: "center", color: "#94a3b8", fontSize: 20, lineHeight: 1, cursor: "grab", padding: "0 4px", userSelect: "none" }}
                  >☰</div>
                )}
                <div style={{ background: "#1a1a1a", color: "#fff", borderRadius: 8, padding: "6px 14px", fontWeight: 800, fontSize: 18, minWidth: 60, textAlign: "center" }}>
                  #{os.numero}
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#1e293b" }}>{os.cliente}</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{os.obra || "—"} · {os.cidade}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                    Vendedor: {os.vendedor} · Início: {os.dataInicio ? fmtDate(os.dataInicio) : "a definir"}
                  </div>
                  {(os.equipes || []).length > 0 && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {(os.equipes || []).map(id => {
                        const eq = equipes.find(e => e.id === id);
                        if (!eq) return null;
                        return (
                          <span key={id} style={{ background: eq.cor + "1a", color: eq.cor, border: `1px solid ${eq.cor}55`, borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>
                            👷 {eq.nome}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Itens</div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>{os.itens.length}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>Peças</div>
                    <div style={{ fontWeight: 800, fontSize: 18 }}>{os.itens.reduce((a, i) => a + (i.qtd || 0), 0)}</div>
                  </div>
                  <div style={{ minWidth: 120 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#94a3b8" }}>Progresso</span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{pct}%</span>
                    </div>
                    <ProgressBar value={pct} height={8} />
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <select
                      value={os.status}
                      onClick={e => e.stopPropagation()}
                      onChange={e => { e.stopPropagation(); onStatusChange(os.id, e.target.value); }}
                      style={{ background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}55`, borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {displayed.length === 0 && (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8", fontSize: 15 }}>
            Nenhuma obra encontrada
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ORDEM DE SERVIÇO ─────────────────────────────────────────────────────────
const HORARIOS = ["DIA TODO", "MANHÃ", "TARDE"];

function composicaoDe(equipe) {
  if (!equipe) return "";
  return equipe.integrantes && equipe.integrantes.length
    ? equipe.integrantes.join(" E ").toUpperCase()
    : (equipe.nome || "").toUpperCase();
}

// Monta as linhas sugeridas (uma por dia x obra agendada da equipe no período)
function preencherLinhas(equipe, obras, inicio, fim) {
  const teamObras = obrasDaEquipe(equipe.id, obras);
  const linhas = [];
  for (const dia of diasNoPeriodo(inicio, fim)) {
    for (const o of teamObras) {
      if (obraAtivaNoDia(o, dia)) {
        linhas.push({
          id: "l_" + Math.random().toString(36).slice(2, 9),
          data: dia,
          obraId: o.id,
          obraNome: o.cliente,
          endereco: (o.cidade || "").split("/")[0].trim(),
          horario: "DIA TODO",
          descricao: etapaAtualObra(o),
        });
      }
    }
  }
  return linhas;
}

function OrdemBuilder({ equipe, obras, ordens, ordemExistente, onSave, onCancel, onPrint }) {
  const isEdit = !!ordemExistente;
  const [inicio, setInicio] = useState(ordemExistente?.periodoInicio || hoje());
  const [fim, setFim] = useState(ordemExistente?.periodoFim || addDays(hoje(), 6));
  const [emissao, setEmissao] = useState(ordemExistente?.dataEmissao || hoje());
  const [composicao, setComposicao] = useState(ordemExistente?.composicao || composicaoDe(equipe));
  const [linhas, setLinhas] = useState(
    ordemExistente?.linhas || preencherLinhas(equipe, obras, hoje(), addDays(hoje(), 6))
  );

  const teamObras = obrasDaEquipe(equipe.id, obras);

  function repreencher() {
    setLinhas(preencherLinhas(equipe, obras, inicio, fim));
  }
  function addLinha() {
    setLinhas(prev => [...prev, { id: "l_" + Math.random().toString(36).slice(2, 9), data: inicio, obraId: "", obraNome: "", endereco: "", horario: "DIA TODO", descricao: "" }]);
  }
  function updLinha(id, campo, valor) {
    setLinhas(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (campo === "obraId") {
        const o = obras.find(x => x.id === valor);
        return { ...l, obraId: valor, obraNome: o ? o.cliente : l.obraNome, endereco: o ? (o.cidade || "").split("/")[0].trim() : l.endereco };
      }
      return { ...l, [campo]: valor };
    }));
  }
  function delLinha(id) { setLinhas(prev => prev.filter(l => l.id !== id)); }

  function montarOrdem() {
    const numero = isEdit ? ordemExistente.numero : (ordens.reduce((m, o) => Math.max(m, o.numero || 0), 0) + 1);
    const id = isEdit ? ordemExistente.id : ("os_" + Date.now());
    const linhasOrd = [...linhas].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    return { id, numero, equipeId: equipe.id, equipeNome: equipe.nome, composicao,
      periodoInicio: inicio, periodoFim: fim, dataEmissao: emissao, linhas: linhasOrd };
  }

  const inp = { border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 8px", fontSize: 13, boxSizing: "border-box" };

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 19, fontWeight: 800, color: BRAND, margin: 0 }}>
          {isEdit ? `O.S. Nº ${String(ordemExistente.numero).padStart(3, "0")}` : "Nova Ordem de Serviço"} — {equipe.nome}
        </h2>
        <button onClick={onCancel} style={{ marginLeft: "auto", background: "transparent", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>← Voltar</button>
      </div>

      {/* período */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div><div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>Período — início</div><input type="date" value={inicio} onChange={e => setInicio(e.target.value)} style={inp} /></div>
        <div><div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>Período — fim</div><input type="date" value={fim} onChange={e => setFim(e.target.value)} style={inp} /></div>
        <div><div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>Data de emissão</div><input type="date" value={emissao} onChange={e => setEmissao(e.target.value)} style={inp} /></div>
        <div style={{ flex: 1, minWidth: 200 }}><div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>Composição (integrantes)</div><input type="text" value={composicao} onChange={e => setComposicao(e.target.value)} style={{ ...inp, width: "100%" }} /></div>
        <button onClick={repreencher} title="Recarregar sugestões do cronograma para este período"
          style={{ background: "#eff6ff", color: BRAND, border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>↻ Sugerir do cronograma</button>
      </div>

      {/* tabela editável */}
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: BRAND, color: "#fff" }}>
              {["Dia", "Obra", "Endereço", "Horário", "Descrição", ""].map(h => (
                <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map(l => (
              <tr key={l.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: 6 }}><input type="date" value={l.data} onChange={e => updLinha(l.id, "data", e.target.value)} style={{ ...inp, width: 140 }} /></td>
                <td style={{ padding: 6 }}>
                  <select value={l.obraId} onChange={e => updLinha(l.id, "obraId", e.target.value)} style={{ ...inp, maxWidth: 200 }}>
                    <option value="">— escolher —</option>
                    {teamObras.length > 0 && <optgroup label="Obras da equipe">{teamObras.map(o => <option key={o.id} value={o.id}>#{o.numero} {o.cliente}</option>)}</optgroup>}
                    <optgroup label="Todas as obras">{obras.map(o => <option key={o.id} value={o.id}>#{o.numero} {o.cliente}</option>)}</optgroup>
                  </select>
                </td>
                <td style={{ padding: 6 }}><input type="text" value={l.endereco} onChange={e => updLinha(l.id, "endereco", e.target.value)} style={{ ...inp, width: 120 }} /></td>
                <td style={{ padding: 6 }}>
                  <select value={l.horario} onChange={e => updLinha(l.id, "horario", e.target.value)} style={inp}>
                    {HORARIOS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </td>
                <td style={{ padding: 6 }}><input type="text" value={l.descricao} onChange={e => updLinha(l.id, "descricao", e.target.value)} style={{ ...inp, width: "100%" }} placeholder="O que fazer..." /></td>
                <td style={{ padding: 6, textAlign: "center" }}><button onClick={() => delLinha(l.id)} title="Remover" style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 6, width: 24, height: 24, cursor: "pointer", fontWeight: 700 }}>×</button></td>
              </tr>
            ))}
            {linhas.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>Nenhuma linha. Use "Sugerir do cronograma" ou "+ Adicionar linha".</td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={addLinha} style={{ background: "transparent", color: BRAND, border: "1px dashed #94a3b8", borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Adicionar linha</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          <button onClick={() => onSave(montarOrdem())} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>💾 Salvar O.S.</button>
          <button onClick={() => onPrint(montarOrdem())} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🖨️ Salvar e Imprimir</button>
        </div>
      </div>
    </div>
  );
}

function OrdemPrint({ ordem, obras, onBack }) {
  const [incluirDetalhes, setIncluirDetalhes] = useState(false);
  const obrasRef = [...new Set(ordem.linhas.map(l => l.obraId).filter(Boolean))]
    .map(id => obras.find(o => o.id === id)).filter(Boolean);

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", color: "#1e293b", background: "#fff" }}>
      {/* barra de ações (some na impressão) */}
      <div className="no-print" style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 24px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
        <button onClick={onBack} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Voltar</button>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#334155", cursor: "pointer" }}>
          <input type="checkbox" checked={incluirDetalhes} onChange={e => setIncluirDetalhes(e.target.checked)} />
          Incluir páginas com detalhes das obras ({obrasRef.length})
        </label>
        <button onClick={() => window.print()} style={{ marginLeft: "auto", background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🖨️ Imprimir</button>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: 32 }}>
        {/* Cabeçalho */}
        <div style={{ textAlign: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: BRAND, letterSpacing: 1 }}>ORDEM DE SERVIÇO</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderTop: `2px solid ${BRAND}`, borderBottom: `2px solid ${BRAND}`, padding: "6px 0", margin: "8px 0 14px", fontWeight: 700 }}>
          <span>Nº {String(ordem.numero).padStart(3, "0")}</span>
          <span>PERÍODO: {fmtDate(ordem.periodoInicio)} a {fmtDate(ordem.periodoFim)}</span>
          <span>DATA: {fmtDate(ordem.dataEmissao)}</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: BRAND, marginBottom: 10 }}>
          {(ordem.equipeNome || "").toUpperCase().startsWith("EQUIPE") ? (ordem.equipeNome || "").toUpperCase() : "EQUIPE " + (ordem.equipeNome || "").toUpperCase()}
        </div>

        {/* Tabela */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: BRAND, color: "#fff" }}>
              {["DIA", "COMPOSIÇÃO", "OBRA", "ENDEREÇO", "HORÁRIO", "DESCRIÇÃO"].map(h => (
                <th key={h} style={{ padding: "7px 8px", textAlign: "left", fontWeight: 600, border: "1px solid #333" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordem.linhas.map((l, i) => (
              <tr key={l.id} style={{ background: i % 2 ? "#f8fafc" : "#fff" }}>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0", fontWeight: 700, whiteSpace: "nowrap" }}>{fmtDiaSemana(l.data)}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{ordem.composicao}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0", fontWeight: 700 }}>{l.obraNome || "—"}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{l.endereco || "—"}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{l.horario}</td>
                <td style={{ padding: "6px 8px", border: "1px solid #e2e8f0" }}>{l.descricao || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Assinaturas */}
        <div style={{ marginTop: 50, display: "flex", gap: 40 }}>
          {["Responsável pela Equipe", "Supervisor / Aprovação", "Cliente / Obra"].map(s => (
            <div key={s} style={{ flex: 1, borderTop: "1px solid #1e293b", paddingTop: 6, textAlign: "center", fontSize: 11, color: "#64748b" }}>{s}</div>
          ))}
        </div>
        <div style={{ marginTop: 26, textAlign: "center", fontSize: 10, color: "#94a3b8" }}>
          CENTAURO — Agenda de Serviços {new Date(ordem.dataEmissao).getFullYear()} | Documento gerado automaticamente
        </div>

        {/* Detalhes das obras (opcional) */}
        {incluirDetalhes && obrasRef.map(o => (
          <div key={o.id} style={{ pageBreakBefore: "always", paddingTop: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: BRAND }}>#{o.numero} — {o.cliente}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>{o.obra || "—"} · {o.cidade} · Início: {fmtDate(o.dataInicio)}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: BRAND, color: "#fff" }}>
                  {["Desenho", "Tipo", "Descrição", "Qtd", "Medidas", "Local", "Etapa", "%"].map(h => (
                    <th key={h} style={{ padding: "5px 6px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {o.itens.map((it, i) => {
                  const feitas = ETAPAS.filter(e => (it.etapas || {})[e] && it.etapas[e].feito);
                  const etapa = feitas.length ? feitas[feitas.length - 1] : "—";
                  return (
                    <tr key={it.id} style={{ background: i % 2 ? "#f8fafc" : "#fff", borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "4px 6px" }}>{it.desenho ? <img src={it.desenho} alt="" style={{ width: 44, height: "auto", border: "1px solid #e2e8f0", borderRadius: 3 }} /> : "—"}</td>
                      <td style={{ padding: "4px 6px", fontWeight: 700 }}>{it.tipo || "—"}</td>
                      <td style={{ padding: "4px 6px" }}>{it.descricao}</td>
                      <td style={{ padding: "4px 6px", textAlign: "center" }}>{it.qtd}</td>
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{it.L}×{it.H}</td>
                      <td style={{ padding: "4px 6px" }}>{it.localizacao || "—"}</td>
                      <td style={{ padding: "4px 6px" }}>{etapa}</td>
                      <td style={{ padding: "4px 6px", textAlign: "center", fontWeight: 700 }}>{itemPercentual(it)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrdensView({ equipes, obras, ordens, onNewOrdem, onEditOrdem, onDeleteOrdem, onPrintOrdem }) {
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: BRAND, marginBottom: 4 }}>Ordem de Serviço por Equipe</h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>Veja o que cada equipe está executando e gere a O.S. semanal.</p>

      {equipes.length === 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: 16, fontSize: 13, color: "#92400e", marginBottom: 20 }}>
          Cadastre equipes em <b>Equipes</b> e atribua-as às obras para gerar Ordens de Serviço.
        </div>
      )}

      {/* Cards de equipe */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 30 }}>
        {equipes.map(eq => {
          const obs = obrasDaEquipe(eq.id, obras);
          const ativas = obs.filter(o => obraAtivaNoDia(o, hoje()));
          return (
            <div key={eq.id} style={{ background: "#fff", borderRadius: 12, padding: "16px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", borderLeft: `5px solid ${eq.cor}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: obs.length ? 12 : 0 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16, color: eq.cor }}>{eq.nome}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>{eq.integrantes.length ? eq.integrantes.join(" + ") : "sem integrantes"}</div>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>{obs.length} obra(s) · {ativas.length} ativa(s) hoje</span>
                  <button onClick={() => onNewOrdem(eq)} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>📋 Gerar O.S.</button>
                </div>
              </div>
              {obs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {obs.map(o => {
                    const pct = o.itens.length ? Math.round(o.itens.reduce((a, i) => a + itemPercentual(i), 0) / o.itens.length) : 0;
                    const ativa = obraAtivaNoDia(o, hoje());
                    return (
                      <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, background: ativa ? "#ecfdf5" : "#f8fafc", border: `1px solid ${ativa ? "#a7f3d0" : "#e2e8f0"}`, borderRadius: 8, padding: "6px 10px", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 800, color: BRAND }}>#{o.numero}</span>
                        <span style={{ fontWeight: 600 }}>{o.cliente}</span>
                        <span style={{ color: "#64748b" }}>· {o.cidade}</span>
                        <span style={{ color: ETAPA_COLORS[etapaAtualObra(o)] || "#64748b", fontWeight: 700 }}>· {etapaAtualObra(o)}</span>
                        {ativa && <span style={{ background: "#10b981", color: "#fff", borderRadius: 999, padding: "1px 8px", fontSize: 10, fontWeight: 700 }}>EM EXECUÇÃO HOJE</span>}
                        <span style={{ marginLeft: "auto", fontWeight: 700 }}>{pct}%</span>
                        <div style={{ width: 90 }}><ProgressBar value={pct} height={6} /></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Histórico de O.S. */}
      <h3 style={{ fontSize: 15, fontWeight: 800, color: BRAND, marginBottom: 10 }}>Ordens de Serviço emitidas ({ordens.length})</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ordens.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13, padding: 16, textAlign: "center" }}>Nenhuma O.S. emitida ainda.</div>}
        {ordens.map(ord => (
          <div key={ord.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 16px", flexWrap: "wrap" }}>
            <span style={{ background: BRAND, color: "#fff", borderRadius: 8, padding: "4px 10px", fontWeight: 800, fontSize: 13 }}>Nº {String(ord.numero).padStart(3, "0")}</span>
            <span style={{ fontWeight: 700 }}>{ord.equipeNome}</span>
            <span style={{ fontSize: 12, color: "#64748b" }}>{fmtDate(ord.periodoInicio)} a {fmtDate(ord.periodoFim)} · {ord.linhas.length} dia(s)</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={() => onPrintOrdem(ord)} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Imprimir</button>
              <button onClick={() => onEditOrdem(ord)} style={{ background: "#eff6ff", color: BRAND, border: "none", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Reabrir</button>
              <button onClick={() => { if (confirm("Excluir esta O.S.?")) onDeleteOrdem(ord.id); }} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Excluir</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MENU LATERAL ─────────────────────────────────────────────────────────────
function SideMenu({ open, onClose, onNav, onImport, current }) {
  const items = [
    { key: "dashboard", label: "Obras", icon: "🏠" },
    { key: "calendar", label: "Calendário", icon: "📅" },
    { key: "equipes", label: "Equipes", icon: "👷" },
    { key: "ordens", label: "Ordem de Serviço", icon: "📋" },
    { key: "cronogramas", label: "Cronograma Comercial", icon: "📊" },
    { key: "financeiro", label: "Financeiro", icon: "🔒" },
  ];
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity .2s", zIndex: 40 }} />
      <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 264, background: "#1a1a1a", transform: open ? "translateX(0)" : "translateX(-100%)", transition: "transform .25s ease", zIndex: 41, display: "flex", flexDirection: "column", padding: "16px 0", boxShadow: open ? "4px 0 24px rgba(0,0,0,0.3)" : "none" }}>
        <div style={{ padding: "0 20px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <img src={logoWhite} alt="Centauro" style={{ height: 28 }} />
          <button onClick={onClose} style={{ background: "transparent", color: "#9ca3af", border: "none", fontSize: 24, lineHeight: 1, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ borderTop: "1px solid #333", margin: "4px 0 8px" }} />
        {items.map(it => (
          <button key={it.key} onClick={() => onNav(it.key)}
            style={{ textAlign: "left", background: current === it.key ? "#2a2a2a" : "transparent", color: current === it.key ? "#fff" : "#d1d5db", borderLeft: current === it.key ? "3px solid #c9a227" : "3px solid transparent", border: "none", borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: current === it.key ? "#c9a227" : "transparent", padding: "13px 22px", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 16 }}>{it.icon}</span> {it.label}
          </button>
        ))}
        <div style={{ borderTop: "1px solid #333", margin: "8px 0" }} />
        <button onClick={onImport}
          style={{ textAlign: "left", background: "transparent", color: "#c9a227", border: "none", padding: "13px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ fontSize: 16 }}>📄</span> Importar PDF
        </button>
        <div style={{ marginTop: "auto", padding: "12px 22px", fontSize: 11, color: "#6b7280" }}>Centauro — Gestão de Obras</div>
      </div>
    </>
  );
}

// ─── FINANCEIRO (protegido por senha) ─────────────────────────────────────────
const SENHA_FINANCEIRO = "00centauro00";
function FinanceiroView({ obras, unlocked, onUnlock }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  if (!unlocked) {
    return (
      <div style={{ padding: "60px 20px", display: "flex", justifyContent: "center" }}>
        <form onSubmit={e => { e.preventDefault(); if (pw === SENHA_FINANCEIRO) onUnlock(); else { setErr("Senha incorreta."); setPw(""); } }}
          style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 32, width: 340, maxWidth: "100%", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 34, textAlign: "center", marginBottom: 6 }}>🔒</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: BRAND, textAlign: "center" }}>Área Financeira</div>
          <div style={{ fontSize: 13, color: "#64748b", textAlign: "center", marginBottom: 20 }}>Digite a senha para acessar</div>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus placeholder="Senha"
            style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", fontSize: 14, boxSizing: "border-box", marginBottom: 12 }} />
          {err && <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <button type="submit" style={{ width: "100%", background: BRAND, color: "#fff", border: "none", borderRadius: 8, padding: 11, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Acessar</button>
        </form>
      </div>
    );
  }

  const total = obras.reduce((a, o) => a + (o.valorTotal || 0), 0);
  const sorted = [...obras].sort((a, b) => (b.valorTotal || 0) - (a.valorTotal || 0));
  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: BRAND, marginBottom: 16 }}>Financeiro</h2>
      <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", borderLeft: "4px solid #c9a227", marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Total em Obras</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#c9a227" }}>R$ {fmt(total)}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{obras.length} pedidos</div>
      </div>
      <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: BRAND, color: "#fff" }}>
              {["#", "Cliente", "Cidade", "Valor", "% do total"].map(h => (
                <th key={h} style={{ padding: "8px 12px", textAlign: h === "Valor" || h === "% do total" ? "right" : "left", fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((o, i) => (
              <tr key={o.id} style={{ background: i % 2 ? "#f8fafc" : "#fff", borderBottom: "1px solid #e2e8f0" }}>
                <td style={{ padding: "7px 12px", fontWeight: 700 }}>#{o.numero}</td>
                <td style={{ padding: "7px 12px" }}>{o.cliente}</td>
                <td style={{ padding: "7px 12px", color: "#64748b" }}>{o.cidade}</td>
                <td style={{ padding: "7px 12px", textAlign: "right", fontWeight: 700, color: "#c9a227" }}>R$ {fmt(o.valorTotal)}</td>
                <td style={{ padding: "7px 12px", textAlign: "right", color: "#64748b" }}>{total ? ((o.valorTotal || 0) / total * 100).toFixed(1) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>Mais recursos financeiros serão adicionados aqui.</div>
    </div>
  );
}

// ─── CRONOGRAMA COMERCIAL (mini MS Project) ──────────────────────────────────
function novoCronograma(titulo, obra) {
  const hoje = new Date().toISOString().split("T")[0];
  return {
    id: "cr_" + Date.now(),
    titulo: titulo || "Novo Cronograma",
    obraId: obra ? obra.id : null,
    cliente: obra ? obra.cliente : "",
    config: { ...CONFIG_PADRAO, dataBase: hoje },
    tasks: [{ id: 1, nivel: 0, nome: titulo || "Projeto", durValor: 1, durUnid: "dias", percent: 0, predecessoras: [], inicioManual: "" }],
  };
}
function toLocalInput(date) {
  if (!date) return "";
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function CronogramasView({ cronogramas, obras, onNovo, onAbrir, onExcluir }) {
  const [criando, setCriando] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [obraId, setObraId] = useState("");

  function criar() {
    if (!titulo.trim()) return;
    const obra = obras.find(o => o.id === obraId) || null;
    onNovo(titulo.trim(), obra);
    setCriando(false); setTitulo(""); setObraId("");
  }

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: BRAND, margin: 0 }}>Cronograma Comercial</h2>
        <button onClick={() => setCriando(v => !v)} style={{ marginLeft: "auto", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Novo cronograma</button>
      </div>

      {criando && (
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 18, marginBottom: 18, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Título</div>
            <input value={titulo} onChange={e => setTitulo(e.target.value)} autoFocus placeholder="Ex: Ampliação GRIII"
              onKeyDown={e => { if (e.key === "Enter") criar(); }}
              style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, boxSizing: "border-box" }} />
          </div>
          <div style={{ minWidth: 220 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Vincular a uma obra (opcional)</div>
            <select value={obraId} onChange={e => setObraId(e.target.value)}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, background: "#fff", minWidth: 220 }}>
              <option value="">— Avulso —</option>
              {obras.map(o => <option key={o.id} value={o.id}>#{o.numero} {o.cliente}</option>)}
            </select>
          </div>
          <button onClick={criar} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Criar</button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {cronogramas.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13, padding: 24, textAlign: "center" }}>Nenhum cronograma ainda.</div>}
        {cronogramas.map(c => {
          const obra = obras.find(o => o.id === c.obraId);
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px", flexWrap: "wrap" }}>
              <span style={{ fontSize: 20 }}>📊</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 700, color: BRAND }}>{c.titulo}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>{obra ? `Obra #${obra.numero} · ${obra.cliente}` : "Avulso"} · {c.tasks.length} tarefa(s)</div>
              </div>
              <button onClick={() => onAbrir(c.id)} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Abrir</button>
              <button onClick={() => { if (confirm("Excluir este cronograma?")) onExcluir(c.id); }} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 7, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Excluir</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CR_ROW_H = 28;
const CR_DAY_MS = 86400000;

function CronogramaEditor({ cronograma, onChange, obras }) {
  const [c, setC] = useState(cronograma);
  const [sel, setSel] = useState(null);
  const [zoom, setZoom] = useState("dia"); // dia | semana

  useEffect(() => { setC(cronograma); }, [cronograma]);
  const update = (next) => { setC(next); onChange(next); };

  const DAY_W = zoom === "dia" ? 26 : 12;
  const sched = agendar(c.tasks, c.config);

  // faixa da timeline
  let tStart = null, tEnd = null;
  for (const t of c.tasks) {
    const s = sched[t.id]; if (!s) continue;
    if (!tStart || s.inicio < tStart) tStart = s.inicio;
    if (!tEnd || s.termino > tEnd) tEnd = s.termino;
  }
  if (!tStart) { tStart = new Date(); tEnd = new Date(); }
  tStart = new Date(tStart.getFullYear(), tStart.getMonth(), tStart.getDate());       // 00:00 do dia
  tStart = new Date(tStart.getTime() - 2 * CR_DAY_MS);
  const totalDays = Math.max(14, Math.ceil((tEnd - tStart) / CR_DAY_MS) + 4);
  const dias = Array.from({ length: totalDays }, (_, i) => new Date(tStart.getTime() + i * CR_DAY_MS));
  const TL_W = totalDays * DAY_W;

  // ── edições ──
  const setTasks = (tasks) => update({ ...c, tasks });
  const updTask = (id, patch) => setTasks(c.tasks.map(t => t.id === id ? { ...t, ...patch } : t));
  const selIdx = c.tasks.findIndex(t => t.id === sel);

  function addTarefa() {
    const idx = selIdx >= 0 ? selIdx : c.tasks.length - 1;
    const nivel = idx >= 0 ? c.tasks[idx].nivel : 0;
    const novoId = Math.max(0, ...c.tasks.map(t => t.id)) + 1;
    const nova = { id: novoId, nivel, nome: "Nova tarefa", durValor: 1, durUnid: "dias", percent: 0, predecessoras: [], inicioManual: "" };
    const arr = [...c.tasks];
    arr.splice(idx + 1, 0, nova);
    setTasks(arr);
    setSel(novoId);
  }
  function indent(dir) {
    if (selIdx < 1) return; // primeira tarefa não indenta
    const t = c.tasks[selIdx];
    const max = c.tasks[selIdx - 1].nivel + 1;
    const nivel = Math.min(Math.max(0, t.nivel + dir), max);
    updTask(t.id, { nivel });
  }
  function mover(dir) {
    const j = selIdx + dir;
    if (selIdx < 0 || j < 0 || j >= c.tasks.length) return;
    const arr = [...c.tasks];
    [arr[selIdx], arr[j]] = [arr[j], arr[selIdx]];
    setTasks(arr);
  }
  function excluir() {
    if (selIdx < 0 || c.tasks.length <= 1) return;
    setTasks(c.tasks.filter((_, i) => i !== selIdx));
    setSel(null);
  }

  const inp = { border: "1px solid #e2e8f0", borderRadius: 5, padding: "2px 5px", fontSize: 12, boxSizing: "border-box" };
  const COL = { id: 34, nome: 240, dur: 92, pct: 46, ini: 122, term: 118, pred: 58 };
  const GRID_W = Object.values(COL).reduce((a, b) => a + b, 0);
  const btn = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontWeight: 700, fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", color: "#1e293b" }}>
      {/* Toolbar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "10px 16px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={c.titulo} onChange={e => update({ ...c, titulo: e.target.value })}
          style={{ fontWeight: 800, fontSize: 15, color: BRAND, border: "1px solid transparent", borderRadius: 6, padding: "4px 8px", minWidth: 220 }}
          onFocus={e => e.target.style.border = "1px solid #e2e8f0"} onBlur={e => e.target.style.border = "1px solid transparent"} />
        {c.obraId && <span style={{ fontSize: 12, color: "#64748b" }}>· {obras.find(o => o.id === c.obraId)?.cliente || "obra"}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={addTarefa} style={btn}>+ Tarefa</button>
          <button onClick={() => indent(1)} style={btn} title="Indentar">→</button>
          <button onClick={() => indent(-1)} style={btn} title="Desindentar">←</button>
          <button onClick={() => mover(-1)} style={btn} title="Mover para cima">↑</button>
          <button onClick={() => mover(1)} style={btn} title="Mover para baixo">↓</button>
          <button onClick={excluir} style={{ ...btn, color: "#dc2626", borderColor: "#fecaca" }} title="Excluir">🗑</button>
          <button onClick={() => setZoom(z => z === "dia" ? "semana" : "dia")} style={btn} title="Zoom">{zoom === "dia" ? "🔍 Semana" : "🔍 Dia"}</button>
        </div>
      </div>

      {/* Split: grade + gantt */}
      <div style={{ display: "flex", alignItems: "flex-start", overflowX: "auto" }}>
        {/* GRADE */}
        <div style={{ width: GRID_W, minWidth: GRID_W, borderRight: "2px solid #cbd5e1", background: "#fff" }}>
          {/* header grade */}
          <div style={{ display: "flex", background: "#1a1a1a", color: "#fff", height: CR_ROW_H * 2, alignItems: "center", fontSize: 11, fontWeight: 700 }}>
            <div style={{ width: COL.id, textAlign: "center" }}>Id</div>
            <div style={{ width: COL.nome, paddingLeft: 6 }}>Nome da tarefa</div>
            <div style={{ width: COL.dur, textAlign: "center" }}>Duração</div>
            <div style={{ width: COL.pct, textAlign: "center" }}>%</div>
            <div style={{ width: COL.ini, textAlign: "center" }}>Início</div>
            <div style={{ width: COL.term, textAlign: "center" }}>Término</div>
            <div style={{ width: COL.pred, textAlign: "center" }}>Pred.</div>
          </div>
          {/* linhas */}
          {c.tasks.map((t, i) => {
            const sc = sched[t.id] || {};
            const selRow = sel === t.id;
            const cor = t.nivel === 0 ? "#dc2626" : sc.isSummary ? BRAND : "#1e293b";
            return (
              <div key={t.id} onClick={() => setSel(t.id)}
                style={{ display: "flex", alignItems: "center", height: CR_ROW_H, borderBottom: "1px solid #f1f5f9", background: selRow ? "#eff6ff" : (i % 2 ? "#fafafa" : "#fff"), fontSize: 12, cursor: "pointer" }}>
                <div style={{ width: COL.id, textAlign: "center", color: "#94a3b8" }}>{t.id}</div>
                <div style={{ width: COL.nome, paddingLeft: 6 + t.nivel * 14, overflow: "hidden" }}>
                  <input value={t.nome} onChange={e => updTask(t.id, { nome: e.target.value })} onClick={e => e.stopPropagation()}
                    style={{ ...inp, border: "1px solid transparent", background: "transparent", width: "100%", fontWeight: (sc.isSummary || t.nivel === 0) ? 700 : 400, color: cor }} />
                </div>
                <div style={{ width: COL.dur, textAlign: "center" }}>
                  {sc.isSummary
                    ? <span style={{ color: "#64748b", fontWeight: 600 }}>{textoDuracao(t, sc)}</span>
                    : <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", gap: 2 }}>
                        <input type="number" min={0} step="0.5" value={t.durValor} onChange={e => updTask(t.id, { durValor: Number(e.target.value) })} style={{ ...inp, width: 40, textAlign: "right" }} />
                        <select value={t.durUnid} onChange={e => updTask(t.id, { durUnid: e.target.value })} style={{ ...inp, width: 44 }}>
                          <option value="dias">dias</option><option value="hrs">hrs</option>
                        </select>
                      </span>}
                </div>
                <div style={{ width: COL.pct, textAlign: "center" }}>
                  {sc.isSummary ? <b>{sc.percent}%</b>
                    : <input type="number" min={0} max={100} value={t.percent} onClick={e => e.stopPropagation()} onChange={e => updTask(t.id, { percent: Number(e.target.value) })} style={{ ...inp, width: 40, textAlign: "center" }} />}
                </div>
                <div style={{ width: COL.ini, textAlign: "center", fontSize: 11 }}>
                  {t.inicioManual
                    ? <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
                        <input type="datetime-local" value={t.inicioManual} onChange={e => updTask(t.id, { inicioManual: e.target.value })} style={{ ...inp, width: 96 }} />
                        <button onClick={() => updTask(t.id, { inicioManual: "" })} title="Auto" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94a3b8" }}>×</button>
                      </span>
                    : <span onClick={e => { e.stopPropagation(); if (!sc.isSummary) updTask(t.id, { inicioManual: toLocalInput(sc.inicio) }); }} title={sc.isSummary ? "" : "Fixar início"} style={{ cursor: sc.isSummary ? "default" : "pointer" }}>
                        {fmtDataHora(sc.inicio)}{!sc.isSummary && <span style={{ color: "#cbd5e1" }}> 📌</span>}
                      </span>}
                </div>
                <div style={{ width: COL.term, textAlign: "center", fontSize: 11, color: "#64748b" }}>{fmtDataHora(sc.termino)}</div>
                <div style={{ width: COL.pred, textAlign: "center" }}>
                  <input value={(t.predecessoras || []).join(",")} onClick={e => e.stopPropagation()}
                    onChange={e => updTask(t.id, { predecessoras: e.target.value.split(",").map(x => parseInt(x.trim(), 10)).filter(Boolean) })}
                    style={{ ...inp, width: 48, textAlign: "center" }} placeholder="—" />
                </div>
              </div>
            );
          })}
        </div>

        {/* GANTT */}
        <div style={{ position: "relative", minWidth: TL_W }}>
          {/* header timeline */}
          <div style={{ height: CR_ROW_H * 2, position: "relative", background: "#1a1a1a", color: "#fff" }}>
            {dias.map((d, i) => (
              <div key={i} style={{ position: "absolute", left: i * DAY_W, top: 0, width: DAY_W, height: "100%", borderLeft: "1px solid #333", boxSizing: "border-box" }}>
                {i % 7 === 0 && <div style={{ position: "absolute", top: 4, left: 3, fontSize: 10, whiteSpace: "nowrap", color: "#9ca3af" }}>{String(d.getDate()).padStart(2, "0")}/{MESES_ABBR[d.getMonth()]}</div>}
                <div style={{ position: "absolute", bottom: 4, width: "100%", textAlign: "center", fontSize: 9, color: ehDiaUtil(d, c.config) ? "#cbd5e1" : "#6b7280" }}>{DOW1[d.getDay()]}</div>
              </div>
            ))}
          </div>
          {/* corpo */}
          <div style={{ position: "relative" }}>
            {/* colunas / sombreado */}
            {dias.map((d, i) => (
              <div key={i} style={{ position: "absolute", left: i * DAY_W, top: 0, bottom: 0, width: DAY_W, borderLeft: "1px solid #f1f5f9", background: ehDiaUtil(d, c.config) ? "transparent" : "#f1f5f9", boxSizing: "border-box" }} />
            ))}
            {/* setas de dependência */}
            <svg style={{ position: "absolute", top: 0, left: 0, width: TL_W, height: c.tasks.length * CR_ROW_H, pointerEvents: "none" }}>
              {c.tasks.map((t, i) => (t.predecessoras || []).map(pid => {
                const pi = c.tasks.findIndex(x => x.id === pid);
                const ps = sched[pid], ss = sched[t.id];
                if (pi < 0 || !ps || !ss) return null;
                const x1 = ((ps.termino - tStart) / CR_DAY_MS) * DAY_W;
                const y1 = pi * CR_ROW_H + CR_ROW_H / 2;
                const x2 = ((ss.inicio - tStart) / CR_DAY_MS) * DAY_W;
                const y2 = i * CR_ROW_H + CR_ROW_H / 2;
                const mx = x1 + 6;
                return <polyline key={pid + "-" + t.id} points={`${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#94a3b8" strokeWidth="1" markerEnd="url(#arr)" />;
              }))}
              <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" /></marker></defs>
            </svg>
            {/* barras */}
            {c.tasks.map((t) => {
              const sc = sched[t.id]; if (!sc) return null;
              const x = ((sc.inicio - tStart) / CR_DAY_MS) * DAY_W;
              const w = Math.max(((sc.termino - sc.inicio) / CR_DAY_MS) * DAY_W, 4);
              const y = c.tasks.indexOf(t) * CR_ROW_H;
              if (sc.isSummary) {
                return (
                  <div key={t.id} style={{ position: "absolute", left: x, top: y + CR_ROW_H / 2 - 4, width: w, height: 8 }}>
                    <div style={{ position: "absolute", top: 2, left: 0, right: 0, height: 4, background: "#1a1a1a" }} />
                    <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: 8, background: "#1a1a1a" }} />
                    <div style={{ position: "absolute", top: 0, right: 0, width: 3, height: 8, background: "#1a1a1a" }} />
                  </div>
                );
              }
              return (
                <div key={t.id} title={`${t.nome}\n${fmtDataHora(sc.inicio)} → ${fmtDataHora(sc.termino)}`}
                  style={{ position: "absolute", left: x, top: y + CR_ROW_H / 2 - 6, width: w, height: 12, background: "#5eead4", border: "1px solid #0d9488", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${sc.percent}%`, background: "#0d9488" }} />
                </div>
              );
            })}
            {/* linhas de grade horizontais */}
            {c.tasks.map((t, i) => (
              <div key={t.id} style={{ position: "absolute", left: 0, top: i * CR_ROW_H, width: TL_W, height: CR_ROW_H, borderBottom: "1px solid #f1f5f9", boxSizing: "border-box", pointerEvents: "none" }} />
            ))}
            <div style={{ height: c.tasks.length * CR_ROW_H }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LOADING / LOGIN ──────────────────────────────────────────────────────────
function CenteredMsg({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", color: "#64748b", fontFamily: "'Segoe UI', sans-serif", fontSize: 15 }}>
      {children}
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [busy, setBusy] = useState(false);

  async function entrar(e) {
    e.preventDefault();
    setBusy(true); setErro("");
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000));
      const { error } = await Promise.race([
        supabase.auth.signInWithPassword({ email: email.trim(), password: senha }),
        timeout,
      ]);
      if (error) { setErro("Email ou senha inválidos."); setBusy(false); }
    } catch {
      setErro("Conexão lenta ou indisponível. Tente entrar novamente.");
      setBusy(false);
    }
    // sucesso: onAuthStateChange troca a tela automaticamente
  }

  return (
    <div style={{ minHeight: "100vh", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', sans-serif", padding: 20 }}>
      <form onSubmit={entrar} style={{ background: "#fff", borderRadius: 14, padding: "36px 32px", width: 360, maxWidth: "100%", boxShadow: "0 10px 40px rgba(0,0,0,0.35)" }}>
        <img src={logoDark} alt="Centauro Esquadrias" style={{ height: 44, display: "block", margin: "0 auto 8px" }} />
        <div style={{ textAlign: "center", fontSize: 13, color: "#64748b", marginBottom: 24 }}>Sistema de Gestão de Obras</div>

        <label style={{ fontSize: 12, fontWeight: 700, color: "#64748b" }}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus required
          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", fontSize: 14, margin: "4px 0 14px", boxSizing: "border-box" }} />

        <label style={{ fontSize: 12, fontWeight: 700, color: "#64748b" }}>Senha</label>
        <input type="password" value={senha} onChange={e => setSenha(e.target.value)} required
          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", fontSize: 14, margin: "4px 0 14px", boxSizing: "border-box" }} />

        {erro && <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 14 }}>{erro}</div>}

        <button type="submit" disabled={busy}
          style={{ width: "100%", background: busy ? "#64748b" : "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 14, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [obras, setObras] = useState([]);
  const [equipes, setEquipes] = useState([]);
  const [ordens, setOrdens] = useState([]);
  const [cronogramas, setCronogramas] = useState([]);
  // Navegação: view atual + pilha de histórico (botão voltar universal)
  const [view, setView] = useState({ type: "dashboard" });
  const [history, setHistory] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [financeiroUnlocked, setFinanceiroUnlocked] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const fileRef = useRef();
  const saveTimers = useRef({});

  // Sessão de login
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Carrega dados do banco após login
  useEffect(() => {
    if (!session) { setObras([]); setEquipes([]); setOrdens([]); setCronogramas([]); return; }
    let cancel = false;
    setLoading(true);
    (async () => {
      try {
        const [obs, eqs, ords, crons] = await Promise.all([fetchObras(), fetchEquipes(), fetchOrdens(), fetchCronogramas()]);
        if (cancel) return;
        setObras(obs.map(normObra).sort((a, b) => {
          const ao = Number.isFinite(a.ordem) ? a.ordem : 1e9 + (Number(a.numero) || 0);
          const bo = Number.isFinite(b.ordem) ? b.ordem : 1e9 + (Number(b.numero) || 0);
          return ao - bo;
        }));
        setEquipes(eqs);
        setOrdens(ords);
        setCronogramas(crons);
      } catch (err) {
        console.error(err);
        if (!cancel) showError("Erro ao carregar dados: " + err.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [session]);

  function showError(msg) {
    setImportError(msg);
    setTimeout(() => setImportError(""), 6000);
  }

  // Salva uma obra no banco (debounce por obra, evita gravar a cada tecla)
  const persistObra = useCallback((obra) => {
    const t = saveTimers.current;
    if (t[obra.id]) clearTimeout(t[obra.id]);
    t[obra.id] = setTimeout(() => {
      upsertObra(obra).catch(err => showError("Erro ao salvar: " + err.message));
    }, 700);
  }, []);

  // Navega para uma nova view (empilha a atual no histórico)
  const navTo = useCallback((v) => { setHistory(h => [...h, view]); setView(v); setMenuOpen(false); }, [view]);
  // Substitui a view atual sem empilhar
  const navReplace = useCallback((v) => { setView(v); setMenuOpen(false); }, []);
  // Volta para a view anterior
  const back = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) { setView({ type: "dashboard" }); return h; }
      setView(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, []);
  const goHome = useCallback(() => { setView({ type: "dashboard" }); setHistory([]); setMenuOpen(false); }, []);
  const openObra = useCallback((id) => navTo({ type: "gantt", obraId: id }), [navTo]);

  const updateObra = useCallback((updated) => {
    setObras(prev => prev.map(o => o.id === updated.id ? updated : o));
    persistObra(updated);
  }, [persistObra]);

  const handleStatusChange = useCallback((id, status) => {
    setObras(prev => {
      const next = prev.map(o => o.id === id ? { ...o, status } : o);
      const changed = next.find(o => o.id === id);
      if (changed) persistObra(changed);
      return next;
    });
  }, [persistObra]);

  // Reordenação manual das obras (arrastar): grava o índice em `ordem` e persiste os que mudaram
  const handleReorder = useCallback((orderedIds) => {
    setObras(prev => {
      const byId = Object.fromEntries(prev.map(o => [o.id, o]));
      const next = orderedIds.map((id, idx) => ({ ...byId[id], ordem: idx }));
      next.forEach(o => { if (byId[o.id] && byId[o.id].ordem !== o.ordem) persistObra(o); });
      return next;
    });
  }, [persistObra]);

  const handleEquipesChange = useCallback((next) => {
    setEquipes(next);
    dbSaveEquipes(next).catch(err => showError("Erro ao salvar equipes: " + err.message));
  }, []);

  const handleSaveOrdem = useCallback((ord) => {
    setOrdens(prev => {
      const exists = prev.find(o => o.id === ord.id);
      return exists ? prev.map(o => o.id === ord.id ? ord : o) : [ord, ...prev];
    });
    upsertOrdem(ord).catch(err => showError("Erro ao salvar O.S.: " + err.message));
  }, []);

  const handleDeleteOrdem = useCallback((id) => {
    setOrdens(prev => prev.filter(o => o.id !== id));
    dbDeleteOrdem(id).catch(err => showError("Erro ao excluir O.S.: " + err.message));
  }, []);

  const cronoTimer = useRef({});
  const handleSaveCronograma = useCallback((cr) => {
    setCronogramas(prev => {
      const exists = prev.find(x => x.id === cr.id);
      return exists ? prev.map(x => x.id === cr.id ? cr : x) : [cr, ...prev];
    });
    const t = cronoTimer.current;
    if (t[cr.id]) clearTimeout(t[cr.id]);
    t[cr.id] = setTimeout(() => {
      upsertCronograma(cr).catch(err => showError("Erro ao salvar cronograma: " + err.message));
    }, 700);
  }, []);
  const handleDeleteCronograma = useCallback((id) => {
    setCronogramas(prev => prev.filter(x => x.id !== id));
    dbDeleteCronograma(id).catch(err => showError("Erro ao excluir cronograma: " + err.message));
  }, []);

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError("");
    try {
      const obra = await parsePDFFile(file);
      if (!obra.numero) throw new Error("Número da proposta não encontrado");
      const exists = obras.find(o => o.id === obra.id);
      const merged = exists ? { ...obra, status: exists.status, dataInicio: exists.dataInicio, equipes: exists.equipes } : obra;
      setObras(prev => exists ? prev.map(o => o.id === obra.id ? merged : o) : [...prev, merged]);
      await upsertObra(merged);
      navTo({ type: "gantt", obraId: obra.id });
    } catch (err) {
      showError("Erro ao importar: " + err.message);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const handleLogout = async () => { await supabase.auth.signOut(); goHome(); };

  // Portões de acesso
  if (!authReady) return <CenteredMsg>Carregando…</CenteredMsg>;
  if (!session)   return <LoginScreen />;

  // Views de impressão ocupam a tela toda (sem o shell do app)
  if (view.type === "print") {
    const o = obras.find(x => x.id === view.obraId);
    return o ? <PrintView obra={o} onBack={back} /> : <CenteredMsg>Obra não encontrada</CenteredMsg>;
  }
  if (view.type === "ordemPrint") {
    return <OrdemPrint ordem={view.ordem} obras={obras} onBack={back} />;
  }

  const userEmail = session.user?.email || "";
  const selectedObra = view.type === "gantt" ? obras.find(o => o.id === view.obraId) : null;
  const canGoBack = history.length > 0 || view.type !== "dashboard";
  const tituloView = { dashboard: "Obras", calendar: "Calendário de Obras", equipes: "Equipes", ordens: "Ordem de Serviço", financeiro: "Financeiro", ordemBuilder: "Nova Ordem de Serviço", cronogramas: "Cronograma Comercial", cronograma: "Cronograma" };

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", background: "#f1f5f9", minHeight: "100vh", color: "#1e293b" }}>
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} current={view.type}
        onNav={(key) => navTo({ type: key })}
        onImport={() => { setMenuOpen(false); fileRef.current.click(); }} />

      {/* Top bar: menu · logo · voltar · título — usuário · sair */}
      <div style={{ background: "#1a1a1a", padding: "12px 20px", display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={() => setMenuOpen(true)} title="Menu"
          style={{ background: "transparent", color: "#fff", border: "none", fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 4 }}>☰</button>
        <div style={{ cursor: "pointer" }} onClick={goHome}>
          <img src={logoWhite} alt="Centauro Esquadrias" style={{ height: 34, display: "block" }} />
        </div>
        {canGoBack && (
          <button onClick={back} title="Voltar"
            style={{ background: "transparent", color: "#e2e8f0", border: "1px solid #333", borderRadius: 8, padding: "6px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Voltar</button>
        )}
        <div style={{ color: "#9ca3af", fontSize: 13, fontWeight: 600, marginLeft: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {selectedObra ? `#${selectedObra.numero} — ${selectedObra.cliente}` : (tituloView[view.type] || "")}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
          {importError && (
            <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600 }}>{importError}</span>
          )}
          {selectedObra && (
            <button onClick={() => navTo({ type: "print", obraId: selectedObra.id })}
              style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Nota de Serviço</button>
          )}
          <span style={{ color: "#9ca3af", fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userEmail}>👤 {userEmail}</span>
          <button onClick={handleLogout} title="Sair"
            style={{ background: "transparent", color: "#9ca3af", border: "1px solid #333", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Sair</button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handleImport} />

      {/* Conteúdo */}
      {loading
        ? <div style={{ textAlign: "center", padding: 80, color: "#64748b", fontSize: 15 }}>Carregando obras…</div>
        : view.type === "gantt"
          ? (selectedObra ? <GanttView obra={selectedObra} onChange={updateObra} equipes={equipes} /> : <CenteredMsg>Obra não encontrada</CenteredMsg>)
          : view.type === "calendar"
            ? <CalendarView obras={obras} equipes={equipes} onSelectObra={openObra} />
            : view.type === "equipes"
              ? <EquipesView equipes={equipes} onChange={handleEquipesChange} obras={obras} />
              : view.type === "ordens"
                ? <OrdensView equipes={equipes} obras={obras} ordens={ordens}
                    onNewOrdem={(eq) => navTo({ type: "ordemBuilder", equipeId: eq.id })}
                    onEditOrdem={(ord) => navTo({ type: "ordemBuilder", equipeId: ord.equipeId, ordem: ord })}
                    onDeleteOrdem={handleDeleteOrdem}
                    onPrintOrdem={(ord) => navTo({ type: "ordemPrint", ordem: ord })} />
                : view.type === "ordemBuilder"
                  ? (equipes.find(e => e.id === view.equipeId)
                      ? <OrdemBuilder equipe={equipes.find(e => e.id === view.equipeId)} obras={obras} ordens={ordens} ordemExistente={view.ordem}
                          onCancel={back}
                          onSave={(ord) => { handleSaveOrdem(ord); back(); }}
                          onPrint={(ord) => { handleSaveOrdem(ord); navReplace({ type: "ordemPrint", ordem: ord }); }} />
                      : <CenteredMsg>Equipe não encontrada</CenteredMsg>)
                  : view.type === "cronogramas"
                    ? <CronogramasView cronogramas={cronogramas} obras={obras}
                        onNovo={(titulo, obra) => { const cr = novoCronograma(titulo, obra); handleSaveCronograma(cr); navTo({ type: "cronograma", id: cr.id }); }}
                        onAbrir={(id) => navTo({ type: "cronograma", id })}
                        onExcluir={handleDeleteCronograma} />
                    : view.type === "cronograma"
                      ? (cronogramas.find(x => x.id === view.id)
                          ? <CronogramaEditor cronograma={cronogramas.find(x => x.id === view.id)} obras={obras} onChange={handleSaveCronograma} />
                          : <CenteredMsg>Cronograma não encontrado</CenteredMsg>)
                      : view.type === "financeiro"
                        ? <FinanceiroView obras={obras} unlocked={financeiroUnlocked} onUnlock={() => setFinanceiroUnlocked(true)} />
                        : <Dashboard obras={obras} onSelect={openObra} onStatusChange={handleStatusChange} onReorder={handleReorder} equipes={equipes} />
      }

      {/* pdf.js CDN (for PDF import in browser) */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            if (!window.pdfjsLib) {
              var s = document.createElement('script');
              s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
              s.onload = function() {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
              };
              document.head.appendChild(s);
            }
          `
        }}
      />
    </div>
  );
}
