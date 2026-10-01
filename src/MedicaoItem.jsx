// ─────────────────────────────────────────────────────────────────────────────
// MEDIÇÃO DO ITEM (plano de corte) — uma linha por unidade do item: largura, altura,
// contramarco, ambiente e observação. É o que a equipe anota na obra na folha "Ordem de
// Medição" (MedicaoPrint.jsx), agora digitado no sistema.
//
// Fica em `item.medicao`, no jsonb da obra, e SEPARADO do L×H do orçamento: o PDF continua
// dizendo o que foi vendido, a medição diz o que vai ser fabricado, e a diferença aparece em
// destaque. Reimportar o PDF não apaga a medição (mesclarImportacao preserva o campo).
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from "react";

export const AMBIENTES = [
  "Sala", "Cozinha", "Suíte master", "Suíte", "Quarto", "Banheiro", "Lavabo", "Área de serviço",
  "Gourmet", "Sacada", "Varanda", "Corredor", "Entrada", "Frente", "Fachada", "Escada", "Garagem",
  "Closet", "Escritório", "Hall",
];
const OUTRO = "__outro";
const TOLERANCIA_MM = 10; // diferença do orçamento que já merece destaque

const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
const ambienteDaLista = (txt) => AMBIENTES.find(a => semAcento(a) === semAcento(txt)) || null;

export const UNIDADE_VAZIA = { L: "", H: "", contramarco: "", ambiente: "", obs: "" };

export function qtdUnidades(item) {
  const n = Math.round(Number(item?.qtd) || 0);
  return Math.min(Math.max(n, 1), 200);
}

// Completa as unidades até a quantidade do item. Nunca corta linha preenchida: se a quantidade
// diminuiu (PDF reimportado), a sobra preenchida continua aparecendo até alguém apagar.
export function normMedicao(m, qtd) {
  const n = Math.min(Math.max(Math.round(Number(qtd) || 0), 1), 200);
  const src = Array.isArray(m?.unidades) ? m.unidades : [];
  const unidades = src.map(u => ({
    L: u?.L == null ? "" : String(u.L),
    H: u?.H == null ? "" : String(u.H),
    contramarco: u?.contramarco === "sim" || u?.contramarco === "nao" ? u.contramarco : "",
    ambiente: String(u?.ambiente || ""),
    obs: String(u?.obs || ""),
  }));
  const preenchida = u => u.L || u.H || u.contramarco || u.ambiente || u.obs;
  while (unidades.length > n && !preenchida(unidades[unidades.length - 1])) unidades.pop();
  while (unidades.length < n) unidades.push({ ...UNIDADE_VAZIA });
  return { unidades, medidoPor: String(m?.medidoPor || ""), medidoEm: String(m?.medidoEm || "") };
}

const unidadeMedida = u => Number(u.L) > 0 && Number(u.H) > 0 && (u.contramarco === "sim" || u.contramarco === "nao");

export function contagemMedicao(item) {
  const { unidades } = normMedicao(item?.medicao, qtdUnidades(item));
  return { feitas: unidades.filter(unidadeMedida).length, total: unidades.length };
}
// Item medido = toda unidade com largura, altura e contramarco respondido.
export function medicaoCompleta(item) {
  const { feitas, total } = contagemMedicao(item);
  return total > 0 && feitas >= total;
}
export function difereDoOrcamento(valor, orcado) {
  const v = Number(valor), o = Number(orcado);
  return v > 0 && o > 0 && Math.abs(v - o) > TOLERANCIA_MM;
}

