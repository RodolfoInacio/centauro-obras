// ─────────────────────────────────────────────────────────────────────────────
// CENTRAL DE AVISOS — o macro de todas as obras abertas: uma linha por contrato (agrupado por
// cliente) e uma coluna por área (itens, documentos, cadastro, prazos, orçar, comprar, medição,
// produção, agenda). As regras moram em avisos.js; aqui é só a apresentação.
// Clique na célula abre a obra já na seção certa.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { fetchResumoAnexos } from "./api";
import { agruparSimples } from "./agrupamento";
import { AREAS, PESO_NIVEL, avisosDaObra, resumoPorArea } from "./avisos";
import { useEstadoSessao } from "./rotas";

const COR = { erro: "#dc2626", atencao: "#d97706", info: "#94a3b8" };
const FUNDO = { erro: "#fee2e2", atencao: "#fef3c7", info: "#f1f5f9" };
const ICONE = { erro: "✕", atencao: "!", info: "•" };
const ROTULO_NIVEL = { erro: "Crítico", atencao: "Atenção", info: "Informativo" };

const inp = { border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 13, background: "#fff" };

export default function CentralAvisos({ obras, agenda, cronogramas, onAbrirObra }) {
  const [anexos, setAnexos] = useState(undefined); // undefined = carregando, null = indisponível
  const [busca, setBusca] = useEstadoSessao("avisos.busca", "");
  const [area, setArea] = useEstadoSessao("avisos.area", "");
  const [nivelMin, setNivelMin] = useEstadoSessao("avisos.nivel", "atencao");
  const [comConcluidas, setComConcluidas] = useEstadoSessao("avisos.concluidas", false);
  const [abertos, setAbertos] = useState(() => new Set());

  useEffect(() => {
    let cancel = false;
    fetchResumoAnexos().then(m => { if (!cancel) setAnexos(m); });
    return () => { cancel = true; };
  }, []);

  // Avisos de cada contrato, já filtrados pelo nível mínimo escolhido.
  const linhas = useMemo(() => {
    const ctx = { anexos: anexos || null, agenda, cronogramas };
    const piso = PESO_NIVEL[nivelMin] || 1;
    return obras
      .filter(o => comConcluidas || o.status !== "Concluído")
      .map(o => {
        const avisos = avisosDaObra(o, ctx).filter(a => PESO_NIVEL[a.nivel] >= piso);
        return { obra: o, avisos, resumo: resumoPorArea(avisos) };
      });
  }, [obras, agenda, cronogramas, anexos, nivelMin, comConcluidas]);

  // KPI: quantos contratos têm pendência em cada área.
  const contagem = useMemo(() => {
    const c = {};
    for (const a of AREAS) c[a.k] = { total: 0, erro: 0 };
    for (const l of linhas) for (const [k, n] of Object.entries(l.resumo)) { c[k].total++; if (n === "erro") c[k].erro++; }
    return c;
  }, [linhas]);

  const termo = busca.trim().toLowerCase();
  const casa = (o) => !termo || String(o.numero).includes(termo)
    || (o.cliente || "").toLowerCase().includes(termo) || (o.obra || "").toLowerCase().includes(termo);
  const porId = new Map(linhas.map(l => [l.obra.id, l]));
  const visiveis = (l) => l && casa(l.obra) && (area ? !!l.resumo[area] : l.avisos.length > 0);
  // Mesma regra das telas de obra: se um contrato do cliente aparece, o grupo aparece junto.
  const grupos = agruparSimples(linhas.map(l => l.obra))
    .map(g => ({ ...g, linhas: g.contratos.map(o => porId.get(o.id)) }))
    .filter(g => g.linhas.some(visiveis))
    .map(g => ({ ...g, peso: Math.max(...g.linhas.map(l => l.avisos.reduce((m, a) => Math.max(m, PESO_NIVEL[a.nivel]), 0))), n: g.linhas.reduce((s, l) => s + l.avisos.length, 0) }))
    .sort((a, b) => b.peso - a.peso || b.n - a.n || a.nome.localeCompare(b.nome));

  const semPendencia = linhas.filter(l => l.avisos.length === 0).length;
  const alternar = id => setAbertos(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", margin: 0 }}>Central de avisos</h2>
        <span style={{ fontSize: 12.5, color: "#64748b" }}>
          {linhas.length} contrato{linhas.length === 1 ? "" : "s"} {comConcluidas ? "" : "em aberto"} · {semPendencia} sem pendência
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar obra ou cliente…" style={{ ...inp, width: 220 }} />
          <select value={nivelMin} onChange={e => setNivelMin(e.target.value)} style={inp} title="Nível mínimo dos avisos mostrados">
            <option value="erro">Só críticos</option>
            <option value="atencao">Críticos e atenção</option>
            <option value="info">Tudo (inclui informativos)</option>
          </select>
          <label style={{ fontSize: 12.5, color: "#334155", display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={comConcluidas} onChange={e => setComConcluidas(e.target.checked)} /> Incluir concluídas
          </label>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16 }}>
        Tudo aqui é calculado dos dados da obra — resolva na obra e o aviso some sozinho.
        {anexos === null && " (Não consegui ler os anexos: documentos são conferidos só pelo checklist.)"}
        {anexos === undefined && " Lendo anexos…"}
      </div>

      {/* KPIs por área — clique filtra */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {AREAS.map(a => {
          const c = contagem[a.k];
          const ativo = area === a.k;
          const cor = c.erro ? COR.erro : c.total ? COR.atencao : "#16a34a";
          return (
            <button key={a.k} onClick={() => setArea(ativo ? "" : a.k)}
              style={{ flex: "1 1 120px", textAlign: "left", background: "#fff", border: `1px solid ${ativo ? cor : "#e2e8f0"}`, boxShadow: ativo ? `0 0 0 2px ${cor}33` : "none", borderRadius: 10, padding: "10px 12px", cursor: "pointer" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>{a.rotulo}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: cor }}>{c.total}</div>
              <div style={{ fontSize: 10.5, color: "#94a3b8" }}>{c.erro ? `${c.erro} crítico${c.erro > 1 ? "s" : ""}` : c.total ? "obras" : "tudo certo"}</div>
            </button>
          );
        })}
      </div>

      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1060 }}>
          <thead>
            <tr style={{ background: "#1a1a1a", color: "#fff" }}>
              <th style={{ textAlign: "left", padding: "9px 12px", fontSize: 12, minWidth: 300 }}>Obra / contrato</th>
              {AREAS.map(a => (
                <th key={a.k} style={{ padding: "9px 4px", fontSize: 10.5, fontWeight: 700, width: 82, background: area === a.k ? "#c9a227" : undefined }}>{a.rotulo}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grupos.map(g => (
              <GrupoLinhas key={g.chave} g={g} visiveis={visiveis} abertos={abertos} alternar={alternar} onAbrirObra={onAbrirObra} areaFiltro={area} />
            ))}
            {grupos.length === 0 && (
              <tr><td colSpan={AREAS.length + 1} style={{ padding: 50, textAlign: "center", color: "#16a34a", fontSize: 14, fontWeight: 600 }}>
                Nenhuma pendência {area ? `em ${AREAS.find(a => a.k === area).rotulo}` : ""} com esse filtro. 👌
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11.5, color: "#64748b", flexWrap: "wrap" }}>
        {["erro", "atencao", "info"].map(n => (
          <span key={n}><Celula nivel={n} /> {ROTULO_NIVEL[n]}</span>
        ))}
        <span><Celula nivel={null} /> Ok</span>
      </div>
    </div>
  );
}

function Celula({ nivel, onClick, title }) {
  return (
    <span onClick={onClick} title={title}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 800,
        cursor: onClick ? "pointer" : "default", verticalAlign: "middle",
        background: nivel ? FUNDO[nivel] : "#dcfce7", color: nivel ? COR[nivel] : "#16a34a" }}>
      {nivel ? ICONE[nivel] : "✓"}
    </span>
  );
}

