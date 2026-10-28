// ─────────────────────────────────────────────────────────────────────────────
// Caixa alta nos cadastros. Em vez de trocar o onChange de cada campo, um ouvinte só, na fase de
// captura (roda antes do React), converte o texto do campo para maiúscula — então o que é gravado
// já sai em caixa alta. Vale para quem está dentro de um elemento com `data-caixa-alta`; um
// `data-livre` mais próximo desliga (observações, unidade do estoque). E-mail, senha, número,
// data e URL ficam de fora pelo tipo.
//
// O valor é escrito pelo setter do protótipo: o React guarda o último valor na própria instância
// do input e, se fosse `el.value = …`, acharia que nada mudou e engoliria o onChange.
// ─────────────────────────────────────────────────────────────────────────────

const TIPOS_TEXTO = new Set(["", "text", "search", "tel"]);
const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;

function deveConverter(el) {
  if (el instanceof HTMLInputElement) {
    if (!TIPOS_TEXTO.has((el.getAttribute("type") || "").toLowerCase())) return false;
  } else if (!(el instanceof HTMLTextAreaElement)) return false;
  const marca = el.closest("[data-caixa-alta],[data-livre]");
  return !!marca && marca.hasAttribute("data-caixa-alta");
}

function converter(el) {
  const v = el.value;
  const up = v.toLocaleUpperCase("pt-BR");
  if (up === v) return;
  const { selectionStart: ini, selectionEnd: fim } = el;
  (el instanceof HTMLTextAreaElement ? setArea : setInput).call(el, up);
  // toUpperCase quase nunca muda o tamanho (só "ß" e afins); mantém o cursor onde estava.
  if (up.length === v.length && ini != null) el.setSelectionRange(ini, fim);
}

export function ligarCaixaAlta() {
  window.addEventListener("input", e => {
    // Durante a composição (acento no teclado de celular) o texto ainda não terminou.
    if (e.isComposing) return;
    if (deveConverter(e.target)) converter(e.target);
  }, true);
  // Fim da composição: o input seguinte já vem com isComposing = false, mas alguns navegadores
  // não disparam um depois do compositionend.
  window.addEventListener("compositionend", e => {
    if (deveConverter(e.target)) {
      converter(e.target);
      e.target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, true);
}
