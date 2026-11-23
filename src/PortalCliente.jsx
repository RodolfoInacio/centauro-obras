// ─────────────────────────────────────────────────────────────────────────────
// Portal do cliente: a obra vista pelo cliente, pensada para o celular (funciona igual no PC).
// Abas: Resumo · Cronograma · Fotos · Itens · Conversa.
//
// Os dados vêm SÓ de portal_obra() (migration_portal.sql) — sem valores, sem equipe, sem compras.
// As datas são calculadas aqui com as mesmas funções do sistema (agendarMacro/andamentoObra), sobre
// o cronograma da obra e a cadeia de cronogramas de que ele depende (que chega sem nome), para o
// cliente ver exatamente as datas que a equipe vê. Nada é gravado, a não ser as mensagens.
//
// A equipe abre a mesma tela em "👁 Ver como o cliente" (`previewObraId`), com a conversa só leitura.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { portalMinhasObras, portalObra, portalAcao, enviarPortalMensagem } from "./api";
import { agendarMacro, ehResumo, naoSeAplica, percentPonderado, percentEsperadoEm, situacaoTarefa, SITUACAO_ROTULO, TOLERANCIA_ATRASO, duracaoParaHoras, normConfig, diasUteisEntre } from "./cronograma";
import { andamentoObra, datasDosItens } from "./planejamento";
import { Rosca, RAMPA, NEUTRO } from "./graficos";
import { ConversaPortal, SugerirData, Folha, fmtDia } from "./PortalConversa.jsx";
import logoCor from "./assets/logo-cor.svg";

const ETAPAS = ["Conf. Medidas", "Produção", "Instalação", "Acabamentos"];
const PESOS = { "Conf. Medidas": 10, "Produção": 30, "Instalação": 50, "Acabamentos": 10 };
const ESTAGIOS = [
  { k: "aguardando", rotulo: "Aguardando medição", cor: NEUTRO },
  { k: "Conf. Medidas", rotulo: "Medido", cor: RAMPA[0] },
  { k: "Produção", rotulo: "Produzido", cor: RAMPA[1] },
  { k: "Instalação", rotulo: "Instalado", cor: RAMPA[3] },
  { k: "Acabamentos", rotulo: "Concluído", cor: "#16a34a" },
];
const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const fmtCurto = d => d ? `${String(d.getDate()).padStart(2, "0")}/${MES[d.getMonth()]}` : "—";
const fmtLongo = d => d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "—";

// ─── modelo ──────────────────────────────────────────────────────────────────
function etapaFeita(etapas, e) {
  const v = (etapas || {})[e] ?? (e === "Acabamentos" ? (etapas || {})["Concluído"] : undefined);
  return typeof v === "boolean" ? v : !!(v && v.feito);
}
function estagioDoItem(it) {
  let ult = "aguardando";
  for (const e of ETAPAS) if (etapaFeita(it.etapas, e)) ult = e;
  return ult;
}
const pctItem = it => ETAPAS.reduce((a, e) => a + (etapaFeita(it.etapas, e) ? PESOS[e] : 0), 0);

