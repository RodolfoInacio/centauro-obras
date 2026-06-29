import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Ajuda a diagnosticar build/deploy sem as chaves configuradas.
  console.error("Supabase: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não definidos.");
}

export const supabase = createClient(url, anon);
