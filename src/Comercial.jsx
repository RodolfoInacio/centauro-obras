import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import CadastroObra, { normCadastro } from "./CadastroObra";
import AnexosObra, { enviarArquivos, urlsComCache, AreaSoltar } from "./AnexosObra";
import ComentariosObra, { lerAutor } from "./ComentariosObra";
import { useComunicacao, nomePessoa, pessoaTemAcesso, Avatar } from "./Comunicacao";
import { Dinheiro, Oculto } from "./Sigilo";
import { chaveCliente } from "./agrupamento";
import { useEstadoSessao } from "./rotas";
import {
  fetchNegociacoes, fetchNegociacao, inserirNegociacao, salvarNegociacao, notificarComercial, fetchFotosCapa,
  excluirNegociacao, fetchNumerosNegExcluidas,
} from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// 💼 Comercial: a negociação da prospecção até virar obra (ou ser declinada).
//
// Fluxo: prospecção → aguardando orçamento (o comercial libera para o orçamentista) → em orçamento
// (o orçamentista pegou) → orçamento pronto (volta ao comercial) → negociação → convertida | declinada.
// Da negociação dá para pedir revisão, que volta para o orçamentista.
//
// A negociação é registro próprio (tabela `negociacoes`, id NEG-0001), não uma obra: o id da obra é o
// nº da proposta do Wvetro, que só existe depois do orçamento. Fotos, anexos e comentários usam as
// mesmas tabelas da obra com o id NEG-… (elas não têm FK com obras). Converter abre o "+ Novo contrato"
// já preenchido, e os anexos são copiados para a obra.
//
// Quem faz cada passo é o LOGIN (profiles), como nas aprovações de compra: é o que diz "quem está
// fazendo o quê". A etapa é gravada; "parada há N dias" é derivado de `etapaEm`, nunca gravado.
// Gravação com trava de versão (como a obra): comercial e orçamentista mexem no mesmo registro.
// ─────────────────────────────────────────────────────────────────────────────

export const ETAPAS_NEG = [
  { id: "prospeccao", rotulo: "Prospecção", icone: "🔎", cor: "#64748b", limite: 30 },
  { id: "aguardando_orcamento", rotulo: "Aguardando orçamento", icone: "📥", cor: "#d97706", limite: 3 },
  { id: "em_orcamento", rotulo: "Em orçamento", icone: "📐", cor: "#8b5cf6", limite: 7 },
  { id: "orcamento_pronto", rotulo: "Orçamento pronto", icone: "📄", cor: "#2563eb", limite: 5 },
  { id: "negociacao", rotulo: "Negociação", icone: "🤝", cor: "#0891b2", limite: 15 },
];
const FINAIS = {
  convertida: { id: "convertida", rotulo: "Convertida em obra", icone: "✅", cor: "#16a34a" },
  declinada: { id: "declinada", rotulo: "Declinada", icone: "✖", cor: "#dc2626" },
};
const ETAPA = Object.fromEntries([...ETAPAS_NEG, ...Object.values(FINAIS)].map(e => [e.id, e]));
const ATIVAS = new Set(ETAPAS_NEG.map(e => e.id));
export const negAtiva = (n) => ATIVAS.has(n.etapa);

export const ORIGENS = [
  { id: "indicacao", rotulo: "Indicação" }, { id: "site", rotulo: "Site / redes" },
  { id: "arquiteto", rotulo: "Arquiteto" }, { id: "construtora", rotulo: "Construtora" },
  { id: "recorrente", rotulo: "Cliente recorrente" }, { id: "outro", rotulo: "Outro" },
];
export const MOTIVOS_DECLINIO = [
  { id: "preco", rotulo: "Preço" }, { id: "prazo", rotulo: "Prazo" }, { id: "concorrente", rotulo: "Fechou com concorrente" },
  { id: "desistiu", rotulo: "Cliente desistiu da obra" }, { id: "sem_retorno", rotulo: "Sem retorno do cliente" },
  { id: "nos", rotulo: "Nós declinamos (não atendemos)" }, { id: "outro", rotulo: "Outro" },
];
const ROTULO_MOTIVO = Object.fromEntries(MOTIVOS_DECLINIO.map(m => [m.id, m.rotulo]));

// ─── MODELO ──────────────────────────────────────────────────────────────────
const txt = (v) => typeof v === "string" ? v : "";
const numero = (v) => Math.max(0, Number(v) || 0);
const idOuNull = (v) => typeof v === "string" && v ? v : null;

export function normNegociacao(n) {
  n = n && typeof n === "object" ? n : {};
  const o = n.orcamento && typeof n.orcamento === "object" ? n.orcamento : {};
  const p = n.prazos && typeof n.prazos === "object" ? n.prazos : {};
  const etapa = ETAPA[n.etapa] ? n.etapa : "prospeccao";
  return {
    id: String(n.id || ""),
    numero: txt(n.numero) || String(n.id || ""),
    // Mesmo formato da obra (CadastroObra lê e grava isso), para a conversão só copiar.
    cliente: txt(n.cliente), obra: txt(n.obra), cidade: txt(n.cidade), vendedor: txt(n.vendedor),
    cadastro: normCadastro(n.cadastro),
    origem: ORIGENS.some(x => x.id === n.origem) ? n.origem : "",
    etapa,
    etapaEm: txt(n.etapaEm) || txt(n.criadaEm),
    criadaEm: txt(n.criadaEm), criadaPorId: idOuNull(n.criadaPorId), criadaPorNome: txt(n.criadaPorNome),
    vendedorId: idOuNull(n.vendedorId), vendedorNome: txt(n.vendedorNome),
    orcamentistaId: idOuNull(n.orcamentistaId), orcamentistaNome: txt(n.orcamentistaNome),
    valorEstimado: numero(n.valorEstimado),
    prazos: { retornoCliente: txt(p.retornoCliente), entregaOrcamento: txt(p.entregaOrcamento) },
    orcamento: {
      numeroProposta: txt(o.numeroProposta), valor: numero(o.valor), validade: txt(o.validade),
      prontoEm: txt(o.prontoEm), prontoPorId: idOuNull(o.prontoPorId), prontoPorNome: txt(o.prontoPorNome),
      obs: txt(o.obs), orcamentoLivreId: txt(o.orcamentoLivreId),
    },
    revisoes: Array.isArray(n.revisoes) ? n.revisoes : [],
    declinio: n.declinio && typeof n.declinio === "object" ? n.declinio : null,
    conversao: n.conversao && typeof n.conversao === "object" ? n.conversao : null,
    historico: Array.isArray(n.historico) ? n.historico : [],
    capa: n.capa && n.capa.path ? { anexoId: n.capa.anexoId || null, path: n.capa.path } : null,
  };
}

// NEG-0001: o próximo depois do maior (inclusive declinadas, convertidas e as excluídas — anexos e
// comentários da excluída continuam presos ao número dela). Número único no banco: duas abas criando
// ao mesmo tempo dão erro visível em vez de dois NEG iguais.
export function proximoNumeroNeg(negs, excluidos = []) {
  const num = (s) => Number(String(s).replace(/\D/g, "")) || 0;
  const max = Math.max(negs.reduce((m, n) => Math.max(m, num(n.numero)), 0), ...excluidos.map(num), 0);
  return `NEG-${String(max + 1).padStart(4, "0")}`;
}

const agoraISO = () => new Date().toISOString();
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function diasDesde(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
}
const fmtData = (d) => d ? String(d).slice(0, 10).split("-").reverse().join("/") : "";
const fmtQuando = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

// Valor da negociação: o orçado quando existe, senão o palpite do comercial.
export const valorNeg = (n) => n.orcamento.valor || n.valorEstimado || 0;
const temOrcamento = (n) => n.orcamento.valor > 0;
// Já orçado (para os rótulos): tem valor ou ao menos o nº da proposta.
const foiOrcado = (n) => temOrcamento(n) || !!n.orcamento.numeroProposta;
const orcamentoVencido = (n) => !!n.orcamento.validade && n.orcamento.validade < hojeLocal() && negAtiva(n) && temOrcamento(n);

// Muda a etapa e deixa o passo no histórico (quem, quando, de onde veio).
function passo(n, etapa, quem, obs = "", extra = {}) {
  const em = agoraISO();
  return {
    ...n, ...extra, etapa, etapaEm: em,
    historico: [...n.historico, { etapa, de: n.etapa, em, porId: quem.id, porNome: quem.nome, obs }],
  };
}

