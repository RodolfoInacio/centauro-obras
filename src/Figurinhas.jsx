// ─────────────────────────────────────────────────────────────────────────────
// Figurinhas do chat: pacote fixo, desenhado aqui em SVG (emoji + legenda, cores da Centauro).
//
// A mensagem continua sendo só texto — `mensagens` é imutável e não tem `data jsonb` —, então a
// figurinha vai como "[fig:<id>]" e a bolha troca pelo desenho. Só vira figurinha quando a
// mensagem inteira é a marca de um id conhecido: id que sair do pacote volta a aparecer como o
// texto cru, e mensagem antiga nunca muda. Nunca reaproveitar um id para outro desenho: as
// mensagens já enviadas passariam a mostrar a figurinha nova.
// ─────────────────────────────────────────────────────────────────────────────

const VERMELHO = "#ED5454", ESCURO = "#34353A", OURO = "#c9a227", VERDE = "#16a34a", AZUL = "#2563eb", LARANJA = "#ea580c";

export const FIGURINHAS = [
  { id: "bomdia", emoji: "☀️", texto: "Bom dia!", cor: OURO },
  { id: "boatarde", emoji: "🌤️", texto: "Boa tarde!", cor: LARANJA },
  { id: "valeu", emoji: "🙏", texto: "Valeu!", cor: VERMELHO },
  { id: "ok", emoji: "👍", texto: "Ok!", cor: VERDE },
  { id: "fechado", emoji: "🤝", texto: "Fechado!", cor: ESCURO },
  { id: "top", emoji: "🏆", texto: "Mandou bem!", cor: OURO },
  { id: "acaminho", emoji: "🚚", texto: "A caminho", cor: AZUL },
  { id: "naobra", emoji: "🏗️", texto: "Na obra", cor: ESCURO },
  { id: "medido", emoji: "📏", texto: "Medição ok", cor: AZUL },
  { id: "instalado", emoji: "🪟", texto: "Instalado!", cor: VERDE },
  { id: "entregue", emoji: "🎉", texto: "Obra entregue", cor: VERMELHO },
  { id: "atrasou", emoji: "⏰", texto: "Atrasou…", cor: LARANJA },
  { id: "chuva", emoji: "🌧️", texto: "Choveu, parou", cor: AZUL },
  { id: "urgente", emoji: "🚨", texto: "Urgente!", cor: VERMELHO },
  { id: "meliga", emoji: "📞", texto: "Me liga", cor: ESCURO },
  { id: "cafe", emoji: "☕", texto: "Pausa pro café", cor: LARANJA },
];

export const marcaFigurinha = (id) => `[fig:${id}]`;

// A figurinha da mensagem, ou null se o texto não for (só) uma figurinha conhecida.
export function figurinhaDoTexto(texto) {
  const m = String(texto || "").trim().match(/^\[fig:([a-z0-9_-]+)\]$/);
  return m ? FIGURINHAS.find(f => f.id === m[1]) || null : null;
}

export function Figurinha({ fig, tamanho = 120 }) {
  const longo = fig.texto.length > 11;
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 140 140" role="img" aria-label={fig.texto}
      style={{ display: "block", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.18))" }}>
      <rect x="6" y="6" width="128" height="128" rx="30" fill="#fff" />
      <rect x="12" y="12" width="116" height="116" rx="25" fill={fig.cor} opacity="0.12" />
      <text x="70" y="78" textAnchor="middle" fontSize="54">{fig.emoji}</text>
      <rect x="14" y="94" width="112" height="28" rx="14" fill={fig.cor} />
      <text x="70" y="113" textAnchor="middle" fontSize={longo ? 13 : 15} fontWeight="800" fill="#fff"
        fontFamily="system-ui, -apple-system, Segoe UI, sans-serif"
        {...(longo ? { textLength: 100, lengthAdjust: "spacingAndGlyphs" } : {})}>
        {fig.texto}
      </text>
    </svg>
  );
}
