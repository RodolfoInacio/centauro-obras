// ─────────────────────────────────────────────────────────────────────────────
// IMPRESSÃO DO CRONOGRAMA — mesma receita de DiarioPrint/OrdemServicoPrint: view em tela cheia,
// window.print() e os controles somem pelo .no-print do index.css. A4 paisagem.
//
// O Gantt é uma tabela com um <svg> por linha, e não o Gantt da tela: divs absolutas não saem na
// impressão sem print-color-adjust, e um SVG único da altura do documento é cortado no meio da
// página. Linha de tabela quebra certo e o <thead> repete a régua em toda página. As setas ficam
// de fora (cruzariam SVGs separados) — a coluna Pred. e a legenda cumprem esse papel.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import logoDark from "./assets/logo-dark.png";
import {
  agendar, normConfig, textoDuracao, textoDias, MESES_ABBR, ehDiaUtil, ehResumo,
  percentPonderado, textoPredecessoras, inicioEstaFixo, diasUteisEntre,
} from "./cronograma";

const DIA_MS = 86400000;
const LARGURA_UTIL = 1040; // px da área útil de um A4 paisagem com 10 mm de margem

const NIVEIS = [
  { k: "completo", rotulo: "Completo", max: Infinity },
  { k: "grupos", rotulo: "Até grupos", max: 2 },
  { k: "fases", rotulo: "Só fases", max: 1 },
];

