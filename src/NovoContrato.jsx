import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import CadastroObra, { normCadastro } from "./CadastroObra";
import { AreaSoltar, CATEGORIAS_ANEXO, categoriaPalpite, fmtTamanho, LIMITE_ANEXO } from "./AnexosObra";
import { agruparSimples } from "./agrupamento";
import { Oculto } from "./Sigilo";

// ─────────────────────────────────────────────────────────────────────────────
// "+ Novo cliente / contrato": o cartão do Trello, agora dentro do app.
// Etapa 1 escolhe entre cliente novo e novo contrato de uma obra que já existe (o cliente vai
// fechando serviços ao longo da obra). Etapa 2 é o cadastro — os campos da descrição do Trello —,
// com atalho para preencher pelo PDF do orçamento e os anexos iniciais.
//
// O nº da proposta é obrigatório e continua sendo o id da obra. Quem grava é o App (onSalvar),
// com INSERT: proposta repetida é recusada, nunca sobrescrita.
// ─────────────────────────────────────────────────────────────────────────────

const VAZIO = () => ({
  numero: "", cliente: "", obra: "", cidade: "", vendedor: "", data: "", dataContrato: "",
  valorTotal: 0, itens: [], cadastro: normCadastro(),
});

const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };
const btnSec = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };
const btnPri = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };

export default function NovoContrato({ open, obras, onFechar, onLerPdf, onSalvar }) {
  const [etapa, setEtapa] = useState("tipo");       // tipo | cadastro
  const [modo, setModo] = useState("novo");         // novo | existente
  const [grupoChave, setGrupoChave] = useState("");
  const [f, setF] = useState(VAZIO);
  const [arquivos, setArquivos] = useState([]);     // [{ file, categoria }]
  const [lendo, setLendo] = useState(false);
  const [aviso, setAviso] = useState("");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const pdfRef = useRef();

  useEffect(() => {
    if (!open) return;
    setEtapa("tipo"); setModo("novo"); setGrupoChave(""); setF(VAZIO()); setArquivos([]);
    setLendo(false); setAviso(""); setErro(""); setSalvando(false);
  }, [open]);

  const grupos = useMemo(
    () => agruparSimples(obras).sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR")),
    [obras],
  );
  const grupoEscolhido = grupos.find(g => g.chave === grupoChave);
  const existe = (n) => obras.some(o => String(o.id) === n || String(o.numero) === n);

  // Fechar com dado digitado pergunta antes: cadastro perdido por um clique fora é o que não pode.
  const sujo = etapa === "cadastro" && (f.numero || f.cliente || f.obra || arquivos.length || Object.values(f.cadastro).some(Boolean));
  function fechar() {
    if (salvando) return;
    if (sujo && !window.confirm("Descartar este cadastro? O que foi digitado não foi gravado.")) return;
    onFechar();
  }

  function continuar() {
    if (modo === "existente") {
      if (!grupoEscolhido) { setErro("Escolha a obra à qual o contrato novo pertence."); return; }
      // Contato e endereços vêm do contrato mais recente do grupo; as especificações não,
      // porque cada contrato costuma ser um serviço diferente.
      const base = grupoEscolhido.contratos[grupoEscolhido.contratos.length - 1];
      const cb = normCadastro(base.cadastro);
      setF({
        ...VAZIO(),
        cliente: base.cliente || "", cidade: base.cidade || "", vendedor: base.vendedor || "",
        cadastro: {
          ...normCadastro(),
          lojaFaturamento: cb.lojaFaturamento, contatoNome: cb.contatoNome, telefones: cb.telefones,
          enderecoObra: cb.enderecoObra, enderecoCliente: cb.enderecoCliente,
        },
      });
    } else {
      setF(VAZIO());
    }
    setErro("");
    setEtapa("cadastro");
  }

  async function lerPdf(file) {
    setLendo(true); setErro(""); setAviso("");
    try {
      const { _fallback, ...o } = await onLerPdf(file);
      setF(prev => ({
        ...prev,
        numero: o.numero || prev.numero,
        // No contrato de obra existente o cliente fica o do grupo — é ele que mantém o agrupamento.
        cliente: modo === "novo" || !prev.cliente ? (o.cliente || prev.cliente) : prev.cliente,
        obra: o.obra || prev.obra,
        cidade: prev.cidade || o.cidade || "",
        vendedor: prev.vendedor || o.vendedor || "",
        data: o.data || prev.data,
        valorTotal: Number(o.valorTotal) || prev.valorTotal,
        itens: o.itens && o.itens.length ? o.itens : prev.itens,
      }));
      setArquivos(prev => prev.some(a => a.file === file) ? prev : [...prev, { file, categoria: "orcamento" }]);
      setAviso(`${(o.itens || []).length} itens lidos do PDF${_fallback ? " pela extração local (IA indisponível) — confira os itens depois" : ""}. O PDF entra nos anexos como orçamento.`);
    } catch (err) {
      setErro("Não deu para ler o PDF: " + err.message);
    } finally {
      setLendo(false);
    }
  }

  function receber(files) {
    setArquivos(prev => [...prev, ...files.filter(fl => !prev.some(a => a.file === fl)).map(fl => ({ file: fl, categoria: categoriaPalpite(fl) }))]);
  }

  async function salvar() {
    const numero = String(f.numero || "").trim();
    if (!numero) { setErro("Informe o nº da proposta."); return; }
    if (existe(numero)) { setErro(`A proposta #${numero} já está cadastrada — abra a obra existente em vez de criar outra.`); return; }
    if (!f.cliente.trim()) { setErro("Informe o cliente."); return; }
    const grandes = arquivos.filter(a => a.file.size > LIMITE_ANEXO);
    if (grandes.length) { setErro("Acima de 25 MB: " + grandes.map(a => a.file.name).join(", ")); return; }
    setSalvando(true);
    setErro("");
    try {
      await onSalvar({
        obra: {
          ...f, id: numero, numero, cliente: f.cliente.trim(), valorTotal: Number(f.valorTotal) || 0,
          status: "Aguardando", dataInicio: "", dataLimiteEntrega: "", equipes: [],
          grupo: modo === "existente" ? grupoChave : "",
        },
        arquivos,
      });
      // Deu certo: quem fecha é o App, depois de subir os anexos.
    } catch (err) {
      setErro(err.message);
      setSalvando(false);
    }
  }

  return (
    <Modal open={open} title={etapa === "tipo" ? "Novo cliente / contrato" : (modo === "existente" ? `Novo contrato — ${grupoEscolhido?.nome || ""}` : "Cadastro do cliente novo")}
      onClose={fechar} width={etapa === "tipo" ? 520 : 820}>
      {etapa === "tipo" ? (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { id: "novo", icone: "🆕", titulo: "Cliente novo", sub: "Primeiro contrato deste cliente" },
              { id: "existente", icone: "⛓", titulo: "Obra existente", sub: "Mais um contrato de um cliente que já tem obra" },
            ].map(op => (
              <button key={op.id} onClick={() => { setModo(op.id); setErro(""); }}
                style={{ textAlign: "left", background: modo === op.id ? "#f8fafc" : "#fff", border: `2px solid ${modo === op.id ? "#1a1a1a" : "#e2e8f0"}`, borderRadius: 10, padding: "14px 14px", cursor: "pointer" }}>
                <div style={{ fontSize: 22 }}>{op.icone}</div>
                <div style={{ fontWeight: 800, fontSize: 14, color: "#1a1a1a", marginTop: 4 }}>{op.titulo}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{op.sub}</div>
              </button>
            ))}
          </div>
          {modo === "existente" && (
            <label style={{ display: "block", marginBottom: 14 }}>
              <span style={lbl}>Obra</span>
              <select value={grupoChave} onChange={e => { setGrupoChave(e.target.value); setErro(""); }} style={{ ...inp, cursor: "pointer" }}>
                <option value="">— escolha a obra —</option>
                {grupos.map(g => (
                  <option key={g.chave} value={g.chave}>{g.nome} ({g.contratos.map(o => "#" + o.numero).join(", ")})</option>
                ))}
              </select>
            </label>
          )}
          {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginBottom: 10 }}>{erro}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={fechar} style={btnSec}>Cancelar</button>
            <button onClick={continuar} style={btnPri}>Continuar →</button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ maxHeight: "68vh", overflowY: "auto", paddingRight: 4 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9, padding: "10px 12px", marginBottom: 14 }}>
              <button onClick={() => pdfRef.current.click()} disabled={lendo} style={{ ...btnSec, cursor: lendo ? "wait" : "pointer" }}>
                {lendo ? "Lendo o PDF…" : "📄 Preencher com o PDF do orçamento"}
              </button>
              <span style={{ fontSize: 12, color: "#64748b", flex: 1, minWidth: 200 }}>
                {aviso || "Lê nº da proposta, obra, cidade, itens e valor. Dá para preencher tudo à mão também."}
              </span>
              <input ref={pdfRef} type="file" accept=".pdf" style={{ display: "none" }}
                onChange={e => { const fl = e.target.files?.[0]; if (fl) lerPdf(fl); e.target.value = ""; }} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px 14px", marginBottom: 12 }}>
              <label>
                <span style={lbl}>Nº da proposta *</span>
                <input style={{ ...inp, fontWeight: 800 }} value={f.numero} onChange={e => { setF({ ...f, numero: e.target.value.trim() }); setErro(""); }} placeholder="2432" autoFocus />
              </label>
              <label>
                <span style={lbl}>Data do contrato</span>
                <input type="date" style={inp} value={f.dataContrato} onChange={e => setF({ ...f, dataContrato: e.target.value })} />
              </label>
              <label>
                <span style={lbl}>Valor do contrato</span>
                <Oculto>
                  <input type="number" min={0} step="0.01" style={inp} value={f.valorTotal || ""} onChange={e => setF({ ...f, valorTotal: Math.max(0, Number(e.target.value) || 0) })} />
                </Oculto>
              </label>
              <div style={{ fontSize: 12, color: "#64748b", alignSelf: "end", paddingBottom: 8 }}>
                {f.itens.length ? `${f.itens.length} itens do orçamento` : "Sem itens (entram pelo PDF)"}
              </div>
            </div>

            <CadastroObra obra={f} onChange={o => { setF(o); setErro(""); }} />

            <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", borderTop: "1px solid #f1f5f9", paddingTop: 10, margin: "14px 0 8px" }}>
              Anexos — projeto, fotos, contrato assinado, comprovantes
            </div>
            {arquivos.map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.file.name}>{a.file.name}</span>
                <span style={{ fontSize: 11, color: a.file.size > LIMITE_ANEXO ? "#dc2626" : "#94a3b8" }}>{fmtTamanho(a.file.size)}</span>
                <select value={a.categoria} onChange={e => setArquivos(prev => prev.map((x, j) => j === i ? { ...x, categoria: e.target.value } : x))}
                  style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", fontSize: 11.5, background: "#fff" }}>
                  {CATEGORIAS_ANEXO.map(c => <option key={c.id} value={c.id}>{c.icone} {c.rotulo}</option>)}
                </select>
                <button onClick={() => setArquivos(prev => prev.filter((_, j) => j !== i))} title="Tirar da lista"
                  style={{ background: "none", border: "none", color: "#dc2626", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}><AreaSoltar onArquivos={receber} /></div>
          </div>

          {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginTop: 10 }}>{erro}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button onClick={() => { setEtapa("tipo"); setErro(""); }} disabled={salvando} style={btnSec}>← Voltar</button>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={fechar} disabled={salvando} style={btnSec}>Cancelar</button>
              <button onClick={salvar} disabled={salvando} style={{ ...btnPri, background: salvando ? "#64748b" : "#10b981", cursor: salvando ? "wait" : "pointer" }}>
                {salvando ? (arquivos.length ? "Gravando e enviando anexos…" : "Gravando…") : "Cadastrar obra"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
