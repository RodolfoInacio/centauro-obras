// Seção "🌐 Portal do cliente" da tela da obra (lado da equipe).
//   - Acessos: cria o login do cliente (usuário + senha gerada), nova senha, bloquear, desligar.
//     A senha aparece UMA vez, com o link, para copiar ou mandar pelo WhatsApp.
//   - Conversa com o cliente, com as sugestões de data. Aprovar aplica a data na tarefa pela
//     gravação normal do cronograma (onSalvarCronograma) e só então registra a decisão — a conversa
//     é o registro de quem pediu, quem aprovou e quando.
//   - "👁 Ver como o cliente" abre a mesma tela do portal, só leitura.
import { useCallback, useEffect, useState } from "react";
import { portalAcao, portalDecidir } from "./api";
import { normConfig, diasUteisEntre, parseDT } from "./cronograma";
import { ConversaPortal, fmtDia } from "./PortalConversa.jsx";

export const LINK_PORTAL = "https://obras.centauroesquadrias.com.br/?portal";

const btn = (cor = "#1a1a1a", claro = false) => ({
  minHeight: 34, padding: "0 12px", borderRadius: 8, fontWeight: 700, fontSize: 12.5, cursor: "pointer",
  border: claro ? `1px solid ${cor}33` : "none", background: claro ? "#fff" : cor, color: claro ? cor : "#fff",
});
const inp = { border: "1px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", background: "#fff" };

function sugestaoUsuario(obra) {
  const nome = String(obra.cliente || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/_teste_/g, "").split(/[^a-z0-9]+/).filter(Boolean)[0] || "cliente";
  const num = String(obra.numero || obra.id).replace(/[^0-9]/g, "");
  return `${nome}${num}`;
}

function textoAcesso({ nome, usuario, senha }) {
  return `Olá${nome ? `, ${nome}` : ""}! Este é o seu acesso para acompanhar a obra com a Centauro Esquadrias:\n\n` +
    `🔗 ${LINK_PORTAL}\n👤 Usuário: ${usuario}\n🔑 Senha: ${senha}\n\n` +
    `Lá você vê o andamento, o cronograma, as fotos e pode falar com a nossa equipe.`;
}

function Credencial({ dados, onFechar }) {
  const [copiado, setCopiado] = useState(false);
  const texto = textoAcesso(dados);
  async function copiar() {
    try { await navigator.clipboard.writeText(texto); setCopiado(true); setTimeout(() => setCopiado(false), 2000); } catch { /* sem permissão */ }
  }
  return (
    <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: 12, margin: "10px 0" }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: "#166534", marginBottom: 6 }}>Acesso pronto — a senha só aparece agora. Copie ou envie antes de fechar.</div>
      <div style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, lineHeight: 1.6, background: "#fff", border: "1px solid #dcfce7", borderRadius: 8, padding: "8px 10px", wordBreak: "break-all" }}>
        <div>Link: {LINK_PORTAL}</div>
        <div>Usuário: <b>{dados.usuario}</b></div>
        <div>Senha: <b>{dados.senha}</b></div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" onClick={copiar} style={btn("#166534")}>{copiado ? "✓ Copiado" : "📋 Copiar mensagem"}</button>
        <a href={`https://wa.me/?text=${encodeURIComponent(texto)}`} target="_blank" rel="noreferrer"
          style={{ ...btn("#16a34a"), display: "inline-flex", alignItems: "center", textDecoration: "none" }}>WhatsApp</a>
        <button type="button" onClick={onFechar} style={btn("#64748b", true)}>Fechar</button>
      </div>
    </div>
  );
}

