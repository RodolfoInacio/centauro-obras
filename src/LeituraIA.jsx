import { Fragment, useEffect, useState } from "react";
import Modal from "./Modal";
import { lerDocumentoComIA, mudarCategoriaAnexo } from "./api";
import { normCadastro } from "./CadastroObra";
import { CATEGORIAS_COMPRA, CATEGORIA_LABEL, normCompras, lancarDocumentoCompra } from "./ComprasObra";
import { useSigilo, Dinheiro } from "./Sigilo";

// ─────────────────────────────────────────────────────────────────────────────
// Leitura de anexo com IA: contrato, comprovante de pagamento, nota fiscal de compra e orçamento
// de fornecedor. A IA só LÊ (Edge Function analisar-documento); esta tela mostra o valor atual ao
// lado do lido, o usuário marca o que entra e corrige, e só então a obra muda — pelo mesmo
// `update` da tela, com trava de versão. Nada é gravado sem conferência: valor lido errado não
// pode entrar no Recebido ou em Compras sozinho.
// ─────────────────────────────────────────────────────────────────────────────

export const TIPOS_DOC = {
  contrato:             { rotulo: "Contrato", icone: "📝", categoriaAnexo: "contrato" },
  comprovante:          { rotulo: "Comprovante de pagamento", icone: "🧾", categoriaAnexo: "comprovante" },
  nota_fiscal:          { rotulo: "Nota fiscal de compra", icone: "🧮", categoriaAnexo: null },
  orcamento_fornecedor: { rotulo: "Orçamento de fornecedor", icone: "📄", categoriaAnexo: "orcamento" },
  outro:                { rotulo: "Outro documento", icone: "📎", categoriaAnexo: null },
};

export const podeLerComIA = mime => mime === "application/pdf" || /^image\/(jpeg|png|webp|gif)$/.test(mime || "");

// obra.documentosLidos = { [anexoId]: { tipo, em } }. Existe para avisar antes de aplicar o mesmo
// comprovante duas vezes — somaria o pagamento em dobro no Recebido.
export function normDocumentosLidos(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const out = {};
  for (const [id, v] of Object.entries(d)) if (v && TIPOS_DOC[v.tipo]) out[id] = { tipo: v.tipo, em: v.em || "" };
  return out;
}

// solto = campo direto da obra; o resto mora em obra.cadastro.
const CAMPOS_CONTRATO = [
  { id: "cliente", rotulo: "Cliente / empresa", solto: true },
  { id: "cidade", rotulo: "Cidade", solto: true },
  { id: "contatoNome", rotulo: "Contato em obra" },
  { id: "telefones", rotulo: "Telefones" },
  { id: "enderecoObra", rotulo: "Endereço da obra" },
  { id: "enderecoCliente", rotulo: "Endereço do cliente" },
  { id: "linha", rotulo: "Linha" },
  { id: "cor", rotulo: "Cor" },
  { id: "vidro", rotulo: "Vidro" },
  { id: "dataContrato", rotulo: "Data do contrato", solto: true, tipo: "data" },
  { id: "dataLimiteEntrega", rotulo: "Limite de entrega", solto: true, tipo: "data" },
  { id: "valorTotal", rotulo: "Valor total", solto: true, tipo: "valor" },
  { id: "obs", rotulo: "Observações", tipo: "acrescenta" },
];

const dataValida = d => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : "");
const fmtData = d => (d ? d.split("-").reverse().join("/") : "");
const vazio = (v, tipo) => (tipo === "valor" ? !(Number(v) > 0) : !String(v || "").trim());

// O que a IA precisa saber da obra: quem é o cliente (para avisar documento de outra obra) e os
// itens de compra (para casar a NF com o item certo). Sem valores.
function contextoObra(obra) {
  const c = normCompras(obra.compras);
  return {
    proposta: obra.numero, cliente: obra.cliente, obra: obra.obra, cidade: obra.cidade,
    itensCompra: CATEGORIAS_COMPRA.flatMap(cat => c[cat].itens.map(it => ({
      id: it.id, categoria: cat, especificacao: it.tipo, fornecedores: it.fornecedores.map(f => f.nome).filter(Boolean),
    }))),
  };
}

function atualContrato(obra, campo) {
  return campo.solto ? obra[campo.id] : normCadastro(obra.cadastro)[campo.id];
}

