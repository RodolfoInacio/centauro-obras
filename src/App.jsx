import { useState, useEffect, useRef, useCallback } from "react";
import logoWhite from "./assets/logo-white.png";
import logoDark from "./assets/logo-dark.png";
import { supabase } from "./supabase";
import { fetchObras, upsertObra, fetchEquipes, upsertEquipe as dbUpsertEquipe, deleteEquipe as dbDeleteEquipe, fetchCronogramas, upsertCronograma, deleteCronograma as dbDeleteCronograma, fetchAgenda, upsertAgendamento, deleteAgendamento as dbDeleteAgendamento } from "./api";
import { agendar, CONFIG_PADRAO, fmtDataHora, textoDuracao, MESES_ABBR, DOW1, ehDiaUtil, renumerarIds, descendentesDe, indicesVisiveis } from "./cronograma";
import Modal from "./Modal";

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
  "Atrasado":     "#ef4444",
};
const STATUS_OPTIONS = ["Aguardando", "Em andamento", "Concluído", "Atrasado"];

// Compras por categoria (Perfil/Pintura/Acessório/Vidro) — previsto x realizado em R$.
const CATEGORIAS_COMPRA = ["perfil", "pintura", "acessorio", "vidro"];
const CATEGORIA_LABEL = { perfil: "Perfil", pintura: "Pintura", acessorio: "Acessório", vidro: "Vidro" };

// Previsto e realizado são grandezas independentes: previsto é a estimativa de gasto daquele
// material, realizado é o que de fato saiu. Nunca se somam nem se subtraem — o que está no
// previsto e ainda não foi comprado É o próprio previsto, e é ele que falta comprar.
function comprasTotais(obra) {
  const compras = obra.compras || {};
  let previsto = 0, realizado = 0;
  for (const cat of CATEGORIAS_COMPRA) {
    const v = compras[cat] || {};
    if (v.naoSeAplica) continue;   // categoria riscada não entra em nenhum total
    previsto += Number(v.previsto) || 0;
    realizado += Number(v.realizado) || 0;
  }
  return { previsto, realizado, aComprar: previsto };
}
// Flag vermelha: o que ainda falta comprar é maior do que o que ainda vai entrar de caixa dessa obra.
function precisaAlertaCompras(obra) {
  const { aComprar } = comprasTotais(obra);
  const aReceber = Math.max(0, (obra.valorTotal || 0) - (obra.valorRecebido || 0));
  return aComprar > aReceber;
}

// ─── BANDEIRAS MANUAIS ───────────────────────────────────────────────────────
// Além da bandeira automática de compras (acima), o escritório pendura bandeiras à mão na obra:
// vermelha (problema), azul (atenção/observação) e verde (liberado/ok).
const FLAG_CORES = {
  vermelha: { emoji: "🚩", label: "Vermelha", cor: "#dc2626" },
  azul:     { emoji: "🔵", label: "Azul",     cor: "#2563eb" },
  verde:    { emoji: "🟢", label: "Verde",    cor: "#16a34a" },
};
function novaFlag(cor) {
  return { id: "fl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cor, criadaEm: hoje() };
}

// ─── FINANCEIRO CONSOLIDADO ──────────────────────────────────────────────────
// O que ainda entra (a receber) e o que ainda sai (a pagar = previsto de compras, ver
// comprasTotais). `aEntregar` é o valor de obra ainda não executado — o saldo físico.
function finObra(o) {
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
function finTotais(obras) {
  return obras.reduce((acc, o) => {
    const f = finObra(o);
    acc.total += f.total; acc.recebido += f.recebido; acc.aReceber += f.aReceber;
    acc.aPagar += f.aPagar; acc.aEntregar += f.aEntregar;
    if (precisaAlertaCompras(o)) acc.emAlerta += 1;
    return acc;
  }, { total: 0, recebido: 0, aReceber: 0, aPagar: 0, aEntregar: 0, emAlerta: 0 });
}

// Dias corridos entre a assinatura do contrato e hoje (a coluna TEMPO da planilha do escritório).
function diasDesdeContrato(o) {
  if (!o.dataContrato) return null;
  return Math.max(0, daysBetween(o.dataContrato, hoje()));
}
function corDias(d) { return d >= 90 ? "#dc2626" : d >= 30 ? "#f59e0b" : "#64748b"; }

function mkEtapas() {
  return Object.fromEntries(ETAPAS.map(e => [e, { feito: false, inicio: "", entrega: "" }]));
}

// % concluído do item = soma dos pesos das etapas concluídas
function itemPercentual(item) {
  const et = item.etapas || {};
  return ETAPAS.reduce((a, e) => a + (et[e] && et[e].feito ? PESOS[e] : 0), 0);
}

// ─── PREFERÊNCIAS DE TELA (localStorage) ─────────────────────────────────────
// Só preferências de exibição; nunca dados de obra. Falha em silêncio se o
// navegador bloquear o armazenamento (aba anônima, cookies restritos).
function lerPref(chave, padrao) {
  try { return localStorage.getItem(chave) ?? padrao; } catch { return padrao; }
}
function gravarPref(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch { /* ignora */ }
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
    // Financeiro por obra: por enquanto preenchido a mão (planilha), depois vem do ERP.
    dataContrato: o.dataContrato || "",
    // Bandeiras penduradas à mão (a automática de compras não fica aqui — é calculada)
    flags: (Array.isArray(o.flags) ? o.flags : [])
      .filter(f => f && FLAG_CORES[f.cor])
      .map(f => ({ id: f.id || novaFlag(f.cor).id, cor: f.cor, criadaEm: f.criadaEm || "" })),
    valorRecebido: Number.isFinite(o.valorRecebido) ? o.valorRecebido : 0,
    statusCompras: o.statusCompras || "Aguardando",
    statusFabricacao: o.statusFabricacao || "Aguardando",
    statusInstalacao: o.statusInstalacao || "Aguardando",
    // Compras por categoria: valores (R$), datas e marcação de "não se aplica".
    compras: CATEGORIAS_COMPRA.reduce((acc, cat) => {
      const v = (o.compras || {})[cat] || {};
      acc[cat] = {
        previsto: Number(v.previsto) || 0,
        realizado: Number(v.realizado) || 0,
        dataCompra: v.dataCompra || "",
        previsaoEntrega: v.previsaoEntrega || "",
        naoSeAplica: !!v.naoSeAplica,
      };
      return acc;
    }, {}),
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
// ─── HELPERS DE DATA ─────────────────────────────────────────────────────────
const DOW_ABBR = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
function hoje() { return new Date().toISOString().split("T")[0]; }
// "2025-06-25" → "25/06 (Qui)"
function fmtDiaSemana(dStr) {
  if (!dStr) return "";
  const [y, m, d] = dStr.split("-");
  const dow = DOW_ABBR[new Date(+y, +m - 1, +d).getDay()];
  return `${d}/${m} (${dow})`;
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

// Gráfico de pizza/rosca em SVG puro (sem lib — o projeto não tem nenhuma). `data`: [{ value, color }].
// `centro`: conteúdo livre desenhado no meio do anel (ex: valor total).
function PieChart({ data, size = 120, strokeWidth = 18, centro }) {
  const total = data.reduce((a, d) => a + (Number(d.value) || 0), 0);
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
        {total > 0 && data.map((d, i) => {
          const frac = (Number(d.value) || 0) / total;
          if (frac <= 0) return null;
          const dash = frac * c;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={d.color} strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} />
          );
          offset += dash;
          return el;
        })}
      </svg>
      {centro && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", textAlign: "center" }}>
          {centro}
        </div>
      )}
    </div>
  );
}