function Acessos({ obra, onAtividade }) {
  const [lista, setLista] = useState(null);
  const [erro, setErro] = useState("");
  const [usuario, setUsuario] = useState(() => sugestaoUsuario(obra));
  const [nome, setNome] = useState(() => String(obra.cadastro?.contatoNome || obra.cliente || "").replace(/\s*_teste_\s*/i, "").trim());
  const [busy, setBusy] = useState(false);
  const [credencial, setCredencial] = useState(null);
  const [ligando, setLigando] = useState(false);
  const [existente, setExistente] = useState("");

  const carregar = useCallback(async () => {
    try { setLista((await portalAcao("listar", { obraId: obra.id })).acessos || []); setErro(""); }
    catch (e) { setErro(e.message); setLista([]); }
  }, [obra.id]);
  useEffect(() => { carregar(); }, [carregar]);

  async function rodar(fn) {
    setBusy(true); setErro("");
    try { await fn(); await carregar(); } catch (e) { setErro(e.message); }
    setBusy(false);
  }
  const criar = () => rodar(async () => {
    const r = await portalAcao("criar", { obraId: obra.id, usuario, nome });
    setCredencial({ nome: r.nome, usuario: r.usuario, senha: r.senha });
    onAtividade?.(`Portal do cliente: acesso "${r.usuario}" criado`);
  });
  const novaSenha = a => rodar(async () => {
    if (!window.confirm(`Gerar outra senha para "${a.usuario}"? A senha atual para de funcionar.`)) return;
    const r = await portalAcao("nova_senha", { userId: a.userId });
    setCredencial({ nome: a.nome, usuario: a.usuario, senha: r.senha });
    onAtividade?.(`Portal do cliente: nova senha para "${a.usuario}"`);
  });
  const bloquear = a => rodar(async () => {
    await portalAcao(a.bloqueado ? "desbloquear" : "bloquear", { userId: a.userId });
    onAtividade?.(`Portal do cliente: acesso "${a.usuario}" ${a.bloqueado ? "desbloqueado" : "bloqueado"}`);
  });
  const desligar = a => rodar(async () => {
    if (!window.confirm(`Tirar "${a.usuario}" desta obra? O login continua existindo (pode estar ligado a outros contratos).`)) return;
    await portalAcao("desvincular", { obraId: obra.id, userId: a.userId });
    onAtividade?.(`Portal do cliente: "${a.usuario}" desligado da obra`);
  });
  const ligar = () => rodar(async () => {
    await portalAcao("vincular", { obraId: obra.id, usuario: existente });
    onAtividade?.(`Portal do cliente: "${existente}" ligado à obra`);
    setExistente(""); setLigando(false);
  });

  return (
    <div>
      {erro && <div style={{ background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, marginBottom: 8 }}>{erro}</div>}
      {credencial && <Credencial dados={credencial} onFechar={() => setCredencial(null)} />}
      {lista === null ? <div style={{ fontSize: 12.5, color: "#94a3b8" }}>Carregando acessos…</div>
        : lista.length === 0 ? <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 8 }}>Nenhum login de cliente nesta obra ainda.</div>
        : lista.map(a => (
          <div key={a.userId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{a.nome || a.usuario} {a.bloqueado && <span style={{ fontSize: 11, color: "#b91c1c", background: "#fee2e2", borderRadius: 999, padding: "1px 7px", marginLeft: 4 }}>bloqueado</span>}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>usuário <b>{a.usuario}</b> · {a.ultimoAcesso ? `último acesso ${fmtDia(a.ultimoAcesso)}` : "nunca entrou"}</div>
            </div>
            <button type="button" disabled={busy} onClick={() => novaSenha(a)} style={btn("#2563eb", true)}>Nova senha</button>
            <button type="button" disabled={busy} onClick={() => bloquear(a)} style={btn(a.bloqueado ? "#16a34a" : "#b45309", true)}>{a.bloqueado ? "Desbloquear" : "Bloquear"}</button>
            <button type="button" disabled={busy} onClick={() => desligar(a)} style={btn("#b91c1c", true)}>Tirar da obra</button>
          </div>
        ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>USUÁRIO
          <input value={usuario} onChange={e => setUsuario(e.target.value.toLowerCase().replace(/\s/g, ""))} style={{ ...inp, display: "block", width: 160, marginTop: 2 }} />
        </label>
        <label style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", flex: "1 1 180px" }}>NOME (APARECE NA CONVERSA)
          <input value={nome} onChange={e => setNome(e.target.value)} style={{ ...inp, display: "block", width: "100%", marginTop: 2 }} />
        </label>
        <button type="button" disabled={busy || usuario.length < 3} onClick={criar} style={{ ...btn("#ED5454"), minHeight: 36 }}>+ Criar acesso</button>
      </div>
      <div style={{ marginTop: 8 }}>
        {!ligando
          ? <button type="button" onClick={() => setLigando(true)} style={{ border: "none", background: "transparent", color: "#2563eb", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>Ligar um cliente que já tem acesso (outro contrato)</button>
          : (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input value={existente} onChange={e => setExistente(e.target.value)} placeholder="usuário existente" style={{ ...inp, width: 180 }} />
              <button type="button" disabled={busy || !existente.trim()} onClick={ligar} style={btn("#2563eb")}>Ligar</button>
              <button type="button" onClick={() => setLigando(false)} style={btn("#64748b", true)}>Cancelar</button>
            </div>
          )}
      </div>
    </div>
  );
}

// Aplica a data aprovada na tarefa. Início → 📌 na data (começo do expediente). Término → a
// duração passa a ser os dias úteis do início atual até o fim do expediente do dia sugerido.
export function aplicarSugestao(cr, sched, m) {
  const cfg = normConfig(cr.config);
  const idx = (cr.tasks || []).findIndex(t => t.id === m.taskId);
  if (idx < 0) throw new Error("A tarefa sugerida não existe mais no cronograma.");
  const t = cr.tasks[idx];
  let nova;
  if (m.campo === "inicio") {
    nova = { ...t, inicioManual: `${m.dataSugerida}T${cfg.expediente[0]}`, inicioFixo: true };
  } else {
    const ini = sched?.[t.id]?.inicio;
    if (!ini) throw new Error("A tarefa ainda não tem início calculado.");
    const alvo = parseDT(`${m.dataSugerida}T${cfg.expediente[1]}`);
    if (alvo <= ini) throw new Error("O término sugerido é antes do início da tarefa — ajuste o início primeiro.");
    const dias = Math.max(0.5, Math.round(diasUteisEntre(ini, alvo, cfg) * 2) / 2);
    nova = t.durUnid === "hrs" ? { ...t, durValor: Math.round(dias * cfg.horasDia) } : { ...t, durValor: dias, durUnid: "dias" };
  }
  return { ...cr, tasks: cr.tasks.map((x, i) => i === idx ? nova : x) };
}

export default function PortalObra({ obra, cronogramas, macro, onSalvarCronograma, onAtividade, onVerComoCliente }) {
  const decidir = useCallback(async (m, estado, motivo) => {
    let novo = null;
    if (estado === "aprovada") {
      const cr = (cronogramas || []).find(c => c.id === m.cronogramaId);
      if (!cr) throw new Error("O cronograma desta sugestão não existe mais.");
      novo = aplicarSugestao(cr, macro?.mapa?.[cr.id]?.sched, m);   // erro aqui não grava a decisão
    }
    await portalDecidir(m.id, estado, motivo);
    if (novo) onSalvarCronograma(novo);
    onAtividade?.(estado === "aprovada"
      ? `Portal: sugestão do cliente aprovada — "${m.taskNome}", ${m.campo === "inicio" ? "início" : "término"} em ${fmtDia(m.dataSugerida)}`
      : `Portal: sugestão do cliente recusada — "${m.taskNome}"${motivo ? ` (${motivo})` : ""}`);
  }, [cronogramas, macro, onSalvarCronograma, onAtividade]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, color: "#64748b", flex: "1 1 260px" }}>
          O cliente acompanha andamento, cronograma, fotos do diário, itens (sem valores) e os anexos marcados com 👁. Link: <b>{LINK_PORTAL}</b>
        </div>
        <button type="button" onClick={onVerComoCliente} style={btn("#1a1a1a", true)}>👁 Ver como o cliente</button>
      </div>
      <div style={{ fontWeight: 800, fontSize: 12, color: "#94a3b8", textTransform: "uppercase", marginBottom: 6 }}>Acessos</div>
      <Acessos obra={obra} onAtividade={onAtividade} />
      <div style={{ fontWeight: 800, fontSize: 12, color: "#94a3b8", textTransform: "uppercase", margin: "18px 0 6px" }}>Conversa com o cliente</div>
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
        <ConversaPortal obraId={obra.id} lado="centauro" onDecidir={decidir} alturaLista={420} />
      </div>
    </div>
  );
}
