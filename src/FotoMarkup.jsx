import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Rabisco estilo paint sobre a foto: seta, caneta, retângulo e texto.
// Genérico e sem regra de negócio — é a segunda peça reutilizável do app, junto
// com o Modal.
//
// Os traços são guardados como VETOR ({tipo, cor, espessura, pontos}) e o PNG
// achatado é gerado só na hora de salvar. Assim a folha impressa é um <img>
// simples (canvas na impressão é frágil) e o traço de ontem ainda pode ser
// desfeito amanhã.
// ─────────────────────────────────────────────────────────────────────────────

export const CORES_MARCACAO = ["#ef4444", "#eab308", "#10b981", "#1a1a1a", "#ffffff"];
export const ESPESSURAS = [{ rotulo: "Fina", v: 3 }, { rotulo: "Média", v: 6 }, { rotulo: "Grossa", v: 12 }];

const FERRAMENTAS = [
  { k: "seta", icone: "↗", rotulo: "Seta" },
  { k: "caneta", icone: "✏️", rotulo: "Caneta" },
  { k: "retangulo", icone: "▭", rotulo: "Retângulo" },
  { k: "texto", icone: "T", rotulo: "Texto" },
];

// Foto de celular tem 4–6 MB. Sem reduzir, uma obra com 40 fotos fica impossível
// de abrir no 4G do canteiro (e a folha impressa demora uma eternidade).
export const LADO_MAX = 1600;

export function redimensionarImagem(file, ladoMax = LADO_MAX, qualidade = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, ladoMax / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * escala);
      const h = Math.round(img.naturalHeight * escala);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      cv.toBlob(b => b ? resolve(b) : reject(new Error("Falha ao processar a imagem")), "image/jpeg", qualidade);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Arquivo não é uma imagem válida")); };
    img.src = url;
  });
}

