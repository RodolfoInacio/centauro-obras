import { useEffect, useRef, useState } from "react";
import { fetchAnexosObra, enviarAnexoObra, removerAnexo, restaurarAnexo, mudarCategoriaAnexo, urlsAssinadas } from "./api";
import { redimensionarImagem } from "./FotoMarkup";
import { lerAutor } from "./ComentariosObra";

// ─────────────────────────────────────────────────────────────────────────────
// Anexos da obra: contrato assinado, orçamento, comprovante, projeto, fotos.
// Bucket PRIVADO "obras": o link é assinado e vence em 1 h. Uma linha por arquivo em
// obra_anexos, fora do jsonb da obra. Remover manda para a lixeira (removido_em) e o arquivo
// continua no Storage — "Mostrar removidos" traz de volta.
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIAS_ANEXO = [
  { id: "contrato", rotulo: "Contrato", icone: "📝" },
  { id: "orcamento", rotulo: "Orçamento", icone: "📄" },
  { id: "comprovante", rotulo: "Comprovante", icone: "🧾" },
  { id: "projeto", rotulo: "Projeto", icone: "📐" },
  { id: "foto", rotulo: "Foto", icone: "📷" },
  { id: "outro", rotulo: "Outro", icone: "📎" },
];
const ROTULO_CAT = Object.fromEntries(CATEGORIAS_ANEXO.map(c => [c.id, c]));
export const LIMITE_ANEXO = 25 * 1024 * 1024;

// Palpite pelo nome — o usuário troca na lista se errar.
export function categoriaPalpite(file) {
  const n = (file.name || "").toLowerCase();
  if (/contrato/.test(n)) return "contrato";
  if (/comprovante|pix|recibo|transfer/.test(n)) return "comprovante";
  if (/or[cç]|proposta/.test(n)) return "orcamento";
  if (/projeto|planta|\.dwg$|\.dxf$/.test(n)) return "projeto";
  if ((file.type || "").startsWith("image/")) return "foto";
  return "outro";
}

const ehImagem = (mime) => /^image\/(jpeg|png|webp|gif|bmp)/.test(mime || "");

