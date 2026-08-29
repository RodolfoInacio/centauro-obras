import { useState, useMemo } from "react";
import Modal from "./Modal";

// ─────────────────────────────────────────────────────────────────────────────
// Mural fixo de lembretes, ao lado do calendário.
// Lista única e geral: não muda ao virar o mês, porque pendência não respeita mês.
// ─────────────────────────────────────────────────────────────────────────────

// Data de hoje pelo relógio local. Não usar toISOString(): às 21h no Brasil ele já
// devolve o dia seguinte (UTC), e a etiqueta ATRASADO acenderia um dia antes.
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function idLembrete() {
  return "lb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function novoLembrete(texto) {
  return {
    id: idLembrete(),
    texto: texto || "",
    prazo: "",           // opcional — sem prazo, nunca atrasa
    obraId: null,        // opcional — vincula a pendência a uma obra
    concluido: false,
    emAndamento: false,
    arquivado: false,
    ordem: Date.now(),
    criadoEm: new Date().toISOString(),
  };
}

// Undefined-safe, no mesmo espírito de normObra/normAgendamento.
export function normLembrete(l) {
  return {
    ...l,
    texto: l.texto || "",
    prazo: l.prazo || "",
    obraId: l.obraId || null,
    concluido: !!l.concluido,
    emAndamento: !!l.emAndamento,
    arquivado: !!l.arquivado,
    ordem: Number.isFinite(l.ordem) ? l.ordem : 0,
  };
}

// A etiqueta é DERIVADA, nunca gravada — mesma decisão do % do grupo no cronograma.
// Gravam-se os fatos (concluido, emAndamento, prazo); o rótulo sai deles.
export function statusLembrete(l, hoje = hojeLocal()) {
  if (l.concluido) return { chave: "concluido", rotulo: "CONCLUÍDO", cor: "#10b981" };
  if (l.prazo && l.prazo < hoje) return { chave: "atrasado", rotulo: "ATRASADO", cor: "#ef4444" };
  if (l.emAndamento) return { chave: "andamento", rotulo: "EM ANDAMENTO", cor: "#3b82f6" };
  return { chave: "afazer", rotulo: "", cor: "#94a3b8" };
}

