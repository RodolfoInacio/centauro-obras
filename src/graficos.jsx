// ─────────────────────────────────────────────────────────────────────────────
// Gráficos em SVG puro para os relatórios (o projeto não tem lib de gráfico — ver "Gráficos em
// SVG puro" no CLAUDE.md). Pensados para a folha impressa: largura 100%, viewBox fixo, marcas
// finas, grade em linha fina, rótulo só onde ajuda e o valor exato no <title> (dica ao passar o
// mouse) e na tabela que acompanha cada gráfico.
//
// Cores: paleta categórica validada para daltonismo (ordem fixa — a ordem é o que garante a
// separação), cores de status reservadas para status (sempre com ícone + texto) e uma rampa azul
// para escalas ordenadas (etapa 1 → 4). Texto nunca usa a cor da série.
// ─────────────────────────────────────────────────────────────────────────────

export const SERIE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const STATUS = { bom: "#0ca30c", alerta: "#fab219", serio: "#ec835a", critico: "#d03b3b" };
export const RAMPA = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"]; // ordinal, claro → escuro
export const NEUTRO = "#cbd5e1";
const TEXTO = "#1e293b", TEXTO2 = "#52514e", GRADE = "#e7e5e4";

const fmtPadrao = (v) => Number(v || 0).toLocaleString("pt-BR");

// Barra com a ponta de dados arredondada (4px) e a base reta, encostada no eixo.
function barraH(x, y, w, h, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}
function colunaV(x, yBase, w, h, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  const y = yBase - h;
  return `M${x},${yBase}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${yBase}Z`;
}

export function Cartao({ titulo, sub, children, largo = false }) {
  return (
    <div className="rl-bloco" style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 14px", gridColumn: largo ? "1 / -1" : "auto", minWidth: 0 }}>
      {titulo && <div style={{ fontSize: 12.5, fontWeight: 800, color: TEXTO }}>{titulo}</div>}
      {sub && <div style={{ fontSize: 10.5, color: TEXTO2, marginTop: 1 }}>{sub}</div>}
      <div style={{ marginTop: titulo || sub ? 10 : 0 }}>{children}</div>
    </div>
  );
}

export function Kpi({ rotulo, valor, sub, destaque }) {
  return (
    <div className="rl-bloco" style={{ background: "#fff", border: "1px solid #e2e8f0", borderLeft: `4px solid ${destaque || "#e2e8f0"}`, borderRadius: 10, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: TEXTO2, textTransform: "uppercase", letterSpacing: 0.3 }}>{rotulo}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: TEXTO, lineHeight: 1.2, marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 10.5, color: TEXTO2, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export function Legenda({ series }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 10.5, color: TEXTO2, marginBottom: 6 }}>
      {series.map(s => (
        <span key={s.k || s.rotulo} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: s.cor, display: "inline-block", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }} />
          {s.icone ? `${s.icone} ` : ""}{s.rotulo}
        </span>
      ))}
    </div>
  );
}

