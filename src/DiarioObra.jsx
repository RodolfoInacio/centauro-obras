import { useState, useRef, useEffect, useMemo } from "react";
import Modal from "./Modal";
import FotoMarkup, { redimensionarImagem, Assinatura } from "./FotoMarkup";
import { uploadFotoDiario } from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// Diário de Obras — um registro por obra por dia.
//
// O registro nasce ~80% preenchido: a agenda já sabe quem foi, para onde, e quais
// itens seriam montados. O usuário edita a diferença. Só a data é obrigatória;
// formulário longo com campo obrigatório é formulário não preenchido.
//
// Não é obrigação legal (a Resolução CONFEA 1.094/2017 do Livro de Ordem foi
// revogada em 2023) — é prova. O que paga a conta é o bloco de OCORRÊNCIAS com
// responsável e foto: é ele que mostra que o atraso não foi nosso.
// ─────────────────────────────────────────────────────────────────────────────

const MESES_CURTO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DIAS_LONGO = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

const TEMPOS = [
  { k: "bom", icone: "☀️", rotulo: "Bom" },
  { k: "nublado", icone: "⛅", rotulo: "Nublado" },
  { k: "chuva", icone: "🌧️", rotulo: "Chuvoso" },
];

// Lista fechada calibrada para esquadria de alumínio e vidro instalada em obra de
// terceiro. Nada de concretagem, cura ou índice pluviométrico: isso é vocabulário
// de construtora tocando a obra inteira.
const TIPOS_OCORRENCIA = [
  "Vão fora de esquadro / fora de medida",
  "Contramarco fora de prumo, nível ou posição",
  "Alvenaria ou acabamento não liberado",
  "Falta de energia, água, andaime ou elevador de carga",
  "Acesso bloqueado por outra empreiteira",
  "Peça danificada em obra",
  "Peça com erro de fábrica",
  "Falta de material",
  "Alteração pedida pelo cliente",
  "Chuva / impedimento climático",
  "Outro",
];

const RESPONSAVEIS = [
  { k: "centauro", rotulo: "Centauro", cor: "#f59e0b" },
  { k: "cliente", rotulo: "Cliente", cor: "#3b82f6" },
  { k: "terceiro", rotulo: "Terceiro", cor: "#8b5cf6" },
];

const STATUS_ATIVIDADE = ["Não iniciado", "Em andamento", "Concluído"];
const STATUS_ATIV_COR = { "Não iniciado": "#94a3b8", "Em andamento": "#3b82f6", "Concluído": "#10b981" };
// Espelha ETAPA_COLORS do App.jsx. Cor é decoração: etapa desconhecida cai no cinza.
const ETAPA_COR = { "Conf. Medidas": "#3b82f6", "Produção": "#8b5cf6", "Instalação": "#f97316", "Acabamentos": "#10b981" };