// Badge do menu: o que está esperando por mim. Orçamentista: liberadas para orçamento (as minhas
// ou sem orçamentista). Comercial: orçamentos prontos (meus ou sem vendedor).
export function contarPendentesComercial(negs, com) {
  if (!negs.length) return 0;
  if (!com?.acessosAtivos) return negs.filter(n => n.etapa === "aguardando_orcamento" || n.etapa === "orcamento_pronto").length;
  const eu = com.eu?.id;
  let total = 0;
  if (com.temAcesso("orcamentista"))
    total += negs.filter(n => n.etapa === "aguardando_orcamento" && (!n.orcamentistaId || n.orcamentistaId === eu)).length;
  if (com.temAcesso("comercial"))
    total += negs.filter(n => n.etapa === "orcamento_pronto" && (!n.vendedorId || n.vendedorId === eu)).length;
  return total;
}

// ─── GRAVAÇÃO (usado pelo App) ───────────────────────────────────────────────
// Mesmo desenho do persistObra: debounce de 700 ms, fila por negociação e trava de versão.
// Mudança de etapa grava na hora (`imediato`). Conflito não sobrescreve: a negociação para de gravar
// e a tela mostra a faixa com "Recarregar".
export function useNegociacoes(userId, onErro) {
  const [negs, setNegs] = useState([]);
  const [semTabela, setSemTabela] = useState(false);
  const [conflitos, setConflitos] = useState([]);
  const [excluidos, setExcluidos] = useState([]);   // números de negociações excluídas (não voltam)
  const versao = useRef({});
  const fila = useRef({});
  const timers = useRef({});
  const pendentes = useRef({});
  const geracao = useRef({});
  const conflRef = useRef(new Set());
  const erroRef = useRef(onErro);
  erroRef.current = onErro;

  useEffect(() => {
    if (!userId) { setNegs([]); return; }
    let cancel = false;
    fetchNegociacoes().then(linhas => {
      if (cancel) return;
      if (linhas === null) { setSemTabela(true); setNegs([]); return; }
      setSemTabela(false);
      versao.current = Object.fromEntries(linhas.map(r => [r.neg.id, r.versao]));
      setNegs(linhas.map(r => normNegociacao(r.neg)));
    }).catch(err => { if (!cancel) erroRef.current?.("Erro ao carregar as negociações: " + err.message); });
    fetchNumerosNegExcluidas().then(l => { if (!cancel) setExcluidos(l); }).catch(err => console.warn("negociacoes_excluidas:", err.message));
    return () => { cancel = true; };
  }, [userId]);

  const enfileirar = useCallback((id, tarefa) => {
    const p = (fila.current[id] || Promise.resolve()).then(tarefa);
    fila.current[id] = p.catch(() => {});
    return p;
  }, []);

  const salvar = useCallback((n, imediato = false) => {
    setNegs(prev => prev.map(x => x.id === n.id ? n : x));
    const id = n.id;
    if (conflRef.current.has(id)) return Promise.resolve();
    const g = geracao.current[id] || 0;
    if (timers.current[id]) clearTimeout(timers.current[id]);
    const executar = () => {
      delete timers.current[id];
      delete pendentes.current[id];
      return enfileirar(id, async () => {
        if (conflRef.current.has(id) || (geracao.current[id] || 0) !== g) return;
        try {
          versao.current[id] = await salvarNegociacao(n, versao.current[id]);
        } catch (err) {
          if (err.conflito) { conflRef.current.add(id); setConflitos([...conflRef.current]); }
          else erroRef.current?.("Erro ao salvar a negociação — a alteração ainda não está no banco: " + err.message);
        }
      });
    };
    if (imediato) return executar();
    pendentes.current[id] = executar;
    timers.current[id] = setTimeout(executar, 700);
    return Promise.resolve();
  }, [enfileirar]);

  // INSERT (nunca upsert): número repetido é recusado. Só entra na lista depois que o banco aceita.
  const criar = useCallback(async (n) => {
    await enfileirar(n.id, async () => { versao.current[n.id] = await inserirNegociacao(n); });
    setNegs(prev => [...prev, n]);
  }, [enfileirar]);

  const recarregar = useCallback(async (id) => {
    try {
      const { neg, versao: v } = await fetchNegociacao(id);
      if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
      delete pendentes.current[id];
      geracao.current[id] = (geracao.current[id] || 0) + 1;
      versao.current[id] = v;
      conflRef.current.delete(id);
      setConflitos([...conflRef.current]);
      setNegs(prev => prev.map(x => x.id === id ? normNegociacao(neg) : x));
    } catch (err) {
      erroRef.current?.("Não deu para recarregar a negociação: " + err.message);
    }
  }, []);

  // Aba escondida ou fechando: dispara o que está esperando o debounce.
  useEffect(() => {
    const disparar = () => { for (const ex of Object.values(pendentes.current)) ex(); };
    const aoEsconder = () => { if (document.visibilityState === "hidden") disparar(); };
    const aoSair = (e) => { if (Object.keys(pendentes.current).length) { disparar(); e.preventDefault(); e.returnValue = ""; } };
    document.addEventListener("visibilitychange", aoEsconder);
    window.addEventListener("beforeunload", aoSair);
    return () => { document.removeEventListener("visibilitychange", aoEsconder); window.removeEventListener("beforeunload", aoSair); };
  }, []);

  // Excluir de vez (só master, só declinada). Espera a gravação pendente e passa pela fila: nenhuma
  // gravação atrasada tenta regravar uma negociação apagada.
  const excluir = useCallback(async (id) => {
    if (timers.current[id]) { clearTimeout(timers.current[id]); pendentes.current[id]?.(); }
    await enfileirar(id, () => excluirNegociacao(id));
    geracao.current[id] = (geracao.current[id] || 0) + 1;
    delete versao.current[id];
    setNegs(prev => prev.filter(x => x.id !== id));
    setExcluidos(prev => [...prev, id]);
  }, [enfileirar]);

  return { negs, semTabela, conflitos, excluidos, salvar, criar, recarregar, excluir };
}

// ─── ESTILOS ─────────────────────────────────────────────────────────────────
const inp = { width: "100%", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };
const lbl = { fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 3, display: "block" };
const btnSec = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 12px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };
const btnPri = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" };
const cartaoBase = { background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.07)" };

function useLargura() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return w;
}

// Capas: a ★ escolhida na negociação ou a primeira foto dela (mesma regra da obra).
function useCapas(negs) {
  const [fotos, setFotos] = useState({});
  const [urls, setUrls] = useState({});
  useEffect(() => { fetchFotosCapa().then(setFotos); }, []);
  const paths = useMemo(() => negs.map(n => n.capa?.path || fotos[n.id]).filter(Boolean), [negs, fotos]);
  const chave = paths.join("|");
  useEffect(() => {
    if (!paths.length) return;
    let cancel = false;
    urlsComCache(paths).then(u => { if (!cancel) setUrls(u); }).catch(err => console.warn("capas comercial:", err.message));
    return () => { cancel = true; };
  }, [chave]); // eslint-disable-line react-hooks/exhaustive-deps
  return (n) => urls[n.capa?.path || fotos[n.id]] || "";
}

function ChipEtapa({ etapa, pequeno }) {
  const e = ETAPA[etapa] || ETAPA.prospeccao;
  return (
    <span style={{ background: e.cor + "18", color: e.cor, border: `1px solid ${e.cor}44`, borderRadius: 999, padding: pequeno ? "1px 8px" : "3px 10px", fontSize: pequeno ? 10.5 : 11.5, fontWeight: 800, whiteSpace: "nowrap" }}>
      {e.icone} {e.rotulo}
    </span>
  );
}

function ChipPessoa({ icone, nome, titulo }) {
  if (!nome) return null;
  return (
    <span title={titulo} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#f1f5f9", borderRadius: 999, padding: "2px 8px 2px 3px", fontSize: 11, fontWeight: 700, color: "#475569", whiteSpace: "nowrap" }}>
      <Avatar nome={nome} tamanho={16} /> {icone} {nome}
    </span>
  );
}

function ChipDias({ n }) {
  const d = diasDesde(n.etapaEm);
  if (d === null || !negAtiva(n)) return null;
  const lim = ETAPA[n.etapa]?.limite || 999;
  const atrasado = d > lim;
  return (
    <span title={atrasado ? `Parada há mais de ${lim} dias nesta etapa` : "Dias nesta etapa"}
      style={{ fontSize: 11, fontWeight: 800, color: atrasado ? "#dc2626" : "#94a3b8" }}>
      ⏱ {d === 0 ? "hoje" : `${d} dia${d === 1 ? "" : "s"}`}
    </span>
  );
}

