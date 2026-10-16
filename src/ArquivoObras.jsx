import { useEffect, useState } from "react";
import Modal from "./Modal";
import { Dinheiro } from "./Sigilo";
import { lerAutor, gravarAutor } from "./ComentariosObra";
import { fetchObrasExcluidas } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Arquivar e excluir obra, em duas etapas: Ativa → Arquivadas → Excluídas → exclusão definitiva.
//
// `obra.arquivo = { estado: "" | "arquivada" | "excluida", historico: [{acao, em, por}] }`.
// O estado é separado do `status` de propósito: restaurar devolve a obra exatamente como estava
// (Em andamento, Concluído…), e o status continua sendo o que o escritório marcou.
// Arquivada ou excluída, a obra some de todo o resto do app (pastas, calendário, cronograma,
// financeiro, avisos, relatórios) — o App filtra `obras` uma vez só. Ela continua abrindo pela
// própria pasta, com a faixa de aviso e os botões de restaurar.
//
// Exclusão definitiva é a única que apaga a linha, e só pela função do banco
// (migration_exclusao_obras.sql): confere a senha de novo, guarda a obra inteira com o
// histórico em `obras_excluidas` e só então apaga. A senha aqui é só SHA-256 (repo público).
// ─────────────────────────────────────────────────────────────────────────────

const HASH_SENHA_EXCLUSAO = "6b75be1ff60b7abca42c2b6bca606109b79c998706ab8bf626a44e78899d796b";

export const ACAO_ROTULO = {
  arquivada: "Arquivada",
  excluida: "Enviada para Excluídas",
  restaurada: "Restaurada",
  excluida_definitivo: "Excluída definitivamente",
};

export function normArquivo(a) {
  const estado = a && (a.estado === "arquivada" || a.estado === "excluida") ? a.estado : "";
  const historico = (Array.isArray(a?.historico) ? a.historico : [])
    .filter(h => h && ACAO_ROTULO[h.acao] && h.em)
    .map(h => ({ acao: h.acao, em: h.em, por: String(h.por || ""), ...(h.de ? { de: h.de } : {}) }));
  return { estado, historico };
}

export const obraAtiva = (o) => !o.arquivo?.estado;

// Muda o estado e anota o passo com data e hora. `acao` é o novo estado, ou "restaurada".
export function comPasso(obra, acao, por) {
  const atual = normArquivo(obra.arquivo);
  const estado = acao === "restaurada"
    ? (atual.estado === "excluida" ? "arquivada" : "")   // de Excluídas volta para Arquivadas
    : acao;
  const passo = { acao, em: new Date().toISOString(), por: por || "", ...(acao === "restaurada" ? { de: atual.estado } : {}) };
  return { ...obra, arquivo: { estado, historico: [...atual.historico, passo] } };
}

