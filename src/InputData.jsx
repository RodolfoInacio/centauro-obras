import { useState, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Campo de data que não briga com quem grava a cada tecla.
//
// Com um <input type="date"> controlado, digitar o ano era impossível: ao teclar o "2" de 2026 o
// campo já vale o ano 0002, o onChange sobe, o pai regrava o estado, o React reescreve o value e
// o navegador perde o buffer do segmento — o ano travava em 0020 e o calendário pulava para o
// ano 2 (foi o que aconteceu no prazo dos lembretes). Aqui o campo é do usuário enquanto ele
// edita: o rascunho é local e só sobe quando a data está completa e o ano é plausível.
// ─────────────────────────────────────────────────────────────────────────────

const ANO_MIN = 1900;
const ANO_MAX = 2200;

export function dataPlausivel(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || "")) return false;
  const ano = Number(v.slice(0, 4));
  return ano >= ANO_MIN && ano <= ANO_MAX;
}

export default function InputData({
  value, onChange, style,
  min = `${ANO_MIN}-01-01`, max = `${ANO_MAX}-12-31`,
  ...resto
}) {
  const [rascunho, setRascunho] = useState(value || "");
  const editando = useRef(false);

  // Valor de fora não reescreve o que está sendo digitado; só sincroniza com o campo parado.
  useEffect(() => { if (!editando.current) setRascunho(value || ""); }, [value]);

  return (
    <input type="date" value={rascunho} min={min} max={max} {...resto}
      onFocus={e => { editando.current = true; resto.onFocus?.(e); }}
      onChange={e => {
        const v = e.target.value;
        setRascunho(v);
        // Ano pela metade (0002, 0020…) fica só no rascunho. Data pronta sobe na hora, para o
        // calendário do navegador continuar gravando sem precisar sair do campo.
        if (dataPlausivel(v)) onChange(v);
      }}
      onBlur={e => {
        editando.current = false;
        const v = e.target.value;
        // Campo limpo apaga a data; digitação pela metade volta ao que era, em vez de gravar
        // um ano torto como 0023.
        if (v === "" || dataPlausivel(v)) onChange(v);
        else setRascunho(value || "");
        resto.onBlur?.(e);
      }}
      style={style} />
  );
}
