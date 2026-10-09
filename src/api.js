import { supabase } from "./supabase";

// ─── OBRAS ───────────────────────────────────────────────────────────────────
// Cada obra volta com a `versao` (updated_at) que esta aba leu. É ela que impede uma aba
// atrasada de gravar por cima do que outra pessoa acabou de salvar (ver salvarObra).
export async function fetchObras() {
  const linhas = await todasAsLinhas(() => supabase.from("obras").select("data, updated_at").order("id"));
  return linhas.map(r => ({ obra: r.data, versao: r.updated_at || null }));
}

export async function fetchObra(id) {
  const { data, error } = await supabase.from("obras").select("data, updated_at").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("A obra não existe mais no banco.");
  return { obra: data.data, versao: data.updated_at || null };
}

function linhaObra(obra) {
  return { numero: obra.numero, cliente: obra.cliente, updated_at: new Date().toISOString(), data: obra };
}

// Trava otimista: só grava se o banco ainda estiver na versão que esta aba leu. Antes era um
// upsert cego — a última gravação vencia, e quem editou a mesma obra em outra aba ou outro
// computador perdia a alteração sem aviso. Sem linha de volta = alguém gravou antes (ou a obra
// sumiu): nada é gravado e o erro sai marcado com `conflito`, para a tela avisar.
export async function salvarObra(obra, versao) {
  let q = supabase.from("obras").update(linhaObra(obra)).eq("id", obra.id);
  q = versao ? q.eq("updated_at", versao) : q.is("updated_at", null);
  const { data, error } = await q.select("updated_at");
  if (error) throw error;
  if (!data || data.length === 0) {
    const err = new Error("A obra foi alterada em outro lugar depois que você abriu.");
    err.conflito = true;
    throw err;
  }
  return data[0].updated_at;
}

// Obra nova é INSERT, nunca upsert: proposta repetida dá erro em vez de sobrescrever a existente.
export async function inserirObra(obra) {
  const { data, error } = await supabase.from("obras").insert({ id: obra.id, ...linhaObra(obra) }).select("updated_at");
  if (error) {
    if (error.code === "23505") throw new Error(`A proposta #${obra.numero} já está cadastrada.`);
    throw error;
  }
  return data[0].updated_at;
}

export async function deleteObra(id) {
  const { error } = await supabase.from("obras").delete().eq("id", id);
  if (error) throw error;
}

// Tabela de migration separada que ainda não foi rodada: aí sim vale devolver lista vazia.
// Qualquer outro erro (rede, sessão vencida) sobe — antes virava [] calado, e um diário vazio
// na tela levava o usuário a recriar um dia que já existia.
function tabelaAusente(error) {
  return error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message || ""));
}
async function lerOpcional(nome, montar) {
  try {
    return await todasAsLinhas(montar);
  } catch (error) {
    if (tabelaAusente(error)) { console.warn(`${nome}:`, error.message); return []; }
    throw error;
  }
}

// ─── CONFIGURAÇÕES ───────────────────────────────────────────────────────────
// Uma linha só ('geral'). `null` = tabela ainda não criada (migration_configuracoes.sql):
// o app segue com os padrões e a tela avisa.
export async function fetchConfiguracoes() {
  const { data, error } = await supabase.from("configuracoes").select("data").eq("id", "geral").maybeSingle();
  if (error) {
    if (tabelaAusente(error)) { console.warn("fetchConfiguracoes:", error.message); return null; }
    throw error;
  }
  return data ? data.data : {};
}

export async function salvarConfiguracoes(cfg) {
  const { error } = await supabase.from("configuracoes")
    .upsert({ id: "geral", updated_at: new Date().toISOString(), data: cfg });
  if (error) throw error;
}

// ─── EQUIPES ─────────────────────────────────────────────────────────────────
export async function fetchEquipes() {
  const data = await todasAsLinhas(() => supabase.from("equipes").select("*").order("id"));
  return (data || []).map(r => ({
    id: r.id, nome: r.nome, integrantes: r.integrantes || [], cor: r.cor,
    // Arquivada continua vindo do banco: é ela que segura o histórico do calendário.
    arquivada: !!r.arquivada,
  }));
}