export function fmtQuando(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function textoPasso(h) {
  const rot = h.acao === "restaurada"
    ? (h.de === "excluida" ? "Restaurada de Excluídas para Arquivadas" : "Restaurada para as obras ativas")
    : ACAO_ROTULO[h.acao];
  return `${rot} em ${fmtQuando(h.em)}${h.por ? ` por ${h.por}` : ""}`;
}

async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── CONFIRMAÇÃO ──────────────────────────────────────────────────────────────
// Pede quem está fazendo (lembrado no navegador, igual aos comentários) e, na exclusão
// definitiva, a senha. `onConfirmar(por, senha)` pode ser async; erro fica no modal.
const PASSOS = {
  arquivada: {
    titulo: "Arquivar obra", botao: "🗄 Arquivar", cor: "#475569",
    texto: "A obra sai das pastas, do calendário, do cronograma, do financeiro e dos relatórios. Nada é apagado: dá para restaurar quando quiser.",
  },
  excluida: {
    titulo: "Enviar para Excluídas", botao: "🗑 Enviar para Excluídas", cor: "#b45309",
    texto: "A obra vai para a pasta Excluídas. Ainda dá para restaurar; apagar de vez é um passo separado, com senha.",
  },
  restaurada: {
    titulo: "Restaurar obra", botao: "↩ Restaurar", cor: "#047857",
    texto: "",
  },
  excluida_definitivo: {
    titulo: "Excluir definitivamente", botao: "Excluir definitivamente", cor: "#dc2626",
    texto: "A obra é apagada do sistema e não volta mais. Fica só o registro da exclusão (data, hora, quem e uma cópia dos dados) na pasta Excluídas. Agenda, diários e anexos ligados a ela não são apagados.",
  },
};

export function ConfirmarPasso({ passo, obra, onConfirmar, onFechar }) {
  const [por, setPor] = useState(lerAutor);
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [gravando, setGravando] = useState(false);
  if (!passo) return null;
  const p = PASSOS[passo];
  const pedeSenha = passo === "excluida_definitivo";
  const texto = passo === "restaurada"
    ? (obra?.arquivo?.estado === "excluida" ? "A obra volta para a pasta Arquivadas." : "A obra volta para as obras ativas, com o mesmo status de antes.")
    : p.texto;

  async function confirmar() {
    if (!por.trim()) { setErro("Diga quem está fazendo — fica no histórico."); return; }
    if (pedeSenha && await sha256(senha) !== HASH_SENHA_EXCLUSAO) { setErro("Senha incorreta."); return; }
    setGravando(true); setErro("");
    try {
      gravarAutor(por.trim());
      await onConfirmar(por.trim(), senha);
      onFechar();
    } catch (e) {
      setErro(e.message || String(e));
      setGravando(false);
    }
  }

  const campo = { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 6, padding: "7px 10px", fontSize: 13 };
  return (
    <Modal open title={p.titulo} onClose={gravando ? undefined : onFechar} width={440}>
      {obra && (
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 8 }}>
          #{obra.numero} · {obra.obra || obra.cliente}
        </div>
      )}
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5, marginBottom: 14 }}>{texto}</div>
      <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Quem está fazendo</label>
      <input value={por} onChange={e => setPor(e.target.value)} placeholder="Seu nome" style={{ ...campo, marginBottom: 12 }} autoFocus={!pedeSenha} />
      {pedeSenha && <>
        <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>Senha de exclusão</label>
        <input type="password" value={senha} onChange={e => setSenha(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === "Enter") confirmar(); }} style={{ ...campo, marginBottom: 12 }} />
      </>}
      {erro && <div style={{ color: "#dc2626", fontSize: 12.5, marginBottom: 10 }}>{erro}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onFechar} disabled={gravando}
          style={{ background: "#f1f5f9", color: "#475569", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Cancelar
        </button>
        <button onClick={confirmar} disabled={gravando}
          style={{ background: p.cor, color: "#fff", border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: gravando ? "wait" : "pointer" }}>
          {gravando ? "Gravando…" : p.botao}
        </button>
      </div>
    </Modal>
  );
}