// ─── BANDEIRAS DA OBRA ───────────────────────────────────────────────────────
// Mostra as bandeiras manuais (× remove) e um "+" que abre as três cores disponíveis.
// Fica dentro de cards clicáveis, por isso engole o clique.
function FlagsObra({ flags, onChange, size = 13 }) {
  const [escolhendo, setEscolhendo] = useState(false);
  const lista = flags || [];
  const add = (cor) => { onChange([...lista, novaFlag(cor)]); setEscolhendo(false); };
  const del = (id) => onChange(lista.filter(f => f.id !== id));
  const btn = { cursor: "pointer", borderRadius: 999, lineHeight: 1.4, fontSize: size, padding: "1px 7px", background: "#fff" };
  return (
    <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
      {lista.map(f => {
        const c = FLAG_CORES[f.cor] || FLAG_CORES.vermelha;
        return (
          <span key={f.id} title={`Bandeira ${c.label}${f.criadaEm ? " · desde " + fmtDate(f.criadaEm) : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 2, background: c.cor + "14", border: `1px solid ${c.cor}44`, borderRadius: 999, padding: "1px 3px 1px 7px", fontSize: size, lineHeight: 1.4 }}>
            {c.emoji}
            <button onClick={() => del(f.id)} title="Remover bandeira"
              style={{ background: "none", border: "none", color: c.cor, cursor: "pointer", fontSize: size, lineHeight: 1, padding: "0 3px", fontWeight: 800 }}>×</button>
          </span>
        );
      })}
      {escolhendo ? (
        <>
          {Object.entries(FLAG_CORES).map(([cor, c]) => (
            <button key={cor} onClick={() => add(cor)} title={`Adicionar bandeira ${c.label}`}
              style={{ ...btn, border: `1px solid ${c.cor}66` }}>{c.emoji}</button>
          ))}
          <button onClick={() => setEscolhendo(false)} title="Cancelar"
            style={{ ...btn, border: "1px solid #e2e8f0", color: "#94a3b8", fontWeight: 800 }}>×</button>
        </>
      ) : (
        <button onClick={() => setEscolhendo(true)} title="Adicionar bandeira (vermelha, azul ou verde)"
          style={{ ...btn, border: "1px dashed #cbd5e1", color: "#94a3b8", fontWeight: 800 }}>+ ⚑</button>
      )}
    </div>
  );
}

// ─── PANORAMA FINANCEIRO ─────────────────────────────────────────────────────
// Consolidado das obras recebidas: quanto ainda entra, quanto ainda sai e quanto falta
// entregar em valor de obra. Recalcula a cada render — mudou um valor, muda aqui.
function PanoramaFinanceiro({ obras }) {
  const t = finTotais(obras);
  const blocos = [
    { label: "● Recebido",  value: t.recebido,  cor: "#10b981", sub: t.total ? `${Math.round(t.recebido / t.total * 100)}% do contratado` : "—" },
    { label: "● A Receber", value: t.aReceber,  cor: "#f59e0b", sub: "ainda entra no caixa" },
    { label: "● A Pagar",   value: t.aPagar,    cor: "#dc2626", sub: "compras previstas" },
    { label: "A Entregar",  value: t.aEntregar, cor: "#3b82f6", sub: "valor de obra não executado" },
  ];
  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", borderLeft: "4px solid #c9a227", marginBottom: 24, display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap" }}>
      <PieChart
        size={104} strokeWidth={15}
        data={[{ value: t.recebido, color: "#10b981" }, { value: t.aReceber, color: "#f59e0b" }]}
        centro={
          <>
            <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Contratado</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b" }}>R$ {fmt(t.total)}</div>
          </>
        }
      />
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap", flex: 1 }}>
        {blocos.map(b => (
          <div key={b.label}>
            <div style={{ fontSize: 10, color: b.cor, fontWeight: 700, textTransform: "uppercase" }}>{b.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: b.cor }}>R$ {fmt(b.value)}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{b.sub}</div>
          </div>
        ))}
      </div>
      {t.emAlerta > 0 && (
        <div style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 800 }}>
          🚩 {t.emAlerta} obra{t.emAlerta > 1 ? "s" : ""} com compras acima do que ainda vai receber
        </div>
      )}
    </div>
  );
}

// ─── PDF PARSER (browser) ─────────────────────────────────────────────────────
// Extrai o texto (linha a linha, já filtrado de rodapé/lixo) de todas as páginas do PDF via pdf.js.
async function extractPdfLines(file) {
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
  return allLines;
}

// Extração local por regex (usada hoje e como fallback do caminho com IA, abaixo).
async function parsePDFFile(file) {
  const allLines = await extractPdfLines(file);
  return parseObraLines(allLines, file.name);
}

// Monta o objeto "obra" completo (com defaults de app) a partir dos campos brutos
// devolvidos pela Edge Function de IA (parse-obra-pdf) ou pelo parser local.
function montarObraDeDados(dados, filename) {
  const num = String(dados.numero || filename.replace(/\D/g, "") || "");
  const itens = (dados.itens || []).map((it, i) => ({
    id: i + 1,
    tipo: it.tipo || "", descricao: it.descricao || "",
    perfil: it.perfil || "", acessorios: it.acessorios || "", vidro: it.vidro || "", localizacao: it.localizacao || "",
    qtd: Number(it.qtd) || 0, L: Number(it.L) || 0, H: Number(it.H) || 0,
    vlrUnt: Number(it.vlrUnt) || 0, vlrTotal: Number(it.vlrTotal) || 0,
    percentual: 0, obs: "", inicio: "", diasExec: 0, desenho: "", etapas: mkEtapas(),
  }));
  return {
    id: num, numero: num,
    cliente: dados.cliente || "", obra: dados.obra || "", cidade: dados.cidade || "",
    vendedor: dados.vendedor || "", data: dados.data || "", valorTotal: Number(dados.valorTotal) || 0,
    status: "Aguardando", dataInicio: "", dataLimiteEntrega: "",
    material: { dataLimite: "", dataCompra: "", previsaoEntrega: "" }, equipes: [], itens,
  };
}

// Caminho principal de importação: extrai o texto e manda pra Edge Function (IA) estruturar.
// Se a IA falhar por qualquer motivo (rede, function fora do ar, custo etc.), cai pro parser local.
async function parsePDFFileComIA(file) {
  const allLines = await extractPdfLines(file);
  try {
    const { data, error } = await supabase.functions.invoke("parse-obra-pdf", { body: { lines: allLines, filename: file.name } });
    if (error) throw error;
    if (!data || data.error) throw new Error((data && data.error) || "resposta vazia da IA");
    const obra = montarObraDeDados(data, file.name);
    // Obra sem nenhum item quase sempre é resposta truncada/incompleta — melhor tentar o parser local.
    if (obra.itens.length === 0) throw new Error("IA não retornou itens");
    return obra;
  } catch (err) {
    console.warn("Importação via IA falhou, usando extração local:", err);
    const obra = parseObraLines(allLines, file.name);
    return { ...obra, _fallback: true };
  }
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

  const totalPct = localObra.itens.length > 0
    ? Math.round(localObra.itens.reduce((a, i) => a + itemPercentual(i), 0) / localObra.itens.length)
    : 0;

  // "A Receber" nunca é gravado — sempre recalculado, pra nunca ficar inconsistente com os outros dois.
  const valorAReceber = Math.max(0, (localObra.valorTotal || 0) - (localObra.valorRecebido || 0));
  const diasContrato = diasDesdeContrato(localObra);
  const compras = comprasTotais(localObra);
  const alertaCompras = precisaAlertaCompras(localObra);
  function updCompraCategoria(cat, campo, valor) {
    const atual = localObra.compras?.[cat] || { previsto: 0, realizado: 0 };
    // Só previsto/realizado são dinheiro; datas são texto e naoSeAplica é booleano.
    const v = (campo === "previsto" || campo === "realizado") ? Math.max(0, Number(valor) || 0) : valor;
    update({ ...localObra, compras: { ...localObra.compras, [cat]: { ...atual, [campo]: v } } });
  }

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

      {/* Resumo Financeiro */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "16px 20px", display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap" }}>
        <PieChart
          size={104} strokeWidth={15}
          data={[
            { value: localObra.valorRecebido || 0, color: "#10b981" },
            { value: valorAReceber, color: "#f59e0b" },
          ]}
          centro={
            <>
              <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Total</div>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b" }}>R$ {fmt(localObra.valorTotal)}</div>
            </>
          }
        />

        <div style={{ display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 10, color: "#10b981", fontWeight: 700, textTransform: "uppercase" }}>● Recebido</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#10b981" }}>R$ {fmt(localObra.valorRecebido || 0)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, textTransform: "uppercase" }}>● A Receber</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#f59e0b" }}>R$ {fmt(valorAReceber)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#dc2626", fontWeight: 700, textTransform: "uppercase" }}>● A Pagar</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#dc2626" }}>R$ {fmt(compras.aComprar)}</div>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 2 }}>Data do Contrato</label>
            <input type="date" value={localObra.dataContrato || ""}
              onChange={e => update({ ...localObra, dataContrato: e.target.value })}
              style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: "#1e293b" }} />
            <div style={{ fontSize: 11, fontWeight: 800, marginTop: 3, color: diasContrato === null ? "#94a3b8" : corDias(diasContrato) }}
              title="Dias corridos desde a data do contrato">
              {diasContrato === null ? "— sem data de contrato" : `⏱ ${diasContrato} dia${diasContrato === 1 ? "" : "s"} desde o contrato`}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 2 }}>Valor Recebido</label>
            <input type="number" min={0} step="0.01" value={localObra.valorRecebido || 0}
              onChange={e => update({ ...localObra, valorRecebido: Math.max(0, Number(e.target.value) || 0) })}
              style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 13, color: "#1e293b", width: 120 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>Bandeiras</label>
            <FlagsObra flags={localObra.flags} onChange={fs => update({ ...localObra, flags: fs })} />
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 20px" }}>
          {[
            { label: "Compras", field: "statusCompras" },
            { label: "Fabricação", field: "statusFabricacao" },
            { label: "Instalação", field: "statusInstalacao" },
            { label: "Geral", field: "status" },
          ].map(({ label, field }) => {
            const cor = STATUS_COLORS[localObra[field]] || "#94a3b8";
            return (
              <div key={field} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#64748b", width: 72 }}>{label}</span>
                <select value={localObra[field]} onChange={e => update({ ...localObra, [field]: e.target.value })}
                  style={{ background: cor + "22", color: cor, border: `1px solid ${cor}55`, borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Compras por categoria */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "12px 20px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Compras por Categoria</span>
          {alertaCompras && (
            <span style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 800 }}>
              🚩 Falta comprar (R$ {fmt(compras.aComprar)}) mais do que ainda vai receber (R$ {fmt(valorAReceber)})
            </span>
          )}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
            <thead>
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ padding: "2px 12px 4px 0", fontWeight: 700 }}>Categoria</th>
                <th style={{ padding: "2px 12px 4px", fontWeight: 700, textAlign: "right" }}>Previsto (falta comprar)</th>
                <th style={{ padding: "2px 12px 4px", fontWeight: 700, textAlign: "right" }}>Realizado</th>
                <th style={{ padding: "2px 12px 4px", fontWeight: 700 }}>Data da compra</th>
                <th style={{ padding: "2px 12px 4px", fontWeight: 700 }}>Previsão entrega</th>
                <th style={{ padding: "2px 0 4px", fontWeight: 700, textAlign: "center" }}>N/A</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIAS_COMPRA.map(cat => {
                const v = localObra.compras?.[cat] || { previsto: 0, realizado: 0 };
                const na = !!v.naoSeAplica;
                const inp = { border: "1px solid #e2e8f0", borderRadius: 5, padding: "3px 6px", fontSize: 12 };
                return (
                  <tr key={cat} style={na ? { opacity: 0.45, textDecoration: "line-through" } : undefined}>
                    <td style={{ padding: "3px 12px 3px 0", fontWeight: 600, color: "#1e293b" }}>{CATEGORIA_LABEL[cat]}</td>
                    <td style={{ padding: "3px 12px" }}>
                      <input type="number" min={0} step="0.01" value={v.previsto} disabled={na}
                        onChange={e => updCompraCategoria(cat, "previsto", e.target.value)}
                        style={{ ...inp, width: 92, textAlign: "right", color: (!na && v.previsto > 0) ? "#dc2626" : "#1e293b", fontWeight: (!na && v.previsto > 0) ? 700 : 400 }} />
                    </td>
                    <td style={{ padding: "3px 12px" }}>
                      <input type="number" min={0} step="0.01" value={v.realizado} disabled={na}
                        onChange={e => updCompraCategoria(cat, "realizado", e.target.value)}
                        style={{ ...inp, width: 92, textAlign: "right" }} />
                    </td>
                    <td style={{ padding: "3px 12px" }}>
                      <input type="date" value={v.dataCompra || ""} disabled={na}
                        onChange={e => updCompraCategoria(cat, "dataCompra", e.target.value)}
                        style={inp} />
                    </td>
                    <td style={{ padding: "3px 12px" }}>
                      <input type="date" value={v.previsaoEntrega || ""} disabled={na}
                        onChange={e => updCompraCategoria(cat, "previsaoEntrega", e.target.value)}
                        style={inp} />
                    </td>
                    <td style={{ padding: "3px 0", textAlign: "center" }}>
                      <input type="checkbox" checked={na} title="Não se aplica a esta obra"
                        onChange={e => updCompraCategoria(cat, "naoSeAplica", e.target.checked)}
                        style={{ cursor: "pointer" }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid #e2e8f0" }}>
                <td style={{ padding: "6px 12px 0 0", fontWeight: 800, color: "#1e293b" }}>Total</td>
                <td style={{ padding: "6px 12px 0", textAlign: "right", fontWeight: 800, color: compras.aComprar > 0 ? "#dc2626" : "#1e293b" }}>R$ {fmt(compras.aComprar)}</td>
                <td style={{ padding: "6px 12px 0", textAlign: "right", fontWeight: 800 }}>R$ {fmt(compras.realizado)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
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
function EquipesView({ equipes, onSalvar, onExcluir, obras }) {
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
      const atual = equipes.find(e => e.id === editingId);
      onSalvar({ ...atual, nome: nome.trim(), integrantes });
    } else {
      const cor = EQUIPE_CORES[equipes.length % EQUIPE_CORES.length];
      onSalvar({ id: "eq_" + Date.now(), nome: nome.trim(), integrantes, cor });
    }
    resetForm();
  }
  function editar(eq) {
    setEditingId(eq.id); setNome(eq.nome); setIntegrantes([...eq.integrantes]); setNovoInt("");
  }
  function excluir(eq) {
    const n = usoCount(eq.id);
    const aviso = n > 0
      ? `Excluir a equipe "${eq.nome}"? Ela será removida de ${n} obra(s) onde está atribuída.`
      : `Excluir a equipe "${eq.nome}"?`;
    if (!confirm(aviso)) return;
    onExcluir(eq.id);
    if (editingId === eq.id) resetForm();
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
            <button onClick={() => excluir(eq)}
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

const DIAS_SEMANA_LONGO = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

// ─── AGENDA DO DIA ───────────────────────────────────────────────────────────
// Um agendamento é um serviço do dia: obra (ou atividade avulsa) + equipe + período.
// Substitui a planilha "rotina trabalhos": lá cada dia é uma coluna e cada equipe um bloco com
// OBRA / ENDEREÇO / REFERÊNCIA / HORÁRIO / DESCRIÇÃO — os mesmos campos daqui.
// A execução do dia é sempre manual: o calendário não deduz nada das datas da obra.
const PERIODOS = ["Dia todo", "Manhã", "Tarde", "1h", "2h", "3h", "4h"];
const PERIODO_COR = { "Dia todo": "#1a1a1a", "Manhã": "#0ea5e9", "Tarde": "#f97316" };

function idAgendamento() {
  return "ag_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function novoAgendamento({ dia, equipeId, obra = null }) {
  return {
    id: idAgendamento(),
    dia,
    equipeId,
    obraId: obra ? obra.id : null,
    titulo: obra ? "" : "",                             // só para atividade fora das obras
    endereco: obra ? [obra.obra, obra.cidade].filter(Boolean).join(" · ") : "",
    referencia: "",
    periodo: "Dia todo",
    horaObs: "",                                        // complemento livre: "saída 5h30"
    descricao: "",
    ordem: Date.now(),
  };
}
// Undefined-safe, no mesmo espírito de normObra: registro antigo continua abrindo.
function normAgendamento(a) {
  return {
    ...a,
    obraId: a.obraId || null,
    titulo: a.titulo || "",
    endereco: a.endereco || "",
    referencia: a.referencia || "",
    periodo: PERIODOS.includes(a.periodo) ? a.periodo : "Dia todo",
    horaObs: a.horaObs || "",
    descricao: a.descricao || "",
    ordem: Number.isFinite(a.ordem) ? a.ordem : 0,
  };
}
// Nome curto do serviço: a obra, ou o título da atividade avulsa.
function tituloAgendamento(ag, obras) {
  if (!ag.obraId) return ag.titulo || "Atividade avulsa";
  const o = obras.find(x => x.id === ag.obraId);
  return o ? `#${o.numero} ${o.cliente}` : "(obra removida)";
}
// Dia da semana de "YYYY-MM-DD" sem cair na armadilha de fuso do new Date(string), que é UTC.
function dowDe(dStr) {
  const [y, m, d] = dStr.split("-");
  return new Date(+y, +m - 1, +d).getDay();
}
// Dias úteis (seg-sex) de `de` até `ate`, inclusive
function diasUteisEntre(de, ate) {
  const out = [];
  let cur = de;
  let guard = 0;
  while (cur <= ate && guard < 400) {
    const dow = dowDe(cur);
    if (dow !== 0 && dow !== 6) out.push(cur);
    cur = addDays(cur, 1);
    guard++;
  }
  return out;
}

// Um serviço já agendado. Campos iguais aos da planilha, mais o botão de repetir nos próximos dias.
function CardAgendamento({ ag, obras, cor, onChange, onExcluir, onRepetir, onAbrirObra, onArrastar }) {
  const [ate, setAte] = useState("");
  const obra = ag.obraId ? obras.find(o => o.id === ag.obraId) : null;
  const inp = { border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 8px", fontSize: 12, color: "#1e293b", width: "100%", boxSizing: "border-box" };
  return (
    <div draggable
      onDragStart={e => { onArrastar(); if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ag.id); } }}
      style={{ background: "#fff", border: "1px solid " + cor + "44", borderLeft: "4px solid " + cor, borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span title="Arraste para outra equipe" style={{ color: "#cbd5e1", cursor: "grab", fontSize: 14, lineHeight: 1 }}>☰</span>
        {obra ? (
          <button onClick={() => onAbrirObra(obra.id)} title="Abrir a obra"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 800, fontSize: 13, color: "#1e293b", textAlign: "left" }}>
            #{obra.numero} {obra.cliente}
          </button>
        ) : (
          <input value={ag.titulo} placeholder="Atividade (ex: manutenção, verificação)"
            onChange={e => onChange({ ...ag, titulo: e.target.value })}
            style={{ ...inp, fontWeight: 800, fontSize: 13, border: "1px dashed #c9a227", background: "#fffbeb", flex: 1 }} />
        )}
        <button onClick={() => onExcluir(ag.id)} title="Remover do dia"
          style={{ marginLeft: "auto", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 6, padding: "2px 9px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>×</button>
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        {PERIODOS.map(pe => {
          const on = ag.periodo === pe;
          const c = PERIODO_COR[pe] || "#64748b";
          return (
            <button key={pe} onClick={() => onChange({ ...ag, periodo: pe })}
              style={{ background: on ? c : "#fff", color: on ? "#fff" : "#64748b", border: "1px solid " + (on ? c : "#e2e8f0"), borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{pe}</button>
          );
        })}
        <input value={ag.horaObs} placeholder="complemento (ex: saída 5h30)"
          onChange={e => onChange({ ...ag, horaObs: e.target.value })}
          style={{ ...inp, width: 180, fontSize: 11 }} />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input value={ag.endereco} placeholder="Endereço" onChange={e => onChange({ ...ag, endereco: e.target.value })}
          style={{ ...inp, flex: 2, minWidth: 150 }} />
        <input value={ag.referencia} placeholder="Referência" onChange={e => onChange({ ...ag, referencia: e.target.value })}
          style={{ ...inp, flex: 1, minWidth: 110 }} />
      </div>

      <textarea value={ag.descricao} placeholder="Descrição do serviço / anotações" rows={2}
        onChange={e => onChange({ ...ag, descricao: e.target.value })}
        style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>Repetir até</span>
        <input type="date" value={ate} min={addDays(ag.dia, 1)} onChange={e => setAte(e.target.value)}
          style={{ ...inp, width: 140 }} />
        <button disabled={!ate || ate <= ag.dia} onClick={() => { onRepetir(ag, ate); setAte(""); }}
          title="Cria este mesmo serviço nos dias úteis até a data escolhida"
          style={{ background: (!ate || ate <= ag.dia) ? "#f1f5f9" : "#1a1a1a", color: (!ate || ate <= ag.dia) ? "#94a3b8" : "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: (!ate || ate <= ag.dia) ? "default" : "pointer" }}>
          Repetir
        </button>
      </div>
    </div>
  );
}

// Tela do dia expandido: obras à esquerda, equipes à direita, arrasta e solta pra combinar.
function DiaAgenda({ dia, obras, equipes, agenda, onSalvar, onExcluir, onVoltar, onAbrirObra, onEmitirOS }) {
  const [busca, setBusca] = useState("");
  // Ref, não estado: o navegador lê no dragstart, antes de qualquer re-render (mesma razão do
  // arrastar da lista de obras).
  const arrastando = useRef(null);          // { obraId } | { avulso } | { agId }
  const [alvo, setAlvo] = useState(null);   // equipe sob o cursor

  const [y, m, d] = dia.split("-");
  const dow = DIAS_SEMANA_LONGO[dowDe(dia)];

  const agendaDoDia = agenda.filter(a => a.dia === dia);
  const ativas = obras.filter(o => o.status !== "Concluído");
  const q = busca.trim().toLowerCase();
  const listaObras = q
    ? ativas.filter(o => o.cliente.toLowerCase().includes(q) || o.numero.includes(q) || (o.obra || "").toLowerCase().includes(q) || (o.cidade || "").toLowerCase().includes(q))
    : ativas;

  const doEquipe = (eqId) => agendaDoDia.filter(a => a.equipeId === eqId).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  const semEquipe = agendaDoDia.filter(a => !equipes.some(e => e.id === a.equipeId));

  // Último dia antes deste que tem alguma coisa marcada — é o que "copiar do dia anterior" traz.
  const diaAnterior = agenda.filter(a => a.dia < dia).map(a => a.dia).sort().pop() || null;

  function limpar() { arrastando.current = null; setAlvo(null); }

  function soltarEm(equipeId) {
    const drag = arrastando.current;
    limpar();
    if (!drag) return;
    if (drag.agId) {                                    // mover serviço já criado para outra equipe
      const ag = agendaDoDia.find(a => a.id === drag.agId);
      if (ag && ag.equipeId !== equipeId) onSalvar({ ...ag, equipeId });
      return;
    }
    const obra = drag.obraId ? obras.find(o => o.id === drag.obraId) : null;
    onSalvar(novoAgendamento({ dia, equipeId, obra }));
  }

  function copiarDoDiaAnterior() {
    if (!diaAnterior) return;
    agenda.filter(a => a.dia === diaAnterior)
      .forEach((a, i) => onSalvar({ ...a, id: idAgendamento(), dia, ordem: Date.now() + i }));
  }

  // Repete o serviço nos dias úteis seguintes, até a data escolhida
  function repetir(ag, ate) {
    diasUteisEntre(addDays(ag.dia, 1), ate)
      .forEach((d2, i) => onSalvar({ ...ag, id: idAgendamento(), dia: d2, ordem: Date.now() + i }));
  }

  return (
    <div style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={onVoltar}
          style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>‹ Voltar ao mês</button>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a1a" }}>{d}/{m}/{y} — {dow}</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            {agendaDoDia.length === 0 ? "Nenhum serviço definido" : agendaDoDia.length + " serviço(s) distribuído(s)"}
          </div>
        </div>
        {diaAnterior && (
          <button onClick={copiarDoDiaAnterior} title={"Traz tudo que estava marcado em " + fmtDate(diaAnterior)}
            style={{ marginLeft: "auto", background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
            ⧉ Copiar do dia anterior ({fmtDate(diaAnterior)})
          </button>
        )}
        <button onClick={() => onEmitirOS(dia, dia)} disabled={agendaDoDia.length === 0}
          title={agendaDoDia.length === 0 ? "Distribua os serviços do dia primeiro" : "Imprime a O.S. deste dia, uma folha por equipe"}
          style={{ marginLeft: diaAnterior ? 0 : "auto", background: agendaDoDia.length ? "#c9a227" : "#e2e8f0", color: agendaDoDia.length ? "#fff" : "#94a3b8", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: agendaDoDia.length ? "pointer" : "not-allowed" }}>
          🖨️ Emitir O.S. do dia
        </button>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── Esquerda: obras + atividade avulsa ── */}
        <div style={{ width: 290, flexShrink: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>Arraste para uma equipe →</div>

          <div draggable
            onDragStart={e => { arrastando.current = { avulso: true }; if (e.dataTransfer) e.dataTransfer.setData("text/plain", "avulso"); }}
            onDragEnd={limpar}
            style={{ background: "#fffbeb", border: "1px dashed #c9a227", color: "#92400e", borderRadius: 8, padding: "8px 10px", fontSize: 12, fontWeight: 800, cursor: "grab", marginBottom: 10 }}>
            🔧 Atividade avulsa <span style={{ fontWeight: 500 }}>(fora das obras)</span>
          </div>

          <input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar obra..."
            style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 12, boxSizing: "border-box", marginBottom: 8 }} />

          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 520, overflowY: "auto" }}>
            {listaObras.map(o => (
              <div key={o.id} draggable
                onDragStart={e => { arrastando.current = { obraId: o.id }; if (e.dataTransfer) { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", o.id); } }}
                onDragEnd={limpar}
                title={(o.obra || "") + " " + (o.cidade || "")}
                style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 9px", cursor: "grab" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{o.numero} {o.cliente}</div>
                <div style={{ fontSize: 10, color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.cidade || "—"}</div>
              </div>
            ))}
            {listaObras.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", padding: 8 }}>Nenhuma obra encontrada</div>}
          </div>
        </div>

        {/* ── Direita: uma faixa por equipe (área de soltura) ── */}
        <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 12 }}>
          {equipes.length === 0 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "14px 18px", fontSize: 13, color: "#92400e" }}>
              Cadastre as equipes em <b>Equipes</b> para distribuir os serviços do dia.
            </div>
          )}
          {equipes.map(eq => {
            const lista = doEquipe(eq.id);
            const sobre = alvo === eq.id;
            return (
              <div key={eq.id}
                onDragOver={e => { e.preventDefault(); setAlvo(eq.id); }}
                onDragLeave={() => setAlvo(a => a === eq.id ? null : a)}
                onDrop={e => { e.preventDefault(); soltarEm(eq.id); }}
                style={{ background: sobre ? eq.cor + "10" : "#fff", border: "1px " + (sobre ? "dashed " : "solid ") + (sobre ? eq.cor : "#e2e8f0"), borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: eq.cor, display: "inline-block" }} />
                  <span style={{ fontWeight: 800, fontSize: 14, color: "#1e293b" }}>{eq.nome}</span>
                  {eq.integrantes.length > 0 && <span style={{ fontSize: 12, color: "#64748b" }}>— {eq.integrantes.join(" + ")}</span>}
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>{lista.length} serviço(s)</span>
                  <select value="" onChange={e => {
                      const v = e.target.value;
                      if (!v) return;
                      const obra = v === "__avulso" ? null : obras.find(o => o.id === v);
                      onSalvar(novoAgendamento({ dia, equipeId: eq.id, obra }));
                    }}
                    style={{ marginLeft: "auto", border: "1px dashed #c9a227", color: "#c9a227", background: "#fffbeb", borderRadius: 8, padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    <option value="">+ Adicionar</option>
                    <option value="__avulso">🔧 Atividade avulsa</option>
                    {ativas.map(o => <option key={o.id} value={o.id}>#{o.numero} {o.cliente}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {lista.map(ag => (
                    <CardAgendamento key={ag.id} ag={ag} obras={obras} cor={eq.cor}
                      onChange={onSalvar} onExcluir={onExcluir} onRepetir={repetir} onAbrirObra={onAbrirObra}
                      onArrastar={() => { arrastando.current = { agId: ag.id }; }} />
                  ))}
                  {lista.length === 0 && (
                    <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>
                      Solte uma obra aqui para dar serviço a esta equipe.
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Serviços cuja equipe foi excluída depois — não somem, ficam aqui para remanejar */}
          {semEquipe.length > 0 && (
            <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: "#dc2626", marginBottom: 8 }}>Sem equipe (equipe removida)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {semEquipe.map(ag => (
                  <CardAgendamento key={ag.id} ag={ag} obras={obras} cor="#dc2626"
                    onChange={onSalvar} onExcluir={onExcluir} onRepetir={repetir} onAbrirObra={onAbrirObra}
                    onArrastar={() => { arrastando.current = { agId: ag.id }; }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CalendarView({ obras, equipes, agenda, onSalvarAgendamento, onExcluirAgendamento, onSelectObra, onEmitirOS }) {
  const hoje = new Date();
  // O helper global hoje() está sombreado pelo Date acima, então monta a string a partir dele.
  const hojeISO = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
  const [ano, setAno] = useState(hoje.getFullYear());
  const [mes, setMes] = useState(hoje.getMonth()); // 0-11
  const [diaAberto, setDiaAberto] = useState(null); // "YYYY-MM-DD" — dia expandido, sem router
  const [emitindo, setEmitindo] = useState(false);
  const [osIni, setOsIni] = useState(hojeISO);
  const [osFim, setOsFim] = useState(hojeISO);

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

  const diaStr = (dia) => `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  // Serviços distribuídos naquele dia. É a única coisa que o calendário mostra: nada é deduzido
  // das datas da obra — a execução do dia é definida a mão aqui dentro.
  function agendaNoDia(dia) {
    const d = diaStr(dia);
    return agenda.filter(a => a.dia === d).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  }
  const corEquipe = (eqId) => (equipes.find(e => e.id === eqId) || {}).cor || "#64748b";
  const nomeEquipe = (eqId) => (equipes.find(e => e.id === eqId) || {}).nome || "Sem equipe";

  const ehHoje = (dia) => dia && ano === hoje.getFullYear() && mes === hoje.getMonth() && dia === hoje.getDate();

  // Prévia do que vai sair na impressão, para não emitir às cegas.
  const previa = agruparPorEquipe(agenda, equipes, osIni, osFim);
  const totalServicos = previa.reduce((n, g) => n + g.linhas.length, 0);

  // Semana de segunda a sábado, que é como a equipe trabalha.
  function semanaDe(base) {
    const dow = dowDe(base);
    const seg = addDays(base, dow === 0 ? -6 : 1 - dow);
    return [seg, addDays(seg, 5)];
  }
  function definirPeriodo(ini, fim) { setOsIni(ini); setOsFim(fim); }

  if (diaAberto) {
    return (
      <DiaAgenda dia={diaAberto} obras={obras} equipes={equipes} agenda={agenda}
        onSalvar={onSalvarAgendamento} onExcluir={onExcluirAgendamento}
        onVoltar={() => setDiaAberto(null)} onAbrirObra={onSelectObra}
        onEmitirOS={onEmitirOS} />
    );
  }

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
          <button onClick={() => { definirPeriodo(hojeISO, hojeISO); setEmitindo(true); }}
            title="Imprime a O.S. de um dia, de uma semana ou do período que você escolher"
            style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "0 14px", height: 34, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>🖨️ Emitir O.S.</button>
        </div>
      </div>

      <Modal open={emitindo} title="Emitir Ordem de Serviço" onClose={() => setEmitindo(false)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 14 }}>
          A O.S. sai da agenda: o que estiver distribuído no período vira uma folha por equipe.
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {[
            ["Hoje", () => definirPeriodo(hojeISO, hojeISO)],
            ["Esta semana", () => definirPeriodo(...semanaDe(hojeISO))],
            ["Próxima semana", () => definirPeriodo(...semanaDe(addDays(hojeISO, 7)))],
          ].map(([rotulo, aplicar]) => (
            <button key={rotulo} onClick={aplicar}
              style={{ background: "#f1f5f9", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{rotulo}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>De</div>
            <input type="date" value={osIni} onChange={e => setOsIni(e.target.value)}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 13 }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Até</div>
            <input type="date" value={osFim} min={osIni} onChange={e => setOsFim(e.target.value)}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 13 }} />
          </div>
        </div>

        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", marginBottom: 18 }}>
          {totalServicos === 0 ? (
            <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Nenhum serviço agendado neste período.</div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1a1a1a", marginBottom: 6 }}>
                {previa.length} folha(s) · {totalServicos} serviço(s)
              </div>
              {previa.map(g => (
                <div key={g.equipe ? g.equipe.id : "sem"} style={{ fontSize: 12, color: g.equipe ? "#475569" : "#dc2626", display: "flex", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, marginTop: 4, flexShrink: 0, background: g.equipe ? g.equipe.cor : "#dc2626" }} />
                  {g.equipe ? g.equipe.nome : "Sem equipe (equipe excluída)"} — {g.linhas.length} serviço(s)
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setEmitindo(false)}
            style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={() => { setEmitindo(false); onEmitirOS(osIni, osFim); }} disabled={totalServicos === 0 || osFim < osIni}
            style={{ background: totalServicos && osFim >= osIni ? "#c9a227" : "#e2e8f0", color: totalServicos && osFim >= osIni ? "#fff" : "#94a3b8", border: "none", borderRadius: 7, padding: "7px 16px", fontWeight: 700, fontSize: 12, cursor: totalServicos && osFim >= osIni ? "pointer" : "not-allowed" }}>
            Emitir
          </button>
        </div>
      </Modal>

      <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 16px", fontSize: 12, color: "#64748b", marginBottom: 16 }}>
        Clique num dia para distribuir os serviços: arraste a obra para a equipe, defina o período e escreva a descrição.
      </div>

      {/* Weekday header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginBottom: 6 }}>
        {DIAS_SEMANA.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>{d}</div>
        ))}
      </div>
      {/* Day cells */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6 }}>
        {celulas.map((dia, i) => {
          const lista = dia ? agendaNoDia(dia) : [];
          return (
            <div key={i}
              onClick={() => dia && setDiaAberto(diaStr(dia))}
              title={dia ? "Clique para definir os serviços do dia" : undefined}
              style={{ minHeight: 110, minWidth: 0, background: dia ? "#fff" : "transparent", borderRadius: 8, border: dia ? "1px solid #e2e8f0" : "none", padding: dia ? 6 : 0, boxShadow: ehHoje(dia) ? "0 0 0 2px #c9a227" : "none", cursor: dia ? "pointer" : "default" }}>
              {dia && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: ehHoje(dia) ? "#c9a227" : "#64748b", marginBottom: 4, textAlign: "right" }}>{dia}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {lista.slice(0, 4).map(ag => (
                      <div key={ag.id}
                        onClick={e => { if (ag.obraId) { e.stopPropagation(); onSelectObra(ag.obraId); } }}
                        title={`${nomeEquipe(ag.equipeId)} — ${tituloAgendamento(ag, obras)} · ${ag.periodo}${ag.descricao ? " · " + ag.descricao : ""}`}
                        style={{ background: corEquipe(ag.equipeId), color: "#fff", borderRadius: 4, padding: "2px 6px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tituloAgendamento(ag, obras)}
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
// Tela de uma pasta (Em Andamento / Concluídas): lista completa daquele grupo, com busca, filtro,
// ordenação e arrastar — igual ao Dashboard de antes, só que operando num subconjunto por status.
// KPIs recalculados aqui em cima do subconjunto é o que dá o "percentual real de execução".
function ObrasPasta({ obras: todas, pasta, onSelect, onStatusChange, onReorder, onFlagsChange, equipes }) {
  const obras = todas.filter(o => pasta === "concluidas" ? o.status === "Concluído" : o.status !== "Concluído");

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("Todos");
  // Ordenação escolhida sobrevive ao recarregar a página (a busca e o filtro, não: começam limpos)
  const [sortBy, setSortBy] = useState(() => lerPref("dash.sortBy", "ordem")); // ordem | numero | nome | pct | itens | pecas
  const [sortDir, setSortDir] = useState(() => lerPref("dash.sortDir", "asc")); // asc | desc
  useEffect(() => { gravarPref("dash.sortBy", sortBy); }, [sortBy]);
  useEffect(() => { gravarPref("dash.sortDir", sortDir); }, [sortDir]);
  // Ref (não estado): o navegador decide se o arrasto pode começar no próprio mousedown,
  // antes de qualquer re-render do React — um estado aqui chegaria tarde demais.
  const dragArmed = useRef(null);                   // id com alça pressionada (pode arrastar)
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

  // Ordenação escolhida (base crescente + direção). "ordem" = ordem manual/arrastar.
  // Sempre ordena explicitamente pelo campo `ordem` (com o mesmo fallback usado na carga inicial)
  // em vez de confiar na posição do array — assim funciona não importa como o estado foi atualizado.
  const dirF = sortDir === "asc" ? 1 : -1;
  const ordemDe = (o) => Number.isFinite(o.ordem) ? o.ordem : 1e9 + (Number(o.numero) || 0);
  const displayed = sortBy === "ordem" ? [...filtered].sort((a, b) => ordemDe(a) - ordemDe(b)) : [...filtered].sort((a, b) => {
    let r = 0;
    switch (sortBy) {
      case "numero": r = (Number(a.numero) || 0) - (Number(b.numero) || 0); break;
      case "nome":   r = a.cliente.localeCompare(b.cliente, "pt-BR"); break;
      case "pct":    r = pctObra(a) - pctObra(b); break;
      case "itens":  r = a.itens.length - b.itens.length; break;
      case "pecas":  r = pecasObra(a) - pecasObra(b); break;
    }
    return r * dirF;
  });

  // Reordenar (arrastar) só faz sentido na lista completa e na ordem manual
  const canReorder = !search && filterStatus === "Todos" && sortBy === "ordem";

  function limparDrag() { setDragId(null); setOverId(null); dragArmed.current = null; }

  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) { limparDrag(); return; }
    // Insere sempre ANTES do alvo, igual à linha preta que marca o ponto de soltura.
    // Usa `displayed` (já ordenado pelo campo `ordem`) — não `obras` cru, que preserva a ordem
    // de carregamento e fica dessincronizado da tela assim que algum `ordem` muda.
    const ids = displayed.map(o => o.id).filter(id => id !== dragId);
    const to = ids.indexOf(targetId);
    if (to < 0) { limparDrag(); return; }
    ids.splice(to, 0, dragId);
    onReorder(ids);
    limparDrag();
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

      {/* Panorama financeiro desta pasta */}
      <PanoramaFinanceiro obras={obras} />

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
        {sortBy !== "ordem" && (
          <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}
            title={sortDir === "asc" ? "Crescente (menor → maior)" : "Decrescente (maior → menor)"}
            style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 13, background: "#fff", cursor: "pointer", fontWeight: 700, color: "#1a1a1a" }}>
            {sortDir === "asc" ? "↑ Crescente" : "↓ Decrescente"}
          </button>
        )}
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
          const fin = finObra(os);
          const dias = diasDesdeContrato(os);
          const isDragging = dragId === os.id;
          const isOver = overId === os.id && dragId && dragId !== os.id;
          return (
            <div key={os.id}
              draggable={canReorder}
              onDragStart={e => {
                // Só arrasta se o gesto começou na alça ☰ (evita arrastar clicando no card inteiro)
                if (dragArmed.current !== os.id) { e.preventDefault(); return; }
                setDragId(os.id);
                if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", os.id); }
              }}
              onDragOver={e => { if (canReorder && dragId) { e.preventDefault(); setOverId(os.id); } }}
              onDrop={e => { e.preventDefault(); handleDrop(os.id); }}
              onDragEnd={limparDrag}
              style={{ background: "#fff", borderRadius: 12, padding: "18px 22px", boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0", borderTop: isOver ? "3px solid #1a1a1a" : "1px solid #e2e8f0", cursor: "pointer", transition: "box-shadow 0.15s", opacity: isDragging ? 0.4 : 1 }}
              onClick={() => onSelect(os.id)}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.07)"}
            >
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                {canReorder && (
                  <div
                    title="Arraste para reordenar"
                    onMouseDown={() => { dragArmed.current = os.id; }}
                    onMouseUp={() => { dragArmed.current = null; }}
                    onClick={e => e.stopPropagation()}
                    style={{ alignSelf: "center", color: "#94a3b8", fontSize: 20, lineHeight: 1, cursor: "grab", padding: "0 4px", userSelect: "none" }}
                  >☰</div>
                )}
                <div style={{ background: "#1a1a1a", color: "#fff", borderRadius: 8, padding: "6px 14px", fontWeight: 800, fontSize: 18, minWidth: 60, textAlign: "center" }}>
                  #{os.numero}
                </div>
                {precisaAlertaCompras(os) && (
                  <span title="Falta comprar mais do que ainda vai receber dessa obra" style={{ alignSelf: "center", fontSize: 20, lineHeight: 1 }}>🚩</span>
                )}
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
                {/* Informativo: o que ainda entra e o que ainda sai desta obra + contrato + bandeiras */}
                <div style={{ minWidth: 230, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700, textTransform: "uppercase" }}>● A Receber</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#f59e0b" }}>R$ {fmt(fin.aReceber)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#dc2626", fontWeight: 700, textTransform: "uppercase" }}>● A Pagar</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#dc2626" }}>R$ {fmt(fin.aPagar)}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>Contrato: {os.dataContrato ? fmtDate(os.dataContrato) : "a definir"}</span>
                    {dias !== null && (
                      <span title="Dias corridos desde a data do contrato" style={{ color: corDias(dias), fontWeight: 800 }}>
                        ⏱ {dias} dia{dias === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <FlagsObra flags={os.flags} onChange={fs => onFlagsChange(os.id, fs)} size={12} />
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

// Tela inicial de Obras: só os KPIs de tudo (sem separar por status) + as duas pastas.
// A lista de obras em si mora dentro de cada pasta (ObrasPasta, acima).
function Dashboard({ obras, onAbrirPasta }) {
  const totalPecas = obras.reduce((a, o) => a + o.itens.reduce((b, i) => b + (i.qtd || 0), 0), 0);
  const progMedio  = obras.length > 0
    ? Math.round(obras.reduce((a, o) => a + (o.itens.length > 0 ? o.itens.reduce((b, i) => b + itemPercentual(i), 0) / o.itens.length : 0), 0) / obras.length)
    : 0;
  const emAndamento = obras.filter(o => o.status !== "Concluído").length;
  const concluidas = obras.length - emAndamento;

  return (
    <div style={{ padding: "24px 28px" }}>
      {/* KPI cards — todas as obras, sem filtro por pasta */}
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

      {/* Panorama financeiro — todas as obras */}
      <PanoramaFinanceiro obras={obras} />

      {/* Pastas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {[
          { key: "andamento", label: "Em Andamento", count: emAndamento, sub: "obras ativas — aguardando, em andamento e atrasadas", accent: "#3b82f6" },
          { key: "concluidas", label: "Concluídas", count: concluidas, sub: "obras finalizadas — arquivo", accent: "#10b981" },
        ].map(({ key, label, count, sub, accent }) => (
          <div key={key} onClick={() => onAbrirPasta(key)}
            style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", borderLeft: `4px solid ${accent}`, cursor: "pointer", transition: "box-shadow 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.07)"}>
            <div style={{ fontSize: 32 }}>📁</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "#1e293b", marginTop: 8 }}>{label}</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{sub}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: accent, marginTop: 10 }}>{count}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ORDEM DE SERVIÇO ─────────────────────────────────────────────────────────
// A O.S. é a folha impressa da agenda do calendário — o que foi distribuído à mão em
// obra x equipe. Não sai das datas da obra (isso deduzia o dia errado) e não é salva
// nem numerada: o registro do que foi feito é a própria agenda.
function composicaoDe(equipe) {
  if (!equipe) return "";
  return equipe.integrantes && equipe.integrantes.length
    ? equipe.integrantes.join(" E ").toUpperCase()
    : (equipe.nome || "").toUpperCase();
}

// Serviços do período agrupados por equipe, na ordem do cadastro. O último grupo pode ser
// o balde dos serviços cuja equipe foi excluída — eles saem numa folha à parte em vez de
// desaparecerem calados da impressão.
function agruparPorEquipe(agenda, equipes, inicio, fim) {
  const noPeriodo = (agenda || [])
    .filter(a => a.dia >= inicio && a.dia <= fim)
    .sort((a, b) => a.dia.localeCompare(b.dia) || (a.ordem || 0) - (b.ordem || 0));
  const grupos = [];
  for (const eq of equipes) {
    const linhas = noPeriodo.filter(a => a.equipeId === eq.id);
    if (linhas.length) grupos.push({ equipe: eq, linhas });
  }
  const orfaos = noPeriodo.filter(a => !equipes.some(e => e.id === a.equipeId));
  if (orfaos.length) grupos.push({ equipe: null, linhas: orfaos });
  return grupos;
}

function OrdemServicoPrint({ agenda, obras, equipes, inicio, fim, onBack }) {
  const grupos = agruparPorEquipe(agenda, equipes, inicio, fim);
  const emissao = hoje();
  const umDia = inicio === fim;

  const th = { padding: "7px 8px", fontSize: 10, fontWeight: 800, textAlign: "left", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "2px solid #1a1a1a", whiteSpace: "nowrap" };
  const td = { padding: "7px 8px", fontSize: 11.5, borderBottom: "1px solid #e2e8f0", verticalAlign: "top" };

  return (
    <div style={{ background: "#fff", minHeight: "100vh", padding: "20px 24px" }}>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <button onClick={onBack} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Voltar</button>
        <span style={{ fontSize: 12.5, color: "#64748b" }}>
          {grupos.length} folha(s) — uma por equipe. Cada uma começa numa página nova.
        </span>
        <button onClick={() => window.print()} style={{ marginLeft: "auto", background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🖨️ Imprimir</button>
      </div>

      {grupos.length === 0 && (
        <div style={{ textAlign: "center", padding: 60, color: "#94a3b8", fontSize: 14 }}>
          Nenhum serviço agendado neste período.
        </div>
      )}

      {grupos.map((g, gi) => (
        <div key={g.equipe ? g.equipe.id : "sem-equipe"}
          style={{ pageBreakBefore: gi > 0 ? "always" : "auto", marginBottom: 40 }}>

          <div style={{ textAlign: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 1, color: "#1a1a1a" }}>ORDEM DE SERVIÇO</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 6, padding: "7px 12px", fontSize: 11.5, fontWeight: 700, marginBottom: 8, flexWrap: "wrap" }}>
            <span>{umDia ? `DIA: ${fmtDate(inicio)}` : `PERÍODO: ${fmtDate(inicio)} a ${fmtDate(fim)}`}</span>
            <span>EMISSÃO: {fmtDate(emissao)}</span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: g.equipe ? g.equipe.cor : "#dc2626" }}>
              {g.equipe
                ? (/^EQUIPE/i.test(g.equipe.nome) ? g.equipe.nome.toUpperCase() : `EQUIPE ${g.equipe.nome.toUpperCase()}`)
                : "SEM EQUIPE — serviços de equipe excluída"}
            </div>
            {g.equipe && composicaoDe(g.equipe) && (
              <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
                COMPOSIÇÃO: {composicaoDe(g.equipe)}
              </div>
            )}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Dia</th>
                <th style={th}>Obra</th>
                <th style={th}>Endereço</th>
                <th style={th}>Referência</th>
                <th style={th}>Horário</th>
                <th style={th}>Descrição</th>
              </tr>
            </thead>
            <tbody>
              {g.linhas.map((ag, i) => (
                <tr key={ag.id} style={{ background: i % 2 ? "#f8fafc" : "#fff" }}>
                  <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 700 }}>{fmtDiaSemana(ag.dia)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{tituloAgendamento(ag, obras)}</td>
                  <td style={td}>{ag.endereco || "—"}</td>
                  <td style={td}>{ag.referencia || "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {ag.periodo}{ag.horaObs ? ` · ${ag.horaObs}` : ""}
                  </td>
                  <td style={td}>{ag.descricao || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", gap: 30, marginTop: 44, flexWrap: "wrap" }}>
            {["Responsável pela Equipe", "Supervisor / Aprovação", "Cliente / Obra"].map(t => (
              <div key={t} style={{ flex: 1, minWidth: 170, textAlign: "center" }}>
                <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 5, fontSize: 10.5, color: "#475569" }}>{t}</div>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", fontSize: 9.5, color: "#94a3b8", marginTop: 14 }}>
            CENTAURO — Agenda de Serviços {emissao.split("-")[0]} | Documento gerado automaticamente
          </div>
        </div>
      ))}
    </div>
  );
}


// ─── MENU LATERAL ─────────────────────────────────────────────────────────────
function SideMenu({ open, onClose, onNav, onImport, current }) {
  const items = [
    { key: "dashboard", label: "Obras", icon: "🏠" },
    { key: "calendar", label: "Calendário", icon: "📅" },
    { key: "equipes", label: "Equipes", icon: "👷" },
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
function clampPercent(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
function clampDuracao(v) { return Math.max(0, Math.min(999, Math.round((Number(v) || 0) * 10) / 10)); }

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

// Modelo padrão de cronograma gerado a partir dos itens já extraídos de uma obra.
const GRUPOS_PRODUCAO = ["Corte", "Usinagem", "Montagem", "Expedição"];
const GRUPOS_INSTALACAO = ["Transporte", "Instalação", "Regulagem", "Acabamento"];

function nomeCurtoItem(item) {
  const base = (item.descricao || item.tipo || "Item").split("|")[0].trim() || "Item";
  return base.length > 60 ? base.slice(0, 57) + "…" : base;
}

function novoCronogramaComModelo(titulo, obra, temVidros) {
  const hoje = new Date().toISOString().split("T")[0];
  const nomeObra = (obra?.obra || "").trim() || titulo || "Projeto";
  const itens = obra?.itens || [];
  const tasks = [];
  let nextId = 1;
  const push = (nivel, nome, extra = {}) => {
    tasks.push({ id: nextId++, nivel, nome, durValor: 1, durUnid: "dias", percent: 0, predecessoras: [], inicioManual: "", comentario: "", ...extra });
  };

  push(0, nomeObra);

  push(1, "Suprimentos");
  push(2, "Metais");
  push(2, "Acessórios");
  if (temVidros) push(2, "Vidros");

  push(1, "Produção");
  for (const grupo of GRUPOS_PRODUCAO) {
    push(2, grupo);
    for (const item of itens) push(3, nomeCurtoItem(item), { descricaoCompleta: item.descricao || "" });
  }

  push(1, "Instalação");
  for (const grupo of GRUPOS_INSTALACAO) {
    push(2, grupo);
    for (const item of itens) push(3, nomeCurtoItem(item), { descricaoCompleta: item.descricao || "" });
  }

  return {
    id: "cr_" + Date.now(),
    titulo: titulo || nomeObra,
    obraId: obra ? obra.id : null,
    cliente: obra ? obra.cliente : "",
    config: { ...CONFIG_PADRAO, dataBase: hoje },
    tasks: renumerarIds(tasks),
  };
}
function toLocalInput(date) {
  if (!date) return "";
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function CronogramasView({ cronogramas, obras, onNovo, onNovoComModelo, onAbrir, onExcluir }) {
  const [criando, setCriando] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [obraId, setObraId] = useState("");
  const [perguntarVidros, setPerguntarVidros] = useState(false);
  const [aviso, setAviso] = useState("");

  const obraSelecionada = obras.find(o => o.id === obraId) || null;

  // Com obra vinculada o título é opcional: assume "Proposta <nº>", que já era a
  // convenção dos cronogramas existentes. Sem obra e sem título não há o que criar.
  const tituloPadrao = obraSelecionada ? `Proposta ${obraSelecionada.numero}` : "";
  function tituloFinal() { return titulo.trim() || tituloPadrao; }

  function limpar() {
    setPerguntarVidros(false); setCriando(false);
    setTitulo(""); setObraId(""); setAviso("");
  }

  function criar() {
    const t = tituloFinal();
    if (!t) { setAviso("Dê um título ao cronograma, ou vincule uma obra para ele herdar o nome."); return; }
    onNovo(t, obraSelecionada);
    limpar();
  }
  function criarComModelo() {
    if (!obraSelecionada) { setAviso("Escolha a obra: o modelo é gerado a partir dos itens dela."); return; }
    setAviso(""); setPerguntarVidros(true);
  }
  function confirmarModelo(temVidros) {
    onNovoComModelo(tituloFinal(), obraSelecionada, temVidros);
    limpar();
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
            <input value={titulo} onChange={e => { setTitulo(e.target.value); setAviso(""); }} autoFocus
              placeholder={tituloPadrao ? `${tituloPadrao} (opcional)` : "Ex: Ampliação GRIII"}
              onKeyDown={e => { if (e.key === "Enter") criar(); }}
              style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, boxSizing: "border-box" }} />
          </div>
          <div style={{ minWidth: 220 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Vincular a uma obra (opcional)</div>
            <select value={obraId} onChange={e => { setObraId(e.target.value); setAviso(""); }}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", fontSize: 14, background: "#fff", minWidth: 220 }}>
              <option value="">— Avulso —</option>
              {obras.map(o => <option key={o.id} value={o.id}>#{o.numero} {o.cliente}</option>)}
            </select>
          </div>
          <button onClick={criar} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Criar</button>
          <button onClick={criarComModelo} disabled={!obraSelecionada}
            title={obraSelecionada ? "Gera automaticamente a árvore Suprimentos / Produção / Instalação a partir dos itens da obra" : "Escolha a obra: o modelo sai dos itens dela"}
            style={{ background: obraSelecionada ? "#0ea5e9" : "#e2e8f0", color: obraSelecionada ? "#fff" : "#94a3b8", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: obraSelecionada ? "pointer" : "not-allowed" }}>
            Criar com modelo da obra
          </button>
          {aviso && (
            <div style={{ flexBasis: "100%", background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, fontWeight: 600 }}>
              {aviso}
            </div>
          )}
        </div>
      )}

      <Modal open={perguntarVidros} title="Esta obra contém vidros?" onClose={() => setPerguntarVidros(false)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 18 }}>
          Se sim, um grupo "Vidros" será criado dentro de Suprimentos, junto com Metais e Acessórios.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => confirmarModelo(false)} style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Não</button>
          <button onClick={() => confirmarModelo(true)} style={{ background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Sim</button>
        </div>
      </Modal>

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

function CronogramaEditor({ cronograma, onChange, obras, dirty, onSalvarAgora }) {
  const [c, setC] = useState(cronograma);
  const [sel, setSel] = useState(null);
  const [zoom, setZoom] = useState("dia"); // dia | semana
  const [zerarAlvo, setZerarAlvo] = useState(null); // id da task cujo % o usuário quer zerar em cascata
  const [expandidoId, setExpandidoId] = useState(null); // id da task-item com detalhes abertos
  const [comentarioDraft, setComentarioDraft] = useState("");
  const undoStack = useRef([]); // snapshots de `c` para Ctrl+Z (~20 níveis)
  const lastGroup = useRef({ key: null, time: 0 });
  const GROUP_MS = 800; // edições seguidas no mesmo campo viram 1 undo só

  useEffect(() => { setC(cronograma); }, [cronograma]);
  useEffect(() => {
    if (expandidoId == null) { setComentarioDraft(""); return; }
    setComentarioDraft(c.tasks.find(t => t.id === expandidoId)?.comentario || "");
  }, [expandidoId]);

  // groupKey (opcional): edições seguidas com a mesma chave dentro de GROUP_MS não empilham undo extra.
  const update = (next, groupKey) => {
    const now = Date.now();
    const sameGroup = groupKey && lastGroup.current.key === groupKey && (now - lastGroup.current.time) < GROUP_MS;
    if (!sameGroup) {
      undoStack.current.push(c);
      if (undoStack.current.length > 20) undoStack.current.shift();
    }
    lastGroup.current = { key: groupKey || null, time: now };
    setC(next);
    onChange(next);
  };

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        const prev = undoStack.current.pop();
        if (prev) { lastGroup.current = { key: null, time: 0 }; setC(prev); onChange(prev); }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChange]);

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
  const setTasks = (tasks, groupKey) => update({ ...c, tasks }, groupKey);
  const updTask = (id, patch, groupKey) => setTasks(c.tasks.map(t => t.id === id ? { ...t, ...patch } : t), groupKey ? `${id}:${groupKey}` : undefined);
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
    setTasks(renumerarIds(c.tasks.filter((_, i) => i !== selIdx)));
    setSel(null);
  }
  function zerarCascata(taskId) {
    const idx = c.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return;
    const idsAlvo = new Set([taskId, ...descendentesDe(c.tasks, idx).map(j => c.tasks[j].id)]);
    setTasks(c.tasks.map(t => idsAlvo.has(t.id) ? { ...t, percent: 0 } : t));
    setZerarAlvo(null);
  }

  const inp = { border: "1px solid #e2e8f0", borderRadius: 5, padding: "2px 5px", fontSize: 12, boxSizing: "border-box" };
  const COL = { id: 34, nome: 240, dur: 116, pct: 60, ini: 122, term: 118, pred: 58 };
  const GRID_W = Object.values(COL).reduce((a, b) => a + b, 0);
  const btn = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 10px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
  const obraVinculada = c.obraId ? obras.find(o => o.id === c.obraId) : null;

  // Linhas visíveis (respeitando pais colapsados) — grade e Gantt usam a mesma ordem/índice, para não desalinhar.
  const visIdxs = indicesVisiveis(c.tasks);
  const visIndexById = {};
  visIdxs.forEach((origI, visI) => { visIndexById[c.tasks[origI].id] = visI; });
  const ROWS_H = visIdxs.length * CR_ROW_H;

  return (
    <div style={{ fontFamily: "'Segoe UI', sans-serif", color: "#1e293b" }}>
      {/* Toolbar */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "10px 16px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={c.titulo} onChange={e => update({ ...c, titulo: e.target.value }, "titulo")}
          style={{ fontWeight: 800, fontSize: 15, color: BRAND, border: "1px solid transparent", borderRadius: 6, padding: "4px 8px", minWidth: 220 }}
          onFocus={e => e.target.style.border = "1px solid #e2e8f0"} onBlur={e => e.target.style.border = "1px solid transparent"} />
        {obraVinculada && <span style={{ fontSize: 12, color: "#64748b" }}>· Obra #{obraVinculada.numero} — {obraVinculada.cliente}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={addTarefa} style={btn}>+ Tarefa</button>
          <button onClick={() => indent(1)} style={btn} title="Indentar">→</button>
          <button onClick={() => indent(-1)} style={btn} title="Desindentar">←</button>
          <button onClick={() => mover(-1)} style={btn} title="Mover para cima">↑</button>
          <button onClick={() => mover(1)} style={btn} title="Mover para baixo">↓</button>
          <button onClick={excluir} style={{ ...btn, color: "#dc2626", borderColor: "#fecaca" }} title="Excluir">🗑</button>
          <button onClick={() => setZoom(z => z === "dia" ? "semana" : "dia")} style={btn} title="Zoom">{zoom === "dia" ? "🔍 Semana" : "🔍 Dia"}</button>
          <button onClick={() => onSalvarAgora && onSalvarAgora(c)} disabled={!dirty}
            title={dirty ? "Há alterações não salvas — clique para salvar agora" : "Tudo salvo"}
            style={{ ...btn, background: dirty ? "#10b981" : "#fff", color: dirty ? "#fff" : "#94a3b8", borderColor: dirty ? "#10b981" : "#e2e8f0", cursor: dirty ? "pointer" : "default" }}>
            {dirty ? "💾 Salvar" : "✓ Salvo"}
          </button>
        </div>
      </div>

      {/* Split: grade + gantt */}
      <div style={{ display: "flex", alignItems: "flex-start", overflowX: "auto" }}>
        {/* GRADE */}
        <div style={{ width: GRID_W, minWidth: GRID_W, borderRight: "2px solid #cbd5e1", background: "#fff", position: "relative" }}>
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
          {visIdxs.map((origI, i) => {
            const t = c.tasks[origI];
            const sc = sched[t.id] || {};
            const selRow = sel === t.id;
            const cor = t.nivel === 0 ? "#dc2626" : sc.isSummary ? BRAND : "#1e293b";
            return (
              <div key={t.id} onClick={() => setSel(t.id)}
                style={{ display: "flex", alignItems: "center", height: CR_ROW_H, borderBottom: "1px solid #f1f5f9", background: selRow ? "#eff6ff" : (i % 2 ? "#fafafa" : "#fff"), fontSize: 12, cursor: "pointer" }}>
                <div style={{ width: COL.id, textAlign: "center", color: "#94a3b8" }}>{t.id}</div>
                <div style={{ width: COL.nome, paddingLeft: 6 + t.nivel * 14, overflow: "hidden", display: "flex", alignItems: "center" }}>
                  {sc.isSummary && (
                    <button onClick={e => { e.stopPropagation(); updTask(t.id, { colapsada: !t.colapsada }); }}
                      title={t.colapsada ? "Expandir" : "Colapsar"} style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: "#64748b", fontSize: 11, padding: "0 4px 0 0", width: 14 }}>
                      {t.colapsada ? "▸" : "▾"}
                    </button>
                  )}
                  <input value={t.nome} onChange={e => updTask(t.id, { nome: e.target.value }, "nome")} onClick={e => e.stopPropagation()}
                    style={{ ...inp, border: "1px solid transparent", background: "transparent", width: "100%", fontWeight: (sc.isSummary || t.nivel === 0) ? 700 : 400, color: cor }} />
                  {t.descricaoCompleta && (
                    <button onClick={e => { e.stopPropagation(); setExpandidoId(id => id === t.id ? null : t.id); }}
                      title="Ver detalhes e comentário" style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: expandidoId === t.id ? BRAND : "#94a3b8", fontSize: 12, padding: "0 4px" }}>
                      {expandidoId === t.id ? "▾" : "▸"}
                    </button>
                  )}
                </div>
                <div style={{ width: COL.dur, textAlign: "center" }}>
                  {sc.isSummary
                    ? <span style={{ color: "#64748b", fontWeight: 600 }}>{textoDuracao(t, sc)}</span>
                    : <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", gap: 3 }}>
                        <input type="number" min={0} max={999} step="0.5" value={t.durValor} onChange={e => updTask(t.id, { durValor: clampDuracao(e.target.value) }, "durValor")} style={{ ...inp, width: 58, textAlign: "right" }} />
                        <select value={t.durUnid} onChange={e => updTask(t.id, { durUnid: e.target.value })} style={{ ...inp, width: 56, paddingRight: 2 }}>
                          <option value="dias">dias</option><option value="hrs">hrs</option>
                        </select>
                      </span>}
                </div>
                <div style={{ width: COL.pct, textAlign: "center" }}>
                  {sc.isSummary ? <b onClick={e => { e.stopPropagation(); setZerarAlvo(t.id); }} style={{ cursor: "pointer" }} title="Zerar percentual do grupo">{sc.percent}%</b>
                    : <input type="number" min={0} max={100} value={t.percent} onClick={e => e.stopPropagation()} onChange={e => updTask(t.id, { percent: clampPercent(e.target.value) }, "percent")} style={{ ...inp, width: 54, textAlign: "center" }} />}
                </div>
                <div style={{ width: COL.ini, textAlign: "center", fontSize: 11 }}>
                  {t.inicioManual
                    ? <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
                        <input type="datetime-local" value={t.inicioManual} onChange={e => updTask(t.id, { inicioManual: e.target.value }, "inicioManual")} style={{ ...inp, width: 96 }} />
                        <button onClick={() => updTask(t.id, { inicioManual: "" })} title="Auto" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94a3b8" }}>×</button>
                      </span>
                    : <span onClick={e => { e.stopPropagation(); if (!sc.isSummary) updTask(t.id, { inicioManual: toLocalInput(sc.inicio) }); }} title={sc.isSummary ? "" : "Fixar início"} style={{ cursor: sc.isSummary ? "default" : "pointer" }}>
                        {fmtDataHora(sc.inicio)}{!sc.isSummary && <span style={{ color: "#cbd5e1" }}> 📌</span>}
                      </span>}
                </div>
                <div style={{ width: COL.term, textAlign: "center", fontSize: 11, color: "#64748b" }}>{fmtDataHora(sc.termino)}</div>
                <div style={{ width: COL.pred, textAlign: "center" }}>
                  <input value={(t.predecessoras || []).join(",")} onClick={e => e.stopPropagation()}
                    onChange={e => updTask(t.id, { predecessoras: e.target.value.split(",").map(x => parseInt(x.trim(), 10)).filter(Boolean) }, "predecessoras")}
                    style={{ ...inp, width: 48, textAlign: "center" }} placeholder="—" />
                </div>
              </div>
            );
          })}

          {/* Painel de detalhes do item (overlay — não desloca a grade nem o Gantt) */}
          {expandidoId !== null && visIndexById[expandidoId] !== undefined && (() => {
            const t = c.tasks.find(x => x.id === expandidoId);
            if (!t) return null;
            return (
              <div onClick={e => e.stopPropagation()} style={{
                position: "absolute", left: 8, right: 8, top: (visIndexById[expandidoId] + 1) * CR_ROW_H + 4, zIndex: 30,
                background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.15)", padding: 12,
              }}>
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Descrição completa</div>
                <div style={{ fontSize: 13, color: "#1e293b", marginBottom: 10 }}>{t.descricaoCompleta || "—"}</div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Comentário</div>
                <textarea value={comentarioDraft} onChange={e => setComentarioDraft(e.target.value)} rows={3}
                  style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 6, padding: 8, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                  <button onClick={() => setExpandidoId(null)} style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Fechar</button>
                  <button onClick={() => { updTask(t.id, { comentario: comentarioDraft }); }} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 7, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Salvar comentário</button>
                </div>
              </div>
            );
          })()}
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
            <svg style={{ position: "absolute", top: 0, left: 0, width: TL_W, height: ROWS_H, pointerEvents: "none" }}>
              {visIdxs.map((origI, i) => { const t = c.tasks[origI]; return (t.predecessoras || []).map(pid => {
                const pi = visIndexById[pid];
                const ps = sched[pid], ss = sched[t.id];
                if (pi === undefined || !ps || !ss) return null;
                const x1 = ((ps.termino - tStart) / CR_DAY_MS) * DAY_W;
                const y1 = pi * CR_ROW_H + CR_ROW_H / 2;
                const x2 = ((ss.inicio - tStart) / CR_DAY_MS) * DAY_W;
                const y2 = i * CR_ROW_H + CR_ROW_H / 2;
                const mx = x1 + 6;
                return <polyline key={pid + "-" + t.id} points={`${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#94a3b8" strokeWidth="1" markerEnd="url(#arr)" />;
              }); })}
              <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" /></marker></defs>
            </svg>
            {/* barras */}
            {visIdxs.map((origI, i) => {
              const t = c.tasks[origI];
              const sc = sched[t.id]; if (!sc) return null;
              const x = ((sc.inicio - tStart) / CR_DAY_MS) * DAY_W;
              const w = Math.max(((sc.termino - sc.inicio) / CR_DAY_MS) * DAY_W, 4);
              const y = i * CR_ROW_H;
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
            {visIdxs.map((origI, i) => (
              <div key={c.tasks[origI].id} style={{ position: "absolute", left: 0, top: i * CR_ROW_H, width: TL_W, height: CR_ROW_H, borderBottom: "1px solid #f1f5f9", boxSizing: "border-box", pointerEvents: "none" }} />
            ))}
            <div style={{ height: ROWS_H }} />
          </div>
        </div>
      </div>

      <Modal open={zerarAlvo !== null} title="Zerar percentual" onClose={() => setZerarAlvo(null)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 18 }}>
          Isso vai zerar o percentual desta tarefa e de todas as subtarefas dentro dela. Confirma?
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setZerarAlvo(null)} style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={() => zerarCascata(zerarAlvo)} style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Zerar tudo</button>
        </div>
      </Modal>
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
  const [cronogramas, setCronogramas] = useState([]);
  const [agenda, setAgenda] = useState([]);   // serviços do dia (obra x equipe)
  // Navegação: view atual + pilha de histórico (botão voltar universal)
  const [view, setView] = useState({ type: "dashboard" });
  const [history, setHistory] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [financeiroUnlocked, setFinanceiroUnlocked] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const fileRef = useRef();
  const saveTimers = useRef({});
  const [dirtyCronoIds, setDirtyCronoIds] = useState(() => new Set()); // cronogramas com gravação pendente (debounce)
  const [pendingExit, setPendingExit] = useState(null); // ação de navegação adiada até o usuário decidir sobre alterações não salvas

  // Avisa antes de fechar a aba/navegador se houver cronograma com gravação pendente
  useEffect(() => {
    function handler(e) { if (dirtyCronoIds.size > 0) { e.preventDefault(); e.returnValue = ""; } }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCronoIds]);

  // Sessão de login
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Carrega pdf.js via CDN (para importação de PDF no browser). Injeção via DOM puro —
  // um <script> renderizado pelo React (dangerouslySetInnerHTML) não é executado pelo navegador.
  useEffect(() => {
    if (window.pdfjsLib) return;
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; };
    document.head.appendChild(s);
  }, []);

  // Carrega dados do banco após login
  useEffect(() => {
    if (!session) { setObras([]); setEquipes([]); setCronogramas([]); setAgenda([]); return; }
    let cancel = false;
    setLoading(true);
    (async () => {
      try {
        const [obs, eqs, crons, ags] = await Promise.all([fetchObras(), fetchEquipes(), fetchCronogramas(), fetchAgenda()]);
        if (cancel) return;
        setObras(obs.map(normObra).sort((a, b) => {
          const ao = Number.isFinite(a.ordem) ? a.ordem : 1e9 + (Number(a.numero) || 0);
          const bo = Number.isFinite(b.ordem) ? b.ordem : 1e9 + (Number(b.numero) || 0);
          return ao - bo;
        }));
        setEquipes(eqs);
        setCronogramas(crons);
        setAgenda(ags.map(normAgendamento));
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

  // Agenda: o estado muda na hora e a gravação é debounced por serviço (a descrição é digitada,
  // não vale um upsert por tecla). Mesmo padrão de persistObra.
  const handleSaveAgendamento = useCallback((ag) => {
    setAgenda(prev => prev.some(a => a.id === ag.id) ? prev.map(a => a.id === ag.id ? ag : a) : [...prev, ag]);
    const t = saveTimers.current;
    if (t[ag.id]) clearTimeout(t[ag.id]);
    t[ag.id] = setTimeout(() => {
      upsertAgendamento(ag).catch(err => showError("Erro ao salvar a agenda (rodou a migration_agenda.sql?): " + err.message));
    }, 700);
  }, []);

  const handleDeleteAgendamento = useCallback((id) => {
    const t = saveTimers.current;
    if (t[id]) { clearTimeout(t[id]); delete t[id]; }
    setAgenda(prev => prev.filter(a => a.id !== id));
    dbDeleteAgendamento(id).catch(err => showError("Erro ao remover da agenda: " + err.message));
  }, []);

  // Há um cronograma com gravação pendente e é justamente o que está aberto agora?
  const isCronoDirty = view.type === "cronograma" && dirtyCronoIds.has(view.id);
  // Roda a navegação direto, ou adia para depois de perguntar "salvar antes de sair?" se houver pendência.
  const guardNav = useCallback((run) => { if (isCronoDirty) setPendingExit(() => run); else run(); }, [isCronoDirty]);

  // Navega para uma nova view (empilha a atual no histórico)
  const navTo = useCallback((v) => guardNav(() => { setHistory(h => [...h, view]); setView(v); setMenuOpen(false); }), [view, guardNav]);
  // Substitui a view atual sem empilhar
  const navReplace = useCallback((v) => guardNav(() => { setView(v); setMenuOpen(false); }), [guardNav]);
  // Volta para a view anterior
  const back = useCallback(() => guardNav(() => {
    setHistory(h => {
      if (h.length === 0) { setView({ type: "dashboard" }); return h; }
      setView(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }), [guardNav]);
  const goHome = useCallback(() => guardNav(() => { setView({ type: "dashboard" }); setHistory([]); setMenuOpen(false); }), [guardNav]);
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

  // Bandeiras manuais da obra, alteradas direto no card da lista
  const handleFlagsChange = useCallback((id, flags) => {
    setObras(prev => {
      const next = prev.map(o => o.id === id ? { ...o, flags } : o);
      const changed = next.find(o => o.id === id);
      if (changed) persistObra(changed);
      return next;
    });
  }, [persistObra]);

  // Reordenação manual das obras (arrastar): grava o índice em `ordem` e persiste os que mudaram
  // Atualiza só o `ordem` dos ids recebidos, preservando o resto do array — importante porque
  // agora quem chama pode ser uma pasta (subconjunto), não só a lista completa.
  const handleReorder = useCallback((orderedIds) => {
    setObras(prev => {
      const novaOrdem = new Map(orderedIds.map((id, idx) => [id, idx]));
      const next = prev.map(o => novaOrdem.has(o.id) ? { ...o, ordem: novaOrdem.get(o.id) } : o);
      next.forEach(o => { const antes = prev.find(p => p.id === o.id); if (antes && antes.ordem !== o.ordem) persistObra(o); });
      return next;
    });
  }, [persistObra]);

  const handleSaveEquipe = useCallback((eq) => {
    setEquipes(prev => prev.some(e => e.id === eq.id) ? prev.map(e => e.id === eq.id ? eq : e) : [...prev, eq]);
    dbUpsertEquipe(eq).catch(err => showError("Erro ao salvar equipe: " + err.message));
  }, []);

  // Se a gravação falhar a equipe volta para a lista. Antes ela sumia da tela de
  // qualquer jeito e o usuário só descobria no F5, quando ela reaparecia sozinha.
  const handleDeleteEquipe = useCallback((id) => {
    let anterior = [];
    setEquipes(prev => { anterior = prev; return prev.filter(e => e.id !== id); });
    dbDeleteEquipe(id)
      .then(() => {
        // O confirm promete tirar a equipe das obras; até aqui isso nunca acontecia
        // e o id ficava pendurado em obra.equipes para sempre.
        setObras(prev => prev.map(o => {
          if (!(o.equipes || []).includes(id)) return o;
          const limpa = { ...o, equipes: o.equipes.filter(e => e !== id) };
          persistObra(limpa);
          return limpa;
        }));
      })
      .catch(err => {
        setEquipes(anterior);
        showError("Erro ao excluir equipe: " + err.message);
      });
  }, [persistObra]);

  const cronoTimer = useRef({});
  const handleSaveCronograma = useCallback((cr) => {
    setCronogramas(prev => {
      const exists = prev.find(x => x.id === cr.id);
      return exists ? prev.map(x => x.id === cr.id ? cr : x) : [cr, ...prev];
    });
    setDirtyCronoIds(prev => prev.has(cr.id) ? prev : new Set(prev).add(cr.id));
    const t = cronoTimer.current;
    if (t[cr.id]) clearTimeout(t[cr.id]);
    t[cr.id] = setTimeout(() => {
      upsertCronograma(cr)
        .then(() => setDirtyCronoIds(prev => { if (!prev.has(cr.id)) return prev; const n = new Set(prev); n.delete(cr.id); return n; }))
        .catch(err => showError("Erro ao salvar cronograma: " + err.message));
    }, 700);
  }, []);
  // Força gravação imediata (botão "Salvar" do editor / confirmação ao sair), sem esperar o debounce.
  const handleSaveCronogramaNow = useCallback(async (cr) => {
    const t = cronoTimer.current;
    if (t[cr.id]) { clearTimeout(t[cr.id]); delete t[cr.id]; }
    try {
      await upsertCronograma(cr);
      setDirtyCronoIds(prev => { if (!prev.has(cr.id)) return prev; const n = new Set(prev); n.delete(cr.id); return n; });
    } catch (err) {
      showError("Erro ao salvar cronograma: " + err.message);
    }
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
      const { _fallback, ...obra } = await parsePDFFileComIA(file);
      if (!obra.numero) throw new Error("Número da proposta não encontrado");
      const exists = obras.find(o => o.id === obra.id);
      const merged = exists ? { ...obra, status: exists.status, dataInicio: exists.dataInicio, equipes: exists.equipes } : obra;
      setObras(prev => exists ? prev.map(o => o.id === obra.id ? merged : o) : [...prev, merged]);
      await upsertObra(merged);
      if (_fallback) showError("Obra importada com extração local (IA indisponível) — confira os itens.");
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
  if (view.type === "osPrint") {
    return <OrdemServicoPrint agenda={agenda} obras={obras} equipes={equipes}
      inicio={view.inicio} fim={view.fim} onBack={back} />;
  }

  const userEmail = session.user?.email || "";
  const selectedObra = view.type === "gantt" ? obras.find(o => o.id === view.obraId) : null;
  const canGoBack = history.length > 0 || view.type !== "dashboard";
  const tituloView = { dashboard: "Obras", calendar: "Calendário de Obras", equipes: "Equipes", financeiro: "Financeiro", cronogramas: "Cronograma Comercial", cronograma: "Cronograma" };

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
          {selectedObra
            ? `#${selectedObra.numero} — ${selectedObra.cliente}`
            : view.type === "obrasPasta"
              ? (view.pasta === "concluidas" ? "📁 Obras Concluídas" : "📁 Obras em Andamento")
              : (tituloView[view.type] || "")}
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
            ? <CalendarView obras={obras} equipes={equipes} agenda={agenda}
                onSalvarAgendamento={handleSaveAgendamento} onExcluirAgendamento={handleDeleteAgendamento}
                onSelectObra={openObra}
                onEmitirOS={(inicio, fim) => navTo({ type: "osPrint", inicio, fim })} />
            : view.type === "equipes"
              ? <EquipesView equipes={equipes} onSalvar={handleSaveEquipe} onExcluir={handleDeleteEquipe} obras={obras} />
              : view.type === "cronogramas"
                ? <CronogramasView cronogramas={cronogramas} obras={obras}
                    onNovo={(titulo, obra) => { const cr = novoCronograma(titulo, obra); handleSaveCronograma(cr); navTo({ type: "cronograma", id: cr.id }); }}
                    onNovoComModelo={(titulo, obra, temVidros) => { const cr = novoCronogramaComModelo(titulo, obra, temVidros); handleSaveCronograma(cr); navTo({ type: "cronograma", id: cr.id }); }}
                    onAbrir={(id) => navTo({ type: "cronograma", id })}
                    onExcluir={handleDeleteCronograma} />
                : view.type === "cronograma"
                  ? (cronogramas.find(x => x.id === view.id)
                      ? <CronogramaEditor cronograma={cronogramas.find(x => x.id === view.id)} obras={obras} onChange={handleSaveCronograma}
                          dirty={dirtyCronoIds.has(view.id)} onSalvarAgora={handleSaveCronogramaNow} />
                      : <CenteredMsg>Cronograma não encontrado</CenteredMsg>)
                  : view.type === "financeiro"
                    ? <FinanceiroView obras={obras} unlocked={financeiroUnlocked} onUnlock={() => setFinanceiroUnlocked(true)} />
                    : view.type === "obrasPasta"
                      ? <ObrasPasta obras={obras} pasta={view.pasta} onSelect={openObra} onStatusChange={handleStatusChange} onReorder={handleReorder} onFlagsChange={handleFlagsChange} equipes={equipes} />
                      : <Dashboard obras={obras} onAbrirPasta={(pasta) => navTo({ type: "obrasPasta", pasta })} />
      }

      <Modal open={pendingExit !== null} title="Alterações não salvas" onClose={() => setPendingExit(null)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 18 }}>
          Este cronograma tem alterações que ainda não foram salvas. Deseja salvar antes de sair?
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={() => setPendingExit(null)} style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={() => { const run = pendingExit; setPendingExit(null); run && run(); }} style={{ background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Sair sem salvar</button>
          <button onClick={async () => {
            const cr = cronogramas.find(x => x.id === view.id);
            if (cr) await handleSaveCronogramaNow(cr);
            const run = pendingExit; setPendingExit(null); run && run();
          }} style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Salvar e sair</button>
        </div>
      </Modal>
    </div>
  );
}