function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const inp = { border: "1px solid #e2e8f0", borderRadius: 6, padding: "5px 6px", fontSize: 12, boxSizing: "border-box", width: "100%", background: "#fff", color: "#1e293b" };
const th = { fontSize: 9.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", textAlign: "left", padding: "0 4px 4px" };

export function ChipMedicao({ item }) {
  const { feitas, total } = contagemMedicao(item);
  const ok = feitas >= total;
  return (
    <span title={ok ? "Medição completa" : `${feitas} de ${total} unidade(s) medidas`}
      style={{ fontSize: 9.5, fontWeight: 800, borderRadius: 999, padding: "0 6px", marginLeft: 6,
        background: ok ? "#dcfce7" : feitas ? "#fef3c7" : "#f1f5f9", color: ok ? "#166534" : feitas ? "#92400e" : "#94a3b8" }}>
      📐 {feitas}/{total}
    </span>
  );
}

export default function MedicaoItem({ item, onChange }) {
  const med = normMedicao(item.medicao, qtdUnidades(item));
  const { feitas, total } = contagemMedicao(item);
  // Linhas em que o usuário escolheu "Outro…" e ainda não digitou nada.
  const [outroAberto, setOutroAberto] = useState(() => new Set());

  function gravar(proxima) {
    onChange({ ...proxima, medidoEm: proxima.medidoEm || hojeLocal() });
  }
  function mudar(i, campo, valor) {
    gravar({ ...med, unidades: med.unidades.map((u, j) => j === i ? { ...u, [campo]: valor } : u) });
  }
  // Só números: um <input type="number"> controlado mostrava "035" (ver InputPercent).
  const soDigitos = v => v.replace(/\D/g, "").slice(0, 5);

  function copiarOrcamento() {
    gravar({
      ...med,
      unidades: med.unidades.map(u => ({
        ...u,
        L: u.L || (Number(item.L) > 0 ? String(item.L) : ""),
        H: u.H || (Number(item.H) > 0 ? String(item.H) : ""),
        ambiente: u.ambiente || item.localizacao || "",
      })),
    });
  }
  function repetirAcima(i) {
    if (i === 0) return;
    const a = med.unidades[i - 1];
    gravar({ ...med, unidades: med.unidades.map((u, j) => j === i ? { ...a, obs: u.obs } : u) });
  }

  return (
    <div onClick={ev => ev.stopPropagation()}
      style={{ background: "#fff", borderRadius: 10, padding: 14, border: "1px solid #e2e8f0", minWidth: 520, flex: "1 1 520px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" }}>📐 Medição (plano de corte)</span>
        <span style={{ fontSize: 10.5, fontWeight: 800, color: feitas >= total ? "#16a34a" : "#b45309" }}>{feitas}/{total} medida{total > 1 ? "s" : ""}</span>
        <button onClick={copiarOrcamento} title="Preenche largura, altura e ambiente vazios com os do orçamento"
          style={{ marginLeft: "auto", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 700, color: "#334155", cursor: "pointer" }}>
          Copiar do orçamento
        </button>
      </div>

      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
        Orçado: <b>{item.L || "—"} × {item.H || "—"} mm</b> · {total} unidade{total > 1 ? "s" : ""}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 22 }}>#</th>
              <th style={{ ...th, width: 70 }}>Largura</th>
              <th style={{ ...th, width: 70 }}>Altura</th>
              <th style={{ ...th, width: 92 }}>Contramarco</th>
              <th style={{ ...th, width: 150 }}>Ambiente</th>
              <th style={th}>Observação</th>
              <th style={{ ...th, width: 24 }} />
            </tr>
          </thead>
          <tbody>
            {med.unidades.map((u, i) => {
              const daLista = ambienteDaLista(u.ambiente);
              const mostraOutro = outroAberto.has(i) || (u.ambiente && !daLista);
              const valorSelect = daLista || (mostraOutro ? OUTRO : "");
              const difL = difereDoOrcamento(u.L, item.L), difH = difereDoOrcamento(u.H, item.H);
              return (
                <tr key={i} style={{ background: unidadeMedida(u) ? "#f0fdf4" : "transparent" }}>
                  <td style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", padding: "3px 4px" }}>{i + 1}</td>
                  <td style={{ padding: "3px 4px" }}>
                    <input value={u.L} inputMode="numeric" placeholder={String(item.L || "")}
                      onChange={e => mudar(i, "L", soDigitos(e.target.value))}
                      title={difL ? `Diferente do orçado (${item.L} mm)` : ""}
                      style={{ ...inp, ...(difL ? { borderColor: "#f59e0b", background: "#fffbeb", fontWeight: 700 } : {}) }} />
                  </td>
                  <td style={{ padding: "3px 4px" }}>
                    <input value={u.H} inputMode="numeric" placeholder={String(item.H || "")}
                      onChange={e => mudar(i, "H", soDigitos(e.target.value))}
                      title={difH ? `Diferente do orçado (${item.H} mm)` : ""}
                      style={{ ...inp, ...(difH ? { borderColor: "#f59e0b", background: "#fffbeb", fontWeight: 700 } : {}) }} />
                  </td>
                  <td style={{ padding: "3px 4px", whiteSpace: "nowrap" }}>
                    {["sim", "nao"].map(v => (
                      <button key={v} onClick={() => mudar(i, "contramarco", u.contramarco === v ? "" : v)}
                        style={{ border: "1px solid " + (u.contramarco === v ? "#1a1a1a" : "#e2e8f0"), background: u.contramarco === v ? "#1a1a1a" : "#fff",
                          color: u.contramarco === v ? "#fff" : "#475569", borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", marginRight: 3 }}>
                        {v === "sim" ? "Sim" : "Não"}
                      </button>
                    ))}
                  </td>
                  <td style={{ padding: "3px 4px" }}>
                    <select value={valorSelect}
                      onChange={e => {
                        const v = e.target.value;
                        setOutroAberto(prev => { const n = new Set(prev); if (v === OUTRO) n.add(i); else n.delete(i); return n; });
                        mudar(i, "ambiente", v === OUTRO ? (daLista ? "" : u.ambiente) : v);
                      }}
                      style={inp}>
                      <option value="">{item.localizacao ? `— (${item.localizacao})` : "—"}</option>
                      {AMBIENTES.map(a => <option key={a} value={a}>{a}</option>)}
                      <option value={OUTRO}>Outro…</option>
                    </select>
                    {mostraOutro && (
                      <input value={u.ambiente} placeholder="Digite o ambiente" autoFocus={outroAberto.has(i) && !u.ambiente}
                        onChange={e => mudar(i, "ambiente", e.target.value)} style={{ ...inp, marginTop: 3 }} />
                    )}
                  </td>
                  <td style={{ padding: "3px 4px" }}>
                    <input value={u.obs} onChange={e => mudar(i, "obs", e.target.value)} style={inp} />
                  </td>
                  <td style={{ padding: "3px 0" }}>
                    {i > 0 && (
                      <button onClick={() => repetirAcima(i)} title="Repetir a linha de cima"
                        style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "#64748b" }}>⤓</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 10, color: "#94a3b8", flex: "1 1 180px" }}>Medido por
          <input value={med.medidoPor} onChange={e => gravar({ ...med, medidoPor: e.target.value })} placeholder="Nome de quem mediu" style={{ ...inp, marginTop: 2 }} />
        </label>
        <label style={{ fontSize: 10, color: "#94a3b8", flex: "0 1 150px" }}>Data da medição
          <input type="date" value={med.medidoEm} onChange={e => onChange({ ...med, medidoEm: e.target.value })} style={{ ...inp, marginTop: 2 }} />
        </label>
      </div>
    </div>
  );
}
