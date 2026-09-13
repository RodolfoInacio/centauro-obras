import { Fragment, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Compras por categoria (Perfil/Pintura/Acessório/Vidro), do jeito que o setor de compras
// trabalha: cada categoria tem vários itens (o vidro temperado 8mm, o laminado 4+4…), cada item
// tem a especificação técnica, o uso de estoque e os orçamentos pedidos aos fornecedores. Cada
// orçamento anda por três etapas — orçamento, compra finalizada e previsão de entrega — cada uma
// com data e comentário, e carrega a nota fiscal da compra.
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIAS_COMPRA = ["perfil", "pintura", "acessorio", "vidro"];
export const CATEGORIA_LABEL = { perfil: "Perfil", pintura: "Pintura", acessorio: "Acessório", vidro: "Vidro" };

// Mesmo motivo do painel de lembretes: toISOString() já é amanhã às 21h no Brasil.
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmt(n) {
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtData(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
const dinheiro = v => Math.max(0, Number(v) || 0);
const ehObjeto = x => x && typeof x === "object";

function novoId(prefixo) {
  return prefixo + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── MODELO ──────────────────────────────────────────────────────────────────
// `aprovadoPadrao` só vale para registro que nasceu antes da flag existir (ver normCategoria).
function normFornecedor(f, idx, aprovadoPadrao = false) {
  const o = f.orcamento || {}, c = f.compra || {}, e = f.entrega || {}, nf = f.nf || {};
  return {
    id: f.id || `fn_${idx}`,
    nome: f.nome || "",
    aprovado: f.aprovado === undefined ? aprovadoPadrao : !!f.aprovado,
    orcamento: { data: o.data || "", valor: dinheiro(o.valor), obs: o.obs || "" },
    compra:    { data: c.data || "", valor: dinheiro(c.valor), obs: c.obs || "" },
    entrega:   { data: e.data || "", recebido: !!e.recebido, obs: e.obs || "" },
    nf:        { numero: nf.numero || "", data: nf.data || "" },
  };
}

function normItemCompra(it, idx, aprovadoPadrao = false) {
  const est = it.estoque || {};
  const forn = Array.isArray(it.fornecedores) ? it.fornecedores : [];
  return {
    id: it.id || `it_${idx}`,
    tipo: it.tipo || "",
    estoque: { usado: est.usado === "sim" || est.usado === "nao" ? est.usado : "", obs: est.obs || "" },
    fornecedores: forn.filter(ehObjeto).map((f, i) => normFornecedor(f, i, aprovadoPadrao)),
  };
}

// Registro da tela antiga (previsto/realizado/dataCompra/previsaoEntrega soltos na categoria).
// Vira duas linhas sem nome: o previsto como orçamento APROVADO ainda não comprado e o realizado
// como compra finalizada. Aprovado porque, sem isso, a compra da outra linha "decidiria" o item e
// o previsto deixaria de contar — o A Pagar mudaria sozinho na carga.
function legadoParaFornecedores(v) {
  const previsto = dinheiro(v.previsto), realizado = dinheiro(v.realizado);
  const out = [];
  if (previsto > 0) out.push({ id: "leg_prev", aprovado: true, orcamento: { valor: previsto, obs: "Previsto lançado na tela antiga" } });
  if (realizado > 0 || v.dataCompra || v.previsaoEntrega) {
    out.push({ id: "leg_real", compra: { valor: realizado, data: v.dataCompra }, entrega: { data: v.previsaoEntrega } });
  }
  return out;
}

// Três formatos convivem no banco; ids fixos nas conversões porque normObra roda a cada carga.
function normCategoria(v) {
  v = v || {};
  let itens;
  if (Array.isArray(v.itens)) {
    itens = v.itens.filter(ehObjeto).map((it, i) => normItemCompra(it, i));
  } else if (v.tipo || (v.fornecedores || []).length || v.estoque?.usado || v.estoque?.obs) {
    // v1: tipo/estoque/fornecedores direto na categoria. Lá os fornecedores sempre somavam,
    // então entram aprovados para o total não mudar.
    itens = [normItemCompra({ id: "it_0", tipo: v.tipo, estoque: v.estoque, fornecedores: v.fornecedores }, 0, true)];
  } else {
    const fs = legadoParaFornecedores(v);
    itens = fs.length ? [normItemCompra({ id: "leg", fornecedores: fs }, 0)] : [];
  }
  return { naoSeAplica: !!v.naoSeAplica, itens };
}

// Undefined-safe, no espírito de normObra: registro antigo abre e cai no formato novo.
export function normCompras(c) {
  return CATEGORIAS_COMPRA.reduce((acc, cat) => {
    acc[cat] = normCategoria((c || {})[cat]);
    return acc;
  }, {});
}

// A compra está finalizada quando tem valor ou data de compra — basta um dos dois.
const comprado = f => f.compra.valor > 0 || !!f.compra.data;
// Linha "ativa" = a que o item vai de fato usar: aprovada ou já comprada.
const ativo = f => f.aprovado || comprado(f);
const decidido = item => item.fornecedores.some(ativo);

// Enquanto ninguém foi aprovado, o orçamento mais barato é a estimativa do item.
function menorOrcamento(item) {
  let menor = null;
  for (const f of item.fornecedores) {
    if (f.orcamento.valor > 0 && (!menor || f.orcamento.valor < menor.orcamento.valor)) menor = f;
  }
  return menor;
}

// "A comprar" nunca soma orçamentos concorrentes: conta os aprovados ainda não comprados (dois
// aprovados = compra dividida) ou, sem aprovação, o mais barato. E nunca subtrai o gasto do
// orçado — a linha comprada simplesmente sai do "a comprar" e entra no "gasto".
function totaisItem(item) {
  let aComprar = 0, gasto = 0;
  for (const f of item.fornecedores) if (comprado(f)) gasto += f.compra.valor;
  if (decidido(item)) {
    for (const f of item.fornecedores) if (f.aprovado && !comprado(f)) aComprar += f.orcamento.valor;
  } else {
    aComprar = menorOrcamento(item)?.orcamento.valor || 0;
  }
  return { aComprar, gasto };
}

function totaisCategoria(v) {
  let aComprar = 0, gasto = 0;
  for (const it of v.itens) {
    const t = totaisItem(it);
    aComprar += t.aComprar;
    gasto += t.gasto;
  }
  return { aComprar, gasto };
}

export function comprasTotais(obra) {
  const compras = normCompras(obra.compras);
  let aComprar = 0, gasto = 0;
  for (const cat of CATEGORIAS_COMPRA) {
    const v = compras[cat];
    if (v.naoSeAplica) continue;   // categoria riscada não entra em nenhum total
    const t = totaisCategoria(v);
    aComprar += t.aComprar;
    gasto += t.gasto;
  }
  return { aComprar, gasto };
}

// Status são DERIVADOS, nunca gravados (mesma regra da etiqueta do lembrete): gravam-se as
// datas, o "aprovado" e o "recebido"; "entrega atrasada" sai da comparação com hoje.
const atrasada = (f, hoje) => comprado(f) && !f.entrega.recebido && f.entrega.data && f.entrega.data < hoje;

function statusFornecedor(f, item, hoje = hojeLocal()) {
  if (f.entrega.recebido) return { rotulo: "Entregue", cor: "#10b981" };
  if (comprado(f)) return atrasada(f, hoje) ? { rotulo: "Entrega atrasada", cor: "#dc2626" } : { rotulo: "Comprado", cor: "#2563eb" };
  if (f.aprovado) return { rotulo: "Aprovado", cor: "#0891b2" };
  if (decidido(item)) return { rotulo: "Não escolhido", cor: "#94a3b8", apagado: true };
  if (f.orcamento.valor > 0 || f.orcamento.data) return { rotulo: "Orçado", cor: "#f59e0b" };
  return { rotulo: "Cotando", cor: "#94a3b8" };
}

function statusItem(item, hoje = hojeLocal()) {
  const ativos = item.fornecedores.filter(ativo);
  if (!ativos.length) {
    if (item.fornecedores.some(f => f.orcamento.valor > 0 || f.orcamento.data)) return { rotulo: "Orçado", cor: "#f59e0b" };
    if (item.estoque.usado === "sim") return { rotulo: "Do estoque", cor: "#7c3aed" };
    return { rotulo: "Cotando", cor: "#94a3b8" };
  }
  if (ativos.some(f => atrasada(f, hoje))) return { rotulo: "Entrega atrasada", cor: "#dc2626" };
  if (ativos.every(f => f.entrega.recebido)) return { rotulo: "Entregue", cor: "#10b981" };
  if (ativos.every(comprado)) return { rotulo: "Comprado", cor: "#2563eb" };
  return { rotulo: "Aprovado", cor: "#0891b2" };
}

// Nomes já usados em qualquer obra, para o campo de fornecedor sugerir enquanto digita.
export function fornecedoresConhecidos(obras) {
  const nomes = new Set();
  for (const o of obras) {
    const compras = normCompras(o.compras);
    for (const cat of CATEGORIAS_COMPRA) {
      for (const it of compras[cat].itens) {
        for (const f of it.fornecedores) {
          const n = f.nome.trim();
          if (n) nomes.add(n);
        }
      }
    }
  }
  return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

// ─── TELA ────────────────────────────────────────────────────────────────────
const COLS = "18px 92px minmax(220px, 1fr) 112px 112px 116px 36px";
const inp = { border: "1px solid #e2e8f0", borderRadius: 5, padding: "4px 6px", fontSize: 12, color: "#1e293b", background: "#fff", boxSizing: "border-box" };
const rotulo = { fontSize: 10, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: 3 };
const DATALIST_ID = "compras-fornecedores";

function Chip({ cor, children, title }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: cor + "1a", color: cor, border: `1px solid ${cor}55`, borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function CampoValor({ value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#64748b" }}>R$</span>
      <input type="number" min={0} step="0.01" value={value || ""} placeholder="0,00"
        onChange={e => onChange(dinheiro(e.target.value))}
        style={{ ...inp, width: "100%", textAlign: "right" }} />
    </div>
  );
}

function Comentario({ value, onChange }) {
  return (
    <textarea value={value} onChange={e => onChange(e.target.value)} rows={2} placeholder="Comentário"
      style={{ ...inp, width: "100%", resize: "vertical", fontFamily: "inherit", marginTop: 6 }} />
  );
}

function Etapa({ titulo, cor, children }) {
  return (
    <div style={{ border: `1px solid ${cor}40`, borderTop: `3px solid ${cor}`, borderRadius: 6, padding: "8px 10px", background: "#fff" }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: cor, marginBottom: 6 }}>{titulo}</div>
      {children}
    </div>
  );
}

function CartaoFornecedor({ f, n, st, menor, onChange, onRemover }) {
  const set = (etapa, campo, valor) => onChange({ ...f, [etapa]: { ...f[etapa], [campo]: valor } });
  return (
    <div style={{ background: "#fff", border: `1px solid ${f.aprovado ? "#0891b255" : "#e2e8f0"}`, borderRadius: 8, padding: 10, opacity: st.apagado ? 0.6 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>Orçamento {n}</span>
        <input value={f.nome} list={DATALIST_ID} placeholder="Nome do fornecedor"
          onChange={e => onChange({ ...f, nome: e.target.value })}
          style={{ ...inp, fontSize: 13, fontWeight: 700, flex: "1 1 200px", maxWidth: 320 }} />
        <Chip cor={st.cor}>{st.rotulo}</Chip>
        {menor && <Chip cor="#16a34a" title="Enquanto nenhum orçamento é aprovado, é este que conta no A comprar">menor</Chip>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {!comprado(f) && (
            <button type="button" onClick={() => onChange({ ...f, aprovado: !f.aprovado })}
              title={f.aprovado ? "Desfazer aprovação" : "Este é o orçamento que vai ser comprado"}
              style={f.aprovado
                ? { background: "#0891b2", color: "#fff", border: "1px solid #0891b2", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }
                : { background: "#fff", color: "#0891b2", border: "1px solid #0891b2", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {f.aprovado ? "✓ Aprovado" : "Aprovar"}
            </button>
          )}
          <button type="button" onClick={onRemover} title="Remover este orçamento"
            style={{ background: "transparent", color: "#94a3b8", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>
            Remover
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
        <Etapa titulo="Orçamento realizado" cor="#f59e0b">
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center" }}>
            <input type="date" value={f.orcamento.data} onChange={e => set("orcamento", "data", e.target.value)} style={inp} />
            <CampoValor value={f.orcamento.valor} onChange={v => set("orcamento", "valor", v)} />
          </div>
          <Comentario value={f.orcamento.obs} onChange={v => set("orcamento", "obs", v)} />
        </Etapa>
        <Etapa titulo="Compra finalizada" cor="#2563eb">
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, alignItems: "center" }}>
            <input type="date" value={f.compra.data} onChange={e => set("compra", "data", e.target.value)} style={inp} />
            <CampoValor value={f.compra.valor} onChange={v => set("compra", "valor", v)} />
          </div>
          <Comentario value={f.compra.obs} onChange={v => set("compra", "obs", v)} />
        </Etapa>
        <Etapa titulo="Previsão de entrega" cor="#10b981">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" value={f.entrega.data} onChange={e => set("entrega", "data", e.target.value)} style={inp} />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#1e293b", cursor: "pointer" }}>
              <input type="checkbox" checked={f.entrega.recebido} onChange={e => set("entrega", "recebido", e.target.checked)} />
              Entregue
            </label>
          </div>
          <Comentario value={f.entrega.obs} onChange={v => set("entrega", "obs", v)} />
        </Etapa>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>🧾 Nota fiscal</span>
        <input value={f.nf.numero} placeholder="Nº da NF" onChange={e => set("nf", "numero", e.target.value)} style={{ ...inp, width: 140 }} />
        <span style={{ fontSize: 11, color: "#94a3b8" }}>emissão</span>
        <input type="date" value={f.nf.data} onChange={e => set("nf", "data", e.target.value)} style={inp} />
      </div>
    </div>
  );
}

function CartaoItem({ item, n, aberto, onAlternar, onChange, onRemover }) {
  const hoje = hojeLocal();
  const st = statusItem(item, hoje);
  const t = totaisItem(item);
  const menor = decidido(item) ? null : menorOrcamento(item);
  const qtdOrc = item.fornecedores.length;

  const setForn = (id, novo) => onChange({ ...item, fornecedores: item.fornecedores.map(f => f.id === id ? novo : f) });
  function adicionarOrcamento() {
    onChange({ ...item, fornecedores: [...item.fornecedores, normFornecedor({ id: novoId("fn_") })] });
  }
  function removerOrcamento(f) {
    const temDado = f.nome || f.orcamento.valor || f.compra.valor || f.orcamento.data || f.compra.data || f.nf.numero;
    if (temDado && !window.confirm(`Remover o orçamento ${f.nome || "sem nome"}?`)) return;
    onChange({ ...item, fornecedores: item.fornecedores.filter(x => x.id !== f.id) });
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #dbe3ec", borderRadius: 10, overflow: "hidden" }}>
      <div onClick={onAlternar}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer", background: aberto ? "#f1f5f9" : "#fff", flexWrap: "wrap" }}>
        <span style={{ color: "#94a3b8", fontSize: 11, width: 10 }}>{aberto ? "▼" : "▶"}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: "#475569", whiteSpace: "nowrap" }}>Item {n}</span>
        <span title={item.tipo} style={{ fontSize: 13, fontWeight: 600, color: item.tipo ? "#1e293b" : "#cbd5e1", fontStyle: item.tipo ? "normal" : "italic", flex: "1 1 180px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.tipo || "sem especificação"}
        </span>
        <Chip cor={st.cor}>{st.rotulo}</Chip>
        <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>{qtdOrc} orçamento{qtdOrc === 1 ? "" : "s"}</span>
        <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>A comprar <b style={{ color: t.aComprar > 0 ? "#dc2626" : "#1e293b" }}>R$ {fmt(t.aComprar)}</b></span>
        <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>Gasto <b style={{ color: "#1e293b" }}>R$ {fmt(t.gasto)}</b></span>
        <button type="button" onClick={e => { e.stopPropagation(); onRemover(); }} title="Remover este item"
          style={{ background: "transparent", color: "#94a3b8", border: "1px solid #e2e8f0", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}>
          Remover item
        </button>
      </div>

      {aberto && (
        <div style={{ padding: "10px 12px 12px", borderTop: "1px solid #eef2f7" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={rotulo}>Tipo / especificação técnica</label>
              <textarea value={item.tipo} rows={2} onChange={e => onChange({ ...item, tipo: e.target.value })}
                placeholder="Ex.: vidro temperado 8 mm incolor · 12 peças · linha Suprema"
                style={{ ...inp, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
            </div>
            <div>
              <label style={rotulo}>Itens de estoque</label>
              <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <select value={item.estoque.usado} onChange={e => onChange({ ...item, estoque: { ...item.estoque, usado: e.target.value } })}
                  style={{ ...inp, width: 150 }}>
                  <option value="">Não informado</option>
                  <option value="nao">Não usou estoque</option>
                  <option value="sim">Usou estoque</option>
                </select>
                <textarea value={item.estoque.obs} rows={2} onChange={e => onChange({ ...item, estoque: { ...item.estoque, obs: e.target.value } })}
                  placeholder={item.estoque.usado === "sim" ? "O que saiu do estoque e quanto" : "Observação"}
                  style={{ ...inp, flex: 1, resize: "vertical", fontFamily: "inherit" }} />
              </div>
            </div>
          </div>

          <label style={rotulo}>Orçamentos</label>
          {qtdOrc > 1 && !decidido(item) && (
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
              Nenhum aprovado ainda — o A comprar usa o orçamento mais barato. Aprove o escolhido (ou dois, se a compra for dividida).
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {qtdOrc === 0 && (
              <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>Nenhum orçamento lançado ainda.</div>
            )}
            {item.fornecedores.map((f, i) => (
              <CartaoFornecedor key={f.id} f={f} n={i + 1} st={statusFornecedor(f, item, hoje)} menor={menor?.id === f.id && qtdOrc > 1}
                onChange={novo => setForn(f.id, novo)} onRemover={() => removerOrcamento(f)} />
            ))}
          </div>
          <button type="button" onClick={adicionarOrcamento}
            style={{ marginTop: 8, border: "1px dashed #94a3b8", color: "#475569", background: "#fff", borderRadius: 8, padding: "4px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            + Adicionar orçamento
          </button>
        </div>
      )}
    </div>
  );
}

function CorpoCategoria({ v, onChange }) {
  // Com um item só, já abre direto nele; com vários, começa tudo fechado para dar o panorama.
  const [abertos, setAbertos] = useState(() => new Set(v.itens.length === 1 ? [v.itens[0].id] : []));
  const t = totaisCategoria(v);

  const alternar = id => setAbertos(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const setItem = (id, novo) => onChange({ ...v, itens: v.itens.map(it => it.id === id ? novo : it) });
  function adicionarItem() {
    const it = normItemCompra({ id: novoId("it_"), fornecedores: [{ id: novoId("fn_") }] }, 0);
    onChange({ ...v, itens: [...v.itens, it] });
    setAbertos(s => new Set(s).add(it.id));
  }
  function removerItem(it) {
    const temDado = it.tipo || it.fornecedores.some(f => f.nome || f.orcamento.valor || f.compra.valor);
    if (temDado && !window.confirm(`Remover o item "${it.tipo || "sem especificação"}" e todos os orçamentos dele?`)) return;
    onChange({ ...v, itens: v.itens.filter(x => x.id !== it.id) });
  }

  return (
    <div style={{ padding: "12px 12px 14px 30px", background: "#f8fafc", borderTop: "1px solid #eef2f7" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {v.itens.length === 0 && (
          <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>Nenhum item lançado ainda.</div>
        )}
        {v.itens.map((it, i) => (
          <CartaoItem key={it.id} item={it} n={i + 1} aberto={abertos.has(it.id)} onAlternar={() => alternar(it.id)}
            onChange={novo => setItem(it.id, novo)} onRemover={() => removerItem(it)} />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={adicionarItem}
          style={{ border: "1px dashed #c9a227", color: "#a16207", background: "#fffbeb", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          + Adicionar item
        </button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 18, fontSize: 12 }}>
          <span style={{ color: "#64748b" }}>A comprar: <b style={{ color: t.aComprar > 0 ? "#dc2626" : "#1e293b" }}>R$ {fmt(t.aComprar)}</b></span>
          <span style={{ color: "#64748b" }}>Valor total gasto: <b style={{ color: "#1e293b", fontSize: 13 }}>R$ {fmt(t.gasto)}</b></span>
        </div>
      </div>
    </div>
  );
}

export default function ComprasObra({ compras, onChange, sugestoes = [] }) {
  const [abertas, setAbertas] = useState(() => new Set());
  const hoje = hojeLocal();
  const c = normCompras(compras);
  const total = comprasTotais({ compras: c });

  const alternar = cat => setAbertas(s => {
    const n = new Set(s);
    n.has(cat) ? n.delete(cat) : n.add(cat);
    return n;
  });
  const setCat = (cat, v) => onChange({ ...c, [cat]: v });

  const th = { fontSize: 11, color: "#94a3b8", fontWeight: 700 };
  return (
    <div style={{ overflowX: "auto" }}>
      <datalist id={DATALIST_ID}>
        {sugestoes.map(n => <option key={n} value={n} />)}
      </datalist>
      <div style={{ minWidth: 760, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, padding: "6px 10px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <span />
          <span style={th}>Categoria</span>
          <span style={th}>Itens</span>
          <span style={{ ...th, textAlign: "right" }}>A comprar</span>
          <span style={{ ...th, textAlign: "right" }}>Total gasto</span>
          <span style={th}>Próx. entrega</span>
          <span style={{ ...th, textAlign: "center" }} title="Não se aplica a esta obra">N/A</span>
        </div>

        {CATEGORIAS_COMPRA.map((cat, idx) => {
          const v = c[cat];
          const na = v.naoSeAplica;
          const aberta = abertas.has(cat) && !na;
          const t = totaisCategoria(v);
          // Próxima entrega: a mais cedo entre o que já foi comprado e ainda não chegou.
          const pendentes = v.itens.flatMap(it => it.fornecedores)
            .filter(f => comprado(f) && !f.entrega.recebido && f.entrega.data).map(f => f.entrega.data).sort();
          const prox = pendentes[0] || "";
          const usouEstoque = v.itens.filter(it => it.estoque.usado === "sim");
          return (
            <Fragment key={cat}>
              <div onClick={() => !na && alternar(cat)}
                style={{
                  display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center", padding: "8px 10px",
                  borderTop: idx ? "1px solid #eef2f7" : "none", cursor: na ? "default" : "pointer",
                  background: aberta ? "#f8fafc" : "#fff", opacity: na ? 0.45 : 1,
                }}>
                <span style={{ color: "#94a3b8", fontSize: 11 }}>{na ? "" : aberta ? "▼" : "▶"}</span>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#1e293b", textDecoration: na ? "line-through" : "none" }}>{CATEGORIA_LABEL[cat]}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                  {v.itens.map((it, i) => {
                    const st = statusItem(it, hoje);
                    const nome = it.tipo || `Item ${i + 1}`;
                    return (
                      <Chip key={it.id} cor={st.cor} title={`${nome} — ${st.rotulo}`}>
                        {nome.length > 28 ? nome.slice(0, 27) + "…" : nome}
                      </Chip>
                    );
                  })}
                  {usouEstoque.length > 0 && (
                    <Chip cor="#7c3aed" title={usouEstoque.map(it => it.estoque.obs || it.tipo || "item").join(" · ")}>estoque</Chip>
                  )}
                  {v.itens.length === 0 && !na && (
                    <span style={{ fontSize: 12, color: "#cbd5e1", fontStyle: "italic" }}>clique para lançar</span>
                  )}
                </div>
                <span style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: !na && t.aComprar > 0 ? "#dc2626" : "#1e293b" }}>R$ {fmt(na ? 0 : t.aComprar)}</span>
                <span style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: "#1e293b" }}>R$ {fmt(na ? 0 : t.gasto)}</span>
                <span style={{ fontSize: 12, fontWeight: prox && prox < hoje ? 800 : 400, color: prox && prox < hoje ? "#dc2626" : "#475569" }}>{fmtData(prox)}</span>
                <span style={{ textAlign: "center" }} onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={na} title="Não se aplica a esta obra"
                    onChange={e => setCat(cat, { ...v, naoSeAplica: e.target.checked })}
                    style={{ cursor: "pointer" }} />
                </span>
              </div>
              {aberta && <CorpoCategoria v={v} onChange={nv => setCat(cat, nv)} />}
            </Fragment>
          );
        })}

        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, padding: "8px 10px", borderTop: "1px solid #e2e8f0", background: "#f8fafc" }}>
          <span />
          <span style={{ fontWeight: 800, fontSize: 13 }}>Total</span>
          <span />
          <span style={{ textAlign: "right", fontWeight: 800, fontSize: 13, color: total.aComprar > 0 ? "#dc2626" : "#1e293b" }}>R$ {fmt(total.aComprar)}</span>
          <span style={{ textAlign: "right", fontWeight: 800, fontSize: 13 }}>R$ {fmt(total.gasto)}</span>
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