// ─── datas ───────────────────────────────────────────────────────────────────
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function partes(iso) {
  const [a, m, d] = (iso || "").split("-").map(Number);
  return { a, m, d };
}
function dataBR(iso) {
  if (!iso) return "";
  const { a, m, d } = partes(iso);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${a}`;
}
function dataExtenso(iso) {
  if (!iso) return "";
  const { a, m, d } = partes(iso);
  return `${String(d).padStart(2, "0")} ${MESES_CURTO[m - 1]} ${a}`;
}
function diaSemana(iso) {
  if (!iso) return "";
  const { a, m, d } = partes(iso);
  return DIAS_LONGO[new Date(a, m - 1, d).getDay()];
}

// ─── modelo ──────────────────────────────────────────────────────────────────
function uid(p) { return p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const TURNO_VAZIO = { tempo: "", praticavel: true };

function normFoto(f) {
  return {
    id: f.id || uid("ft"),
    url: f.url || "",
    urlOriginal: f.urlOriginal || f.url || "",
    caminho: f.caminho || "",
    legenda: f.legenda || "",
    // Só afeta a folha impressa: "grande" ocupa a largura inteira e sai sem corte
    // (contain); "normal" entra na grade de duas colunas.
    tamanho: f.tamanho === "grande" ? "grande" : "normal",
    tracos: Array.isArray(f.tracos) ? f.tracos : [],
  };
}

export function normDiario(d) {
  // Undefined-safe em tudo, como normObra/normAgendamento — campo novo entra com
  // default e registro antigo continua abrindo, sem migrar o banco.
  return {
    ...d,
    obraId: d.obraId || null,
    dia: d.dia || "",
    numero: Number.isFinite(d.numero) ? d.numero : 0,
    clima: {
      manha: { ...TURNO_VAZIO, ...((d.clima || {}).manha || {}) },
      tarde: { ...TURNO_VAZIO, ...((d.clima || {}).tarde || {}) },
    },
    equipes: (Array.isArray(d.equipes) ? d.equipes : []).map(e => ({
      // equipeId null = grupo avulso (visita do escritório, vistoria, dois de nós
      // conferindo). O rótulo é livre e só existe nesse caso.
      equipeId: e.equipeId || null,
      rotulo: e.rotulo || "",
      presentes: Array.isArray(e.presentes) ? e.presentes : [],
      horaInicio: e.horaInicio || "",
      horaFim: e.horaFim || "",
    })),
    atividades: (Array.isArray(d.atividades) ? d.atividades : []).map(a => ({
      id: a.id || uid("at"),
      itemId: a.itemId ?? null,
      texto: a.texto || "",
      etapa: a.etapa || "Instalação",
      status: a.status || "Em andamento",
      qtd: Number.isFinite(a.qtd) ? a.qtd : 0,
      local: a.local || "",
    })),
    ocorrencias: (Array.isArray(d.ocorrencias) ? d.ocorrencias : []).map(o => ({
      id: o.id || uid("oc"),
      tipo: o.tipo || TIPOS_OCORRENCIA[0],
      responsavel: o.responsavel || "cliente",
      horasParadas: Number.isFinite(o.horasParadas) ? o.horasParadas : 0,
      descricao: o.descricao || "",
      fotos: (Array.isArray(o.fotos) ? o.fotos : []).map(normFoto),
    })),
    visitas: (Array.isArray(d.visitas) ? d.visitas : []).map(v => ({
      id: v.id || uid("vi"), nome: v.nome || "", empresa: v.empresa || "", motivo: v.motivo || "",
    })),
    fotos: (Array.isArray(d.fotos) ? d.fotos : []).map(normFoto),
    materiais: Array.isArray(d.materiais) ? d.materiais : [],   // reservado para a v2
    observacoes: d.observacoes || "",
    endereco: d.endereco || "",
    assinaturas: { encarregado: "", cliente: "", ...(d.assinaturas || {}) },
    responsavel: d.responsavel || "",
    criadoEm: d.criadoEm || new Date().toISOString(),
  };
}

// O registro nasce da agenda: equipes, integrantes, endereço e itens do dia.
export function novoDiario({ obra, dia, agenda, equipes, diariosDaObra, responsavel }) {
  const servicos = (agenda || []).filter(a => a.dia === dia && a.obraId === obra.id);

  const vistas = new Set();
  const eqs = [];
  servicos.forEach(s => {
    if (!s.equipeId || vistas.has(s.equipeId)) return;
    vistas.add(s.equipeId);
    const eq = (equipes || []).find(e => e.id === s.equipeId);
    eqs.push({
      equipeId: s.equipeId,
      presentes: (eq && eq.integrantes ? eq.integrantes : []).slice(),  // todos presentes; desmarca quem faltou
      horaInicio: "", horaFim: "",
    });
  });

  const idsItens = [...new Set(servicos.flatMap(s => s.itens || []))];
  const atividades = idsItens.map(id => {
    const item = (obra.itens || []).find(i => String(i.id) === String(id));
    return {
      id: uid("at"), itemId: id, texto: "", etapa: "Instalação",
      status: "Em andamento", qtd: 0, local: (item && item.localizacao) || "",
    };
  });

  const maiorNumero = (diariosDaObra || []).reduce((n, d) => Math.max(n, d.numero || 0), 0);

  return normDiario({
    id: uid("di"),
    obraId: obra.id,
    dia,
    numero: maiorNumero + 1,
    endereco: (servicos[0] && servicos[0].endereco) || [obra.obra, obra.cidade].filter(Boolean).join(" · "),
    equipes: eqs,
    atividades,
    responsavel: responsavel || "",
  });
}

// ─── estilos recorrentes ─────────────────────────────────────────────────────
const painel = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16 };
const inp = { border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" };
const btnEscuro = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const btnClaro = { background: "#fff", color: "#1a1a1a", border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const btnDourado = { ...btnEscuro, background: "#c9a227" };

function Bloco({ titulo, sub, acao, children }) {
  return (
    <div style={{ ...painel, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#1a1a1a" }}>{titulo}</div>
          {sub && <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 2 }}>{sub}</div>}
        </div>
        {acao && <div style={{ marginLeft: "auto" }}>{acao}</div>}
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TELA PRINCIPAL — navegação interna em estado local, como CalendarView/DiaAgenda
// ─────────────────────────────────────────────────────────────────────────────
export default function DiarioView({ obras, equipes, agenda, diarios, obraInicial, usuario,
  onSalvar, onExcluir, onImprimir, onAbrirObra }) {
  const [obraId, setObraId] = useState(obraInicial || null);
  const [abertoId, setAbertoId] = useState(null);
  const [busca, setBusca] = useState("");

  const obra = obraId ? obras.find(o => o.id === obraId) : null;
  const aberto = abertoId ? diarios.find(d => d.id === abertoId) : null;

  if (aberto && obra) {
    return (
      <EditorDiario diario={aberto} obra={obra} equipes={equipes} agenda={agenda}
        onSalvar={onSalvar} onExcluir={onExcluir}
        onVoltar={() => setAbertoId(null)}
        onImprimir={() => onImprimir(obra.id, aberto.dia, aberto.dia)} />
    );
  }

  if (obra) {
    return (
      <CadernoObra obra={obra} equipes={equipes} agenda={agenda} diarios={diarios} usuario={usuario}
        onSalvar={onSalvar} onExcluir={onExcluir} onAbrir={setAbertoId}
        onVoltar={() => setObraId(null)} onImprimir={onImprimir} onAbrirObra={onAbrirObra} />
    );
  }

  // ── Nível 1: escolher a obra ──
  const termo = busca.trim().toLowerCase();
  const lista = obras.filter(o => !termo ||
    String(o.numero).includes(termo) ||
    (o.cliente || "").toLowerCase().includes(termo) ||
    (o.obra || "").toLowerCase().includes(termo));

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", margin: 0 }}>Diário de Obras</h2>
        <input type="search" value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar obra…"
          style={{ ...inp, marginLeft: "auto", width: 240 }} />
      </div>
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 18 }}>
        Escolha a obra para abrir o caderno. Cada dia vira um registro com clima, equipe, o que foi
        feito, ocorrências e fotos — pronto para imprimir ou salvar em PDF.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {lista.map(o => {
          const meus = diarios.filter(d => d.obraId === o.id);
          const ultimo = meus.reduce((max, d) => (d.dia > max ? d.dia : max), "");
          return (
            <div key={o.id} onClick={() => setObraId(o.id)}
              style={{ ...painel, padding: 16, cursor: "pointer", borderLeft: `4px solid ${meus.length ? "#c9a227" : "#e2e8f0"}` }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.10)"; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8" }}>#{o.numero}</div>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: "#1a1a1a", marginTop: 2 }}>{o.cliente}</div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{o.obra || "—"}</div>
              <div style={{ fontSize: 11.5, color: meus.length ? "#475569" : "#cbd5e1", marginTop: 10, fontWeight: 600 }}>
                {meus.length
                  ? `${meus.length} registro${meus.length > 1 ? "s" : ""} · último em ${dataBR(ultimo)}`
                  : "Nenhum registro ainda"}
              </div>
            </div>
          );
        })}
        {lista.length === 0 && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 60, color: "#94a3b8", fontSize: 14 }}>
            Nenhuma obra encontrada.
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nível 2: o caderno da obra
// ─────────────────────────────────────────────────────────────────────────────
function CadernoObra({ obra, equipes, agenda, diarios, usuario, onSalvar, onExcluir, onAbrir, onVoltar, onImprimir, onAbrirObra }) {
  const [criando, setCriando] = useState(false);
  const [diaNovo, setDiaNovo] = useState(hojeLocal());
  const [imprimindo, setImprimindo] = useState(false);
  const [pIni, setPIni] = useState("");
  const [pFim, setPFim] = useState(hojeLocal());
  const [excluindo, setExcluindo] = useState(null);

  const meus = useMemo(
    () => diarios.filter(d => d.obraId === obra.id).sort((a, b) => (b.dia || "").localeCompare(a.dia || "")),
    [diarios, obra.id]);

  const jaExiste = meus.find(d => d.dia === diaNovo);

  function criar() {
    if (jaExiste) { onAbrir(jaExiste.id); setCriando(false); return; }
    const d = novoDiario({ obra, dia: diaNovo, agenda, equipes, diariosDaObra: meus, responsavel: usuario });
    onSalvar(d);
    setCriando(false);
    onAbrir(d.id);
  }

  function abrirImpressao() {
    const ini = pIni || (meus.length ? meus[meus.length - 1].dia : hojeLocal());
    onImprimir(obra.id, ini, pFim);
  }

  // Quantos serviços dessa obra estão na agenda sem registro no diário — o "faltou fechar o dia".
  const semRegistro = useMemo(() => {
    const dias = new Set(agenda.filter(a => a.obraId === obra.id).map(a => a.dia));
    meus.forEach(d => dias.delete(d.dia));
    return [...dias].filter(d => d <= hojeLocal()).sort().reverse();
  }, [agenda, meus, obra.id]);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <button onClick={onVoltar} style={btnEscuro}>‹ Obras</button>
        <div onClick={() => onAbrirObra && onAbrirObra(obra.id)} title="Abrir a obra"
          style={{ cursor: onAbrirObra ? "pointer" : "default" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a1a" }}>#{obra.numero} — {obra.cliente}</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{obra.obra || "—"}{obra.cidade ? " · " + obra.cidade : ""}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {meus.length > 0 && (
            <button onClick={() => { setPIni(meus[meus.length - 1].dia); setPFim(meus[0].dia); setImprimindo(true); }}
              style={btnClaro}>🖨️ Imprimir período</button>
          )}
          <button onClick={() => { setDiaNovo(hojeLocal()); setCriando(true); }} style={btnDourado}>+ Novo registro</button>
        </div>
      </div>

      {semRegistro.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, color: "#92400e" }}>
          <strong>{semRegistro.length} dia(s) com serviço na agenda e sem diário:</strong>{" "}
          {semRegistro.slice(0, 6).map(d => (
            <button key={d} onClick={() => { setDiaNovo(d); setCriando(true); }}
              style={{ background: "#fff", color: "#92400e", border: "1px solid #fde68a", borderRadius: 6, padding: "2px 8px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", marginRight: 5 }}>
              {dataBR(d)}
            </button>
          ))}
          {semRegistro.length > 6 && <span>e mais {semRegistro.length - 6}…</span>}
        </div>
      )}

      {meus.length === 0 ? (
        <div style={{ ...painel, textAlign: "center", padding: 60, color: "#94a3b8" }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>📓</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#64748b" }}>Caderno em branco</div>
          <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
            O primeiro registro já vem preenchido com a equipe, o endereço<br />
            e os itens que estavam na agenda do dia.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {meus.map(d => <LinhaRegistro key={d.id} d={d} equipes={equipes} onAbrir={() => onAbrir(d.id)} onExcluir={() => setExcluindo(d)} />)}
        </div>
      )}

      <Modal open={criando} title="Novo registro do diário" onClose={() => setCriando(false)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 14, lineHeight: 1.5 }}>
          Escolha o dia. O registro já nasce com a equipe, o endereço e os itens que estavam
          na agenda dessa data.
        </div>
        <input type="date" value={diaNovo} onChange={e => setDiaNovo(e.target.value)}
          style={{ ...inp, width: "100%", marginBottom: 12 }} />
        {jaExiste && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#1e40af", marginBottom: 14 }}>
            Já existe registro em {dataBR(diaNovo)}. O botão abre o que já existe — um dia, um registro.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setCriando(false)} style={btnClaro}>Cancelar</button>
          <button onClick={criar} disabled={!diaNovo} style={{ ...btnDourado, opacity: diaNovo ? 1 : 0.5 }}>
            {jaExiste ? "Abrir registro" : "Criar registro"}
          </button>
        </div>
      </Modal>

      <Modal open={imprimindo} title="Imprimir período" onClose={() => setImprimindo(false)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 14 }}>
          Sai uma folha por dia, cada uma numa página nova. No diálogo do navegador,
          escolha <strong>Salvar como PDF</strong> para baixar.
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>De</div>
            <input type="date" value={pIni} onChange={e => setPIni(e.target.value)} style={{ ...inp, width: "100%" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Até</div>
            <input type="date" value={pFim} min={pIni} onChange={e => setPFim(e.target.value)} style={{ ...inp, width: "100%" }} />
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>
          {meus.filter(d => d.dia >= pIni && d.dia <= pFim).length} registro(s) no período.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setImprimindo(false)} style={btnClaro}>Cancelar</button>
          <button onClick={abrirImpressao} style={btnDourado}>Imprimir</button>
        </div>
      </Modal>

      <Modal open={!!excluindo} title="Excluir registro" onClose={() => setExcluindo(null)}>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 16, lineHeight: 1.5 }}>
          Excluir o registro de <strong>{dataBR(excluindo?.dia)}</strong>? As fotos já enviadas
          continuam no servidor, mas o registro some do caderno e isso não tem volta.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setExcluindo(null)} style={btnClaro}>Cancelar</button>
          <button onClick={() => { onExcluir(excluindo.id); setExcluindo(null); }}
            style={{ ...btnEscuro, background: "#dc2626" }}>Excluir</button>
        </div>
      </Modal>
    </div>
  );
}

function LinhaRegistro({ d, equipes, onAbrir, onExcluir }) {
  const nomes = d.equipes
    .map(e => e.equipeId
      ? (equipes.find(x => x.id === e.equipeId) || {}).nome
      : (e.rotulo || (e.presentes.length ? e.presentes.join(", ") : "Grupo avulso")))
    .filter(Boolean);
  const nOc = d.ocorrencias.length;
  const impraticavel = !d.clima.manha.praticavel || !d.clima.tarde.praticavel;

  return (
    <div onClick={onAbrir}
      style={{ ...painel, padding: "12px 14px", cursor: "pointer", display: "flex", gap: 14, alignItems: "center", borderLeft: `4px solid ${nOc ? "#ef4444" : "#e2e8f0"}` }}>
      <div style={{ textAlign: "center", flexShrink: 0, width: 54 }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a1a", lineHeight: 1 }}>{String(partes(d.dia).d).padStart(2, "0")}</div>
        <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>
          {MESES_CURTO[partes(d.dia).m - 1]} {String(partes(d.dia).a).slice(2)}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b" }}>
          Registro nº {d.numero} · {diaSemana(d.dia)}
        </div>
        <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {nomes.length ? nomes.join(", ") : "Sem equipe"}
          {d.atividades.length ? ` · ${d.atividades.length} atividade(s)` : ""}
          {d.fotos.length ? ` · ${d.fotos.length} foto(s)` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
        {impraticavel && (
          <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "2px 8px", fontSize: 10, fontWeight: 800 }}>IMPRATICÁVEL</span>
        )}
        {nOc > 0 && (
          <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 999, padding: "2px 8px", fontSize: 10, fontWeight: 800 }}>
            {nOc} OCORRÊNCIA{nOc > 1 ? "S" : ""}
          </span>
        )}
        <button onClick={e => { e.stopPropagation(); onExcluir(); }} title="Excluir registro"
          style={{ background: "none", border: "none", color: "#cbd5e1", fontSize: 13, cursor: "pointer", padding: "2px 4px" }}>🗑</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nível 3: o editor do registro
// ─────────────────────────────────────────────────────────────────────────────
function EditorDiario({ diario, obra, equipes, agenda, onSalvar, onExcluir, onVoltar, onImprimir }) {
  const [editandoFoto, setEditandoFoto] = useState(null);   // { foto, destino }
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const inputGeral = useRef(null);
  const inputOcorrencia = useRef(null);
  const destinoUpload = useRef(null);

  // O upload é assíncrono; quando ele volta, a prop `diario` pode estar velha.
  // O ref sempre aponta para a versão mais nova.
  const ref = useRef(diario);
  useEffect(() => { ref.current = diario; }, [diario]);

  // O ref é atualizado ANTES de avisar o pai. Sem isso, dois cliques dentro do mesmo
  // ciclo de render (clicar rápido em dois botões de clima) leem a mesma versão antiga
  // e o segundo apaga o primeiro — o efeito acima só roda depois da pintura.
  const salvar = (campos) => {
    const proximo = { ...ref.current, ...campos };
    ref.current = proximo;
    onSalvar(proximo);
  };

  const equipesAtivas = equipes.filter(e => !e.arquivada);
  const itensObra = obra.itens || [];

  function mostrarErro(msg) { setErro(msg); setTimeout(() => setErro(""), 7000); }

  // ── fotos ──
  async function enviarArquivos(files, destino) {
    if (!files || !files.length) return;
    setEnviando(true);
    try {
      for (const file of Array.from(files)) {
        // Reduz antes de subir: foto de celular tem 4–6 MB e o canteiro é 4G.
        const blob = await redimensionarImagem(file);
        const fotoId = uid("ft");
        // Dois caminhos: a foto crua (que o editor reabre) e a marcada (que a folha
        // impressa usa). Enquanto não houver rabisco, as duas URLs são a mesma.
        const caminho = `${obra.id}/${ref.current.id}/${fotoId}.jpg`;
        const caminhoOriginal = `${obra.id}/${ref.current.id}/${fotoId}-orig.jpg`;
        const url = await uploadFotoDiario(caminhoOriginal, blob);
        const foto = { id: fotoId, url, urlOriginal: url, caminho, legenda: "", tracos: [] };
        adicionarFoto(foto, destino);
      }
    } catch (err) {
      mostrarErro("Não foi possível enviar a foto (rodou a migration_diario.sql, que cria o bucket?): " + err.message);
    } finally {
      setEnviando(false);
    }
  }

  function adicionarFoto(foto, destino) {
    const d = ref.current;
    if (destino && destino.ocorrenciaId) {
      salvar({ ocorrencias: d.ocorrencias.map(o => o.id === destino.ocorrenciaId ? { ...o, fotos: [...o.fotos, foto] } : o) });
    } else {
      salvar({ fotos: [...d.fotos, foto] });
    }
  }

  function trocarFoto(fotoAtualizada, destino) {
    const d = ref.current;
    if (destino && destino.ocorrenciaId) {
      salvar({
        ocorrencias: d.ocorrencias.map(o => o.id === destino.ocorrenciaId
          ? { ...o, fotos: o.fotos.map(f => f.id === fotoAtualizada.id ? fotoAtualizada : f) } : o),
      });
    } else {
      salvar({ fotos: d.fotos.map(f => f.id === fotoAtualizada.id ? fotoAtualizada : f) });
    }
  }

  function removerFoto(fotoId, destino) {
    const d = ref.current;
    if (destino && destino.ocorrenciaId) {
      salvar({ ocorrencias: d.ocorrencias.map(o => o.id === destino.ocorrenciaId ? { ...o, fotos: o.fotos.filter(f => f.id !== fotoId) } : o) });
    } else {
      salvar({ fotos: d.fotos.filter(f => f.id !== fotoId) });
    }
  }

  async function salvarMarcacao({ blob, tracos, legenda }) {
    const { foto, destino } = editandoFoto;
    try {
      // A versão achatada vai para um caminho próprio; o ?v= evita o navegador
      // continuar mostrando a marcação anterior a partir do cache.
      const url = await uploadFotoDiario(foto.caminho || `${obra.id}/${ref.current.id}/${foto.id}.jpg`, blob);
      trocarFoto({ ...foto, url: url + "?v=" + Date.now(), tracos, legenda }, destino);
      setEditandoFoto(null);
    } catch (err) {
      throw new Error("Falha ao salvar a marcação: " + err.message);
    }
  }

  // ── blocos ──
  function mudarClima(turno, campos) {
    salvar({ clima: { ...ref.current.clima, [turno]: { ...ref.current.clima[turno], ...campos } } });
  }

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      {/* Cabeçalho */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={onVoltar} style={btnEscuro}>‹ Caderno</button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a1a" }}>
            Registro nº {diario.numero} · {dataBR(diario.dia)}
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{diaSemana(diario.dia)} · #{obra.numero} {obra.cliente}</div>
        </div>
        <button onClick={onImprimir} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir / PDF</button>
      </div>

      {erro && (
        <div style={{ background: "#fee2e2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, fontWeight: 600 }}>{erro}</div>
      )}

      {/* Identificação (automático) */}
      <div style={{ ...painel, marginBottom: 14, background: "#f8fafc" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <Campo rotulo="Obra" valor={obra.obra || "—"} />
          <Campo rotulo="Cliente" valor={obra.cliente} />
          <Campo rotulo="Proposta" valor={"#" + obra.numero} />
          <Campo rotulo="Responsável" valor={diario.responsavel || "—"} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Endereço</div>
          <input value={diario.endereco} onChange={e => salvar({ endereco: e.target.value })}
            placeholder="Endereço da obra" style={{ ...inp, width: "100%", background: "#fff" }} />
        </div>
      </div>

      {/* Clima */}
      <Bloco titulo="Condições do dia" sub="É o que justifica um dia parado — chuva impede vedação e instalação de fachada.">
        {["manha", "tarde"].map(turno => (
          <div key={turno} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: turno === "manha" ? 10 : 0 }}>
            <div style={{ width: 54, fontSize: 12, fontWeight: 700, color: "#475569", flexShrink: 0 }}>
              {turno === "manha" ? "Manhã" : "Tarde"}
            </div>
            <div style={{ display: "flex", gap: 5 }}>
              {TEMPOS.map(t => {
                const ativo = diario.clima[turno].tempo === t.k;
                return (
                  <button key={t.k} title={t.rotulo}
                    onClick={() => mudarClima(turno, { tempo: ativo ? "" : t.k })}
                    style={{
                      background: ativo ? "#1a1a1a" : "#f1f5f9", border: "none", borderRadius: 8,
                      padding: "7px 12px", fontSize: 16, cursor: "pointer", lineHeight: 1,
                      boxShadow: ativo ? "0 0 0 2px #c9a227" : "none",
                    }}>{t.icone}</button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 5, marginLeft: 6 }}>
              {[[true, "Praticável", "#10b981"], [false, "Impraticável", "#ef4444"]].map(([v, rot, cor]) => {
                const ativo = diario.clima[turno].praticavel === v;
                return (
                  <button key={rot} onClick={() => mudarClima(turno, { praticavel: v })}
                    style={{
                      background: ativo ? cor : "#f1f5f9", color: ativo ? "#fff" : "#64748b",
                      border: "none", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                    }}>{rot}</button>
                );
              })}
            </div>
          </div>
        ))}
      </Bloco>

      {/* Equipe */}
      <Bloco titulo="Quem esteve na obra"
        sub="Já vem da agenda, com todos presentes. Desmarque quem faltou — ou monte um grupo avulso."
        acao={
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select value="" onChange={e => {
              if (!e.target.value) return;
              const eq = equipes.find(x => x.id === e.target.value);
              salvar({ equipes: [...ref.current.equipes, { equipeId: eq.id, rotulo: "", presentes: (eq.integrantes || []).slice(), horaInicio: "", horaFim: "" }] });
            }} style={{ ...inp, fontSize: 12, background: "#fff", cursor: "pointer" }}>
              <option value="">+ Equipe cadastrada</option>
              {equipesAtivas.filter(e => !diario.equipes.some(x => x.equipeId === e.id))
                .map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select>
            <button onClick={() => salvar({ equipes: [...ref.current.equipes, { equipeId: null, rotulo: "", presentes: [], horaInicio: "", horaFim: "" }] })}
              title="Para o dia em que não foi uma equipe fechada — uma vistoria, você e um funcionário conferindo itens"
              style={btnClaro}>+ Grupo avulso</button>
          </div>
        }>
        {diario.equipes.length === 0 && (
          <div style={{ fontSize: 12.5, color: "#94a3b8", padding: "8px 0" }}>
            Ninguém registrado nesse dia. Não havia serviço na agenda — use “+ Equipe cadastrada” ou
            “+ Grupo avulso” para dizer quem foi.
          </div>
        )}
        {diario.equipes.map((ed, idx) => {
          const eq = ed.equipeId ? equipes.find(x => x.id === ed.equipeId) : null;
          const avulso = !ed.equipeId;
          const integrantes = (eq && eq.integrantes) || [];
          // Quem está presente mas não é do cadastro: ajudante emprestado, o escritório,
          // ou o grupo avulso inteiro. Some da lista quando o nome existe na equipe.
          const extras = ed.presentes.filter(n => !integrantes.includes(n));
          const trocar = (campos) => salvar({ equipes: ref.current.equipes.map((x, i) => i === idx ? { ...x, ...campos } : x) });
          const cor = avulso ? "#c9a227" : ((eq && eq.cor) || "#94a3b8");
          return (
            <div key={ed.equipeId || "avulso" + idx}
              style={{ border: "1px solid #e2e8f0", borderRadius: 9, padding: 12, marginBottom: 8, borderLeft: `3px solid ${cor}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                {avulso ? (
                  <input value={ed.rotulo} onChange={e => trocar({ rotulo: e.target.value })}
                    placeholder="Do que se trata? (ex.: Vistoria — escritório)"
                    style={{ ...inp, fontSize: 12.5, fontWeight: 700, color: "#c9a227", minWidth: 250, flex: 1, maxWidth: 340 }} />
                ) : (
                  <div style={{ fontSize: 13, fontWeight: 800, color: cor }}>
                    {(eq && eq.nome) || "Equipe removida"}
                  </div>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700 }}>Horário</span>
                  <input type="time" value={ed.horaInicio} onChange={e => trocar({ horaInicio: e.target.value })} style={{ ...inp, padding: "4px 7px", fontSize: 12 }} />
                  <span style={{ color: "#cbd5e1" }}>—</span>
                  <input type="time" value={ed.horaFim} onChange={e => trocar({ horaFim: e.target.value })} style={{ ...inp, padding: "4px 7px", fontSize: 12 }} />
                  <button onClick={() => salvar({ equipes: ref.current.equipes.filter((_, i) => i !== idx) })}
                    title={avulso ? "Tirar o grupo do registro" : "Tirar equipe do registro"}
                    style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 13 }}>✕</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {!avulso && integrantes.length === 0 && extras.length === 0 && (
                  <span style={{ fontSize: 12, color: "#cbd5e1" }}>Equipe sem integrantes cadastrados.</span>
                )}
                {integrantes.map(nome => {
                  const presente = ed.presentes.includes(nome);
                  return (
                    <button key={nome}
                      onClick={() => trocar({ presentes: presente ? ed.presentes.filter(n => n !== nome) : [...ed.presentes, nome] })}
                      style={{
                        background: presente ? "#dcfce7" : "#f1f5f9", color: presente ? "#166534" : "#94a3b8",
                        border: "1px solid " + (presente ? "#86efac" : "#e2e8f0"), borderRadius: 999,
                        padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                        textDecoration: presente ? "none" : "line-through",
                      }}>{presente ? "✓ " : ""}{nome}</button>
                  );
                })}
                {extras.map(nome => (
                  <span key={nome}
                    style={{
                      background: "#fef9e7", color: "#8a6d1f", border: "1px solid #f0dfa8", borderRadius: 999,
                      padding: "5px 8px 5px 12px", fontSize: 12, fontWeight: 700,
                      display: "inline-flex", alignItems: "center", gap: 6,
                    }}>
                    ✓ {nome}
                    <button onClick={() => trocar({ presentes: ed.presentes.filter(n => n !== nome) })} title="Tirar"
                      style={{ background: "none", border: "none", color: "#c0a76a", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>✕</button>
                  </span>
                ))}
                <NomeAvulso onAdicionar={nome => { if (!ed.presentes.includes(nome)) trocar({ presentes: [...ed.presentes, nome] }); }} />
              </div>
            </div>
          );
        })}
      </Bloco>

      {/* Atividades */}
      <Bloco titulo="O que foi feito" sub="Os itens vieram da agenda do dia. Ajuste a etapa e o andamento."
        acao={
          <div style={{ display: "flex", gap: 6 }}>
            <select value="" onChange={e => {
              if (!e.target.value) return;
              const item = itensObra.find(i => String(i.id) === e.target.value);
              salvar({ atividades: [...ref.current.atividades, { id: uid("at"), itemId: item.id, texto: "", etapa: "Instalação", status: "Em andamento", qtd: 0, local: item.localizacao || "" }] });
            }} style={{ ...inp, fontSize: 12, background: "#fff", cursor: "pointer", maxWidth: 190 }}>
              <option value="">+ Item da obra</option>
              {itensObra.filter(i => !diario.atividades.some(a => String(a.itemId) === String(i.id)))
                .map(i => <option key={i.id} value={i.id}>#{i.id} {i.tipo} {i.localizacao ? "· " + i.localizacao : ""}</option>)}
            </select>
            <button onClick={() => salvar({ atividades: [...ref.current.atividades, { id: uid("at"), itemId: null, texto: "", etapa: "Instalação", status: "Em andamento", qtd: 0, local: "" }] })}
              style={btnClaro}>+ Livre</button>
          </div>
        }>
        {diario.atividades.length === 0 && (
          <div style={{ fontSize: 12.5, color: "#94a3b8", padding: "8px 0" }}>
            Nada lançado. Use “+ Item da obra” para trazer as peças, ou “+ Livre” para uma tarefa
            que não é de um item (limpeza, medição, mobilização).
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {diario.atividades.map((at, idx) => {
            const item = at.itemId != null ? itensObra.find(i => String(i.id) === String(at.itemId)) : null;
            const trocar = (campos) => salvar({ atividades: ref.current.atividades.map((x, i) => i === idx ? { ...x, ...campos } : x) });
            return (
              <div key={at.id} style={{ border: "1px solid #e2e8f0", borderRadius: 9, padding: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                  {item ? (
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1e293b", flex: 1, minWidth: 160 }}>
                      #{item.id} {item.tipo}
                      {item.L && item.H ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · {item.L}×{item.H}</span> : null}
                      {item.qtd ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · {item.qtd}un</span> : null}
                    </div>
                  ) : (
                    <input value={at.texto} onChange={e => trocar({ texto: e.target.value })}
                      placeholder="Descreva a tarefa"
                      style={{ ...inp, flex: 1, minWidth: 160, fontSize: 12.5 }} />
                  )}
                  <button onClick={() => salvar({ atividades: ref.current.atividades.filter((_, i) => i !== idx) })}
                    style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 13 }}>✕</button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select value={at.etapa} onChange={e => trocar({ etapa: e.target.value })}
                    style={{ ...inp, fontSize: 11.5, padding: "5px 8px", background: "#fff", color: ETAPA_COR[at.etapa] || "#475569", fontWeight: 700 }}>
                    {Object.keys(ETAPA_COR).map(et => <option key={et} value={et}>{et}</option>)}
                  </select>
                  <div style={{ display: "flex", gap: 4 }}>
                    {STATUS_ATIVIDADE.map(s => (
                      <button key={s} onClick={() => trocar({ status: s })}
                        style={{
                          background: at.status === s ? STATUS_ATIV_COR[s] : "#f1f5f9",
                          color: at.status === s ? "#fff" : "#94a3b8", border: "none", borderRadius: 999,
                          padding: "5px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                        }}>{s}</button>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700 }}>Peças</span>
                    <button onClick={() => trocar({ qtd: Math.max(0, at.qtd - 1) })} style={contador}>−</button>
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: "#1a1a1a", minWidth: 18, textAlign: "center" }}>{at.qtd}</span>
                    <button onClick={() => trocar({ qtd: at.qtd + 1 })} style={contador}>+</button>
                  </div>
                  <input value={at.local} onChange={e => trocar({ local: e.target.value })}
                    placeholder="Local / pavimento"
                    style={{ ...inp, fontSize: 11.5, padding: "5px 8px", flex: 1, minWidth: 120 }} />
                </div>
              </div>
            );
          })}
        </div>
      </Bloco>

      {/* Ocorrências */}
      <Bloco titulo="Ocorrências e impedimentos"
        sub="É a prova de que o atraso não foi nosso. Registre com foto e responsável."
        acao={
          <button onClick={() => salvar({ ocorrencias: [...ref.current.ocorrencias, { id: uid("oc"), tipo: TIPOS_OCORRENCIA[0], responsavel: "cliente", horasParadas: 0, descricao: "", fotos: [] }] })}
            style={{ ...btnEscuro, background: "#dc2626" }}>+ Ocorrência</button>
        }>
        {diario.ocorrencias.length === 0 && (
          <div style={{ fontSize: 12.5, color: "#94a3b8", padding: "8px 0" }}>
            Dia sem intercorrência. Deixe vazio mesmo — só registre o que realmente travou o serviço.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {diario.ocorrencias.map((oc, idx) => {
            const trocar = (campos) => salvar({ ocorrencias: ref.current.ocorrencias.map((x, i) => i === idx ? { ...x, ...campos } : x) });
            return (
              <div key={oc.id} style={{ border: "1px solid #fecaca", background: "#fffbfb", borderRadius: 9, padding: 12 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <select value={oc.tipo} onChange={e => trocar({ tipo: e.target.value })}
                    style={{ ...inp, flex: 1, minWidth: 220, fontSize: 12.5, background: "#fff", fontWeight: 700 }}>
                    {TIPOS_OCORRENCIA.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button onClick={() => salvar({ ocorrencias: ref.current.ocorrencias.filter((_, i) => i !== idx) })}
                    style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 13 }}>✕</button>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>Responsável</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {RESPONSAVEIS.map(r => (
                      <button key={r.k} onClick={() => trocar({ responsavel: r.k })}
                        style={{
                          background: oc.responsavel === r.k ? r.cor : "#f1f5f9",
                          color: oc.responsavel === r.k ? "#fff" : "#94a3b8", border: "none", borderRadius: 999,
                          padding: "5px 13px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                        }}>{r.rotulo}</button>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
                    <span style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700 }}>Horas paradas</span>
                    <input type="number" min="0" step="0.5" value={oc.horasParadas}
                      onChange={e => trocar({ horasParadas: Number(e.target.value) || 0 })}
                      style={{ ...inp, width: 66, padding: "5px 8px", fontSize: 12 }} />
                  </div>
                </div>

                <textarea value={oc.descricao} onChange={e => trocar({ descricao: e.target.value })} rows={2}
                  placeholder="O que aconteceu, onde, e o que foi feito a respeito."
                  style={{ ...inp, width: "100%", resize: "vertical", marginBottom: 8 }} />

                <GradeFotos fotos={oc.fotos} enviando={enviando}
                  onAdicionar={() => { destinoUpload.current = { ocorrenciaId: oc.id }; inputOcorrencia.current.click(); }}
                  onEditar={f => setEditandoFoto({ foto: f, destino: { ocorrenciaId: oc.id } })}
                  onRemover={fid => removerFoto(fid, { ocorrenciaId: oc.id })}
                  onTamanho={(fid, tamanho) => trocarFoto({ ...oc.fotos.find(f => f.id === fid), tamanho }, { ocorrenciaId: oc.id })}
                  compacta />
              </div>
            );
          })}
        </div>
      </Bloco>

      {/* Visitas */}
      <Bloco titulo="Visitas à obra" sub="É na visita do engenheiro do cliente que o combinado muda de boca."
        acao={<button onClick={() => salvar({ visitas: [...ref.current.visitas, { id: uid("vi"), nome: "", empresa: "", motivo: "" }] })} style={btnClaro}>+ Visita</button>}>
        {diario.visitas.length === 0 && (
          <div style={{ fontSize: 12.5, color: "#94a3b8", padding: "8px 0" }}>Ninguém registrado.</div>
        )}
        {diario.visitas.map((v, idx) => {
          const trocar = (campos) => salvar({ visitas: ref.current.visitas.map((x, i) => i === idx ? { ...x, ...campos } : x) });
          return (
            <div key={v.id} style={{ display: "flex", gap: 8, marginBottom: 7, flexWrap: "wrap", alignItems: "center" }}>
              <input value={v.nome} onChange={e => trocar({ nome: e.target.value })} placeholder="Nome"
                style={{ ...inp, flex: 1, minWidth: 130 }} />
              <input value={v.empresa} onChange={e => trocar({ empresa: e.target.value })} placeholder="Empresa"
                style={{ ...inp, flex: 1, minWidth: 130 }} />
              <input value={v.motivo} onChange={e => trocar({ motivo: e.target.value })} placeholder="Motivo"
                style={{ ...inp, flex: 1.4, minWidth: 150 }} />
              <button onClick={() => salvar({ visitas: ref.current.visitas.filter((_, i) => i !== idx) })}
                style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 13 }}>✕</button>
            </div>
          );
        })}
      </Bloco>

      {/* Fotos */}
      <Bloco titulo="Fotos do dia"
        sub="✏️ desenha seta e anotação em cima da foto. ⤢ marca a foto para sair grande na folha impressa."
        acao={
          <button onClick={() => { destinoUpload.current = null; inputGeral.current.click(); }} disabled={enviando}
            style={{ ...btnDourado, opacity: enviando ? 0.6 : 1 }}>
            {enviando ? "Enviando…" : "📷 Adicionar fotos"}
          </button>
        }>
        <GradeFotos fotos={diario.fotos} enviando={enviando}
          onAdicionar={() => { destinoUpload.current = null; inputGeral.current.click(); }}
          onEditar={f => setEditandoFoto({ foto: f, destino: null })}
          onRemover={fid => removerFoto(fid, null)}
          onTamanho={(fid, tamanho) => trocarFoto({ ...ref.current.fotos.find(f => f.id === fid), tamanho }, null)}
          onLegenda={(fid, legenda) => trocarFoto({ ...ref.current.fotos.find(f => f.id === fid), legenda }, null)} />
      </Bloco>

      {/* Observações */}
      <Bloco titulo="Observações gerais">
        <textarea value={diario.observacoes} onChange={e => salvar({ observacoes: e.target.value })} rows={3}
          placeholder="Qualquer coisa que valha registrar e não coube nos blocos acima."
          style={{ ...inp, width: "100%", resize: "vertical" }} />
      </Bloco>

      {/* Assinaturas */}
      <Bloco titulo="Assinaturas" sub="A assinatura de ciência do responsável da obra é o que torna o documento oponível ao cliente.">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Assinatura rotulo="ENCARREGADO DA EQUIPE" valor={diario.assinaturas.encarregado}
            onChange={v => salvar({ assinaturas: { ...ref.current.assinaturas, encarregado: v } })} />
          <Assinatura rotulo="CIÊNCIA — RESPONSÁVEL DA OBRA" valor={diario.assinaturas.cliente}
            onChange={v => salvar({ assinaturas: { ...ref.current.assinaturas, cliente: v } })} />
        </div>
      </Bloco>

      <div style={{ display: "flex", gap: 10, marginBottom: 40 }}>
        <button onClick={onVoltar} style={btnEscuro}>‹ Voltar ao caderno</button>
        <button onClick={onImprimir} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir / PDF</button>
      </div>

      {/* inputs de arquivo, escondidos */}
      <input ref={inputGeral} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={e => { enviarArquivos(e.target.files, null); e.target.value = ""; }} />
      <input ref={inputOcorrencia} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={e => { enviarArquivos(e.target.files, destinoUpload.current); e.target.value = ""; }} />

      {editandoFoto && (
        <FotoMarkup src={editandoFoto.foto.urlOriginal} tracosIniciais={editandoFoto.foto.tracos}
          legendaInicial={editandoFoto.foto.legenda}
          onSalvar={salvarMarcacao} onFechar={() => setEditandoFoto(null)} />
      )}
    </div>
  );
}

const contador = {
  background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, width: 24, height: 24,
  fontSize: 14, fontWeight: 800, color: "#475569", cursor: "pointer", lineHeight: 1, padding: 0,
};

// Campo de digitar nome solto: serve tanto para o grupo avulso quanto para um
// ajudante que entrou numa equipe cadastrada naquele dia.
function NomeAvulso({ onAdicionar }) {
  const [nome, setNome] = useState("");
  function confirmar() {
    const n = nome.trim();
    if (!n) return;
    onAdicionar(n);
    setNome("");
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input value={nome} onChange={e => setNome(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); confirmar(); } }}
        onBlur={confirmar}
        placeholder="+ nome"
        style={{ ...inp, padding: "5px 10px", fontSize: 12, width: 130, borderStyle: "dashed" }} />
    </span>
  );
}

function Campo({ rotulo, valor }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "#94a3b8", fontWeight: 700, textTransform: "uppercase" }}>{rotulo}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginTop: 3, wordBreak: "break-word" }}>{valor}</div>
    </div>
  );
}

function GradeFotos({ fotos, enviando, onAdicionar, onEditar, onRemover, onLegenda, onTamanho, compacta }) {
  const lado = compacta ? 90 : 130;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {fotos.map(f => {
        const grande = f.tamanho === "grande";
        return (
        <div key={f.id} style={{ width: lado, position: "relative" }}>
          <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", background: "#f8fafc",
                        border: grande ? "2px solid #c9a227" : "1px solid #e2e8f0" }}>
            <img src={f.url} alt="" style={{ display: "block", width: "100%", height: lado, objectFit: "cover" }} />
            <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 3 }}>
              {onTamanho && (
                <button onClick={() => onTamanho(f.id, grande ? "normal" : "grande")}
                  title={grande ? "Sai grande na folha — clique para voltar ao normal" : "Sair grande na folha impressa (largura inteira, sem corte)"}
                  style={{ ...miniSobreFoto, background: grande ? "#c9a227" : miniSobreFoto.background, color: grande ? "#fff" : "inherit", fontWeight: 800 }}>
                  {grande ? "G" : "⤢"}
                </button>
              )}
              <button onClick={() => onEditar(f)} title="Desenhar na foto"
                style={miniSobreFoto}>✏️</button>
              <button onClick={() => onRemover(f.id)} title="Remover foto"
                style={miniSobreFoto}>🗑</button>
            </div>
            {(f.tracos || []).length > 0 && (
              <div style={{ position: "absolute", bottom: 4, left: 4, background: "rgba(201,162,39,0.95)", color: "#fff", borderRadius: 4, padding: "1px 5px", fontSize: 9, fontWeight: 800 }}>MARCADA</div>
            )}
          </div>
          {onLegenda && (
            <input value={f.legenda} onChange={e => onLegenda(f.id, e.target.value)} placeholder="Legenda"
              style={{ ...inp, width: "100%", fontSize: 10.5, padding: "4px 6px", marginTop: 4 }} />
          )}
        </div>
        );
      })}
      <button onClick={onAdicionar} disabled={enviando}
        style={{
          width: lado, height: lado, border: "2px dashed #cbd5e1", borderRadius: 8, background: "#f8fafc",
          color: "#94a3b8", fontSize: 11.5, fontWeight: 700, cursor: enviando ? "wait" : "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
        }}>
        <span style={{ fontSize: 20 }}>{enviando ? "⏳" : "📷"}</span>
        {enviando ? "Enviando…" : "Adicionar"}
      </button>
    </div>
  );
}

