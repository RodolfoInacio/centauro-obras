import { useState, useEffect, useMemo, useCallback } from "react";
import Modal from "./Modal";
import InputData from "./InputData";
import { useSigilo, Dinheiro, Oculto, OlhoFinanceiro } from "./Sigilo";
import { useComunicacao } from "./Comunicacao";
import { useEstadoSessao } from "./rotas";
import { fetchFinanceiro, salvarContratoFin, lancarBaixaFin, anexarNaBaixaFin, fetchAnexosObra } from "./api";
import { enviarArquivos, urlsComCache } from "./AnexosObra";
import {
  FORMAS_PAGAMENTO, SITUACOES, cent, hojeLocal, normContratoFin, normParcela, somaParcelas,
  caixaDaBaixa, gerarParcelas, situacaoContrato, encargosSugeridos, camposEspelho, espelhoDiferente,
} from "./recebimentos";

// ─────────────────────────────────────────────────────────────────────────────
// 💰 Financeiro: o contrato de cada obra (parcelas), os recebimentos (baixas) e o que falta
// receber. É o ÚNICO lugar onde valor de contrato e recebido mudam; a obra só espelha
// (`obra.financeiroResumo`, `valorTotal`, `valorRecebido`). Gravar exige o acesso "financeiro"
// (ou master) — o banco confere (RLS em fin_contratos/fin_baixas), a tela só esconde os botões.
// Como o estoque, todo lançamento espera o banco e relê tudo: nada de debounce com dinheiro.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = "#1a1a1a";
const OURO = "#c9a227";
const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };
const card = { background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", border: "1px solid #eef2f7" };
const th = { padding: "8px 10px", fontWeight: 600, fontSize: 11.5, textAlign: "left", whiteSpace: "nowrap" };
const td = { padding: "7px 10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "middle" };
const num = { textAlign: "right", whiteSpace: "nowrap" };
const btn = (cor = BRAND, claro = false) => ({
  background: claro ? "#fff" : cor, color: claro ? cor : "#fff", border: `1px solid ${cor}`, borderRadius: 7,
  padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
});

const fmtData = d => d ? d.split("-").reverse().join("/") : "—";
const rotuloObra = o => `#${o.numero} — ${o.cliente || "sem cliente"}`;

function Chip({ sit, extra }) {
  const s = SITUACOES[sit];
  return <span style={{ background: s.fundo, color: s.cor, borderRadius: 10, padding: "2px 8px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{s.rotulo}{extra}</span>;
}

function Kpi({ rotulo, v, cor = "#1e293b", sub }) {
  return (
    <div style={{ ...card, padding: "12px 14px", borderLeft: `4px solid ${cor}` }}>
      <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>{rotulo}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: cor, marginTop: 2 }}><Dinheiro v={v} /></div>
      {sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Campo de R$ (some com os valores ocultos, como o resto do app).
function CampoValor({ value, onChange, ...resto }) {
  return (
    <Oculto>
      <input type="number" min={0} step="0.01" value={value === 0 ? "" : value} placeholder="0,00"
        onChange={e => onChange(Math.max(0, cent(e.target.value)))} style={inp} {...resto} />
    </Oculto>
  );
}

function usePode() {
  const com = useComunicacao();
  return { pode: !!(com?.temAcesso?.("financeiro") || com?.eu?.master), eu: com?.eu || null };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function FinanceiroView({ obras, obraId = null, onAbrirFicha, onVoltar, onAbrirObra, onEspelhar, onAtividade, onRelatorio }) {
  const { visivel, desbloquear } = useSigilo();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const { pode } = usePode();
  const [fin, setFin] = useState(undefined);   // undefined = carregando · null = sem a migration
  const [erroCarga, setErroCarga] = useState("");

  const carregar = useCallback(async () => {
    try { setFin(await fetchFinanceiro()); setErroCarga(""); }
    catch (e) { setErroCarga(e.message); }
  }, []);
  useEffect(() => { if (visivel) carregar(); }, [visivel, carregar]);

  const baixasPorObra = useMemo(() => {
    const m = {};
    for (const b of fin?.baixas || []) (m[b.obraId] ||= []).push(b);
    return m;
  }, [fin]);

  // O retrato de cada obra com contrato (hoje).
  const sits = useMemo(() => {
    const out = {};
    if (!fin) return out;
    for (const o of obras) {
      const c = fin.contratos[o.id];
      if (c) out[o.id] = situacaoContrato(c.contrato, baixasPorObra[o.id] || [], hojeLocal());
    }
    return out;
  }, [fin, obras, baixasPorObra]);

  // Espelho na obra: depois de qualquer alteração (e ao abrir, se outra aba lançou e não espelhou),
  // a obra recebe valor do contrato, recebido e o resumo. Só quem pode gravar o financeiro espelha.
  useEffect(() => {
    if (!pode || !fin) return;
    for (const o of obras) {
      const s = sits[o.id];
      if (s && espelhoDiferente(o, s)) onEspelhar(o.id, camposEspelho(s));
    }
  }, [pode, fin, sits, obras, onEspelhar]);

  if (!visivel) {
    return (
      <div style={{ padding: "60px 20px", display: "flex", justifyContent: "center" }}>
        <form onSubmit={e => { e.preventDefault(); if (!desbloquear(pw)) { setErr("Senha incorreta."); setPw(""); } }}
          style={{ ...card, padding: 32, width: 340, maxWidth: "100%", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 34, textAlign: "center", marginBottom: 6 }}>🔒</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: BRAND, textAlign: "center" }}>Área Financeira</div>
          <div style={{ fontSize: 13, color: "#64748b", textAlign: "center", marginBottom: 20 }}>Digite a senha para acessar</div>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus placeholder="Senha"
            style={{ ...inp, padding: "10px 12px", fontSize: 14, marginBottom: 12 }} />
          {err && <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <button type="submit" style={{ ...btn(), width: "100%", padding: 11, fontSize: 14 }}>Acessar</button>
        </form>
      </div>
    );
  }

  if (fin === null) {
    return (
      <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
        <div style={{ ...card, padding: 20, borderLeft: "4px solid #f59e0b" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Financeiro por contrato ainda não está ativo</div>
          <div style={{ fontSize: 13, color: "#475569" }}>
            Rode <code>supabase/migration_financeiro.sql</code> no SQL Editor do Supabase e dê o acesso
            "Financeiro" às pessoas em Configurações → Pessoas e acessos.
          </div>
        </div>
      </div>
    );
  }
  if (fin === undefined) {
    return <div style={{ padding: 60, textAlign: "center", color: "#94a3b8" }}>{erroCarga ? <span style={{ color: "#dc2626" }}>Erro ao carregar o financeiro: {erroCarga}</span> : "Carregando o financeiro…"}</div>;
  }

  const ctx = { fin, sits, baixasPorObra, pode, carregar, onAtividade };

  if (obraId) {
    const obra = obras.find(o => o.id === obraId);
    if (!obra) return <div style={{ padding: 60, textAlign: "center", color: "#94a3b8" }}>Obra não encontrada (arquivada ou excluída).</div>;
    return <FichaFinanceira obra={obra} ctx={ctx} onVoltar={onVoltar} onAbrirObra={onAbrirObra} />;
  }
  return <Painel obras={obras} ctx={ctx} onAbrirFicha={onAbrirFicha} onRelatorio={onRelatorio} erroCarga={erroCarga} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// Painel: indicadores + quatro abas.
function Painel({ obras, ctx, onAbrirFicha, onRelatorio, erroCarga }) {
  const { fin, sits, pode } = ctx;
  const [aba, setAba] = useEstadoSessao("fin.aba", "receber");
  const [busca, setBusca] = useEstadoSessao("fin.busca", "");
  const [filtroSit, setFiltroSit] = useEstadoSessao("fin.sit", "abertas");
  const [mes, setMes] = useEstadoSessao("fin.mes", hojeLocal().slice(0, 7));
  const [baixando, setBaixando] = useState(null);     // {obra, parcelaId}
  const [gerando, setGerando] = useState(null);       // obra
  const hoje = hojeLocal();
  const em30 = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

  const comContrato = obras.filter(o => sits[o.id]);
  const semContrato = obras.filter(o => !sits[o.id]);
  const casa = (o) => {
    const q = busca.trim().toUpperCase();
    return !q || [o.numero, o.cliente, o.obra, o.cidade].some(x => String(x || "").toUpperCase().includes(q));
  };

  const parcelas = comContrato.flatMap(o => sits[o.id].parcelas.map(p => ({ ...p, obra: o })));
  const abertas = parcelas.filter(p => p.saldo > 0.004);
  const soma = (l, k) => cent(l.reduce((a, x) => a + x[k], 0));
  const k = {
    contratado: soma(comContrato.map(o => ({ v: sits[o.id].contrato.valor })), "v"),
    recebido: soma(comContrato.map(o => sits[o.id]), "principal"),
    aReceber: soma(comContrato.map(o => sits[o.id]), "aReceber"),
    vencido: soma(abertas.filter(p => p.situacao === "vencida"), "saldo"),
    prox30: soma(abertas.filter(p => p.situacao !== "vencida" && p.vencimento && p.vencimento <= em30), "saldo"),
  };
  const baixasMes = fin.baixas.filter(b => b.dia?.startsWith(mes));
  const validasMes = (() => {
    const estornadas = new Set(fin.baixas.filter(b => b.tipo === "estorno").map(b => b.estornoDe));
    return baixasMes.filter(b => b.tipo !== "estorno" && !estornadas.has(b.id));
  })();
  const caixaMes = cent(validasMes.reduce((a, b) => a + caixaDaBaixa(b), 0));
  const encargosMes = cent(validasMes.reduce((a, b) => a + b.juros + b.multa, 0));
  const descontosMes = cent(validasMes.reduce((a, b) => a + b.desconto, 0));

  const abas = [
    { id: "receber", rotulo: "A receber", n: abertas.length },
    { id: "recebimentos", rotulo: "Recebimentos" },
    { id: "obras", rotulo: "Por obra", n: comContrato.length },
    { id: "pendentes", rotulo: "Sem financeiro", n: semContrato.length, alerta: semContrato.length > 0 },
  ];

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: BRAND, margin: 0 }}>Financeiro</h2>
        {!pode && <span style={{ fontSize: 11.5, background: "#f1f5f9", color: "#475569", borderRadius: 8, padding: "3px 9px", fontWeight: 700 }}>👁 Só leitura — lançar exige o acesso Financeiro</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {onRelatorio && <button onClick={onRelatorio} style={btn()}>🖨 Relatório com gráficos</button>}
          <OlhoFinanceiro rotulo />
        </div>
      </div>
      {erroCarga && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{erroCarga}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 10 }}>
        <Kpi rotulo="Contratado" v={k.contratado} cor={OURO} sub={`${comContrato.length} contrato(s) com financeiro`} />
        <Kpi rotulo="Recebido" v={k.recebido} cor="#10b981" sub={k.contratado ? `${Math.round(k.recebido / k.contratado * 100)}% do contratado` : null} />
        <Kpi rotulo="A receber" v={k.aReceber} cor="#f59e0b" />
        <Kpi rotulo="Vencido" v={k.vencido} cor="#dc2626" sub={`${abertas.filter(p => p.situacao === "vencida").length} parcela(s)`} />
        <Kpi rotulo="Vence em 30 dias" v={k.prox30} cor="#2563eb" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 18 }}>
        <div style={{ ...card, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>MÊS</span>
          <input type="month" value={mes} onChange={e => e.target.value && setMes(e.target.value)} style={{ ...inp, width: "auto" }} />
        </div>
        <Kpi rotulo="Entrou no caixa (mês)" v={caixaMes} cor="#047857" sub={`${validasMes.length} recebimento(s)`} />
        <Kpi rotulo="Juros + multa (mês)" v={encargosMes} cor="#7c3aed" />
        <Kpi rotulo="Descontos (mês)" v={descontosMes} cor="#64748b" />
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {abas.map(a => (
          <button key={a.id} onClick={() => setAba(a.id)} style={{
            ...btn(aba === a.id ? BRAND : "#cbd5e1", aba !== a.id), color: aba === a.id ? "#fff" : "#334155",
          }}>
            {a.rotulo}{a.n != null && <span style={{ marginLeft: 6, background: a.alerta ? "#f59e0b" : aba === a.id ? "#fff3" : "#e2e8f0", color: a.alerta ? "#fff" : "inherit", borderRadius: 8, padding: "0 6px" }}>{a.n}</span>}
          </button>
        ))}
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar obra, cliente, cidade…" style={{ ...inp, width: 240, marginLeft: "auto" }} />
      </div>

      {aba === "receber" && (() => {
        const lista = (filtroSit === "todas" ? parcelas : abertas)
          .filter(p => casa(p.obra))
          .filter(p => filtroSit === "vencidas" ? p.situacao === "vencida" : filtroSit === "30" ? p.situacao !== "vencida" && p.vencimento && p.vencimento <= em30 : true)
          .sort((a, b) => (a.vencimento || "9999").localeCompare(b.vencimento || "9999"));
        return (
          <div style={{ ...card, overflow: "auto" }}>
            <div style={{ padding: "10px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[["abertas", "Em aberto"], ["vencidas", "Vencidas"], ["30", "Próximos 30 dias"], ["todas", "Todas (inclui pagas)"]].map(([id, r]) => (
                <button key={id} onClick={() => setFiltroSit(id)} style={{ ...btn(filtroSit === id ? "#2563eb" : "#cbd5e1", filtroSit !== id), color: filtroSit === id ? "#fff" : "#334155", padding: "4px 10px" }}>{r}</button>
              ))}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ background: BRAND, color: "#fff" }}>
                <th style={th}>Vencimento</th><th style={th}>Obra</th><th style={th}>Parcela</th><th style={th}>Forma</th>
                <th style={{ ...th, ...num }}>Valor</th><th style={{ ...th, ...num }}>Saldo</th><th style={th}>Situação</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {lista.map(p => (
                  <tr key={p.obra.id + p.id}>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtData(p.vencimento)}</td>
                    <td style={td}><a onClick={() => onAbrirFicha(p.obra.id)} style={{ cursor: "pointer", color: "#1d4ed8", fontWeight: 600 }}>{rotuloObra(p.obra)}</a></td>
                    <td style={td}>{p.descricao}</td>
                    <td style={{ ...td, color: "#64748b" }}>{p.forma || sits[p.obra.id].contrato.forma}</td>
                    <td style={{ ...td, ...num }}><Dinheiro v={p.valor} /></td>
                    <td style={{ ...td, ...num, fontWeight: 800 }}><Dinheiro v={p.saldo} /></td>
                    <td style={td}><Chip sit={p.situacao} extra={p.diasAtraso ? ` · ${p.diasAtraso}d` : ""} /></td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {pode && p.saldo > 0.004 && <button onClick={() => setBaixando({ obra: p.obra, parcelaId: p.id })} style={btn("#047857")}>Dar baixa</button>}
                    </td>
                  </tr>
                ))}
                {!lista.length && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 30 }}>Nenhuma parcela neste filtro.</td></tr>}
              </tbody>
              {lista.length > 0 && <tfoot><tr style={{ background: "#f8fafc", fontWeight: 800 }}>
                <td style={td} colSpan={4}>{lista.length} parcela(s)</td>
                <td style={{ ...td, ...num }}><Dinheiro v={soma(lista, "valor")} /></td>
                <td style={{ ...td, ...num }}><Dinheiro v={soma(lista, "saldo")} /></td><td style={td} colSpan={2} />
              </tr></tfoot>}
            </table>
          </div>
        );
      })()}

      {aba === "recebimentos" && (
        <ListaBaixas baixas={baixasMes.filter(b => casa(obras.find(o => o.id === b.obraId) || { numero: b.obraId }))}
          todas={fin.baixas} obras={obras} sits={sits} comObra onAbrirFicha={onAbrirFicha}
          vazio={`Nenhum recebimento lançado em ${mes.split("-").reverse().join("/")}.`} />
      )}

      {aba === "obras" && (
        <div style={{ ...card, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ background: BRAND, color: "#fff" }}>
              <th style={th}>Obra</th><th style={th}>Forma / condição</th><th style={{ ...th, ...num }}>Contrato</th>
              <th style={{ ...th, ...num }}>Recebido</th><th style={{ ...th, ...num }}>A receber</th><th style={{ ...th, ...num }}>Vencido</th>
              <th style={th}>Próxima parcela</th><th style={th}>%</th>
            </tr></thead>
            <tbody>
              {comContrato.filter(casa).sort((a, b) => sits[b.id].vencido - sits[a.id].vencido || sits[b.id].aReceber - sits[a.id].aReceber).map(o => {
                const s = sits[o.id];
                const pct = s.contrato.valor ? Math.min(100, Math.round(s.principal / s.contrato.valor * 100)) : 0;
                return (
                  <tr key={o.id} onClick={() => onAbrirFicha(o.id)} style={{ cursor: "pointer" }}>
                    <td style={{ ...td, fontWeight: 700 }}>{rotuloObra(o)}{o.obra && <div style={{ fontWeight: 400, fontSize: 11, color: "#64748b" }}>{o.obra}</div>}</td>
                    <td style={{ ...td, color: "#475569", fontSize: 11.5 }}>{[s.contrato.forma, s.contrato.condicao].filter(Boolean).join(" · ") || "—"}</td>
                    <td style={{ ...td, ...num, color: OURO, fontWeight: 700 }}><Dinheiro v={s.contrato.valor} /></td>
                    <td style={{ ...td, ...num, color: "#047857" }}><Dinheiro v={s.principal} /></td>
                    <td style={{ ...td, ...num, fontWeight: 700 }}><Dinheiro v={s.aReceber} /></td>
                    <td style={{ ...td, ...num, color: s.vencido ? "#dc2626" : "#cbd5e1", fontWeight: 700 }}>{s.vencido ? <Dinheiro v={s.vencido} /> : "—"}</td>
                    <td style={td}>{s.proxima ? <>{fmtData(s.proxima.vencimento)} · <Dinheiro v={s.proxima.saldo} /></> : <span style={{ color: "#047857", fontWeight: 700 }}>Quitado</span>}</td>
                    <td style={{ ...td, minWidth: 80 }}>
                      <div style={{ background: "#e2e8f0", borderRadius: 4, height: 7 }}><div style={{ width: pct + "%", background: "#10b981", height: 7, borderRadius: 4 }} /></div>
                      <div style={{ fontSize: 10.5, color: "#64748b" }}>{pct}%</div>
                    </td>
                  </tr>
                );
              })}
              {!comContrato.length && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 30 }}>Nenhuma obra com financeiro gerado ainda — veja a aba "Sem financeiro".</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {aba === "pendentes" && (
        <div style={{ ...card, overflow: "auto" }}>
          <div style={{ padding: "10px 14px", fontSize: 12.5, color: "#475569", borderBottom: "1px solid #f1f5f9" }}>
            Obras ativas sem o financeiro do contrato. Ao gerar, o valor do contrato e as parcelas passam a valer para a
            obra; o "recebido" antigo pode entrar como saldo inicial.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr style={{ background: BRAND, color: "#fff" }}>
              <th style={th}>Obra</th><th style={th}>Data contrato</th><th style={{ ...th, ...num }}>Valor (atual)</th><th style={{ ...th, ...num }}>Recebido (antigo)</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {semContrato.filter(casa).sort((a, b) => String(b.numero).localeCompare(String(a.numero), "pt-BR", { numeric: true })).map(o => (
                <tr key={o.id}>
                  <td style={{ ...td, fontWeight: 700 }}>{rotuloObra(o)}{o.obra && <div style={{ fontWeight: 400, fontSize: 11, color: "#64748b" }}>{o.obra}</div>}</td>
                  <td style={td}>{fmtData(o.dataContrato)}</td>
                  <td style={{ ...td, ...num }}><Dinheiro v={o.valorTotal || 0} /></td>
                  <td style={{ ...td, ...num, color: "#64748b" }}><Dinheiro v={o.valorRecebido || 0} /></td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {pode ? <button onClick={() => setGerando(o)} style={btn("#047857")}>Gerar financeiro</button>
                      : <button onClick={() => onAbrirFicha(o.id)} style={btn("#64748b", true)}>Abrir</button>}
                  </td>
                </tr>
              ))}
              {!semContrato.length && <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "#047857", padding: 30, fontWeight: 600 }}>✓ Todas as obras ativas têm financeiro gerado.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {baixando && (
        <BaixaModal obra={baixando.obra} sit={sits[baixando.obra.id]} parcelaId={baixando.parcelaId} ctx={ctx}
          onFechar={() => setBaixando(null)} />
      )}
      {gerando && (
        <ContratoModal obra={gerando} atual={null} ctx={ctx}
          onFechar={salvou => { setGerando(null); if (salvou) onAbrirFicha(gerando.id); }} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Lista de baixas (painel: do mês, todas as obras · ficha: todas da obra).
function ListaBaixas({ baixas, todas, obras, sits, comObra = false, onAbrirFicha, vazio, acoes }) {
  const estornoDe = useMemo(() => Object.fromEntries(todas.filter(b => b.tipo === "estorno").map(b => [b.estornoDe, b])), [todas]);
  const ordenadas = [...baixas].sort((a, b) => (b.dia || "").localeCompare(a.dia || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const valido = b => b.tipo !== "estorno" && !estornoDe[b.id];
  const total = cent(ordenadas.filter(valido).reduce((a, b) => a + caixaDaBaixa(b), 0));
  return (
    <div style={{ ...card, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead><tr style={{ background: BRAND, color: "#fff" }}>
          <th style={th}>Data</th>{comObra && <th style={th}>Obra</th>}<th style={th}>Parcela</th><th style={th}>Forma</th>
          <th style={{ ...th, ...num }}>Principal</th><th style={{ ...th, ...num }}>Juros+multa</th><th style={{ ...th, ...num }}>Desconto</th>
          <th style={{ ...th, ...num }}>Recebido</th><th style={th}>NF / anexos</th><th style={th}>Lançado por</th>{acoes && <th style={th}></th>}
        </tr></thead>
        <tbody>
          {ordenadas.map(b => {
            const obra = obras.find(o => o.id === b.obraId);
            const parcela = sits[b.obraId]?.parcelas.find(p => p.id === b.parcelaId);
            const estornada = estornoDe[b.id];
            const riscado = b.tipo === "estorno" || estornada ? { textDecoration: "line-through", color: "#94a3b8" } : {};
            return (
              <tr key={b.id} style={{ background: b.tipo === "estorno" ? "#fef2f2" : undefined }}>
                <td style={{ ...td, fontWeight: 700, ...riscado }}>{fmtData(b.dia)}</td>
                {comObra && <td style={td}>{obra ? <a onClick={() => onAbrirFicha(obra.id)} style={{ cursor: "pointer", color: "#1d4ed8", fontWeight: 600 }}>{rotuloObra(obra)}</a> : "#" + b.obraId}</td>}
                <td style={td}>
                  {b.tipo === "estorno" ? <b style={{ color: "#b91c1c" }}>ESTORNO</b> : b.tipo === "saldo_inicial" ? <b style={{ color: "#7c3aed" }}>SALDO INICIAL</b> : parcela ? parcela.descricao : <span style={{ color: "#64748b" }}>sem parcela</span>}
                  {estornada && <div style={{ fontSize: 10.5, color: "#b91c1c", fontWeight: 700 }}>estornada em {fmtData(estornada.dia)}</div>}
                  {b.obs && <div style={{ fontSize: 10.5, color: "#64748b", maxWidth: 260 }}>{b.obs}</div>}
                </td>
                <td style={{ ...td, color: "#64748b" }}>{b.forma || "—"}</td>
                <td style={{ ...td, ...num, ...riscado }}><Dinheiro v={b.principal} /></td>
                <td style={{ ...td, ...num, ...riscado }}>{b.juros + b.multa ? <Dinheiro v={b.juros + b.multa} /> : "—"}</td>
                <td style={{ ...td, ...num, ...riscado }}>{b.desconto ? <Dinheiro v={b.desconto} /> : "—"}</td>
                <td style={{ ...td, ...num, fontWeight: 800, ...riscado }}><Dinheiro v={caixaDaBaixa(b)} /></td>
                <td style={td}>{b.nfNumero && <div style={{ fontSize: 11 }}>NF {b.nfNumero}</div>}{acoes ? acoes.anexos(b) : b.anexos.length ? `📎 ${b.anexos.length}` : ""}</td>
                <td style={{ ...td, fontSize: 11, color: "#64748b" }}>{b.lancadoPor || "—"}</td>
                {acoes && <td style={{ ...td, textAlign: "right" }}>{acoes.botoes(b, !!estornada)}</td>}
              </tr>
            );
          })}
          {!ordenadas.length && <tr><td colSpan={11} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 30 }}>{vazio}</td></tr>}
        </tbody>
        {ordenadas.length > 0 && <tfoot><tr style={{ background: "#f8fafc", fontWeight: 800 }}>
          <td style={td} colSpan={comObra ? 7 : 6}>Total recebido (sem estornos)</td>
          <td style={{ ...td, ...num }}><Dinheiro v={total} /></td><td style={td} colSpan={acoes ? 3 : 2} />
        </tr></tfoot>}
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Ficha financeira de uma obra.
function FichaFinanceira({ obra, ctx, onVoltar, onAbrirObra }) {
  const { fin, sits, baixasPorObra, pode, carregar, onAtividade } = ctx;
  const { eu } = usePode();
  const reg = fin.contratos[obra.id];
  const sit = sits[obra.id];
  const baixas = baixasPorObra[obra.id] || [];
  const [editando, setEditando] = useState(false);
  const [baixando, setBaixando] = useState(null);       // parcelaId | "" (sem parcela)
  const [anexos, setAnexos] = useState({});
  const [ocupado, setOcupado] = useState("");
  const [erro, setErro] = useState("");

  const lerAnexos = useCallback(() => {
    fetchAnexosObra(obra.id).then(l => setAnexos(Object.fromEntries((l || []).map(a => [a.id, a]))));
  }, [obra.id]);
  useEffect(() => { lerAnexos(); }, [lerAnexos, fin]);

  async function abrirAnexo(a) {
    try { const u = await urlsComCache([a.path]); if (u[a.path]) window.open(u[a.path], "_blank", "noopener"); }
    catch (e) { setErro("Não abriu o anexo: " + e.message); }
  }

  async function estornar(b) {
    const motivo = window.prompt("Estornar este recebimento?\n\nA baixa continua no histórico, riscada, e o valor volta para o a receber.\nMotivo do estorno:");
    if (motivo === null) return;
    if (!motivo.trim()) { setErro("Informe o motivo do estorno."); return; }
    setOcupado(b.id); setErro("");
    try {
      await lancarBaixaFin({ obraId: obra.id, tipo: "estorno", estornoDe: b.id, dia: hojeLocal(), obs: motivo.trim().toUpperCase(), lancadoPor: eu?.nome || "" });
      onAtividade?.(obra.id, `Financeiro: recebimento de ${fmtData(b.dia)} estornado (${motivo.trim()})`);
      await carregar();
    } catch (e) { setErro(e.message); }
    setOcupado("");
  }

  async function anexar(b, files, categoria) {
    if (!files.length) return;
    setOcupado(b.id); setErro("");
    try {
      const { ok, falhas } = await enviarArquivos(obra.id, [...files].map(f => ({ file: f, categoria })), { manterOriginal: true });
      if (ok.length) await anexarNaBaixaFin(b.id, [...b.anexos, ...ok.map(a => a.id)]);
      if (falhas.length) setErro("Não subiram: " + falhas.join(" · "));
      await carregar();
    } catch (e) { setErro(e.message); }
    setOcupado("");
  }

  const acoes = {
    anexos: b => (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {b.anexos.map(id => anexos[id]
          ? <a key={id} onClick={() => abrirAnexo(anexos[id])} title={anexos[id].nome} style={{ cursor: "pointer", color: "#1d4ed8", fontSize: 11, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
              {anexos[id].categoria === "nota_fiscal" ? "🧮" : "🧾"} {anexos[id].nome}</a>
          : <span key={id} style={{ fontSize: 11, color: "#94a3b8" }}>📎 anexo</span>)}
      </div>
    ),
    botoes: (b, estornada) => pode && b.tipo !== "estorno" && (
      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <label style={{ ...btn("#2563eb", true), padding: "3px 8px", opacity: ocupado === b.id ? 0.5 : 1 }} title="Anexar comprovante">
          🧾<input type="file" multiple hidden accept="image/*,application/pdf" onChange={e => { anexar(b, e.target.files, "comprovante"); e.target.value = ""; }} />
        </label>
        <label style={{ ...btn("#2563eb", true), padding: "3px 8px", opacity: ocupado === b.id ? 0.5 : 1 }} title="Anexar nota fiscal">
          NF<input type="file" multiple hidden accept="image/*,application/pdf,.xml" onChange={e => { anexar(b, e.target.files, "nota_fiscal"); e.target.value = ""; }} />
        </label>
        {!estornada && <button disabled={!!ocupado} onClick={() => estornar(b)} style={{ ...btn("#dc2626", true), padding: "3px 8px" }}>Estornar</button>}
      </div>
    ),
  };

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button onClick={onVoltar} style={btn("#64748b", true)}>← Financeiro</button>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800, color: BRAND }}>{rotuloObra(obra)}</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{[obra.obra, obra.cidade].filter(Boolean).join(" · ")}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => onAbrirObra(obra.id)} style={btn("#1d4ed8", true)}>Abrir obra ↗</button>
          <OlhoFinanceiro rotulo />
        </div>
      </div>
      {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{erro}</div>}

      {!sit ? (
        <div style={{ ...card, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Financeiro do contrato ainda não gerado</div>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
            Valor atual da obra <Dinheiro v={obra.valorTotal || 0} /> · recebido antigo <Dinheiro v={obra.valorRecebido || 0} />
          </div>
          {pode ? <button onClick={() => setEditando(true)} style={btn("#047857")}>Gerar financeiro do contrato</button>
            : <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Só quem tem o acesso Financeiro gera.</div>}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
            <Kpi rotulo="Contrato" v={sit.contrato.valor} cor={OURO} />
            <Kpi rotulo="Recebido (principal)" v={sit.principal} cor="#10b981" sub={<>caixa <Dinheiro v={sit.caixa} /></>} />
            <Kpi rotulo="A receber" v={sit.aReceber} cor="#f59e0b" />
            <Kpi rotulo="Vencido" v={sit.vencido} cor="#dc2626" />
            <Kpi rotulo="Juros + multa" v={sit.juros + sit.multa} cor="#7c3aed" />
            <Kpi rotulo="Descontos" v={sit.desconto} cor="#64748b" />
          </div>

          <div style={{ ...card, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>📝 Contrato</div>
              {pode && <button onClick={() => setEditando(true)} style={{ ...btn("#1a1a1a", true), marginLeft: "auto" }}>Editar / renegociar</button>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "8px 16px", fontSize: 13 }}>
              <Info r="Data do contrato" v={fmtData(sit.contrato.dataContrato)} />
              <Info r="Forma de pagamento" v={sit.contrato.forma || "—"} />
              <Info r="Condição" v={sit.contrato.condicao || "—"} />
              <Info r="Multa / juros" v={`${sit.contrato.multaPct}% multa · ${sit.contrato.jurosMesPct}% a.m.`} />
              {sit.contrato.obs && <Info r="Observações" v={sit.contrato.obs} largo />}
            </div>
            {sit.difParcelas !== 0 && (
              <div style={{ marginTop: 10, background: "#fef3c7", color: "#92400e", borderRadius: 8, padding: "6px 10px", fontSize: 12.5 }}>
                ⚠ A soma das parcelas difere do valor do contrato em <Dinheiro v={Math.abs(sit.difParcelas)} />.
              </div>
            )}
            {sit.excedente > 0 && (
              <div style={{ marginTop: 10, background: "#ede9fe", color: "#5b21b6", borderRadius: 8, padding: "6px 10px", fontSize: 12.5 }}>
                Recebido além das parcelas (crédito do cliente): <Dinheiro v={sit.excedente} />
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>Parcelas</div>
            {pode && <button onClick={() => setBaixando("")} style={{ ...btn("#047857", true), marginLeft: "auto" }}>+ Recebimento sem parcela</button>}
          </div>
          <div style={{ ...card, overflow: "auto", marginBottom: 16 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr style={{ background: BRAND, color: "#fff" }}>
                <th style={th}>Parcela</th><th style={th}>Vencimento</th><th style={th}>Forma</th>
                <th style={{ ...th, ...num }}>Valor</th><th style={{ ...th, ...num }}>Recebido</th><th style={{ ...th, ...num }}>Saldo</th><th style={th}>Situação</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {sit.parcelas.map(p => (
                  <tr key={p.id}>
                    <td style={{ ...td, fontWeight: 700 }}>{p.descricao}{p.obs && <div style={{ fontWeight: 400, fontSize: 11, color: "#64748b" }}>{p.obs}</div>}</td>
                    <td style={td}>{fmtData(p.vencimento)}</td>
                    <td style={{ ...td, color: "#64748b" }}>{p.forma || sit.contrato.forma || "—"}</td>
                    <td style={{ ...td, ...num }}><Dinheiro v={p.valor} /></td>
                    <td style={{ ...td, ...num, color: "#047857" }}>{p.abatido ? <Dinheiro v={p.abatido} /> : "—"}</td>
                    <td style={{ ...td, ...num, fontWeight: 800 }}><Dinheiro v={p.saldo} /></td>
                    <td style={td}><Chip sit={p.situacao} extra={p.diasAtraso ? ` · ${p.diasAtraso}d` : ""} /></td>
                    <td style={{ ...td, textAlign: "right" }}>{pode && p.saldo > 0.004 && <button onClick={() => setBaixando(p.id)} style={btn("#047857")}>Dar baixa</button>}</td>
                  </tr>
                ))}
                {!sit.parcelas.length && <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 24 }}>Sem parcelas — edite o contrato para gerar.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ fontWeight: 800, fontSize: 14, margin: "4px 0 8px" }}>Recebimentos</div>
          <ListaBaixas baixas={baixas} todas={baixas} obras={[obra]} sits={sits} acoes={acoes} vazio="Nenhum recebimento lançado." />

          {sit.contrato.historico.length > 0 && (
            <div style={{ ...card, padding: 14, marginTop: 16 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Histórico do contrato</div>
              {[...sit.contrato.historico].reverse().map((h, i) => (
                <div key={i} style={{ fontSize: 12, color: "#475569", padding: "4px 0", borderTop: i ? "1px solid #f1f5f9" : "none" }}>
                  <b>{new Date(h.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</b> · {h.por || "—"} — {h.texto}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editando && <ContratoModal obra={obra} atual={reg ? { contrato: reg.contrato, versao: reg.versao } : null} baixas={baixas} ctx={ctx} onFechar={() => setEditando(false)} />}
      {baixando !== null && sit && <BaixaModal obra={obra} sit={sit} parcelaId={baixando} ctx={ctx} onFechar={() => setBaixando(null)} />}
    </div>
  );
}

function Info({ r, v, largo }) {
  return (
    <div style={{ gridColumn: largo ? "1 / -1" : "auto" }}>
      <div style={lbl}>{r}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Gerar / editar o contrato financeiro. Renegociar depois de haver recebimento pede motivo e
// fica no histórico; parcela que já recebeu dinheiro não sai da lista.
function ContratoModal({ obra, atual, baixas = [], ctx, onFechar }) {
  const { carregar, onAtividade } = ctx;
  const { eu } = usePode();
  const novo = !atual;
  const [c, setC] = useState(() => normContratoFin(atual?.contrato || {
    valor: obra.valorTotal || 0, dataContrato: obra.dataContrato || "", condicao: "",
  }));
  const temBaixas = baixas.length > 0;
  const comBaixa = new Set(baixas.filter(b => b.parcelaId).map(b => b.parcelaId));
  const [ger, setGer] = useState({ entradaPct: 30, entrada: cent((obra.valorTotal || 0) * 0.3), dataEntrada: obra.dataContrato || hojeLocal(), qtd: 3, primeiroVenc: "", intervalo: "mensal", dias: 30 });
  const [motivo, setMotivo] = useState("");
  const legado = cent(obra.valorRecebido);
  const [saldoIni, setSaldoIni] = useState({ usar: novo && legado > 0 && !temBaixas, dia: obra.dataContrato || hojeLocal() });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");

  const set = mud => setC(x => ({ ...x, ...mud }));
  const setParcela = (id, mud) => set({ parcelas: c.parcelas.map(p => p.id === id ? { ...p, ...mud } : p) });
  const soma = somaParcelas(c.parcelas);
  const dif = cent(c.valor - soma);

  function gerar() {
    if (c.parcelas.length && !confirm("Substituir as parcelas atuais pelas geradas?")) return;
    set({ parcelas: gerarParcelas({ valor: c.valor, entrada: ger.entrada, dataEntrada: ger.dataEntrada, qtd: ger.qtd, primeiroVenc: ger.primeiroVenc, intervalo: ger.intervalo, dias: ger.dias, forma: c.forma }) });
  }
  function ajustarUltima() {
    const ult = c.parcelas[c.parcelas.length - 1];
    if (ult) setParcela(ult.id, { valor: cent(ult.valor + dif) });
  }

  async function salvar() {
    setErro("");
    if (!(c.valor > 0)) return setErro("Informe o valor do contrato.");
    if (!c.parcelas.length) return setErro("Gere ou adicione as parcelas.");
    if (dif !== 0) return setErro("A soma das parcelas precisa fechar com o valor do contrato.");
    if (c.parcelas.some(p => !p.vencimento)) return setErro("Toda parcela precisa de vencimento.");
    if (!novo && temBaixas && !motivo.trim()) return setErro("Já há recebimentos: informe o motivo da alteração (fica no histórico).");
    setOcupado(true);
    const agora = new Date().toISOString();
    const por = eu?.nome || "";
    const texto = novo ? `Financeiro gerado: ${c.parcelas.length} parcela(s)` : `Contrato alterado${motivo.trim() ? ": " + motivo.trim().toUpperCase() : ""}`;
    const dados = {
      ...c,
      parcelas: c.parcelas.map(normParcela),
      historico: [...c.historico, { em: agora, porId: eu?.id || null, por, texto }],
      criadoEm: c.criadoEm || agora, criadoPor: c.criadoPor || por,
    };
    try {
      await salvarContratoFin(obra.id, dados, atual?.versao || null);
      if (novo && saldoIni.usar && legado > 0) {
        await lancarBaixaFin({
          obraId: obra.id, tipo: "saldo_inicial", dia: saldoIni.dia || hojeLocal(), principal: legado,
          obs: "RECEBIDO ANTES DO FINANCEIRO POR CONTRATO (VALOR QUE ESTAVA NA OBRA)", lancadoPor: por,
        });
      }
      onAtividade?.(obra.id, novo ? "Financeiro do contrato gerado" : `Financeiro: contrato alterado${motivo.trim() ? " — " + motivo.trim() : ""}`);
      await carregar();
      onFechar(true);
    } catch (e) {
      setErro(e.message);
      setOcupado(false);
    }
  }

  return (
    <Modal open title={novo ? `Gerar financeiro — ${rotuloObra(obra)}` : `Contrato — ${rotuloObra(obra)}`} onClose={() => !ocupado && onFechar(false)} width={880}>
      <div style={{ maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }} data-caixa-alta>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px 12px", marginBottom: 14 }}>
          <label><span style={lbl}>Valor do contrato</span><CampoValor value={c.valor} onChange={v => set({ valor: v })} /></label>
          <label><span style={lbl}>Data do contrato</span><InputData value={c.dataContrato} onChange={v => set({ dataContrato: v })} style={inp} /></label>
          <label><span style={lbl}>Forma de pagamento</span>
            <select value={c.forma} onChange={e => set({ forma: e.target.value })} style={inp}>
              <option value="">—</option>{FORMAS_PAGAMENTO.map(f => <option key={f}>{f}</option>)}
            </select>
          </label>
          <label><span style={lbl}>Multa (%)</span><input type="number" min={0} step="0.1" value={c.multaPct} onChange={e => set({ multaPct: Math.max(0, Number(e.target.value) || 0) })} style={inp} /></label>
          <label><span style={lbl}>Juros ao mês (%)</span><input type="number" min={0} step="0.1" value={c.jurosMesPct} onChange={e => set({ jurosMesPct: Math.max(0, Number(e.target.value) || 0) })} style={inp} /></label>
          <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Condição de pagamento (como está no contrato)</span>
            <input value={c.condicao} onChange={e => set({ condicao: e.target.value })} placeholder="EX.: 30% NA ASSINATURA + 3X MENSAIS" style={inp} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Observações</span>
            <textarea data-livre rows={2} value={c.obs} onChange={e => set({ obs: e.target.value })} style={{ ...inp, resize: "vertical" }} />
          </label>
        </div>

        {!temBaixas && (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 12.5, marginBottom: 8 }}>⚙ Gerar parcelas</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px 10px", alignItems: "end" }}>
              <label><span style={lbl}>Entrada (%)</span>
                <input type="number" min={0} max={100} value={ger.entradaPct} onChange={e => { const pct = Math.min(100, Math.max(0, Number(e.target.value) || 0)); setGer({ ...ger, entradaPct: pct, entrada: cent(c.valor * pct / 100) }); }} style={inp} />
              </label>
              <label><span style={lbl}>Entrada (R$)</span><CampoValor value={ger.entrada} onChange={v => setGer({ ...ger, entrada: v, entradaPct: c.valor ? Math.round(v / c.valor * 1000) / 10 : 0 })} /></label>
              <label><span style={lbl}>Data da entrada</span><InputData value={ger.dataEntrada} onChange={v => setGer({ ...ger, dataEntrada: v })} style={inp} /></label>
              <label><span style={lbl}>Nº de parcelas</span><input type="number" min={0} max={120} value={ger.qtd} onChange={e => setGer({ ...ger, qtd: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} style={inp} /></label>
              <label><span style={lbl}>1º vencimento</span><InputData value={ger.primeiroVenc} onChange={v => setGer({ ...ger, primeiroVenc: v })} style={inp} /></label>
              <label><span style={lbl}>Intervalo</span>
                <select value={ger.intervalo} onChange={e => setGer({ ...ger, intervalo: e.target.value })} style={inp}>
                  <option value="mensal">Mensal (mesmo dia)</option><option value="dias">A cada N dias</option>
                </select>
              </label>
              {ger.intervalo === "dias" && <label><span style={lbl}>Dias</span><input type="number" min={1} value={ger.dias} onChange={e => setGer({ ...ger, dias: Math.max(1, Number(e.target.value) || 30) })} style={inp} /></label>}
              <button onClick={gerar} disabled={!(c.valor > 0)} style={btn("#2563eb")}>Gerar parcelas</button>
            </div>
          </div>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, marginBottom: 6 }}>
          <thead><tr style={{ background: "#f1f5f9" }}>
            <th style={th}>Descrição</th><th style={th}>Vencimento</th><th style={th}>Forma</th><th style={{ ...th, width: 130 }}>Valor</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {c.parcelas.map(p => (
              <tr key={p.id}>
                <td style={td}><input value={p.descricao} onChange={e => setParcela(p.id, { descricao: e.target.value })} style={inp} /></td>
                <td style={td}><InputData value={p.vencimento} onChange={v => setParcela(p.id, { vencimento: v })} style={inp} /></td>
                <td style={td}>
                  <select value={p.forma} onChange={e => setParcela(p.id, { forma: e.target.value })} style={inp}>
                    <option value="">(do contrato)</option>{FORMAS_PAGAMENTO.map(f => <option key={f}>{f}</option>)}
                  </select>
                </td>
                <td style={td}><CampoValor value={p.valor} onChange={v => setParcela(p.id, { valor: v })} /></td>
                <td style={{ ...td, textAlign: "right" }}>
                  {comBaixa.has(p.id)
                    ? <span title="Já tem recebimento ligado" style={{ fontSize: 11, color: "#94a3b8" }}>🔒</span>
                    : <button onClick={() => set({ parcelas: c.parcelas.filter(x => x.id !== p.id) })} style={{ ...btn("#dc2626", true), padding: "3px 8px" }}>✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5, marginBottom: 12 }}>
          <button onClick={() => set({ parcelas: [...c.parcelas, normParcela({ descricao: `PARCELA ${c.parcelas.length + 1}`, valor: Math.max(0, dif) }, c.parcelas.length)] })} style={btn("#1a1a1a", true)}>+ Parcela</button>
          <span style={{ marginLeft: "auto" }}>Soma das parcelas: <b><Dinheiro v={soma} /></b></span>
          {dif !== 0
            ? <><span style={{ color: "#b91c1c", fontWeight: 700 }}>diferença <Dinheiro v={dif} /></span>
                {c.parcelas.length > 0 && <button onClick={ajustarUltima} style={btn("#b45309", true)}>Ajustar na última</button>}</>
            : c.parcelas.length > 0 && <span style={{ color: "#047857", fontWeight: 700 }}>✓ fecha com o contrato</span>}
        </div>

        {novo && legado > 0 && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 12 }}>
            <input type="checkbox" checked={saldoIni.usar} onChange={e => setSaldoIni({ ...saldoIni, usar: e.target.checked })} />
            Lançar os <b><Dinheiro v={legado} /></b> que já estavam como recebidos na obra como <b>saldo inicial</b>, em
            <InputData value={saldoIni.dia} onChange={v => setSaldoIni({ ...saldoIni, dia: v })} style={{ ...inp, width: 150 }} />
            <span style={{ color: "#64748b" }}>(abate as parcelas na ordem de vencimento; dá para estornar depois)</span>
          </label>
        )}

        {!novo && (
          <label style={{ display: "block", marginBottom: 12 }}><span style={lbl}>Motivo da alteração {temBaixas ? "(obrigatório — já há recebimentos)" : "(opcional)"}</span>
            <input value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="EX.: CLIENTE PEDIU PARA ADIAR A 3ª PARCELA" style={inp} />
          </label>
        )}
      </div>
      {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 8, padding: "8px 12px", fontSize: 13, margin: "10px 0" }}>{erro}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={() => onFechar(false)} disabled={ocupado} style={btn("#64748b", true)}>Cancelar</button>
        <button onClick={salvar} disabled={ocupado} style={btn("#047857")}>{ocupado ? "Gravando…" : novo ? "Gerar financeiro" : "Salvar contrato"}</button>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Dar baixa: parcela, data, forma, principal, multa/juros sugeridos, desconto, NF e arquivos.
function BaixaModal({ obra, sit, parcelaId, ctx, onFechar }) {
  const { carregar, onAtividade } = ctx;
  const { eu } = usePode();
  const abertas = sit.parcelas.filter(p => p.saldo > 0.004);
  const [f, setF] = useState(() => {
    const p = sit.parcelas.find(x => x.id === parcelaId);
    return {
      parcelaId: parcelaId || "", dia: hojeLocal(), forma: p?.forma || sit.contrato.forma || "",
      principal: p ? p.saldo : 0, juros: 0, multa: 0, desconto: 0, nfNumero: "", obs: "",
    };
  });
  const [encManual, setEncManual] = useState(false);
  const [arquivos, setArquivos] = useState([]);   // [{file, categoria}]
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const parcela = sit.parcelas.find(p => p.id === f.parcelaId) || null;
  const sug = encargosSugeridos(sit.contrato, parcela, f.principal, f.dia);

  // Multa e juros acompanham parcela/data/valor até alguém digitar neles.
  useEffect(() => {
    if (!encManual) setF(x => ({ ...x, multa: sug.multa, juros: sug.juros }));
  }, [sug.multa, sug.juros, encManual]);

  const total = cent(f.principal + f.juros + f.multa - f.desconto);
  const set = mud => setF(x => ({ ...x, ...mud }));

  async function salvar() {
    setErro("");
    if (!f.dia) return setErro("Informe a data do recebimento.");
    if (!(f.principal > 0) && !(f.juros + f.multa > 0)) return setErro("Informe o valor.");
    if (f.desconto > f.principal + f.juros + f.multa) return setErro("Desconto maior que o valor.");
    setOcupado(true);
    try {
      let ids = [];
      if (arquivos.length) {
        const { ok, falhas } = await enviarArquivos(obra.id, arquivos, { manterOriginal: true });
        ids = ok.map(a => a.id);
        if (falhas.length && !confirm(`Alguns arquivos não subiram:\n${falhas.join("\n")}\n\nLançar a baixa mesmo assim?`)) { setOcupado(false); return; }
      }
      await lancarBaixaFin({ ...f, parcelaId: f.parcelaId || null, obs: f.obs.trim(), anexos: ids, obraId: obra.id, lancadoPor: eu?.nome || "" });
      onAtividade?.(obra.id, `Financeiro: recebimento de ${fmtData(f.dia)} lançado${parcela ? ` (${parcela.descricao})` : ""}`);
      await carregar();
      onFechar();
    } catch (e) {
      setErro(e.message);
      setOcupado(false);
    }
  }

  return (
    <Modal open title={`Dar baixa — ${rotuloObra(obra)}`} onClose={() => !ocupado && onFechar()} width={640}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px 12px" }} data-caixa-alta>
        <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Parcela</span>
          <select value={f.parcelaId} onChange={e => { const p = sit.parcelas.find(x => x.id === e.target.value); set({ parcelaId: e.target.value, principal: p ? p.saldo : f.principal, forma: p?.forma || f.forma }); }} style={inp}>
            <option value="">SEM PARCELA — abate na ordem de vencimento</option>
            {abertas.map(p => <option key={p.id} value={p.id}>{p.descricao} · vence {fmtData(p.vencimento)} · saldo R$ {p.saldo.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</option>)}
          </select>
        </label>
        <label><span style={lbl}>Data do recebimento</span><InputData value={f.dia} onChange={v => set({ dia: v })} style={inp} /></label>
        <label><span style={lbl}>Forma</span>
          <select value={f.forma} onChange={e => set({ forma: e.target.value })} style={inp}>
            <option value="">—</option>{FORMAS_PAGAMENTO.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label><span style={lbl}>Principal (abate da parcela)</span><CampoValor value={f.principal} onChange={v => set({ principal: v })} /></label>
        <label><span style={lbl}>Multa {sug.dias > 0 && !encManual && <span style={{ textTransform: "none", color: "#7c3aed" }}>· sugerida</span>}</span>
          <CampoValor value={f.multa} onChange={v => { setEncManual(true); set({ multa: v }); }} />
        </label>
        <label><span style={lbl}>Juros {sug.dias > 0 && <span style={{ textTransform: "none", color: "#7c3aed" }}>· {sug.dias} dia(s) de atraso</span>}</span>
          <CampoValor value={f.juros} onChange={v => { setEncManual(true); set({ juros: v }); }} />
        </label>
        <label><span style={lbl}>Desconto</span><CampoValor value={f.desconto} onChange={v => set({ desconto: v })} /></label>
        <label><span style={lbl}>Nº da nota fiscal</span><input value={f.nfNumero} onChange={e => set({ nfNumero: e.target.value })} style={inp} /></label>
        <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Observação</span><input value={f.obs} onChange={e => set({ obs: e.target.value })} style={inp} /></label>
      </div>

      {encManual && sug.dias > 0 && (
        <div style={{ fontSize: 11.5, color: "#7c3aed", marginTop: 6 }}>
          Sugerido pelo contrato: multa <Dinheiro v={sug.multa} /> · juros <Dinheiro v={sug.juros} />{" "}
          <a onClick={() => setEncManual(false)} style={{ cursor: "pointer", textDecoration: "underline" }}>usar a sugestão</a>
        </div>
      )}
      {parcela && f.principal > parcela.saldo + 0.004 && (
        <div style={{ fontSize: 12, color: "#b45309", marginTop: 6 }}>O principal passa do saldo desta parcela — o excedente abate as próximas, na ordem de vencimento.</div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <label style={btn("#2563eb", true)}>🧾 Comprovante<input type="file" multiple hidden accept="image/*,application/pdf" onChange={e => { setArquivos(a => [...a, ...[...e.target.files].map(file => ({ file, categoria: "comprovante" }))]); e.target.value = ""; }} /></label>
        <label style={btn("#2563eb", true)}>🧮 Nota fiscal<input type="file" multiple hidden accept="image/*,application/pdf,.xml" onChange={e => { setArquivos(a => [...a, ...[...e.target.files].map(file => ({ file, categoria: "nota_fiscal" }))]); e.target.value = ""; }} /></label>
        {arquivos.map((a, i) => (
          <span key={i} style={{ fontSize: 11.5, background: "#eff6ff", borderRadius: 6, padding: "3px 8px" }}>
            {a.categoria === "nota_fiscal" ? "🧮" : "🧾"} {a.file.name} <a onClick={() => setArquivos(l => l.filter((_, j) => j !== i))} style={{ cursor: "pointer", color: "#dc2626" }}>✕</a>
          </span>
        ))}
      </div>

      <div style={{ marginTop: 14, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 12px", display: "flex", justifyContent: "space-between", fontSize: 14 }}>
        <span>Valor recebido (entra no caixa)</span><b style={{ color: "#047857" }}><Dinheiro v={total} /></b>
      </div>
      {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginTop: 10 }}>{erro}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onFechar} disabled={ocupado} style={btn("#64748b", true)}>Cancelar</button>
        <button onClick={salvar} disabled={ocupado} style={btn("#047857")}>{ocupado ? "Lançando…" : "Lançar recebimento"}</button>
      </div>
    </Modal>
  );
}
