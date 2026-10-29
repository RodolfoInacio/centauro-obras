// ─────────────────────────────────────────────────────────────────────────────
// Financeiro por contrato — modelo puro (sem React, sem banco).
//
// Contrato (fin_contratos.data): valor, forma, condição, multa/juros e as PARCELAS previstas.
// Baixas (fin_baixas): o dinheiro que entrou, uma linha por recebimento, imutável.
//
// Cada baixa tem `principal` (quanto abate da parcela), `juros`, `multa` e `desconto`.
// O dinheiro que entrou de fato = principal + juros + multa − desconto. Pagou 950 numa parcela de
// 1.000 com 50 de desconto: principal 1.000, desconto 50 — a parcela quita e o caixa mostra 950.
//
// Tudo o mais é DERIVADO, nunca gravado: saldo da parcela, situação (a vencer / vencida / parcial /
// paga), dias de atraso. Gravar "vencida" seria um campo que mente no dia seguinte.
// A obra guarda só um espelho (`obra.financeiroResumo`) para o resto do app ler sem buscar as
// tabelas; quem escreve o espelho é a tela Financeiro, depois de cada alteração.
// ─────────────────────────────────────────────────────────────────────────────

export const FORMAS_PAGAMENTO = ["PIX", "BOLETO", "TRANSFERÊNCIA", "CARTÃO DE CRÉDITO", "CARTÃO DE DÉBITO", "DINHEIRO", "CHEQUE", "PERMUTA", "OUTRO"];

export const SITUACOES = {
  paga: { rotulo: "Paga", cor: "#047857", fundo: "#d1fae5" },
  parcial: { rotulo: "Parcial", cor: "#b45309", fundo: "#fef3c7" },
  vencida: { rotulo: "Vencida", cor: "#b91c1c", fundo: "#fee2e2" },
  hoje: { rotulo: "Vence hoje", cor: "#c2410c", fundo: "#ffedd5" },
  aVencer: { rotulo: "A vencer", cor: "#1d4ed8", fundo: "#dbeafe" },
};

export const cent = v => Math.round((Number(v) || 0) * 100) / 100;

