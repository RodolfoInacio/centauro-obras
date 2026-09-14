import { useState, useEffect, useMemo, useRef } from "react";
import Modal from "./Modal";
import { Oculto, useSigilo } from "./Sigilo";
import {
  salvarItemEstoque, lancarDocumentoEstoque, estornarDocumentoEstoque,
  fetchDocumentosEstoque, fetchDocumentoEstoque, fetchMovimentosItem, fetchMovimentosObra,
  fetchTodosMovimentosEstoque,
} from "./api";
import logoDark from "./assets/logo-dark.png";

// ─────────────────────────────────────────────────────────────────────────────
// Estoque — cadastro de material + livro-razão de entradas e saídas.
//
// Aqui não vale o padrão do resto do app (estado muda na hora, upsert debounced).
// Todo lançamento espera o banco responder: é o banco que numera o documento, trava
// o item e recusa saída maior que o saldo. O que aparece na tela é sempre o que foi
// relido do banco depois de gravar. Documento lançado não se edita — estorna.
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIAS_ESTOQUE = [
  { k: "perfil", rotulo: "Perfil" },
  { k: "vidro", rotulo: "Vidro" },
  { k: "acessorio", rotulo: "Acessório" },
  { k: "pintura", rotulo: "Pintura" },
  { k: "consumivel", rotulo: "Consumível" },
  { k: "ferramenta", rotulo: "Ferramenta" },
  { k: "outro", rotulo: "Outro" },
];
const CATEGORIA_ROTULO = Object.fromEntries(CATEGORIAS_ESTOQUE.map(c => [c.k, c.rotulo]));
const CATEGORIA_COR = {
  perfil: "#475569", vidro: "#0891b2", acessorio: "#7c3aed", pintura: "#db2777",
  consumivel: "#ca8a04", ferramenta: "#ea580c", outro: "#94a3b8",
};
const UNIDADES = ["un", "pç", "barra", "chapa", "kg", "m", "m²", "L", "cx", "rolo", "par", "jogo"];

export const TIPOS_DOC = {
  entrada: { prefixo: "ENT", rotulo: "Entrada", cor: "#059669" },
  saida: { prefixo: "SAI", rotulo: "Saída", cor: "#dc2626" },
  ajuste: { prefixo: "AJU", rotulo: "Ajuste", cor: "#d97706" },
  estorno: { prefixo: "ETN", rotulo: "Estorno", cor: "#64748b" },
};
// As chaves casam com a função estoque_lancar: "obra" (saída) e "devolucao" (entrada) são as
// únicas que guardam a obra no documento.
const MOTIVOS = {
  entrada: [
    { k: "compra", rotulo: "Compra" },
    { k: "devolucao", rotulo: "Devolução de obra (sobra)" },
    { k: "inventario_inicial", rotulo: "Inventário inicial" },
    { k: "outro", rotulo: "Outro" },
  ],
  saida: [
    { k: "obra", rotulo: "Para obra" },
    { k: "perda", rotulo: "Perda / avaria" },
    { k: "uso_interno", rotulo: "Uso interno" },
    { k: "outro", rotulo: "Outro" },
  ],
  ajuste: [{ k: "contagem", rotulo: "Contagem de inventário" }],
  estorno: [{ k: "estorno", rotulo: "Estorno" }],
};
export function rotuloMotivo(tipo, motivo) {
  return (MOTIVOS[tipo] || []).find(m => m.k === motivo)?.rotulo || motivo || "";
}
export function numeroDoc(d) {
  if (!d) return "";
  return `${TIPOS_DOC[d.tipo]?.prefixo || "DOC"}-${String(d.numero).padStart(6, "0")}`;
}

// A etiqueta aponta sempre para produção: etiqueta impressa a partir do localhost
// levaria a um endereço que não existe no celular do depósito.
export const URL_ITEM = "https://obras.centauroesquadrias.com.br/?item=";

// Aceita o código puro (leitor de código de barras) ou a URL inteira do QR (leitor 2D, ou
// colado). Procura só o "item=": leitor configurado como teclado americano num Windows ABNT2
// troca "/" e "?" de lugar, mas "=" e "-" ficam onde estão.
export function codigoDoTexto(txt) {
  const t = String(txt || "").trim();
  const m = t.match(/item=([A-Za-z0-9-]+)/);
  return (m ? m[1] : t).toUpperCase();
}