// Uma equipe por vez, de propósito: gravar a lista inteira fazia uma chamada atrasada
// com a lista antiga ressuscitar, via upsert, a equipe que acabou de ser excluída.
export async function upsertEquipe(eq) {
  const { error } = await supabase.from("equipes").upsert({
    id: eq.id, nome: eq.nome, integrantes: eq.integrantes || [], cor: eq.cor,
    arquivada: !!eq.arquivada,
  });
  if (error) throw error;
}

// Exclusão de verdade. A tela usa arquivamento (upsertEquipe com arquivada), porque apagar a
// linha faz os serviços antigos do calendário perderem a equipe. Fica aqui para uso manual.
export async function deleteEquipe(id) {
  const { data, error } = await supabase.from("equipes").delete().eq("id", id).select("id");
  if (error) throw error;
  // O PostgREST devolve 204 sem erro quando o RLS filtra todas as linhas. Sem nenhuma
  // linha de volta, nada foi apagado — e sem esta checagem o app acha que deu certo.
  if (!data || data.length === 0) {
    throw new Error("A equipe não foi apagada — sem permissão ou ela já não existia.");
  }
}

// ─── CRONOGRAMAS ─────────────────────────────────────────────────────────────
export async function fetchCronogramas() {
  // Resiliente: se a tabela ainda não existe, não quebra o app.
  const data = await lerOpcional("fetchCronogramas", () => supabase.from("cronogramas").select("data").order("updated_at", { ascending: false }).order("id"));
  return data.map(r => r.data);
}

export async function upsertCronograma(c) {
  const row = {
    id: c.id, titulo: c.titulo, obra_id: c.obraId || null,
    updated_at: new Date().toISOString(), data: c,
  };
  const { error } = await supabase.from("cronogramas").upsert(row);
  if (error) throw error;
}

export async function deleteCronograma(id) {
  const { error } = await supabase.from("cronogramas").delete().eq("id", id);
  if (error) throw error;
}

// ─── AGENDA (serviços do dia por equipe) ─────────────────────────────────────
export async function fetchAgenda() {
  // Resiliente: se a tabela ainda não existe (migration_agenda.sql), não quebra o app.
  // Paginado: com mais de 1000 serviços o PostgREST cortava calado justamente os dias recentes.
  const data = await lerOpcional("fetchAgenda", () => supabase.from("agenda").select("data").order("dia", { ascending: true }).order("id"));
  return data.map(r => r.data);
}

export async function upsertAgendamento(ag) {
  const row = {
    id: ag.id,
    dia: ag.dia,
    equipe_id: ag.equipeId || null,
    obra_id: ag.obraId || null,
    updated_at: new Date().toISOString(),
    data: ag,
  };
  const { error } = await supabase.from("agenda").upsert(row);
  if (error) throw error;
}

export async function deleteAgendamento(id) {
  const { error } = await supabase.from("agenda").delete().eq("id", id);
  if (error) throw error;
}

// ─── LEMBRETES (mural do calendário) ─────────────────────────────────────────
export async function fetchLembretes() {
  // Resiliente: se a tabela ainda não existe (migration_lembretes.sql), não quebra o app.
  const data = await lerOpcional("fetchLembretes", () => supabase.from("lembretes").select("data").order("ordem", { ascending: true }).order("id"));
  return data.map(r => r.data);
}

export async function upsertLembrete(l) {
  const row = {
    id: l.id,
    texto: l.texto || "",
    prazo: l.prazo || null,
    arquivado: !!l.arquivado,
    ordem: l.ordem || 0,
    updated_at: new Date().toISOString(),
    data: l,
  };
  const { error } = await supabase.from("lembretes").upsert(row);
  if (error) throw error;
}