// ─── TELA ────────────────────────────────────────────────────────────────────
// view: { pasta?: "andamento"|"declinadas"|"convertidas", id? }
export default function ComercialView({
  negs, semTabela, conflitos = [], excluidos = [], pasta, negId, obras = [], orcamentos = [], atividadeVersao = 0,
  onNavegar, onSalvar, onCriar, onRecarregar, onAtividade, onConverter, onAbrirObra, onErro, onExcluir,
}) {
  const com = useComunicacao();
  const eu = com?.eu || null;
  const quem = eu ? { id: eu.id, nome: nomePessoa(eu) } : { id: null, nome: lerAutor() || "—" };
  // Sem a migration de acessos todos podem tudo (pessoaTemAcesso já trata `acessos === null`).
  const pode = (acesso) => !com?.acessosAtivos || com.temAcesso(acesso) || !!eu?.master;
  const pessoas = com?.pessoas || [];
  const capaDe = useCapas(negs);
  const [modal, setModal] = useState(null);   // { tipo, neg }

  // Aviso no 🔔 (e no WhatsApp, pelo gatilho do banco). Falhar o aviso não desfaz o passo.
  const avisar = useCallback((tipo, n, texto, para) => {
    if (!com?.ativo) return;
    notificarComercial({ tipo, negId: n.id, texto, para: para || null, dados: { negId: n.id } })
      .catch(err => {
        if (/notificar_comercial|schema cache|does not exist/i.test(err.message || "")) console.warn("notificar_comercial:", err.message);
        else onErro?.("O passo foi gravado, mas o aviso no 🔔 não saiu: " + err.message);
      });
  }, [com?.ativo, onErro]);

  const rotulo = (n) => `${n.numero} — ${n.cliente || "sem cliente"}`;

  // Todas as transições passam por aqui: grava na hora, registra na atividade e avisa quem precisa.
  function executar(acao, n, d = {}) {
    let nova = n;
    if (acao === "liberar") {
      const orc = pessoas.find(p => p.id === d.orcamentistaId);
      nova = passo(n, "aguardando_orcamento", quem, d.obs, {
        orcamentistaId: orc?.id || null, orcamentistaNome: orc ? nomePessoa(orc) : "",
        prazos: { ...n.prazos, entregaOrcamento: d.entregaOrcamento || n.prazos.entregaOrcamento },
      });
      onAtividade(n.id, `Liberado para orçamento${orc ? ` → ${nomePessoa(orc)}` : ""} por ${quem.nome}${d.obs ? `: ${d.obs}` : ""}`);
      avisar("comercial_liberado", nova, `${rotulo(nova)}${d.obs ? ` — ${d.obs}` : ""}`, orc?.id);
    } else if (acao === "pegar") {
      nova = passo(n, "em_orcamento", quem, "", { orcamentistaId: quem.id, orcamentistaNome: quem.nome });
      onAtividade(n.id, `${quem.nome} começou o orçamento`);
    } else if (acao === "pronto") {
      nova = passo(n, "orcamento_pronto", quem, d.obs, {
        orcamento: { ...n.orcamento, numeroProposta: d.numeroProposta, valor: numero(d.valor), validade: d.validade, obs: d.obs || n.orcamento.obs, prontoEm: agoraISO(), prontoPorId: quem.id, prontoPorNome: quem.nome },
        ...(!n.orcamentistaId ? { orcamentistaId: quem.id, orcamentistaNome: quem.nome } : {}),
      });
      onAtividade(n.id, `Orçamento pronto${d.numeroProposta ? ` — proposta #${d.numeroProposta}` : ""} por ${quem.nome}`);
      avisar("comercial_pronto", nova, `${rotulo(nova)}${d.numeroProposta ? ` · proposta #${d.numeroProposta}` : ""}`, n.vendedorId);
    } else if (acao === "negociar") {
      nova = passo(n, "negociacao", quem);
      onAtividade(n.id, `Em negociação com o cliente (${quem.nome})`);
    } else if (acao === "revisao") {
      nova = passo(n, "aguardando_orcamento", quem, d.motivo, {
        revisoes: [...n.revisoes, { em: agoraISO(), porId: quem.id, porNome: quem.nome, motivo: d.motivo, numeroAnterior: n.orcamento.numeroProposta, valorAnterior: n.orcamento.valor }],
      });
      onAtividade(n.id, `Revisão do orçamento pedida por ${quem.nome}: ${d.motivo}`);
      avisar("comercial_revisao", nova, `${rotulo(nova)} — ${d.motivo}`, n.orcamentistaId);
    } else if (acao === "declinar") {
      nova = passo(n, "declinada", quem, d.obs, { declinio: { motivo: d.motivo, obs: d.obs, porId: quem.id, porNome: quem.nome, em: agoraISO() } });
      onAtividade(n.id, `Declinada por ${quem.nome}: ${ROTULO_MOTIVO[d.motivo] || d.motivo}${d.obs ? ` — ${d.obs}` : ""}`);
    } else if (acao === "reabrir") {
      const volta = [...n.historico].reverse().find(h => h.etapa === n.etapa && ATIVAS.has(h.de))?.de || "negociacao";
      nova = passo(n, volta, quem, "reaberta", { declinio: null });
      onAtividade(n.id, `Reaberta por ${quem.nome} (volta para ${ETAPA[volta].rotulo})`);
    } else if (acao === "mover") {
      nova = passo(n, d.etapa, quem, "movida à mão");
      onAtividade(n.id, `Etapa: ${ETAPA[n.etapa].rotulo} → ${ETAPA[d.etapa].rotulo} (${quem.nome})`);
    }
    onSalvar(nova, true);
    setModal(null);
  }

  // Responsável trocado na ficha: registra e avisa a pessoa marcada.
  function trocarResponsavel(n, campo, pessoaId) {
    const p = pessoas.find(x => x.id === pessoaId);
    const nome = p ? nomePessoa(p) : "";
    const nova = campo === "vendedor"
      ? { ...n, vendedorId: p?.id || null, vendedorNome: nome, vendedor: n.vendedor || nome }
      : { ...n, orcamentistaId: p?.id || null, orcamentistaNome: nome };
    onSalvar(nova, true);
    onAtividade(n.id, `${campo === "vendedor" ? "Vendedor" : "Orçamentista"}: ${nome || "ninguém"} (por ${quem.nome})`);
    if (p && p.id !== quem.id) avisar("comercial_atribuido", nova, `${rotulo(nova)} — você é o ${campo === "vendedor" ? "vendedor" : "orçamentista"}`, p.id);
  }

  async function criarNova(dados) {
    const numeroNovo = proximoNumeroNeg(negs, excluidos);
    const n = normNegociacao({
      ...dados, id: numeroNovo, numero: numeroNovo,
      etapa: "prospeccao", criadaEm: agoraISO(), etapaEm: agoraISO(), criadaPorId: quem.id, criadaPorNome: quem.nome,
      historico: [{ etapa: "prospeccao", de: "", em: agoraISO(), porId: quem.id, porNome: quem.nome, obs: "criada" }],
    });
    n.id = n.numero;
    await onCriar(n);
    onAtividade(n.id, `Negociação criada por ${quem.nome}`);
    if (n.vendedorId && n.vendedorId !== quem.id) avisar("comercial_atribuido", n, `${rotulo(n)} — você é o vendedor`, n.vendedorId);
    setModal(null);
    onNavegar({ id: n.id });
  }

  // 🗑 Excluir de vez: só o master, e só declinada (o banco confere as duas coisas de novo).
  const podeExcluir = !!eu?.master && !!onExcluir;
  async function excluir(n) {
    if (!window.confirm(`Excluir de vez a negociação ${n.numero} — ${n.cliente || "sem cliente"}?

Ela sai do app; uma cópia fica guardada no banco (negociacoes_excluidas). Fotos, anexos e comentários não são apagados.`)) return;
    try {
      await onExcluir(n.id);
      if (negId === n.id) onNavegar({ pasta: "declinadas" }, true);
    } catch (err) {
      onErro?.("Não deu para excluir a negociação: " + err.message);
    }
  }

  const ctx = { pode, quem, executar, setModal, capaDe, onNavegar, onConverter, onAbrirObra, podeExcluir, excluir };

  let conteudo;
  if (semTabela) {
    conteudo = (
      <div style={{ ...cartaoBase, padding: 24, maxWidth: 640, margin: "40px auto", fontSize: 13.5, color: "#475569" }}>
        <div style={{ fontSize: 28 }}>💼</div>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a1a", margin: "6px 0" }}>Falta criar a tabela do Comercial</div>
        Rode a <code>supabase/migration_comercial.sql</code> no SQL Editor do Supabase (depois da migration de acessos) e recarregue a página.
      </div>
    );
  } else if (negId) {
    const n = negs.find(x => x.id === negId);
    conteudo = n
      ? <FichaNegociacao n={n} ctx={ctx} pessoas={pessoas} obras={obras} orcamentos={orcamentos} atividadeVersao={atividadeVersao}
          onSalvar={onSalvar} onAtividade={onAtividade} onTrocarResponsavel={trocarResponsavel} />
      : <div style={{ padding: 60, textAlign: "center", color: "#64748b" }}>Negociação não encontrada.</div>;
  } else if (pasta === "andamento") {
    conteudo = <Quadro negs={negs.filter(negAtiva)} ctx={ctx} eu={eu} onNova={() => setModal({ tipo: "nova" })} />;
  } else if (pasta === "declinadas" || pasta === "convertidas") {
    conteudo = <ListaFinal negs={negs.filter(n => n.etapa === (pasta === "declinadas" ? "declinada" : "convertida"))} pasta={pasta} ctx={ctx} />;
  } else {
    conteudo = <Painel negs={negs} onAbrirPasta={p => onNavegar({ pasta: p })} onNova={() => setModal({ tipo: "nova" })} podeCriar={pode("comercial")} />;
  }

  return (
    <div>
      {conflitos.length > 0 && (
        <div style={{ background: "#fef2f2", borderBottom: "1px solid #fecaca", padding: "10px 20px", fontSize: 13, color: "#991b1b", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 260 }}>
            ⚠ A negociação <b>{conflitos.join(", ")}</b> foi alterada em outra aba ou outro computador depois que você abriu.
            Para não apagar o que a outra pessoa gravou, <b>suas últimas alterações nela não foram salvas</b>. Recarregue e refaça o que faltar.
          </span>
          {conflitos.map(id => (
            <button key={id} onClick={() => onRecarregar(id)}
              style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              Recarregar {id}
            </button>
          ))}
        </div>
      )}
      {conteudo}

      {modal?.tipo === "nova" && <ModalNova pessoas={pessoas} eu={eu} onFechar={() => setModal(null)} onCriar={criarNova} />}
      {modal?.tipo === "liberar" && <ModalLiberar n={modal.neg} pessoas={pessoas} onFechar={() => setModal(null)} onOk={d => executar("liberar", modal.neg, d)} />}
      {modal?.tipo === "pronto" && <ModalPronto n={modal.neg} onFechar={() => setModal(null)} onAtividade={onAtividade} onOk={d => executar("pronto", modal.neg, d)} />}
      {modal?.tipo === "revisao" && <ModalMotivo titulo={`Pedir revisão — ${modal.neg.numero}`} rotulo="O que mudar no orçamento?" botao="Pedir revisão"
        onFechar={() => setModal(null)} onOk={motivo => executar("revisao", modal.neg, { motivo })} />}
      {modal?.tipo === "declinar" && <ModalDeclinar n={modal.neg} onFechar={() => setModal(null)} onOk={d => executar("declinar", modal.neg, d)} />}
    </div>
  );
}

// ─── AÇÕES ───────────────────────────────────────────────────────────────────
// A próxima ação de cada etapa, para o cartão e para a ficha. `pode` diz se este login faz esse passo.
function proximasAcoes(n, ctx) {
  const { pode, setModal, executar, onConverter, quem } = ctx;
  const c = pode("comercial"), o = pode("orcamentista");
  const semC = "Só quem tem o acesso Comercial", semO = "Só quem tem o acesso Orçamentista";
  switch (n.etapa) {
    case "prospeccao": return [{ rotulo: "📤 Liberar para orçamento", ok: c, dica: semC, fazer: () => setModal({ tipo: "liberar", neg: n }) }];
    case "aguardando_orcamento": return [{ rotulo: "📐 Pegar orçamento", ok: o, dica: semO, fazer: () => executar("pegar", n) }];
    case "em_orcamento": return [{ rotulo: "✔ Orçamento pronto", ok: o || c, dica: semO, fazer: () => setModal({ tipo: "pronto", neg: n }) }];
    case "orcamento_pronto": return [
      { rotulo: "🤝 Iniciar negociação", ok: c, dica: semC, fazer: () => executar("negociar", n) },
      { rotulo: "🔁 Revisão", ok: c, dica: semC, secundario: true, fazer: () => setModal({ tipo: "revisao", neg: n }) },
    ];
    case "negociacao": return [
      { rotulo: "🏗 Converter em obra", ok: c, dica: semC, verde: true, fazer: () => onConverter(n, quem) },
      { rotulo: "🔁 Revisão", ok: c, dica: semC, secundario: true, fazer: () => setModal({ tipo: "revisao", neg: n }) },
    ];
    case "declinada": return [{ rotulo: "↺ Reabrir", ok: c, dica: semC, fazer: () => executar("reabrir", n) }];
    default: return [];
  }
}

function BotoesAcao({ n, ctx, comDeclinar = false, compacto = false }) {
  const acoes = proximasAcoes(n, ctx);
  if (comDeclinar && negAtiva(n)) acoes.push({ rotulo: "✖ Declinar", ok: ctx.pode("comercial"), dica: "Só quem tem o acesso Comercial", perigo: true, fazer: () => ctx.setModal({ tipo: "declinar", neg: n }) });
  if (!acoes.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onClick={e => e.stopPropagation()}>
      {acoes.map(a => {
        const estilo = a.secundario || a.perigo
          ? { ...btnSec, color: a.perigo ? "#dc2626" : "#475569", borderColor: a.perigo ? "#fecaca" : "#e2e8f0" }
          : { ...btnPri, background: a.verde ? "#10b981" : "#1a1a1a" };
        return (
          <button key={a.rotulo} disabled={!a.ok} title={a.ok ? "" : a.dica} onClick={a.fazer}
            style={{ ...estilo, padding: compacto ? "5px 10px" : estilo.padding, fontSize: compacto ? 11.5 : 12.5, opacity: a.ok ? 1 : 0.4, cursor: a.ok ? "pointer" : "not-allowed" }}>
            {a.rotulo}
          </button>
        );
      })}
    </div>
  );
}

// ─── PAINEL ──────────────────────────────────────────────────────────────────
function Painel({ negs, onAbrirPasta, onNova, podeCriar }) {
  const ativas = negs.filter(negAtiva);
  const clientes = new Set(ativas.map(n => chaveCliente(n.cliente) || n.id)).size;
  const valorAtivo = ativas.reduce((s, n) => s + valorNeg(n), 0);
  const orcado = ativas.filter(temOrcamento).reduce((s, n) => s + n.orcamento.valor, 0);
  const naFila = ativas.filter(n => n.etapa === "aguardando_orcamento" || n.etapa === "em_orcamento");
  const filaAtrasada = naFila.filter(n => diasDesde(n.etapaEm) > ETAPA[n.etapa].limite).length;
  // Conversão nos últimos 12 meses: fechadas ÷ (fechadas + declinadas) decididas no período.
  const corte = new Date(Date.now() - 365 * 86400000).toISOString();
  const conv12 = negs.filter(n => n.etapa === "convertida" && (n.conversao?.em || n.etapaEm) >= corte);
  const decl12 = negs.filter(n => n.etapa === "declinada" && (n.declinio?.em || n.etapaEm) >= corte);
  const taxa = conv12.length + decl12.length ? Math.round(conv12.length / (conv12.length + decl12.length) * 100) : null;
  const valorFechado = conv12.reduce((s, n) => s + valorNeg(n), 0);
  const declinadas = negs.filter(n => n.etapa === "declinada").length;
  const convertidas = negs.filter(n => n.etapa === "convertida").length;
  const porEtapa = ETAPAS_NEG.map(e => {
    const l = ativas.filter(n => n.etapa === e.id);
    return { ...e, n: l.length, valor: l.reduce((s, x) => s + valorNeg(x), 0) };
  });
  const maxN = Math.max(1, ...porEtapa.map(e => e.n));
  const motivos = MOTIVOS_DECLINIO.map(m => ({ ...m, n: decl12.filter(n => n.declinio?.motivo === m.id).length })).filter(m => m.n > 0).sort((a, b) => b.n - a.n);

  return (
    <div style={{ padding: "24px 28px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button onClick={onNova} disabled={!podeCriar} title={podeCriar ? "" : "Só quem tem o acesso Comercial"}
          style={{ ...btnPri, padding: "9px 18px", fontSize: 13, opacity: podeCriar ? 1 : 0.4 }}>+ Nova negociação</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Em negociação", value: ativas.length, sub: `${clientes} cliente${clientes === 1 ? "" : "s"}`, accent: "#1a1a1a" },
          { label: "Valor em orçamento", value: <Dinheiro v={valorAtivo} />, sub: <>orçado <Dinheiro v={orcado} /> · resto estimado</>, accent: "#c9a227" },
          { label: "Na fila do orçamentista", value: naFila.length, sub: filaAtrasada ? <span style={{ color: "#dc2626", fontWeight: 700 }}>{filaAtrasada} parada{filaAtrasada > 1 ? "s" : ""} além do prazo</span> : "aguardando ou em orçamento", accent: "#8b5cf6" },
          { label: "Conversão (12 meses)", value: taxa === null ? "—" : `${taxa}%`, sub: <>{conv12.length} fechada{conv12.length === 1 ? "" : "s"} (<Dinheiro v={valorFechado} />) · {decl12.length} declinada{decl12.length === 1 ? "" : "s"}</>, accent: "#10b981" },
        ].map(({ label, value, sub, accent }) => (
          <div key={label} style={{ ...cartaoBase, padding: 20, borderLeft: `4px solid ${accent}` }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: accent }}>{value}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Funil: quantas e quanto em cada etapa */}
      <div style={{ ...cartaoBase, padding: "18px 22px", marginBottom: 24, borderLeft: "4px solid #c9a227", display: "flex", gap: 28, flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 380px", minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Funil — negociações ativas por etapa</div>
          {porEtapa.map(e => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7, fontSize: 12.5 }}>
              <span style={{ width: 170, flexShrink: 0, color: "#334155", fontWeight: 600 }}>{e.icone} {e.rotulo}</span>
              <div style={{ flex: 1, background: "#f1f5f9", borderRadius: 6, height: 16, minWidth: 60 }}>
                <div style={{ width: `${(e.n / maxN) * 100}%`, background: e.cor, height: "100%", borderRadius: 6, minWidth: e.n ? 6 : 0 }} />
              </div>
              <span style={{ width: 28, textAlign: "right", fontWeight: 800 }}>{e.n}</span>
              <span style={{ width: 130, textAlign: "right", color: "#64748b" }}><Dinheiro v={e.valor} /></span>
            </div>
          ))}
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Por que perdemos (12 meses)</div>
          {motivos.length === 0
            ? <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Nenhuma declinada no período.</div>
            : motivos.map(m => (
              <div key={m.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>{m.rotulo}</span><b>{m.n}</b>
              </div>
            ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {[
          { key: "andamento", label: "Em Andamento", count: ativas.length, sub: "prospecção, orçamento e negociação", accent: "#3b82f6" },
          { key: "declinadas", label: "Declinadas", count: declinadas, sub: "não fecharam — com o motivo", accent: "#dc2626" },
        ].map(({ key, label, count, sub, accent }) => (
          <div key={key} onClick={() => onAbrirPasta(key)}
            style={{ ...cartaoBase, padding: 24, borderLeft: `4px solid ${accent}`, cursor: "pointer", transition: "box-shadow 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.07)"}>
            <div style={{ fontSize: 32 }}>📁</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "#1e293b", marginTop: 8 }}>{label}</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>{sub}</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: accent, marginTop: 10 }}>{count}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
        <button onClick={() => onAbrirPasta("convertidas")}
          style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, color: "#475569", cursor: "pointer" }}>
          ✅ Convertidas em obra <span style={{ color: "#94a3b8", fontWeight: 600 }}>({convertidas})</span>
        </button>
      </div>
    </div>
  );
}

// ─── QUADRO (Em andamento) ───────────────────────────────────────────────────
function Quadro({ negs, ctx, eu, onNova }) {
  const [busca, setBusca] = useEstadoSessao("com.busca", "");
  const [minhas, setMinhas] = useEstadoSessao("com.minhas", false);
  const [aba, setAba] = useEstadoSessao("com.aba", "prospeccao");
  const largura = useLargura();
  const estreito = largura < 900;
  const q = busca.trim().toLowerCase();
  const filtradas = negs.filter(n => {
    if (minhas && eu && n.vendedorId !== eu.id && n.orcamentistaId !== eu.id) return false;
    if (!q) return true;
    return [n.numero, n.cliente, n.obra, n.cidade, n.cadastro.enderecoObra, n.vendedorNome, n.orcamentistaNome, n.orcamento.numeroProposta]
      .some(v => (v || "").toLowerCase().includes(q));
  });
  const colunas = ETAPAS_NEG.map(e => ({ ...e, lista: filtradas.filter(n => n.etapa === e.id).sort((a, b) => (a.etapaEm || "").localeCompare(b.etapaEm || "")) }));

  return (
    <div style={{ padding: "18px 20px" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar cliente, cidade, endereço, nº…"
          style={{ ...inp, maxWidth: 340, flex: "1 1 220px" }} />
        {eu && (
          <label style={{ fontSize: 12.5, fontWeight: 700, color: "#475569", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={minhas} onChange={e => setMinhas(e.target.checked)} /> Só as minhas
          </label>
        )}
        <button onClick={onNova} disabled={!ctx.pode("comercial")} style={{ ...btnPri, marginLeft: "auto", opacity: ctx.pode("comercial") ? 1 : 0.4 }}>+ Nova negociação</button>
      </div>

      {estreito && (
        <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 4 }}>
          {colunas.map(c => (
            <button key={c.id} onClick={() => setAba(c.id)}
              style={{ ...btnSec, whiteSpace: "nowrap", background: aba === c.id ? c.cor : "#fff", color: aba === c.id ? "#fff" : "#475569", borderColor: aba === c.id ? c.cor : "#e2e8f0" }}>
              {c.icone} {c.rotulo} ({c.lista.length})
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: estreito ? "1fr" : `repeat(${colunas.length}, minmax(0, 1fr))`, gap: 12, alignItems: "start" }}>
        {colunas.filter(c => !estreito || c.id === aba).map(c => {
          const total = c.lista.reduce((s, n) => s + valorNeg(n), 0);
          return (
            <div key={c.id} style={{ background: "#e9eef5", borderRadius: 12, padding: 10, minWidth: 0 }}>
              <div style={{ borderTop: `3px solid ${c.cor}`, margin: "-10px -10px 8px", borderRadius: "12px 12px 0 0" }} />
              {!estreito && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, padding: "0 2px" }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: "#1e293b" }}>{c.icone} {c.rotulo}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: c.cor }}>{c.lista.length}</span>
                </div>
              )}
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, padding: "0 2px" }}><Dinheiro v={total} /></div>
              {c.lista.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", padding: "10px 4px", textAlign: "center" }}>vazio</div>}
              {c.lista.map(n => <CartaoNeg key={n.id} n={n} ctx={ctx} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CartaoNeg({ n, ctx }) {
  const capa = ctx.capaDe(n);
  const local = [n.cadastro.enderecoObra, n.cidade].filter(Boolean).join(" · ");
  return (
    <div onClick={() => ctx.onNavegar({ id: n.id })}
      style={{ ...cartaoBase, padding: 10, marginBottom: 8, cursor: "pointer", border: "1px solid #e2e8f0" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.12)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.07)"}>
      {capa && <img src={capa} alt="" style={{ width: "100%", height: 96, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block" }} />}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}>
        <span style={{ background: "#1a1a1a", color: "#fff", borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 800 }}>{n.numero}</span>
        <ChipDias n={n} />
      </div>
      <div style={{ fontWeight: 800, fontSize: 13.5, color: "#1e293b", marginTop: 6, lineHeight: 1.25 }}>{n.cliente || "Sem cliente"}</div>
      {n.obra && <div style={{ fontSize: 12, color: "#475569" }}>{n.obra}</div>}
      {local && <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>📍 {local}</div>}
      <div style={{ fontSize: 13, fontWeight: 800, color: temOrcamento(n) ? "#c9a227" : "#94a3b8", marginTop: 6 }}>
        <Dinheiro v={valorNeg(n)} /> <span style={{ fontSize: 10.5, fontWeight: 600 }}>{foiOrcado(n) ? (n.orcamento.numeroProposta ? `· #${n.orcamento.numeroProposta}` : "· orçado") : "· estimado"}</span>
      </div>
      {orcamentoVencido(n) && <div style={{ fontSize: 11, fontWeight: 800, color: "#dc2626" }}>⚠ validade vencida em {fmtData(n.orcamento.validade)}</div>}
      {n.revisoes.length > 0 && <div style={{ fontSize: 11, color: "#8b5cf6", fontWeight: 700 }}>🔁 {n.revisoes.length} revis{n.revisoes.length === 1 ? "ão" : "ões"}</div>}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", margin: "6px 0" }}>
        <ChipPessoa icone="💼" nome={n.vendedorNome} titulo="Vendedor" />
        <ChipPessoa icone="📐" nome={n.orcamentistaNome} titulo="Orçamentista" />
      </div>
      <BotoesAcao n={n} ctx={ctx} compacto />
    </div>
  );
}

// ─── DECLINADAS / CONVERTIDAS ────────────────────────────────────────────────
function ListaFinal({ negs, pasta, ctx }) {
  const [busca, setBusca] = useEstadoSessao(`com.${pasta}.busca`, "");
  const q = busca.trim().toLowerCase();
  const lista = negs
    .filter(n => !q || [n.numero, n.cliente, n.obra, n.cidade].some(v => (v || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.etapaEm || "").localeCompare(a.etapaEm || ""));
  return (
    <div style={{ padding: "18px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar…" style={{ ...inp, maxWidth: 340, marginBottom: 14 }} />
      {lista.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13, padding: 30, textAlign: "center" }}>Nenhuma negociação aqui.</div>}
      {lista.map(n => {
        const capa = ctx.capaDe(n);
        return (
          <div key={n.id} onClick={() => ctx.onNavegar({ id: n.id })}
            style={{ ...cartaoBase, padding: "14px 18px", marginBottom: 10, cursor: "pointer", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ background: "#1a1a1a", color: "#fff", borderRadius: 7, padding: "4px 10px", fontSize: 13, fontWeight: 800 }}>{n.numero}</span>
            {capa && <img src={capa} alt="" style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 7 }} />}
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>{n.cliente || "Sem cliente"}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>{[n.obra, n.cidade].filter(Boolean).join(" · ")}</div>
            </div>
            <div style={{ fontWeight: 800, color: "#c9a227" }}><Dinheiro v={valorNeg(n)} /></div>
            {pasta === "declinadas" ? (
              <div style={{ fontSize: 12, color: "#991b1b", minWidth: 200 }}>
                <b>{ROTULO_MOTIVO[n.declinio?.motivo] || "Sem motivo"}</b>{n.declinio?.obs ? ` — ${n.declinio.obs}` : ""}
                <div style={{ color: "#94a3b8" }}>{n.declinio?.porNome} · {fmtData(n.declinio?.em || n.etapaEm)}</div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#166534", minWidth: 180 }}>
                {n.conversao?.obraId
                  ? <button onClick={e => { e.stopPropagation(); ctx.onAbrirObra(n.conversao.obraId); }} style={{ ...btnSec, color: "#166534", borderColor: "#bbf7d0" }}>🏗 Obra #{n.conversao.obraId}</button>
                  : "—"}
                <div style={{ color: "#94a3b8", marginTop: 3 }}>{n.conversao?.porNome} · {fmtData(n.conversao?.em || n.etapaEm)}</div>
              </div>
            )}
            {pasta === "declinadas" && <BotoesAcao n={n} ctx={ctx} compacto />}
            {pasta === "declinadas" && ctx.podeExcluir && (
              <button onClick={e => { e.stopPropagation(); ctx.excluir(n); }} title="Excluir de vez (só o master)"
                style={{ ...btnSec, color: "#dc2626", borderColor: "#fecaca", padding: "5px 10px", fontSize: 11.5 }}>🗑 Excluir</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── FICHA DA NEGOCIAÇÃO ─────────────────────────────────────────────────────
function Bloco({ titulo, icone, resumo, aberto: inicial = true, children }) {
  const [aberto, setAberto] = useState(inicial);
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, marginBottom: 10 }}>
      <div role="button" tabIndex={0} onClick={() => setAberto(a => !a)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setAberto(a => !a); } }}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ fontSize: 10, color: "#94a3b8", width: 10, display: "inline-block", transform: aberto ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
        <span style={{ fontSize: 15 }}>{icone}</span>
        <span style={{ fontWeight: 800, fontSize: 13.5, color: "#1a1a1a", whiteSpace: "nowrap" }}>{titulo}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#64748b", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{resumo}</span>
      </div>
      {aberto && <div style={{ borderTop: "1px solid #f1f5f9", padding: 16 }}>{children}</div>}
    </div>
  );
}

function EscolhaPessoa({ valor, pessoas, acesso, onChange, disabled }) {
  const comAcesso = pessoas.filter(p => pessoaTemAcesso(p, acesso));
  const lista = comAcesso.length ? comAcesso : pessoas;
  const fora = valor && !lista.some(p => p.id === valor) ? pessoas.find(p => p.id === valor) : null;
  return (
    <select value={valor || ""} disabled={disabled} onChange={e => onChange(e.target.value || null)} style={{ ...inp, cursor: disabled ? "not-allowed" : "pointer" }}>
      <option value="">— ninguém —</option>
      {[...lista, ...(fora ? [fora] : [])].map(p => <option key={p.id} value={p.id}>{nomePessoa(p)}</option>)}
    </select>
  );
}

function FichaNegociacao({ n, ctx, pessoas, obras, orcamentos, atividadeVersao, onSalvar, onAtividade, onTrocarResponsavel }) {
  const capa = ctx.capaDe(n);
  const podeEditar = ctx.pode("comercial") || ctx.pode("orcamentista");
  const finalizada = !negAtiva(n);
  const [nAnexos, setNAnexos] = useState(null);
  const set = (campos) => onSalvar({ ...n, ...campos });
  const etapaIdx = ETAPAS_NEG.findIndex(e => e.id === n.etapa);
  const obraConv = n.conversao?.obraId ? obras.find(o => o.id === n.conversao.obraId) : null;

  function mover(e) {
    if (!ctx.pode("comercial") || finalizada || e.id === n.etapa) return;
    if (!window.confirm(`Mover ${n.numero} de "${ETAPA[n.etapa].rotulo}" para "${e.rotulo}"? Fica registrado no histórico.`)) return;
    ctx.executar("mover", n, { etapa: e.id });
  }

  return (
    <div style={{ color: "#1e293b" }}>
      {/* Cabeçalho: quem é, onde é, em que pé está */}
      <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "12px 20px" }}>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          {capa && <img src={capa} alt="" style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0", flexShrink: 0 }} />}
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>
              Negociação {n.numero}{n.origem ? ` · ${ORIGENS.find(o => o.id === n.origem)?.rotulo}` : ""}{n.criadaEm ? ` · desde ${fmtData(n.criadaEm)}` : ""}
            </div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{n.obra || n.cliente || "Sem cliente"}</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>{[n.obra ? n.cliente : "", n.cadastro.enderecoObra, n.cidade].filter(Boolean).join(" · ")}</div>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, color: "#c9a227", fontSize: 15 }}>
              <Dinheiro v={valorNeg(n)} /> <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>{temOrcamento(n) ? "orçado" : "estimado"}</span>
            </div>
            <ChipEtapa etapa={n.etapa} />
            <ChipDias n={n} />
            <BotoesAcao n={n} ctx={ctx} comDeclinar />
          </div>
        </div>

        {/* Barra de etapas: onde está, e o comercial pode mover à mão */}
        {!finalizada ? (
          <div style={{ display: "flex", gap: 4, marginTop: 12, overflowX: "auto" }}>
            {ETAPAS_NEG.map((e, i) => {
              const feita = i < etapaIdx, atual = i === etapaIdx;
              return (
                <div key={e.id} onClick={() => mover(e)} title={ctx.pode("comercial") && !atual ? "Mover para esta etapa" : ""}
                  style={{ flex: "1 0 120px", textAlign: "center", padding: "6px 8px", fontSize: 11.5, fontWeight: 800, borderRadius: 6,
                    cursor: ctx.pode("comercial") && !atual ? "pointer" : "default",
                    background: atual ? e.cor : feita ? e.cor + "22" : "#f1f5f9", color: atual ? "#fff" : feita ? e.cor : "#94a3b8" }}>
                  {e.icone} {e.rotulo}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, fontSize: 13,
            background: n.etapa === "convertida" ? "#f0fdf4" : "#fef2f2", color: n.etapa === "convertida" ? "#166534" : "#991b1b",
            display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {n.etapa === "convertida" ? (
              <>✅ Convertida em obra por <b>{n.conversao?.porNome}</b> em {fmtData(n.conversao?.em)}.
                {n.conversao?.obraId && <button onClick={() => ctx.onAbrirObra(n.conversao.obraId)} style={{ ...btnSec, color: "#166534", borderColor: "#bbf7d0" }}>
                  🏗 Abrir obra #{n.conversao.obraId}{obraConv ? "" : " (não encontrada)"}</button>}</>
            ) : (
              <>✖ Declinada por <b>{n.declinio?.porNome}</b> em {fmtData(n.declinio?.em)}: <b>{ROTULO_MOTIVO[n.declinio?.motivo] || "—"}</b>{n.declinio?.obs ? ` — ${n.declinio.obs}` : ""}
                {ctx.podeExcluir && (
                  <button onClick={() => ctx.excluir(n)} title="Excluir de vez (só o master)"
                    style={{ ...btnSec, marginLeft: "auto", color: "#dc2626", borderColor: "#fecaca" }}>🗑 Excluir de vez</button>
                )}</>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", padding: "16px 20px" }}>
        <div style={{ flex: "999 1 600px", minWidth: 0 }}>
          <Bloco titulo="Cadastro do cliente" icone="🪪" resumo={[n.cadastro.contatoNome, n.cadastro.telefones].filter(Boolean).join(" · ") || "a preencher"}>
            <CadastroObra obra={n} onChange={o => set({ cliente: o.cliente, obra: o.obra, cidade: o.cidade, vendedor: o.vendedor, cadastro: o.cadastro })} comLinks />
          </Bloco>

          <Bloco titulo="Responsáveis e prazos" icone="👥" resumo={[n.vendedorNome && `💼 ${n.vendedorNome}`, n.orcamentistaNome && `📐 ${n.orcamentistaNome}`].filter(Boolean).join(" · ") || "ninguém marcado"}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px 14px" }}>
              <label><span style={lbl}>Vendedor (login)</span>
                <EscolhaPessoa valor={n.vendedorId} pessoas={pessoas} acesso="comercial" disabled={!ctx.pode("comercial")} onChange={id => onTrocarResponsavel(n, "vendedor", id)} />
              </label>
              <label><span style={lbl}>Orçamentista (login)</span>
                <EscolhaPessoa valor={n.orcamentistaId} pessoas={pessoas} acesso="orcamentista" disabled={!podeEditar} onChange={id => onTrocarResponsavel(n, "orcamentista", id)} />
              </label>
              <label><span style={lbl}>Origem</span>
                <select value={n.origem} onChange={e => set({ origem: e.target.value })} disabled={!podeEditar} style={inp}>
                  <option value="">—</option>
                  {ORIGENS.map(o => <option key={o.id} value={o.id}>{o.rotulo}</option>)}
                </select>
              </label>
              <label><span style={lbl}>Valor estimado</span>
                <Oculto><input type="number" min={0} step="0.01" value={n.valorEstimado || ""} disabled={!podeEditar}
                  onChange={e => set({ valorEstimado: numero(e.target.value) })} style={inp} /></Oculto>
              </label>
              <label><span style={lbl}>Entregar orçamento até</span>
                <input type="date" value={n.prazos.entregaOrcamento} disabled={!podeEditar} onChange={e => set({ prazos: { ...n.prazos, entregaOrcamento: e.target.value } })} style={inp} />
              </label>
              <label><span style={lbl}>Próximo retorno ao cliente</span>
                <input type="date" value={n.prazos.retornoCliente} disabled={!podeEditar} onChange={e => set({ prazos: { ...n.prazos, retornoCliente: e.target.value } })} style={inp} />
              </label>
            </div>
          </Bloco>

          <Bloco titulo="Orçamento" icone="📄"
            resumo={foiOrcado(n) ? <>{n.orcamento.numeroProposta ? `#${n.orcamento.numeroProposta} · ` : ""}<Dinheiro v={n.orcamento.valor} />{n.revisoes.length ? ` · ${n.revisoes.length} revisão(ões)` : ""}</> : "ainda não orçado"}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px 14px" }}>
              <label><span style={lbl}>Nº da proposta (Wvetro)</span>
                <input value={n.orcamento.numeroProposta} disabled={!podeEditar} onChange={e => set({ orcamento: { ...n.orcamento, numeroProposta: e.target.value.trim() } })} style={{ ...inp, fontWeight: 800 }} placeholder="vira o nº da obra" />
              </label>
              <label><span style={lbl}>Valor orçado</span>
                <Oculto><input type="number" min={0} step="0.01" value={n.orcamento.valor || ""} disabled={!podeEditar}
                  onChange={e => set({ orcamento: { ...n.orcamento, valor: numero(e.target.value) } })} style={inp} /></Oculto>
              </label>
              <label><span style={lbl}>Validade</span>
                <input type="date" value={n.orcamento.validade} disabled={!podeEditar} onChange={e => set({ orcamento: { ...n.orcamento, validade: e.target.value } })} style={inp} />
              </label>
              <label><span style={lbl}>Orçamento livre (OL)</span>
                <select value={n.orcamento.orcamentoLivreId} disabled={!podeEditar} onChange={e => set({ orcamento: { ...n.orcamento, orcamentoLivreId: e.target.value } })} style={inp}>
                  <option value="">—</option>
                  {orcamentos.map(o => <option key={o.id} value={o.id}>{o.numero} — {o.cliente?.nome || ""}</option>)}
                </select>
              </label>
              <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Observações do orçamento</span>
                <textarea rows={2} value={n.orcamento.obs} disabled={!podeEditar} onChange={e => set({ orcamento: { ...n.orcamento, obs: e.target.value } })} style={{ ...inp, resize: "vertical" }} />
              </label>
            </div>
            {n.orcamento.prontoEm && (
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>Pronto em {fmtQuando(n.orcamento.prontoEm)} por <b>{n.orcamento.prontoPorNome}</b>{orcamentoVencido(n) && <span style={{ color: "#dc2626", fontWeight: 800 }}> · validade vencida</span>}</div>
            )}
            {n.revisoes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={lbl}>Revisões pedidas</div>
                {n.revisoes.map((r, i) => (
                  <div key={i} style={{ fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid #f1f5f9" }}>
                    {fmtQuando(r.em)} · <b>{r.porNome}</b>: {r.motivo}
                    {(r.numeroAnterior || r.valorAnterior) ? <span style={{ color: "#94a3b8" }}> (antes: {r.numeroAnterior ? `#${r.numeroAnterior} ` : ""}{r.valorAnterior ? <Dinheiro v={r.valorAnterior} /> : ""})</span> : null}
                  </div>
                ))}
              </div>
            )}
          </Bloco>

          <Bloco titulo="Fotos e anexos" icone="📎" resumo={nAnexos === null ? "" : nAnexos === 0 ? "nenhum arquivo" : `${nAnexos} arquivo${nAnexos === 1 ? "" : "s"}`}>
            <AnexosObra obraId={n.id} capa={n.capa} recarregar={atividadeVersao}
              onCapa={c => set({ capa: c })}
              onAtividade={t => onAtividade(n.id, t)} onContagem={l => setNAnexos(l.length)} />
          </Bloco>

          <Bloco titulo="Linha do tempo" icone="🕑" resumo={`${n.historico.length} passo${n.historico.length === 1 ? "" : "s"}`} aberto={false}>
            {[...n.historico].reverse().map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid #f1f5f9", fontSize: 12.5 }}>
                <span style={{ color: "#94a3b8", width: 110, flexShrink: 0 }}>{fmtQuando(h.em)}</span>
                <span style={{ flex: 1 }}>
                  {h.de && ETAPA[h.de] ? <>{ETAPA[h.de].rotulo} → </> : null}<ChipEtapa etapa={h.etapa} pequeno />
                  {" "}por <b>{h.porNome || "—"}</b>{h.obs ? <span style={{ color: "#64748b" }}> — {h.obs}</span> : null}
                </span>
              </div>
            ))}
          </Bloco>
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 280, position: "sticky", top: 12 }}>
          <ComentariosObra obraId={n.id} recarregar={atividadeVersao} />
        </div>
      </div>
    </div>
  );
}

// ─── POPUPS ──────────────────────────────────────────────────────────────────
function Rodape({ onFechar, onOk, botao, ocupado, cor = "#1a1a1a" }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
      <button onClick={onFechar} disabled={ocupado} style={btnSec}>Cancelar</button>
      <button onClick={onOk} disabled={ocupado} style={{ ...btnPri, background: ocupado ? "#64748b" : cor, cursor: ocupado ? "wait" : "pointer" }}>{ocupado ? "Gravando…" : botao}</button>
    </div>
  );
}

function ModalNova({ pessoas, eu, onFechar, onCriar }) {
  const [f, setF] = useState(() => ({
    cliente: "", obra: "", cidade: "", vendedor: eu ? nomePessoa(eu) : "", origem: "", valorEstimado: 0,
    cadastro: normCadastro(), vendedorId: eu?.id || null,
  }));
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  async function ok() {
    if (!f.cliente.trim()) { setErro("Informe o cliente."); return; }
    setOcupado(true);
    const v = pessoas.find(p => p.id === f.vendedorId);
    try {
      await onCriar({ ...f, cliente: f.cliente.trim(), vendedorNome: v ? nomePessoa(v) : "", vendedor: f.vendedor || (v ? nomePessoa(v) : "") });
    } catch (err) {
      setErro(err.message);
      setOcupado(false);
    }
  }
  return (
    <Modal open title="Nova negociação" onClose={() => !ocupado && onFechar()} width={760}>
      <div style={{ maxHeight: "68vh", overflowY: "auto", paddingRight: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px 14px", marginBottom: 12 }}>
          <label><span style={lbl}>Vendedor (login)</span>
            <EscolhaPessoa valor={f.vendedorId} pessoas={pessoas} acesso="comercial" onChange={id => setF({ ...f, vendedorId: id })} />
          </label>
          <label><span style={lbl}>Origem</span>
            <select value={f.origem} onChange={e => setF({ ...f, origem: e.target.value })} style={inp}>
              <option value="">—</option>
              {ORIGENS.map(o => <option key={o.id} value={o.id}>{o.rotulo}</option>)}
            </select>
          </label>
          <label><span style={lbl}>Valor estimado</span>
            <Oculto><input type="number" min={0} step="0.01" value={f.valorEstimado || ""} onChange={e => setF({ ...f, valorEstimado: numero(e.target.value) })} style={inp} /></Oculto>
          </label>
        </div>
        <CadastroObra obra={f} onChange={o => { setF({ ...f, ...o }); setErro(""); }} />
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>Fotos e arquivos entram na ficha, logo depois de criar.</div>
      </div>
      {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginTop: 10 }}>{erro}</div>}
      <Rodape onFechar={onFechar} onOk={ok} botao="Criar negociação" ocupado={ocupado} />
    </Modal>
  );
}

function ModalLiberar({ n, pessoas, onFechar, onOk }) {
  const [orcamentistaId, setOrc] = useState(n.orcamentistaId);
  const [entregaOrcamento, setEntrega] = useState(n.prazos.entregaOrcamento);
  const [obs, setObs] = useState("");
  return (
    <Modal open title={`Liberar para orçamento — ${n.numero}`} onClose={onFechar} width={480}>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 12 }}>
        Sem orçamentista escolhido, o aviso vai para todos que têm o acesso Orçamentista e o primeiro que pegar fica com ela.
      </div>
      <label style={{ display: "block", marginBottom: 10 }}><span style={lbl}>Orçamentista</span>
        <EscolhaPessoa valor={orcamentistaId} pessoas={pessoas} acesso="orcamentista" onChange={setOrc} />
      </label>
      <label style={{ display: "block", marginBottom: 10 }}><span style={lbl}>Entregar até</span>
        <input type="date" value={entregaOrcamento} onChange={e => setEntrega(e.target.value)} style={inp} />
      </label>
      <label style={{ display: "block" }}><span style={lbl}>Recado para o orçamentista</span>
        <textarea rows={3} value={obs} onChange={e => setObs(e.target.value)} style={{ ...inp, resize: "vertical" }} placeholder="Linha, cor, vidro, o que o cliente pediu…" />
      </label>
      <Rodape onFechar={onFechar} onOk={() => onOk({ orcamentistaId, entregaOrcamento, obs: obs.trim() })} botao="📤 Liberar" />
    </Modal>
  );
}

function ModalPronto({ n, onFechar, onOk, onAtividade }) {
  const [f, setF] = useState({ numeroProposta: n.orcamento.numeroProposta, valor: n.orcamento.valor, validade: n.orcamento.validade, obs: "" });
  const [arquivos, setArquivos] = useState([]);
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  async function ok() {
    if (!f.numeroProposta && !f.valor) { setErro("Informe o nº da proposta ou o valor do orçamento."); return; }
    setOcupado(true);
    if (arquivos.length) {
      const { ok: subiu, falhas } = await enviarArquivos(n.id, arquivos.map(file => ({ file, categoria: "orcamento" })));
      if (subiu.length) onAtividade(n.id, `Anexou o orçamento: ${subiu.map(a => a.nome).join(", ")}`);
      if (falhas.length) { setErro("Não subiram: " + falhas.join(" · ")); setOcupado(false); return; }
    }
    onOk({ ...f, obs: f.obs.trim() });
  }
  return (
    <Modal open title={`Orçamento pronto — ${n.numero}`} onClose={() => !ocupado && onFechar()} width={520}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" }}>
        <label><span style={lbl}>Nº da proposta (Wvetro)</span>
          <input value={f.numeroProposta} onChange={e => setF({ ...f, numeroProposta: e.target.value.trim() })} style={{ ...inp, fontWeight: 800 }} autoFocus />
        </label>
        <label><span style={lbl}>Valor</span>
          <Oculto><input type="number" min={0} step="0.01" value={f.valor || ""} onChange={e => setF({ ...f, valor: numero(e.target.value) })} style={inp} /></Oculto>
        </label>
        <label><span style={lbl}>Validade</span>
          <input type="date" value={f.validade} onChange={e => setF({ ...f, validade: e.target.value })} style={inp} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}><span style={lbl}>Observação para o comercial</span>
          <textarea rows={2} value={f.obs} onChange={e => setF({ ...f, obs: e.target.value })} style={{ ...inp, resize: "vertical" }} />
        </label>
      </div>
      <div style={{ ...lbl, marginTop: 12 }}>PDF do orçamento (opcional)</div>
      {arquivos.map((a, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, padding: "3px 0" }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
          <button onClick={() => setArquivos(prev => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer" }}>×</button>
        </div>
      ))}
      <AreaSoltar onArquivos={fs => setArquivos(prev => [...prev, ...fs])} />
      {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginTop: 10 }}>{erro}</div>}
      <Rodape onFechar={onFechar} onOk={ok} botao="✔ Devolver ao comercial" ocupado={ocupado} cor="#2563eb" />
    </Modal>
  );
}

function ModalMotivo({ titulo, rotulo, botao, onFechar, onOk }) {
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState("");
  return (
    <Modal open title={titulo} onClose={onFechar} width={460}>
      <label style={{ display: "block" }}><span style={lbl}>{rotulo}</span>
        <textarea rows={3} value={motivo} onChange={e => { setMotivo(e.target.value); setErro(""); }} style={{ ...inp, resize: "vertical" }} autoFocus />
      </label>
      {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginTop: 8 }}>{erro}</div>}
      <Rodape onFechar={onFechar} onOk={() => motivo.trim() ? onOk(motivo.trim()) : setErro("Escreva o motivo.")} botao={botao} />
    </Modal>
  );
}

function ModalDeclinar({ n, onFechar, onOk }) {
  const [motivo, setMotivo] = useState("");
  const [obs, setObs] = useState("");
  const [erro, setErro] = useState("");
  return (
    <Modal open title={`Declinar — ${n.numero} ${n.cliente}`} onClose={onFechar} width={480}>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>Vai para a pasta Declinadas e pode ser reaberta depois. O motivo alimenta o "por que perdemos" do painel.</div>
      <label style={{ display: "block", marginBottom: 10 }}><span style={lbl}>Motivo *</span>
        <select value={motivo} onChange={e => { setMotivo(e.target.value); setErro(""); }} style={inp}>
          <option value="">— escolha —</option>
          {MOTIVOS_DECLINIO.map(m => <option key={m.id} value={m.id}>{m.rotulo}</option>)}
        </select>
      </label>
      <label style={{ display: "block" }}><span style={lbl}>Detalhe</span>
        <textarea rows={3} value={obs} onChange={e => setObs(e.target.value)} style={{ ...inp, resize: "vertical" }} placeholder="Ex.: fechou com a concorrência por 8% a menos" />
      </label>
      {erro && <div style={{ fontSize: 12.5, color: "#dc2626", marginTop: 8 }}>{erro}</div>}
      <Rodape onFechar={onFechar} onOk={() => motivo ? onOk({ motivo, obs: obs.trim() }) : setErro("Escolha o motivo.")} botao="✖ Declinar" cor="#dc2626" />
    </Modal>
  );
}