export function derivarPortal(d, agora = new Date()) {
  const cronos = d.cronogramas || [];
  const todos = [...cronos, ...(d.cadeia || [])];
  const macro = agendarMacro(todos);
  const and = cronos.length ? andamentoObra(todos, macro, d.id, agora) : null;
  const folhas = [];   // [{cronoId, task, inicio, termino, cfg}]
  const arvores = cronos.map(c => {
    const m = macro.mapa[c.id] || {};
    const sched = m.sched || {};
    const tasks = c.tasks || [];
    const linhas = tasks.map((t, i) => {
      const s = sched[t.id] || {};
      const resumo = ehResumo(tasks, i);
      const nsa = naoSeAplica(t);
      const percent = resumo ? Math.round(s.percent || 0) : Math.max(0, Math.min(100, Math.round(Number(t.percent) || 0)));
      const sit = nsa ? null : resumo
        ? situacaoTarefa(percent, s.inicio, s.termino, agora, m.config)
        : (and?.situacao[`${c.id}|${t.id}`] || situacaoTarefa(percent, s.inicio, s.termino, agora, m.config));
      if (!resumo && !nsa && s.inicio) folhas.push({ cronoId: c.id, task: t, inicio: s.inicio, termino: s.termino, cfg: m.config });
      return { cronoId: c.id, id: t.id, nivel: Number(t.nivel) || 0, nome: t.nome || "", inicio: s.inicio || null, termino: s.termino || null, percent, resumo, nsa, sit, itemId: t.itemId ?? null, etapa: t.etapa || "" };
    });
    return { id: c.id, titulo: c.titulo || "Cronograma", linhas, inicio: m.inicio || null, termino: m.termino || null };
  });

  const itens = d.itens || [];
  const pctItens = itens.length ? Math.round(itens.reduce((a, i) => a + pctItem(i), 0) / itens.length) : 0;
  const cfg0 = folhas[0]?.cfg || normConfig({});
  const pctCrono = folhas.length ? percentPonderado(folhas.map(f => f.task), cfg0) : null;
  const percentGeral = pctCrono ?? pctItens;

  // Curva planejada (0–100) ao longo da obra, pesada pelas horas de cada tarefa.
  let curva = null;
  if (folhas.length) {
    const ini = folhas.reduce((m, f) => !m || f.inicio < m ? f.inicio : m, null);
    let fim = folhas.reduce((m, f) => !m || f.termino > m ? f.termino : m, null);
    if (and?.projetado && and.projetado > fim) fim = and.projetado;
    const pesoTot = folhas.reduce((a, f) => a + duracaoParaHoras(f.task, f.cfg), 0) || 1;
    const planejadoEm = q => folhas.reduce((a, f) => a + duracaoParaHoras(f.task, f.cfg) * percentEsperadoEm(f.inicio, f.termino, q, f.cfg), 0) / pesoTot;
    const N = 36, pontos = [];
    for (let k = 0; k <= N; k++) {
      const q = new Date(ini.getTime() + (fim - ini) * k / N);
      pontos.push({ q, v: planejadoEm(q) });
    }
    curva = { ini, fim, pontos, planejadoHoje: Math.round(planejadoEm(agora)), realHoje: percentGeral, hoje: agora };
  }

  const em14 = new Date(agora.getTime() + 14 * 86400000);
  const proximas = folhas
    .filter(f => (Number(f.task.percent) || 0) < 100 && f.inicio <= em14 && f.termino >= agora)
    .sort((a, b) => a.inicio - b.inicio).slice(0, 6)
    .map(f => ({ nome: f.task.nome, inicio: f.inicio, termino: f.termino, andamento: f.inicio <= agora, percent: Math.round(Number(f.task.percent) || 0) }));

  const porEstagio = Object.fromEntries(ESTAGIOS.map(e => [e.k, 0]));
  itens.forEach(i => { porEstagio[estagioDoItem(i)] += 1; });

  return {
    arvores, folhas, and, curva, proximas, percentGeral, porEstagio,
    datasItens: datasDosItens(todos, macro, d.id),
    inicio: arvores.reduce((m, a) => a.inicio && (!m || a.inicio < m) ? a.inicio : m, null),
    termino: and?.termino || arvores.reduce((m, a) => a.termino && (!m || a.termino > m) ? a.termino : m, null),
    projetado: and?.projetado || null,
    atrasoDias: and?.atrasoDias || 0,
    cfg: cfg0,
  };
}

// ─── tela ────────────────────────────────────────────────────────────────────
function useLargura() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return w;
}

const ABAS = [
  { k: "resumo", rotulo: "Resumo", icone: "📊" },
  { k: "cronograma", rotulo: "Cronograma", icone: "📅" },
  { k: "fotos", rotulo: "Fotos", icone: "📷" },
  { k: "itens", rotulo: "Itens", icone: "🪟" },
  { k: "conversa", rotulo: "Conversa", icone: "💬" },
];

