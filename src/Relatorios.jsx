// ─────────────────────────────────────────────────────────────────────────────
// RELATÓRIOS — folhas A4 com indicadores, gráficos e tabela, prontas para imprimir ou "Salvar como
// PDF" (mesma receita das outras folhas: view em tela cheia, .no-print, @page). Cada relatório é
// um retrato do momento: tudo é calculado dos dados na hora, nada é gravado.
//
//   avisos      Central de avisos — pendências por área, situação geral, matriz obra × área
//   carteira    Obras em andamento — status, etapa dos itens, progresso, tempo de contrato
//   financeiro  Contratado × recebido × a receber, compras por categoria (pede a senha dos valores)
//   compras     Situação das compras por categoria, entregas previstas, pendências por obra
//   agenda      Serviços do calendário num período — por dia, por equipe, por obra
//
// Os gráficos vêm de graficos.jsx; toda figura tem a tabela correspondente na mesma folha, porque
// impresso não tem "passar o mouse".
//
// Todo relatório abre completo. "⚙ Personalizar" recorta por obra, item, categoria, situação,
// equipe ou área e escolhe as partes da folha (ver FILTROS). O recorte sai impresso no cabeçalho.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import logoDark from "./assets/logo-dark.png";
import { fetchResumoAnexos } from "./api";
import { agruparSimples } from "./agrupamento";
import { AREAS, PESO_NIVEL, avisosDaObra, resumoPorArea } from "./avisos";
import { ETAPAS, itemPercentual, finObra, agruparObras, precisaAlertaCompras } from "./calculos";
import { CATEGORIAS_COMPRA, CATEGORIA_LABEL, situacaoItensCompra, comprasPorCategoria } from "./ComprasObra";
import { useSigilo } from "./Sigilo";
import { useEstadoSessao, gravarSessao } from "./rotas";
import { Cartao, Kpi, BarrasH, BarrasEmpilhadasH, Colunas, Rosca, BarraParte, SERIE, RAMPA, NEUTRO } from "./graficos";

export const RELATORIOS = [
  { tipo: "avisos", icone: "⚠️", titulo: "Central de avisos", desc: "O que falta em cada obra aberta: documentos, cadastro, prazos, orçar, comprar, medir. Gráfico por área e matriz obra × área.", paisagem: true },
  { tipo: "carteira", icone: "🏗️", titulo: "Obras em andamento", desc: "Status das obras, em que etapa estão os itens, progresso de cada obra e há quanto tempo o contrato foi assinado.", paisagem: false },
  { tipo: "compras", icone: "🛒", titulo: "Compras", desc: "Situação dos materiais por categoria, entregas previstas nas próximas semanas e o que falta orçar ou comprar em cada obra.", paisagem: false },
  { tipo: "agenda", icone: "📅", titulo: "Agenda e equipes", desc: "Serviços lançados no calendário num período: por dia, por equipe e por obra. Bom para fechar o mês.", paisagem: false, periodo: true },
  { tipo: "financeiro", icone: "💰", titulo: "Financeiro", desc: "Contratado, recebido, a receber e a pagar; obras com mais a receber e compras por categoria. Pede a senha dos valores.", paisagem: false },
];