// "2026-08-29" → "29/08" (com o ano só quando não é o ano corrente)
function dataCurta(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}` + (a !== hojeLocal().slice(0, 4) ? `/${a.slice(2)}` : "");
}

// Quanto falta (ou faz) para o prazo, em linguagem de gente.
function prazoLegivel(iso, hoje) {
  if (!iso) return "";
  if (iso === hoje) return "hoje";
  const dias = Math.round((new Date(iso + "T12:00:00") - new Date(hoje + "T12:00:00")) / 86400000);
  if (dias === 1) return "amanhã";
  if (dias === -1) return "ontem";
  if (dias < 0) return `${-dias} dias atrás`;
  if (dias <= 7) return `em ${dias} dias`;
  return dataCurta(iso);
}

const btnMini = {
  background: "none", border: "none", cursor: "pointer", padding: "2px 5px",
  borderRadius: 5, fontSize: 12, lineHeight: 1, color: "#94a3b8",
};

export default function PainelLembretes({ lembretes, obras, onSalvar, onExcluir, onSelectObra }) {
  const [aba, setAba] = useState("ativos");          // ativos | arquivados
  const [novo, setNovo] = useState("");
  const [expandido, setExpandido] = useState(null);  // id do lembrete com os detalhes abertos
  const [excluindo, setExcluindo] = useState(null);  // lembrete aguardando confirmação
  const [verConcluidos, setVerConcluidos] = useState(false);

  const hoje = hojeLocal();

  const { atrasados, pendentes, concluidos, arquivados } = useMemo(() => {
    const ativos = lembretes.filter(l => !l.arquivado);
    // Prazo mais apertado primeiro; sem prazo cai para o fim da fila.
    const porPrazo = (a, b) => (a.prazo || "9999").localeCompare(b.prazo || "9999") || (a.ordem || 0) - (b.ordem || 0);
    return {
      atrasados: ativos.filter(l => statusLembrete(l, hoje).chave === "atrasado").sort(porPrazo),
      pendentes: ativos.filter(l => !l.concluido && statusLembrete(l, hoje).chave !== "atrasado").sort(porPrazo),
      concluidos: ativos.filter(l => l.concluido).sort((a, b) => (b.ordem || 0) - (a.ordem || 0)),
      arquivados: lembretes.filter(l => l.arquivado).sort((a, b) => (b.ordem || 0) - (a.ordem || 0)),
    };
  }, [lembretes, hoje]);

  function criar() {
    const texto = novo.trim();
    if (!texto) return;
    const l = novoLembrete(texto);
    onSalvar(l);
    setNovo("");
    setExpandido(l.id);   // já abre os detalhes, para pôr prazo/obra sem procurar
  }

  const nAtivos = atrasados.length + pendentes.length;

  const cardProps = (l) => ({
    l, hoje, obras, aberto: expandido === l.id,
    onAbrir: () => setExpandido(e => e === l.id ? null : l.id),
    onSalvar, onExcluir: () => setExcluindo(l), onSelectObra,
  });

  return (
    <div style={{ width: 340, flexShrink: 0 }}>
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#1a1a1a" }}>📌 Lembretes</div>
          {atrasados.length > 0 && (
            <div style={{ marginLeft: 8, background: "#fee2e2", color: "#dc2626", borderRadius: 999, padding: "1px 8px", fontSize: 10, fontWeight: 800 }}>
              {atrasados.length} atrasado{atrasados.length > 1 ? "s" : ""}
            </div>
          )}
        </div>

        {/* Abas */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {[["ativos", `Ativos (${nAtivos})`], ["arquivados", `Arquivados (${arquivados.length})`]].map(([k, rot]) => (
            <button key={k} onClick={() => setAba(k)}
              style={{
                flex: 1, background: aba === k ? "#1a1a1a" : "#f1f5f9", color: aba === k ? "#fff" : "#64748b",
                border: "none", borderRadius: 7, padding: "6px 8px", fontWeight: 700, fontSize: 11, cursor: "pointer",
              }}>{rot}</button>
          ))}
        </div>

        {aba === "ativos" && (
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input value={novo} onChange={e => setNovo(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") criar(); }}
              placeholder="Novo lembrete… (Enter)"
              style={{ flex: 1, minWidth: 0, border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, boxSizing: "border-box" }} />
            <button onClick={criar} title="Adicionar"
              style={{ background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, width: 34, fontSize: 17, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>+</button>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 320px)", minHeight: 120, overflowY: "auto" }}>
          {aba === "ativos" ? (
            <>
              {nAtivos === 0 && concluidos.length === 0 && (
                <div style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "22px 8px", lineHeight: 1.5 }}>
                  Nada anotado ainda.<br />O que não pode esquecer desta semana?
                </div>
              )}

              {atrasados.length > 0 && <Secao titulo="Atrasados" cor="#dc2626" />}
              {atrasados.map(l => <CardLembrete key={l.id} {...cardProps(l)} />)}

              {pendentes.length > 0 && <Secao titulo="Pendentes" cor="#94a3b8" />}
              {pendentes.map(l => <CardLembrete key={l.id} {...cardProps(l)} />)}

              {concluidos.length > 0 && (
                <button onClick={() => setVerConcluidos(v => !v)}
                  style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: "6px 2px", fontSize: 10.5, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.4 }}>
                  {verConcluidos ? "▾" : "▸"} Concluídos ({concluidos.length})
                </button>
              )}
              {verConcluidos && concluidos.map(l => <CardLembrete key={l.id} {...cardProps(l)} />)}
            </>
          ) : (
            <>
              {arquivados.length === 0 && (
                <div style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "22px 8px" }}>
                  Nenhum lembrete arquivado.
                </div>
              )}
              {arquivados.map(l => (
                <CardLembrete key={l.id} l={l} hoje={hoje} obras={obras} aberto={false} arquivado
                  onAbrir={() => {}} onSalvar={onSalvar} onExcluir={() => setExcluindo(l)} onSelectObra={onSelectObra} />
              ))}
            </>
          )}
        </div>
      </div>

      <Modal open={!!excluindo} title="Excluir lembrete" onClose={() => setExcluindo(null)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 16, lineHeight: 1.5 }}>
          Excluir <strong>“{excluindo?.texto}”</strong> de vez? Isso não tem volta — se for só para
          tirar da frente, use <strong>Arquivar</strong>.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setExcluindo(null)}
            style={{ background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={() => { onSalvar({ ...excluindo, arquivado: true }); setExcluindo(null); }}
            style={{ background: "#f1f5f9", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Arquivar</button>
          <button onClick={() => { onExcluir(excluindo.id); setExcluindo(null); }}
            style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 7, padding: "7px 16px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Excluir</button>
        </div>
      </Modal>
    </div>
  );
}

function Secao({ titulo, cor }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 800, color: cor, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>
      {titulo}
    </div>
  );
}

function CardLembrete({ l, hoje, obras, aberto, arquivado, onAbrir, onSalvar, onExcluir, onSelectObra }) {
  const st = statusLembrete(l, hoje);
  const obra = l.obraId ? obras.find(o => o.id === l.obraId) : null;
  const mudar = (campos) => onSalvar({ ...l, ...campos });

  return (
    <div style={{
      background: l.concluido ? "#f8fafc" : "#fff",
      border: "1px solid " + (st.chave === "atrasado" ? "#fecaca" : "#e2e8f0"),
      borderLeft: "3px solid " + (st.chave === "afazer" ? "#e2e8f0" : st.cor),
      borderRadius: 9, padding: "8px 10px", opacity: arquivado ? 0.75 : 1,
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        {!arquivado && (
          <button onClick={() => mudar({ concluido: !l.concluido, emAndamento: false })}
            title={l.concluido ? "Reabrir" : "Marcar como concluído"}
            style={{
              flexShrink: 0, marginTop: 1, width: 17, height: 17, borderRadius: "50%", cursor: "pointer",
              border: "2px solid " + (l.concluido ? "#10b981" : "#cbd5e1"),
              background: l.concluido ? "#10b981" : "#fff",
              color: "#fff", fontSize: 10, lineHeight: 1, padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{l.concluido ? "✓" : ""}</button>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={onAbrir}
            style={{
              fontSize: 12.5, fontWeight: 600, color: l.concluido ? "#94a3b8" : "#1e293b",
              textDecoration: l.concluido ? "line-through" : "none",
              cursor: arquivado ? "default" : "pointer", wordBreak: "break-word", lineHeight: 1.35,
            }}>{l.texto || <span style={{ color: "#cbd5e1" }}>(sem texto)</span>}</div>

          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
            {st.rotulo && (
              <span style={{ background: st.cor + "1a", color: st.cor, borderRadius: 999, padding: "1px 7px", fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3 }}>
                {st.rotulo}
              </span>
            )}
            {l.prazo && !l.concluido && (
              <span style={{ fontSize: 10.5, color: st.chave === "atrasado" ? "#dc2626" : "#94a3b8", fontWeight: 600 }}>
                {prazoLegivel(l.prazo, hoje)}
              </span>
            )}
            {obra && (
              <span onClick={e => { e.stopPropagation(); onSelectObra(obra.id); }}
                title={`Abrir obra ${obra.numero}`}
                style={{ background: "#f1f5f9", color: "#475569", borderRadius: 999, padding: "1px 7px", fontSize: 9.5, fontWeight: 700, cursor: "pointer", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                #{obra.numero} {obra.cliente}
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexShrink: 0, gap: 1 }}>
          {arquivado ? (
            <>
              <button onClick={() => mudar({ arquivado: false })} title="Restaurar" style={btnMini}>↩</button>
              <button onClick={onExcluir} title="Excluir de vez" style={btnMini}>🗑</button>
            </>
          ) : (
            <>
              <button onClick={onAbrir} title="Editar" style={{ ...btnMini, color: aberto ? "#c9a227" : "#94a3b8" }}>✎</button>
              <button onClick={() => mudar({ arquivado: true })} title="Arquivar" style={btnMini}>📥</button>
            </>
          )}
        </div>
      </div>

      {aberto && !arquivado && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #e2e8f0", display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea value={l.texto} onChange={e => mudar({ texto: e.target.value })} rows={2}
            placeholder="O que precisa ser feito?"
            style={{ border: "1px solid #e2e8f0", borderRadius: 7, padding: "6px 8px", fontSize: 12, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", width: "100%" }} />

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, width: 42, flexShrink: 0 }}>Prazo</div>
            <input type="date" value={l.prazo || ""} onChange={e => mudar({ prazo: e.target.value })}
              style={{ flex: 1, minWidth: 0, border: "1px solid #e2e8f0", borderRadius: 7, padding: "5px 8px", fontSize: 12, boxSizing: "border-box" }} />
            {l.prazo && <button onClick={() => mudar({ prazo: "" })} title="Tirar o prazo" style={btnMini}>✕</button>}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, width: 42, flexShrink: 0 }}>Obra</div>
            <select value={l.obraId || ""} onChange={e => mudar({ obraId: e.target.value || null })}
              style={{ flex: 1, minWidth: 0, border: "1px solid #e2e8f0", borderRadius: 7, padding: "5px 8px", fontSize: 12, background: "#fff", boxSizing: "border-box" }}>
              <option value="">— nenhuma —</option>
              {obras.map(o => <option key={o.id} value={o.id}>#{o.numero} — {o.cliente}</option>)}
            </select>
          </div>

          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12, color: "#475569", cursor: "pointer" }}>
            <input type="checkbox" checked={!!l.emAndamento} disabled={l.concluido}
              onChange={e => mudar({ emAndamento: e.target.checked })} />
            Marcar como <strong style={{ color: "#3b82f6" }}>em andamento</strong>
          </label>

          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={onExcluir}
              style={{ background: "#fff", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 7, padding: "5px 11px", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>Excluir</button>
            <button onClick={onAbrir}
              style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 7, padding: "5px 13px", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}
