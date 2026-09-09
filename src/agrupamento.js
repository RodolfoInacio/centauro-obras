// Chave de agrupamento de obras: duas propostas do mesmo cliente são uma obra com dois contratos.
//
// Mora num arquivo próprio (e não no App.jsx) porque o DiarioObra.jsx também precisa dela, e
// importar do App.jsx criaria ciclo — o App importa o diário. Só o cálculo da chave vive aqui:
// `agruparObras`, que consolida financeiro e progresso, continua no App.jsx, onde estão finObra
// e itemPercentual.

// "BOL ENGENHARIA LTDA." e "Bol Engenharia" caem na mesma chave.
export function chaveCliente(nome) {
  return (nome || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")             // acento
    .toUpperCase()
    .replace(/[.,\-/]/g, " ")
    .replace(/\b(LTDA|ME|EPP|EIRELI|MEI|CIA|S\s?A)\b/g, "")       // razão social
    .replace(/\s+/g, " ").trim();
}

// A chave gravada à mão vence a automática. "solo:<id>" é uma obra que o usuário separou do grupo.
export function chaveGrupo(o) {
  return o.grupo || chaveCliente(o.cliente) || "solo:" + o.id;
}

// Agrupa uma lista de obras em [{ chave, nome, contratos }], sem consolidar números.
// Os contratos saem ordenados por número, para a lista interna não dançar entre renders.
export function agruparSimples(obras) {
  const mapa = new Map();
  for (const o of obras) {
    const chave = chaveGrupo(o);
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(o);
  }
  return [...mapa.entries()].map(([chave, lista]) => {
    const contratos = [...lista].sort((a, b) => (Number(a.numero) || 0) - (Number(b.numero) || 0));
    return { chave, nome: contratos[0].cliente, contratos };
  });
}
