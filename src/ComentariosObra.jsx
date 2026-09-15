import { useEffect, useState } from "react";
import { fetchComentariosObra, inserirComentario, ocultarComentario } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Comentários e atividade da obra — a coluna da direita, como no Trello.
// Cada comentário é uma linha própria no banco (obra_comentarios), fora do jsonb da obra:
// duas pessoas comentando ao mesmo tempo não se apagam. Não se edita nem se apaga, só se oculta.
//
// O autor é digitado e lembrado no navegador, nunca o e-mail do login: o login é da empresa,
// não da pessoa (mesma decisão do `responsavel` do diário).
// ─────────────────────────────────────────────────────────────────────────────

const CHAVE_AUTOR = "autor.nome";
export function lerAutor() {
  try { return localStorage.getItem(CHAVE_AUTOR) || ""; } catch { return ""; }
}
export function gravarAutor(nome) {
  try { localStorage.setItem(CHAVE_AUTOR, nome); } catch { /* ignora */ }
}

function fmtQuando(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const CORES_AVATAR = ["#0ea5e9", "#10b981", "#8b5cf6", "#f97316", "#ec4899", "#14b8a6", "#6366f1", "#eab308"];
function corDe(nome) {
  let h = 0;
  for (const c of nome || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CORES_AVATAR[h % CORES_AVATAR.length];
}

export default function ComentariosObra({ obraId, recarregar = 0 }) {
  const [lista, setLista] = useState(undefined);   // undefined = carregando, null = sem migration
  const [texto, setTexto] = useState("");
  const [autor, setAutor] = useState(lerAutor);
  const [editandoAutor, setEditandoAutor] = useState(false);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [verOcultos, setVerOcultos] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetchComentariosObra(obraId).then(l => { if (!cancel) setLista(l); });
    return () => { cancel = true; };
  }, [obraId, recarregar]);

  async function enviar() {
    const t = texto.trim();
    if (!t) { setErro("Escreva o comentário antes de enviar."); return; }
    const a = autor.trim();
    if (!a) { setEditandoAutor(true); setErro("Digite seu nome — ele aparece junto do comentário."); return; }
    gravarAutor(a);
    setEnviando(true);
    try {
      // Só entra na lista depois que o banco confirma; se falhar, o texto continua na caixa.
      const novo = await inserirComentario({ obraId, texto: t, autor: a });
      setLista(prev => [novo, ...(prev || [])]);
      setTexto("");
      setEditandoAutor(false);
      setErro("");
    } catch (err) {
      setErro("Não foi gravado: " + err.message);
    } finally {
      setEnviando(false);
    }
  }

  async function alternarOculto(c) {
    if (!c.ocultoEm && !window.confirm("Ocultar este comentário? Ele continua guardado e aparece em \"Mostrar ocultos\".")) return;
    try {
      const novo = await ocultarComentario(c.id, !c.ocultoEm);
      setLista(prev => prev.map(x => x.id === c.id ? novo : x));
    } catch (err) {
      setErro(err.message);
    }
  }

  const ocultos = (lista || []).filter(c => c.ocultoEm).length;
  const visiveis = (lista || []).filter(c => verOcultos || !c.ocultoEm);

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10, maxHeight: "calc(100vh - 40px)" }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: "#1a1a1a" }}>💬 Comentários e atividade</div>

      {lista === null ? (
        <div style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px" }}>
          Os comentários ainda não estão ativos — rode a <b>migration_ficha_obra.sql</b> no Supabase.
        </div>
      ) : (
        <>
          <div>
            <textarea rows={3} value={texto} placeholder="Escrever um comentário…"
              onChange={e => { setTexto(e.target.value); if (erro) setErro(""); }}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); } }}
              style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit" }} />
            {(editandoAutor || !autor) && (
              <input value={autor} onChange={e => { setAutor(e.target.value); if (erro) setErro(""); }} placeholder="Seu nome"
                style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 10px", fontSize: 12, marginTop: 6, boxSizing: "border-box" }} />
            )}
            {erro && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>{erro}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              {autor && !editandoAutor && (
                <span style={{ fontSize: 11, color: "#94a3b8" }}>
                  como <b style={{ color: "#64748b" }}>{autor}</b> ·{" "}
                  <button onClick={() => setEditandoAutor(true)} style={{ background: "none", border: "none", color: "#2563eb", fontSize: 11, cursor: "pointer", padding: 0 }}>trocar</button>
                </span>
              )}
              <button onClick={enviar} disabled={enviando}
                style={{ marginLeft: "auto", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 7, padding: "6px 14px", fontWeight: 700, fontSize: 12, cursor: enviando ? "wait" : "pointer" }}>
                {enviando ? "Gravando…" : "Comentar"}
              </button>
            </div>
          </div>

          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
            {lista === undefined && <div style={{ fontSize: 12, color: "#94a3b8" }}>Carregando…</div>}
            {lista && visiveis.length === 0 && (
              <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>Nenhum comentário ainda. Registre aqui o andamento da obra.</div>
            )}
            {visiveis.map(c => c.tipo === "sistema" ? (
              <div key={c.id} style={{ fontSize: 11.5, color: "#64748b", padding: "2px 2px 2px 8px", borderLeft: "2px solid #e2e8f0", opacity: c.ocultoEm ? 0.5 : 1 }}>
                {c.texto}
                <div style={{ fontSize: 10.5, color: "#94a3b8" }}>{c.autor ? c.autor + " · " : ""}{fmtQuando(c.createdAt)}</div>
              </div>
            ) : (
              <div key={c.id} style={{ display: "flex", gap: 8, opacity: c.ocultoEm ? 0.5 : 1 }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: corDe(c.autor), color: "#fff", fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {(c.autor || "?").trim().charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                    <b style={{ color: "#1e293b" }}>{c.autor || "—"}</b>
                    <span style={{ color: "#94a3b8" }}>{fmtQuando(c.createdAt)}</span>
                    {c.ocultoEm && <span style={{ color: "#94a3b8", fontStyle: "italic" }}>(oculto)</span>}
                    <button onClick={() => alternarOculto(c)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#94a3b8", fontSize: 10.5, cursor: "pointer", padding: 0 }}>
                      {c.ocultoEm ? "mostrar" : "ocultar"}
                    </button>
                  </div>
                  <div style={{ fontSize: 12.5, color: "#334155", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {c.texto}
                  </div>
                </div>
              </div>
            ))}
            {ocultos > 0 && (
              <button onClick={() => setVerOcultos(v => !v)}
                style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#64748b", fontSize: 11, cursor: "pointer", padding: 0 }}>
                {verOcultos ? "Esconder ocultos" : `Mostrar ocultos (${ocultos})`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
