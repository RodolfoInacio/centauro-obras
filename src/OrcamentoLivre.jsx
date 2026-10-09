// ─────────────────────────────────────────────────────────────────────────────
// ORÇAMENTOS LIVRES — orçamento rápido feito no app, fora do Wvetro: serviço avulso, acabamento,
// manutenção, "cantoneira em todos os vãos do prédio". Lista, editor e a folha A4 com a marca
// (paleta #ED5454 / #34353A, logo colorido, Kumbh Sans).
//
// O orçamento é um documento `jsonb` como os outros (tabela `orcamentos`, migration separada):
// estado muda na hora e grava debounced pelo `agendarGravacao` do App. Quantidade, subtotais e
// total são DERIVADOS (qtdItem/totaisOrcamento), nunca gravados — mesma regra do % do grupo.
//
// O item pode ter quantidade calculada por vãos (`calc`): uma lista de L × H × qtd em mm e um
// modo (perímetro, 3 lados, largura, altura, área, por vão) + % de perda. É o que resolve
// "cantoneira em todos os vãos": importa os vãos de uma obra cadastrada (medição quando houver,
// senão o L×H do orçamento) e a metragem sai sozinha.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import logoCor from "./assets/logo-cor.svg";
import iconeCor from "./assets/icone-cor.svg";
import Modal from "./Modal";
import { useSigilo, Dinheiro, Oculto, OlhoFinanceiro } from "./Sigilo";
import { normMedicao } from "./MedicaoItem";
import { useEstadoSessao } from "./rotas";

// Dados do rodapé das propostas do Wvetro (página 1 do PDF).
export const EMPRESA = {
  nome: "CENTAURO ESQUADRIAS",
  cnpj: "79.471.272/0001-20",
  fones: "(41) 3442-2144 · (41) 98834-2009",
  email: "comercial@esquadriascentauro.com.br",
  site: "esquadriascentauro.com.br",
  instagram: "@esquadriascentauro",
  endereco: "Av. Damião Botelho de Souza, 70 — Centro — Guaratuba/PR — 83280-000",
};

const VERMELHO = "#ED5454";
const GRAFITE = "#34353A";

// "Considerações gerais" das propostas do Wvetro, para não redigitar. Editável por orçamento.
export const CONSIDERACOES_PADRAO = [
  "Prazo de entrega: conforme cronograma a ser definido entre as partes.",
  "O local de execução deverá estar livre e desimpedido para a instalação dos itens fornecidos.",
  "Estamos considerando ponto de energia 220/110 V próximo ao local de instalação.",
  "O cliente deverá fornecer água potável e banheiro para nossos colaboradores.",
  "É de responsabilidade do cliente um local seguro para armazenamento dos itens fornecidos.",
  "As medidas e quantidades lançadas são de conferência do cliente/solicitante; havendo inclusão, alteração ou cancelamento de itens, os valores serão recalculados.",
].join("\n");

export const STATUS_ORC = {
  rascunho: { rotulo: "Rascunho", cor: "#64748b", fundo: "#f1f5f9" },
  enviado:  { rotulo: "Enviado",  cor: "#2563eb", fundo: "#eff6ff" },
  aprovado: { rotulo: "Aprovado", cor: "#16a34a", fundo: "#f0fdf4" },
  recusado: { rotulo: "Recusado", cor: "#dc2626", fundo: "#fef2f2" },
};

export const UNIDADES = ["un", "m", "m²", "ml", "vb", "pç", "kg", "h", "dia"];

// Modo de cálculo por vão. L e H em mm; o resultado já sai na unidade do modo.
export const MODOS_VAO = {
  perimetro: { rotulo: "Perímetro (2L + 2H)", un: "m",  f: (L, H) => 2 * (L + H) / 1000 },
  tresLados: { rotulo: "3 lados (L + 2H)",    un: "m",  f: (L, H) => (L + 2 * H) / 1000 },
  duasAlturas: { rotulo: "2 alturas (2H)",    un: "m",  f: (L, H) => 2 * H / 1000 },
  largura:   { rotulo: "Largura (L)",         un: "m",  f: (L) => L / 1000 },
  altura:    { rotulo: "Altura (H)",          un: "m",  f: (L, H) => H / 1000 },
  area:      { rotulo: "Área (L × H)",        un: "m²", f: (L, H) => L * H / 1e6 },
  contagem:  { rotulo: "Por vão (1 por unidade)", un: "un", f: () => 1 },
};

// ─── modelo ──────────────────────────────────────────────────────────────────
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
let seq = 0;
export const novoId = p => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const hojeLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function normVao(v) {
  return { id: v?.id || novoId("v"), local: String(v?.local || ""), L: num(v?.L), H: num(v?.H), qtd: v?.qtd == null ? 1 : num(v.qtd) };
}

function normItemOrc(i) {
  const tipo = i?.tipo === "titulo" ? "titulo" : "item";
  const base = { id: i?.id || novoId("i"), tipo, descricao: String(i?.descricao || "") };
  if (tipo === "titulo") return base;
  return {
    ...base,
    detalhe: String(i?.detalhe || ""),
    unidade: String(i?.unidade || "un"),
    qtd: num(i?.qtd),
    valorUnit: num(i?.valorUnit),
    calc: i?.calc && MODOS_VAO[i.calc.modo]
      ? { modo: i.calc.modo, perda: num(i.calc.perda), vaos: (Array.isArray(i.calc.vaos) ? i.calc.vaos : []).map(normVao) }
      : null,
  };
}

export function normOrcamento(o) {
  const c = o?.cliente || {};
  return {
    ...o,
    id: o?.id || novoId("orc"),
    numero: String(o?.numero || ""),
    status: STATUS_ORC[o?.status] ? o.status : "rascunho",
    criadoEm: o?.criadoEm || new Date().toISOString(),
    data: o?.data || hojeLocal(),
    validadeDias: o?.validadeDias == null ? 5 : num(o.validadeDias),
    titulo: String(o?.titulo || ""),
    obraId: o?.obraId || "",
    cliente: {
      nome: String(c.nome || ""), documento: String(c.documento || ""), telefone: String(c.telefone || ""),
      email: String(c.email || ""), endereco: String(c.endereco || ""), cidade: String(c.cidade || ""),
      contato: String(c.contato || ""),
    },
    enderecoObra: String(o?.enderecoObra || ""),
    vendedor: String(o?.vendedor || ""),
    itens: (Array.isArray(o?.itens) ? o.itens : []).map(normItemOrc),
    desconto: { tipo: o?.desconto?.tipo === "pct" ? "pct" : "valor", valor: num(o?.desconto?.valor) },
    pagamento: String(o?.pagamento || ""),
    prazo: String(o?.prazo || ""),
    observacoes: String(o?.observacoes || ""),
    consideracoes: o?.consideracoes == null ? CONSIDERACOES_PADRAO : String(o.consideracoes),
  };
}

// "OL-0001", "OL-0002"… — o próximo depois do maior já usado. O banco tem único em `numero`:
// duas abas criando ao mesmo tempo dão erro visível em vez de dois orçamentos com o mesmo nº.
export function proximoNumero(orcamentos) {
  const max = orcamentos.reduce((m, o) => Math.max(m, Number(String(o.numero).replace(/\D/g, "")) || 0), 0);
  return `OL-${String(max + 1).padStart(4, "0")}`;
}