const p2 = n => String(n).padStart(2, "0");
const fmtData = d => d ? `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}` : "—";
const fmtCurta = d => d ? `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : "—";
const meiaNoite = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnDourado = { background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const TEAL = "#0d9488", TEAL_CLARO = "#99f6e4";

export default function CronogramaPrint({ cronograma: c, obras, dataBaseEfetiva, origemInicio, onBack }) {
  const [versao, setVersao] = useState("cliente"); // cliente | interna
  const [detalhe, setDetalhe] = useState("grupos");
  const [mostrarPct, setMostrarPct] = useState(true);

  const obra = c.obraId ? obras.find(o => o.id === c.obraId) : null;

  // Nome sugerido pelo "Salvar como PDF" é o título da aba.
  useEffect(() => {
    const antes = document.title;
    document.title = `Cronograma — ${c.titulo}`;
    return () => { document.title = antes; };
  }, [c.titulo]);

  // Mesmo cálculo do editor: o início herdado do macro vence a data base própria.
  const cfg = normConfig(dataBaseEfetiva ? { ...c.config, dataBase: dataBaseEfetiva } : c.config);
  const tasks = c.tasks || [];
  const sched = agendar(tasks, cfg);
  const hoje = new Date();

  let inicio = null, termino = null;
  for (const t of tasks) {
    const s = sched[t.id]; if (!s) continue;
    if (!inicio || s.inicio < inicio) inicio = s.inicio;
    if (!termino || s.termino > termino) termino = s.termino;
  }
  const folhas = tasks.filter((_, i) => !ehResumo(tasks, i));
  const pctGeral = percentPonderado(folhas, cfg);
  const diasUteis = inicio && termino ? diasUteisEntre(inicio, termino, cfg) : 0;
  const diasCorridos = inicio && termino ? Math.round((meiaNoite(termino) - meiaNoite(inicio)) / DIA_MS) + 1 : 0;

  // Detalhe é só apresentação: tarefa oculta continua pesando nas datas e nos %.
  const maxNivel = NIVEIS.find(n => n.k === detalhe).max;
  const linhas = tasks.filter(t => t.nivel <= maxNivel && sched[t.id]);

  // ── escala da régua: de segunda a domingo, cobrindo o projeto inteiro ──
  const COL = { id: 26, nome: 214, dur: 60, ini: 92, term: 82, pct: mostrarPct ? 38 : 0, pred: 52 };
  const larguraTabela = Object.values(COL).reduce((a, b) => a + b, 0);
  const W = LARGURA_UTIL - larguraTabela;
  const base = inicio ? meiaNoite(inicio) : meiaNoite(hoje);
  const tIni = new Date(base.getFullYear(), base.getMonth(), base.getDate() - ((base.getDay() + 6) % 7)); // segunda
  const fim = termino ? meiaNoite(termino) : base;
  const tFim = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate() + (7 - ((fim.getDay() + 6) % 7))); // segunda seguinte
  const totalDias = Math.max(7, Math.round((tFim - tIni) / DIA_MS));
  const pxDia = W / totalDias;
  const xDe = d => ((d - tIni) / DIA_MS) * pxDia;
  const dias = Array.from({ length: totalDias }, (_, i) => new Date(tIni.getFullYear(), tIni.getMonth(), tIni.getDate() + i));
  const xHoje = hoje >= tIni && hoje <= tFim ? xDe(hoje) : null;

  // ── resumo ──
  const minNivel = tasks.length ? Math.min(...tasks.map(t => t.nivel)) : 0;
  const nivelFase = tasks.some(t => t.nivel === minNivel + 1) ? minNivel + 1 : minNivel;
  const fases = tasks.filter(t => t.nivel === nivelFase && sched[t.id]);
  const ultima = folhas.reduce((acc, t) => (!acc || sched[t.id].termino > sched[acc.id].termino) ? t : acc, null);
  const atrasadas = folhas.filter(t => sched[t.id].termino < hoje && sched[t.id].percent < 100);
  const andamento = folhas.filter(t => sched[t.id].inicio <= hoje && sched[t.id].termino > hoje && sched[t.id].percent < 100);
  const fixadas = folhas.filter(inicioEstaFixo);

  return (
    <div style={{ padding: 24, maxWidth: 1120, margin: "0 auto", color: "#1e293b", background: "#fff", minHeight: "100vh" }}>
      <style>{`
        @page { size: A4 landscape; margin: 10mm; }
        @media print {
          html, body { background: #fff !important; }
          .cr-folha { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .cr-tabela thead { display: table-header-group; }
          .cr-tabela tr { page-break-inside: avoid; break-inside: avoid; }
          .cr-bloco { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>

      {/* ── controles ── */}
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 14px" }}>
        <button onClick={onBack} style={btnEscuro}>← Voltar</button>
        <Seletor rotulo="Versão" valor={versao} onChange={setVersao}
          opcoes={[{ k: "cliente", rotulo: "Cliente" }, { k: "interna", rotulo: "Interna" }]} />
        <Seletor rotulo="Detalhe" valor={detalhe} onChange={setDetalhe} opcoes={NIVEIS} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer" }}>
          <input type="checkbox" checked={mostrarPct} onChange={e => setMostrarPct(e.target.checked)} /> Mostrar % concluído
        </label>
        <span style={{ fontSize: 12, color: "#64748b" }}>Use “Salvar como PDF” no diálogo para gerar o arquivo.</span>
        <button onClick={() => window.print()} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir</button>
      </div>

      <div className="cr-folha">
        {/* ── cabeçalho ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, borderBottom: "3px solid #1a1a1a", paddingBottom: 10, marginBottom: 12 }}>
          <img src={logoDark} alt="Centauro Esquadrias" style={{ height: 42 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, color: "#64748b", textTransform: "uppercase" }}>
              Cronograma de execução{versao === "interna" ? " · uso interno" : ""}
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a1a" }}>{c.titulo}</div>
            <div style={{ fontSize: 12, color: "#475569" }}>
              {obra ? `Obra #${obra.numero} — ${obra.cliente}${obra.obra ? ` · ${obra.obra}` : ""}` : "Cronograma avulso"}
            </div>
          </div>
          <div style={{ textAlign: "right", fontSize: 11, color: "#64748b" }}>
            Emitido em<br /><b style={{ color: "#1e293b", fontSize: 12 }}>{fmtData(hoje)}</b>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: mostrarPct ? "repeat(4, 1fr)" : "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
          <Kpi rotulo="Início" valor={fmtData(inicio)} sub={inicio ? `às ${p2(inicio.getHours())}:${p2(inicio.getMinutes())}` : ""} />
          <Kpi rotulo="Término previsto" valor={fmtData(termino)} sub={termino ? `às ${p2(termino.getHours())}:${p2(termino.getMinutes())}` : ""} destaque />
          <Kpi rotulo="Duração" valor={textoDias(diasUteis).replace("dias", "dias úteis")} sub={`${diasCorridos} dias corridos`} />
          {mostrarPct && <Kpi rotulo="Concluído" valor={`${pctGeral}%`} sub={`posição em ${fmtData(hoje)}`} />}
        </div>

        {/* ── Gantt ── */}
        <table className="cr-tabela" style={{ width: LARGURA_UTIL, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 10.5 }}>
          <colgroup>
            <col style={{ width: COL.id }} /><col style={{ width: COL.nome }} /><col style={{ width: COL.dur }} />
            <col style={{ width: COL.ini }} /><col style={{ width: COL.term }} />
            {mostrarPct && <col style={{ width: COL.pct }} />}
            <col style={{ width: COL.pred }} /><col style={{ width: W }} />
          </colgroup>
          <thead>
            <tr style={{ background: "#1a1a1a", color: "#fff" }}>
              <th style={th}>Id</th>
              <th style={{ ...th, textAlign: "left" }}>Tarefa</th>
              <th style={th}>Duração</th>
              <th style={th}>Início</th>
              <th style={th}>Término</th>
              {mostrarPct && <th style={th}>%</th>}
              <th style={th}>Pred.</th>
              <th style={{ ...th, padding: 0 }}><Regua dias={dias} pxDia={pxDia} W={W} /></th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((t, i) => {
              const s = sched[t.id];
              const grupo = s.isSummary;
              return (
                <tr key={t.id} style={{ background: t.nivel === minNivel && grupo ? "#f1f5f9" : i % 2 ? "#fafafa" : "#fff", borderBottom: "1px solid #e2e8f0" }}>
                  <td style={{ ...td, textAlign: "center", color: "#94a3b8" }}>{t.id}</td>
                  <td style={{ ...td, paddingLeft: 5 + (t.nivel - minNivel) * 11, fontWeight: grupo ? 700 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={t.nome}>{t.nome}</td>
                  <td style={{ ...td, textAlign: "center", color: grupo ? "#475569" : "#1e293b" }}>{textoDuracao(t, s)}</td>
                  <td style={{ ...td, textAlign: "center" }}>{fmtCurta(s.inicio)}{!grupo && inicioEstaFixo(t) && <span style={{ fontSize: 8.5, marginLeft: 2 }}>📌</span>}</td>
                  <td style={{ ...td, textAlign: "center" }}>{fmtCurta(s.termino)}</td>
                  {mostrarPct && <td style={{ ...td, textAlign: "center", fontWeight: grupo ? 700 : 400 }}>{s.percent}%</td>}
                  <td style={{ ...td, textAlign: "center", color: "#475569" }}>{grupo ? "" : textoPredecessoras(t.predecessoras)}</td>
                  <td style={{ padding: 0, borderLeft: "1px solid #cbd5e1" }}>
                    <Barra s={s} x0={xDe(s.inicio)} x1={xDe(s.termino)} W={W} dias={dias} pxDia={pxDia} cfg={cfg} xHoje={xHoje} mostrarPct={mostrarPct} marco={!grupo && +s.inicio === +s.termino} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {detalhe !== "completo" && linhas.length < tasks.length && (
          <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
            Exibindo {linhas.length} de {tasks.length} tarefas ({NIVEIS.find(n => n.k === detalhe).rotulo.toLowerCase()}). As tarefas ocultas estão consideradas nas datas e percentuais.
          </div>
        )}

        {/* ── legenda ── */}
        <div className="cr-bloco" style={{ marginTop: 16, border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 14px" }}>
          <Titulo>Como ler este cronograma</Titulo>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 28px", fontSize: 10.5, color: "#334155" }}>
            <Item icone={<svg width="34" height="12"><rect x="1" y="2" width="32" height="8" rx="1" fill={TEAL_CLARO} stroke={TEAL} />{mostrarPct && <rect x="1" y="2" width="14" height="8" fill={TEAL} />}</svg>}>
              <b>Tarefa</b> — a barra vai do início ao término{mostrarPct ? "; a parte escura é o quanto já foi concluído" : ""}.
            </Item>
            <Item icone={<svg width="34" height="12"><rect x="1" y="4" width="32" height="4" fill="#1a1a1a" /><rect x="1" y="2" width="2.5" height="8" fill="#1a1a1a" /><rect x="30.5" y="2" width="2.5" height="8" fill="#1a1a1a" /></svg>}>
              <b>Grupo</b> — reúne as tarefas abaixo dele; vai do primeiro início ao último término.
            </Item>
            <Item icone={<svg width="34" height="12"><path d="M17 1 L22 6 L17 11 L12 6 Z" fill="#1a1a1a" /></svg>}>
              <b>Marco</b> — evento sem duração (uma entrega, uma liberação).
            </Item>
            <Item icone={<svg width="34" height="12"><rect x="10" y="0" width="14" height="12" fill="#e2e8f0" /><line x1="28" y1="0" x2="28" y2="12" stroke="#dc2626" strokeWidth="1.2" /></svg>}>
              <b>Faixa cinza</b> = sábado e domingo, sem trabalho. <b style={{ color: "#dc2626" }}>Linha vermelha</b> = data de emissão.
            </Item>
            <Item icone={<span style={{ fontSize: 13, fontWeight: 800 }}>4</span>}>
              <b>Predecessora</b> — a tarefa começa <b>quando a tarefa 4 termina</b>.
            </Item>
            <Item icone={<span style={{ fontSize: 13, fontWeight: 800 }}>4II</span>}>
              <b>Início com início</b> — a tarefa começa <b>junto com a tarefa 4</b>.
            </Item>
            <Item icone={<span style={{ fontSize: 13, fontWeight: 800 }}>3, 4</span>}>
              <b>Várias predecessoras</b> — começa depois da <b>última</b> delas a liberar.
            </Item>
            <Item icone={<span style={{ fontSize: 13 }}>📌</span>}>
              <b>Data fixada</b> — início combinado, não depende das predecessoras.
            </Item>
          </div>
          <div style={{ fontSize: 10, color: "#64748b", marginTop: 8, borderTop: "1px dashed #e2e8f0", paddingTop: 6 }}>
            Durações em dias úteis: segunda a sexta, {cfg.expediente[0]}–{cfg.almoco?.[0]} e {cfg.almoco?.[1]}–{cfg.expediente[1]} ({cfg.horasDia} h por dia).
            O que passa do expediente continua no próximo dia útil: uma tarefa de 1 dia que começa às 13:00 termina às 12:00 do dia útil seguinte.
          </div>
        </div>

        {/* ── resumo ── */}
        <div className="cr-bloco" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 14 }}>
          <div style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 14px" }}>
            <Titulo>Resumo por fase</Titulo>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #1a1a1a" }}>
                  <th style={thResumo}>Fase</th><th style={thResumo}>Início</th><th style={thResumo}>Término</th>
                  <th style={thResumo}>Duração</th>{mostrarPct && <th style={thResumo}>%</th>}
                </tr>
              </thead>
              <tbody>
                {fases.map(t => {
                  const s = sched[t.id];
                  return (
                    <tr key={t.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "4px 4px", fontWeight: 700 }}>{t.nome}</td>
                      <td style={tdResumo}>{fmtData(s.inicio)}</td>
                      <td style={tdResumo}>{fmtData(s.termino)}</td>
                      <td style={tdResumo}>{textoDias(s.durDias)}</td>
                      {mostrarPct && <td style={tdResumo}>{s.percent}%</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {ultima && (
              <div style={{ fontSize: 10.5, color: "#334155", marginTop: 8 }}>
                <b>Atividade que define o término:</b> {ultima.nome} (tarefa {ultima.id}), prevista para {fmtCurta(sched[ultima.id].termino)}.
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 14px" }}>
            <Titulo>Premissas</Titulo>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10.5, color: "#334155", lineHeight: 1.5 }}>
              <li>Calendário de segunda a sexta, sem trabalho em fins de semana.</li>
              <li>Prazos contados a partir de {fmtData(inicio)}{origemInicio ? `, após a conclusão de “${origemInicio}”` : ""}.</li>
              <li>Datas previstas dependem da liberação da frente de obra e da aprovação de medidas e projeto.</li>
              <li>Atrasos em uma tarefa deslocam as que dependem dela.</li>
              {fixadas.length > 0 && <li>{fixadas.length} tarefa(s) com data fixada (📌) não se deslocam automaticamente.</li>}
            </ul>
          </div>
        </div>

        {versao === "interna" && (
          <div className="cr-bloco" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 8, padding: "10px 14px" }}>
              <Titulo cor="#b91c1c">⚠ Atrasadas em {fmtData(hoje)} ({atrasadas.length})</Titulo>
              {atrasadas.length === 0
                ? <div style={{ fontSize: 10.5, color: "#64748b" }}>Nenhuma tarefa com término vencido e não concluída.</div>
                : <ListaTarefas itens={atrasadas} sched={sched} texto={(s) => `terminava ${fmtCurta(s.termino)} · ${s.percent}% feito`} />}
            </div>
            <div style={{ border: "1px solid #bae6fd", background: "#f0f9ff", borderRadius: 8, padding: "10px 14px" }}>
              <Titulo cor="#0369a1">▶ Em andamento ({andamento.length})</Titulo>
              {andamento.length === 0
                ? <div style={{ fontSize: 10.5, color: "#64748b" }}>Nenhuma tarefa em execução hoje.</div>
                : <ListaTarefas itens={andamento} sched={sched} texto={(s) => `até ${fmtCurta(s.termino)} · ${s.percent}% feito`} />}
              {fixadas.length > 0 && (
                <div style={{ fontSize: 10.5, color: "#334155", marginTop: 8, borderTop: "1px dashed #bae6fd", paddingTop: 6 }}>
                  <b>📌 Datas fixadas à mão:</b> {fixadas.map(t => `${t.id} ${t.nome}`).join(" · ")}
                </div>
              )}
            </div>
          </div>
        )}

        {versao === "cliente" && (
          <div className="cr-bloco" style={{ marginTop: 40, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, padding: "0 40px" }}>
            <Assinatura rotulo="Centauro Esquadrias" />
            <Assinatura rotulo={`De acordo — ${obra?.cliente || "Cliente"}`} />
          </div>
        )}
      </div>
    </div>
  );
}

const th = { padding: "5px 3px", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3, textAlign: "center" };
const td = { padding: "3px 3px", verticalAlign: "middle", height: 20, whiteSpace: "nowrap", overflow: "hidden" };
const thResumo = { textAlign: "left", padding: "4px 4px", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase" };
const tdResumo = { padding: "4px 4px", whiteSpace: "nowrap" };

function Seletor({ rotulo, valor, onChange, opcoes }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155" }}>
      <b>{rotulo}:</b>
      <span style={{ display: "inline-flex", border: "1px solid #cbd5e1", borderRadius: 8, overflow: "hidden" }}>
        {opcoes.map(o => (
          <span key={o.k} role="button" tabIndex={0} onClick={() => onChange(o.k)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") onChange(o.k); }}
            style={{ padding: "5px 11px", cursor: "pointer", fontWeight: 700, fontSize: 12, background: valor === o.k ? "#1a1a1a" : "#fff", color: valor === o.k ? "#fff" : "#334155" }}>
            {o.rotulo}
          </span>
        ))}
      </span>
    </span>
  );
}

function Kpi({ rotulo, valor, sub, destaque }) {
  return (
    <div style={{ border: `1px solid ${destaque ? "#c9a227" : "#cbd5e1"}`, borderLeft: `4px solid ${destaque ? "#c9a227" : "#1a1a1a"}`, borderRadius: 6, padding: "6px 10px" }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{rotulo}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a1a" }}>{valor}</div>
      {sub && <div style={{ fontSize: 10, color: "#64748b" }}>{sub}</div>}
    </div>
  );
}

function Titulo({ children, cor = "#1a1a1a" }) {
  return <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: cor, marginBottom: 8 }}>{children}</div>;
}

function Item({ icone, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 40, flexShrink: 0, display: "inline-flex", justifyContent: "center" }}>{icone}</span>
      <span>{children}</span>
    </div>
  );
}

function ListaTarefas({ itens, sched, texto }) {
  const mostrar = itens.slice(0, 12);
  return (
    <div style={{ fontSize: 10.5, color: "#334155", lineHeight: 1.55 }}>
      {mostrar.map(t => <div key={t.id}>· <b>{t.id}</b> {t.nome} — {texto(sched[t.id])}</div>)}
      {itens.length > mostrar.length && <div style={{ color: "#64748b" }}>e mais {itens.length - mostrar.length}…</div>}
    </div>
  );
}

function Assinatura({ rotulo }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 5, fontSize: 11, fontWeight: 700 }}>{rotulo}</div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>Data: ____/____/________</div>
    </div>
  );
}

// Régua do cabeçalho: meses em cima, início de cada semana embaixo.
function Regua({ dias, pxDia, W }) {
  const meses = [];
  dias.forEach((d, i) => {
    const chave = `${d.getFullYear()}-${d.getMonth()}`;
    if (!meses.length || meses[meses.length - 1].chave !== chave) meses.push({ chave, d, i0: i, n: 0 });
    meses[meses.length - 1].n++;
  });
  const cabeRotuloSemana = pxDia * 7 >= 22;
  return (
    <svg width={W} height={32} style={{ display: "block" }}>
      {meses.map(m => (
        <g key={m.chave}>
          <line x1={m.i0 * pxDia} y1={0} x2={m.i0 * pxDia} y2={32} stroke="#4b5563" />
          {m.n * pxDia >= 26 && (
            <text x={m.i0 * pxDia + 3} y={12} fill="#fff" fontSize="9.5" fontWeight="700">
              {MESES_ABBR[m.d.getMonth()]}{m.n * pxDia >= 50 ? `/${String(m.d.getFullYear()).slice(2)}` : ""}
            </text>
          )}
        </g>
      ))}
      <line x1={0} y1={16} x2={W} y2={16} stroke="#374151" />
      {dias.map((d, i) => d.getDay() === 1 && (
        <g key={i}>
          <line x1={i * pxDia} y1={16} x2={i * pxDia} y2={32} stroke="#374151" />
          {cabeRotuloSemana && <text x={i * pxDia + 2} y={28} fill="#cbd5e1" fontSize="8.5">{p2(d.getDate())}</text>}
        </g>
      ))}
    </svg>
  );
}

function Barra({ s, x0, x1, W, dias, pxDia, cfg, xHoje, mostrarPct, marco }) {
  const H = 18, meio = H / 2;
  const w = Math.max(x1 - x0, 2);
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      {pxDia >= 2.5 && dias.map((d, i) => !ehDiaUtil(d, cfg) && (
        <rect key={i} x={i * pxDia} y={0} width={pxDia} height={H} fill="#eef2f6" />
      ))}
      {dias.map((d, i) => d.getDay() === 1 && <line key={"s" + i} x1={i * pxDia} y1={0} x2={i * pxDia} y2={H} stroke="#e2e8f0" strokeWidth="0.6" />)}
      {marco
        ? <path d={`M${x0} ${meio - 5} L${x0 + 5} ${meio} L${x0} ${meio + 5} L${x0 - 5} ${meio} Z`} fill="#1a1a1a" />
        : s.isSummary
          ? <g fill="#1a1a1a">
              <rect x={x0} y={meio - 2} width={w} height={4} />
              <rect x={x0} y={meio - 4} width={2.5} height={8} />
              <rect x={x0 + w - 2.5} y={meio - 4} width={2.5} height={8} />
            </g>
          : <g>
              <rect x={x0} y={meio - 4.5} width={w} height={9} rx={1} fill={TEAL_CLARO} stroke={TEAL} strokeWidth="0.8" />
              {mostrarPct && s.percent > 0 && <rect x={x0} y={meio - 4.5} width={w * s.percent / 100} height={9} rx={1} fill={TEAL} />}
            </g>}
      {xHoje !== null && <line x1={xHoje} y1={0} x2={xHoje} y2={H} stroke="#dc2626" strokeWidth="1" />}
    </svg>
  );
}