export default function PortalCliente({ previewObraId = null, onVoltar }) {
  const preview = !!previewObraId;
  const [obras, setObras] = useState(preview ? [{ id: previewObraId }] : null);
  const [obraId, setObraId] = useState(previewObraId);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [aba, setAba] = useState(() => { try { return sessionStorage.getItem("portal.aba") || "resumo"; } catch { return "resumo"; } });
  const largura = useLargura();
  const celular = largura < 760;

  useEffect(() => { try { sessionStorage.setItem("portal.aba", aba); } catch { /* ignora */ } window.scrollTo(0, 0); }, [aba]);

  useEffect(() => {
    if (preview) return;
    portalMinhasObras().then(l => {
      setObras(l);
      setObraId(id => id || l[0]?.id || null);
    }).catch(e => { setErro(e.message); setObras([]); });
  }, [preview]);

  const carregar = useCallback(async () => {
    if (!obraId) return;
    try { setDados(await portalObra(obraId)); setErro(""); }
    catch (e) { setErro(e.message); }
  }, [obraId]);
  useEffect(() => { setDados(null); carregar(); }, [carregar]);
  // Volta para a aba: a equipe pode ter atualizado o cronograma ou aprovado uma data.
  useEffect(() => {
    const vis = () => { if (document.visibilityState === "visible") carregar(); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [carregar]);

  const der = useMemo(() => dados ? derivarPortal(dados) : null, [dados]);
  const tarefas = useMemo(() => (der?.folhas || []).map(f => ({ cronoId: f.cronoId, taskId: f.task.id, nome: f.task.nome, inicio: f.inicio, termino: f.termino })), [der]);
  const [sugerindo, setSugerindo] = useState(null);

  const sair = () => supabase.auth.signOut();

  const conteudo = !obras ? <Carregando />
    : obras.length === 0 ? <Vazio erro={erro} onSair={sair} />
    : !dados ? (erro ? <Aviso>{erro}</Aviso> : <Carregando />)
    : aba === "resumo" ? <Resumo d={dados} der={der} celular={celular} onAba={setAba} />
    : aba === "cronograma" ? <Cronograma der={der} preview={preview} onSugerir={t => setSugerindo(t)} />
    : aba === "fotos" ? <Fotos d={dados} />
    : aba === "itens" ? <Itens d={dados} der={der} />
    : <div style={cartao}><ConversaPortal obraId={obraId} lado="cliente" tarefas={tarefas} somenteLeitura={preview} /></div>;

  return (
    <div style={{ minHeight: "100dvh", background: "#f1f5f9", fontFamily: "'Segoe UI', system-ui, sans-serif", color: "#1e293b", paddingBottom: celular ? "calc(76px + env(safe-area-inset-bottom))" : 24 }}>
      {preview && (
        <div style={{ background: "#fef3c7", color: "#92400e", fontSize: 13.5, padding: "8px 16px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <b>👁 Pré-visualização:</b> é assim que o cliente vê a obra. A conversa aqui é só leitura — responda pela seção da obra.
          {onVoltar && <button onClick={onVoltar} style={{ marginLeft: "auto", minHeight: 34, padding: "0 12px", border: "1px solid #f59e0b", background: "#fff", borderRadius: 8, fontWeight: 700, cursor: "pointer" }}>← Voltar à obra</button>}
        </div>
      )}
      <header style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, boxSizing: "border-box" }}>
          <img src={logoCor} alt="Centauro Esquadrias" style={{ height: 30, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {obras && obras.length > 1 ? (
              <select value={obraId || ""} onChange={e => setObraId(e.target.value)}
                style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px", fontSize: 14, fontWeight: 700, background: "#fff" }}>
                {obras.map(o => <option key={o.id} value={o.id}>#{o.numero || o.id} · {o.obra || o.cliente}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 12.5, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {dados ? `Proposta #${dados.numero}` : "Portal do cliente"}
              </div>
            )}
          </div>
          {!preview && <button onClick={sair} style={{ minHeight: 40, padding: "0 12px", border: "1px solid #e2e8f0", background: "#fff", borderRadius: 10, fontSize: 13, fontWeight: 700, color: "#475569", cursor: "pointer" }}>Sair</button>}
        </div>
        {!celular && obras?.length > 0 && <Abas aba={aba} setAba={setAba} topo />}
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "14px 16px", boxSizing: "border-box" }}>
        {dados && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2, wordBreak: "break-word" }}>{dados.obra || dados.cliente}</div>
            <div style={{ fontSize: 14, color: "#64748b", marginTop: 2 }}>{[dados.cliente, dados.cidade].filter(Boolean).join(" · ")}</div>
          </div>
        )}
        {conteudo}
      </main>

      {celular && obras?.length > 0 && <Abas aba={aba} setAba={setAba} />}
      {sugerindo && (
        <SugerirData tarefas={tarefas} inicial={sugerindo}
          onEnviar={async m => { await enviarPortalMensagem({ obraId, lado: "cliente", ...m }); setAba("conversa"); }}
          onFechar={() => setSugerindo(null)} />
      )}
    </div>
  );
}

function Abas({ aba, setAba, topo = false }) {
  return (
    <nav style={topo
      ? { maxWidth: 760, margin: "0 auto", display: "flex", gap: 4, padding: "0 12px", boxSizing: "border-box" }
      : { position: "fixed", left: 0, right: 0, bottom: 0, background: "#fff", borderTop: "1px solid #e2e8f0", display: "flex", zIndex: 60, paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -4px 16px rgba(15,23,42,0.06)" }}>
      {ABAS.map(a => {
        const ativa = a.k === aba;
        return (
          <button key={a.k} type="button" onClick={() => setAba(a.k)} aria-current={ativa ? "page" : undefined}
            style={topo
              ? { minHeight: 44, padding: "0 14px", border: "none", borderBottom: `3px solid ${ativa ? "#ED5454" : "transparent"}`, background: "transparent", fontSize: 14.5, fontWeight: ativa ? 800 : 600, color: ativa ? "#1e293b" : "#64748b", cursor: "pointer" }
              : { flex: 1, minHeight: 60, border: "none", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, fontSize: 11.5, fontWeight: ativa ? 800 : 600, color: ativa ? "#ED5454" : "#64748b", cursor: "pointer", padding: 0 }}>
            <span style={{ fontSize: topo ? 15 : 20, lineHeight: 1, marginRight: topo ? 6 : 0, filter: ativa ? "none" : "grayscale(0.6)" }}>{a.icone}</span>
            {a.rotulo}
          </button>
        );
      })}
    </nav>
  );
}

const cartao = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14, marginBottom: 12, boxSizing: "border-box", minWidth: 0 };
const tituloCartao = { fontSize: 15, fontWeight: 800, marginBottom: 10 };
function Carregando() { return <div style={{ textAlign: "center", color: "#64748b", padding: 50, fontSize: 15 }}>Carregando…</div>; }
function Aviso({ children }) { return <div style={{ ...cartao, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b", fontSize: 14.5 }}>{children}</div>; }
function Vazio({ erro, onSair }) {
  return (
    <div style={{ ...cartao, textAlign: "center", padding: 28 }}>
      <div style={{ fontSize: 36 }}>🏗️</div>
      <div style={{ fontWeight: 800, fontSize: 17, marginTop: 6 }}>Nenhuma obra liberada ainda</div>
      <div style={{ color: "#64748b", fontSize: 14.5, marginTop: 6 }}>{erro || "Assim que a Centauro liberar a sua obra, ela aparece aqui."}</div>
      <button onClick={onSair} style={{ marginTop: 16, minHeight: 44, padding: "0 18px", border: "1px solid #e2e8f0", background: "#fff", borderRadius: 10, fontWeight: 700, cursor: "pointer" }}>Sair</button>
    </div>
  );
}

// ─── Resumo ──────────────────────────────────────────────────────────────────
function Resumo({ d, der, celular, onAba }) {
  const [capa, setCapa] = useState("");
  useEffect(() => {
    if (!d.capaAnexoId) return;
    portalAcao("anexo", { anexoId: d.capaAnexoId }).then(r => setCapa(r.url)).catch(() => setCapa(""));
  }, [d.capaAnexoId]);

  const temCrono = der.folhas.length > 0;
  const prazo = d.dataLimiteEntrega ? new Date(d.dataLimiteEntrega + "T12:00") : null;
  const previsto = der.projetado || der.termino;
  const atrasado = der.atrasoDias > 0;
  const passaPrazo = prazo && previsto && previsto > new Date(prazo.getFullYear(), prazo.getMonth(), prazo.getDate(), 23, 59);
  const situacao = !temCrono ? { t: "Cronograma em preparação", c: "#64748b", f: "#f1f5f9" }
    : der.percentGeral >= 100 ? { t: "Obra concluída", c: "#15803d", f: "#dcfce7" }
    : atrasado ? { t: `Cerca de ${der.atrasoDias} dia${der.atrasoDias === 1 ? " útil" : "s úteis"} além do planejado`, c: "#b45309", f: "#fef3c7" }
    : der.curva && der.percentGeral + TOLERANCIA_ATRASO < der.curva.planejadoHoje
      ? { t: "Um pouco abaixo do planejado para hoje — a previsão de término está mantida", c: "#b45309", f: "#fef3c7" }
      : { t: "Dentro do planejado", c: "#15803d", f: "#dcfce7" };
  const colunas = celular ? "1fr 1fr" : "repeat(4, 1fr)";
  const dadosRosca = ESTAGIOS.map(e => ({ rotulo: e.rotulo, valor: der.porEstagio[e.k] || 0, cor: e.cor })).filter(x => x.valor > 0);
  const nItens = (d.itens || []).length;

  return (
    <>
      {capa && <img src={capa} alt="" style={{ width: "100%", height: celular ? 180 : 260, objectFit: "cover", borderRadius: 14, display: "block", marginBottom: 12 }} />}
      <div style={{ ...cartao, background: situacao.f, borderColor: "transparent", color: situacao.c, fontWeight: 800, fontSize: 15.5, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20 }}>{!temCrono ? "🗓️" : situacao.c === "#b45309" ? "⏳" : "✅"}</span>{situacao.t}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: colunas, gap: 10, marginBottom: 12 }}>
        <Numero rotulo="Concluído" valor={`${der.percentGeral}%`} sub={temCrono ? `planejado p/ hoje: ${der.curva.planejadoHoje}%` : "pelas etapas dos itens"} />
        <Numero rotulo="Início" valor={der.inicio ? fmtCurto(der.inicio) : "—"} sub={der.inicio ? String(der.inicio.getFullYear()) : "a definir"} />
        <Numero rotulo="Previsão de término" valor={previsto ? fmtCurto(previsto) : "—"} sub={previsto ? String(previsto.getFullYear()) : "a definir"} alerta={atrasado} />
        <Numero rotulo="Prazo do contrato" valor={prazo ? fmtCurto(prazo) : "—"} sub={prazo ? (passaPrazo ? "previsão passa do prazo" : String(prazo.getFullYear())) : "conforme cronograma"} alerta={passaPrazo} />
      </div>

      <div style={cartao}>
        <div style={tituloCartao}>Andamento geral</div>
        <BarraProgresso pct={der.percentGeral} marca={temCrono ? der.curva.planejadoHoje : null} />
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, color: "#475569", marginTop: 8 }}>
          <span><Bolinha cor="#2563eb" /> Realizado {der.percentGeral}%</span>
          {temCrono && <span><span style={{ display: "inline-block", width: 2, height: 12, background: "#1e293b", marginRight: 6, verticalAlign: -1 }} />Planejado para hoje {der.curva.planejadoHoje}%</span>}
        </div>
      </div>

      {temCrono && (
        <div style={cartao}>
          <div style={tituloCartao}>Planejado × realizado</div>
          <CurvaS curva={der.curva} />
        </div>
      )}

      {nItens > 0 && (
        <div style={cartao}>
          <div style={tituloCartao}>Esquadrias por etapa</div>
          <Rosca dados={dadosRosca} centro={nItens} sub={nItens === 1 ? "item" : "itens"} tamanho={celular ? 130 : 150} />
          <div style={{ marginTop: 16, display: "grid", gap: 9 }}>
            {ETAPAS.map((e, i) => {
              const n = (d.itens || []).filter(it => etapaFeita(it.etapas, e)).length;
              return (
                <div key={e}>
                  <div style={{ display: "flex", fontSize: 13.5, marginBottom: 3 }}>
                    <span style={{ flex: 1 }}>{e}</span>
                    <b style={{ fontVariantNumeric: "tabular-nums" }}>{n} de {nItens}</b>
                  </div>
                  <div style={{ height: 10, background: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: `${(n / nItens) * 100}%`, height: "100%", background: RAMPA[i + 1], borderRadius: 999 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={cartao}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <div style={{ ...tituloCartao, marginBottom: 0, flex: 1 }}>Próximas atividades</div>
          {temCrono && <button onClick={() => onAba("cronograma")} style={btnLink}>Ver cronograma →</button>}
        </div>
        {der.proximas.length === 0
          ? <div style={{ fontSize: 14, color: "#64748b" }}>{temCrono ? "Nada previsto para as próximas duas semanas." : "O cronograma da obra ainda está sendo montado pela Centauro."}</div>
          : der.proximas.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderTop: i ? "1px solid #f1f5f9" : "none" }}>
              <div style={{ width: 52, flexShrink: 0, textAlign: "center", background: p.andamento ? "#eff6ff" : "#f8fafc", borderRadius: 10, padding: "5px 0" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: p.andamento ? "#1d4ed8" : "#1e293b" }}>{String(p.inicio.getDate()).padStart(2, "0")}</div>
                <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase" }}>{MES[p.inicio.getMonth()]}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, wordBreak: "break-word" }}>{p.nome}</div>
                <div style={{ fontSize: 13, color: "#64748b" }}>{p.andamento ? `Em andamento · ${p.percent}% · até ${fmtCurto(p.termino)}` : `${fmtCurto(p.inicio)} → ${fmtCurto(p.termino)}`}</div>
              </div>
            </div>
          ))}
      </div>

      <button onClick={() => onAba("conversa")} style={{ ...cartao, width: "100%", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, fontFamily: "inherit" }}>
        <span style={{ fontSize: 26 }}>💬</span>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontWeight: 800, fontSize: 15 }}>Fale com a Centauro</span>
          <span style={{ display: "block", fontSize: 13.5, color: "#64748b" }}>Comentários, perguntas e sugestões de data</span>
        </span>
        <span style={{ color: "#94a3b8", fontSize: 18 }}>›</span>
      </button>
    </>
  );
}
const btnLink = { border: "none", background: "transparent", color: "#2563eb", fontWeight: 700, fontSize: 13.5, cursor: "pointer", minHeight: 36, padding: "0 4px" };
function Bolinha({ cor }) { return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: cor, marginRight: 6, verticalAlign: -1 }} />; }

function Numero({ rotulo, valor, sub, alerta }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: `4px solid ${alerta ? "#f59e0b" : "#ED5454"}`, borderRadius: 12, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.3 }}>{rotulo}</div>
      <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.25, color: alerta ? "#b45309" : "#1e293b" }}>{valor}</div>
      {sub && <div style={{ fontSize: 12, color: alerta ? "#b45309" : "#64748b" }}>{sub}</div>}
    </div>
  );
}

