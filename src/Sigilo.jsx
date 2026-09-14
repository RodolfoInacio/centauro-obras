import { createContext, useContext, useState } from "react";
import Modal from "./Modal";

// ─────────────────────────────────────────────────────────────────────────────
// Sigilo dos valores financeiros. Todo R$ do app nasce oculto (R$ ••••••) e só aparece depois da
// senha — no olho da barra do topo, no olho de cada bloco ou clicando no próprio valor. Vale para
// o app inteiro e dura até recarregar a página, sair ou clicar no olho de novo.
// É tranca visual: a senha está no bundle e os valores chegam ao navegador do mesmo jeito.
// ─────────────────────────────────────────────────────────────────────────────

const SENHA_FINANCEIRO = "00centauro00";
export const MASCARA = "••••••";

const SigiloCtx = createContext({ visivel: false, pedir: () => {}, ocultar: () => {}, desbloquear: () => false });
export const useSigilo = () => useContext(SigiloCtx);

export function SigiloProvider({ children }) {
  const [visivel, setVisivel] = useState(false);
  const [pedindo, setPedindo] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  function desbloquear(senha) {
    if (senha !== SENHA_FINANCEIRO) return false;
    setVisivel(true);
    return true;
  }
  const ctx = {
    visivel,
    desbloquear,
    ocultar: () => setVisivel(false),
    pedir: () => { setPw(""); setErr(""); setPedindo(true); },
  };

  return (
    <SigiloCtx.Provider value={ctx}>
      {children}
      <Modal open={pedindo} title="🔒 Valores financeiros" onClose={() => setPedindo(false)} width={340}>
        <form onSubmit={e => {
          e.preventDefault();
          if (desbloquear(pw)) setPedindo(false);
          else { setErr("Senha incorreta."); setPw(""); }
        }}>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>Digite a senha para mostrar os valores.</div>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus placeholder="Senha"
            style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", fontSize: 14, boxSizing: "border-box", marginBottom: 12 }} />
          {err && <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setPedindo(false)}
              style={{ background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
            <button type="submit"
              style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Mostrar valores</button>
          </div>
        </form>
      </Modal>
    </SigiloCtx.Provider>
  );
}

function fmtReais(n) {
  return Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Valor em reais, ou a máscara. A máscara é clicável e pede a senha; o stopPropagation é porque
// quase todo valor mora dentro de um card ou linha que abre alguma coisa ao clicar.
export function Dinheiro({ v, prefixo = "R$ " }) {
  const { visivel, pedir } = useSigilo();
  if (visivel) return <>{prefixo}{fmtReais(v)}</>;
  return (
    <span onClick={e => { e.stopPropagation(); pedir(); }} title="Valor oculto — clique para ver"
      style={{ cursor: "pointer", letterSpacing: 1 }}>
      {prefixo}{MASCARA}
    </span>
  );
}

// Mostra os filhos (tipicamente um campo de valor) só com os valores liberados.
export function Oculto({ children, prefixo = "R$ " }) {
  const { visivel } = useSigilo();
  return visivel ? children : <Dinheiro prefixo={prefixo} />;
}

function IconeOlho({ aberto, size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!aberto && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

// Botão do olho: fechado = valores ocultos (clicar pede a senha), aberto = visíveis (clicar oculta).
export function OlhoFinanceiro({ escuro = false, size = 18, rotulo = false }) {
  const { visivel, pedir, ocultar } = useSigilo();
  const cor = escuro ? "#e2e8f0" : "#64748b";
  return (
    <button type="button" onClick={e => { e.stopPropagation(); visivel ? ocultar() : pedir(); }}
      title={visivel ? "Ocultar valores financeiros" : "Mostrar valores financeiros (pede senha)"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", color: cor, border: `1px solid ${escuro ? "#333" : "#e2e8f0"}`, borderRadius: 8, padding: rotulo ? "5px 10px" : 5, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
      <IconeOlho aberto={visivel} size={size} />
      {rotulo && (visivel ? "Ocultar valores" : "Mostrar valores")}
    </button>
  );
}
