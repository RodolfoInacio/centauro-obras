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
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import logoDark from "./assets/logo-dark.png";
import { fetchResumoAnexos } from "./api";
import { agruparSimples } from "./agrupamento";
import { AREAS, PESO_NIVEL, avisosDaObra, resumoPorArea } from "./avisos";
import { ETAPAS, itemPercentual, finObra, agruparObras, precisaAlertaCompras } from "./calculos";
import { CATEGORIAS_COMPRA, CATEGORIA_LABEL, situacaoItensCompra, comprasPorCategoria } from "./ComprasObra";
import { useSigilo } from "./Sigilo";
import { Cartao, Kpi, BarrasH, BarrasEmpilhadasH, Colunas, Rosca, BarraParte, SERIE, RAMPA, NEUTRO } from "./graficos";

export const RELATORIOS = [
  { tipo: "avisos", icone: "⚠️", titulo: "Central de avisos", desc: "O que falta em cada obra aberta: documentos, cadastro, prazos, orçar, comprar, medir. Gráfico por área e matriz obra × área.", paisagem: true },
  { tipo: "carteira", icone: "🏗️", titulo: "Obras em andamento", desc: "Status das obras, em que etapa estão os itens, progresso de cada obra e há quanto tempo o contrato foi assinado.", paisagem: false },
  { tipo: "compras", icone: "🛒", titulo: "Compras", desc: "Situação dos materiais por categoria, entregas previstas nas próximas semanas e o que falta orçar ou comprar em cada obra.", paisagem: false },
  { tipo: "agenda", icone: "📅", titulo: "Agenda e equipes", desc: "Serviços lançados no calendário num período: por dia, por equipe e por obra. Bom para fechar o mês.", paisagem: false, periodo: true },
  { tipo: "financeiro", icone: "💰", titulo: "Financeiro", desc: "Contratado, recebido, a receber e a pagar; obras com mais a receber e compras por categoria. Pede a senha dos valores.", paisagem: false },
];

