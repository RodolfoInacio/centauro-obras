// ─────────────────────────────────────────────────────────────────────────────
// Cadastro do cliente / contrato: os campos que o escritório escrevia na descrição do cartão
// do Trello. Usado no popup de novo contrato e na seção "Cadastro" da tela da obra.
// cliente, obra (nome da obra), cidade e vendedor são campos soltos da obra (vêm do PDF);
// o resto mora em `obra.cadastro` (default em normObra).
// ─────────────────────────────────────────────────────────────────────────────

export const CADASTRO_VAZIO = {
  lojaFaturamento: "", contatoNome: "", telefones: "", enderecoObra: "", enderecoCliente: "",
  linha: "", cor: "", vidro: "", medidas: "", obs: "",
};

export function normCadastro(c) {
  const base = { ...CADASTRO_VAZIO };
  if (c && typeof c === "object") for (const k of Object.keys(base)) base[k] = typeof c[k] === "string" ? c[k] : "";
  return base;
}

const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };

function Campo({ rotulo, largo, children, extra }) {
  return (
    <label style={{ gridColumn: largo ? "1 / -1" : "auto", minWidth: 0 }}>
      <span style={lbl}>{rotulo}{extra}</span>
      {children}
    </label>
  );
}

// Link discreto ao lado do rótulo (abrir no mapa, chamar no WhatsApp).
function LinkRotulo({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
      style={{ marginLeft: 8, color: "#2563eb", fontWeight: 700, textTransform: "none", textDecoration: "none" }}>{children}</a>
  );
}

function linkWhats(tel) {
  const d = (tel || "").split(/[\/,;]| e /)[0].replace(/\D/g, "");
  if (d.length < 10) return null;
  return "https://wa.me/" + (d.length <= 11 ? "55" + d : d);
}
function linkMapa(end, cidade) {
  const q = [end, cidade].filter(Boolean).join(", ");
  return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : null;
}

// obra: { cliente, obra, cidade, vendedor, cadastro }. onChange recebe a obra inteira alterada.
// comLinks: mostra WhatsApp/mapa (na tela da obra; no popup ainda não faz sentido).
export default function CadastroObra({ obra, onChange, comLinks = false }) {
  const cad = normCadastro(obra.cadastro);
  const setSolto = (campo, v) => onChange({ ...obra, [campo]: v });
  const setCad = (campo, v) => onChange({ ...obra, cadastro: { ...cad, [campo]: v } });
  const whats = comLinks && linkWhats(cad.telefones);
  const mapa = comLinks && linkMapa(cad.enderecoObra, obra.cidade);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px 14px" }}>
      <Campo rotulo="Cliente / empresa">
        <input style={inp} value={obra.cliente || ""} onChange={e => setSolto("cliente", e.target.value)} placeholder="J L Campanholo Consultoria" />
      </Campo>
      <Campo rotulo="Nome da obra">
        <input style={inp} value={obra.obra || ""} onChange={e => setSolto("obra", e.target.value)} placeholder="José Luiz — vidro acústico quarto frente" />
      </Campo>
      <Campo rotulo="Loja de faturamento">
        <input style={inp} list="lojas-faturamento" value={cad.lojaFaturamento} onChange={e => setCad("lojaFaturamento", e.target.value)} placeholder="Loja 01" />
        <datalist id="lojas-faturamento"><option value="LOJA 01" /><option value="LOJA 02" /></datalist>
      </Campo>
      <Campo rotulo="Contato em obra">
        <input style={inp} value={cad.contatoNome} onChange={e => setCad("contatoNome", e.target.value)} placeholder="José Luiz" />
      </Campo>
      <Campo rotulo="Telefones" extra={whats && <LinkRotulo href={whats}>WhatsApp ↗</LinkRotulo>}>
        <input style={inp} value={cad.telefones} onChange={e => setCad("telefones", e.target.value)} placeholder="41 9218-3696" />
      </Campo>
      <Campo rotulo="Vendedor">
        <input style={inp} value={obra.vendedor || ""} onChange={e => setSolto("vendedor", e.target.value)} />
      </Campo>
      <Campo rotulo="Endereço da obra" largo extra={mapa && <LinkRotulo href={mapa}>Abrir no mapa ↗</LinkRotulo>}>
        <input style={inp} value={cad.enderecoObra} onChange={e => setCad("enderecoObra", e.target.value)} placeholder="Rua Ponta Grossa, 1261, Centro — Ed Fenix Apto 61" />
      </Campo>
      <Campo rotulo="Cidade">
        <input style={inp} value={obra.cidade || ""} onChange={e => setSolto("cidade", e.target.value)} />
      </Campo>
      <Campo rotulo="Endereço do cliente / empresa">
        <input style={inp} value={cad.enderecoCliente} onChange={e => setCad("enderecoCliente", e.target.value)} />
      </Campo>

      <div style={{ gridColumn: "1 / -1", fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", borderTop: "1px solid #f1f5f9", paddingTop: 8, marginTop: 2 }}>
        Especificações para orçamento
      </div>
      <Campo rotulo="Linha de esquadrias">
        <input style={inp} value={cad.linha} onChange={e => setCad("linha", e.target.value)} placeholder="Sem especificação" />
      </Campo>
      <Campo rotulo="Cor">
        <input style={inp} value={cad.cor} onChange={e => setCad("cor", e.target.value)} placeholder="Sem especificação" />
      </Campo>
      <Campo rotulo="Vidro">
        <input style={inp} value={cad.vidro} onChange={e => setCad("vidro", e.target.value)} placeholder="Sem especificação" />
      </Campo>
      <Campo rotulo="Medidas">
        <input style={inp} value={cad.medidas} onChange={e => setCad("medidas", e.target.value)} placeholder="Em anexo" />
      </Campo>
      <Campo rotulo="Observações" largo>
        <textarea rows={3} style={{ ...inp, resize: "vertical" }} value={cad.obs} onChange={e => setCad("obs", e.target.value)} />
      </Campo>
    </div>
  );
}