export async function deleteLembrete(id) {
  const { data, error } = await supabase.from("lembretes").delete().eq("id", id).select("id");
  if (error) throw error;
  // Igual ao deleteEquipe: DELETE barrado por RLS volta 204 sem erro. Sem linha de
  // volta, nada foi apagado — e o lembrete reapareceria no F5.
  if (!data || data.length === 0) {
    throw new Error("O lembrete não foi apagado — sem permissão ou ele já não existia.");
  }
}

// ─── DIÁRIO DE OBRAS ─────────────────────────────────────────────────────────
export async function fetchDiarios() {
  // Resiliente: se a tabela ainda não existe (migration_diario.sql), não quebra o app.
  const data = await lerOpcional("fetchDiarios", () => supabase.from("diarios").select("data").order("dia", { ascending: false }).order("id"));
  return data.map(r => r.data);
}

export async function upsertDiario(d) {
  const row = {
    id: d.id,
    obra_id: d.obraId || null,
    dia: d.dia,
    numero: d.numero || null,
    updated_at: new Date().toISOString(),
    data: d,
  };
  const { error } = await supabase.from("diarios").upsert(row);
  if (error) throw error;
}

export async function deleteDiario(id) {
  const { error } = await supabase.from("diarios").delete().eq("id", id);
  if (error) throw error;
}

// ─── ORÇAMENTOS LIVRES ───────────────────────────────────────────────────────
export async function fetchOrcamentos() {
  // Resiliente: se a tabela ainda não existe (migration_orcamentos.sql), não quebra o app.
  const data = await lerOpcional("fetchOrcamentos", () => supabase.from("orcamentos").select("data").order("id"));
  return data.map(r => r.data);
}

export async function upsertOrcamento(o) {
  const row = {
    id: o.id,
    numero: o.numero,
    cliente: o.cliente?.nome || "",
    status: o.status || "rascunho",
    obra_id: o.obraId || null,
    updated_at: new Date().toISOString(),
    data: o,
  };
  const { error } = await supabase.from("orcamentos").upsert(row);
  if (error) throw error;
}

export async function deleteOrcamento(id) {
  const { data, error } = await supabase.from("orcamentos").delete().eq("id", id).select("id");
  if (error) throw error;
  // DELETE barrado por RLS volta 204 sem erro (ver deleteEquipe).
  if (!data || data.length === 0) throw new Error("O orçamento não foi apagado — sem permissão ou ele já não existia.");
}

// ─── FOTOS DO DIÁRIO (Storage) ───────────────────────────────────────────────
// O app nunca escrevia no Storage; o padrão vem do seed_supabase.mjs.
// Caminho: <obraId>/<diarioId>/<fotoId>.jpg (e -orig.jpg para a foto sem marcação).
const BUCKET_DIARIO = "diario";

export async function uploadFotoDiario(path, blob) {
  const { error } = await supabase.storage.from(BUCKET_DIARIO)
    .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });
  if (error) throw error;
  return supabase.storage.from(BUCKET_DIARIO).getPublicUrl(path).data.publicUrl;
}

export async function removeFotoDiario(paths) {
  const { error } = await supabase.storage.from(BUCKET_DIARIO).remove(paths);
  if (error) console.warn("removeFotoDiario:", error.message); // sobra de arquivo não trava a UI
}

// ─── ESTOQUE (livro-razão) ───────────────────────────────────────────────────
// Diferente do resto: documento e movimento só são gravados pelas funções do banco
// (estoque_lancar / estoque_estornar), que travam os itens e conferem o saldo. O saldo
// não é gravado em lugar nenhum — vem da view estoque_saldos. Aqui tudo faz throw:
// estoque não é opcional, e erro engolido é lançamento que o usuário acha que existe.

// O PostgREST devolve no máximo 1000 linhas por chamada e corta calado. Lista de estoque
// truncada sem aviso é item "sumido", então tudo que pode crescer passa por aqui.
const PAGINA = 1000;
async function todasAsLinhas(montar) {
  const out = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await montar().range(de, de + PAGINA - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGINA) return out;
  }
}