const miniSobreFoto = {
  background: "rgba(255,255,255,0.92)", border: "none", borderRadius: 5, width: 22, height: 22,
  fontSize: 11, cursor: "pointer", padding: 0, lineHeight: 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// IMPRESSÃO — mesma receita do OrdemServicoPrint: view em tela cheia, window.print()
// e os botões somem sozinhos pelo @media print do index.css.
// ─────────────────────────────────────────────────────────────────────────────
export function DiarioPrint({ diarios, obras, equipes, obraId, inicio, fim, onBack }) {
  const obra = obras.find(o => o.id === obraId);
  const folhas = diarios
    .filter(d => d.obraId === obraId && d.dia >= inicio && d.dia <= fim)
    .sort((a, b) => (a.dia || "").localeCompare(b.dia || ""));

  if (!obra) {
    return <div style={{ padding: 60, textAlign: "center", color: "#64748b" }}>Obra não encontrada</div>;
  }

  return (
    <div style={{ padding: 28, maxWidth: 980, margin: "0 auto" }}>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <button onClick={onBack} style={btnEscuro}>← Voltar</button>
        <span style={{ fontSize: 12.5, color: "#64748b" }}>
          {folhas.length} folha(s) — uma por dia, cada uma numa página nova. Use “Salvar como PDF” no
          diálogo de impressão para baixar.
        </span>
        <button onClick={() => window.print()} style={{ ...btnDourado, marginLeft: "auto" }}>🖨️ Imprimir</button>
      </div>

      {folhas.length === 0 && (
        <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>Nenhum registro no período.</div>
      )}

      {folhas.map((d, i) => <FolhaDiario key={d.id} d={d} obra={obra} equipes={equipes} primeira={i === 0} />)}
    </div>
  );
}

const th = { textAlign: "left", padding: "6px 8px", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "6px 8px", fontSize: 11.5, verticalAlign: "top", borderBottom: "1px solid #e2e8f0" };

function FolhaDiario({ d, obra, equipes, primeira }) {
  // Grupo avulso não tem cadastro: o rótulo digitado é o nome dele na folha.
  const nomeEq = (e) => e.equipeId
    ? ((equipes.find(x => x.id === e.equipeId) || {}).nome || "Equipe removida")
    : (e.rotulo || "Grupo avulso");
  const rotuloTempo = (k) => (TEMPOS.find(t => t.k === k) || {}).rotulo || "—";
  const rotuloResp = (k) => (RESPONSAVEIS.find(r => r.k === k) || {}).rotulo || k;

  return (
    <div style={{ pageBreakBefore: primeira ? "auto" : "always", marginBottom: 44 }}>
      {/* Cabeçalho */}
      <div style={{ display: "flex", alignItems: "flex-start", borderBottom: "3px solid #1a1a1a", paddingBottom: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800, color: "#1a1a1a", letterSpacing: 0.5 }}>CENTAURO ESQUADRIAS</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#c9a227", letterSpacing: 1.5, marginTop: 2 }}>DIÁRIO DE OBRA</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>Registro nº</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#1a1a1a", lineHeight: 1 }}>{String(d.numero).padStart(3, "0")}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, background: "#f8fafc", padding: "10px 12px", borderRadius: 6, marginBottom: 12 }}>
        <ItemCab rotulo="Data" valor={`${dataBR(d.dia)}`} />
        <ItemCab rotulo="Dia" valor={diaSemana(d.dia)} />
        <ItemCab rotulo="Proposta" valor={"#" + obra.numero} />
        <ItemCab rotulo="Cliente" valor={obra.cliente} />
        <div style={{ gridColumn: "1 / span 3" }}><ItemCab rotulo="Obra / Endereço" valor={d.endereco || obra.obra || "—"} /></div>
        <ItemCab rotulo="Responsável" valor={d.responsavel || "—"} />
      </div>

      {/* Clima */}
      <SecaoImp titulo="Condições do dia" />
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr style={{ background: "#1a1a1a", color: "#fff" }}>
            <th style={{ ...th, width: "20%" }}>Turno</th>
            <th style={{ ...th, width: "40%" }}>Tempo</th>
            <th style={th}>Condição de trabalho</th>
          </tr>
        </thead>
        <tbody>
          {[["Manhã", d.clima.manha], ["Tarde", d.clima.tarde]].map(([rot, c]) => (
            <tr key={rot}>
              <td style={{ ...td, fontWeight: 700 }}>{rot}</td>
              <td style={td}>{rotuloTempo(c.tempo)}</td>
              <td style={{ ...td, fontWeight: 700, color: c.praticavel ? "#166534" : "#dc2626" }}>
                {c.praticavel ? "PRATICÁVEL" : "IMPRATICÁVEL"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Equipe */}
      <SecaoImp titulo="Equipe e efetivo presente" />
      {d.equipes.length === 0 ? (
        <Vazio texto="Nenhuma equipe registrada neste dia." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ background: "#1a1a1a", color: "#fff" }}>
              <th style={{ ...th, width: "25%" }}>Equipe</th>
              <th style={th}>Presentes</th>
              <th style={{ ...th, width: "20%" }}>Horário</th>
            </tr>
          </thead>
          <tbody>
            {d.equipes.map((e, i) => (
              <tr key={i} style={{ pageBreakInside: "avoid" }}>
                <td style={{ ...td, fontWeight: 700 }}>{nomeEq(e)}</td>
                <td style={td}>{e.presentes.length ? e.presentes.join(" · ").toUpperCase() : "—"}</td>
                <td style={td}>{e.horaInicio || e.horaFim ? `${e.horaInicio || "—"} às ${e.horaFim || "—"}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Atividades */}
      <SecaoImp titulo="Atividades executadas" />
      {d.atividades.length === 0 ? (
        <Vazio texto="Nenhuma atividade lançada." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
          <thead>
            <tr style={{ background: "#1a1a1a", color: "#fff" }}>
              <th style={{ ...th, width: "38%" }}>Item / tarefa</th>
              <th style={{ ...th, width: "17%" }}>Etapa</th>
              <th style={{ ...th, width: "17%" }}>Situação</th>
              <th style={{ ...th, width: "10%" }}>Peças</th>
              <th style={th}>Local</th>
            </tr>
          </thead>
          <tbody>
            {d.atividades.map((a, i) => {
              const item = a.itemId != null ? (obra.itens || []).find(x => String(x.id) === String(a.itemId)) : null;
              return (
                <tr key={a.id} style={{ background: i % 2 ? "#f8fafc" : "#fff", pageBreakInside: "avoid" }}>
                  <td style={td}>
                    {item
                      ? `#${item.id} ${item.tipo || ""}${item.L && item.H ? ` · ${item.L}×${item.H}` : ""}`
                      : (a.texto || "—")}
                  </td>
                  <td style={td}>{a.etapa}</td>
                  <td style={{ ...td, fontWeight: 700, color: STATUS_ATIV_COR[a.status] || "#475569" }}>{a.status}</td>
                  <td style={td}>{a.qtd || "—"}</td>
                  <td style={td}>{a.local || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Ocorrências */}
      <SecaoImp titulo="Ocorrências e impedimentos" />
      {d.ocorrencias.length === 0 ? (
        <Vazio texto="Sem ocorrências registradas." />
      ) : (
        <div style={{ marginBottom: 12 }}>
          {d.ocorrencias.map(oc => (
            <div key={oc.id} style={{ border: "1px solid #e2e8f0", borderLeft: "3px solid #dc2626", borderRadius: 4, padding: "8px 10px", marginBottom: 7, pageBreakInside: "avoid" }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#1a1a1a" }}>{oc.tipo}</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 800, color: "#475569" }}>
                  RESPONSÁVEL: {rotuloResp(oc.responsavel).toUpperCase()}
                  {oc.horasParadas ? ` · ${oc.horasParadas}h PARADAS` : ""}
                </span>
              </div>
              {oc.descricao && <div style={{ fontSize: 11.5, color: "#334155", marginTop: 4, lineHeight: 1.4 }}>{oc.descricao}</div>}
              {oc.fotos.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap", alignItems: "flex-start" }}>
                  {oc.fotos.map(f => {
                    const grande = f.tamanho === "grande";
                    return (
                      <img key={f.id} src={f.url} alt=""
                        style={{
                          width: grande ? "100%" : 150, height: grande ? "auto" : 112,
                          maxHeight: grande ? 460 : 112, objectFit: grande ? "contain" : "cover",
                          background: grande ? "#f8fafc" : "transparent",
                          border: "1px solid #e2e8f0", borderRadius: 3,
                        }} />
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Visitas */}
      {d.visitas.length > 0 && (
        <>
          <SecaoImp titulo="Visitas à obra" />
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
            <thead>
              <tr style={{ background: "#1a1a1a", color: "#fff" }}>
                <th style={{ ...th, width: "30%" }}>Nome</th>
                <th style={{ ...th, width: "30%" }}>Empresa</th>
                <th style={th}>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {d.visitas.map(v => (
                <tr key={v.id} style={{ pageBreakInside: "avoid" }}>
                  <td style={td}>{v.nome || "—"}</td>
                  <td style={td}>{v.empresa || "—"}</td>
                  <td style={td}>{v.motivo || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Observações */}
      {d.observacoes && (
        <>
          <SecaoImp titulo="Observações" />
          <div style={{ fontSize: 11.5, color: "#334155", lineHeight: 1.5, marginBottom: 12, whiteSpace: "pre-wrap" }}>{d.observacoes}</div>
        </>
      )}

      {/* Fotos */}
      {d.fotos.length > 0 && (
        <>
          <SecaoImp titulo="Registro fotográfico" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {d.fotos.map(f => {
              // A foto "grande" atravessa as duas colunas e sai por inteiro (contain),
              // que é o ponto dela: enxergar o detalhe. A normal é miniatura de grade.
              const grande = f.tamanho === "grande";
              return (
                <div key={f.id} style={{ pageBreakInside: "avoid", gridColumn: grande ? "1 / -1" : "auto" }}>
                  <img src={f.url} alt=""
                    style={{
                      width: "100%", maxHeight: grande ? 520 : 240,
                      objectFit: grande ? "contain" : "cover",
                      background: grande ? "#f8fafc" : "transparent",
                      border: "1px solid #e2e8f0", borderRadius: 4, display: "block",
                    }} />
                  {f.legenda && <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 3 }}>{f.legenda}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Assinaturas */}
      <div style={{ display: "flex", gap: 30, marginTop: 26, pageBreakInside: "avoid" }}>
        {[["ENCARREGADO DA EQUIPE", d.assinaturas.encarregado], ["CIÊNCIA — RESPONSÁVEL DA OBRA", d.assinaturas.cliente]].map(([rot, src]) => (
          <div key={rot} style={{ flex: 1, textAlign: "center" }}>
            <div style={{ height: 56, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              {src && <img src={src} alt="" style={{ maxHeight: 56, maxWidth: "100%" }} />}
            </div>
            <div style={{ borderTop: "2px solid #1a1a1a", paddingTop: 5, fontSize: 10, fontWeight: 800, color: "#475569", letterSpacing: 0.3 }}>{rot}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 9.5, color: "#94a3b8", textAlign: "center", borderTop: "1px solid #e2e8f0", paddingTop: 7 }}>
        Centauro Esquadrias · Diário de Obra nº {String(d.numero).padStart(3, "0")} · {dataExtenso(d.dia)} · Obra #{obra.numero} {obra.cliente}
      </div>
    </div>
  );
}

function SecaoImp({ titulo }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 800, color: "#1a1a1a", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5, marginTop: 4 }}>
      {titulo}
    </div>
  );
}
function Vazio({ texto }) {
  return <div style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic", marginBottom: 12 }}>{texto}</div>;
}
function ItemCab({ rotulo, valor }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{rotulo}</div>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "#1e293b", marginTop: 1 }}>{valor}</div>
    </div>
  );
}