const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnClaro = { background: "#fff", color: "#1a1a1a", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnDourado = { background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const th = { textAlign: "left", padding: "5px 7px", fontSize: 10, fontWeight: 700, color: "#fff", background: "#1a1a1a", whiteSpace: "nowrap" };
const td = { padding: "4px 7px", fontSize: 10.5, borderBottom: "1px solid #e2e8f0", verticalAlign: "top" };
const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const grade = (n) => ({ display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gap: 10, marginBottom: 10 });

const p2 = n => String(n).padStart(2, "0");
function hojeLocal() { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
const dataBR = iso => iso ? iso.split("-").reverse().join("/") : "—";
const diasEntre = (a, b) => Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / 86400000);
function somaDias(iso, n) { const d = new Date(iso + "T12:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
const reais = v => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const reaisCurto = v => {
  const n = Number(v || 0), a = Math.abs(n);
  if (a >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
  if (a >= 1e3) return "R$ " + Math.round(n / 1e3).toLocaleString("pt-BR") + " mil";
  return "R$ " + Math.round(n).toLocaleString("pt-BR");
};
const nomeObra = o => `#${o.numero} ${o.cliente || ""}`.trim();

// Primeiro e último dia do mês corrente — período padrão da agenda.
export function periodoPadrao() {
  const d = new Date();
  const ini = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-01`;
  const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { inicio: ini, fim: `${fim.getFullYear()}-${p2(fim.getMonth() + 1)}-${p2(fim.getDate())}` };
}

// ─── TELA: lista de relatórios ───────────────────────────────────────────────
export function RelatoriosHub({ onAbrir }) {
  // "Gerar completo" sempre abre sem filtro; "Personalizar" reabre o último recorte daquele relatório.
  const completo = (tipo) => { limparFiltroRelatorio(tipo); onAbrir(tipo, false); };
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", margin: "0 0 4px" }}>Relatórios</h2>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 18 }}>
        Cada relatório abre como uma folha A4 com indicadores, gráficos e tabela. Use <b>Imprimir</b> e escolha
        <b> “Salvar como PDF”</b> para guardar ou mandar por WhatsApp/e-mail. Os números são os de agora — gere de novo para atualizar.
        Em <b>Personalizar</b> você escolhe a obra, o item, a categoria ou a equipe e quais partes entram na folha.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
        {RELATORIOS.map(r => (
          <div key={r.tipo}
            style={{ textAlign: "left", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 26 }}>{r.icone}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a1a" }}>{r.titulo}</div>
            <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>{r.desc}</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>A4 {r.paisagem ? "paisagem" : "retrato"} · gráficos + tabela</div>
            <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 6 }}>
              <button onClick={() => completo(r.tipo)} style={{ ...btnEscuro, flex: 1, padding: "8px 10px" }}>Gerar completo</button>
              <button onClick={() => onAbrir(r.tipo, true)} style={{ ...btnClaro, flex: 1, padding: "8px 10px" }}>⚙ Personalizar…</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── FOLHA: moldura comum ────────────────────────────────────────────────────
function Folha({ titulo, subtitulo, paisagem, controles, filtro, onBack, children }) {
  const escopo = filtro ? descreverFiltro(filtro) : "";
  useEffect(() => {
    const antes = document.title;
    document.title = `${titulo} — ${dataBR(hojeLocal())}`;
    return () => { document.title = antes; };
  }, [titulo]);
  const agora = new Date();
  return (
    <div style={{ padding: 24, maxWidth: paisagem ? 1180 : 860, margin: "0 auto", color: "#1e293b", background: "#fff", minHeight: "100vh" }}>
      <style>{`
        @page { size: A4 ${paisagem ? "landscape" : "portrait"}; margin: 10mm; }
        @media print {
          html, body { background: #fff !important; }
          .rl-folha { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .rl-bloco, .rl-folha tr { break-inside: avoid; page-break-inside: avoid; }
          .rl-folha thead { display: table-header-group; }
          .rl-quebra { break-before: page; page-break-before: always; }
        }
      `}</style>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 14px" }}>
        <button onClick={onBack} style={btnEscuro}>← Voltar</button>
        {filtro && (
          <button onClick={() => filtro.setAberto(a => !a)}
            style={{ ...(filtro.aberto ? btnEscuro : btnClaro), padding: "7px 12px", fontSize: 12.5 }}>
            ⚙ Personalizar{filtro.ativo ? " •" : ""}
          </button>
        )}
        {filtro?.ativo && <button onClick={filtro.limpar} style={{ ...btnClaro, padding: "7px 12px", fontSize: 12.5 }}>↺ Relatório completo</button>}
        {controles}
        <button onClick={() => window.print()} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir / PDF</button>
      </div>
      {filtro?.aberto && <PainelFiltro {...filtro} />}
      <div className="rl-folha">
        <div style={{ display: "flex", alignItems: "center", gap: 16, borderBottom: "3px solid #1a1a1a", paddingBottom: 8, marginBottom: 12 }}>
          <img src={logoDark} alt="Centauro Esquadrias" style={{ height: 38 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: "#64748b", textTransform: "uppercase" }}>Relatório</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a1a" }}>{titulo}</div>
            {subtitulo && <div style={{ fontSize: 11.5, color: "#475569" }}>{subtitulo}</div>}
            {escopo && <div style={{ fontSize: 11, color: "#1e293b", marginTop: 2 }}><b>Recorte:</b> {escopo}</div>}
          </div>
          <div style={{ textAlign: "right", fontSize: 10.5, color: "#64748b" }}>
            Emitido em<br /><b style={{ color: "#1e293b", fontSize: 11.5 }}>{dataBR(hojeLocal())} {p2(agora.getHours())}:{p2(agora.getMinutes())}</b>
          </div>
        </div>
        {children}
        <div style={{ marginTop: 16, fontSize: 9.5, color: "#94a3b8", textAlign: "center" }}>
          Centauro Esquadrias — Gestão de Obras · números calculados no momento da emissão
        </div>
      </div>
    </div>
  );
}

function Opcao({ checked, onChange, children }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {children}
    </label>
  );
}

// ─── FILTROS ─────────────────────────────────────────────────────────────────
// Lista vazia = tudo (o relatório completo). O filtro mora na sessão da aba, um por tipo de
// relatório: sobrevive ao voltar e ao F5, e "Gerar completo" no hub zera. `obras` com ids
// escolhidos à mão ignora o "incluir concluídas" — quem escolheu a obra quer ver a obra.
const SECOES = {
  avisos: [["kpis", "Indicadores"], ["graficos", "Gráficos"], ["matriz", "Matriz obra × área"], ["detalhes", "O que falta em cada obra"]],
  carteira: [["kpis", "Indicadores"], ["graficos", "Gráficos"], ["tabela", "Tabela de contratos"], ["itens", "Itens de cada obra (etapa e %)"]],
  compras: [["kpis", "Indicadores"], ["graficos", "Gráficos"], ["entregas", "Entregas atrasadas e próximas"], ["pendencias", "O que falta em cada obra"], ["detalhe", "Detalhe dos itens (orçamentos, compra, entrega, NF)"]],
  agenda: [["kpis", "Indicadores"], ["graficos", "Gráficos"], ["equipes", "Tabela por equipe"], ["obras", "Tabela por obra"], ["lista", "Lista dia a dia dos serviços"]],
  financeiro: [["kpis", "Indicadores"], ["graficos", "Gráficos"], ["tabela", "Tabela por obra"], ["categorias", "Compras por categoria de cada obra"]],
};
// Partes novas, mais longas, que o relatório completo de antes não tinha: começam desligadas.
const DESLIGADAS = { carteira: ["itens"], compras: ["detalhe"], agenda: ["lista"], financeiro: ["categorias"] };
const STATUS_ABERTOS = ["Em andamento", "Aguardando", "Atrasado"];

export function filtroPadrao(tipo) {
  return {
    obras: [], itens: [], concluidas: false, info: false,
    categorias: [], situacoes: [], status: [], areas: [], equipes: [],
    secoes: Object.fromEntries((SECOES[tipo] || []).map(([k]) => [k, !(DESLIGADAS[tipo] || []).includes(k)])),
  };
}
const chaveFiltro = tipo => `rel.filtro.${tipo}`;
export function limparFiltroRelatorio(tipo) { gravarSessao(chaveFiltro(tipo), filtroPadrao(tipo)); }

function useFiltro(tipo) {
  const padrao = filtroPadrao(tipo);
  const [bruto, setBruto] = useEstadoSessao(chaveFiltro(tipo), padrao);
  const junta = b => ({ ...padrao, ...(b || {}), secoes: { ...padrao.secoes, ...(b?.secoes || {}) } });
  const f = junta(bruto);
  const set = patch => setBruto(prev => { const base = junta(prev); return { ...base, ...(typeof patch === "function" ? patch(base) : patch) }; });
  return { f, set, ativo: JSON.stringify(f) !== JSON.stringify(padrao), limpar: () => setBruto(padrao) };
}

const passa = (lista, v) => !lista.length || lista.includes(v);
const alterna = (lista, v) => lista.includes(v) ? lista.filter(x => x !== v) : [...lista, v];

function obrasDoFiltro(obras, f) {
  if (f.obras.length) { const sel = new Set(f.obras); return obras.filter(o => sel.has(o.id)); }
  return f.concluidas ? obras : obras.filter(o => o.status !== "Concluído");
}
const chaveItemObra = (obraId, itemId) => `${obraId}|${itemId}`;
const chaveItemCompra = (obraId, l) => `${obraId}|${l.cat}|${l.itemId || "vazio"}`;

// O texto do recorte que vai impresso no cabeçalho. Vazio = relatório completo.
function descreverFiltro({ tipo, f, obras, equipes }) {
  const p = [];
  if (f.obras.length) {
    const nomes = f.obras.map(id => obras.find(o => o.id === id)).filter(Boolean).map(o => `#${o.numero} ${o.cliente || ""}`.trim());
    p.push(nomes.length > 4 ? `${nomes.length} contratos (${nomes.slice(0, 3).join(", ")}…)` : nomes.join(", "));
  } else if (f.concluidas && tipo !== "agenda") p.push("inclui concluídas");
  if (f.itens.length) p.push(`${f.itens.length} item(ns) escolhido(s)`);
  if (tipo === "compras") {
    if (f.categorias.length) p.push("categorias: " + f.categorias.map(c => CATEGORIA_LABEL[c]).join(", "));
    if (f.situacoes.length) p.push("situação: " + f.situacoes.map(k => GRUPOS_SIT.find(g => g.k === k)?.rotulo).join(", "));
  }
  if (tipo === "carteira" && f.status.length) p.push("status: " + f.status.join(", "));
  if (tipo === "avisos" && f.areas.length) p.push("áreas: " + f.areas.map(k => AREAS.find(a => a.k === k)?.rotulo).join(", "));
  if (tipo === "agenda" && f.equipes.length) p.push("equipes: " + f.equipes.map(id => id === "_" ? "Sem equipe" : equipes.find(e => e.id === id)?.nome || "?").join(", "));
  return p.join(" · ");
}

function Chip({ on, onClick, children, cor }) {
  return (
    <button onClick={onClick}
      style={{ background: on ? (cor || "#1a1a1a") : "#fff", color: on ? "#fff" : "#334155", border: `1px solid ${on ? (cor || "#1a1a1a") : "#cbd5e1"}`, borderRadius: 999, padding: "4px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
      {children}
    </button>
  );
}
function GrupoFiltro({ titulo, dica, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5 }}>
        {titulo}{dica && <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>{dica}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{children}</div>
    </div>
  );
}

// Escolha de obras: agrupadas por cliente (o grupo marca todos os contratos), com busca.
function EscolhaObras({ obras, selecionadas, onChange }) {
  const [busca, setBusca] = useState("");
  const [verConcluidas, setVerConcluidas] = useState(false);
  const sel = new Set(selecionadas);
  const q = busca.trim().toLowerCase();
  const base = obras.filter(o => verConcluidas || o.status !== "Concluído" || sel.has(o.id))
    .filter(o => !q || `${o.numero} ${o.cliente || ""} ${o.obra || ""} ${o.cidade || ""}`.toLowerCase().includes(q));
  const grupos = agruparSimples(base).sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
  const marcarGrupo = (g, on) => {
    const ids = g.contratos.map(o => o.id);
    onChange(on ? [...new Set([...selecionadas, ...ids])] : selecionadas.filter(id => !ids.includes(id)));
  };
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por nº, cliente, obra ou cidade…"
          style={{ flex: 1, minWidth: 200, border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 10px", fontSize: 12.5 }} />
        <Opcao checked={verConcluidas} onChange={setVerConcluidas}>Mostrar concluídas</Opcao>
        {selecionadas.length > 0 && <button onClick={() => onChange([])} style={{ ...btnClaro, padding: "5px 10px", fontSize: 12 }}>Todas as obras</button>}
      </div>
      <div style={{ maxHeight: 210, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff" }}>
        {grupos.length === 0 && <div style={{ padding: 10, fontSize: 12, color: "#94a3b8" }}>Nenhuma obra encontrada.</div>}
        {grupos.map(g => {
          const todos = g.contratos.every(o => sel.has(o.id));
          return (
            <div key={g.chave} style={{ borderBottom: "1px solid #f1f5f9", padding: "5px 10px" }}>
              {g.contratos.length > 1 && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                  <input type="checkbox" checked={todos} onChange={e => marcarGrupo(g, e.target.checked)} /> {g.nome}
                  <span style={{ fontWeight: 500, color: "#94a3b8", fontSize: 11 }}>({g.contratos.length} contratos — obra inteira)</span>
                </label>
              )}
              {g.contratos.map(o => (
                <label key={o.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, cursor: "pointer", paddingLeft: g.contratos.length > 1 ? 20 : 0, color: o.status === "Concluído" ? "#94a3b8" : "#1e293b" }}>
                  <input type="checkbox" checked={sel.has(o.id)} onChange={() => onChange(alterna(selecionadas, o.id))} />
                  <b>#{o.numero}</b> {g.contratos.length > 1 ? (o.obra || "") : o.cliente}
                  {g.contratos.length === 1 && o.obra ? <span style={{ color: "#64748b" }}>· {o.obra}</span> : null}
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8" }}>{o.status}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Escolha de itens dentro das obras escolhidas: itens do orçamento (carteira) ou de compra (compras).
function EscolhaItens({ grupos, selecionados, onChange }) {
  const todos = grupos.flatMap(g => g.itens.map(i => i.k));
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#64748b" }}>{selecionados.length ? `${selecionados.length} de ${todos.length} escolhido(s)` : `Todos os ${todos.length} itens`}</span>
        {selecionados.length > 0 && <button onClick={() => onChange([])} style={{ ...btnClaro, padding: "3px 9px", fontSize: 11.5 }}>Todos os itens</button>}
      </div>
      <div style={{ maxHeight: 210, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", padding: "4px 10px" }}>
        {grupos.map(g => (
          <div key={g.titulo} style={{ marginBottom: 4 }}>
            {grupos.length > 1 && <div style={{ fontSize: 11.5, fontWeight: 800, color: "#475569", padding: "4px 0 2px" }}>{g.titulo}</div>}
            {g.itens.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8" }}>Sem itens.</div>}
            {g.itens.map(i => (
              <label key={i.k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, cursor: "pointer", padding: "1px 0" }}>
                <input type="checkbox" checked={selecionados.includes(i.k)} onChange={() => onChange(alterna(selecionados, i.k))} /> {i.rotulo}
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PainelFiltro({ tipo, f, set, limpar, ativo, obras, equipes, setAberto }) {
  const escolhidas = f.obras.length ? obras.filter(o => f.obras.includes(o.id)) : [];
  // Item só se escolhe com a obra escolhida: "o item X" não faz sentido em todas as obras juntas.
  let gruposItens = null;
  if (escolhidas.length && tipo === "carteira") {
    gruposItens = escolhidas.map(o => ({ titulo: nomeObra(o), itens: (o.itens || []).map(i => ({ k: chaveItemObra(o.id, i.id), rotulo: `${i.tipo || "Item " + i.id} — ${i.descricao || ""}` })) }));
  }
  if (escolhidas.length && tipo === "compras") {
    gruposItens = escolhidas.map(o => ({ titulo: nomeObra(o), itens: situacaoItensCompra(o).filter(l => passa(f.categorias, l.cat)).map(l => ({ k: chaveItemCompra(o.id, l), rotulo: l.vazio ? `${l.nome} (nada lançado)` : l.nome })) }));
  }
  const secao = (k, v) => set(x => ({ secoes: { ...x.secoes, [k]: v } }));
  return (
    <div className="no-print" style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 16px", marginTop: -8, marginBottom: 18 }}>
      <GrupoFiltro titulo="De quais obras" dica={f.obras.length ? "" : "— nenhuma marcada = todas"}>
        <EscolhaObras obras={obras} selecionadas={f.obras}
          onChange={ids => set(x => ({ obras: ids, itens: x.itens.filter(k => ids.includes(k.split("|")[0])) }))} />
      </GrupoFiltro>
      {tipo !== "agenda" && !f.obras.length && (
        <div style={{ marginBottom: 12 }}><Opcao checked={f.concluidas} onChange={v => set({ concluidas: v })}>Incluir obras concluídas</Opcao></div>
      )}
      {gruposItens && (
        <GrupoFiltro titulo={tipo === "compras" ? "Quais itens de compra" : "Quais itens da obra"} dica="— nenhum marcado = a obra inteira">
          <EscolhaItens grupos={gruposItens} selecionados={f.itens} onChange={k => set({ itens: k })} />
        </GrupoFiltro>
      )}
      {!gruposItens && (tipo === "carteira" || tipo === "compras") && (
        <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 12 }}>Marque uma obra acima para escolher itens específicos dela.</div>
      )}
      {tipo === "compras" && (<>
        <GrupoFiltro titulo="Categorias" dica={f.categorias.length ? "" : "— todas"}>
          {CATEGORIAS_COMPRA.map(c => <Chip key={c} on={f.categorias.includes(c)} onClick={() => set(x => ({ categorias: alterna(x.categorias, c) }))}>{CATEGORIA_LABEL[c]}</Chip>)}
        </GrupoFiltro>
        <GrupoFiltro titulo="Situação" dica={f.situacoes.length ? "" : "— todas"}>
          {GRUPOS_SIT.map(g => <Chip key={g.k} cor={g.cor} on={f.situacoes.includes(g.k)} onClick={() => set(x => ({ situacoes: alterna(x.situacoes, g.k) }))}>{g.rotulo}</Chip>)}
        </GrupoFiltro>
      </>)}
      {tipo === "carteira" && (
        <GrupoFiltro titulo="Status" dica={f.status.length ? "" : "— todos"}>
          {[...STATUS_ABERTOS, "Concluído"].map(st => <Chip key={st} on={f.status.includes(st)} onClick={() => set(x => ({ status: alterna(x.status, st) }))}>{st}</Chip>)}
        </GrupoFiltro>
      )}
      {tipo === "avisos" && (<>
        <GrupoFiltro titulo="Áreas" dica={f.areas.length ? "" : "— todas"}>
          {AREAS.map(a => <Chip key={a.k} on={f.areas.includes(a.k)} onClick={() => set(x => ({ areas: alterna(x.areas, a.k) }))}>{a.rotulo}</Chip>)}
        </GrupoFiltro>
        <div style={{ marginBottom: 12 }}><Opcao checked={f.info} onChange={v => set({ info: v })}>Incluir avisos informativos</Opcao></div>
      </>)}
      {tipo === "agenda" && (
        <GrupoFiltro titulo="Equipes" dica={f.equipes.length ? "" : "— todas"}>
          {[...equipes.filter(e => !e.arquivada), { id: "_", nome: "Sem equipe" }].map(e => <Chip key={e.id} on={f.equipes.includes(e.id)} onClick={() => set(x => ({ equipes: alterna(x.equipes, e.id) }))}>{e.nome}</Chip>)}
        </GrupoFiltro>
      )}
      <GrupoFiltro titulo="O que entra na folha">
        {(SECOES[tipo] || []).map(([k, rot]) => <Opcao key={k} checked={!!f.secoes[k]} onChange={v => secao(k, v)}>{rot}</Opcao>)}
      </GrupoFiltro>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {ativo && <button onClick={limpar} style={{ ...btnClaro, padding: "6px 12px", fontSize: 12.5 }}>↺ Voltar ao relatório completo</button>}
        <button onClick={() => setAberto(false)} style={{ ...btnEscuro, padding: "6px 14px", fontSize: 12.5 }}>Ver a folha</button>
      </div>
    </div>
  );
}

const Titulo = ({ children }) => <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>{children}</div>;

// ─── DESPACHO ────────────────────────────────────────────────────────────────
export default function RelatorioPrint({ tipo, obras, agenda, cronogramas, equipes, inicio, fim, personalizar, onPeriodo, onBack }) {
  const { f, set, ativo, limpar } = useFiltro(tipo);
  const [aberto, setAberto] = useState(!!personalizar);
  const filtro = { tipo, f, set, ativo, limpar, aberto, setAberto, obras, equipes };
  const props = { obras, agenda, cronogramas, equipes, onBack, f, filtro };
  if (tipo === "avisos") return <RelAvisos {...props} />;
  if (tipo === "carteira") return <RelCarteira {...props} />;
  if (tipo === "compras") return <RelCompras {...props} />;
  if (tipo === "financeiro") return <RelFinanceiro {...props} />;
  if (tipo === "agenda") return <RelAgenda {...props} inicio={inicio} fim={fim} onPeriodo={onPeriodo} />;
  return <Folha titulo="Relatório" onBack={onBack}><div style={{ padding: 40, color: "#94a3b8" }}>Relatório não encontrado.</div></Folha>;
}

// ─── 1. CENTRAL DE AVISOS ────────────────────────────────────────────────────
const COR_NIVEL = { erro: SERIE[7], atencao: SERIE[3], info: SERIE[0] };
const ROTULO_NIVEL = { erro: "Crítico", atencao: "Atenção", info: "Informativo" };
const ICONE_NIVEL = { erro: "✕", atencao: "!", info: "•" };

function Selo({ nivel }) {
  const cor = nivel ? COR_NIVEL[nivel] : "#16a34a";
  return (
    <span style={{ display: "inline-block", width: 16, height: 16, lineHeight: "16px", borderRadius: 4, textAlign: "center", fontSize: 10, fontWeight: 800,
      background: nivel ? cor + "26" : "#dcfce7", color: nivel === "atencao" ? "#92400e" : nivel ? cor : "#166534" }}>
      {nivel ? ICONE_NIVEL[nivel] : "✓"}
    </span>
  );
}

function RelAvisos({ obras, agenda, cronogramas, onBack, f, filtro }) {
  const [anexos, setAnexos] = useState(undefined);
  const comInfo = f.info, comConcluidas = f.concluidas || f.obras.length > 0;
  const sec = f.secoes;
  const areasVis = f.areas.length ? AREAS.filter(a => f.areas.includes(a.k)) : AREAS;
  const chaveF = JSON.stringify([f.obras, f.concluidas, f.areas]);
  useEffect(() => { let c = false; fetchResumoAnexos().then(m => { if (!c) setAnexos(m); }); return () => { c = true; }; }, []);

  const linhas = useMemo(() => {
    const ctx = { anexos: anexos || null, agenda, cronogramas };
    const piso = comInfo ? 1 : 2;
    return obrasDoFiltro(obras, f).map(o => {
      const av = avisosDaObra(o, ctx).filter(a => PESO_NIVEL[a.nivel] >= piso && passa(f.areas, a.area));
      return { obra: o, avisos: av, resumo: resumoPorArea(av) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obras, agenda, cronogramas, anexos, comInfo, chaveF]);

  const niveis = comInfo ? ["erro", "atencao", "info"] : ["erro", "atencao"];
  const series = niveis.map(n => ({ k: n, rotulo: ROTULO_NIVEL[n], cor: COR_NIVEL[n], icone: ICONE_NIVEL[n] }));
  const porArea = areasVis.map(a => {
    const partes = {};
    for (const l of linhas) { const n = l.resumo[a.k]; if (n) partes[n] = (partes[n] || 0) + 1; }
    return { rotulo: a.rotulo, partes };
  });
  const comCritico = linhas.filter(l => l.avisos.some(a => a.nivel === "erro")).length;
  const soAtencao = linhas.filter(l => l.avisos.length && !l.avisos.some(a => a.nivel === "erro")).length;
  const limpos = linhas.length - comCritico - soAtencao;
  const totalAvisos = linhas.reduce((s, l) => s + l.avisos.length, 0);
  const ranking = [...linhas].filter(l => l.avisos.length).sort((a, b) => b.avisos.length - a.avisos.length).slice(0, 10)
    .map(l => ({ rotulo: nomeObra(l.obra), valor: l.avisos.length, cor: l.avisos.some(a => a.nivel === "erro") ? COR_NIVEL.erro : COR_NIVEL.atencao }));
  const porId = new Map(linhas.map(l => [l.obra.id, l]));
  const grupos = agruparSimples(linhas.map(l => l.obra)).map(g => ({ ...g, linhas: g.contratos.map(o => porId.get(o.id)) }))
    .sort((a, b) => Math.max(...b.linhas.map(l => l.avisos.length)) - Math.max(...a.linhas.map(l => l.avisos.length)));

  return (
    <Folha titulo="Central de avisos" paisagem onBack={onBack} filtro={filtro}
      subtitulo={`${linhas.length} contrato${linhas.length === 1 ? "" : "s"} ${comConcluidas ? "(inclui concluídos)" : "em aberto"} · ${comInfo ? "críticos, atenção e informativos" : "críticos e atenção"}`}
      controles={anexos === undefined && <span style={{ fontSize: 12, color: "#94a3b8" }}>Lendo anexos…</span>}>
      {sec.kpis && <div style={grade(4)}>
        <Kpi rotulo="Contratos analisados" valor={linhas.length} />
        <Kpi rotulo="Com pendência crítica" valor={comCritico} destaque={COR_NIVEL.erro} sub={linhas.length ? `${Math.round(comCritico / linhas.length * 100)}% dos contratos` : ""} />
        <Kpi rotulo="Só pendências de atenção" valor={soAtencao} destaque={COR_NIVEL.atencao} />
        <Kpi rotulo="Sem pendência" valor={limpos} destaque="#1baf7a" sub={`${totalAvisos} avisos no total`} />
      </div>}
      {sec.graficos && <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10, marginBottom: 10 }}>
        <Cartao titulo="Contratos com pendência, por área" sub="Cada contrato conta uma vez por área, pelo pior aviso dela">
          <BarrasEmpilhadasH dados={porArea} series={series} larguraRotulo={110} />
        </Cartao>
        <div style={{ display: "grid", gap: 10 }}>
          <Cartao titulo="Situação geral dos contratos">
            <Rosca tamanho={120} sub="contratos" dados={[
              { rotulo: "Com crítico", valor: comCritico, cor: COR_NIVEL.erro, icone: "✕" },
              { rotulo: "Só atenção", valor: soAtencao, cor: COR_NIVEL.atencao, icone: "!" },
              { rotulo: "Sem pendência", valor: limpos, cor: "#1baf7a", icone: "✓" },
            ]} />
          </Cartao>
          <Cartao titulo="Contratos com mais avisos">
            <BarrasH dados={ranking} larguraRotulo={190} largura={400} vazio="Nenhum contrato com aviso." />
          </Cartao>
        </div>
      </div>}

      {sec.matriz && <>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "6px 0" }}>Matriz obra × área</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Obra / contrato</th>
            <th style={th}>Status</th>
            {areasVis.map(a => <th key={a.k} style={{ ...th, textAlign: "center" }}>{a.rotulo}</th>)}
            <th style={{ ...th, textAlign: "right" }}>Avisos</th>
          </tr>
        </thead>
        <tbody>
          {grupos.flatMap(g => g.linhas.map((l, i) => (
            <tr key={l.obra.id}>
              <td style={td}>
                <b>#{l.obra.numero}</b> {i === 0 ? g.nome : <span style={{ color: "#94a3b8" }}>〃</span>}{g.contratos.length > 1 && l.obra.obra && l.obra.obra !== g.nome ? <span style={{ color: "#64748b" }}> · {l.obra.obra}</span> : null}
              </td>
              <td style={{ ...td, whiteSpace: "nowrap", color: "#475569" }}>{l.obra.status}{l.obra.regrasEtapas === 2 ? " 🔒" : ""}</td>
              {areasVis.map(a => <td key={a.k} style={{ ...td, textAlign: "center" }}><Selo nivel={l.resumo[a.k]} /></td>)}
              <td style={num}>{l.avisos.length}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 14, fontSize: 10, color: "#475569", marginTop: 6 }}>
        {[...niveis, null].map(n => <span key={n || "ok"} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Selo nivel={n} /> {n ? ROTULO_NIVEL[n] : "Ok"}</span>)}
        {anexos === null && <span>· Anexos indisponíveis: documentos conferidos só pelo checklist.</span>}
      </div>
      </>}

      {sec.detalhes && (
        <div className={sec.matriz ? "rl-quebra" : ""} style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>O que falta em cada obra</div>
          <div style={{ columnCount: 2, columnGap: 18 }}>
            {grupos.flatMap(g => g.linhas).filter(l => l.avisos.length).map(l => (
              <div key={l.obra.id} className="rl-bloco" style={{ breakInside: "avoid", marginBottom: 9 }}>
                <div style={{ fontSize: 11, fontWeight: 800, borderBottom: "1px solid #e2e8f0", paddingBottom: 2, marginBottom: 3 }}>
                  {nomeObra(l.obra)}{l.obra.obra ? <span style={{ fontWeight: 500, color: "#64748b" }}> · {l.obra.obra}</span> : null}
                </div>
                {[...l.avisos].sort((a, b) => PESO_NIVEL[b.nivel] - PESO_NIVEL[a.nivel]).map((a, i) => (
                  <div key={i} style={{ fontSize: 10, display: "flex", gap: 6, alignItems: "baseline", padding: "1px 0" }}>
                    <Selo nivel={a.nivel} />
                    <span style={{ color: "#64748b", minWidth: 64 }}>{AREAS.find(x => x.k === a.area)?.rotulo}</span>
                    <span>{a.texto}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Folha>
  );
}

// ─── 2. OBRAS EM ANDAMENTO ───────────────────────────────────────────────────
const COR_STATUS = { "Em andamento": SERIE[0], "Aguardando": SERIE[3], "Atrasado": SERIE[7], "Concluído": "#1baf7a" };

function etapaAtual(item) {
  let ult = -1;
  ETAPAS.forEach((e, i) => { if (item.etapas?.[e]?.feito) ult = i; });
  return ult; // -1 = nenhuma
}

function RelCarteira({ obras, onBack, f, filtro }) {
  const hoje = hojeLocal();
  const sec = f.secoes;
  // Item escolhido à mão (só com obra escolhida) recorta os itens; sem escolha, a obra inteira.
  const itensDe = o => (o.itens || []).filter(i => !f.itens.length || f.itens.includes(chaveItemObra(o.id, i.id)));
  const abertas = obrasDoFiltro(obras, f).filter(o => passa(f.status, o.status));
  const grupos = agruparObras(abertas).sort((a, b) => b.pct - a.pct);
  const itens = abertas.flatMap(itensDe);
  const pecas = itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0);
  const pct = itens.length ? Math.round(itens.reduce((s, i) => s + itemPercentual(i), 0) / itens.length) : 0;

  const porStatus = [...STATUS_ABERTOS, ...(abertas.some(o => o.status === "Concluído") ? ["Concluído"] : [])].map(st => ({ rotulo: st, valor: abertas.filter(o => o.status === st).length, cor: COR_STATUS[st] }));
  const contEtapa = [-1, 0, 1, 2, 3].map(k => itens.filter(i => etapaAtual(i) === k).length);
  const etapasDados = [
    { rotulo: "Nenhuma", valor: contEtapa[0], cor: NEUTRO },
    ...ETAPAS.map((e, i) => ({ rotulo: e, valor: contEtapa[i + 1], cor: RAMPA[i + 1] })),
  ];
  const faixas = [["Sem data", null, null], ["até 30 d", 0, 30], ["31–60 d", 31, 60], ["61–90 d", 61, 90], ["91–180 d", 91, 180], ["+180 d", 181, Infinity]];
  const diasContrato = o => o.dataContrato ? diasEntre(o.dataContrato, hoje) : null;
  const tempo = faixas.map(([r, a, b]) => ({
    rotulo: r,
    valor: abertas.filter(o => { const d = diasContrato(o); return a === null ? d === null : d !== null && d >= a && d <= b; }).length,
    cor: a === null ? NEUTRO : SERIE[0],
  }));
  const vencidas = abertas.filter(o => o.dataLimiteEntrega && o.dataLimiteEntrega < hoje).length;

  return (
    <Folha titulo={f.obras.length === 1 ? `Obra ${nomeObra(abertas[0] || {})}` : "Obras em andamento"} onBack={onBack} filtro={filtro}
      subtitulo={`${grupos.length} obra${grupos.length === 1 ? "" : "s"} · ${abertas.length} contrato${abertas.length === 1 ? "" : "s"}${f.obras.length || f.concluidas ? "" : " em aberto"}`}>
      {abertas.length === 0 && <div style={{ padding: 30, textAlign: "center", color: "#94a3b8" }}>Nenhuma obra nesse recorte.</div>}
      {sec.kpis && <div style={grade(4)}>
        <Kpi rotulo="Obras em aberto" valor={grupos.length} sub={`${abertas.length} contratos`} />
        <Kpi rotulo="Itens / peças" valor={`${itens.length} / ${pecas}`} />
        <Kpi rotulo="Progresso médio" valor={`${pct}%`} sub="ponderado por item" destaque={SERIE[0]} />
        <Kpi rotulo="Prazo vencido" valor={vencidas} destaque={vencidas ? SERIE[7] : undefined} sub={`${abertas.filter(o => !o.dataLimiteEntrega).length} sem prazo definido`} />
      </div>}
      {sec.graficos && <div style={grade(2)}>
        <Cartao titulo="Contratos por status">
          <Rosca dados={porStatus} sub="contratos" tamanho={120} />
        </Cartao>
        <Cartao titulo="Itens pela última etapa concluída" sub={f.itens.length ? "Itens escolhidos" : "Onde está cada item das obras do relatório"}>
          <Colunas dados={etapasDados} rotularTodas altura={170} largura={420} />
        </Cartao>
        <Cartao titulo="Progresso por obra" sub="% dos itens concluído (pesos das etapas)" largo>
          <BarrasH dados={grupos.map(g => ({ rotulo: g.nome, valor: g.pct, detalhe: g.contratos.map(o => "#" + o.numero).join(" ") }))}
            max={100} formatar={v => `${v}%`} larguraRotulo={230} />
        </Cartao>
        <Cartao titulo="Tempo desde a assinatura do contrato" sub="Contratos em aberto" largo>
          <Colunas dados={tempo} rotularTodas altura={140} />
        </Cartao>
      </div>}

      {sec.tabela && <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr>{["Contrato", "Cliente / obra", "Status", "Itens", "Peças", "%", "Contrato há", "Prazo"].map(h => <th key={h} style={{ ...th, textAlign: ["Itens", "Peças", "%", "Contrato há"].includes(h) ? "right" : "left" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {grupos.flatMap(g => g.contratos).map(o => {
            const its = itensDe(o);
            const p = its.length ? Math.round(its.reduce((s, i) => s + itemPercentual(i), 0) / its.length) : 0;
            const d = diasContrato(o);
            const venc = o.dataLimiteEntrega && o.dataLimiteEntrega < hoje;
            return (
              <tr key={o.id}>
                <td style={{ ...td, fontWeight: 700 }}>#{o.numero}</td>
                <td style={td}>{o.cliente}{o.obra ? <span style={{ color: "#64748b" }}> · {o.obra}</span> : null}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{o.status}</td>
                <td style={num}>{its.length}</td>
                <td style={num}>{its.reduce((s, i) => s + (Number(i.qtd) || 0), 0)}</td>
                <td style={num}>{p}%</td>
                <td style={num}>{d === null ? "—" : `${d} d`}</td>
                <td style={{ ...td, whiteSpace: "nowrap", fontWeight: venc ? 800 : 400 }}>{venc ? "✕ " : ""}{dataBR(o.dataLimiteEntrega)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>}

      {sec.itens && grupos.flatMap(g => g.contratos).map(o => {
        const its = itensDe(o);
        return (
          <div key={o.id} style={{ marginBottom: 12 }}>
            <Titulo>Itens — {nomeObra(o)}{o.obra ? <span style={{ fontWeight: 500, color: "#64748b" }}> · {o.obra}</span> : null}</Titulo>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Item", "Descrição", "L × H (mm)", "Qtd", ...ETAPAS, "%"].map(h => <th key={h} style={{ ...th, textAlign: h === "Item" || h === "Descrição" ? "left" : "center" }}>{h}</th>)}</tr></thead>
              <tbody>
                {its.length === 0 && <tr><td colSpan={5 + ETAPAS.length} style={{ ...td, color: "#94a3b8" }}>Sem itens.</td></tr>}
                {its.map(i => (
                  <tr key={i.id}>
                    <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>{i.tipo || i.id}</td>
                    <td style={td}>{i.descricao}{i.localizacao ? <span style={{ color: "#64748b" }}> · {i.localizacao}</span> : null}</td>
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>{i.L || i.H ? `${i.L} × ${i.H}` : "—"}</td>
                    <td style={{ ...td, textAlign: "center" }}>{i.qtd}</td>
                    {ETAPAS.map(e => {
                      const et = i.etapas?.[e];
                      return <td key={e} style={{ ...td, textAlign: "center", whiteSpace: "nowrap", color: et?.feito ? "#166534" : "#cbd5e1", fontWeight: 700 }}>{et?.feito ? `✓${et.data ? " " + dataBR(et.data).slice(0, 5) : ""}` : "—"}</td>;
                    })}
                    <td style={{ ...num, textAlign: "center" }}>{itemPercentual(i)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </Folha>
  );
}

// ─── 3. COMPRAS ──────────────────────────────────────────────────────────────
// Cinco grupos de situação, na ordem da paleta validada (a ordem garante a separação para daltônicos).
const GRUPOS_SIT = [
  { k: "pronto", rotulo: "Pronto (entregue/estoque)", cor: "#1baf7a", de: ["entregue", "estoque"] },
  { k: "caminho", rotulo: "Comprado, a caminho", cor: "#2a78d6", de: ["aguardando"] },
  { k: "comprar", rotulo: "Falta comprar / previsão", cor: "#eda100", de: ["comprar", "previsao"] },
  { k: "orcar", rotulo: "Falta orçar / aprovar", cor: "#4a3aa7", de: ["orcar", "aprovar"] },
  { k: "atrasada", rotulo: "Entrega atrasada", cor: "#e34948", de: ["atrasada"] },
];
const grupoDe = sit => GRUPOS_SIT.find(g => g.de.includes(sit))?.k;
const ROTULO_SIT = { orcar: "Falta orçar", aprovar: "Falta aprovar", comprar: "Falta comprar", previsao: "Sem previsão de entrega", atrasada: "Entrega atrasada", aguardando: "A caminho", entregue: "Entregue", estoque: "Do estoque" };

function RelCompras({ obras, onBack, f, filtro }) {
  const hoje = hojeLocal();
  const { visivel } = useSigilo();
  const sec = f.secoes;
  const abertas = obrasDoFiltro(obras, f);
  const linhas = abertas.flatMap(o => situacaoItensCompra(o, hoje).map(s => ({ ...s, obra: o })))
    .filter(l => passa(f.categorias, l.cat) && passa(f.situacoes, grupoDe(l.situacao)))
    .filter(l => !f.itens.length || f.itens.includes(chaveItemCompra(l.obra.id, l)));
  const categoriasVis = f.categorias.length ? CATEGORIAS_COMPRA.filter(c => f.categorias.includes(c)) : CATEGORIAS_COMPRA;
  const gruposVis = f.situacoes.length ? GRUPOS_SIT.filter(g => f.situacoes.includes(g.k)) : GRUPOS_SIT;
  const conta = k => linhas.filter(l => grupoDe(l.situacao) === k).length;
  const porCategoria = categoriasVis.map(cat => {
    const partes = {};
    for (const l of linhas) if (l.cat === cat) { const g = grupoDe(l.situacao); partes[g] = (partes[g] || 0) + 1; }
    return { rotulo: CATEGORIA_LABEL[cat], partes };
  });
  // Entregas ainda não recebidas: atrasadas + as próximas 8 semanas.
  const entregas = linhas.flatMap(l => l.entregas.filter(e => !e.recebido && e.data).map(e => ({ ...e, obra: l.obra, nome: l.nome })));
  const semanas = Array.from({ length: 8 }, (_, i) => {
    const ini = somaDias(hoje, i * 7), fimS = somaDias(hoje, i * 7 + 6);
    return { rotulo: i === 0 ? "esta sem." : dataBR(ini).slice(0, 5), valor: entregas.filter(e => e.data >= ini && e.data <= fimS).length };
  });
  const atrasadas = entregas.filter(e => e.data < hoje);
  const proximas = entregas.filter(e => e.data <= somaDias(hoje, 30)).sort((a, b) => a.data.localeCompare(b.data));
  const pendPorObra = abertas.map(o => ({ obra: o, pend: linhas.filter(l => l.obra.id === o.id && ["orcar", "aprovar", "comprar", "previsao", "atrasada"].includes(l.situacao)) }))
    .filter(x => x.pend.length).sort((a, b) => b.pend.length - a.pend.length);

  return (
    <Folha titulo={f.obras.length === 1 ? `Compras — ${nomeObra(abertas[0] || {})}` : "Compras"} onBack={onBack} filtro={filtro}
      subtitulo={`${linhas.length} itens de compra em ${abertas.length} contrato${abertas.length === 1 ? "" : "s"}${f.obras.length || f.concluidas ? "" : " abertos"} (categorias "não se aplica" ficam fora)`}>
      {sec.kpis && <div style={grade(Math.min(5, gruposVis.length))}>
        {gruposVis.map(g => <Kpi key={g.k} rotulo={g.rotulo} valor={conta(g.k)} destaque={g.cor} />)}
      </div>}
      {sec.graficos && <div style={grade(2)}>
        <Cartao titulo="Situação por categoria" sub="Itens de compra das obras abertas" largo>
          <BarrasEmpilhadasH dados={porCategoria} series={gruposVis} larguraRotulo={90} />
        </Cartao>
        <Cartao titulo="Entregas previstas nas próximas 8 semanas" sub={`Compras feitas ainda não recebidas${atrasadas.length ? ` · ${atrasadas.length} já atrasada(s), fora do gráfico` : ""}`} largo>
          <Colunas dados={semanas} rotularTodas altura={140} vazio="Nenhuma entrega com previsão nas próximas 8 semanas — preencha a previsão de entrega nas compras feitas." />
        </Cartao>
      </div>}

      {sec.entregas && <>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>Entregas atrasadas e dos próximos 30 dias</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Previsão", "Obra", "Material", "Fornecedor"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {proximas.length === 0 && <tr><td colSpan={4} style={{ ...td, color: "#94a3b8" }}>Nenhuma entrega prevista.</td></tr>}
          {proximas.map((e, i) => (
            <tr key={i}>
              <td style={{ ...td, whiteSpace: "nowrap", fontWeight: e.data < hoje ? 800 : 400 }}>{e.data < hoje ? "✕ " : ""}{dataBR(e.data)}</td>
              <td style={td}>{nomeObra(e.obra)}</td>
              <td style={td}>{e.nome}</td>
              <td style={td}>{e.fornecedor || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </>}

      {sec.pendencias && <>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>O que falta em cada obra</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Obra", "Material", "Situação"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {pendPorObra.flatMap(x => x.pend.map((l, i) => (
            <tr key={x.obra.id + i}>
              <td style={{ ...td, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#1e293b" : "#cbd5e1" }}>{i === 0 ? nomeObra(x.obra) : "〃"}</td>
              <td style={td}>{l.nome}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{ROTULO_SIT[l.situacao]}</td>
            </tr>
          )))}
          {pendPorObra.length === 0 && <tr><td colSpan={3} style={{ ...td, color: "#94a3b8" }}>Nada pendente nesse recorte.</td></tr>}
        </tbody>
      </table>
      </>}

      {sec.detalhe && <>
        <Titulo>Detalhe dos itens de compra{visivel ? "" : " (valores ocultos — libere os valores para imprimi-los)"}</Titulo>
        {linhas.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8" }}>Nenhum item nesse recorte.</div>}
        {linhas.map((l, i) => (
          <div key={l.obra.id + "|" + i} className="rl-bloco" style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "6px 8px", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 11.5 }}>
              <b>{l.nome}</b>
              <span style={{ color: "#64748b" }}>{nomeObra(l.obra)}</span>
              <span style={{ marginLeft: "auto", fontWeight: 700, color: GRUPOS_SIT.find(g => g.k === grupoDe(l.situacao))?.cor }}>{ROTULO_SIT[l.situacao]}</span>
            </div>
            {l.estoque?.usado === "sim" && <div style={{ fontSize: 10.5, color: "#475569" }}>Usa material do estoque{l.estoque.obs ? `: ${l.estoque.obs}` : ""}</div>}
            {(l.fornecedores || []).length > 0 ? (
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
                <thead><tr>{["Fornecedor", "Orçamento", "Aprov.", "Compra", "Entrega", "NF"].map(h => <th key={h} style={{ ...th, background: "#475569" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {l.fornecedores.map(fo => (
                    <tr key={fo.id}>
                      <td style={td}>{fo.nome || "—"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{dataBR(fo.orcamento.data)}{visivel && fo.orcamento.valor ? ` · ${reais(fo.orcamento.valor)}` : ""}</td>
                      <td style={{ ...td, textAlign: "center" }}>{fo.aprovado ? "✓" : ""}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fo.compra.data || fo.compra.valor ? `${dataBR(fo.compra.data)}${visivel && fo.compra.valor ? ` · ${reais(fo.compra.valor)}` : ""}` : "—"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fo.entrega.recebido ? `✓ recebido${fo.entrega.data ? " " + dataBR(fo.entrega.data) : ""}` : fo.entrega.data ? `prev. ${dataBR(fo.entrega.data)}` : "—"}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fo.nf.numero ? `${fo.nf.numero}${fo.nf.data ? " · " + dataBR(fo.nf.data) : ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 2 }}>Nenhum orçamento lançado.</div>}
          </div>
        ))}
      </>}
    </Folha>
  );
}

// ─── 4. AGENDA E EQUIPES ─────────────────────────────────────────────────────
function RelAgenda({ obras, agenda, equipes, inicio, fim, onPeriodo, onBack, f, filtro }) {
  const padrao = periodoPadrao();
  const sec = f.secoes;
  const ini = inicio || padrao.inicio, fimP = fim || padrao.fim;
  // Com obra escolhida, atividade avulsa (sem obra) fica fora.
  const servicos = agenda.filter(a => a.dia >= ini && a.dia <= fimP)
    .filter(a => !f.obras.length || f.obras.includes(a.obraId))
    .filter(a => passa(f.equipes, a.equipeId || "_"));
  const nomeEquipe = id => equipes.find(e => e.id === id)?.nome || "Sem equipe";
  const tituloServ = a => {
    if (!a.obraId) return a.titulo || "Atividade avulsa";
    const o = obras.find(x => x.id === a.obraId);
    return o ? nomeObra(o) : "(obra removida)";
  };
  const dias = new Set(servicos.map(a => a.dia));
  const obrasAtendidas = new Set(servicos.filter(a => a.obraId).map(a => a.obraId));
  const equipesAtivas = new Set(servicos.map(a => a.equipeId || "_"));
  const totalDias = diasEntre(ini, fimP) + 1;

  // Por dia (até ~6 semanas) ou por semana (período longo).
  let tempo;
  if (totalDias <= 42) {
    tempo = Array.from({ length: Math.max(1, totalDias) }, (_, i) => {
      const d = somaDias(ini, i);
      const dow = new Date(d + "T12:00").getDay();
      return { rotulo: d.slice(8, 10), valor: servicos.filter(a => a.dia === d).length, cor: dow === 0 || dow === 6 ? NEUTRO : SERIE[0] };
    });
  } else {
    const n = Math.ceil(totalDias / 7);
    tempo = Array.from({ length: n }, (_, i) => {
      const a = somaDias(ini, i * 7), b = somaDias(ini, i * 7 + 6);
      return { rotulo: dataBR(a).slice(0, 5), valor: servicos.filter(s => s.dia >= a && s.dia <= b).length };
    });
  }
  const porEquipe = [...equipesAtivas].map(id => {
    const s = servicos.filter(a => (a.equipeId || "_") === id);
    return { id, rotulo: id === "_" ? "Sem equipe" : nomeEquipe(id), valor: s.length, dias: new Set(s.map(a => a.dia)).size, obras: new Set(s.filter(a => a.obraId).map(a => a.obraId)).size };
  }).sort((a, b) => b.valor - a.valor);
  const porObra = [...new Set(servicos.map(tituloServ))].map(t => {
    const s = servicos.filter(a => tituloServ(a) === t);
    return { rotulo: t, valor: new Set(s.map(a => a.dia)).size, servicos: s.length, equipes: [...new Set(s.map(a => a.equipeId ? nomeEquipe(a.equipeId) : "Sem equipe"))].join(", ") };
  }).sort((a, b) => b.valor - a.valor);

  return (
    <Folha titulo="Agenda e equipes" onBack={onBack} filtro={filtro} subtitulo={`Período de ${dataBR(ini)} a ${dataBR(fimP)} (${totalDias} dias)`}
      controles={<>
        <label style={{ fontSize: 12.5, color: "#334155" }}>De <input type="date" value={ini} onChange={e => e.target.value && onPeriodo(e.target.value, fimP < e.target.value ? e.target.value : fimP)} /></label>
        <label style={{ fontSize: 12.5, color: "#334155" }}>até <input type="date" value={fimP} onChange={e => e.target.value && onPeriodo(ini > e.target.value ? e.target.value : ini, e.target.value)} /></label>
        <button onClick={() => onPeriodo(padrao.inicio, padrao.fim)} style={{ ...btnEscuro, background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0" }}>Este mês</button>
        <button onClick={() => {
          const d = new Date(ini + "T12:00"); const a = new Date(d.getFullYear(), d.getMonth() - 1, 1); const b = new Date(d.getFullYear(), d.getMonth(), 0);
          onPeriodo(`${a.getFullYear()}-${p2(a.getMonth() + 1)}-01`, `${b.getFullYear()}-${p2(b.getMonth() + 1)}-${p2(b.getDate())}`);
        }} style={{ ...btnEscuro, background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0" }}>Mês anterior</button>
      </>}>
      {sec.kpis && <div style={grade(4)}>
        <Kpi rotulo="Serviços lançados" valor={servicos.length} destaque={SERIE[0]} />
        <Kpi rotulo="Dias com serviço" valor={dias.size} sub={`de ${totalDias} no período`} />
        <Kpi rotulo="Obras atendidas" valor={obrasAtendidas.size} sub={`${servicos.filter(a => !a.obraId).length} atividades avulsas`} />
        <Kpi rotulo="Equipes em campo" valor={porEquipe.filter(e => e.id !== "_").length} />
      </div>}
      {sec.graficos && <div style={grade(2)}>
        <Cartao titulo={totalDias <= 42 ? "Serviços por dia" : "Serviços por semana"} sub={totalDias <= 42 ? "Fim de semana em cinza" : "Semana começando na data indicada"} largo>
          <Colunas dados={tempo} altura={150} />
        </Cartao>
        <Cartao titulo="Serviços por equipe">
          <BarrasH dados={porEquipe} larguraRotulo={130} largura={400} />
        </Cartao>
        <Cartao titulo="Obras com mais dias de serviço" sub="Top 12">
          <BarrasH dados={porObra.slice(0, 12)} larguraRotulo={180} largura={400} formatar={v => `${v} d`} />
        </Cartao>
      </div>}
      {sec.equipes && <>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>Por equipe</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Equipe", "Serviços", "Dias", "Obras"].map(h => <th key={h} style={{ ...th, textAlign: h === "Equipe" ? "left" : "right" }}>{h}</th>)}</tr></thead>
        <tbody>{porEquipe.map(e => <tr key={e.id}><td style={td}>{e.rotulo}</td><td style={num}>{e.valor}</td><td style={num}>{e.dias}</td><td style={num}>{e.obras}</td></tr>)}</tbody>
      </table>
      </>}
      {sec.obras && <>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>Por obra</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Obra / atividade", "Dias", "Serviços", "Equipes"].map(h => <th key={h} style={{ ...th, textAlign: h === "Dias" || h === "Serviços" ? "right" : "left" }}>{h}</th>)}</tr></thead>
        <tbody>{porObra.map(o => <tr key={o.rotulo}><td style={td}>{o.rotulo}</td><td style={num}>{o.valor}</td><td style={num}>{o.servicos}</td><td style={td}>{o.equipes}</td></tr>)}</tbody>
      </table>
      </>}
      {sec.lista && servicos.length > 0 && <>
        <Titulo>Serviços dia a dia</Titulo>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Dia", "Equipe", "Obra / atividade", "Período", "O que foi feito / previsto"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {[...servicos].sort((a, b) => a.dia.localeCompare(b.dia) || (a.ordem || 0) - (b.ordem || 0)).map((a, i, arr) => {
              const o = a.obraId ? obras.find(x => x.id === a.obraId) : null;
              const itensTxt = o && a.itens?.length ? (o.itens || []).filter(it => a.itens.includes(Number(it.id))).map(it => it.tipo || it.id).join(", ") : "";
              const novoDia = i === 0 || arr[i - 1].dia !== a.dia;
              return (
                <tr key={a.id}>
                  <td style={{ ...td, whiteSpace: "nowrap", fontWeight: novoDia ? 700 : 400, color: novoDia ? "#1e293b" : "#cbd5e1" }}>{novoDia ? dataBR(a.dia) : "〃"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{a.equipeId ? nomeEquipe(a.equipeId) : "Sem equipe"}</td>
                  <td style={td}>{tituloServ(a)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{a.periodo || ""}{a.horaObs ? ` · ${a.horaObs}` : ""}</td>
                  <td style={td}>{[a.descricao, itensTxt && `Itens: ${itensTxt}`].filter(Boolean).join(" — ") || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>}
      {servicos.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>Nenhum serviço no calendário nesse período.</div>}
    </Folha>
  );
}

// ─── 5. FINANCEIRO ───────────────────────────────────────────────────────────
function RelFinanceiro({ obras, onBack, f, filtro }) {
  const { visivel, pedir } = useSigilo();
  const sec = f.secoes;
  const comConcluidas = f.concluidas || f.obras.length > 0;
  if (!visivel) {
    return (
      <Folha titulo="Financeiro" onBack={onBack} filtro={filtro}>
        <div style={{ padding: "50px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 34 }}>🔒</div>
          <div style={{ fontSize: 15, fontWeight: 800, margin: "6px 0" }}>Os valores estão ocultos</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 14 }}>O relatório financeiro só é montado com os valores liberados.</div>
          <button onClick={pedir} style={btnEscuro} className="no-print">Mostrar valores</button>
        </div>
      </Folha>
    );
  }
  const base = obrasDoFiltro(obras, f);
  const grupos = agruparObras(base);
  const t = base.reduce((acc, o) => { const f = finObra(o); for (const k of Object.keys(acc)) acc[k] += f[k]; return acc; }, { total: 0, recebido: 0, aReceber: 0, aPagar: 0, aEntregar: 0 });
  const alertas = base.filter(precisaAlertaCompras);
  const porCat = CATEGORIAS_COMPRA.map(cat => {
    const s = base.reduce((acc, o) => { const c = comprasPorCategoria(o)[cat]; acc.gasto += c.gasto; acc.aComprar += c.aComprar; return acc; }, { gasto: 0, aComprar: 0 });
    return { rotulo: CATEGORIA_LABEL[cat], partes: s };
  });
  const topReceber = [...grupos].sort((a, b) => b.fin.aReceber - a.fin.aReceber).filter(g => g.fin.aReceber > 0).slice(0, 12)
    .map(g => ({ rotulo: g.nome, valor: g.fin.aReceber }));
  const linhas = [...grupos].sort((a, b) => b.fin.total - a.fin.total);

  return (
    <Folha titulo="Financeiro" onBack={onBack} filtro={filtro}
      subtitulo={`${grupos.length} obra${grupos.length === 1 ? "" : "s"} · ${base.length} contratos ${f.obras.length ? "escolhidos" : comConcluidas ? "(inclui concluídos)" : "em aberto"} · documento com valores — uso interno`}>
      {sec.kpis && <div style={grade(3)}>
        <Kpi rotulo="Contratado" valor={reaisCurto(t.total)} sub={reais(t.total)} destaque="#c9a227" />
        <Kpi rotulo="Recebido" valor={reaisCurto(t.recebido)} sub={t.total ? `${Math.round(t.recebido / t.total * 100)}% do contratado` : ""} destaque={SERIE[0]} />
        <Kpi rotulo="A receber" valor={reaisCurto(t.aReceber)} sub={reais(t.aReceber)} destaque={SERIE[1]} />
        <Kpi rotulo="A pagar (a comprar)" valor={reaisCurto(t.aPagar)} sub="orçado, ainda não comprado" />
        <Kpi rotulo="A entregar" valor={reaisCurto(t.aEntregar)} sub="valor de obra não executado" />
        <Kpi rotulo="🚩 Compras acima do a receber" valor={alertas.length} sub="contratos" destaque={alertas.length ? SERIE[7] : undefined} />
      </div>}
      {sec.graficos && <div style={grade(2)}>
        <Cartao titulo="Contratado: recebido × a receber" largo>
          <BarraParte formatar={reaisCurto} partes={[
            { rotulo: "Recebido", valor: t.recebido, cor: SERIE[0] },
            { rotulo: "A receber", valor: t.aReceber, cor: SERIE[1] },
          ]} />
        </Cartao>
        <Cartao titulo="Obras com mais a receber" sub="Top 12">
          <BarrasH dados={topReceber} formatar={reaisCurto} larguraRotulo={160} largura={400} cor={SERIE[1]} vazio="Nada a receber." />
        </Cartao>
        <Cartao titulo="Compras por categoria" sub="Já gasto × ainda a comprar">
          <BarrasEmpilhadasH dados={porCat} formatar={reaisCurto} larguraRotulo={80} largura={400}
            series={[{ k: "gasto", rotulo: "Gasto", cor: SERIE[0] }, { k: "aComprar", rotulo: "A comprar", cor: SERIE[1] }]} />
        </Cartao>
      </div>}
      {sec.tabela && <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Obra", "Contratos", "Contratado", "Recebido", "A receber", "A pagar", "% receb."].map(h => <th key={h} style={{ ...th, textAlign: h === "Obra" || h === "Contratos" ? "left" : "right" }}>{h}</th>)}</tr></thead>
        <tbody>
          {linhas.map(g => (
            <tr key={g.chave}>
              <td style={td}>{g.emAlerta ? "🚩 " : ""}{g.nome}</td>
              <td style={{ ...td, color: "#64748b" }}>{g.contratos.map(o => "#" + o.numero).join(" ")}</td>
              <td style={num}>{reais(g.fin.total)}</td>
              <td style={num}>{reais(g.fin.recebido)}</td>
              <td style={num}>{reais(g.fin.aReceber)}</td>
              <td style={num}>{reais(g.fin.aPagar)}</td>
              <td style={num}>{g.fin.total ? Math.round(g.fin.recebido / g.fin.total * 100) : 0}%</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...td, fontWeight: 800 }} colSpan={2}>Total</td>
            <td style={{ ...num, fontWeight: 800 }}>{reais(t.total)}</td>
            <td style={{ ...num, fontWeight: 800 }}>{reais(t.recebido)}</td>
            <td style={{ ...num, fontWeight: 800 }}>{reais(t.aReceber)}</td>
            <td style={{ ...num, fontWeight: 800 }}>{reais(t.aPagar)}</td>
            <td style={{ ...num, fontWeight: 800 }}>{t.total ? Math.round(t.recebido / t.total * 100) : 0}%</td>
          </tr>
        </tbody>
      </table>}
      {sec.categorias && <>
        <Titulo>Compras por categoria de cada contrato</Titulo>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Contrato</th>
              {CATEGORIAS_COMPRA.map(c => <th key={c} style={{ ...th, textAlign: "right" }}>{CATEGORIA_LABEL[c]}<br /><span style={{ fontWeight: 500 }}>gasto / a comprar</span></th>)}
            </tr>
          </thead>
          <tbody>
            {linhas.flatMap(g => g.contratos).map(o => {
              const pc = comprasPorCategoria(o);
              return (
                <tr key={o.id}>
                  <td style={td}>{nomeObra(o)}</td>
                  {CATEGORIAS_COMPRA.map(c => <td key={c} style={num}>{pc[c].gasto || pc[c].aComprar ? <>{reaisCurto(pc[c].gasto)}<br /><span style={{ color: "#64748b" }}>{reaisCurto(pc[c].aComprar)}</span></> : "—"}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </>}
    </Folha>
  );
}
