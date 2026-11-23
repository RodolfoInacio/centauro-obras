// Portaria: decide se o login abre o sistema da equipe ou o portal do cliente.
//
// Fica por fora do App (main.jsx) porque o App dispara todas as cargas da equipe antes de qualquer
// gate — com o cliente logado, elas só voltariam vazias pela RLS, mas não há por que fazê-las.
// O papel vem primeiro do app_metadata do token (instantâneo; só a service_role grava) e é
// conferido no profiles, que é o que a RLS usa.
//
// Sem login: o link do cliente (`/?portal`) abre a tela de entrada do portal; o resto abre o
// login normal do App (que também aceita usuário de cliente e cai aqui depois).
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { papelDoLogin, emailDoLogin } from "./api";
import PortalCliente from "./PortalCliente.jsx";
import logoCor from "./assets/logo-cor.svg";

const CHAVE_LINK = "portal.link";

function veioPeloLink() {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.has("portal")) { sessionStorage.setItem(CHAVE_LINK, "1"); return true; }
    return sessionStorage.getItem(CHAVE_LINK) === "1";
  } catch { return false; }
}

export default function Portaria({ children }) {
  const [sessao, setSessao] = useState(undefined);   // undefined = ainda lendo
  const [papel, setPapel] = useState(null);           // { userId, papel }
  const [pelaLink] = useState(veioPeloLink);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSessao(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => {
      // Mesmo usuário (troca de aba renova o token): mantém o objeto, como o App faz.
      setSessao(prev => (prev && s && prev.user?.id === s.user?.id ? prev : s || null));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = sessao?.user?.id || null;
  const peloToken = sessao?.user?.app_metadata?.papel === "cliente";
  useEffect(() => {
    if (!userId) { setPapel(null); return; }
    let vivo = true;
    papelDoLogin(userId).then(p => { if (vivo) setPapel({ userId, papel: p }); });
    return () => { vivo = false; };
  }, [userId]);

  if (sessao === undefined) return null;
  if (!userId) return pelaLink ? <EntradaPortal /> : children;

  const ehCliente = peloToken || (papel?.userId === userId && papel.papel === "cliente");
  if (ehCliente) return <PortalCliente />;
  // Equipe: não espera o perfil para abrir o sistema (o token já diz que não é cliente).
  return children;
}

// Tela de entrada do cliente: grande, de um campo por linha, pensada para o celular.
function EntradaPortal() {
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [ver, setVer] = useState(false);
  const [erro, setErro] = useState("");
  const [busy, setBusy] = useState(false);

  async function entrar(e) {
    e.preventDefault();
    setBusy(true); setErro("");
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000));
      const { error } = await Promise.race([
        supabase.auth.signInWithPassword({ email: emailDoLogin(usuario), password: senha }),
        timeout,
      ]);
      if (error) { setErro(/banned/i.test(error.message) ? "Este acesso está bloqueado. Fale com a Centauro." : "Usuário ou senha inválidos."); setBusy(false); }
    } catch {
      setErro("Conexão lenta ou indisponível. Tente de novo.");
      setBusy(false);
    }
  }

  const campo = { width: "100%", border: "1px solid #cbd5e1", borderRadius: 10, padding: "13px 14px", fontSize: 16, margin: "6px 0 16px", boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };
  return (
    <div style={{ minHeight: "100dvh", background: "linear-gradient(160deg,#34353A 0%,#1a1a1a 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', system-ui, sans-serif", padding: 16, boxSizing: "border-box" }}>
      <form onSubmit={entrar} style={{ background: "#fff", borderRadius: 18, padding: "30px 22px 24px", width: 400, maxWidth: "100%", boxShadow: "0 18px 50px rgba(0,0,0,0.35)", boxSizing: "border-box" }}>
        <img src={logoCor} alt="Centauro Esquadrias" style={{ height: 46, display: "block", margin: "0 auto 10px", maxWidth: "80%" }} />
        <div style={{ textAlign: "center", fontSize: 19, fontWeight: 800, color: "#1e293b" }}>Acompanhe sua obra</div>
        <div style={{ textAlign: "center", fontSize: 14, color: "#64748b", margin: "4px 0 22px" }}>Prazos, andamento, fotos e conversa com a nossa equipe.</div>

        <label style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>Usuário</label>
        <input value={usuario} onChange={e => setUsuario(e.target.value)} autoFocus required
          autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" style={campo} />

        <label style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>Senha</label>
        <div style={{ position: "relative" }}>
          <input type={ver ? "text" : "password"} value={senha} onChange={e => setSenha(e.target.value)} required
            autoComplete="current-password" style={{ ...campo, paddingRight: 70 }} />
          <button type="button" onClick={() => setVer(v => !v)}
            style={{ position: "absolute", right: 6, top: 12, height: 36, padding: "0 10px", border: "none", background: "transparent", color: "#2563eb", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            {ver ? "Ocultar" : "Mostrar"}
          </button>
        </div>

        {erro && <div style={{ background: "#fee2e2", color: "#b91c1c", borderRadius: 10, padding: "10px 12px", fontSize: 14, marginBottom: 14 }}>{erro}</div>}

        <button type="submit" disabled={busy}
          style={{ width: "100%", minHeight: 50, background: busy ? "#94a3b8" : "#ED5454", color: "#fff", border: "none", borderRadius: 12, fontWeight: 800, fontSize: 16, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <div style={{ textAlign: "center", fontSize: 12.5, color: "#94a3b8", marginTop: 16 }}>
          Não tem acesso? Fale com a Centauro: (41) 3442-2144
        </div>
      </form>
    </div>
  );
}