export function novoOrcamento(orcamentos, base = {}) {
  return normOrcamento({ ...base, id: novoId("orc"), numero: proximoNumero(orcamentos), criadoEm: new Date().toISOString(), data: hojeLocal() });
}

export function qtdVao(modo, v) { return MODOS_VAO[modo] ? MODOS_VAO[modo].f(num(v.L), num(v.H)) * num(v.qtd) : 0; }

export function qtdItem(it) {
  if (it.tipo === "titulo") return 0;
  if (!it.calc) return num(it.qtd);
  const bruto = it.calc.vaos.reduce((a, v) => a + qtdVao(it.calc.modo, v), 0);
  return r2(bruto * (1 + num(it.calc.perda) / 100));
}
export const totalItem = it => r2(qtdItem(it) * num(it.valorUnit));

export function totaisOrcamento(o) {
  const subtotal = r2(o.itens.reduce((a, it) => a + (it.tipo === "titulo" ? 0 : totalItem(it)), 0));
  const desconto = r2(Math.min(subtotal, o.desconto.tipo === "pct" ? subtotal * num(o.desconto.valor) / 100 : num(o.desconto.valor)));
  return { subtotal, desconto, total: r2(subtotal - desconto) };
}

// Numeração na folha (1, 2, 3… só nos itens) e subtotal de cada seção (título até o próximo título).
function linhasNumeradas(itens) {
  let n = 0;
  const subt = {};
  let tituloAtual = null;
  for (const it of itens) {
    if (it.tipo === "titulo") { tituloAtual = it.id; subt[it.id] = 0; continue; }
    if (tituloAtual) subt[tituloAtual] = r2(subt[tituloAtual] + totalItem(it));
  }
  return itens.map(it => ({ it, n: it.tipo === "titulo" ? null : ++n, subtotal: subt[it.id] }));
}

// Vãos de uma obra cadastrada: cada unidade medida vira um vão com a medida real; o que não foi
// medido usa o L × H do orçamento (qtd do item). Item de serviço (sem medida) fica de fora.
export function vaosDaObra(obra) {
  const res = [];
  for (const it of obra.itens || []) {
    const local = [it.localizacao, it.tipo ? `T${it.tipo}` : ""].filter(Boolean).join(" · ") || it.descricao || `Item ${it.id}`;
    const L = num(it.L), H = num(it.H);
    const unidades = it.medicao ? normMedicao(it.medicao, it.qtd).unidades : [];
    const medidas = unidades.filter(u => num(u.L) > 0 && num(u.H) > 0);
    if (medidas.length) {
      medidas.forEach((u, k) => res.push({ chave: `${it.id}-${k}`, item: it, local: u.ambiente || local, L: num(u.L), H: num(u.H), qtd: 1, medido: true }));
      const faltam = Math.round(num(it.qtd)) - medidas.length;
      if (faltam > 0 && L > 1 && H > 1) res.push({ chave: `${it.id}-r`, item: it, local, L, H, qtd: faltam, medido: false });
    } else if (L > 1 && H > 1) {
      res.push({ chave: `${it.id}`, item: it, local, L, H, qtd: num(it.qtd) || 1, medido: false });
    }
  }
  return res;
}

// ─── formatação ──────────────────────────────────────────────────────────────
const fmtN = (n, casas = 2) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const fmtQ = n => Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const fmtR = n => "R$ " + fmtN(n);
const dataBR = iso => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
function somaDias(iso, dias) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + num(dias));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
// "1.234,5" / "1234.5" / "12,5" → número. Ponto seguido de 3 dígitos é milhar.
export function lerNumeroBR(s) {
  let t = String(s ?? "").trim().replace(/\s|R\$/g, "");
  if (!t) return 0;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// ─── estilos ─────────────────────────────────────────────────────────────────
const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff", color: "#1e293b" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };
const card = { background: "#fff", borderRadius: 12, padding: 18, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", marginBottom: 16 };
const btn = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };
const btnPri = { ...btn, background: GRAFITE, color: "#fff", border: "none" };
const btnVerm = { ...btn, background: VERMELHO, color: "#fff", border: "none" };
const btnMini = { background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 13, padding: "2px 4px", lineHeight: 1 };

function Campo({ rotulo, largo, children }) {
  return (
    <label style={{ gridColumn: largo ? "1 / -1" : "auto", minWidth: 0 }}>
      <span style={lbl}>{rotulo}</span>
      {children}
    </label>
  );
}

function Bloco({ titulo, extra, children }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 4, height: 16, background: VERMELHO, borderRadius: 2 }} />
        <div style={{ fontWeight: 800, fontSize: 14, color: GRAFITE }}>{titulo}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>{extra}</div>
      </div>
      {children}
    </div>
  );
}