export function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function diasEntre(a, b) {
  return Math.round((Date.parse(b + "T12:00:00") - Date.parse(a + "T12:00:00")) / 86400000);
}
// Soma meses mantendo o dia (31/01 + 1 mês = 28/02, não 03/03).
export function somarMeses(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const alvo = new Date(y, m - 1 + n, 1);
  const ultimo = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d, ultimo));
  return `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, "0")}-${String(alvo.getDate()).padStart(2, "0")}`;
}
function somarDias(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function normParcela(p, i = 0) {
  return {
    id: String(p?.id || `p_${Date.now()}_${i}`),
    descricao: String(p?.descricao || ""),
    vencimento: String(p?.vencimento || ""),
    valor: cent(p?.valor),
    forma: String(p?.forma || ""),
    obs: String(p?.obs || ""),
  };
}

export function normContratoFin(c) {
  const o = c && typeof c === "object" ? c : {};
  return {
    valor: cent(o.valor),
    dataContrato: String(o.dataContrato || ""),
    forma: String(o.forma || ""),
    condicao: String(o.condicao || ""),
    multaPct: Number.isFinite(Number(o.multaPct)) && o.multaPct !== "" ? Number(o.multaPct) : 2,
    jurosMesPct: Number.isFinite(Number(o.jurosMesPct)) && o.jurosMesPct !== "" ? Number(o.jurosMesPct) : 1,
    obs: String(o.obs || ""),
    parcelas: (Array.isArray(o.parcelas) ? o.parcelas : []).map(normParcela),
    // Cada alteração depois de gerado: {em, porId, por, texto}. Só cresce.
    historico: Array.isArray(o.historico) ? o.historico : [],
    criadoEm: o.criadoEm || null,
    criadoPor: o.criadoPor || "",
    // Rascunho lido pela IA do contrato anexado: não espelha na obra nem recebe baixa até alguém
    // conferir. Contrato gerado à mão (sem o campo) já nasce conferido.
    conferido: o.conferido !== false,
    rascunho: o.rascunho && typeof o.rascunho === "object" ? o.rascunho : null,
  };
}

// Monta o rascunho do contrato a partir da leitura da IA (analisar-documento) do contrato anexado.
// Tudo que a IA não trouxe cai no que a obra já tem; o que não fecha vira aviso para a conferência.
export function contratoDoRascunhoIA(obra, ia, anexo, por) {
  const ct = ia?.contrato || {}, fin = ia?.financeiro || {};
  const valor = cent(ct.valorTotal) || cent(obra.valorTotal);
  const base = Date.now();
  let parcelas = (Array.isArray(fin.parcelas) ? fin.parcelas : [])
    .filter(p => cent(p.valor) > 0)
    .map((p, i) => normParcela({
      id: `p_${base}_${i}`, descricao: String(p.descricao || `PARCELA ${i + 1}`).toUpperCase(),
      vencimento: /^\d{4}-\d{2}-\d{2}$/.test(p.vencimento || "") ? p.vencimento : "",
      valor: p.valor, forma: String(p.forma || "").toUpperCase(),
    }, i));
  const avisos = [...(Array.isArray(ia?.avisos) ? ia.avisos : [])];
  if (ia?.tipo && ia.tipo !== "contrato") avisos.push(`A IA leu este anexo como "${ia.tipo}", não como contrato.`);
  if (!cent(ct.valorTotal)) avisos.push("O contrato não trouxe o valor total — usado o valor que estava na obra.");
  else if (cent(obra.valorTotal) && Math.abs(cent(ct.valorTotal) - cent(obra.valorTotal)) > 0.5) avisos.push("O valor do contrato é diferente do que estava na obra.");
  if (!parcelas.length) {
    parcelas = [normParcela({ id: `p_${base}_0`, descricao: "A DEFINIR", vencimento: "", valor })];
    avisos.push("A IA não achou as parcelas — ficou uma parcela única a definir.");
  }
  const dif = cent(valor - somaParcelas(parcelas));
  if (dif !== 0) avisos.push("A soma das parcelas lidas não fecha com o valor do contrato.");
  if (parcelas.some(p => !p.vencimento)) avisos.push("Há parcela sem vencimento (depende de evento ou não estava no contrato).");
  const agora = new Date().toISOString();
  return normContratoFin({
    valor,
    dataContrato: /^\d{4}-\d{2}-\d{2}$/.test(ct.dataContrato || "") ? ct.dataContrato : obra.dataContrato || "",
    forma: String(fin.forma || "").toUpperCase(),
    condicao: String(fin.condicao || "").toUpperCase(),
    multaPct: cent(fin.multaPct) || 2,
    jurosMesPct: cent(fin.jurosMesPct) || 1,
    obs: String(ct.obs || ""),
    parcelas,
    historico: [{ em: agora, porId: null, por, texto: `Rascunho gerado pela IA a partir de "${anexo.nome}"` }],
    criadoEm: agora, criadoPor: por,
    conferido: false,
    rascunho: { anexoId: anexo.id, anexoNome: anexo.nome, em: agora, resumo: ia?.resumo || "", avisos },
  });
}

export const somaParcelas = parcelas => cent(parcelas.reduce((a, p) => a + (Number(p.valor) || 0), 0));
export const caixaDaBaixa = b => cent(b.principal + b.juros + b.multa - b.desconto);

// Gera as parcelas de "entrada + N vezes". `entrada` em R$; o resto é dividido igual e o
// centavo que sobra do arredondamento vai para a última, para a soma fechar no valor exato.
export function gerarParcelas({ valor, entrada = 0, dataEntrada = "", qtd = 1, primeiroVenc = "", intervalo = "mensal", dias = 30, forma = "" }) {
  const total = cent(valor);
  const ent = Math.min(cent(entrada), total);
  const n = Math.max(0, Math.floor(Number(qtd) || 0));
  const out = [];
  const base = Date.now();
  if (ent > 0) out.push(normParcela({ id: `p_${base}_e`, descricao: "ENTRADA", vencimento: dataEntrada, valor: ent, forma }));
  const resto = cent(total - ent);
  if (n > 0 && resto > 0) {
    const cada = Math.floor(resto / n * 100) / 100;
    for (let i = 0; i < n; i++) {
      const venc = !primeiroVenc ? "" : intervalo === "mensal" ? somarMeses(primeiroVenc, i) : somarDias(primeiroVenc, i * (Number(dias) || 30));
      const v = i === n - 1 ? cent(resto - cada * (n - 1)) : cada;
      out.push(normParcela({ id: `p_${base}_${i}`, descricao: `PARCELA ${i + 1}/${n}`, vencimento: venc, valor: v, forma }));
    }
  }
  return out;
}

// Baixas que contam: tira os estornos e as baixas estornadas (as duas aparecem no histórico).
export function baixasValidas(baixas) {
  const estornadas = new Set(baixas.filter(b => b.tipo === "estorno").map(b => b.estornoDe));
  return baixas.filter(b => b.tipo !== "estorno" && !estornadas.has(b.id));
}

function situacaoParcela(p, saldo, abatido, hoje) {
  if (saldo <= 0.004) return "paga";
  if (p.vencimento && p.vencimento < hoje) return "vencida";
  if (abatido > 0.004) return "parcial";
  if (p.vencimento === hoje) return "hoje";
  return "aVencer";
}

// O retrato do contrato num dia. As baixas ligadas a uma parcela abatem nela; o que passa do saldo
// dela e as baixas sem parcela (o saldo inicial, por exemplo) abatem na ordem de vencimento.
export function situacaoContrato(contrato0, baixasDaObra, hoje = hojeLocal()) {
  const contrato = normContratoFin(contrato0);
  const validas = baixasValidas(baixasDaObra || []);
  const ordem = [...contrato.parcelas].sort((a, b) => (a.vencimento || "9999").localeCompare(b.vencimento || "9999"));
  const abat = Object.fromEntries(ordem.map(p => [p.id, 0]));
  let livre = 0;
  for (const b of validas) {
    if (b.parcelaId && b.parcelaId in abat) {
      const p = ordem.find(x => x.id === b.parcelaId);
      const cabe = Math.max(0, p.valor - abat[p.id]);
      const usa = Math.min(cabe, b.principal);
      abat[p.id] = cent(abat[p.id] + usa);
      livre = cent(livre + b.principal - usa);
    } else livre = cent(livre + b.principal);
  }
  for (const p of ordem) {
    if (livre <= 0) break;
    const usa = Math.min(livre, Math.max(0, p.valor - abat[p.id]));
    abat[p.id] = cent(abat[p.id] + usa);
    livre = cent(livre - usa);
  }
  const parcelas = ordem.map(p => {
    const saldo = cent(p.valor - abat[p.id]);
    const sit = situacaoParcela(p, saldo, abat[p.id], hoje);
    return { ...p, abatido: abat[p.id], saldo, situacao: sit, diasAtraso: sit === "vencida" ? diasEntre(p.vencimento, hoje) : 0 };
  });
  const soma = (k) => cent(validas.reduce((a, b) => a + b[k], 0));
  const principal = soma("principal");
  const juros = soma("juros"), multa = soma("multa"), desconto = soma("desconto");
  const vencido = cent(parcelas.filter(p => p.situacao === "vencida").reduce((a, p) => a + p.saldo, 0));
  return {
    contrato, parcelas, validas,
    principal, juros, multa, desconto,
    caixa: cent(principal + juros + multa - desconto),
    aReceber: Math.max(0, cent(contrato.valor - principal)),
    vencido,
    excedente: livre,                         // recebido além das parcelas (crédito do cliente)
    difParcelas: cent(contrato.valor - somaParcelas(contrato.parcelas)),
    proxima: parcelas.find(p => p.saldo > 0.004) || null,
  };
}

// Multa e juros sugeridos para pagar `valor` de uma parcela vencida em `dia`. Multa única sobre o
// valor pago, juros simples pró-rata ao dia (juros ao mês / 30). Só sugestão — o campo é editável.
export function encargosSugeridos(contrato, parcela, valor, dia) {
  if (!parcela?.vencimento || !dia || dia <= parcela.vencimento || !(valor > 0)) return { multa: 0, juros: 0, dias: 0 };
  const dias = diasEntre(parcela.vencimento, dia);
  return {
    multa: cent(valor * (Number(contrato.multaPct) || 0) / 100),
    juros: cent(valor * (Number(contrato.jurosMesPct) || 0) / 100 / 30 * dias),
    dias,
  };
}

// ─── Espelho na obra ─────────────────────────────────────────────────────────
// O que a obra guarda do financeiro, para Dashboard, avisos, relatórios e a seção da obra lerem
// sem buscar as tabelas. As parcelas vão com o saldo; o "vencido" é calculado na leitura.
export function resumoParaObra(sit) {
  return {
    contrato: sit.contrato.valor,
    recebido: sit.principal,
    caixa: sit.caixa,
    juros: cent(sit.juros + sit.multa),
    desconto: sit.desconto,
    aReceber: sit.aReceber,
    forma: sit.contrato.forma,
    condicao: sit.contrato.condicao,
    parcelas: sit.parcelas.map(p => ({ id: p.id, descricao: p.descricao, vencimento: p.vencimento, valor: p.valor, saldo: p.saldo })),
  };
}

// Campos da obra que o espelho escreve. `valorRecebido` continua existindo para o código antigo e
// passa a ser o principal recebido (total − a receber), nunca digitado.
export function camposEspelho(sit) {
  return { valorTotal: sit.contrato.valor, valorRecebido: sit.principal, financeiroResumo: resumoParaObra(sit) };
}

// O espelho mudou? Não regrava a obra à toa ao abrir a tela. Comparação sem depender da ordem
// das chaves: o jsonb do Postgres devolve as chaves reordenadas.
function estavel(v) {
  if (Array.isArray(v)) return "[" + v.map(estavel).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + estavel(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
export function espelhoDiferente(obra, sit) {
  const a = obra.financeiroResumo;
  const b = resumoParaObra(sit);
  return !a || cent(obra.valorTotal) !== b.contrato || cent(obra.valorRecebido) !== b.recebido
    || estavel(a) !== estavel(b);
}

// Leitura do espelho (qualquer tela): vencido e próxima parcela no dia de hoje.
export function vencidoDoResumo(resumo, hoje = hojeLocal()) {
  if (!resumo?.parcelas) return { vencido: 0, qtd: 0 };
  const venc = resumo.parcelas.filter(p => p.saldo > 0.004 && p.vencimento && p.vencimento < hoje);
  return { vencido: cent(venc.reduce((a, p) => a + p.saldo, 0)), qtd: venc.length };
}