// ─── utilidades ──────────────────────────────────────────────────────────────
// "Hoje" local, não toISOString(): às 21h no Brasil o ISO já é amanhã.
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function primeiroDoMes() { return hojeLocal().slice(0, 8) + "01"; }
function dataBR(iso) {
  if (!iso) return "—";
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}
function dataHoraBR(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtQtd(n) { return Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 3 }); }
function fmtMoeda(n) { return Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
const r3 = x => Math.round(x * 1000) / 1000; // soma de 0,1 + 0,2 não pode virar 0,30000000004
// "1,5" e "1.5" valem 1,5; "1.250,5" vale 1250,5. Vazio é NaN, para a validação pegar.
function num(s) {
  const t = String(s ?? "").trim();
  if (!t) return NaN;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : NaN;
}
function semAcento(s) { return String(s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase(); }
const abaixoMinimo = i => i.estoqueMinimo > 0 && i.saldo <= i.estoqueMinimo;
const concluida = o => /conclu/i.test(o.status || "");
function rotuloObra(o) { return `#${o.numero} — ${o.cliente || ""}`; }
function obrasOrdenadas(obras) {
  return [...obras].sort((a, b) => (concluida(a) - concluida(b)) || ((Number(b.numero) || 0) - (Number(a.numero) || 0)));
}
function nomeEquipe(equipes, id) { return (equipes || []).find(e => e.id === id)?.nome || ""; }

// ─── estilos ─────────────────────────────────────────────────────────────────
const card = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12 };
const inp = { border: "1px solid #cbd5e1", borderRadius: 7, padding: "7px 10px", fontSize: 13, color: "#1e293b", background: "#fff", width: "100%", boxSizing: "border-box" };
const rotulo = { fontSize: 11, color: "#64748b", fontWeight: 700, display: "block", marginBottom: 4 };
const th = { padding: "8px 10px", fontSize: 11, color: "#64748b", fontWeight: 800, textAlign: "left", textTransform: "uppercase", letterSpacing: 0.3, borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap", background: "#f8fafc" };
const td = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid #f1f5f9", verticalAlign: "middle" };
function btn(cor = "#1a1a1a", cheio = true) {
  return {
    background: cheio ? cor : "#fff", color: cheio ? "#fff" : cor, border: `1px solid ${cheio ? cor : "#e2e8f0"}`,
    borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap",
  };
}
const btnMini = cor => ({ background: cor + "14", color: cor, border: `1px solid ${cor}44`, borderRadius: 6, padding: "3px 9px", fontWeight: 800, fontSize: 13, cursor: "pointer", lineHeight: 1.2 });
const link = { background: "none", border: "none", color: "#2563eb", fontWeight: 700, cursor: "pointer", padding: 0, fontSize: "inherit", fontFamily: "inherit" };

function Chip({ cor, children, title }) {
  return (
    <span title={title} style={{ background: cor + "1a", color: cor, border: `1px solid ${cor}44`, borderRadius: 999, padding: "1px 9px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function Faixa({ cor, children, onFechar }) {
  return (
    <div style={{ background: cor + "12", color: cor, border: `1px solid ${cor}44`, borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 600, marginBottom: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ flex: 1 }}>{children}</span>
      {onFechar && <button onClick={onFechar} style={{ background: "none", border: "none", color: cor, fontSize: 18, lineHeight: 1, cursor: "pointer" }}>×</button>}
    </div>
  );
}

function Voltar({ onClick, children = "← Estoque" }) {
  return <button onClick={onClick} style={{ ...link, fontSize: 13, marginBottom: 12 }}>{children}</button>;
}

function baixarCSV(nome, linhas) {
  const esc = v => {
    const s = v == null ? "" : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM + ";" para o Excel em português abrir com acento e colunas certas.
  const txt = String.fromCharCode(0xFEFF) + linhas.map(l => l.map(esc).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const numCSV = n => (n == null || n === "" ? "" : String(n).replace(".", ","));

// ─── TELA PRINCIPAL ──────────────────────────────────────────────────────────
export default function EstoqueView({ itens, erroCarga, obras, equipes, fornecedores = [], codigoInicial, entradaCompra, onEntradaCompraLancada, onLimparParametros, onRecarregar, onImprimirDoc, onImprimirEtiquetas }) {
  const [tela, setTela] = useState({ tipo: "lista" });
  const [editando, setEditando] = useState(null); // item em edição no modal ({} = novo)
  const [aviso, setAviso] = useState("");
  const [exportando, setExportando] = useState(false);

  // Veio pelo QR (?item=EST-00012): abre a ficha assim que os itens chegarem, uma vez só.
  const abriuQR = useRef(false);
  useEffect(() => {
    if (!codigoInicial || abriuQR.current || itens.length === 0) return;
    abriuQR.current = true;
    const cod = codigoDoTexto(codigoInicial);
    const alvo = itens.find(i => i.codigo === cod);
    if (alvo) setTela({ tipo: "item", id: alvo.id });
    else setAviso(`Nenhum item com o código ${cod}.`);
  }, [codigoInicial, itens]);

  // Veio do botão "Dar entrada no estoque" de Compras: abre a entrada já preenchida. Depois limpa
  // o parâmetro da view, senão o "Voltar" da folha impressa reabriria o formulário.
  const abriuEntrada = useRef(null);
  useEffect(() => {
    if (!entradaCompra || abriuEntrada.current === entradaCompra) return;
    abriuEntrada.current = entradaCompra;
    setTela({ tipo: "lancar", tipoDoc: "entrada", preset: entradaCompra, volta: { tipo: "lista" } });
    if (onLimparParametros) onLimparParametros();
  }, [entradaCompra, onLimparParametros]);

  const irLancar = (tipoDoc, item) => setTela({ tipo: "lancar", tipoDoc, itemId: item?.id || null, volta: tela });

  async function salvarItem(form) {
    const r = await salvarItemEstoque(form);
    const inicial = num(form.saldoInicial);
    let erroInicial = "";
    if (!form.id && inicial > 0) {
      try {
        await lancarDocumentoEstoque(
          { tipo: "entrada", motivo: "inventario_inicial", dia: hojeLocal(), obs: "Saldo inicial informado no cadastro do item" },
          [{ item_id: r.id, quantidade: inicial }]);
      } catch (e) {
        erroInicial = e.message;
      }
    }
    await onRecarregar();
    setEditando(null);
    if (!form.id) setTela({ tipo: "item", id: r.id });
    if (erroInicial) setAviso(`O item foi criado, mas o saldo inicial não entrou: ${erroInicial}. Lance uma entrada de "Inventário inicial".`);
  }

  async function alternarArquivo(item) {
    const arquivar = !item.arquivado;
    if (arquivar && !window.confirm(`Arquivar ${item.codigo} — ${item.nome}?\n\nEle sai da lista e das escolhas, mas o histórico continua guardado. Dá para reativar depois.`)) return;
    try {
      await salvarItemEstoque({ ...item, arquivado: arquivar });
      await onRecarregar();
    } catch (e) {
      setAviso("Não foi possível " + (arquivar ? "arquivar" : "reativar") + ": " + e.message);
    }
  }

  async function exportar() {
    setExportando(true);
    try {
      const movs = await fetchTodosMovimentosEstoque();
      const hoje = hojeLocal();
      baixarCSV(`estoque-itens-${hoje}.csv`, [
        ["Código", "Item", "Categoria", "Unidade", "Local", "Saldo", "Estoque mínimo", "Arquivado", "Descrição", "Acabamento", "Cód. fornecedor"],
        ...itens.map(i => [i.codigo, i.nome, CATEGORIA_ROTULO[i.categoria] || i.categoria, i.unidade, i.local, numCSV(i.saldo), numCSV(i.estoqueMinimo),
          i.arquivado ? "sim" : "", i.data.descricao, i.data.acabamento, i.data.codFornecedor]),
      ]);
      baixarCSV(`estoque-movimentos-${hoje}.csv`, [
        ["Documento", "Tipo", "Data", "Motivo", "Obra", "Equipe", "Fornecedor", "NF", "Responsável", "Recebido por", "Código", "Item", "Unidade", "Quantidade", "Valor unit.", "Lançado em", "Obs"],
        ...movs.map(m => [numeroDoc(m.doc), TIPOS_DOC[m.doc.tipo]?.rotulo, dataBR(m.doc.dia), rotuloMotivo(m.doc.tipo, m.doc.motivo), m.doc.obraRotulo,
          nomeEquipe(equipes, m.doc.equipeId), m.doc.fornecedor, m.doc.nfNumero, m.doc.responsavel, m.doc.recebidoPor,
          m.codigo, m.nome, m.unidade, numCSV(m.quantidade), numCSV(m.valorUnitario), dataHoraBR(m.createdAt), m.doc.obs]),
      ]);
    } catch (e) {
      setAviso("Erro ao exportar: " + e.message);
    } finally {
      setExportando(false);
    }
  }

  const itemAberto = tela.tipo === "item" ? itens.find(i => i.id === tela.id) : null;

  let conteudo;
  if (itemAberto) {
    conteudo = (
      <FichaItem item={itemAberto} onVoltar={() => setTela({ tipo: "lista" })}
        onEditar={() => setEditando(itemAberto)} onLancar={tipo => irLancar(tipo, itemAberto)}
        onEtiqueta={() => onImprimirEtiquetas([itemAberto.id])} onAbrirDoc={onImprimirDoc}
        onArquivar={() => alternarArquivo(itemAberto)} />
    );
  } else if (tela.tipo === "lancar") {
    conteudo = (
      <LancarDocumento tipoInicial={tela.tipoDoc} itemInicialId={tela.itemId} preset={tela.preset || null}
        itens={itens} obras={obras} equipes={equipes} fornecedores={fornecedores}
        onCancelar={() => setTela(tela.volta || { tipo: "lista" })}
        onLancado={async doc => {
          // Só entrada marca o orçamento: se trocaram para saída no meio, não foi a compra que chegou.
          if (tela.preset && doc.tipo === "entrada" && onEntradaCompraLancada) onEntradaCompraLancada(tela.preset, doc);
          await onRecarregar();
          onImprimirDoc(doc.id);
        }} />
    );
  } else if (tela.tipo === "documentos") {
    conteudo = (
      <ListaDocumentos onVoltar={() => setTela({ tipo: "lista" })} onAbrirDoc={onImprimirDoc}
        onEstornado={onRecarregar} />
    );
  } else {
    conteudo = (
      <ListaEstoque itens={itens} onAbrir={id => setTela({ tipo: "item", id })} onLancar={irLancar}
        onNovoItem={() => setEditando({})} onDocumentos={() => setTela({ tipo: "documentos" })}
        onEtiquetas={onImprimirEtiquetas} onExportar={exportar} exportando={exportando} />
    );
  }

  return (
    <div style={{ padding: "20px 24px 40px", maxWidth: 1240, margin: "0 auto" }}>
      {erroCarga && (
        <Faixa cor="#dc2626">Não consegui ler o estoque: {erroCarga}. A <b>migration_estoque.sql</b> já foi rodada no Supabase?</Faixa>
      )}
      {aviso && <Faixa cor="#b45309" onFechar={() => setAviso("")}>{aviso}</Faixa>}
      {conteudo}
      {editando && <ItemForm item={editando} onSalvar={salvarItem} onFechar={() => setEditando(null)} />}
    </div>
  );
}

// ─── LISTA ───────────────────────────────────────────────────────────────────
function Kpi({ rotulo: r, valor, cor = "#1e293b", onClick, ativo }) {
  return (
    <div onClick={onClick} style={{ ...card, padding: "12px 16px", flex: "1 1 160px", cursor: onClick ? "pointer" : "default", borderColor: ativo ? cor : "#e2e8f0", boxShadow: ativo ? `0 0 0 2px ${cor}33` : "none" }}>
      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{r}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: cor, marginTop: 2 }}>{valor}</div>
    </div>
  );
}

function ListaEstoque({ itens, onAbrir, onLancar, onNovoItem, onDocumentos, onEtiquetas, onExportar, exportando }) {
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState("");
  const [soAbaixo, setSoAbaixo] = useState(false);
  const [verArquivados, setVerArquivados] = useState(false);
  const [sel, setSel] = useState(() => new Set());

  const termo = semAcento(busca.trim());
  const codigoBusca = codigoDoTexto(busca);
  const filtrados = useMemo(() => itens.filter(i =>
    (verArquivados || !i.arquivado)
    && (!categoria || i.categoria === categoria)
    && (!soAbaixo || abaixoMinimo(i))
    && (!termo || i.codigo === codigoBusca
      || semAcento([i.codigo, i.nome, i.local, i.data.descricao, i.data.acabamento, i.data.codFornecedor].join(" ")).includes(termo))
  ), [itens, verArquivados, categoria, soAbaixo, termo, codigoBusca]);

  const ativos = itens.filter(i => !i.arquivado);
  const qtdAbaixo = ativos.filter(abaixoMinimo).length;
  const qtdSemSaldo = ativos.filter(i => i.saldo <= 0).length;

  // Leitor USB digita o código e manda Enter; o QR lido por leitor 2D chega como URL.
  function aoTeclar(e) {
    if (e.key !== "Enter") return;
    const exato = itens.find(i => i.codigo === codigoBusca);
    const alvo = exato || (filtrados.length === 1 ? filtrados[0] : null);
    if (alvo) { setBusca(""); onAbrir(alvo.id); }
  }

  const alternar = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const todosMarcados = filtrados.length > 0 && filtrados.every(i => sel.has(i.id));
  function marcarTodos() {
    setSel(s => {
      const n = new Set(s);
      filtrados.forEach(i => (todosMarcados ? n.delete(i.id) : n.add(i.id)));
      return n;
    });
  }
  function etiquetas() {
    const ids = sel.size ? itens.filter(i => sel.has(i.id)).map(i => i.id) : filtrados.map(i => i.id);
    if (!ids.length) return;
    if (!sel.size && !window.confirm(`Nenhum item marcado. Imprimir etiqueta dos ${ids.length} itens da lista?`)) return;
    onEtiquetas(ids);
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", marginRight: "auto" }}>📦 Estoque</div>
        <button onClick={() => onLancar("entrada")} style={btn(TIPOS_DOC.entrada.cor)}>＋ Entrada</button>
        <button onClick={() => onLancar("saida")} style={btn(TIPOS_DOC.saida.cor)}>− Saída</button>
        <button onClick={() => onLancar("ajuste")} style={btn(TIPOS_DOC.ajuste.cor, false)}>⚖ Ajuste</button>
        <button onClick={onNovoItem} style={btn("#1a1a1a", false)}>＋ Novo item</button>
        <button onClick={onDocumentos} style={btn("#1a1a1a", false)}>📄 Documentos</button>
        <button onClick={etiquetas} style={btn("#c9a227", false)}>🏷️ Etiquetas{sel.size ? ` (${sel.size})` : ""}</button>
        <button onClick={onExportar} disabled={exportando} style={{ ...btn("#1a1a1a", false), opacity: exportando ? 0.6 : 1 }}
          title="Baixa duas planilhas: itens com saldo e o livro completo de movimentos">
          {exportando ? "Exportando…" : "⬇ Exportar CSV"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Kpi rotulo="Itens ativos" valor={ativos.length} />
        <Kpi rotulo="Abaixo do mínimo" valor={qtdAbaixo} cor={qtdAbaixo ? "#dc2626" : "#1e293b"}
          onClick={() => setSoAbaixo(v => !v)} ativo={soAbaixo} />
        <Kpi rotulo="Sem saldo" valor={qtdSemSaldo} cor={qtdSemSaldo ? "#d97706" : "#1e293b"} />
      </div>

      <div style={{ ...card, padding: 12, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} onKeyDown={aoTeclar} autoFocus
          placeholder="🔎 Buscar ou bipar o código — nome, código, local…"
          style={{ ...inp, flex: "1 1 280px", width: "auto", fontSize: 15, padding: "10px 12px" }} />
        <select value={categoria} onChange={e => setCategoria(e.target.value)} style={{ ...inp, width: "auto" }}>
          <option value="">Todas as categorias</option>
          {CATEGORIAS_ESTOQUE.map(c => <option key={c.k} value={c.k}>{c.rotulo}</option>)}
        </select>
        <label style={{ fontSize: 12.5, color: "#475569", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={soAbaixo} onChange={e => setSoAbaixo(e.target.checked)} /> Só abaixo do mínimo
        </label>
        <label style={{ fontSize: 12.5, color: "#475569", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={verArquivados} onChange={e => setVerArquivados(e.target.checked)} /> Mostrar arquivados
        </label>
      </div>

      {itens.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: "center", color: "#64748b", fontSize: 14 }}>
          Nenhum item cadastrado ainda.<br />
          Comece por <b>＋ Novo item</b> — no cadastro dá para informar a quantidade que já está na prateleira.
        </div>
      ) : (
        <div style={{ ...card, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 34 }}><input type="checkbox" checked={todosMarcados} onChange={marcarTodos} title="Marcar todos para etiqueta" /></th>
                <th style={th}>Código</th>
                <th style={th}>Item</th>
                <th style={th}>Categoria</th>
                <th style={th}>Local</th>
                <th style={{ ...th, textAlign: "right" }}>Saldo</th>
                <th style={{ ...th, textAlign: "right" }}>Mínimo</th>
                <th style={{ ...th, textAlign: "center" }}>Lançar</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(i => {
                const baixo = abaixoMinimo(i);
                return (
                  <tr key={i.id} onClick={() => onAbrir(i.id)} style={{ cursor: "pointer", opacity: i.arquivado ? 0.55 : 1 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")} onMouseLeave={e => (e.currentTarget.style.background = "")}>
                    <td style={td} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(i.id)} onChange={() => alternar(i.id)} />
                    </td>
                    <td style={{ ...td, fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{i.codigo}</td>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {i.nome}
                      {i.arquivado && <span style={{ marginLeft: 8 }}><Chip cor="#94a3b8">arquivado</Chip></span>}
                    </td>
                    <td style={td}><Chip cor={CATEGORIA_COR[i.categoria] || "#94a3b8"}>{CATEGORIA_ROTULO[i.categoria] || i.categoria}</Chip></td>
                    <td style={{ ...td, color: "#475569" }}>{i.local || "—"}</td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", fontWeight: 800, color: baixo ? "#dc2626" : i.saldo <= 0 ? "#94a3b8" : "#1e293b" }}
                      title={baixo ? "Abaixo do estoque mínimo" : ""}>
                      {baixo && "▼ "}{fmtQtd(i.saldo)} <span style={{ fontWeight: 500, color: "#94a3b8", fontSize: 12 }}>{i.unidade}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "#94a3b8" }}>{i.estoqueMinimo ? fmtQtd(i.estoqueMinimo) : "—"}</td>
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                      {!i.arquivado && (
                        <>
                          <button onClick={() => onLancar("entrada", i)} title="Entrada" style={{ ...btnMini(TIPOS_DOC.entrada.cor), marginRight: 6 }}>＋</button>
                          <button onClick={() => onLancar("saida", i)} title="Saída" disabled={i.saldo <= 0}
                            style={{ ...btnMini(TIPOS_DOC.saida.cor), opacity: i.saldo <= 0 ? 0.35 : 1, cursor: i.saldo <= 0 ? "not-allowed" : "pointer" }}>−</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtrados.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 30 }}>Nada encontrado com esse filtro.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─── FICHA DO ITEM ───────────────────────────────────────────────────────────
function Info({ r, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>{r}</div>
      <div style={{ fontSize: 14, color: "#1e293b", fontWeight: 600 }}>{children || "—"}</div>
    </div>
  );
}

function FichaItem({ item, onVoltar, onEditar, onLancar, onEtiqueta, onAbrirDoc, onArquivar }) {
  const [movs, setMovs] = useState(null);
  const [erro, setErro] = useState("");

  // Recarrega quando o saldo muda: depois de um lançamento o App relê os itens.
  useEffect(() => {
    let cancel = false;
    setErro("");
    fetchMovimentosItem(item.id)
      .then(m => { if (!cancel) setMovs(m); })
      .catch(e => { if (!cancel) setErro(e.message); });
    return () => { cancel = true; };
  }, [item.id, item.saldo]);

  // Saldo corrido, do mais novo para o mais antigo, a partir da soma dos próprios movimentos.
  const linhas = useMemo(() => {
    if (!movs) return [];
    let s = r3(movs.reduce((acc, m) => acc + m.quantidade, 0));
    return movs.map(m => { const r = { ...m, saldoApos: s }; s = r3(s - m.quantidade); return r; });
  }, [movs]);

  const baixo = abaixoMinimo(item);
  const extras = [["Descrição", item.data.descricao], ["Acabamento / cor", item.data.acabamento], ["Cód. do fornecedor", item.data.codFornecedor], ["Observação", item.data.obs]].filter(([, v]) => v);

  return (
    <>
      <Voltar onClick={onVoltar} />
      <div style={{ ...card, padding: 20, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, color: "#64748b" }}>{item.codigo}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#1a1a1a", margin: "2px 0 8px" }}>{item.nome}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              <Chip cor={CATEGORIA_COR[item.categoria] || "#94a3b8"}>{CATEGORIA_ROTULO[item.categoria] || item.categoria}</Chip>
              {item.arquivado && <Chip cor="#94a3b8">arquivado</Chip>}
              {baixo && <Chip cor="#dc2626">abaixo do mínimo</Chip>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
              <Info r="Local">{item.local}</Info>
              <Info r="Unidade">{item.unidade}</Info>
              <Info r="Estoque mínimo">{item.estoqueMinimo ? `${fmtQtd(item.estoqueMinimo)} ${item.unidade}` : ""}</Info>
              <Info r="Última movimentação">{item.ultimaMov ? dataHoraBR(item.ultimaMov) : ""}</Info>
              {extras.map(([r, v]) => <Info key={r} r={r}>{v}</Info>)}
            </div>
          </div>
          <div style={{ textAlign: "right", minWidth: 160 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Saldo</div>
            <div style={{ fontSize: 38, fontWeight: 800, color: baixo ? "#dc2626" : "#1a1a1a", lineHeight: 1.1 }}>{fmtQtd(item.saldo)}</div>
            <div style={{ fontSize: 13, color: "#64748b" }}>{item.unidade}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 18, paddingTop: 14, borderTop: "1px solid #f1f5f9" }}>
          {!item.arquivado && (
            <>
              <button onClick={() => onLancar("entrada")} style={btn(TIPOS_DOC.entrada.cor)}>＋ Entrada</button>
              <button onClick={() => onLancar("saida")} disabled={item.saldo <= 0}
                style={{ ...btn(TIPOS_DOC.saida.cor), opacity: item.saldo <= 0 ? 0.4 : 1 }}>− Saída</button>
              <button onClick={() => onLancar("ajuste")} style={btn(TIPOS_DOC.ajuste.cor, false)}>⚖ Ajustar saldo</button>
            </>
          )}
          <button onClick={onEtiqueta} style={btn("#c9a227", false)}>🏷️ Etiqueta</button>
          <button onClick={onEditar} style={btn("#1a1a1a", false)}>✎ Editar</button>
          <button onClick={onArquivar} disabled={!item.arquivado && item.saldo !== 0}
            title={!item.arquivado && item.saldo !== 0 ? "Zere o saldo com um ajuste antes de arquivar — item arquivado com saldo é material que some da lista" : ""}
            style={{ ...btn("#64748b", false), marginLeft: "auto", opacity: !item.arquivado && item.saldo !== 0 ? 0.45 : 1 }}>
            {item.arquivado ? "Reativar" : "Arquivar"}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 8 }}>Histórico</div>
      {erro && <Faixa cor="#dc2626">Erro ao ler o histórico: {erro}</Faixa>}
      <div style={{ ...card, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={th}>Data</th>
              <th style={th}>Documento</th>
              <th style={th}>Motivo / destino</th>
              <th style={{ ...th, textAlign: "right" }}>Quantidade</th>
              <th style={{ ...th, textAlign: "right" }}>Saldo</th>
            </tr>
          </thead>
          <tbody>
            {movs === null && !erro && <tr><td colSpan={5} style={{ ...td, color: "#94a3b8", textAlign: "center" }}>Carregando…</td></tr>}
            {movs && movs.length === 0 && <tr><td colSpan={5} style={{ ...td, color: "#94a3b8", textAlign: "center", padding: 24 }}>Nenhuma movimentação ainda.</td></tr>}
            {linhas.map(m => {
              const destino = m.doc.obraRotulo || [m.doc.fornecedor, m.doc.nfNumero && `NF ${m.doc.nfNumero}`].filter(Boolean).join(" · ");
              return (
                <tr key={m.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{dataBR(m.doc.dia)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button onClick={() => onAbrirDoc(m.doc.id)} style={{ ...link, fontFamily: "monospace" }}>{numeroDoc(m.doc)}</button>
                  </td>
                  <td style={td}>
                    <Chip cor={TIPOS_DOC[m.doc.tipo]?.cor || "#94a3b8"}>{rotuloMotivo(m.doc.tipo, m.doc.motivo)}</Chip>
                    {destino && <span style={{ color: "#475569", marginLeft: 8 }}>{destino}</span>}
                    {m.doc.tipo === "estorno" && m.doc.obs && <span style={{ color: "#94a3b8", marginLeft: 8, fontStyle: "italic" }}>{m.doc.obs}</span>}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 800, whiteSpace: "nowrap", color: m.quantidade > 0 ? "#059669" : "#dc2626" }}>
                    {m.quantidade > 0 ? "+" : "−"}{fmtQtd(Math.abs(m.quantidade))}
                  </td>
                  <td style={{ ...td, textAlign: "right", color: "#475569", whiteSpace: "nowrap" }}>{fmtQtd(m.saldoApos)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── CADASTRO DO ITEM ────────────────────────────────────────────────────────
function ItemForm({ item, onSalvar, onFechar }) {
  const novo = !item.id;
  const [f, setF] = useState(() => ({
    id: item.id || null, nome: item.nome || "", categoria: item.categoria || "perfil", unidade: item.unidade || "un",
    local: item.local || "", estoqueMinimo: item.estoqueMinimo ? String(item.estoqueMinimo) : "", arquivado: !!item.arquivado,
    data: { ...(item.data || {}) }, saldoInicial: "",
  }));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const setData = (k, v) => setF(x => ({ ...x, data: { ...x.data, [k]: v } }));

  async function salvar(e) {
    e.preventDefault();
    if (!f.nome.trim()) { setErro("Informe o nome do item."); return; }
    const min = f.estoqueMinimo === "" ? 0 : num(f.estoqueMinimo);
    if (!(min >= 0)) { setErro("Estoque mínimo inválido."); return; }
    if (novo && f.saldoInicial !== "" && !(num(f.saldoInicial) >= 0)) { setErro("Quantidade inicial inválida."); return; }
    setSalvando(true); setErro("");
    try {
      await onSalvar({ ...f, estoqueMinimo: min });
    } catch (err) {
      setErro(err.message);
      setSalvando(false);
    }
  }

  const campo = { marginBottom: 12 };
  return (
    <Modal open title={novo ? "Novo item de estoque" : `Editar ${item.codigo}`} onClose={salvando ? undefined : onFechar} width={520}>
      <form onSubmit={salvar}>
        <div style={campo}>
          <label style={rotulo}>Nome *</label>
          <input autoFocus value={f.nome} onChange={e => set("nome", e.target.value)} style={inp}
            placeholder="Ex.: Perfil LG-020 Suprema 6 m — branco" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, ...campo }}>
          <div>
            <label style={rotulo}>Categoria</label>
            <select value={f.categoria} onChange={e => set("categoria", e.target.value)} style={inp}>
              {CATEGORIAS_ESTOQUE.map(c => <option key={c.k} value={c.k}>{c.rotulo}</option>)}
            </select>
          </div>
          <div>
            <label style={rotulo}>Unidade</label>
            <input value={f.unidade} onChange={e => set("unidade", e.target.value)} list="estoque-unidades" style={inp} />
            <datalist id="estoque-unidades">{UNIDADES.map(u => <option key={u} value={u} />)}</datalist>
          </div>
          <div>
            <label style={rotulo}>Local (prateleira / corredor)</label>
            <input value={f.local} onChange={e => set("local", e.target.value)} style={inp} placeholder="Ex.: Galpão A · P3" />
          </div>
          <div>
            <label style={rotulo}>Estoque mínimo</label>
            <input value={f.estoqueMinimo} onChange={e => set("estoqueMinimo", e.target.value)} inputMode="decimal" style={inp} placeholder="0 = sem alerta" />
          </div>
          <div>
            <label style={rotulo}>Acabamento / cor</label>
            <input value={f.data.acabamento || ""} onChange={e => setData("acabamento", e.target.value)} style={inp} />
          </div>
          <div>
            <label style={rotulo}>Cód. do fornecedor</label>
            <input value={f.data.codFornecedor || ""} onChange={e => setData("codFornecedor", e.target.value)} style={inp} />
          </div>
        </div>
        <div style={campo}>
          <label style={rotulo}>Descrição</label>
          <textarea value={f.data.descricao || ""} onChange={e => setData("descricao", e.target.value)} rows={2} style={{ ...inp, resize: "vertical" }} />
        </div>
        {novo && (
          <div style={{ ...campo, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: 12 }}>
            <label style={{ ...rotulo, color: "#047857" }}>Quantidade que já está no estoque (opcional)</label>
            <input value={f.saldoInicial} onChange={e => set("saldoInicial", e.target.value)} inputMode="decimal" style={{ ...inp, maxWidth: 180 }} placeholder="0" />
            <div style={{ fontSize: 11.5, color: "#047857", marginTop: 5 }}>Entra como documento de "Inventário inicial".</div>
          </div>
        )}
        {!novo && (
          <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 12 }}>
            O código <b>{item.codigo}</b> não muda — ele pode já estar numa etiqueta colada. O saldo só muda por entrada, saída ou ajuste.
          </div>
        )}
        {erro && <Faixa cor="#dc2626">{erro}</Faixa>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onFechar} disabled={salvando} style={btn("#1a1a1a", false)}>Cancelar</button>
          <button type="submit" disabled={salvando} style={{ ...btn("#10b981"), opacity: salvando ? 0.6 : 1 }}>{salvando ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── LANÇAR DOCUMENTO ────────────────────────────────────────────────────────
// preset: entrada vinda de um orçamento de Compras ({ fornecedor, nf, dia, obraRotulo, categoria, tipo }).
function LancarDocumento({ tipoInicial, itemInicialId, preset, itens, obras, equipes, fornecedores, onLancado, onCancelar }) {
  const [tipo, setTipo] = useState(tipoInicial || "saida");
  const [motivo, setMotivo] = useState(MOTIVOS[tipoInicial || "saida"][0].k);
  const [dia, setDia] = useState(preset?.dia || hojeLocal());
  const [obraId, setObraId] = useState("");
  const [equipeId, setEquipeId] = useState("");
  const [fornecedor, setFornecedor] = useState(preset?.fornecedor || "");
  const [nf, setNf] = useState(preset?.nf || "");
  const [responsavel, setResponsavel] = useState("");
  const [recebidoPor, setRecebidoPor] = useState("");
  // A obra não vai para o documento (compra não guarda obra, ver estoque_lancar) — fica na obs.
  const [obs, setObs] = useState(preset
    ? `Compra da obra ${preset.obraRotulo} — ${preset.categoria}${preset.tipo ? ": " + preset.tipo : ""}` : "");
  // qtd serve para entrada e saída; contagem, para o ajuste. Bipar de novo soma 1 no campo da vez.
  const [linhas, setLinhas] = useState(() => itemInicialId ? [{ itemId: itemInicialId, qtd: "1", contagem: "", valor: "" }] : []);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const bipRef = useRef();

  const porId = useMemo(() => new Map(itens.map(i => [i.id, i])), [itens]);
  const campo = tipo === "ajuste" ? "contagem" : "qtd";
  const precisaObra = (tipo === "saida" && motivo === "obra") || (tipo === "entrada" && motivo === "devolucao");
  const cor = TIPOS_DOC[tipo].cor;

  function trocarTipo(t) {
    setTipo(t);
    setMotivo(MOTIVOS[t][0].k);
    setErro("");
  }

  const termo = semAcento(busca.trim());
  const codigoBusca = codigoDoTexto(busca);
  const sugestoes = !termo ? [] : itens.filter(i => !i.arquivado && (i.codigo === codigoBusca
    || semAcento(`${i.codigo} ${i.nome} ${i.local}`).includes(termo))).slice(0, 8);

  function adicionar(item) {
    setLinhas(ls => ls.some(l => l.itemId === item.id)
      ? ls.map(l => l.itemId === item.id ? { ...l, [campo]: String(r3((num(l[campo]) || 0) + 1)).replace(".", ",") } : l)
      : [...ls, { itemId: item.id, qtd: "", contagem: "", valor: "", [campo]: "1" }]);
    setBusca("");
    setErro("");
    bipRef.current?.focus();
  }
  function aoTeclar(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const exato = itens.find(i => i.codigo === codigoBusca);
    if (exato) {
      if (exato.arquivado) { setErro(`${exato.codigo} está arquivado — reative na ficha do item.`); setBusca(""); return; }
      adicionar(exato);
    } else if (sugestoes.length === 1) adicionar(sugestoes[0]);
    else if (termo) setErro(`Nenhum item com o código "${codigoBusca}".`);
  }
  const setLinha = (itemId, k, v) => setLinhas(ls => ls.map(l => l.itemId === itemId ? { ...l, [k]: v } : l));
  const remover = itemId => setLinhas(ls => ls.filter(l => l.itemId !== itemId));

  // Cálculo por linha: o que tem, o que fica. A trava de verdade é no banco; aqui é para avisar antes.
  const calc = linhas.map(l => {
    const item = porId.get(l.itemId);
    const saldo = item?.saldo || 0;
    if (tipo === "ajuste") {
      const c = num(l.contagem);
      const ok = c >= 0;
      return { l, item, saldo, ok, depois: ok ? c : null, delta: ok ? r3(c - saldo) : null };
    }
    const q = num(l.qtd);
    const ok = q > 0;
    const depois = ok ? r3(tipo === "saida" ? saldo - q : saldo + q) : null;
    return { l, item, saldo, ok, depois, delta: ok ? (tipo === "saida" ? -q : q) : null, falta: ok && depois < 0 };
  });

  let problema = "";
  if (!linhas.length) problema = "Bipe ou busque ao menos um item.";
  else if (calc.some(c => !c.item)) problema = "Há um item que não existe mais na lista.";
  else if (calc.some(c => !c.ok)) problema = tipo === "ajuste" ? "Informe a contagem de todos os itens." : "Informe a quantidade de todos os itens.";
  else if (calc.some(c => c.falta)) problema = "Há item com saída maior que o saldo.";
  else if (tipo === "ajuste" && calc.every(c => c.delta === 0)) problema = "A contagem bate com o saldo em todos os itens — nada a ajustar.";
  else if (precisaObra && !obraId) problema = "Escolha a obra.";
  else if (tipo === "ajuste" && !obs.trim()) problema = "Ajuste precisa de justificativa.";

  async function lancar() {
    if (problema || enviando) return;
    const destino = precisaObra ? ` para ${rotuloObra(obras.find(o => o.id === obraId) || { numero: obraId })}` : "";
    if (!window.confirm(`Lançar ${TIPOS_DOC[tipo].rotulo.toUpperCase()} de ${linhas.length} item(ns)${destino}?\n\nDepois de lançado, o documento não se edita nem se apaga — correção é por estorno.`)) return;
    setEnviando(true); setErro("");
    try {
      const cab = {
        tipo, motivo, dia, obra_id: precisaObra ? obraId : null,
        equipe_id: tipo === "saida" && motivo === "obra" ? equipeId || null : null,
        fornecedor: tipo === "entrada" ? fornecedor : "", nf_numero: tipo === "entrada" ? nf : "",
        responsavel, recebido_por: tipo === "ajuste" ? "" : recebidoPor, obs,
      };
      const ls = linhas.map(l => tipo === "ajuste"
        ? { item_id: l.itemId, contagem: num(l.contagem) }
        : { item_id: l.itemId, quantidade: num(l.qtd), valor_unitario: tipo === "entrada" && num(l.valor) >= 0 ? num(l.valor) : null });
      const doc = await lancarDocumentoEstoque(cab, ls);
      await onLancado(doc);
    } catch (e) {
      setErro(e.message);
      setEnviando(false);
    }
  }

  function cancelar() {
    if (linhas.length && !window.confirm("Descartar este lançamento? Nada foi gravado ainda.")) return;
    onCancelar();
  }

  const lblResp = { saida: "Entregue por", entrada: "Recebido por (estoque)", ajuste: "Contado por" }[tipo];
  const lblReceb = { saida: "Retirado por", entrada: "Entregue por (fornecedor / motorista)" }[tipo];

  return (
    <>
      <Voltar onClick={cancelar}>← Cancelar</Voltar>
      {preset && (
        <Faixa cor="#7c3aed">
          Entrada da compra de <b>{preset.fornecedor || "fornecedor sem nome"}</b>{preset.nf ? ` · NF ${preset.nf}` : ""} — obra {preset.obraRotulo},
          {" "}{preset.categoria}{preset.tipo ? `: ${preset.tipo}` : ""}.
          {" "}Bipe ou busque o item de estoque que chegou e informe a quantidade. Ao lançar, o orçamento fica marcado com o nº do documento.
        </Faixa>
      )}
      <div style={{ ...card, padding: 18, marginBottom: 14, borderTop: `4px solid ${cor}` }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {["entrada", "saida", "ajuste"].map(t => (
            <button key={t} onClick={() => trocarTipo(t)}
              style={{ ...btn(TIPOS_DOC[t].cor, tipo === t), padding: "8px 18px" }}>
              {t === "entrada" ? "＋ " : t === "saida" ? "− " : "⚖ "}{TIPOS_DOC[t].rotulo}
            </button>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
          <div>
            <label style={rotulo}>Motivo</label>
            <select value={motivo} onChange={e => setMotivo(e.target.value)} style={inp}>
              {MOTIVOS[tipo].map(m => <option key={m.k} value={m.k}>{m.rotulo}</option>)}
            </select>
          </div>
          <div>
            <label style={rotulo}>Data</label>
            <input type="date" value={dia} onChange={e => setDia(e.target.value)} style={inp} />
          </div>
          {precisaObra && (
            <div style={{ gridColumn: "span 2", minWidth: 0 }}>
              <label style={rotulo}>{tipo === "saida" ? "Obra de destino *" : "Obra de onde voltou *"}</label>
              <select value={obraId} onChange={e => setObraId(e.target.value)} style={{ ...inp, borderColor: obraId ? "#cbd5e1" : cor }}>
                <option value="">— escolha o contrato —</option>
                {obrasOrdenadas(obras).map(o => <option key={o.id} value={o.id}>{rotuloObra(o)}{concluida(o) ? " (concluída)" : ""}</option>)}
              </select>
            </div>
          )}
          {tipo === "saida" && motivo === "obra" && (
            <div>
              <label style={rotulo}>Equipe</label>
              <select value={equipeId} onChange={e => setEquipeId(e.target.value)} style={inp}>
                <option value="">—</option>
                {equipes.filter(e => !e.arquivada).map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            </div>
          )}
          {tipo === "entrada" && motivo === "compra" && (
            <>
              <div>
                <label style={rotulo}>Fornecedor</label>
                <input value={fornecedor} onChange={e => setFornecedor(e.target.value)} list="estoque-fornecedores" style={inp} />
                <datalist id="estoque-fornecedores">{fornecedores.map(n => <option key={n} value={n} />)}</datalist>
              </div>
              <div>
                <label style={rotulo}>Nº da NF</label>
                <input value={nf} onChange={e => setNf(e.target.value)} style={inp} />
              </div>
            </>
          )}
          <div>
            <label style={rotulo}>{lblResp}</label>
            <input value={responsavel} onChange={e => setResponsavel(e.target.value)} style={inp} />
          </div>
          {tipo !== "ajuste" && (
            <div>
              <label style={rotulo}>{lblReceb}</label>
              <input value={recebidoPor} onChange={e => setRecebidoPor(e.target.value)} style={inp} />
            </div>
          )}
        </div>
      </div>

      <div style={{ ...card, padding: 18, marginBottom: 14 }}>
        <div style={{ position: "relative", marginBottom: 12 }}>
          <input ref={bipRef} value={busca} onChange={e => { setBusca(e.target.value); setErro(""); }} onKeyDown={aoTeclar} autoFocus
            placeholder="🔎 Bipe o código ou digite para buscar o item — Enter adiciona"
            style={{ ...inp, fontSize: 15, padding: "11px 12px", borderColor: cor }} />
          {sugestoes.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", marginTop: 4, overflow: "hidden" }}>
              {sugestoes.map(i => (
                <button key={i.id} onClick={() => adicionar(i)}
                  style={{ display: "flex", width: "100%", gap: 10, alignItems: "center", textAlign: "left", background: "#fff", border: "none", borderBottom: "1px solid #f1f5f9", padding: "9px 12px", cursor: "pointer", fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")} onMouseLeave={e => (e.currentTarget.style.background = "#fff")}>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#64748b" }}>{i.codigo}</span>
                  <span style={{ flex: 1, fontWeight: 600, color: "#1e293b" }}>{i.nome}</span>
                  <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>saldo {fmtQtd(i.saldo)} {i.unidade}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead>
              <tr>
                <th style={th}>Código</th>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: "right" }}>Saldo atual</th>
                <th style={{ ...th, textAlign: "right" }}>{tipo === "ajuste" ? "Contado" : "Quantidade"}</th>
                {tipo === "entrada" && <th style={{ ...th, textAlign: "right" }}>Valor unit. (R$)</th>}
                <th style={{ ...th, textAlign: "right" }}>{tipo === "ajuste" ? "Diferença" : "Fica"}</th>
                <th style={{ ...th, width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {calc.map(({ l, item, saldo, ok, depois, delta, falta }) => (
                <tr key={l.itemId} style={{ background: falta ? "#fef2f2" : undefined }}>
                  <td style={{ ...td, fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{item?.codigo || "?"}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{item?.nome || "Item removido"}</td>
                  <td style={{ ...td, textAlign: "right", color: "#475569", whiteSpace: "nowrap" }}>{fmtQtd(saldo)} {item?.unidade}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <input value={l[campo]} onChange={e => setLinha(l.itemId, campo, e.target.value)} inputMode="decimal"
                      style={{ ...inp, width: 90, textAlign: "right", fontWeight: 700, borderColor: ok ? "#cbd5e1" : "#f59e0b" }} />
                  </td>
                  {tipo === "entrada" && (
                    <td style={{ ...td, textAlign: "right" }}>
                      <Oculto prefixo="">
                        <input value={l.valor} onChange={e => setLinha(l.itemId, "valor", e.target.value)} inputMode="decimal" placeholder="opcional"
                          style={{ ...inp, width: 100, textAlign: "right" }} />
                      </Oculto>
                    </td>
                  )}
                  <td style={{ ...td, textAlign: "right", fontWeight: 800, whiteSpace: "nowrap", color: falta ? "#dc2626" : tipo === "ajuste" ? (delta > 0 ? "#059669" : delta < 0 ? "#dc2626" : "#94a3b8") : "#1e293b" }}>
                    {!ok ? "—" : tipo === "ajuste" ? `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${fmtQtd(Math.abs(delta))}` : fmtQtd(depois)}
                    {falta && <div style={{ fontSize: 11, fontWeight: 700 }}>saldo insuficiente</div>}
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <button onClick={() => remover(l.itemId)} title="Tirar da lista" style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer" }}>×</button>
                  </td>
                </tr>
              ))}
              {!linhas.length && (
                <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "#94a3b8", padding: 26 }}>Nenhum item ainda. Bipe a etiqueta ou busque pelo nome.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={rotulo}>{tipo === "ajuste" ? "Justificativa *" : "Observação"}</label>
          <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} style={{ ...inp, resize: "vertical" }}
            placeholder={tipo === "ajuste" ? "Ex.: contagem física de 13/09 — 2 barras amassadas descartadas" : ""} />
        </div>
      </div>

      {erro && <Faixa cor="#dc2626">{erro}</Faixa>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
        {problema && <span style={{ fontSize: 12.5, color: "#94a3b8", marginRight: "auto" }}>{problema}</span>}
        <button onClick={cancelar} style={btn("#1a1a1a", false)}>Cancelar</button>
        <button onClick={lancar} disabled={!!problema || enviando}
          style={{ ...btn(cor), padding: "10px 22px", fontSize: 14, opacity: problema || enviando ? 0.45 : 1, cursor: problema || enviando ? "not-allowed" : "pointer" }}>
          {enviando ? "Lançando…" : `Lançar ${TIPOS_DOC[tipo].rotulo.toLowerCase()} e imprimir`}
        </button>
      </div>
    </>
  );
}

// ─── DOCUMENTOS ──────────────────────────────────────────────────────────────
function ListaDocumentos({ onVoltar, onAbrirDoc, onEstornado }) {
  const [inicio, setInicio] = useState(primeiroDoMes());
  const [fim, setFim] = useState(hojeLocal());
  const [tipo, setTipo] = useState("");
  const [busca, setBusca] = useState("");
  const [docs, setDocs] = useState(null);
  const [erro, setErro] = useState("");
  const [recarga, setRecarga] = useState(0);
  const [estornando, setEstornando] = useState(null);
  const [motivoEst, setMotivoEst] = useState("");
  const [respEst, setRespEst] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erroEst, setErroEst] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    let cancel = false;
    setDocs(null); setErro("");
    fetchDocumentosEstoque({ inicio, fim })
      .then(d => { if (!cancel) setDocs(d); })
      .catch(e => { if (!cancel) setErro(e.message); });
    return () => { cancel = true; };
  }, [inicio, fim, recarga]);

  const termo = semAcento(busca.trim());
  const lista = (docs || []).filter(d => (!tipo || d.tipo === tipo)
    && (!termo || semAcento([numeroDoc(d), d.obraRotulo, d.fornecedor, d.nfNumero, d.responsavel, d.recebidoPor, d.obs].join(" ")).includes(termo)));

  async function confirmarEstorno() {
    if (!motivoEst.trim()) { setErroEst("Informe o motivo."); return; }
    setEnviando(true); setErroEst("");
    try {
      const novo = await estornarDocumentoEstoque(estornando.id, motivoEst.trim(), respEst.trim());
      setOk(`${numeroDoc(estornando)} estornado pelo ${numeroDoc(novo)}.`);
      setEstornando(null);
      await onEstornado();
      setRecarga(x => x + 1);
    } catch (e) {
      setErroEst(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <Voltar onClick={onVoltar} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", marginRight: "auto" }}>📄 Documentos de estoque</div>
      </div>
      <div style={{ ...card, padding: 12, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div><label style={rotulo}>De</label><input type="date" value={inicio} onChange={e => setInicio(e.target.value)} style={{ ...inp, width: "auto" }} /></div>
        <div><label style={rotulo}>Até</label><input type="date" value={fim} onChange={e => setFim(e.target.value)} style={{ ...inp, width: "auto" }} /></div>
        <div>
          <label style={rotulo}>Tipo</label>
          <select value={tipo} onChange={e => setTipo(e.target.value)} style={{ ...inp, width: "auto" }}>
            <option value="">Todos</option>
            {Object.entries(TIPOS_DOC).map(([k, t]) => <option key={k} value={k}>{t.rotulo}</option>)}
          </select>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          <label style={rotulo}>Buscar</label>
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Nº, obra, fornecedor, NF, pessoa…" style={inp} />
        </div>
      </div>
      {ok && <Faixa cor="#059669" onFechar={() => setOk("")}>{ok}</Faixa>}
      {erro && <Faixa cor="#dc2626">Erro ao ler os documentos: {erro}</Faixa>}
      <div style={{ ...card, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr>
              <th style={th}>Nº</th>
              <th style={th}>Data</th>
              <th style={th}>Tipo</th>
              <th style={th}>Motivo</th>
              <th style={th}>Obra / fornecedor</th>
              <th style={{ ...th, textAlign: "right" }}>Itens</th>
              <th style={th}>Situação</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {docs === null && !erro && <tr><td colSpan={8} style={{ ...td, color: "#94a3b8", textAlign: "center" }}>Carregando…</td></tr>}
            {docs && lista.length === 0 && <tr><td colSpan={8} style={{ ...td, color: "#94a3b8", textAlign: "center", padding: 26 }}>Nenhum documento neste período.</td></tr>}
            {lista.map(d => (
              <tr key={d.id} style={{ opacity: d.estornadoPor ? 0.6 : 1 }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button onClick={() => onAbrirDoc(d.id)} style={{ ...link, fontFamily: "monospace" }}>{numeroDoc(d)}</button>
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{dataBR(d.dia)}</td>
                <td style={td}><Chip cor={TIPOS_DOC[d.tipo]?.cor || "#94a3b8"}>{TIPOS_DOC[d.tipo]?.rotulo || d.tipo}</Chip></td>
                <td style={td}>{d.tipo === "estorno" ? <i style={{ color: "#64748b" }}>{d.obs}</i> : rotuloMotivo(d.tipo, d.motivo)}</td>
                <td style={{ ...td, color: "#475569" }}>{d.obraRotulo || [d.fornecedor, d.nfNumero && `NF ${d.nfNumero}`].filter(Boolean).join(" · ") || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{d.qtdItens}</td>
                <td style={{ ...td, fontSize: 12 }}>
                  {d.estornadoPor && <span style={{ color: "#dc2626", fontWeight: 700 }}>Estornado por {numeroDoc(d.estornadoPor)}</span>}
                  {d.estornaDe && <span style={{ color: "#64748b" }}>Estorna {numeroDoc(d.estornaDe)}</span>}
                </td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button onClick={() => onAbrirDoc(d.id)} style={{ ...btn("#1a1a1a", false), padding: "4px 10px", fontSize: 12 }}>🖨️ Abrir</button>
                  {d.tipo !== "estorno" && !d.estornadoPor && (
                    <button onClick={() => { setEstornando(d); setMotivoEst(""); setRespEst(""); setErroEst(""); }}
                      style={{ ...btn("#dc2626", false), padding: "4px 10px", fontSize: 12, marginLeft: 6 }}>Estornar</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!estornando} title={estornando ? `Estornar ${numeroDoc(estornando)}` : ""} onClose={enviando ? undefined : () => setEstornando(null)} width={440}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.5 }}>
          Gera um documento de estorno com as quantidades invertidas. O original continua no histórico, marcado como estornado.
        </div>
        <label style={rotulo}>Motivo *</label>
        <textarea autoFocus value={motivoEst} onChange={e => setMotivoEst(e.target.value)} rows={2} style={{ ...inp, resize: "vertical", marginBottom: 10 }}
          placeholder="Ex.: lançado na obra errada" />
        <label style={rotulo}>Responsável</label>
        <input value={respEst} onChange={e => setRespEst(e.target.value)} style={{ ...inp, marginBottom: 12 }} />
        {erroEst && <Faixa cor="#dc2626">{erroEst}</Faixa>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setEstornando(null)} disabled={enviando} style={btn("#1a1a1a", false)}>Cancelar</button>
          <button onClick={confirmarEstorno} disabled={enviando} style={{ ...btn("#dc2626"), opacity: enviando ? 0.6 : 1 }}>{enviando ? "Estornando…" : "Estornar"}</button>
        </div>
      </Modal>
    </>
  );
}

// ─── BLOCO NA TELA DA OBRA ───────────────────────────────────────────────────
// O que saiu do estoque para esta obra, líquido das devoluções e estornos. Só leitura:
// lançar é sempre pela tela de Estoque, para o documento nascer com número e conferência.
export function SaidasEstoqueObra({ obraId, onAbrirDoc }) {
  const [movs, setMovs] = useState(undefined);
  useEffect(() => {
    let cancel = false;
    fetchMovimentosObra(obraId).then(m => { if (!cancel) setMovs(m); });
    return () => { cancel = true; };
  }, [obraId]);

  if (!movs) return null; // carregando, ou tabela ainda não existe

  const porItem = new Map();
  for (const m of movs) {
    const a = porItem.get(m.itemId) || { codigo: m.codigo, nome: m.nome, unidade: m.unidade, consumo: 0 };
    a.consumo = r3(a.consumo - m.quantidade); // saída é negativa no livro; aqui vira consumo positivo
    porItem.set(m.itemId, a);
  }
  const itens = [...porItem.values()].filter(a => a.consumo !== 0);
  const docs = [...new Map(movs.map(m => [m.doc.id, m.doc])).values()].sort((a, b) => a.numero - b.numero);

  return (
    <div style={{ marginTop: 14, border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", background: "#fafafa" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>📦 Saiu do estoque para esta obra</div>
      {movs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Nenhuma retirada do estoque lançada para este contrato.</div>
      ) : (
        <>
          {itens.length === 0 && <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Tudo o que saiu voltou ou foi estornado.</div>}
          {itens.map(a => (
            <div key={a.codigo} style={{ display: "flex", gap: 10, fontSize: 13, padding: "2px 0" }}>
              <span style={{ fontFamily: "monospace", color: "#64748b", fontWeight: 700 }}>{a.codigo}</span>
              <span style={{ flex: 1, color: "#1e293b" }}>{a.nome}</span>
              <span style={{ fontWeight: 800, color: a.consumo < 0 ? "#059669" : "#1e293b", whiteSpace: "nowrap" }}>{fmtQtd(a.consumo)} {a.unidade}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {docs.map(d => (
              <button key={d.id} onClick={() => onAbrirDoc(d.id)} title={dataBR(d.dia)}
                style={{ ...btnMini(TIPOS_DOC[d.tipo]?.cor || "#64748b"), fontSize: 11, fontFamily: "monospace" }}>{numeroDoc(d)}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── IMPRESSÃO: DOCUMENTO ────────────────────────────────────────────────────
const TITULO_DOC = { entrada: "ENTRADA DE ESTOQUE", saida: "SAÍDA DE ESTOQUE", ajuste: "AJUSTE DE INVENTÁRIO", estorno: "ESTORNO DE ESTOQUE" };
const ASSINATURAS = {
  saida: ["Entregue por (estoque)", "Retirado por", "Conferido"],
  entrada: ["Recebido por (estoque)", "Entregue por", "Conferido"],
  ajuste: ["Contado por", "Aprovado por"],
  estorno: ["Responsável", "Aprovado por"],
};
const VIAS = { saida: ["Estoque", "Retirante / obra"], entrada: ["Estoque", "Financeiro"], ajuste: ["Estoque", "Escritório"], estorno: ["Estoque", "Escritório"] };

export function EstoqueDocumentoPrint({ docId, equipes, onBack }) {
  const { visivel: valoresVisiveis } = useSigilo();
  const [doc, setDoc] = useState(null);
  const [erro, setErro] = useState("");
  const [vias, setVias] = useState(1);

  useEffect(() => {
    let cancel = false;
    fetchDocumentoEstoque(docId).then(d => { if (!cancel) setDoc(d); }).catch(e => { if (!cancel) setErro(e.message); });
    return () => { cancel = true; };
  }, [docId]);

  const barra = (
    <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
      <button onClick={onBack} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Voltar</button>
      {doc && <span style={{ fontSize: 13, color: "#059669", fontWeight: 700 }}>{numeroDoc(doc)} gravado.</span>}
      <label style={{ fontSize: 12.5, color: "#475569", display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
        <input type="checkbox" checked={vias === 2} onChange={e => setVias(e.target.checked ? 2 : 1)} /> Imprimir 2 vias
      </label>
      <button onClick={() => window.print()} disabled={!doc} style={{ background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🖨️ Imprimir</button>
    </div>
  );

  if (erro || !doc) {
    return (
      <div style={{ background: "#fff", minHeight: "100vh", padding: "20px 24px" }}>
        {barra}
        <div style={{ textAlign: "center", padding: 60, color: erro ? "#dc2626" : "#94a3b8", fontSize: 14 }}>{erro || "Carregando documento…"}</div>
      </div>
    );
  }

  const thP = { padding: "6px 8px", fontSize: 10, fontWeight: 800, textAlign: "left", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "2px solid #1a1a1a", whiteSpace: "nowrap" };
  const tdP = { padding: "6px 8px", fontSize: 11.5, borderBottom: "1px solid #e2e8f0", verticalAlign: "top" };
  // Com os valores ocultos a folha sai sem as colunas de valor, em vez de imprimir a máscara.
  const comValor = valoresVisiveis && doc.tipo === "entrada" && doc.linhas.some(l => l.valorUnitario != null);
  const comSinal = doc.tipo === "ajuste" || doc.tipo === "estorno";
  const total = comValor ? doc.linhas.reduce((s, l) => s + (l.valorUnitario || 0) * Math.abs(l.quantidade), 0) : 0;
  const campos = [
    ["Data", dataBR(doc.dia)],
    ["Motivo", doc.tipo === "estorno" ? `Estorno de ${numeroDoc(doc.estornaDe) || "—"}` : rotuloMotivo(doc.tipo, doc.motivo)],
    doc.obraRotulo && ["Obra", doc.obraRotulo],
    doc.equipeId && ["Equipe", nomeEquipe(equipes, doc.equipeId) || "—"],
    doc.fornecedor && ["Fornecedor", doc.fornecedor],
    doc.nfNumero && ["Nota fiscal", doc.nfNumero],
    doc.responsavel && [{ saida: "Entregue por", entrada: "Recebido por", ajuste: "Contado por" }[doc.tipo] || "Responsável", doc.responsavel],
    doc.recebidoPor && [{ saida: "Retirado por", entrada: "Entregue por" }[doc.tipo] || "Recebido por", doc.recebidoPor],
  ].filter(Boolean);

  const folha = via => (
    <div key={via} style={{ pageBreakBefore: via > 1 ? "always" : "auto", marginBottom: 40, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, borderBottom: "2px solid #1a1a1a", paddingBottom: 10, marginBottom: 10 }}>
        <img src={logoDark} alt="Centauro" style={{ height: 38 }} />
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1, color: "#1a1a1a" }}>{TITULO_DOC[doc.tipo]}</div>
          {vias === 2 && <div style={{ fontSize: 10.5, color: "#475569", fontWeight: 700 }}>{via}ª via — {VIAS[doc.tipo][via - 1]}</div>}
        </div>
        <div style={{ border: "2px solid #1a1a1a", borderRadius: 6, padding: "4px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: "#475569" }}>Nº</div>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "monospace" }}>{numeroDoc(doc)}</div>
        </div>
      </div>

      {doc.estornadoPor && (
        <div style={{ border: "2px solid #dc2626", color: "#dc2626", borderRadius: 6, padding: "6px 12px", fontWeight: 800, fontSize: 12.5, textAlign: "center", marginBottom: 10 }}>
          ESTORNADO — anulado pelo documento {numeroDoc(doc.estornadoPor)} em {dataBR(doc.estornadoPor.dia)}{doc.estornadoPor.obs ? ` · ${doc.estornadoPor.obs}` : ""}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "6px 16px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
        {campos.map(([r, v]) => (
          <div key={r} style={{ fontSize: 11.5 }}>
            <span style={{ fontWeight: 800, color: "#475569", textTransform: "uppercase", fontSize: 9.5, letterSpacing: 0.3 }}>{r}: </span>
            <span style={{ fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...thP, width: 28 }}>#</th>
            <th style={thP}>Código</th>
            <th style={thP}>Item</th>
            <th style={thP}>Unid.</th>
            <th style={{ ...thP, textAlign: "right" }}>{comSinal ? "Movimento" : "Quantidade"}</th>
            {comValor && <th style={{ ...thP, textAlign: "right" }}>Valor unit.</th>}
            {comValor && <th style={{ ...thP, textAlign: "right" }}>Total</th>}
          </tr>
        </thead>
        <tbody>
          {doc.linhas.map((l, i) => (
            <tr key={l.id} style={{ pageBreakInside: "avoid" }}>
              <td style={{ ...tdP, color: "#94a3b8" }}>{i + 1}</td>
              <td style={{ ...tdP, fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{l.codigo}</td>
              <td style={{ ...tdP, fontWeight: 600 }}>{l.nome}</td>
              <td style={tdP}>{l.unidade}</td>
              <td style={{ ...tdP, textAlign: "right", fontWeight: 800, whiteSpace: "nowrap" }}>
                {comSinal ? `${l.quantidade > 0 ? "+" : "−"}${fmtQtd(Math.abs(l.quantidade))}` : fmtQtd(Math.abs(l.quantidade))}
              </td>
              {comValor && <td style={{ ...tdP, textAlign: "right", whiteSpace: "nowrap" }}>{l.valorUnitario != null ? fmtMoeda(l.valorUnitario) : "—"}</td>}
              {comValor && <td style={{ ...tdP, textAlign: "right", whiteSpace: "nowrap" }}>{l.valorUnitario != null ? fmtMoeda(l.valorUnitario * Math.abs(l.quantidade)) : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, fontWeight: 700, marginTop: 6 }}>
        <span>{doc.linhas.length} item(ns)</span>
        {comValor && <span>Total: {fmtMoeda(total)}</span>}
      </div>

      {doc.obs && (
        <div style={{ marginTop: 12, fontSize: 11.5, border: "1px solid #e2e8f0", borderRadius: 6, padding: "7px 10px" }}>
          <b style={{ fontSize: 9.5, textTransform: "uppercase", color: "#475569" }}>{doc.tipo === "ajuste" ? "Justificativa" : doc.tipo === "estorno" ? "Motivo do estorno" : "Observação"}: </b>{doc.obs}
        </div>
      )}

      <div style={{ display: "flex", gap: 30, marginTop: 48, flexWrap: "wrap" }}>
        {ASSINATURAS[doc.tipo].map(t => (
          <div key={t} style={{ flex: 1, minWidth: 170, textAlign: "center" }}>
            <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 5, fontSize: 10.5, color: "#475569" }}>{t}</div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center", fontSize: 9.5, color: "#94a3b8", marginTop: 14 }}>
        CENTAURO — Controle de Estoque | {numeroDoc(doc)} lançado em {dataHoraBR(doc.createdAt)} | Documento gerado pelo sistema
      </div>
    </div>
  );

  return (
    <div style={{ background: "#fff", minHeight: "100vh", padding: "20px 24px" }}>
      {barra}
      {Array.from({ length: vias }, (_, i) => folha(i + 1))}
    </div>
  );
}

// ─── IMPRESSÃO: ETIQUETAS ────────────────────────────────────────────────────
// Medidas em mm. margem = [topo, esquerda] até a primeira etiqueta; passo = [horizontal, vertical]
// de uma etiqueta à próxima (inclui o vão). Impressora e folha variam alguns décimos: por isso o
// deslocamento X/Y, que fica salvo neste navegador por formato.
const FORMATOS_ETIQUETA = {
  a4260: { rotulo: "A4 · Pimaco A4260 — 3×7 (63,5 × 38,1 mm)", pagina: [210, 297], cols: 3, rows: 7, w: 63.5, h: 38.1, margem: [15.15, 7.25], passo: [66.04, 38.1] },
  a4262: { rotulo: "A4 · Pimaco A4262 — 2×8 (99,1 × 33,9 mm)", pagina: [210, 297], cols: 2, rows: 8, w: 99.1, h: 33.9, margem: [12.9, 4.65], passo: [101.6, 33.9] },
  c6180: { rotulo: "Carta · Pimaco 6180 — 3×10 (66,7 × 25,4 mm)", pagina: [215.9, 279.4], cols: 3, rows: 10, w: 66.7, h: 25.4, margem: [12.7, 4.8], passo: [69.85, 25.4] },
  t5030: { rotulo: "Térmica — 50 × 30 mm (uma por página)", pagina: [50, 30], cols: 1, rows: 1, w: 50, h: 30, margem: [0, 0], passo: [50, 30] },
  t6040: { rotulo: "Térmica — 60 × 40 mm (uma por página)", pagina: [60, 40], cols: 1, rows: 1, w: 60, h: 40, margem: [0, 0], passo: [60, 40] },
};

function lerPref(chave, padrao) {
  try { const v = localStorage.getItem(chave); return v == null ? padrao : JSON.parse(v); } catch { return padrao; }
}
function gravarPref(chave, v) {
  try { localStorage.setItem(chave, JSON.stringify(v)); } catch { /* navegador sem storage: só não lembra */ }
}

// O jsbarcode desenha com width/height em px; troca por viewBox para a etiqueta esticar o SVG
// na largura que tiver. Esticar na horizontal não atrapalha a leitura: todas as barras crescem juntas.
function svgEscalavel(svg) {
  const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
  if (!svg.getAttribute("viewBox") && w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.removeAttribute("width"); svg.removeAttribute("height"); svg.removeAttribute("style");
  svg.setAttribute("preserveAspectRatio", "none");
  return svg.outerHTML;
}

async function gerarCodigos(itens) {
  // Carregadas só aqui: ninguém que não imprime etiqueta paga o peso das duas libs.
  const [{ default: QRCode }, { default: JsBarcode }] = await Promise.all([import("qrcode"), import("jsbarcode")]);
  const out = {};
  for (const it of itens) {
    const qr = await QRCode.toString(URL_ITEM + encodeURIComponent(it.codigo), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // Zona de silêncio de ~10 módulos dos dois lados: sem ela o leitor não acha o começo do código.
    JsBarcode(svg, it.codigo, { format: "CODE128", displayValue: false, width: 2, height: 60, margin: 0, marginLeft: 20, marginRight: 20 });
    out[it.id] = { qr, barras: svgEscalavel(svg) };
  }
  return out;
}

function Etiqueta({ item, g, w, h }) {
  const pad = Math.min(2, h * 0.07);
  const fs = Math.max(2.2, Math.min(3.6, h * 0.095));
  const deitada = w / h >= 2; // larga e baixa: QR à esquerda, código de barras à direita
  const nome = (
    <div style={{ fontSize: fs + "mm", fontWeight: 800, lineHeight: 1.12, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", wordBreak: "break-word" }}>{item.nome}</div>
  );
  const codigo = <div style={{ fontSize: fs * 1.05 + "mm", fontWeight: 800, fontFamily: "Consolas, monospace", lineHeight: 1.2 }}>{item.codigo}</div>;
  const local = item.local ? <div style={{ fontSize: fs * 0.82 + "mm", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Local: {item.local}</div> : null;
  const base = { position: "absolute", inset: 0, padding: pad + "mm", boxSizing: "border-box", fontFamily: "Arial, Helvetica, sans-serif", color: "#000", overflow: "hidden", display: "flex" };

  if (deitada) {
    const qr = h - 2 * pad;
    return (
      <div style={{ ...base, gap: pad + "mm" }}>
        <div className="etq-svg" style={{ width: qr + "mm", height: qr + "mm", flex: "none" }} dangerouslySetInnerHTML={{ __html: g.qr }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>{nome}{codigo}{local}</div>
          <div className="etq-svg" style={{ height: h * 0.27 + "mm" }} dangerouslySetInnerHTML={{ __html: g.barras }} />
        </div>
      </div>
    );
  }
  // Compacta (quase quadrada): QR e texto em cima, código de barras na largura inteira embaixo —
  // espremido ao lado do QR ele ficaria fino demais para a térmica de 203 dpi imprimir.
  const barH = h * 0.24;
  const qr = h - 2 * pad - barH - pad;
  return (
    <div style={{ ...base, flexDirection: "column", gap: pad + "mm" }}>
      <div style={{ display: "flex", gap: pad + "mm", height: qr + "mm" }}>
        <div className="etq-svg" style={{ width: qr + "mm", height: qr + "mm", flex: "none" }} dangerouslySetInnerHTML={{ __html: g.qr }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>{nome}{codigo}{local}</div>
      </div>
      <div className="etq-svg" style={{ height: barH + "mm" }} dangerouslySetInnerHTML={{ __html: g.barras }} />
    </div>
  );
}

export function EtiquetasPrint({ itens, itemIds, onBack }) {
  const [formato, setFormato] = useState(() => {
    const f = lerPref("estoque.etiqueta.formato", "a4260");
    return FORMATOS_ETIQUETA[f] ? f : "a4260";
  });
  const [copias, setCopias] = useState(1);
  const [posicao, setPosicao] = useState(1);
  const [desloc, setDesloc] = useState(() => lerPref("estoque.etiqueta.desloc." + formato, [0, 0]));
  const [codigos, setCodigos] = useState(null);
  const [erro, setErro] = useState("");

  const lista = useMemo(() => itemIds.map(id => itens.find(i => i.id === id)).filter(Boolean), [itens, itemIds]);
  const F = FORMATOS_ETIQUETA[formato];
  const porFolha = F.cols * F.rows;
  const folhaInteira = porFolha > 1;

  useEffect(() => {
    let cancel = false;
    gerarCodigos(lista).then(c => { if (!cancel) setCodigos(c); }).catch(e => { if (!cancel) setErro(e.message); });
    return () => { cancel = true; };
  }, [lista]);

  function trocarFormato(f) {
    setFormato(f); gravarPref("estoque.etiqueta.formato", f);
    setDesloc(lerPref("estoque.etiqueta.desloc." + f, [0, 0]));
    setPosicao(1);
  }
  function mudarDesloc(i, v) {
    const n = [...desloc]; n[i] = Number(v) || 0;
    setDesloc(n); gravarPref("estoque.etiqueta.desloc." + formato, n);
  }

  // Posições vazias no começo reaproveitam uma folha já usada pela metade.
  const vagas = folhaInteira ? Math.min(Math.max(1, posicao), porFolha) - 1 : 0;
  const slots = [...Array(vagas).fill(null), ...lista.flatMap(it => Array(Math.max(1, copias)).fill(it))];
  const folhas = [];
  for (let i = 0; i < slots.length; i += porFolha) folhas.push(slots.slice(i, i + porFolha));
  const [pw, ph] = F.pagina;

  const inpMini = { ...inp, width: 72, padding: "5px 8px" };
  return (
    <div className="etq-previa" style={{ background: "#e2e8f0", minHeight: "100vh", padding: "20px 24px" }}>
      <style>{`
        @page { size: ${pw}mm ${ph}mm; margin: 0; }
        .etq-svg svg { width: 100%; height: 100%; display: block; }
        @media print {
          .etq-previa { background: #fff !important; padding: 0 !important; }
          .etq-pagina { box-shadow: none !important; margin: 0 !important; }
        }
      `}</style>
      <div className="no-print" style={{ ...card, padding: 14, marginBottom: 20, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <button onClick={onBack} style={{ background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>← Voltar</button>
        <div>
          <label style={rotulo}>Formato</label>
          <select value={formato} onChange={e => trocarFormato(e.target.value)} style={{ ...inp, width: "auto" }}>
            {Object.entries(FORMATOS_ETIQUETA).map(([k, f]) => <option key={k} value={k}>{f.rotulo}</option>)}
          </select>
        </div>
        <div>
          <label style={rotulo}>Cópias por item</label>
          <input type="number" min={1} max={200} value={copias} onChange={e => setCopias(Math.max(1, Number(e.target.value) || 1))} style={inpMini} />
        </div>
        {folhaInteira && (
          <div>
            <label style={rotulo} title="Para reaproveitar folha já usada: começa a imprimir nesta posição (contando da esquerda para a direita, de cima para baixo)">Começar na posição</label>
            <input type="number" min={1} max={porFolha} value={posicao} onChange={e => setPosicao(Number(e.target.value) || 1)} style={inpMini} />
          </div>
        )}
        <div>
          <label style={rotulo} title="Ajuste fino se a impressão sair deslocada da etiqueta (mm, pode ser negativo)">Deslocar X / Y (mm)</label>
          <div style={{ display: "flex", gap: 4 }}>
            <input type="number" step="0.5" value={desloc[0]} onChange={e => mudarDesloc(0, e.target.value)} style={inpMini} />
            <input type="number" step="0.5" value={desloc[1]} onChange={e => mudarDesloc(1, e.target.value)} style={inpMini} />
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 12.5, color: "#475569", marginBottom: 6 }}>
            {lista.length} item(ns) · {slots.length - vagas} etiqueta(s) · {folhas.length} {folhaInteira ? "folha(s)" : "página(s)"}
          </div>
          <button onClick={() => window.print()} disabled={!codigos}
            style={{ background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: codigos ? "pointer" : "wait", opacity: codigos ? 1 : 0.6 }}>🖨️ Imprimir</button>
        </div>
        <div style={{ flexBasis: "100%", fontSize: 11.5, color: "#64748b" }}>
          Na janela de impressão: <b>Margens: Nenhuma</b> e <b>Escala: 100% / Tamanho real</b>.
          {folhaInteira ? " Na primeira vez, imprima numa folha comum e sobreponha à de etiquetas contra a luz; se sair torto, ajuste o deslocamento (fica salvo)." : " Na térmica, escolha o papel com o mesmo tamanho da etiqueta nas preferências da impressora."}
        </div>
      </div>

      {erro && <Faixa cor="#dc2626">Erro ao gerar os códigos: {erro}</Faixa>}
      {!codigos && !erro && <div className="no-print" style={{ textAlign: "center", color: "#64748b", padding: 30 }}>Gerando QR e códigos de barras…</div>}

      {codigos && folhas.map((folha, fi) => (
        <div key={fi} className="etq-pagina"
          style={{ width: pw + "mm", height: ph - 0.3 + "mm", position: "relative", overflow: "hidden", background: "#fff", margin: "0 auto 18px", boxShadow: "0 2px 12px rgba(0,0,0,0.15)", pageBreakAfter: fi < folhas.length - 1 ? "always" : "auto" }}>
          {folha.map((it, si) => {
            if (!it) return null;
            const col = si % F.cols, row = Math.floor(si / F.cols);
            return (
              <div key={si} style={{
                position: "absolute", width: F.w + "mm", height: F.h + "mm",
                left: F.margem[1] + col * F.passo[0] + desloc[0] + "mm", top: F.margem[0] + row * F.passo[1] + desloc[1] + "mm",
                outline: folhaInteira ? "1px dashed #e2e8f0" : "none",
              }}>
                <Etiqueta item={it} g={codigos[it.id]} w={F.w} h={F.h} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