function itemEstoque(r, s) {
  return {
    id: r.id, codigo: r.codigo, nome: r.nome, categoria: r.categoria, unidade: r.unidade,
    local: r.local || "", estoqueMinimo: Number(r.estoque_minimo) || 0, arquivado: !!r.arquivado,
    data: r.data || {}, saldo: Number(s?.saldo) || 0, ultimaMov: s?.ultima_movimentacao || null,
  };
}

function docEstoque(r) {
  return {
    id: r.id, tipo: r.tipo, numero: Number(r.numero), motivo: r.motivo, dia: r.dia,
    obraId: r.obra_id || null, obraRotulo: r.obra_rotulo || "", equipeId: r.equipe_id || null,
    fornecedor: r.fornecedor || "", nfNumero: r.nf_numero || "", responsavel: r.responsavel || "",
    recebidoPor: r.recebido_por || "", obs: r.obs || "", estornaId: r.estorna_id || null, createdAt: r.created_at,
  };
}

export async function fetchEstoqueItens() {
  const [itens, saldos] = await Promise.all([
    todasAsLinhas(() => supabase.from("estoque_itens").select("*").order("codigo")),
    todasAsLinhas(() => supabase.from("estoque_saldos").select("*").order("item_id")),
  ]);
  const saldo = new Map(saldos.map(s => [s.item_id, s]));
  return itens.map(r => itemEstoque(r, saldo.get(r.id)));
}

