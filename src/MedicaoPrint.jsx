// ─────────────────────────────────────────────────────────────────────────────
// ORDEM DE MEDIÇÃO — folha impressa no mesmo desenho da "Ordem Medição" do wvetro: um bloco por
// item (ambiente, tipo, cores, desenho) e uma tabela com a linha do orçado e uma linha por
// unidade. "Em branco" deixa as linhas para anotar à mão na obra; "preenchida" traz o que foi
// lançado em MedicaoItem. Sem valores em R$: é folha de campo.
// Receita de impressão igual à do CronogramaPrint (view em tela cheia, .no-print, @page).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import logoDark from "./assets/logo-dark.png";
import { normMedicao, qtdUnidades, difereDoOrcamento } from "./MedicaoItem";

const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnDourado = { background: "#c9a227", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const p2 = n => String(n).padStart(2, "0");
const dataBR = iso => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const agoraBR = () => { const d = new Date(); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

const cel = { border: "1px solid #1a1a1a", padding: "4px 6px", fontSize: 11, height: 22, textAlign: "center", verticalAlign: "middle" };
const cab = { ...cel, fontSize: 9.5, fontWeight: 700, background: "#f1f5f9", height: 18 };
const rot = { fontSize: 10, color: "#475569", fontWeight: 700, marginRight: 4 };

export default function MedicaoPrint({ obra, modoInicial = "preenchida", onBack }) {
  const [modo, setModo] = useState(modoInicial === "branco" ? "branco" : "preenchida");
  const [soPendentes, setSoPendentes] = useState(false);
  const cad = obra.cadastro || {};

  useEffect(() => {
    const antes = document.title;
    document.title = `Ordem de medição — #${obra.numero} ${obra.cliente || ""}`;
    return () => { document.title = antes; };
  }, [obra.numero, obra.cliente]);

  const itens = (obra.itens || []).filter(it => {
    if (!soPendentes) return true;
    const { unidades } = normMedicao(it.medicao, qtdUnidades(it));
    return unidades.some(u => !(Number(u.L) > 0 && Number(u.H) > 0 && u.contramarco));
  });

  return (
    <div style={{ padding: 24, maxWidth: 1120, margin: "0 auto", color: "#1e293b", background: "#fff", minHeight: "100vh" }}>
      <style>{`
        @page { size: A4 landscape; margin: 9mm; }
        @media print {
          html, body { background: #fff !important; }
          .om-folha { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .om-item { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>

      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 14px" }}>
        <button onClick={onBack} style={btnEscuro}>← Voltar</button>
        <div style={{ display: "inline-flex", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
          {[["preenchida", "Preenchida"], ["branco", "Em branco (anotar à mão)"]].map(([k, r]) => (
            <button key={k} onClick={() => setModo(k)}
              style={{ background: modo === k ? "#1a1a1a" : "#fff", color: modo === k ? "#fff" : "#334155", border: "none", padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{r}</button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", cursor: "pointer" }}>
          <input type="checkbox" checked={soPendentes} onChange={e => setSoPendentes(e.target.checked)} /> Só itens ainda não medidos
        </label>
        <span style={{ fontSize: 12, color: "#64748b" }}>Use “Salvar como PDF” no diálogo para gerar o arquivo.</span>
        <button onClick={() => window.print()} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir</button>
      </div>

      <div className="om-folha">
        {/* ── cabeçalho ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, borderBottom: "2px solid #1a1a1a", paddingBottom: 8, marginBottom: 8 }}>
          <img src={logoDark} alt="Centauro Esquadrias" style={{ height: 44 }} />
          <div style={{ flex: 1, fontSize: 10, color: "#334155", lineHeight: 1.45 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#1a1a1a" }}>CENTAURO ESQUADRIAS</div>
            Av. Damião Botelho de Souza, 70 — Centro · Guaratuba | PR<br />
            (41) 3442-2144 · comercial@esquadriascentauro.com.br
          </div>
          <div style={{ borderLeft: "2px solid #1a1a1a", paddingLeft: 12, fontSize: 11, lineHeight: 1.5, minWidth: 220 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a1a" }}>ORDEM DE MEDIÇÃO</div>
            Número: <b>{obra.numero}</b><br />
            Emissão: {agoraBR()}<br />
            {obra.vendedor ? <>Vendedor: {obra.vendedor}</> : null}
          </div>
        </div>

        {/* ── cliente ── */}
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "3px 16px", fontSize: 11, marginBottom: 12, borderBottom: "1px solid #cbd5e1", paddingBottom: 8 }}>
          <div><span style={rot}>NOME:</span>{obra.cliente}</div>
          <div style={{ gridColumn: "span 2" }}><span style={rot}>TELEFONES:</span>{cad.telefones}</div>
          <div><span style={rot}>OBRA:</span>{obra.obra}</div>
          <div style={{ gridColumn: "span 2" }}><span style={rot}>CIDADE:</span>{obra.cidade}</div>
          <div><span style={rot}>RESP. OBRA:</span>{cad.contatoNome}</div>
          <div style={{ gridColumn: "span 2" }}><span style={rot}>LINHA / COR:</span>{[cad.linha, cad.cor].filter(Boolean).join(" · ")}</div>
          <div style={{ gridColumn: "1 / -1" }}><span style={rot}>END. ENTREGA:</span>{cad.enderecoObra}</div>
        </div>

        {itens.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
            {soPendentes ? "Todos os itens já foram medidos." : "Esta obra ainda não tem itens."}
          </div>
        )}

        {itens.map(it => {
          const med = normMedicao(it.medicao, qtdUnidades(it));
          return (
            <div key={it.id} className="om-item" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", fontSize: 11, marginBottom: 4 }}>
                <span><span style={rot}>*LOCAL/AMBIENTE:</span><b>{it.localizacao || "—"}</b></span>
                <span style={{ marginLeft: "auto" }}><span style={rot}>ITEM:</span>#{it.id}</span>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ width: 96, height: 86, border: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {it.desenho
                    ? <img src={it.desenho} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} />
                    : <span style={{ fontSize: 9, color: "#cbd5e1" }}>sem desenho</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#1a1a1a", marginBottom: 6 }}>
                    {it.tipo && <span style={{ marginRight: 10 }}>{it.tipo}</span>}{it.descricao}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 10.5, marginBottom: 6 }}>
                    <div><span style={rot}>COR ESQUADRIA:</span>{it.perfil}</div>
                    <div><span style={rot}>COR VIDRO:</span>{it.vidro}</div>
                    <div><span style={rot}>COR ACESSÓRIO:</span>{it.acessorios}</div>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...cab, width: 60 }} />
                        <th style={{ ...cab, width: 50 }}>QTDE.</th>
                        <th style={{ ...cab, width: 80 }}>LARGURA</th>
                        <th style={{ ...cab, width: 80 }}>ALTURA</th>
                        <th style={{ ...cab, width: 90 }}>CONTRAMARCO</th>
                        <th style={{ ...cab, width: 150 }}>AMBIENTE</th>
                        <th style={cab}>OBSERVAÇÃO</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ ...cel, fontSize: 9.5, fontWeight: 700, background: "#f8fafc" }}>Orçado</td>
                        <td style={cel}>{it.qtd}</td>
                        <td style={cel}>{it.L}</td>
                        <td style={cel}>{it.H}</td>
                        <td style={cel} />
                        <td style={cel}>{it.localizacao}</td>
                        <td style={{ ...cel, textAlign: "left" }} />
                      </tr>
                      {med.unidades.map((u, i) => {
                        const v = modo === "preenchida";
                        const marca = (dif) => v && dif ? { fontWeight: 800, textDecoration: "underline" } : {};
                        return (
                          <tr key={i}>
                            <td style={{ ...cel, fontSize: 9.5, color: "#475569" }}>Un. {i + 1}</td>
                            <td style={cel}>1</td>
                            <td style={{ ...cel, ...marca(difereDoOrcamento(u.L, it.L)) }}>{v ? u.L : ""}</td>
                            <td style={{ ...cel, ...marca(difereDoOrcamento(u.H, it.H)) }}>{v ? u.H : ""}</td>
                            <td style={{ ...cel, fontSize: 10 }}>
                              {v && u.contramarco
                                ? (u.contramarco === "sim" ? "SIM" : "NÃO")
                                : <span style={{ color: "#64748b" }}>☐ SIM &nbsp; ☐ NÃO</span>}
                            </td>
                            <td style={cel}>{v ? u.ambiente : ""}</td>
                            <td style={{ ...cel, textAlign: "left" }}>{v ? u.obs : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ fontSize: 10, marginTop: 4 }}>
                    <span style={rot}>OBSERVAÇÕES PARA O CLIENTE:</span>{it.obs || ""}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* ── assinaturas ── */}
        {itens.length > 0 && (
          <div className="om-item" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 30, marginTop: 34, fontSize: 10.5, textAlign: "center", color: "#334155" }}>
            {[
              ["Medido por", modo === "preenchida" ? (itens.map(i => i.medicao?.medidoPor).find(Boolean) || "") : ""],
              ["Data da medição", modo === "preenchida" ? dataBR(itens.map(i => i.medicao?.medidoEm).find(Boolean) || "") : ""],
              ["Cliente / responsável da obra", ""],
            ].map(([r, v]) => (
              <div key={r}>
                <div style={{ minHeight: 16, fontWeight: 700 }}>{v}</div>
                <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 3 }}>{r}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