// Botões de cada estado. Usados no cabeçalho da obra e nos cartões das pastas.
function botoesDoEstado(estado) {
  if (estado === "arquivada") return ["restaurada", "excluida"];
  if (estado === "excluida") return ["restaurada", "excluida_definitivo"];
  return ["arquivada"];
}
const ROTULO_BOTAO = {
  arquivada: "🗄 Arquivar", excluida: "🗑 Enviar para Excluídas",
  restaurada: "↩ Restaurar", excluida_definitivo: "✖ Excluir definitivamente",
};
function Botao({ passo, onClick, pequeno }) {
  const p = PASSOS[passo];
  const forte = passo === "excluida_definitivo";
  return (
    <button onClick={onClick}
      style={{ background: forte ? "#dc2626" : "#fff", color: forte ? "#fff" : p.cor, border: `1px solid ${forte ? "#dc2626" : "#cbd5e1"}`,
        borderRadius: 6, padding: pequeno ? "5px 10px" : "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
      {ROTULO_BOTAO[passo]}
    </button>
  );
}

// ─── NA TELA DA OBRA ──────────────────────────────────────────────────────────
// Ativa: só o botão Arquivar no cabeçalho. Arquivada/excluída: faixa com o histórico e os botões.
export function AcoesArquivo({ obra, onPasso }) {
  const [passo, setPasso] = useState(null);
  const arq = normArquivo(obra.arquivo);
  const ultimo = arq.historico[arq.historico.length - 1];
  const modal = <ConfirmarPasso passo={passo} obra={obra} onFechar={() => setPasso(null)}
    onConfirmar={(por, senha) => onPasso(obra, passo, por, senha)} />;

  if (!arq.estado) return <>{botoesDoEstado("").map(b => <Botao key={b} passo={b} pequeno onClick={() => setPasso(b)} />)}{modal}</>;
  const excluida = arq.estado === "excluida";
  return (
    <div style={{ flexBasis: "100%", background: excluida ? "#fef2f2" : "#f1f5f9", border: `1px solid ${excluida ? "#fecaca" : "#cbd5e1"}`,
      borderRadius: 8, padding: "10px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px", fontSize: 13, color: excluida ? "#991b1b" : "#334155" }}>
        <b>{excluida ? "🗑 Obra em Excluídas" : "🗄 Obra arquivada"}</b>
        {ultimo && <span> — {textoPasso(ultimo)}</span>}
        <div style={{ fontSize: 12, opacity: 0.8 }}>Não aparece nas pastas, no calendário, no cronograma nem nos relatórios.</div>
      </div>
      {botoesDoEstado(arq.estado).map(b => <Botao key={b} passo={b} onClick={() => setPasso(b)} />)}
      {modal}
    </div>
  );
}

function Historico({ historico }) {
  if (!historico.length) return null;
  return (
    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
      {historico.map((h, i) => <li key={i}>{textoPasso(h)}</li>)}
    </ul>
  );
}

// ─── PASTAS ARQUIVADAS / EXCLUÍDAS ───────────────────────────────────────────
export function PastaArquivo({ obras: todas, pasta, onAbrir, onPasso }) {
  const estado = pasta === "excluidas" ? "excluida" : "arquivada";
  const [busca, setBusca] = useState("");
  const [passo, setPasso] = useState(null); // { obra, passo }
  const [definitivas, setDefinitivas] = useState(null);
  const [recarregar, setRecarregar] = useState(0);

  useEffect(() => {
    if (estado !== "excluida") return;
    let cancel = false;
    fetchObrasExcluidas().then(l => { if (!cancel) setDefinitivas(l); }).catch(e => { if (!cancel) setDefinitivas({ erro: e.message }); });
    return () => { cancel = true; };
  }, [estado, recarregar]);

  const q = busca.trim().toLowerCase();
  const casa = (...campos) => !q || campos.some(c => String(c || "").toLowerCase().includes(q));
  const ultimoEm = o => { const h = normArquivo(o.arquivo).historico; return h[h.length - 1]?.em || ""; };
  const lista = todas.filter(o => o.arquivo?.estado === estado && casa(o.numero, o.cliente, o.obra, o.cidade))
    .sort((a, b) => ultimoEm(b).localeCompare(ultimoEm(a)));
  const listaDef = Array.isArray(definitivas) ? definitivas.filter(d => casa(d.numero, d.cliente, d.data?.obra)) : [];

  const cartao = { background: "#fff", borderRadius: 10, padding: "14px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 10 };
  return (
    <div style={{ padding: "20px 28px", maxWidth: 1000 }}>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12, lineHeight: 1.5 }}>
        {estado === "arquivada"
          ? "Obras fora de uso. Não aparecem no resto do sistema; restaurar devolve a obra como estava."
          : "Obras a caminho da exclusão. Restaurar devolve para Arquivadas; excluir de vez pede a senha e não tem volta."}
      </div>
      <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por nº, cliente, obra…"
        style={{ width: "100%", maxWidth: 360, boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 16 }} />

      {lista.length === 0 && <div style={{ ...cartao, color: "#94a3b8", fontSize: 13 }}>Nenhuma obra {estado === "arquivada" ? "arquivada" : "em Excluídas"}.</div>}
      {lista.map(o => (
        <div key={o.id} style={cartao}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 280px", minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>PROPOSTA #{o.numero} · {o.status}</div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b" }}>{o.obra || o.cliente}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {[o.obra ? o.cliente : "", o.cidade].filter(Boolean).join(" · ")}{o.valorTotal ? <> · <Dinheiro v={o.valorTotal} /></> : null}
              </div>
              <Historico historico={normArquivo(o.arquivo).historico} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => onAbrir(o.id)}
                style={{ background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1", borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Abrir
              </button>
              {botoesDoEstado(estado).map(b => <Botao key={b} passo={b} pequeno onClick={() => setPasso({ obra: o, passo: b })} />)}
            </div>
          </div>
        </div>
      ))}

      {estado === "excluida" && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: "#1e293b", marginBottom: 4 }}>Excluídas definitivamente</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Registro permanente: não se apaga nem se altera.</div>
          {definitivas === null && <div style={{ fontSize: 13, color: "#94a3b8" }}>Carregando…</div>}
          {definitivas?.erro && <div style={{ fontSize: 13, color: "#dc2626" }}>Erro ao carregar: {definitivas.erro}</div>}
          {Array.isArray(definitivas) && listaDef.length === 0 && <div style={{ fontSize: 13, color: "#94a3b8" }}>Nenhuma.</div>}
          {listaDef.map(d => (
            <div key={d.id} style={{ ...cartao, background: "#fafafa" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>PROPOSTA #{d.numero || d.obra_id}</div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#475569" }}>{d.data?.obra || d.cliente}</div>
              <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>
                Excluída definitivamente em {fmtQuando(d.excluida_em)}{d.excluida_por ? ` por ${d.excluida_por}` : ""}
              </div>
              <Historico historico={normArquivo(d.data?.arquivo).historico.filter(h => h.acao !== "excluida_definitivo")} />
            </div>
          ))}
        </div>
      )}

      <ConfirmarPasso passo={passo?.passo} obra={passo?.obra} onFechar={() => setPasso(null)}
        onConfirmar={async (por, senha) => {
          await onPasso(passo.obra, passo.passo, por, senha);
          if (passo.passo === "excluida_definitivo") setRecarregar(n => n + 1);
        }} />
    </div>
  );
}