// ─── Desenho dos traços num contexto 2D qualquer ─────────────────────────────
function desenharTraco(ctx, t) {
  const pts = t.pontos || [];
  if (!pts.length) return;
  ctx.save();
  ctx.strokeStyle = t.cor;
  ctx.fillStyle = t.cor;
  ctx.lineWidth = t.espessura;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (t.tipo === "caneta") {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  } else if (t.tipo === "retangulo" && pts.length > 1) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (t.tipo === "seta" && pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const cabeca = Math.max(14, t.espessura * 4);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - cabeca * Math.cos(ang - Math.PI / 7), b.y - cabeca * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(b.x - cabeca * Math.cos(ang + Math.PI / 7), b.y - cabeca * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (t.tipo === "texto" && t.texto) {
    const tam = Math.max(18, t.espessura * 5);
    ctx.font = `800 ${tam}px "Kumbh Sans", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // Contorno claro por baixo para o texto não sumir em foto escura.
    ctx.lineWidth = Math.max(3, tam / 7);
    ctx.strokeStyle = t.cor === "#ffffff" ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)";
    ctx.strokeText(t.texto, pts[0].x, pts[0].y);
    ctx.fillText(t.texto, pts[0].x, pts[0].y);
  }
  ctx.restore();
}

export function desenharTracos(ctx, tracos) {
  (tracos || []).forEach(t => desenharTraco(ctx, t));
}

// Achata foto + traços num JPEG. É o arquivo que vai para a impressão.
export function achatar(img, tracos, qualidade = 0.85) {
  return new Promise((resolve, reject) => {
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    desenharTracos(ctx, tracos);
    cv.toBlob(b => b ? resolve(b) : reject(new Error("Falha ao gerar a imagem marcada")), "image/jpeg", qualidade);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────
export default function FotoMarkup({ src, tracosIniciais, legendaInicial = "", onSalvar, onFechar }) {
  const [tracos, setTracos] = useState(() => (tracosIniciais || []).map(t => ({ ...t })));
  const [ferramenta, setFerramenta] = useState("seta");
  const [cor, setCor] = useState("#ef4444");
  const [espessura, setEspessura] = useState(6);
  const [legenda, setLegenda] = useState(legendaInicial);
  const [carregada, setCarregada] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [digitando, setDigitando] = useState(null); // {x, y, valor} — caixa de texto aberta

  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  // O traço em construção fica no ref: o pointermove dispara dezenas de vezes por
  // segundo e um setState por evento engasga o desenho.
  const rascunho = useRef(null);

  const repintar = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    desenharTracos(ctx, tracos);
    if (rascunho.current) desenharTraco(ctx, rascunho.current);
  }, [tracos]);

  useEffect(() => { repintar(); }, [repintar, carregada]);

  function aoCarregar() {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv) return;
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    setCarregada(true);
  }

  // Tela → coordenadas da imagem (o canvas é exibido escalado por CSS).
  function pos(e) {
    const cv = canvasRef.current;
    const r = cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (cv.width / r.width),
      y: (e.clientY - r.top) * (cv.height / r.height),
    };
  }

  function onDown(e) {
    if (!carregada || digitando) return;
    const p = pos(e);
    if (ferramenta === "texto") { setDigitando({ x: p.x, y: p.y, valor: "" }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    rascunho.current = { tipo: ferramenta, cor, espessura, pontos: [p] };
    repintar();
  }

  function onMove(e) {
    if (!rascunho.current) return;
    const p = pos(e);
    // Caneta acumula todos os pontos; seta e retângulo só precisam de início e fim.
    if (rascunho.current.tipo === "caneta") rascunho.current.pontos.push(p);
    else rascunho.current.pontos = [rascunho.current.pontos[0], p];
    repintar();
  }

  function onUp() {
    const t = rascunho.current;
    rascunho.current = null;
    if (!t) return;
    const [a, b] = [t.pontos[0], t.pontos[t.pontos.length - 1]];
    // Clique sem arrastar não vira traço nenhum.
    if (t.tipo !== "caneta" && Math.hypot(b.x - a.x, b.y - a.y) < 8) { repintar(); return; }
    setTracos(ts => [...ts, t]);
  }

  function confirmarTexto() {
    const txt = (digitando.valor || "").trim();
    if (txt) setTracos(ts => [...ts, { tipo: "texto", cor, espessura, texto: txt, pontos: [{ x: digitando.x, y: digitando.y }] }]);
    setDigitando(null);
  }

  async function salvar() {
    setSalvando(true);
    setErro("");
    try {
      const blob = await achatar(imgRef.current, tracos);
      await onSalvar({ blob, tracos, legenda });
    } catch (err) {
      setErro(err.message || "Não foi possível salvar a marcação.");
      setSalvando(false);
    }
  }

  const btnFerr = (ativo) => ({
    background: ativo ? "#c9a227" : "#2a2a2a", color: "#fff", border: "none", borderRadius: 7,
    padding: "7px 11px", fontSize: 13, fontWeight: 700, cursor: "pointer", minWidth: 38,
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 300, display: "flex", flexDirection: "column" }}>
      {/* Barra de ferramentas */}
      <div style={{ background: "#1a1a1a", padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
        {FERRAMENTAS.map(f => (
          <button key={f.k} onClick={() => { setFerramenta(f.k); setDigitando(null); }} title={f.rotulo} style={btnFerr(ferramenta === f.k)}>
            {f.icone}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#333" }} />

        <div style={{ display: "flex", gap: 5 }}>
          {CORES_MARCACAO.map(c => (
            <button key={c} onClick={() => setCor(c)} title={c}
              style={{
                width: 24, height: 24, borderRadius: "50%", background: c, cursor: "pointer",
                border: cor === c ? "3px solid #c9a227" : "2px solid #444", padding: 0,
              }} />
          ))}
        </div>

        <div style={{ width: 1, height: 24, background: "#333" }} />

        <div style={{ display: "flex", gap: 5 }}>
          {ESPESSURAS.map(x => (
            <button key={x.v} onClick={() => setEspessura(x.v)} title={x.rotulo}
              style={{ ...btnFerr(espessura === x.v), fontSize: 11, padding: "7px 9px" }}>{x.rotulo}</button>
          ))}
        </div>

        <div style={{ width: 1, height: 24, background: "#333" }} />

        <button onClick={() => setTracos(ts => ts.slice(0, -1))} disabled={!tracos.length}
          style={{ ...btnFerr(false), opacity: tracos.length ? 1 : 0.4, fontSize: 11 }}>↶ Desfazer</button>
        <button onClick={() => setTracos([])} disabled={!tracos.length}
          style={{ ...btnFerr(false), opacity: tracos.length ? 1 : 0.4, fontSize: 11 }}>Limpar</button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={onFechar} disabled={salvando}
            style={{ background: "#2a2a2a", color: "#fff", border: "none", borderRadius: 7, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
          <button onClick={salvar} disabled={salvando || !carregada}
            style={{ background: salvando ? "#555" : "#10b981", color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontWeight: 700, fontSize: 12, cursor: salvando ? "wait" : "pointer" }}>
            {salvando ? "Salvando…" : "Salvar marcação"}
          </button>
        </div>
      </div>

      {erro && (
        <div style={{ background: "#dc2626", color: "#fff", padding: "8px 14px", fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>{erro}</div>
      )}

      {/* Área de desenho */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflow: "auto" }}>
        <div style={{ position: "relative", lineHeight: 0, maxWidth: "100%", maxHeight: "100%" }}>
          <img ref={imgRef} src={src} alt="" onLoad={aoCarregar} crossOrigin="anonymous"
            style={{ display: "block", maxWidth: "100%", maxHeight: "calc(100vh - 190px)", borderRadius: 4 }} />
          <canvas ref={canvasRef}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              cursor: ferramenta === "texto" ? "text" : "crosshair", touchAction: "none", borderRadius: 4,
            }} />

          {digitando && (
            <div style={{ position: "absolute", left: 12, bottom: 12, right: 12, display: "flex", gap: 6, background: "rgba(26,26,26,0.94)", padding: 8, borderRadius: 8 }}>
              <input autoFocus value={digitando.valor}
                onChange={e => setDigitando(d => ({ ...d, valor: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") confirmarTexto(); if (e.key === "Escape") setDigitando(null); }}
                placeholder="Digite a anotação e tecle Enter"
                style={{ flex: 1, minWidth: 0, border: "none", borderRadius: 6, padding: "8px 10px", fontSize: 13, boxSizing: "border-box" }} />
              <button onClick={confirmarTexto}
                style={{ background: "#c9a227", color: "#fff", border: "none", borderRadius: 6, padding: "0 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>OK</button>
              <button onClick={() => setDigitando(null)}
                style={{ background: "#2a2a2a", color: "#fff", border: "none", borderRadius: 6, padding: "0 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>✕</button>
            </div>
          )}
        </div>
      </div>

      {/* Legenda */}
      <div style={{ background: "#1a1a1a", padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <span style={{ color: "#9ca3af", fontSize: 11.5, fontWeight: 700 }}>Legenda</span>
        <input value={legenda} onChange={e => setLegenda(e.target.value)}
          placeholder="O que esta foto mostra? (opcional, sai na folha impressa)"
          style={{ flex: 1, border: "none", borderRadius: 7, padding: "8px 11px", fontSize: 12.5, boxSizing: "border-box" }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Assinatura no dedo. Mesmo canvas, só caneta preta — o traço é leve, então vai
// como data URI direto no jsonb, sem passar pelo Storage.
// ─────────────────────────────────────────────────────────────────────────────
export function Assinatura({ valor, rotulo, onChange }) {
  const canvasRef = useRef(null);
  const desenhando = useRef(false);
  const [vazio, setVazio] = useState(!valor);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = 600; cv.height = 180;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (valor) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height);
      img.src = valor;
    }
    setVazio(!valor);
  }, [valor]);

  function pos(e) {
    const cv = canvasRef.current;
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  }

  function down(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    desenhando.current = true;
    const ctx = canvasRef.current.getContext("2d");
    const p = pos(e);
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setVazio(false);
  }
  function move(e) {
    if (!desenhando.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function up() {
    if (!desenhando.current) return;
    desenhando.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  }
  function limpar() {
    const cv = canvasRef.current;
    cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    setVazio(true);
    onChange("");
  }

  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>{rotulo}</span>
        {!vazio && (
          <button onClick={limpar}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "#94a3b8", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>Limpar</button>
        )}
      </div>
      <div style={{ position: "relative", border: "1px dashed #cbd5e1", borderRadius: 8, background: "#fff" }}>
        <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          style={{ display: "block", width: "100%", height: 110, touchAction: "none", cursor: "crosshair" }} />
        {vazio && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 11.5, color: "#cbd5e1" }}>
            Assine com o dedo ou o mouse
          </div>
        )}
      </div>
    </div>
  );
}
