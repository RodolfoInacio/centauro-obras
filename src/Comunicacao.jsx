import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import {
  fetchPessoas, salvarMeuNome, fetchNotificacoes, marcarNotificacoesLidas,
  fetchResumoMensagens, fetchMensagens, enviarMensagem, marcarConversaLida,
  linhaMensagem, chaveConversa, CONVERSA_GERAL,
} from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Comunicação entre as pessoas do sistema: @menção nos comentários da obra (🔔) e o chat
// interno (✉️) com o canal Geral e conversas diretas.
//
// Diferente do `autor` digitado dos comentários, aqui a pessoa É o login: notificação precisa
// de destinatário, e o destinatário é quem entra com aquele e-mail. O nome exibido vem de
// profiles.nome (cada um ajusta o seu na tela de Mensagens) — nunca o e-mail na tela, se der.
//
// Tempo real pelo Realtime do Supabase; sem ele (ou sem a migration), confere a cada minuto e
// quando a aba volta ao foco. Sem a migration_mensagens.sql, sino e cartinha somem da barra.
// ─────────────────────────────────────────────────────────────────────────────

const ComunicacaoCtx = createContext(null);
export const useComunicacao = () => useContext(ComunicacaoCtx);

// Nome para exibir: o do perfil; se o perfil ainda guarda o e-mail (padrão do cadastro), a parte
// antes do @.
export function nomePessoa(p) {
  const n = (p?.nome || "").trim();
  if (!n) return "Sem nome";
  return n.includes("@") ? n.split("@")[0] : n;
}
export const nomeEhEmail = (p) => !p?.nome || p.nome.includes("@");

