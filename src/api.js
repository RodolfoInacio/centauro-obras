import { supabase } from "./supabase";

// ─── OBRAS ───────────────────────────────────────────────────────────────────
export async function fetchObras() {
  const { data, error } = await supabase.from("obras").select("data");
  if (error) throw error;
  return (data || []).map(r => r.data);
}

export async function upsertObra(obra) {
  const row = {
    id: obra.id,
    numero: obra.numero,
    cliente: obra.cliente,
    updated_at: new Date().toISOString(),
    data: obra,
  };
  const { error } = await supabase.from("obras").upsert(row);
  if (error) throw error;
}

export async function deleteObra(id) {
  const { error } = await supabase.from("obras").delete().eq("id", id);
  if (error) throw error;
}

// ─── EQUIPES ─────────────────────────────────────────────────────────────────
export async function fetchEquipes() {
  const { data, error } = await supabase.from("equipes").select("*");
  if (error) throw error;
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
  const { data, error } = await supabase.from("cronogramas").select("data").order("updated_at", { ascending: false });
  if (error) { console.warn("fetchCronogramas:", error.message); return []; }
  return (data || []).map(r => r.data);
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
  const { data, error } = await supabase.from("agenda").select("data").order("dia", { ascending: true });
  if (error) { console.warn("fetchAgenda:", error.message); return []; }
  return (data || []).map(r => r.data);
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
  const { data, error } = await supabase.from("lembretes").select("data").order("ordem", { ascending: true });
  if (error) { console.warn("fetchLembretes:", error.message); return []; }
  return (data || []).map(r => r.data);
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
  const { data, error } = await supabase.from("diarios").select("data").order("dia", { ascending: false });
  if (error) { console.warn("fetchDiarios:", error.message); return []; }
  return (data || []).map(r => r.data);
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