// Campo numérico em texto: rascunho enquanto digita, formata no blur. `type="number"` controlado
// mostra zero à esquerda e não aceita vírgula (ver Armadilhas no CLAUDE.md).
// `dinheiro` mostra sempre duas casas (1.250,00); o resto mostra só as casas que existem.
function CampoNum({ valor, onChange, dinheiro, style, ...resto }) {
  const [rasc, setRasc] = useState(null);
  const mostrado = rasc ?? (valor ? (dinheiro ? fmtN(valor) : fmtQ(valor)) : "");
  return (
    <input type="text" inputMode="decimal" value={mostrado} {...resto}
      onFocus={e => { setRasc(valor ? String(valor).replace(".", ",") : ""); setTimeout(() => e.target.select(), 0); }}
      onChange={e => setRasc(e.target.value)}
      onBlur={() => { if (rasc != null) { const n = lerNumeroBR(rasc); if (n !== valor) onChange(n); } setRasc(null); }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
      style={{ ...inp, textAlign: "right", ...style }} />
  );
}

function ChipStatus({ status }) {
  const s = STATUS_ORC[status] || STATUS_ORC.rascunho;
  return <span style={{ background: s.fundo, color: s.cor, borderRadius: 999, padding: "2px 10px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{s.rotulo}</span>;
}

// ─── tela ────────────────────────────────────────────────────────────────────
export default function OrcamentosView({ orcamentos, obras, orcamentoId, erroTabela, onAbrir, onSalvar, onExcluir, onImprimir }) {
  if (orcamentoId) {
    const o = orcamentos.find(x => x.id === orcamentoId);
    if (!o) return <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>Orçamento não encontrado.</div>;
    return <EditorOrcamento key={o.id} orc={o} orcamentos={orcamentos} obras={obras} onSalvar={onSalvar}
      onExcluir={onExcluir} onImprimir={onImprimir} onAbrir={onAbrir} />;
  }
  return <ListaOrcamentos orcamentos={orcamentos} obras={obras} erroTabela={erroTabela} onAbrir={onAbrir} onSalvar={onSalvar} />;
}

function ListaOrcamentos({ orcamentos, obras, erroTabela, onAbrir, onSalvar }) {
  const [busca, setBusca] = useEstadoSessao("orc.busca", "");
  const [filtro, setFiltro] = useEstadoSessao("orc.status", "");
  const q = busca.trim().toLowerCase();
  const lista = orcamentos
    .filter(o => !filtro || o.status === filtro)
    .filter(o => !q || [o.numero, o.titulo, o.cliente.nome, o.cliente.cidade].some(s => String(s).toLowerCase().includes(q)))
    .sort((a, b) => (b.data || "").localeCompare(a.data || "") || b.numero.localeCompare(a.numero));
  const nomeObra = id => { const ob = obras.find(x => x.id === id); return ob ? `#${ob.numero} ${ob.cliente || ""}` : ""; };

  function criar() {
    const o = novoOrcamento(orcamentos);
    onSalvar(o);
    onAbrir(o.id);
  }

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: GRAFITE, margin: 0 }}>Orçamentos livres</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <OlhoFinanceiro rotulo />
          <button onClick={criar} style={btnVerm}>+ Novo orçamento</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
        Orçamento rápido fora do Wvetro — serviço, acabamento, manutenção. Sai em folha A4 com a marca da Centauro.
      </div>

      {erroTabela && (
        <div style={{ background: "#fef3c7", border: "1px solid #fde68a", color: "#92400e", borderRadius: 10, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
          A tabela de orçamentos ainda não existe no banco — rode <b>supabase/migration_orcamentos.sql</b> no SQL Editor do Supabase. Até lá, o que for criado aqui não é salvo.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por nº, cliente, título, cidade…" style={{ ...inp, flex: 1, minWidth: 220 }} />
        <div style={{ display: "inline-flex", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {[["", "Todos"], ...Object.entries(STATUS_ORC).map(([k, s]) => [k, s.rotulo])].map(([k, r]) => (
            <button key={k} onClick={() => setFiltro(k)}
              style={{ background: filtro === k ? GRAFITE : "#fff", color: filtro === k ? "#fff" : "#334155", border: "none", padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{r}</button>
          ))}
        </div>
      </div>

      {lista.length === 0 ? (
        <div style={{ ...card, textAlign: "center", color: "#94a3b8", padding: 40 }}>
          {orcamentos.length ? "Nenhum orçamento com esse filtro." : "Nenhum orçamento ainda. Clique em “+ Novo orçamento”."}
        </div>
      ) : (
        <div style={{ ...card, padding: 0, overflow: "hidden" }}>
          {lista.map((o, i) => {
            const t = totaisOrcamento(o);
            return (
              <div key={o.id} onClick={() => onAbrir(o.id)}
                style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderTop: i ? "1px solid #f1f5f9" : "none", cursor: "pointer", flexWrap: "wrap" }}
                onMouseEnter={e => { e.currentTarget.style.background = "#f8fafc"; }} onMouseLeave={e => { e.currentTarget.style.background = ""; }}>
                <div style={{ fontWeight: 800, color: VERMELHO, fontSize: 13, width: 72 }}>{o.numero}</div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#1e293b" }}>{o.titulo || <span style={{ color: "#94a3b8" }}>Sem título</span>}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {o.cliente.nome || "Cliente não informado"}{o.cliente.cidade ? ` · ${o.cliente.cidade}` : ""}
                    {o.obraId && nomeObra(o.obraId) ? ` · 🔗 ${nomeObra(o.obraId)}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", width: 76 }}>{dataBR(o.data)}</div>
                <ChipStatus status={o.status} />
                <div style={{ fontWeight: 800, fontSize: 14, color: GRAFITE, width: 130, textAlign: "right" }}><Dinheiro v={t.total} /></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── editor ──────────────────────────────────────────────────────────────────
function EditorOrcamento({ orc, orcamentos, obras, onSalvar, onExcluir, onImprimir, onAbrir }) {
  const { visivel } = useSigilo();
  const [abertoCalc, setAbertoCalc] = useState(() => new Set());
  const [importarPara, setImportarPara] = useState(null); // id do item que recebe os vãos
  const [confirmaExcluir, setConfirmaExcluir] = useState(false);
  // Mesma regra do editor do diário: mutação lê o ref (dois cliques no mesmo ciclo não se apagam).
  const ref = useRef(orc);
  ref.current = orc;

  const salvar = (mud) => {
    const novo = typeof mud === "function" ? mud(ref.current) : { ...ref.current, ...mud };
    ref.current = novo;
    onSalvar(novo);
  };
  const setCliente = (k, v) => salvar(o => ({ ...o, cliente: { ...o.cliente, [k]: v } }));
  const setItem = (id, mud) => salvar(o => ({ ...o, itens: o.itens.map(it => it.id === id ? { ...it, ...(typeof mud === "function" ? mud(it) : mud) } : it) }));
  const addItem = (extra = {}) => {
    const it = normItemOrc({ tipo: "item", unidade: "un", qtd: 1, ...extra });
    salvar(o => ({ ...o, itens: [...o.itens, it] }));
    if (it.calc) setAbertoCalc(s => new Set(s).add(it.id));
    return it;
  };
  const mover = (id, d) => salvar(o => {
    const i = o.itens.findIndex(x => x.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= o.itens.length) return o;
    const itens = [...o.itens];
    [itens[i], itens[j]] = [itens[j], itens[i]];
    return { ...o, itens };
  });
  const remover = id => salvar(o => ({ ...o, itens: o.itens.filter(x => x.id !== id) }));
  const duplicarItem = id => salvar(o => {
    const i = o.itens.findIndex(x => x.id === id);
    const c = normItemOrc({ ...o.itens[i], id: undefined, calc: o.itens[i].calc ? { ...o.itens[i].calc, vaos: o.itens[i].calc.vaos.map(v => ({ ...v, id: undefined })) } : null });
    const itens = [...o.itens]; itens.splice(i + 1, 0, c);
    return { ...o, itens };
  });

  function vincularObra(id) {
    const ob = obras.find(x => x.id === id);
    salvar(o => {
      if (!ob) return { ...o, obraId: "" };
      const cad = ob.cadastro || {};
      const c = o.cliente;
      // Só preenche o que está vazio — o que já foi digitado no orçamento vence.
      return {
        ...o, obraId: id,
        enderecoObra: o.enderecoObra || cad.enderecoObra || "",
        vendedor: o.vendedor || ob.vendedor || "",
        cliente: {
          ...c,
          nome: c.nome || ob.cliente || "",
          cidade: c.cidade || ob.cidade || "",
          telefone: c.telefone || cad.telefones || "",
          contato: c.contato || cad.contatoNome || "",
          endereco: c.endereco || cad.enderecoCliente || "",
        },
      };
    });
  }

  function duplicar() {
    const copia = novoOrcamento(orcamentos, {
      ...ref.current, status: "rascunho",
      titulo: ref.current.titulo ? `${ref.current.titulo} (cópia)` : "",
      itens: ref.current.itens.map(it => ({ ...it, id: undefined, calc: it.calc ? { ...it.calc, vaos: it.calc.vaos.map(v => ({ ...v, id: undefined })) } : null })),
    });
    onSalvar(copia);
    onAbrir(copia.id);
  }

  const t = totaisOrcamento(orc);
  const linhas = linhasNumeradas(orc.itens);
  const obrasOrdenadas = useMemo(() => [...obras].sort((a, b) => (Number(b.numero) || 0) - (Number(a.numero) || 0)), [obras]);
  const validoAte = somaDias(orc.data, orc.validadeDias);

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>
      {/* cabeçalho */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", borderTop: `4px solid ${VERMELHO}` }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: VERMELHO, letterSpacing: 1 }}>ORÇAMENTO {orc.numero}</div>
          <input value={orc.titulo} onChange={e => salvar({ titulo: e.target.value })} placeholder="Título — ex.: Acabamento com cantoneira nos vãos do Ed. Mar Azul"
            style={{ ...inp, fontSize: 17, fontWeight: 800, border: "none", padding: "2px 0", width: 520, maxWidth: "70vw", color: GRAFITE }} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={orc.status} onChange={e => salvar({ status: e.target.value })}
            style={{ ...inp, width: "auto", fontWeight: 800, color: STATUS_ORC[orc.status].cor, background: STATUS_ORC[orc.status].fundo }}>
            {Object.entries(STATUS_ORC).map(([k, s]) => <option key={k} value={k}>{s.rotulo}</option>)}
          </select>
          <button onClick={duplicar} style={btn} title="Cria um orçamento novo com o mesmo conteúdo">⧉ Duplicar</button>
          <button onClick={() => setConfirmaExcluir(true)} style={{ ...btn, color: "#dc2626", borderColor: "#fecaca" }}>Excluir</button>
          <button onClick={() => onImprimir(orc.id)} style={btnVerm}>🖨 Imprimir / PDF</button>
        </div>
      </div>

      {!visivel && (
        <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412", borderRadius: 10, padding: "8px 14px", fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          Valores ocultos — para lançar preços, libere os valores. <OlhoFinanceiro rotulo />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Bloco titulo="Cliente">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Campo rotulo="Vincular a uma obra (opcional)" largo>
              <select value={orc.obraId} onChange={e => vincularObra(e.target.value)} style={inp}>
                <option value="">— sem vínculo —</option>
                {obrasOrdenadas.map(ob => <option key={ob.id} value={ob.id}>#{ob.numero} — {ob.cliente}{ob.obra ? ` · ${ob.obra}` : ""}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Nome / razão social" largo><input value={orc.cliente.nome} onChange={e => setCliente("nome", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="CPF / CNPJ"><input value={orc.cliente.documento} onChange={e => setCliente("documento", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="Telefone"><input value={orc.cliente.telefone} onChange={e => setCliente("telefone", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="Contato"><input value={orc.cliente.contato} onChange={e => setCliente("contato", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="E-mail"><input value={orc.cliente.email} onChange={e => setCliente("email", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="Endereço"><input value={orc.cliente.endereco} onChange={e => setCliente("endereco", e.target.value)} style={inp} /></Campo>
            <Campo rotulo="Cidade / UF"><input value={orc.cliente.cidade} onChange={e => setCliente("cidade", e.target.value)} style={inp} /></Campo>
          </div>
        </Bloco>
        <Bloco titulo="Proposta">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Campo rotulo="Data"><input type="date" value={orc.data} onChange={e => salvar({ data: e.target.value })} style={inp} /></Campo>
            <Campo rotulo={`Validade (dias)${validoAte ? ` · até ${dataBR(validoAte)}` : ""}`}>
              <CampoNum valor={orc.validadeDias} onChange={v => salvar({ validadeDias: Math.max(0, Math.round(v)) })} style={{ textAlign: "left" }} />
            </Campo>
            <Campo rotulo="Endereço da obra / serviço" largo><input value={orc.enderecoObra} onChange={e => salvar({ enderecoObra: e.target.value })} style={inp} /></Campo>
            <Campo rotulo="Vendedor / responsável" largo><input value={orc.vendedor} onChange={e => salvar({ vendedor: e.target.value })} style={inp} /></Campo>
            <Campo rotulo="Prazo de execução" largo><input value={orc.prazo} onChange={e => salvar({ prazo: e.target.value })} placeholder="ex.: 15 dias úteis após a aprovação" style={inp} /></Campo>
          </div>
        </Bloco>
      </div>

      {/* itens */}
      <Bloco titulo="Itens e serviços" extra={<>
        <button onClick={() => salvar(o => ({ ...o, itens: [...o.itens, normItemOrc({ tipo: "titulo", descricao: "" })] }))} style={btn} title="Separa os itens em seções (pavimento, bloco, ambiente) com subtotal">+ Seção</button>
        <button onClick={() => addItem({ unidade: "m", calc: { modo: "perimetro", perda: 0, vaos: [] } })} style={btn} title="Quantidade calculada pelas medidas dos vãos">📐 + Item por vãos</button>
        <button onClick={() => addItem()} style={btnPri}>+ Item</button>
      </>}>
        {orc.itens.length === 0 ? (
          <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, padding: "22px 0" }}>
            Nenhum item. Use <b>+ Item</b> para serviço/material com quantidade digitada, ou <b>📐 + Item por vãos</b> para metragem
            calculada pelos vãos (ex.: cantoneira em todos os vãos de um prédio — dá para importar os vãos de uma obra cadastrada).
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              <div style={{ display: "grid", gridTemplateColumns: "30px 1fr 74px 90px 120px 120px 112px", gap: 8, fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", padding: "0 0 6px", borderBottom: "1px solid #f1f5f9" }}>
                <div>#</div><div>Descrição</div><div>Un</div><div style={{ textAlign: "right" }}>Qtd</div><div style={{ textAlign: "right" }}>Valor unit.</div><div style={{ textAlign: "right" }}>Total</div><div />
              </div>
              {linhas.map(({ it, n, subtotal }, idx) => {
                const acoes = (
                  <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                    <button onClick={() => mover(it.id, -1)} disabled={idx === 0} style={btnMini} title="Subir">▲</button>
                    <button onClick={() => mover(it.id, 1)} disabled={idx === orc.itens.length - 1} style={btnMini} title="Descer">▼</button>
                    {it.tipo === "item" && <button onClick={() => duplicarItem(it.id)} style={btnMini} title="Duplicar linha">⧉</button>}
                    <button onClick={() => remover(it.id)} style={{ ...btnMini, color: "#ef4444" }} title="Remover">✕</button>
                  </div>
                );
                if (it.tipo === "titulo") {
                  return (
                    <div key={it.id} style={{ display: "grid", gridTemplateColumns: "30px 1fr 120px 112px", gap: 8, alignItems: "center", padding: "10px 0 6px", borderBottom: `2px solid ${GRAFITE}` }}>
                      <div style={{ color: VERMELHO, fontWeight: 900 }}>§</div>
                      <input value={it.descricao} onChange={e => setItem(it.id, { descricao: e.target.value })} placeholder="Nome da seção — ex.: Torre A / 3º pavimento"
                        style={{ ...inp, fontWeight: 800, textTransform: "uppercase", color: GRAFITE }} />
                      <div style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: "#64748b" }}>Subtotal <Dinheiro v={subtotal || 0} /></div>
                      {acoes}
                    </div>
                  );
                }
                const temCalc = !!it.calc;
                const calcAberto = abertoCalc.has(it.id);
                const qtd = qtdItem(it);
                return (
                  <div key={it.id} style={{ borderBottom: "1px solid #f1f5f9", padding: "8px 0" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "30px 1fr 74px 90px 120px 120px 112px", gap: 8, alignItems: "start" }}>
                      <div style={{ fontWeight: 800, color: "#94a3b8", fontSize: 13, paddingTop: 8 }}>{n}</div>
                      <div>
                        <input value={it.descricao} onChange={e => setItem(it.id, { descricao: e.target.value })} placeholder="Descrição — ex.: Fornecimento e instalação de cantoneira de alumínio 1&quot; preto"
                          style={{ ...inp, fontWeight: 600 }} />
                        <textarea value={it.detalhe} onChange={e => setItem(it.id, { detalhe: e.target.value })} placeholder="Detalhe (opcional): acabamento, cor, fixação…" rows={it.detalhe ? 2 : 1}
                          style={{ ...inp, marginTop: 4, fontSize: 12, color: "#475569", resize: "vertical" }} />
                      </div>
                      <select value={it.unidade} onChange={e => setItem(it.id, { unidade: e.target.value })} style={{ ...inp, padding: "7px 4px" }}>
                        {[...new Set([...UNIDADES, it.unidade])].map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                      {temCalc
                        ? <button onClick={() => setAbertoCalc(s => { const x = new Set(s); x.has(it.id) ? x.delete(it.id) : x.add(it.id); return x; })}
                            title="Quantidade calculada pelos vãos — clique para ver/editar"
                            style={{ ...inp, textAlign: "right", fontWeight: 800, background: "#fef2f2", borderColor: "#fecaca", color: GRAFITE, cursor: "pointer" }}>📐 {fmtQ(qtd)}</button>
                        : <CampoNum valor={it.qtd} onChange={v => setItem(it.id, { qtd: v })} />}
                      <Oculto><CampoNum dinheiro valor={it.valorUnit} onChange={v => setItem(it.id, { valorUnit: v })} /></Oculto>
                      <div style={{ textAlign: "right", fontWeight: 800, fontSize: 13, color: GRAFITE, paddingTop: 8 }}><Dinheiro v={totalItem(it)} /></div>
                      <div style={{ paddingTop: 6 }}>{acoes}</div>
                    </div>
                    <div style={{ marginLeft: 38, marginTop: 4 }}>
                      {!temCalc ? (
                        <button onClick={() => { setItem(it.id, { calc: { modo: "perimetro", perda: 0, vaos: [] }, unidade: "m" }); setAbertoCalc(s => new Set(s).add(it.id)); }}
                          style={{ ...btnMini, fontSize: 11, color: "#64748b" }}>📐 calcular a quantidade pelos vãos</button>
                      ) : calcAberto ? (
                        <CalcVaos item={it} onChange={calc => setItem(it.id, { calc })}
                          onUnidade={u => setItem(it.id, { unidade: u })}
                          onImportar={() => setImportarPara(it.id)}
                          onDesligar={() => { setItem(it.id, i => ({ calc: null, qtd: qtdItem(i) })); setAbertoCalc(s => { const x = new Set(s); x.delete(it.id); return x; }); }}
                          onFechar={() => setAbertoCalc(s => { const x = new Set(s); x.delete(it.id); return x; })} />
                      ) : (
                        <button onClick={() => setAbertoCalc(s => new Set(s).add(it.id))} style={{ ...btnMini, fontSize: 11, color: "#64748b" }}>
                          📐 {it.calc.vaos.length} linha{it.calc.vaos.length === 1 ? "" : "s"} de vãos · {MODOS_VAO[it.calc.modo].rotulo}{it.calc.perda ? ` · +${fmtQ(it.calc.perda)}% perda` : ""} — editar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* totais */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <div style={{ width: 340, maxWidth: "100%", fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#475569" }}><span>Subtotal</span><b><Dinheiro v={t.subtotal} /></b></div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "4px 0", color: "#475569" }}>
              <span>Desconto</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select value={orc.desconto.tipo} onChange={e => salvar(o => ({ ...o, desconto: { ...o.desconto, tipo: e.target.value } }))} style={{ ...inp, width: 64, padding: "5px 4px" }}>
                  <option value="valor">R$</option><option value="pct">%</option>
                </select>
                <Oculto prefixo=""><CampoNum dinheiro={orc.desconto.tipo === "valor"} valor={orc.desconto.valor} onChange={v => salvar(o => ({ ...o, desconto: { ...o.desconto, valor: Math.max(0, v) } }))} style={{ width: 110 }} /></Oculto>
              </div>
            </div>
            {t.desconto > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: "#dc2626", fontSize: 12 }}><span /><span>− <Dinheiro v={t.desconto} /></span></div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, background: GRAFITE, color: "#fff", borderRadius: 8, padding: "10px 14px" }}>
              <span style={{ fontWeight: 700 }}>TOTAL</span><span style={{ fontWeight: 900, fontSize: 18 }}><Dinheiro v={t.total} /></span>
            </div>
          </div>
        </div>
      </Bloco>

      <Bloco titulo="Condições">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <Campo rotulo="Forma de pagamento">
            <textarea value={orc.pagamento} onChange={e => salvar({ pagamento: e.target.value })} rows={3} placeholder="ex.: 50% de entrada e 50% na conclusão · PIX ou boleto" style={{ ...inp, resize: "vertical" }} />
          </Campo>
          <Campo rotulo="Observações">
            <textarea value={orc.observacoes} onChange={e => salvar({ observacoes: e.target.value })} rows={3} placeholder="Aparece na folha, logo abaixo dos itens" style={{ ...inp, resize: "vertical" }} />
          </Campo>
          <Campo rotulo="Considerações gerais (uma por linha)" largo>
            <textarea value={orc.consideracoes} onChange={e => salvar({ consideracoes: e.target.value })} rows={6} style={{ ...inp, resize: "vertical", fontSize: 12 }} />
          </Campo>
        </div>
        {orc.consideracoes !== CONSIDERACOES_PADRAO && (
          <button onClick={() => salvar({ consideracoes: CONSIDERACOES_PADRAO })} style={{ ...btnMini, fontSize: 11, color: "#64748b", marginTop: 6 }}>↺ voltar ao texto padrão</button>
        )}
      </Bloco>

      <ImportarVaos open={!!importarPara} obras={obrasOrdenadas} obraInicial={orc.obraId}
        onFechar={() => setImportarPara(null)}
        onImportar={vaos => {
          setItem(importarPara, i => ({ calc: { ...i.calc, vaos: [...i.calc.vaos, ...vaos.map(normVao)] } }));
          setImportarPara(null);
        }} />

      <Modal open={confirmaExcluir} title="Excluir orçamento" onClose={() => setConfirmaExcluir(false)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 16 }}>
          Excluir o orçamento <b>{orc.numero}</b>{orc.titulo ? ` — ${orc.titulo}` : ""}? Não dá para desfazer.
          {orc.status !== "rascunho" && <div style={{ marginTop: 8, color: "#b45309" }}>Ele já está como <b>{STATUS_ORC[orc.status].rotulo}</b>. Se só não vai adiante, prefira marcar “Recusado”.</div>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setConfirmaExcluir(false)} style={btn}>Cancelar</button>
          <button onClick={() => { setConfirmaExcluir(false); onExcluir(orc.id); }} style={{ ...btn, background: "#dc2626", color: "#fff", border: "none" }}>Excluir</button>
        </div>
      </Modal>
    </div>
  );
}

// Lista de vãos de um item (L × H × qtd em mm) e o modo de cálculo.
function CalcVaos({ item, onChange, onUnidade, onImportar, onDesligar, onFechar }) {
  const c = item.calc;
  const set = mud => onChange({ ...c, ...mud });
  const setVao = (id, mud) => set({ vaos: c.vaos.map(v => v.id === id ? { ...v, ...mud } : v) });
  const modo = MODOS_VAO[c.modo];
  const bruto = c.vaos.reduce((a, v) => a + qtdVao(c.modo, v), 0);
  const nVaos = c.vaos.reduce((a, v) => a + num(v.qtd), 0);
  const [colar, setColar] = useState(null);

  // Colar do Excel/Wvetro: uma linha por vão — "local  L  H  qtd" ou "L  H  qtd" (tab, ; ou espaços).
  function aplicarColagem() {
    const novos = [];
    for (const linha of String(colar || "").split(/\r?\n/)) {
      const partes = linha.split(/\t|;/).map(s => s.trim()).filter(Boolean);
      const cols = partes.length > 1 ? partes : linha.trim().split(/\s+/);
      const nums = [], texto = [];
      cols.forEach(p => (/^[\d.,]+$/.test(p) ? nums : texto).push(p));
      if (nums.length < 2) continue;
      novos.push(normVao({ local: texto.join(" "), L: lerNumeroBR(nums[0]), H: lerNumeroBR(nums[1]), qtd: nums[2] ? lerNumeroBR(nums[2]) : 1 }));
    }
    if (novos.length) set({ vaos: [...c.vaos, ...novos] });
    setColar(null);
  }

  return (
    <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderLeft: `3px solid ${VERMELHO}`, borderRadius: 8, padding: 12, marginTop: 4 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ minWidth: 200 }}>
          <span style={lbl}>Calcular por</span>
          <select value={c.modo} onChange={e => { set({ modo: e.target.value }); onUnidade(MODOS_VAO[e.target.value].un); }} style={inp}>
            {Object.entries(MODOS_VAO).map(([k, m]) => <option key={k} value={k}>{m.rotulo}</option>)}
          </select>
        </label>
        <label style={{ width: 100 }}>
          <span style={lbl}>+ Perda %</span>
          <CampoNum valor={c.perda} onChange={v => set({ perda: Math.max(0, v) })} />
        </label>
        <div style={{ fontSize: 12, color: "#475569", paddingBottom: 8 }}>
          {fmtQ(nVaos)} vão{nVaos === 1 ? "" : "s"} · {fmtQ(r2(bruto))} {modo.un}{c.perda ? ` + ${fmtQ(c.perda)}% = ` : " = "}<b>{fmtQ(qtdItem(item))} {modo.un}</b>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={onImportar} style={btn}>⤓ Importar vãos de uma obra</button>
          <button onClick={() => setColar("")} style={btn} title="Colar linhas do Excel">📋 Colar</button>
          <button onClick={onDesligar} style={{ ...btn, color: "#64748b" }} title="Volta a quantidade digitada (fica o valor calculado)">Digitar qtd</button>
          <button onClick={onFechar} style={btn}>Fechar ▲</button>
        </div>
      </div>

      {colar != null && (
        <div style={{ marginBottom: 10 }}>
          <textarea value={colar} onChange={e => setColar(e.target.value)} rows={5} autoFocus
            placeholder={"Uma linha por vão, em mm: local  largura  altura  quantidade\nSala 1500 1200 2\nQuarto 1;1000;1200;1\n1200 2100 4"}
            style={{ ...inp, fontFamily: "monospace", fontSize: 12 }} />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button onClick={aplicarColagem} style={btnPri}>Adicionar linhas</button>
            <button onClick={() => setColar(null)} style={btn}>Cancelar</button>
          </div>
        </div>
      )}

      {c.vaos.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "#94a3b8", fontSize: 10.5, textTransform: "uppercase" }}>
                <th style={{ textAlign: "left", padding: "2px 4px" }}>Local / vão</th>
                <th style={{ textAlign: "right", padding: "2px 4px", width: 90 }}>L (mm)</th>
                <th style={{ textAlign: "right", padding: "2px 4px", width: 90 }}>H (mm)</th>
                <th style={{ textAlign: "right", padding: "2px 4px", width: 70 }}>Qtd</th>
                <th style={{ textAlign: "right", padding: "2px 4px", width: 90 }}>{modo.un}</th>
                <th style={{ width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {c.vaos.map(v => (
                <tr key={v.id}>
                  <td style={{ padding: 2 }}><input value={v.local} onChange={e => setVao(v.id, { local: e.target.value })} style={{ ...inp, padding: "4px 8px", fontSize: 12 }} /></td>
                  <td style={{ padding: 2 }}><CampoNum valor={v.L} onChange={x => setVao(v.id, { L: x })} style={{ padding: "4px 8px", fontSize: 12 }} /></td>
                  <td style={{ padding: 2 }}><CampoNum valor={v.H} onChange={x => setVao(v.id, { H: x })} style={{ padding: "4px 8px", fontSize: 12 }} /></td>
                  <td style={{ padding: 2 }}><CampoNum valor={v.qtd} onChange={x => setVao(v.id, { qtd: x })} style={{ padding: "4px 8px", fontSize: 12 }} /></td>
                  <td style={{ padding: "2px 6px", textAlign: "right", fontWeight: 700, color: GRAFITE }}>{fmtQ(r2(qtdVao(c.modo, v)))}</td>
                  <td style={{ textAlign: "center" }}><button onClick={() => set({ vaos: c.vaos.filter(x => x.id !== v.id) })} style={{ ...btnMini, color: "#ef4444" }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button onClick={() => set({ vaos: [...c.vaos, normVao({ qtd: 1 })] })} style={{ ...btn, marginTop: 8 }}>+ Vão</button>
      {c.vaos.length > 1 && (
        <button onClick={() => set({ vaos: [] })} style={{ ...btnMini, fontSize: 11, color: "#ef4444", marginLeft: 10 }}>limpar todos</button>
      )}
    </div>
  );
}

// Escolhe a obra e marca os vãos que entram. Medido (Medição do item) vem com a medida real.
function ImportarVaos({ open, obras, obraInicial, onFechar, onImportar }) {
  const [obraId, setObraId] = useState(obraInicial || "");
  const [marcados, setMarcados] = useState(() => new Set());
  const obra = obras.find(o => o.id === obraId);
  const vaos = useMemo(() => (obra ? vaosDaObra(obra) : []), [obra]);
  useEffect(() => { if (open) setObraId(obraInicial || ""); }, [open, obraInicial]);
  useEffect(() => { setMarcados(new Set(vaos.map(v => v.chave))); }, [vaos]);
  const alternar = k => setMarcados(s => { const x = new Set(s); x.has(k) ? x.delete(k) : x.add(k); return x; });
  const total = vaos.filter(v => marcados.has(v.chave)).reduce((a, v) => a + v.qtd, 0);

  return (
    <Modal open={open} title="⤓ Importar vãos de uma obra" onClose={onFechar} width={680}>
      <select value={obraId} onChange={e => setObraId(e.target.value)} style={{ ...inp, marginBottom: 10 }}>
        <option value="">— escolha a obra —</option>
        {obras.map(ob => <option key={ob.id} value={ob.id}>#{ob.numero} — {ob.cliente}{ob.obra ? ` · ${ob.obra}` : ""} ({(ob.itens || []).length} itens)</option>)}
      </select>
      {obra && (vaos.length === 0
        ? <div style={{ color: "#94a3b8", fontSize: 13, padding: 16, textAlign: "center" }}>Essa obra não tem itens com medida (L × H).</div>
        : <>
          <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#64748b", marginBottom: 6 }}>
            <button onClick={() => setMarcados(new Set(vaos.map(v => v.chave)))} style={btnMini}>marcar todos</button>
            <button onClick={() => setMarcados(new Set())} style={btnMini}>desmarcar</button>
            <span style={{ marginLeft: "auto" }}>📏 = medida da Medição · demais = L × H do orçamento</span>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto", border: "1px solid #f1f5f9", borderRadius: 8 }}>
            {vaos.map(v => (
              <label key={v.chave} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid #f8fafc", fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={marcados.has(v.chave)} onChange={() => alternar(v.chave)} />
                <span style={{ width: 40, color: "#94a3b8", fontWeight: 700 }}>{v.item.id}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={v.item.descricao}>
                  {v.local} <span style={{ color: "#94a3b8" }}>— {v.item.descricao}</span>
                </span>
                <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{v.medido ? "📏 " : ""}{v.L} × {v.H}</span>
                <span style={{ width: 44, textAlign: "right", color: "#475569" }}>×{fmtQ(v.qtd)}</span>
              </label>
            ))}
          </div>
        </>)}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", marginTop: 14 }}>
        {obra && vaos.length > 0 && <span style={{ fontSize: 12, color: "#64748b", marginRight: "auto" }}>{fmtQ(total)} vãos marcados</span>}
        <button onClick={onFechar} style={btn}>Cancelar</button>
        <button disabled={!total} onClick={() => onImportar(vaos.filter(v => marcados.has(v.chave)).map(v => ({ local: v.local, L: v.L, H: v.H, qtd: v.qtd })))}
          style={{ ...btnVerm, opacity: total ? 1 : 0.5 }}>Importar</button>
      </div>
    </Modal>
  );
}

// ─── folha impressa ──────────────────────────────────────────────────────────
// A4 retrato, mesma receita das outras folhas (tela cheia, .no-print, @page). Com os valores
// ocultos (Sigilo), a folha sai sem preços em vez de imprimir a máscara.
export function OrcamentoPrint({ orcamento, onBack }) {
  const { visivel } = useSigilo();
  const o = orcamento;
  const [memoria, setMemoria] = useState(false);
  const [precoItem, setPrecoItem] = useState(true);
  const t = totaisOrcamento(o);
  const linhas = linhasNumeradas(o.itens);
  const temSecao = o.itens.some(i => i.tipo === "titulo");
  const comPreco = visivel && precoItem;
  const consid = o.consideracoes.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const c = o.cliente;

  useEffect(() => {
    const antes = document.title;
    document.title = `Orçamento ${o.numero}${c.nome ? ` — ${c.nome}` : ""}`;
    return () => { document.title = antes; };
  }, [o.numero, c.nome]);

  const th = { background: GRAFITE, color: "#fff", fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, padding: "7px 8px", textAlign: "left" };
  const td = { fontSize: 11, padding: "7px 8px", borderBottom: "1px solid #e5e7eb", verticalAlign: "top" };
  const rotulo = { fontSize: 8.5, fontWeight: 800, color: VERMELHO, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 };
  const dado = (r, v) => v ? <div style={{ fontSize: 11, color: "#1f2937", marginBottom: 2 }}><span style={{ color: "#6b7280" }}>{r}: </span>{v}</div> : null;
  const nCols = comPreco ? 6 : 4;

  return (
    <div style={{ background: "#e5e7eb", minHeight: "100vh", padding: "20px 12px" }} className="orc-fundo">
      <style>{`
        @page { size: A4 portrait; margin: 12mm 12mm 14mm; }
        @media print {
          html, body, .orc-fundo { background: #fff !important; padding: 0 !important; }
          .orc-folha { box-shadow: none !important; padding: 0 !important; width: auto !important; min-height: 0 !important; }
          .orc-folha, .orc-folha * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .orc-marca { position: fixed !important; }
          tr, .orc-bloco { page-break-inside: avoid; break-inside: avoid; }
          thead { display: table-header-group; }
        }
      `}</style>

      <div className="no-print" style={{ maxWidth: 820, margin: "0 auto 14px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 14px" }}>
        <button onClick={onBack} style={btnPri}>← Voltar</button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer" }}>
          <input type="checkbox" checked={precoItem} onChange={e => setPrecoItem(e.target.checked)} /> Preço por item
        </label>
        {o.itens.some(i => i.calc?.vaos.length) && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer" }}>
            <input type="checkbox" checked={memoria} onChange={e => setMemoria(e.target.checked)} /> Memória de cálculo dos vãos
          </label>
        )}
        {!visivel && <span style={{ fontSize: 12, color: "#9a3412", display: "inline-flex", alignItems: "center", gap: 8 }}>Valores ocultos: a folha sai sem preços. <OlhoFinanceiro rotulo /></span>}
        <button onClick={() => window.print()} style={{ ...btnVerm, marginLeft: "auto", padding: "8px 18px", fontSize: 13 }}>🖨 Imprimir / Salvar PDF</button>
      </div>

      <div className="orc-folha" style={{ position: "relative", background: "#fff", width: 794, maxWidth: "100%", minHeight: 1123, margin: "0 auto", padding: "40px 46px", boxShadow: "0 4px 24px rgba(0,0,0,0.12)", color: "#1f2937", fontFamily: "'Kumbh Sans', 'Segoe UI', sans-serif", overflow: "hidden" }}>
        {/* marca d'água do timbrado */}
        <img className="orc-marca" src={iconeCor} alt="" style={{ position: "absolute", right: -60, bottom: -40, width: 420, opacity: 0.045, pointerEvents: "none", zIndex: 0 }} />

        <div style={{ position: "relative", zIndex: 1 }}>
          {/* cabeçalho */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
            <img src={logoCor} alt="Centauro Esquadrias" style={{ height: 50 }} />
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 3, color: VERMELHO }}>ORÇAMENTO</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: GRAFITE, lineHeight: 1.1 }}>{o.numero}</div>
              <div style={{ fontSize: 10.5, color: "#6b7280", marginTop: 3 }}>
                Emitido em {dataBR(o.data)}{o.validadeDias ? ` · válido até ${dataBR(somaDias(o.data, o.validadeDias))}` : ""}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", height: 4, margin: "14px 0 18px" }}>
            <div style={{ flex: 3, background: VERMELHO }} /><div style={{ flex: 1, background: GRAFITE }} />
          </div>

          {o.titulo && <div style={{ fontSize: 16, fontWeight: 800, color: GRAFITE, marginBottom: 12 }}>{o.titulo}</div>}

          {/* cliente e obra */}
          <div className="orc-bloco" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14, marginBottom: 18 }}>
            <div style={{ background: "#f7f7f8", borderRadius: 6, padding: "10px 12px" }}>
              <div style={rotulo}>Cliente</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: GRAFITE, marginBottom: 3 }}>{c.nome || "—"}</div>
              {dado("CPF/CNPJ", c.documento)}
              {dado("Contato", [c.contato, c.telefone].filter(Boolean).join(" · "))}
              {dado("E-mail", c.email)}
              {dado("Endereço", [c.endereco, c.cidade].filter(Boolean).join(" — "))}
            </div>
            <div style={{ background: "#f7f7f8", borderRadius: 6, padding: "10px 12px" }}>
              <div style={rotulo}>Obra / serviço</div>
              {dado("Local", o.enderecoObra || c.cidade)}
              {dado("Prazo de execução", o.prazo)}
              {dado("Responsável", o.vendedor)}
              {!o.enderecoObra && !c.cidade && !o.prazo && !o.vendedor && <div style={{ fontSize: 11, color: "#9ca3af" }}>—</div>}
            </div>
          </div>

          {/* itens */}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28, textAlign: "center" }}>#</th>
                <th style={th}>Descrição</th>
                <th style={{ ...th, width: 40, textAlign: "center" }}>Un</th>
                <th style={{ ...th, width: 62, textAlign: "right" }}>Qtd</th>
                {comPreco && <th style={{ ...th, width: 92, textAlign: "right" }}>Valor unit.</th>}
                {comPreco && <th style={{ ...th, width: 100, textAlign: "right" }}>Total</th>}
              </tr>
            </thead>
            <tbody>
              {linhas.map(({ it, n, subtotal }) => it.tipo === "titulo" ? (
                <tr key={it.id}>
                  <td colSpan={comPreco ? nCols - 1 : nCols} style={{ ...td, background: "#f1f1f2", fontWeight: 800, color: GRAFITE, textTransform: "uppercase", fontSize: 10.5, letterSpacing: 0.4, borderLeft: `3px solid ${VERMELHO}` }}>{it.descricao || "Seção"}</td>
                  {comPreco && <td style={{ ...td, background: "#f1f1f2", textAlign: "right", fontWeight: 800, color: GRAFITE, fontSize: 10.5 }}>{fmtR(subtotal || 0)}</td>}
                </tr>
              ) : (
                <tr key={it.id}>
                  <td style={{ ...td, textAlign: "center", color: "#9ca3af", fontWeight: 700 }}>{n}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 700, color: "#111827" }}>{it.descricao || "—"}</div>
                    {it.detalhe && <div style={{ fontSize: 10, color: "#4b5563", whiteSpace: "pre-wrap", marginTop: 2 }}>{it.detalhe}</div>}
                    {it.calc && it.calc.vaos.length > 0 && (
                      <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 2 }}>
                        {fmtQ(it.calc.vaos.reduce((a, v) => a + num(v.qtd), 0))} vãos · {MODOS_VAO[it.calc.modo].rotulo.toLowerCase()}{it.calc.perda ? ` · inclui ${fmtQ(it.calc.perda)}% de perda` : ""}
                      </div>
                    )}
                    {memoria && it.calc && it.calc.vaos.length > 0 && (
                      <table style={{ borderCollapse: "collapse", marginTop: 5, fontSize: 9 }}>
                        <tbody>
                          {it.calc.vaos.map(v => (
                            <tr key={v.id} style={{ color: "#4b5563" }}>
                              <td style={{ padding: "1px 10px 1px 0" }}>{v.local || "—"}</td>
                              <td style={{ padding: "1px 10px 1px 0", textAlign: "right" }}>{fmtQ(v.L)} × {fmtQ(v.H)} mm</td>
                              <td style={{ padding: "1px 10px 1px 0", textAlign: "right" }}>× {fmtQ(v.qtd)}</td>
                              <td style={{ padding: "1px 0", textAlign: "right", fontWeight: 700 }}>{fmtQ(r2(qtdVao(it.calc.modo, v)))} {MODOS_VAO[it.calc.modo].un}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>{it.unidade}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtQ(qtdItem(it))}</td>
                  {comPreco && <td style={{ ...td, textAlign: "right" }}>{fmtR(it.valorUnit)}</td>}
                  {comPreco && <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtR(totalItem(it))}</td>}
                </tr>
              ))}
              {o.itens.length === 0 && <tr><td colSpan={nCols} style={{ ...td, textAlign: "center", color: "#9ca3af" }}>Sem itens</td></tr>}
            </tbody>
          </table>

          {/* totais */}
          {visivel && (
            <div className="orc-bloco" style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <div style={{ width: 280, fontSize: 11.5 }}>
                {(t.desconto > 0 || temSecao) && <>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "#4b5563" }}><span>Subtotal</span><span>{fmtR(t.subtotal)}</span></div>
                  {t.desconto > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "#4b5563" }}>
                    <span>Desconto{o.desconto.tipo === "pct" ? ` (${fmtQ(o.desconto.valor)}%)` : ""}</span><span>− {fmtR(t.desconto)}</span>
                  </div>}
                </>}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: VERMELHO, color: "#fff", borderRadius: 4, padding: "9px 12px", marginTop: 4 }}>
                  <span style={{ fontWeight: 800, letterSpacing: 1, fontSize: 11 }}>VALOR TOTAL</span>
                  <span style={{ fontWeight: 900, fontSize: 16 }}>{fmtR(t.total)}</span>
                </div>
              </div>
            </div>
          )}

          {o.observacoes && (
            <div className="orc-bloco" style={{ marginTop: 16 }}>
              <div style={rotulo}>Observações</div>
              <div style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "#374151" }}>{o.observacoes}</div>
            </div>
          )}

          {(o.pagamento || o.validadeDias > 0) && (
            <div className="orc-bloco" style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {o.pagamento && <div>
                <div style={rotulo}>Forma de pagamento</div>
                <div style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "#374151" }}>{o.pagamento}</div>
              </div>}
              {o.validadeDias > 0 && <div>
                <div style={rotulo}>Validade da proposta</div>
                <div style={{ fontSize: 11, color: "#374151" }}>{o.validadeDias} dia{o.validadeDias === 1 ? "" : "s"} a contar da emissão ({dataBR(somaDias(o.data, o.validadeDias))})</div>
              </div>}
            </div>
          )}

          {consid.length > 0 && (
            <div className="orc-bloco" style={{ marginTop: 16 }}>
              <div style={rotulo}>Considerações gerais</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 9.5, color: "#4b5563", lineHeight: 1.5 }}>
                {consid.map((s, i) => <li key={i}>{s.replace(/^[-•]\s*/, "")}</li>)}
              </ul>
            </div>
          )}

          {/* assinaturas */}
          <div className="orc-bloco" style={{ display: "flex", gap: 40, marginTop: 46 }}>
            {[["CONTRATANTE", c.nome], ["CONTRATADA", EMPRESA.nome]].map(([r, nome]) => (
              <div key={r} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ borderTop: `1.5px solid ${GRAFITE}`, paddingTop: 5, fontSize: 9, fontWeight: 800, letterSpacing: 1, color: GRAFITE }}>{r}</div>
                {nome && <div style={{ fontSize: 9.5, color: "#6b7280" }}>{nome}</div>}
              </div>
            ))}
          </div>

          {/* rodapé */}
          <div className="orc-bloco" style={{ marginTop: 30, borderTop: `2px solid ${VERMELHO}`, paddingTop: 8, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 9, color: "#4b5563" }}>
            <div>
              <div style={{ fontWeight: 800, color: GRAFITE }}>{EMPRESA.nome} · CNPJ {EMPRESA.cnpj}</div>
              <div>{EMPRESA.endereco}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div>{EMPRESA.fones}</div>
              <div>{EMPRESA.email} · {EMPRESA.site}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