// Item novo passa pela função do banco, que tira o código do contador (EST-00001).
export async function salvarItemEstoque(it) {
  const campos = {
    nome: (it.nome || "").trim(), categoria: it.categoria, unidade: it.unidade,
    local: (it.local || "").trim() || null, estoque_minimo: Math.max(0, Number(it.estoqueMinimo) || 0),
    data: it.data || {},
  };
  if (!it.id) {
    const { data, error } = await supabase.rpc("estoque_novo_item", { item: campos });
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from("estoque_itens")
    .update({ ...campos, arquivado: !!it.arquivado }).eq("id", it.id).select("id");
  if (error) throw error;
  // Mesmo caso do deleteEquipe: UPDATE barrado por RLS volta sem erro e sem linha.
  if (!data || data.length === 0) throw new Error("O item não foi gravado — sem permissão ou ele não existe mais.");
  return data[0];
}

// cab: { tipo, motivo, dia, obra_id, equipe_id, fornecedor, nf_numero, responsavel, recebido_por, obs }
// linhas: [{ item_id, quantidade, valor_unitario }] ou, no ajuste, [{ item_id, contagem }]
export async function lancarDocumentoEstoque(cab, linhas) {
  const { data, error } = await supabase.rpc("estoque_lancar", { cab, linhas });
  if (error) throw error;
  return docEstoque(data);
}

export async function estornarDocumentoEstoque(docId, motivo, responsavel) {
  const { data, error } = await supabase.rpc("estoque_estornar", { doc_id: docId, motivo, responsavel: responsavel || null });
  if (error) throw error;
  return docEstoque(data);
}

export async function fetchDocumentosEstoque({ inicio, fim } = {}) {
  const [linhas, estornos] = await Promise.all([
    todasAsLinhas(() => {
      let q = supabase.from("estoque_documentos").select("*, estoque_movimentos(count)");
      if (inicio) q = q.gte("dia", inicio);
      if (fim) q = q.lte("dia", fim);
      return q.order("created_at", { ascending: false });
    }),
    // Estorno é raro: vêm todos, para marcar o original mesmo que o estorno seja de outro mês.
    todasAsLinhas(() => supabase.from("estoque_documentos").select("id, tipo, numero, estorna_id").eq("tipo", "estorno").order("numero")),
  ]);
  const idsOrig = [...new Set(linhas.filter(r => r.estorna_id).map(r => r.estorna_id))];
  let originais = [];
  if (idsOrig.length) {
    const { data, error } = await supabase.from("estoque_documentos").select("id, tipo, numero").in("id", idsOrig);
    if (error) throw error;
    originais = data || [];
  }
  const porOriginal = new Map(estornos.map(e => [e.estorna_id, e]));
  const orig = new Map(originais.map(o => [o.id, o]));
  return linhas.map(r => ({
    ...docEstoque(r),
    qtdItens: r.estoque_movimentos?.[0]?.count ?? 0,
    estornadoPor: porOriginal.get(r.id) || null,
    estornaDe: r.estorna_id ? orig.get(r.estorna_id) || null : null,
  }));
}

export async function fetchDocumentoEstoque(id) {
  const { data, error } = await supabase.from("estoque_documentos")
    .select("*, estoque_movimentos(id, item_id, quantidade, valor_unitario, item_nome, unidade, item:estoque_itens(codigo))")
    .eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Documento não encontrado.");
  const [estorno, original] = await Promise.all([
    supabase.from("estoque_documentos").select("id, tipo, numero, dia, obs").eq("estorna_id", id).maybeSingle(),
    data.estorna_id
      ? supabase.from("estoque_documentos").select("id, tipo, numero, dia").eq("id", data.estorna_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (estorno.error) throw estorno.error;
  if (original.error) throw original.error;
  return {
    ...docEstoque(data),
    linhas: (data.estoque_movimentos || []).sort((a, b) => a.id - b.id).map(m => ({
      id: m.id, itemId: m.item_id, codigo: m.item?.codigo || "", nome: m.item_nome || "", unidade: m.unidade || "",
      quantidade: Number(m.quantidade), valorUnitario: m.valor_unitario == null ? null : Number(m.valor_unitario),
    })),
    estornadoPor: estorno.data || null,
    estornaDe: original.data || null,
  };
}

export async function fetchMovimentosItem(itemId) {
  const linhas = await todasAsLinhas(() => supabase.from("estoque_movimentos")
    .select("id, quantidade, valor_unitario, created_at, doc:estoque_documentos(*)")
    .eq("item_id", itemId).order("id", { ascending: false }));
  return linhas.map(m => ({
    id: m.id, quantidade: Number(m.quantidade), createdAt: m.created_at,
    valorUnitario: m.valor_unitario == null ? null : Number(m.valor_unitario), doc: docEstoque(m.doc),
  }));
}

// Resiliente como a agenda: é um bloco de consulta dentro da tela da obra. Sem a
// migration rodada, devolve null e a tela da obra só não mostra o bloco.
export async function fetchMovimentosObra(obraId) {
  try {
    const linhas = await todasAsLinhas(() => supabase.from("estoque_movimentos")
      .select("id, item_id, quantidade, item_nome, unidade, item:estoque_itens(codigo), doc:estoque_documentos!inner(id, tipo, numero, dia, obra_id)")
      .eq("doc.obra_id", obraId).order("id"));
    return linhas.map(m => ({
      id: m.id, itemId: m.item_id, codigo: m.item?.codigo || "", nome: m.item_nome || "", unidade: m.unidade || "",
      quantidade: Number(m.quantidade), doc: { id: m.doc.id, tipo: m.doc.tipo, numero: Number(m.doc.numero), dia: m.doc.dia },
    }));
  } catch (err) {
    console.warn("fetchMovimentosObra:", err.message);
    return null;
  }
}

// ─── ANEXOS DA OBRA (tabela obra_anexos + bucket privado "obras") ────────────
// Uma linha por arquivo, fora do jsonb da obra (dois envios ao mesmo tempo não se apagam).
// Nada é apagado: remover marca `removido_em` (lixeira) e o arquivo continua no Storage.
const BUCKET_OBRAS = "obras";

function anexo(r) {
  return {
    id: r.id, obraId: r.obra_id, nome: r.nome, path: r.path, mime: r.mime || "",
    tamanho: Number(r.tamanho) || 0, categoria: r.categoria, autor: r.autor || "",
    createdAt: r.created_at, removidoEm: r.removido_em || null, removidoPor: r.removido_por || "",
  };
}

// Resiliente: sem a migration_ficha_obra.sql, devolve null e o bloco mostra o aviso.
export async function fetchAnexosObra(obraId) {
  try {
    const linhas = await todasAsLinhas(() => supabase.from("obra_anexos").select("*").eq("obra_id", obraId).order("created_at"));
    return linhas.map(anexo);
  } catch (err) {
    console.warn("fetchAnexosObra:", err.message);
    return null;
  }
}

// Categorias de anexo de cada obra (sem os da lixeira), para a central de avisos apontar obra
// sem contrato/orçamento/projeto. null = tabela ainda não existe ou leitura falhou.
export async function fetchResumoAnexos() {
  try {
    const linhas = await todasAsLinhas(() => supabase.from("obra_anexos").select("id, obra_id, categoria").is("removido_em", null).order("id"));
    const mapa = new Map();
    for (const r of linhas) {
      if (!mapa.has(r.obra_id)) mapa.set(r.obra_id, new Set());
      mapa.get(r.obra_id).add(r.categoria);
    }
    return mapa;
  } catch (err) {
    console.warn("fetchResumoAnexos:", err.message);
    return null;
  }
}

// Capa automática: para cada obra, o caminho da primeira foto (categoria "foto", imagem, fora da
// lixeira). Só a categoria foto — comprovante ou projeto escaneado não vira capa. A capa escolhida
// à mão (obra.capa) vence; esta é só a de quando ninguém escolheu. `obraId` limita a uma obra.
export async function fetchFotosCapa(obraId) {
  try {
    const linhas = await todasAsLinhas(() => {
      let q = supabase.from("obra_anexos").select("id, obra_id, path, mime, created_at")
        .eq("categoria", "foto").like("mime", "image/%").is("removido_em", null);
      if (obraId) q = q.eq("obra_id", obraId);
      return q.order("created_at").order("id");
    });
    const mapa = {};
    for (const r of linhas) if (!mapa[r.obra_id]) mapa[r.obra_id] = r.path;
    return mapa;
  } catch (err) {
    console.warn("fetchFotosCapa:", err.message);
    return {};
  }
}

// Nome de arquivo seguro para a chave do Storage (sem acento, espaço nem símbolo).
function saneado(nome) {
  return (nome || "arquivo").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-80);
}

// Sobe o arquivo e só depois registra a linha. `upsert: false` + uuid no caminho: um envio
// nunca sobrescreve outro arquivo.
export async function enviarAnexoObra({ obraId, blob, nome, mime, categoria, autor }) {
  const path = `${saneado(String(obraId))}/${crypto.randomUUID()}-${saneado(nome)}`;
  const up = await supabase.storage.from(BUCKET_OBRAS).upload(path, blob, { contentType: mime || blob.type || "application/octet-stream", upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await supabase.from("obra_anexos").insert({
    obra_id: obraId, nome, path, mime: mime || blob.type || null, tamanho: blob.size || null,
    categoria: categoria || "outro", autor: autor || null,
  }).select("*").single();
  if (error) throw new Error(`"${nome}" subiu, mas não foi registrado na obra: ${error.message}`);
  return anexo(data);
}

async function atualizarAnexo(id, campos) {
  const { data, error } = await supabase.from("obra_anexos").update(campos).eq("id", id).select("*");
  if (error) throw error;
  // Mesmo caso do deleteEquipe: UPDATE barrado por RLS volta sem erro e sem linha.
  if (!data || data.length === 0) throw new Error("O anexo não foi alterado — sem permissão ou ele não existe.");
  return anexo(data[0]);
}
export const removerAnexo = (id, por) => atualizarAnexo(id, { removido_em: new Date().toISOString(), removido_por: por || null });
export const restaurarAnexo = (id) => atualizarAnexo(id, { removido_em: null, removido_por: null });
export const mudarCategoriaAnexo = (id, categoria) => atualizarAnexo(id, { categoria });

// Bucket privado: o link é assinado e vence em 1 h. Várias de uma vez para as miniaturas.
export async function urlsAssinadas(paths, segundos = 3600) {
  const unicos = [...new Set(paths.filter(Boolean))];
  if (!unicos.length) return {};
  const { data, error } = await supabase.storage.from(BUCKET_OBRAS).createSignedUrls(unicos, segundos);
  if (error) throw error;
  return Object.fromEntries((data || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
}

// Leitura de um anexo pela IA (Edge Function analisar-documento). Só devolve os campos lidos —
// nada é gravado aqui. A function busca o arquivo pelo id, com o login de quem pediu.
export async function lerDocumentoComIA(anexoId, contexto) {
  const { data, error } = await supabase.functions.invoke("analisar-documento", { body: { anexoId, contexto } });
  if (error) {
    // Erro HTTP da function: a mensagem útil está no corpo, não no `error.message` genérico.
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* corpo não é JSON */ }
    if (/not found|404/i.test(msg) && !/Anexo/.test(msg)) msg = "A leitura com IA ainda não foi publicada no Supabase (function analisar-documento).";
    throw new Error(msg);
  }
  if (!data || data.error) throw new Error((data && data.error) || "Resposta vazia da IA");
  return data;
}

// ─── COMENTÁRIOS E ATIVIDADE DA OBRA ─────────────────────────────────────────
// Imutáveis no banco: não se editam nem se apagam, só se ocultam.
function comentario(r) {
  return { id: r.id, obraId: r.obra_id, tipo: r.tipo, texto: r.texto, autor: r.autor || "", createdAt: r.created_at, ocultoEm: r.oculto_em || null };
}

export async function fetchComentariosObra(obraId) {
  try {
    const linhas = await todasAsLinhas(() => supabase.from("obra_comentarios").select("*").eq("obra_id", obraId).order("created_at", { ascending: false }));
    return linhas.map(comentario);
  } catch (err) {
    console.warn("fetchComentariosObra:", err.message);
    return null;
  }
}

export async function inserirComentario({ obraId, texto, autor, tipo = "comentario" }) {
  const { data, error } = await supabase.from("obra_comentarios")
    .insert({ obra_id: obraId, texto, autor: autor || null, tipo }).select("*").single();
  if (error) throw error;
  return comentario(data);
}

export async function ocultarComentario(id, oculto) {
  const { data, error } = await supabase.from("obra_comentarios")
    .update({ oculto_em: oculto ? new Date().toISOString() : null }).eq("id", id).select("*");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("O comentário não foi alterado — sem permissão ou ele não existe.");
  return comentario(data[0]);
}

// ─── BACKUP COMPLETO (botão "Exportar dados") ────────────────────────────────
// Todas as tabelas, paginadas. Obras é obrigatória; o resto vira null se a tabela não existir.
// Os arquivos em si (anexos, fotos, desenhos) ficam no Storage e não entram aqui.
export async function fetchBackupCompleto() {
  const tabela = (nome) => todasAsLinhas(() => supabase.from(nome).select("*").order("id"));
  const opcional = async (nome) => {
    try { return await tabela(nome); } catch (err) { console.warn(`backup ${nome}:`, err.message); return null; }
  };
  const obras = await tabela("obras");
  const nomes = ["equipes", "agenda", "cronogramas", "lembretes", "diarios", "obra_anexos", "obra_comentarios",
    "obras_historico", "orcamentos", "estoque_itens", "estoque_documentos", "estoque_movimentos"];
  const resto = await Promise.all(nomes.map(opcional));
  return { geradoEm: new Date().toISOString(), obras, ...Object.fromEntries(nomes.map((n, i) => [n, resto[i]])) };
}

// Para o CSV: o livro inteiro, na ordem em que foi lançado.
export async function fetchTodosMovimentosEstoque() {
  const linhas = await todasAsLinhas(() => supabase.from("estoque_movimentos")
    .select("id, quantidade, valor_unitario, item_nome, unidade, created_at, item:estoque_itens(codigo), doc:estoque_documentos(*)")
    .order("id"));
  return linhas.map(m => ({
    id: m.id, quantidade: Number(m.quantidade), createdAt: m.created_at,
    valorUnitario: m.valor_unitario == null ? null : Number(m.valor_unitario),
    codigo: m.item?.codigo || "", nome: m.item_nome || "", unidade: m.unidade || "", doc: docEstoque(m.doc),
  }));
}