const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
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
  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", margin: "0 0 4px" }}>Relatórios</h2>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 18 }}>
        Cada relatório abre como uma folha A4 com indicadores, gráficos e tabela. Use <b>Imprimir</b> e escolha
        <b> “Salvar como PDF”</b> para guardar ou mandar por WhatsApp/e-mail. Os números são os de agora — gere de novo para atualizar.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
        {RELATORIOS.map(r => (
          <button key={r.tipo} onClick={() => onAbrir(r.tipo)}
            style={{ textAlign: "left", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 18px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 26 }}>{r.icone}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a1a" }}>{r.titulo}</div>
            <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>{r.desc}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: "auto" }}>A4 {r.paisagem ? "paisagem" : "retrato"} · gráficos + tabela</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── FOLHA: moldura comum ────────────────────────────────────────────────────
function Folha({ titulo, subtitulo, paisagem, controles, onBack, children }) {
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
        {controles}
        <button onClick={() => window.print()} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir / PDF</button>
      </div>
      <div className="rl-folha">
        <div style={{ display: "flex", alignItems: "center", gap: 16, borderBottom: "3px solid #1a1a1a", paddingBottom: 8, marginBottom: 12 }}>
          <img src={logoDark} alt="Centauro Esquadrias" style={{ height: 38 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: "#64748b", textTransform: "uppercase" }}>Relatório</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#1a1a1a" }}>{titulo}</div>
            {subtitulo && <div style={{ fontSize: 11.5, color: "#475569" }}>{subtitulo}</div>}
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

// ─── DESPACHO ────────────────────────────────────────────────────────────────
export default function RelatorioPrint({ tipo, obras, agenda, cronogramas, equipes, inicio, fim, onPeriodo, onBack }) {
  const props = { obras, agenda, cronogramas, equipes, onBack };
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

function RelAvisos({ obras, agenda, cronogramas, onBack }) {
  const [anexos, setAnexos] = useState(undefined);
  const [comInfo, setComInfo] = useState(false);
  const [detalhes, setDetalhes] = useState(true);
  const [comConcluidas, setComConcluidas] = useState(false);
  useEffect(() => { let c = false; fetchResumoAnexos().then(m => { if (!c) setAnexos(m); }); return () => { c = true; }; }, []);

  const linhas = useMemo(() => {
    const ctx = { anexos: anexos || null, agenda, cronogramas };
    const piso = comInfo ? 1 : 2;
    return obras.filter(o => comConcluidas || o.status !== "Concluído").map(o => {
      const av = avisosDaObra(o, ctx).filter(a => PESO_NIVEL[a.nivel] >= piso);
      return { obra: o, avisos: av, resumo: resumoPorArea(av) };
    });
  }, [obras, agenda, cronogramas, anexos, comInfo, comConcluidas]);

  const niveis = comInfo ? ["erro", "atencao", "info"] : ["erro", "atencao"];
  const series = niveis.map(n => ({ k: n, rotulo: ROTULO_NIVEL[n], cor: COR_NIVEL[n], icone: ICONE_NIVEL[n] }));
  const porArea = AREAS.map(a => {
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
    <Folha titulo="Central de avisos" paisagem onBack={onBack}
      subtitulo={`${linhas.length} contrato${linhas.length === 1 ? "" : "s"} ${comConcluidas ? "(inclui concluídos)" : "em aberto"} · ${comInfo ? "críticos, atenção e informativos" : "críticos e atenção"}`}
      controles={<>
        <Opcao checked={detalhes} onChange={setDetalhes}>Lista detalhada por obra</Opcao>
        <Opcao checked={comInfo} onChange={setComInfo}>Incluir informativos</Opcao>
        <Opcao checked={comConcluidas} onChange={setComConcluidas}>Incluir concluídas</Opcao>
        {anexos === undefined && <span style={{ fontSize: 12, color: "#94a3b8" }}>Lendo anexos…</span>}
      </>}>
      <div style={grade(4)}>
        <Kpi rotulo="Contratos analisados" valor={linhas.length} />
        <Kpi rotulo="Com pendência crítica" valor={comCritico} destaque={COR_NIVEL.erro} sub={linhas.length ? `${Math.round(comCritico / linhas.length * 100)}% dos contratos` : ""} />
        <Kpi rotulo="Só pendências de atenção" valor={soAtencao} destaque={COR_NIVEL.atencao} />
        <Kpi rotulo="Sem pendência" valor={limpos} destaque="#1baf7a" sub={`${totalAvisos} avisos no total`} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10, marginBottom: 10 }}>
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
      </div>

      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "6px 0" }}>Matriz obra × área</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Obra / contrato</th>
            <th style={th}>Status</th>
            {AREAS.map(a => <th key={a.k} style={{ ...th, textAlign: "center" }}>{a.rotulo}</th>)}
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
              {AREAS.map(a => <td key={a.k} style={{ ...td, textAlign: "center" }}><Selo nivel={l.resumo[a.k]} /></td>)}
              <td style={num}>{l.avisos.length}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 14, fontSize: 10, color: "#475569", marginTop: 6 }}>
        {[...niveis, null].map(n => <span key={n || "ok"} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Selo nivel={n} /> {n ? ROTULO_NIVEL[n] : "Ok"}</span>)}
        {anexos === null && <span>· Anexos indisponíveis: documentos conferidos só pelo checklist.</span>}
      </div>

      {detalhes && (
        <div className="rl-quebra" style={{ marginTop: 14 }}>
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

function RelCarteira({ obras, onBack }) {
  const hoje = hojeLocal();
  const abertas = obras.filter(o => o.status !== "Concluído");
  const grupos = agruparObras(obras).filter(g => !g.concluido).sort((a, b) => b.pct - a.pct);
  const itens = abertas.flatMap(o => o.itens || []);
  const pecas = itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0);
  const pct = itens.length ? Math.round(itens.reduce((s, i) => s + itemPercentual(i), 0) / itens.length) : 0;

  const porStatus = ["Em andamento", "Aguardando", "Atrasado"].map(st => ({ rotulo: st, valor: abertas.filter(o => o.status === st).length, cor: COR_STATUS[st] }));
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
    <Folha titulo="Obras em andamento" onBack={onBack}
      subtitulo={`${grupos.length} obra${grupos.length === 1 ? "" : "s"} · ${abertas.length} contrato${abertas.length === 1 ? "" : "s"} em aberto`}>
      <div style={grade(4)}>
        <Kpi rotulo="Obras em aberto" valor={grupos.length} sub={`${abertas.length} contratos`} />
        <Kpi rotulo="Itens / peças" valor={`${itens.length} / ${pecas}`} />
        <Kpi rotulo="Progresso médio" valor={`${pct}%`} sub="ponderado por item" destaque={SERIE[0]} />
        <Kpi rotulo="Prazo vencido" valor={vencidas} destaque={vencidas ? SERIE[7] : undefined} sub={`${abertas.filter(o => !o.dataLimiteEntrega).length} sem prazo definido`} />
      </div>
      <div style={grade(2)}>
        <Cartao titulo="Contratos por status">
          <Rosca dados={porStatus} sub="contratos" tamanho={120} />
        </Cartao>
        <Cartao titulo="Itens pela última etapa concluída" sub="Onde está cada item das obras abertas">
          <Colunas dados={etapasDados} rotularTodas altura={170} largura={420} />
        </Cartao>
        <Cartao titulo="Progresso por obra" sub="% dos itens concluído (pesos das etapas)" largo>
          <BarrasH dados={grupos.map(g => ({ rotulo: g.nome, valor: g.pct, detalhe: g.contratos.map(o => "#" + o.numero).join(" ") }))}
            max={100} formatar={v => `${v}%`} larguraRotulo={230} />
        </Cartao>
        <Cartao titulo="Tempo desde a assinatura do contrato" sub="Contratos em aberto" largo>
          <Colunas dados={tempo} rotularTodas altura={140} />
        </Cartao>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>{["Contrato", "Cliente / obra", "Status", "Itens", "Peças", "%", "Contrato há", "Prazo"].map(h => <th key={h} style={{ ...th, textAlign: ["Itens", "Peças", "%", "Contrato há"].includes(h) ? "right" : "left" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {grupos.flatMap(g => g.contratos.filter(o => o.status !== "Concluído")).map(o => {
            const its = o.itens || [];
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
      </table>
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

function RelCompras({ obras, onBack }) {
  const hoje = hojeLocal();
  const abertas = obras.filter(o => o.status !== "Concluído");
  const linhas = abertas.flatMap(o => situacaoItensCompra(o, hoje).map(s => ({ ...s, obra: o })));
  const conta = k => linhas.filter(l => grupoDe(l.situacao) === k).length;
  const porCategoria = CATEGORIAS_COMPRA.map(cat => {
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
    <Folha titulo="Compras" onBack={onBack} subtitulo={`${linhas.length} itens de compra em ${abertas.length} contratos abertos (categorias "não se aplica" ficam fora)`}>
      <div style={grade(5)}>
        {GRUPOS_SIT.map(g => <Kpi key={g.k} rotulo={g.rotulo} valor={conta(g.k)} destaque={g.cor} />)}
      </div>
      <div style={grade(2)}>
        <Cartao titulo="Situação por categoria" sub="Itens de compra das obras abertas" largo>
          <BarrasEmpilhadasH dados={porCategoria} series={GRUPOS_SIT} larguraRotulo={90} />
        </Cartao>
        <Cartao titulo="Entregas previstas nas próximas 8 semanas" sub={`Compras feitas ainda não recebidas${atrasadas.length ? ` · ${atrasadas.length} já atrasada(s), fora do gráfico` : ""}`} largo>
          <Colunas dados={semanas} rotularTodas altura={140} vazio="Nenhuma entrega com previsão nas próximas 8 semanas — preencha a previsão de entrega nas compras feitas." />
        </Cartao>
      </div>

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

      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>O que falta em cada obra</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Obra", "Material", "Situação"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {pendPorObra.flatMap(x => x.pend.map((l, i) => (
            <tr key={x.obra.id + i}>
              <td style={{ ...td, fontWeight: i === 0 ? 700 : 400, color: i === 0 ? "#1e293b" : "#cbd5e1" }}>{i === 0 ? nomeObra(x.obra) : "〃"}</td>
              <td style={td}>{l.nome}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{ROTULO_SIT[l.situacao]}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </Folha>
  );
}

// ─── 4. AGENDA E EQUIPES ─────────────────────────────────────────────────────
function RelAgenda({ obras, agenda, equipes, inicio, fim, onPeriodo, onBack }) {
  const padrao = periodoPadrao();
  const ini = inicio || padrao.inicio, fimP = fim || padrao.fim;
  const servicos = agenda.filter(a => a.dia >= ini && a.dia <= fimP);
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
    <Folha titulo="Agenda e equipes" onBack={onBack} subtitulo={`Período de ${dataBR(ini)} a ${dataBR(fimP)} (${totalDias} dias)`}
      controles={<>
        <label style={{ fontSize: 12.5, color: "#334155" }}>De <input type="date" value={ini} onChange={e => e.target.value && onPeriodo(e.target.value, fimP < e.target.value ? e.target.value : fimP)} /></label>
        <label style={{ fontSize: 12.5, color: "#334155" }}>até <input type="date" value={fimP} onChange={e => e.target.value && onPeriodo(ini > e.target.value ? e.target.value : ini, e.target.value)} /></label>
        <button onClick={() => onPeriodo(padrao.inicio, padrao.fim)} style={{ ...btnEscuro, background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0" }}>Este mês</button>
        <button onClick={() => {
          const d = new Date(ini + "T12:00"); const a = new Date(d.getFullYear(), d.getMonth() - 1, 1); const b = new Date(d.getFullYear(), d.getMonth(), 0);
          onPeriodo(`${a.getFullYear()}-${p2(a.getMonth() + 1)}-01`, `${b.getFullYear()}-${p2(b.getMonth() + 1)}-${p2(b.getDate())}`);
        }} style={{ ...btnEscuro, background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0" }}>Mês anterior</button>
      </>}>
      <div style={grade(4)}>
        <Kpi rotulo="Serviços lançados" valor={servicos.length} destaque={SERIE[0]} />
        <Kpi rotulo="Dias com serviço" valor={dias.size} sub={`de ${totalDias} no período`} />
        <Kpi rotulo="Obras atendidas" valor={obrasAtendidas.size} sub={`${servicos.filter(a => !a.obraId).length} atividades avulsas`} />
        <Kpi rotulo="Equipes em campo" valor={porEquipe.filter(e => e.id !== "_").length} />
      </div>
      <div style={grade(2)}>
        <Cartao titulo={totalDias <= 42 ? "Serviços por dia" : "Serviços por semana"} sub={totalDias <= 42 ? "Fim de semana em cinza" : "Semana começando na data indicada"} largo>
          <Colunas dados={tempo} altura={150} />
        </Cartao>
        <Cartao titulo="Serviços por equipe">
          <BarrasH dados={porEquipe} larguraRotulo={130} largura={400} />
        </Cartao>
        <Cartao titulo="Obras com mais dias de serviço" sub="Top 12">
          <BarrasH dados={porObra.slice(0, 12)} larguraRotulo={180} largura={400} formatar={v => `${v} d`} />
        </Cartao>
      </div>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>Por equipe</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead><tr>{["Equipe", "Serviços", "Dias", "Obras"].map(h => <th key={h} style={{ ...th, textAlign: h === "Equipe" ? "left" : "right" }}>{h}</th>)}</tr></thead>
        <tbody>{porEquipe.map(e => <tr key={e.id}><td style={td}>{e.rotulo}</td><td style={num}>{e.valor}</td><td style={num}>{e.dias}</td><td style={num}>{e.obras}</td></tr>)}</tbody>
      </table>
      <div className="rl-bloco" style={{ fontSize: 12, fontWeight: 800, margin: "8px 0 4px" }}>Por obra</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Obra / atividade", "Dias", "Serviços", "Equipes"].map(h => <th key={h} style={{ ...th, textAlign: h === "Dias" || h === "Serviços" ? "right" : "left" }}>{h}</th>)}</tr></thead>
        <tbody>{porObra.map(o => <tr key={o.rotulo}><td style={td}>{o.rotulo}</td><td style={num}>{o.valor}</td><td style={num}>{o.servicos}</td><td style={td}>{o.equipes}</td></tr>)}</tbody>
      </table>
      {servicos.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>Nenhum serviço no calendário nesse período.</div>}
    </Folha>
  );
}

// ─── 5. FINANCEIRO ───────────────────────────────────────────────────────────
function RelFinanceiro({ obras, onBack }) {
  const { visivel, pedir } = useSigilo();
  const [comConcluidas, setComConcluidas] = useState(false);
  if (!visivel) {
    return (
      <Folha titulo="Financeiro" onBack={onBack}>
        <div style={{ padding: "50px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 34 }}>🔒</div>
          <div style={{ fontSize: 15, fontWeight: 800, margin: "6px 0" }}>Os valores estão ocultos</div>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 14 }}>O relatório financeiro só é montado com os valores liberados.</div>
          <button onClick={pedir} style={btnEscuro} className="no-print">Mostrar valores</button>
        </div>
      </Folha>
    );
  }
  const base = obras.filter(o => comConcluidas || o.status !== "Concluído");
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
    <Folha titulo="Financeiro" onBack={onBack}
      subtitulo={`${grupos.length} obra${grupos.length === 1 ? "" : "s"} · ${base.length} contratos ${comConcluidas ? "(inclui concluídos)" : "em aberto"} · documento com valores — uso interno`}
      controles={<Opcao checked={comConcluidas} onChange={setComConcluidas}>Incluir concluídas</Opcao>}>
      <div style={grade(3)}>
        <Kpi rotulo="Contratado" valor={reaisCurto(t.total)} sub={reais(t.total)} destaque="#c9a227" />
        <Kpi rotulo="Recebido" valor={reaisCurto(t.recebido)} sub={t.total ? `${Math.round(t.recebido / t.total * 100)}% do contratado` : ""} destaque={SERIE[0]} />
        <Kpi rotulo="A receber" valor={reaisCurto(t.aReceber)} sub={reais(t.aReceber)} destaque={SERIE[1]} />
        <Kpi rotulo="A pagar (a comprar)" valor={reaisCurto(t.aPagar)} sub="orçado, ainda não comprado" />
        <Kpi rotulo="A entregar" valor={reaisCurto(t.aEntregar)} sub="valor de obra não executado" />
        <Kpi rotulo="🚩 Compras acima do a receber" valor={alertas.length} sub="contratos" destaque={alertas.length ? SERIE[7] : undefined} />
      </div>
      <div style={grade(2)}>
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
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
      </table>
    </Folha>
  );
}
