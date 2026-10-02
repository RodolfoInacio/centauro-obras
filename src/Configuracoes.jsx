import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { fetchConfiguracoes, salvarConfiguracoes } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Configurações do app, iguais para todos os computadores (tabela `configuracoes`, uma linha
// 'geral'). Sem a tabela, valem os padrões e a tela avisa que não dá para salvar.
// A tela pede senha. Como a do Sigilo, é tranca visual: as configurações chegam a qualquer
// usuário logado. A senha fica aqui só como SHA-256 porque o repositório é público.
// ─────────────────────────────────────────────────────────────────────────────

const HASH_SENHA = "73f5f84a4a362736504e579ed4361c2bab41ba76037fe83b4d8c89ab35519ebc";

export const SECOES_OBRA = [
  { id: "cadastro", rotulo: "Cadastro do cliente" },
  { id: "anexos", rotulo: "Anexos" },
  { id: "checklist", rotulo: "Checklist de abertura" },
  { id: "itens", rotulo: "Itens e cronograma" },
  { id: "compras", rotulo: "Compras" },
  { id: "financeiro", rotulo: "Financeiro" },
  { id: "equipe", rotulo: "Equipe e status" },
];

export const ORDENS_LISTA = [
  { id: "ordem", rotulo: "↕ Ordem manual" },
  { id: "numero", rotulo: "# Número" },
  { id: "nome", rotulo: "Nome (A-Z)" },
  { id: "pct", rotulo: "% Execução" },
  { id: "itens", rotulo: "Itens" },
  { id: "pecas", rotulo: "Peças" },
];

// Telas que podem sair do menu. "Obras" e "Configurações" ficam sempre.
export const MENU_OCULTAVEL = [
  { id: "avisos", rotulo: "Central de avisos", icone: "⚠️" },
  { id: "relatorios", rotulo: "Relatórios", icone: "📈" },
  { id: "calendar", rotulo: "Calendário", icone: "📅" },
  { id: "diario", rotulo: "Diário de Obras", icone: "📓" },
  { id: "equipes", rotulo: "Equipes", icone: "👷" },
  { id: "estoque", rotulo: "Estoque", icone: "📦" },
  { id: "cronogramas", rotulo: "Cronograma Comercial", icone: "📊" },
  { id: "financeiro", rotulo: "Financeiro", icone: "🔒" },
];

// Largura da capa em px (a altura é 3/4). Os padrões são os tamanhos de antes desta tela.
export const CAPA_LISTA = { min: 48, max: 200, padrao: 64 };
export const CAPA_OBRA = { min: 64, max: 280, padrao: 88 };

const entre = (v, { min, max, padrao }) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : padrao;
};

// Undefined-safe, no espírito de normObra: campo novo entra aqui com o padrão.
export function normConfiguracoes(c) {
  c = c && typeof c === "object" ? c : {};
  const secoes = Array.isArray(c.secoesAbertas) ? c.secoesAbertas : ["cadastro", "anexos"];
  return {
    capaLista: entre(c.capaLista, CAPA_LISTA),
    capaObra: entre(c.capaObra, CAPA_OBRA),
    secoesAbertas: secoes.filter(id => SECOES_OBRA.some(s => s.id === id)),
    ordemLista: ORDENS_LISTA.some(o => o.id === c.ordemLista) ? c.ordemLista : "ordem",
    menuOculto: (Array.isArray(c.menuOculto) ? c.menuOculto : []).filter(id => MENU_OCULTAVEL.some(m => m.id === id)),
    // 0 = os valores em R$ só se escondem ao recarregar, sair ou clicar no olho (como antes).
    sigiloMinutos: Math.max(0, Math.min(240, Math.round(Number(c.sigiloMinutos) || 0))),
  };
}

const PADRAO = normConfiguracoes({});
const ConfigCtx = createContext({ cfg: PADRAO, disponivel: false, salvar: async () => {} });
export const useConfig = () => useContext(ConfigCtx);

