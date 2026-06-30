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

// Sincroniza a lista inteira: upsert das atuais + remove as que sumiram.
export async function saveEquipes(equipes) {
  const { data: existing } = await supabase.from("equipes").select("id");
  const keep = new Set(equipes.map(e => e.id));
  const toDelete = (existing || []).filter(r => !keep.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error } = await supabase.from("equipes").delete().in("id", toDelete);
    if (error) throw error;
  }
  if (equipes.length) {
    const rows = equipes.map(e => ({ id: e.id, nome: e.nome, integrantes: e.integrantes || [], cor: e.cor }));
    const { error } = await supabase.from("equipes").upsert(rows);
    if (error) throw error;
  }
}

// ─── ORDENS DE SERVIÇO ───────────────────────────────────────────────────────
export async function fetchOrdens() {
  // Resiliente: se a tabela ainda não existe, não quebra o app (retorna vazio).
  const { data, error } = await supabase.from("ordens").select("data").order("numero", { ascending: false });
  if (error) { console.warn("fetchOrdens:", error.message); return []; }
  return (data || []).map(r => r.data);
}

export async function upsertOrdem(ordem) {
  const row = {
    id: ordem.id,
    numero: ordem.numero,
    equipe_id: ordem.equipeId,
    periodo_inicio: ordem.periodoInicio || null,
    periodo_fim: ordem.periodoFim || null,
    updated_at: new Date().toISOString(),
    data: ordem,
  };
  const { error } = await supabase.from("ordens").upsert(row);
  if (error) throw error;
}

export async function deleteOrdem(id) {
  const { error } = await supabase.from("ordens").delete().eq("id", id);
  if (error) throw error;
}