function BarraProgresso({ pct, marca, altura = 16 }) {
  return (
    <div style={{ position: "relative", height: altura, background: "#e2e8f0", borderRadius: 999, overflow: "visible" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: pct >= 100 ? "#16a34a" : "#2563eb", borderRadius: 999 }} />
      {marca != null && <div title={`Planejado: ${marca}%`} style={{ position: "absolute", left: `calc(${Math.max(0, Math.min(100, marca))}% - 1px)`, top: -4, bottom: -4, width: 2, background: "#1e293b", borderRadius: 1 }} />}
    </div>
  );
}

// Curva S: linha do planejado ao longo da obra + o ponto do realizado hoje.
function CurvaS({ curva }) {
  const W = 360, H = 190, E = 34, D = 10, T = 12, B = 30;
  const { ini, fim, pontos, hoje, realHoje } = curva;
  const span = Math.max(1, fim - ini);
  const x = q => E + ((q - ini) / span) * (W - E - D);
  const y = v => T + (1 - v / 100) * (H - T - B);
  const caminho = pontos.map((p, i) => `${i ? "L" : "M"}${x(p.q).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const hojeDentro = hoje >= ini && hoje <= fim;
  const xh = x(Math.max(ini, Math.min(fim, hoje)));
  const marcasX = [0, 0.5, 1].map(f => new Date(ini.getTime() + span * f));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 640 }} role="img" aria-label={`Planejado para hoje ${curva.planejadoHoje}%, realizado ${realHoje}%`}>
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={E} x2={W - D} y1={y(v)} y2={y(v)} stroke="#e7e5e4" />
            <text x={E - 6} y={y(v) + 3.5} textAnchor="end" fontSize="11" fill="#52514e">{v}%</text>
          </g>
        ))}
        {marcasX.map((q, i) => (
          <text key={i} x={x(q)} y={H - 10} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} fontSize="11" fill="#52514e">{fmtCurto(q)}</text>
        ))}
        <path d={caminho} fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinejoin="round" />
        {hojeDentro && <line x1={xh} x2={xh} y1={T} y2={H - B} stroke="#1e293b" strokeDasharray="3 3" />}
        {hojeDentro && <text x={xh + (xh > W / 2 ? -4 : 4)} y={T + 9} textAnchor={xh > W / 2 ? "end" : "start"} fontSize="10" fontWeight="700" fill="#1e293b">hoje</text>}
        <circle cx={xh} cy={y(realHoje)} r="6" fill="#2563eb" stroke="#fff" strokeWidth="2" />
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, color: "#475569", marginTop: 4 }}>
        <span><span style={{ display: "inline-block", width: 16, height: 3, background: "#94a3b8", marginRight: 6, verticalAlign: 3 }} />Planejado</span>
        <span><Bolinha cor="#2563eb" />Realizado hoje: {realHoje}%</span>
      </div>
    </div>
  );
}

// ─── Cronograma ──────────────────────────────────────────────────────────────
function Cronograma({ der, preview, onSugerir }) {
  const [abertas, setAbertas] = useState(() => new Set());
  const [detalhe, setDetalhe] = useState(null);
  if (!der.arvores.length) {
    return <div style={{ ...cartao, color: "#64748b", fontSize: 14.5, textAlign: "center", padding: 26 }}>🗓️ O cronograma da obra ainda está sendo montado pela Centauro.</div>;
  }
  const ini = der.inicio, fim = der.projetado && der.projetado > der.termino ? der.projetado : der.termino;
  const hoje = new Date();
  const alterna = k => setAbertas(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <>
      <div style={{ fontSize: 13.5, color: "#64748b", margin: "0 2px 10px" }}>
        Toque numa etapa para abrir o que tem dentro. Em cada atividade dá para sugerir outra data.
      </div>
      {der.arvores.map(a => {
        const base = Math.min(...a.linhas.map(l => l.nivel));
        // Mostra uma linha se todos os resumos acima dela estiverem abertos.
        const visiveis = [];
        const pilha = [];
        a.linhas.forEach((l, i) => {
          while (pilha.length && pilha[pilha.length - 1].nivel >= l.nivel) pilha.pop();
          const visivel = pilha.every(p => abertas.has(`${a.id}|${p.id}`));
          if (visivel) visiveis.push({ l, prof: l.nivel - base, i });
          if (l.resumo) pilha.push(l);
        });
        return (
          <div key={a.id} style={{ ...cartao, padding: 0, overflow: "hidden" }}>
            {der.arvores.length > 1 && <div style={{ padding: "10px 14px", fontWeight: 800, borderBottom: "1px solid #f1f5f9" }}>{a.titulo}</div>}
            {visiveis.map(({ l, prof }) => {
              const k = `${a.id}|${l.id}`;
              const aberta = abertas.has(k);
              const sit = l.sit ? SITUACAO_ROTULO[l.sit] : null;
              return (
                <button key={k} type="button" onClick={() => l.resumo ? alterna(k) : setDetalhe(l)}
                  style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: "1px solid #f1f5f9", background: l.resumo && prof === 0 ? "#f8fafc" : "#fff", padding: `11px 14px 11px ${14 + prof * 16}px`, cursor: "pointer", fontFamily: "inherit", color: "#1e293b", minHeight: 56 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {l.resumo
                      ? <span style={{ width: 16, color: "#64748b", fontSize: 12, transform: aberta ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block" }}>▶</span>
                      : <span style={{ width: 16 }} />}
                    <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: l.resumo ? 800 : 600, textDecoration: l.nsa ? "line-through" : "none", color: l.nsa ? "#94a3b8" : "#1e293b", wordBreak: "break-word" }}>{l.nome}</span>
                    {!l.nsa && <span style={{ fontSize: 14, fontWeight: 800, color: l.percent >= 100 ? "#15803d" : "#1e293b" }}>{l.percent}%</span>}
                  </div>
                  {l.nsa ? (
                    <div style={{ fontSize: 12.5, color: "#94a3b8", paddingLeft: 24, marginTop: 2 }}>não se aplica</div>
                  ) : (
                    <div style={{ paddingLeft: 24, marginTop: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "#64748b" }}>
                        <span>{fmtCurto(l.inicio)} → {fmtCurto(l.termino)}</span>
                        {sit && <span style={{ fontSize: 11.5, fontWeight: 800, color: sit.cor, border: `1px solid ${sit.cor}`, borderRadius: 999, padding: "1px 8px" }}>{sit.rotulo}</span>}
                      </div>
                      <MiniLinha ini={ini} fim={fim} a={l.inicio} b={l.termino} pct={l.percent} hoje={hoje} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
      {detalhe && (
        <Folha titulo={detalhe.nome} onFechar={() => setDetalhe(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Numero rotulo="Início" valor={fmtCurto(detalhe.inicio)} sub={detalhe.inicio ? fmtLongo(detalhe.inicio) : ""} />
            <Numero rotulo="Término" valor={fmtCurto(detalhe.termino)} sub={detalhe.termino ? fmtLongo(detalhe.termino) : ""} />
          </div>
          <div style={{ margin: "14px 0 6px", fontSize: 14, color: "#475569" }}>
            Duração: <b>{detalhe.inicio && detalhe.termino ? `${Math.max(1, Math.round(diasUteisEntre(detalhe.inicio, detalhe.termino, der.cfg)))} dias úteis` : "—"}</b>
            {detalhe.sit && <> · <b style={{ color: SITUACAO_ROTULO[detalhe.sit].cor }}>{SITUACAO_ROTULO[detalhe.sit].rotulo}</b></>}
          </div>
          <BarraProgresso pct={detalhe.percent} />
          <div style={{ fontSize: 13.5, color: "#64748b", marginTop: 6 }}>{detalhe.percent}% concluído</div>
          {!preview && !detalhe.nsa && detalhe.percent < 100 && (
            <button type="button" onClick={() => { onSugerir({ cronoId: detalhe.cronoId, taskId: detalhe.id }); setDetalhe(null); }}
              style={{ width: "100%", minHeight: 50, marginTop: 18, background: "#fff", color: "#1d4ed8", border: "2px solid #2563eb", borderRadius: 12, fontWeight: 800, fontSize: 15.5, cursor: "pointer" }}>
              📅 Sugerir outra data
            </button>
          )}
        </Folha>
      )}
    </>
  );
}

// Barrinha de tempo: onde a atividade fica dentro da obra inteira, com o "hoje".
function MiniLinha({ ini, fim, a, b, pct, hoje }) {
  if (!ini || !fim || !a || !b) return null;
  const span = Math.max(1, fim - ini);
  const l = Math.max(0, (a - ini) / span * 100), w = Math.max(1.5, (b - a) / span * 100);
  const h = (hoje - ini) / span * 100;
  return (
    <div style={{ position: "relative", height: 8, background: "#f1f5f9", borderRadius: 999, marginTop: 6 }}>
      <div style={{ position: "absolute", left: `${l}%`, width: `${Math.min(w, 100 - l)}%`, top: 0, bottom: 0, background: "#bfdbfe", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "#16a34a" : "#2563eb" }} />
      </div>
      {h >= 0 && h <= 100 && <div style={{ position: "absolute", left: `${h}%`, top: -3, bottom: -3, width: 2, background: "#1e293b", opacity: 0.6 }} />}
    </div>
  );
}

// ─── Fotos ───────────────────────────────────────────────────────────────────
function Fotos({ d }) {
  const dias = (d.diarios || []).filter(x => (x.fotos || []).length || (x.atividades || []).length);
  const todas = dias.flatMap(x => (x.fotos || []).map(f => ({ ...f, dia: x.dia })));
  const [aberta, setAberta] = useState(null); // índice em `todas`
  if (!dias.length) return <div style={{ ...cartao, color: "#64748b", fontSize: 14.5, textAlign: "center", padding: 26 }}>📷 As fotos da obra aparecem aqui conforme a equipe registra o diário de cada dia.</div>;
  return (
    <>
      {dias.map(x => (
        <div key={x.id} style={cartao}>
          <div style={{ fontWeight: 800, fontSize: 15 }}>{fmtDia(x.dia)}</div>
          {(x.atividades || []).filter(a => a.texto).length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14, color: "#475569" }}>
              {x.atividades.filter(a => a.texto).slice(0, 6).map((a, i) => <li key={i}>{a.texto}</li>)}
            </ul>
          )}
          {(x.fotos || []).length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginTop: 10 }}>
              {x.fotos.map(f => (
                <button key={f.id} type="button" onClick={() => setAberta(todas.findIndex(t => t.id === f.id && t.dia === x.dia))}
                  style={{ padding: 0, border: "none", background: "#e2e8f0", borderRadius: 10, overflow: "hidden", aspectRatio: "4 / 3", cursor: "pointer" }}>
                  <img src={f.url} alt={f.legenda || ""} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {aberta != null && todas[aberta] && (
        <div onClick={() => setAberta(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 1000, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", color: "#fff", padding: "10px 12px" }}>
            <span style={{ flex: 1, fontSize: 14 }}>{fmtDia(todas[aberta].dia)} · {aberta + 1}/{todas.length}</span>
            <button aria-label="Fechar" style={{ width: 44, height: 44, border: "none", background: "rgba(255,255,255,0.15)", color: "#fff", borderRadius: 12, fontSize: 18, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, padding: "0 8px" }}>
            <img src={todas[aberta].url} alt="" onClick={e => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
          {todas[aberta].legenda && <div style={{ color: "#fff", textAlign: "center", fontSize: 14.5, padding: "8px 16px" }}>{todas[aberta].legenda}</div>}
          <div onClick={e => e.stopPropagation()} style={{ display: "flex", gap: 10, padding: "10px 12px calc(14px + env(safe-area-inset-bottom))" }}>
            <button disabled={aberta === 0} onClick={() => setAberta(a => a - 1)} style={navFoto(aberta === 0)}>‹ Anterior</button>
            <button disabled={aberta === todas.length - 1} onClick={() => setAberta(a => a + 1)} style={navFoto(aberta === todas.length - 1)}>Próxima ›</button>
          </div>
        </div>
      )}
    </>
  );
}
const navFoto = off => ({ flex: 1, minHeight: 48, border: "none", borderRadius: 12, background: off ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.2)", color: off ? "rgba(255,255,255,0.4)" : "#fff", fontWeight: 700, fontSize: 15, cursor: off ? "default" : "pointer" });

// ─── Itens e documentos ──────────────────────────────────────────────────────
const CATEGORIA_DOC = { contrato: "Contrato", orcamento: "Orçamento", comprovante: "Comprovante", projeto: "Projeto", foto: "Foto", nota_fiscal: "Nota fiscal", outro: "Documento" };
function Itens({ d, der }) {
  const [baixando, setBaixando] = useState(null);
  const [erro, setErro] = useState("");
  async function abrir(a) {
    // Janela aberta no clique (antes do await), senão o Safari do iPhone bloqueia o pop-up.
    const janela = window.open("", "_blank");
    setBaixando(a.id); setErro("");
    try {
      const r = await portalAcao("anexo", { anexoId: a.id });
      if (janela) janela.location.href = r.url; else window.location.href = r.url;
    } catch (e) { janela?.close(); setErro(e.message); }
    setBaixando(null);
  }
  const itens = d.itens || [];
  return (
    <>
      <div style={{ fontSize: 13.5, color: "#64748b", margin: "0 2px 10px" }}>{itens.length} ite{itens.length === 1 ? "m" : "ns"} na obra. Medidas em milímetros (largura × altura).</div>
      {itens.map(it => {
        const est = ESTAGIOS.find(e => e.k === estagioDoItem(it));
        const datas = der.datasItens[Number(it.id)];
        return (
          <div key={it.id} style={cartao}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ width: 34, height: 34, flexShrink: 0, borderRadius: 10, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#475569" }}>{it.id}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, wordBreak: "break-word" }}>{it.descricao || it.tipo || "Item"}</div>
                <div style={{ fontSize: 13.5, color: "#64748b", marginTop: 3 }}>
                  {[it.qtd ? `${it.qtd} un.` : "", it.L && it.H ? `${Number(it.L).toLocaleString("pt-BR")} × ${Number(it.H).toLocaleString("pt-BR")} mm` : "", it.localizacao].filter(Boolean).join(" · ")}
                </div>
                {(it.vidro || it.perfil) && <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2, wordBreak: "break-word" }}>{[it.perfil && `Perfil ${it.perfil}`, it.vidro].filter(Boolean).join(" · ")}</div>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 10 }}>
              {ETAPAS.map(e => {
                const ok = etapaFeita(it.etapas, e);
                return <span key={e} style={{ fontSize: 12, fontWeight: 700, borderRadius: 999, padding: "4px 9px", background: ok ? "#dcfce7" : "#f1f5f9", color: ok ? "#15803d" : "#94a3b8" }}>{ok ? "✓ " : ""}{e}</span>;
              })}
            </div>
            <div style={{ fontSize: 13, color: "#475569", marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span>Situação: <b>{est?.rotulo}</b></span>
              {datas?.porEtapa?.["Instalação"]?.inicio && <span>Instalação prevista: <b>{fmtCurto(datas.porEtapa["Instalação"].inicio)}</b></span>}
            </div>
          </div>
        );
      })}

      <div style={{ ...tituloCartao, margin: "18px 2px 8px" }}>📄 Documentos</div>
      {erro && <Aviso>{erro}</Aviso>}
      {(d.anexos || []).length === 0
        ? <div style={{ ...cartao, color: "#64748b", fontSize: 14 }}>Nenhum documento liberado ainda.</div>
        : (d.anexos || []).map(a => (
          <button key={a.id} type="button" onClick={() => abrir(a)} disabled={baixando === a.id}
            style={{ ...cartao, width: "100%", display: "flex", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "#1e293b", minHeight: 60 }}>
            <span style={{ fontSize: 24 }}>{/pdf/i.test(a.mime || "") ? "📕" : /image/i.test(a.mime || "") ? "🖼️" : "📄"}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, fontSize: 14.5, wordBreak: "break-word" }}>{a.nome}</span>
              <span style={{ display: "block", fontSize: 12.5, color: "#64748b" }}>{CATEGORIA_DOC[a.categoria] || "Documento"} · {fmtDia(a.em)}</span>
            </span>
            <span style={{ color: "#2563eb", fontWeight: 700, fontSize: 13.5 }}>{baixando === a.id ? "Abrindo…" : "Abrir"}</span>
          </button>
        ))}
    </>
  );
}