export function fmtTamanho(b) {
  if (!b) return "";
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + " KB";
  return (b / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
}

// Links assinados em memória por 50 min (vencem em 60): lista de obras e tela da obra
// não pedem a mesma URL a cada render.
const cacheUrls = new Map();
export async function urlsComCache(paths) {
  const agora = Date.now();
  const faltam = [...new Set(paths.filter(p => p && !(cacheUrls.get(p)?.expira > agora)))];
  if (faltam.length) {
    const novas = await urlsAssinadas(faltam);
    for (const [p, url] of Object.entries(novas)) cacheUrls.set(p, { url, expira: agora + 50 * 60 * 1000 });
  }
  return Object.fromEntries(paths.filter(Boolean).map(p => [p, cacheUrls.get(p)?.url]).filter(([, u]) => u));
}

// Sobe uma lista de { file, categoria }. Imagem é reduzida a 1.600px (foto de celular tem
// 4–6 MB e o canteiro é 4G), a não ser que peça o original. Devolve { ok: [anexos], falhas: [msgs] }.
export async function enviarArquivos(obraId, itens, { manterOriginal = false } = {}) {
  const ok = [], falhas = [];
  const autor = lerAutor();
  for (const { file, categoria } of itens) {
    try {
      if (file.size > LIMITE_ANEXO) throw new Error(`tem ${fmtTamanho(file.size)} — o limite é 25 MB`);
      let blob = file, nome = file.name, mime = file.type;
      if (!manterOriginal && ehImagem(file.type) && file.type !== "image/gif") {
        blob = await redimensionarImagem(file);
        nome = nome.replace(/\.[^.]+$/, "") + ".jpg";
        mime = "image/jpeg";
      }
      ok.push(await enviarAnexoObra({ obraId, blob, nome, mime, categoria: categoria || categoriaPalpite(file), autor }));
    } catch (err) {
      falhas.push(`${file.name}: ${err.message}`);
    }
  }
  return { ok, falhas };
}

// Área de soltar arquivos, usada aqui e no popup de novo contrato.
export function AreaSoltar({ onArquivos, texto = "Arraste arquivos aqui ou clique para anexar", desabilitado }) {
  const inputRef = useRef();
  const [sobre, setSobre] = useState(false);
  return (
    <div
      onClick={() => !desabilitado && inputRef.current.click()}
      onDragOver={e => { e.preventDefault(); setSobre(true); }}
      onDragLeave={() => setSobre(false)}
      onDrop={e => { e.preventDefault(); setSobre(false); if (!desabilitado && e.dataTransfer.files.length) onArquivos([...e.dataTransfer.files]); }}
      style={{ border: `2px dashed ${sobre ? "#2563eb" : "#cbd5e1"}`, background: sobre ? "#eff6ff" : "#f8fafc", borderRadius: 9, padding: "14px 12px", textAlign: "center", fontSize: 12.5, color: "#64748b", cursor: desabilitado ? "wait" : "pointer" }}>
      📎 {texto}
      <input ref={inputRef} type="file" multiple style={{ display: "none" }}
        onChange={e => { if (e.target.files.length) onArquivos([...e.target.files]); e.target.value = ""; }} />
    </div>
  );
}

const btn = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", color: "#475569", whiteSpace: "nowrap" };

// capa: { anexoId, path } | null. onCapa(novaCapa|null). onAtividade(texto) registra na lateral.
// onContagem(anexosAtivos) avisa a seção (resumo de uma linha).
export default function AnexosObra({ obraId, capa, onCapa, onAtividade, onContagem, recarregar = 0 }) {
  const [lista, setLista] = useState(undefined); // undefined = carregando, null = sem migration
  const [urls, setUrls] = useState({});
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("");
  const [verRemovidos, setVerRemovidos] = useState(false);
  const [manterOriginal, setManterOriginal] = useState(false);

  // `recarregar` sobe quando o App registra atividade (ex.: o PDF importado entrou como anexo).
  useEffect(() => { setLista(undefined); }, [obraId]);
  useEffect(() => {
    let cancel = false;
    fetchAnexosObra(obraId).then(l => { if (!cancel) setLista(l); });
    return () => { cancel = true; };
  }, [obraId, recarregar]);

  const ativos = (lista || []).filter(a => !a.removidoEm);
  useEffect(() => { if (lista) onContagem?.(ativos); }, [lista]); // eslint-disable-line react-hooks/exhaustive-deps

  // Miniaturas e links abrem por URL assinada, pedidas de uma vez.
  useEffect(() => {
    if (!lista || !lista.length) return;
    let cancel = false;
    urlsComCache(lista.map(a => a.path)).then(u => { if (!cancel) setUrls(u); }).catch(err => console.warn("urls anexos:", err.message));
    return () => { cancel = true; };
  }, [lista]);

  async function receber(files) {
    setEnviando(true);
    setErro("");
    const { ok, falhas } = await enviarArquivos(obraId, files.map(f => ({ file: f, categoria: categoriaPalpite(f) })), { manterOriginal });
    if (ok.length) {
      setLista(prev => [...(prev || []), ...ok]);
      onAtividade?.(ok.length === 1 ? `Anexou "${ok[0].nome}"` : `Anexou ${ok.length} arquivos: ${ok.map(a => a.nome).join(", ")}`);
    }
    if (falhas.length) setErro("Não subiram: " + falhas.join(" · "));
    setEnviando(false);
  }

  async function trocar(a, fn, atividade) {
    try {
      const novo = await fn();
      setLista(prev => prev.map(x => x.id === a.id ? novo : x));
      if (atividade) onAtividade?.(atividade);
    } catch (err) {
      setErro(err.message);
    }
  }

  // Link aberto na hora do clique: se o cache venceu, pede um novo (a aba abre antes, senão o
  // navegador bloqueia como pop-up).
  async function abrir(e, a) {
    const url = urls[a.path];
    const fresco = cacheUrls.get(a.path)?.expira > Date.now();
    if (url && fresco) return;
    e.preventDefault();
    const w = window.open("about:blank", "_blank");
    try {
      const u = await urlsComCache([a.path]);
      setUrls(prev => ({ ...prev, ...u }));
      if (w) w.location.href = u[a.path];
    } catch (err) {
      if (w) w.close();
      setErro("Não deu para abrir: " + err.message);
    }
  }

  if (lista === null) {
    return (
      <div style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px" }}>
        Os anexos ainda não estão ativos — rode a <b>migration_ficha_obra.sql</b> no Supabase.
      </div>
    );
  }
  if (lista === undefined) return <div style={{ fontSize: 12, color: "#94a3b8" }}>Carregando anexos…</div>;

  const removidos = (lista || []).filter(a => a.removidoEm);
  const mostrados = (verRemovidos ? removidos : ativos).filter(a => !filtro || a.categoria === filtro);
  const contagem = CATEGORIAS_ANEXO.map(c => ({ ...c, n: ativos.filter(a => a.categoria === c.id).length })).filter(c => c.n > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {contagem.length > 0 && !verRemovidos && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setFiltro("")} style={{ ...btn, background: !filtro ? "#1a1a1a" : "#fff", color: !filtro ? "#fff" : "#475569", borderRadius: 999 }}>Todos {ativos.length}</button>
          {contagem.map(c => (
            <button key={c.id} onClick={() => setFiltro(filtro === c.id ? "" : c.id)}
              style={{ ...btn, borderRadius: 999, background: filtro === c.id ? "#1a1a1a" : "#fff", color: filtro === c.id ? "#fff" : "#475569" }}>
              {c.icone} {c.rotulo} {c.n}
            </button>
          ))}
        </div>
      )}

      {verRemovidos && <div style={{ fontSize: 12, fontWeight: 700, color: "#dc2626" }}>🗑 Lixeira — arquivos removidos continuam guardados e podem ser restaurados</div>}

      {mostrados.length === 0 && (
        <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic" }}>
          {verRemovidos ? "A lixeira está vazia." : "Nenhum anexo ainda — contrato assinado, orçamento, comprovantes, projeto e fotos da obra."}
        </div>
      )}

      {mostrados.map(a => {
        const cat = ROTULO_CAT[a.categoria] || ROTULO_CAT.outro;
        const url = urls[a.path];
        const img = ehImagem(a.mime);
        const ehCapa = capa?.anexoId === a.id;
        return (
          <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: 6, border: "1px solid #f1f5f9", borderRadius: 8, opacity: a.removidoEm ? 0.7 : 1 }}>
            <a href={url || "#"} target="_blank" rel="noreferrer" onClick={e => abrir(e, a)}
              style={{ width: 64, height: 48, flexShrink: 0, borderRadius: 6, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", textDecoration: "none", fontSize: 11, fontWeight: 800, color: "#64748b" }}>
              {img && url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : /pdf/.test(a.mime) ? "PDF" : cat.icone}
            </a>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={url || "#"} target="_blank" rel="noreferrer" onClick={e => abrir(e, a)}
                style={{ fontSize: 12.5, fontWeight: 700, color: "#1e293b", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.nome}>
                {a.nome}
              </a>
              <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span>{new Date(a.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                {a.autor && <span>· {a.autor}</span>}
                {a.tamanho > 0 && <span>· {fmtTamanho(a.tamanho)}</span>}
                {ehCapa && <span style={{ color: "#c9a227", fontWeight: 800 }}>· ★ capa</span>}
                {a.removidoEm && <span style={{ color: "#dc2626" }}>· removido {a.removidoPor ? "por " + a.removidoPor : ""}</span>}
              </div>
            </div>
            {a.removidoEm ? (
              <button style={btn} onClick={() => trocar(a, () => restaurarAnexo(a.id), `Restaurou o anexo "${a.nome}"`)}>↩ Restaurar</button>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <select value={a.categoria} onChange={e => trocar(a, () => mudarCategoriaAnexo(a.id, e.target.value))}
                  style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", fontSize: 11, background: "#fff", cursor: "pointer" }}>
                  {CATEGORIAS_ANEXO.map(c => <option key={c.id} value={c.id}>{c.icone} {c.rotulo}</option>)}
                </select>
                {img && (
                  <button style={{ ...btn, color: ehCapa ? "#c9a227" : "#475569" }} title={ehCapa ? "Tirar da capa" : "Usar como capa da obra"}
                    onClick={() => onCapa?.(ehCapa ? null : { anexoId: a.id, path: a.path })}>★</button>
                )}
                <button style={{ ...btn, color: "#dc2626" }} title="Mandar para a lixeira"
                  onClick={() => {
                    if (!window.confirm(`Remover "${a.nome}"?\n\nO arquivo vai para a lixeira e pode ser restaurado.`)) return;
                    if (ehCapa) onCapa?.(null);
                    trocar(a, () => removerAnexo(a.id, lerAutor()), `Removeu o anexo "${a.nome}"`);
                  }}>🗑</button>
              </div>
            )}
          </div>
        );
      })}

      {!verRemovidos && (
        <>
          <AreaSoltar onArquivos={receber} desabilitado={enviando}
            texto={enviando ? "Enviando…" : "Arraste arquivos aqui ou clique para anexar (até 25 MB cada)"} />
          <label style={{ fontSize: 11, color: "#64748b", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={manterOriginal} onChange={e => setManterOriginal(e.target.checked)} />
            Manter fotos no tamanho original (sem reduzir para 1.600px)
          </label>
        </>
      )}
      {erro && <div style={{ fontSize: 12, color: "#dc2626" }}>{erro}</div>}
      {removidos.length > 0 && (
        <button onClick={() => { setVerRemovidos(v => !v); setFiltro(""); }}
          style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#64748b", fontSize: 11, cursor: "pointer", padding: 0 }}>
          {verRemovidos ? "← Voltar aos anexos" : `🗑 Mostrar removidos (${removidos.length})`}
        </button>
      )}
    </div>
  );
}