// Barras horizontais, uma série. dados: [{ rotulo, valor, detalhe? }]
// `largura` é a largura do viewBox: em cartão estreito use menos (ex.: 400), senão o texto encolhe.
export function BarrasH({ dados, cor = SERIE[0], formatar = fmtPadrao, larguraRotulo = 190, max, vazio = "Sem dados.", largura = 640 }) {
  if (!dados.length) return <div style={{ fontSize: 12, color: TEXTO2 }}>{vazio}</div>;
  const W = largura, ALT = 18, GAP = 6, AREA = W - larguraRotulo - 70;
  const topo = max || Math.max(...dados.map(d => d.valor), 1);
  const H = dados.length * (ALT + GAP);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
      {dados.map((d, i) => {
        const y = i * (ALT + GAP);
        const w = Math.max(0, (d.valor / topo) * AREA);
        return (
          <g key={i}>
            <title>{`${d.rotulo}: ${formatar(d.valor)}${d.detalhe ? ` — ${d.detalhe}` : ""}`}</title>
            <text x={larguraRotulo - 8} y={y + ALT / 2 + 4} textAnchor="end" fontSize="11" fill={TEXTO}>{corta(d.rotulo, Math.floor(larguraRotulo / 7))}</text>
            <line x1={larguraRotulo} x2={larguraRotulo} y1={y - GAP / 2} y2={y + ALT + GAP / 2} stroke={GRADE} />
            <path d={barraH(larguraRotulo, y, w, ALT)} fill={d.cor || cor} />
            <text x={larguraRotulo + w + 6} y={y + ALT / 2 + 4} fontSize="11" fill={TEXTO2} style={{ fontVariantNumeric: "tabular-nums" }}>{formatar(d.valor)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// Barras horizontais empilhadas. dados: [{ rotulo, partes: { k: valor } }]; series: [{ k, rotulo, cor }]
// 2px de vão entre os segmentos (cor do fundo), total no fim da barra.
export function BarrasEmpilhadasH({ dados, series, formatar = fmtPadrao, larguraRotulo = 150, legenda = true, max, largura = 640 }) {
  if (!dados.length) return <div style={{ fontSize: 12, color: TEXTO2 }}>Sem dados.</div>;
  const W = largura, ALT = 18, GAP = 7, AREA = W - larguraRotulo - 50;
  const totais = dados.map(d => series.reduce((s, x) => s + (d.partes[x.k] || 0), 0));
  const topo = max || Math.max(...totais, 1);
  const H = dados.length * (ALT + GAP);
  return (
    <div>
      {legenda && <Legenda series={series} />}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
        {dados.map((d, i) => {
          const y = i * (ALT + GAP);
          let x = larguraRotulo;
          const visiveis = series.filter(s => (d.partes[s.k] || 0) > 0);
          return (
            <g key={i}>
              <text x={larguraRotulo - 8} y={y + ALT / 2 + 4} textAnchor="end" fontSize="11" fill={TEXTO}>{corta(d.rotulo, Math.floor(larguraRotulo / 7))}</text>
              <line x1={larguraRotulo} x2={larguraRotulo} y1={y - GAP / 2} y2={y + ALT + GAP / 2} stroke={GRADE} />
              {visiveis.map((s, j) => {
                const v = d.partes[s.k];
                const wCheio = (v / topo) * AREA;
                const ultimo = j === visiveis.length - 1;
                const w = Math.max(0, wCheio - (ultimo ? 0 : 2));
                const el = (
                  <g key={s.k}>
                    <title>{`${d.rotulo} · ${s.rotulo}: ${formatar(v)}`}</title>
                    {ultimo ? <path d={barraH(x, y, w, ALT)} fill={s.cor} /> : <rect x={x} y={y} width={w} height={ALT} fill={s.cor} />}
                    {w > 10 + String(formatar(v)).length * 6 && <text x={x + w / 2} y={y + ALT / 2 + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={tintaSobre(s.cor)}>{formatar(v)}</text>}
                  </g>
                );
                x += wCheio;
                return el;
              })}
              <text x={x + 6} y={y + ALT / 2 + 4} fontSize="11" fill={TEXTO2}>{formatar(totais[i])}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Colunas (série no tempo ou faixas ordenadas). dados: [{ rotulo, valor, destaque? }]
export function Colunas({ dados, cor = SERIE[0], formatar = fmtPadrao, altura = 170, rotularTodas = false, largura = 640, vazio = "Sem dados no período." }) {
  if (!dados.length || dados.every(d => !d.valor)) return <div style={{ fontSize: 12, color: TEXTO2, padding: "18px 0" }}>{vazio}</div>;
  const W = largura, BASE = altura - 24, TOPO = 14, ESQ = 34;
  const max = Math.max(...dados.map(d => d.valor), 1);
  // Contagem não tem meio: com valores inteiros a escala anda de 1 em 1, no mínimo.
  const inteiros = dados.every(d => Number.isInteger(d.valor));
  const passo = inteiros ? Math.max(1, Math.round(niceStep(max))) : niceStep(max);
  const teto = Math.ceil(max / passo) * passo || 1;
  const fatia = (W - ESQ) / dados.length;
  const barra = Math.min(46, fatia * 0.62);
  const y = v => BASE - (v / teto) * (BASE - TOPO);
  const marcas = [];
  for (let v = 0; v <= teto; v += passo) marcas.push(v);
  const iMax = dados.reduce((m, d, i) => d.valor > dados[m].valor ? i : m, 0);
  const pulo = Math.ceil(dados.length / 14); // rótulos do eixo x sem encavalar
  return (
    <svg viewBox={`0 0 ${W} ${altura}`} width="100%" style={{ display: "block" }} role="img">
      {marcas.map(v => (
        <g key={v}>
          <line x1={ESQ} x2={W} y1={y(v)} y2={y(v)} stroke={GRADE} />
          <text x={ESQ - 6} y={y(v) + 3.5} textAnchor="end" fontSize="9.5" fill={TEXTO2}>{formatar(v)}</text>
        </g>
      ))}
      {dados.map((d, i) => {
        const x = ESQ + i * fatia + (fatia - barra) / 2;
        const h = BASE - y(d.valor);
        return (
          <g key={i}>
            <title>{`${d.rotulo}: ${formatar(d.valor)}`}</title>
            <rect x={ESQ + i * fatia} y={TOPO} width={fatia} height={BASE - TOPO} fill="transparent" />
            <path d={colunaV(x, BASE, barra, h)} fill={d.cor || cor} />
            {(rotularTodas || i === iMax) && d.valor > 0 && (
              <text x={x + barra / 2} y={y(d.valor) - 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={TEXTO}>{formatar(d.valor)}</text>
            )}
            {i % pulo === 0 && <text x={x + barra / 2} y={BASE + 14} textAnchor="middle" fontSize="9.5" fill={TEXTO2}>{d.rotulo}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Rosca para parte-do-todo com poucas fatias (≤ 6). dados: [{ rotulo, valor, cor, icone? }]
export function Rosca({ dados, centro, sub, tamanho = 140, formatar = fmtPadrao }) {
  const total = dados.reduce((s, d) => s + (d.valor || 0), 0);
  const esp = 18, r = (tamanho - esp) / 2, c = 2 * Math.PI * r;
  let acum = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: tamanho, height: tamanho, flexShrink: 0 }}>
        <svg width={tamanho} height={tamanho} style={{ transform: "rotate(-90deg)" }} role="img">
          <circle cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={esp} />
          {total > 0 && dados.map((d, i) => {
            const frac = (d.valor || 0) / total;
            if (frac <= 0) return null;
            const vao = dados.filter(x => x.valor > 0).length > 1 ? 2 : 0; // 2px de fundo entre fatias
            const dash = Math.max(0, frac * c - vao);
            const el = (
              <circle key={i} cx={tamanho / 2} cy={tamanho / 2} r={r} fill="none" stroke={d.cor} strokeWidth={esp}
                strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-acum}>
                <title>{`${d.rotulo}: ${formatar(d.valor)} (${Math.round(frac * 100)}%)`}</title>
              </circle>
            );
            acum += frac * c;
            return el;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: TEXTO, lineHeight: 1 }}>{centro ?? formatar(total)}</div>
          {sub && <div style={{ fontSize: 9.5, color: TEXTO2, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
      <div style={{ display: "grid", gap: 4, fontSize: 11.5, minWidth: 150 }}>
        {dados.map(d => (
          <div key={d.rotulo} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: d.cor, display: "inline-block", flexShrink: 0, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }} />
            <span style={{ color: TEXTO }}>{d.icone ? `${d.icone} ` : ""}{d.rotulo}</span>
            <span style={{ marginLeft: "auto", paddingLeft: 10, color: TEXTO2, fontVariantNumeric: "tabular-nums" }}>
              {formatar(d.valor)}{total ? ` · ${Math.round((d.valor / total) * 100)}%` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Uma barra só, inteira = 100%, dividida em partes (ex.: recebido | a receber do contratado).
export function BarraParte({ partes, formatar = fmtPadrao }) {
  const total = partes.reduce((s, p) => s + (p.valor || 0), 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 16, borderRadius: 4, overflow: "hidden", gap: 2, background: "#f1f5f9" }}>
        {partes.filter(p => p.valor > 0).map(p => (
          <div key={p.rotulo} title={`${p.rotulo}: ${formatar(p.valor)}`}
            style={{ width: `${(p.valor / total) * 100}%`, background: p.cor, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 6, fontSize: 11 }}>
        {partes.map(p => (
          <span key={p.rotulo} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: TEXTO2 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: p.cor, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }} />
            {p.rotulo}: <b style={{ color: TEXTO }}>{formatar(p.valor)}</b> ({Math.round((p.valor / total) * 100)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

// Texto escuro sobre cor clara (amarelo, aqua), branco sobre cor escura.
function tintaSobre(hex) {
  const h = String(hex).replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#1e293b" : "#fff";
}
function corta(txt, n) {
  const s = String(txt || "");
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}
function niceStep(max) {
  const bruto = max / 4;
  const pot = Math.pow(10, Math.floor(Math.log10(bruto || 1)));
  const n = bruto / pot;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pot;
}