// Fica no main.jsx (fora do App), junto do Sigilo, que lê o tempo dos valores daqui.
export function ConfigProvider({ children }) {
  const [cfg, setCfg] = useState(PADRAO);
  const [disponivel, setDisponivel] = useState(false);
  const [userId, setUserId] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUserId(data.session?.user?.id || null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUserId(s?.user?.id || null));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancel = false;
    fetchConfiguracoes()
      .then(c => { if (cancel) return; setDisponivel(c !== null); setCfg(normConfiguracoes(c)); })
      .catch(err => console.warn("configurações:", err.message));
    return () => { cancel = true; };
  }, [userId]);

  async function salvar(novo) {
    const n = normConfiguracoes(novo);
    await salvarConfiguracoes(n);
    setCfg(n);
  }

  return <ConfigCtx.Provider value={{ cfg, disponivel, salvar }}>{children}</ConfigCtx.Provider>;
}

async function sha256(texto) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Liberada uma vez, a tela fica aberta até recarregar a página.
let liberada = false;

const cartao = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "16px 18px", marginBottom: 12 };
const tituloSecao = { fontWeight: 800, fontSize: 14, color: "#1a1a1a", marginBottom: 4 };
const ajuda = { fontSize: 12, color: "#64748b", marginBottom: 12 };
const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnClaro = { background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" };

function Senha({ onOk }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  async function entrar(e) {
    e.preventDefault();
    if (await sha256(pw) === HASH_SENHA) { liberada = true; onOk(); }
    else { setErr("Senha incorreta."); setPw(""); }
  }
  return (
    <div style={{ padding: "60px 20px", display: "flex", justifyContent: "center" }}>
      <form onSubmit={entrar} style={{ ...cartao, width: 340, maxWidth: "100%" }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>⚙️ Configurações</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>Digite a senha das configurações.</div>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus placeholder="Senha"
          style={{ width: "100%", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", fontSize: 14, boxSizing: "border-box", marginBottom: 12 }} />
        {err && <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <button type="submit" style={{ ...btnEscuro, width: "100%" }}>Entrar</button>
      </form>
    </div>
  );
}

function Capa({ largura }) {
  return (
    <div style={{ width: largura, height: Math.round(largura * 3 / 4), borderRadius: 8, border: "1px solid #e2e8f0", flexShrink: 0,
      background: "linear-gradient(135deg, #cbd5e1, #94a3b8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(14, largura / 4) }}>
      📷
    </div>
  );
}

function Deslizante({ rotulo, valor, faixa, onChange, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b" }}>{rotulo}</span>
        <span style={{ fontSize: 12, color: "#64748b" }}>{valor} × {Math.round(valor * 3 / 4)} px</span>
        {valor !== faixa.padrao && (
          <button type="button" onClick={() => onChange(faixa.padrao)}
            style={{ border: "none", background: "transparent", color: "#2563eb", fontSize: 12, cursor: "pointer", padding: 0 }}>voltar ao padrão</button>
        )}
      </div>
      <input type="range" min={faixa.min} max={faixa.max} step={4} value={valor} onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", maxWidth: 420 }} />
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

function Marcavel({ marcado, onChange, children }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1e293b", padding: "5px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={marcado} onChange={e => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function ConfiguracoesView({ onSalvo }) {
  const { cfg, disponivel, salvar } = useConfig();
  const [ok, setOk] = useState(liberada);
  const [rasc, setRasc] = useState(cfg);
  const [gravando, setGravando] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setRasc(cfg); }, [cfg]);

  if (!ok) return <Senha onOk={() => setOk(true)} />;

  const set = (campo, valor) => { setRasc(r => ({ ...r, [campo]: valor })); setMsg(null); };
  const alternarLista = (campo, id, incluir) =>
    set(campo, incluir ? [...rasc[campo].filter(x => x !== id), id] : rasc[campo].filter(x => x !== id));
  const mudou = JSON.stringify(normConfiguracoes(rasc)) !== JSON.stringify(cfg);

  async function gravar() {
    setGravando(true);
    try {
      await salvar(rasc);
      setMsg({ ok: true, texto: "Configurações salvas — já valem em todos os computadores." });
      onSalvo?.();
    } catch (err) {
      setMsg({ ok: false, texto: "Não deu para salvar: " + err.message });
    } finally {
      setGravando(false);
    }
  }

  return (
    <div style={{ padding: "20px 16px 40px", maxWidth: 760, margin: "0 auto" }}>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>⚙️ Configurações</div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>Valem para todos os computadores e celulares do escritório.</div>

      {!disponivel && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 12 }}>
          Falta criar a tabela de configurações no Supabase: rode <b>supabase/migration_configuracoes.sql</b> no SQL Editor.
          Até lá o app usa os valores padrão e não dá para salvar.
        </div>
      )}

      <div style={cartao}>
        <div style={tituloSecao}>🖼️ Tamanho das fotos de capa</div>
        <div style={ajuda}>A capa é a foto marcada com ★ nos anexos ou, sem escolha, a primeira foto da obra.</div>
        <Deslizante rotulo="Na lista de obras" valor={rasc.capaLista} faixa={CAPA_LISTA} onChange={v => set("capaLista", v)}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, maxWidth: 420 }}>
            <Capa largura={rasc.capaLista} />
            <div><div style={{ fontWeight: 800, fontSize: 13 }}>#2909 · EDGARD MAX</div><div style={{ fontSize: 12, color: "#64748b" }}>Exemplo do card</div></div>
          </div>
        </Deslizante>
        <Deslizante rotulo="Dentro da obra (ao lado do nome)" valor={rasc.capaObra} faixa={CAPA_OBRA} onChange={v => set("capaObra", v)}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 520 }}>
            <Capa largura={rasc.capaObra} />
            <div style={{ fontWeight: 800, fontSize: 18 }}>EDGARD MAX INCORPORADORA</div>
          </div>
        </Deslizante>
      </div>

      <div style={cartao}>
        <div style={tituloSecao}>📂 Seções da obra que já abrem abertas</div>
        <div style={ajuda}>Ao salvar, vale como ponto de partida em todos os computadores. Depois cada um pode abrir e fechar à vontade.</div>
        {SECOES_OBRA.map(s => (
          <Marcavel key={s.id} marcado={rasc.secoesAbertas.includes(s.id)} onChange={v => alternarLista("secoesAbertas", s.id, v)}>{s.rotulo}</Marcavel>
        ))}
      </div>

      <div style={cartao}>
        <div style={tituloSecao}>↕ Ordem padrão da lista de obras</div>
        <div style={ajuda}>Como a lista vem ordenada ao abrir. Quem trocar na lista continua com a escolha dele até a próxima mudança aqui.</div>
        <select value={rasc.ordemLista} onChange={e => set("ordemLista", e.target.value)}
          style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, background: "#fff" }}>
          {ORDENS_LISTA.map(o => <option key={o.id} value={o.id}>{o.rotulo}</option>)}
        </select>
      </div>

      <div style={cartao}>
        <div style={tituloSecao}>☰ Itens do menu</div>
        <div style={ajuda}>Desmarque o que o escritório não usa. A tela continua existindo — só sai do menu. Obras e Configurações ficam sempre.</div>
        {MENU_OCULTAVEL.map(m => (
          <Marcavel key={m.id} marcado={!rasc.menuOculto.includes(m.id)} onChange={v => alternarLista("menuOculto", m.id, !v)}>
            <span>{m.icone}</span> {m.rotulo}
          </Marcavel>
        ))}
      </div>

      <div style={cartao}>
        <div style={tituloSecao}>🔒 Valores em R$</div>
        <div style={ajuda}>Depois de liberar os valores com a senha, esconder de novo sozinho após um tempo sem mexer no app.</div>
        <select value={rasc.sigiloMinutos} onChange={e => set("sigiloMinutos", Number(e.target.value))}
          style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, background: "#fff" }}>
          <option value={0}>Nunca (só ao recarregar, sair ou clicar no olho)</option>
          {[2, 5, 10, 15, 30, 60].map(m => <option key={m} value={m}>Após {m} minutos sem uso</option>)}
        </select>
      </div>

      <div style={{ position: "sticky", bottom: 0, background: "#f1f5f9", padding: "10px 0", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={gravar} disabled={!mudou || gravando || !disponivel}
          style={{ ...btnEscuro, opacity: !mudou || gravando || !disponivel ? 0.45 : 1, cursor: !mudou || gravando || !disponivel ? "default" : "pointer" }}>
          {gravando ? "Salvando…" : "Salvar configurações"}
        </button>
        {mudou && <button type="button" onClick={() => { setRasc(cfg); setMsg(null); }} style={btnClaro}>Descartar</button>}
        {msg && <span style={{ fontSize: 13, fontWeight: 700, color: msg.ok ? "#16a34a" : "#dc2626" }}>{msg.texto}</span>}
      </div>
    </div>
  );
}
