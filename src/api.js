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
  }));
}

// Uma equipe por vez, de propósito: gravar a lista inteira fazia uma chamada atrasada
// com a lista antiga ressuscitar, via upsert, a equipe que acabou de ser excluída.
export async function upsertEquipe(eq) {
  const { error } = await supabase.from("equipes").upsert({
    id: eq.id, nome: eq.nome, integrantes: eq.integrantes || [], cor: eq.cor,
  });
  if (error) throw error;
}

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