// Estado editável a partir do que a IA leu. Marcado por padrão só o que preenche campo vazio;
// o que troca um valor já digitado fica desmarcado — quem sobrescreve é o usuário, não a IA.
function prepararEdicao(doc, obra, jaLido) {
  const ct = doc.contrato || {}, pg = doc.pagamento || {}, cp = doc.compra || {};
  const cad = normCadastro(obra.cadastro);
  const contrato = {};
  for (const campo of CAMPOS_CONTRATO) {
    let v = ct[campo.id];
    if (campo.tipo === "data") v = dataValida(v);
    else if (campo.tipo === "valor") v = Number(v) || 0;
    else v = String(v || "").trim();
    const atual = atualContrato(obra, campo);
    const marcado = campo.tipo === "acrescenta"
      ? !!v && !cad.obs.includes(v)
      : !vazio(v, campo.tipo) && vazio(atual, campo.tipo);
    contrato[campo.id] = { valor: v, marcado };
  }
  const compras = normCompras(obra.compras);
  const categoria = CATEGORIAS_COMPRA.includes(cp.categoria) ? cp.categoria : "";
  const itemId = categoria && compras[categoria].itens.some(it => it.id === cp.itemCompraId) ? cp.itemCompraId : "";
  return {
    contrato,
    pagamento: { valor: Number(pg.valor) || 0, data: dataValida(pg.data), marcado: Number(pg.valor) > 0 && !jaLido },
    compra: {
      categoria, itemId,
      especificacao: cp.especificacao || "", fornecedor: cp.fornecedor || "", numeroNF: cp.numeroNF || "",
      data: dataValida(cp.data), valor: Number(cp.valor) || 0,
      marcado: !jaLido && (Number(cp.valor) > 0 || !!cp.fornecedor),
    },
  };
}

