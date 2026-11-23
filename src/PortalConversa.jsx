// Conversa do portal do cliente: a mesma tela serve o cliente (portal) e a equipe (seção da obra).
// Comentário, pergunta e sugestão de data, uma bolha por mensagem, imutáveis como os comentários.
// A sugestão de data mostra tarefa, data atual → sugerida e o estado; a equipe aprova ou recusa
// (o `onDecidir` do pai aplica no cronograma antes de gravar a decisão).
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { fetchPortalMensagens, enviarPortalMensagem, marcarPortalLido } from "./api";

export const fmtDia = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : "—";
};
const fmtQuando = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const hoje = new Date();
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === hoje.toDateString()) return `hoje ${hh}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hh}`;
};

// Mensagens de uma obra, com Realtime; sem ele, confere a cada minuto e quando a aba volta.
export function useMensagensPortal(obraId) {
  const [msgs, setMsgs] = useState(null);
  const [erro, setErro] = useState("");
  const recarregar = useCallback(async () => {
    if (!obraId) return;
    try { setMsgs(await fetchPortalMensagens(obraId)); setErro(""); }
    catch (e) { setErro(e.message); setMsgs(m => m || []); }
  }, [obraId]);
  useEffect(() => {
    if (!obraId) return;
    recarregar();
    const canal = supabase.channel(`portal:${obraId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "portal_mensagens", filter: `obra_id=eq.${obraId}` }, () => recarregar())
      .subscribe();
    const t = setInterval(recarregar, 60000);
    const vis = () => { if (document.visibilityState === "visible") recarregar(); };
    document.addEventListener("visibilitychange", vis);
    return () => { supabase.removeChannel(canal); clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [obraId, recarregar]);
  return { msgs, erro, recarregar, setMsgs };
}

const ESTADO = {
  pendente: { rotulo: "Aguardando a Centauro", cor: "#b45309", fundo: "#fef3c7" },
  aprovada: { rotulo: "Aprovada", cor: "#15803d", fundo: "#dcfce7" },
  recusada: { rotulo: "Não aprovada", cor: "#b91c1c", fundo: "#fee2e2" },
};

// Popup de sugestão de data. `tarefas` = [{ cronoId, taskId, nome, inicio, termino }] (Date).
export function SugerirData({ tarefas, inicial, onEnviar, onFechar }) {
  const [sel, setSel] = useState(inicial ? `${inicial.cronoId}|${inicial.taskId}` : "");
  const [campo, setCampo] = useState("termino");
  const t = tarefas.find(x => `${x.cronoId}|${x.taskId}` === sel) || null;
  const atual = t ? (campo === "inicio" ? t.inicio : t.termino) : null;
  const isoAtual = atual ? `${atual.getFullYear()}-${String(atual.getMonth() + 1).padStart(2, "0")}-${String(atual.getDate()).padStart(2, "0")}` : "";
  const [data, setData] = useState("");
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");
  useEffect(() => { setData(isoAtual); }, [isoAtual]);

  async function enviar() {
    if (!t || !data) { setErro("Escolha a etapa e a data."); return; }
    if (data === isoAtual) { setErro("A data sugerida é igual à atual."); return; }
    setBusy(true); setErro("");
    try {
      await onEnviar({ tipo: "sugestao_data", cronogramaId: t.cronoId, taskId: t.taskId, taskNome: t.nome, campo, dataAtual: isoAtual, dataSugerida: data, texto: motivo.trim() });
      onFechar();
    } catch (e) { setErro(e.message); setBusy(false); }
  }

  const inp = { width: "100%", border: "1px solid #cbd5e1", borderRadius: 10, padding: "12px", fontSize: 16, boxSizing: "border-box", fontFamily: "inherit", background: "#fff", marginTop: 5 };
  return (
    <Folha titulo="📅 Sugerir outra data" onFechar={onFechar}>
      <div style={{ fontSize: 14, color: "#475569", marginBottom: 14 }}>
        A sugestão vai para a equipe da Centauro, que confirma ou responde. O cronograma só muda depois da aprovação.
      </div>
      <label style={rot}>Etapa do cronograma
        <select value={sel} onChange={e => setSel(e.target.value)} style={inp}>
          <option value="">Escolha…</option>
          {tarefas.map(x => <option key={`${x.cronoId}|${x.taskId}`} value={`${x.cronoId}|${x.taskId}`}>{x.nome}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", gap: 8, margin: "14px 0" }}>
        {[["inicio", "Início"], ["termino", "Término"]].map(([k, r]) => (
          <button key={k} type="button" onClick={() => setCampo(k)}
            style={{ flex: 1, minHeight: 46, borderRadius: 10, border: `2px solid ${campo === k ? "#2563eb" : "#e2e8f0"}`, background: campo === k ? "#eff6ff" : "#fff", color: campo === k ? "#1d4ed8" : "#475569", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
            {r}
          </button>
        ))}
      </div>
      {t && <div style={{ fontSize: 14, color: "#64748b", marginBottom: 8 }}>Data atual: <b style={{ color: "#1e293b" }}>{fmtDia(isoAtual)}</b></div>}
      <label style={rot}>Nova data
        <input type="date" value={data} onChange={e => setData(e.target.value)} style={inp} />
      </label>
      <label style={{ ...rot, marginTop: 14 }}>Motivo (opcional)
        <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={3} placeholder="Ex.: a alvenaria do 2º andar atrasou uma semana"
          style={{ ...inp, resize: "vertical" }} />
      </label>
      {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 10, padding: "10px 12px", fontSize: 14, marginTop: 12 }}>{erro}</div>}
      <button type="button" onClick={enviar} disabled={busy}
        style={{ width: "100%", minHeight: 50, marginTop: 16, background: busy ? "#94a3b8" : "#2563eb", color: "#fff", border: "none", borderRadius: 12, fontWeight: 800, fontSize: 16, cursor: busy ? "wait" : "pointer" }}>
        {busy ? "Enviando…" : "Enviar sugestão"}
      </button>
    </Folha>
  );
}
const rot = { display: "block", fontSize: 13, fontWeight: 700, color: "#475569" };

// Painel que sobe de baixo no celular e vira um popup centralizado no PC.
export function Folha({ titulo, onFechar, children, largura = 480 }) {
  useEffect(() => {
    const k = e => { if (e.key === "Escape") onFechar(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onFechar]);
  return (
    <div onClick={onFechar} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={titulo}
        style={{ background: "#fff", width: largura, maxWidth: "100%", maxHeight: "92dvh", overflowY: "auto", borderRadius: "18px 18px 0 0", padding: "16px 16px calc(20px + env(safe-area-inset-bottom))", boxSizing: "border-box", margin: "0 auto", alignSelf: window.innerWidth >= 760 ? "center" : "flex-end", ...(window.innerWidth >= 760 ? { borderRadius: 18 } : {}) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#1e293b", flex: 1 }}>{titulo}</div>
          <button type="button" onClick={onFechar} aria-label="Fechar"
            style={{ width: 44, height: 44, border: "none", background: "#f1f5f9", borderRadius: 12, fontSize: 18, cursor: "pointer", color: "#475569" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Bolha({ m, minha, lado, onDecidir }) {
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");
  const est = ESTADO[m.estado];
  const daCentauro = m.lado === "centauro";
  async function decidir(estado) {
    setBusy(true); setErro("");
    try { await onDecidir(m, estado, motivo.trim()); setRecusando(false); }
    catch (e) { setErro(e.message); }
    setBusy(false);
  }
  return (
    <div style={{ display: "flex", justifyContent: minha ? "flex-end" : "flex-start", margin: "6px 0" }}>
      <div style={{ maxWidth: "86%", background: minha ? "#2563eb" : daCentauro ? "#fff" : "#f1f5f9", color: minha ? "#fff" : "#1e293b", border: minha ? "none" : "1px solid #e2e8f0", borderRadius: minha ? "16px 16px 4px 16px" : "16px 16px 16px 4px", padding: "9px 12px", boxSizing: "border-box", minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, opacity: 0.8, marginBottom: 2 }}>
          {daCentauro ? `Centauro · ${m.autorNome}` : m.autorNome || "Cliente"}
          {m.tipo === "pergunta" && " · ❓ Pergunta"}
        </div>
        {m.tipo === "sugestao_data" ? (
          <div style={{ background: minha ? "rgba(255,255,255,0.14)" : "#fff", border: minha ? "none" : "1px solid #e2e8f0", borderRadius: 10, padding: "8px 10px", margin: "4px 0", color: minha ? "#fff" : "#1e293b" }}>
            <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.85 }}>📅 SUGESTÃO DE DATA</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2, wordBreak: "break-word" }}>{m.taskNome}</div>
            <div style={{ fontSize: 14, marginTop: 4 }}>
              {m.campo === "inicio" ? "Início" : "Término"}: <span style={{ textDecoration: "line-through", opacity: 0.7 }}>{fmtDia(m.dataAtual)}</span> → <b>{fmtDia(m.dataSugerida)}</b>
            </div>
            {est && (
              <div style={{ display: "inline-block", marginTop: 6, fontSize: 12, fontWeight: 800, color: est.cor, background: est.fundo, borderRadius: 999, padding: "3px 9px" }}>
                {est.rotulo}{m.estado !== "pendente" && m.decididoPor ? ` · ${m.decididoPor}` : ""}
              </div>
            )}
            {m.estado === "recusada" && m.motivo && <div style={{ fontSize: 13, marginTop: 4 }}>Motivo: {m.motivo}</div>}
            {lado === "centauro" && m.estado === "pendente" && onDecidir && (
              <div style={{ marginTop: 8 }}>
                {!recusando ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" disabled={busy} onClick={() => decidir("aprovada")}
                      style={{ minHeight: 38, padding: "0 14px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 9, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
                      ✓ Aprovar e aplicar no cronograma
                    </button>
                    <button type="button" disabled={busy} onClick={() => setRecusando(true)}
                      style={{ minHeight: 38, padding: "0 14px", background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 9, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
                      Recusar
                    </button>
                  </div>
                ) : (
                  <div>
                    <input value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Motivo (o cliente vê)" autoFocus
                      style={{ width: "100%", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 10px", fontSize: 14, boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button type="button" disabled={busy} onClick={() => decidir("recusada")}
                        style={{ minHeight: 36, padding: "0 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Recusar</button>
                      <button type="button" onClick={() => setRecusando(false)}
                        style={{ minHeight: 36, padding: "0 12px", background: "#f1f5f9", color: "#475569", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                    </div>
                  </div>
                )}
                {erro && <div style={{ color: "#b91c1c", fontSize: 12.5, marginTop: 4 }}>{erro}</div>}
              </div>
            )}
          </div>
        ) : null}
        {m.texto && <div style={{ fontSize: 15, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.texto}</div>}
        <div style={{ fontSize: 11, opacity: 0.7, textAlign: "right", marginTop: 3 }}>{fmtQuando(m.createdAt)}</div>
      </div>
    </div>
  );
}

// lado: "cliente" (portal) | "centauro" (equipe). tarefas: para o popup de sugestão (só cliente).
export function ConversaPortal({ obraId, lado, tarefas = [], onDecidir, somenteLeitura = false, alturaLista }) {
  const { msgs, erro, recarregar } = useMensagensPortal(obraId);
  const [eu, setEu] = useState(null);
  const [tipo, setTipo] = useState("comentario");
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);
  const [erroEnvio, setErroEnvio] = useState("");
  const [sugerindo, setSugerindo] = useState(false);
  const fimRef = useRef(null);

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setEu(data.user?.id || null)); }, []);
  const n = msgs?.length || 0;
  useEffect(() => {
    if (!n) return;
    fimRef.current?.scrollIntoView({ block: "end" });
    if (!somenteLeitura) marcarPortalLido(obraId);
  }, [n, obraId, somenteLeitura]);

  async function enviar(m) {
    await enviarPortalMensagem({ obraId, lado, ...m });
    await recarregar();
  }
  async function enviarTexto() {
    if (!texto.trim()) return;
    setBusy(true); setErroEnvio("");
    try { await enviar({ tipo, texto: texto.trim() }); setTexto(""); setTipo("comentario"); }
    catch (e) { setErroEnvio(e.message); }
    setBusy(false);
  }

  const tipos = lado === "cliente"
    ? [["comentario", "💬 Comentário"], ["pergunta", "❓ Pergunta"], ["sugestao", "📅 Sugerir data"]]
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ ...(alturaLista ? { maxHeight: alturaLista, overflowY: "auto" } : {}), padding: "4px 2px" }}>
        {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 10, padding: "10px 12px", fontSize: 14, margin: "6px 0" }}>{erro}</div>}
        {msgs === null ? <div style={{ color: "#94a3b8", fontSize: 14, padding: 16, textAlign: "center" }}>Carregando…</div>
          : msgs.length === 0 ? (
            <div style={{ color: "#64748b", fontSize: 14.5, padding: "22px 8px", textAlign: "center", lineHeight: 1.5 }}>
              {lado === "cliente"
                ? <>Nenhuma mensagem ainda.<br />Mande um comentário, uma pergunta ou sugira uma data — a equipe da Centauro responde por aqui.</>
                : "O cliente ainda não escreveu."}
            </div>
          ) : msgs.map(m => <Bolha key={m.id} m={m} minha={m.autorId === eu} lado={lado} onDecidir={onDecidir} />)}
        <div ref={fimRef} />
      </div>
      {!somenteLeitura && (
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 6 }}>
          {tipos.length > 0 && (
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8 }}>
              {tipos.map(([k, r]) => (
                <button key={k} type="button" onClick={() => k === "sugestao" ? setSugerindo(true) : setTipo(k)}
                  style={{ flexShrink: 0, minHeight: 40, padding: "0 14px", borderRadius: 999, border: `1.5px solid ${tipo === k ? "#2563eb" : "#e2e8f0"}`, background: tipo === k ? "#eff6ff" : "#fff", color: tipo === k ? "#1d4ed8" : "#475569", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
                  {r}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={2}
              placeholder={tipo === "pergunta" ? "Escreva sua pergunta…" : lado === "cliente" ? "Escreva uma mensagem…" : "Responder ao cliente…"}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) enviarTexto(); }}
              style={{ flex: 1, minWidth: 0, border: "1px solid #cbd5e1", borderRadius: 12, padding: "10px 12px", fontSize: 16, fontFamily: "inherit", resize: "none", boxSizing: "border-box" }} />
            <button type="button" onClick={enviarTexto} disabled={busy || !texto.trim()} aria-label="Enviar"
              style={{ width: 50, height: 50, flexShrink: 0, borderRadius: 12, border: "none", background: busy || !texto.trim() ? "#cbd5e1" : "#2563eb", color: "#fff", fontSize: 20, cursor: busy ? "wait" : "pointer" }}>
              ➤
            </button>
          </div>
          {erroEnvio && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 6 }}>{erroEnvio}</div>}
        </div>
      )}
      {sugerindo && <SugerirData tarefas={tarefas} onEnviar={enviar} onFechar={() => setSugerindo(false)} />}
    </div>
  );
}