function GrupoLinhas({ g, visiveis, abertos, alternar, onAbrirObra, areaFiltro }) {
  const varios = g.contratos.length > 1;
  return (
    <>
      {varios && (
        <tr style={{ background: "#f8fafc" }}>
          <td colSpan={AREAS.length + 1} style={{ padding: "7px 12px", fontSize: 12.5, fontWeight: 800, color: "#1a1a1a", borderTop: "1px solid #e2e8f0" }}>
            {g.nome} <span style={{ fontSize: 10.5, color: "#1d4ed8", fontWeight: 700 }}>· {g.contratos.length} contratos</span>
          </td>
        </tr>
      )}
      {g.linhas.map(l => {
        const o = l.obra;
        const aberto = abertos.has(o.id);
        const lista = areaFiltro ? l.avisos.filter(a => a.area === areaFiltro) : l.avisos;
        return (
          <FragmentoLinha key={o.id}>
            <tr style={{ borderTop: "1px solid #eef2f7", opacity: visiveis(l) ? 1 : 0.5 }}>
              <td style={{ padding: "7px 12px", paddingLeft: varios ? 26 : 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => alternar(o.id)} title={aberto ? "Esconder detalhes" : "Ver o que falta"}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 10, width: 14 }}>{aberto ? "▼" : "▶"}</button>
                  <span onClick={() => onAbrirObra(o.id)} style={{ cursor: "pointer", minWidth: 0 }} title="Abrir a obra">
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", marginRight: 6 }}>#{o.numero}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a" }}>{varios ? (o.obra || o.cliente) : o.cliente}</span>
                    {!varios && o.obra && <span style={{ fontSize: 11.5, color: "#64748b" }}> · {o.obra}</span>}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: "#64748b", whiteSpace: "nowrap" }}>{o.status}{o.regrasEtapas === 2 ? " · 🔒" : ""}</span>
                </div>
              </td>
              {AREAS.map(a => {
                const n = l.resumo[a.k] || null;
                const textos = l.avisos.filter(x => x.area === a.k).map(x => x.texto);
                return (
                  <td key={a.k} style={{ textAlign: "center", padding: "5px 2px" }}>
                    <Celula nivel={n} title={textos.length ? textos.join("\n") : "Ok"}
                      onClick={() => onAbrirObra(o.id, a.secao)} />
                  </td>
                );
              })}
            </tr>
            {aberto && (
              <tr>
                <td colSpan={AREAS.length + 1} style={{ padding: "4px 12px 10px 48px", background: "#fcfcfd" }}>
                  {lista.length === 0 && <span style={{ fontSize: 12, color: "#16a34a" }}>Nada pendente.</span>}
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "3px 18px" }}>
                    {[...lista].sort((x, y) => PESO_NIVEL[y.nivel] - PESO_NIVEL[x.nivel]).map((a, i) => (
                      <li key={i} style={{ fontSize: 12, color: "#334155", display: "flex", gap: 6, alignItems: "baseline" }}>
                        <span style={{ color: COR[a.nivel], fontWeight: 800 }}>{ICONE[a.nivel]}</span>
                        <span style={{ color: "#94a3b8", fontSize: 10.5, fontWeight: 700, minWidth: 70 }}>{AREAS.find(x => x.k === a.area)?.rotulo}</span>
                        <span>{a.texto}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            )}
          </FragmentoLinha>
        );
      })}
    </>
  );
}

function FragmentoLinha({ children }) { return <>{children}</>; }