const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 6, padding: "5px 8px", fontSize: 12.5, boxSizing: "border-box", fontFamily: "inherit", background: "#fff", color: "#1e293b" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };
const btn = { border: "1px solid #e2e8f0", background: "#fff", color: "#475569", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" };

function CampoValor({ value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#64748b" }}>R$</span>
      <input type="number" min={0} step="0.01" value={value || ""} onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        style={{ ...inp, textAlign: "right" }} />
    </div>
  );
}

// Campo financeiro com os valores ocultos: não dá para conferir o que não se vê, então não marca.
function TravaValor() {
  const { pedir } = useSigilo();
  return (
    <button type="button" onClick={pedir}
      style={{ background: "none", border: "none", color: "#2563eb", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>
      🔒 Mostrar valores para conferir
    </button>
  );
}

export default function LeituraIA({ obra, anexo, onFechar, onAplicar }) {
  const { visivel } = useSigilo();
  const jaLido = normDocumentosLidos(obra.documentosLidos)[anexo.id];
  const [fase, setFase] = useState("lendo"); // lendo | erro | pronto
  const [erro, setErro] = useState("");
  const [doc, setDoc] = useState(null);
  const [tipo, setTipo] = useState("outro");
  const [ed, setEd] = useState(null);
  const [mudarCategoria, setMudarCategoria] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  // Lê uma vez ao abrir. O contexto é da obra no momento da abertura — não relê se ela mudar.
  useEffect(() => {
    let cancel = false;
    setFase("lendo");
    lerDocumentoComIA(anexo.id, contextoObra(obra))
      .then(d => {
        if (cancel) return;
        setDoc(d);
        setTipo(TIPOS_DOC[d.tipo] ? d.tipo : "outro");
        setEd(prepararEdicao(d, obra, jaLido));
        setFase("pronto");
      })
      .catch(err => { if (!cancel) { setErro(err.message); setFase("erro"); } });
    return () => { cancel = true; };
  }, [anexo.id, tentativa]); // eslint-disable-line react-hooks/exhaustive-deps

  const titulo = `✨ Ler com IA — ${anexo.nome}`;

  if (fase !== "pronto") {
    return (
      <Modal open title={titulo} onClose={onFechar} width={520}>
        {fase === "lendo" ? (
          <div style={{ fontSize: 13, color: "#64748b", padding: "18px 0", textAlign: "center" }}>
            Lendo o documento… costuma levar de 10 a 40 segundos.
          </div>
        ) : (
          <>
            <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 14 }}>
              Não deu para ler: {erro}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={btn} onClick={onFechar}>Fechar</button>
              <button style={{ ...btn, background: "#1a1a1a", color: "#fff", borderColor: "#1a1a1a" }} onClick={() => setTentativa(t => t + 1)}>Tentar de novo</button>
            </div>
          </>
        )}
      </Modal>
    );
  }

  const compras = normCompras(obra.compras);
  const setContrato = (id, mud) => setEd(e => ({ ...e, contrato: { ...e.contrato, [id]: { ...e.contrato[id], ...mud } } }));
  const setPagamento = mud => setEd(e => ({ ...e, pagamento: { ...e.pagamento, ...mud } }));
  const setCompra = mud => setEd(e => ({ ...e, compra: { ...e.compra, ...mud } }));

  const ehCompra = tipo === "nota_fiscal" || tipo === "orcamento_fornecedor";
  const catAnexo = TIPOS_DOC[tipo].categoriaAnexo;
  const trocaCategoria = catAnexo && catAnexo !== anexo.categoria;

  // O que de fato entra: marcado, com valor e — se for dinheiro — com os valores à mostra.
  const camposContrato = tipo !== "contrato" ? [] : CAMPOS_CONTRATO.filter(c => {
    const l = ed.contrato[c.id], atual = atualContrato(obra, c);
    if (!l.marcado || vazio(l.valor, c.tipo)) return false;
    if (c.tipo === "valor" && !visivel) return false;
    return c.tipo === "acrescenta" || String(atual ?? "") !== String(l.valor);
  });
  const pagamentoOk = tipo === "comprovante" && visivel && ed.pagamento.marcado && ed.pagamento.valor > 0;
  const compraOk = ehCompra && visivel && ed.compra.marcado && !!ed.compra.categoria && !!ed.compra.fornecedor.trim()
    && (!!ed.compra.itemId || !!ed.compra.especificacao.trim());
  const algo = camposContrato.length > 0 || pagamentoOk || compraOk;

  const previaCompra = ehCompra && ed.compra.categoria
    ? lancarDocumentoCompra(obra.compras, { ...ed.compra, ehNF: tipo === "nota_fiscal" })
    : null;

  async function aplicar() {
    setAplicando(true);
    const nome = `"${anexo.nome}"`;
    let nova = { ...obra }, atividade = "";

    if (tipo === "contrato") {
      const cad = normCadastro(obra.cadastro);
      for (const c of camposContrato) {
        const v = ed.contrato[c.id].valor;
        if (c.tipo === "acrescenta") cad.obs = cad.obs ? `${cad.obs}\n${v}` : v;
        else if (c.solto) nova[c.id] = v;
        else cad[c.id] = v;
      }
      nova.cadastro = cad;
      atividade = `Leitura com IA do contrato ${nome} preencheu: ${camposContrato.map(c => c.rotulo).join(", ")}`;
    } else if (tipo === "comprovante") {
      // Arredonda em centavos: 0,1 + 0,2 somados várias vezes viram 0,30000000000000004.
      nova.valorRecebido = Math.round(((Number(obra.valorRecebido) || 0) + ed.pagamento.valor) * 100) / 100;
      // Sem o valor no texto: a coluna de comentários aparece com os valores ocultos.
      atividade = `Leitura com IA do comprovante ${nome}: pagamento${ed.pagamento.data ? " de " + fmtData(ed.pagamento.data) : ""} somado ao Recebido`;
    } else if (ehCompra) {
      const ehNF = tipo === "nota_fiscal";
      const { compras: c, finalizouOrcamento } = lancarDocumentoCompra(obra.compras, {
        ...ed.compra, fornecedor: ed.compra.fornecedor.trim(), ehNF,
        obs: `Lido pela IA ${ehNF ? "da NF" : "do orçamento"} ${nome}`,
      });
      nova.compras = c;
      const onde = `Compras › ${CATEGORIA_LABEL[ed.compra.categoria]}`;
      atividade = ehNF
        ? `Leitura com IA: NF ${ed.compra.numeroNF || "s/nº"} de ${ed.compra.fornecedor.trim()} lançada em ${onde}${finalizouOrcamento ? " (finalizou o orçamento já lançado)" : ""}`
        : `Leitura com IA: orçamento de ${ed.compra.fornecedor.trim()} lançado em ${onde}`;
    }

    nova.documentosLidos = { ...normDocumentosLidos(obra.documentosLidos), [anexo.id]: { tipo, em: new Date().toISOString() } };
    // A categoria do anexo é da tabela obra_anexos, fora da obra. Se falhar, a obra ainda aplica.
    if (trocaCategoria && mudarCategoria) {
      try { await mudarCategoriaAnexo(anexo.id, catAnexo); } catch (err) { console.warn("categoria do anexo:", err.message); }
    }
    onAplicar(nova, atividade);
  }

  const cabecalho = (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
      <select value={tipo} onChange={e => setTipo(e.target.value)} style={{ ...inp, width: "auto", fontWeight: 700 }} title="Se a IA errou o tipo, troque aqui">
        {Object.entries(TIPOS_DOC).map(([id, t]) => <option key={id} value={id}>{t.icone} {t.rotulo}</option>)}
      </select>
      <span style={{ fontSize: 12.5, color: "#475569", flex: 1, minWidth: 200 }}>{doc.resumo}</span>
    </div>
  );

  return (
    <Modal open title={titulo} onClose={onFechar} width={780}>
      <div style={{ maxHeight: "68vh", overflowY: "auto", paddingRight: 4 }}>
        {cabecalho}

        {jaLido && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }}>
            ⚠ Este documento já foi aplicado nesta obra em {new Date(jaLido.em).toLocaleDateString("pt-BR")}. Aplicar de novo pode lançar o mesmo pagamento ou a mesma compra duas vezes.
          </div>
        )}
        {(doc.avisos || []).length > 0 && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 10 }}>
            <b>Confira:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{doc.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
        )}

        {tipo === "contrato" && (
          <div style={{ display: "grid", gridTemplateColumns: "22px minmax(100px, 140px) minmax(0, 1fr) minmax(0, 1.3fr)", gap: "6px 10px", alignItems: "center" }}>
            <span /><span style={lbl}>Campo</span><span style={lbl}>Hoje na obra</span><span style={lbl}>Lido no contrato</span>
            {CAMPOS_CONTRATO.map(c => {
              const l = ed.contrato[c.id];
              const atual = atualContrato(obra, c);
              const bloqueado = c.tipo === "valor" && !visivel;
              const igual = c.tipo !== "acrescenta" && !vazio(atual, c.tipo) && String(atual) === String(l.valor);
              return (
                <Fragment key={c.id}>
                  <input type="checkbox" checked={l.marcado && !bloqueado && !igual} disabled={bloqueado || igual || vazio(l.valor, c.tipo)}
                    onChange={e => setContrato(c.id, { marcado: e.target.checked })} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "#334155" }}>{c.rotulo}</span>
                  <span style={{ fontSize: 12.5, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: c.tipo === "acrescenta" ? "pre-wrap" : "nowrap" }} title={String(atual || "")}>
                    {c.tipo === "valor" ? (atual ? <Dinheiro v={atual} /> : "—") : c.tipo === "data" ? (fmtData(atual) || "—") : (atual || "—")}
                  </span>
                  <span>
                    {bloqueado ? <TravaValor />
                      : c.tipo === "valor" ? <CampoValor value={l.valor} onChange={v => setContrato(c.id, { valor: v, marcado: v > 0 })} />
                      : c.tipo === "data" ? <input type="date" value={l.valor} onChange={e => setContrato(c.id, { valor: e.target.value, marcado: !!e.target.value })} style={inp} />
                      : c.tipo === "acrescenta" ? <textarea rows={3} value={l.valor} onChange={e => setContrato(c.id, { valor: e.target.value, marcado: !!e.target.value.trim() })} style={{ ...inp, resize: "vertical" }} />
                      : <input value={l.valor} onChange={e => setContrato(c.id, { valor: e.target.value, marcado: !!e.target.value.trim() })} style={inp} />}
                    {igual && <span style={{ fontSize: 11, color: "#10b981", fontWeight: 700 }}>igual ao da obra</span>}
                  </span>
                </Fragment>
              );
            })}
            <div style={{ gridColumn: "1 / -1", fontSize: 11.5, color: "#94a3b8" }}>
              Vêm marcados só os campos vazios na obra. Para trocar um valor já preenchido, marque a linha. Observações são acrescentadas ao que já existe.
            </div>
          </div>
        )}

        {tipo === "comprovante" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <label style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 700, color: "#334155" }}>
              <input type="checkbox" checked={ed.pagamento.marcado && visivel} disabled={!visivel} onChange={e => setPagamento({ marcado: e.target.checked })} />
              Somar este pagamento ao Recebido da obra
            </label>
            <div>
              <span style={lbl}>Valor pago</span>
              {visivel ? <CampoValor value={ed.pagamento.valor} onChange={v => setPagamento({ valor: v })} /> : <TravaValor />}
            </div>
            <div>
              <span style={lbl}>Data do pagamento</span>
              <input type="date" value={ed.pagamento.data} onChange={e => setPagamento({ data: e.target.value })} style={inp} />
            </div>
            <div>
              <span style={lbl}>Recebido</span>
              <div style={{ fontSize: 13, color: "#334155", paddingTop: 5 }}>
                <Dinheiro v={obra.valorRecebido || 0} /> → <b style={{ color: "#10b981" }}><Dinheiro v={(Number(obra.valorRecebido) || 0) + (ed.pagamento.marcado ? ed.pagamento.valor : 0)} /></b>
              </div>
            </div>
            <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#64748b" }}>
              {[doc.pagamento?.pagador && `Pagador: ${doc.pagamento.pagador}`, doc.pagamento?.forma, doc.pagamento?.identificador && `ID ${doc.pagamento.identificador}`].filter(Boolean).join(" · ")}
            </div>
          </div>
        )}

        {ehCompra && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <label style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 700, color: "#334155" }}>
              <input type="checkbox" checked={ed.compra.marcado && visivel} disabled={!visivel} onChange={e => setCompra({ marcado: e.target.checked })} />
              {tipo === "nota_fiscal" ? "Lançar a compra em Compras" : "Lançar o orçamento em Compras"}
            </label>
            <div>
              <span style={lbl}>Categoria</span>
              <select value={ed.compra.categoria} onChange={e => setCompra({ categoria: e.target.value, itemId: "" })}
                style={{ ...inp, borderColor: ed.compra.categoria ? "#e2e8f0" : "#f59e0b" }}>
                <option value="">Escolha…</option>
                {CATEGORIAS_COMPRA.map(c => <option key={c} value={c}>{CATEGORIA_LABEL[c]}</option>)}
              </select>
            </div>
            <div>
              <span style={lbl}>Item</span>
              <select value={ed.compra.itemId} onChange={e => setCompra({ itemId: e.target.value })} disabled={!ed.compra.categoria} style={inp}>
                <option value="">+ Novo item</option>
                {ed.compra.categoria && compras[ed.compra.categoria].itens.map((it, i) => (
                  <option key={it.id} value={it.id}>Item {i + 1} · {it.tipo || "sem especificação"}</option>
                ))}
              </select>
            </div>
            {!ed.compra.itemId && (
              <div style={{ gridColumn: "1 / -1" }}>
                <span style={lbl}>Especificação do item novo</span>
                <input value={ed.compra.especificacao} onChange={e => setCompra({ especificacao: e.target.value })} style={inp} />
              </div>
            )}
            <div>
              <span style={lbl}>Fornecedor</span>
              <input value={ed.compra.fornecedor} onChange={e => setCompra({ fornecedor: e.target.value })} style={inp} />
            </div>
            {tipo === "nota_fiscal" && (
              <div>
                <span style={lbl}>Nº da NF</span>
                <input value={ed.compra.numeroNF} onChange={e => setCompra({ numeroNF: e.target.value })} style={inp} />
              </div>
            )}
            <div>
              <span style={lbl}>{tipo === "nota_fiscal" ? "Emissão / data da compra" : "Data do orçamento"}</span>
              <input type="date" value={ed.compra.data} onChange={e => setCompra({ data: e.target.value })} style={inp} />
            </div>
            <div>
              <span style={lbl}>{tipo === "nota_fiscal" ? "Valor da compra" : "Valor orçado"}</span>
              {visivel ? <CampoValor value={ed.compra.valor} onChange={v => setCompra({ valor: v })} /> : <TravaValor />}
            </div>
            {previaCompra?.finalizouOrcamento && (
              <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#2563eb" }}>
                Já existe um orçamento de {ed.compra.fornecedor} neste item. A NF finaliza a compra nele, sem criar uma linha nova.
              </div>
            )}
          </div>
        )}

        {tipo === "outro" && (
          <div style={{ fontSize: 13, color: "#64748b", padding: "8px 0" }}>
            Não é contrato, comprovante, nota fiscal nem orçamento de fornecedor: não há campo para preencher. Se a IA errou o tipo, troque no seletor acima.
          </div>
        )}

        {trocaCategoria && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "#475569", marginTop: 14 }}>
            <input type="checkbox" checked={mudarCategoria} onChange={e => setMudarCategoria(e.target.checked)} />
            Mudar a categoria do anexo para {TIPOS_DOC[tipo].icone} {TIPOS_DOC[tipo].rotulo}
          </label>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
        <button style={btn} onClick={onFechar}>Cancelar</button>
        <button disabled={!algo || aplicando} onClick={aplicar}
          style={{ ...btn, background: algo ? "#1a1a1a" : "#cbd5e1", color: "#fff", borderColor: algo ? "#1a1a1a" : "#cbd5e1", cursor: algo ? "pointer" : "not-allowed" }}>
          {aplicando ? "Aplicando…" : "Aplicar na obra"}
        </button>
      </div>
    </Modal>
  );
}

