import { useState } from "react";
import { Dinheiro } from "./Sigilo";
import { useComunicacao, nomePessoa } from "./Comunicacao";
import {
  normCompras, itensAguardandoAprovacao, aprovarItem, recusarItem, nomeItemCompra, fmtQuandoISO,
  comprasPorCategoria, saldoPrevisto, CATEGORIA_LABEL,
} from "./ComprasObra";

// ─────────────────────────────────────────────────────────────────────────────
// ✅ Aprovações de compra — a tela de quem tem o acesso 'aprova_compras' (o Marcelo).
// Junta os itens "aguardando aprovação" de todas as obras ativas, com os orçamentos lado a lado.
// Aprovar marca o(s) orçamento(s) escolhido(s) (dois = compra dividida); recusar pede motivo.
// Grava pela obra (updateObra, com a trava de versão) e avisa Compras pelo 🔔.
// ─────────────────────────────────────────────────────────────────────────────

export function contarAguardando(obras) {
  return obras.reduce((n, o) => n + itensAguardandoAprovacao(o).length, 0);
}

function trocarItem(obra, cat, novo) {
  const c = normCompras(obra.compras);
  return { ...obra, compras: { ...c, [cat]: { ...c[cat], itens: c[cat].itens.map(it => it.id === novo.id ? novo : it) } } };
}