const CORES_AVATAR = ["#0ea5e9", "#10b981", "#8b5cf6", "#f97316", "#ec4899", "#14b8a6", "#6366f1", "#eab308"];
export function corDe(nome) {
  let h = 0;
  for (const c of nome || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CORES_AVATAR[h % CORES_AVATAR.length];
}
export function Avatar({ nome, tamanho = 28 }) {
  return (
    <div style={{ width: tamanho, height: tamanho, borderRadius: "50%", background: corDe(nome), color: "#fff", fontWeight: 800, fontSize: tamanho * 0.43, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {(nome || "?").trim().charAt(0).toUpperCase()}
    </div>
  );
}

export function fmtQuando(iso) {
  if (!iso) return "";
  const d = new Date(iso), hoje = new Date();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === hoje.toDateString()) return hm;
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return "ontem " + hm;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + hm;
}

// ─── PROVIDER: pessoas, notificações e resumo das conversas ──────────────────
export function ComunicacaoProvider({ userId, children }) {
  const [pessoas, setPessoas] = useState([]);
  const [notificacoes, setNotificacoes] = useState([]);
  const [resumo, setResumo] = useState([]);
  const [ativo, setAtivo] = useState(false);          // migration rodada?
  const [novaMensagem, setNovaMensagem] = useState(null); // última mensagem recebida pelo Realtime
  const vivo = useRef(true);

  const recarregarPessoas = useCallback(() => fetchPessoas().then(p => { if (vivo.current) setPessoas(p); }), []);
  const recarregar = useCallback(async () => {
    if (!userId) return;
    try {
      const [n, r] = await Promise.all([fetchNotificacoes(userId), fetchResumoMensagens()]);
      if (!vivo.current) return;
      setAtivo(n !== null && r !== null);
      setNotificacoes(n || []);
      setResumo(r || []);
    } catch (err) {
      console.warn("comunicação:", err.message);
    }
  }, [userId]);

  useEffect(() => {
    vivo.current = true;
    if (!userId) { setPessoas([]); setNotificacoes([]); setResumo([]); setAtivo(false); return; }
    recarregarPessoas();
    recarregar();
    const timer = setInterval(recarregar, 60000);
    const aoFocar = () => { if (document.visibilityState === "visible") recarregar(); };
    document.addEventListener("visibilitychange", aoFocar);
    const canal = supabase.channel(`comunicacao-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notificacoes", filter: `user_id=eq.${userId}` }, () => recarregar())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensagens" }, (ev) => {
        setNovaMensagem(linhaMensagem(ev.new));
        recarregar();
      })
      .subscribe();
    return () => {
      vivo.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", aoFocar);
      supabase.removeChannel(canal);
    };
  }, [userId, recarregar, recarregarPessoas]);

  const marcarLidas = useCallback(async (ids) => {
    const alvo = ids.filter(id => notificacoes.some(n => n.id === id && !n.lidaEm));
    if (!alvo.length) return;
    const agora = new Date().toISOString();
    setNotificacoes(prev => prev.map(n => alvo.includes(n.id) ? { ...n, lidaEm: agora } : n));
    try { await marcarNotificacoesLidas(alvo); } catch (err) { console.warn("marcar lidas:", err.message); recarregar(); }
  }, [notificacoes, recarregar]);

  const lerConversa = useCallback(async (conversa) => {
    setResumo(prev => prev.map(r => r.conversa === conversa ? { ...r, naoLidas: 0 } : r));
    try { await marcarConversaLida(userId, conversa); } catch (err) { console.warn("conversa lida:", err.message); }
  }, [userId]);

  const eu = pessoas.find(p => p.id === userId) || null;
  const valor = useMemo(() => ({
    userId, eu, pessoas, notificacoes, resumo, ativo, novaMensagem,
    naoLidasNotif: notificacoes.filter(n => !n.lidaEm).length,
    naoLidasMsg: resumo.reduce((s, r) => s + r.naoLidas, 0),
    recarregar, recarregarPessoas, marcarLidas, lerConversa,
  }), [userId, eu, pessoas, notificacoes, resumo, ativo, novaMensagem, recarregar, recarregarPessoas, marcarLidas, lerConversa]);

  return <ComunicacaoCtx.Provider value={valor}>{children}</ComunicacaoCtx.Provider>;
}

// ─── BARRA DO TOPO: 🔔 e ✉️ ──────────────────────────────────────────────────
function Contador({ n }) {
  if (!n) return null;
  return (
    <span style={{ position: "absolute", top: -4, right: -6, background: "#dc2626", color: "#fff", borderRadius: 999, minWidth: 17, height: 17, padding: "0 4px", fontSize: 10.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", border: "2px solid #1a1a1a" }}>
      {n > 99 ? "99+" : n}
    </span>
  );
}
const botaoTopo = { position: "relative", background: "transparent", border: "none", fontSize: 19, lineHeight: 1, cursor: "pointer", padding: 4, color: "#fff" };

export function BotaoMensagens({ onAbrir }) {
  const c = useComunicacao();
  if (!c?.ativo) return null;
  return (
    <button onClick={onAbrir} title={c.naoLidasMsg ? `${c.naoLidasMsg} mensagem(ns) não lida(s)` : "Mensagens"} style={botaoTopo}>
      ✉️<Contador n={c.naoLidasMsg} />
    </button>
  );
}

export function SinoNotificacoes({ obras, onAbrirObra }) {
  const c = useComunicacao();
  const [aberto, setAberto] = useState(false);
  const caixa = useRef(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e) => { if (caixa.current && !caixa.current.contains(e.target)) setAberto(false); };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);
  if (!c?.ativo) return null;
  const { notificacoes, naoLidasNotif, marcarLidas } = c;
  const rotuloObra = (id) => { const o = obras.find(x => x.id === id); return o ? `#${o.numero} ${o.cliente || ""}`.trim() : `#${id}`; };

  return (
    <div ref={caixa} style={{ position: "relative" }}>
      <button onClick={() => setAberto(a => !a)} title={naoLidasNotif ? `${naoLidasNotif} notificação(ões) nova(s)` : "Notificações"} style={botaoTopo}>
        🔔<Contador n={naoLidasNotif} />
      </button>
      {aberto && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 10px)", width: 360, maxWidth: "calc(100vw - 24px)", background: "#fff", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.25)", zIndex: 60, overflow: "hidden", color: "#1e293b" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #e2e8f0" }}>
            <b style={{ fontSize: 13.5 }}>Notificações</b>
            {naoLidasNotif > 0 && (
              <button onClick={() => marcarLidas(notificacoes.map(n => n.id))}
                style={{ marginLeft: "auto", background: "none", border: "none", color: "#2563eb", fontSize: 12, cursor: "pointer", padding: 0 }}>Marcar todas como lidas</button>
            )}
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {notificacoes.length === 0 && (
              <div style={{ padding: "22px 14px", fontSize: 12.5, color: "#94a3b8", textAlign: "center" }}>
                Nada por aqui. Quando alguém marcar você com <b>@</b> num comentário de obra, aparece aqui.
              </div>
            )}
            {notificacoes.map(n => (
              <button key={n.id}
                onClick={() => { marcarLidas([n.id]); setAberto(false); if (n.obraId) onAbrirObra(n.obraId); }}
                style={{ display: "flex", gap: 10, width: "100%", textAlign: "left", background: n.lidaEm ? "#fff" : "#eff6ff", border: "none", borderBottom: "1px solid #f1f5f9", padding: "10px 14px", cursor: "pointer" }}>
                <Avatar nome={n.deNome} tamanho={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5 }}>
                    <b>{n.deNome || "Alguém"}</b> marcou você em <b>{rotuloObra(n.obraId)}</b>
                  </div>
                  <div style={{ fontSize: 12, color: "#475569", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{n.texto}</div>
                  <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 3 }}>{fmtQuando(n.createdAt)}</div>
                </div>
                {!n.lidaEm && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2563eb", marginTop: 6, flexShrink: 0 }} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CAMPO DE TEXTO COM @MENÇÃO ──────────────────────────────────────────────
// Ao digitar "@" seguido de letras, abre a lista de pessoas; escolher insere "@Nome ".
// Quem continua com "@Nome" no texto na hora de enviar é marcado (apagar o nome desmarca).
export function mencoesDoTexto(texto, pessoas, userId) {
  return pessoas.filter(p => p.id !== userId && texto.includes("@" + nomePessoa(p))).map(p => p.id);
}

export function TextoComMencao({ value, onChange, onEnviar, placeholder, rows = 3, style }) {
  const c = useComunicacao();
  const ref = useRef(null);
  const [busca, setBusca] = useState(null); // { inicio, termo }
  const [sel, setSel] = useState(0);
  const pessoas = (c?.ativo ? c.pessoas : []).filter(p => p.id !== c?.userId);
  const sugestoes = busca ? pessoas.filter(p => norm(nomePessoa(p)).includes(norm(busca.termo))).slice(0, 6) : [];

  function aoMudar(e) {
    const v = e.target.value;
    onChange(v);
    const pos = e.target.selectionStart;
    const antes = v.slice(0, pos);
    const m = antes.match(/(^|\s)@([^\s@]{0,30})$/);
    if (m && pessoas.length) { setBusca({ inicio: pos - m[2].length - 1, termo: m[2] }); setSel(0); }
    else setBusca(null);
  }
  function escolher(p) {
    const fim = busca.inicio + 1 + busca.termo.length;
    const ins = "@" + nomePessoa(p) + " ";
    const novo = value.slice(0, busca.inicio) + ins + value.slice(fim);
    onChange(novo);
    setBusca(null);
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); const p2 = busca.inicio + ins.length; el.setSelectionRange(p2, p2); } });
  }
  function aoTeclar(e) {
    if (busca && sugestoes.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => (s + 1) % sugestoes.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => (s - 1 + sugestoes.length) % sugestoes.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); escolher(sugestoes[sel]); return; }
      if (e.key === "Escape") { setBusca(null); return; }
    }
    if (onEnviar && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onEnviar(); }
  }

  return (
    <div style={{ position: "relative" }}>
      <textarea ref={ref} rows={rows} value={value} placeholder={placeholder} onChange={aoMudar} onKeyDown={aoTeclar}
        onBlur={() => setTimeout(() => setBusca(null), 150)}
        style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit", ...style }} />
      {busca && sugestoes.length > 0 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 2, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.15)", zIndex: 30, overflow: "hidden" }}>
          {sugestoes.map((p, i) => (
            <button key={p.id} onMouseDown={e => { e.preventDefault(); escolher(p); }}
              style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", textAlign: "left", background: i === sel ? "#eff6ff" : "#fff", border: "none", padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}>
              <Avatar nome={nomePessoa(p)} tamanho={22} /> {nomePessoa(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Texto com as menções destacadas (só as de quem foi de fato marcado).
export function TextoMarcado({ texto, nomes }) {
  const lista = [...new Set(nomes)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!lista.length) return texto;
  const re = new RegExp("(" + lista.map(n => "@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
  return texto.split(re).map((parte, i) => lista.some(n => parte === "@" + n)
    ? <span key={i} style={{ background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "0 3px", fontWeight: 700 }}>{parte}</span>
    : parte);
}

// ─── TELA: MENSAGENS ─────────────────────────────────────────────────────────
export function ChatView({ conversa: conversaParam, onConversa, obras, onAbrirObra }) {
  const c = useComunicacao();
  const conversa = conversaParam || CONVERSA_GERAL;
  const [mensagens, setMensagens] = useState(undefined);
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [busca, setBusca] = useState("");
  const fimRef = useRef(null);

  const userId = c?.userId;
  const outros = (c?.pessoas || []).filter(p => p.id !== userId);
  const pessoaDaConversa = conversa === CONVERSA_GERAL ? null : outros.find(p => chaveConversa(userId, p.id) === conversa) || null;

  useEffect(() => {
    if (!c?.ativo) return;
    let cancel = false;
    setMensagens(undefined);
    fetchMensagens(conversa).then(l => { if (!cancel) setMensagens(l); }).catch(err => { if (!cancel) { setMensagens([]); setErro(err.message); } });
    c.lerConversa(conversa);
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversa, c?.ativo]);

  // Mensagem nova pelo Realtime: entra na conversa aberta e já conta como lida.
  useEffect(() => {
    const m = c?.novaMensagem;
    if (!m || m.conversa !== conversa) return;
    setMensagens(prev => prev && !prev.some(x => x.id === m.id) ? [...prev, m] : prev);
    if (m.deId !== userId) c.lerConversa(conversa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.novaMensagem]);

  useEffect(() => { fimRef.current?.scrollIntoView({ block: "end" }); }, [mensagens]);

  if (!c) return null;
  if (!c.ativo) {
    return (
      <div style={{ maxWidth: 640, margin: "40px auto", padding: 20, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, fontSize: 13.5, color: "#92400e" }}>
        As mensagens ainda não estão ativas — rode a <b>supabase/migration_mensagens.sql</b> no SQL Editor do Supabase e recarregue a página.
      </div>
    );
  }

  async function enviar() {
    const t = texto.trim();
    if (!t) return;
    // Conversa direta com a pessoa ainda não carregada: sem isso a mensagem cairia no Geral.
    if (conversa !== CONVERSA_GERAL && !pessoaDaConversa) { setErro("Pessoa não encontrada — escolha a conversa na lista."); return; }
    setEnviando(true);
    try {
      const nova = await enviarMensagem({ deId: userId, deNome: nomePessoa(c.eu), paraId: pessoaDaConversa?.id || null, texto: t });
      setMensagens(prev => prev && !prev.some(x => x.id === nova.id) ? [...prev, nova] : prev);
      setTexto(""); setErro("");
      c.lerConversa(conversa);
      c.recarregar();
    } catch (err) {
      setErro("Não foi enviada: " + err.message);
    } finally {
      setEnviando(false);
    }
  }

  const resumoDe = (k) => c.resumo.find(r => r.conversa === k);
  const itens = [
    { chave: CONVERSA_GERAL, nome: "# Geral", sub: "Todos do sistema", pessoa: null },
    ...outros.map(p => ({ chave: chaveConversa(userId, p.id), nome: nomePessoa(p), sub: "", pessoa: p })),
  ].filter(it => !busca || norm(it.nome).includes(norm(busca)))
    .sort((a, b) => {
      if (a.chave === CONVERSA_GERAL) return -1;
      if (b.chave === CONVERSA_GERAL) return 1;
      const ua = resumoDe(a.chave)?.ultimaEm || "", ub = resumoDe(b.chave)?.ultimaEm || "";
      return ub.localeCompare(ua) || a.nome.localeCompare(b.nome);
    });
  const rotuloObra = (id) => { const o = obras.find(x => x.id === id); return o ? `#${o.numero} ${o.cliente || ""}` : `#${id}`; };
  const nomesMarcaveis = c.pessoas.map(nomePessoa);

  return (
    <div style={{ padding: "18px 20px", maxWidth: 1180, margin: "0 auto" }}>
      <MeuNome />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 14, height: "calc(100vh - 170px)", minHeight: 420 }}>
        {/* Conversas */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 10, borderBottom: "1px solid #e2e8f0" }}>
            <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar pessoa…"
              style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 12.5, boxSizing: "border-box" }} />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {itens.map(it => {
              const r = resumoDe(it.chave);
              const atual = it.chave === conversa;
              return (
                <button key={it.chave} onClick={() => onConversa(it.chave)}
                  style={{ display: "flex", gap: 10, alignItems: "center", width: "100%", textAlign: "left", background: atual ? "#f1f5f9" : "#fff", border: "none", borderLeft: `3px solid ${atual ? "#c9a227" : "transparent"}`, padding: "10px 12px", cursor: "pointer" }}>
                  {it.pessoa ? <Avatar nome={it.nome} tamanho={32} /> : <div style={{ width: 32, height: 32, borderRadius: 8, background: "#1a1a1a", color: "#c9a227", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>#</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: r?.naoLidas ? 800 : 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.nome}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{r?.ultimaEm ? fmtQuando(r.ultimaEm) : it.sub || "sem mensagens"}</div>
                  </div>
                  {r?.naoLidas > 0 && <span style={{ background: "#dc2626", color: "#fff", borderRadius: 999, padding: "1px 7px", fontSize: 11, fontWeight: 800 }}>{r.naoLidas}</span>}
                </button>
              );
            })}
            {outros.length === 0 && (
              <div style={{ padding: 12, fontSize: 11.5, color: "#94a3b8" }}>
                Só você tem login por enquanto. Cada pessoa precisa do próprio usuário (Supabase → Authentication → Users) para aparecer aqui.
              </div>
            )}
          </div>
        </div>

        {/* Conversa aberta */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0", display: "flex", gap: 10, alignItems: "center" }}>
            {pessoaDaConversa ? <Avatar nome={nomePessoa(pessoaDaConversa)} /> : null}
            <div>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{pessoaDaConversa ? nomePessoa(pessoaDaConversa) : "# Geral"}</div>
              <div style={{ fontSize: 11.5, color: "#94a3b8" }}>{pessoaDaConversa ? "Conversa direta — só vocês dois veem" : "Todos que têm login no sistema veem este canal"}</div>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, background: "#f8fafc" }}>
            {mensagens === undefined && <div style={{ fontSize: 12, color: "#94a3b8" }}>Carregando…</div>}
            {mensagens && mensagens.length === 0 && <div style={{ fontSize: 12.5, color: "#94a3b8", textAlign: "center", marginTop: 30 }}>Nenhuma mensagem ainda. Diga um oi 👋</div>}
            {(mensagens || []).map((m, i) => {
              const minha = m.deId === userId;
              const anterior = mensagens[i - 1];
              const agrupada = anterior && anterior.deId === m.deId && new Date(m.createdAt) - new Date(anterior.createdAt) < 5 * 60000;
              const autor = c.pessoas.find(p => p.id === m.deId);
              const nome = autor ? nomePessoa(autor) : (m.deNome || "—");
              return (
                <div key={m.id} style={{ display: "flex", gap: 8, flexDirection: minha ? "row-reverse" : "row", marginTop: agrupada ? -6 : 0 }}>
                  <div style={{ width: 28, flexShrink: 0 }}>{!minha && !agrupada && <Avatar nome={nome} />}</div>
                  <div style={{ maxWidth: "70%", display: "flex", flexDirection: "column", alignItems: minha ? "flex-end" : "flex-start" }}>
                    {!agrupada && (
                      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>
                        {!minha && <b style={{ color: "#1e293b" }}>{nome} </b>}{fmtQuando(m.createdAt)}
                      </div>
                    )}
                    <div style={{ fontSize: 13, background: minha ? "#1a1a1a" : "#fff", color: minha ? "#fff" : "#1e293b", border: minha ? "none" : "1px solid #e2e8f0", borderRadius: 12, padding: "7px 11px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      <TextoMarcado texto={m.texto} nomes={nomesMarcaveis} />
                      {m.obraId && (
                        <button onClick={() => onAbrirObra(m.obraId)} style={{ display: "block", marginTop: 4, background: "none", border: "none", padding: 0, color: minha ? "#fcd34d" : "#2563eb", fontSize: 11.5, cursor: "pointer" }}>
                          🏗️ {rotuloObra(m.obraId)}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={fimRef} />
          </div>
          <div style={{ padding: 12, borderTop: "1px solid #e2e8f0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <textarea rows={2} value={texto} placeholder={`Mensagem para ${pessoaDaConversa ? nomePessoa(pessoaDaConversa) : "todos"}… (Enter envia, Shift+Enter quebra linha)`}
                  onChange={e => { setTexto(e.target.value); if (erro) setErro(""); }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); } }}
                  style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, resize: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
              </div>
              <button onClick={enviar} disabled={enviando || !texto.trim()}
                style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: enviando ? "wait" : "pointer", opacity: texto.trim() ? 1 : 0.5 }}>
                {enviando ? "…" : "Enviar"}
              </button>
            </div>
            {erro && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>{erro}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Faixa "Seu nome no sistema": aparece aberta enquanto o perfil ainda guarda o e-mail.
function MeuNome() {
  const c = useComunicacao();
  const [editando, setEditando] = useState(false);
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState("");
  const precisa = nomeEhEmail(c.eu);
  if (!c.eu) return null;
  const abrir = () => { setNome(precisa ? "" : c.eu.nome); setEditando(true); setErro(""); };
  async function salvar() {
    const n = nome.trim();
    if (n.length < 2) { setErro("Digite seu nome."); return; }
    if (n.includes("@")) { setErro("Use o nome, não o e-mail."); return; }
    try { await salvarMeuNome(c.userId, n); await c.recarregarPessoas(); setEditando(false); }
    catch (err) { setErro(err.message); }
  }
  if (!editando && !precisa) {
    return (
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>
        Você aparece como <b style={{ color: "#1e293b" }}>{nomePessoa(c.eu)}</b> ·{" "}
        <button onClick={abrir} style={{ background: "none", border: "none", color: "#2563eb", fontSize: 12, cursor: "pointer", padding: 0 }}>trocar</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13 }}>
      <span>{precisa ? <>Como você quer aparecer para os colegas? <span style={{ color: "#64748b" }}>(hoje aparece o e-mail)</span></> : "Seu nome no sistema:"}</span>
      <input value={nome} onChange={e => setNome(e.target.value)} onKeyDown={e => e.key === "Enter" && salvar()} placeholder="Ex.: Renato"
        style={{ border: "1px solid #bfdbfe", borderRadius: 7, padding: "6px 10px", fontSize: 13 }} />
      <button onClick={salvar} style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Salvar</button>
      {!precisa && <button onClick={() => setEditando(false)} style={{ background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer" }}>cancelar</button>}
      {erro && <span style={{ color: "#dc2626", fontSize: 12 }}>{erro}</span>}
    </div>
  );
}