function ItemPendente({ obra, cat, item, n, quem, onDecidir }) {
  const [sel, setSel] = useState(() => new Set());
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const a = item.aprovacao;
  const orcs = item.fornecedores.filter(f => f.orcamento.valor > 0 || f.nome);
  const menor = orcs.filter(f => f.orcamento.valor > 0).reduce((m, f) => !m || f.orcamento.valor < m.orcamento.valor ? f : m, null);
  const tCat = comprasPorCategoria(obra)[cat];
  const saldo = saldoPrevisto(tCat);
  const nome = nomeItemCompra(cat, item, n);
  const alternar = id => setSel(s => { const x = new Set(s); x.has(id) ? x.delete(id) : x.add(id); return x; });

  function aprovar() {
    const escolhidos = item.fornecedores.filter(f => sel.has(f.id));
    onDecidir(trocarItem(obra, cat, aprovarItem(item, [...sel], quem)), {
      tipo: "compra_aprovada", texto: `${nome} — ${escolhidos.map(f => f.nome || "sem nome").join(" + ")}`,
      atividade: `Compra aprovada por ${quem.nome}: ${nome} — ${escolhidos.map(f => f.nome || "sem nome").join(" + ")}`,
      cat, itemId: item.id, para: a.pedidoPorId || null,
    });
  }
  function recusar() {
    if (!motivo.trim()) return;
    onDecidir(trocarItem(obra, cat, recusarItem(item, motivo.trim(), quem)), {
      tipo: "compra_recusada", texto: `${nome} — ${motivo.trim()}`,
      atividade: `Compra recusada por ${quem.nome}: ${nome} — ${motivo.trim()}`,
      cat, itemId: item.id, para: a.pedidoPorId || null,
    });
  }

  const btn = (cor, ativo = true) => ({ background: ativo ? cor : "#cbd5e1", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: ativo ? "pointer" : "default" });
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 14px", background: "#fff", marginTop: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase" }}>{CATEGORIA_LABEL[cat]}</span>
        <span style={{ fontWeight: 800, fontSize: 14, color: "#1e293b", flex: "1 1 200px" }}>{item.tipo || `Item ${n}`}</span>
        <span style={{ fontSize: 12, color: "#64748b" }}>pedido por <b>{a.pedidoPor || "?"}</b> em {fmtQuandoISO(a.pedidoEm)}</span>
      </div>
      {a.obs && <div style={{ fontSize: 12.5, color: "#92400e", background: "#fffbeb", borderRadius: 6, padding: "5px 9px", marginTop: 6 }}>“{a.obs}”</div>}
      <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>{CATEGORIA_LABEL[cat]} nesta obra — previsto <b><Dinheiro v={tCat.previsto} /></b></span>
        <span>gasto <b><Dinheiro v={tCat.gasto} /></b></span>
        <span>a comprar <b><Dinheiro v={tCat.aComprar} /></b></span>
        {saldo !== null && <span style={{ color: saldo >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{saldo >= 0 ? "economia " : "acima "}<Dinheiro v={Math.abs(saldo)} /></span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8, marginTop: 10 }}>
        {orcs.map(f => {
          const on = sel.has(f.id);
          return (
            <label key={f.id} style={{ border: `2px solid ${on ? "#0891b2" : "#e2e8f0"}`, background: on ? "#ecfeff" : "#fff", borderRadius: 8, padding: "9px 11px", cursor: "pointer", display: "block" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={on} onChange={() => alternar(f.id)} />
                <b style={{ fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.nome || "Sem nome"}</b>
                {menor?.id === f.id && orcs.length > 1 && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#16a34a", border: "1px solid #16a34a55", borderRadius: 999, padding: "0 7px" }}>menor</span>}
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#1e293b", marginTop: 4 }}><Dinheiro v={f.orcamento.valor} /></div>
              {f.orcamento.data && <div style={{ fontSize: 11.5, color: "#94a3b8" }}>orçado em {f.orcamento.data.split("-").reverse().join("/")}</div>}
              {f.orcamento.obs && <div style={{ fontSize: 12, color: "#475569", marginTop: 3 }}>{f.orcamento.obs}</div>}
            </label>
          );
        })}
      </div>

      {!recusando ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={aprovar} disabled={!sel.size} style={btn("#0891b2", sel.size > 0)}>
            ✓ Aprovar {sel.size > 1 ? `os ${sel.size} (compra dividida)` : sel.size ? "o marcado" : ""}
          </button>
          <button onClick={() => setRecusando(true)} style={{ ...btn("#fff"), color: "#dc2626", border: "1px solid #fecaca" }}>✖ Recusar</button>
          {!sel.size && <span style={{ fontSize: 12, color: "#94a3b8" }}>Marque o orçamento que vai ser comprado.</span>}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input value={motivo} onChange={e => setMotivo(e.target.value)} autoFocus placeholder="Motivo (vai para quem pediu): ex. cotar mais um fornecedor"
            onKeyDown={e => { if (e.key === "Enter") recusar(); }}
            style={{ flex: "1 1 260px", border: "1px solid #cbd5e1", borderRadius: 6, padding: "7px 10px", fontSize: 13 }} />
          <button onClick={recusar} disabled={!motivo.trim()} style={btn("#dc2626", !!motivo.trim())}>Recusar</button>
          <button onClick={() => { setRecusando(false); setMotivo(""); }} style={{ ...btn("#fff"), color: "#475569", border: "1px solid #e2e8f0" }}>Cancelar</button>
        </div>
      )}
    </div>
  );
}

export default function AprovacoesCompra({ obras, onAtualizarObra, onAvisoCompra, onAtividade, onAbrirObra }) {
  const com = useComunicacao();
  const eu = com?.eu;
  const podeAprovar = !!(com?.acessosAtivos && com.temAcesso("aprova_compras"));
  const quem = eu ? { id: eu.id, nome: nomePessoa(eu) } : null;
  const porObra = obras.map(o => ({ obra: o, itens: itensAguardandoAprovacao(o) })).filter(x => x.itens.length)
    .sort((a, b) => Math.min(...a.itens.map(i => i.item.aprovacao.pedidoEm ? Date.parse(i.item.aprovacao.pedidoEm) : 0))
      - Math.min(...b.itens.map(i => i.item.aprovacao.pedidoEm ? Date.parse(i.item.aprovacao.pedidoEm) : 0)));
  const total = porObra.reduce((n, x) => n + x.itens.length, 0);

  function decidir(obra, novaObra, aviso) {
    onAtualizarObra(novaObra);
    onAtividade(obra.id, aviso.atividade);
    onAvisoCompra({ tipo: aviso.tipo, obraId: obra.id, texto: aviso.texto, dados: { itens: [{ cat: aviso.cat, itemId: aviso.itemId }] }, para: aviso.para });
  }

  return (
    <div style={{ padding: "20px 24px 40px", maxWidth: 1100 }}>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14, lineHeight: 1.5 }}>
        Pedidos de aprovação de compra de todas as obras, do mais antigo para o mais novo. Marque o orçamento escolhido e aprove — quem pediu recebe o aviso no 🔔 na hora.
      </div>
      {!podeAprovar && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 14 }}>
          Você pode ver os pedidos, mas não tem o acesso <b>Aprova compras</b>. Quem libera acessos é o master, em Configurações.
        </div>
      )}
      {total === 0 && (
        <div style={{ background: "#fff", borderRadius: 10, padding: 24, color: "#94a3b8", fontSize: 14, textAlign: "center" }}>Nenhuma compra esperando aprovação. ✓</div>
      )}
      {porObra.map(({ obra, itens }) => (
        <div key={obra.id} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>#{obra.numero}</span>
            <b style={{ fontSize: 15, flex: "1 1 200px" }}>{obra.obra || obra.cliente}</b>
            <span style={{ fontSize: 12, color: "#64748b" }}>{itens.length} {itens.length === 1 ? "item" : "itens"}</span>
            <button onClick={() => onAbrirObra(obra.id)}
              style={{ background: "#fff", border: "1px solid #cbd5e1", borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: "#334155", cursor: "pointer" }}>
              Abrir Compras da obra
            </button>
          </div>
          {podeAprovar && quem
            ? itens.map(({ cat, item, n }) => (
              <ItemPendente key={`${cat}|${item.id}`} obra={obra} cat={cat} item={item} n={n} quem={quem}
                onDecidir={(nova, aviso) => decidir(obra, nova, aviso)} />
            ))
            : <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: "#475569" }}>
                {itens.map(({ cat, item, n }) => <li key={`${cat}|${item.id}`}>{nomeItemCompra(cat, item, n)} — pedido por {item.aprovacao.pedidoPor || "?"} em {fmtQuandoISO(item.aprovacao.pedidoEm)}</li>)}
              </ul>}
        </div>
      ))}
    </div>
  );
}
